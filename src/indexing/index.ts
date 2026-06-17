/**
 * Incremental Indexing Subsystem
 *
 * This module exports the core indexing pipeline components:
 * - IndexingPipelineController: orchestrates end-to-end file indexing
 * - ASTChunker: parses source files into semantic chunks via Tree-sitter
 * - EmbeddingStore: persists and queries vector embeddings in SQLite
 * - CallGraphEngine: builds and queries the directed call graph
 * - TransformationCache: content-addressable memoization of agent results
 * - EmbeddingDaemonClient: background worker thread for embedding inference
 * - Connectors: pluggable ingestion for Git, Markdown, etc.
 */

export { EmbeddingStore } from './embedding-store.js';
export type { EmbeddingRecord, SearchResult } from './embedding-store.js';
export { TransformationCache } from './transformation-cache.js';
export type { CacheEntry, CacheStats } from './transformation-cache.js';

export { CallGraphEngine } from './call-graph-engine.js';
export type { CallGraphNode, CallGraphEdge, BlastRadius, CallEdge } from './call-graph-engine.js';

export { ASTChunker } from './ast-chunker.js';
export type { Chunk } from './ast-chunker.js';

export { LineageTracker } from './lineage-tracker.js';
export type { LineageRecord } from './lineage-tracker.js';

export { EmbeddingDaemonClient } from './embedding-daemon.js';
export type { EmbeddingDaemonConfig, EmbeddingRequest, EmbeddingResponse, DaemonHealth } from './embedding-daemon.js';

export { IndexingPipelineController } from './indexing-pipeline-controller.js';
export type { IndexingConfig, FileProvenance, PipelineStatus } from './indexing-pipeline-controller.js';

export type { Connector, ConnectorNode, ConnectorEdge } from './connectors/connector-interface.js';

export { serializeGraphExtract, toGraphPayload } from './graph-export.js';
export type {
  GraphExtract,
  GraphExtractNode,
  GraphExtractEdge,
  GraphEncoding,
  SerializedGraphExtract,
  SerializeGraphExtractOptions,
  MetricsSink as GraphExportMetricsSink,
} from './graph-export.js';

export { CodeExplorer } from './code-explorer.js';
export type { IndexResult, IndexResultType, IndexStats } from './code-explorer.js';
