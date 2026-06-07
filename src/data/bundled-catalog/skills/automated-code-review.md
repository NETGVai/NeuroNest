---
id: automated-code-review
name: Automated Code Review
description: Set up automated code review workflows with linting, static analysis, and AI-assisted review
source: bundled
version: 1.0.0
category: code-quality
tags: [automated-review, linting, static-analysis, ci, code-quality]
scope: project
---

# Automated Code Review

## Automated Checks

- **Linting**: ESLint, Prettier, Stylelint for style consistency
- **Type checking**: TypeScript strict mode, mypy for Python
- **Static analysis**: SonarQube, CodeClimate for code smells
- **Security scanning**: Snyk, npm audit for vulnerabilities
- **License compliance**: Check dependency licenses

## CI Integration

- Run all checks on every pull request
- Block merge if any required check fails
- Report results as inline PR comments
- Cache analysis results to speed up subsequent runs

## Custom Rules

- Define project-specific linting rules
- Create custom static analysis checks for domain patterns
- Enforce architectural boundaries with import restrictions
- Check for banned APIs or deprecated patterns

## Review Workflow

1. Developer pushes code and opens PR
2. Automated checks run and post results
3. Human reviewer focuses on logic and design
4. Automated checks re-run after changes
5. All checks pass → ready for merge
