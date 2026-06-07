---
id: event-driven-architecture
name: Event-Driven Architecture
description: Design event-driven systems with message brokers, event sourcing, and CQRS patterns
source: bundled
version: 1.0.0
category: architecture
tags: [events, cqrs, event-sourcing, messaging]
scope: project
---

# Event-Driven Architecture

Design event-driven systems with message brokers, event sourcing, and CQRS patterns for scalable, decoupled applications.

## When to Use
- When building systems that need loose coupling between components
- When implementing audit trails or temporal queries
- When different read and write models optimize different use cases
- When integrating multiple systems asynchronously

## Guidelines

### Event Design
- Name events in past tense (OrderPlaced, UserRegistered)
- Include all data needed by consumers in the event payload
- Version events to support schema evolution
- Use a canonical event envelope with metadata (timestamp, source, correlationId)

### Event Sourcing
- Store events as the source of truth, derive state by replaying
- Use snapshots to optimize replay performance
- Implement event store with append-only semantics
- Handle event versioning with upcasters

### CQRS (Command Query Responsibility Segregation)
- Separate write models (commands) from read models (queries)
- Build optimized read projections for specific query patterns
- Accept eventual consistency between write and read sides
- Use materialized views for complex query requirements

### Message Broker Patterns
- Use topics for fan-out (one-to-many) delivery
- Use queues for competing consumers (load balancing)
- Implement dead letter queues for failed message handling
- Ensure at-least-once delivery with idempotent consumers

## Best Practices
- Design events as immutable facts about what happened
- Test event handlers in isolation with recorded events
- Monitor consumer lag and processing latency
- Document event schemas in a shared registry
