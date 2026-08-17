/**
 * Queue Dock Row Island — Typed adapter for queue entry rendering.
 *
 * Renders projected queue entries (follow-up, steer, inject) as typed row
 * islands in the Canonical_Timeline. Connects Queue_Dock projections to
 * authority-routed Turn_Controller command ports.
 *
 * Key design:
 * - Routes every mutation through Turn_Controller (never mutates queue state directly)
 * - Preserves old-session readability (legacy sessions can still display queue items)
 * - Maintains authority ownership (all mutations go through Turn_Controller)
 * - Dispatches on queue type, preserves stable entry identity
 *
 * Requirements: 39.1–39.18
 */

import { sanitizeContent } from '../../presentation/sanitize';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type {
  RowIsland,
  RowIslandOutput,
  QueueDockRowIslandInput,
  LegacyQueueEntryData,
} from './types';

// ─── Queue Type Labels ──────────────────────────────────────────

const QUEUE_TYPE_LABELS: Record<string, string> = {
  follow_up: 'Follow-up',
  steer: 'Steering',
  inject: 'Injected',
};

const DELIVERY_STATE_LABELS: Record<string, string> = {
  queued: 'Queued',
  delivering: 'Delivering',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const DELIVERY_STATE_ACCESSIBILITY: Record<string, string> = {
  queued: 'Entry is queued for delivery',
  delivering: 'Entry is being delivered to the turn',
  delivered: 'Entry has been delivered',
  cancelled: 'Entry was cancelled',
};

// ─── Block Builders ─────────────────────────────────────────────

/**
 * Builds the primary queue entry content block.
 */
function buildEntryContentBlock(input: QueueDockRowIslandInput): ContentBlock {
  const typeLabel = QUEUE_TYPE_LABELS[input.queueType] || input.queueType;
  const deliveryLabel = DELIVERY_STATE_LABELS[input.deliveryState] || input.deliveryState;
  const posLabel = `#${input.position + 1}`;

  const sanitized = sanitizeContent(input.content);

  return {
    kind: 'generic_card',
    content: sanitized.text,
    accessibilityLabel: `${typeLabel} entry ${posLabel}: ${sanitized.text.slice(0, 100)}. Delivery: ${deliveryLabel}`,
    expandable: sanitized.text.length > 500,
    truncated: sanitized.text.length > 500,
    metadata: {
      queueType: input.queueType,
      queueTypeLabel: typeLabel,
      entryId: input.entryId,
      revision: input.revision,
      position: input.position,
      owner: input.owner,
      deliveryState: input.deliveryState,
      deliveryStateLabel: deliveryLabel,
      sourceProjectionRevision: input.sourceProjectionRevision,
    },
  };
}

/**
 * Builds the entry status/metadata block.
 */
function buildEntryStatusBlock(input: QueueDockRowIslandInput): ContentBlock {
  const deliveryLabel = DELIVERY_STATE_LABELS[input.deliveryState] || input.deliveryState;
  const deliveryAccess = DELIVERY_STATE_ACCESSIBILITY[input.deliveryState] || input.deliveryState;

  const parts: string[] = [deliveryLabel];

  if (input.mutationPending) {
    parts.push('(mutation pending)');
  }

  if (!input.authorityAvailable) {
    parts.push('(authority unavailable)');
  }

  if (input.subagentIncompatibilityReason) {
    parts.push(`(${input.subagentIncompatibilityReason})`);
  }

  return {
    kind: 'generic_card',
    content: parts.join(' '),
    accessibilityLabel: `${deliveryAccess}${input.mutationPending ? ', mutation pending' : ''}${!input.authorityAvailable ? ', authority unavailable' : ''}`,
    metadata: {
      isStatusBlock: true,
      mutationPending: input.mutationPending,
      authorityAvailable: input.authorityAvailable,
      subagentIncompatibilityReason: input.subagentIncompatibilityReason,
    },
  };
}

// ─── Queue Dock Row Island Implementation ───────────────────────

/**
 * Typed queue dock row island adapter.
 *
 * Renders projected queue entries as typed row islands.
 * Routes through Turn_Controller projection/command ports — never
 * mutates queue state directly.
 *
 * Produces RowIslandOutput keyed by entryId for stable timeline identity.
 * Supports legacy queue entries from older sessions.
 */
export class QueueDockRowIslandAdapter implements RowIsland<QueueDockRowIslandInput> {
  readonly kind = 'queue_dock' as const;

  /**
   * Render a queue entry as a typed row island.
   *
   * Dispatches on queue type (follow_up, steer, inject).
   * Includes delivery state, mutation status, and authority availability.
   */
  render(input: QueueDockRowIslandInput): RowIslandOutput {
    const blocks: ContentBlock[] = [];

    // Primary content block
    blocks.push(buildEntryContentBlock(input));

    // Status block (only when there's meaningful status beyond 'queued')
    if (
      input.deliveryState !== 'queued' ||
      input.mutationPending ||
      !input.authorityAvailable ||
      input.subagentIncompatibilityReason
    ) {
      blocks.push(buildEntryStatusBlock(input));
    }

    const typeLabel = QUEUE_TYPE_LABELS[input.queueType] || input.queueType;
    const deliveryLabel = DELIVERY_STATE_LABELS[input.deliveryState] || input.deliveryState;
    const posLabel = `position ${input.position + 1}`;
    const accessibilityLabel = `${typeLabel} entry ${posLabel}: ${deliveryLabel}`;

    const presentation: PresentationOutput = {
      dispatchedKind: 'generic',
      blocks,
      isFallback: false,
      sanitizationReasons: [],
      callId: input.entryId,
    };

    return {
      islandKind: 'queue_dock',
      presentation,
      stableKey: `queue-dock:${input.entryId}`,
      accessibilityLabel,
      usedFallback: false,
    };
  }

  /**
   * Adapt a legacy queue entry to a QueueDockRowIslandInput.
   *
   * Maps older session queue records into the typed input format.
   * Preserves readability for old sessions by inferring type and state.
   */
  adaptLegacy(legacy: LegacyQueueEntryData, entryId: string): QueueDockRowIslandInput {
    const queueType = inferQueueType(legacy.type);
    const deliveryState = legacy.delivered ? 'delivered' : 'queued';

    return {
      entryId,
      queueType,
      revision: 1,
      position: 0,
      owner: 'user',
      deliveryState,
      content: legacy.content || '',
      sessionId: '',
      turnId: '',
      sourceProjectionRevision: 0,
      mutationPending: false,
      authorityAvailable: true,
    };
  }
}

/**
 * Infer queue type from a legacy type string.
 */
function inferQueueType(type?: string): 'follow_up' | 'steer' | 'inject' {
  const normalized = (type || '').toLowerCase().trim();
  if (normalized.includes('steer')) return 'steer';
  if (normalized.includes('inject') || normalized.includes('system')) return 'inject';
  return 'follow_up';
}

/**
 * Singleton instance. Queue dock row islands are stateless pure adapters.
 */
export const queueDockRowIsland = new QueueDockRowIslandAdapter();
