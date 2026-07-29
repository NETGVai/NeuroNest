/**
 * Context Store — SQLite persistence layer with lazy loading and LRU eviction.
 *
 * Provides CRUD operations for Context_Entries backed by the gcf_context_entries
 * table. In-memory metadata is always available; content is lazily loaded from
 * SQLite on first access and evicted under memory pressure using LRU ordering.
 *
 * Requirements: 4.1, 4.2, 4.5, 8.1, 8.2, 8.3, 8.5
 */

import type Database from 'better-sqlite3';
import type { ContextEntry } from './types.js';

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/** In-memory representation: metadata is always present; content may be null (evicted). */
interface CachedEntry {
  entry: ContextEntry;
  /** Byte size of content when loaded (0 if evicted). */
  contentSize: number;
  /** Monotonic access counter for LRU ordering. */
  accessOrder: number;
}

// ---------------------------------------------------------------------------
// Context Store
// ---------------------------------------------------------------------------

export class ContextStore {
  private readonly db: Database.Database;
  private readonly sessionId: string;

  /** In-memory index keyed by entry id. Metadata always present; content may be null. */
  private readonly cache = new Map<string, CachedEntry>();

  /** Monotonically increasing counter to track access recency. */
  private accessCounter = 0;

  /** Total bytes currently held in memory (content only). */
  private memoryUsageBytes = 0;

  // Prepared statements (lazy-initialized)
  private stmtUpsert!: Database.Statement;
  private stmtGetById!: Database.Statement;
  private stmtGetAll!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtLoadContent!: Database.Statement;

  constructor(db: Database.Database, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;
    this.prepareStatements();
    this.loadMetadataIndex();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────

  /**
   * Insert or update a context entry. Commits to SQLite immediately
   * and updates the in-memory cache. Target: within 500ms.
   */
  upsert(entry: ContextEntry): void {
    const metadataJson = entry.metadata ? JSON.stringify(entry.metadata) : null;

    this.stmtUpsert.run({
      id: entry.id,
      session_id: this.sessionId,
      type: entry.type,
      source: entry.source,
      content: entry.content,
      hash: entry.hash,
      priority: entry.priority,
      producer_agent_id: entry.producerAgentId ?? null,
      metadata_json: metadataJson,
      created_at: entry.createdAt,
      last_accessed_at: entry.lastAccessedAt,
      prompts_since_access: entry.promptsSinceLastAccess,
    });

    // Update in-memory cache
    const contentSize = entry.content ? Buffer.byteLength(entry.content, 'utf8') : 0;
    const existing = this.cache.get(entry.id);

    // Adjust memory accounting
    if (existing) {
      this.memoryUsageBytes -= existing.contentSize;
    }
    this.memoryUsageBytes += contentSize;

    this.cache.set(entry.id, {
      entry: { ...entry },
      contentSize,
      accessOrder: ++this.accessCounter,
    });
  }

  /**
   * Get a context entry by id. Returns from in-memory cache if available
   * (target <5ms), otherwise loads from SQLite (target <50ms).
   */
  get(id: string): ContextEntry | null {
    const cached = this.cache.get(id);
    if (cached) {
      cached.accessOrder = ++this.accessCounter;
      cached.entry.lastAccessedAt = Date.now();
      return { ...cached.entry };
    }

    // Fallback: load from SQLite (should only happen if entry was created
    // outside this instance or cache was cleared unexpectedly)
    const row = this.stmtGetById.get(id, this.sessionId) as DbRow | undefined;
    if (!row) return null;

    const entry = this.rowToEntry(row);
    const contentSize = entry.content ? Buffer.byteLength(entry.content, 'utf8') : 0;
    this.memoryUsageBytes += contentSize;

    this.cache.set(id, {
      entry: { ...entry },
      contentSize,
      accessOrder: ++this.accessCounter,
    });

    return { ...entry };
  }

  /**
   * Get all context entries for this session. Returns copies from the
   * in-memory cache (metadata always available; content may be null for evicted entries).
   */
  getAll(): ContextEntry[] {
    return Array.from(this.cache.values()).map((cached) => ({ ...cached.entry }));
  }

  /**
   * Remove an entry from both SQLite and in-memory cache.
   */
  remove(id: string): void {
    this.stmtDelete.run(id, this.sessionId);

    const cached = this.cache.get(id);
    if (cached) {
      this.memoryUsageBytes -= cached.contentSize;
      this.cache.delete(id);
    }
  }

  // ─── Lazy Loading ─────────────────────────────────────────────────

  /**
   * Load content for an entry from SQLite. Returns the content string or null
   * if the entry doesn't exist. Updates the in-memory cache with the loaded content.
   */
  loadContent(id: string): string | null {
    const cached = this.cache.get(id);

    // If content is already in memory, return it directly
    if (cached && cached.entry.content !== null) {
      cached.accessOrder = ++this.accessCounter;
      return cached.entry.content;
    }

    // Load content from SQLite
    const row = this.stmtLoadContent.get(id, this.sessionId) as { content: string | null } | undefined;
    if (!row || row.content === null) return null;

    const content = row.content;
    const contentSize = Buffer.byteLength(content, 'utf8');

    if (cached) {
      // Update existing cache entry with loaded content
      this.memoryUsageBytes -= cached.contentSize;
      cached.entry.content = content;
      cached.contentSize = contentSize;
      cached.accessOrder = ++this.accessCounter;
      this.memoryUsageBytes += contentSize;
    }

    return content;
  }

  /**
   * Evict content from in-memory cache for a specific entry.
   * Metadata remains accessible; content is set to null.
   */
  evictContent(id: string): void {
    const cached = this.cache.get(id);
    if (!cached) return;

    this.memoryUsageBytes -= cached.contentSize;
    cached.entry.content = null;
    cached.contentSize = 0;
  }

  // ─── Memory Management ────────────────────────────────────────────

  /**
   * Returns the current total bytes of content held in memory.
   */
  getMemoryUsage(): number {
    return this.memoryUsageBytes;
  }

  /**
   * Evict content from the least-recently-used entries until memory usage
   * drops to or below the target byte threshold.
   */
  evictLRU(targetBytes: number): void {
    if (this.memoryUsageBytes <= targetBytes) return;

    // Sort entries by access order (ascending = least recently used first)
    const entries = Array.from(this.cache.entries())
      .filter(([, cached]) => cached.contentSize > 0)
      .sort((a, b) => a[1].accessOrder - b[1].accessOrder);

    for (const [id] of entries) {
      if (this.memoryUsageBytes <= targetBytes) break;
      this.evictContent(id);
    }
  }

  // ─── Metadata ─────────────────────────────────────────────────────

  /**
   * Returns metadata for an entry from the in-memory index.
   * Always available regardless of whether content is loaded.
   */
  getMetadata(id: string): Pick<ContextEntry, 'hash' | 'priority' | 'createdAt' | 'lastAccessedAt'> | null {
    const cached = this.cache.get(id);
    if (!cached) return null;

    return {
      hash: cached.entry.hash,
      priority: cached.entry.priority,
      createdAt: cached.entry.createdAt,
      lastAccessedAt: cached.entry.lastAccessedAt,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  private prepareStatements(): void {
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO gcf_context_entries (
        id, session_id, type, source, content, hash, priority,
        producer_agent_id, metadata_json, created_at, last_accessed_at, prompts_since_access
      ) VALUES (
        @id, @session_id, @type, @source, @content, @hash, @priority,
        @producer_agent_id, @metadata_json, @created_at, @last_accessed_at, @prompts_since_access
      ) ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        hash = excluded.hash,
        priority = excluded.priority,
        producer_agent_id = excluded.producer_agent_id,
        metadata_json = excluded.metadata_json,
        last_accessed_at = excluded.last_accessed_at,
        prompts_since_access = excluded.prompts_since_access
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM gcf_context_entries WHERE id = ? AND session_id = ?
    `);

    this.stmtGetAll = this.db.prepare(`
      SELECT * FROM gcf_context_entries WHERE session_id = ?
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM gcf_context_entries WHERE id = ? AND session_id = ?
    `);

    this.stmtLoadContent = this.db.prepare(`
      SELECT content FROM gcf_context_entries WHERE id = ? AND session_id = ?
    `);
  }

  /**
   * Loads all entries from SQLite for this session into the metadata index.
   * Content is loaded lazily — only metadata is retained in memory initially (Req 8.1).
   */
  private loadMetadataIndex(): void {
    const rows = this.stmtGetAll.all(this.sessionId) as DbRow[];

    for (const row of rows) {
      const entry = this.rowToEntry(row);
      // Lazy loading: store metadata only, set content to null
      entry.content = null;

      this.cache.set(entry.id, {
        entry,
        contentSize: 0,
        accessOrder: ++this.accessCounter,
      });
    }
  }

  /** Convert a raw database row to a ContextEntry. */
  private rowToEntry(row: DbRow): ContextEntry {
    return {
      id: row.id,
      type: row.type as ContextEntry['type'],
      source: row.source,
      content: row.content,
      hash: row.hash,
      priority: row.priority as ContextEntry['priority'],
      producerAgentId: row.producer_agent_id ?? undefined,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      promptsSinceLastAccess: row.prompts_since_access,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Database Row Type
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  session_id: string;
  type: string;
  source: string;
  content: string | null;
  hash: string;
  priority: string;
  producer_agent_id: string | null;
  status: string;
  metadata_json: string | null;
  created_at: number;
  last_accessed_at: number;
  prompts_since_access: number;
}
