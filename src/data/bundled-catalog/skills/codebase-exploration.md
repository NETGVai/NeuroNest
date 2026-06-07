---
id: codebase-exploration
name: Codebase Exploration
description: Systematically explore and understand unfamiliar codebases with structured discovery
source: bundled
version: 1.0.0
category: code-quality
tags: [exploration, codebase, discovery, understanding, onboarding]
scope: project
---

# Codebase Exploration

## Exploration Strategy

1. Read the README and any architecture documentation
2. Examine the project structure and directory layout
3. Identify entry points (main files, route definitions)
4. Trace a typical request through the system
5. Map the dependency graph between modules

## Key Files to Find First

- Package manifest (package.json, Cargo.toml, go.mod)
- Configuration files (env, config, settings)
- Database schema or migrations
- Test files (reveal expected behavior)
- CI/CD configuration (reveals build and deploy process)

## Understanding Patterns

- Look for consistent naming conventions
- Identify the architectural pattern (MVC, hexagonal, etc.)
- Find shared utilities and helper libraries
- Note error handling and logging patterns

## Documentation as You Go

- Create a map of modules and their responsibilities
- Document non-obvious design decisions you discover
- Note areas of technical debt or confusion
- Build a glossary of domain-specific terms
