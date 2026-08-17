/**
 * Composer Workbench - Draft Transaction Module
 *
 * Per-session transactional draft store with undo/redo, atomic submission
 * snapshots, and async resolution settlement. Implements the durable draft
 * journal for the Composer_Workbench presentation layer.
 *
 * Requirements: 40.1, 40.3–40.6, 40.10–40.15, 40.19–40.24
 */

export {
  DraftTransactionStore,
  _resetSnapshotCounter,
} from './draft-transaction-store';

export type {
  SubmissionContext,
  DraftChange,
  SubmissionResult,
  SettlementResult,
  ContextItem,
  ContextItemKind,
  ContextItemStatus,
  AttachmentDraft,
  AttachmentDraftState,
  Selection,
  ComposerMode,
  QueuePlacement,
  DraftRevision,
  SubmissionSnapshot,
  AsyncResolutionResult,
} from './draft-transaction-store';

export type {
  DraftRetentionPolicy,
  DraftTransactionStoreConfig,
} from './types';

export {
  ContextItemSchema,
  ContextItemKindSchema,
  ContextItemStatusSchema,
  AttachmentDraftSchema,
  AttachmentDraftStateSchema,
  SelectionSchema,
  ComposerModeSchema,
  QueuePlacementSchema,
  DraftRevisionSchema,
  SubmissionSnapshotSchema,
  AsyncResolutionRequestSchema,
  AsyncResolutionResultSchema,
  DraftRetentionPolicySchema,
  DraftTransactionStoreConfigSchema,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_SELECTION,
} from './types';
