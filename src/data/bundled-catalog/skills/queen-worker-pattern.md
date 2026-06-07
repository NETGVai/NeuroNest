---
id: queen-worker-pattern
name: Queen-Worker Pattern
description: Implement hierarchical coordination with a queen agent delegating to specialized workers
source: bundled
version: 1.0.0
category: ai
tags: [queen-worker, hierarchical, delegation, coordination, agents]
scope: project
---

# Queen-Worker Pattern

## Pattern Overview

A queen agent acts as the central coordinator, decomposing tasks and delegating to specialized worker agents. Workers report results back to the queen for aggregation.

## Queen Responsibilities

- Receive and analyze incoming tasks
- Decompose tasks into worker-appropriate subtasks
- Select the best worker for each subtask based on specialization
- Aggregate worker results into a coherent response
- Handle worker failures with reassignment or fallback

## Worker Responsibilities

- Accept tasks matching their specialization
- Execute tasks independently within defined constraints
- Report results with confidence scores
- Signal when a task is outside their capability

## Coordination Protocol

1. Queen receives a complex task
2. Queen decomposes into subtasks with dependencies
3. Independent subtasks are dispatched in parallel
4. Dependent subtasks wait for prerequisites
5. Queen aggregates results and resolves conflicts
6. Final result is validated against original requirements
