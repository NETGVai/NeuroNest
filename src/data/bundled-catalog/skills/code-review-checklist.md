---
id: code-review-checklist
name: Code Review Checklist
description: Structured code review with security, performance, and style checks
source: bundled
version: 1.0.0
category: code-quality
tags: [review, security, performance]
scope: project
---

# Code Review Checklist

## Security Checks
- Validate all user inputs and sanitize outputs
- Check for hardcoded secrets, API keys, or credentials
- Verify authentication and authorization on all endpoints
- Review for SQL injection, XSS, and CSRF vulnerabilities
- Ensure sensitive data is encrypted at rest and in transit

## Performance Checks
- Review database queries for N+1 problems and missing indexes
- Check for unnecessary re-renders or redundant computations
- Verify async operations are properly awaited
- Look for memory leaks in event listeners and subscriptions
- Assess bundle size impact of new dependencies

## Code Style
- Ensure consistent naming conventions across the codebase
- Verify functions are single-responsibility and under 50 lines
- Check for proper error handling with descriptive messages
- Confirm TypeScript types are explicit, not inferred as `any`
- Validate that public APIs have JSDoc documentation

## Testing
- Verify new code has corresponding unit tests
- Check edge cases are covered (empty inputs, nulls, boundaries)
- Ensure tests are deterministic and not order-dependent
- Confirm integration tests cover critical user flows

## Architecture
- Verify changes follow established project patterns
- Check for circular dependencies between modules
- Ensure new abstractions are justified and documented
- Review for proper separation of concerns
