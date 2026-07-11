/**
 * Self-Healing Loop — feeds verification failures back to the agent as structured
 * feedback for automated repair. Retries up to maxAttempts, tracks token budget,
 * and escalates to the user when limits are exceeded or repair fails.
 *
 * Feedback includes: stage name, error message, affected file path, and line number.
 * For security stage failures, feedback additionally includes the finding's remediation
 * string as a natural-language hint for LLM repair.
 *
 * Requirements: 9.4, 9.5, 9.6, 9.7, 12.1–12.5
 */
import type {
  AgentEdit,
  VerificationResult,
  ProjectContext,
  Diagnostic,
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
  /** Structured escalation details for unresolved security findings (Req 9.7) */
  securityEscalations?: SecurityEscalation[];
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

// ─── Security Finding Context ───────────────────────────────────

/**
 * Represents a security finding attached to a diagnostic for enriched feedback.
 * Used to pass remediation hints to the LLM repair agent.
 * (Requirements 9.4, 9.5)
 */
export interface SecurityFindingContext {
  /** The vulnerability category (e.g., 'xss', 'sql-injection', 'secrets') */
  category: string;
  /** Natural-language remediation hint for the LLM */
  remediation: string;
  /** File path where the finding was detected */
  file: string;
  /** Line number of the finding */
  line: number;
}

/**
 * Tracks remediation attempts per security finding class.
 * Provides escalating context on retries — subsequent attempts for the same
 * category include prior attempt history so the LLM can try different strategies.
 * (Requirement 9.6)
 */
export interface SecurityRemediationTracker {
  /** Maps finding category to attempt records */
  attemptsByCategory: Map<string, SecurityCategoryAttempts>;
}

export interface SecurityCategoryAttempts {
  /** Total attempts made for this finding category */
  totalAttempts: number;
  /** Whether any attempt succeeded for this category */
  succeeded: boolean;
  /** Brief descriptions of what was tried in prior attempts */
  priorStrategies: string[];
}

/**
 * Structured escalation emitted when the retry budget is exhausted
 * for a security finding. Contains all context needed for user resolution.
 * (Requirement 9.7)
 */
export interface SecurityEscalation {
  /** The security finding category that couldn't be fixed */
  category: string;
  /** File and line of the finding */
  file: string;
  line: number;
  /** The remediation advice that was attempted */
  remediation: string;
  /** Number of attempts made */
  attemptsMade: number;
  /** Summaries of strategies tried in each attempt */
  strategiesTried: string[];
  /** The final error message from the last attempt */
  lastError: string;
  /** Reason for escalation */
  reason: 'max_attempts_exceeded' | 'token_budget_exceeded';
}

/**
 * Creates a new empty SecurityRemediationTracker instance.
 */
export function createRemediationTracker(): SecurityRemediationTracker {
  return { attemptsByCategory: new Map() };
}

/**
 * Records an attempt for a finding category in the tracker.
 */
export function recordRemediationAttempt(
  tracker: SecurityRemediationTracker,
  category: string,
  succeeded: boolean,
  strategy?: string,
): void {
  let entry = tracker.attemptsByCategory.get(category);
  if (!entry) {
    entry = { totalAttempts: 0, succeeded: false, priorStrategies: [] };
    tracker.attemptsByCategory.set(category, entry);
  }
  entry.totalAttempts++;
  if (succeeded) {
    entry.succeeded = true;
  }
  if (strategy) {
    entry.priorStrategies.push(strategy);
  }
}

/**
 * Builds structured SecurityEscalation objects for all unresolved categories
 * when the retry budget is exhausted.
 * (Requirement 9.7)
 */
export function buildSecurityEscalations(
  tracker: SecurityRemediationTracker,
  feedback: RepairFeedback[],
  reason: 'max_attempts_exceeded' | 'token_budget_exceeded',
): SecurityEscalation[] {
  const escalations: SecurityEscalation[] = [];

  for (const [category, attempts] of tracker.attemptsByCategory.entries()) {
    if (attempts.succeeded) continue;

    // Find the last feedback item for this category to get context
    const relatedFeedback = feedback.filter(f =>
      f.stage === 'security' && f.errorMessage.includes(category),
    );
    const lastFeedback = relatedFeedback[relatedFeedback.length - 1];

    escalations.push({
      category,
      file: lastFeedback?.filePath ?? 'unknown',
      line: lastFeedback?.lineNumber ?? 1,
      remediation: extractRemediationFromMessage(lastFeedback?.errorMessage ?? ''),
      attemptsMade: attempts.totalAttempts,
      strategiesTried: attempts.priorStrategies,
      lastError: lastFeedback?.errorMessage ?? 'Unknown security failure',
      reason,
    });
  }

  return escalations;
}

/**
 * Extracts the remediation portion from a security feedback message.
 * Messages follow the format: "Security violation at {file}:{line} — {category}: {remediation}"
 */
function extractRemediationFromMessage(message: string): string {
  const colonIdx = message.lastIndexOf(': ');
  if (colonIdx >= 0 && message.includes('—')) {
    return message.substring(colonIdx + 2);
  }
  return message;
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
 * For security stage failures, the errorMessage is formatted as:
 * "Security violation at {file}:{line} — {category}: {remediation}"
 * to provide the LLM with actionable remediation context.
 *
 * When a SecurityRemediationTracker is provided, escalating context from
 * prior attempts is appended to help the LLM try different strategies.
 *
 * Requirement 9.4: Include remediation string as natural-language hint
 * Requirement 9.6: Track per-finding-class attempts for escalating context
 * Requirement 12.1: feedback always includes stage, error message, file path, line number.
 */
export function constructFeedback(
  verificationResult: VerificationResult,
  config: SelfHealingConfig,
  tracker?: SecurityRemediationTracker,
): RepairFeedback[] {
  const feedback: RepairFeedback[] = [];

  for (const stage of verificationResult.stages) {
    if (!stage.passed && stage.diagnostics.length > 0) {
      for (const diagnostic of stage.diagnostics) {
        let errorMessage = diagnostic.message || 'Unknown error';

        // For security stage failures, format with remediation hint (Req 9.4)
        if (stage.stageName === 'security') {
          errorMessage = formatSecurityFeedback(diagnostic, tracker);
        }

        const item: RepairFeedback = {
          stage: stage.stageName,
          errorMessage,
          filePath: diagnostic.file || 'unknown',
          lineNumber: Math.max(1, diagnostic.line || 1),
        };

        if (config.feedbackFormat === 'natural' && stage.stageName !== 'security') {
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

/**
 * Formats a security diagnostic as a natural-language remediation hint.
 * Format: "Security violation at {file}:{line} — {category}: {remediation}"
 *
 * Security diagnostics from the security stage have messages formatted as:
 * "[category] message" or "[category] ruleName: remediation"
 *
 * When a tracker is provided with prior attempts for the same category,
 * escalating context is appended to guide the LLM toward a different strategy.
 *
 * (Requirements 9.4, 9.6)
 */
function formatSecurityFeedback(
  diagnostic: Diagnostic,
  tracker?: SecurityRemediationTracker,
): string {
  const file = diagnostic.file || 'unknown';
  const line = Math.max(1, diagnostic.line || 1);
  const { category, remediation } = parseSecurityDiagnostic(diagnostic.message);

  let message = `Security violation at ${file}:${line} — ${category}: ${remediation}`;

  // Append escalating context if we have prior attempts for this category (Req 9.6)
  if (tracker) {
    const attempts = tracker.attemptsByCategory.get(category);
    if (attempts && attempts.totalAttempts > 0) {
      message += ` [Attempt ${attempts.totalAttempts + 1}: previous strategies failed`;
      if (attempts.priorStrategies.length > 0) {
        message += ` (tried: ${attempts.priorStrategies.join(', ')})`;
      }
      message += `. Try a different approach.]`;
    }
  }

  return message;
}

/**
 * Parses a security diagnostic message to extract category and remediation.
 * Expected formats:
 * - "[category] message"
 * - "[category] ruleName: remediation"
 */
function parseSecurityDiagnostic(message: string): { category: string; remediation: string } {
  // Match "[category] rest" pattern from security stage diagnostics
  const bracketMatch = message.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    const category = bracketMatch[1] ?? 'security';
    const rest = bracketMatch[2] ?? '';

    // Check if rest contains "ruleName: remediation" pattern
    const colonIdx = rest.indexOf(': ');
    if (colonIdx >= 0) {
      return { category, remediation: rest.substring(colonIdx + 2) };
    }
    return { category, remediation: rest || 'Fix the security issue' };
  }

  // Fallback: use entire message as remediation with generic category
  return { category: 'security', remediation: message || 'Fix the security issue' };
}

// ─── Self-Healing Loop ──────────────────────────────────────────

/**
 * Tracks security finding remediation success/failure per category after each attempt.
 * Compares the before/after verification results to determine which security findings
 * were resolved and which persist.
 * (Requirement 9.6)
 */
function trackSecurityAttempts(
  tracker: SecurityRemediationTracker,
  previousResult: VerificationResult,
  currentResult: VerificationResult,
  attemptNum: number,
): void {
  // Find security diagnostics from the previous result (what we tried to fix)
  const previousSecurityDiags = extractSecurityDiagnostics(previousResult);
  const currentSecurityDiags = extractSecurityDiagnostics(currentResult);

  // For each category in the previous failures, check if it's resolved
  const previousCategories = new Set(previousSecurityDiags.map(d => parseCategoryFromMessage(d.message)));
  const currentCategories = new Set(currentSecurityDiags.map(d => parseCategoryFromMessage(d.message)));

  for (const category of previousCategories) {
    const resolved = !currentCategories.has(category);
    recordRemediationAttempt(
      tracker,
      category,
      resolved,
      `Attempt ${attemptNum}: ${resolved ? 'resolved' : 'still failing'}`,
    );
  }
}

/**
 * Extracts security-stage diagnostics from a verification result.
 */
function extractSecurityDiagnostics(result: VerificationResult): Diagnostic[] {
  const securityStage = result.stages.find(s => s.stageName === 'security');
  if (!securityStage || securityStage.passed) return [];
  return securityStage.diagnostics;
}

/**
 * Extracts the category string from a security diagnostic message.
 * Expects format "[category] ..." from the security stage.
 */
function parseCategoryFromMessage(message: string): string {
  const match = message.match(/^\[([^\]]+)\]/);
  return match?.[1] ?? 'unknown';
}

/**
 * Executes the self-healing loop:
 * 1. Feeds verification failures to the agent as structured feedback
 * 2. Receives a repaired edit from the agent
 * 3. Re-runs verification on the repaired edit
 * 4. Repeats until success, max attempts, or token budget is exhausted
 * 5. Escalates to user when limits are reached
 * 6. For security findings, tracks attempts per category and provides escalating context
 * 7. Emits structured SecurityEscalation when retry budget is exhausted
 *
 * Requirements: 9.4, 9.5, 9.6, 9.7, 12.1, 12.2, 12.3, 12.4, 12.5
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

  // Track remediation attempts per security finding class (Req 9.6)
  const tracker = createRemediationTracker();

  for (let attemptNum = 1; attemptNum <= config.maxAttempts; attemptNum++) {
    // Check token budget before making repair call
    if (totalTokensUsed >= config.tokenBudget) {
      const feedback = constructFeedback(currentResult, config, tracker);
      const escalations = buildSecurityEscalations(tracker, feedback, 'token_budget_exceeded');
      const result: SelfHealingResult = {
        accepted: false,
        attempts,
        totalTokensUsed,
        escalatedToUser: true,
        escalationReason: 'token_budget_exceeded',
      };
      if (escalations.length > 0) {
        result.securityEscalations = escalations;
      }
      return result;
    }

    // Construct feedback from the current verification failure (with tracker for escalating context)
    const feedback = constructFeedback(currentResult, config, tracker);

    // Request repair from the agent
    const repairResponse = await agent.repair(currentEdit, feedback, context);
    totalTokensUsed += repairResponse.tokensUsed;

    // Run verification on the repaired edit
    const verificationResult = await verifier.run(repairResponse.edit, context);

    // Track security finding remediation success/failure per category (Req 9.6)
    trackSecurityAttempts(tracker, currentResult, verificationResult, attemptNum);

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
      const latestFeedback = constructFeedback(verificationResult, config, tracker);
      const escalations = buildSecurityEscalations(tracker, latestFeedback, 'token_budget_exceeded');
      const result: SelfHealingResult = {
        accepted: false,
        attempts,
        totalTokensUsed,
        escalatedToUser: true,
        escalationReason: 'token_budget_exceeded',
      };
      if (escalations.length > 0) {
        result.securityEscalations = escalations;
      }
      return result;
    }

    // Update current state for next iteration
    currentResult = verificationResult;
    currentEdit = repairResponse.edit;
  }

  // Max attempts exceeded without success (Requirement 12.2, 12.3, 9.7)
  const finalFeedback = constructFeedback(currentResult, config, tracker);
  const escalations = buildSecurityEscalations(tracker, finalFeedback, 'max_attempts_exceeded');
  const finalResult: SelfHealingResult = {
    accepted: false,
    attempts,
    totalTokensUsed,
    escalatedToUser: true,
    escalationReason: 'max_attempts_exceeded',
  };
  if (escalations.length > 0) {
    finalResult.securityEscalations = escalations;
  }
  return finalResult;
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
