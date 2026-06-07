---
id: memory-coordination
name: Memory Coordination
description: Manage shared memory and context across distributed agents and services
source: bundled
version: 1.0.0
category: ai
tags: [memory, shared-state, coordination, context, distributed]
scope: project
---

# Memory Coordination

## Memory Architecture

- **Hot tier**: In-memory cache for frequently accessed context
- **Warm tier**: Vector store for semantic retrieval
- **Cold tier**: Persistent storage for historical data

## Context Window Management

- Summarize old context to fit within token limits
- Prioritize recent and relevant information
- Use sliding window with importance-weighted retention
- Compress repetitive information into summaries

## Shared State Patterns

- Use append-only logs for coordination state
- Implement read-your-writes consistency for critical data
- Use CRDTs for conflict-free concurrent updates
- Version all shared state for rollback capability

## Eviction Strategies

- LRU for general-purpose caching
- Importance-weighted eviction for context windows
- TTL-based expiry for time-sensitive data
- Manual pinning for critical reference information
