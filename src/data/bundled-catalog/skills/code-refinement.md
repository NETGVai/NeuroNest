---
id: code-refinement
name: Code Refinement
description: Iteratively improve code quality through systematic refactoring and optimization cycles
source: bundled
version: 1.0.0
category: code-quality
tags: [refinement, refactoring, optimization, iteration, improvement]
scope: project
---

# Code Refinement

## Refinement Cycle

1. **Measure**: Profile and benchmark current implementation
2. **Identify**: Find the highest-impact improvement opportunity
3. **Refactor**: Apply targeted changes with tests as safety net
4. **Verify**: Confirm behavior is preserved and metrics improved
5. **Document**: Record what changed and why

## Refactoring Priorities

- Extract duplicated logic into shared utilities
- Simplify complex conditionals with guard clauses or polymorphism
- Replace magic values with named constants or enums
- Break large functions into focused, composable pieces
- Improve naming to reflect intent, not implementation

## Optimization Techniques

- Profile before optimizing — measure, don't guess
- Optimize hot paths first (80/20 rule)
- Reduce allocations in tight loops
- Use appropriate data structures for access patterns
- Cache expensive computations with proper invalidation

## Safety Practices

- Always have passing tests before refactoring
- Make one change at a time, verify after each
- Use version control to create rollback points
- Review refactored code for unintended behavior changes
