---
id: llm-integration
name: LLM Integration
description: Integrate large language models into applications with proper error handling, caching, and cost management
source: bundled
version: 1.0.0
category: ai
tags: [llm, ai, integration, openai]
scope: project
---

# LLM Integration

Integrate large language models into applications with proper error handling, caching, and cost management.

## When to Use
- When adding AI-powered features to applications
- When building chatbots, content generation, or analysis tools
- When implementing AI-assisted workflows
- When choosing between LLM providers and models

## Guidelines

### Model Selection
- Match model capability to task complexity (don't use GPT-4 for classification)
- Consider latency requirements when choosing model size
- Evaluate cost per token for expected usage volumes
- Test multiple providers for quality and reliability

### Prompt Engineering
- Use system prompts to set behavior and constraints
- Provide clear output format instructions (JSON, markdown)
- Include few-shot examples for complex tasks
- Use chain-of-thought for reasoning tasks

### Error Handling and Resilience
- Implement retries with exponential backoff for API failures
- Set timeouts appropriate for model response times
- Handle rate limits with queuing and backpressure
- Validate and sanitize LLM outputs before using them

### Cost Management
- Cache identical or similar requests
- Use streaming for long responses to improve perceived latency
- Implement token budgets per user or request
- Route simple tasks to cheaper, faster models

## Best Practices
- Log prompts and responses for debugging and improvement
- Implement content filtering for safety
- Monitor token usage and costs in real-time
- Version your prompts alongside application code
