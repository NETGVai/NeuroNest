---
id: static-code-analysis
name: Static Code Analysis
description: Perform deep static analysis to detect bugs, code smells, complexity issues, and maintainability risks
source: bundled
version: 1.0.0
category: code-quality
tags: [analysis, complexity, code-smells, maintainability]
scope: project
---

# Static Code Analysis

Perform deep static analysis to detect bugs, code smells, complexity issues, and maintainability risks before they reach production.

## When to Use
- Before merging pull requests to catch issues early
- During periodic codebase health assessments
- When onboarding to an unfamiliar codebase
- After major refactoring to verify quality improvements

## Guidelines

### Complexity Analysis
- Calculate cyclomatic complexity per function (flag >10)
- Measure cognitive complexity for readability assessment
- Identify deeply nested control flow (>3 levels)
- Track function length (flag >50 lines)

### Code Smell Detection
- Duplicate code blocks across files
- Long parameter lists (>4 parameters)
- Feature envy — methods using other class data excessively
- Dead code and unreachable branches
- God classes with too many responsibilities

### Dependency Analysis
- Map import/dependency graphs between modules
- Detect circular dependencies
- Identify tightly coupled components
- Flag unused dependencies

### Type Safety
- Find implicit `any` types in TypeScript
- Detect unsafe type assertions
- Verify null/undefined handling
- Check for missing return types on public APIs

## Best Practices
- Run analysis incrementally on changed files for fast feedback
- Set thresholds per metric and track trends over time
- Prioritize findings by severity: bugs > security > maintainability > style
- Combine automated analysis with human code review for best results
