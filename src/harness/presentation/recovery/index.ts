/**
 * Recovery and Reconciliation Surfaces — Public API
 *
 * Exports the typed recovery/reconciliation surface types, schemas,
 * reducer functions, and helpers.
 *
 * Requirements: 45.1–45.16
 */

export {
  // Schemas
  RecoveryErrorClassSchema,
  RecoverabilitySchema,
  RecoveryActionKindSchema,
  RecoveryActionSchema,
  RetryPresentationSchema,
  ConnectivityInterruptionSchema,
  SchemaIncompatibilitySchema,
  StaleProjectionLabelSchema,
  PreservedRecoveryStateSchema,
  MutationControlStateSchema,
  ReconciliationStatusSchema,
  RecoverySurfaceConfigSchema,

  // Types
  type RecoveryErrorClass,
  type Recoverability,
  type RecoveryActionKind,
  type RecoveryAction,
  type RetryPresentation,
  type ConnectivityInterruption,
  type SchemaIncompatibility,
  type StaleProjectionLabel,
  type PreservedRecoveryState,
  type MutationControlState,
  type ReconciliationStatus,
  type RecoverySurfaceState,
  type RecoverySurfaceConfig,
  type RecoveryProjectionInput,
  type RecoveryAccessibilityView,

  // Constants
  DEFAULT_RECOVERY_SURFACE_CONFIG,
} from './types';

export {
  // State creation
  createInitialRecoverySurfaceState,

  // Classification
  classifyRecoverability,
  getTerminalOutcomeLabel,

  // Derivation functions
  deriveMutationControlState,
  deriveRetryPresentation,
  deriveConnectivityInterruption,
  deriveSchemaIncompatibility,
  deriveStaleLabel,
  derivePreservedState,
  filterIdempotentActions,

  // Main reducer
  deriveRecoverySurfaceState,

  // Reconciliation lifecycle
  applyReconciliationCompletion,

  // Accessibility
  deriveRecoveryAccessibilityView,

  // Utilities
  redactDiagnosticContent,
  isMutationCommitted,
} from './recovery-surface';
