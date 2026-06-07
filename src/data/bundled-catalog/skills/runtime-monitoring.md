---
id: runtime-monitoring
name: Runtime Monitoring
description: Monitor live systems with real-time metrics, alerting, and anomaly detection
source: bundled
version: 1.0.0
category: infrastructure
tags: [monitoring, runtime, metrics, alerting, anomaly-detection]
scope: project
---

# Runtime Monitoring

## Key Metrics to Track

- **Latency**: p50, p95, p99 response times
- **Throughput**: Requests per second, events processed
- **Error Rate**: 4xx/5xx rates, exception counts
- **Saturation**: CPU, memory, disk, connection pool usage

## Alerting Strategy

- Alert on symptoms (high latency) not causes (high CPU)
- Use multi-window burn rate alerts for SLO-based monitoring
- Set warning thresholds before critical thresholds
- Include runbook links in every alert notification

## Anomaly Detection

- Establish baseline patterns for normal behavior
- Detect deviations using statistical methods or ML models
- Correlate anomalies across services to find root causes
- Reduce alert fatigue by grouping related anomalies

## Dashboard Design

- Create overview dashboards for system health at a glance
- Build drill-down dashboards for each service
- Include business metrics alongside technical metrics
- Use consistent time ranges and refresh intervals
