/**
 * Semantic Index IPC handlers — wires renderer to the semantic search backend.
 *
 * Channels:
 *   - semantic:search — natural language search against the vector index
 *   - semantic:index-status — current indexing pipeline state
 *   - semantic:reindex — trigger a full re-index of the project
 *
 * Requirements: 2.3, 2.7
 */

import { ipcMain } from 'electron';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system';

export interface SemanticIPCDeps {
  /** Feature gate instance for checking `semantic_index` flag */
  featureGate?: FeatureGateSystem;
  /** Returns the active indexing pipeline controller, or null if unavailable */
  getIndexingPipeline?: () => any | null;
  /** Returns the vector store / embedding store for search queries */
  getVectorStore?: () => any | null;
  /** Returns the active project ID */
  getActiveProjectId?: () => string | null;
}

/**
 * Register IPC handlers for semantic search functionality.
 * All handlers are gated behind the `semantic_index` feature flag.
 */
export function registerSemanticIPC(deps: SemanticIPCDeps = {}): void {
  const { featureGate, getIndexingPipeline, getVectorStore, getActiveProjectId } = deps;

  // Remove existing handlers if re-registering
  const channels = ['semantic:search', 'semantic:index-status', 'semantic:reindex'];
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch); } catch {}
  }

  /**
   * semantic:search — query the semantic index with natural language
   *
   * Args: { query: string; projectId?: string; topK?: number }
   * Returns: { results: Array<{ id, filePath, chunkName, chunkType, startLine, endLine, content, score }> }
   */
  ipcMain.handle('semantic:search', async (_ev, args: any) => {
    try {
      // Feature gate check
      if (featureGate && !featureGate.isEnabled('semantic_index' as any)) {
        return { results: [], error: 'semantic_index feature is disabled' };
      }

      const query = typeof args === 'string' ? args : args?.query;
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return { results: [], error: 'Query is required' };
      }

      const projectId = args?.projectId || getActiveProjectId?.() || null;
      if (!projectId) {
        return { results: [], error: 'No active project' };
      }

      const topK = typeof args?.topK === 'number' ? Math.min(args.topK, 50) : 10;

      const vectorStore = getVectorStore?.();
      if (!vectorStore) {
        return { results: [], error: 'Vector store not available. Run a re-index first.' };
      }

      // Delegate to the vector store's search method
      const results = await vectorStore.search(projectId, query, topK);
      return { results: results || [] };
    } catch (e: any) {
      console.error('[SemanticIPC] search error:', e?.message);
      return { results: [], error: e?.message || 'Search failed' };
    }
  });

  /**
   * semantic:index-status — get the current state of the semantic indexing pipeline
   *
   * Returns: { indexed: boolean; filesIndexed: number; totalFiles: number; lastIndexedAt: number | null; inProgress: boolean }
   */
  ipcMain.handle('semantic:index-status', async (_ev, _args: any) => {
    try {
      if (featureGate && !featureGate.isEnabled('semantic_index' as any)) {
        return { indexed: false, filesIndexed: 0, totalFiles: 0, lastIndexedAt: null, inProgress: false, disabled: true };
      }

      // args.projectId available for future per-project status filtering
      const pipeline = getIndexingPipeline?.();

      if (!pipeline) {
        return { indexed: false, filesIndexed: 0, totalFiles: 0, lastIndexedAt: null, inProgress: false };
      }

      const status = pipeline.getStatus?.() || {};
      return {
        indexed: (status.filesIndexed || 0) > 0,
        filesIndexed: status.filesIndexed || 0,
        totalFiles: status.totalFiles || 0,
        lastIndexedAt: status.lastIndexedAt || null,
        inProgress: status.running || false,
      };
    } catch (e: any) {
      console.error('[SemanticIPC] index-status error:', e?.message);
      return { indexed: false, filesIndexed: 0, totalFiles: 0, lastIndexedAt: null, inProgress: false, error: e?.message };
    }
  });

  /**
   * semantic:reindex — trigger a full re-index of the current project
   *
   * Args: { projectId?: string; projectPath?: string }
   * Returns: { success: boolean; error?: string }
   */
  ipcMain.handle('semantic:reindex', async (_ev, args: any) => {
    try {
      if (featureGate && !featureGate.isEnabled('semantic_index' as any)) {
        return { success: false, error: 'semantic_index feature is disabled' };
      }

      const pipeline = getIndexingPipeline?.();
      if (!pipeline) {
        return { success: false, error: 'Indexing pipeline not initialized' };
      }

      const projectPath = args?.projectPath;
      if (!projectPath) {
        return { success: false, error: 'Project path is required for re-indexing' };
      }

      // Kick off the full reindex asynchronously
      pipeline.fullReindex(projectPath).catch((err: any) => {
        console.error('[SemanticIPC] reindex error:', err?.message);
      });

      return { success: true };
    } catch (e: any) {
      console.error('[SemanticIPC] reindex error:', e?.message);
      return { success: false, error: e?.message || 'Reindex failed' };
    }
  });

  console.log('[IPC] Semantic Index IPC handlers registered');
}
