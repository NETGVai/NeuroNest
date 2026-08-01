/**
 * KB IPC Handler Registration — registers ipcMain.handle() handlers for all
 * Knowledge Base IPC channels.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, benchmark-ipc.ts).
 *
 * Channels (Renderer→Main):
 *   kb:sources-list   — list all configured sources for a project
 *   kb:source-add     — add and begin indexing a new source
 *   kb:source-remove  — delete source and all data
 *   kb:source-reindex — trigger re-indexing
 *   kb:status         — overall KB status summary
 *   kb:search         — search KB
 *   kb:config-update  — update embedding config
 *
 * Renderer-bound events (Main→Renderer via webContents.send):
 *   kb:indexing-progress       — real-time indexing progress
 *   kb:source-status-changed   — source state transitions
 *   kb:search-results          — async search results push
 *
 * Requirements: 29.1, 29.3, 29.4, 29.5, 27.6
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { ConnectorFramework } from '../connectors/connector-framework';
import { ConnectorConfigSchema } from '../connectors/types';
import type { KBEmbeddingService } from '../ingest/embedding-service';
import type { KBVectorStore } from '../ingest/vector-store';
import type { DataRetentionManager } from '../../training/cleanup/data-retention';

// ─── Zod Schemas for IPC Arguments ─────────────────────────────

/**
 * Schema for `kb:sources-list` channel arguments.
 */
export const KBSourcesListArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `kb:source-add` channel arguments.
 * Reuses the ConnectorConfigSchema from the connector types module.
 */
export const KBSourceAddArgsSchema = ConnectorConfigSchema;

/**
 * Schema for `kb:source-remove` channel arguments.
 */
export const KBSourceRemoveArgsSchema = z.object({
  sourceId: z.string().min(1, 'sourceId is required'),
});

/**
 * Schema for `kb:source-reindex` channel arguments.
 */
export const KBSourceReindexArgsSchema = z.object({
  sourceId: z.string().min(1, 'sourceId is required'),
});

/**
 * Schema for `kb:status` channel arguments.
 */
export const KBStatusArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
});

/**
 * Schema for `kb:search` channel arguments.
 */
export const KBSearchArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  query: z.string().min(1, 'query is required'),
  topK: z.number().int().positive().optional(),
});

/**
 * Schema for `kb:config-update` channel arguments.
 */
export const KBConfigUpdateArgsSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  config: z.object({
    modelId: z.string().min(1).optional(),
    provider: z.enum(['ollama', 'openai', 'onnx-local']).optional(),
    dimensions: z.number().int().positive().optional(),
  }).refine(
    (cfg) => cfg.modelId !== undefined || cfg.provider !== undefined || cfg.dimensions !== undefined,
    { message: 'At least one config field must be provided' },
  ),
});

// ─── IPCErrorResponse ───────────────────────────────────────────

/**
 * Structured error response returned by KB IPC handlers.
 * Conforms to the IPCErrorResponse pattern defined in the design document.
 */
export interface KBIPCErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    recoverable: boolean;
  };
}

/**
 * Structured success response wrapper.
 */
export interface KBIPCSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export type KBIPCResponse<T = unknown> = KBIPCSuccessResponse<T> | KBIPCErrorResponse;

// ─── Error Helpers ──────────────────────────────────────────────

/**
 * Create a structured validation error response from Zod parse errors.
 * Returns a descriptive error with validation failure details without throwing.
 */
function makeValidationError(zodError: z.ZodError): KBIPCErrorResponse {
  return {
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid arguments: ' + zodError.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      details: zodError.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
      recoverable: true,
    },
  };
}

/**
 * Create a structured operational error response.
 */
function makeError(code: string, err: unknown, recoverable = true): KBIPCErrorResponse {
  return {
    success: false,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      recoverable,
    },
  };
}

/**
 * Create a structured success response.
 */
function makeSuccess<T>(data: T): KBIPCSuccessResponse<T> {
  return {
    success: true,
    data,
  };
}

// ─── Dependencies Interface ─────────────────────────────────────

/**
 * Dependencies required by the KB IPC handlers.
 * Injected at registration time for testability.
 */
export interface KBIPCDependencies {
  /** The connector framework for source management. */
  connectorFramework: ConnectorFramework;
  /** The KB embedding service for search queries. */
  embeddingService: KBEmbeddingService;
  /** The KB vector store for search operations. */
  vectorStore: KBVectorStore;
  /** The main BrowserWindow for emitting renderer-bound events. */
  mainWindow: BrowserWindow;
  /** Project ID for the current session. */
  projectId: string;
  /** Optional data retention manager for coordinated source removal cleanup. */
  dataRetentionManager?: DataRetentionManager;
}

// ─── Renderer-Bound Event Emitters ──────────────────────────────

/**
 * Emit indexing progress to the renderer.
 * Channel: `kb:indexing-progress`
 */
export function emitIndexingProgress(
  mainWindow: BrowserWindow,
  data: {
    sourceId: string;
    chunksProcessed: number;
    totalChunks?: number;
    ratePerSecond?: number;
    etaMs?: number;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kb:indexing-progress', data);
  }
}

/**
 * Emit source status change to the renderer.
 * Channel: `kb:source-status-changed`
 */
export function emitSourceStatusChanged(
  mainWindow: BrowserWindow,
  data: {
    sourceId: string;
    status: string;
    error?: string;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kb:source-status-changed', data);
  }
}

/**
 * Emit search results to the renderer (for async / streaming results).
 * Channel: `kb:search-results`
 */
export function emitSearchResults(
  mainWindow: BrowserWindow,
  data: {
    projectId: string;
    query: string;
    results: Array<{
      id: string;
      content: string;
      sourceUri: string;
      similarity: number;
    }>;
  },
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kb:search-results', data);
  }
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register all KB IPC handlers on ipcMain.
 * Called during KB subsystem initialization, gated behind NEURONEST_KB_SYSTEM.
 *
 * All handlers:
 * 1. Validate inbound arguments using Zod schemas
 * 2. Return structured error responses for invalid arguments (no throwing)
 * 3. Delegate to KB subsystem components
 * 4. Emit renderer-bound events for real-time UI updates
 */
export function registerKBIPCHandlers(deps: KBIPCDependencies): void {
  const { connectorFramework, embeddingService, vectorStore, mainWindow, projectId, dataRetentionManager } = deps;

  // ── kb:sources-list ──
  // Requirement 29.1: List all configured sources for the project
  ipcMain.handle(
    'kb:sources-list',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBSourcesListArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const sources = connectorFramework.listSources();
        return makeSuccess(sources);
      } catch (err) {
        return makeError('KB_SOURCES_LIST_FAILED', err);
      }
    },
  );

  // ── kb:source-add ──
  // Requirement 29.1: Add and begin indexing a source
  ipcMain.handle(
    'kb:source-add',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBSourceAddArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const config = parsed.data;
        // Generate a unique source ID (uuidv7 pattern)
        const sourceId = `kb-src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await connectorFramework.addSource(sourceId, config);

        // Emit status change to renderer
        emitSourceStatusChanged(mainWindow, {
          sourceId: result.id,
          status: result.status,
        });

        return makeSuccess({ id: result.id, status: result.status });
      } catch (err) {
        return makeError('KB_SOURCE_ADD_FAILED', err);
      }
    },
  );

  // ── kb:source-remove ──
  // Requirement 29.1: Delete source and all data
  // Requirement 35.2: Coordinated LanceDB + SQLite deletion
  ipcMain.handle(
    'kb:source-remove',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBSourceRemoveArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { sourceId } = parsed.data;

        // Use DataRetentionManager for coordinated deletion if available
        if (dataRetentionManager) {
          // Coordinated: SQLite transaction first, then LanceDB deletion
          await dataRetentionManager.removeSourceData(sourceId);
        } else {
          // Fallback: separate deletion (original behavior)
          await connectorFramework.removeSource(sourceId);
          await vectorStore.deleteBySourceId(sourceId);
        }

        // Emit status change to renderer
        emitSourceStatusChanged(mainWindow, {
          sourceId,
          status: 'removed',
        });

        return makeSuccess({ removed: true });
      } catch (err) {
        return makeError('KB_SOURCE_REMOVE_FAILED', err);
      }
    },
  );

  // ── kb:source-reindex ──
  // Requirement 29.1: Trigger re-indexing
  ipcMain.handle(
    'kb:source-reindex',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBSourceReindexArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { sourceId } = parsed.data;

        // Emit status change to renderer (indexing started)
        emitSourceStatusChanged(mainWindow, {
          sourceId,
          status: 'indexing',
        });

        // Kick off re-indexing in the background (non-blocking)
        // The reindexSource method is an async generator; consume it
        // and track progress for the renderer.
        let chunksProcessed = 0;
        const reindex = async (): Promise<void> => {
          try {
            for await (const _doc of connectorFramework.reindexSource(sourceId)) {
              chunksProcessed++;
              // Emit progress periodically (every 10 documents)
              if (chunksProcessed % 10 === 0) {
                emitIndexingProgress(mainWindow, {
                  sourceId,
                  chunksProcessed,
                });
              }
            }
            // Complete
            emitSourceStatusChanged(mainWindow, {
              sourceId,
              status: 'idle',
            });
          } catch (reindexErr) {
            emitSourceStatusChanged(mainWindow, {
              sourceId,
              status: 'error',
              error: reindexErr instanceof Error ? reindexErr.message : String(reindexErr),
            });
          }
        };

        // Fire-and-forget — the IPC response confirms queuing
        reindex();

        return makeSuccess({ queued: true });
      } catch (err) {
        return makeError('KB_SOURCE_REINDEX_FAILED', err);
      }
    },
  );

  // ── kb:status ──
  // Requirement 29.1: Overall KB status summary
  ipcMain.handle(
    'kb:status',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBStatusArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const sources = connectorFramework.listSources();
        const totalSources = sources.length;
        const indexingSources = sources.filter((s) => s.status === 'indexing').length;
        const errorSources = sources.filter((s) => s.status === 'error' || s.status === 'auth-failed').length;
        const idleSources = sources.filter((s) => s.status === 'idle').length;
        const totalChunks = await vectorStore.count();

        return makeSuccess({
          projectId: parsed.data.projectId,
          totalSources,
          indexingSources,
          errorSources,
          idleSources,
          totalChunks,
          embeddingModel: embeddingService.getProvider(),
          dimensions: embeddingService.getDimensions(),
        });
      } catch (err) {
        return makeError('KB_STATUS_FAILED', err);
      }
    },
  );

  // ── kb:search ──
  // Requirement 29.1: Search KB
  ipcMain.handle(
    'kb:search',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBSearchArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { query, topK } = parsed.data;
        const searchTopK = topK ?? 10;

        // Embed the query
        const embeddingResult = await embeddingService.embed(query);

        // Search the vector store
        const results = await vectorStore.search(embeddingResult.vector, searchTopK);

        const searchResults = results.map((r) => ({
          id: r.id,
          content: r.content,
          sourceUri: r.source_uri,
          similarity: r.similarity,
        }));

        // Also emit results to renderer for async notification
        emitSearchResults(mainWindow, {
          projectId: parsed.data.projectId,
          query,
          results: searchResults,
        });

        return makeSuccess({
          results: searchResults,
          queryTimeMs: Date.now(), // placeholder — real impl would measure
          totalResults: searchResults.length,
        });
      } catch (err) {
        return makeError('KB_SEARCH_FAILED', err);
      }
    },
  );

  // ── kb:config-update ──
  // Requirement 29.1: Update embedding config
  ipcMain.handle(
    'kb:config-update',
    async (_event, args: unknown): Promise<KBIPCResponse> => {
      // Validate arguments
      const parsed = KBConfigUpdateArgsSchema.safeParse(args);
      if (!parsed.success) {
        return makeValidationError(parsed.error);
      }

      try {
        const { projectId: targetProjectId, config } = parsed.data;

        // Apply config changes to the embedding service
        embeddingService.switchBackend(
          {
            ...(config.modelId && { modelId: config.modelId }),
            ...(config.provider && { provider: config.provider as 'onnx-local' | 'ollama' | 'tfidf' }),
            ...(config.dimensions && { dimensions: config.dimensions as 384 | 768 | 1536 }),
          } as Partial<{ provider: 'onnx-local' | 'ollama' | 'tfidf'; modelId: string; dimensions: 384 | 768 | 1536 }>,
          targetProjectId,
        );

        // Persist the updated config
        embeddingService.saveProjectConfig(targetProjectId);

        return makeSuccess({ updated: true });
      } catch (err) {
        return makeError('KB_CONFIG_UPDATE_FAILED', err);
      }
    },
  );
}

/**
 * Unregister all KB IPC handlers.
 * Call during subsystem teardown or when the feature gate is disabled.
 */
export function unregisterKBIPCHandlers(): void {
  ipcMain.removeHandler('kb:sources-list');
  ipcMain.removeHandler('kb:source-add');
  ipcMain.removeHandler('kb:source-remove');
  ipcMain.removeHandler('kb:source-reindex');
  ipcMain.removeHandler('kb:status');
  ipcMain.removeHandler('kb:search');
  ipcMain.removeHandler('kb:config-update');
}
