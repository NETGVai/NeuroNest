---
id: system-architecture
name: System Architecture
description: Design scalable system architectures using SPARC methodology and component-based design
source: bundled
version: 1.0.0
category: backend
tags: [architecture, sparc, system-design, components, scalability]
scope: project
---

# System Architecture

## SPARC Methodology

- **Specification**: Define clear requirements and constraints
- **Pseudocode**: Outline logic before writing production code
- **Architecture**: Design component boundaries and interactions
- **Refinement**: Iterate on design based on feedback and testing
- **Completion**: Finalize with documentation and deployment plan

## Component Design Principles

1. Define clear boundaries with explicit interfaces
2. Minimize coupling between components
3. Maximize cohesion within components
4. Design for independent deployment and scaling
5. Use contracts (API specs, schemas) at boundaries

## Scalability Patterns

- Horizontal scaling with stateless services
- Event-driven architecture for async workloads
- CQRS for read/write optimization
- Sharding strategies for data partitioning
- Circuit breakers for fault isolation

## Architecture Decision Records

- Document every significant architectural choice
- Include context, decision, consequences, and alternatives
- Review ADRs periodically as the system evolves
- Use ADRs as onboarding material for new team members
