---
id: code-review-advanced
name: Advanced Code Review
description: Deep code review with security focus, architectural assessment, and automated checks
source: bundled
version: 1.0.0
category: code-quality
tags: [review, security, architecture, automated-review]
scope: project
---

# Advanced Code Review

## Security-Focused Review

- Check for injection vulnerabilities (SQL, XSS, command injection)
- Verify authentication and authorization on every endpoint
- Scan for hardcoded secrets, tokens, or credentials
- Validate input sanitization and output encoding
- Review cryptographic usage for known weaknesses

## Architectural Review

- Verify changes respect module boundaries and layering
- Check for circular dependencies introduced by the change
- Assess impact on system-wide concerns (caching, logging, auth)
- Validate backward compatibility of public API changes
- Review database migration safety (rollback plan, data loss risk)

## Automated Review Checklist

- Linting passes with zero warnings
- Type checking is strict with no `any` escapes
- Test coverage meets threshold for changed lines
- No new dependencies without justification
- Bundle size impact is within budget

## Review Communication

- Lead with what's good before suggesting changes
- Distinguish blocking issues from nits
- Provide concrete suggestions, not just criticism
- Ask questions when intent is unclear rather than assuming
