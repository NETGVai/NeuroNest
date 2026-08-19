/**
 * Typed Presentation Dispatch and Safe Generic Fallback
 *
 * Renders tool results from Render_Intent.kind + Canonical_Tool_Value
 * without branching on tool names. Invalid or unsupported intents
 * always produce the safe generic fallback.
 *
 * Local state is limited to focus, disclosure, measurement, and
 * pending-envelope concerns.
 *
 * Requirements: 13.8, 35.5–35.6, 35.11–35.13, 37.5–37.6
 */

export { dispatchPresentation, getSupportedIntentKinds } from './dispatch';
export {
  RESPONSE_COMPATIBILITY_CONTRACT_VERSION,
  RESPONSE_COMPATIBILITY_MATRIX_V1,
  RESPONSE_INTENT_KINDS_V1,
  responseCompatibilityMatrix,
  evaluateResponseCompatibility,
  evaluateResponseBlockCompatibility,
} from './response-compatibility';
export type {
  ResponseIntentKind,
  ResponseCompatibilityMatrix,
  ResponseCompatibilityFailureReason,
  ResponseCompatibilityDecision,
  ResponseBlockCompatibilityDecision,
} from './response-compatibility';
export { sanitizeContent, sanitizeUrl, sanitizeFilePath, checkContentSafety } from './sanitize';
export type {
  PresentationOutput,
  PresentationInput,
  PresentationLocalState,
  ContentBlock,
  ContentBlockKind,
  IntentRenderer,
} from './types';
export {
  genericRenderer,
  readRenderer,
  searchRenderer,
  diffRenderer,
  terminalRenderer,
  webRenderer,
  imageRenderer,
  tableRenderer,
  treeRenderer,
  artifactRenderer,
} from './renderers';

export { DraftTransactionStore } from './composer';
export {
  OwningAuthorityDuplicateGuard,
  type AuthoritySubmissionReceiptV1,
  type DuplicateProtectionFailureReasonV1,
  type NonIdempotentSubmissionRequestV1,
  type ProtectedActionClassV1,
  type ProtectedSubmissionSnapshotV1,
  type ProtectedSubmissionStateV1,
  type ReceiptRecordFailureReasonV1,
  type ReceiptRecordResultV1,
  type ReplayPolicyV1,
  type SubmissionReservationResultV1,
  type SubmissionReservationV1,
} from './authority-actions';
export type {
  SubmissionContext,
  DraftChange,
  SubmissionResult,
  SettlementResult,
  ContextItem,
  AttachmentDraft,
  Selection,
  DraftRevision,
  SubmissionSnapshot,
  AsyncResolutionResult,
  DraftRetentionPolicy,
  DraftTransactionStoreConfig,
  QueuePlacement,
} from './composer';

export {
  CompatibleConfirmationReconciler,
  changedCompatibilityFields,
} from './pending-commands';
export type {
  ActionCompatibilitySnapshot,
  ProjectedActionOutcome,
  TransportReceiptState,
  PendingActionSubmission,
  ProjectedActionSnapshot,
  ProjectedActionResolution,
  ActionConfirmationProjection,
  PendingActionReconciliationView,
  CompatibilityField,
  ActionReconciliationResult,
} from './pending-commands';