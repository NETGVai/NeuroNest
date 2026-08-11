/**
 * Taxonomy Loader - Schema-Driven Automatic Loading
 *
 * Loads taxonomy data from versioned TypeScript/JSON modules automatically.
 * Future taxonomy additions are included through snapshot and schema-driven
 * loading rather than maintained ID/source lists.
 *
 * The loader:
 * 1. Validates taxonomy data against the schema
 * 2. Builds an immutable SkillTaxonomySnapshot
 * 3. Supports merging multiple taxonomy versions
 * 4. Enables automatic future additions through version discovery
 *
 * Requirements: 10.1–10.7, 10.10, 10.12, 10.19
 */

import type { TaxonomyDataFile } from './taxonomy-schema';
import { loadTaxonomyFromData } from './taxonomy-schema';
import type { TaxonomyLoadResult } from './taxonomy-schema';
import { TAXONOMY_V1 } from './taxonomy-v1';

/**
 * Registered taxonomy data sources.
 *
 * New taxonomy versions are added here. The loader automatically picks
 * up any registered version and selects the highest version. This enables
 * future catalog/taxonomy additions through schema-driven loading rather
 * than maintained ID/source lists.
 *
 * To add a new version:
 * 1. Create taxonomy-v{N}.ts exporting TAXONOMY_V{N}: TaxonomyDataFile
 * 2. Add it to this registry
 * 3. The loader automatically picks up the latest version
 */
const TAXONOMY_REGISTRY: readonly TaxonomyDataFile[] = [
  TAXONOMY_V1,
];

/**
 * Loads the authoritative taxonomy snapshot from registered data sources.
 *
 * Selects the highest taxonomy version from all registered sources,
 * validates it against the schema, and builds an immutable snapshot.
 * Future additions are included automatically when new versions are
 * registered in the TAXONOMY_REGISTRY.
 *
 * This is the PRIMARY entry point for taxonomy loading at runtime.
 * It replaces all legacy in-memory category/department/technology maps
 * with a single validated, versioned, schema-driven snapshot.
 */
export function loadAuthoritativeTaxonomy(): TaxonomyLoadResult {
  if (TAXONOMY_REGISTRY.length === 0) {
    return {
      success: false,
      snapshot: null,
      errors: ['No taxonomy data registered in the taxonomy registry'],
      ruleCount: 0,
      sourceDescription: 'taxonomy-registry (empty)',
    };
  }

  // Select the highest taxonomy version
  const sorted = [...TAXONOMY_REGISTRY].sort(
    (a, b) => b.taxonomyVersion - a.taxonomyVersion,
  );
  const latest = sorted[0]!;

  return loadTaxonomyFromData(
    latest,
    `taxonomy-v${latest.taxonomyVersion} (schema-driven)`,
  );
}

/**
 * Loads taxonomy from explicit data (for testing or programmatic use).
 * Validates and builds a snapshot from any conforming TaxonomyDataFile.
 */
export function loadTaxonomyFromExplicitData(
  data: TaxonomyDataFile,
): TaxonomyLoadResult {
  return loadTaxonomyFromData(data, `explicit-data-v${data.taxonomyVersion}`);
}

/**
 * Returns all registered taxonomy versions sorted by version number.
 * Useful for introspection, migration tooling, and version comparison.
 */
export function getRegisteredTaxonomyVersions(): readonly number[] {
  return TAXONOMY_REGISTRY.map(t => t.taxonomyVersion).sort((a, b) => a - b);
}

/**
 * Returns the complete registry for dynamic iteration.
 * Each entry is the raw TaxonomyDataFile without snapshot construction.
 */
export function getTaxonomyRegistry(): readonly TaxonomyDataFile[] {
  return TAXONOMY_REGISTRY;
}

// ─────────────────────────────────────────────
// Re-exports for convenience
// ─────────────────────────────────────────────

export type { TaxonomyDataFile, TaxonomyLoadResult } from './taxonomy-schema';
export {
  TAXONOMY_DATA_SCHEMA_VERSION,
  validateTaxonomyDataFile,
  buildSnapshotFromDataFile,
  computeTaxonomyDataFingerprint,
  buildTypedSelector,
} from './taxonomy-schema';
export { TAXONOMY_V1 } from './taxonomy-v1';
