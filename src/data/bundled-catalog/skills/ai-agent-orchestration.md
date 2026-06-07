---
id: ai-agent-orchestration
name: AI Agent Orchestration
description: Design and coordinate multi-agent AI systems with task decomposition, routing, and result synthesis
source: bundled
version: 1.0.0
category: ai
tags: [agents, orchestration, multi-agent, ai]
scope: project
---

# AI Agent Orchestration

Design and coordinate multi-agent AI systems with task decomposition, intelligent routing, and result synthesis.

## When to Use
- When building systems with multiple specialized AI agents
- When decomposing complex tasks across agent capabilities
- When implementing agent coordination and consensus
- When designing agent communication protocols

## Guidelines

### Task Decomposition
- Break complex tasks into subtasks matching agent specialties
- Identify dependencies between subtasks for execution ordering
- Estimate complexity to route to appropriate agent tiers
- Define clear input/output contracts for each subtask

### Agent Routing
- Route tasks based on agent capability profiles
- Consider agent load and availability in routing decisions
- Implement fallback routing when primary agents are unavailable
- Track routing success rates to improve future decisions

### Result Synthesis
- Merge outputs from multiple agents into coherent results
- Resolve conflicts between agent outputs using voting or ranking
- Validate synthesized results against original requirements
- Provide provenance tracking for each contribution

### Coordination Patterns
- Sequential: agents work in pipeline order
- Parallel: independent subtasks execute simultaneously
- Hierarchical: coordinator agent delegates to specialists
- Consensus: multiple agents vote on the best approach

## Best Practices
- Define clear agent roles and capability boundaries
- Implement timeout and retry logic for agent interactions
- Monitor agent performance and adjust routing weights
- Log all agent interactions for debugging and improvement
