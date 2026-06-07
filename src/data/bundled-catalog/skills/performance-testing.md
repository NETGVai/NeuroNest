---
id: performance-testing
name: Performance Testing
description: Design and execute performance, load, and stress tests to validate system behavior under pressure
source: bundled
version: 1.0.0
category: testing
tags: [performance, load-testing, benchmarking, stress]
scope: project
---

# Performance Testing

Design and execute performance, load, and stress tests to validate system behavior under realistic and extreme conditions.

## When to Use
- Before major releases to establish performance baselines
- When validating system capacity for expected traffic
- When investigating performance regressions
- When planning infrastructure scaling

## Guidelines

### Test Types
- Load test: verify behavior under expected concurrent users
- Stress test: find breaking points beyond normal capacity
- Soak test: detect memory leaks and degradation over time
- Spike test: validate behavior under sudden traffic bursts

### Test Design
- Model realistic user behavior with think times and varied actions
- Use production-like data volumes and distributions
- Ramp up load gradually to identify inflection points
- Define clear pass/fail thresholds (p95 latency, error rate)

### Metrics to Capture
- Response time percentiles (p50, p95, p99)
- Throughput (requests per second)
- Error rate under load
- Resource utilization (CPU, memory, connections, disk I/O)

### Analysis
- Compare results against SLA requirements
- Identify bottlenecks using profiling and tracing
- Correlate performance degradation with resource saturation
- Document findings with reproducible test configurations

## Best Practices
- Run performance tests in an environment matching production
- Automate performance tests in CI for regression detection
- Test with warm caches and cold caches separately
- Share results with the team and track trends over time
