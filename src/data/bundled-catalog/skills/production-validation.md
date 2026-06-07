---
id: production-validation
name: Production Validation
description: Validate deployments with pre-deploy checks, smoke tests, and canary analysis
source: bundled
version: 1.0.0
category: devops
tags: [production, validation, smoke-tests, canary, deployment]
scope: project
---

# Production Validation

## Pre-Deploy Checks

- All CI pipeline stages pass (build, test, security scan)
- Database migrations are backward compatible
- Feature flags are configured for gradual rollout
- Rollback procedure is documented and tested

## Smoke Tests

- Verify critical user flows immediately after deployment
- Check health endpoints return 200 with correct metadata
- Validate database connectivity and cache availability
- Confirm external service integrations are functional

## Canary Analysis

- Route a small percentage of traffic to the new version
- Compare error rates, latency, and business metrics
- Automatically roll back if metrics degrade beyond thresholds
- Gradually increase traffic if canary metrics are healthy

## Post-Deploy Monitoring

- Watch error rates for 30 minutes after full rollout
- Monitor key business metrics (conversion, engagement)
- Check for increased support tickets or user complaints
- Confirm log volume and patterns are within normal range
