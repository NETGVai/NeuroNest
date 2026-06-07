---
id: microservices-architecture
name: Microservices Architecture
description: Design and implement microservice architectures with service boundaries, communication patterns, and resilience
source: bundled
version: 1.0.0
category: architecture
tags: [microservices, architecture, distributed, patterns]
scope: project
---

# Microservices Architecture

Design and implement microservice architectures with clear service boundaries, communication patterns, and resilience.

## When to Use
- When decomposing a monolith into independent services
- When designing a new distributed system
- When scaling specific components independently
- When different services need different technology stacks

## Guidelines

### Service Boundaries
- Define boundaries using Domain-Driven Design bounded contexts
- Each service owns its data store (database per service)
- Services communicate through well-defined APIs or events
- Avoid shared databases and tight coupling between services

### Communication Patterns
- Synchronous: REST or gRPC for request/response
- Asynchronous: message queues (RabbitMQ, Kafka) for event-driven flows
- Use API gateways for client-facing aggregation
- Implement circuit breakers for fault tolerance

### Data Management
- Use the Saga pattern for distributed transactions
- Implement eventual consistency where strong consistency isn't required
- Use event sourcing for audit trails and temporal queries
- Design idempotent operations for safe retries

### Resilience
- Implement health checks and readiness probes
- Use bulkheads to isolate failures
- Set timeouts and retries with exponential backoff
- Design for graceful degradation

## Best Practices
- Start with a modular monolith, extract services when justified
- Monitor inter-service latency and error rates
- Use distributed tracing to debug cross-service issues
- Document service contracts and SLAs
