---
id: swarm-task-decomposition
name: Swarm Task Decomposition
description: Decompose complex tasks into subtasks optimized for parallel execution by agent swarms
source: bundled
version: 1.0.0
category: swarm
tags: [swarm, decomposition, parallel, planning]
scope: project
---

# Swarm Task Decomposition

Decompose complex tasks into subtasks optimized for parallel execution by agent swarms.

## When to Use
- When a task is too complex for a single agent
- When parallelizing work across multiple agents
- When planning multi-step agent workflows
- When optimizing swarm throughput

## Guidelines

### Decomposition Strategy
- Identify independent subtasks that can run in parallel
- Define clear input/output contracts for each subtask
- Estimate complexity to match subtasks with agent capabilities
- Minimize inter-task dependencies for maximum parallelism

### Dependency Management
- Build a dependency graph of subtasks
- Identify the critical path for timeline estimation
- Schedule dependent tasks in topological order
- Allow independent branches to execute concurrently

### Task Sizing
- Keep subtasks small enough for a single agent to complete
- Avoid tasks so small that coordination overhead dominates
- Balance task granularity with communication costs
- Group related micro-tasks into coherent work units

### Result Aggregation
- Define how subtask results combine into the final output
- Handle partial failures gracefully
- Validate aggregated results against original requirements
- Provide clear provenance for each contribution

## Best Practices
- Start with coarse decomposition, refine if needed
- Test decomposition strategies with representative tasks
- Monitor subtask completion rates and bottlenecks
- Iterate on decomposition based on swarm performance data
