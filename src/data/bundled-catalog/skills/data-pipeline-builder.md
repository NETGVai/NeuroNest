---
id: data-pipeline-builder
name: Data Pipeline Builder
description: Build reliable data pipelines with ETL/ELT patterns, data quality checks, and orchestration
source: bundled
version: 1.0.0
category: data
tags: [data-pipeline, etl, data-quality, orchestration]
scope: project
---

# Data Pipeline Builder

Build reliable data pipelines with ETL/ELT patterns, data quality checks, and orchestration.

## When to Use
- When building data ingestion and transformation pipelines
- When implementing data warehouse loading processes
- When setting up real-time or batch data processing
- When ensuring data quality across pipeline stages

## Guidelines

### Pipeline Architecture
- Choose ETL (transform before load) or ELT (load then transform) based on needs
- Design for idempotency — safe to re-run without duplicates
- Implement checkpointing for long-running pipelines
- Use partitioning for parallel processing

### Data Quality
- Validate schema conformance at ingestion
- Check for nulls, duplicates, and out-of-range values
- Implement data freshness monitoring
- Alert on quality threshold violations

### Orchestration
- Use DAG-based orchestrators (Airflow, Prefect, Dagster)
- Define clear dependencies between pipeline stages
- Implement retry logic with exponential backoff
- Set up alerting for pipeline failures

### Monitoring
- Track pipeline execution time and data volumes
- Monitor data latency (time from source to destination)
- Log row counts at each stage for reconciliation
- Set up SLAs for data freshness

## Best Practices
- Version pipeline code and configurations
- Test pipelines with sample data before production
- Document data lineage and transformation logic
- Implement dead letter handling for malformed records
