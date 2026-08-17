/**
 * Traceability module.
 *
 * Validates every requirement is referenced by implementation or automated validation,
 * and every design property 1–52 maps to exactly one property-test task/test identifier
 * with artifact links.
 *
 * Requirements: 33.1–33.9
 */

export type {
  RequirementId,
  PropertyId,
  CoverageKind,
  RequirementCoverage,
  PropertyTestMapping,
  TraceabilityMatrix,
  TraceabilityValidationResult,
  TraceabilityConfig,
  RequirementGroup,
} from './types.js';

export type { ParsedProperty, ParsedTask } from './traceability-generator.js';

export {
  expandRequirementRange,
  parseRequirementList,
  parsePropertiesFromDesign,
  parseTasksFromTasksDoc,
  inferCoverageKind,
  generateAllRequirementIds,
  buildTraceabilityMatrix,
  generateTraceabilityMatrix,
} from './traceability-generator.js';

export {
  validateTraceabilityMatrix,
  validatePropertyUniqueness,
  validateArtifactLinks,
  formatValidationSummary,
} from './traceability-validator.js';
