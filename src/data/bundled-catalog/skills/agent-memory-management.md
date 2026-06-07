---
id: agent-memory-management
name: Agent Memory Management
description: Manage shared memory, context windows, and knowledge bases for multi-agent collaboration
source: bundled
version: 1.0.0
category: swarm
tags: [memory, context, knowledge-base, agents]
scope: project
---

# Agent Memory Management

Manage shared memory, context windows, and knowledge bases for effective multi-agent collaboration.

## When to Use
- When agents need to share context and knowledge
- When managing context window limits across agent interactions
- When building persistent knowledge bases for agent swarms
- When implementing memory retrieval for agent decision-making

## Guidelines

### Memory Architecture
- Short-term: current task context and recent interactions
- Working memory: active project state and intermediate results
- Long-term: persistent knowledge base and learned patterns
- Shared memory: cross-agent state for coordination

### Context Window Management
- Summarize older context to fit within token limits
- Prioritize recent and relevant information
- Use retrieval-augmented approaches for large knowledge bases
- Implement context compression for efficiency

### Knowledge Persistence
- Store successful patterns and solutions for reuse
- Index knowledge by topic, agent, and project
- Implement relevance scoring for knowledge retrieval
- Expire stale knowledge based on age and usage

### Memory Sharing
- Define access patterns (read-only, read-write, append-only)
- Implement conflict resolution for concurrent updates
- Use event-driven notifications for memory changes
- Scope memory access by project and task

## Best Practices
- Monitor memory usage and retrieval quality
- Implement garbage collection for unused memories
- Test memory retrieval with diverse queries
- Balance memory completeness with retrieval speed
