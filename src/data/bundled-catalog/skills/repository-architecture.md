---
id: repository-architecture
name: Repository Architecture
description: Design repository structures with monorepo and polyrepo patterns for scalable codebases
source: bundled
version: 1.0.0
category: code-quality
tags: [repository, monorepo, polyrepo, architecture, organization]
scope: project
---

# Repository Architecture

## Monorepo vs Polyrepo

- **Monorepo**: All code in one repository, shared tooling
  - Pros: Atomic changes, shared code, unified CI
  - Cons: Scaling challenges, longer CI times, complex permissions
- **Polyrepo**: Separate repository per service/package
  - Pros: Independent deployments, clear ownership, simpler CI
  - Cons: Cross-repo changes are painful, dependency management

## Monorepo Structure

```
/packages
  /shared-utils
  /ui-components
  /api-client
/apps
  /web
  /mobile
  /api
/tools
  /scripts
  /configs
```

## Repository Organization

- Use consistent directory naming conventions
- Place shared code in dedicated packages
- Keep configuration files at the root level
- Document the structure in a top-level README

## Tooling

- Use workspace-aware package managers (pnpm, Turborepo, Nx)
- Configure incremental builds to only rebuild changed packages
- Set up affected-only test runs in CI
- Use changesets for coordinated versioning across packages
