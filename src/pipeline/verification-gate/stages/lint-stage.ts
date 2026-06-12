/**
 * ESLint verification stage.
 * Runs ESLint on changed files and reports structured diagnostics.
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

// ─── ESLint Output Types ────────────────────────────────────────

interface ESLintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
}

interface ESLintFileResult {
  filePath: string;
  messages: ESLintMessage[];
  errorCount: number;
  warningCount: number;
}

// ─── ESLint Runner Interface ────────────────────────────────────

export interface LintRunner {
  run(files: string[], rootDir: string, eslintConfigPath?: string): Promise<ESLintFileResult[]>;
}

export class DefaultLintRunner implements LintRunner {
  async run(files: string[], rootDir: string, eslintConfigPath?: string): Promise<ESLintFileResult[]> {
    if (files.length === 0) return [];

    const configArg = eslintConfigPath ? `--config ${eslintConfigPath}` : '';
    const fileArgs = files.map(f => `"${f}"`).join(' ');
    const cmd = `npx eslint ${configArg} --format json ${fileArgs}`;

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: rootDir,
        timeout: 15_000,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return JSON.parse(stdout) as ESLintFileResult[];
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string };
      // ESLint exits non-zero when it finds errors — still parse stdout
      if (execError.stdout) {
        try {
          return JSON.parse(execError.stdout) as ESLintFileResult[];
        } catch {
          // Could not parse output
        }
      }
      return [];
    }
  }
}

// ─── Lint Stage ─────────────────────────────────────────────────

export class LintStage implements VerificationStage {
  readonly name = 'lint' as const;
  readonly score = STAGE_SCORES.lint;

  constructor(private runner: LintRunner = new DefaultLintRunner()) {}

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();
    const files = edit.changes.map(c => c.filePath);

    const results = await this.runner.run(files, context.rootDir, context.eslintConfigPath);

    const diagnostics: Diagnostic[] = [];
    for (const fileResult of results) {
      const relPath = path.isAbsolute(fileResult.filePath)
        ? path.relative(context.rootDir, fileResult.filePath)
        : fileResult.filePath;

      for (const msg of fileResult.messages) {
        // Only count errors (severity 2) as failures
        if (msg.severity === 2) {
          diagnostics.push({
            file: relPath,
            line: msg.line,
            column: msg.column,
            message: msg.ruleId ? `[${msg.ruleId}] ${msg.message}` : msg.message,
            severity: 'error',
          });
        }
      }
    }

    return {
      stageName: 'lint',
      passed: diagnostics.length === 0,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }
}
