/**
 * Memory Cache Module
 * 
 * Provides in-memory caching functionality replacing Redis with TTL expiration,
 * LRU eviction, and optional SQLite backing for persistence.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

export {
  MemoryCache,
  type CacheEntry,
  type CacheStats,
  type MemoryCacheOptions
} from './memory-cache.js';