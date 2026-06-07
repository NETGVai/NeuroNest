---
id: integration-test-patterns
name: Integration Test Patterns
description: Design integration tests that verify component interactions, API contracts, and data flows
source: bundled
version: 1.0.0
category: testing
tags: [integration, testing, contracts, api-testing]
scope: project
---

# Integration Test Patterns

Design integration tests that verify component interactions, API contracts, and data flows across system boundaries.

## When to Use
- When testing interactions between modules or services
- When verifying API contract compliance
- When testing database operations with real connections
- When validating third-party service integrations

## Guidelines

### Test Architecture
- Use test containers for database and service dependencies
- Implement test fixtures for consistent data setup
- Isolate tests with per-test transactions or database cleanup
- Use factory functions to create test data

### API Contract Testing
- Test request/response schemas against OpenAPI specs
- Verify error response formats and status codes
- Test authentication and authorization flows
- Validate pagination, filtering, and sorting

### Database Integration
- Test migrations run cleanly on empty and populated databases
- Verify cascade deletes and referential integrity
- Test concurrent access patterns and locking behavior
- Validate query performance with representative data volumes

### External Service Testing
- Use recorded HTTP interactions (VCR pattern) for deterministic tests
- Implement contract tests between producer and consumer
- Test timeout and error handling for external calls
- Mock external services at the HTTP level, not the code level

## Best Practices
- Run integration tests in CI but allow local execution too
- Keep integration tests focused — test one interaction per test
- Use realistic but minimal test data
- Clean up test state to prevent test pollution
