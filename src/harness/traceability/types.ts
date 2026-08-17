/**
 * Traceability matrix types for requirement-to-implementation and
 * property-to-test mapping validation.
 *
 * Requirements: 33.1–33.9
 */

/**
 * A single requirement identifier in the form "X.Y" (e.g., "3.1", "33.9").
 */
export type RequirementId = string;

/**
 * A property identifier in the range 1–52.
 */
export type PropertyId = number;

/**
 * Describes how a requirement is covered.
 */
export type CoverageKind =
  | 'implementation'
  | 'property-test'
  | 'unit-test'
  | 'integration-test'
  | 'snapshot-test'
  | 'conformance-test'
  | 'stress-test'
  | 'accessibility-test';

/**
 * A single requirement coverage entry.
 */
export interface RequirementCoverage {
  /** Requirement identifier, e.g. "3.1" */
  readonly requirementId: RequirementId;
  /** Task identifiers that reference this requirement (e.g. "3.3", "3.7") */
  readonly taskIds: readonly string[];
  /** The kind of coverage provided */
  readonly coverageKinds: readonly CoverageKind[];
  /** Artifact links (file paths or test identifiers) */
  readonly artifactLinks: readonly string[];
}

/**
 * A single design property to test mapping entry.
 */
export interface PropertyTestMapping {
  /** Property number 1–52 */
  readonly propertyId: PropertyId;
  /** Property title from the design document */
  readonly title: string;
  /** The task identifier that contains the property test (e.g. "1.5", "3.7") */
  readonly taskId: string;
  /** Test file path or identifier */
  readonly testArtifact: string;
  /** Requirement IDs validated by this property */
  readonly validatesRequirements: readonly RequirementId[];
}

/**
 * The complete traceability matrix.
 */
export interface TraceabilityMatrix {
  /** All requirement coverage entries */
  readonly requirements: readonly RequirementCoverage[];
  /** All property-to-test mappings */
  readonly properties: readonly PropertyTestMapping[];
}

/**
 * Result of a traceability validation check.
 */
export interface TraceabilityValidationResult {
  /** Whether all requirements are covered */
  readonly allRequirementsCovered: boolean;
  /** Whether all properties 1–52 map to exactly one test */
  readonly allPropertiesMapped: boolean;
  /** Requirements missing any coverage */
  readonly uncoveredRequirements: readonly RequirementId[];
  /** Properties missing a test mapping */
  readonly unmappedProperties: readonly PropertyId[];
  /** Properties mapped to more than one test (violation of exactly-one rule) */
  readonly duplicatePropertyMappings: readonly PropertyId[];
  /** Overall pass/fail */
  readonly valid: boolean;
}

/**
 * Configuration for the traceability matrix generator.
 */
export interface TraceabilityConfig {
  /** Total number of design properties (default: 52) */
  readonly propertyCount: number;
  /** All requirement groups with their acceptance criteria counts */
  readonly requirementGroups: readonly RequirementGroup[];
}

/**
 * A requirement group (e.g., Requirement 3 with 7 acceptance criteria = 3.1–3.7).
 */
export interface RequirementGroup {
  /** Requirement group number */
  readonly groupId: number;
  /** Number of acceptance criteria in this group */
  readonly criteriaCount: number;
}
