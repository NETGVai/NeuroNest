/**
 * Branching, Edit-and-Resend, and Exact Retry Module
 *
 * Immutable message branching with lineage-first semantics,
 * edit-and-resend in child branches, and exact retry bound to
 * Completion_Anchor/Prompt_Fingerprint. Branch-with-current-config
 * is a separate action that never masquerades as exact retry.
 *
 * Requirements: 44.1-44.16
 */

export { BranchActionService } from './branch-action-service';
export type { BranchAuthorityPort, BranchServiceState } from './branch-action-service';

export type {
  BranchLineageV1,
  CompletionAnchor,
  PromptFingerprint,
  CompletionProvenanceV1,
  UnavailabilityReason,
  ActionAvailability,
  MessageActionKind,
  MessageActionV1,
  ConfirmationReason,
  ActionConfirmation,
  RetryPreconditionKind,
  PreconditionResult,
  BranchCommand,
  EditAndResendCommand,
  ExactRetryCommand,
  BranchWithCurrentConfigCommand,
  BranchActionCommand,
  BranchActionOutcome,
  ActiveBranchState,
} from './types';

export {
  BranchLineageV1Schema,
  CompletionAnchorSchema,
  PromptFingerprintSchema,
  CompletionProvenanceV1Schema,
  UnavailabilityReasonSchema,
  ActionAvailabilitySchema,
  MessageActionKindSchema,
  MessageActionV1Schema,
  ConfirmationReasonSchema,
  ActionConfirmationSchema,
  RetryPreconditionKindSchema,
  PreconditionResultSchema,
  BranchCommandSchema,
  EditAndResendCommandSchema,
  ExactRetryCommandSchema,
  BranchWithCurrentConfigCommandSchema,
  BranchActionCommandSchema,
  BranchActionOutcomeSchema,
  ActiveBranchStateSchema,
} from './types';
