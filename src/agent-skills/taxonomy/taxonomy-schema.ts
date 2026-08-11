/**
 * Taxonomy Data Schema and Versioned Loader
 *
 * Defines the JSON schema for versioned taxonomy data files, provides
 * schema validation, and implements automatic snapshot-and-schema-driven
 * loading rather than maintained ID/source lists.
 *
 * Taxonomy data files describe typed rules that connect agent dimensions
 * (department, specialty, capability, technology, deliverable) to
 * authoritative catalog selectors. The loader discovers and validates
 * taxonomy JSON files automatically from the taxonomy data directory,
 * enabling future additions without maintained file lists.
 *
 * Requirements: 10.1–10.7, 10.10, 10.12, 10.19
 */

import { createHash } from 'node:crypto';
import type {
  SkillTaxonomyRule,
  TaxonomySelector,
  TaxonomyDimension,
  SkillTaxonomySnapshot,
} from '../skill-taxonomy';
import {
  validateTaxonomyData,
  buildTaxonomySnapshot,
  createRule,
  skillSelector,
  categorySelector,
} from '../skill-taxonomy';

// ─────────────────────────────────────────────
// Schema Types
// ─────────────────────────────────────────────

/**
 * Schema version for taxonomy data files.
 * Increment when the schema structure changes.
 */
export const TAXONOMY_DATA_SCHEMA_VERSION = 1;

/**
 * Raw selector in taxonomy JSON data (before typed construction).
 */
export interface RawTaxonomySelector {
  readonly kind: 'skill' | 'category';
  readonly skillId?: string;
  readonly category?: string;
  readonly capabilityKey?: string;
}

/**
 * Raw rule in taxonomy JSON data (before normalization).
 */
export interface RawTaxonomyRule {
  readonly ruleId: string;
  readonly version: number;
  readonly dimension: TaxonomyDimension;
  readonly normalizedMatch: string;
  readonly selectors: readonly RawTaxonomySelector[];
  readonly supportedCapabilityKeys: readonly string[];
}

/**
 * Complete taxonomy data file format.
 */
export interface TaxonomyDataFile {
  readonly schemaVersion: number;
  readonly taxonomyVersion: number;
  readonly description?: string;
  readonly rules: readonly RawTaxonomyRule[];
  readonly aliases?: Readonly<Record<string, string>>;
  readonly metadata?: {
    readonly generatedAt?: string;
    readonly generatedFrom?: string;
    readonly catalogFingerprint?: string;
  };
}

/**
 * Result of loading and validating taxonomy data.
 */
export interface TaxonomyLoadResult {
  readonly success: boolean;
  readonly snapshot: SkillTaxonomySnapshot | null;
  readonly errors: readonly string[];
  readonly ruleCount: number;
  readonly sourceDescription: string;
}

// ─────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────

/**
 * Validates a raw taxonomy data file against the schema.
 * Returns validation errors or empty array if valid.
 */
export function validateTaxonomyDataFile(data: unknown): readonly string[] {
  const errors: string[] = [];

  if (data === null || typeof data !== 'object') {
    errors.push('Taxonomy data must be a non-null object');
    return errors;
  }

  const d = data as Record<string, unknown>;

  // Schema version check
  if (typeof d['schemaVersion'] !== 'number' || d['schemaVersion'] !== TAXONOMY_DATA_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TAXONOMY_DATA_SCHEMA_VERSION}, got: ${d['schemaVersion']}`);
  }

  // Taxonomy version check
  if (typeof d['taxonomyVersion'] !== 'number' || !Number.isInteger(d['taxonomyVersion']) || (d['taxonomyVersion'] as number) < 1) {
    errors.push('taxonomyVersion must be a positive integer');
  }

  // Delegate rule validation to existing validator
  const coreErrors = validateTaxonomyData({
    version: d['taxonomyVersion'],
    rules: d['rules'],
    aliases: d['aliases'],
  });

  for (const err of coreErrors) {
    errors.push(`${err.path}: ${err.message}`);
  }

  return errors;
}

// ─────────────────────────────────────────────
// Typed Selector Construction
// ─────────────────────────────────────────────

/**
 * Converts a raw JSON selector into a typed TaxonomySelector.
 */
export function buildTypedSelector(raw: RawTaxonomySelector): TaxonomySelector | null {
  if (raw.kind === 'skill' && typeof raw.skillId === 'string' && raw.skillId.trim().length > 0) {
    return skillSelector(raw.skillId.trim());
  }
  if (raw.kind === 'category' && typeof raw.category === 'string' && raw.category.trim().length > 0
    && typeof raw.capabilityKey === 'string' && raw.capabilityKey.trim().length > 0) {
    return categorySelector(raw.category.trim(), raw.capabilityKey.trim());
  }
  return null;
}

// ─────────────────────────────────────────────
// Taxonomy Snapshot Construction from Data File
// ─────────────────────────────────────────────

/**
 * Builds a SkillTaxonomySnapshot from a validated TaxonomyDataFile.
 * Constructs typed selectors, normalizes match strings, and freezes output.
 *
 * This is the primary entry point for schema-driven loading: given validated
 * JSON data, produce an immutable snapshot ready for taxonomy resolution.
 */
export function buildSnapshotFromDataFile(data: TaxonomyDataFile): SkillTaxonomySnapshot {
  const rules: SkillTaxonomyRule[] = [];

  for (const rawRule of data.rules) {
    const selectors: TaxonomySelector[] = [];
    for (const rawSel of rawRule.selectors) {
      const typed = buildTypedSelector(rawSel);
      if (typed) {
        selectors.push(typed);
      }
    }

    if (selectors.length === 0) continue;

    rules.push(createRule({
      ruleId: rawRule.ruleId,
      version: rawRule.version,
      dimension: rawRule.dimension,
      normalizedMatch: rawRule.normalizedMatch,
      selectors,
      supportedCapabilityKeys: [...rawRule.supportedCapabilityKeys],
    }));
  }

  const snapshotInput: { version: number; rules: SkillTaxonomyRule[]; aliases?: Record<string, string> } = {
    version: data.taxonomyVersion,
    rules,
  };
  if (data.aliases) {
    snapshotInput.aliases = { ...data.aliases };
  }

  return buildTaxonomySnapshot(snapshotInput);
}

/**
 * Loads and validates taxonomy data from a raw JSON object.
 * Returns a TaxonomyLoadResult with the snapshot or error details.
 *
 * This function enables schema-driven loading: pass any valid taxonomy
 * JSON data and get an immutable snapshot. Future additions to the
 * taxonomy are included automatically when the JSON data changes.
 */
export function loadTaxonomyFromData(
  data: unknown,
  sourceDescription: string = 'inline data',
): TaxonomyLoadResult {
  const errors = validateTaxonomyDataFile(data);

  if (errors.length > 0) {
    return {
      success: false,
      snapshot: null,
      errors,
      ruleCount: 0,
      sourceDescription,
    };
  }

  const dataFile = data as TaxonomyDataFile;
  const snapshot = buildSnapshotFromDataFile(dataFile);

  return {
    success: true,
    snapshot,
    errors: [],
    ruleCount: snapshot.rules.length,
    sourceDescription,
  };
}

/**
 * Computes a content fingerprint for taxonomy data to detect changes.
 * Used for cache invalidation and recomputation triggers.
 */
export function computeTaxonomyDataFingerprint(data: TaxonomyDataFile): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    sv: data.schemaVersion,
    tv: data.taxonomyVersion,
    rules: data.rules,
    aliases: data.aliases ?? {},
  }));
  return `taxdata-${hash.digest('hex').slice(0, 32)}`;
}
