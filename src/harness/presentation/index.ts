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
