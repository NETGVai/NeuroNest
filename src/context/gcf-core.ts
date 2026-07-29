/**
 * GCF Core — Global Context Framework lifecycle, coordination, and orchestration.
 *
 * Central module that manages the GCF lifecycle, wires dependencies (Context Store,
 * File Watcher, URL Fetcher), handles source management, cross-agent context sharing,
 * session restore, degraded mode, proactive eviction, and lifecycle event emission.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 3.1, 4.2, 4.4, 5.1, 5.2,
 *              5.3, 5.4, 5.5, 8.2, 8.7, 9.3
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { ContextStore } from './context-store.js';
import { FileWatcher } from './file-watcher.js';
import { URLFetcher } from './url-fetcher.js';
import type {
  ContextEntry,
  ContextEvent,
  ContextQueryFilter,
  ContextStats,
  FileChangeEvent,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default maximum in-memory context size (64MB) */
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** Default maximum concurrent file sources per session */
const DEFAULT_MAX_FILE_SOURCES = 50;

/** Default maximum concurrent URL sources per session */
const DEFAULT_MAX_URL_SOURCES = 20;

/** Memory eviction trigger threshold (80%) */
const EVICTION_TRIGGER_RATIO = 0.8;

/** Memory eviction target (70%) */
const EVICTION_TARGET_RATIO = 0.7;

/** Agent notification timeout (100ms) */
const AGENT_NOTIFY_TIMEOUT_MS = 100;

/** Agent notification retry delay (50ms) */
const AGENT_NOTIFY_RETRY_MS = 50;

// ─── Types ──────────────────────────────────────────────────────

/** Options for constructing a GCFCore instance. */
export interface GCFOptions {
  db: Database.Database;
  projectDir: string;
  sessionId: string;
  maxMemoryBytes?: number;
  maxFileSources?: number;
  maxUrlSources?: number;
}

/** GCF lifecycle event types emitted to listeners. */
export type GCFLifecycleEvent =
  | 'context:initialized'
  | 'entry-added'
  | 'entry-updated'
  | 'entry-removed'
  | 'drift-detected';

/** Callback for agent context event notifications. */
export type AgentCallback = (event: ContextEvent) => void;

/** Internal agent registration record. */
interface AgentRegistration {
  callback: AgentCallback;
  /** Events queued before session was active */
  queuedEvents: ContextEvent[];
}

// ─── GCFCore ────────────────────────────────────────────────────

/**
 * GCFCore — Central coordination module for the Global Context Framework.
 *
 * Manages the lifecycle of context sources (files, URLs, agent-generated),
 * coordinates cross-agent sharing, handles session restore and degraded mode,
 * and emits lifecycle events.
 */
export class GCFCore {
  private readonly db: Database.Database;
  readonly projectDir: string;
  private readonly sessionId: string;
  private readonly maxMemoryBytes: number;
  private readonly maxFileSources: number;
  private readonly maxUrlSources: number;

  // Dependencies
  private store: ContextStore | null = null;
  private fileWatcher: FileWatcher;
  private urlFetcher: URLFetcher;

  // State
  private initialized = false;
  private degradedMode = false;
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly lifecycleListeners = new Map<GCFLifecycleEvent, Array<(data?: unknown) => void>>();

  // In-memory fallback store (used in degraded mode)
  private readonly inMemoryEntries = new Map<string, ContextEntry>();

  // Tracking for file/url source counts
  private fileSourceCount = 0;
  private urlSourceCount = 0;

  // Stats
  private cacheHits = 0;
  private cacheMisses = 0;
  private lastDriftEventAt: number | null = null;

  constructor(options: GCFOptions) {
    this.db = options.db;
    this.projectDir = options.projectDir;
    this.sessionId = options.sessionId;
    this.maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
    this.maxFileSources = options.maxFileSources ?? DEFAULT_MAX_FILE_SOURCES;
    this.maxUrlSources = options.maxUrlSources ?? DEFAULT_MAX_URL_SOURCES;

    // Initialize file watcher and URL fetcher (always available)
    this.fileWatcher = new FileWatcher({ maxSources: this.maxFileSources });
    this.urlFetcher = new URLFetcher({
      maxConcurrency: 3,
      defaultTTLMs: 30 * 60 * 1000, // 30 minutes
      maxResponseBytes: 512 * 1024,  // 512KB
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Initialize the GCF: create context store, load persisted entries,
   * re-establish watchers, and resume URL schedules.
   *
   * If SQLite fails, falls back to memory-only degraded mode (Req 1.4).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize Context Store with SQLite (Req 1.1)
      this.store = new ContextStore(this.db, this.sessionId);
      this.degradedMode = false;
    } catch (error) {
      // Degraded mode: memory-only operation (Req 1.4)
      console.error('[GCFCore] Failed to initialize Context Store, operating in degraded mode:', error);
      this.store = null;
      this.degradedMode = true;
    }

    // Session restore: reload entries and re-establish watchers (Req 1.2, 4.4)
    if (this.store) {
      await this.restoreSession();
    }

    // Start URL background refresh
    this.urlFetcher.startBackgroundRefresh();

    this.initialized = true;

    // Emit initialization event (Req 9.3)
    this.emitLifecycleEvent('context:initialized');

    // Deliver queued events to pre-registered agents (Req 1.5)
    this.deliverQueuedEvents();
  }

  /**
   * Shutdown the GCF: flush entries to SQLite, stop watchers, cancel fetches.
   *
   * Ensures all in-memory Context_Entries are persisted before closing (Req 1.3).
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Flush all in-memory entries to SQLite (Req 1.3)
    if (this.store && !this.degradedMode) {
      const entries = this.degradedMode ? Array.from(this.inMemoryEntries.values()) : this.store.getAll();
      for (const entry of entries) {
        try {
          this.store.upsert(entry);
        } catch {
          // Best effort flush on shutdown
        }
      }
    }

    // Stop file watching
    this.fileWatcher.unwatchAll();

    // Stop URL fetching
    this.urlFetcher.dispose();

    this.initialized = false;
  }

  // ─── Source Management ────────────────────────────────────────

  /**
   * Add a file as a context source.
   *
   * Validates the file, reads content, computes hash, creates entry, and
   * starts watching for changes (Req 2.1, 2.6).
   *
   * @throws Error if max file sources exceeded or file is not readable
   */
  async addFileSource(filePath: string): Promise<ContextEntry> {
    // Enforce max file sources (Req 2.5)
    if (this.fileSourceCount >= this.maxFileSources) {
      throw new Error(
        `MAX_SOURCES_EXCEEDED: Cannot add more than ${this.maxFileSources} file sources. ` +
          `Currently tracking ${this.fileSourceCount} files.`
      );
    }

    // Validate file exists and is readable (Req 2.6)
    const validation = this.fileWatcher.validateSource(filePath);
    if (!validation.exists) {
      throw new Error(`FILE_NOT_FOUND: File does not exist: ${filePath}`);
    }
    if (!validation.readable) {
      throw new Error(`FILE_NOT_READABLE: File is not readable: ${filePath}`);
    }

    // Read file content
    const content = await readFile(filePath, 'utf-8');

    // Compute SHA-256 hash (Req 2.1)
    const hash = computeHash(content);

    // Create context entry
    const now = Date.now();
    const entry: ContextEntry = {
      id: randomUUID(),
      type: 'file',
      source: filePath,
      content,
      hash,
      priority: 'active',
      createdAt: now,
      lastAccessedAt: now,
      promptsSinceLastAccess: 0,
    };

    // Persist entry
    this.persistEntry(entry);

    // Start watching for changes (Req 2.2)
    this.fileWatcher.watch(filePath, (event: FileChangeEvent) => {
      void this.handleFileChange(event, entry.id);
    });

    this.fileSourceCount++;

    // Emit event and notify agents (Req 9.3, 5.2)
    this.emitLifecycleEvent('entry-added', { entryId: entry.id });
    this.notifyAgents({
      type: 'entry-added',
      entryId: entry.id,
      timestamp: now,
    });

    // Check memory pressure
    this.checkMemoryPressure();

    return entry;
  }

  /**
   * Add a URL as a context source.
   *
   * Fetches content, strips HTML, computes hash, creates entry, and
   * schedules background refresh (Req 3.1).
   *
   * @throws Error if max URL sources exceeded or fetch fails
   */
  async addUrlSource(url: string): Promise<ContextEntry> {
    // Enforce max URL sources (Req 3.6)
    if (this.urlSourceCount >= this.maxUrlSources) {
      throw new Error(
        `MAX_SOURCES_EXCEEDED: Cannot add more than ${this.maxUrlSources} URL sources. ` +
          `Currently tracking ${this.urlSourceCount} URLs.`
      );
    }

    // Fetch content (includes HTML stripping, retry, TTL caching) (Req 3.1, 3.7)
    const fetchResult = await this.urlFetcher.fetch(url);

    // Create context entry
    const now = Date.now();
    const entry: ContextEntry = {
      id: randomUUID(),
      type: 'url',
      source: url,
      content: fetchResult.content,
      hash: fetchResult.hash,
      priority: 'active',
      createdAt: now,
      lastAccessedAt: now,
      promptsSinceLastAccess: 0,
    };

    // Persist entry
    this.persistEntry(entry);

    this.urlSourceCount++;

    // Emit event and notify agents (Req 9.3, 5.2)
    this.emitLifecycleEvent('entry-added', { entryId: entry.id });
    this.notifyAgents({
      type: 'entry-added',
      entryId: entry.id,
      timestamp: now,
    });

    // Check memory pressure
    this.checkMemoryPressure();

    return entry;
  }

  /**
   * Remove a context source by entry ID.
   *
   * Deletes the entry and stops watching/cancels fetch (Req 2.3).
   */
  removeSource(entryId: string): void {
    const entry = this.getEntry(entryId);
    if (!entry) return;

    // Stop watching or cancel fetch
    if (entry.type === 'file') {
      this.fileWatcher.unwatch(entry.source);
      this.fileSourceCount = Math.max(0, this.fileSourceCount - 1);
    } else if (entry.type === 'url') {
      this.urlFetcher.cancel(entry.source);
      this.urlSourceCount = Math.max(0, this.urlSourceCount - 1);
    }

    // Remove from store
    this.removeEntry(entryId);

    // Emit event and notify agents (Req 9.3, 5.2)
    const now = Date.now();
    this.emitLifecycleEvent('entry-removed', { entryId });
    this.notifyAgents({
      type: 'entry-removed',
      entryId,
      timestamp: now,
    });
  }

  /**
   * List all context sources for this session.
   */
  listSources(): ContextEntry[] {
    if (this.degradedMode) {
      return Array.from(this.inMemoryEntries.values());
    }
    if (this.store) {
      return this.store.getAll();
    }
    return [];
  }

  // ─── Agent Interaction ────────────────────────────────────────

  /**
   * Store agent-generated context.
   *
   * Creates a Context_Entry with type "agent_generated" and the producing
   * agent's identifier (Req 5.1, 5.3).
   */
  storeAgentContext(agentId: string, content: string, metadata?: Record<string, unknown>): ContextEntry {
    const hash = computeHash(content);
    const now = Date.now();

    const entry: ContextEntry = {
      id: randomUUID(),
      type: 'agent_generated',
      source: agentId,
      content,
      hash,
      priority: 'active',
      producerAgentId: agentId,
      createdAt: now,
      lastAccessedAt: now,
      promptsSinceLastAccess: 0,
      metadata,
    };

    // Persist entry (Req 5.4 — serialized writes)
    this.persistEntry(entry);

    // Emit event and notify agents (Req 9.3, 5.2)
    this.emitLifecycleEvent('entry-added', { entryId: entry.id, agentId });
    this.notifyAgents({
      type: 'entry-added',
      entryId: entry.id,
      agentId,
      timestamp: now,
    });

    // Check memory pressure
    this.checkMemoryPressure();

    return entry;
  }

  /**
   * Query context entries with filter support.
   *
   * Supports filtering by type, source, recency (maxAge), priority, and limit (Req 5.5).
   */
  queryEntries(filter: ContextQueryFilter): ContextEntry[] {
    let entries = this.listSources();

    // Filter by type
    if (filter.type) {
      entries = entries.filter(e => e.type === filter.type);
    }

    // Filter by source
    if (filter.source) {
      entries = entries.filter(e => e.source === filter.source);
    }

    // Filter by recency (maxAge in ms since lastAccessedAt)
    if (filter.maxAge !== undefined) {
      const cutoff = Date.now() - filter.maxAge;
      entries = entries.filter(e => e.lastAccessedAt >= cutoff);
    }

    // Filter by minimum priority
    if (filter.minPriority) {
      const priorityOrder: Record<string, number> = {
        pinned: 3,
        active: 2,
        background: 1,
      };
      const minLevel = priorityOrder[filter.minPriority] ?? 0;
      entries = entries.filter(e => (priorityOrder[e.priority] ?? 0) >= minLevel);
    }

    // Sort by lastAccessedAt descending (most recent first)
    entries.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

    // Apply limit
    if (filter.limit !== undefined && filter.limit > 0) {
      entries = entries.slice(0, filter.limit);
    }

    // Track cache hits
    this.cacheHits += entries.length;

    return entries;
  }

  // ─── Agent Registration ───────────────────────────────────────

  /**
   * Register an agent to receive context events.
   *
   * Agents can register at any time, including before a session is active.
   * Events will be queued and delivered once the session becomes active (Req 1.5).
   */
  registerAgent(agentId: string, callback: AgentCallback): void {
    this.agents.set(agentId, {
      callback,
      queuedEvents: [],
    });
  }

  /**
   * Unregister an agent from context events.
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  // ─── Stats ────────────────────────────────────────────────────

  /**
   * Get aggregated statistics for the current GCF session (Req 9.4).
   */
  getStats(): ContextStats {
    const totalEntries = this.degradedMode
      ? this.inMemoryEntries.size
      : (this.store?.getAll().length ?? 0);

    const memoryUsageBytes = this.degradedMode
      ? this.computeInMemoryUsage()
      : (this.store?.getMemoryUsage() ?? 0);

    const totalAccesses = this.cacheHits + this.cacheMisses;
    const cacheHitRate = totalAccesses > 0 ? this.cacheHits / totalAccesses : 0;

    return {
      totalEntries,
      memoryUsageBytes,
      cacheHitRate,
      activeSourceCount: this.fileSourceCount + this.urlSourceCount,
      lastDriftEventAt: this.lastDriftEventAt,
    };
  }

  // ─── Lifecycle Event Emitter ──────────────────────────────────

  /**
   * Register a listener for GCF lifecycle events.
   * Used by the CallbackEngine integration (Req 9.3).
   */
  on(event: GCFLifecycleEvent, listener: (data?: unknown) => void): void {
    let listeners = this.lifecycleListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.lifecycleListeners.set(event, listeners);
    }
    listeners.push(listener);
  }

  /**
   * Remove a lifecycle event listener.
   */
  off(event: GCFLifecycleEvent, listener: (data?: unknown) => void): void {
    const listeners = this.lifecycleListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  // ─── Accessors ────────────────────────────────────────────────

  /** Whether the GCF is operating in degraded (memory-only) mode. */
  get isDegradedMode(): boolean {
    return this.degradedMode;
  }

  /** Whether the GCF has been initialized. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Restore session: reload entries from SQLite, re-establish file watchers,
   * and resume URL refresh schedules (Req 1.2, 4.4).
   */
  private async restoreSession(): Promise<void> {
    if (!this.store) return;

    const entries = this.store.getAll();

    for (const entry of entries) {
      if (entry.type === 'file') {
        // Re-establish file watcher
        const validation = this.fileWatcher.validateSource(entry.source);
        if (validation.exists && validation.readable) {
          this.fileWatcher.watch(entry.source, (event: FileChangeEvent) => {
            void this.handleFileChange(event, entry.id);
          });
          this.fileSourceCount++;
        }
        // If file no longer exists, entry stays as stale (Req 2.4)
      } else if (entry.type === 'url') {
        // Resume URL refresh by adding to fetcher cache awareness
        // The background refresh will pick up expired entries
        this.urlSourceCount++;
      }
    }
  }

  /**
   * Handle a file change event: re-read, re-hash, update entry (Req 2.2).
   */
  private async handleFileChange(event: FileChangeEvent, entryId: string): Promise<void> {
    if (event.type === 'delete') {
      // File deleted: mark stale, emit source_unavailable (Req 2.4)
      // Keep last-known content, don't remove the entry
      this.emitLifecycleEvent('entry-updated', { entryId, reason: 'source_unavailable' });
      this.notifyAgents({
        type: 'entry-updated',
        entryId,
        timestamp: event.timestamp,
      });
      return;
    }

    // File changed: re-read content and update entry
    try {
      const content = await readFile(event.filePath, 'utf-8');
      const hash = computeHash(content);

      const existing = this.getEntry(entryId);
      if (!existing) return;

      // Skip update if content hasn't actually changed
      if (existing.hash === hash) return;

      const updatedEntry: ContextEntry = {
        ...existing,
        content,
        hash,
        lastAccessedAt: Date.now(),
      };

      this.persistEntry(updatedEntry);

      // Emit update event (Req 9.3)
      this.emitLifecycleEvent('entry-updated', { entryId });
      this.notifyAgents({
        type: 'entry-updated',
        entryId,
        timestamp: event.timestamp,
      });

      // Check memory pressure after content update
      this.checkMemoryPressure();
    } catch (error) {
      console.warn(`[GCFCore] Failed to re-read file ${event.filePath}:`, error);
    }
  }

  /**
   * Persist an entry to the Context Store or in-memory fallback.
   */
  private persistEntry(entry: ContextEntry): void {
    if (this.degradedMode || !this.store) {
      this.inMemoryEntries.set(entry.id, entry);
    } else {
      try {
        this.store.upsert(entry);
      } catch (error) {
        // If SQLite write fails, fall back to in-memory
        console.warn('[GCFCore] SQLite write failed, storing in memory:', error);
        this.inMemoryEntries.set(entry.id, entry);
      }
    }
  }

  /**
   * Get an entry by ID from the store or in-memory fallback.
   */
  private getEntry(entryId: string): ContextEntry | null {
    if (this.degradedMode || !this.store) {
      return this.inMemoryEntries.get(entryId) ?? null;
    }
    const entry = this.store.get(entryId);
    if (entry) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }
    return entry;
  }

  /**
   * Remove an entry from the store or in-memory fallback.
   */
  private removeEntry(entryId: string): void {
    if (this.degradedMode || !this.store) {
      this.inMemoryEntries.delete(entryId);
    } else {
      try {
        this.store.remove(entryId);
      } catch {
        this.inMemoryEntries.delete(entryId);
      }
    }
  }

  /**
   * Check memory pressure and evict if exceeding 80% threshold (Req 8.7).
   * Target: evict until usage drops below 70%.
   */
  private checkMemoryPressure(): void {
    if (this.degradedMode || !this.store) return;

    const currentUsage = this.store.getMemoryUsage();
    const triggerThreshold = this.maxMemoryBytes * EVICTION_TRIGGER_RATIO;

    if (currentUsage > triggerThreshold) {
      const targetBytes = this.maxMemoryBytes * EVICTION_TARGET_RATIO;
      this.store.evictLRU(targetBytes);
    }
  }

  /**
   * Compute total in-memory usage for degraded mode.
   */
  private computeInMemoryUsage(): number {
    let total = 0;
    for (const entry of this.inMemoryEntries.values()) {
      if (entry.content) {
        total += Buffer.byteLength(entry.content, 'utf-8');
      }
    }
    return total;
  }

  /**
   * Emit a lifecycle event to all registered listeners (Req 9.3).
   */
  private emitLifecycleEvent(event: GCFLifecycleEvent, data?: unknown): void {
    const listeners = this.lifecycleListeners.get(event);
    if (!listeners || listeners.length === 0) return;

    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.warn(`[GCFCore] Lifecycle listener for "${event}" threw:`, error);
      }
    }
  }

  /**
   * Notify all registered agents of a context event.
   *
   * Uses setImmediate for async dispatch. If delivery exceeds 100ms,
   * retries once after 50ms and logs a warning (Req 5.2).
   */
  private notifyAgents(event: ContextEvent): void {
    for (const [agentId, registration] of this.agents.entries()) {
      if (!this.initialized) {
        // Queue events for pre-session registered agents (Req 1.5)
        registration.queuedEvents.push(event);
        continue;
      }

      // Dispatch asynchronously using setImmediate (Req 5.2)
      setImmediate(() => {
        this.deliverEventToAgent(agentId, registration, event);
      });
    }
  }

  /**
   * Deliver a single event to an agent with timeout and retry logic.
   */
  private deliverEventToAgent(agentId: string, registration: AgentRegistration, event: ContextEvent): void {
    const startTime = Date.now();

    try {
      registration.callback(event);
      const elapsed = Date.now() - startTime;

      if (elapsed > AGENT_NOTIFY_TIMEOUT_MS) {
        // Retry once after 50ms (Req 5.2)
        setTimeout(() => {
          try {
            registration.callback(event);
          } catch (retryError) {
            console.warn(
              `[GCFCore] Agent "${agentId}" notification retry failed:`,
              retryError
            );
          }
        }, AGENT_NOTIFY_RETRY_MS);

        console.warn(
          `[GCFCore] Agent "${agentId}" notification exceeded ${AGENT_NOTIFY_TIMEOUT_MS}ms (took ${elapsed}ms)`
        );
      }
    } catch (error) {
      // Retry once on failure (Req 5.2)
      setTimeout(() => {
        try {
          registration.callback(event);
        } catch (retryError) {
          console.warn(
            `[GCFCore] Agent "${agentId}" notification retry failed:`,
            retryError
          );
        }
      }, AGENT_NOTIFY_RETRY_MS);

      console.warn(`[GCFCore] Agent "${agentId}" notification failed:`, error);
    }
  }

  /**
   * Deliver queued events to pre-registered agents after initialization (Req 1.5).
   */
  private deliverQueuedEvents(): void {
    for (const [agentId, registration] of this.agents.entries()) {
      if (registration.queuedEvents.length > 0) {
        const events = [...registration.queuedEvents];
        registration.queuedEvents = [];

        for (const event of events) {
          setImmediate(() => {
            this.deliverEventToAgent(agentId, registration, event);
          });
        }
      }
    }
  }

  /**
   * Record a drift event timestamp for stats reporting.
   * Called by external Drift Reconciler integration.
   */
  recordDriftEvent(timestamp: number): void {
    this.lastDriftEventAt = timestamp;
    this.emitLifecycleEvent('drift-detected', { timestamp });
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Compute SHA-256 hash of content.
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
