---
id: design-patterns
name: Design Patterns
description: Apply proven software design patterns including creational, structural, and behavioral patterns
source: bundled
version: 1.0.0
category: architecture
tags: [patterns, design, oop, architecture]
scope: project
---

# Design Patterns

Apply proven software design patterns to solve common architectural and implementation challenges.

## When to Use
- When facing recurring design problems with known solutions
- When improving code extensibility and maintainability
- When communicating design intent to team members
- When refactoring code to reduce coupling

## Guidelines

### Creational Patterns
- Factory Method: create objects without specifying exact class
- Builder: construct complex objects step by step
- Singleton: ensure a class has only one instance (use sparingly)
- Dependency Injection: provide dependencies from outside

### Structural Patterns
- Adapter: make incompatible interfaces work together
- Decorator: add behavior to objects dynamically
- Facade: provide a simplified interface to a complex subsystem
- Proxy: control access to an object

### Behavioral Patterns
- Strategy: define a family of interchangeable algorithms
- Observer: notify dependents of state changes
- Command: encapsulate requests as objects
- Chain of Responsibility: pass requests along a handler chain

### Modern Patterns
- Repository: abstract data access behind a clean interface
- Unit of Work: track changes and commit as a batch
- Middleware/Pipeline: compose processing steps
- Plugin Architecture: extend functionality without modifying core

## Best Practices
- Choose patterns based on the problem, not the other way around
- Don't over-engineer — use patterns when complexity justifies them
- Document which pattern is used and why in code comments
- Combine patterns when they complement each other naturally
