---
id: technical-documentation
name: Technical Documentation
description: Write clear technical documentation including architecture docs, runbooks, and decision records
source: bundled
version: 1.0.0
category: documentation
tags: [docs, architecture, adr, technical-writing]
scope: project
---

# Technical Documentation

Write clear technical documentation including architecture docs, runbooks, and architecture decision records.

## When to Use
- When documenting system architecture and design decisions
- When creating operational runbooks for production systems
- When onboarding new team members
- When recording architecture decision records (ADRs)

## Guidelines

### Architecture Documentation
- Use C4 model levels (context, container, component, code)
- Document key architectural decisions and trade-offs
- Include data flow diagrams for critical paths
- Keep diagrams as code (Mermaid, PlantUML) for version control

### Architecture Decision Records
- Title: short descriptive name
- Status: proposed, accepted, deprecated, superseded
- Context: what forces are at play
- Decision: what was decided and why
- Consequences: what are the trade-offs

### Operational Runbooks
- Step-by-step procedures for common operations
- Troubleshooting guides with symptoms and solutions
- Escalation paths and contact information
- Recovery procedures for failure scenarios

### Writing Quality
- Write for your audience's technical level
- Use consistent terminology with a glossary
- Include code examples and command snippets
- Keep documentation close to the code it describes

## Best Practices
- Treat documentation as code — review, version, and test it
- Set up automated checks for broken links and outdated references
- Assign documentation ownership to prevent staleness
- Use templates for consistency across document types
