/**
 * Chat module — Authoritative header, structured composer, context items,
 * @ mention picker, rich response services, code actions, artifacts,
 * pagination, and stale-target handling.
 *
 * Requirements: 15.3, 15.4, 15.10, 16.1–16.10, 17.1–17.8
 */

export { ChatHeaderService } from './chat-header-service';
export { StructuredComposerService } from './structured-composer-service';
export { ContextItemStore } from './context-item-store';
export { AtMentionPicker } from './at-mention-picker';
export {
  RichResponseRenderer,
  TypedArtifactService,
  CitationService,
  CodeActionService,
  ArtifactViewerService,
  LargeOutputHandler,
  StaleTargetHandler,
} from './rich-response';
export type {
  HeaderViewModel,
  HeaderField,
  HeaderRuntimeData,
  SourceAttribution,
  InputModality,
  ComposerInput,
  ComposerMode,
  ValidationResult,
  ValidationIssue,
  ComposerContext,
  ModalityDeclaration,
  HistoryEntry,
  ContextResolutionProgress,
} from './types';
export type {
  ContextItemKind,
  ContextProvenance,
  StalenessStatus,
  ContextItem,
  ContextItemControls,
  ContextUsageSummary,
} from './context-item-store';
export type {
  PickerCategory,
  PickerSuggestion,
  PickerState,
  PickerDataProvider,
} from './at-mention-picker';
export type {
  RichContentType,
  RichContentBlock,
  RichContentMetadata,
  RenderResult,
  CspPolicy,
  RemoteResourceConsent,
  CodeBlockOptions,
  InteractiveCard,
  CardAction,
  DiffPreview,
  DiffHunk,
  TableData,
  ArtifactType,
  TypedArtifact,
  ArtifactMetadata,
  EmitArtifactInput,
  Citation,
  CitationPosition,
  AttachCitationInput,
  CitedResponseSegment,
  CodeActionKind,
  CodeAction,
  CodeBlockContext,
  TargetResolution,
  CodeActionResult,
  CodeActionError,
  RecoveryOption,
  CodeActionDelegate,
  ArtifactVersion,
  ArtifactDiff,
  ArtifactDiffHunk,
  ArtifactOriginLink,
  ExportFormat,
  ExportResult,
  ArtifactViewerState,
  LargeOutputConfig,
  OutputDisplayMode,
  OutputChunk,
  LargeOutputState,
  RemoteResourceGate,
  StaleReason,
  StaleTargetResult,
  RecoveryAction,
  RecoveryResult,
  StaleTargetDelegate,
  TargetCheckInput,
} from './rich-response';
