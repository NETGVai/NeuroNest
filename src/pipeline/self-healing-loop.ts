/**
 * Self-Healing Loop — feeds verification failures back to the agent as structured
 * feedback for automated repair. Retries up to maxAttempts, tracks token budget,
 * and escalates to the user when limits are exceeded or repair fails.
 *
 * Feedback includes: stage name, error message, affected file path, and line number.
 */
import type {
  AgentEdit,
  VerificationResult,
  ProjectContext,
  Diagnostic,
  StageName,
} from './verification-gate/types';

// ─── Configuration ──────────────────────────────────────────────

export interface SelfHealingConfig {
  /** Maximum number of repair attempts before escalating (default: 3) */
  maxAttempts: number;
  /** Per-task token budget ceiling */
  tokenBudget: number;
  /** Format for feedback sent to the agent */
  feedbackFormat: 'structured' | 'natural';
}

export const DEFAULT_SELF_HEALING_CONFIG: SelfHealingConfig = {
  maxAttempts: 3,
  tokenBudget: 50_000,
  feedbackFormat: 'structured',
};

// ─── Feedback Types ─────────────────────────────────────────────

/**
 * Structured feedback sent to the agent for each verification failure.
 * All four fields are always present per Requirement 12.1.
 */
export interface RepairFeedback {
  /** The verification stage that failed */
  stage: string;
  /** Non-empty error message describing the failure */
  errorMessage: string;
  /** Path to the affected file */
  filePath: string;
  /** Line number where the error was detected (positive integer) */
  lineNumber: number;
}

// ─── Repair Attempt Types ───────────────────────────────────────

export interface RepairAttempt {
  /** 1-based attempt number */
  attempt: number;
  /** The edit produced by the agent for this attempt */
  edit: AgentEdit;
  /** Verification result for this attempt's edit */
  result: VerificationResult;
  /** Tokens consumed by this repair attempt */
  tokensUsed: number;
}

// ─── Result Types ───────────────────────────────────────────────

export interface SelfHealingResult {
  /** Whether a repaired edit was accepted */
  accepted: boolean;
  /** The final accepted edit (if accepted) */
  finalEdit?: AgentEdit;
  /** All repair attempts made */
  attempts: RepairAttempt[];
  /** Cumulative tokens used across all attempts */
  totalTokensUsed: number;
  /** Whether the loop escalated to the user */
  escalatedToUser: boolean;
  /** Reason for escalation (if escalated) */
  escalationReason?: 'max_attempts_exceeded' | 'token_budget_exceeded';
}

// ─── Escalation Info ────────────────────────────────────────────

export interface EscalationInfo {
  /** The original edit that started the repair process */
  originalEdit: AgentEdit;
  /** All repair attempts with their diagnostics */
  attempts: RepairAttempt[];
  /** Total tokens consumed */
  totalTokensUsed: number;
  /** Why the loop escalated */
  reason: 'max_attempts_exceeded' | 'token_budget_exceeded';
}

// ─── Agent Repair Interface ─────────────────────────────────────

/**
 * Interface for the agent's repair capability.
 * Implementations send feedback to the agent and receive a repaired edit.
 */
export interface RepairAgent {
  /**
   * Sends verification feedback to the agent and receives a repaired edit.
   * @returns The repaired edit and token count used for this repair call
   */
  repair(
    originalEdit: AgentEdit,
    feedback: RepairFeedback[],
    context: ProjectContext,
  ): Promise<{ edit: AgentEdit; tokensUsed: number }>;
}

/**
 * Interface for the verification pipeline used by the self-healing loop.
 */
export interface VerificationRunner {
  run(edit: AgentEdit, context: ProjectContext): Promise<VerificationResult>;
}

// ─── Feedback Construction ──────────────────────────────────────

/**
 * Constructs structured repair feedback from a verification result.
 * Each feedback item contains all four required fields:
 * - stage: the verification stage name
 * - errorMessage: non-empty string describing the failure
 * - filePath: valid file path string
 * - lineNumber: positive integer
 *
 * Requirement 12.1: feedback always includes stage, error message, file path, line number.
 */
export function constructFeedback(
  verificationResult: VerificationResult,
  config: SelfHealingConfig,
): RepairFeedback[] {
  const feedback: RepairFeedback[] = [];

  for (const stage of verificationResult.stages) {
    if (!stage.passed && stage.diagnostics.length > 0) {
      for (const diagnostic of stage.diagnostics) {
        const item: RepairFeedback = {
          stage: stage.stageName,
          errorMessage: diagnostic.message || 'Unknown error',
          filePath: diagnostic.file || 'unknown',
          lineNumber: Math.max(1, diagnostic.line || 1),
        };

        if (config.feedbackFormat === 'natural') {
          item.errorMessage = formatNaturalFeedback(item);
        }

        feedback.push(item);
      }
    }
  }

  // If no diagnostics found but stage failed, create a generic feedback entry
  if (feedback.length === 0 && verificationResult.failedAt) {
    feedback.push({
      stage: verificationResult.failedAt,
      errorMessage: `Verification failed at stage: ${verificationResult.failedAt}`,
      filePath: 'unknown',
      lineNumber: 1,
    });
  }

  return feedback;
}

/**
 * Formats a structured feedback item into natural language.
 */
function formatNaturalFeedback(item: RepairFeedback): string {
  return `In file "${item.filePath}" at line ${item.lineNumber}, the ${item.stage} stage reported: ${item.errorMessage}`;
}

// ─── Self-Healing Loop ──────────────────────────────────────────

/**
 * Executes the self-healing loop:
 * 1. Feeds verification failures to the agent as structured feedback
 * 2. Receives a repaired edit from the agent
 * 3. Re-runs verification on the repaired edit
 * 4. Repeats until success, max attempts, or token budget is exhausted
 * 5. Escalates to user when limits are reached
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */
export async function runSelfHealingLoop(
  originalEdit: AgentEdit,
  initialResult: VerificationResult,
  agent: RepairAgent,
  verifier: VerificationRunner,
  context: ProjectContext,
  config: SelfHealingConfig = DEFAULT_SELF_HEALING_CONFIG,
): Promise<SelfHealingResult> {
  const attempts: RepairAttempt[] = [];
  let totalTokensUsed = 0;
  let currentResult = initialResult;
  let currentEdit = originalEdit;

  for (let attemptNum = 1; attemptNum <= config.maxAttempts; attemptNum++) {
    // Check token budget before making repair call
    if (totalTokensUsed >= config.tokenBudget) {
      return {
        accepted: false,
        attempts,
        totalTokensUsed,
        escalatedToUser: true,
        escalationReason: 'token_budget_exceeded',
      };
    }

    // Construct feedback from the current verification failure
    const feedback = constructFeedback(currentResult, config);

    // Request repair from the agent
    const repairResponse = await agent.repair(currentEdit, feedback, context);
    totalTokensUsed += repairResponse.tokensUsed;

    // Run verification on the repaired edit
    const verificationResult = await verifier.run(repairResponse.edit, context);

    // Record the attempt
    const attempt: RepairAttempt = {
      attempt: attemptNum,
      edit: repairResponse.edit,
      result: verificationResult,
      tokensUsed: repairResponse.tokensUsed,
    };
    attempts.push(attempt);

    // Check if repair passed all stages (Requirement 12.5)
    if (verificationResult.accepted) {
      return {
        accepted: true,
        finalEdit: repairResponse.edit,
        attempts,
        totalTokensUsed,
        escalatedToUser: false,
      };
    }

    // Check if token budget exceeded after this attempt (Requirement 12.4)
    if (totalTokensUsed >= config.tokenBudget) {
      return {
        accepted: false,
        attempts,
        totalTokensUsed,
        escalatedToUser: true,
        escalationReason: 'token_budget_exceeded',
      };
    }

    // Update current state for next iteration
    currentResult = verificationResult;
    currentEdit = repairResponse.edit;
  }

  // Max attempts exceeded without success (Requirement 12.2, 12.3)
  return {
    accepted: false,
    attempts,
    totalTokensUsed,
    escalatedToUser: true,
    escalationReason: 'max_attempts_exceeded',
  };
}

// ─── Escalation Helper ──────────────────────────────────────────

/**
 * Builds an escalation info object for user presentation.
 * Contains all attempts, diagnostics, and token usage for manual resolution.
 * (Requirement 12.3)
 */
export function buildEscalationInfo(
  originalEdit: AgentEdit,
  result: SelfHealingResult,
): EscalationInfo {
  return {
    originalEdit,
    attempts: result.attempts,
    totalTokensUsed: result.totalTokensUsed,
    reason: result.escalationReason ?? 'max_attempts_exceeded',
  };
}
