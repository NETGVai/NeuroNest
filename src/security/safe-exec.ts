/**
 * SafeExec — secure subprocess execution without shell interpretation.
 *
 * Wraps `child_process.execFile` with argument-array interface and an optional
 * command allowlist. Replaces all `execSync` with string interpolation patterns.
 *
 * Design Decision: `execFile` (not `exec`) avoids shell interpretation entirely.
 * Arguments are passed verbatim to the subprocess — no metacharacter expansion.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */

import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SafeExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface SafeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── Errors ─────────────────────────────────────────────────────

export class CommandNotAllowedError extends Error {
  constructor(command: string, allowlist: string[]) {
    super(
      `Command "${command}" is not in the allowlist. Allowed: ${allowlist.join(', ')}`,
    );
    this.name = 'CommandNotAllowedError';
  }
}

export class ExecTimeoutError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(command: string, timeout: number, stdout: string, stderr: string) {
    super(`Command "${command}" timed out after ${timeout}ms`);
    this.name = 'ExecTimeoutError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// ─── Command Validation ─────────────────────────────────────────

/**
 * Validates that a command is in the allowlist of permitted executables.
 * Compares just the basename of the command against each allowlist entry's basename.
 *
 * @param command - The executable path or name to validate.
 * @param allowlist - Array of allowed executable names or paths.
 * @returns true if the command is permitted, false otherwise.
 */
export function validateCommand(
  command: string,
  allowlist: string[],
): boolean {
  if (!command || allowlist.length === 0) {
    return false;
  }

  const commandBasename = path.basename(command);

  return allowlist.some((allowed) => {
    const allowedBasename = path.basename(allowed);
    // Match against full path or basename
    return command === allowed || commandBasename === allowedBasename;
  });
}

// ─── Async Execution ────────────────────────────────────────────

/**
 * Executes a command using `child_process.execFile` with an argument array.
 * No shell interpretation — arguments are passed verbatim to the subprocess.
 *
 * @param command - The executable to run.
 * @param args - Array of arguments passed verbatim (no shell expansion).
 * @param options - Optional execution options (cwd, timeout, env).
 * @returns Promise resolving to execution result with stdout, stderr, and exit code.
 */
export function safeExecFile(
  command: string,
  args: string[],
  options?: SafeExecOptions,
): Promise<SafeExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        timeout: options?.timeout ?? 0,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        shell: false,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // Check if it was a timeout (killed)
          if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            reject(
              new ExecTimeoutError(
                command,
                options?.timeout ?? 0,
                stdout ?? '',
                stderr ?? '',
              ),
            );
            return;
          }

          // Non-zero exit code is not an exception — return it in the result
          if (typeof (error as any).code === 'number' || error.message.includes('exited with code')) {
            resolve({
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              exitCode: (error as any).code ?? 1,
            });
            return;
          }

          // Other errors (e.g., command not found)
          reject(error);
          return;
        }

        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: 0,
        });
      },
    );

    // Handle the case where the child process is killed due to timeout
    if (options?.timeout && options.timeout > 0) {
      child.on('error', (err) => {
        // Already handled in the callback above
        void err;
      });
    }
  });
}

// ─── Synchronous Execution ──────────────────────────────────────

/**
 * Executes a command synchronously using `child_process.execFileSync` with an argument array.
 * No shell interpretation — arguments are passed verbatim to the subprocess.
 *
 * @param command - The executable to run.
 * @param args - Array of arguments passed verbatim (no shell expansion).
 * @param options - Optional execution options (cwd, timeout, env).
 * @returns Execution result with stdout, stderr, and exit code.
 */
export function safeExecFileSync(
  command: string,
  args: string[],
  options?: SafeExecOptions,
): SafeExecResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 0,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      shell: false,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      stdout: stdout ?? '',
      stderr: '',
      exitCode: 0,
    };
  } catch (error: unknown) {
    const err = error as any;

    // Timeout — process was killed
    if (err.killed || err.signal === 'SIGTERM') {
      throw new ExecTimeoutError(
        command,
        options?.timeout ?? 0,
        err.stdout?.toString() ?? '',
        err.stderr?.toString() ?? '',
      );
    }

    // Non-zero exit code — return as result (not an exception)
    if (typeof err.status === 'number') {
      return {
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? '',
        exitCode: err.status,
      };
    }

    // Other errors (e.g., command not found)
    throw error;
  }
}
