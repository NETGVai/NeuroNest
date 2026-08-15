/**
 * Types for Rich Response rendering, Typed Artifacts, and Citations.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */

// ─── Rich Response Types ────────────────────────────────────────

/**
 * Supported rich content block types in chat responses.
 */
export type RichContentType =
  | 'markdown'
  | 'code'
  | 'mermaid'
  | 'table'
  | 'interactive_card'
  | 'diff_preview'
  | 'structured_data';

/**
 * A single rich content block in a response.
 */
export interface RichContentBlock {
  readonly id: string;
  readonly type: RichContentType;
  readonly content: string;
  readonly metadata?: RichContentMetadata;
}

/**
 * Metadata associated with a rich content block.
 */
export interface RichContentMetadata {
  readonly language?: string;
  readonly title?: string;
  readonly sourceUri?: string;
  readonly collapsed?: boolean;
}

/**
 * Options for rendering a code block with syntax highlighting.
 */
export interface CodeBlockOptions {
  readonly language: string;
  readonly content: string;
  readonly sourceAttribution?: string;
  readonly lineNumbers?: boolean;
}

/**
 * An interactive card for approval requests, tool outputs, etc.
 */
export interface InteractiveCard {
  readonly id: string;
  readonly kind: 'approval_request' | 'tool_output' | 'info' | 'warning' | 'error';
  readonly title: string;
  readonly body: string;
  readonly actions?: readonly CardAction[];
}

/**
 * An action button on an interactive card.
 */
export interface CardAction {
  readonly id: string;
  readonly label: string;
  readonly kind: 'primary' | 'secondary' | 'destructive';
  readonly disabled?: boolean;
}

/**
 * A diff preview showing before/after content.
 */
export interface DiffPreview {
  readonly targetUri: string;
  readonly before: string;
  readonly after: string;
  readonly language?: string;
  readonly hunks?: readonly DiffHunk[];
}

/**
 * A single hunk in a diff preview.
 */
export interface DiffHunk {
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly type: 'addition' | 'removal' | 'unchanged';
}

/**
 * Table data for rendering.
 */
export interface TableData {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly caption?: string;
}

/**
 * Result of rendering a content block.
 */
export interface RenderResult {
  readonly html: string;
  readonly sanitized: boolean;
  readonly remoteResourcesBlocked: readonly string[];
}

/**
 * CSP sanitization policy configuration.
 */
export interface CspPolicy {
  readonly allowInlineStyles: boolean;
  readonly allowInlineScripts: boolean;
  readonly allowedImageSources: readonly string[];
  readonly allowedFrameSources: readonly string[];
  readonly requireConsent: boolean;
}

/**
 * Remote resource consent status.
 */
export interface RemoteResourceConsent {
  readonly uri: string;
  readonly granted: boolean;
  readonly grantedAt?: string;
  readonly grantedBy?: string;
}

// ─── Typed Artifact Types ───────────────────────────────────────

/**
 * Supported artifact types.
 */
export type ArtifactType =
  | 'code_change'
  | 'file_create'
  | 'file_modify'
  | 'diagram'
  | 'data';

/**
 * A typed artifact with an explicit file target URI.
 */
export interface TypedArtifact {
  readonly id: string;
  readonly type: ArtifactType;
  readonly targetUri: string;
  readonly content: string;
  readonly metadata: ArtifactMetadata;
  readonly createdAt: string;
}

/**
 * Metadata for a typed artifact.
 */
export interface ArtifactMetadata {
  readonly language?: string;
  readonly version?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeSetId?: string;
  readonly description?: string;
}

/**
 * Input for emitting an artifact. targetUri is REQUIRED.
 */
export interface EmitArtifactInput {
  readonly type: ArtifactType;
  readonly targetUri: string;
  readonly content: string;
  readonly metadata?: Partial<ArtifactMetadata>;
}

// ─── Citation Types ─────────────────────────────────────────────

/**
 * A citation attached to a response segment.
 */
export interface Citation {
  readonly id: string;
  readonly sourceUri: string;
  readonly version: string;
  readonly position: CitationPosition;
  readonly confidence: number;
  readonly label?: string;
}

/**
 * Position within a source for a citation.
 */
export interface CitationPosition {
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/**
 * Input for attaching a citation.
 */
export interface AttachCitationInput {
  readonly sourceUri: string;
  readonly version: string;
  readonly position: CitationPosition;
  readonly confidence: number;
  readonly label?: string;
}

/**
 * A response segment with attached citations.
 */
export interface CitedResponseSegment {
  readonly segmentId: string;
  readonly content: string;
  readonly citations: readonly Citation[];
}
