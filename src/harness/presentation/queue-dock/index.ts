/**
 * Queue_Dock — Public API
 *
 * Exports the keyed authority projection types, surface derivation,
 * IME composition helpers, busy-enter resolution, entry control logic,
 * ephemeral state management, and configuration schemas.
 *
 * Requirements: 39.1–39.18
 */

export {
  // Schemas
  IMECompositionStateSchema,
  EntryMutationStatusSchema,
  EntryMutationFailureSchema,
  EntryControlSchema,
  QueueDockEntryViewSchema,
  SubagentOwnershipSchema,
  BusyEnterStateSchema,
  QueueDockSurfaceSchema,
  QueueDockConfigSchema,

  // Types
  type IMECompositionState,
  type EntryMutationStatus,
  type EntryMutationFailure,
  type EntryControl,
  type QueueDockEntryView,
  type SubagentOwnership,
  type BusyEnterState,
  type QueueDockSurface,
  type QueueDockConfig,

  // Constants
  DEFAULT_QUEUE_DOCK_CONFIG,
  BUSY_ENTER_ACTION_LABELS,
  ALTERNATE_SHORTCUT_HINTS,
} from './types';

export {
  // Types
  type EntryEphemeralState,
  type QueueDockEphemeralState,
  type QueueDockProjectionInput,
  type SuppressibleAction,

  // IME Composition
  handleCompositionStart,
  handleCompositionEnd,
  isActionSuppressedByIME,

  // Busy-Enter
  deriveBusyEnterState,
  resolveBusyEnterAction,

  // Entry Controls
  deriveEntryControls,
  deriveEntryView,

  // Surface Derivation
  deriveQueueDockSurface,

  // Ephemeral State Management
  createInitialEphemeralState,
  markEntryPending,
  markEntryCommitted,
  markEntryFailed,
  setEntryFocus,
  retainEditInput,
  reconcileEphemeralState,

  // Mutation Outcome Processing
  processMutationOutcome,
} from './queue-dock-surface';
