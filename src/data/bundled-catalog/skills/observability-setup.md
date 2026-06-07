---
id: observability-setup
name: Observability Setup
description: Implement the three pillars of observability — metrics, logs, and traces — for production systems
source: bundled
version: 1.0.0
category: infrastructure
tags: [observability, metrics, logging, tracing]
scope: project
---

# Observability Setup

Implement the three pillars of observability — metrics, logs, and traces — for production systems.

## When to Use
- When setting up monitoring for new services
- When debugging production issues across distributed systems
- When establishing SLOs and alerting
- When improving system visibility and troubleshooting

## Guidelines

### Metrics
- Define RED metrics: Rate, Errors, Duration for services
- Define USE metrics: Utilization, Saturation, Errors for resources
- Use histograms for latency (not averages)
- Set up dashboards for key business and technical metrics

### Structured Logging
- Use JSON-formatted structured logs
- Include correlation IDs, request IDs, and user context
- Set appropriate log levels (error, warn, info, debug)
- Avoid logging sensitive data (PII, secrets, tokens)

### Distributed Tracing
- Instrument all service boundaries with trace context propagation
- Use OpenTelemetry for vendor-neutral instrumentation
- Set sampling rates appropriate for traffic volume
- Add custom spans for critical business operations

### Alerting
- Alert on symptoms (high error rate) not causes (high CPU)
- Set multi-window, multi-burn-rate alerts for SLOs
- Include runbook links in alert notifications
- Avoid alert fatigue with proper threshold tuning

## Best Practices
- Correlate metrics, logs, and traces with shared identifiers
- Use SLOs to drive alerting and prioritization
- Review and tune alerts quarterly
- Make dashboards accessible to the whole team
