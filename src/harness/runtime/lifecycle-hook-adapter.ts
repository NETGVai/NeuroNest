/**
 * Lifecycle Hook Adapter — Translates established client lifecycle hooks into
 * canonical observe or command events at adapter boundaries.
 *
 * Lifecycle phases:
 * - pre_request: Invoked before an operation is dispatched; may reject
 * - post_response: Invoked after a successful response; observe-only
 * - error: Invoked on operation failure; may emit recovery commands
 * - cancellation: Invoked when an operation is cancelled; observe-only
 *
 * Hooks are registered per adapter, ordered by priority, and executed sequentially.
 * Each hook receives canonical data (never raw protocol). Hook results are either
 * continue (with optional emitted events), reject, or observe.
 *
 * Requirements: 25.3, 25.4, 25.6
 */

import {
  LifecycleHookRegistrationSchema,
  LifecycleHookContextSchema,
  type LifecycleHookRegistration,
  type LifecycleHookContext,
  type LifecycleHookResult,
  type LifecycleHookPhase,
  type CanonicalOperation,
  type AdapterIdentity,
} from './protocol-adapter-types.js';

// ─── Hook Handler Interface ─────────────────────────────────────

/**
 * A lifecycle hook handler that processes canonical hook contexts.
 * Implementations are protocol-specific but operate on canonical data.
 */
export interface LifecycleHookHandler {
  /**
   * Execute the hook logic. Returns a result indicating whether to continue,
   * reject, or observe.
   */
  execute(context: LifecycleHookContext): Promise<LifecycleHookResult>;
}

// ─── Lifecycle Hook Registry ────────────────────────────────────

/**
 * Result of executing a lifecycle hook chain for a phase.
 */
export type HookChainResult =
  | { outcome: 'continue'; emittedEvents: Record<string, unknown>[] }
  | { outcome: 'rejected'; hookId: string; reason: string }
  | { outcome: 'observed'; observations: Record<string, unknown>[] };

/**
 * Manages lifecycle hook registrations and executes hook chains for each phase.
 * Hooks are confined to adapter boundaries and translate external lifecycle events
 * into canonical observe or command events.
 */
export class LifecycleHookAdapter {
  private readonly adapterId: string;
  private readonly registrations: Map<string, LifecycleHookRegistration> = new Map();
  private readonly handlers: Map<string, LifecycleHookHandler> = new Map();

  constructor(adapterIdentity: AdapterIdentity) {
    this.adapterId = adapterIdentity.adapterId;
  }

  /**
   * Register a lifecycle hook for a specific phase.
   * Validates the registration schema before accepting.
   */
  registerHook(
    registration: LifecycleHookRegistration,
    handler: LifecycleHookHandler,
  ): { registered: boolean; reason?: string } {
    // Validate registration
    const parsed = LifecycleHookRegistrationSchema.safeParse(registration);
    if (!parsed.success) {
      return { registered: false, reason: `Invalid hook registration: ${parsed.error.message}` };
    }

    // Ensure hook belongs to this adapter
    if (registration.adapterId !== this.adapterId) {
      return {
        registered: false,
        reason: `Hook adapterId '${registration.adapterId}' does not match adapter '${this.adapterId}'`,
      };
    }

    this.registrations.set(registration.hookId, parsed.data);
    this.handlers.set(registration.hookId, handler);
    return { registered: true };
  }

  /**
   * Unregister a lifecycle hook.
   */
  unregisterHook(hookId: string): boolean {
    const existed = this.registrations.delete(hookId);
    this.handlers.delete(hookId);
    return existed;
  }

  /**
   * Get all registered hooks for a specific phase, ordered by priority.
   */
  getHooksForPhase(phase: LifecycleHookPhase): LifecycleHookRegistration[] {
    const hooks: LifecycleHookRegistration[] = [];
    for (const reg of this.registrations.values()) {
      if (reg.phase === phase && reg.enabled) {
        hooks.push(reg);
      }
    }
    // Sort by priority ascending (lower priority number = earlier execution)
    return hooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Execute all enabled hooks for the pre_request phase.
   * Any hook can reject the operation.
   */
  async executePreRequest(operation: CanonicalOperation): Promise<HookChainResult> {
    return this.executePhase('pre_request', operation);
  }

  /**
   * Execute all enabled hooks for the post_response phase.
   * These are observe-only — they cannot reject.
   */
  async executePostResponse(operation: CanonicalOperation): Promise<HookChainResult> {
    return this.executePhase('post_response', operation);
  }

  /**
   * Execute all enabled hooks for the error phase.
   * May emit recovery commands.
   */
  async executeError(
    operation: CanonicalOperation,
    errorData: Record<string, unknown>,
  ): Promise<HookChainResult> {
    return this.executePhase('error', operation, errorData);
  }

  /**
   * Execute all enabled hooks for the cancellation phase.
   * These are observe-only.
   */
  async executeCancellation(operation: CanonicalOperation): Promise<HookChainResult> {
    return this.executePhase('cancellation', operation);
  }

  /**
   * Execute a hook chain for a specific phase.
   * Hooks run sequentially in priority order.
   */
  private async executePhase(
    phase: LifecycleHookPhase,
    operation: CanonicalOperation,
    additionalData?: Record<string, unknown>,
  ): Promise<HookChainResult> {
    const hooks = this.getHooksForPhase(phase);
    const emittedEvents: Record<string, unknown>[] = [];
    const observations: Record<string, unknown>[] = [];

    for (const hookReg of hooks) {
      const handler = this.handlers.get(hookReg.hookId);
      if (!handler) {
        continue;
      }

      // Build canonical hook context — never raw protocol data
      const context = this.buildHookContext(hookReg, operation, additionalData);
      const contextValidation = LifecycleHookContextSchema.safeParse(context);
      if (!contextValidation.success) {
        // Skip hooks with invalid context rather than failing the chain
        continue;
      }

      const result = await handler.execute(contextValidation.data);

      switch (result.action) {
        case 'continue':
          if (result.emittedEvents) {
            emittedEvents.push(...result.emittedEvents);
          }
          break;

        case 'reject':
          // Only pre_request hooks can reject
          if (phase === 'pre_request') {
            return { outcome: 'rejected', hookId: hookReg.hookId, reason: result.reason };
          }
          // For other phases, treat reject as an observation
          observations.push({
            type: 'hook_rejection_ignored',
            hookId: hookReg.hookId,
            reason: result.reason,
            phase,
          });
          break;

        case 'observe':
          observations.push(result.observationEvent);
          break;
      }
    }

    if (observations.length > 0) {
      return { outcome: 'observed', observations };
    }

    return { outcome: 'continue', emittedEvents };
  }

  /**
   * Build a canonical hook context from operation data.
   * This context contains only canonical data — no raw protocol.
   */
  private buildHookContext(
    registration: LifecycleHookRegistration,
    operation: CanonicalOperation,
    additionalData?: Record<string, unknown>,
  ): LifecycleHookContext {
    return {
      hookId: registration.hookId,
      phase: registration.phase,
      operationId: operation.operationId,
      correlationId: operation.correlationId,
      actor: operation.actor,
      scope: operation.scope,
      timestamp: new Date().toISOString(),
      canonicalData: {
        operationType: operation.operationType,
        payload: operation.canonicalPayload,
        ...(additionalData ?? {}),
      },
    };
  }

  /**
   * Get all registered hooks (for inspection/diagnostics).
   */
  getRegistrations(): ReadonlyMap<string, LifecycleHookRegistration> {
    return this.registrations;
  }

  /**
   * Disable a hook without removing its registration.
   */
  disableHook(hookId: string): boolean {
    const reg = this.registrations.get(hookId);
    if (!reg) return false;
    this.registrations.set(hookId, { ...reg, enabled: false });
    return true;
  }

  /**
   * Enable a previously disabled hook.
   */
  enableHook(hookId: string): boolean {
    const reg = this.registrations.get(hookId);
    if (!reg) return false;
    this.registrations.set(hookId, { ...reg, enabled: true });
    return true;
  }

  /**
   * Clear all registrations (used during shutdown).
   */
  clear(): void {
    this.registrations.clear();
    this.handlers.clear();
  }
}
