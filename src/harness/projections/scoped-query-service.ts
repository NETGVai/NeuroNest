/**
 * ScopedQueryService — Bounded, cancellable, scope-aware query with filters.
 *
 * Provides:
 * - query: Bounded search with scope filtering (user/workspace/project/session).
 * - queryWithFilters: Lineage, relationship, range, event type, and tag filters.
 * - Respects configured query limits from operational bounds.
 *
 * Requirements: 28.2–28.3, 28.10
 */

import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

export interface QueryParams {
  /** Search text for full-text matching */
  searchText: string;
  /** Session scope filter */
  sessionId?: string;
  /** Branch filter */
  branchId?: string;
  /** Scope filtering */
  scope?: ScopeFilter;
  /** Maximum number of results to return */
  limit?: number;
  /** Maximum snippet bytes per result */
  maxSnippetBytes?: number;
  /** Cancellation signal */
  signal?: AbortSignal;
}

export interface ScopeFilter {
  userId?: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
}

export interface FilteredQueryParams extends QueryParams {
  /** Lineage filter: only events in this lineage chain */
  lineageSessionId?: string;
  /** Relationship filter: events related to this entity */
  relatedEntityId?: string;
  /** Sequence range filter */
  fromSequence?: number;
  toSequence?: number;
  /** Event type filter */
  eventTypes?: string[];
  /** Tag filter */
  tags?: string[];
  /** Time range filter */
  fromTime?: string;
  toTime?: string;
}

export interface QueryResult {
  indexId: string;
  sessionId: string;
  entityId: string;
  entityKind: string;
  content: string;
  snippet: string;
  metadata: Record<string, unknown>;
  sourceSequence: number;
  score: number;
}

export interface ScopedQueryServiceConfig {
  /** Default max results per query */
  defaultLimit: number;
  /** Maximum allowed limit (hard ceiling) */
  maxLimit: number;
  /** Default maximum snippet bytes */
  defaultMaxSnippetBytes: number;
  /** Maximum scan time range in milliseconds */
  maxScanTimeRangeMs: number;
}

// ─── ScopedQueryService ─────────────────────────────────────────

export class ScopedQueryService {
  private readonly db: Database.Database;
  private readonly config: ScopedQueryServiceConfig;

  constructor(db: Database.Database, config: ScopedQueryServiceConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Bounded, cancellable search with scope filtering.
   *
   * Requirements: 28.2
   */
  query(params: QueryParams): QueryResult[] {
    if (params.signal?.aborted) {
      throw new QueryCancelledError('Query cancelled before execution');
    }

    const limit = Math.min(
      params.limit ?? this.config.defaultLimit,
      this.config.maxLimit
    );
    const maxSnippetBytes = params.maxSnippetBytes ?? this.config.defaultMaxSnippetBytes;

    // Build the query with scope filtering
    let sql = `
      SELECT indexId, sessionId, entityId, entityKind, content, metadata, sourceSequence
      FROM harness_projection_indexes
      WHERE indexKind = 'fulltext'
    `;
    const bindings: unknown[] = [];

    if (params.sessionId) {
      sql += ` AND sessionId = ?`;
      bindings.push(params.sessionId);
    }

    if (params.searchText) {
      sql += ` AND content LIKE ?`;
      bindings.push(`%${params.searchText}%`);
    }

    // Apply scope filters via metadata JSON
    if (params.scope) {
      if (params.scope.userId) {
        sql += ` AND json_extract(metadata, '$.userId') = ?`;
        bindings.push(params.scope.userId);
      }
      if (params.scope.workspaceId) {
        sql += ` AND json_extract(metadata, '$.workspaceId') = ?`;
        bindings.push(params.scope.workspaceId);
      }
      if (params.scope.projectId) {
        sql += ` AND json_extract(metadata, '$.projectId') = ?`;
        bindings.push(params.scope.projectId);
      }
      if (params.scope.sessionId) {
        sql += ` AND sessionId = ?`;
        bindings.push(params.scope.sessionId);
      }
    }

    if (params.branchId) {
      sql += ` AND json_extract(metadata, '$.branchId') = ?`;
      bindings.push(params.branchId);
    }

    sql += ` ORDER BY sourceSequence DESC LIMIT ?`;
    bindings.push(limit);

    if (params.signal?.aborted) {
      throw new QueryCancelledError('Query cancelled during preparation');
    }

    const rows = this.db.prepare(sql).all(...bindings) as Array<{
      indexId: string;
      sessionId: string;
      entityId: string;
      entityKind: string;
      content: string;
      metadata: string;
      sourceSequence: number;
    }>;

    return rows.map((row, idx) => ({
      indexId: row.indexId,
      sessionId: row.sessionId,
      entityId: row.entityId,
      entityKind: row.entityKind,
      content: row.content,
      snippet: this.truncateSnippet(row.content, params.searchText, maxSnippetBytes),
      metadata: JSON.parse(row.metadata),
      sourceSequence: row.sourceSequence,
      score: rows.length - idx, // Simple relevance score based on recency
    }));
  }

  /**
   * Query with lineage, relationship, range, event type, and tag filters.
   *
   * Requirements: 28.3
   */
  queryWithFilters(params: FilteredQueryParams): QueryResult[] {
    if (params.signal?.aborted) {
      throw new QueryCancelledError('Query cancelled before execution');
    }

    const limit = Math.min(
      params.limit ?? this.config.defaultLimit,
      this.config.maxLimit
    );
    const maxSnippetBytes = params.maxSnippetBytes ?? this.config.defaultMaxSnippetBytes;

    let sql = `
      SELECT i.indexId, i.sessionId, i.entityId, i.entityKind, i.content, i.metadata, i.sourceSequence
      FROM harness_projection_indexes i
      WHERE i.indexKind = 'fulltext'
    `;
    const bindings: unknown[] = [];

    // Session filter
    if (params.sessionId) {
      sql += ` AND i.sessionId = ?`;
      bindings.push(params.sessionId);
    }

    // Full-text search
    if (params.searchText) {
      sql += ` AND i.content LIKE ?`;
      bindings.push(`%${params.searchText}%`);
    }

    // Lineage filter: match events from the lineage session
    if (params.lineageSessionId) {
      sql += ` AND i.sessionId = ?`;
      bindings.push(params.lineageSessionId);
    }

    // Relationship filter
    if (params.relatedEntityId) {
      sql += ` AND (i.entityId = ? OR json_extract(i.metadata, '$.relatedTo') = ?)`;
      bindings.push(params.relatedEntityId, params.relatedEntityId);
    }

    // Sequence range filter
    if (params.fromSequence !== undefined) {
      sql += ` AND i.sourceSequence >= ?`;
      bindings.push(params.fromSequence);
    }
    if (params.toSequence !== undefined) {
      sql += ` AND i.sourceSequence <= ?`;
      bindings.push(params.toSequence);
    }

    // Event type filter
    if (params.eventTypes && params.eventTypes.length > 0) {
      const placeholders = params.eventTypes.map(() => '?').join(',');
      sql += ` AND i.entityKind IN (${placeholders})`;
      bindings.push(...params.eventTypes);
    }

    // Tag filter via metadata
    if (params.tags && params.tags.length > 0) {
      for (const tag of params.tags) {
        sql += ` AND i.metadata LIKE ?`;
        bindings.push(`%${tag}%`);
      }
    }

    // Time range filter
    if (params.fromTime) {
      sql += ` AND json_extract(i.metadata, '$.occurredAt') >= ?`;
      bindings.push(params.fromTime);
    }
    if (params.toTime) {
      sql += ` AND json_extract(i.metadata, '$.occurredAt') <= ?`;
      bindings.push(params.toTime);
    }

    // Branch filter
    if (params.branchId) {
      sql += ` AND json_extract(i.metadata, '$.branchId') = ?`;
      bindings.push(params.branchId);
    }

    // Scope filters
    if (params.scope) {
      if (params.scope.userId) {
        sql += ` AND json_extract(i.metadata, '$.userId') = ?`;
        bindings.push(params.scope.userId);
      }
      if (params.scope.workspaceId) {
        sql += ` AND json_extract(i.metadata, '$.workspaceId') = ?`;
        bindings.push(params.scope.workspaceId);
      }
      if (params.scope.projectId) {
        sql += ` AND json_extract(i.metadata, '$.projectId') = ?`;
        bindings.push(params.scope.projectId);
      }
    }

    sql += ` ORDER BY i.sourceSequence DESC LIMIT ?`;
    bindings.push(limit);

    if (params.signal?.aborted) {
      throw new QueryCancelledError('Query cancelled during preparation');
    }

    const rows = this.db.prepare(sql).all(...bindings) as Array<{
      indexId: string;
      sessionId: string;
      entityId: string;
      entityKind: string;
      content: string;
      metadata: string;
      sourceSequence: number;
    }>;

    return rows.map((row, idx) => ({
      indexId: row.indexId,
      sessionId: row.sessionId,
      entityId: row.entityId,
      entityKind: row.entityKind,
      content: row.content,
      snippet: this.truncateSnippet(row.content, params.searchText, maxSnippetBytes),
      metadata: JSON.parse(row.metadata),
      sourceSequence: row.sourceSequence,
      score: rows.length - idx,
    }));
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private truncateSnippet(content: string, searchText: string, maxBytes: number): string {
    if (content.length <= maxBytes) return content;

    // Try to center the snippet around the search term
    if (searchText) {
      const idx = content.toLowerCase().indexOf(searchText.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - Math.floor(maxBytes / 2));
        const end = Math.min(content.length, start + maxBytes);
        const snippet = content.slice(start, end);
        return (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : '');
      }
    }

    return content.slice(0, maxBytes) + '...';
  }
}

// ─── Errors ─────────────────────────────────────────────────────

export class QueryCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryCancelledError';
  }
}
