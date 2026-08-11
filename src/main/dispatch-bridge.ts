/**
 * DispatchBridge — translates Agent Dashboard dispatch events into
 * ChatService-compatible IPC emissions.
 *
 * Encapsulates the logic for:
 *   - Persisting user messages with `source = 'dashboard'` to SQLite
 *   - Emitting `chat:message-received` to the ChatService renderer layer
 *   - Tracking in-flight dispatches by msgId
 *   - Cleaning up stale dispatch entries
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */

import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';

/** Configuration required to instantiate a DispatchBridge. */
export interface DispatchBridgeConfig {
  mainWindow: BrowserWindow;
  db: Database.Database;
}

/** Context tracked for each in-flight dispatch. */
export interface DispatchContext {
  projectId: string;
  msgId: string;
  source: 'dashboard';
  agent?: string;
  agentEmoji?: string;
  buffer: string;
  startedAt: number;
  status: 'streaming' | 'complete' | 'failed';
}

/** Default retention period for completed/failed dispatches: 5 minutes. */
const RETENTION_MS = 5 * 60 * 1000;

/**
 * DispatchBridge bridges Agent Dashboard dispatches to the ChatService
 * renderer by persisting messages to SQLite and emitting IPC events that
 * the ChatService already listens for.
 */
export class DispatchBridge {
  /** Tracks in-flight dispatches by msgId. */
  private activeDispatches: Map<string, DispatchContext> = new Map();

  constructor(private config: DispatchBridgeConfig) {}

  /**
   * Register a new dispatch: persist the user message to SQLite with
   * `source = 'dashboard'`, then emit `chat:message-received` so the
   * ChatService picks it up for rendering in the Chat Panel.
   */
  registerDispatch(payload: {
    projectId: string;
    message: string;
    source: string;
    agent?: string;
    msgId: string;
  }): void {
    const { projectId, message, source, agent, msgId } = payload;
    const trimmedContent = message.trim();

    // Persist user message to SQLite with source attribution
    const createdAt = new Date().toISOString();
    try {
      this.config.db
        .prepare(
          'INSERT INTO messages (id, session_id, role, content, tool_calls, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          msgId,
          projectId,
          'user',
          trimmedContent,
          agent ? JSON.stringify({ agent }) : null,
          source,
          createdAt,
        );
    } catch (err) {
      console.error('[DispatchBridge] Failed to persist user message:', (err as Error)?.message);
    }

    // Track this dispatch as active
    const context: DispatchContext = {
      projectId,
      msgId,
      source: 'dashboard',
      agent,
      agentEmoji: undefined,
      buffer: '',
      startedAt: Date.now(),
      status: 'streaming',
    };
    this.activeDispatches.set(msgId, context);

    // Emit to ChatService so the Chat Panel renders the user message
    try {
      if (!this.config.mainWindow.isDestroyed()) {
        this.config.mainWindow.webContents.send('chat:message-received', {
          id: msgId,
          roomId: projectId,
          sender: 'user',
          content: trimmedContent,
          timestamp: Date.now(),
          status: 'sent',
          metadata: {
            source: 'dashboard',
            agent: agent || undefined,
          },
        });
      }
    } catch (err) {
      // Fail-soft: ChatService delivery failure must not block dispatch
      console.warn('[DispatchBridge] Failed to emit chat:message-received:', (err as Error)?.message);
    }
  }

  /**
   * Check if a given msgId belongs to an active dashboard dispatch.
   */
  isDispatch(msgId: string): boolean {
    return this.activeDispatches.has(msgId);
  }

  /**
   * Clean up completed/failed dispatches older than the retention period.
   * Removes stale entries from the activeDispatches Map to prevent memory leaks.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [msgId, ctx] of this.activeDispatches) {
      if (now - ctx.startedAt > RETENTION_MS) {
        this.activeDispatches.delete(msgId);
      }
    }
  }

  /**
   * Forward a stream start event to the ChatService.
   * Emits `chat:stream-chunk` with `start: true`, agent name, agent emoji,
   * and `source: 'dashboard'` to create a placeholder assistant message
   * in the Chat Panel.
   *
   * Requirements: 2.1, 2.2, 5.3
   */
  onStreamStart(msgId: string, agentName: string, metadata?: Record<string, unknown>): void {
    const ctx = this.activeDispatches.get(msgId);
    if (!ctx) return;

    // Update context with agent info
    ctx.agent = agentName;
    const agentEmoji = (metadata?.agentEmoji as string) || undefined;
    ctx.agentEmoji = agentEmoji;

    try {
      if (!this.config.mainWindow.isDestroyed()) {
        this.config.mainWindow.webContents.send('chat:stream-chunk', {
          messageId: msgId,
          chunk: '',
          start: true,
          agent: agentName,
          agentEmoji: agentEmoji,
          source: 'dashboard',
        });
      }
    } catch (err) {
      // Fail-soft: ChatService delivery failure must not block dashboard (Req 5.4)
      console.warn('[DispatchBridge] Failed to emit stream start:', (err as Error)?.message);
    }
  }

  /**
   * Forward a stream token to the ChatService.
   * Emits `chat:stream-chunk` with the token chunk and accumulates the token
   * into the dispatch buffer for later persistence.
   *
   * Requirements: 2.3, 5.3
   */
  onStreamToken(msgId: string, token: string): void {
    const ctx = this.activeDispatches.get(msgId);
    if (!ctx) return;

    // Accumulate token in buffer for persistence on completion
    ctx.buffer += token;

    try {
      if (!this.config.mainWindow.isDestroyed()) {
        this.config.mainWindow.webContents.send('chat:stream-chunk', {
          messageId: msgId,
          chunk: token,
        });
      }
    } catch (err) {
      // Fail-soft: ChatService delivery failure must not block dashboard (Req 5.4)
      console.warn('[DispatchBridge] Failed to emit stream token:', (err as Error)?.message);
    }
  }

  /**
   * Forward a stream completion event to the ChatService.
   * Persists the accumulated buffer to SQLite as an assistant message,
   * emits `chat:stream-chunk` with `done: true`, and removes the dispatch
   * from activeDispatches.
   *
   * Requirements: 2.1, 2.4, 5.3, 5.4
   */
  onStreamDone(msgId: string, reasoning?: string): void {
    const ctx = this.activeDispatches.get(msgId);
    if (!ctx) return;

    ctx.status = 'complete';

    // Build tool_calls metadata JSON including optional reasoning content
    const toolCallsMeta: Record<string, unknown> = { source: 'dashboard' };
    if (ctx.agent) {
      toolCallsMeta.agent = ctx.agent;
    }
    if (reasoning) {
      toolCallsMeta.reasoning = reasoning;
    }

    // Persist the full assistant message to SQLite
    const createdAt = new Date().toISOString();
    try {
      this.config.db
        .prepare(
          'INSERT INTO messages (id, session_id, role, content, tool_calls, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          msgId + '-response',
          ctx.projectId,
          'assistant',
          ctx.buffer,
          JSON.stringify(toolCallsMeta),
          'dashboard',
          createdAt,
        );
    } catch (err) {
      console.error('[DispatchBridge] Failed to persist assistant message:', (err as Error)?.message);
    }

    // Emit stream done to ChatService, including reasoning in the payload
    try {
      if (!this.config.mainWindow.isDestroyed()) {
        this.config.mainWindow.webContents.send('chat:stream-chunk', {
          messageId: msgId,
          chunk: '',
          done: true,
          reasoning: reasoning || undefined,
        });
      }
    } catch (err) {
      console.warn('[DispatchBridge] Failed to emit stream done:', (err as Error)?.message);
    }

    // Remove from active dispatches
    this.activeDispatches.delete(msgId);
  }

  /**
   * Forward a stream error event to the ChatService.
   * Emits `chat:stream-chunk` with the error field, marks the dispatch as
   * failed, and persists any partial content accumulated in the buffer.
   *
   * Requirements: 2.5, 5.3, 5.4
   */
  onStreamError(msgId: string, error: string): void {
    const ctx = this.activeDispatches.get(msgId);
    if (!ctx) return;

    ctx.status = 'failed';

    // Persist partial content if any tokens were accumulated
    if (ctx.buffer.length > 0) {
      const createdAt = new Date().toISOString();
      try {
        this.config.db
          .prepare(
            'INSERT INTO messages (id, session_id, role, content, tool_calls, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            msgId + '-response',
            ctx.projectId,
            'assistant',
            ctx.buffer,
            JSON.stringify({ agent: ctx.agent || undefined, source: 'dashboard', error: true }),
            'dashboard',
            createdAt,
          );
      } catch (err) {
        console.error('[DispatchBridge] Failed to persist partial assistant message:', (err as Error)?.message);
      }
    }

    // Emit stream error to ChatService
    try {
      if (!this.config.mainWindow.isDestroyed()) {
        this.config.mainWindow.webContents.send('chat:stream-chunk', {
          messageId: msgId,
          chunk: '',
          error,
        });
      }
    } catch (err) {
      console.warn('[DispatchBridge] Failed to emit stream error:', (err as Error)?.message);
    }

    // Remove from active dispatches
    this.activeDispatches.delete(msgId);
  }
}
