---
id: consensus-protocols
name: Consensus Protocols
description: Implement distributed consensus protocols for multi-agent agreement and fault-tolerant decision making
source: bundled
version: 1.0.0
category: swarm
tags: [consensus, distributed, fault-tolerance, voting]
scope: project
---

# Consensus Protocols

Implement distributed consensus protocols for multi-agent agreement and fault-tolerant decision making.

## When to Use
- When multiple agents need to agree on a decision
- When implementing fault-tolerant coordination
- When resolving conflicting agent outputs
- When designing leader election mechanisms

## Guidelines

### Voting Mechanisms
- Majority voting: simple majority decides
- Weighted voting: votes weighted by agent expertise
- Quorum-based: require minimum participation threshold
- Ranked choice: agents rank preferences for nuanced decisions

### Fault Tolerance
- Tolerate f failures with 2f+1 agents (crash faults)
- Tolerate f Byzantine faults with 3f+1 agents
- Implement timeout-based failure detection
- Handle network partitions gracefully

### Leader Election
- Use heartbeat-based leader detection
- Implement term-based leadership with monotonic counters
- Handle split-brain with fencing tokens
- Support graceful leadership transfer

### Conflict Resolution
- Define merge strategies for conflicting outputs
- Use CRDTs for conflict-free state convergence
- Implement last-writer-wins for simple conflicts
- Escalate unresolvable conflicts to human review

## Best Practices
- Choose the simplest protocol that meets requirements
- Test consensus under network delays and failures
- Monitor consensus latency and agreement rates
- Document protocol guarantees and limitations
