/**
 * Bound Descriptor — Type definitions for documenting operational bounds.
 *
 * Each bound descriptor carries unit, supported range, purpose, and the
 * scope precedence used to resolve values. Descriptors are used by
 * Diagnostics_Service to expose operational bounds for inspection.
 *
 * Requirements: 5.6, 7.4, 11.3, 14.2, 18.2, 22.4–22.8, 31.1, 36.5, 37.3, 40.14, 40.17, 42.4, 47.1, 47.9, 47.14–47.15, 47.20–47.21
 */

/**
 * Physical unit for a bound value.
 */
export type BoundUnit =
  | 'milliseconds'
  | 'seconds'
  | 'bytes'
  | 'kilobytes'
  | 'megabytes'
  | 'count'
  | 'tokens'
  | 'percentage'
  | 'dip';

/**
 * Describes the documented supported range, unit, and purpose of a single
 * operational bound. Used for diagnostics and validation.
 */
export interface BoundDescriptor {
  /** Machine-readable key matching the bound in OperationalBoundsV1 */
  key: string;
  /** Human-readable label */
  label: string;
  /** The physical unit of the bound value */
  unit: BoundUnit;
  /** The minimum supported value (inclusive) */
  min: number;
  /** The maximum supported value (inclusive) */
  max: number;
  /** Explanation of the bound's purpose */
  purpose: string;
  /** The category this bound belongs to */
  category: string;
}

/**
 * Scope precedence levels for resolving operational bounds.
 * Higher precedence overrides lower. Order: session > project > workspace > user > default.
 */
export const SCOPE_PRECEDENCE = ['default', 'user', 'workspace', 'project', 'session'] as const;
export type ScopePrecedenceLevel = (typeof SCOPE_PRECEDENCE)[number];

/**
 * A resolved bound value with provenance information.
 */
export interface ResolvedBound<T = number> {
  /** The resolved value */
  value: T;
  /** The scope level that produced this value */
  resolvedFrom: ScopePrecedenceLevel;
  /** The revision that produced this value */
  sourceRevision: number;
  /** Whether this value is from last-valid-revision retention */
  retained: boolean;
}

/**
 * Diagnostics entry for a single bound.
 */
export interface BoundDiagnostic {
  descriptor: BoundDescriptor;
  resolved: ResolvedBound;
  /** Whether the current value passes validation */
  valid: boolean;
  /** If invalid, reason for failure */
  invalidReason?: string;
}
