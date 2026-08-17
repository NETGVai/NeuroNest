/**
 * Queue_Dock Surface
 *
 * Implements the keyed authority projection for Turn_Controller inbox records.
 * Derives the Queue_Dock presentation surface from projected queue state,
 * manages IME composition suppression, busy-enter behavior, authority-derived
 * ownership/unavailability, and preserves focus/order/edit input across
 * pending and failure states.
 *
 * Key behaviors:
 * - Render revisioned entries with eligible controls (Req 39.1, 39.2)
 * - Route every mutation through Turn_Controller (Req 39.13, 39.14)
 * - Pending presentation is separate from committed order (Req 39.15)
 * - Stale/rejected/timeout restores latest compatible projection (Req 39.17)
 * - IME composition suppresses shortcuts until composition ends (Req 39.8, 39.18)
 * - Busy-enter submits queue or steer based on config (Req 39.5, 39.6)
 * - Alternate shortcut exposed for non-default action (Req 39.7)
 * - Authority-derived ownership/unavailability displayed (Req 39.10, 39.11)
 *
 * Requirements: 39.1–39.18
 */

import type {
  QueueEntry,
  QueueProjection,
  MutationOutcome,
  QueueMutationKind,
  BusyEnterPolicy,
} from '../../runtime/queue-schemas';

import type {
  QueueDockSurface,
  QueueDockEntryView,
  QueueDockConfig,
  EntryControl,
  EntryMutationStatus,
  EntryMutationFailure,
  IMECompositionState,
  BusyEnterState,
  SubagentOwnership,
} from './types';

import {
  DEFAULT_QUEUE_DOCK_CONFIG,
  BUSY_ENTER_ACTION_LABELS,
  ALTERNATE_SHORTCUT_HINTS,
} from './types';

// ─── Ephemeral UI State ─────────────────────────────────────────

/**
 * Ephemeral per-entry UI state preserved across projection updates.
 * This is presentation-layer-only state that does not exist in the projection.
 */
export interface EntryEphemeralState {
  /** Retained edit input text preserved on failure (Requirement 39.17). */
  retainedEditInput?: string;

  /** Whether this entry has UI focus. */
  focused: boolean;

  /** Failed mutation details. */
  mutationFailure?: EntryMutationFailure;

  /** Current mutation status (idle/pending/failed). */
  mutationStatus: EntryMutationStatus;
}

/**
 * Ephemeral Queue_Dock UI state held by the presentation layer.
 * Limited to focus, edit input, IME state, and pending mutation tracking.
 */
export interface QueueDockEphemeralState {
  /** Per-entry ephemeral state keyed by entryId. */
  entries: Map<string, EntryEphemeralState>;

  /** Currently focused entry ID. */
  focusedEntryId?: string;

  /** IME composition state. */
  imeComposition: IMECompositionState;
}

// ─── IME Composition Controller ─────────────────────────────────

/**
 * Manages IME composition state to suppress shortcuts during composition.
 *
 * While an input-method composition is active (Requirements 39.8, 39.18):
 * - Enter is treated as composition input
 * - Queue, steer, command, and mutation shortcuts are deferred
 * - Send actions are deferred
 *
 * Returns the updated IME state and whether an action should be suppressed.
 */
export function handleCompositionStart(
  current: IMECompositionState,
  editorId: string,
): IMECompositionState {
  return { active: true, editorId };
}

export function handleCompositionEnd(
  current: IMECompositionState,
): IMECompositionState {
  return { active: false, editorId: undefined };
}

/**
 * Determines if a shortcut/action should be suppressed due to active
 * IME composition (Requirements 39.8, 39.18).
 *
 * Suppressed actions during composition:
 * - send
 * - queue
 * - steer
 * - command
 * - mutation (edit, remove, reorder, promote)
 */
export type SuppressibleAction =
  | 'send'
  | 'queue'
  | 'steer'
  | 'command'
  | 'mutation';

export function isActionSuppressedByIME(
  imeState: IMECompositionState,
  action: SuppressibleAction,
): boolean {
  if (!imeState.active) return false;

  // All listed actions are suppressed during IME composition
  const SUPPRESSED_ACTIONS: ReadonlySet<SuppressibleAction> = new Set([
    'send',
    'queue',
    'steer',
    'command',
    'mutation',
  ]);

  return SUPPRESSED_ACTIONS.has(action);
}

// ─── Busy-Enter Resolution ──────────────────────────────────────

/**
 * Resolves the Enter key behavior when a compatible turn is active.
 *
 * Requirements 39.5–39.7:
 * - If defaultPolicy is 'queue', Enter submits as queued follow-up
 * - If defaultPolicy is 'steer', Enter submits as steering input
 * - The alternate shortcut exposes the non-default action
 */
export function deriveBusyEnterState(
  turnActive: boolean,
  config: QueueDockConfig['busyEnter'],
): BusyEnterState {
  const defaultPolicy = config.defaultPolicy;
  const alternatePolicy = config.alternatePolicy ?? (
    defaultPolicy === 'queue' ? 'steer' : 'queue'
  );

  return {
    turnActive,
    defaultPolicy,
    defaultActionLabel: BUSY_ENTER_ACTION_LABELS[defaultPolicy],
    alternatePolicy: turnActive ? alternatePolicy : undefined,
    alternateActionLabel: turnActive
      ? BUSY_ENTER_ACTION_LABELS[alternatePolicy]
      : undefined,
    alternateShortcutHint: turnActive
      ? ALTERNATE_SHORTCUT_HINTS[alternatePolicy]
      : undefined,
  };
}

/**
 * Resolves the action to take when Enter is pressed during a busy turn.
 * Returns undefined if the action is suppressed by IME composition.
 *
 * Requirements 39.5, 39.6, 39.8
 */
export function resolveBusyEnterAction(
  turnActive: boolean,
  imeActive: boolean,
  config: QueueDockConfig['busyEnter'],
  isAlternateShortcut: boolean,
): BusyEnterPolicy | undefined {
  // IME composition suppresses all queue/steer actions (Requirement 39.8)
  if (imeActive) return undefined;

  if (!turnActive) return undefined;

  if (isAlternateShortcut) {
    return config.alternatePolicy ?? (
      config.defaultPolicy === 'queue' ? 'steer' : 'queue'
    );
  }

  return config.defaultPolicy;
}

// ─── Entry Control Derivation ───────────────────────────────────

/**
 * Derives eligible controls for an entry based on queue policy,
 * delivery state, subagent ownership, and entry type.
 *
 * Requirements 39.2, 39.10, 39.11
 */
export function deriveEntryControls(
  entry: QueueEntry,
  subagentOwnership: SubagentOwnership,
  entryMutationStatus: EntryMutationStatus,
): EntryControl {
  // If incompatible subagent ownership is active, all mutations are unavailable (Req 39.11)
  if (subagentOwnership.active) {
    const reason = `Owned by ${subagentOwnership.subagentId ?? 'subagent'}: ${subagentOwnership.incompatibilityReason ?? 'incompatible ownership'}`;
    return {
      editAvailable: false,
      editUnavailableReason: reason,
      removeAvailable: false,
      removeUnavailableReason: reason,
      reorderAvailable: false,
      reorderUnavailableReason: reason,
      promoteAvailable: false,
      promoteUnavailableReason: reason,
    };
  }

  // Delivered or cancelled entries cannot be mutated
  if (entry.deliveryState === 'delivered' || entry.deliveryState === 'cancelled') {
    const reason = entry.deliveryState === 'delivered'
      ? 'Entry has been delivered'
      : 'Entry was cancelled';
    return {
      editAvailable: false,
      editUnavailableReason: reason,
      removeAvailable: false,
      removeUnavailableReason: reason,
      reorderAvailable: false,
      reorderUnavailableReason: reason,
      promoteAvailable: false,
      promoteUnavailableReason: reason,
    };
  }

  // Pending mutation entries cannot accept new mutations
  if (entryMutationStatus === 'pending') {
    const reason = 'Mutation pending confirmation';
    return {
      editAvailable: false,
      editUnavailableReason: reason,
      removeAvailable: false,
      removeUnavailableReason: reason,
      reorderAvailable: false,
      reorderUnavailableReason: reason,
      promoteAvailable: false,
      promoteUnavailableReason: reason,
    };
  }

  // Inject entries cannot be edited by users
  if (entry.queueType === 'inject') {
    return {
      editAvailable: false,
      editUnavailableReason: 'System-injected entries cannot be edited',
      removeAvailable: true,
      removeUnavailableReason: undefined,
      reorderAvailable: true,
      reorderUnavailableReason: undefined,
      promoteAvailable: false,
      promoteUnavailableReason: 'System-injected entries cannot be promoted',
    };
  }

  // Steer entries cannot be promoted (already steering)
  const promoteAvailable = entry.queueType === 'follow_up';
  const promoteReason = entry.queueType === 'steer'
    ? 'Entry is already steering'
    : undefined;

  return {
    editAvailable: true,
    editUnavailableReason: undefined,
    removeAvailable: true,
    removeUnavailableReason: undefined,
    reorderAvailable: true,
    reorderUnavailableReason: undefined,
    promoteAvailable,
    promoteUnavailableReason: promoteReason,
  };
}

// ─── Entry View Derivation ──────────────────────────────────────

/**
 * Derives a single QueueDockEntryView from a committed entry and
 * ephemeral state.
 */
export function deriveEntryView(
  entry: QueueEntry,
  ephemeral: EntryEphemeralState | undefined,
  subagentOwnership: SubagentOwnership,
): QueueDockEntryView {
  const mutationStatus = ephemeral?.mutationStatus ?? 'idle';
  const controls = deriveEntryControls(entry, subagentOwnership, mutationStatus);

  const accessibilityLabel = buildEntryAccessibilityLabel(
    entry,
    mutationStatus,
    controls,
  );

  return {
    entryId: entry.entryId,
    queueType: entry.queueType,
    revision: entry.revision,
    position: entry.position,
    owner: entry.owner,
    deliveryState: entry.deliveryState,
    placement: entry.placement,
    content: entry.content,
    mutationStatus,
    mutationFailure: ephemeral?.mutationFailure,
    controls,
    focused: ephemeral?.focused ?? false,
    retainedEditInput: ephemeral?.retainedEditInput,
    accessibilityLabel,
  };
}

/**
 * Builds an accessibility label for a queue entry.
 */
function buildEntryAccessibilityLabel(
  entry: QueueEntry,
  mutationStatus: EntryMutationStatus,
  controls: EntryControl,
): string {
  const typeLabel = entry.queueType === 'follow_up'
    ? 'Follow-up'
    : entry.queueType === 'steer'
      ? 'Steering'
      : 'Injected';

  const statusSuffix = mutationStatus === 'pending'
    ? ', pending confirmation'
    : mutationStatus === 'failed'
      ? ', mutation failed'
      : '';

  const posLabel = `position ${entry.position + 1}`;

  return `${typeLabel} entry ${posLabel}${statusSuffix}`;
}

// ─── Surface Derivation ─────────────────────────────────────────

/**
 * Input required to derive the Queue_Dock surface.
 */
export interface QueueDockProjectionInput {
  /** The projected queue state from Projection_Service. */
  projection: QueueProjection;

  /** Whether a compatible turn is currently active (for busy-enter). */
  turnActive: boolean;

  /** Subagent ownership status. */
  subagentOwnership: SubagentOwnership;

  /** Current time for derivation timestamp. */
  currentTime: string;
}

/**
 * Derives the complete QueueDockSurface from projection data and
 * ephemeral state.
 *
 * This is a pure function given the same inputs. It does not hold
 * mutable state. Focus, edit input, and mutation status are preserved
 * from the ephemeral state parameter.
 *
 * Requirements: 39.1–39.18
 */
export function deriveQueueDockSurface(
  input: QueueDockProjectionInput,
  ephemeral: QueueDockEphemeralState,
  config: QueueDockConfig = DEFAULT_QUEUE_DOCK_CONFIG,
): QueueDockSurface {
  const { projection, turnActive, subagentOwnership, currentTime } = input;

  // Derive entry views preserving committed order (Requirement 39.12)
  const entries: QueueDockEntryView[] = projection.entries.map((entry) => {
    const entryEphemeral = ephemeral.entries.get(entry.entryId);
    return deriveEntryView(entry, entryEphemeral, subagentOwnership);
  });

  // Collect pending entry IDs (Requirement 39.15)
  const pendingEntryIds = entries
    .filter((e) => e.mutationStatus === 'pending')
    .map((e) => e.entryId);

  // Derive add availability (Requirement 39.10, 39.11)
  const addAvailable = !subagentOwnership.active;
  const addUnavailableReason = subagentOwnership.active
    ? `Owned by ${subagentOwnership.subagentId ?? 'subagent'}: ${subagentOwnership.incompatibilityReason ?? 'incompatible ownership'}`
    : undefined;

  // Derive busy-enter state (Requirements 39.5–39.7)
  const busyEnterState = deriveBusyEnterState(turnActive, config.busyEnter);

  return {
    sessionId: projection.sessionId,
    turnId: projection.turnId,
    projectionRevision: projection.projectionRevision,
    entries,
    pendingEntryIds,
    addAvailable,
    addUnavailableReason,
    subagentOwnership,
    busyEnterState,
    imeComposition: ephemeral.imeComposition,
    focusedEntryId: ephemeral.focusedEntryId,
    derivedAt: currentTime,
  };
}

// ─── Ephemeral State Management ─────────────────────────────────

/**
 * Creates a fresh ephemeral state with no entries and IME inactive.
 */
export function createInitialEphemeralState(): QueueDockEphemeralState {
  return {
    entries: new Map(),
    focusedEntryId: undefined,
    imeComposition: { active: false },
  };
}

/**
 * Marks an entry as having a pending mutation.
 * Preserves existing edit input and focus state.
 *
 * Requirement 39.15: Label affected entry as pending.
 */
export function markEntryPending(
  state: QueueDockEphemeralState,
  entryId: string,
): QueueDockEphemeralState {
  const entries = new Map(state.entries);
  const existing = entries.get(entryId);
  entries.set(entryId, {
    ...existing,
    focused: existing?.focused ?? false,
    mutationStatus: 'pending',
    mutationFailure: undefined,
  });
  return { ...state, entries };
}

/**
 * Marks an entry mutation as committed (confirmed by projection).
 * Clears pending state and retained edit input.
 *
 * Requirement 39.16: Present resulting entry revision as committed.
 */
export function markEntryCommitted(
  state: QueueDockEphemeralState,
  entryId: string,
): QueueDockEphemeralState {
  const entries = new Map(state.entries);
  const existing = entries.get(entryId);
  entries.set(entryId, {
    focused: existing?.focused ?? false,
    mutationStatus: 'idle',
    mutationFailure: undefined,
    retainedEditInput: undefined,
  });
  return { ...state, entries };
}

/**
 * Marks an entry mutation as failed, preserving edit input and
 * identifying the failed action with eligible retry/refresh.
 *
 * Requirements 39.9, 39.17: Retain item, identify failed action,
 * expose retry or refresh, preserve unaffected identities and order,
 * retain user edit input.
 */
export function markEntryFailed(
  state: QueueDockEphemeralState,
  entryId: string,
  failure: EntryMutationFailure,
  retainedEditInput?: string,
): QueueDockEphemeralState {
  const entries = new Map(state.entries);
  const existing = entries.get(entryId);
  entries.set(entryId, {
    focused: existing?.focused ?? false,
    mutationStatus: 'failed',
    mutationFailure: failure,
    retainedEditInput: retainedEditInput ?? existing?.retainedEditInput,
  });
  return { ...state, entries };
}

/**
 * Updates focus state for an entry.
 *
 * Requirement 39.12: Preserve focus and list order when delivery
 * state changes.
 */
export function setEntryFocus(
  state: QueueDockEphemeralState,
  entryId: string,
  focused: boolean,
): QueueDockEphemeralState {
  const entries = new Map(state.entries);
  const existing = entries.get(entryId);
  entries.set(entryId, {
    ...existing,
    focused,
    mutationStatus: existing?.mutationStatus ?? 'idle',
  });

  // Update global focused entry ID
  const focusedEntryId = focused ? entryId : (
    state.focusedEntryId === entryId ? undefined : state.focusedEntryId
  );

  return { ...state, entries, focusedEntryId };
}

/**
 * Retains edit input text for an entry across state transitions.
 *
 * Requirement 39.17: Retain user edit input on rejection/stale/timeout.
 */
export function retainEditInput(
  state: QueueDockEphemeralState,
  entryId: string,
  editInput: string,
): QueueDockEphemeralState {
  const entries = new Map(state.entries);
  const existing = entries.get(entryId);
  entries.set(entryId, {
    ...existing,
    focused: existing?.focused ?? false,
    mutationStatus: existing?.mutationStatus ?? 'idle',
    retainedEditInput: editInput,
  });
  return { ...state, entries };
}

/**
 * Removes ephemeral state for entries no longer in the projection.
 * Preserves focus and order for entries that remain.
 */
export function reconcileEphemeralState(
  state: QueueDockEphemeralState,
  currentEntryIds: ReadonlySet<string>,
): QueueDockEphemeralState {
  const entries = new Map<string, EntryEphemeralState>();
  for (const [id, entry] of state.entries) {
    if (currentEntryIds.has(id)) {
      entries.set(id, entry);
    }
  }

  const focusedEntryId = state.focusedEntryId && currentEntryIds.has(state.focusedEntryId)
    ? state.focusedEntryId
    : undefined;

  return { ...state, entries, focusedEntryId };
}

// ─── Mutation Outcome Processing ────────────────────────────────

/**
 * Processes a mutation outcome from Turn_Controller and updates
 * ephemeral state accordingly.
 *
 * Requirements 39.9, 39.15–39.17
 */
export function processMutationOutcome(
  state: QueueDockEphemeralState,
  outcome: MutationOutcome,
  failedAction?: QueueMutationKind,
  retainedInput?: string,
): QueueDockEphemeralState {
  const entryId = outcome.entryId;
  if (!entryId) return state;

  switch (outcome.status) {
    case 'committed':
      return markEntryCommitted(state, entryId);

    case 'pending':
      return markEntryPending(state, entryId);

    case 'rejected_stale':
      return markEntryFailed(state, entryId, {
        failedAction: failedAction ?? 'edit',
        reason: outcome.reason ?? `Expected revision ${outcome.currentRevision} is stale`,
        retryEligible: true,
        refreshEligible: true,
        failedAt: outcome.determinedAt,
      }, retainedInput);

    case 'rejected_unavailable':
      return markEntryFailed(state, entryId, {
        failedAction: failedAction ?? 'edit',
        reason: outcome.reason ?? 'Action unavailable',
        retryEligible: false,
        refreshEligible: true,
        failedAt: outcome.determinedAt,
      }, retainedInput);

    case 'rejected_incompatible_owner':
      return markEntryFailed(state, entryId, {
        failedAction: failedAction ?? 'edit',
        reason: outcome.reason ?? `Incompatible owner: ${outcome.owningSubagentId ?? 'unknown'}`,
        retryEligible: false,
        refreshEligible: true,
        failedAt: outcome.determinedAt,
      }, retainedInput);

    case 'timed_out':
      return markEntryFailed(state, entryId, {
        failedAction: failedAction ?? 'edit',
        reason: outcome.reason ?? 'Mutation timed out',
        retryEligible: true,
        refreshEligible: true,
        failedAt: outcome.determinedAt,
      }, retainedInput);

    default:
      return state;
  }
}
