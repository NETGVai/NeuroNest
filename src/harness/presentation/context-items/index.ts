/**
 * Context Items — Public API
 *
 * Exports typed Context_Item chip schemas, resolution guards,
 * capacity workbench logic, and derivation functions.
 *
 * Requirements: 40.2, 40.4–40.9, 40.16–40.22
 */

export {
  // Schemas
  ContextItemKindSchema,
  ProvenanceSourceSchema,
  StalenessStateSchema,
  ItemInclusionStatusSchema,
  AuthorityActionSchema,
  ResolutionGuardSchema,
  ResolutionStateSchema,
  ResolutionFailureSchema,
  ContextItemChipSchema,
  ResolutionProgressSchema,
  RouteCapacityImpactSchema,
  ContextWorkbenchStateSchema,

  // Types
  type ContextItemKind,
  type ProvenanceSource,
  type StalenessState,
  type ItemInclusionStatus,
  type AuthorityAction,
  type ResolutionGuard,
  type ResolutionState,
  type ResolutionFailure,
  type ContextItemChip,
  type ResolutionProgress,
  type RouteCapacityImpact,
  type ContextWorkbenchState,
  type SettlementValidation,
  type ContextItemInput,
  type CapacityComputeInput,

  // Functions
  validateSettlement,
  deriveContextItemChip,
  computeRouteCapacityImpact,
  deriveResolutionProgress,
  applyCancellation,
  applyResolutionFailure,
  deriveContextWorkbenchState,
} from './context-item-surface';
