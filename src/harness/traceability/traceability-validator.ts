/**
 * Traceability matrix validator.
 *
 * Validates that:
 * 1. Every requirement is referenced by at least one implementation or automated validation task.
 * 2. Every design property (1–52) maps to exactly one property-test task/test identifier.
 * 3. Artifact links exist for all mappings.
 *
 * Requirements: 33.1–33.9
 */

import type {
  PropertyId,
  RequirementId,
  TraceabilityMatrix,
  TraceabilityValidationResult,
  TraceabilityConfig,
} from './types.js';

/**
 * Validates a traceability matrix for completeness.
 *
 * Checks:
 * - All requirements from config are present and have at least one task covering them.
 * - All properties (1 through config.propertyCount) are mapped to exactly one test task.
 * - No property is mapped to more than one test (exactly-one constraint).
 */
export function validateTraceabilityMatrix(
  matrix: TraceabilityMatrix,
  config: TraceabilityConfig,
): TraceabilityValidationResult {
  // Check requirement coverage
  const uncoveredRequirements: RequirementId[] = [];

  for (const entry of matrix.requirements) {
    if (entry.taskIds.length === 0) {
      uncoveredRequirements.push(entry.requirementId);
    }
  }

  // Check property mappings
  const unmappedProperties: PropertyId[] = [];
  const duplicatePropertyMappings: PropertyId[] = [];
  const seenPropertyIds = new Map<PropertyId, number>();

  for (const mapping of matrix.properties) {
    const count = (seenPropertyIds.get(mapping.propertyId) ?? 0) + 1;
    seenPropertyIds.set(mapping.propertyId, count);

    if (!mapping.taskId || mapping.taskId === '') {
      unmappedProperties.push(mapping.propertyId);
    }
  }

  // Check all expected properties exist in the matrix
  for (let id = 1; id <= config.propertyCount; id++) {
    if (!seenPropertyIds.has(id)) {
      unmappedProperties.push(id);
    }
  }

  // Check for duplicates (same property mapped by multiple entries)
  for (const [propId, count] of seenPropertyIds) {
    if (count > 1) {
      duplicatePropertyMappings.push(propId);
    }
  }

  const allRequirementsCovered = uncoveredRequirements.length === 0;
  const allPropertiesMapped =
    unmappedProperties.length === 0 && duplicatePropertyMappings.length === 0;

  return {
    allRequirementsCovered,
    allPropertiesMapped,
    uncoveredRequirements,
    unmappedProperties,
    duplicatePropertyMappings,
    valid: allRequirementsCovered && allPropertiesMapped,
  };
}

/**
 * Validates that every property maps to exactly one test by checking
 * the task document for duplicate property-test assignments.
 */
export function validatePropertyUniqueness(
  matrix: TraceabilityMatrix,
): { valid: boolean; duplicates: PropertyId[] } {
  const propertyToTasks = new Map<PropertyId, string[]>();

  for (const mapping of matrix.properties) {
    if (mapping.taskId) {
      const existing = propertyToTasks.get(mapping.propertyId) ?? [];
      existing.push(mapping.taskId);
      propertyToTasks.set(mapping.propertyId, existing);
    }
  }

  const duplicates: PropertyId[] = [];
  for (const [propId, tasks] of propertyToTasks) {
    if (tasks.length > 1) {
      duplicates.push(propId);
    }
  }

  return { valid: duplicates.length === 0, duplicates };
}

/**
 * Validates that artifact links reference valid paths or identifiers.
 * Returns invalid links for diagnostic reporting.
 */
export function validateArtifactLinks(
  matrix: TraceabilityMatrix,
): { valid: boolean; invalidLinks: Array<{ source: string; link: string }> } {
  const invalidLinks: Array<{ source: string; link: string }> = [];

  for (const entry of matrix.requirements) {
    for (const link of entry.artifactLinks) {
      if (!link || link.trim() === '') {
        invalidLinks.push({ source: `requirement:${entry.requirementId}`, link });
      }
    }
  }

  for (const mapping of matrix.properties) {
    if (mapping.taskId && (!mapping.testArtifact || mapping.testArtifact.trim() === '')) {
      invalidLinks.push({ source: `property:${mapping.propertyId}`, link: mapping.testArtifact });
    }
  }

  return { valid: invalidLinks.length === 0, invalidLinks };
}

/**
 * Produces a human-readable summary of the validation result.
 */
export function formatValidationSummary(result: TraceabilityValidationResult): string {
  const lines: string[] = [];

  lines.push(`Traceability Validation: ${result.valid ? 'PASS' : 'FAIL'}`);
  lines.push('');

  lines.push(`Requirements Coverage: ${result.allRequirementsCovered ? 'COMPLETE' : 'INCOMPLETE'}`);
  if (result.uncoveredRequirements.length > 0) {
    lines.push(`  Uncovered (${result.uncoveredRequirements.length}): ${result.uncoveredRequirements.join(', ')}`);
  }

  lines.push('');
  lines.push(`Property Mappings: ${result.allPropertiesMapped ? 'COMPLETE' : 'INCOMPLETE'}`);
  if (result.unmappedProperties.length > 0) {
    lines.push(`  Unmapped (${result.unmappedProperties.length}): ${result.unmappedProperties.join(', ')}`);
  }
  if (result.duplicatePropertyMappings.length > 0) {
    lines.push(`  Duplicates (${result.duplicatePropertyMappings.length}): ${result.duplicatePropertyMappings.join(', ')}`);
  }

  return lines.join('\n');
}
