/**
 * Renderer Workbench Authority — desktop shell, canonical workspace-relative
 * editor models, deep links, and streamed/completed ChangeSet review
 * (FUT-PKG-07-EXPERIENCE/T-003).
 *
 * A single view authority over the desktop shell that never becomes a durable
 * file writer: every mutation routes through the canonical ChangeService
 * (NN-INV-008, D-04/D-12). Editor models are canonical per workspace-relative
 * URI (NN-WORKSPACE-011); deep links and models carry only workspace-relative
 * paths (NN-UI-003, NN-INV-004); review preserves hunk state across the
 * streamed→completed transition and never mutates before approval (NN-UI-004).
 *
 * Requirements: NN-UI-001–006/013, NN-WORKSPACE-011, NN-OPS-002.
 */

export * from './workbench-types.js';
export {
  WORKSPACE_LAYOUT_VERSION,
  NARROW_MAX_WIDTH_PX,
  classifyViewport,
  defaultLayout,
  deriveShell,
  openInPane,
  splitPane,
  setPanel,
  focusArea,
  migrateLayout,
} from './desktop-shell.js';
export {
  WORKBENCH_LINK_OWNER,
  DeepLinkError,
  normalizeWorkspaceRelative,
  makeFileLink,
  makeRangeLink,
  makeAnchorLink,
  serializeDeepLink,
  parseDeepLink,
} from './deep-link.js';
export {
  EDITOR_MODEL_OWNER,
  EditorModelError,
  EditorModelRegistry,
  type EditorModel,
  type ModelLifecycleEvent,
  type ModelLifecycleKind,
} from './editor-model-registry.js';
export {
  REVIEW_OWNER,
  ReviewError,
  ChangeSetReviewModel,
  type HunkDecision,
  type ReviewHunk,
  type ReviewPhase,
  type ReviewProvenance,
  type ReviewSnapshot,
} from './changeset-review.js';
