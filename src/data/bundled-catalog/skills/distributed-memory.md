---
id: distributed-memory
name: Distributed Memory
description: Implement distributed memory patterns for shared state across services and agents
source: bundled
version: 1.0.0
category: infrastructure
tags: [distributed, memory, shared-state, caching, replication]
scope: project
---

# Distributed Memory

## Memory Distribution Patterns

- **Replicated**: Full copy on every node, fast reads, expensive writes
- **Partitioned**: Data sharded across nodes, scales horizontally
- **Tiered**: Hot data in memory, warm in SSD, cold in object storage
- **Hybrid**: Combine patterns based on access patterns

## Consistency Models

- **Strong consistency**: All reads see the latest write (expensive)
- **Eventual consistency**: Reads may be stale but converge (scalable)
- **Causal consistency**: Preserves cause-effect ordering
- **Read-your-writes**: Guarantees you see your own updates

## Implementation Strategies

- Use Redis Cluster for partitioned in-memory data
- Use CRDTs for conflict-free eventual consistency
- Implement write-ahead logs for durability
- Use consistent hashing for stable partition assignment

## Failure Handling

- Detect node failures with heartbeat monitoring
- Rebalance partitions when nodes join or leave
- Maintain replication factor for fault tolerance
- Handle split-brain scenarios with quorum-based decisions
