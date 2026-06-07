---
id: worker-specialization
name: Worker Specialization
description: Design specialized worker agents with focused capabilities and clear task boundaries
source: bundled
version: 1.0.0
category: ai
tags: [workers, specialization, agents, task-routing, capabilities]
scope: project
---

# Worker Specialization

## Specialization Principles

- Each worker should excel at a narrow set of tasks
- Define clear capability boundaries for each worker type
- Avoid creating generalist workers that do everything poorly
- Match worker granularity to task decomposition level

## Capability Definition

- List the specific task types each worker handles
- Define input/output contracts for each task type
- Specify quality metrics and performance expectations
- Document limitations and tasks to reject

## Task Routing

- Route tasks based on required capabilities
- Use skill tags to match tasks to qualified workers
- Fall back to general workers when specialists are unavailable
- Track routing accuracy and adjust matching rules

## Worker Lifecycle

- Initialize workers with their specialization context
- Warm up with representative examples if needed
- Monitor performance and retrain/reconfigure as needed
- Retire workers whose specialization is no longer needed
