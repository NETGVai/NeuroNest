/**
 * Sandbox smoke-run stage.
 * Executes the edited code in an isolated environment with no network access
 * and a 10-second timeout to catch runtime crashes.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
} from '../types';
import { STAGE_SCORES } from '../types';

const execAsync = promisify(exec);

// ─── Sandbox Runner Interface ───────────────────────────────────

export interface SandboxConfig {
  /** Timeout for the smoke run in ms (default: 10000) */
  timeoutMs: number;
  /** Whether to block network access (default: true) */
  noNetwork: boolean;
  /** Working directory for execution */
  cwd: string;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface SandboxRunner {
  run(entryFile: string, config: SandboxConfig): Promise<SandboxRunResult>;
}

/**
 * Default sandbox runner using a child process with network isolation.
 * On Linux, uses unshare for network namespacing.
 * On macOS, uses sandbox-exec (if available) or falls back to basic process isolation.
 */
export class DefaultSandboxRunner implements SandboxRunner {
  async run(entryFile: string, config: SandboxConfig): Promise<SandboxRunResult> {
    const cmd = this.buildCommand(entryFile, config);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: config.cwd,
        timeout: config.timeoutMs,
        env: this.buildSandboxEnv(config),
        killSignal: 'SIGKILL',
      });

      return { exitCode: 0, stdout, stderr, timedOut: false };
    } catch (error: unknown) {
      const execError = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };

      if (execError.killed || execError.signal === 'SIGKILL') {
        return {
          exitCode: 124,
          stdout: execError.stdout || '',
          stderr: execError.stderr || '',
          timedOut: true,
          error: `Smoke run timed out after ${config.timeoutMs}ms`,
        };
      }

      return {
        exitCode: execError.code ?? 1,
        stdout: execError.stdout || '',
        stderr: execError.stderr || '',
        timedOut: false,
        error: execError.stderr || 'Smoke run failed',
      };
    }
  }

  private buildCommand(entryFile: string, config: SandboxConfig): string {
    const nodeCmd = `node --experimental-vm-modules --no-warnings "${entryFile}"`;

    if (!config.noNetwork) return nodeCmd;

    // Platform-specific network isolation
    if (process.platform === 'linux') {
      return `unshare --net ${nodeCmd}`;
    }

    if (process.platform === 'darwin') {
      // macOS sandbox-exec with network deny profile
      const profile = '(version 1)(deny network*)';
      return `sandbox-exec -p '${profile}' ${nodeCmd}`;
    }

    // Windows or other — run without network isolation but with env flag
    return nodeCmd;
  }

  private buildSandboxEnv(config: SandboxConfig): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_OPTIONS: '',
      // Signal to code under test that it's in sandbox mode
      NEURONEST_SANDBOX: '1',
      // Disable network in user-space even if OS-level isolation unavailable
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      HTTP_PROXY: config.noNetwork ? 'http://0.0.0.0:0' : (process.env.HTTP_PROXY || ''),
      HTTPS_PROXY: config.noNetwork ? 'http://0.0.0.0:0' : (process.env.HTTPS_PROXY || ''),
    };
  }
}

// ─── Smoke Stage ────────────────────────────────────────────────

const SMOKE_TIMEOUT_MS = 10_000;

export class SmokeStage implements VerificationStage {
  readonly name = 'smoke' as const;
  readonly score = STAGE_SCORES.smoke;

  constructor(private runner: SandboxRunner = new DefaultSandboxRunner()) {}

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();
    const diagnostics: Diagnostic[] = [];

    // Find an entry file to smoke-test
    const entryFile = this.findEntryFile(edit, context);

    if (!entryFile) {
      // No executable entry point — pass with no diagnostics
      return {
        stageName: 'smoke',
        passed: true,
        diagnostics: [],
        durationMs: Date.now() - startTime,
      };
    }

    const config: SandboxConfig = {
      timeoutMs: SMOKE_TIMEOUT_MS,
      noNetwork: true,
      cwd: context.rootDir,
    };

    const result = await this.runner.run(entryFile, config);

    if (result.timedOut) {
      diagnostics.push({
        file: entryFile,
        line: 1,
        column: 1,
        message: `Smoke run timed out after ${SMOKE_TIMEOUT_MS}ms`,
        severity: 'error',
      });
    } else if (result.exitCode !== 0) {
      const errorInfo = this.parseRuntimeError(result.stderr || result.error || '');
      diagnostics.push({
        file: errorInfo.file || entryFile,
        line: errorInfo.line || 1,
        column: errorInfo.column || 1,
        message: errorInfo.message || `Smoke run failed with exit code ${result.exitCode}`,
        severity: 'error',
      });
    }

    return {
      stageName: 'smoke',
      passed: diagnostics.length === 0,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Finds the best entry file to use for a smoke run.
   * Prefers files with main/index patterns.
   */
  private findEntryFile(edit: AgentEdit, context: ProjectContext): string | null {
    const changedFiles = edit.changes.map(c => c.filePath);

    // Prefer index files or files with a main export
    const entryPatterns = ['index.ts', 'index.js', 'main.ts', 'main.js'];
    for (const pattern of entryPatterns) {
      const match = changedFiles.find(f => f.endsWith(pattern));
      if (match) return path.resolve(context.rootDir, match);
    }

    // Fall back to first TypeScript/JavaScript file
    const executableFile = changedFiles.find(f =>
      f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx')
    );

    return executableFile ? path.resolve(context.rootDir, executableFile) : null;
  }

  /**
   * Attempts to extract file/line/column from a Node.js runtime error stack trace.
   */
  private parseRuntimeError(stderr: string): { file?: string; line?: number; column?: number; message?: string } {
    // Match Node.js error format: "    at Object.<anonymous> (/path/file.ts:10:5)"
    const stackMatch = stderr.match(/at\s+.+?\((.+?):(\d+):(\d+)\)/);
    // Match error message line
    const msgMatch = stderr.match(/^(?:Error|TypeError|ReferenceError|SyntaxError):\s*(.+)$/m);

    return {
      file: stackMatch?.[1],
      line: stackMatch ? parseInt(stackMatch[2], 10) : undefined,
      column: stackMatch ? parseInt(stackMatch[3], 10) : undefined,
      message: msgMatch?.[1] || stderr.split('\n')[0] || 'Runtime error',
    };
  }
}
