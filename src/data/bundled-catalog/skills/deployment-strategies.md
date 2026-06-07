---
id: deployment-strategies
name: Deployment Strategies
description: Implement safe deployment strategies including blue-green, canary, rolling, and feature flags
source: bundled
version: 1.0.0
category: devops
tags: [deployment, blue-green, canary, feature-flags]
scope: project
---

# Deployment Strategies

Implement safe deployment strategies that minimize risk and enable rapid rollback.

## When to Use
- When deploying to production environments
- When releasing high-risk changes
- When implementing gradual rollouts
- When setting up deployment automation

## Guidelines

### Blue-Green Deployment
- Maintain two identical production environments
- Deploy to inactive environment, test, then switch traffic
- Keep old environment ready for instant rollback
- Automate environment switching via load balancer

### Canary Deployment
- Route a small percentage of traffic to the new version
- Monitor error rates and latency during canary phase
- Gradually increase traffic if metrics are healthy
- Auto-rollback if error thresholds are exceeded

### Rolling Deployment
- Update instances incrementally (one at a time or in batches)
- Ensure minimum healthy instances during rollout
- Use health checks to verify each batch before proceeding
- Support both forward and backward compatibility during rollout

### Feature Flags
- Decouple deployment from release using feature flags
- Target specific users or segments for gradual rollout
- Use kill switches for instant feature disable
- Clean up flags after full rollout

## Best Practices
- Always have a tested rollback procedure
- Run smoke tests after every deployment
- Monitor key metrics for 15-30 minutes post-deploy
- Document deployment runbooks for each service
