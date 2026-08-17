/**
 * Presentation Types
 *
 * Types for the typed presentation dispatch layer. Renderers produce
 * PresentationOutput which describes how content should be shown in
 * the Chat_Interface without coupling to a specific UI framework.
 *
 * Local state is limited to focus, disclosure, measurement, and
 * pending-envelope concerns.
 *
 * Requirements: 13.8, 35.5–35.6, 35.11–35.13, 37.5–37.6
 */

import type { RenderIntentV1 } from '../contracts/render-intent';
import type { CanonicalToolValueV1 } from '../contracts/tool-value';

// ─── Presentation Output ────────────────────────────────────────

/**
 * The kind of content block produced by a renderer.
 * Each kind maps to a distinct presentation component.
 */
export type ContentBlockKind =
  | 'markdown'
  | 'code'
  | 'diff'
  | 'diagram'
  | 'image'
  | 'table'
  | 'tree'
  | 'terminal'
  | 'web_citation'
  | 'search_results'
  | 'artifact'
  | 'generic_card'
  | 'error_card';

/**
 * A single content block within a presentation output.
 */
export interface ContentBlock {
  kind: ContentBlockKind;
  /** Sanitized text or structured data for the block. */
  content: string;
  /** Language hint for code/diff blocks. */
  language?: string;
  /** Accessibility label for the block. */
  accessibilityLabel: string;
  /** Whether this block is expandable (long content). */
  expandable?: boolean;
  /** Whether the content was truncated. */
  truncated?: boolean;
  /** Additional metadata for specialized renderers. */
  metadata?: Record<string, unknown>;
}

/**
 * The output of a presentation renderer. Contains one or more content
 * blocks and status information.
 */
export interface PresentationOutput {
  /** The intent kind that was dispatched to produce this output. */
  dispatchedKind: RenderIntentV1['kind'] | 'fallback';
  /** The content blocks to render. */
  blocks: ContentBlock[];
  /** Whether this presentation used the safe generic fallback. */
  isFallback: boolean;
  /** Reasons sanitization was applied (empty if content was clean). */
  sanitizationReasons: string[];
  /** Correlation identity from the Canonical_Tool_Value. */
  callId: string;
}

// ─── Renderer Interface ─────────────────────────────────────────

/**
 * A typed renderer that handles one specific RenderIntentV1 kind.
 * Renderers are pure functions of intent + value; they must not branch
 * on tool names or access mutable global state.
 */
export interface IntentRenderer<K extends RenderIntentV1['kind'] = RenderIntentV1['kind']> {
  /** The intent kind this renderer handles. */
  readonly kind: K;
  /** Render the intent and tool value into presentation output. */
  render(intent: Extract<RenderIntentV1, { kind: K }>, value: CanonicalToolValueV1): PresentationOutput;
}

// ─── Local UI State (ephemeral only) ────────────────────────────

/**
 * Ephemeral local state that the presentation layer may hold.
 * This is limited to focus, disclosure, measurement, and
 * pending-envelope concerns per the design.
 */
export interface PresentationLocalState {
  /** Whether a collapsible section is expanded. */
  disclosed: boolean;
  /** Whether this item currently has focus. */
  focused: boolean;
  /** Measured row height in device-independent pixels. */
  measuredHeight?: number;
  /** Pending command envelope ID (for optimistic display). */
  pendingEnvelopeId?: string;
}

/**
 * Input to the presentation dispatch. Carries an intent (possibly
 * invalid/unsupported) and the canonical tool value.
 */
export interface PresentationInput {
  /** Raw intent data to be parsed and dispatched. */
  intent: unknown;
  /** Validated canonical tool value. */
  value: CanonicalToolValueV1;
}
