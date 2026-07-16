/**
 * Authorization Pipeline — Ordered, staged authorization for every tool invocation.
 *
 * This module is the SOLE authorization gate immediately in front of tool
 * implementation execution. Every tool call, regardless of source (GUI, CLI,
 * ACP, Loop Engine, swarm), must pass through `authorize()` before execution.
 *
 * Stage evaluation order:
 *   0. Plan-mode gate — deny mutating calls outside plan file
 *   1. Pre-tool-hook — veto-only hooks (hook allow does NOT skip later stages)
 *   2. Pattern-rules — deny-before-ask-before-allow with tier priorities
 *   3. Remembered-grants — persisted per-project authorization decisions
 *   4. Builtin-readonly — auto-approve read-only tools when earlier stages decline
 *   5. Mode-policy — final fallback based on session permission mode
 *
 * Design contracts:
 *   - Hooks are veto-only: hook timeout/exception = decline-to-deny + warning (Req 10.2, 10.3)
 *   - Pattern evaluation preserves deny > ask > allow and tier priorities (Req 10.4)
 *   - Built-in read-only auto-approve ONLY after earlier stages decline (Req 10.8)
 *   - Every decision is recorded in the permission audit sink (Req 10.9)
 *   - This pipeline is the ONLY authorization gate (Req 1.3)
 *
 * Dependencies are injectable so each stage can be wired in as later tasks
 * deliver their implementations. Stages without backing services default to
 * "decline-to-decide" (pass-through to next stage).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.8, 1.3
 */

import type { ToolCall, ToolContext, RiskLevel } from '../shared/types.js';

// ─── Public Types ───────────────────────────────────────────────

/** Names of each authorization stage in evaluation order */
export type AuthStage =
  | 'plan-mode'
  | 'pre-tool-hook'
  | 'pattern-rules'
  | 'remembered-grants'
  | 'builtin-readonly'
  | 'mode-policy';

/** Context provided when the pipeline recommends asking the user */
export interface PromptContext {
  toolId: string;
  toolName: string;
  args: unknown;
  riskLevel: RiskLevel;
  reason: string;
}

/** The decision returned by the authorization pipeline */
export type AuthDecision =
  | { verdict: 'deny'; stage: AuthStage; reason: string }
  | { verdict: 'allow'; stage: AuthStage; reason: string }
  | { verdict: 'ask'; stage: AuthStage; promptContext: PromptContext };

/** Internal stage result — includes 'pass' for decline-to-decide */
type StageResult =
  | { verdict: 'deny'; reason: string }
  | { verdict: 'allow'; reason: string }
  | { verdict: 'ask'; reason: string }
  | { verdict: 'pass' };

// ─── Audit Entry ────────────────────────────────────────────────

/** Record of every authorization decision for the audit sink */
export interface AuthAuditEntry {
  timestamp: Date;
  verdict: 'deny' | 'allow' | 'ask';
  stage: AuthStage;
  reason: string;
  projectId: string | undefined;
  sessionId: string;
  agentId: string;
  toolId: string;
  toolName: string;
  args: unknown;
}

// ─── Stage Interfaces (Injectable Dependencies) ─────────────────

/**
 * Plan Mode Gate — denies mutating calls outside the plan file.
 * Will be implemented in Wave 2 task 3.1.
 */
export interface PlanModeGate {
  /**
   * Evaluate whether the call is permitted under plan mode.
   * Returns 'pass' if plan mode is not active or the call is non-mutating.
   */
  evaluate(call: ToolCall, ctx: ToolContext): StageResult;
}

/**
 * Pre-tool Hook Provider — runs PreToolUse hooks for veto.
 * Hooks are veto-only: a hook returning 'allow' does NOT skip later stages.
 * Will be integrated with Hook Engine v2 in Wave 2 task 3.5/3.6.
 */
export interface PreToolHookProvider {
  /**
   * Run PreToolUse hooks. Returns 'deny' if any hook vetoes, 'pass' otherwise.
   * Timeout or exception = decline-to-deny (returns 'pass') + emits warning.
   */
  evaluate(call: ToolCall, ctx: ToolContext): Promise<StageResult>;
}

/**
 * Pattern Rules Evaluator — the permission-pattern-engine stage.
 * Relocated to src/security/permission-pattern-engine.ts (task 2.2).
 */
export interface PatternRulesEvaluator {
  /**
   * Evaluate tool call against pattern rules.
   * Returns deny/allow/ask/pass based on pattern matching with tier priorities.
   */
  evaluate(call: ToolCall, ctx: ToolContext): StageResult;
}

/**
 * Remembered Grants Lookup — persisted per-project authorization decisions.
 * Will be implemented in task 2.3.
 */
export interface RememberedGrantsLookup {
  /**
   * Check if there's a persisted grant for this tool+args combination.
   * Returns 'allow' if a grant exists and the command is NOT dangerous,
   * 'pass' otherwise.
   */
  evaluate(call: ToolCall, ctx: ToolContext): StageResult;
}

/**
 * Audit Sink — records every authorization decision.
 * Currently backed by PermissionSystem's audit log.
 */
export interface AuthAuditSink {
  record(entry: AuthAuditEntry): void;
}

// ─── Built-in Read-Only Allowlist ───────────────────────────────

/**
 * Tools that are inherently read-only and can be auto-approved
 * after earlier stages decline to decide (Req 10.8).
 */
const BUILTIN_READONLY_TOOL_IDS: ReadonlySet<string> = new Set([
  'file_read',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'semantic_search',
  'list_directory',
  'get_file_info',
]);

/**
 * Shell commands that are considered read-only and safe to auto-approve
 * in the builtin-readonly stage (Req 10.8).
 */
const READONLY_SHELL_COMMANDS: ReadonlyArray<string> = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'which',
  'whoami',
  'pwd',
  'echo',
  'date',
  'uname',
  'env',
  'printenv',
  'git status',
  'git log',
  'git diff',
  'git branch',
  'git remote',
  'git show',
  'git rev-parse',
];

// ─── Default (No-Op) Stage Implementations ─────────────────────

/** Default plan-mode gate: plan mode not active, always passes */
class DefaultPlanModeGate implements PlanModeGate {
  evaluate(_call: ToolCall, _ctx: ToolContext): StageResult {
    return { verdict: 'pass' };
  }
}

/** Default hook provider: no hooks configured, always passes */
class DefaultPreToolHookProvider implements PreToolHookProvider {
  async evaluate(_call: ToolCall, _ctx: ToolContext): Promise<StageResult> {
    return { verdict: 'pass' };
  }
}

/** Default pattern rules: no patterns configured, always passes */
class DefaultPatternRulesEvaluator implements PatternRulesEvaluator {
  evaluate(_call: ToolCall, _ctx: ToolContext): StageResult {
    return { verdict: 'pass' };
  }
}

/** Default remembered grants: no grants stored, always passes */
class DefaultRememberedGrantsLookup implements RememberedGrantsLookup {
  evaluate(_call: ToolCall, _ctx: ToolContext): StageResult {
    return { verdict: 'pass' };
  }
}

/** Default audit sink: logs to console in development, no-op in production */
class DefaultAuditSink implements AuthAuditSink {
  record(_entry: AuthAuditEntry): void {
    // No-op until permission-system.ts is wired as the audit logger (task 2.4)
  }
}

// ─── Pipeline Configuration ─────────────────────────────────────

export interface AuthorizationPipelineConfig {
  /** Plan mode gate implementation */
  planModeGate?: PlanModeGate;
  /** Pre-tool hook provider implementation */
  preToolHookProvider?: PreToolHookProvider;
  /** Pattern rules evaluator implementation */
  patternRulesEvaluator?: PatternRulesEvaluator;
  /** Remembered grants lookup implementation */
  rememberedGrantsLookup?: RememberedGrantsLookup;
  /** Audit sink for recording decisions */
  auditSink?: AuthAuditSink;
  /** Hook timeout in milliseconds (default: 2000, max: 10000) */
  hookTimeoutMs?: number;
  /** Additional read-only tool IDs to auto-approve in builtin-readonly stage */
  additionalReadOnlyToolIds?: string[];
}

// ─── Authorization Pipeline ─────────────────────────────────────

export class AuthorizationPipeline {
  private readonly planModeGate: PlanModeGate;
  private readonly preToolHookProvider: PreToolHookProvider;
  private readonly patternRulesEvaluator: PatternRulesEvaluator;
  private readonly rememberedGrantsLookup: RememberedGrantsLookup;
  private readonly auditSink: AuthAuditSink;
  private readonly hookTimeoutMs: number;
  private readonly readOnlyToolIds: ReadonlySet<string>;

  constructor(config: AuthorizationPipelineConfig = {}) {
    this.planModeGate = config.planModeGate ?? new DefaultPlanModeGate();
    this.preToolHookProvider = config.preToolHookProvider ?? new DefaultPreToolHookProvider();
    this.patternRulesEvaluator = config.patternRulesEvaluator ?? new DefaultPatternRulesEvaluator();
    this.rememberedGrantsLookup = config.rememberedGrantsLookup ?? new DefaultRememberedGrantsLookup();
    this.auditSink = config.auditSink ?? new DefaultAuditSink();
    this.hookTimeoutMs = Math.min(config.hookTimeoutMs ?? 2000, 10000);

    // Merge built-in read-only IDs with any additional ones
    const allReadOnly = new Set(BUILTIN_READONLY_TOOL_IDS);
    if (config.additionalReadOnlyToolIds) {
      for (const id of config.additionalReadOnlyToolIds) {
        allReadOnly.add(id);
      }
    }
    this.readOnlyToolIds = allReadOnly;
  }

  /**
   * Authorize a tool call through the ordered pipeline stages.
   *
   * This is the SOLE authorization entry point for all tool executions.
   * The pipeline evaluates stages in strict order and short-circuits on
   * the first definitive deny/allow/ask decision.
   */
  async authorize(call: ToolCall, ctx: ToolContext & { riskLevel: RiskLevel }): Promise<AuthDecision> {
    // Stage 0: Plan-mode gate
    const planResult = this.planModeGate.evaluate(call, ctx);
    if (planResult.verdict !== 'pass') {
      return this.finalize(planResult, 'plan-mode', call, ctx);
    }

    // Stage 1: Pre-tool-hook (veto-only, with timeout protection)
    const hookResult = await this.runHookStage(call, ctx);
    if (hookResult.verdict === 'deny') {
      // Hooks can only deny, never allow or ask
      return this.finalize(hookResult, 'pre-tool-hook', call, ctx);
    }
    // Hook 'allow' or 'pass' does NOT short-circuit — hooks are veto-only (Req 10.2)

    // Stage 2: Pattern-rules
    const patternResult = this.patternRulesEvaluator.evaluate(call, ctx);
    if (patternResult.verdict !== 'pass') {
      return this.finalize(patternResult, 'pattern-rules', call, ctx);
    }

    // Stage 3: Remembered-grants
    const grantResult = this.rememberedGrantsLookup.evaluate(call, ctx);
    if (grantResult.verdict !== 'pass') {
      return this.finalize(grantResult, 'remembered-grants', call, ctx);
    }

    // Stage 4: Builtin-readonly auto-approve
    const readonlyResult = this.evaluateBuiltinReadonly(call, ctx);
    if (readonlyResult.verdict !== 'pass') {
      return this.finalize(readonlyResult, 'builtin-readonly', call, ctx);
    }

    // Stage 5: Mode-policy (final fallback, always produces a decision)
    const modeResult = this.evaluateModePolicy(call, ctx);
    return this.finalize(modeResult, 'mode-policy', call, ctx);
  }

  // ─── Private: Hook Stage with Timeout ───────────────────────

  private async runHookStage(call: ToolCall, ctx: ToolContext): Promise<StageResult> {
    try {
      const result = await Promise.race([
        this.preToolHookProvider.evaluate(call, ctx),
        this.createTimeout(),
      ]);
      return result;
    } catch (err) {
      // Timeout or exception = decline-to-deny + warning (Req 10.3)
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[AuthorizationPipeline] Pre-tool hook failed or timed out: ${message}. ` +
        `Declining to deny (passing to next stage).`
      );
      return { verdict: 'pass' };
    }
  }

  private createTimeout(): Promise<StageResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Pre-tool hook timed out after ${this.hookTimeoutMs}ms`));
      }, this.hookTimeoutMs);
    });
  }

  // ─── Private: Builtin Read-Only Stage ───────────────────────

  /**
   * Auto-approve tools that are inherently read-only.
   * This stage only fires AFTER all earlier stages have declined (Req 10.8).
   */
  private evaluateBuiltinReadonly(
    call: ToolCall,
    ctx: ToolContext & { riskLevel: RiskLevel },
  ): StageResult {
    // Check if the tool is in the read-only allowlist
    if (this.readOnlyToolIds.has(call.name)) {
      return { verdict: 'allow', reason: 'Built-in read-only tool auto-approved' };
    }

    // Check if it's a read-only shell command
    if (this.isReadOnlyShellCommand(call)) {
      return { verdict: 'allow', reason: 'Read-only shell command auto-approved' };
    }

    // Check risk level as a secondary signal
    if (ctx.riskLevel === 'read-only') {
      return { verdict: 'allow', reason: 'Tool risk level is read-only, auto-approved' };
    }

    return { verdict: 'pass' };
  }

  /**
   * Check if a tool call represents a read-only shell command.
   * Parses the arguments to extract the command string.
   */
  private isReadOnlyShellCommand(call: ToolCall): boolean {
    if (call.name !== 'bash' && call.name !== 'shell' && call.name !== 'Bash') {
      return false;
    }

    try {
      const args = typeof call.arguments === 'string'
        ? JSON.parse(call.arguments)
        : call.arguments;
      const command = (args?.command ?? args?.cmd ?? '') as string;
      const trimmed = command.trim();

      return READONLY_SHELL_COMMANDS.some((safe) =>
        trimmed === safe || trimmed.startsWith(safe + ' ')
      );
    } catch {
      return false;
    }
  }

  // ─── Private: Mode Policy Stage ────────────────────────────

  /**
   * Final fallback based on session permission mode.
   * This stage always produces a definitive decision (never passes).
   */
  private evaluateModePolicy(
    _call: ToolCall,
    ctx: ToolContext & { riskLevel: RiskLevel },
  ): StageResult {
    switch (ctx.permissionMode) {
      case 'auto-approve':
        return { verdict: 'allow', reason: 'Auto-approve mode active' };

      case 'plan-mode':
        // In plan-mode with a read-only operation that wasn't caught earlier
        if (ctx.riskLevel === 'read-only') {
          return { verdict: 'allow', reason: 'Plan mode: read-only operation allowed' };
        }
        return {
          verdict: 'ask',
          reason: `Plan mode: ${ctx.riskLevel} operation requires approval`,
        };

      case 'prompt':
      default:
        // Read-only operations auto-approve under prompt mode
        if (ctx.riskLevel === 'read-only') {
          return { verdict: 'allow', reason: 'Prompt mode: read-only operation allowed' };
        }
        return {
          verdict: 'ask',
          reason: `Prompt mode: ${ctx.riskLevel} operation requires user approval`,
        };
    }
  }

  // ─── Private: Finalize and Audit ────────────────────────────

  /**
   * Convert a stage result into a final AuthDecision, record in audit sink.
   */
  private finalize(
    result: StageResult,
    stage: AuthStage,
    call: ToolCall,
    ctx: ToolContext & { riskLevel: RiskLevel },
  ): AuthDecision {
    // 'pass' should never reach finalize — it means "decline-to-decide"
    // If it does (defensive), treat as ask at mode-policy
    const effectiveResult = result.verdict === 'pass'
      ? { verdict: 'ask' as const, reason: 'No stage produced a decision' }
      : result;

    // Build the decision
    let decision: AuthDecision;

    switch (effectiveResult.verdict) {
      case 'deny':
        decision = {
          verdict: 'deny',
          stage,
          reason: effectiveResult.reason,
        };
        break;

      case 'allow':
        decision = {
          verdict: 'allow',
          stage,
          reason: effectiveResult.reason,
        };
        break;

      case 'ask':
        decision = {
          verdict: 'ask',
          stage,
          promptContext: {
            toolId: call.id,
            toolName: call.name,
            args: call.arguments,
            riskLevel: ctx.riskLevel,
            reason: effectiveResult.reason,
          },
        };
        break;
    }

    // Record in audit sink (Req 10.9)
    this.auditSink.record({
      timestamp: new Date(),
      verdict: decision.verdict,
      stage,
      reason: effectiveResult.reason,
      projectId: ctx.projectDir,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolId: call.id,
      toolName: call.name,
      args: call.arguments,
    });

    return decision;
  }
}

// ─── Factory / Convenience ──────────────────────────────────────

/**
 * Create a default authorization pipeline with no external dependencies wired.
 * All stages that require backing services will decline-to-decide (pass through).
 *
 * Use `AuthorizationPipeline` constructor directly for full configuration.
 */
export function createAuthorizationPipeline(
  config?: AuthorizationPipelineConfig,
): AuthorizationPipeline {
  return new AuthorizationPipeline(config);
}

/**
 * Standalone authorize function matching the design document signature.
 * Delegates to a singleton pipeline instance.
 *
 * For production use, prefer constructing an AuthorizationPipeline instance
 * with proper dependency injection.
 */
let _defaultPipeline: AuthorizationPipeline | null = null;

export async function authorize(
  call: ToolCall,
  ctx: ToolContext & { riskLevel: RiskLevel },
): Promise<AuthDecision> {
  if (!_defaultPipeline) {
    _defaultPipeline = createAuthorizationPipeline();
  }
  return _defaultPipeline.authorize(call, ctx);
}

/**
 * Reset the default pipeline instance (for testing).
 */
export function resetDefaultPipeline(config?: AuthorizationPipelineConfig): void {
  _defaultPipeline = config ? new AuthorizationPipeline(config) : null;
}
