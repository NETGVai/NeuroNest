---
id: serverless-architecture
name: Serverless Architecture
description: Design serverless applications with Lambda, API Gateway, and event-driven compute patterns
source: bundled
version: 1.0.0
category: infrastructure
tags: [serverless, lambda, cloud, event-driven]
scope: project
---

# Serverless Architecture

Design serverless applications with functions-as-a-service, managed APIs, and event-driven compute patterns.

## When to Use
- When building event-driven microservices
- When workloads have variable or unpredictable traffic
- When minimizing operational overhead is a priority
- When building APIs with pay-per-request pricing

## Guidelines

### Function Design
- Keep functions small and single-purpose
- Minimize cold start impact with appropriate runtime choices
- Use provisioned concurrency for latency-sensitive functions
- Externalize state to databases or caches

### Event Sources
- API Gateway for HTTP-triggered functions
- Queue/stream triggers for async processing (SQS, EventBridge)
- Schedule triggers for cron-like periodic tasks
- Storage triggers for file processing pipelines

### Architecture Patterns
- Use Step Functions or Durable Functions for orchestration
- Implement fan-out/fan-in for parallel processing
- Use event bridges for decoupled service communication
- Design for idempotency — functions may be retried

### Operational Concerns
- Set appropriate timeout and memory limits
- Implement structured logging with correlation IDs
- Use distributed tracing for cross-function debugging
- Monitor cold start frequency and duration

## Best Practices
- Test functions locally with emulators before deploying
- Use infrastructure-as-code (SAM, Serverless Framework, CDK)
- Implement dead letter queues for failed invocations
- Design for the constraints: stateless, time-limited, ephemeral
