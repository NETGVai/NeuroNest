---
id: caching-strategies
name: Caching Strategies
description: Design multi-layer caching architectures for optimal performance with proper invalidation
source: bundled
version: 1.0.0
category: optimization
tags: [caching, redis, cdn, performance]
scope: project
---

# Caching Strategies

Design multi-layer caching architectures for optimal performance with proper invalidation and consistency.

## When to Use
- When reducing database load and API latency
- When implementing CDN caching for static and dynamic content
- When designing distributed caching layers
- When optimizing expensive computations

## Guidelines

### Cache Layers
- Browser cache: static assets with long TTLs and cache busting
- CDN cache: edge caching for geographically distributed users
- Application cache: in-memory caching (Redis, Memcached)
- Database cache: query result caching and materialized views

### Caching Patterns
- Cache-aside: application manages cache reads and writes
- Write-through: write to cache and database simultaneously
- Write-behind: write to cache, async flush to database
- Read-through: cache automatically loads from database on miss

### Invalidation Strategies
- TTL-based: set expiration times based on data freshness needs
- Event-based: invalidate on data change events
- Tag-based: group related cache entries for bulk invalidation
- Version-based: include version in cache keys

### Common Pitfalls
- Cache stampede: use locking or probabilistic early expiration
- Stale data: balance freshness vs performance
- Cold start: pre-warm caches after deployments
- Memory pressure: set eviction policies (LRU, LFU)

## Best Practices
- Monitor cache hit rates and optimize for >90%
- Set appropriate TTLs based on data change frequency
- Use consistent hashing for distributed cache clusters
- Test cache failure scenarios — the app should work without cache
