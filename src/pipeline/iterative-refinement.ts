/**
 * Iterative Refinement — Agent executes, checks, and retries until correct.
 *
 * Pattern: execute → verify → fix → verify → ... until success or max iterations.
 * Each iteration produces an observation that feeds into the next attempt.
 */

import { currentDateContext } from './date-grounding';
import { PERF_FLAGS } from '../main/performance/feature-flags';

export interface RefinementConfig {
  maxIterations: number;  // Max retry attempts (default: 5)
  successCriteria?: string; // What "success" looks like (regex or description)
  verifyCommand?: string;  // Command to run to verify (e.g., "npm test")
  autoFix: boolean;        // Let agent auto-fix on failure
}

export interface RefinementStep {
  iteration: number;
  action: string;
  output: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface RefinementResult {
  success: boolean;
  totalIterations: number;
  steps: RefinementStep[];
  finalOutput: string;
  totalDurationMs: number;
}

const DEFAULT_CONFIG: RefinementConfig = {
  maxIterations: 5,
  autoFix: true,
};

/**
 * Assemble the refinement prompt sent to the LLM when retrying a failed
 * attempt.
 *
 * F5_Call_Site (Date_Grounding_Preamble): when `DATE_GROUNDING_ENABLED` is
 * `true`, the current-date preamble (`currentDateContext()`) is prepended to
 * the refinement prompt so the model grounds any year-sensitive reasoning in
 * the real current date rather than a training-cutoff year. When the flag is
 * `false`, the prompt is emitted unchanged.
 *
 * Backward-compatible: callers that pass only a body string receive that body
 * verbatim when the flag is off.
 *
 * Validates: Requirement 34.3
 *
 * @param body - The refinement instruction/prompt body to send to the LLM.
 * @param now - Optional reference date forwarded to `currentDateContext` for
 *   deterministic output under a frozen clock (tests).
 * @returns The refinement prompt, optionally prefixed with the date preamble.
 */
export function buildRefinementPrompt(body: string, now?: Date): string {
  if (PERF_FLAGS.DATE_GROUNDING_ENABLED) {
    return currentDateContext(now) + body;
  }
  return body;
}

export class IterativeRefinement {
  private config: RefinementConfig;

  constructor(config?: Partial<RefinementConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run an iterative refinement loop.
   *
   * @param execute - Function that runs the action and returns output
   * @param verify - Function that checks if the output is correct
   * @param fix - Function that attempts to fix failures (receives error + previous output)
   */
  async run(
    execute: () => Promise<{ output: string; exitCode: number }>,
    verify: (output: string) => Promise<{ success: boolean; error?: string }>,
    fix?: (error: string, previousOutput: string) => Promise<string>,
  ): Promise<RefinementResult> {
    const steps: RefinementStep[] = [];
    const totalStart = Date.now();
    let lastOutput = '';

    for (let i = 0; i < this.config.maxIterations; i++) {
      const stepStart = Date.now();

      // Execute
      let execResult: { output: string; exitCode: number };
      try {
        execResult = await execute();
      } catch (e: any) {
        steps.push({
          iteration: i + 1,
          action: 'execute',
          output: '',
          success: false,
          error: e.message,
          durationMs: Date.now() - stepStart,
        });
        continue;
      }

      lastOutput = execResult.output;

      // Verify
      const verification = await verify(execResult.output);

      steps.push({
        iteration: i + 1,
        action: i === 0 ? 'initial execution' : 'retry after fix',
        output: execResult.output.slice(0, 2000),
        success: verification.success,
        error: verification.error,
        durationMs: Date.now() - stepStart,
      });

      if (verification.success) {
        return {
          success: true,
          totalIterations: i + 1,
          steps,
          finalOutput: lastOutput,
          totalDurationMs: Date.now() - totalStart,
        };
      }

      // Fix (if auto-fix enabled and fix function provided)
      if (this.config.autoFix && fix && verification.error) {
        try {
          const fixResult = await fix(verification.error, lastOutput);
          steps.push({
            iteration: i + 1,
            action: 'auto-fix applied',
            output: fixResult.slice(0, 2000),
            success: true,
            durationMs: Date.now() - stepStart,
          });
        } catch (e: any) {
          steps.push({
            iteration: i + 1,
            action: 'auto-fix failed',
            output: '',
            success: false,
            error: e.message,
            durationMs: Date.now() - stepStart,
          });
        }
      }
    }

    return {
      success: false,
      totalIterations: this.config.maxIterations,
      steps,
      finalOutput: lastOutput,
      totalDurationMs: Date.now() - totalStart,
    };
  }

  /**
   * Simple command-based refinement: run a command, check exit code.
   */
  async runCommand(
    command: string,
    executor: (cmd: string) => Promise<{ output: string; exitCode: number }>,
    successExitCode: number = 0,
  ): Promise<RefinementResult> {
    return this.run(
      () => executor(command),
      async (output) => {
        // Check if the command output indicates success
        const lastLine = output.trim().split('\n').pop() || '';
        if (this.config.successCriteria) {
          const regex = new RegExp(this.config.successCriteria, 'i');
          return { success: regex.test(output), error: regex.test(output) ? undefined : `Output doesn't match criteria: ${this.config.successCriteria}` };
        }
        return { success: true }; // Default: any output is success
      },
    );
  }

  getConfig(): RefinementConfig { return { ...this.config }; }
}
