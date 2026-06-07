import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * A single entry in the transformation cache.
 */
export interface CacheEntry {
  cacheKey: string;
  resultBlob: string;
  createdAt: number;
  lastAccessed: number;
  sourceChunkIds: string[];
  sizeBytes: number;
}

/**
 * Cache statistics returned by getStats().
 */
export interface CacheStats {
  entries: number;
  sizeBytes: number;
  hitRate: number;
}

/**
 * Content-addressable memoization cache for agent results.
 *
 * Stores transformation results keyed by SHA-256(taskInput + sorted chunkHashes).
 * Supports TTL-based staleness, LRU eviction, and chunk-based invalidation.
 */
export class TransformationCache {
  private hits = 0;
  private misses = 0;

  constructor(
    private db: Database.Database,
    private maxSizeBytes: number = 500 * 1024 * 1024, // 500 MB
    private ttlDays: number = 7
  ) {}

  /**
   * Compute a deterministic cache key from task input and relevant chunk hashes.
   * The key is SHA-256(taskInput + sorted chunkHashes joined by '|').
   */
  computeKey(taskInput: string, relevantChunkHashes: string[]): string {
    const sorted = [...relevantChunkHashes].sort();
    const payload = taskInput + '|' + sorted.join('|');
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Look up a cached result by cache key.
   * Returns null if not found or if the entry is stale (TTL expired).
   * Updates last_accessed on cache hit.
   * If an entry is stale, it is marked as such and null is returned.
   */
  get(cacheKey: string): string | null {
    const row = this.db.prepare(
      'SELECT result_blob, created_at, is_stale FROM transformation_cache WHERE cache_key = ?'
    ).get(cacheKey) as { result_blob: string; created_at: number; is_stale: number } | undefined;

    if (!row) {
      this.misses++;
      return null;
    }

    // Check if entry is already marked stale
    if (row.is_stale === 1) {
      this.misses++;
      return null;
    }

    // Check TTL expiration
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = this.ttlDays * 24 * 60 * 60;
    if (now - row.created_at > ttlSeconds) {
      // Mark as stale
      this.db.prepare(
        'UPDATE transformation_cache SET is_stale = 1 WHERE cache_key = ?'
      ).run(cacheKey);
      this.misses++;
      return null;
    }

    // Cache hit — update last_accessed
    this.db.prepare(
      'UPDATE transformation_cache SET last_accessed = ? WHERE cache_key = ?'
    ).run(now, cacheKey);

    this.hits++;
    return row.result_blob;
  }

  /**
   * Store a transformation result in the cache.
   * Computes size from the result blob and triggers LRU eviction if needed.
   */
  set(cacheKey: string, result: string, sourceChunkIds: string[]): void {
    const now = Math.floor(Date.now() / 1000);
    const sizeBytes = Buffer.byteLength(result, 'utf8');
    const chunkIdsJson = JSON.stringify(sourceChunkIds);

    this.db.prepare(`
      INSERT OR REPLACE INTO transformation_cache
        (cache_key, project_id, result_blob, created_at, last_accessed, source_chunk_ids, size_bytes, is_stale)
      VALUES (?, '', ?, ?, ?, ?, ?, 0)
    `).run(cacheKey, result, now, now, chunkIdsJson, sizeBytes);

    // Evict if over size limit
    this.evictLRU();
  }

  /**
   * Invalidate all cache entries whose source_chunk_ids include the given chunk ID.
   * Marks matching entries as stale (is_stale = 1).
   * Returns the number of entries invalidated.
   */
  invalidateByChunk(chunkId: string): number {
    // Query all non-stale entries and check if their source_chunk_ids contain the chunk
    const rows = this.db.prepare(
      'SELECT cache_key, source_chunk_ids FROM transformation_cache WHERE is_stale = 0'
    ).all() as { cache_key: string; source_chunk_ids: string }[];

    let invalidated = 0;
    const markStale = this.db.prepare(
      'UPDATE transformation_cache SET is_stale = 1 WHERE cache_key = ?'
    );

    for (const row of rows) {
      try {
        const ids: string[] = JSON.parse(row.source_chunk_ids);
        if (ids.includes(chunkId)) {
          markStale.run(row.cache_key);
          invalidated++;
        }
      } catch {
        // If JSON parse fails, mark as stale to be safe
        markStale.run(row.cache_key);
        invalidated++;
      }
    }

    return invalidated;
  }

  /**
   * Evict least-recently-used entries until total cache size is within maxSizeBytes.
   * Deletes entries ordered by last_accessed ascending (oldest first).
   * Returns the number of entries evicted.
   */
  evictLRU(): number {
    const totalRow = this.db.prepare(
      'SELECT COALESCE(SUM(size_bytes), 0) as total FROM transformation_cache'
    ).get() as { total: number };

    let totalSize = totalRow.total;
    if (totalSize <= this.maxSizeBytes) {
      return 0;
    }

    // Get entries ordered by last_accessed ascending (LRU first)
    const entries = this.db.prepare(
      'SELECT cache_key, size_bytes FROM transformation_cache ORDER BY last_accessed ASC'
    ).all() as { cache_key: string; size_bytes: number }[];

    let evicted = 0;
    const deleteStmt = this.db.prepare(
      'DELETE FROM transformation_cache WHERE cache_key = ?'
    );

    for (const entry of entries) {
      if (totalSize <= this.maxSizeBytes) {
        break;
      }
      deleteStmt.run(entry.cache_key);
      totalSize -= entry.size_bytes;
      evicted++;
    }

    return evicted;
  }

  /**
   * Get cache statistics: total entries, total size in bytes, and hit rate.
   */
  getStats(): CacheStats {
    const row = this.db.prepare(
      'SELECT COUNT(*) as entries, COALESCE(SUM(size_bytes), 0) as sizeBytes FROM transformation_cache'
    ).get() as { entries: number; sizeBytes: number };

    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      entries: row.entries,
      sizeBytes: row.sizeBytes,
      hitRate,
    };
  }
}
