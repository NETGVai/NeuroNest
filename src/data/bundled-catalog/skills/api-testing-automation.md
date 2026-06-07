---
id: api-testing-automation
name: API Testing Automation
description: Automate API testing with contract validation, schema checks, and comprehensive endpoint coverage
source: bundled
version: 1.0.0
category: testing
tags: [api-testing, automation, contracts, validation]
scope: project
---

# API Testing Automation

Automate API testing with contract validation, schema checks, and comprehensive endpoint coverage.

## When to Use
- When building automated test suites for REST or GraphQL APIs
- When implementing contract testing between services
- When validating API responses against schemas
- When testing authentication and authorization flows

## Guidelines

### Test Categories
- Smoke tests: verify endpoints are reachable and return expected status codes
- Functional tests: validate business logic and data transformations
- Contract tests: verify request/response schemas match specifications
- Security tests: test auth, injection, and access control

### Request Testing
- Test all HTTP methods for each endpoint
- Validate request body schema enforcement
- Test with missing, extra, and malformed fields
- Verify query parameter validation and defaults

### Response Validation
- Assert status codes for success and error cases
- Validate response body against JSON Schema or OpenAPI spec
- Check response headers (content-type, cache-control, CORS)
- Verify pagination metadata and link headers

### Authentication Testing
- Test with valid, expired, and malformed tokens
- Verify role-based access control per endpoint
- Test rate limiting behavior
- Validate error responses for unauthorized requests

## Best Practices
- Run API tests in CI on every pull request
- Use environment variables for test configuration
- Generate test data with factories, don't rely on production data
- Keep tests independent — no shared state between tests
