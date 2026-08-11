/**
 * Taxonomy Module - Public API
 *
 * Exports the complete taxonomy loading, validation, and snapshot
 * construction API. This is the canonical entry point for any code
 * that needs to load or reference authoritative taxonomy data.
 */

export {
  loadAuthoritativeTaxonomy,
  loadTaxonomyFromExplicitData,
  getRegisteredTaxonomyVersions,
  getTaxonomyRegistry,
  TAXONOMY_DATA_SCHEMA_VERSION,
  validateTaxonomyDataFile,
  buildSnapshotFromDataFile,
  computeTaxonomyDataFingerprint,
  buildTypedSelector,
  TAXONOMY_V1,
} from './taxonomy-loader';
export type { TaxonomyDataFile, TaxonomyLoadResult } from './taxonomy-schema';
