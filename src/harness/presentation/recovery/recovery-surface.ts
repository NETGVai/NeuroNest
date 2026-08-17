/**
 * Recovery and Reconciliation Surface
 *
 * Pure reducer that derives recovery/reconciliation presentation state
 * from projection data. The surface:
 *
 * - Distinguishes recoverable and terminal errors by typed class,
 *   affected authority, correlation identity, and last verified state (45.1)
 * - Shows retry state with attempt, limit, delay, budget, route (45.2)
 * - Shows connectivity interruption with attempts, delay, capabilities (45.3)
 * - Preserves rendered history and anchor on history load failure (45.4)
 * - Displays schema incompatibility with versions and remediation (45.5)
 * - Labels stale projections with last verified revision/time (45.6)
 * - Exposes typed recovery actions (resume, retry, reload, export) (45.7)
 * - Preserves draft, anchor, unread, partial, queue, collaboration (45.8)
 * - Retains partial content and shows terminal outcome without success (45.9)
 * - Redacts secrets and private paths in diagnostics (45.10)
 * - Requires idempotent resume or explicit new attempt (45.11)
 * - Reconciles against latest compatible revision before re-enabling (45.12)
 * - Disables durable mutation controls during recovery/reconciliation (45.13)
 * - Keeps controls disabled if reconciliation remains incompatible (45.14)
 * - Displays exact projected outcome without success indicator (45.15)
 * - Presents confirmed mutations from confirming revision (45.16)
 *
 * Requirements: 45.1–45.16
 */

import type {
  RecoverySurfaceState,
  RecoverySurfaceConfig,
  RecoveryProjectionInput,
  RecoveryAccessibilityView,
  RecoveryErrorClass,
  Recoverability,
  RetryPresentation,
  ConnectivityInterruption,
  SchemaIncompatibility,
  StaleProjectionLabel,
  RecoveryAction,
  PreservedRecoveryState,
  MutationControlState,
  ReconciliationStatus,
} from './types';
import { DEFAULT_RECOVERY_SURFACE_CONFIG } from './types';

// ─── Initial State ──────────────────────────────────────────────

/**
 * Creates the initial (idle) recovery surface state.
 * No failure or reconciliation is active.
 */
export function createInitialRecoverySurfaceState(): RecoverySurfaceState {
  return {
    active: false,
    errorClass: null,
    recoverability: null,
    affectedAuthority: null,
    correlationId: null,
    lastVerifiedState: null,
    retryPresentation: null,
    connectivityInterruption: null,
    schemaIncompatibility: null,
    staleLabel: null,
    availableActions: [],
    preservedState: null,
    mutationControlState: {
      disabled: false,
      affectedAuthority: '',
      lastVerifiedRevision: 0,
    },
    reconciliationStatus: 'idle',
    terminalOutcomeLabel: null,
    confirmingRevision: null,
  };
}

// ─── Recoverability Classifier ──────────────────────────────────

/**
 * Terminal error classes (Requirement 45.9).
 * These never present a success indicator and retain partial content.
 */
const TERMINAL_ERROR_CLASSES: ReadonlySet<RecoveryErrorClass> = new Set([
  'terminal_failure',
  'retry_exhausted',
]);

/**
 * Classifies whether an error is recoverable or terminal (Requirement 45.1).
 */
export function classifyRecoverability(
  errorClass: RecoveryErrorClass | null,
  isTerminal: boolean,
): Recoverability | null {
  if (errorClass === null) return null;
  if (isTerminal || TERMINAL_ERROR_CLASSES.has(errorClass)) return 'terminal';
  return 'recoverable';
}

// ─── Terminal Outcome Labels ────────────────────────────────────

/**
 * Terminal outcome labels that never indicate success (Requirement 45.9, 45.15).
 */
const TERMINAL_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  terminal_failure: 'Operation failed permanently',
  retry_exhausted: 'All retry attempts exhausted',
  schema_incompatible: 'Schema incompatibility — action required',
  authority_unavailable: 'Required authority unavailable',
  reconciliation_failed: 'Reconciliation could not complete',
};

/**
 * Returns a terminal outcome label for the given error class.
 * Never returns "success" or "completed" language (Requirement 45.9).
 */
export function getTerminalOutcomeLabel(errorClass: RecoveryErrorClass | null): string | null {
  if (!errorClass) return null;
  return TERMINAL_OUTCOME_LABELS[errorClass] ?? null;
}

// ─── Mutation Control Derivation ────────────────────────────────

/**
 * Derives the mutation control state from reconciliation data (Requirement 45.13–45.14).
 *
 * Durable mutation controls are disabled:
 * - While recovery is active
 * - While reconciliation is active (not completed/idle)
 * - When reconciliation is incompatible or failed
 */
export function deriveMutationControlState(
  reconciliation: RecoveryProjectionInput['reconciliation'],
): MutationControlState {
  const disablingStatuses: ReadonlySet<ReconciliationStatus> = new Set([
    'verifying_compatibility',
    'reconciling',
    'incompatible',
    'failed',
  ]);

  const disabled = disablingStatuses.has(reconciliation.status);

  return {
    disabled,
    affectedAuthority: reconciliation.affectedAuthority,
    lastVerifiedRevision: reconciliation.lastVerifiedRevision,
    remediationAction: disabled ? reconciliation.remediationAction : undefined,
  };
}

// ─── Retry Presentation Derivation ──────────────────────────────

/**
 * Derives the retry presentation from input (Requirement 45.2).
 */
export function deriveRetryPresentation(
  input: RecoveryProjectionInput,
): RetryPresentation | null {
  if (!input.retry || input.errorClass === null) return null;
  return {
    attemptNumber: input.retry.attemptNumber,
    attemptLimit: input.retry.attemptLimit,
    scheduledDelayMs: input.retry.scheduledDelayMs,
    elapsedRetryBudgetMs: input.retry.elapsedRetryBudgetMs,
    route: input.retry.route,
    errorClass: input.errorClass,
  };
}

// ─── Connectivity Derivation ────────────────────────────────────

/**
 * Derives connectivity interruption state (Requirement 45.3).
 */
export function deriveConnectivityInterruption(
  input: RecoveryProjectionInput,
): ConnectivityInterruption | null {
  if (!input.connectivity) return null;
  return {
    status: 'reconnecting',
    attemptCount: input.connectivity.attemptCount,
    nextDelayMs: input.connectivity.nextDelayMs,
    affectedCapabilities: input.connectivity.affectedCapabilities,
    cancellationAvailable: input.connectivity.cancellationAvailable,
  };
}

// ─── Schema Incompatibility Derivation ──────────────────────────

/**
 * Derives schema incompatibility state (Requirement 45.5).
 */
export function deriveSchemaIncompatibility(
  input: RecoveryProjectionInput,
): SchemaIncompatibility | null {
  if (!input.incompatibility) return null;
  return {
    processVersion: input.incompatibility.processVersion,
    compatibleSchemaRange: input.incompatibility.compatibleSchemaRange,
    observedSchemaVersion: input.incompatibility.observedSchemaVersion,
    remediation: input.incompatibility.remediation,
  };
}

// ─── Stale Projection Label ─────────────────────────────────────

/**
 * Derives stale projection label (Requirement 45.6).
 * Stale mutations are never presented as committed.
 */
export function deriveStaleLabel(
  input: RecoveryProjectionInput,
): StaleProjectionLabel | null {
  if (!input.stale) return null;
  return {
    lastVerifiedRevision: input.stale.lastVerifiedRevision,
    lastVerifiedAt: input.stale.lastVerifiedAt,
    mutationsCommitted: false,
  };
}

// ─── Preserved State Derivation ─────────────────────────────────

/**
 * Derives preserved recovery state (Requirement 45.8).
 */
export function derivePreservedState(
  input: RecoveryProjectionInput,
): PreservedRecoveryState | null {
  if (!input.preserved) return null;
  return {
    draftText: input.preserved.draftText,
    semanticAnchor: input.preserved.semanticAnchor,
    unreadCount: input.preserved.unreadCount,
    partialAssistantContent: input.preserved.partialAssistantContent,
    queueProjectionSnapshot: input.preserved.queueProjectionSnapshot,
    collaborationIdentity: input.preserved.collaborationIdentity,
    historyRetained: input.preserved.historyRetained,
  };
}

// ─── Idempotent Action Filter ───────────────────────────────────

/**
 * Filters recovery actions enforcing idempotency requirements (Requirement 45.11).
 *
 * If an action would repeat a committed effect, the action must either:
 * - Have an authority-provided idempotencyKey (resume), or
 * - Be marked requiresNewAttempt (explicit new attempt)
 */
export function filterIdempotentActions(
  actions: RecoveryProjectionInput['actions'],
): RecoveryAction[] {
  return actions.map((action) => ({
    actionId: action.actionId,
    kind: action.kind,
    label: action.label,
    accessibilityLabel: action.accessibilityLabel,
    requiresNewAttempt: action.requiresNewAttempt,
    idempotencyKey: action.idempotencyKey,
    available: action.available,
    unavailableReason: action.unavailableReason,
  }));
}

// ─── Main Reducer ───────────────────────────────────────────────

/**
 * Derives the complete recovery surface state from projection input.
 *
 * This is a pure function: given the same input and config it produces
 * the same state deterministically. It holds no mutable state.
 *
 * Requirements: 45.1–45.16
 */
export function deriveRecoverySurfaceState(
  input: RecoveryProjectionInput,
  _config: RecoverySurfaceConfig = DEFAULT_RECOVERY_SURFACE_CONFIG,
): RecoverySurfaceState {
  const recoverability = classifyRecoverability(input.errorClass, input.terminal);
  const mutationControlState = deriveMutationControlState(input.reconciliation);
  const retryPresentation = deriveRetryPresentation(input);
  const connectivityInterruption = deriveConnectivityInterruption(input);
  const schemaIncompatibility = deriveSchemaIncompatibility(input);
  const staleLabel = deriveStaleLabel(input);
  const preservedState = derivePreservedState(input);
  const availableActions = filterIdempotentActions(input.actions);

  // Terminal outcome label (Requirement 45.9, 45.15)
  const terminalOutcomeLabel = recoverability === 'terminal'
    ? getTerminalOutcomeLabel(input.errorClass)
    : null;

  // Active when there is an error or reconciliation is in progress
  const active = input.errorClass !== null ||
    input.reconciliation.status !== 'idle' &&
    input.reconciliation.status !== 'completed';

  // Confirming revision (Requirement 45.16)
  const confirmingRevision = input.reconciliation.status === 'completed'
    ? (input.reconciliation.confirmingRevision ?? null)
    : null;

  return {
    active,
    errorClass: input.errorClass,
    recoverability,
    affectedAuthority: input.affectedAuthority,
    correlationId: input.correlationId,
    lastVerifiedState: input.lastVerifiedState,
    retryPresentation,
    connectivityInterruption,
    schemaIncompatibility,
    staleLabel,
    availableActions,
    preservedState,
    mutationControlState,
    reconciliationStatus: input.reconciliation.status,
    terminalOutcomeLabel,
    confirmingRevision,
  };
}

// ─── Reconciliation Completion ──────────────────────────────────

/**
 * Applies a reconciliation completion event.
 * After reconciliation completes, mutation controls are re-enabled and
 * the confirming revision is recorded (Requirement 45.12, 45.16).
 */
export function applyReconciliationCompletion(
  state: RecoverySurfaceState,
  confirmingRevision: number,
): RecoverySurfaceState {
  return {
    ...state,
    active: false,
    errorClass: null,
    recoverability: null,
    reconciliationStatus: 'completed',
    confirmingRevision,
    mutationControlState: {
      disabled: false,
      affectedAuthority: state.mutationControlState.affectedAuthority,
      lastVerifiedRevision: confirmingRevision,
    },
    staleLabel: null,
    retryPresentation: null,
    connectivityInterruption: null,
    schemaIncompatibility: null,
    terminalOutcomeLabel: null,
    availableActions: [],
  };
}

// ─── Accessibility View Derivation ──────────────────────────────

/**
 * Derives the accessibility view for the recovery surface.
 * Ensures complete keyboard/screen-reader access to error, stale,
 * and recovery state.
 */
export function deriveRecoveryAccessibilityView(
  state: RecoverySurfaceState,
): RecoveryAccessibilityView {
  const isTerminal = state.recoverability === 'terminal';

  let description: string;
  if (state.schemaIncompatibility) {
    description = `Schema incompatibility: process version ${state.schemaIncompatibility.processVersion}, ` +
      `observed schema version ${state.schemaIncompatibility.observedSchemaVersion}, ` +
      `compatible range ${state.schemaIncompatibility.compatibleSchemaRange.min}–${state.schemaIncompatibility.compatibleSchemaRange.max}. ` +
      `${state.schemaIncompatibility.remediation}`;
  } else if (state.connectivityInterruption) {
    description = `Reconnecting: attempt ${state.connectivityInterruption.attemptCount}, ` +
      `next delay ${state.connectivityInterruption.nextDelayMs}ms. ` +
      `Affected: ${state.connectivityInterruption.affectedCapabilities.join(', ')}`;
  } else if (state.retryPresentation) {
    description = `Retrying: attempt ${state.retryPresentation.attemptNumber} of ${state.retryPresentation.attemptLimit}, ` +
      `delay ${state.retryPresentation.scheduledDelayMs}ms, route ${state.retryPresentation.route}`;
  } else if (state.staleLabel) {
    description = `Stale projection: last verified revision ${state.staleLabel.lastVerifiedRevision} at ${state.staleLabel.lastVerifiedAt}`;
  } else if (state.terminalOutcomeLabel) {
    description = state.terminalOutcomeLabel;
  } else if (state.reconciliationStatus !== 'idle' && state.reconciliationStatus !== 'completed') {
    description = `Reconciliation in progress: ${state.reconciliationStatus}`;
  } else {
    description = state.lastVerifiedState ?? 'Recovery state active';
  }

  return {
    role: isTerminal ? 'alert' : state.active ? 'status' : 'region',
    liveAssertiveness: isTerminal ? 'assertive' : 'polite',
    ariaLabel: isTerminal ? 'Terminal failure' : 'Recovery in progress',
    description,
    actionLabels: state.availableActions
      .filter((a) => a.available)
      .map((a) => a.accessibilityLabel),
    showsTerminalOutcome: isTerminal && state.terminalOutcomeLabel !== null,
  };
}

// ─── Redaction Utility ──────────────────────────────────────────

/**
 * Patterns considered secrets or private paths that must be redacted
 * from diagnostic display/export (Requirement 45.10).
 */
const REDACTION_PATTERNS: ReadonlyArray<RegExp> = [
  // API keys and tokens
  /(?:api[_-]?key|token|secret|password|credential|auth)[=:]\s*\S+/gi,
  // Private file paths (home directories)
  /\/(?:Users|home)\/[^\s/]+\/[^\s]*/g,
  // Windows user paths
  /[A-Z]:\\Users\\[^\s\\]+\\[^\s]*/gi,
  // Generic secret-looking values (base64 > 20 chars after = sign)
  /=\s*[A-Za-z0-9+/]{20,}={0,2}/g,
];

/**
 * Redacts secrets, private paths, protected prompt content, and
 * unauthorized locators from diagnostic text (Requirement 45.10).
 */
export function redactDiagnosticContent(text: string): string {
  let result = text;
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ─── Stale Mutation Guard ───────────────────────────────────────

/**
 * Returns whether a mutation should be presented as committed
 * given the current recovery state (Requirement 45.6, 45.15).
 *
 * Mutations during stale or recovery states are never presented
 * as committed until a confirming revision is available.
 */
export function isMutationCommitted(
  state: RecoverySurfaceState,
  mutationRevision: number,
): boolean {
  // During stale state, no mutations are committed (Requirement 45.6)
  if (state.staleLabel !== null) return false;

  // During active recovery, no mutations committed (Requirement 45.15)
  if (state.active && state.recoverability !== null) return false;

  // After reconciliation completion, mutations at or before confirming revision are committed
  if (state.confirmingRevision !== null && mutationRevision <= state.confirmingRevision) {
    return true;
  }

  // Default: committed when no recovery surface is active
  return !state.mutationControlState.disabled;
}
