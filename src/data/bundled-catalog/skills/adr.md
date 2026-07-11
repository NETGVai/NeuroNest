---
id: adr
name: Architecture Decision Records
description: Document and maintain architecture decisions using structured ADR templates with context, decision, consequences, and status fields
source: bundled
version: 1.0.0
category: architecture
tags: [adr, architecture, decisions, documentation, design-records]
scope: project
---

# Architecture Decision Records

Record every significant architectural decision using the ADR format. ADRs provide traceability, onboarding context, and a living history of system evolution.

## ADR Template

Use this template for every architecture decision:

```markdown
# ADR-{number}: {Title}

## Status

{Proposed | Accepted | Deprecated | Superseded by ADR-XXX}

## Context

Describe the forces at play: technical constraints, business requirements, team capabilities, and timeline pressures that make this decision necessary.

## Decision

State the decision clearly and concisely. Use active voice: "We will use X" or "The system will implement Y".

## Consequences

### Positive
- List benefits and opportunities this decision enables

### Negative
- List trade-offs, risks, and limitations accepted

### Neutral
- List side effects that are neither clearly positive nor negative
```

## Guidelines

1. **One decision per ADR** — Keep each record focused on a single architectural choice.
2. **Immutable once accepted** — Never modify an accepted ADR. Supersede it with a new one if the decision changes.
3. **Date and number sequentially** — Use monotonically increasing numbers (ADR-001, ADR-002, etc.).
4. **Link affected modules** — Reference the source files, packages, or services impacted by the decision.
5. **Record alternatives considered** — Briefly note what was rejected and why.
6. **Review periodically** — Flag ADRs whose context has changed for potential supersession.

## Status Lifecycle

- **Proposed** → Under discussion, not yet binding.
- **Accepted** → Ratified and in effect. Implementation should follow.
- **Deprecated** → No longer relevant but kept for historical context.
- **Superseded** → Replaced by a newer ADR (link to successor).

## When to Write an ADR

- Choosing between competing technologies or libraries
- Defining module boundaries or service decomposition
- Selecting communication patterns (sync vs async, REST vs gRPC)
- Establishing data storage strategies
- Setting security or compliance architectural constraints
- Changing an existing architectural pattern

## Storage Convention

Store ADRs in the project's `docs/adr/` directory with filenames like `001-use-event-sourcing.md`. Keep an `index.md` linking all active ADRs.
