---
id: api-gateway-design
name: API Gateway Design
description: Design API gateways with routing, rate limiting, authentication, and request transformation
source: bundled
version: 1.0.0
category: backend
tags: [api-gateway, routing, rate-limiting, middleware]
scope: project
---

# API Gateway Design

Design API gateways with routing, rate limiting, authentication, and request transformation.

## When to Use
- When building a unified entry point for microservices
- When implementing cross-cutting concerns (auth, rate limiting)
- When aggregating multiple backend APIs for clients
- When implementing API management and monitoring

## Guidelines

### Core Functions
- Route requests to appropriate backend services
- Authenticate and authorize requests centrally
- Rate limit by client, endpoint, or tier
- Transform requests and responses between formats

### Traffic Management
- Implement circuit breakers for failing backends
- Use load balancing across service instances
- Support canary routing for gradual rollouts
- Cache responses for frequently accessed endpoints

### Security
- Validate and sanitize all incoming requests
- Implement OAuth 2.0 / API key authentication
- Add security headers to all responses
- Log all requests for audit and debugging

### Observability
- Collect metrics per route (latency, error rate, throughput)
- Add correlation IDs for distributed tracing
- Log request/response metadata (not bodies) for debugging
- Set up alerts for error rate spikes

## Best Practices
- Keep gateway logic thin — business logic belongs in services
- Use declarative configuration for routing rules
- Test gateway behavior under load
- Plan for gateway high availability
