---
id: github-actions-workflows
name: GitHub Actions Workflows
description: Build efficient GitHub Actions CI/CD workflows with caching, matrix builds, and reusable workflows
source: bundled
version: 1.0.0
category: devops
tags: [github-actions, ci-cd, automation, workflows]
scope: project
---

# GitHub Actions Workflows

Build efficient GitHub Actions CI/CD workflows with caching, matrix builds, and reusable workflows.

## When to Use
- When setting up CI/CD for a GitHub-hosted project
- When optimizing slow or expensive CI pipelines
- When creating reusable workflow templates for an organization

## Guidelines

### Workflow Structure
- Use separate workflows for CI (test) and CD (deploy)
- Trigger on appropriate events (push, pull_request, release)
- Use path filters to skip irrelevant workflows
- Set concurrency groups to cancel redundant runs

### Performance Optimization
- Cache dependencies (node_modules, pip cache, etc.)
- Use matrix strategies for parallel testing across versions
- Split long workflows into parallel jobs with dependencies
- Use self-hosted runners for heavy workloads

### Security
- Pin action versions to full SHA, not tags
- Use OIDC for cloud provider authentication (no long-lived secrets)
- Limit GITHUB_TOKEN permissions with `permissions` key
- Review third-party actions before using them

### Reusable Workflows
- Extract common patterns into reusable workflow files
- Use inputs and secrets for parameterization
- Publish shared workflows in a central repository
- Version reusable workflows with tags

## Best Practices
- Keep workflows fast (< 10 minutes for CI)
- Use status checks to protect main branch
- Add workflow dispatch for manual triggers
- Monitor workflow costs and optimize runner usage
