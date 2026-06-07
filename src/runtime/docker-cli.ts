import { execFile, spawn as cpSpawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

/**
 * Custom error thrown when a Docker CLI command fails with a non-zero exit code.
 */
export class DockerCliError extends Error {
  public readonly exitCode: number;
  public readonly stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = 'DockerCliError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Thin wrapper around child_process for Docker CLI invocations.
 * All commands use execFile/spawn — never exec() with shell interpolation —
 * to avoid command injection.
 */
export class DockerCli {
  /**
   * Execute a docker command and return stdout.
   * Throws DockerCliError on non-zero exit.
   */
  async exec(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile('docker', args, (error, stdout, stderr) => {
        if (error) {
          const exitCode = error.code != null && typeof error.code === 'number'
            ? error.code
            : (error as NodeJS.ErrnoException & { status?: number }).status ?? 1;
          reject(new DockerCliError(
            `docker ${args.join(' ')} failed with exit code ${exitCode}`,
            exitCode,
            stderr,
          ));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Execute a docker command and stream stdout/stderr line-by-line.
   * Returns the ChildProcess for lifecycle management.
   */
  spawn(args: string[], onLine: (line: string) => void): ChildProcess {
    const child = cpSpawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    if (child.stdout) {
      const stdoutRl = createInterface({ input: child.stdout });
      stdoutRl.on('line', onLine);
    }

    if (child.stderr) {
      const stderrRl = createInterface({ input: child.stderr });
      stderrRl.on('line', onLine);
    }

    return child;
  }

  /**
   * Check if docker CLI is on PATH.
   */
  async isInstalled(): Promise<boolean> {
    try {
      await this.exec(['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if docker daemon is responsive.
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      await this.exec(['info', '--format', '{{.ServerVersion}}']);
      return true;
    } catch {
      return false;
    }
  }
}
