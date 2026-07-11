/**
 * BuildVerifier — Post-execution build verification hook.
 *
 * Runs a verification pipeline (manifest → install → boot → health)
 * after code-generation phases complete. Registered as a CallbackEngine
 * post-execution hook on the 'on-task-complete' lifecycle event.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

// ─── Types ──────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  stage: 'manifest' | 'install' | 'boot' | 'health';
  error?: string;
  durationMs: number;
  attempt: number;
}

export interface BuildVerifierConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** How long to wait for the application to stay alive (default: 5000ms) */
  bootTimeoutMs: number;
  /** Optional health endpoint URL (e.g., "http://localhost:3000/health") */
  healthEndpoint?: string;
  /** Root directory of the project to verify */
  projectRoot: string;
}

/**
 * CallbackEngine interface for hook registration.
 * Matches the existing HookEngineLike contract.
 */
export interface CallbackEngine {
  registerHook(event: string, callback: (context: any) => Promise<void>): void;
}

// ─── Constants ──────────────────────────────────────────────────

/** Maximum time to wait for npm install before killing (60 seconds) */
const INSTALL_TIMEOUT_MS = 60_000;

/** Permission error codes that should not be retried */
const PERMISSION_ERROR_PATTERNS = [
  'EACCES',
  'EPERM',
  'permission denied',
  'Permission denied',
];

// ─── BuildVerifier ──────────────────────────────────────────────

export class BuildVerifier {
  private config: BuildVerifierConfig;
  private currentAttempt: number = 0;

  constructor(config: BuildVerifierConfig) {
    const resolvedConfig: BuildVerifierConfig = {
      maxRetries: config.maxRetries ?? 3,
      bootTimeoutMs: config.bootTimeoutMs ?? 5000,
      projectRoot: config.projectRoot,
    };
    if (config.healthEndpoint !== undefined) {
      resolvedConfig.healthEndpoint = config.healthEndpoint;
    }
    this.config = resolvedConfig;
  }

  /**
   * Run full verification pipeline: manifest → install → boot → health.
   * Returns on first failure or full pass.
   * Records durationMs and attempt number.
   *
   * Requirements: 5.1, 5.5, 5.6, 5.8
   */
  async verify(): Promise<VerificationResult> {
    this.currentAttempt++;
    const startTime = Date.now();

    // Stage 1: Check manifest
    const manifestResult = await this.checkManifest();
    if (!manifestResult.passed) {
      manifestResult.attempt = this.currentAttempt;
      manifestResult.durationMs = Date.now() - startTime;
      return manifestResult;
    }

    // Stage 2: Run install
    const installResult = await this.runInstall();
    if (!installResult.passed) {
      installResult.attempt = this.currentAttempt;
      installResult.durationMs = Date.now() - startTime;
      return installResult;
    }

    // Stage 3: Boot application
    const bootResult = await this.bootApplication();
    if (!bootResult.passed) {
      bootResult.attempt = this.currentAttempt;
      bootResult.durationMs = Date.now() - startTime;
      return bootResult;
    }

    // Stage 4: Health check
    const healthResult = await this.healthCheck();
    healthResult.attempt = this.currentAttempt;
    healthResult.durationMs = Date.now() - startTime;
    return healthResult;
  }

  /**
   * Register this verifier as a CallbackEngine post-execution hook.
   * Listens on 'on-task-complete' lifecycle event.
   *
   * Requirements: 5.7
   */
  registerHook(callbackEngine: CallbackEngine): void {
    callbackEngine.registerHook('on-task-complete', async (_context: any) => {
      await this.verify();
    });
  }

  /**
   * Check if package.json exists in the project root.
   *
   * No package.json → { passed: false, stage: 'manifest', error: 'No package.json found' }
   *
   * Requirements: 5.2
   */
  private async checkManifest(): Promise<VerificationResult> {
    const packageJsonPath = join(this.config.projectRoot, 'package.json');
    const exists = existsSync(packageJsonPath);

    if (!exists) {
      return {
        passed: false,
        stage: 'manifest',
        error: 'No package.json found',
        durationMs: 0,
        attempt: this.currentAttempt,
      };
    }

    return {
      passed: true,
      stage: 'manifest',
      durationMs: 0,
      attempt: this.currentAttempt,
    };
  }

  /**
   * Run npm install in the project root.
   * Exit code 0 → passed. Non-zero → failed.
   * Kill after 60s if hanging.
   *
   * Requirements: 5.3
   */
  private async runInstall(): Promise<VerificationResult> {
    return new Promise<VerificationResult>((resolve) => {
      let killed = false;
      let stderr = '';

      const child: ChildProcess = spawn('npm', ['install'], {
        cwd: this.config.projectRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: true,
      });

      // Collect stderr for error reporting
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      // Kill after 60s if hanging
      const timeout = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, INSTALL_TIMEOUT_MS);

      child.on('error', (err: Error) => {
        clearTimeout(timeout);
        const isPermissionError = this.isPermissionError(err.message);
        resolve({
          passed: false,
          stage: 'install',
          error: isPermissionError
            ? `Permission error: ${err.message}`
            : `Install process error: ${err.message}`,
          durationMs: 0,
          attempt: this.currentAttempt,
        });
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timeout);

        if (killed) {
          resolve({
            passed: false,
            stage: 'install',
            error: 'npm install timed out after 60s',
            durationMs: 0,
            attempt: this.currentAttempt,
          });
          return;
        }

        if (code === 0) {
          resolve({
            passed: true,
            stage: 'install',
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        } else {
          const errorMsg = stderr.trim() || `npm install exited with code ${code}`;
          resolve({
            passed: false,
            stage: 'install',
            error: errorMsg,
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        }
      });
    });
  }

  /**
   * Boot the application and confirm it stays alive for bootTimeoutMs.
   * Reads package.json scripts to find a start script, spawns it.
   * If process stays alive for bootTimeoutMs → passed.
   * If it crashes within that time → failed with stderr.
   *
   * Requirements: 5.4
   */
  private async bootApplication(): Promise<VerificationResult> {
    // Read package.json to find start script
    const packageJsonPath = join(this.config.projectRoot, 'package.json');
    let startScript: string | undefined;

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const scripts = packageJson.scripts as Record<string, string> | undefined;
      if (scripts) {
        // Look for start scripts in priority order
        startScript = scripts['start'] ?? scripts['dev'] ?? scripts['serve'];
      }
    } catch (err: any) {
      return {
        passed: false,
        stage: 'boot',
        error: `Failed to read package.json scripts: ${err.message}`,
        durationMs: 0,
        attempt: this.currentAttempt,
      };
    }

    if (!startScript) {
      return {
        passed: false,
        stage: 'boot',
        error: 'No start script found in package.json',
        durationMs: 0,
        attempt: this.currentAttempt,
      };
    }

    return new Promise<VerificationResult>((resolve) => {
      let stderr = '';
      let resolved = false;

      const child: ChildProcess = spawn('npm', ['run', 'start'], {
        cwd: this.config.projectRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: true,
      });

      // Collect stderr for error reporting
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      // If process stays alive for bootTimeoutMs → passed
      const bootTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGTERM');
          resolve({
            passed: true,
            stage: 'boot',
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        }
      }, this.config.bootTimeoutMs);

      child.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(bootTimer);
          resolve({
            passed: false,
            stage: 'boot',
            error: `Boot process error: ${err.message}`,
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        }
      });

      // If process exits before bootTimeoutMs → crash detected
      child.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(bootTimer);
          const errorMsg =
            stderr.trim() || `Application crashed with exit code ${code}`;
          resolve({
            passed: false,
            stage: 'boot',
            error: errorMsg,
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        }
      });
    });
  }

  /**
   * Perform health check if endpoint is configured.
   * Makes an HTTP GET request to the health endpoint.
   * 2xx → passed. Otherwise → failed.
   * If no endpoint configured → skip (return passed).
   *
   * Requirements: 5.4
   */
  private async healthCheck(): Promise<VerificationResult> {
    // No health endpoint → skip (return passed)
    if (!this.config.healthEndpoint) {
      return {
        passed: true,
        stage: 'health',
        durationMs: 0,
        attempt: this.currentAttempt,
      };
    }

    return new Promise<VerificationResult>((resolve) => {
      const endpoint = this.config.healthEndpoint!;
      const getter = endpoint.startsWith('https') ? httpsGet : httpGet;

      const req = getter(endpoint, (res) => {
        const statusCode = res.statusCode ?? 0;
        const passed = statusCode >= 200 && statusCode < 300;

        if (passed) {
          resolve({
            passed: true,
            stage: 'health',
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        } else {
          resolve({
            passed: false,
            stage: 'health',
            error: `Health check returned status ${statusCode}`,
            durationMs: 0,
            attempt: this.currentAttempt,
          });
        }
      });

      req.on('error', (err: Error) => {
        resolve({
          passed: false,
          stage: 'health',
          error: `Health check failed: ${err.message}`,
          durationMs: 0,
          attempt: this.currentAttempt,
        });
      });

      // Timeout health check after 10 seconds
      req.setTimeout(10_000, () => {
        req.destroy();
        resolve({
          passed: false,
          stage: 'health',
          error: 'Health check timed out after 10s',
          durationMs: 0,
          attempt: this.currentAttempt,
        });
      });
    });
  }

  /**
   * Check if an error message indicates a permission error.
   * Permission errors should not be retried.
   */
  private isPermissionError(message: string): boolean {
    return PERMISSION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
  }
}
