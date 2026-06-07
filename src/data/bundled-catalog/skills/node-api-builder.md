---
id: node-api-builder
name: Node.js API Builder
description: Build production-ready Node.js APIs with Express or Fastify, middleware, and error handling
source: bundled
version: 1.0.0
category: backend
tags: [nodejs, express, fastify, api]
scope: project
---

# Node.js API Builder

Build production-ready Node.js APIs with Express or Fastify, middleware patterns, and robust error handling.

## When to Use
- When building new REST or GraphQL APIs in Node.js
- When structuring middleware pipelines
- When implementing authentication and validation layers

## Guidelines

### Project Structure
- Organize by feature/domain, not by technical layer
- Separate route definitions from business logic
- Use a centralized error handling middleware
- Keep configuration in environment variables

### Middleware Patterns
- Request validation with Zod or Joi schemas
- Authentication middleware for JWT/session verification
- Rate limiting and request throttling
- Request logging with correlation IDs

### Error Handling
- Use custom error classes with HTTP status codes
- Catch async errors with wrapper functions or express-async-errors
- Return consistent error response format
- Log errors with context but don't leak internals to clients

### Performance
- Use connection pooling for database connections
- Implement response caching with ETags
- Stream large responses instead of buffering
- Use clustering or worker threads for CPU-bound tasks

## Best Practices
- Write integration tests for API endpoints
- Use OpenAPI/Swagger for API documentation
- Implement graceful shutdown handling
- Set appropriate security headers (helmet)
