/**
 * Guardrails Pipeline Integration — orchestrates all guardrail subsystems
 * in the agent execution pipeline.
 *
 * Provides a unified interface for:
 * - Pre-execution command policy checks
 * - Sandboxed command execution
 * - LLM cost recording
 * - Trace recording for all agent actions
 * - Prompt-level checkpoint creation for rewind/undo
 *
 * All methods are gated behind Feature Toggle Manager checks and handle
 * errors gracefully (catch, log, continue) to avoid disrupting the agent workflow.
 *
 * Requirements: 1.1, 1.9, 3.9, 4.6, 6.10, 8.1, 9.1
 */

import { FeatureToggleManager, type GuardrailFeature } from '../config/feature-toggles.js';
import { CommandPolicyEngine, type CommandPolicyResult } from '../firewall/command-policy-engine.js';
import { SandboxIsolator, type SandboxIsolatorResult } from '../sandbox/sandbox-isolator.js';
import type { SandboxProfile } from '../sandbox/sandbox-profile-loader.js';
import type { SandboxSession } from '../sandbox/types/sandbox-types.js';
import { CostTracker, type LLMCostEntry } from '../session/cost-tracker.js';
import { TraceRecorder, type TraceEntryInput } from '../session/trace-recorder.js';
import { PromptRewindManager } from '../session/prompt-rewind-manager.js';
import { logger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/**
 * Options for creating a GuardrailsPipeline instance.
 */
export interface GuardrailsPipelineOptions {
  featureToggleManager: FeatureToggleManager;
  commandPolicyEngine?: CommandPolicyEngine;
  sandboxIsolator?: SandboxIsolator;
  costTracker?: CostTracker;
  traceRecorder?: TraceRecorder;
  promptRewindManager?: PromptRewindManager;
}

/**
 * Result of a pre-execution command policy check.
 */
export interface PreExecuteResult {
  allowed: boolean;
  action: 'allow' | 'ask' | 'deny';
  reason: string;
  matchedRule: { id: string; pattern: string; tier: string } | null;
}

/**
 * Result of a sandboxed command execution.
 */
export interface ExecuteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxed: boolean;
}

// ─── GuardrailsPipeline Implementation ───────────────────────────────────────

/**
 * Orchestrates all guardrail subsystems in the agent execution pipeline.
 *
 * Each method checks the relevant feature toggle before invoking the subsystem.
 * If the feature is disabled or the subsystem is not configured, the method
 * gracefully falls through (no-op or direct execution). All errors are caught,
 * logged, and reported to the FeatureToggleManager for auto-disable behavior.
 */
export class GuardrailsPipeline {
  private featureToggleManager: FeatureToggleManager;
  private commandPolicyEngine?: CommandPolicyEngine;
  private sandboxIsolator?: SandboxIsolator;
  private costTracker?: CostTracker;
  private traceRecorder?: TraceRecorder;
  private promptRewindManager?: PromptRewindManager;

  constructor(options: GuardrailsPipelineOptions) {
    this.featureToggleManager = options.featureToggleManager;
    this.commandPolicyEngine = options.commandPolicyEngine;
    this.sandboxIsolator = options.sandboxIsolator;
    this.costTracker = options.costTracker;
    this.traceRecorder = options.traceRecorder;
    this.promptRewindManager = options.promptRewindManager;
  }

  // ─── Pre-Execution Command Policy Check ──────────────────────────────────

  /**
   * Evaluate a command against the command policy engine before execution.
   *
   * Checks the 'command-policy' feature toggle. If disabled or the engine
   * is not configured, returns an allow result (pass-through).
   *
   * @param command - The shell command string to evaluate
   * @param _session - The sandbox session context (reserved for future use)
   * @returns PreExecuteResult indicating allow/deny/ask
   */
  preExecuteCommand(command: string, _session?: SandboxSession): PreExecuteResult {
    // Default pass-through result when feature is disabled or unavailable
    const passThrough: PreExecuteResult = {
      allowed: true,
      action: 'allow',
      reason: 'Command policy feature disabled or not configured',
      matchedRule: null,
    };

    if (!this.isFeatureEnabled('command-policy')) {
      return passThrough;
    }

    if (!this.commandPolicyEngine) {
      logger.debug('Command policy engine not configured, allowing command');
      return passThrough;
    }

    try {
      const result: CommandPolicyResult = this.commandPolicyEngine.evaluate(command);

      return {
        allowed: result.action === 'allow',
        action: result.action,
        reason: result.reason,
        matchedRule: result.matchedRule
          ? { id: result.matchedRule.id, pattern: result.matchedRule.pattern, tier: result.matchedRule.tier }
          : null,
      };
    } catch (error) {
      this.handleFeatureError('command-policy', error, 'preExecuteCommand');
      return passThrough;
    }
  }

  // ─── Sandboxed Command Execution ─────────────────────────────────────────

  /**
   * Execute a command, optionally wrapped in OS-level sandbox isolation.
   *
   * Checks the 'sandbox-isolation' feature toggle. If disabled or the isolator
   * is not configured, falls through to direct execution via the isolator's
   * built-in fallback (which also respects the toggle internally).
   *
   * @param command - The shell command string to execute
   * @param session - The sandbox session context
   * @param profile - The sandbox profile defining restrictions
   * @returns ExecuteCommandResult with exit code, stdout, stderr, and sandbox status
   */
  async executeCommand(
    command: string,
    session: SandboxSession,
    profile: SandboxProfile,
  ): Promise<ExecuteCommandResult> {
    // Default direct execution result
    const directFallback: ExecuteCommandResult = {
      exitCode: -1,
      stdout: '',
      stderr: 'Sandbox isolator not configured',
      timedOut: false,
      sandboxed: false,
    };

    if (!this.sandboxIsolator) {
      logger.debug('Sandbox isolator not configured, cannot execute command');
      return directFallback;
    }

    try {
      // The SandboxIsolator internally checks the feature toggle and falls back
      // to direct execution when disabled. We still gate here for clarity.
      const sandboxEnabled = this.isFeatureEnabled('sandbox-isolation');
      const result: SandboxIsolatorResult = await this.sandboxIsolator.execute(command, session, profile);

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        sandboxed: sandboxEnabled && this.sandboxIsolator.isPlatformSandboxAvailable(),
      };
    } catch (error) {
      this.handleFeatureError('sandbox-isolation', error, 'executeCommand');
      return directFallback;
    }
  }

  // ─── LLM Cost Recording ──────────────────────────────────────────────────

  /**
   * Record an LLM call completion for cost tracking.
   *
   * Checks the 'cost-tracking' feature toggle. If disabled or the tracker
   * is not configured, the call is silently skipped.
   *
   * @param sessionId - The session identifier
   * @param data - The LLM cost entry data (model, tokens, cost)
   */
  recordLLMCompletion(sessionId: string, data: LLMCostEntry): void {
    if (!this.isFeatureEnabled('cost-tracking')) {
      return;
    }

    if (!this.costTracker) {
      logger.debug('Cost tracker not configured, skipping LLM cost recording');
      return;
    }

    try {
      this.costTracker.recordLLMCall(sessionId, data);
    } catch (error) {
      this.handleFeatureError('cost-tracking', error, 'recordLLMCompletion');
    }
  }

  // ─── Trace Recording ─────────────────────────────────────────────────────

  /**
   * Record an agent action in the trace audit trail.
   *
   * Checks the 'trace-recording' feature toggle. If disabled or the recorder
   * is not configured, the call is silently skipped.
   *
   * @param traceId - The trace identifier for the current session trace
   * @param entry - The trace entry input (type and structured data)
   * @returns The entry ID if recorded, or undefined if skipped
   */
  recordAction(traceId: string, entry: TraceEntryInput): string | undefined {
    if (!this.isFeatureEnabled('trace-recording')) {
      return undefined;
    }

    if (!this.traceRecorder) {
      logger.debug('Trace recorder not configured, skipping action recording');
      return undefined;
    }

    try {
      return this.traceRecorder.recordEntry(traceId, entry);
    } catch (error) {
      this.handleFeatureError('trace-recording', error, 'recordAction');
      return undefined;
    }
  }

  // ─── Prompt Rewind Checkpoint ────────────────────────────────────────────

  /**
   * Create a workspace checkpoint at the start of a prompt execution.
   *
   * Checks the 'prompt-rewind' feature toggle. If disabled or the manager
   * is not configured, the call is silently skipped.
   *
   * @param sessionId - The session identifier
   * @param projectPath - The project directory path to snapshot
   * @param promptText - The prompt text being executed
   * @returns The checkpoint ID if created, or undefined if skipped
   */
  onPromptStart(sessionId: string, projectPath: string, promptText: string): string | undefined {
    if (!this.isFeatureEnabled('prompt-rewind')) {
      return undefined;
    }

    if (!this.promptRewindManager) {
      logger.debug('Prompt rewind manager not configured, skipping checkpoint creation');
      return undefined;
    }

    try {
      return this.promptRewindManager.createCheckpoint(sessionId, projectPath, promptText);
    } catch (error) {
      this.handleFeatureError('prompt-rewind', error, 'onPromptStart');
      return undefined;
    }
  }

  // ─── Utility Methods ─────────────────────────────────────────────────────

  /**
   * Check if a guardrail feature is currently enabled.
   */
  isFeatureEnabled(feature: GuardrailFeature): boolean {
    return this.featureToggleManager.isEnabled(feature);
  }

  /**
   * Get the current state of all feature toggles.
   */
  getFeatureStates(): Record<GuardrailFeature, boolean> {
    return this.featureToggleManager.getAllStates();
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Handle an error from a guardrail feature subsystem.
   * Logs the error and reports it to the FeatureToggleManager for auto-disable.
   */
  private handleFeatureError(feature: GuardrailFeature, error: unknown, method: string): void {
    const err = error instanceof Error ? error : new Error(String(error));

    logger.error(`Guardrails pipeline error in ${method}`, {
      feature,
      error: err.message,
      stack: err.stack,
    });

    // Report to FeatureToggleManager for auto-disable behavior
    this.featureToggleManager.reportError(feature, err);
  }
}
