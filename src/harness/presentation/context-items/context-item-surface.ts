/**
 * Context Item Surface
 *
 * Implements typed Context_Item chip rendering, asynchronous resolution guards,
 * provenance/staleness/token/status/actions exposure, and route-capacity impact
 * calculation for the Composer_Workbench.
 *
 * Chips are rendered from structured typed identity — display labels are never
 * reparsed as source identities. Asynchronous settlements are guarded by
 * (draftId, originRevision, exactRange, requestId) tuples. Route-capacity
 * impact is updated before submission.
 *
 * Requirements: 40.2, 40.4–40.9, 40.16–40.22
 */

import { z } from 'zod';
import { IdentifierSchema } from '../../contracts/primitives';

// ─── Context Item Kind ──────────────────────────────────────────

/**
 * Closed set of supported Context_Item kinds.
 * Chips are rendered by kind without reparsing labels (Requirement 40.2).
 */
export const ContextItemKindSchema = z.enum([
  'file',
  'folder',
  'range',
  'symbol',
  'diagnostic',
  'terminal',
  'git',
  'planning',
  'run',
  'artifact',
  'image',
  'url',
]);

export type ContextItemKind = z.infer<typeof ContextItemKindSchema>;

// ─── Provenance ─────────────────────────────────────────────────

/**
 * Provenance source indicating how this item was added (Requirement 40.7).
 */
export const ProvenanceSourceSchema = z.enum([
  'explicit',
  'suggested',
  'mandatory',
  'injected',
  'inherited',
]);

export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

// ─── Staleness ──────────────────────────────────────────────────

/**
 * Staleness state of a Context_Item (Requirement 40.7).
 */
export const StalenessStateSchema = z.enum([
  'current',
  'stale',
  'unavailable',
  'refreshing',
]);

export type StalenessState = z.infer<typeof StalenessStateSchema>;

// ─── Item Inclusion Status ──────────────────────────────────────

/**
 * Inclusion status for a Context_Item (Requirement 40.7).
 * Determines how the item participates in the submitted context.
 */
export const ItemInclusionStatusSchema = z.enum([
  'included',
  'unavailable',
  'redacted',
  'omitted',
  'condensed',
]);

export type ItemInclusionStatus = z.infer<typeof ItemInclusionStatusSchema>;

// ─── Authority Actions ──────────────────────────────────────────

/**
 * Controls available for a Context_Item per owning-authority policy
 * (Requirement 40.8). Actions may be disabled with a reason (Requirement 40.16).
 */
export const AuthorityActionSchema = z.object({
  actionId: z.enum(['inspect', 'pin', 'unpin', 'refresh', 'remove', 'redact']),
  available: z.boolean(),
  /** Authority-derived reason when unavailable (Requirement 40.16). */
  unavailableReason: z.string().optional(),
});

export type AuthorityAction = z.infer<typeof AuthorityActionSchema>;

// ─── Async Resolution Guard ─────────────────────────────────────

/**
 * Settlement guard captures (draftId, originRevision, exactRange, requestId).
 * An async resolution may settle only if ALL fields still match the current
 * draft state (Requirements 40.4, 40.20).
 */
export const ResolutionGuardSchema = z.object({
  draftId: IdentifierSchema,
  originRevision: z.number().int().nonnegative(),
  exactRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  requestId: IdentifierSchema,
});

export type ResolutionGuard = z.infer<typeof ResolutionGuardSchema>;

// ─── Resolution State ───────────────────────────────────────────

/**
 * Resolution lifecycle state for async context items (Requirement 40.5, 40.6).
 */
export const ResolutionStateSchema = z.enum([
  'pending',
  'resolving',
  'resolved',
  'cancelled',
  'failed',
  'stale',
  'superseded',
]);

export type ResolutionState = z.infer<typeof ResolutionStateSchema>;

// ─── Resolution Failure ─────────────────────────────────────────

/**
 * Typed failure information with authority-eligible recovery actions
 * (Requirement 40.22).
 */
export const ResolutionFailureSchema = z.object({
  reason: z.string().min(1),
  failedItemId: IdentifierSchema,
  eligibleActions: z.array(z.enum(['retry', 'refresh', 'remove', 'redact'])),
});

export type ResolutionFailure = z.infer<typeof ResolutionFailureSchema>;

// ─── Context Item Chip ──────────────────────────────────────────

/**
 * A typed Context_Item chip rendered by the workbench (Requirement 40.2, 40.7).
 *
 * The chip carries structured identity — `displayLabel` is decorative and
 * never reparsed as the source identity.
 */
export const ContextItemChipSchema = z.object({
  /** Unique item identity within the draft. */
  itemId: IdentifierSchema,

  /** Typed kind determines chip appearance (Requirement 40.2). */
  kind: ContextItemKindSchema,

  /** Structured source identity (URI, path, symbol, etc.). */
  sourceIdentity: z.string().min(1),

  /** Decorative display label — not used as source truth. */
  displayLabel: z.string().min(1),

  /** Pinned content version at attachment time. */
  version: z.string().min(1),

  /** How this item was added (Requirement 40.7). */
  provenance: ProvenanceSourceSchema,

  /** Staleness state (Requirement 40.7). */
  staleness: StalenessStateSchema,

  /** Estimated token count (Requirement 40.7). */
  tokenEstimate: z.number().int().nonnegative(),

  /** Inclusion status (Requirement 40.7). */
  inclusionStatus: ItemInclusionStatusSchema,

  /** Authority-derived controls (Requirement 40.8). */
  actions: z.array(AuthorityActionSchema),

  /** Resolution state for async items. */
  resolutionState: ResolutionStateSchema,

  /** Settlement guard binding (for async items). */
  resolutionGuard: ResolutionGuardSchema.optional(),

  /** Failure information (for failed resolutions, Requirement 40.22). */
  failure: ResolutionFailureSchema.optional(),

  /** Accessibility label for the chip. */
  accessibilityLabel: z.string().min(1),
});

export type ContextItemChip = z.infer<typeof ContextItemChipSchema>;

// ─── Resolution Progress ────────────────────────────────────────

/**
 * Resolution progress state displayed during batch context resolution
 * (Requirement 40.5).
 */
export const ResolutionProgressSchema = z.object({
  /** Number of items completed so far. */
  completedCount: z.number().int().nonnegative(),

  /** Total items being resolved. */
  totalCount: z.number().int().positive(),

  /** Current item being resolved (label for display). */
  currentItemLabel: z.string().min(1),

  /** Whether cancellation is available. */
  cancellationAvailable: z.boolean(),
});

export type ResolutionProgress = z.infer<typeof ResolutionProgressSchema>;

// ─── Route Capacity Impact ──────────────────────────────────────

/**
 * Route-capacity impact projection (Requirement 40.9).
 *
 * Computed before submission to show the user the token/context impact
 * of the current Context_Items against the active route's capacity.
 */
export const RouteCapacityImpactSchema = z.object({
  /** Total tokens consumed by all included items. */
  totalIncludedTokens: z.number().int().nonnegative(),

  /** Route's maximum context window. */
  routeCapacity: z.number().int().positive(),

  /** Remaining capacity after included items. */
  remainingCapacity: z.number().int(),

  /** Percentage of route capacity consumed (0–100). */
  usagePercent: z.number().nonnegative().max(100),

  /** Number of items omitted due to capacity. */
  omittedCount: z.number().int().nonnegative(),

  /** Number of items condensed to fit. */
  condensedCount: z.number().int().nonnegative(),

  /** Whether submission would exceed capacity. */
  overCapacity: z.boolean(),

  /** Accessibility description of capacity state. */
  accessibilityLabel: z.string().min(1),
});

export type RouteCapacityImpact = z.infer<typeof RouteCapacityImpactSchema>;

// ─── Context Workbench State ────────────────────────────────────

/**
 * Complete context workbench presentation state combining chips,
 * resolution progress, and capacity impact.
 */
export const ContextWorkbenchStateSchema = z.object({
  /** Current draft revision binding. */
  draftRevision: z.number().int().nonnegative(),

  /** All typed context item chips. */
  chips: z.array(ContextItemChipSchema),

  /** Active resolution progress (null when no resolution in progress). */
  resolutionProgress: ResolutionProgressSchema.nullable(),

  /** Projected route-capacity impact. */
  capacityImpact: RouteCapacityImpactSchema,
});

export type ContextWorkbenchState = z.infer<typeof ContextWorkbenchStateSchema>;

// ─── Settlement Validation ──────────────────────────────────────

/**
 * Result of validating an async settlement against current draft state.
 */
export type SettlementValidation =
  | { valid: true }
  | { valid: false; reason: 'revision_mismatch' | 'range_mismatch' | 'request_superseded' | 'cancelled' | 'stale' };

/**
 * Validates whether an async resolution settlement may be applied.
 *
 * A settlement is valid only when the originating draftId, revision,
 * exact range, and requestId all match the current state
 * (Requirements 40.4, 40.20, 40.21).
 */
export function validateSettlement(
  guard: ResolutionGuard,
  currentDraftId: string,
  currentRevision: number,
  currentRange: { start: number; end: number },
  activeRequestId: string,
): SettlementValidation {
  if (guard.draftId !== currentDraftId) {
    return { valid: false, reason: 'stale' };
  }
  if (guard.originRevision !== currentRevision) {
    return { valid: false, reason: 'revision_mismatch' };
  }
  if (guard.exactRange.start !== currentRange.start || guard.exactRange.end !== currentRange.end) {
    return { valid: false, reason: 'range_mismatch' };
  }
  if (guard.requestId !== activeRequestId) {
    return { valid: false, reason: 'request_superseded' };
  }
  return { valid: true };
}

// ─── Chip Derivation ────────────────────────────────────────────

/**
 * Input to derive a Context_Item chip from stored item data and
 * authority policy. Decouples storage shape from presentation shape.
 */
export interface ContextItemInput {
  itemId: string;
  kind: ContextItemKind;
  sourceIdentity: string;
  displayLabel: string;
  version: string;
  provenance: ProvenanceSource;
  staleness: StalenessState;
  tokenEstimate: number;
  pinned: boolean;
  redacted: boolean;
  resolutionState: ResolutionState;
  resolutionGuard?: ResolutionGuard;
  failure?: ResolutionFailure;
  /** Authority policy for this item. */
  authorityPolicy: {
    canInspect: boolean;
    canPin: boolean;
    canRefresh: boolean;
    canRemove: boolean;
    canRedact: boolean;
  };
}

/**
 * Derives a typed chip from item input and authority policy.
 * Chips are keyed by itemId and carry structured identity —
 * displayLabel is decorative only (Requirement 40.2).
 */
export function deriveContextItemChip(input: ContextItemInput): ContextItemChip {
  const inclusionStatus = computeInclusionStatus(input);
  const actions = deriveActions(input);
  const accessibilityLabel = buildAccessibilityLabel(input, inclusionStatus);

  return {
    itemId: input.itemId,
    kind: input.kind,
    sourceIdentity: input.sourceIdentity,
    displayLabel: input.displayLabel,
    version: input.version,
    provenance: input.provenance,
    staleness: input.staleness,
    tokenEstimate: input.tokenEstimate,
    inclusionStatus,
    actions,
    resolutionState: input.resolutionState,
    resolutionGuard: input.resolutionGuard,
    failure: input.failure,
    accessibilityLabel,
  };
}

/**
 * Computes inclusion status from item state (Requirement 40.7).
 */
function computeInclusionStatus(input: ContextItemInput): ItemInclusionStatus {
  if (input.redacted) return 'redacted';
  if (input.staleness === 'unavailable') return 'unavailable';
  if (input.resolutionState === 'failed' || input.resolutionState === 'cancelled') return 'unavailable';
  // omitted/condensed are determined at capacity-impact time
  return 'included';
}

/**
 * Derives authority actions with availability reasons (Requirement 40.8, 40.16).
 */
function deriveActions(input: ContextItemInput): AuthorityAction[] {
  const actions: AuthorityAction[] = [];

  actions.push({
    actionId: 'inspect',
    available: input.authorityPolicy.canInspect,
    unavailableReason: input.authorityPolicy.canInspect ? undefined : 'Inspection not permitted',
  });

  if (input.pinned) {
    actions.push({
      actionId: 'unpin',
      available: true,
    });
  } else {
    actions.push({
      actionId: 'pin',
      available: input.authorityPolicy.canPin,
      unavailableReason: input.authorityPolicy.canPin ? undefined : 'Pinning not permitted',
    });
  }

  actions.push({
    actionId: 'refresh',
    available: input.authorityPolicy.canRefresh && input.staleness === 'stale',
    unavailableReason: input.staleness !== 'stale'
      ? 'Item is current'
      : (!input.authorityPolicy.canRefresh ? 'Refresh not permitted' : undefined),
  });

  actions.push({
    actionId: 'remove',
    available: input.authorityPolicy.canRemove,
    unavailableReason: input.authorityPolicy.canRemove ? undefined : 'Item is mandatory',
  });

  actions.push({
    actionId: 'redact',
    available: input.authorityPolicy.canRedact && !input.redacted,
    unavailableReason: input.redacted
      ? 'Already redacted'
      : (!input.authorityPolicy.canRedact ? 'Redaction not permitted' : undefined),
  });

  return actions;
}

/**
 * Builds an accessibility label for the chip (Requirement 40.2, 40.7).
 */
function buildAccessibilityLabel(input: ContextItemInput, inclusionStatus: ItemInclusionStatus): string {
  const parts: string[] = [
    `${input.kind} context`,
    input.displayLabel,
  ];

  if (input.staleness !== 'current') {
    parts.push(input.staleness);
  }

  if (inclusionStatus !== 'included') {
    parts.push(inclusionStatus);
  }

  parts.push(`${input.tokenEstimate} tokens`);

  return parts.join(', ');
}

// ─── Capacity Impact Computation ────────────────────────────────

/**
 * Input for computing route-capacity impact.
 */
export interface CapacityComputeInput {
  /** Chips to assess for capacity impact. */
  chips: ContextItemChip[];

  /** Route's maximum context window in tokens. */
  routeCapacity: number;

  /** Tokens already consumed by prompt overhead, system messages, etc. */
  reservedTokens: number;
}

/**
 * Computes the route-capacity impact from Context_Items (Requirement 40.9).
 *
 * The impact is deterministic given the same inputs — tokens are summed from
 * included items and compared against available route capacity.
 */
export function computeRouteCapacityImpact(input: CapacityComputeInput): RouteCapacityImpact {
  const { chips, routeCapacity, reservedTokens } = input;

  // Sort by priority: mandatory/inherited first, then included, then others
  const sorted = [...chips].sort((a, b) => {
    return provenancePriority(a.provenance) - provenancePriority(b.provenance);
  });

  const availableCapacity = Math.max(0, routeCapacity - reservedTokens);
  let totalIncludedTokens = 0;
  let totalRequestedTokens = 0;
  let omittedCount = 0;
  let condensedCount = 0;

  for (const chip of sorted) {
    if (chip.inclusionStatus === 'redacted' || chip.inclusionStatus === 'unavailable') {
      continue;
    }
    totalRequestedTokens += chip.tokenEstimate;
    if (totalIncludedTokens + chip.tokenEstimate <= availableCapacity) {
      totalIncludedTokens += chip.tokenEstimate;
    } else {
      omittedCount++;
    }
  }

  const remainingCapacity = availableCapacity - totalIncludedTokens;
  const usagePercent = availableCapacity > 0
    ? Math.min(100, Math.round((totalIncludedTokens / availableCapacity) * 100))
    : 100;
  // Over capacity when the total requested exceeds available (items had to be omitted)
  const overCapacity = totalRequestedTokens > availableCapacity;

  const accessibilityLabel = overCapacity
    ? `Context exceeds route capacity: ${totalIncludedTokens} of ${availableCapacity} tokens used, ${omittedCount} items omitted`
    : `Context usage: ${totalIncludedTokens} of ${availableCapacity} tokens, ${remainingCapacity} remaining`;

  return {
    totalIncludedTokens,
    routeCapacity,
    remainingCapacity,
    usagePercent,
    omittedCount,
    condensedCount,
    overCapacity,
    accessibilityLabel,
  };
}

/**
 * Priority ordering for provenance during capacity allocation.
 */
function provenancePriority(provenance: ProvenanceSource): number {
  switch (provenance) {
    case 'mandatory': return 0;
    case 'inherited': return 1;
    case 'injected': return 2;
    case 'explicit': return 3;
    case 'suggested': return 4;
  }
}

// ─── Resolution Progress Derivation ─────────────────────────────

/**
 * Derives resolution progress from a set of chips undergoing resolution
 * (Requirement 40.5).
 */
export function deriveResolutionProgress(
  chips: ContextItemChip[],
): ResolutionProgress | null {
  const resolving = chips.filter(c =>
    c.resolutionState === 'pending' || c.resolutionState === 'resolving'
  );
  const resolved = chips.filter(c => c.resolutionState === 'resolved');
  const total = resolving.length + resolved.length;

  if (resolving.length === 0) return null;

  const currentItem = resolving.find(c => c.resolutionState === 'resolving') ?? resolving[0]!;

  return {
    completedCount: resolved.length,
    totalCount: total,
    currentItemLabel: currentItem.displayLabel,
    cancellationAvailable: true,
  };
}

// ─── Cancellation Handler ───────────────────────────────────────

/**
 * Applies cancellation to resolution: retains resolved items and marks
 * unresolved items as cancelled (Requirement 40.6).
 */
export function applyCancellation(chips: ContextItemChip[]): ContextItemChip[] {
  return chips.map(chip => {
    if (chip.resolutionState === 'pending' || chip.resolutionState === 'resolving') {
      return {
        ...chip,
        resolutionState: 'cancelled' as const,
        inclusionStatus: 'unavailable' as const,
        accessibilityLabel: buildAccessibilityLabel(
          { ...chipToInput(chip), resolutionState: 'cancelled' },
          'unavailable',
        ),
      };
    }
    return chip;
  });
}

/**
 * Applies a failed resolution result to a chip (Requirement 40.22).
 * Preserves the draft and exposes failure info with eligible actions.
 */
export function applyResolutionFailure(
  chip: ContextItemChip,
  failure: ResolutionFailure,
): ContextItemChip {
  return {
    ...chip,
    resolutionState: 'failed',
    inclusionStatus: 'unavailable',
    failure,
    accessibilityLabel: buildAccessibilityLabel(
      { ...chipToInput(chip), resolutionState: 'failed' },
      'unavailable',
    ),
  };
}

// ─── Workbench State Derivation ─────────────────────────────────

/**
 * Derives the full context workbench state from items, authority policy,
 * and route capacity (Requirements 40.2, 40.5, 40.7–40.9).
 */
export function deriveContextWorkbenchState(
  draftRevision: number,
  items: ContextItemInput[],
  routeCapacity: number,
  reservedTokens: number,
): ContextWorkbenchState {
  const chips = items.map(deriveContextItemChip);
  const resolutionProgress = deriveResolutionProgress(chips);
  const capacityImpact = computeRouteCapacityImpact({
    chips,
    routeCapacity,
    reservedTokens,
  });

  return {
    draftRevision,
    chips,
    resolutionProgress,
    capacityImpact,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Converts a chip back to an input-like shape for rebuilding accessibility labels.
 * Internal helper only.
 */
function chipToInput(chip: ContextItemChip): ContextItemInput {
  const result: ContextItemInput = {
    itemId: chip.itemId,
    kind: chip.kind,
    sourceIdentity: chip.sourceIdentity,
    displayLabel: chip.displayLabel,
    version: chip.version,
    provenance: chip.provenance,
    staleness: chip.staleness,
    tokenEstimate: chip.tokenEstimate,
    pinned: chip.actions.some(a => a.actionId === 'unpin'),
    redacted: chip.inclusionStatus === 'redacted',
    resolutionState: chip.resolutionState,
    authorityPolicy: {
      canInspect: chip.actions.find(a => a.actionId === 'inspect')?.available ?? false,
      canPin: chip.actions.find(a => a.actionId === 'pin')?.available ?? false,
      canRefresh: chip.actions.find(a => a.actionId === 'refresh')?.available ?? false,
      canRemove: chip.actions.find(a => a.actionId === 'remove')?.available ?? false,
      canRedact: chip.actions.find(a => a.actionId === 'redact')?.available ?? false,
    },
  };
  if (chip.resolutionGuard !== undefined) {
    result.resolutionGuard = chip.resolutionGuard;
  }
  if (chip.failure !== undefined) {
    result.failure = chip.failure;
  }
  return result;
}
