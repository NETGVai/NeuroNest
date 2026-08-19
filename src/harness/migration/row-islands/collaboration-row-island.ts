/**
 * Collaboration Row Island — Typed adapter for collaboration takeover rendering.
 *
 * Renders projected collaboration contracts (questions, approvals, plan reviews)
 * as typed row islands in the Canonical_Timeline. Connects CollaborationTakeoverStore
 * to projection/command ports, maintaining authority ownership for all mutations.
 *
 * Key design:
 * - Routes through Collaboration_Service projection/command ports (never directly mutates state)
 * - Preserves old-session readability (legacy sessions can still display these items)
 * - Maintains authority ownership (decisions go through Collaboration_Service)
 * - Dispatches on collaboration kind, never on arbitrary string matching
 *
 * Requirements: 38.1–38.16
 */

import { sanitizeContent } from '../../presentation/sanitize';
import type { PresentationOutput, ContentBlock } from '../../presentation/types';
import type {
  RowIsland,
  RowIslandOutput,
  CollaborationRowIslandInput,
  LegacyCollaborationData,
} from './types';

// ─── Status Labels ──────────────────────────────────────────────

const COLLABORATION_KIND_LABELS: Record<string, string> = {
  question: 'Question',
  approval: 'Approval Request',
  plan_review: 'Plan Review',
};

const TAKEOVER_STATUS_LABELS: Record<string, string> = {
  active: 'Awaiting Decision',
  submitting: 'Submitting Decision',
  committed: 'Decision Committed',
  expired: 'Expired',
  superseded: 'Superseded',
  unavailable: 'Authority Unavailable',
  rejected: 'Decision Rejected',
};

const TAKEOVER_STATUS_ACCESSIBILITY: Record<string, string> = {
  active: 'Awaiting your decision',
  submitting: 'Decision is being submitted, awaiting confirmation',
  committed: 'Decision has been committed successfully',
  expired: 'This collaboration contract has expired',
  superseded: 'This contract has been superseded by a newer version',
  unavailable: 'The owning authority is currently unavailable',
  rejected: 'The decision was rejected',
};

// ─── Block Builders ─────────────────────────────────────────────

/**
 * Builds the primary collaboration content block.
 */
function buildCollaborationBlock(input: CollaborationRowIslandInput): ContentBlock {
  const kindLabel = COLLABORATION_KIND_LABELS[input.kind] || input.kind;
  const statusLabel = TAKEOVER_STATUS_LABELS[input.status] || input.status;

  const contentLines: string[] = [
    `**${kindLabel}** from ${input.owner}`,
    '',
    input.displayText,
  ];

  if (input.riskSummary) {
    contentLines.push('', `Risk: ${input.riskSummary}`);
  }

  if (input.changeSummary) {
    contentLines.push('', `Changes: ${input.changeSummary}`);
  }

  if (input.expiresAt) {
    contentLines.push('', `Expires: ${input.expiresAt}`);
  }

  const sanitized = sanitizeContent(contentLines.join('\n'));

  return {
    kind: 'generic_card',
    content: sanitized.text,
    accessibilityLabel: `${kindLabel}: ${input.displayText}. Status: ${statusLabel}`,
    expandable: sanitized.text.length > 500,
    truncated: false,
    metadata: {
      collaborationKind: input.kind,
      collaborationId: input.collaborationId,
      status: input.status,
      statusLabel,
      owner: input.owner,
      revision: input.revision,
      authorityAvailable: input.authorityAvailable,
      sourceProjectionRevision: input.sourceProjectionRevision,
    },
  };
}

/**
 * Builds a status/action indicator block.
 */
function buildStatusBlock(input: CollaborationRowIslandInput): ContentBlock {
  const statusLabel = TAKEOVER_STATUS_LABELS[input.status] || input.status;
  const statusAccessibility = TAKEOVER_STATUS_ACCESSIBILITY[input.status] || input.status;

  const actionsText = input.availableActions.length > 0
    ? `Available actions: ${input.availableActions.join(', ')}`
    : 'No actions available';

  const unavailableText = !input.authorityAvailable
    ? ' (authority unavailable)'
    : '';

  return {
    kind: 'generic_card',
    content: `${statusLabel}${unavailableText}. ${actionsText}`,
    accessibilityLabel: `${statusAccessibility}. ${actionsText}${unavailableText}`,
    metadata: {
      isStatusBlock: true,
      availableActions: input.availableActions,
      authorityAvailable: input.authorityAvailable,
    },
  };
}

/**
 * Builds a plan review detail block.
 */
function buildPlanReviewBlock(input: CollaborationRowIslandInput): ContentBlock | null {
  if (input.kind !== 'plan_review' || !input.planRevisionId) return null;

  const content = `Plan Revision: ${input.planRevisionId}`;

  return {
    kind: 'generic_card',
    content,
    accessibilityLabel: `Plan review for revision ${input.planRevisionId}`,
    metadata: {
      isPlanReviewDetail: true,
      planRevisionId: input.planRevisionId,
    },
  };
}

// ─── Collaboration Row Island Implementation ────────────────────

/**
 * Typed collaboration row island adapter.
 *
 * Renders collaboration takeover contracts as typed row islands.
 * Routes through projection/command ports — never mutates
 * Collaboration_Service state directly.
 *
 * Produces RowIslandOutput keyed by collaborationId for stable
 * timeline identity. Supports legacy collaboration data from
 * older sessions.
 */
export class CollaborationRowIslandAdapter implements RowIsland<CollaborationRowIslandInput> {
  readonly kind = 'collaboration' as const;

  /**
   * Render a collaboration contract as a typed row island.
   *
   * Dispatches on collaboration kind (question, approval, plan_review).
   * Includes status, available actions, and authority availability.
   */
  render(input: CollaborationRowIslandInput): RowIslandOutput {
    const blocks: ContentBlock[] = [];

    // Primary content block
    blocks.push(buildCollaborationBlock(input));

    // Status and action block
    blocks.push(buildStatusBlock(input));

    // Plan review detail (only for plan_review kind)
    const planBlock = buildPlanReviewBlock(input);
    if (planBlock) blocks.push(planBlock);

    const kindLabel = COLLABORATION_KIND_LABELS[input.kind] || input.kind;
    const statusLabel = TAKEOVER_STATUS_LABELS[input.status] || input.status;
    const accessibilityLabel = `${kindLabel} from ${input.owner}: ${input.displayText}. Status: ${statusLabel}`;

    const presentation: PresentationOutput = {
      dispatchedKind: 'generic',
      blocks,
      isFallback: false,
      sanitizationReasons: [],
      callId: input.collaborationId,
    };

    return {
      islandKind: 'collaboration',
      presentation,
      stableKey: input.canonicalStableKey,
      accessibilityLabel,
      usedFallback: false,
    };
  }

  /**
   * Adapt a legacy collaboration item to a CollaborationRowIslandInput.
   *
   * Maps older session collaboration records into the typed input format.
   * Preserves readability for old sessions by inferring kind and status.
   *
   * For legacy data, generates a deterministic key since no canonical projection
   * existed. New projections MUST supply the canonical stable key directly.
   */
  adaptLegacy(legacy: LegacyCollaborationData, collaborationId: string, canonicalStableKey?: string): CollaborationRowIslandInput {
    // Infer kind from type string
    const kind = inferCollaborationKind(legacy.type);

    // Infer status
    const status = legacy.resolved ? 'committed' : 'active';

    // Use provided canonical key or generate a legacy-compat key
    const stableKey = canonicalStableKey || `legacy-collab:${collaborationId}`;

    return {
      collaborationId,
      canonicalStableKey: stableKey,
      kind,
      displayText: legacy.description || 'Collaboration item',
      owner: legacy.owner || 'unknown',
      revision: 1,
      sessionId: '',
      turnId: '',
      status,
      availableActions: legacy.resolved ? [] : ['approve', 'deny'],
      authorityAvailable: true,
      sourceProjectionRevision: 0,
    };
  }
}

/**
 * Infer collaboration kind from a legacy type string.
 */
function inferCollaborationKind(type: string): 'question' | 'approval' | 'plan_review' {
  const normalized = (type || '').toLowerCase().trim();
  if (normalized.includes('question') || normalized.includes('ask')) return 'question';
  if (normalized.includes('plan')) return 'plan_review';
  return 'approval';
}

/**
 * Singleton instance. Collaboration row islands are stateless pure adapters.
 */
export const collaborationRowIsland = new CollaborationRowIslandAdapter();
