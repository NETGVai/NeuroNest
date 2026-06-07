---
id: benchmark-design
name: Benchmark Design
description: Create rigorous performance benchmarks with statistical validity and reproducibility
source: bundled
version: 1.0.0
category: testing
tags: [benchmarks, performance, statistics, measurement, testing]
scope: project
---

# Benchmark Design

## Benchmark Principles

- Measure what matters to users (latency, throughput)
- Control for external variables (system load, GC, caching)
- Run enough iterations for statistical significance
- Report results with confidence intervals, not just averages

## Benchmark Structure

1. **Warmup phase**: Allow JIT compilation and cache warming
2. **Measurement phase**: Collect data over many iterations
3. **Cooldown phase**: Ensure no resource leaks
4. **Analysis phase**: Compute statistics and detect outliers

## Statistical Rigor

- Report p50, p95, p99 percentiles, not just mean
- Calculate standard deviation and confidence intervals
- Use appropriate statistical tests for comparisons
- Run benchmarks multiple times to verify reproducibility

## Common Pitfalls

- Benchmarking with unrealistic data sizes or patterns
- Not accounting for warmup effects
- Comparing benchmarks run on different hardware
- Optimizing for benchmarks instead of real workloads
