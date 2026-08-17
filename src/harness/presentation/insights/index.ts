/**
 * Insight Presentation — Public API
 *
 * Exports the insight presentation surface for deriving concise/detailed
 * views from InsightProjectionService records, redacted attributed export,
 * and all supporting schemas and types.
 *
 * Requirements: 48.1-48.22
 */

export {
  // Schemas
  ClassifiedMetricSchema,
  RouteProvenanceDisplaySchema,
  CostDisplayEntrySchema,
  ConversionDisplaySchema,
  BudgetStateDisplaySchema,
  ConciseInsightViewSchema,
  DetailedInsightViewSchema,
  RedactionDeclarationSchema,
  InsightExportRecordSchema,

  // Types
  type ClassifiedMetric,
  type RouteProvenanceDisplay,
  type CostDisplayEntry,
  type ConversionDisplay,
  type BudgetStateDisplay,
  type ConciseInsightView,
  type DetailedInsightView,
  type RedactionDeclaration,
  type InsightExportRecord,
} from './insight-schemas';

export {
  // Functions
  deriveConciseInsightView,
  deriveDetailedInsightView,
  buildInsightExport,
  hasIncompleteData,
  isForkInsight,
  classificationLabel,

  // Config types
  type InsightPresentationConfig,
  DEFAULT_INSIGHT_PRESENTATION_CONFIG,
} from './insight-presentation-surface';
