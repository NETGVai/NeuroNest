/**
 * Rich Response module — Rendering, artifacts, code actions, pagination,
 * citations, and stale-target handling for chat responses.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */

export { RichResponseRenderer } from './rich-response-renderer';
export { TypedArtifactService } from './typed-artifact-service';
export { CitationService } from './citation-service';
export { CodeActionService } from './code-action-service';
export { ArtifactViewerService } from './artifact-viewer-service';
export { LargeOutputHandler } from './large-output-handler';
export { StaleTargetHandler } from './stale-target-handler';
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
} from './types';
export type {
  CodeActionKind,
  CodeAction,
  CodeBlockContext,
  TargetResolution,
  CodeActionResult,
  CodeActionError,
  RecoveryOption,
  CodeActionDelegate,
} from './code-action-service';
export type {
  ArtifactVersion,
  ArtifactDiff,
  ArtifactDiffHunk,
  ArtifactOriginLink,
  ExportFormat,
  ExportResult,
  ArtifactViewerState,
} from './artifact-viewer-service';
export type {
  LargeOutputConfig,
  OutputDisplayMode,
  OutputChunk,
  LargeOutputState,
  RemoteResourceGate,
} from './large-output-handler';
export type {
  StaleReason,
  StaleTargetResult,
  RecoveryAction,
  RecoveryResult,
  StaleTargetDelegate,
  TargetCheckInput,
} from './stale-target-handler';
