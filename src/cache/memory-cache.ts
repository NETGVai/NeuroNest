import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { agentSkillsErrorHandler, ErrorContext } from '../agent-skills/error-handler.js';

/**
 * Memory Cache system replacing Redis functionality
 * 
 * Provides in-memory caching with TTL expiration, LRU eviction, and optional
 * SQLite backing for persistence. Maintains cache performance characteristics
 * similar to Redis while eliminating external dependencies.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

export interface CacheEntry {
  key: string;
  value: any;
  ttl?: number; // Time to live in milliseconds
  createdAt: number;
  accessedAt: number;
  expiresAt?: number;
  size: number; // Approximate size in bytes for memory management
}

export interface CacheStats {
  totalEntries: number;
  memoryUsage: number; // Approximate memory usage in bytes
  hitRate: number;
  missRate: number;
  evictionCount: number;
  expiredCount: number;
  totalHits: number;
  totalMisses: number;
  totalSets: number;
  totalDeletes: number;
  averageAccessTime: number;
}

export interface MemoryCacheOptions {
  database?: Database.Database;
  maxMemoryMB?: number; // Maximum memory usage in MB
  maxEntries?: number; // Maximum number of entries
  defaultTTL?: number; // Default TTL in milliseconds
  enablePersistence?: boolean; // Enable SQLite backing
  cleanupInterval?: number; // Cleanup interval in milliseconds
  enableStats?: boolean; // Enable statistics collection
  compressionThreshold?: number; // Compress values larger than this (bytes)
}

/**
 * LRU Node for doubly-linked list implementation
 */
class LRUNode {
  constructor(
    public key: string,
    public entry: CacheEntry,
    public prev: LRUNode | null = null,
    public next: LRUNode | null = null
  ) {}
}

/**
 * In-memory cache with TTL expiration and LRU eviction
 * Provides Redis-like functionality with SQLite backing for persistence
 */
export class MemoryCache extends EventEmitter {
  private cache = new Map<string, LRUNode>();
  private db?: Database.Database;
  private options: Required<Omit<MemoryCacheOptions, 'database'>> & { database?: Database.Database };
  
  // LRU implementation using doubly-linked list
  private head: LRUNode;
  private tail: LRUNode;
  
  // Statistics
  private stats: CacheStats = {
    totalEntries: 0,
    memoryUsage: 0,
    hitRate: 0,
    missRate: 0,
    evictionCount: 0,
    expiredCount: 0,
    totalHits: 0,
    totalMisses: 0,
    totalSets: 0,
    totalDeletes: 0,
    averageAccessTime: 0
  };
  
  // Prepared statements for SQLite operations
  private insertStmt?: Database.Statement;
  private selectStmt?: Database.Statement;
  private updateStmt?: Database.Statement;
  private deleteStmt?: Database.Statement;
  private cleanupStmt?: Database.Statement;
  
  // Cleanup timer
  private cleanupTimer?: NodeJS.Timeout;
  
  constructor(options: MemoryCacheOptions = {}) {
    super();
    
    this.options = {
      database: options.database,
      maxMemoryMB: options.maxMemoryMB || 100,
      maxEntries: options.maxEntries || 10000,
      defaultTTL: options.defaultTTL || 3600000, // 1 hour
      enablePersistence: options.enablePersistence ?? true,
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      enableStats: options.enableStats ?? true,
      compressionThreshold: options.compressionThreshold || 1024 // 1KB
    };
    
    // Initialize LRU list with dummy head and tail
    this.head = new LRUNode('__head__', {} as CacheEntry);
    this.tail = new LRUNode('__tail__', {} as CacheEntry);
    this.head.next = this.tail;
    this.tail.prev = this.head;
    
    if (options.database && this.options.enablePersistence) {
      this.db = options.database;
      this.initializePersistence();
      this.loadFromPersistence();
    }
    
    this.startCleanup();
    
    logger.info('Memory Cache initialized', {
      maxMemoryMB: this.options.maxMemoryMB,
      maxEntries: this.options.maxEntries,
      defaultTTL: this.options.defaultTTL,
      enablePersistence: this.options.enablePersistence
    });
  }

  /**
   * Set a value in the cache with comprehensive error handling
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const startTime = Date.now();
    const context: ErrorContext = {
      component: 'memory-cache',
      operation: 'set',
      metadata: { key, hasTTL: ttl !== undefined },
      timestamp: new Date()
    };
    
    await agentSkillsErrorHandler.executeWithFallback(
      // Primary operation: full cache set with persistence
      async () => {
        const now = Date.now();
        const effectiveTTL = ttl !== undefined ? ttl : this.options.defaultTTL;
        const expiresAt = effectiveTTL > 0 ? now + effectiveTTL : undefined;
        const serializedValue = this.serialize(value);
        const size = this.calculateSize(key, serializedValue);
        
        const entry: CacheEntry = {
          key,
          value: serializedValue,
          ttl: effectiveTTL,
          createdAt: now,
          accessedAt: now,
          expiresAt,
          size
        };
        
        // Check if key already exists
        const existingNode = this.cache.get(key);
        if (existingNode) {
          // Update existing entry
          this.stats.memoryUsage -= existingNode.entry.size;
          existingNode.entry = entry;
          this.moveToHead(existingNode);
        } else {
          // Create new entry
          const newNode = new LRUNode(key, entry);
          this.cache.set(key, newNode);
          this.addToHead(newNode);
          this.stats.totalEntries++;
        }
        
        this.stats.memoryUsage += size;
        this.stats.totalSets++;
        
        // Enforce memory and entry limits
        await this.enforceMemoryLimits();
        
        // Persist to SQLite if enabled
        if (this.db && this.options.enablePersistence) {
          await this.persistEntry(entry);
        }
        
        this.emit('set', { key, size, ttl: effectiveTTL });
        
        if (this.options.enableStats) {
          this.updateAverageAccessTime(Date.now() - startTime);
        }
      },
      // Fallback operation: memory-only (degraded mode)
      async () => {
        logger.warn('Cache operating in degraded mode (memory-only)', { key });
        
        const now = Date.now();
        const effectiveTTL = ttl !== undefined ? ttl : this.options.defaultTTL;
        const expiresAt = effectiveTTL > 0 ? now + effectiveTTL : undefined;
        const serializedValue = this.serialize(value);
        const size = this.calculateSize(key, serializedValue);
        
        const entry: CacheEntry = {
          key,
          value: serializedValue,
          ttl: effectiveTTL,
          createdAt: now,
          accessedAt: now,
          expiresAt,
          size
        };
        
        // Check if key already exists
        const existingNode = this.cache.get(key);
        if (existingNode) {
          // Update existing entry
          this.stats.memoryUsage -= existingNode.entry.size;
          existingNode.entry = entry;
          this.moveToHead(existingNode);
        } else {
          // Create new entry
          const newNode = new LRUNode(key, entry);
          this.cache.set(key, newNode);
          this.addToHead(newNode);
          this.stats.totalEntries++;
        }
        
        this.stats.memoryUsage += size;
        this.stats.totalSets++;
        
        // Enforce memory and entry limits
        await this.enforceMemoryLimits();
        
        this.emit('set', { key, size, ttl: effectiveTTL });
        
        if (this.options.enableStats) {
          this.updateAverageAccessTime(Date.now() - startTime);
        }
      },
      context,
      {
        maxRetries: 3,
        baseDelay: 200,
        retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
      }
    );
  }

  /**
   * Get a value from the cache with comprehensive error handling
   */
  async get(key: string): Promise<any> {
    const startTime = Date.now();
    const context: ErrorContext = {
      component: 'memory-cache',
      operation: 'get',
      metadata: { key },
      timestamp: new Date()
    };
    
    try {
      const node = this.cache.get(key);
      
      if (!node) {
        this.stats.totalMisses++;
        this.updateHitRates();
        
        // Try to load from persistence if enabled
        if (this.db && this.options.enablePersistence) {
          try {
            const persistedEntry = await agentSkillsErrorHandler.executeWithRetry(
              () => this.loadFromPersistenceByKey(key),
              context,
              {
                maxRetries: 2,
                baseDelay: 100,
                retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED']
              }
            );
            
            if (persistedEntry && !this.isExpired(persistedEntry)) {
              // Restore to memory cache
              const newNode = new LRUNode(key, persistedEntry);
              this.cache.set(key, newNode);
              this.addToHead(newNode);
              this.stats.totalEntries++;
              this.stats.memoryUsage += persistedEntry.size;
              
              this.stats.totalHits++;
              this.updateHitRates();
              this.emit('hit', { key, source: 'persistence' });
              
              if (this.options.enableStats) {
                this.updateAverageAccessTime(Date.now() - startTime);
              }
              
              return this.deserialize(persistedEntry.value);
            }
          } catch (persistenceError) {
            // Log but don't fail - continue with cache miss
            logger.debug('Failed to load from persistence', {
              key,
              error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
            });
          }
        }
        
        this.emit('miss', { key });
        return null;
      }
      
      // Check if entry is expired
      if (this.isExpired(node.entry)) {
        this.removeNode(node);
        this.cache.delete(key);
        this.stats.totalEntries--;
        this.stats.memoryUsage -= node.entry.size;
        this.stats.expiredCount++;
        this.stats.totalMisses++;
        this.updateHitRates();
        
        this.emit('expired', { key });
        return null;
      }
      
      // Update access time and move to head (LRU)
      node.entry.accessedAt = Date.now();
      this.moveToHead(node);
      
      this.stats.totalHits++;
      this.updateHitRates();
      this.emit('hit', { key, source: 'memory' });
      
      if (this.options.enableStats) {
        this.updateAverageAccessTime(Date.now() - startTime);
      }
      
      return this.deserialize(node.entry.value);
      
    } catch (error) {
      logger.error('Failed to get cache entry', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // For cache get operations, we can return null instead of throwing
      // This provides graceful degradation
      this.stats.totalMisses++;
      this.updateHitRates();
      this.emit('miss', { key });
      return null;
    }
  }

  /**
   * Delete a value from the cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      const node = this.cache.get(key);
      
      if (!node) {
        return false;
      }
      
      this.removeNode(node);
      this.cache.delete(key);
      this.stats.totalEntries--;
      this.stats.memoryUsage -= node.entry.size;
      this.stats.totalDeletes++;
      
      // Remove from persistence if enabled
      if (this.db && this.options.enablePersistence && this.deleteStmt) {
        this.deleteStmt.run(key);
      }
      
      this.emit('delete', { key });
      return true;
      
    } catch (error) {
      logger.error('Failed to delete cache entry', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Set with expiration time in seconds
   */
  async setex(key: string, seconds: number, value: any): Promise<void> {
    return this.set(key, value, seconds * 1000);
  }

  /**
   * Set expiration for an existing key
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }
    
    const now = Date.now();
    node.entry.expiresAt = now + (seconds * 1000);
    node.entry.ttl = seconds * 1000;
    
    // Update in persistence if enabled
    if (this.db && this.options.enablePersistence) {
      await this.persistEntry(node.entry);
    }
    
    return true;
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }
    
    if (this.isExpired(node.entry)) {
      await this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get multiple values at once
   */
  async mget(keys: string[]): Promise<any[]> {
    const results: any[] = [];
    
    for (const key of keys) {
      const value = await this.get(key);
      results.push(value);
    }
    
    return results;
  }

  /**
   * Set multiple key-value pairs at once
   */
  async mset(keyValues: Record<string, any>): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const [key, value] of Object.entries(keyValues)) {
      promises.push(this.set(key, value));
    }
    
    await Promise.all(promises);
  }

  /**
   * Clear all entries from the cache
   */
  async clear(): Promise<void> {
    try {
      this.cache.clear();
      
      // Reset LRU list
      this.head.next = this.tail;
      this.tail.prev = this.head;
      
      // Reset stats
      this.stats.totalEntries = 0;
      this.stats.memoryUsage = 0;
      
      // Clear persistence if enabled
      if (this.db && this.options.enablePersistence && this.cleanupStmt) {
        this.cleanupStmt.run();
      }
      
      this.emit('clear');
      logger.info('Cache cleared');
      
    } catch (error) {
      logger.error('Failed to clear cache', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get the number of entries in the cache
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Initialize SQLite persistence
   */
  private initializePersistence(): void {
    if (!this.db) return;
    
    try {
      this.insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO cache_entries (key, value, expires_at, created_at, accessed_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      this.selectStmt = this.db.prepare(`
        SELECT key, value, expires_at, created_at, accessed_at
        FROM cache_entries
        WHERE key = ?
      `);
      
      this.updateStmt = this.db.prepare(`
        UPDATE cache_entries
        SET accessed_at = ?
        WHERE key = ?
      `);
      
      this.deleteStmt = this.db.prepare(`
        DELETE FROM cache_entries
        WHERE key = ?
      `);
      
      this.cleanupStmt = this.db.prepare(`
        DELETE FROM cache_entries
        WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
      `);
      
      logger.debug('Cache persistence initialized');
      
    } catch (error) {
      logger.error('Failed to initialize cache persistence', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Load all entries from SQLite persistence
   */
  private async loadFromPersistence(): Promise<void> {
    if (!this.db) return;
    
    try {
      const rows = this.db.prepare(`
        SELECT key, value, expires_at, created_at, accessed_at
        FROM cache_entries
      `).all() as any[];
      
      let loadedCount = 0;
      
      for (const row of rows) {
        const entry: CacheEntry = {
          key: row.key,
          value: row.value,
          createdAt: new Date(row.created_at).getTime(),
          accessedAt: new Date(row.accessed_at).getTime(),
          expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
          size: this.calculateSize(row.key, row.value)
        };
        
        if (entry.expiresAt) {
          entry.ttl = entry.expiresAt - entry.createdAt;
        }
        
        // Skip expired entries
        if (this.isExpired(entry)) {
          continue;
        }
        
        const node = new LRUNode(entry.key, entry);
        this.cache.set(entry.key, node);
        this.addToHead(node);
        this.stats.totalEntries++;
        this.stats.memoryUsage += entry.size;
        loadedCount++;
      }
      
      logger.info('Loaded cache entries from persistence', { count: loadedCount });
      
    } catch (error) {
      logger.error('Failed to load cache from persistence', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Load a specific entry from SQLite persistence
   */
  private async loadFromPersistenceByKey(key: string): Promise<CacheEntry | null> {
    if (!this.db || !this.selectStmt) return null;
    
    try {
      const row = this.selectStmt.get(key) as any;
      if (!row) return null;
      
      const entry: CacheEntry = {
        key: row.key,
        value: row.value,
        createdAt: new Date(row.created_at).getTime(),
        accessedAt: new Date(row.accessed_at).getTime(),
        expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : undefined,
        size: this.calculateSize(row.key, row.value)
      };
      
      if (entry.expiresAt) {
        entry.ttl = entry.expiresAt - entry.createdAt;
      }
      
      return entry;
      
    } catch (error) {
      logger.error('Failed to load cache entry from persistence', {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Persist an entry to SQLite with error handling
   */
  private async persistEntry(entry: CacheEntry): Promise<void> {
    if (!this.db || !this.insertStmt) return;
    
    const context: ErrorContext = {
      component: 'memory-cache',
      operation: 'persistEntry',
      metadata: { key: entry.key },
      timestamp: new Date()
    };

    await agentSkillsErrorHandler.executeWithRetry(async () => {
      this.insertStmt!.run(
        entry.key,
        entry.value,
        entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
        new Date(entry.createdAt).toISOString(),
        new Date(entry.accessedAt).toISOString()
      );
    }, context, {
      maxRetries: 3,
      baseDelay: 100,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }
  /**
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry): boolean {
    if (!entry.expiresAt) return false;
    return Date.now() > entry.expiresAt;
  }

  /**
   * Serialize a value for storage
   */
  private serialize(value: any): string {
    try {
      return JSON.stringify(value);
    } catch (error) {
      logger.warn('Failed to serialize cache value, storing as string', {
        error: error instanceof Error ? error.message : String(error)
      });
      return String(value);
    }
  }

  /**
   * Deserialize a stored value
   */
  private deserialize(value: string): any {
    try {
      return JSON.parse(value);
    } catch (error) {
      // If JSON parsing fails, return as string
      return value;
    }
  }

  /**
   * Calculate approximate size of a cache entry
   */
  private calculateSize(key: string, value: string): number {
    // Rough estimation: key + value + overhead
    return (key.length + value.length) * 2 + 100; // 2 bytes per char + 100 bytes overhead
  }

  /**
   * Add node to head of LRU list (most recently used)
   */
  private addToHead(node: LRUNode): void {
    node.prev = this.head;
    node.next = this.head.next;
    
    if (this.head.next) {
      this.head.next.prev = node;
    }
    this.head.next = node;
  }

  /**
   * Remove a node from the LRU list
   */
  private removeNode(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
  }

  /**
   * Move node to head of LRU list
   */
  private moveToHead(node: LRUNode): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  /**
   * Remove tail node (least recently used)
   */
  private removeTail(): LRUNode | null {
    const lastNode = this.tail.prev;
    if (lastNode && lastNode !== this.head) {
      this.removeNode(lastNode);
      return lastNode;
    }
    return null;
  }

  /**
   * Enforce memory and entry limits using LRU eviction
   */
  private async enforceMemoryLimits(): Promise<void> {
    const maxMemoryBytes = this.options.maxMemoryMB * 1024 * 1024;
    
    // Evict entries if over memory limit
    while (this.stats.memoryUsage > maxMemoryBytes && this.cache.size > 0) {
      const evictedNode = this.removeTail();
      if (!evictedNode) break;
      
      this.cache.delete(evictedNode.key);
      this.stats.totalEntries--;
      this.stats.memoryUsage -= evictedNode.entry.size;
      this.stats.evictionCount++;
      
      // Remove from persistence if enabled
      if (this.db && this.options.enablePersistence && this.deleteStmt) {
        this.deleteStmt.run(evictedNode.key);
      }
      
      this.emit('evicted', { 
        key: evictedNode.key, 
        reason: 'memory_limit',
        size: evictedNode.entry.size 
      });
    }
    
    // Evict entries if over entry limit
    while (this.cache.size > this.options.maxEntries) {
      const evictedNode = this.removeTail();
      if (!evictedNode) break;
      
      this.cache.delete(evictedNode.key);
      this.stats.totalEntries--;
      this.stats.memoryUsage -= evictedNode.entry.size;
      this.stats.evictionCount++;
      
      // Remove from persistence if enabled
      if (this.db && this.options.enablePersistence && this.deleteStmt) {
        this.deleteStmt.run(evictedNode.key);
      }
      
      this.emit('evicted', { 
        key: evictedNode.key, 
        reason: 'entry_limit',
        size: evictedNode.entry.size 
      });
    }
  }

  /**
   * Update hit/miss rates
   */
  private updateHitRates(): void {
    const total = this.stats.totalHits + this.stats.totalMisses;
    if (total > 0) {
      this.stats.hitRate = this.stats.totalHits / total;
      this.stats.missRate = this.stats.totalMisses / total;
    }
  }

  /**
   * Update average access time
   */
  private updateAverageAccessTime(accessTime: number): void {
    const totalOperations = this.stats.totalHits + this.stats.totalMisses + this.stats.totalSets;
    if (totalOperations === 1) {
      this.stats.averageAccessTime = accessTime;
    } else {
      // Running average
      this.stats.averageAccessTime = 
        (this.stats.averageAccessTime * (totalOperations - 1) + accessTime) / totalOperations;
    }
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.options.cleanupInterval);
  }

  /**
   * Clean up expired entries
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    // Find expired entries
    for (const [key, node] of this.cache.entries()) {
      if (this.isExpired(node.entry)) {
        expiredKeys.push(key);
      }
    }
    
    // Remove expired entries
    for (const key of expiredKeys) {
      const node = this.cache.get(key);
      if (node) {
        this.removeNode(node);
        this.cache.delete(key);
        this.stats.totalEntries--;
        this.stats.memoryUsage -= node.entry.size;
        this.stats.expiredCount++;
        
        this.emit('expired', { key });
      }
    }
    
    // Clean up expired entries from persistence
    if (this.db && this.options.enablePersistence && this.cleanupStmt && expiredKeys.length > 0) {
      try {
        this.cleanupStmt.run();
      } catch (error) {
        logger.error('Failed to cleanup expired entries from persistence', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    if (expiredKeys.length > 0) {
      logger.debug('Cleaned up expired cache entries', { count: expiredKeys.length });
    }
  }

  /**
   * Get memory usage information
   */
  getMemoryUsage(): {
    usedMB: number;
    maxMB: number;
    utilizationPercent: number;
    entryCount: number;
    maxEntries: number;
  } {
    const usedMB = this.stats.memoryUsage / (1024 * 1024);
    const utilizationPercent = (usedMB / this.options.maxMemoryMB) * 100;
    
    return {
      usedMB: Math.round(usedMB * 100) / 100,
      maxMB: this.options.maxMemoryMB,
      utilizationPercent: Math.round(utilizationPercent * 100) / 100,
      entryCount: this.stats.totalEntries,
      maxEntries: this.options.maxEntries
    };
  }

  /**
   * Get all keys in the cache
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache
   */
  values(): any[] {
    const values: any[] = [];
    for (const node of this.cache.values()) {
      if (!this.isExpired(node.entry)) {
        values.push(this.deserialize(node.entry.value));
      }
    }
    return values;
  }

  /**
   * Get all entries in the cache
   */
  entries(): Array<[string, any]> {
    const entries: Array<[string, any]> = [];
    for (const [key, node] of this.cache.entries()) {
      if (!this.isExpired(node.entry)) {
        entries.push([key, this.deserialize(node.entry.value)]);
      }
    }
    return entries;
  }

  /**
   * Flush cache to persistence
   */
  async flush(): Promise<void> {
    if (!this.db || !this.options.enablePersistence) {
      return;
    }
    
    try {
      // Check if database is open
      if (!this.db.open) {
        logger.warn('Cannot flush cache: database connection is closed');
        return;
      }
      
      const transaction = this.db.transaction(() => {
        for (const node of this.cache.values()) {
          if (!this.isExpired(node.entry)) {
            this.persistEntry(node.entry);
          }
        }
      });
      
      transaction();
      logger.info('Cache flushed to persistence');
      
    } catch (error) {
      logger.error('Failed to flush cache to persistence', {
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't throw error, just log it
    }
  }

  /**
   * Shutdown the cache gracefully
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Memory Cache');
    
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    
    // Flush to persistence if enabled
    if (this.options.enablePersistence) {
      await this.flush();
    }
    
    // Clear cache
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    
    // Reset stats
    this.stats = {
      totalEntries: 0,
      memoryUsage: 0,
      hitRate: 0,
      missRate: 0,
      evictionCount: 0,
      expiredCount: 0,
      totalHits: 0,
      totalMisses: 0,
      totalSets: 0,
      totalDeletes: 0,
      averageAccessTime: 0
    };
    
    this.removeAllListeners();
    
    logger.info('Memory Cache shutdown complete');
  }
}