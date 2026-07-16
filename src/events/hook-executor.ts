/**
 * Hook Executor — Blocking execution of command and HTTP hooks with verdict semantics.
 *
 * Executes hooks registered via HookEngineV2 and provides:
 *   - Command hooks via child_process.exec with per-hook timeout
 *   - HTTP hooks via fetch with per-hook timeout
 *   - PreToolUse blocking semantics: 2s default timeout, 10s max; timeout = decline-to-deny
 *   - LoopPassStart blocking semantics: deny → BLOCKED with reason in debrief
 *   - Network sandbox policy enforcement for HTTP hooks
 *   - Integration with the AuthorizationPipeline as a PreToolHookProvider
 *
 * Hook execution contracts:
 *   - Command hooks: receive event context as JSON on stdin; exit 0 = pass, non-zero = deny (stderr = reason)
 *   - HTTP hooks: receive event context as JSON body; response { "verdict": "deny"|"allow", "reason": "..." }
 *
 * Requirements: 17.2, 17.3, 17.7, 17.8, 17.9, 17.10
 */

import { exec } from 'node:child_process';
import type { HookDefinition, HookEvent } from './hook-engine-v2.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './hook-engine-v2.js';
import type { PreToolHookProvider } from '../security/authorization-pipeline.js';
import type { ToolCall, ToolContext } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

/** Verdict returned by a hook execution */
export type HookVerdict = 'allow' | 'deny' | 'pass';

/** Result of executing a single hook */
export interface HookExecutionResult {
  hookName: string;
  verdict: HookVerdict;
  reason?: string | undefined;
  durationMs: number;
  error?: string | undefined;
}

/** Result of evaluating all matching hooks for an event */
export interface HookEvaluationResult {
  verdict: 'deny' | 'pass';
  reason?: string | undefined;
  results: HookExecutionResult[];
}

/** Event context provided to hooks */
export interface HookEventContext {
  event: HookEvent;
  toolName?: string | undefined;
  toolArgs?: unknown;
  sessionId?: string | undefined;
  projectId?: string | undefined;
  agentId?: string | undefined;
  passNumber?: number | undefined;
  [key: string]: unknown;
}

/** Interface for checking network access permission */
export interface NetworkPolicyChecker {
  /**
   * Returns true if outbound HTTP requests to the given URL are permitted.
   */
  isNetworkAllowed(url: string): boolean;
}

/** Logger interface for hook execution warnings */
export interface HookExecutorLogger {
  warn(message: string): void;
  info(message: string): void;
}

/** Options for creating a HookExecutor */
export interface HookExecutorOptions {
  /** Function to retrieve matching hooks for an event */
  getMatchingHooks: (event: HookEvent, context?: string) => HookDefinition[];
  /** Network policy checker — if provided, HTTP hooks are blocked when not allowed */
  networkPolicyChecker?: NetworkPolicyChecker | undefined;
  /** Logger for warnings */
  logger?: HookExecutorLogger | undefined;
  /** Custom fetch implementation (for testing) */
  fetchFn?: typeof globalThis.fetch | undefined;
  /** Custom exec implementation (for testing) */
  execFn?: typeof exec | undefined;
}

// ─── Default Logger ─────────────────────────────────────────────

const defaultLogger: HookExecutorLogger = {
  warn: (msg) => console.warn(`[HookExecutor] ${msg}`),
  info: (msg) => console.info(`[HookExecutor] ${msg}`),
};

// ─── Hook Executor ──────────────────────────────────────────────

/**
 * HookExecutor runs matching hooks for lifecycle events and returns
 * aggregated verdicts. For blocking events (PreToolUse, LoopPassStart),
 * any single deny results in an overall deny.
 */
export class HookExecutor {
  private readonly getMatchingHooks: (event: HookEvent, context?: string) => HookDefinition[];
  private readonly networkPolicyChecker: NetworkPolicyChecker | undefined;
  private readonly logger: HookExecutorLogger;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly execFn: typeof exec;

  constructor(options: HookExecutorOptions) {
    this.getMatchingHooks = options.getMatchingHooks;
    this.networkPolicyChecker = options.networkPolicyChecker;
    this.logger = options.logger ?? defaultLogger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.execFn = options.execFn ?? exec;
  }

  // ─── Public: Evaluate Blocking Event ────────────────────────────

  /**
   * Evaluate hooks for a blocking event (PreToolUse or LoopPassStart).
   *
   * Runs matching hooks in sequence:
   * - If any hook returns deny → overall deny with reason
   * - Timeout/exception → decline-to-deny (pass, log warning) (Req 17.3, 17.9)
   * - Hook returning allow does NOT short-circuit (Req 17.2)
   *
   * @returns HookEvaluationResult with overall verdict
   */
  async evaluateBlocking(
    event: HookEvent,
    context: HookEventContext,
    matcherContext?: string,
  ): Promise<HookEvaluationResult> {
    const hooks = this.getMatchingHooks(event, matcherContext);
    const results: HookExecutionResult[] = [];

    for (const hook of hooks) {
      const result = await this.executeHook(hook, context);
      results.push(result);

      // Any deny short-circuits the sequence
      if (result.verdict === 'deny') {
        return {
          verdict: 'deny',
          reason: result.reason ?? `Hook "${hook.name}" denied`,
          results,
        };
      }
      // Allow or pass → continue evaluating other hooks (Req 17.2)
    }

    return { verdict: 'pass', results };
  }

  // ─── Public: Execute Single Hook ────────────────────────────────

  /**
   * Execute a single hook and return its verdict.
   * Timeout/exception → decline-to-deny (pass verdict + warning log).
   */
  async executeHook(
    hook: HookDefinition,
    context: HookEventContext,
  ): Promise<HookExecutionResult> {
    const timeoutMs = this.resolveTimeout(hook);
    const startTime = Date.now();

    try {
      let verdict: HookVerdict;
      let reason: string | undefined;

      if (hook.type === 'command') {
        const cmdResult = await this.executeCommandHook(hook, context, timeoutMs);
        verdict = cmdResult.verdict;
        reason = cmdResult.reason;
      } else if (hook.type === 'http') {
        const httpResult = await this.executeHttpHook(hook, context, timeoutMs);
        verdict = httpResult.verdict;
        reason = httpResult.reason;
      } else {
        // Unknown hook type — decline-to-deny
        this.logger.warn(`Hook "${hook.name}" has unknown type "${hook.type}", declining to deny`);
        verdict = 'pass';
      }

      return {
        hookName: hook.name,
        verdict,
        reason,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      // Exception → decline-to-deny (Req 17.3)
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Hook "${hook.name}" failed: ${message}. Declining to deny.`);
      return {
        hookName: hook.name,
        verdict: 'pass',
        reason: undefined,
        durationMs: Date.now() - startTime,
        error: message,
      };
    }
  }

  // ─── Private: Command Hook Execution ────────────────────────────

  private executeCommandHook(
    hook: HookDefinition,
    context: HookEventContext,
    timeoutMs: number,
  ): Promise<{ verdict: HookVerdict; reason?: string | undefined }> {
    return new Promise((resolve) => {
      const command = hook.command;
      if (!command) {
        this.logger.warn(`Hook "${hook.name}" has no command defined, declining to deny`);
        resolve({ verdict: 'pass' });
        return;
      }

      const child = this.execFn(
        command,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            // Check if it's a timeout (killed signal)
            if (error.killed || error.signal === 'SIGTERM') {
              this.logger.warn(
                `Hook "${hook.name}" command timed out after ${timeoutMs}ms. Declining to deny.`,
              );
              resolve({ verdict: 'pass' });
              return;
            }

            // Non-zero exit code = deny
            const reason = stderr?.trim() || error.message || 'Command hook denied';
            resolve({ verdict: 'deny', reason });
            return;
          }

          // Exit code 0 = allow/pass
          resolve({ verdict: 'allow' });
        },
      );

      // Write event context as JSON to stdin
      try {
        const contextJson = JSON.stringify(context);
        child.stdin?.write(contextJson);
        child.stdin?.end();
      } catch {
        // If we can't write to stdin, the hook will still run
      }
    });
  }

  // ─── Private: HTTP Hook Execution ───────────────────────────────

  private async executeHttpHook(
    hook: HookDefinition,
    context: HookEventContext,
    timeoutMs: number,
  ): Promise<{ verdict: HookVerdict; reason?: string | undefined }> {
    const url = hook.url;
    if (!url) {
      this.logger.warn(`Hook "${hook.name}" has no URL defined, declining to deny`);
      return { verdict: 'pass' };
    }

    // Enforce network sandbox policy (Req 17.8)
    if (this.networkPolicyChecker && !this.networkPolicyChecker.isNetworkAllowed(url)) {
      this.logger.warn(
        `Hook "${hook.name}" HTTP request to "${url}" blocked by network sandbox policy. Declining to deny.`,
      );
      return { verdict: 'pass' };
    }

    const method = (hook.method ?? 'POST').toUpperCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger.warn(
          `Hook "${hook.name}" HTTP response status ${response.status}. Declining to deny.`,
        );
        return { verdict: 'pass' };
      }

      const body = await response.json() as { verdict?: string; reason?: string };

      if (body.verdict === 'deny') {
        return { verdict: 'deny', reason: body.reason ?? 'HTTP hook denied' };
      }

      if (body.verdict === 'allow') {
        return { verdict: 'allow', reason: body.reason };
      }

      // Malformed response → decline-to-deny (Req 17.9)
      this.logger.warn(
        `Hook "${hook.name}" returned malformed verdict: "${body.verdict}". Declining to deny.`,
      );
      return { verdict: 'pass' };
    } catch (err) {
      clearTimeout(timeoutId);

      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('AbortError')) {
        this.logger.warn(
          `Hook "${hook.name}" HTTP request timed out after ${timeoutMs}ms. Declining to deny.`,
        );
      } else {
        this.logger.warn(
          `Hook "${hook.name}" HTTP request failed: ${message}. Declining to deny.`,
        );
      }
      return { verdict: 'pass' };
    }
  }

  // ─── Private: Timeout Resolution ───────────────────────────────

  /**
   * Resolve the effective timeout for a hook.
   * Per-hook timeout is configurable (Req 17.9), clamped to max 10s.
   * Default: 2s (Req 17.8).
   */
  private resolveTimeout(hook: HookDefinition): number {
    const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(timeout, 100), MAX_TIMEOUT_MS);
  }
}

// ─── PreToolHookProvider Implementation ─────────────────────────

/**
 * PreToolHookProvider integrates the HookExecutor with the AuthorizationPipeline.
 *
 * For PreToolUse events:
 * - Runs matching hooks in sequence via HookExecutor
 * - Any hook deny → return deny to pipeline
 * - Timeout/exception → decline-to-deny (returns 'pass')
 * - Hook allow does NOT short-circuit (other hooks still evaluated)
 *
 * Requirements: 17.2, 17.3, 17.9
 */
export class PreToolHookProviderImpl implements PreToolHookProvider {
  private readonly executor: HookExecutor;

  constructor(executor: HookExecutor) {
    this.executor = executor;
  }

  /**
   * Evaluate PreToolUse hooks for the given tool call.
   * Returns 'deny' if any hook vetoes, 'pass' otherwise.
   */
  async evaluate(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<{ verdict: 'deny'; reason: string } | { verdict: 'pass' }> {
    const context: HookEventContext = {
      event: 'PreToolUse',
      toolName: call.name,
      toolArgs: typeof call.arguments === 'string' ? tryParseJson(call.arguments) : call.arguments,
      sessionId: ctx.sessionId,
      projectId: ctx.projectDir,
      agentId: ctx.agentId,
    };

    const matcherContext = call.name;
    const result = await this.executor.evaluateBlocking('PreToolUse', context, matcherContext);

    if (result.verdict === 'deny') {
      return { verdict: 'deny', reason: result.reason ?? 'PreToolUse hook denied' };
    }

    return { verdict: 'pass' };
  }
}

// ─── LoopPassStart Hook Evaluator ───────────────────────────────

/**
 * Result of evaluating LoopPassStart hooks.
 * If verdict is 'deny', the loop should transition to BLOCKED with the reason.
 */
export interface LoopPassStartResult {
  verdict: 'deny' | 'pass';
  reason?: string | undefined;
  results: HookExecutionResult[];
}

/**
 * LoopPassStartHookEvaluator evaluates hooks at the start of each loop pass.
 *
 * If any hook returns deny → the Loop Engine should transition to BLOCKED
 * with the reason included in the debrief (Req 17.7).
 *
 * Requirements: 17.7, 17.10
 */
export class LoopPassStartHookEvaluator {
  private readonly executor: HookExecutor;

  constructor(executor: HookExecutor) {
    this.executor = executor;
  }

  /**
   * Evaluate LoopPassStart hooks.
   * Returns deny with reason if any hook vetoes, pass otherwise.
   * On deny, caller should transition loop to BLOCKED with reason in debrief.
   */
  async evaluate(context: {
    sessionId: string;
    projectId?: string | undefined;
    agentId?: string | undefined;
    passNumber: number;
    runId?: string | undefined;
  }): Promise<LoopPassStartResult> {
    const hookContext: HookEventContext = {
      event: 'LoopPassStart',
      sessionId: context.sessionId,
      projectId: context.projectId,
      agentId: context.agentId,
      passNumber: context.passNumber,
      runId: context.runId,
    };

    const result = await this.executor.evaluateBlocking('LoopPassStart', hookContext);

    return {
      verdict: result.verdict,
      reason: result.reason,
      results: result.results,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a HookExecutor with standard configuration.
 */
export function createHookExecutor(options: HookExecutorOptions): HookExecutor {
  return new HookExecutor(options);
}

/**
 * Create a PreToolHookProvider backed by the given HookExecutor.
 */
export function createPreToolHookProvider(executor: HookExecutor): PreToolHookProviderImpl {
  return new PreToolHookProviderImpl(executor);
}

/**
 * Create a LoopPassStartHookEvaluator backed by the given HookExecutor.
 */
export function createLoopPassStartEvaluator(executor: HookExecutor): LoopPassStartHookEvaluator {
  return new LoopPassStartHookEvaluator(executor);
}

// ─── Utilities ──────────────────────────────────────────────────

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
