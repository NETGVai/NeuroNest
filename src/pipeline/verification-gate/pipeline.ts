/**
 * Verification Gate Pipeline — orchestrates sequential stage execution.
 * Stops at first failure, enforces total timeout, and computes numeric scores.
 */
import type {
  VerificationPipeline,
  VerificationPipelineConfig,
  VerificationResult,
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  StageName,
} from './types';
import { MAX_SCORE, STAGE_ORDER } from './types';
import { SyntaxStage } from './stages/syntax-stage';
import { TypecheckStage } from './stages/typecheck-stage';
import { LintStage } from './stages/lint-stage';
import { SecurityStage } from './stages/security-stage';
import { OverEngineeringReviewStage } from '../over-engineering-review';
import { TestGapDetectorStage } from './stages/test-gap-stage';
import { TestStage } from './stages/test-stage';
import { GUIAcceptanceStage } from './stages/gui-acceptance-stage';
import { SmokeStage } from './stages/smoke-stage';
import { BeforeMergeStage } from './stages/before-merge-stage';

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES_FOR_TIMEOUT = 10;

// ─── Pipeline Timeout Error ─────────────────────────────────────

export class PipelineTimeoutError extends Error {
  constructor(
    public readonly elapsedMs: number,
    public readonly timeoutMs: number,
    public readonly failedAtStage: StageName
  ) {
    super(`Pipeline timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms) at stage "${failedAtStage}"`);
    this.name = 'PipelineTimeoutError';
  }
}

// ─── Pipeline Implementation ────────────────────────────────────

export class VerificationGatePipeline implements VerificationPipeline {
  private config: VerificationPipelineConfig;

  constructor(config?: Partial<VerificationPipelineConfig>) {
    this.config = {
      timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxFilesForTimeout: config?.maxFilesForTimeout ?? DEFAULT_MAX_FILES_FOR_TIMEOUT,
      stages: config?.stages ?? this.createDefaultStages(),
    };
  }

  /**
   * Runs the verification pipeline sequentially, stopping at first failure.
   * Enforces 30-second total timeout for edits affecting <10 files.
   */
  async run(edit: AgentEdit, context: ProjectContext): Promise<VerificationResult> {
    const pipelineStart = Date.now();
    const completedStages: StageResult[] = [];
    let totalScore = 0;
    let failedAt: StageName | undefined;

    // Determine if timeout should be enforced
    const enforceTimeout = edit.changes.length < this.config.maxFilesForTimeout;
    const timeoutMs = enforceTimeout ? this.config.timeoutMs : Infinity;

    for (const stage of this.config.stages) {
      // Check total pipeline timeout before starting next stage
      const elapsed = Date.now() - pipelineStart;
      if (enforceTimeout && elapsed >= timeoutMs) {
        completedStages.push({
          stageName: stage.name,
          passed: false,
          diagnostics: [{
            file: '',
            line: 0,
            column: 0,
            message: `Pipeline timeout exceeded (${elapsed}ms / ${timeoutMs}ms)`,
            severity: 'error',
          }],
          durationMs: 0,
        });
        failedAt = stage.name;
        break;
      }

      // Execute the stage with a remaining-time budget
      const remainingMs = enforceTimeout ? timeoutMs - elapsed : Infinity;
      const stageResult = await this.executeStageWithTimeout(stage, edit, context, remainingMs);

      completedStages.push(stageResult);

      if (stageResult.passed) {
        totalScore += stage.score;
      } else {
        failedAt = stage.name;
        break; // Stop at first failure
      }
    }

    return {
      totalScore,
      maxScore: MAX_SCORE,
      stages: completedStages,
      accepted: !failedAt,
      failedAt,
      totalDurationMs: Date.now() - pipelineStart,
    };
  }

  /**
   * Executes a single stage with a timeout guard.
   */
  private async executeStageWithTimeout(
    stage: VerificationStage,
    edit: AgentEdit,
    context: ProjectContext,
    remainingMs: number
  ): Promise<StageResult> {
    if (remainingMs <= 0) {
      return {
        stageName: stage.name,
        passed: false,
        diagnostics: [{
          file: '',
          line: 0,
          column: 0,
          message: 'No time remaining in pipeline budget',
          severity: 'error',
        }],
        durationMs: 0,
      };
    }

    if (!isFinite(remainingMs)) {
      // No timeout constraint — run directly
      return stage.execute(edit, context);
    }

    // Race between stage execution and timeout
    const startTime = Date.now();
    const timeoutPromise = new Promise<StageResult>((resolve) => {
      setTimeout(() => {
        resolve({
          stageName: stage.name,
          passed: false,
          diagnostics: [{
            file: '',
            line: 0,
            column: 0,
            message: `Stage "${stage.name}" exceeded remaining pipeline budget (${remainingMs}ms)`,
            severity: 'error',
          }],
          durationMs: Date.now() - startTime,
        });
      }, remainingMs);
    });

    return Promise.race([stage.execute(edit, context), timeoutPromise]);
  }

  /**
   * Creates the default stage sequence.
   */
  private createDefaultStages(): VerificationStage[] {
    return [
      new SyntaxStage(),
      new TypecheckStage(),
      new LintStage(),
      new SecurityStage(),
      new OverEngineeringReviewStage(), // Runs BEFORE test-gap detection
      new TestGapDetectorStage(),        // Runs AFTER over-engineering review
      new TestStage(),
      new GUIAcceptanceStage(),          // Activated selectively for UI-touching tasks
      new SmokeStage(),
      new BeforeMergeStage(),            // Final stage — aggregates all quality signals
    ];
  }
}

/**
 * Creates a verification pipeline with default configuration.
 */
export function createVerificationPipeline(
  config?: Partial<VerificationPipelineConfig>
): VerificationPipeline {
  return new VerificationGatePipeline(config);
}
