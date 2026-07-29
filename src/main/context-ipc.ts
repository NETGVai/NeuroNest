/**
 * IPC handler registration for the Global Context Framework (GCF).
 *
 * Uses the ipcMain.handle() pattern matching existing NeuroNest IPC modules
 * (drift-ipc.ts, artifact-ipc.ts). All inputs validated with Zod schemas.
 *
 * Channels:
 *   context:add-source     — Add a file or URL context source
 *   context:remove-source  — Remove a context source by entry ID
 *   context:list-sources   — List all active context sources
 *   context:get-entry      — Retrieve a single context entry by ID
 *   context:get-stats      — Get aggregated context statistics
 *
 * Real-time streaming pushes (main → renderer):
 *   context:drift-event    — Pushed to renderer when drift is detected
 *
 * Requirements: 9.1, 9.4, 9.5, 6.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { GCFCore } from '../context/gcf-core.js';
import type { ContextEntry, ContextStats, IPCErrorResponse } from '../context/types.js';

// ─── Zod Schemas ────────────────────────────────────────────────

/**
 * Schema for context:add-source input.
 * Supports both 'file' and 'url' source types with appropriate validation.
 */
export const AddSourceRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    path: z.string().min(1, 'File path must not be empty'),
  }),
  z.object({
    type: z.literal('url'),
    url: z.string().url('Must be a valid URL'),
  }),
]);
export type AddSourceRequest = z.infer<typeof AddSourceRequestSchema>;

/**
 * Schema for context:remove-source input.
 */
export const RemoveSourceRequestSchema = z.object({
  entryId: z.string().min(1, 'Entry ID must not be empty'),
});
export type RemoveSourceRequest = z.infer<typeof RemoveSourceRequestSchema>;

/**
 * Schema for context:list-sources input (no parameters required).
 */
export const ListSourcesRequestSchema = z.object({}).optional();
export type ListSourcesRequest = z.infer<typeof ListSourcesRequestSchema>;

/**
 * Schema for context:get-entry input.
 */
export const GetEntryRequestSchema = z.object({
  entryId: z.string().min(1, 'Entry ID must not be empty'),
});
export type GetEntryRequest = z.infer<typeof GetEntryRequestSchema>;

/**
 * Schema for context:get-stats input (no parameters required).
 */
export const GetStatsRequestSchema = z.object({}).optional();
export type GetStatsRequest = z.infer<typeof GetStatsRequestSchema>;

// ─── IPC Success Response Types ─────────────────────────────────

export interface AddSourceResponse {
  success: true;
  entry: ContextEntry;
}

export interface RemoveSourceResponse {
  success: true;
}

export interface ListSourcesResponse {
  success: true;
  entries: ContextEntry[];
}

export interface GetEntryResponse {
  success: true;
  entry: ContextEntry;
}

export interface GetStatsResponse {
  success: true;
  stats: ContextStats;
}

// ─── Error Helpers ──────────────────────────────────────────────

/**
 * Error codes for structured IPC error responses.
 */
export type ContextIPCErrorCode =
  | 'VALIDATION_ERROR'
  | 'MAX_SOURCES_EXCEEDED'
  | 'INVALID_URL'
  | 'SOURCE_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_READABLE'
  | 'FETCH_FAILED'
  | 'INTERNAL_ERROR';

/**
 * Create a structured IPC error response.
 */
function makeError(code: ContextIPCErrorCode, message: string, details?: unknown): IPCErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}

/**
 * Map GCF error messages to structured error codes.
 */
function mapErrorToCode(err: unknown): { code: ContextIPCErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith('MAX_SOURCES_EXCEEDED')) {
    return { code: 'MAX_SOURCES_EXCEEDED', message };
  }
  if (message.startsWith('FILE_NOT_FOUND')) {
    return { code: 'FILE_NOT_FOUND', message };
  }
  if (message.startsWith('FILE_NOT_READABLE')) {
    return { code: 'FILE_NOT_READABLE', message };
  }
  if (message.includes('INVALID_URL') || message.includes('invalid url')) {
    return { code: 'INVALID_URL', message };
  }
  if (message.includes('fetch') || message.includes('FETCH_FAILED')) {
    return { code: 'FETCH_FAILED', message };
  }

  return { code: 'INTERNAL_ERROR', message };
}

// ─── Registration ───────────────────────────────────────────────

export interface ContextIPCDeps {
  gcf: GCFCore;
  mainWindow: BrowserWindow;
}

/**
 * Register all GCF-related IPC handlers on the Electron IPC bridge.
 *
 * Validates all inputs with Zod schemas before processing. Returns structured
 * IPCErrorResponse for invalid inputs or GCF operational errors.
 *
 * Also wires drift event notifications from GCF to the renderer process.
 *
 * Requirements: 9.1, 9.4, 9.5, 6.3
 */
export function registerContextIPC(deps: ContextIPCDeps): void {
  const { gcf, mainWindow } = deps;

  // ── context:add-source ──
  // Requirement 9.1: Register IPC handler for adding context sources
  // Requirement 9.5: Validate input with Zod before processing
  ipcMain.handle(
    'context:add-source',
    async (_event, args: unknown): Promise<AddSourceResponse | IPCErrorResponse> => {
      // Validate input
      const parsed = AddSourceRequestSchema.safeParse(args);
      if (!parsed.success) {
        return makeError(
          'VALIDATION_ERROR',
          'Invalid input for context:add-source',
          parsed.error.format(),
        );
      }

      const input = parsed.data;

      try {
        let entry: ContextEntry;

        if (input.type === 'file') {
          entry = await gcf.addFileSource(input.path);
        } else {
          entry = await gcf.addUrlSource(input.url);
        }

        return { success: true, entry };
      } catch (err) {
        const { code, message } = mapErrorToCode(err);
        return makeError(code, message);
      }
    },
  );

  // ── context:remove-source ──
  // Requirement 9.1: Register IPC handler for removing context sources
  // Requirement 9.5: Validate input with Zod before processing
  ipcMain.handle(
    'context:remove-source',
    async (_event, args: unknown): Promise<RemoveSourceResponse | IPCErrorResponse> => {
      // Validate input
      const parsed = RemoveSourceRequestSchema.safeParse(args);
      if (!parsed.success) {
        return makeError(
          'VALIDATION_ERROR',
          'Invalid input for context:remove-source',
          parsed.error.format(),
        );
      }

      const { entryId } = parsed.data;

      try {
        // Verify entry exists before removal
        const sources = gcf.listSources();
        const exists = sources.some((e) => e.id === entryId);
        if (!exists) {
          return makeError('SOURCE_NOT_FOUND', `Context source not found: ${entryId}`);
        }

        gcf.removeSource(entryId);
        return { success: true };
      } catch (err) {
        const { code, message } = mapErrorToCode(err);
        return makeError(code, message);
      }
    },
  );

  // ── context:list-sources ──
  // Requirement 9.1: Register IPC handler for listing context sources
  ipcMain.handle(
    'context:list-sources',
    async (_event, _args: unknown): Promise<ListSourcesResponse | IPCErrorResponse> => {
      try {
        const entries = gcf.listSources();
        return { success: true, entries };
      } catch (err) {
        const { code, message } = mapErrorToCode(err);
        return makeError(code, message);
      }
    },
  );

  // ── context:get-entry ──
  // Requirement 9.1: Register IPC handler for retrieving a single entry
  // Requirement 9.5: Validate input with Zod before processing
  ipcMain.handle(
    'context:get-entry',
    async (_event, args: unknown): Promise<GetEntryResponse | IPCErrorResponse> => {
      // Validate input
      const parsed = GetEntryRequestSchema.safeParse(args);
      if (!parsed.success) {
        return makeError(
          'VALIDATION_ERROR',
          'Invalid input for context:get-entry',
          parsed.error.format(),
        );
      }

      const { entryId } = parsed.data;

      try {
        const sources = gcf.listSources();
        const entry = sources.find((e) => e.id === entryId);

        if (!entry) {
          return makeError('SOURCE_NOT_FOUND', `Context entry not found: ${entryId}`);
        }

        return { success: true, entry };
      } catch (err) {
        const { code, message } = mapErrorToCode(err);
        return makeError(code, message);
      }
    },
  );

  // ── context:get-stats ──
  // Requirement 9.4: Return context statistics via IPC
  ipcMain.handle(
    'context:get-stats',
    async (_event, _args: unknown): Promise<GetStatsResponse | IPCErrorResponse> => {
      try {
        const stats = gcf.getStats();
        return { success: true, stats };
      } catch (err) {
        const { code, message } = mapErrorToCode(err);
        return makeError(code, message);
      }
    },
  );

  // ── Wire drift event notifications to renderer ──
  // Requirement 6.3: Send drift notification to renderer via IPC
  gcf.on('drift-detected', (data?: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('context:drift-event', data);
    }
  });
}

// ─── Push Functions (main → renderer) ───────────────────────────

/**
 * Push a context drift event to the renderer process.
 *
 * Can be called externally by the Drift Reconciler when drift is detected.
 * Requirement 6.3: Drift event notification sent via IPC to renderer.
 */
export function pushContextDriftEvent(
  mainWindow: BrowserWindow | null,
  event: { entryId: string; agent1Id: string; agent2Id: string; timestamp: number },
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('context:drift-event', event);
  }
}
