---
id: issue-management
name: Issue Management
description: Triage, label, and prioritize issues with structured workflows and templates
source: bundled
version: 1.0.0
category: workflow
tags: [issues, triage, labeling, prioritization, tracking]
scope: project
---

# Issue Management

## Issue Triage Process

1. Verify the issue is reproducible and well-described
2. Assign severity: critical, high, medium, low
3. Categorize: bug, feature, enhancement, documentation
4. Label with affected component and area
5. Assign to the appropriate team or milestone

## Issue Templates

- **Bug report**: Steps to reproduce, expected vs actual, environment
- **Feature request**: Problem statement, proposed solution, alternatives
- **Task**: Description, acceptance criteria, dependencies

## Prioritization Framework

- **P0 Critical**: System down, data loss, security breach
- **P1 High**: Major feature broken, significant user impact
- **P2 Medium**: Minor feature issue, workaround available
- **P3 Low**: Cosmetic issues, nice-to-have improvements

## Workflow Automation

- Auto-label issues based on content keywords
- Move issues to "In Progress" when a branch is created
- Close issues automatically when linked PR merges
- Notify stakeholders on priority changes
