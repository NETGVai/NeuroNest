---
id: ci-workflow-patterns
name: CI Workflow Patterns
description: Design efficient CI workflow patterns with caching, parallelism, and conditional execution
source: bundled
version: 1.0.0
category: devops
tags: [ci, workflows, caching, parallelism, patterns]
scope: project
---

# CI Workflow Patterns

## Pipeline Architecture

- **Build stage**: Compile, bundle, generate artifacts
- **Test stage**: Unit, integration, E2E tests in parallel
- **Security stage**: SAST, dependency scan, secret detection
- **Deploy stage**: Staging → production with approval gates

## Optimization Patterns

- Cache dependencies between runs (node_modules, pip cache)
- Use matrix builds for cross-platform/version testing
- Run tests in parallel with sharding
- Skip unchanged modules with affected-only detection

## Conditional Execution

- Run full pipeline on main branch, subset on feature branches
- Skip E2E tests for documentation-only changes
- Trigger deployment only on tagged releases
- Run security scans on schedule plus on dependency changes

## Reliability Patterns

- Retry flaky steps with limited attempts
- Use timeouts to prevent hung jobs
- Archive test results and artifacts for debugging
- Send notifications only on state changes (pass→fail, fail→pass)
