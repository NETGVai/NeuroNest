import { WorkflowDesignSchema } from '../shared/schemas.js';
import type { WorkflowDesign } from '../shared/types.js';

/**
 * Serializes a WorkflowDesign to a JSON string.
 * Converts Date fields in metadata to ISO strings.
 * Validates: Requirement 23.13, 23.14
 */
export function serializeWorkflowDesign(design: WorkflowDesign): string {
  return JSON.stringify({
    ...design,
    metadata: {
      ...design.metadata,
      createdAt: design.metadata.createdAt.toISOString(),
      updatedAt: design.metadata.updatedAt.toISOString(),
    },
  });
}

/**
 * Parses a JSON string into a validated WorkflowDesign.
 * Throws on invalid input. Coerces date strings back to Date objects.
 * Validates: Requirement 23.13, 23.14, 23.15
 */
export function parseWorkflowDesign(json: string): WorkflowDesign {
  const raw = JSON.parse(json);
  return WorkflowDesignSchema.parse(raw);
}
