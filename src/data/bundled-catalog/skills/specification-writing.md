---
id: specification-writing
name: Specification Writing
description: Write clear technical specifications with requirements, acceptance criteria, and constraints
source: bundled
version: 1.0.0
category: documentation
tags: [specifications, requirements, acceptance-criteria, technical-writing]
scope: project
---

# Specification Writing

## Specification Structure

1. **Overview**: What problem does this solve and for whom?
2. **Requirements**: Functional and non-functional requirements
3. **Constraints**: Technical, business, and regulatory limits
4. **Acceptance Criteria**: Testable conditions for completion
5. **Out of Scope**: Explicitly state what is NOT included

## Writing Effective Requirements

- Use precise, unambiguous language
- Each requirement should be independently testable
- Assign unique IDs for traceability
- Classify as Must/Should/Could/Won't (MoSCoW)
- Include rationale for non-obvious requirements

## Acceptance Criteria Format

Use Given/When/Then for behavioral specifications:
- **Given** a specific precondition or context
- **When** an action or event occurs
- **Then** the expected outcome is observed

## Common Pitfalls

- Avoid vague terms like "fast", "user-friendly", "scalable"
- Don't mix requirements with implementation details
- Ensure no contradictions between requirements
- Get stakeholder sign-off before implementation begins
