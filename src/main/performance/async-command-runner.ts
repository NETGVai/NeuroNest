/**
 * AsyncCommandRunner - Non-blocking command execution with streaming output.
 *
 * Replaces synchronous execSync calls for lint, test, and build commands
 * with child_process.spawn-based async execution. Supports streaming output,
 * timeout enforcement, cancellation, and concurrent command tracking.
 */
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { CommandOptions, CommandResult, CommandProgress } from './types';

interface ActiveCommand {
  id: string;
  process: ChildProcess;
  startedAt: number;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

export class AsyncCommandRunner {
  private activeProcesses: Map<string, ActiveCommand> = new Map();

  /**
   * Execute a command asynchronously with streaming output.
   * Uses child_process.spawn with shell mode for non-blocking execution.
   */
  execute(
    command: string,
    options: CommandOptions,
    onProgress?: (progress: CommandProgress) => void
  ): Promise<CommandResult> {
    const commandId = randomUUID();
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve) => {
      const shell = options.shell !== undefined ? options.shell : true;

      const child = spawn(command, [], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;

      const activeCommand: ActiveCommand = {
        id: commandId,
        process: child,
        startedAt,
        timeoutTimer: null,
        killTimer: null,
      };

      this.activeProcesses.set(commandId, activeCommand);

      // Set up timeout enforcement
      if (options.timeout > 0) {
        activeCommand.timeoutTimer = setTimeout(() => {
          if (resolved) return;
          timedOut = true;
          this.killProcess(activeCommand);
        }, options.timeout);
      }

      // Stream stdout
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          if (onProgress) {
            onProgress({ commandId, stream: 'stdout', chunk });
          }
        });
      }

      // Stream stderr
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          if (onProgress) {
            onProgress({ commandId, stream: 'stderr', chunk });
          }
        });
      }

      // Handle process errors (e.g., spawn failure)
      child.on('error', (err: Error) => {
        if (resolved) return;
        resolved = true;
        this.cleanup(activeCommand);

        resolve({
          exitCode: 127,
          stdout,
          stderr: stderr || err.message,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        });
      });

      // Handle process completion
      child.on('close', (exitCode: number | null) => {
        if (resolved) return;
        resolved = true;
        this.cleanup(activeCommand);

        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  /**
   * Cancel a running command by ID.
   * Sends SIGTERM first, then SIGKILL after 5 seconds if the process hasn't exited.
   */
  cancel(commandId: string): void {
    const activeCommand = this.activeProcesses.get(commandId);
    if (!activeCommand) return;
    this.killProcess(activeCommand);
  }

  /**
   * Get count of currently active processes.
   */
  getActiveCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Kill a process with SIGTERM, followed by SIGKILL after 5 seconds.
   * Uses process group kill to ensure child processes are also terminated.
   */
  private killProcess(activeCommand: ActiveCommand): void {
    const { process: child } = activeCommand;
    const pid = child.pid;

    // Send SIGTERM to the process group (negative pid kills the group)
    try {
      if (pid) {
        process.kill(-pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // Process may have already exited
    }

    // Schedule SIGKILL after 5 seconds if process hasn't exited
    activeCommand.killTimer = setTimeout(() => {
      try {
        if (pid) {
          process.kill(-pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Process may have already exited
      }
    }, 5000);
  }

  /**
   * Clean up timers and remove from active processes map.
   */
  private cleanup(activeCommand: ActiveCommand): void {
    if (activeCommand.timeoutTimer) {
      clearTimeout(activeCommand.timeoutTimer);
      activeCommand.timeoutTimer = null;
    }
    if (activeCommand.killTimer) {
      clearTimeout(activeCommand.killTimer);
      activeCommand.killTimer = null;
    }
    this.activeProcesses.delete(activeCommand.id);
  }
}
