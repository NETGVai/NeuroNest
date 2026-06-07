---
id: code-implementation
name: Code Implementation
description: Apply coding best practices with TDD, design patterns, and clean architecture principles
source: bundled
version: 1.0.0
category: code-quality
tags: [coding, tdd, design-patterns, clean-architecture, implementation]
scope: project
---

# Code Implementation

## Core Principles

1. Write code that is readable, maintainable, and testable
2. Follow TDD: write failing test first, implement minimally, then refactor
3. Apply SOLID principles and appropriate design patterns
4. Keep functions small and focused on a single responsibility

## Implementation Workflow

1. Understand requirements and define acceptance criteria
2. Write a failing test that captures the expected behavior
3. Implement the minimum code to pass the test
4. Refactor for clarity, removing duplication
5. Repeat until feature is complete

## Design Pattern Selection

- Use Factory when object creation logic is complex
- Use Strategy when behavior varies by context
- Use Observer for event-driven decoupling
- Use Adapter to integrate incompatible interfaces
- Use Decorator to extend behavior without subclassing

## Code Quality Checklist

- All public APIs have clear type signatures
- Error paths are handled explicitly
- No magic numbers or hardcoded strings
- Dependencies are injected, not instantiated inline
- Tests cover happy path, edge cases, and error scenarios
