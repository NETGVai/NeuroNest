---
id: service-mesh
name: Service Mesh
description: Implement service mesh patterns for inter-service communication, observability, and security
source: bundled
version: 1.0.0
category: infrastructure
tags: [service-mesh, istio, linkerd, networking, microservices]
scope: project
---

# Service Mesh

## Core Capabilities

- **Traffic management**: Routing, load balancing, retries
- **Security**: mTLS, authorization policies, certificate rotation
- **Observability**: Distributed tracing, metrics, access logs
- **Resilience**: Circuit breaking, rate limiting, fault injection

## Sidecar Pattern

- Deploy a proxy sidecar alongside each service
- All traffic flows through the sidecar transparently
- Centralized control plane manages sidecar configuration
- No application code changes required for mesh features

## Traffic Management

- Route traffic based on headers, paths, or weights
- Implement canary deployments with traffic splitting
- Configure retries with budgets to prevent retry storms
- Set timeouts per route to prevent cascading failures

## When to Use a Service Mesh

- Multiple services communicating over the network
- Need for consistent security policies across services
- Requirement for detailed inter-service observability
- Complex traffic routing (A/B testing, canary, mirroring)
