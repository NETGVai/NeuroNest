/**
 * Shared type definitions for the Global Context Framework (GCF).
 *
 * These types are consumed across the context subsystem: store, file watcher,
 * URL fetcher, drift reconciler, AST analyzer, prompt enrichment, response
 * validation, incremental engine, semantic search, edit history, and IPC bridge.
 */

// ---------------------------------------------------------------------------
// Core Context Types
// ---------------------------------------------------------------------------

/**
 * A single unit of context data stored in the GCF with associated metadata.
 */
export interface ContextEntry {
  id: string;
  type: 'file' | 'url' | 'agent_generated';
  source: string;
  content: string | null;
  hash: string;
  priority: 'pinned' | 'active' | 'background';
  producerAgentId?: string | undefined;
  createdAt: number;
  lastAccessedAt: number;
  promptsSinceLastAccess: number;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Filter criteria for querying Context_Entries from the GCF.
 */
export interface ContextQueryFilter {
  type?: ContextEntry['type'] | undefined;
  source?: string | undefined;
  minPriority?: ContextEntry['priority'] | undefined;
  maxAge?: number | undefined;
  limit?: number | undefined;
}

/**
 * Aggregated statistics for the current GCF session.
 */
export interface ContextStats {
  totalEntries: number;
  memoryUsageBytes: number;
  cacheHitRate: number;
  activeSourceCount: number;
  lastDriftEventAt: number | null;
}

/**
 * Lifecycle and mutation events emitted by the GCF.
 */
export interface ContextEvent {
  type: 'entry-added' | 'entry-updated' | 'entry-removed' | 'drift-detected';
  entryId: string;
  agentId?: string | undefined;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// File Watcher Types
// ---------------------------------------------------------------------------

/**
 * Event emitted when a watched file changes or is deleted on disk.
 */
export interface FileChangeEvent {
  filePath: string;
  type: 'change' | 'delete';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// URL Fetcher Types
// ---------------------------------------------------------------------------

/**
 * Result of a URL fetch operation, including TTL caching metadata.
 */
export interface FetchResult {
  content: string;
  hash: string;
  fetchedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Drift Reconciliation Types
// ---------------------------------------------------------------------------

/**
 * A recorded drift event when multiple agents concurrently modify the same entry.
 */
export interface DriftEvent {
  id: string;
  entryId: string;
  agent1Id: string;
  agent2Id: string;
  value1Hash: string;
  value2Hash: string;
  resolvedValue: 'latest' | 'previous' | 'manual';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// AST Analyzer Types
// ---------------------------------------------------------------------------

/**
 * Languages supported by the AST_Analyzer for structural code parsing.
 */
export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'json';

/**
 * Metadata for a single code symbol extracted from AST analysis.
 */
export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'constant' | 'enum';
  filePath: string;
  lineStart: number;
  lineEnd: number;
  parameters?: string[] | undefined;
  returnType?: string | undefined;
  exported: boolean;
  signature: string;
}

/**
 * Directed graph of code symbols and their dependency relationships.
 */
export interface CodeGraph {
  nodes: Map<string, SymbolInfo>;
  edges: Map<string, { imports: string[]; calls: string[]; inherits: string[]; typeRefs: string[] }>;
}

// ---------------------------------------------------------------------------
// Semantic Search Types
// ---------------------------------------------------------------------------

/**
 * A code snippet scored by semantic similarity to a query.
 */
export interface ScoredSnippet {
  symbol: SymbolInfo;
  score: number;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Edit History Types
// ---------------------------------------------------------------------------

/**
 * A single recorded edit in the rolling edit history window.
 */
export interface EditEntry {
  id: string;
  filePath: string;
  diff: string;
  actor: string;
  timestamp: number;
  reverted: boolean;
}

// ---------------------------------------------------------------------------
// Context Window Optimizer Types
// ---------------------------------------------------------------------------

/**
 * The assembled context output after priority selection, summarization, and chunking.
 */
export interface AssembledContext {
  text: string;
  tokenCount: number;
  includedEntryIds: string[];
  summarizedEntryIds: string[];
  droppedEntryIds: string[];
}

// ---------------------------------------------------------------------------
// Prompt Enrichment Types
// ---------------------------------------------------------------------------

/**
 * The result of the multi-stage prompt enrichment pipeline.
 */
export interface EnrichedPrompt {
  originalPrompt: string;
  injectedContext: string;
  resolvedSymbols: string[];
  importMaps: string[];
  recentEdits: string[];
  tokenCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Response Validation Types
// ---------------------------------------------------------------------------

/**
 * Result of validating an LLM-generated code response.
 */
export interface ValidationResult {
  passed: boolean;
  diagnostics: Diagnostic[];
  status: 'validated' | 'validation_disabled' | 'errors_found';
}

/**
 * A single diagnostic issue found during response validation.
 */
export interface Diagnostic {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
  source: 'typescript' | 'eslint' | 'prettier';
}

// ---------------------------------------------------------------------------
// IPC Types
// ---------------------------------------------------------------------------

/**
 * Structured error response returned by IPC handlers for invalid inputs or failures.
 */
export interface IPCErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown | undefined;
  };
}
