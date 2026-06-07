import { AgentTemplateSchema } from '../shared/schemas.js';
import type { AgentTemplate } from '../shared/types.js';

/**
 * Serializes an AgentTemplate to a JSON string.
 * Validates: Requirement 4.10
 */
export function serializeAgentTemplate(template: AgentTemplate): string {
  return JSON.stringify(template);
}

/**
 * Parses a JSON string into a validated AgentTemplate.
 * Throws on invalid input.
 * Validates: Requirement 4.10, 4.11
 */
export function parseAgentTemplate(json: string): AgentTemplate {
  const raw = JSON.parse(json);
  return AgentTemplateSchema.parse(raw);
}
