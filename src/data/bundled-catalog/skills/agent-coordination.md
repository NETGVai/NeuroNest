---
id: agent-coordination
name: Agent Coordination
description: Coordinate multi-agent task execution with handoffs, shared context, and conflict resolution
source: bundled
version: 1.0.0
category: ai
tags: [agents, coordination, multi-agent, handoffs, orchestration]
scope: project
---

# Agent Coordination

## Coordination Patterns

- **Sequential**: Agents execute in order, passing results forward
- **Parallel**: Independent tasks run simultaneously across agents
- **Pipeline**: Each agent transforms and passes to the next stage
- **Supervisor**: A coordinator agent delegates and monitors workers

## Task Handoff Protocol

1. Define clear input/output contracts between agents
2. Include context summary with each handoff
3. Validate outputs before passing to the next agent
4. Log handoff events for debugging and auditing

## Shared Context Management

- Maintain a shared workspace accessible to all agents
- Use append-only logs for coordination state
- Implement read/write locks for shared resources
- Summarize context periodically to manage token budgets

## Conflict Resolution

- Detect conflicting outputs from parallel agents
- Use voting or confidence scoring to resolve disagreements
- Escalate unresolvable conflicts to a supervisor agent
- Document resolution decisions for future reference
