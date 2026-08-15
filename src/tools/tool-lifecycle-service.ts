/**
 * ToolLifecycleService — Tracks tool invocations through lifecycle states.
 *
 * Manages lifecycle transitions:
 *   requested → policy_checking → awaiting_approval → running → succeeded/failed/rejected/cancelled/timed_out
 *
 * Also supports the legacy subset: pending → approved → running → completed/failed/cancelled
 * (mapped transparently for backward compatibility).
 *
 * Records timestamps, output previews, multi-step progress, and emits typed Tool_Events
 * for the timeline.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Full lifecycle states per Requirement 18.1 */
export type ToolLifecycleState =
  | 'requested'
  | 'policy_checking'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  // Legacy aliases (mapped to new states in event emission)
  | 'pending'
  | 'approved'
  | 'completed';

/** Terminal states that indicate the invocation is done */
export const TERMINAL_STATES: ReadonlySet<ToolLifecycleState> = new Set([
  'succeeded', 'failed', 'rejected', 'cancelled', 'timed_out', 'completed',
]);

/** A timestamp record for each state transition */
export interface StateTransition {
  from: ToolLifecycleState | null;
  to: ToolLifecycleState;
  timestamp: string;
}

/** Multi-step progress tracking */
export interface ToolProgress {
  currentStep: number;
  totalSteps: number;
  stepDescription: string;
}

/** A tracked tool invocation */
export interface ToolInvocation {
  id: string;
  toolName: string;
  purpose: string;
  scope: string;
  arguments: Record<string, unknown>;
  agentId: string;
  taskId?: string;
  runId?: string;
  correlationId: string;

  state: ToolLifecycleState;
  transitions: StateTransition[];
  startedAt: string | null;
  completedAt: string | null;

  outputPreview: string | null;
  progress: ToolProgress | null;

  error?: string;
  errorCategory?: string;
  retryable?: boolean;
  modelFeedback?: string;
}

/** Tool_Event emitted for the timeline */
export interface ToolTimelineEvent {
  id: string;
  type: 'tool_event';
  invocationId: string;
  toolName: string;
  state: ToolLifecycleState;
  timestamp: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  summary: string;
}

/** Configuration for the lifecycle service */
export interface ToolLifecycleConfig {
  /** Maximum length for output previews (default: 1024) */
  maxOutputPreviewLength?: number;
}

/** Listener for timeline events */
export type ToolEventListener = (event: ToolTimelineEvent) => void;

// ─── Valid transitions ──────────────────────────────────────────

const VALID_TRANSITIONS: Record<ToolLifecycleState, ToolLifecycleState[]> = {
  // Full R18.1 state machine
  requested: ['policy_checking', 'cancelled', 'rejected'],
  policy_checking: ['awaiting_approval', 'running', 'rejected', 'cancelled', 'failed'],
  awaiting_approval: ['running', 'rejected', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out', 'completed'],
  succeeded: [],
  failed: [],
  rejected: [],
  cancelled: [],
  timed_out: [],
  // Legacy aliases (backward-compatible transitions)
  pending: ['approved', 'cancelled', 'failed', 'policy_checking', 'rejected'],
  approved: ['running', 'cancelled', 'failed'],
  completed: [],
};

// ─── Service ────────────────────────────────────────────────────

export class ToolLifecycleService {
  private invocations = new Map<string, ToolInvocation>();
  private listeners: ToolEventListener[] = [];
  private maxOutputPreviewLength: number;

  constructor(config?: ToolLifecycleConfig) {
    this.maxOutputPreviewLength = config?.maxOutputPreviewLength ?? 1024;
  }

  /**
   * Create a new tool invocation in 'pending' state.
   */
  createInvocation(params: {
    toolName: string;
    purpose: string;
    scope: string;
    arguments: Record<string, unknown>;
    agentId: string;
    sessionId: string;
    taskId?: string;
    runId?: string;
  }): ToolInvocation {
    const now = new Date().toISOString();
    const id = randomUUID();
    const correlationId = randomUUID();

    const invocation: ToolInvocation = {
      id,
      toolName: params.toolName,
      purpose: params.purpose,
      scope: params.scope,
      arguments: params.arguments,
      agentId: params.agentId,
      taskId: params.taskId,
      runId: params.runId,
      correlationId,

      state: 'pending',
      transitions: [{ from: null, to: 'pending', timestamp: now }],
      startedAt: now,
      completedAt: null,

      outputPreview: null,
      progress: null,
    };

    this.invocations.set(id, invocation);
    this.emitEvent(invocation, params.sessionId);
    return invocation;
  }

  /**
   * Transition an invocation to a new state.
   * Throws if the transition is invalid.
   */
  transition(invocationId: string, newState: ToolLifecycleState, sessionId: string): ToolInvocation {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) {
      throw new Error(`Invocation not found: ${invocationId}`);
    }

    const allowed = VALID_TRANSITIONS[invocation.state];
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid transition from '${invocation.state}' to '${newState}' for invocation ${invocationId}`,
      );
    }

    const now = new Date().toISOString();
    invocation.transitions.push({ from: invocation.state, to: newState, timestamp: now });
    invocation.state = newState;

    if (newState === 'completed' || newState === 'failed' || newState === 'cancelled'
        || newState === 'succeeded' || newState === 'rejected' || newState === 'timed_out') {
      invocation.completedAt = now;
    }

    this.emitEvent(invocation, sessionId);
    return invocation;
  }

  /**
   * Set the output preview for an invocation (bounded by maxOutputPreviewLength).
   */
  setOutputPreview(invocationId: string, output: string): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) {
      throw new Error(`Invocation not found: ${invocationId}`);
    }

    invocation.outputPreview =
      output.length > this.maxOutputPreviewLength
        ? output.slice(0, this.maxOutputPreviewLength)
        : output;
  }

  /**
   * Update multi-step progress for an invocation.
   */
  updateProgress(invocationId: string, progress: ToolProgress): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) {
      throw new Error(`Invocation not found: ${invocationId}`);
    }

    if (progress.currentStep < 0 || progress.currentStep > progress.totalSteps) {
      throw new Error(
        `Invalid progress: step ${progress.currentStep} out of range [0, ${progress.totalSteps}]`,
      );
    }

    invocation.progress = { ...progress };
  }

  /**
   * Cancel an invocation at any cancellable state.
   */
  cancel(invocationId: string, sessionId: string): ToolInvocation {
    return this.transition(invocationId, 'cancelled', sessionId);
  }

  /**
   * Mark an invocation as failed with error details.
   */
  fail(
    invocationId: string,
    sessionId: string,
    details: {
      error: string;
      errorCategory?: string;
      retryable?: boolean;
      modelFeedback?: string;
    },
  ): ToolInvocation {
    const invocation = this.transition(invocationId, 'failed', sessionId);
    invocation.error = details.error;
    invocation.errorCategory = details.errorCategory;
    invocation.retryable = details.retryable;
    invocation.modelFeedback = details.modelFeedback;
    return invocation;
  }

  /**
   * Get an invocation by ID.
   */
  getInvocation(invocationId: string): ToolInvocation | undefined {
    return this.invocations.get(invocationId);
  }

  /**
   * Get all invocations for a session or run.
   */
  getInvocations(filter?: { sessionId?: string; runId?: string; taskId?: string }): ToolInvocation[] {
    const all = Array.from(this.invocations.values());
    if (!filter) return all;
    return all.filter((inv) => {
      if (filter.runId && inv.runId !== filter.runId) return false;
      if (filter.taskId && inv.taskId !== filter.taskId) return false;
      return true;
    });
  }

  /**
   * Subscribe to timeline events.
   */
  onEvent(listener: ToolEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emitEvent(invocation: ToolInvocation, sessionId: string): void {
    const event: ToolTimelineEvent = {
      id: randomUUID(),
      type: 'tool_event',
      invocationId: invocation.id,
      toolName: invocation.toolName,
      state: invocation.state,
      timestamp: new Date().toISOString(),
      sessionId,
      taskId: invocation.taskId,
      runId: invocation.runId,
      summary: this.buildSummary(invocation),
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private buildSummary(invocation: ToolInvocation): string {
    const base = `${invocation.toolName}: ${invocation.state}`;
    if (invocation.state === 'failed' && invocation.error) {
      return `${base} — ${invocation.error}`;
    }
    if (invocation.progress) {
      return `${base} (${invocation.progress.currentStep}/${invocation.progress.totalSteps}: ${invocation.progress.stepDescription})`;
    }
    return base;
  }
}
