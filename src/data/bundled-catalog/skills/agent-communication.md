---
id: agent-communication
name: Agent Communication
description: Design effective inter-agent communication protocols with message formats, routing, and error handling
source: bundled
version: 1.0.0
category: swarm
tags: [agents, communication, messaging, protocols]
scope: project
---

# Agent Communication

Design effective inter-agent communication protocols with structured message formats, routing, and error handling.

## When to Use
- When building multi-agent systems that need to exchange information
- When designing message formats for agent interactions
- When implementing request/response and event-driven patterns
- When debugging communication issues between agents

## Guidelines

### Message Design
- Use structured message envelopes with type, sender, recipient, and payload
- Include correlation IDs for request/response tracking
- Version message schemas for backward compatibility
- Keep payloads focused and minimal

### Communication Patterns
- Request/Response: synchronous query with expected reply
- Fire-and-Forget: async notification without reply
- Publish/Subscribe: broadcast to interested agents
- Streaming: continuous data flow between agents

### Routing
- Route messages based on agent capabilities and availability
- Implement message queues for async delivery
- Use priority levels for urgent communications
- Support broadcast and multicast delivery

### Error Handling
- Define timeout policies for unanswered messages
- Implement retry logic with backoff for transient failures
- Use dead letter queues for undeliverable messages
- Provide error responses with actionable information

## Best Practices
- Keep message schemas documented and versioned
- Monitor message throughput and latency
- Implement circuit breakers for unreliable agents
- Test communication patterns under load and failure conditions
