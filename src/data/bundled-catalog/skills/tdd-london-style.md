---
id: tdd-london-style
name: TDD London Style
description: Practice London-school TDD with outside-in development and mock-based isolation
source: bundled
version: 1.0.0
category: testing
tags: [tdd, london-school, mocks, outside-in, testing]
scope: project
---

# TDD London Style

## London School Approach

The London school (mockist) approach builds from the outside in:
1. Start with an acceptance test for the feature
2. Write a unit test for the outermost component
3. Mock collaborators to isolate the unit under test
4. Implement the unit to pass the test
5. Move inward, repeating for each collaborator

## When to Use London Style

- Complex systems with many collaborating objects
- When you want to drive interface design through tests
- When external dependencies are slow or unreliable
- When you need fast, isolated unit tests

## Mock Best Practices

- Mock roles (interfaces), not concrete implementations
- Verify interactions, not implementation details
- Keep mock setups simple and readable
- Use test doubles: stubs for queries, mocks for commands

## Comparison with Classic TDD

| Aspect | London | Classic |
|--------|--------|---------|
| Direction | Outside-in | Inside-out |
| Isolation | Mock collaborators | Use real objects |
| Design focus | Interface discovery | Algorithm design |
| Refactoring | May break mock setups | Tests survive refactoring |
