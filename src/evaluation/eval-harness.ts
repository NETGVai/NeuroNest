/**
 * Evaluation Harness — CI gate that runs correctness checks after Agent Loop modifications.
 *
 * Default checks: TypeScript type check (tsc --noEmit), ESLint, test runner (vitest).
 * On failure: feeds errors back into the Agent Loop for self-correction (max 2 retries).
 * Supports custom evaluation scripts in `.neuronest/eval/` directory.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

/** Result of a single check execution */
export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
  errors: string[];
}

/** Aggregate result from all checks */
export interface EvalResult {
  passed: boolean;
  checks: CheckResult[];
}

/** Options for running a check as a child process */
export interface CheckOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

/** Interface for the Agent Loop correction callback */
export interface AgentLoopCorrector {
  correctErrors(errors: string[]): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const CUSTOM_EVAL_DIR = '.neuronest/eval';

// ─── Helper: Run a child process and capture output ─────────────

/**
 * Execute a command as a child process, capturing stdout/stderr.
 * Returns the combined output and exit code.
 */
export function runProcess(options: CheckOptions): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const { command, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return new Promise((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    child.stdout?.on('data', (data: Buffer) => {
      stdoutChunks.push(data.toString());
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: code ?? 1,
        timedOut,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: `Process error: ${err.message}`,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

// ─── Helper: Parse errors from check output ─────────────────────

/**
 * Extract individual error lines from combined stdout/stderr output.
 * Filters empty lines and trims whitespace.
 */
export function parseErrors(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (
      line.includes('error') ||
      line.includes('Error') ||
      line.includes('ERR') ||
      line.includes('✗') ||
      line.includes('FAIL') ||
      line.includes('TS') ||
      // ESLint errors typically have line:col format
      /^\s*\d+:\d+/.test(line) ||
      // File paths with errors
      /\.\w+\(\d+,\d+\)/.test(line)
    ));
}

// ─── EvalHarness Class ──────────────────────────────────────────

export class EvalHarness {
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Run all default checks plus any custom scripts against changed files.
   *
   * Default checks:
   * 1. TypeScript type check: `tsc --noEmit`
   * 2. ESLint: `npx eslint <files>`
   * 3. Test runner: `npx vitest run --reporter=json`
   *
   * Custom scripts from `.neuronest/eval/` are also executed.
   */
  async runChecks(projectDir: string, filesChanged: string[]): Promise<EvalResult> {
    const checks: CheckResult[] = [];

    // 1. TypeScript type check
    const tscResult = await this.runTypeCheck(projectDir);
    checks.push(tscResult);

    // 2. ESLint on changed files
    if (filesChanged.length > 0) {
      const lintResult = await this.runLint(projectDir, filesChanged);
      checks.push(lintResult);
    }

    // 3. Test runner
    const testResult = await this.runTests(projectDir);
    checks.push(testResult);

    // 4. Custom evaluation scripts
    const customChecks = await this.runCustomScripts(projectDir, filesChanged);
    checks.push(...customChecks);

    const passed = checks.every((c) => c.passed);

    return { passed, checks };
  }

  /**
   * Run checks with self-correction: if checks fail, feed errors to the agent loop
   * for automatic fix, then re-run checks. Retries up to maxRetries times.
   */
  async runWithSelfCorrection(
    projectDir: string,
    filesChanged: string[],
    agentLoop: AgentLoopCorrector,
    maxRetries: number = 2,
  ): Promise<EvalResult> {
    let attempt = 0;
    let result: EvalResult;

    // Initial run
    result = await this.runChecks(projectDir, filesChanged);

    while (!result.passed && attempt < maxRetries) {
      attempt++;

      // Collect all errors from failed checks
      const allErrors = result.checks
        .filter((c) => !c.passed)
        .flatMap((c) => c.errors.length > 0 ? c.errors : [`${c.name} failed: ${c.output.slice(0, 500)}`]);

      // Feed errors back to the agent loop for correction
      await agentLoop.correctErrors(allErrors);

      // Re-run checks after correction
      result = await this.runChecks(projectDir, filesChanged);
    }

    return result;
  }

  /**
   * Run TypeScript type check using `tsc --noEmit`.
   */
  async runTypeCheck(projectDir: string): Promise<CheckResult> {
    const { stdout, stderr, exitCode, timedOut } = await runProcess({
      command: 'npx',
      args: ['tsc', '--noEmit'],
      cwd: projectDir,
      timeoutMs: this.timeoutMs,
    });

    const output = (stdout + '\n' + stderr).trim();

    if (timedOut) {
      return {
        name: 'TypeScript type check',
        passed: false,
        output: 'TypeScript type check timed out',
        errors: ['tsc --noEmit timed out after ' + this.timeoutMs + 'ms'],
      };
    }

    const passed = exitCode === 0;
    const errors = passed ? [] : parseErrors(output);

    return {
      name: 'TypeScript type check',
      passed,
      output,
      errors,
    };
  }

  /**
   * Run ESLint on the specified files.
   */
  async runLint(projectDir: string, filesChanged: string[]): Promise<CheckResult> {
    // Filter to only lint TypeScript/JavaScript files
    const lintableFiles = filesChanged.filter((f) =>
      /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(f),
    );

    if (lintableFiles.length === 0) {
      return {
        name: 'ESLint',
        passed: true,
        output: 'No lintable files changed',
        errors: [],
      };
    }

    const { stdout, stderr, exitCode, timedOut } = await runProcess({
      command: 'npx',
      args: ['eslint', ...lintableFiles],
      cwd: projectDir,
      timeoutMs: this.timeoutMs,
    });

    const output = (stdout + '\n' + stderr).trim();

    if (timedOut) {
      return {
        name: 'ESLint',
        passed: false,
        output: 'ESLint timed out',
        errors: ['ESLint timed out after ' + this.timeoutMs + 'ms'],
      };
    }

    const passed = exitCode === 0;
    const errors = passed ? [] : parseErrors(output);

    return {
      name: 'ESLint',
      passed,
      output,
      errors,
    };
  }

  /**
   * Run the test suite using vitest.
   */
  async runTests(projectDir: string): Promise<CheckResult> {
    const { stdout, stderr, exitCode, timedOut } = await runProcess({
      command: 'npx',
      args: ['vitest', 'run', '--reporter=json'],
      cwd: projectDir,
      timeoutMs: this.timeoutMs,
    });

    const output = (stdout + '\n' + stderr).trim();

    if (timedOut) {
      return {
        name: 'Test runner',
        passed: false,
        output: 'Test runner timed out',
        errors: ['vitest run timed out after ' + this.timeoutMs + 'ms'],
      };
    }

    const passed = exitCode === 0;
    const errors = passed ? [] : this.parseTestErrors(output);

    return {
      name: 'Test runner',
      passed,
      output,
      errors,
    };
  }

  /**
   * Scan `.neuronest/eval/` directory for custom evaluation scripts and run each one.
   * Scripts receive changed files as arguments.
   */
  async runCustomScripts(projectDir: string, filesChanged: string[]): Promise<CheckResult[]> {
    const evalDir = path.join(projectDir, CUSTOM_EVAL_DIR);
    const results: CheckResult[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(evalDir);
    } catch {
      // Directory doesn't exist — no custom scripts
      return results;
    }

    for (const entry of entries) {
      const scriptPath = path.join(evalDir, entry);

      // Check if the file is executable (or at least a regular file)
      let stat: import('fs').Stats;
      try {
        stat = await fs.stat(scriptPath) as unknown as import('fs').Stats;
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;

      const { stdout, stderr, exitCode, timedOut } = await runProcess({
        command: scriptPath,
        args: filesChanged,
        cwd: projectDir,
        timeoutMs: this.timeoutMs,
      });

      const output = (stdout + '\n' + stderr).trim();
      const passed = exitCode === 0 && !timedOut;

      let errors: string[] = [];
      if (timedOut) {
        errors = [`Custom script '${entry}' timed out after ${this.timeoutMs}ms`];
      } else if (!passed) {
        errors = parseErrors(output);
        if (errors.length === 0) {
          errors = [`Custom script '${entry}' exited with code ${exitCode}`];
        }
      }

      results.push({
        name: `Custom: ${entry}`,
        passed,
        output,
        errors,
      });
    }

    return results;
  }

  /**
   * Parse test-specific errors from vitest JSON output.
   */
  private parseTestErrors(output: string): string[] {
    // Try parsing as JSON first (vitest --reporter=json output)
    try {
      const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const errors: string[] = [];
        if (parsed.testResults) {
          for (const suite of parsed.testResults) {
            if (suite.status === 'failed') {
              for (const tc of suite.assertionResults || []) {
                if (tc.status === 'failed') {
                  errors.push(`${tc.fullName}: ${(tc.failureMessages || []).join('; ')}`);
                }
              }
            }
          }
        }
        if (errors.length > 0) return errors;
      }
    } catch {
      // Fall through to line-based parsing
    }

    // Fallback: parse error lines
    return parseErrors(output);
  }
}
