/**
 * Settings Bounds Service — Resolves operational bounds by deterministic scope precedence.
 *
 * Implements:
 * - Deterministic scope precedence: session > project > workspace > user > default
 * - Source revision tracking on every resolved value
 * - Last-valid-revision retention when current revision is invalid
 * - Diagnostics_Service exposure
 * - NO hard-coded product fallbacks
 *
 * Requirements: 5.6, 7.4, 11.3, 14.2, 18.2, 22.4–22.8, 31.1, 36.5, 37.3, 40.14, 40.17, 42.4, 47.1, 47.9, 47.14–47.15, 47.20–47.21
 */

import type { z } from 'zod';
import type { ScopeDescriptorV1 } from '../contracts/scope';
import {
  OperationalBoundsV1Schema,
  BOUND_DESCRIPTORS,
  getAllBoundKeys,
  getBoundDescriptor,
  PositiveFiniteSchema,
  type OperationalBoundsV1,
} from './operational-bounds-schema';
import {
  SCOPE_PRECEDENCE,
  type ScopePrecedenceLevel,
  type ResolvedBound,
  type BoundDiagnostic,
  type BoundDescriptor,
} from './bound-descriptor';

// ─── Types ──────────────────────────────────────────────────────

/**
 * A revision-tagged set of bounds at a specific scope level.
 */
export interface BoundsRevision {
  /** The scope level this revision applies to */
  scope: ScopePrecedenceLevel;
  /** Monotonically increasing revision number */
  revision: number;
  /** The partial or complete bounds values at this scope */
  values: Partial<FlatBounds>;
}

/**
 * Flattened dot-notation map of bound keys to their numeric values.
 * e.g., 'database.busyTimeoutMs' -> 5000
 */
export type FlatBounds = Record<string, number>;

/**
 * Validation result returned by the validate method.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  key: string;
  value: unknown;
  reason: string;
}

/**
 * Internal record of last-valid state for a given bound key.
 */
interface LastValidRecord {
  value: number;
  revision: number;
  scope: ScopePrecedenceLevel;
}

// ─── Service ────────────────────────────────────────────────────

/**
 * Resolves operational bounds using deterministic scope precedence with
 * source revision tracking, last-valid-revision retention, and diagnostics exposure.
 */
export class SettingsBoundsService {
  /**
   * Scope layers indexed by precedence level.
   * Each scope level holds the latest revision with its partial bound values.
   */
  private readonly layers: Map<ScopePrecedenceLevel, BoundsRevision> = new Map();

  /**
   * Last-valid-revision retention store.
   * If a current revision is invalid for a key, this provides the last known good value.
   */
  private readonly lastValid: Map<string, LastValidRecord> = new Map();

  /**
   * Apply a new bounds revision at a given scope level.
   * Validates each individual value and updates last-valid retention accordingly.
   */
  applyRevision(revision: BoundsRevision): void {
    // Store the layer — we resolve from all layers during resolution
    this.layers.set(revision.scope, revision);

    // Update last-valid records for each key in this revision
    for (const [key, value] of Object.entries(revision.values)) {
      if (this.isValidBoundValue(key, value)) {
        this.lastValid.set(key, {
          value,
          revision: revision.revision,
          scope: revision.scope,
        });
      }
    }
  }

  /**
   * Resolve a single bound by dot-notation key using scope precedence.
   * Returns the resolved value with provenance, or undefined if no valid value exists.
   */
  resolveBound(key: string): ResolvedBound | undefined {
    // Walk scope precedence from highest to lowest
    for (let i = SCOPE_PRECEDENCE.length - 1; i >= 0; i--) {
      const scope = SCOPE_PRECEDENCE[i];
      const layer = this.layers.get(scope);
      if (!layer) continue;

      const value = layer.values[key];
      if (value === undefined) continue;

      // Check if the value is valid
      if (this.isValidBoundValue(key, value)) {
        return {
          value,
          resolvedFrom: scope,
          sourceRevision: layer.revision,
          retained: false,
        };
      }
    }

    // No valid value found in any layer — check last-valid retention
    const retained = this.lastValid.get(key);
    if (retained) {
      return {
        value: retained.value,
        resolvedFrom: retained.scope,
        sourceRevision: retained.revision,
        retained: true,
      };
    }

    return undefined;
  }

  /**
   * Resolve all operational bounds using scope precedence.
   * Returns a complete OperationalBoundsV1 only if all bounds are resolvable.
   * Throws if any required bound is missing (no hard-coded defaults).
   */
  resolveAll(): { bounds: OperationalBoundsV1; resolutions: Map<string, ResolvedBound> } {
    const resolutions = new Map<string, ResolvedBound>();
    const allKeys = getAllBoundKeys();

    for (const key of allKeys) {
      const resolved = this.resolveBound(key);
      if (!resolved) {
        throw new Error(
          `Operational bound "${key}" has no configured value at any scope level. ` +
          'All bounds must come from Settings_Service configuration — no hard-coded fallbacks.',
        );
      }
      resolutions.set(key, resolved);
    }

    // Build the nested object from flat resolutions
    const flat: FlatBounds = {};
    for (const [key, resolved] of resolutions) {
      flat[key] = resolved.value;
    }

    const bounds = unflattenBounds(flat);
    return { bounds, resolutions };
  }

  /**
   * Validate a candidate OperationalBoundsV1 against schema and range constraints.
   */
  validate(candidate: unknown): ValidationResult {
    const schemaResult = OperationalBoundsV1Schema.safeParse(candidate);
    if (!schemaResult.success) {
      const errors: ValidationError[] = schemaResult.error.issues.map((issue) => ({
        key: issue.path.join('.'),
        value: undefined,
        reason: issue.message,
      }));
      return { valid: false, errors };
    }

    // Additional range validation
    const flat = flattenBounds(schemaResult.data);
    const errors: ValidationError[] = [];
    for (const [key, value] of Object.entries(flat)) {
      const descriptor = getBoundDescriptor(key);
      if (!descriptor) continue;

      if (value < descriptor.min || value > descriptor.max) {
        errors.push({
          key,
          value,
          reason: `Value ${value} is outside supported range [${descriptor.min}, ${descriptor.max}] (unit: ${descriptor.unit})`,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the BoundDescriptor for a given dot-notation key.
   */
  describe(key: string): BoundDescriptor | undefined {
    return getBoundDescriptor(key);
  }

  /**
   * Expose all bounds diagnostics for Diagnostics_Service.
   * Returns the current state of each bound with resolution provenance and validity.
   */
  getDiagnostics(): BoundDiagnostic[] {
    const allKeys = getAllBoundKeys();
    const diagnostics: BoundDiagnostic[] = [];

    for (const key of allKeys) {
      const descriptor = BOUND_DESCRIPTORS[key];
      const resolved = this.resolveBound(key);

      if (!resolved) {
        diagnostics.push({
          descriptor,
          resolved: { value: 0, resolvedFrom: 'default', sourceRevision: 0, retained: false },
          valid: false,
          invalidReason: 'No configured value at any scope level',
        });
        continue;
      }

      const inRange = resolved.value >= descriptor.min && resolved.value <= descriptor.max;
      diagnostics.push({
        descriptor,
        resolved,
        valid: inRange,
        invalidReason: inRange
          ? undefined
          : `Value ${resolved.value} outside range [${descriptor.min}, ${descriptor.max}]`,
      });
    }

    return diagnostics;
  }

  /**
   * Check if a value is valid for a given bound key.
   * Uses the PositiveFiniteSchema and the descriptor's range.
   */
  private isValidBoundValue(key: string, value: unknown): value is number {
    const numResult = PositiveFiniteSchema.safeParse(value);
    if (!numResult.success) return false;

    const descriptor = getBoundDescriptor(key);
    if (!descriptor) return numResult.success;

    const num = numResult.data;
    return num >= descriptor.min && num <= descriptor.max;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Flatten a nested OperationalBoundsV1 into dot-notation key-value pairs.
 */
export function flattenBounds(bounds: OperationalBoundsV1): FlatBounds {
  const flat: FlatBounds = {};

  for (const [category, categoryBounds] of Object.entries(bounds)) {
    if (category === 'schemaVersion') continue;
    if (typeof categoryBounds === 'object' && categoryBounds !== null) {
      for (const [field, value] of Object.entries(categoryBounds as Record<string, number>)) {
        flat[`${category}.${field}`] = value;
      }
    }
  }

  return flat;
}

/**
 * Unflatten dot-notation bounds into a nested OperationalBoundsV1 object.
 */
export function unflattenBounds(flat: FlatBounds): OperationalBoundsV1 {
  const result: Record<string, Record<string, number>> = {};

  for (const [key, value] of Object.entries(flat)) {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) continue;
    const category = key.slice(0, dotIndex);
    const field = key.slice(dotIndex + 1);
    if (!result[category]) result[category] = {};
    result[category][field] = value;
  }

  return { schemaVersion: 1 as const, ...result } as unknown as OperationalBoundsV1;
}
