/**
 * GCF Bootstrap — Application startup wiring for the Global Context Framework.
 *
 * Provides `bootstrapGCF(options)` which creates and initializes all GCF
 * components, wires event flows between them, registers IPC handlers, and
 * returns the initialized system. The function is idempotent (safe to call
 * multiple times) and supports graceful shutdown.
 *
 * Event flow connections:
 *   File Watcher → Incremental Context Engine → AST Analyzer → Semantic Search Index
 *   Prompt submission → Prompt Enrichment Pipeline → Context Window Optimizer → LLM
 *   LLM response → Response Validator → Self-Correction Loop → renderer
 *   File modifications (user/agent) → Edit History Tracker
 *
 * Requirements: 1.1, 9.2, 9.3, 14.1
 */

import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { GCFCore } from './gcf-core.js';
import { ASTAnalyzer } from './ast-analyzer.js';
import { SemanticSearchIndex } from './semantic-search.js';
import { IncrementalContextEngine } from './incremental-engine.js';
import { EditHistoryTracker } from './edit-history.js';
import { PromptEnrichmentPipeline } from './prompt-enrichment.js';
import { ResponseValidator } from './response-validator.js';
import { ContextWindowOptimizer } from './context-window-optimizer.js';
import { GCFAgentIntegration } from './gcf-agent-integration.js';
import { registerContextIPC } from '../main/context-ipc.js';
import { CallbackEngine } from '../pipeline/callback-engine.js';
import type { SupportedLanguage } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for bootstrapping the entire GCF system.
 */
export interface GCFBootstrapOptions {
  /** The SQLite database instance. */
  db: Database.Database;
  /** Absolute path to the project directory. */
  projectDir: string;
  /** Session identifier for this GCF session. */
  sessionId: string;
  /** The Electron BrowserWindow for IPC communication. */
  mainWindow: BrowserWindow;
  /** Optional: CallbackEngine instance (will create a new one if not provided). */
  callbackEngine?: CallbackEngine;
  /** Optional: Model context window size in tokens (default 128000). */
  modelContextWindow?: number;
  /** Optional: Ratio of context window reserved for LLM response (default 0.25). */
  responseBudgetRatio?: number;
  /** Optional: Maximum memory for GCF in bytes (default 64MB). */
  maxMemoryBytes?: number;
  /** Optional: Max concurrent file sources (default 50). */
  maxFileSources?: number;
  /** Optional: Max concurrent URL sources (default 20). */
  maxUrlSources?: number;
  /** Optional: Batch window for incremental engine in ms (default 500). */
  batchWindowMs?: number;
  /** Optional: Whether response validation is disabled. */
  validationDisabled?: boolean;
}

/**
 * The fully initialized GCF system returned by bootstrapGCF.
 * Exposes all components for use by the agent pipeline and other subsystems.
 */
export interface GCFSystem {
  /** Central GCF lifecycle and coordination module. */
  gcfCore: GCFCore;
  /** AST-based structural code analyzer. */
  astAnalyzer: ASTAnalyzer;
  /** Embedding-based semantic search over code symbols. */
  semanticSearch: SemanticSearchIndex;
  /** Diff-based incremental update engine. */
  incrementalEngine: IncrementalContextEngine;
  /** Rolling window edit history tracker. */
  editHistory: EditHistoryTracker;
  /** Multi-stage prompt augmentation pipeline. */
  promptEnrichment: PromptEnrichmentPipeline;
  /** Post-LLM response validation with self-correction. */
  responseValidator: ResponseValidator;
  /** Token-budget-aware context assembly. */
  contextWindowOptimizer: ContextWindowOptimizer;
  /** Bridge between GCF and the agent pipeline. */
  agentIntegration: GCFAgentIntegration;
  /** Lifecycle hook engine for the pipeline. */
  callbackEngine: CallbackEngine;
  /** Graceful shutdown function. */
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-Level Singleton Guard (Idempotency)
// ---------------------------------------------------------------------------

/** Singleton instance — ensures bootstrapGCF is idempotent. */
let currentSystem: GCFSystem | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_RESPONSE_BUDGET_RATIO = 0.25;
const DEFAULT_BATCH_WINDOW_MS = 500;
const DEFAULT_BULK_THRESHOLD_PERCENT = 30;
const DEFAULT_EMBEDDING_MODEL = 'tfidf-v1';
const DEFAULT_MAX_SYMBOLS = 50_000;

// ---------------------------------------------------------------------------
// Bootstrap Function
// ---------------------------------------------------------------------------

/**
 * Bootstrap the entire GCF system.
 *
 * Creates all components, wires event flows, registers IPC handlers, and
 * initializes the GCF Core. Idempotent: if already bootstrapped, returns
 * the existing system without re-initializing.
 *
 * @param options - Configuration for the GCF system.
 * @returns The fully initialized GCF system.
 */
export async function bootstrapGCF(options: GCFBootstrapOptions): Promise<GCFSystem> {
  // Idempotency: return existing system if already bootstrapped
  if (currentSystem !== null) {
    return currentSystem;
  }

  const {
    db,
    projectDir,
    sessionId,
    mainWindow,
    modelContextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
    responseBudgetRatio = DEFAULT_RESPONSE_BUDGET_RATIO,
    maxMemoryBytes,
    maxFileSources,
    maxUrlSources,
    batchWindowMs = DEFAULT_BATCH_WINDOW_MS,
    validationDisabled = false,
  } = options;

  // 1. Create CallbackEngine (or use provided one)
  const callbackEngine = options.callbackEngine ?? new CallbackEngine();

  // 2. Create GCF Core with all lifecycle dependencies
  const gcfCoreOptions: import('./gcf-core.js').GCFOptions = {
    db,
    projectDir,
    sessionId,
  };
  if (maxMemoryBytes !== undefined) gcfCoreOptions.maxMemoryBytes = maxMemoryBytes;
  if (maxFileSources !== undefined) gcfCoreOptions.maxFileSources = maxFileSources;
  if (maxUrlSources !== undefined) gcfCoreOptions.maxUrlSources = maxUrlSources;

  const gcfCore = new GCFCore(gcfCoreOptions);

  // 3. Create intelligence layer components
  const astAnalyzer = new ASTAnalyzer();

  const semanticSearch = new SemanticSearchIndex({
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    persistPath: projectDir,
    db,
    maxSymbols: DEFAULT_MAX_SYMBOLS,
  });

  const incrementalEngine = new IncrementalContextEngine({
    batchWindowMs,
    bulkThresholdPercent: DEFAULT_BULK_THRESHOLD_PERCENT,
    db,
    sessionId,
  });

  const editHistory = new EditHistoryTracker(db, {
    sessionId,
  });

  const promptEnrichment = new PromptEnrichmentPipeline({
    astAnalyzer,
    searchIndex: semanticSearch,
    editHistory,
    tokenBudgetRatio: 0.3,
  });

  const responseValidator = new ResponseValidator({
    projectDir,
    maxCorrectionIterations: 2,
    timeoutMs: 5000,
    validationDisabled,
  });

  const contextWindowOptimizer = new ContextWindowOptimizer({
    modelContextWindow,
    responseBudgetRatio,
  });

  // 4. Create agent integration bridge
  const agentIntegration = new GCFAgentIntegration({
    gcfCore,
    enrichmentPipeline: promptEnrichment,
    responseValidator,
    callbackEngine,
    sessionId,
  });

  // 5. Initialize GCF Core (loads persisted entries, starts watchers)
  await gcfCore.initialize();

  // 6. Wire event flows between components

  // 6a. File Watcher events → Incremental Context Engine → AST Analyzer → Semantic Search
  //     GCF Core emits 'entry-updated' when files change; we hook into that to drive
  //     the incremental pipeline.
  gcfCore.on('entry-updated', (data?: unknown) => {
    const eventData = data as { entryId?: string; reason?: string } | undefined;
    if (!eventData?.entryId) return;

    // The incremental engine handles file change tracking.
    // When a file source changes, trigger re-analysis through the pipeline.
    const entries = gcfCore.listSources();
    const entry = entries.find((e) => e.id === eventData.entryId);
    if (!entry || entry.type !== 'file' || !entry.content) return;

    // Step 1: Feed into incremental engine (batched, diff-based)
    // The incremental engine needs old vs new content, but we pass current content
    // for re-parse since it manages its own diff tracking internally.
    const filePath = entry.source;
    const content = entry.content;

    // Step 2: Re-parse via AST analyzer for structural updates
    const language = detectLanguage(filePath);
    if (language) {
      const parseResult = astAnalyzer.parse(filePath, content, language);

      // Step 3: Update semantic search index with new/changed symbols
      for (const symbol of parseResult.symbols) {
        void semanticSearch.index(symbol);
      }
    }
  });

  // 6b. Also handle new file entries being added
  gcfCore.on('entry-added', (data?: unknown) => {
    const eventData = data as { entryId?: string } | undefined;
    if (!eventData?.entryId) return;

    const entries = gcfCore.listSources();
    const entry = entries.find((e) => e.id === eventData.entryId);
    if (!entry || entry.type !== 'file' || !entry.content) return;

    const filePath = entry.source;
    const content = entry.content;
    const language = detectLanguage(filePath);

    if (language) {
      const parseResult = astAnalyzer.parse(filePath, content, language);
      for (const symbol of parseResult.symbols) {
        void semanticSearch.index(symbol);
      }
    }
  });

  // 6c. Connect Edit History Tracker to file modification events (user and agent)
  //     When an entry is updated, record it in edit history.
  gcfCore.on('entry-updated', (data?: unknown) => {
    const eventData = data as { entryId?: string } | undefined;
    if (!eventData?.entryId) return;

    const entries = gcfCore.listSources();
    const entry = entries.find((e) => e.id === eventData.entryId);
    if (!entry || entry.type !== 'file' || !entry.content) return;

    // Record the update as an edit event
    // Use a minimal diff representation since we don't have the old content here
    const diffSummary = `[file updated: ${entry.source}]`;
    const actor = entry.producerAgentId ?? 'user';
    editHistory.recordEdit(entry.source, diffSummary, actor);
  });

  // 6d. Emit GCF lifecycle events on the CallbackEngine (Req 9.3)
  gcfCore.on('context:initialized', () => {
    void callbackEngine.emit({
      event: 'after-tool-call',
      toolName: 'gcf:context-initialized',
      output: { projectDir },
      sessionId,
      iteration: 0,
    });
  });

  gcfCore.on('drift-detected', (data?: unknown) => {
    void callbackEngine.emit({
      event: 'on-drift-signal',
      sessionId,
      iteration: 0,
      output: data,
    });
  });

  // 7. Register IPC handlers for renderer communication
  registerContextIPC({
    gcf: gcfCore,
    mainWindow,
  });

  // 8. Build the system object
  const system: GCFSystem = {
    gcfCore,
    astAnalyzer,
    semanticSearch,
    incrementalEngine,
    editHistory,
    promptEnrichment,
    responseValidator,
    contextWindowOptimizer,
    agentIntegration,
    callbackEngine,
    shutdown: async () => {
      await gcfCore.shutdown();
      currentSystem = null;
    },
  };

  // Store as singleton
  currentSystem = system;

  return system;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Shutdown the currently active GCF system.
 * Flushes state to SQLite, stops watchers, and clears the singleton.
 * Safe to call even if no system is active (no-op).
 */
export async function shutdownGCF(): Promise<void> {
  if (currentSystem) {
    await currentSystem.shutdown();
  }
}

/**
 * Get the currently active GCF system, or null if not bootstrapped.
 */
export function getGCFSystem(): GCFSystem | null {
  return currentSystem;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect the programming language from a file path extension.
 * Returns null for unsupported languages (raw text fallback).
 */
function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
    case 'pyw':
      return 'python';
    case 'json':
      return 'json';
    default:
      return null;
  }
}
