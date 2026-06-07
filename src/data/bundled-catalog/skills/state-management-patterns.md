---
id: state-management-patterns
name: State Management Patterns
description: Implement effective state management using Redux, Zustand, Pinia, or context-based patterns
source: bundled
version: 1.0.0
category: frontend
tags: [state, redux, zustand, react]
scope: project
---

# State Management Patterns

Implement effective state management strategies for frontend applications using modern libraries and patterns.

## When to Use
- When component prop drilling becomes unwieldy
- When multiple components need shared state
- When implementing complex data flows with side effects
- When choosing a state management approach for a new project

## Guidelines

### Choosing the Right Approach
- Local state: `useState`/`ref()` for component-specific data
- Context/Provide: for theme, auth, locale shared across a subtree
- External stores: Redux/Zustand/Pinia for complex global state
- Server state: React Query/SWR/TanStack Query for API data

### Store Design
- Normalize nested data structures
- Keep stores flat and focused by domain
- Separate UI state from domain state
- Use selectors/computed for derived data

### Side Effects
- Handle async operations in middleware or actions, not reducers
- Use optimistic updates for better perceived performance
- Implement proper error and loading states
- Cancel stale requests on navigation or re-fetch

### Performance
- Memoize selectors to prevent unnecessary re-renders
- Split stores by feature to reduce subscription scope
- Use structural sharing for immutable updates
- Profile re-render counts during development

## Best Practices
- Start with the simplest approach that works
- Avoid premature global state — lift state only when needed
- Write unit tests for reducers and selectors
- Document state shape and update patterns
