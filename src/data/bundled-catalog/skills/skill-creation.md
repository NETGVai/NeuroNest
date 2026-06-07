---
id: skill-creation
name: Skill Creation
description: Create new agent skills with proper structure, metadata, and integration patterns
source: bundled
version: 1.0.0
category: ai
tags: [skills, creation, agents, metadata, templates]
scope: project
---

# Skill Creation

## Skill Structure

Every skill needs:
1. YAML frontmatter with id, name, description, category, tags
2. Clear title and purpose statement
3. Actionable instructions organized by section
4. Examples or templates where applicable

## Frontmatter Requirements

```yaml
---
id: unique-kebab-case-id
name: Human Readable Name
description: One-line description of what the skill does
source: bundled
version: 1.0.0
category: one-of-valid-categories
tags: [relevant, searchable, tags]
scope: project
---
```

## Content Guidelines

- Keep skills focused on a single domain or capability
- Write instructions that are actionable, not theoretical
- Include checklists, templates, or decision frameworks
- Target 40-80 lines total for optimal readability

## Integration

- Add the skill to catalog-index.json for discovery
- Map the skill to relevant agents in agent-skill-mappings.json
- Test that the skill loads correctly via the catalog loader
- Verify the skill appears in the skills panel
