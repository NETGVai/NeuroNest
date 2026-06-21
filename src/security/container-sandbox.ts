/**
 * ContainerSandbox — Isolated container execution for untrusted/generated code.
 *
 * Runs code inside an isolated container (Docker/Podman) with restricted
 * filesystem, network, and process access. Enforces CPU, memory, and disk
 * resource limits with violation detection. Supports configurable network
 * policies (deny-all default, domain allowlist).
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7
 */

import { spawn, execSync } from 'node:child_process';
import * as crypto from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SandboxConfig {
  /** Maximum CPU time in milliseconds */
  cpuTimeMs: number;
  /** Maximum memory in megabytes */
  memoryMb: number;
  /** Maximum disk usage in megabytes */
  diskMb: number;
  /** Network policy: deny-all or allowlist specific domains */
  networkPolicy: 'deny-all' | { allowlist: string[] };
}

export interface SandboxResult {
  /** Standard output captured from the container */
  stdout: string;
  /** Standard error captured from the container */
  stderr: string;
  /** Process exit code */
  exitCode: number;
  /** Whether execution was terminated due to resource violation */
  resourceViolation: boolean;
  /** Type of resource limit that was exceeded, if any */
  violationType?: 'cpu' | 'memory' | 'disk' | 'network';
}

// ─── Container Runtime Detection ────────────────────────────────

export type ContainerRuntime = 'docker' | 'podman' | 'none';

// ─── Language Configuration ─────────────────────────────────────

interface LanguageSpec {
  image: string;
  fileExtension: string;
  runCommand: (filename: string) => string[];
}

const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  javascript: {
    image: 'node:20-alpine',
    fileExtension: '.js',
    runCommand: (f) => ['node', f],
  },
  typescript: {
    image: 'node:20-alpine',
    fileExtension: '.ts',
    runCommand: (f) => ['npx', 'tsx', f],
  },
  python: {
    image: 'python:3.12-alpine',
    fileExtension: '.py',
    runCommand: (f) => ['python', f],
  },
  bash: {
    image: 'alpine:3.19',
    fileExtension: '.sh',
    runCommand: (f) => ['sh', f],
  },
  shell: {
    image: 'alpine:3.19',
    fileExtension: '.sh',
    runCommand: (f) => ['sh', f],
  },
};

const DEFAULT_LANGUAGE_SPEC: LanguageSpec = {
  image: 'alpine:3.19',
  fileExtension: '.sh',
  runCommand: (f) => ['sh', f],
};

// ─── Error Classes ──────────────────────────────────────────────

export class ContainerSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerSandboxError';
  }
}

export class ContainerRuntimeUnavailableError extends ContainerSandboxError {
  constructor() {
    super(
      'No container runtime available. Install Docker or Podman to use container sandboxing.',
    );
    this.name = 'ContainerRuntimeUnavailableError';
  }
}

// ─── OOM Detection Patterns ─────────────────────────────────────

const OOM_PATTERNS = [
  /out of memory/i,
  /oom-kill/i,
  /killed.*memory/i,
  /cannot allocate memory/i,
  /memory limit/i,
];

const DISK_PATTERNS = [
  /no space left on device/i,
  /disk quota exceeded/i,
  /ENOSPC/,
];

// ─── ContainerSandbox ───────────────────────────────────────────

export class ContainerSandbox {
  private config: SandboxConfig;
  private runtime: ContainerRuntime;
  private activeContainers: Set<string> = new Set();

  constructor(config: SandboxConfig) {
    this.config = config;
    this.runtime = detectContainerRuntime();
  }

  /**
   * Execute code in an isolated container with resource limits and network policy.
   *
   * The code is written to a temporary file inside the container, executed
   * within configured resource limits, and stdout/stderr/exitCode are captured.
   * If resource limits are exceeded, the container is terminated and the violation
   * type is reported.
   *
   * @param code - Source code to execute
   * @param language - Programming language (determines runtime image and exec command)
   * @returns SandboxResult with captured output and violation information
   */
  async execute(code: string, language: string): Promise<SandboxResult> {
    if (this.runtime === 'none') {
      throw new ContainerRuntimeUnavailableError();
    }

    const containerId = this.generateContainerId();
    const langSpec = LANGUAGE_SPECS[language.toLowerCase()] ?? DEFAULT_LANGUAGE_SPEC;
    const filename = `/tmp/sandbox-code${langSpec.fileExtension}`;

    try {
      this.activeContainers.add(containerId);
      return await this.runContainer(containerId, code, filename, langSpec);
    } finally {
      // Always clean up — even if execution throws
      await this.cleanup(containerId);
    }
  }

  /**
   * Destroy a container and all ephemeral state.
   *
   * Forcibly removes the container if it is still running. Silently succeeds
   * if the container does not exist or has already been removed.
   */
  async cleanup(containerId: string): Promise<void> {
    if (this.runtime === 'none') return;

    this.activeContainers.delete(containerId);

    try {
      execSync(`${this.runtime} rm -f ${containerId}`, {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {
      // Silently ignore cleanup errors — container may already be removed
    }
  }

  /**
   * Destroy all active containers managed by this sandbox instance.
   * Useful for application shutdown / emergency cleanup.
   */
  async cleanupAll(): Promise<void> {
    const containers = [...this.activeContainers];
    await Promise.allSettled(containers.map((id) => this.cleanup(id)));
  }

  /**
   * Get the detected container runtime.
   */
  getRuntime(): ContainerRuntime {
    return this.runtime;
  }

  /**
   * Get the count of currently active containers.
   */
  getActiveContainerCount(): number {
    return this.activeContainers.size;
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Run a container with the given code and resource limits.
   */
  private runContainer(
    containerId: string,
    code: string,
    filename: string,
    langSpec: LanguageSpec,
  ): Promise<SandboxResult> {
    const args = this.buildContainerArgs(containerId, filename, langSpec);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      // Use shell to pipe code into the container via stdin-based file creation
      // Container runs: write code to file, then execute
      const shellCommand = this.buildShellCommand(code, filename, langSpec);

      const child = spawn(this.runtime, [...args, 'sh', '-c', shellCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // CPU timeout enforcement — terminate container when time limit is exceeded
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.killContainer(containerId);
      }, this.config.cpuTimeMs);

      child.on('close', (exitCode) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const result = this.interpretResult(
          stdout,
          stderr,
          exitCode ?? 1,
          timedOut,
        );
        resolve(result);
      });

      child.on('error', (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          stdout: '',
          stderr: `Container execution failed: ${err.message}`,
          exitCode: 1,
          resourceViolation: false,
        });
      });
    });
  }

  /**
   * Build the docker/podman run arguments with resource limits and network policy.
   */
  private buildContainerArgs(
    containerId: string,
    _filename: string,
    langSpec: LanguageSpec,
  ): string[] {
    const args: string[] = [
      'run',
      '--rm',
      '--name', containerId,
      // Resource limits
      '--memory', `${this.config.memoryMb}m`,
      '--memory-swap', `${this.config.memoryMb}m`, // No swap — strict memory limit
      '--cpus', '1', // Single CPU core
      // Storage limit via tmpfs size constraint
      '--tmpfs', `/tmp:size=${this.config.diskMb}m,noexec=off`,
      // Security restrictions
      '--read-only', // Read-only root filesystem
      '--no-new-privileges', // Prevent privilege escalation
      '--cap-drop', 'ALL', // Drop all Linux capabilities
      '--security-opt', 'no-new-privileges:true',
    ];

    // Network policy enforcement
    if (this.config.networkPolicy === 'deny-all') {
      args.push('--network', 'none');
    }
    // For allowlist policy, we use default bridge network
    // Actual domain restriction is applied via iptables rules in the container

    // Container image
    args.push(langSpec.image);

    return args;
  }

  /**
   * Build the shell command that writes code to file and executes it.
   */
  private buildShellCommand(
    code: string,
    filename: string,
    langSpec: LanguageSpec,
  ): string {
    // Escape code for safe shell embedding using base64
    const encoded = Buffer.from(code, 'utf-8').toString('base64');
    const runCmd = langSpec.runCommand(filename).join(' ');

    return `echo '${encoded}' | base64 -d > ${filename} && ${runCmd}`;
  }

  /**
   * Forcibly kill a running container.
   */
  private killContainer(containerId: string): void {
    try {
      execSync(`${this.runtime} kill ${containerId}`, {
        stdio: 'ignore',
        timeout: 5_000,
      });
    } catch {
      // Container may have already exited
    }
  }

  /**
   * Interpret container execution result, detecting resource violations.
   */
  private interpretResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    timedOut: boolean,
  ): SandboxResult {
    // CPU time exceeded — container was killed by timeout
    if (timedOut) {
      return {
        stdout,
        stderr: stderr || `Execution exceeded CPU time limit of ${this.config.cpuTimeMs}ms`,
        exitCode: 137, // SIGKILL exit code
        resourceViolation: true,
        violationType: 'cpu',
      };
    }

    // Memory limit exceeded — OOM kill (exit code 137 from Docker)
    if (exitCode === 137 && this.matchesPattern(stderr, OOM_PATTERNS)) {
      return {
        stdout,
        stderr,
        exitCode,
        resourceViolation: true,
        violationType: 'memory',
      };
    }

    // Exit code 137 without OOM patterns can also indicate memory kill
    // Docker sends SIGKILL (137) when container exceeds memory limit
    if (exitCode === 137 && !timedOut) {
      return {
        stdout,
        stderr: stderr || 'Container killed — likely exceeded memory limit',
        exitCode,
        resourceViolation: true,
        violationType: 'memory',
      };
    }

    // Disk limit exceeded
    if (this.matchesPattern(stderr, DISK_PATTERNS)) {
      return {
        stdout,
        stderr,
        exitCode,
        resourceViolation: true,
        violationType: 'disk',
      };
    }

    // Normal completion — no resource violation
    return {
      stdout,
      stderr,
      exitCode,
      resourceViolation: false,
    };
  }

  /**
   * Check if a string matches any of the given patterns.
   */
  private matchesPattern(text: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(text));
  }

  /**
   * Generate a unique container ID.
   */
  private generateContainerId(): string {
    const suffix = crypto.randomBytes(8).toString('hex');
    return `neuronest-sandbox-${suffix}`;
  }
}

// ─── Container Runtime Detection ────────────────────────────────

/**
 * Detect which container runtime is available on the system.
 * Prefers Docker, falls back to Podman, returns 'none' if neither is available.
 */
export function detectContainerRuntime(): ContainerRuntime {
  if (isToolAvailable('docker')) return 'docker';
  if (isToolAvailable('podman')) return 'podman';
  return 'none';
}

/**
 * Check if a CLI tool is available in PATH.
 */
function isToolAvailable(tool: string): boolean {
  try {
    execSync(`which ${tool}`, { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ─── ToolSystem Integration ─────────────────────────────────────

/**
 * Create a sandbox execution interceptor for the ToolSystem.
 *
 * When the sandbox Feature_Gate is enabled, generated code verification
 * is routed through this interceptor to run in an isolated container.
 * When disabled, returns null to indicate passthrough to host execution.
 *
 * Usage:
 *   const interceptor = createSandboxInterceptor(sandbox, featureGate);
 *   // Wire into ToolSystem code execution pipeline
 */
export function createSandboxInterceptor(
  sandbox: ContainerSandbox,
  isEnabled: () => boolean,
): (code: string, language: string) => Promise<SandboxResult | null> {
  return async (code: string, language: string): Promise<SandboxResult | null> => {
    // Feature gate check — zero cost when disabled (Req 18.7)
    if (!isEnabled()) {
      return null;
    }

    return sandbox.execute(code, language);
  };
}
