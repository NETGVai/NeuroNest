---
id: dependency-management
name: Dependency Management
description: Audit, update, and manage project dependencies for security, compatibility, and minimal bloat
source: bundled
version: 1.0.0
category: code-quality
tags: [dependencies, npm, security, audit]
scope: project
---

# Dependency Management

Audit, update, and manage project dependencies for security, compatibility, and minimal bloat.

## When to Use
- During regular security audit cycles
- Before major releases to ensure dependency health
- When adding new dependencies to evaluate trade-offs
- When resolving vulnerability alerts

## Guidelines

### Security Auditing
- Run `npm audit` or equivalent to find known vulnerabilities
- Check CVE databases for critical dependency issues
- Verify dependency maintainer reputation and activity
- Review transitive dependencies for hidden risks

### Version Management
- Use semantic versioning ranges appropriately
- Pin exact versions for production deployments
- Keep a lockfile committed and up to date
- Test dependency updates in isolation before merging

### Bloat Reduction
- Audit bundle size impact of each dependency
- Replace heavy libraries with lighter alternatives when possible
- Remove unused dependencies regularly
- Prefer dependencies with zero or minimal transitive deps

### License Compliance
- Verify all dependency licenses are compatible with your project
- Flag copyleft licenses (GPL) in proprietary projects
- Maintain a license inventory for compliance audits

## Best Practices
- Automate dependency update PRs with tools like Dependabot or Renovate
- Set up CI checks for vulnerability scanning on every PR
- Evaluate alternatives before adding any new dependency
- Document why each major dependency was chosen
