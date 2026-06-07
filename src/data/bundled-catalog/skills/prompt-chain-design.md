---
id: prompt-chain-design
name: Prompt Chain Design
description: Design multi-step prompt chains for complex AI tasks with validation, branching, and error recovery
source: bundled
version: 1.0.0
category: ai
tags: [prompts, chains, ai, workflow]
scope: project
---

# Prompt Chain Design

Design multi-step prompt chains for complex AI tasks with validation, branching, and error recovery.

## When to Use
- When a single prompt can't handle the full task complexity
- When building multi-step AI workflows
- When implementing validation between AI processing steps
- When designing branching logic based on AI outputs

## Guidelines

### Chain Architecture
- Break complex tasks into sequential, focused prompts
- Define clear input/output contracts between chain steps
- Use structured output (JSON) for reliable inter-step data passing
- Implement validation gates between steps

### Step Design
- Each step should have a single, clear objective
- Provide context from previous steps as needed
- Use system prompts to constrain each step's behavior
- Include examples of expected output format

### Branching and Routing
- Route to different chains based on input classification
- Implement conditional steps that execute only when needed
- Use early termination for simple cases
- Support parallel branches for independent subtasks

### Error Recovery
- Validate outputs at each step before proceeding
- Implement retry with rephrased prompts on failure
- Use fallback chains for common failure modes
- Log chain execution for debugging and improvement

## Best Practices
- Test chains with diverse inputs including edge cases
- Monitor token usage and latency per chain step
- Version prompt chains alongside application code
- Use evaluation datasets to measure chain quality
