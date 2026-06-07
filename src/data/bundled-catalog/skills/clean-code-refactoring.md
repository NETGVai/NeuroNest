---
id: clean-code-refactoring
name: Clean Code Refactoring
description: Systematically improve code structure, readability, and maintainability without changing behavior
source: bundled
version: 1.0.0
category: code-quality
tags: [refactoring, clean-code, patterns, solid]
scope: project
---

# Clean Code Refactoring

Systematically improve code structure, readability, and maintainability without changing external behavior.

## When to Use
- When code complexity makes changes risky or slow
- Before adding new features to a messy module
- When test coverage is sufficient to refactor safely
- During dedicated tech debt sprints

## Guidelines

### Extract and Simplify
- Extract long methods into smaller, named functions
- Replace magic numbers and strings with named constants
- Simplify conditional logic with guard clauses and early returns
- Convert nested callbacks to async/await patterns

### Apply SOLID Principles
- Single Responsibility: each class/module does one thing
- Open/Closed: extend behavior without modifying existing code
- Liskov Substitution: subtypes must be substitutable
- Interface Segregation: prefer small, focused interfaces
- Dependency Inversion: depend on abstractions, not concretions

### Naming and Clarity
- Use intention-revealing names for variables and functions
- Replace abbreviations with full descriptive names
- Name boolean variables as questions (isActive, hasPermission)
- Use consistent naming conventions across the codebase

### Safe Refactoring Process
1. Ensure tests pass before starting
2. Make one small change at a time
3. Run tests after each change
4. Commit frequently with descriptive messages

## Best Practices
- Never refactor and add features in the same commit
- Use IDE refactoring tools for rename, extract, and move operations
- Keep refactoring scope small and focused
- Document the rationale for significant structural changes
