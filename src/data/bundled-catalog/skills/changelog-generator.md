---
id: changelog-generator
name: Changelog Generator
description: Generate and maintain changelogs from commit history with semantic versioning and release notes
source: bundled
version: 1.0.0
category: documentation
tags: [changelog, releases, versioning, docs]
scope: project
---

# Changelog Generator

Generate and maintain changelogs from commit history with semantic versioning and release notes.

## When to Use
- When preparing releases and release notes
- When setting up automated changelog generation
- When establishing commit message conventions
- When communicating changes to users and stakeholders

## Guidelines

### Commit Conventions
- Use Conventional Commits format: type(scope): description
- Types: feat, fix, docs, style, refactor, perf, test, chore
- Include breaking change footer for major version bumps
- Reference issue numbers in commit messages

### Changelog Format
- Group changes by type (Added, Changed, Fixed, Removed)
- Include version number and release date
- Link to full diff between versions
- Highlight breaking changes prominently

### Automation
- Use tools like conventional-changelog or release-please
- Generate changelogs from commit messages automatically
- Integrate with CI/CD for release automation
- Publish release notes to GitHub Releases

### Versioning
- Follow semantic versioning (MAJOR.MINOR.PATCH)
- Bump MAJOR for breaking changes
- Bump MINOR for new features
- Bump PATCH for bug fixes

## Best Practices
- Write commit messages for the changelog reader, not just developers
- Include migration guides for breaking changes
- Keep a human-readable CHANGELOG.md in the repository root
- Review auto-generated changelogs before publishing
