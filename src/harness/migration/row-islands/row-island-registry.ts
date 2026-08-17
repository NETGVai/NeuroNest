/**
 * Row Island Registry — Coordinates tool and turn-status row islands
 * with a safe generic fallback.
 *
 * The registry is the single dispatch point for the strangler migration.
 * It routes legacy tool cards and turn status indicators through their
 * respective typed row island adapters. If an input cannot be handled
 * (malformed data, missing intent, unrecognized format), the safe
 * generic fallback produces a bounded, sanitized, accessible output.
 *
 * This module does NOT branch on tool names — all rendering dispatch
 * is through intent.kind or row island kind.
 *
 * Requirements: 13.8, 35.3–35.6, 35.11, 36.1–36.17, 37.1–37.17
 */

import { ToolRowIslandAdapter, toolRowIsland } from './tool-row-island';
import { TurnStatusRowIslandAdapter, turnStatusRowIsland } from './turn-status-row-island';
import { CollaborationRowIslandAdapter, collaborationRowIsland } from './collaboration-row-island';
import { QueueDockRowIslandAdapter, queueDockRowIsland } from './queue-dock-row-island';
import { AttachmentRowIslandAdapter, attachmentRowIsland } from './attachment-row-island';
import { sanitizeContent } from '../../presentation/sanitize';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type { CanonicalToolValueV1 } from '../../contracts/tool-value';
import type {
  RowIslandKind,
  RowIslandOutput,
  ToolRowIslandInput,
  TurnStatusRowIslandInput,
  CollaborationRowIslandInput,
  QueueDockRowIslandInput,
  AttachmentRowIslandInput,
  LegacyToolCardData,
  LegacyTurnStatusData,
  LegacyCollaborationData,
  LegacyQueueEntryData,
  LegacyAttachmentData,
} from './types';

// ─── Row Input Discriminator ────────────────────────────────────

/**
 * A discriminated input to the row island registry.
 * The `rowKind` field determines which adapter handles the input.
 */
export type RowIslandDispatchInput =
  | { rowKind: 'tool'; input: ToolRowIslandInput }
  | { rowKind: 'turn_status'; input: TurnStatusRowIslandInput }
  | { rowKind: 'collaboration'; input: CollaborationRowIslandInput }
  | { rowKind: 'queue_dock'; input: QueueDockRowIslandInput }
  | { rowKind: 'attachment'; input: AttachmentRowIslandInput }
  | { rowKind: 'legacy_tool'; input: LegacyToolCardData; callId: string }
  | { rowKind: 'legacy_turn_status'; input: LegacyTurnStatusData; turnId: string }
  | { rowKind: 'legacy_collaboration'; input: LegacyCollaborationData; collaborationId: string }
  | { rowKind: 'legacy_queue_entry'; input: LegacyQueueEntryData; entryId: string }
  | { rowKind: 'legacy_attachment'; input: LegacyAttachmentData; attachmentId: string };

// ─── Safe Generic Fallback ──────────────────────────────────────

/** Maximum content for fallback rendering. */
const FALLBACK_MAX_CHARS = 3_000;

/**
 * Produce a safe generic fallback row island output.
 *
 * Used when:
 * - The input cannot be classified into tool or turn_status
 * - Input data is malformed or missing required fields
 * - An error occurs during typed dispatch
 *
 * Never evaluates tool names. Produces bounded, sanitized, accessible output.
 */
function renderGenericFallback(
  content: unknown,
  reason: string,
  stableKey: string,
): RowIslandOutput {
  let rawContent: string;
  if (typeof content === 'string') {
    rawContent = content;
  } else if (content != null) {
    try {
      rawContent = JSON.stringify(content, null, 2);
    } catch {
      rawContent = '[unserializable content]';
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
    accessibilityLabel: `Row content (fallback: ${reason})`,
    expandable: truncated,
    truncated,
    metadata: {
      fallbackReason: reason,
    },
  }];

  const presentation: PresentationOutput = {
    dispatchedKind: 'fallback',
    blocks,
    isFallback: true,
    sanitizationReasons: sanitized.reasons,
    callId: stableKey,
  };

  return {
    islandKind: 'fallback',
    presentation,
    stableKey: `fallback:${stableKey}`,
    accessibilityLabel: `Content (${reason})`,
    usedFallback: true,
  };
}

// ─── Row Island Registry ────────────────────────────────────────

/**
 * Registry and dispatcher for typed row islands.
 *
 * Routes inputs to the appropriate island adapter based on `rowKind`.
 * Wraps dispatch in error handling to ensure the safe generic fallback
 * is used for any unexpected failures.
 */
export class RowIslandRegistry {
  private readonly toolIsland: ToolRowIslandAdapter;
  private readonly turnStatusIsland: TurnStatusRowIslandAdapter;
  private readonly collaborationIsland: CollaborationRowIslandAdapter;
  private readonly queueDockIsland: QueueDockRowIslandAdapter;
  private readonly attachmentIsland: AttachmentRowIslandAdapter;

  constructor(
    toolIsland: ToolRowIslandAdapter = toolRowIsland,
    turnStatusIsland: TurnStatusRowIslandAdapter = turnStatusRowIsland,
    collaborationIsland: CollaborationRowIslandAdapter = collaborationRowIsland,
    queueDockIsland: QueueDockRowIslandAdapter = queueDockRowIsland,
    attachmentIsland: AttachmentRowIslandAdapter = attachmentRowIsland,
  ) {
    this.toolIsland = toolIsland;
    this.turnStatusIsland = turnStatusIsland;
    this.collaborationIsland = collaborationIsland;
    this.queueDockIsland = queueDockIsland;
    this.attachmentIsland = attachmentIsland;
  }

  /**
   * Dispatch a typed or legacy input to the appropriate row island.
   *
   * If dispatch fails for any reason (malformed input, rendering error,
   * unexpected exception), the safe generic fallback is returned.
   *
   * This method never throws.
   */
  dispatch(input: RowIslandDispatchInput): RowIslandOutput {
    try {
      switch (input.rowKind) {
        case 'tool':
          return this.toolIsland.render(input.input);

        case 'turn_status':
          return this.turnStatusIsland.render(input.input);

        case 'collaboration':
          return this.collaborationIsland.render(input.input);

        case 'queue_dock':
          return this.queueDockIsland.render(input.input);

        case 'attachment':
          return this.attachmentIsland.render(input.input);

        case 'legacy_tool': {
          const adapted = this.toolIsland.adaptLegacy(input.input, input.callId);
          return this.toolIsland.render(adapted);
        }

        case 'legacy_turn_status': {
          const adapted = this.turnStatusIsland.adaptLegacy(input.input, input.turnId);
          return this.turnStatusIsland.render(adapted);
        }

        case 'legacy_collaboration': {
          const adapted = this.collaborationIsland.adaptLegacy(input.input, input.collaborationId);
          return this.collaborationIsland.render(adapted);
        }

        case 'legacy_queue_entry': {
          const adapted = this.queueDockIsland.adaptLegacy(input.input, input.entryId);
          return this.queueDockIsland.render(adapted);
        }

        case 'legacy_attachment': {
          const adapted = this.attachmentIsland.adaptLegacy(input.input, input.attachmentId);
          return this.attachmentIsland.render(adapted);
        }

        default:
          return renderGenericFallback(
            null,
            'unknown row kind',
            `unknown-${Date.now()}`,
          );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unexpected error';
      const key = this.extractStableKey(input);
      return renderGenericFallback(null, reason, key);
    }
  }

  /**
   * Dispatch a raw tool rendering input directly. Convenience method
   * that creates the RowIslandDispatchInput wrapper.
   */
  dispatchTool(
    intent: unknown,
    value: CanonicalToolValueV1,
    options?: { toolDisplayName?: string; status?: ToolRowIslandInput['status']; modelOrderIndex?: number },
  ): RowIslandOutput {
    return this.dispatch({
      rowKind: 'tool',
      input: {
        intent,
        value,
        toolDisplayName: options?.toolDisplayName,
        status: options?.status,
        modelOrderIndex: options?.modelOrderIndex,
      },
    });
  }

  /**
   * Dispatch a raw turn status rendering input directly.
   */
  dispatchTurnStatus(input: TurnStatusRowIslandInput): RowIslandOutput {
    return this.dispatch({
      rowKind: 'turn_status',
      input,
    });
  }

  /**
   * Dispatch a collaboration input directly.
   */
  dispatchCollaboration(input: CollaborationRowIslandInput): RowIslandOutput {
    return this.dispatch({
      rowKind: 'collaboration',
      input,
    });
  }

  /**
   * Dispatch a queue dock entry input directly.
   */
  dispatchQueueDock(input: QueueDockRowIslandInput): RowIslandOutput {
    return this.dispatch({
      rowKind: 'queue_dock',
      input,
    });
  }

  /**
   * Dispatch an attachment input directly.
   */
  dispatchAttachment(input: AttachmentRowIslandInput): RowIslandOutput {
    return this.dispatch({
      rowKind: 'attachment',
      input,
    });
  }

  /**
   * Render using the safe generic fallback explicitly.
   * Used when the caller knows the content should use fallback rendering.
   */
  dispatchFallback(content: unknown, reason: string, stableKey: string): RowIslandOutput {
    return renderGenericFallback(content, reason, stableKey);
  }

  /**
   * Get the list of supported row island kinds.
   */
  getSupportedKinds(): ReadonlyArray<RowIslandKind> {
    return ['tool', 'turn_status', 'collaboration', 'queue_dock', 'attachment', 'fallback'];
  }

  /**
   * Extract a best-effort stable key from a dispatch input.
   */
  private extractStableKey(input: RowIslandDispatchInput): string {
    switch (input.rowKind) {
      case 'tool':
        return input.input.value.callId;
      case 'turn_status':
        return input.input.turnId;
      case 'collaboration':
        return input.input.collaborationId;
      case 'queue_dock':
        return input.input.entryId;
      case 'attachment':
        return input.input.attachmentId;
      case 'legacy_tool':
        return input.callId;
      case 'legacy_turn_status':
        return input.turnId;
      case 'legacy_collaboration':
        return input.collaborationId;
      case 'legacy_queue_entry':
        return input.entryId;
      case 'legacy_attachment':
        return input.attachmentId;
      default:
        return `unknown-${Date.now()}`;
    }
  }
}

/**
 * Default registry instance. Safe to use as a singleton since
 * all row islands are stateless pure adapters.
 */
export const rowIslandRegistry = new RowIslandRegistry();
