/**
 * IPC handler registration for the Execution Trace System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, pipeline-ipc.ts).
 *
 * Channels:
 *   trace:get              — retrieve a single trace by ID
 *   trace:list-by-session  — list all traces for a session
 *   trace:stream           — subscribe to real-time trace updates (via webContents.send)
 *
 * Real-time streaming pushes:
 *   trace:update           — pushed to renderer when trace events occur
 *
 * Requirements: 14.3, 14.4
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { ExecutionTraceService } from '../infrastructure/execution-trace-service.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { ExecutionTrace, TraceEntry } from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface TraceIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Real-time update types ─────────────────────────────────────

export type TraceUpdateType = 'trace-started' | 'entry-added' | 'trace-completed';

export interface TraceUpdate {
  updateType: TraceUpdateType;
  traceId: string;
  sessionId?: string;
  messageId?: string;
  startedAt?: string;
  entry?: TraceEntry;
  completedAt?: string;
  totalDurationMs?: number;
  totalTokens?: number;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let traceService: ExecutionTraceService | null = null;

function getTraceService(db: Database.Database, callbackEngine?: CallbackEngine | null): ExecutionTraceService {
  if (!traceService) {
    traceService = new ExecutionTraceService(db, callbackEngine);
  }
  return traceService;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): TraceIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Stream subscription state ──────────────────────────────────

/** Set of traceIds the renderer is subscribed to for real-time updates. */
const streamSubscriptions = new Set<string>();

/** Whether a session-level subscription is active (receives all trace updates for a session). */
const sessionSubscriptions = new Set<string>();

// ─── Registration ───────────────────────────────────────────────

export interface TraceIPCOptions {
  db: Database.Database;
  callbackEngine?: CallbackEngine | null;
}

export function registerTraceIPC(
  mainWindow: BrowserWindow,
  options: TraceIPCOptions,
): void {
  const service = getTraceService(options.db, options.callbackEngine);

  // ── trace:get ──
  // Retrieve a single execution trace by ID with all entries
  ipcMain.handle(
    'trace:get',
    async (_event, args: { traceId: string }) => {
      try {
        const trace = await service.getTrace(args.traceId);

        if (!trace) {
          return makeError('TRACE_NOT_FOUND', new Error(`Trace not found: ${args.traceId}`));
        }

        return serializeTrace(trace);
      } catch (err) {
        return makeError('TRACE_GET_FAILED', err);
      }
    },
  );

  // ── trace:list-by-session ──
  // List all traces for a given session, ordered by start time descending
  ipcMain.handle(
    'trace:list-by-session',
    async (_event, args: { sessionId: string }) => {
      try {
        const traces = await service.getTracesBySession(args.sessionId);
        return traces.map(serializeTrace);
      } catch (err) {
        return makeError('TRACE_LIST_FAILED', err);
      }
    },
  );

  // ── trace:stream ──
  // Subscribe/unsubscribe to real-time trace updates.
  // The renderer calls this to register interest in trace events.
  // Updates are pushed via mainWindow.webContents.send('trace:update', ...).
  ipcMain.handle(
    'trace:stream',
    async (
      _event,
      args: { action: 'subscribe' | 'unsubscribe'; traceId?: string; sessionId?: string },
    ) => {
      try {
        if (args.action === 'subscribe') {
          if (args.traceId) {
            streamSubscriptions.add(args.traceId);
          }
          if (args.sessionId) {
            sessionSubscriptions.add(args.sessionId);
          }
          return { subscribed: true, traceId: args.traceId, sessionId: args.sessionId };
        }

        if (args.action === 'unsubscribe') {
          if (args.traceId) {
            streamSubscriptions.delete(args.traceId);
          }
          if (args.sessionId) {
            sessionSubscriptions.delete(args.sessionId);
          }
          return { subscribed: false, traceId: args.traceId, sessionId: args.sessionId };
        }

        return makeError('INVALID_ACTION', new Error(`Invalid stream action: ${args.action}`));
      } catch (err) {
        return makeError('TRACE_STREAM_FAILED', err);
      }
    },
  );

  // ── Real-time update hook ──
  // Listen to CallbackEngine events for trace updates and push to renderer.
  // Requirement 14.3: Real-time updates as steps complete.
  // Requirement 14.4: Failure highlighting (renderer uses error field in entries).
  if (options.callbackEngine) {
    options.callbackEngine.register('after-tool-call', (context) => {
      const toolName = context.toolName;
      if (!toolName || !toolName.startsWith('trace:')) return;

      const output = context.output as Record<string, unknown> | undefined;
      if (!output) return;

      const traceId = output['traceId'] as string | undefined;
      if (!traceId) return;

      // Check if renderer is subscribed to this trace or session
      const sessionId = output['sessionId'] as string | undefined;
      const isSubscribed =
        streamSubscriptions.has(traceId) ||
        (sessionId && sessionSubscriptions.has(sessionId));

      if (!isSubscribed) return;

      // Build update payload based on event type
      const updateType = toolName.replace('trace:', '') as TraceUpdateType;
      const update: TraceUpdate = {
        updateType,
        traceId,
      };

      if (sessionId) {
        update.sessionId = sessionId;
      }
      if (output['messageId']) {
        update.messageId = output['messageId'] as string;
      }
      if (output['startedAt']) {
        update.startedAt = output['startedAt'] as string;
      }
      if (output['entry']) {
        update.entry = output['entry'] as TraceEntry;
      }
      if (output['completedAt']) {
        update.completedAt = output['completedAt'] as string;
      }
      if (output['totalDurationMs'] !== undefined) {
        update.totalDurationMs = output['totalDurationMs'] as number;
      }
      if (output['totalTokens'] !== undefined) {
        update.totalTokens = output['totalTokens'] as number;
      }

      // Push to renderer if window is still alive
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('trace:update', update);
      }
    });
  }
}

// ─── Serialization helpers ──────────────────────────────────────

/**
 * Serialize an ExecutionTrace for IPC transport.
 * Ensures all fields are plain JSON-serializable objects.
 */
function serializeTrace(trace: ExecutionTrace): object {
  return {
    id: trace.id,
    sessionId: trace.sessionId,
    messageId: trace.messageId,
    entries: trace.entries.map(serializeEntry),
    startedAt: trace.startedAt,
    completedAt: trace.completedAt ?? null,
    totalDurationMs: trace.totalDurationMs,
    totalTokens: trace.totalTokens,
  };
}

/**
 * Serialize a TraceEntry for IPC transport.
 */
function serializeEntry(entry: TraceEntry): object {
  return {
    id: entry.id,
    traceId: entry.traceId,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    type: entry.type,
    toolName: entry.toolName ?? null,
    parameters: entry.parameters ?? null,
    tokenCount: entry.tokenCount ?? null,
    durationMs: entry.durationMs ?? null,
    result: entry.result ?? null,
    error: entry.error ?? null,
  };
}
