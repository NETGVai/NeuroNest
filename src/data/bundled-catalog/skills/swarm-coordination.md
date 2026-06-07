---
id: swarm-coordination
name: Swarm Coordination
description: Coordinate multi-agent swarms with task distribution, consensus protocols, and fault tolerance
source: bundled
version: 1.0.0
category: swarm
tags: [swarm, multi-agent, coordination, consensus]
scope: project
---

# Swarm Coordination

Coordinate multi-agent swarms with task distribution, consensus protocols, and fault tolerance.

## When to Use
- When orchestrating multiple AI agents on complex tasks
- When implementing distributed decision-making
- When building fault-tolerant multi-agent systems
- When designing agent communication topologies

## Guidelines

### Task Distribution
- Decompose work into independent, parallelizable units
- Assign tasks based on agent specialization and availability
- Implement work-stealing for load balancing
- Track task progress and handle timeouts

### Consensus Protocols
- Use voting for decisions requiring agreement
- Implement quorum-based consensus for fault tolerance
- Handle split-brain scenarios with leader election
- Support both synchronous and asynchronous consensus

### Communication Patterns
- Hub-and-spoke: coordinator routes all messages
- Peer-to-peer: agents communicate directly
- Publish-subscribe: agents subscribe to relevant topics
- Gossip: epidemic-style information propagation

### Fault Tolerance
- Detect agent failures with heartbeat monitoring
- Reassign tasks from failed agents automatically
- Implement idempotent task execution for safe retries
- Maintain system progress despite partial failures

## Best Practices
- Start with simple coordination, add complexity as needed
- Monitor swarm health metrics (throughput, latency, error rate)
- Log all coordination decisions for debugging
- Test with simulated agent failures
