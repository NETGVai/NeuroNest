---
id: database-optimization
name: Database Optimization
description: Optimize database queries, indexes, and schemas for maximum performance and reliability
source: bundled
version: 1.0.0
category: data
tags: [database, sql, optimization, indexing]
scope: project
---

# Database Optimization

Optimize database queries, indexes, and schemas for maximum performance and reliability.

## When to Use
- When queries are slow or causing timeouts
- When designing schemas for high-throughput workloads
- During performance audits and capacity planning
- When migrating to handle increased data volumes

## Guidelines

### Query Optimization
- Use EXPLAIN/ANALYZE to understand query execution plans
- Avoid SELECT * — specify only needed columns
- Use parameterized queries to prevent SQL injection and enable plan caching
- Optimize JOINs by ensuring join columns are indexed
- Avoid N+1 query patterns — use eager loading or batch queries

### Index Strategy
- Create indexes on columns used in WHERE, JOIN, and ORDER BY
- Use composite indexes matching query patterns (leftmost prefix rule)
- Monitor index usage and remove unused indexes
- Consider partial indexes for filtered queries

### Schema Design
- Normalize to 3NF, then denormalize strategically for read performance
- Use appropriate data types (don't store numbers as strings)
- Add constraints (NOT NULL, CHECK, UNIQUE) for data integrity
- Plan for schema evolution with backward-compatible migrations

### Connection Management
- Use connection pooling with appropriate pool sizes
- Set query timeouts to prevent long-running queries
- Implement read replicas for read-heavy workloads
- Monitor connection usage and pool exhaustion

## Best Practices
- Benchmark queries with production-like data volumes
- Set up slow query logging and review regularly
- Test migrations on a copy of production data
- Document schema decisions and index rationale
