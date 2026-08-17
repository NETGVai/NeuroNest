/**
 * Tool Row Island — Typed adapter for tool card rendering.
 *
 * Routes existing Markdown/code/diff/diagram/image helpers through pure
 * typed presentation adapters. Dispatches exclusively on Render_Intent.kind
 * plus Canonical_Tool_Value, never on tool names.
 *
 * Replaces legacy DOM-based tool cards (`.ce-tool-card`) with typed
 * PresentationOutput blocks while retaining all existing visible
 * capabilities through the intent renderer registry.
 *
 * Requirements: 13.8, 35.3–35.6, 35.11, 37.1–37.17
 */

import { dispatchPresentation } from '../../presentation/dispatch';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type { CanonicalToolValueV1 } from '../../contracts/tool-value';
import { sanitizeContent } from '../../presentation/sanitize';
import type {
  RowIsland,
  RowIslandOutput,
  ToolRowIslandInput,
  LegacyToolCardData,
} from './types';

// ─── Status Labels ──────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  executing: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  retrying: 'Retrying',
};

const STATUS_ACCESSIBILITY: Record<string, string> = {
  executing: 'Tool is currently executing',
  completed: 'Tool execution completed successfully',
  failed: 'Tool execution failed',
  cancelled: 'Tool execution was cancelled',
  retrying: 'Tool execution is being retried',
};

// ─── Tool Row Island Implementation ─────────────────────────────

/**
 * Typed tool row island adapter.
 *
 * Routes tool result rendering through the typed presentation dispatch
 * layer (Render_Intent.kind + Canonical_Tool_Value). Never branches on
 * tool names — the tool display name is metadata only.
 *
 * Produces RowIslandOutput with a stable key derived from the immutable
 * callId, ensuring timeline identity stability.
 */
export class ToolRowIslandAdapter implements RowIsland<ToolRowIslandInput> {
  readonly kind = 'tool' as const;

  /**
   * Render a tool result through typed presentation dispatch.
   *
   * Dispatches on intent.kind exclusively. The tool display name is
   * included in accessibility labels but never drives renderer selection.
   */
  render(input: ToolRowIslandInput): RowIslandOutput {
    const { intent, value, toolDisplayName, status } = input;

    // Dispatch exclusively on intent.kind + canonical value
    const presentation = dispatchPresentation(intent, value);

    // Enrich with status information if available
    const enrichedPresentation = this.enrichWithStatus(presentation, status);

    // Build accessibility label from intent kind and status
    const statusLabel = status ? STATUS_LABELS[status] || status : '';
    const displayName = toolDisplayName || 'Tool';
    const accessibilityLabel = statusLabel
      ? `${displayName}: ${statusLabel}`
      : displayName;

    return {
      islandKind: 'tool',
      presentation: enrichedPresentation,
      stableKey: `tool-row:${value.callId}`,
      accessibilityLabel,
      usedFallback: presentation.isFallback,
    };
  }

  /**
   * Adapt a legacy tool card to a ToolRowIslandInput.
   *
   * This compatibility method converts legacy tool card data into the
   * typed input format. It infers a generic intent (since legacy cards
   * did not carry typed intents) and wraps the raw output into a
   * canonical tool value structure.
   *
   * The legacy toolName is ONLY used for the display name; it is never
   * used for rendering dispatch.
   */
  adaptLegacy(legacy: LegacyToolCardData, callId: string): ToolRowIslandInput {
    // Legacy cards do not carry typed intents — use generic
    const intent = {
      kind: 'generic' as const,
      label: legacy.toolName,
    };

    // Wrap raw output into a minimal canonical tool value
    const value: CanonicalToolValueV1 = {
      canonicalValueId: `legacy-${callId}`,
      callId,
      toolContract: { name: legacy.toolName, version: '0.0.0' },
      mediaType: 'text/plain',
      value: legacy.rawOutput ?? '',
      valueDigest: `sha256:legacy-${callId}`,
      retention: { policy: 'session' },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    return {
      intent,
      value,
      toolDisplayName: legacy.toolName,
      status: 'completed',
    };
  }

  /**
   * Enrich presentation output with status metadata.
   * Status information is appended as metadata to the first block
   * without altering the rendered content.
   */
  private enrichWithStatus(
    presentation: PresentationOutput,
    status?: string,
  ): PresentationOutput {
    if (!status || presentation.blocks.length === 0) {
      return presentation;
    }

    // Add status metadata to the first content block
    const firstBlock = presentation.blocks[0];
    const enrichedBlock: ContentBlock = {
      ...firstBlock,
      metadata: {
        ...firstBlock.metadata,
        callStatus: status,
        statusLabel: STATUS_LABELS[status] || status,
        statusAccessibility: STATUS_ACCESSIBILITY[status] || `Tool is ${status}`,
      },
    };

    return {
      ...presentation,
      blocks: [enrichedBlock, ...presentation.blocks.slice(1)],
    };
  }
}

/**
 * Singleton instance for convenience. Tool row islands are stateless
 * pure adapters so a single instance is safe.
 */
export const toolRowIsland = new ToolRowIslandAdapter();
