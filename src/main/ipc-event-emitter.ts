/**
 * IPCEventEmitter — Wraps the `ipcSend` function to emit structured agent events
 * to the renderer process for real-time activity streaming.
 *
 * All emissions are gated behind the `production_ux_realtime_activity` feature flag.
 * When the flag is disabled, all emit calls are no-ops with zero overhead.
 *
 * This module provides the main-process side of the IPC event protocol defined
 * in `src/shared/production-ux-types.ts`. The renderer subscribes to these events
 * via the preload bridge's LISTEN_CHANNELS.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 5.1, 6.5, 21.2, 22.5
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system';
import type {
  EnhancedLoopProgress,
  ToolLifecycleEvent,
  FileChangeEvent,
  StreamTokenEvent,
  TaskCompleteEvent,
  AgentErrorEvent,
  ParallelStatusEvent,
} from '../shared/production-ux-types';

// ─── IPC Channel Constants ──────────────────────────────────────

export const IPC_CHANNELS = {
  PROGRESS: 'agent:progress',
  TOOL_EVENT: 'agent:tool-event',
  FILE_CHANGE: 'agent:file-change',
  STREAM_TOKEN: 'agent:stream-token',
  TASK_COMPLETE: 'agent:task-complete',
  ERROR: 'agent:error',
  PARALLEL_STATUS: 'agent:parallel-status',
} as const;

// ─── IPCEventEmitter Class ──────────────────────────────────────

/**
 * Wraps the raw `ipcSend` function with type-safe event emission methods.
 * Checks the `production_ux_realtime_activity` feature gate before every emit.
 * Fail-soft: any emission error is swallowed with a console warning so a bad
 * payload never tears down the agent loop execution flow.
 */
export class IPCEventEmitter {
  private readonly ipcSend: (channel: string, data: unknown) => void;
  private readonly featureGate: FeatureGateSystem | null;

  constructor(
    ipcSend: (channel: string, data: unknown) => void,
    featureGate: FeatureGateSystem | null,
  ) {
    this.ipcSend = ipcSend;
    this.featureGate = featureGate;
  }

  // ─── Gate Check ─────────────────────────────────────────────────

  /**
   * Returns true when the realtime activity feature gate is enabled.
   * When no feature gate is available, defaults to disabled (safe fallback).
   */
  private isEnabled(): boolean {
    if (!this.featureGate) return false;
    return this.featureGate.isEnabled('production_ux_realtime_activity');
  }

  // ─── Emit Methods ───────────────────────────────────────────────

  /**
   * Emit an enhanced progress event (iteration state, phase label, tool target).
   * Validates: Requirements 4.1, 4.3, 5.1, 5.4
   */
  emitProgress(progress: EnhancedLoopProgress): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.PROGRESS, progress);
  }

  /**
   * Emit a tool lifecycle event (start, complete, or error).
   * Validates: Requirements 4.2, 4.4, 6.5
   */
  emitToolEvent(event: ToolLifecycleEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.TOOL_EVENT, event);
  }

  /**
   * Emit a file change event (created, modified, deleted).
   * Validates: Requirements 6.5
   */
  emitFileChange(event: FileChangeEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.FILE_CHANGE, event);
  }

  /**
   * Emit a stream token event for incremental LLM response rendering.
   * Validates: Requirements 21.2
   */
  emitStreamToken(event: StreamTokenEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.STREAM_TOKEN, event);
  }

  /**
   * Emit a task complete event with the full change summary.
   * Validates: Requirements 4.5, 5.1
   */
  emitTaskComplete(event: TaskCompleteEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.TASK_COMPLETE, event);
  }

  /**
   * Emit a classified error event for user-friendly display.
   * Validates: Requirements 5.1 (error state indicator)
   */
  emitError(event: AgentErrorEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.ERROR, event);
  }

  /**
   * Emit a parallel status event for concurrent tool execution visibility.
   * Validates: Requirements 22.5
   */
  emitParallelStatus(event: ParallelStatusEvent): void {
    if (!this.isEnabled()) return;
    this.safeSend(IPC_CHANNELS.PARALLEL_STATUS, event);
  }

  // ─── Internal ───────────────────────────────────────────────────

  /**
   * Safe wrapper around ipcSend that catches and logs any errors.
   * Ensures IPC emission failures never interrupt agent loop execution.
   */
  private safeSend(channel: string, data: unknown): void {
    try {
      this.ipcSend(channel, data);
    } catch (e) {
      // Fail-soft: log warning but never propagate to caller.
      // eslint-disable-next-line no-console
      console.warn(
        `[IPCEventEmitter] Failed to emit on "${channel}":`,
        (e as Error)?.message ?? e,
      );
    }
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create an IPCEventEmitter instance. Returns null if no ipcSend function
 * is provided (e.g., in headless or CLI mode).
 */
export function createIPCEventEmitter(
  ipcSend: ((channel: string, data: unknown) => void) | undefined,
  featureGate: FeatureGateSystem | null,
): IPCEventEmitter | null {
  if (!ipcSend) return null;
  return new IPCEventEmitter(ipcSend, featureGate);
}

// ─── Callback Wiring Helpers ────────────────────────────────────

/**
 * Creates an `onProgress` callback that wraps the raw LoopProgress with
 * enhanced fields and emits via the IPCEventEmitter.
 *
 * The enhanced progress includes a human-readable `phaseLabel` derived
 * from the status field, and optional `toolTarget` when a tool is executing.
 */
export function createProgressCallback(
  emitter: IPCEventEmitter | null,
  existingCallback?: (update: import('../pipeline/agent-loop').LoopProgress) => void,
): (update: import('../pipeline/agent-loop').LoopProgress) => void {
  return (update) => {
    // Always call the existing callback first (backwards-compatible)
    existingCallback?.(update);

    if (!emitter) return;

    // Build the enhanced progress event with phase label
    const enhanced: EnhancedLoopProgress = {
      ...update,
      phaseLabel: buildPhaseLabel(update.status, update.lastToolCall),
    };

    emitter.emitProgress(enhanced);
  };
}

/**
 * Creates an `onToolEvent` callback that emits tool lifecycle events via IPC.
 */
export function createToolEventCallback(
  emitter: IPCEventEmitter | null,
): ((event: ToolLifecycleEvent) => void) | undefined {
  if (!emitter) return undefined;
  return (event) => emitter.emitToolEvent(event);
}

/**
 * Creates an `onFileChange` callback that emits file change events via IPC.
 */
export function createFileChangeCallback(
  emitter: IPCEventEmitter | null,
): ((event: FileChangeEvent) => void) | undefined {
  if (!emitter) return undefined;
  return (event) => emitter.emitFileChange(event);
}

/**
 * Creates an `onStreamToken` callback that emits stream token events via IPC.
 */
export function createStreamTokenCallback(
  emitter: IPCEventEmitter | null,
): ((event: StreamTokenEvent) => void) | undefined {
  if (!emitter) return undefined;
  return (event) => emitter.emitStreamToken(event);
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Build a human-readable phase label from the status and tool name.
 * Used in EnhancedLoopProgress for renderer display.
 */
function buildPhaseLabel(
  status: string,
  lastToolCall?: string,
): string {
  switch (status) {
    case 'thinking':
      return 'Thinking...';
    case 'tool_executing':
      if (lastToolCall) {
        // Special-case common tool names for friendly labels
        if (lastToolCall === 'file-write' || lastToolCall === 'file-edit') {
          return `Writing file...`;
        }
        if (lastToolCall === 'file-read') {
          return `Reading file...`;
        }
        if (lastToolCall === 'shell-exec') {
          return `Running command...`;
        }
        return `Running tool: ${lastToolCall}`;
      }
      return 'Executing tool...';
    case 'awaiting_approval':
      return 'Awaiting approval...';
    case 'complete':
      return 'Complete';
    default:
      return status;
  }
}
