---
id: pr-management
name: PR Management
description: Manage pull request workflows with review automation, labeling, and merge strategies
source: bundled
version: 1.0.0
category: workflow
tags: [pull-requests, review, automation, github, merge]
scope: project
---

# PR Management

## PR Best Practices

- Keep PRs small and focused (under 400 lines changed)
- Write descriptive titles following conventional format
- Include context, motivation, and testing notes in the description
- Link to related issues and design documents

## Review Automation

- Auto-assign reviewers based on code ownership (CODEOWNERS)
- Run automated checks: lint, type-check, tests, security scan
- Label PRs automatically based on changed files
- Require passing CI before review is requested

## Merge Strategies

- **Squash merge**: Clean history, one commit per PR
- **Merge commit**: Preserves full branch history
- **Rebase merge**: Linear history without merge commits
- Choose based on team preference and branch strategy

## PR Lifecycle

1. Create draft PR early for visibility
2. Mark ready for review when CI passes
3. Address review feedback promptly
4. Resolve all conversations before merging
5. Delete the branch after merge
