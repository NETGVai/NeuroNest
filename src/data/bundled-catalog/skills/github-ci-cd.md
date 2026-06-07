---
id: github-ci-cd
name: GitHub CI/CD
description: Build GitHub-specific CI/CD pipelines with Actions, environments, and deployment protection
source: bundled
version: 1.0.0
category: devops
tags: [github, ci-cd, actions, deployment, automation]
scope: project
---

# GitHub CI/CD

## Workflow Structure

- Use reusable workflows for shared CI logic
- Separate build, test, and deploy into distinct jobs
- Use job dependencies to enforce execution order
- Cache dependencies aggressively to speed up builds

## GitHub Actions Best Practices

- Pin action versions to specific SHAs for security
- Use matrix builds for cross-platform/version testing
- Store secrets in GitHub Secrets, never in workflow files
- Use concurrency groups to cancel redundant runs

## Environment Protection

- Configure required reviewers for production deployments
- Set wait timers between staging and production
- Use environment-specific secrets and variables
- Enable deployment branch restrictions

## Deployment Patterns

```yaml
# Example: Deploy on tag push
on:
  push:
    tags: ['v*']
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - run: npm run deploy
```
