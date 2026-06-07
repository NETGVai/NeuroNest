---
id: system-design-review
name: System Design Review
description: Review and evaluate system designs for scalability, reliability, security, and maintainability
source: bundled
version: 1.0.0
category: architecture
tags: [system-design, review, scalability, reliability]
scope: project
---

# System Design Review

Review and evaluate system designs for scalability, reliability, security, and maintainability.

## When to Use
- When reviewing architecture proposals before implementation
- When evaluating system designs for production readiness
- When conducting architecture review boards
- When assessing technical debt and improvement opportunities

## Guidelines

### Scalability Review
- Can the system handle 10x current load?
- Are there single points of failure or bottlenecks?
- Is horizontal scaling possible for each component?
- Are data stores designed for expected growth?

### Reliability Review
- What happens when each component fails?
- Are there proper health checks and circuit breakers?
- Is there a disaster recovery plan?
- What are the SLOs and how are they measured?

### Security Review
- Are trust boundaries clearly defined?
- Is authentication and authorization properly implemented?
- Is sensitive data encrypted at rest and in transit?
- Are there proper audit logs?

### Maintainability Review
- Is the system well-documented?
- Can components be deployed independently?
- Is the codebase testable and tested?
- Are operational runbooks available?

## Best Practices
- Use a structured review checklist for consistency
- Include diverse perspectives (dev, ops, security, product)
- Document decisions and trade-offs in ADRs
- Follow up on review findings with action items
