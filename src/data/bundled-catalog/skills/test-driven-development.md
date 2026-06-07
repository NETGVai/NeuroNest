---
id: test-driven-development
name: Test-Driven Development
description: Apply TDD methodology with red-green-refactor cycles for reliable, well-designed code
source: bundled
version: 1.0.0
category: testing
tags: [tdd, testing, methodology, design]
scope: project
---

# Test-Driven Development

Apply TDD methodology with red-green-refactor cycles to produce reliable, well-designed code.

## When to Use
- When implementing new features with clear requirements
- When fixing bugs to prevent regression
- When designing APIs or interfaces
- When working on critical business logic

## Guidelines

### Red-Green-Refactor Cycle
1. Red: Write a failing test that describes desired behavior
2. Green: Write the minimum code to make the test pass
3. Refactor: Improve code structure while keeping tests green
4. Repeat with the next small increment

### Writing Good Tests
- Test behavior, not implementation details
- Use descriptive test names that read as specifications
- Follow Arrange-Act-Assert (AAA) pattern
- Keep each test focused on one assertion

### Test Design
- Start with the simplest case, then add complexity
- Use parameterized tests for similar scenarios
- Test edge cases: empty inputs, boundaries, nulls
- Write tests for error conditions, not just happy paths

### When to Skip TDD
- Exploratory prototyping (write tests after)
- UI layout code (use visual regression tests instead)
- Generated code or boilerplate
- Spike solutions for learning

## Best Practices
- Commit after each green phase
- Don't write more test than needed for the next step
- Let tests drive the design — listen to test pain
- Maintain fast test execution (< 1 second per unit test)
