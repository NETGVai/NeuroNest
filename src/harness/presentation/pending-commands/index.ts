/**
 * Projection-Confirmed Pending Command Presentation
 *
 * Manages pending UI commands that await confirmation from Projection_Service.
 * Ensures prior committed projections are retained while commands are pending,
 * commits only from causally compatible projection revisions, preserves user
 * input, and displays typed rejection/stale/timeout outcomes.
 *
 * Requirements: 35.12–35.13, 35.19–35.21, 38.10–38.11, 39.15–39.17,
 *              43.13–43.16, 44.16, 45.6, 45.16
 */

// Types and schemas
export {
  PendingCommandStatusSchema,
  PendingCommandOutcomeSchema,
  PendingCommandEntrySchema,
  PendingCommandStoreStateSchema,
  PendingCommandConfigSchema,
  DEFAULT_PENDING_COMMAND_CONFIG,
  type PendingCommandStatus,
  type PendingCommandOutcome,
  type PendingCommandEntry,
  type PendingCommandStoreState,
  type PendingCommandConfig,
  type ProjectionConfirmation,
  type PendingCommandSubmission,
  type PendingCommandView,
} from './types';

// Store and helpers
export {
  PendingCommandStore,
  isCausallyCompatible,
  shouldShowTimeoutWarning,
  derivePendingCommandPresentation,
  type PendingCommandPresentation,
} from './pending-command-store';
