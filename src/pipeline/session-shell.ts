/**
 * Session Shell — Persistent PTY-based shell session per agent task.
 *
 * Maintains one persistent shell process per agent task inside the existing
 * sandbox profile. Commands are written to the shell using sentinel-delimited
 * output capture, preserving cwd, env vars, and process state across commands.
 *
 * Features:
 *   - Persistent execution as the default `run` action (state-preserving)
 *   - One-shot `spawn` for explicitly isolated commands
 *   - Per-command timeout with hard kill
 *   - Hard kill on task end (no orphaned processes)
 *   - Shell state (cwd, env var names) included in condensed summary block
 *   - Sandbox security profiles applied identically to persistent and one-shot modes
 *   - Feature-gated behind `session_shell` flag
 *   - Graceful fallback to per-command spawn on any persistent shell failure
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.6, 25.4
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { SandboxProfile } from '../sandbox/sandbox-profile-loader.js';
import { generateSeatbeltProfile, generateBwrapFlags } from '../sandbox/sandbox-isolator.js';
import { platform } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Public Interfaces ──────────────────────────────────────────────────────

export interface ShellState {
  cwd: string;
  envVarNames: string[];
  pid: number;
  alive: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SessionShell {
  run(command: string, timeoutMs?: number): Promise<CommandResult>;
  spawn(command: string, timeoutMs?: number): Promise<CommandResult>;
  getState(): ShellState;
  kill(): void;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface SessionShellConfig {
  /** Default per-command timeout in milliseconds. */
  defaultTimeoutMs: number;
  /** Working directory for the shell session. */
  workspaceDir: string;
  /** Sandbox profile to apply (same for persistent and one-shot). */
  sandboxProfile: SandboxProfile;
  /** Whether sandbox enforcement is available on this platform. */
  sandboxAvailable: boolean;
  /** Platform sandbox type. */
  platformType: 'seatbelt' | 'bwrap' | 'none';
}

export const DEFAULT_SESSION_SHELL_CONFIG: Partial<SessionShellConfig> = {
  defaultTimeoutMs: 30_000,
};

// ─── Sentinel Constants ─────────────────────────────────────────────────────

/** Unique sentinel used to delimit command output in the persistent shell. */
const SENTINEL_PREFIX = '__NEURONEST_SHELL_SENTINEL_';

/** Generate a unique sentinel for a command execution. */
function makeSentinel(): string {
  return `${SENTINEL_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

// ─── SessionShell Implementation ────────────────────────────────────────────

export class SessionShellImpl implements SessionShell {
  private process: ChildProcess | null = null;
  private alive = false;
  private cwd: string;
  private envVarNames: string[] = [];
  private pid = -1;
  private readonly config: SessionShellConfig;
  private readonly featureGate: FeatureGateSystem;
  private fallbackMode = false;

  constructor(config: SessionShellConfig, featureGate: FeatureGateSystem) {
    this.config = config;
    this.featureGate = featureGate;
    this.cwd = config.workspaceDir;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Execute a command in the persistent shell session.
   * Preserves cwd, env vars, and process state across calls.
   * Falls back to one-shot spawn on any persistent shell failure.
   *
   * Requirement 20.3: Default `run` action for agents.
   */
  async run(command: string, timeoutMs?: number): Promise<CommandResult> {
    // Gate check (Requirement 25.4)
    if (!this.featureGate.isEnabled('session_shell')) {
      return this.spawn(command, timeoutMs);
    }

    // If in fallback mode due to prior failure, use spawn
    if (this.fallbackMode) {
      return this.spawn(command, timeoutMs);
    }

    try {
      // Ensure persistent shell is running
      if (!this.alive) {
        this.boot();
      }

      return await this.executeInPersistentShell(command, timeoutMs);
    } catch (err) {
      // Graceful fallback on any failure (Requirement 25.4)
      logger.warn('SessionShell persistent execution failed, falling back to spawn', {
        error: err instanceof Error ? err.message : String(err),
        command: command.slice(0, 100),
      });
      this.fallbackMode = true;
      return this.spawn(command, timeoutMs);
    }
  }

  /**
   * Execute a command in a one-shot isolated process.
   * Does not share state with the persistent shell.
   * Applies identical sandbox security profile.
   *
   * Requirement 20.3: Retained one-shot spawn for isolated commands.
   * Requirement 20.6: Same sandbox profile as persistent session.
   */
  async spawn(command: string, timeoutMs?: number): Promise<CommandResult> {
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    return this.executeOneShot(command, timeout);
  }

  /**
   * Get the current shell state for inclusion in condensed summary block.
   *
   * Requirement 20.4: Include shell state in condensed summary.
   */
  getState(): ShellState {
    return {
      cwd: this.cwd,
      envVarNames: [...this.envVarNames],
      pid: this.pid,
      alive: this.alive,
    };
  }

  /**
   * Kill the persistent shell and all child processes.
   * Called on task end to prevent orphaned processes.
   *
   * Requirement 20.2: Hard kill on task end, no orphaned processes.
   */
  kill(): void {
    if (this.process) {
      try {
        // Kill process group to prevent orphans
        if (this.process.pid) {
          try {
            process.kill(-this.process.pid, 'SIGKILL');
          } catch {
            // Process group kill may fail if already dead; try direct kill
            this.process.kill('SIGKILL');
          }
        } else {
          this.process.kill('SIGKILL');
        }
      } catch (err) {
        logger.warn('SessionShell kill failed (process may already be dead)', {
          pid: this.pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.process = null;
    }
    this.alive = false;
    this.pid = -1;
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  /**
   * Boot the persistent shell process with sandbox enforcement.
   * Uses setsid to create a process group for clean kill.
   */
  private boot(): void {
    const { workspaceDir, sandboxProfile, sandboxAvailable, platformType } = this.config;

    let spawnCmd: string;
    let spawnArgs: string[];

    if (sandboxAvailable && platformType !== 'none') {
      // Apply sandbox profile identically to persistent session (Requirement 20.6)
      if (platformType === 'seatbelt') {
        const seatbeltProfile = generateSeatbeltProfile(sandboxProfile);
        spawnCmd = 'sandbox-exec';
        spawnArgs = ['-p', seatbeltProfile, '/bin/bash', '--norc', '--noprofile', '-i'];
      } else {
        const bwrapFlags = generateBwrapFlags(sandboxProfile);
        spawnCmd = 'bwrap';
        spawnArgs = [...bwrapFlags, '--', '/bin/bash', '--norc', '--noprofile', '-i'];
      }
    } else {
      // No sandbox available — direct shell
      spawnCmd = '/bin/bash';
      spawnArgs = ['--norc', '--noprofile', '-i'];
    }

    this.process = spawn(spawnCmd, spawnArgs, {
      cwd: workspaceDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // Create process group for clean kill
    });

    if (!this.process.pid) {
      throw new Error('Failed to start persistent shell: no PID assigned');
    }

    this.pid = this.process.pid;
    this.alive = true;
    this.cwd = workspaceDir;

    // Monitor for unexpected exit
    this.process.on('exit', (code, signal) => {
      this.alive = false;
      logger.info('SessionShell persistent shell exited', { code, signal, pid: this.pid });
    });

    this.process.on('error', (err) => {
      this.alive = false;
      logger.warn('SessionShell persistent shell error', {
        error: err.message,
        pid: this.pid,
      });
    });

    // Set initial working directory
    this.writeToShell(`cd ${this.escapeShellArg(workspaceDir)}\n`);

    logger.info('SessionShell persistent shell booted', {
      pid: this.pid,
      workspaceDir,
      sandboxed: sandboxAvailable && platformType !== 'none',
    });
  }

  /**
   * Execute a command in the persistent shell using sentinel-delimited output capture.
   *
   * Protocol:
   *   1. Write a start sentinel marker to stdout/stderr
   *   2. Execute the command
   *   3. Write the exit code and end sentinel
   *   4. Collect output between start and end sentinels
   *
   * Requirement 20.1: Sentinel-delimited output capture.
   * Requirement 20.2: Per-command timeout enforcement.
   */
  private executeInPersistentShell(command: string, timeoutMs?: number): Promise<CommandResult> {
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    const sentinel = makeSentinel();
    const startMarker = `${sentinel}_START`;
    const endMarker = `${sentinel}_END`;

    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin || !this.process.stdout || !this.process.stderr) {
        reject(new Error('Persistent shell not available'));
        return;
      }

      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        this.process?.stdout?.removeListener('data', onStdout);
        this.process?.stderr?.removeListener('data', onStderr);
      };

      const finish = (exitCode: number, timedOut = false): void => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const durationMs = Date.now() - startTime;

        // Update shell state after command execution
        this.updateState();

        resolve({
          stdout: timedOut ? stdout : stdout,
          stderr: timedOut ? `Command timed out after ${timeout}ms\n${stderr}` : stderr,
          exitCode: timedOut ? 124 : exitCode, // 124 = timeout exit code (like GNU timeout)
          durationMs,
        });
      };

      const onStdout = (data: Buffer): void => {
        const chunk = data.toString();
        stdout += chunk;

        // Look for end sentinel with exit code
        const endIdx = stdout.indexOf(endMarker);
        if (endIdx !== -1) {
          // Parse exit code from the line before the end marker
          // Format: "EXIT_CODE:N\n<endMarker>\n"
          const exitCodeMatch = stdout.match(new RegExp(`EXIT_CODE:(\\d+)\\n${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
          const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

          // Extract output between start and end markers
          const startIdx = stdout.indexOf(startMarker);
          if (startIdx !== -1) {
            // Remove sentinel lines from captured output
            const capturedSection = stdout.slice(
              startIdx + startMarker.length + 1, // +1 for newline
              stdout.indexOf(`EXIT_CODE:`, endIdx - 20 > 0 ? endIdx - 20 : 0)
            );
            stdout = capturedSection.trimEnd();
          } else {
            stdout = stdout.slice(0, endIdx).trimEnd();
          }

          finish(exitCode);
        }
      };

      const onStderr = (data: Buffer): void => {
        stderr += data.toString();
      };

      this.process.stdout.on('data', onStdout);
      this.process.stderr.on('data', onStderr);

      // Set up per-command timeout (Requirement 20.2)
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          // Kill the current command but keep the shell alive if possible
          // Send SIGINT to interrupt the running command
          if (this.process?.pid) {
            try {
              // Send SIGINT to the process group to kill the command
              process.kill(-this.process.pid, 'SIGINT');
            } catch {
              // If process group signal fails, try direct
              this.process?.kill('SIGINT');
            }
          }
          finish(124, true);
        }
      }, timeout);

      // Write the sentinel-delimited command sequence
      // This echoes markers so we can delimit the output precisely
      const wrappedCommand = [
        `echo "${startMarker}"`,
        command,
        `__nn_ec=$?`,
        `echo "EXIT_CODE:$__nn_ec"`,
        `echo "${endMarker}"`,
      ].join('\n');

      this.writeToShell(wrappedCommand + '\n');
    });
  }

  /**
   * Execute a command in a one-shot process with sandbox enforcement.
   * Identical sandbox profile to the persistent session (Requirement 20.6).
   */
  private executeOneShot(command: string, timeoutMs: number): Promise<CommandResult> {
    const { workspaceDir, sandboxProfile, sandboxAvailable, platformType } = this.config;

    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      let spawnCmd: string;
      let spawnArgs: string[];

      if (sandboxAvailable && platformType !== 'none') {
        // Apply same sandbox profile as persistent session (Requirement 20.6)
        if (platformType === 'seatbelt') {
          const seatbeltProfile = generateSeatbeltProfile(sandboxProfile);
          spawnCmd = 'sandbox-exec';
          spawnArgs = ['-p', seatbeltProfile, 'sh', '-c', command];
        } else {
          const bwrapFlags = generateBwrapFlags(sandboxProfile);
          spawnCmd = 'bwrap';
          spawnArgs = [...bwrapFlags, '--', 'sh', '-c', command];
        }
      } else {
        spawnCmd = 'sh';
        spawnArgs = ['-c', command];
      }

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: workspaceDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // Process group for clean kill
      });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Per-command timeout (Requirement 20.2)
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.on('close', (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          stdout,
          stderr: timedOut ? `Command timed out after ${timeoutMs}ms` : stderr,
          exitCode: timedOut ? 124 : (code ?? 1),
          durationMs: Date.now() - startTime,
        });
      });

      child.on('error', (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Update the tracked shell state (cwd, env var names) by querying the shell.
   * This is called after each command execution to keep state current for
   * inclusion in the condensed summary block (Requirement 20.4).
   */
  private updateState(): void {
    if (!this.process || !this.alive) return;

    // Query cwd asynchronously — we don't block on this
    const cwdSentinel = makeSentinel();
    const cwdMarkerStart = `${cwdSentinel}_CWD_START`;
    const cwdMarkerEnd = `${cwdSentinel}_CWD_END`;

    let cwdBuffer = '';

    const onData = (data: Buffer): void => {
      cwdBuffer += data.toString();
      const startIdx = cwdBuffer.indexOf(cwdMarkerStart);
      const endIdx = cwdBuffer.indexOf(cwdMarkerEnd);

      if (startIdx !== -1 && endIdx !== -1) {
        const cwdValue = cwdBuffer.slice(startIdx + cwdMarkerStart.length + 1, endIdx).trim();
        if (cwdValue) {
          this.cwd = cwdValue;
        }

        // Parse env var names
        const envSection = cwdBuffer.slice(endIdx + cwdMarkerEnd.length);
        const envEndIdx = envSection.indexOf(`${cwdSentinel}_ENV_END`);
        if (envEndIdx !== -1) {
          const envNames = envSection.slice(0, envEndIdx).trim().split('\n').filter(Boolean);
          this.envVarNames = envNames;
        }

        this.process?.stdout?.removeListener('data', onData);
      }
    };

    this.process.stdout?.on('data', onData);

    // Query state without blocking
    const stateQuery = [
      `echo "${cwdMarkerStart}"`,
      `pwd`,
      `echo "${cwdMarkerEnd}"`,
      `env | cut -d= -f1 | sort`,
      `echo "${cwdSentinel}_ENV_END"`,
    ].join('\n');

    this.writeToShell(stateQuery + '\n');

    // Auto-cleanup listener after a short timeout to prevent leaks
    setTimeout(() => {
      this.process?.stdout?.removeListener('data', onData);
    }, 1000);
  }

  /**
   * Write a string to the persistent shell's stdin.
   */
  private writeToShell(input: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Shell stdin is not writable');
    }
    this.process.stdin.write(input);
  }

  /**
   * Escape a string for safe use in shell arguments.
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface CreateSessionShellOptions {
  workspaceDir: string;
  sandboxProfile: SandboxProfile;
  featureGate: FeatureGateSystem;
  defaultTimeoutMs?: number;
}

/**
 * Create a new SessionShell instance for an agent task.
 *
 * Detects platform sandbox availability and configures the shell accordingly.
 * The caller is responsible for calling `kill()` when the task ends to prevent
 * orphaned processes (Requirement 20.2).
 *
 * Usage:
 * ```typescript
 * const shell = createSessionShell({
 *   workspaceDir: '/path/to/project',
 *   sandboxProfile: profile,
 *   featureGate: gates,
 * });
 *
 * const result = await shell.run('npm install');
 * const state = shell.getState();
 * // ... later
 * shell.kill();
 * ```
 */
export function createSessionShell(options: CreateSessionShellOptions): SessionShell {
  const { workspaceDir, sandboxProfile, featureGate, defaultTimeoutMs } = options;

  // Detect platform sandbox type (same logic as SandboxIsolator)
  const platformType = detectPlatformType();
  const sandboxAvailable = platformType !== 'none';

  const config: SessionShellConfig = {
    defaultTimeoutMs: defaultTimeoutMs ?? 30_000,
    workspaceDir,
    sandboxProfile,
    sandboxAvailable,
    platformType,
  };

  return new SessionShellImpl(config, featureGate);
}

/**
 * Detect the platform sandbox type by checking tool availability.
 * Mirrors SandboxIsolator.detectPlatformType() logic.
 */
function detectPlatformType(): 'seatbelt' | 'bwrap' | 'none' {
  const os = platform();

  if (os === 'darwin') {
    if (isToolInPath('sandbox-exec')) {
      return 'seatbelt';
    }
  } else if (os === 'linux') {
    if (isToolInPath('bwrap')) {
      return 'bwrap';
    }
  }

  return 'none';
}

/**
 * Check if a tool is available in the system PATH.
 */
function isToolInPath(tool: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${tool}` : `which ${tool}`;
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Summary Block Helper ───────────────────────────────────────────────────

/**
 * Format shell state for inclusion in the condensed summary block.
 *
 * Requirement 20.4: Include shell state in condensed summary so the model
 * knows the shell's state without re-querying.
 *
 * @returns A compact string representation of the shell state.
 */
export function formatShellStateForSummary(state: ShellState): string {
  if (!state.alive) {
    return '[Shell: not active]';
  }

  const envDisplay = state.envVarNames.length > 10
    ? `${state.envVarNames.slice(0, 10).join(', ')} (+${state.envVarNames.length - 10} more)`
    : state.envVarNames.join(', ');

  return [
    `[Shell: pid=${state.pid}, cwd=${state.cwd}`,
    state.envVarNames.length > 0 ? `, env=[${envDisplay}]` : '',
    ']',
  ].join('');
}
