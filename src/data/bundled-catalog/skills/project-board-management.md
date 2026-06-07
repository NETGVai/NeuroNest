---
id: project-board-management
name: Project Board Management
description: Manage GitHub Projects boards with automation, views, and workflow customization
source: bundled
version: 1.0.0
category: workflow
tags: [project-management, github-projects, boards, automation, tracking]
scope: project
---

# Project Board Management

## Board Structure

- **Backlog**: Triaged items not yet scheduled
- **Ready**: Items ready for development with clear requirements
- **In Progress**: Currently being worked on
- **In Review**: PR submitted, awaiting review
- **Done**: Completed and deployed

## Automation Rules

- Move to "In Progress" when a branch is created
- Move to "In Review" when a PR is opened
- Move to "Done" when the PR is merged
- Auto-add new issues to "Backlog" with triage label

## Custom Views

- Sprint view: Filter by current milestone
- Team view: Group by assignee
- Priority view: Sort by priority label
- Stale items view: Filter items with no activity for 7+ days

## Metrics and Reporting

- Track cycle time from "Ready" to "Done"
- Monitor WIP limits per column
- Report sprint velocity (items completed per sprint)
- Identify bottlenecks by column dwell time
