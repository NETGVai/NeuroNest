/**
 * Typed Presentation Dispatch
 *
 * Dispatches tool result rendering based exclusively on RenderIntentV1.kind
 * plus CanonicalToolValueV1. Never branches on tool names.
 *
 * Invalid or unsupported intents produce the safe generic fallback without
 * evaluating the tool name. The fallback renders correlation identity,
 * bounded output, and permitted status.
 *
 * Requirements: 13.8, 35.5–35.6, 35.11–35.13, 37.5–37.6
 */

import { parseRenderIntent } from '../contracts/render-intent';
import type { CanonicalToolValueV1 } from '../contracts/tool-value';
import type { PresentationOutput, ContentBlock } from './types';
import { sanitizeContent } from './sanitize';
import {
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

// ─── Renderer Registry ──────────────────────────────────────────

/**
 * Internal renderer entry — erases the specific kind type for the registry.
 * Dispatch narrows the intent before calling.
 */
interface RendererEntry {
  readonly kind: string;
  render(intent: never, value: CanonicalToolValueV1): PresentationOutput;
}

/**
 * Registry mapping intent kinds to their typed renderers.
 * This is the sole dispatch mechanism; tool names are never consulted.
 */
const RENDERER_REGISTRY: Record<string, RendererEntry> = {
  generic: genericRenderer,
  read: readRenderer,
  search: searchRenderer,
  diff: diffRenderer,
  terminal: terminalRenderer,
  web: webRenderer,
  image: imageRenderer,
  table: tableRenderer,
  tree: treeRenderer,
  artifact: artifactRenderer,
};

// ─── Safe Generic Fallback ──────────────────────────────────────

/** Maximum content bytes for the fallback card. */
const FALLBACK_MAX_CHARS = 5_000;

/**
 * Produce a safe generic fallback presentation. Used when the intent
 * is invalid, unsupported, or cannot be parsed. Never evaluates tool names.
 *
 * Renders: permitted status, bounded output, and correlation identity.
 */
function renderFallback(
  value: CanonicalToolValueV1,
  reason: string,
): PresentationOutput {
  let rawContent: string;
  if (typeof value.value === 'string') {
    rawContent = value.value;
  } else if (value.value != null) {
    try {
      rawContent = JSON.stringify(value.value, null, 2);
    } catch {
      rawContent = '[unserializable value]';
    }
  } else {
    rawContent = '';
  }

  const sanitized = sanitizeContent(rawContent);
  const truncated = sanitized.text.length > FALLBACK_MAX_CHARS;
  const displayText = truncated
    ? sanitized.text.slice(0, FALLBACK_MAX_CHARS)
    : sanitized.text;

  const blocks: ContentBlock[] = [{
    kind: 'generic_card',
    content: displayText,
    accessibilityLabel: `Tool result (${value.callId})`,
    expandable: truncated,
    truncated,
    metadata: {
      callId: value.callId,
      fallbackReason: reason,
      mediaType: value.mediaType,
    },
  }];

  return {
    dispatchedKind: 'fallback',
    blocks,
    isFallback: true,
    sanitizationReasons: sanitized.reasons,
    callId: value.callId,
  };
}

// ─── Public Dispatch ────────────────────────────────────────────

/**
 * Dispatch presentation rendering for a tool result.
 *
 * Dispatches exclusively on `RenderIntentV1.kind` + `CanonicalToolValueV1`.
 * Never branches on tool names.
 *
 * If the intent is invalid or unsupported, returns the safe generic
 * fallback without evaluating the tool name.
 *
 * @param rawIntent - The render intent (possibly invalid or unknown kind)
 * @param value - The validated canonical tool value
 * @returns A PresentationOutput describing how to render the content
 */
export function dispatchPresentation(
  rawIntent: unknown,
  value: CanonicalToolValueV1,
): PresentationOutput {
  // Parse the intent at the boundary
  const parseResult = parseRenderIntent(rawIntent);

  if (!parseResult.ok) {
    // Invalid or unsupported intent -> safe generic fallback
    return renderFallback(value, parseResult.reason);
  }

  const intent = parseResult.intent;
  const renderer = RENDERER_REGISTRY[intent.kind];

  if (!renderer) {
    // Kind parsed but no renderer registered (should not happen with closed union)
    return renderFallback(value, `no renderer for kind: ${intent.kind}`);
  }

  // Dispatch to the typed renderer — it receives the narrowed intent type
  return renderer.render(intent as never, value);
}

/**
 * Get the list of supported intent kinds.
 * UI layers can use this to determine which kinds have dedicated renderers.
 */
export function getSupportedIntentKinds(): ReadonlyArray<string> {
  return Object.keys(RENDERER_REGISTRY);
}
