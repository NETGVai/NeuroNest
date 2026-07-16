// File: packages/neuronest-cli/src/cli/acp-event-mapper.ts
//
// Maps internal swarm/Loop events to ACP `agent/event` JSON-RPC
// notifications for real-time streaming to connected clients.
//
// Validates: Requirements 16.4, 16.5, 16.6 (task context)
// Validates: Requirements 20.3, 20.4 (ACP event streaming)

import type { JsonRpcNotification } from './acp-stdio-server.js';

// ─── Event Types ────────────────────────────────────────────────

export interface ACPEventBase {
  sessionId: string;
  timestamp: string;
}

export interface ToolUseStartEvent extends ACPEventBase {
  type: 'tool_use_start';
  toolId: string;
  args: Record<string, unknown>;
}

export interface ToolUseEndEvent extends ACPEventBase {
  type: 'tool_use_end';
  toolId: string;
  result: unknown;
  duration: number;
}

export interface TurnCompleteEvent extends ACPEventBase {
  type: 'turn_complete';
  messageId: string;
}

export interface LoopPassDoneEvent extends ACPEventBase {
  type: 'loop_pass_done';
  passNumber: number;
  state: string;
}

export interface PartialContentEvent extends ACPEventBase {
  type: 'partial_content';
  content: string;
}

export type ACPEvent =
  | ToolUseStartEvent
  | ToolUseEndEvent
  | TurnCompleteEvent
  | LoopPassDoneEvent
  | PartialContentEvent;

// ─── Notification Sender Interface ──────────────────────────────

/**
 * Interface for the server's notification sender. Decouples the mapper
 * from the full ACPStdioServer so it can be tested independently.
 */
export interface NotificationSender {
  sendNotification(method: string, params: Record<string, unknown>): void;
}

// ─── Internal Event Types (inputs to the mapper) ────────────────

export interface InternalToolUseStart {
  kind: 'tool_use_start';
  toolId: string;
  args: Record<string, unknown>;
}

export interface InternalToolUseEnd {
  kind: 'tool_use_end';
  toolId: string;
  result: unknown;
  duration: number;
}

export interface InternalTurnComplete {
  kind: 'turn_complete';
  messageId: string;
}

export interface InternalLoopPassDone {
  kind: 'loop_pass_done';
  passNumber: number;
  state: string;
}

export interface InternalPartialContent {
  kind: 'partial_content';
  content: string;
}

export type InternalEvent =
  | InternalToolUseStart
  | InternalToolUseEnd
  | InternalTurnComplete
  | InternalLoopPassDone
  | InternalPartialContent;

// ─── ACPEventMapper ─────────────────────────────────────────────

export interface ACPEventMapperOptions {
  /** The notification sender (typically the ACP server instance). */
  sender: NotificationSender;
  /** Session ID for event context. */
  sessionId: string;
  /** Debounce interval for partial_content events in milliseconds (default: 50). */
  debounceMs?: number;
  /** Optional clock function for testing (returns ISO timestamp). */
  clock?: () => string;
}

/**
 * Maps internal execution events to `agent/event` JSON-RPC notifications.
 *
 * Discrete events (tool_use_start, tool_use_end, turn_complete, loop_pass_done)
 * are emitted immediately. Partial content events are debounced — rapid token
 * chunks are batched into a single notification every `debounceMs` milliseconds.
 */
export class ACPEventMapper {
  private readonly sender: NotificationSender;
  private readonly sessionId: string;
  private readonly debounceMs: number;
  private readonly clock: () => string;

  // Streaming debounce state
  private pendingContent: string = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ACPEventMapperOptions) {
    this.sender = options.sender;
    this.sessionId = options.sessionId;
    this.debounceMs = options.debounceMs ?? 50;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Emit an internal event as an `agent/event` JSON-RPC notification.
   * Partial content events are debounced; all others emit immediately.
   */
  emit(event: InternalEvent): void {
    if (event.kind === 'partial_content') {
      this.bufferPartialContent(event.content);
    } else {
      this.sendEvent(this.mapEvent(event));
    }
  }

  /**
   * Flush any pending partial content immediately.
   * Call this when the stream ends or on session teardown.
   */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingContent.length > 0) {
      this.sendEvent({
        type: 'partial_content',
        content: this.pendingContent,
        sessionId: this.sessionId,
        timestamp: this.clock(),
      });
      this.pendingContent = '';
    }
  }

  /**
   * Clean up resources. Flushes pending content and clears timers.
   */
  dispose(): void {
    this.flush();
  }

  // ─── Internal ───────────────────────────────────────────────

  private bufferPartialContent(content: string): void {
    this.pendingContent += content;

    if (this.debounceTimer === null) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingContent.length > 0) {
          this.sendEvent({
            type: 'partial_content',
            content: this.pendingContent,
            sessionId: this.sessionId,
            timestamp: this.clock(),
          });
          this.pendingContent = '';
        }
      }, this.debounceMs);
    }
  }

  private mapEvent(event: Exclude<InternalEvent, InternalPartialContent>): ACPEvent {
    const base: ACPEventBase = {
      sessionId: this.sessionId,
      timestamp: this.clock(),
    };

    switch (event.kind) {
      case 'tool_use_start':
        return { ...base, type: 'tool_use_start', toolId: event.toolId, args: event.args };
      case 'tool_use_end':
        return { ...base, type: 'tool_use_end', toolId: event.toolId, result: event.result, duration: event.duration };
      case 'turn_complete':
        return { ...base, type: 'turn_complete', messageId: event.messageId };
      case 'loop_pass_done':
        return { ...base, type: 'loop_pass_done', passNumber: event.passNumber, state: event.state };
    }
  }

  private sendEvent(event: ACPEvent): void {
    const notification: Omit<JsonRpcNotification, 'jsonrpc' | 'method'> & { method: string } = {
      method: 'agent/event',
    };
    // The sender handles framing — we just provide method and params
    this.sender.sendNotification('agent/event', event as unknown as Record<string, unknown>);
  }
}
