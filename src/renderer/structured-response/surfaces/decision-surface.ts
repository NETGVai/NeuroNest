/**
 * Decision Surface — concise non-interactive timeline summary for
 * questions, approvals, permissions, and plan reviews.
 *
 * Renders exactly one non-interactive card per collaboration identity in the
 * timeline. The card shows decision type, owner, scope, risk, expiry, and
 * authority state. Interactive controls are owned exclusively by the
 * Composer_Workbench collaboration takeover; this surface suppresses duplicate
 * interactive elements for the same collaboration identity.
 *
 * Authority state is retained with a separate submission-pending indication
 * until a compatible Projection_Service revision confirms, rejects, expires,
 * or supersedes the decision. Conflicting authority responses that include any
 * compatible confirmation resolve to the confirmation outcome.
 *
 * Requirements: 9.1–9.12, 16.8, 18.6
 */

import type { DecisionBlockV1 } from '../../../harness/contracts/response-composition';

// ─── Public Types ───────────────────────────────────────────────

export type DecisionType = 'question' | 'approval' | 'permission' | 'plan_review';

export type DecisionState =
  | 'pending'
  | 'answered'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'superseded'
  | 'unavailable';

export const TERMINAL_DECISION_STATES: ReadonlySet<DecisionState> = new Set([
  'answered',
  'approved',
  'denied',
  'expired',
  'superseded',
]);

export interface DecisionSurfaceHandle {
  readonly element: HTMLElement;
  readonly collaborationId: string;
  readonly canonicalStableKey: string;
  readonly decisionType: DecisionType;
  readonly state: DecisionState;
  readonly submissionPending: boolean;
  readonly disposed: boolean;
  dispose(): void;
}

export interface DecisionSurfaceContext {
  /**
   * Set of collaboration IDs currently owned by the composer takeover.
   * The surface suppresses duplicate interactive controls for these.
   */
  readonly suppressedCollaborationIds?: ReadonlySet<string>;
  /**
   * Whether a submission is pending confirmation for this collaboration identity.
   */
  readonly submissionPendingIds?: ReadonlySet<string>;
  /**
   * Conflicting authority responses keyed by collaborationId.
   * If any response is a compatible confirmation, that takes precedence.
   */
  readonly conflictingResponses?: ReadonlyMap<string, readonly DecisionState[]>;
}

// ─── Constants ──────────────────────────────────────────────────

export const DECISION_SURFACE_CSS_CLASS = 'nn-decision-surface';

const DECISION_TYPE_LABELS: Readonly<Record<DecisionType, string>> = Object.freeze({
  question: 'Question',
  approval: 'Approval',
  permission: 'Permission',
  plan_review: 'Plan Review',
});

const DECISION_TYPE_ICONS: Readonly<Record<DecisionType, string>> = Object.freeze({
  question: '\u2753',     // ❓
  approval: '\u2705',     // ✅ (request)
  permission: '\u{1F512}', // 🔒
  plan_review: '\u{1F4CB}', // 📋
});

const DECISION_STATE_LABELS: Readonly<Record<DecisionState, string>> = Object.freeze({
  pending: 'Pending',
  answered: 'Answered',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
  superseded: 'Superseded',
  unavailable: 'Unavailable',
});

const DECISION_STATE_INDICATORS: Readonly<Record<DecisionState, string>> = Object.freeze({
  pending: '\u25CB',      // ○
  answered: '\u2713',     // ✓
  approved: '\u2713',     // ✓
  denied: '\u2717',       // ✗
  expired: '\u23F1',      // ⏱
  superseded: '\u21B7',   // ↷
  unavailable: '\u2014',  // —
});

/**
 * Confirmation states that take precedence when conflicting responses exist.
 * Per Requirement 9.8: any compatible confirmation takes precedence.
 */
const CONFIRMATION_STATES: ReadonlySet<DecisionState> = new Set([
  'answered',
  'approved',
]);

// ─── Conflict Resolution ────────────────────────────────────────

/**
 * Resolve conflicting authority responses for a collaboration identity.
 * Per Requirement 9.8, any compatible confirmation takes precedence regardless
 * of the other conflicting responses.
 */
export function resolveConflictingResponses(responses: readonly DecisionState[]): DecisionState | null {
  if (responses.length === 0) return null;

  // Any compatible confirmation takes precedence
  for (const response of responses) {
    if (CONFIRMATION_STATES.has(response)) {
      return response;
    }
  }

  // If no confirmation exists, return the first non-pending terminal state
  for (const response of responses) {
    if (TERMINAL_DECISION_STATES.has(response)) {
      return response;
    }
  }

  // All responses are non-terminal, non-confirmation — return the first
  return responses[0] ?? null;
}

// ─── Duplicate Suppression ──────────────────────────────────────

/**
 * Determine whether duplicate interactive controls should be suppressed
 * for a given collaboration identity. The composer takeover owns
 * interactive decision controls; the timeline shows only a summary.
 *
 * Requirement 9.2: suppress duplicate interactive card for same identity.
 */
export function shouldSuppressInteraction(
  _collaborationId: string,
  _context: DecisionSurfaceContext,
): boolean {
  // Always suppress interactive controls in the timeline surface.
  // The composer takeover owns interactive decision controls exclusively.
  // This surface is non-interactive by design.
  return true;
}

/**
 * Determine whether the collaboration is currently owned by the takeover.
 */
export function isOwnedByTakeover(
  collaborationId: string,
  context: DecisionSurfaceContext,
): boolean {
  return context.suppressedCollaborationIds?.has(collaborationId) ?? false;
}

// ─── Submission Pending ─────────────────────────────────────────

/**
 * Determine if a decision submission is pending for this collaboration.
 * Per Requirement 9.5–9.6: retain pre-submission authority state with a
 * separate submission-pending indication until confirmation/rejection/expiry/supersession.
 */
export function isSubmissionPending(
  collaborationId: string,
  context: DecisionSurfaceContext,
): boolean {
  return context.submissionPendingIds?.has(collaborationId) ?? false;
}

// ─── Stale Control Detection ────────────────────────────────────

/**
 * Determine if the decision controls for this block are stale.
 * Per Requirement 9.10: if scope, arguments, owner, risk, tool version,
 * plan revision, expiry, or Approval_Digest changes, controls become stale.
 */
export function isControlStale(
  previousBlock: DecisionBlockV1 | null,
  currentBlock: DecisionBlockV1,
): boolean {
  if (!previousBlock) return false;

  // Controls are stale if contract revision or digest changed
  return (
    previousBlock.content.contractRevision !== currentBlock.content.contractRevision ||
    previousBlock.content.contractDigest !== currentBlock.content.contractDigest
  );
}

// ─── DOM Rendering ──────────────────────────────────────────────

function createTypeIndicator(type: DecisionType): HTMLElement {
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__type-icon`;
  el.textContent = DECISION_TYPE_ICONS[type];
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function createTypeLabel(type: DecisionType): HTMLElement {
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__type`;
  el.textContent = DECISION_TYPE_LABELS[type];
  return el;
}

function createOwnerLabel(owner: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__owner`;
  el.textContent = owner;
  return el;
}

function createScopeLabel(scope: string | undefined): HTMLElement | null {
  if (!scope) return null;
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__scope`;
  el.textContent = scope;
  return el;
}

function createRiskLabel(risk: string | undefined): HTMLElement | null {
  if (!risk) return null;
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__risk`;
  el.textContent = risk;
  return el;
}

function createExpiryLabel(expiresAt: string | undefined): HTMLElement | null {
  if (!expiresAt) return null;
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__expiry`;
  el.textContent = `Expires: ${formatExpiry(expiresAt)}`;
  return el;
}

function createStateIndicator(state: DecisionState, submissionPending: boolean): HTMLElement {
  const container = document.createElement('span');
  container.className = `${DECISION_SURFACE_CSS_CLASS}__state`;
  container.dataset.state = state;

  const indicator = document.createElement('span');
  indicator.className = `${DECISION_SURFACE_CSS_CLASS}__state-indicator`;
  indicator.textContent = DECISION_STATE_INDICATORS[state];
  indicator.setAttribute('aria-hidden', 'true');
  container.appendChild(indicator);

  const label = document.createElement('span');
  label.className = `${DECISION_SURFACE_CSS_CLASS}__state-label`;
  label.textContent = DECISION_STATE_LABELS[state];
  container.appendChild(label);

  if (submissionPending) {
    const pendingEl = document.createElement('span');
    pendingEl.className = `${DECISION_SURFACE_CSS_CLASS}__submission-pending`;
    pendingEl.textContent = '(Awaiting confirmation)';
    pendingEl.setAttribute('aria-label', 'Decision submitted, awaiting authority confirmation');
    container.appendChild(pendingEl);
  }

  return container;
}

function createPromptSummary(prompt: string): HTMLElement {
  const el = document.createElement('p');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__prompt`;
  el.textContent = prompt.length > 512 ? `${prompt.slice(0, 509)}...` : prompt;
  return el;
}

function createRevisionInfo(revision: number, digest: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `${DECISION_SURFACE_CSS_CLASS}__revision`;
  el.textContent = `Rev ${revision}`;
  el.title = `Digest: ${digest}`;
  el.setAttribute('aria-label', `Contract revision ${revision}, digest ${digest.slice(0, 8)}`);
  return el;
}

function formatExpiry(expiresAt: string): string {
  try {
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) return expiresAt;
    return date.toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return expiresAt;
  }
}

function buildAriaLabel(block: DecisionBlockV1, submissionPending: boolean): string {
  const parts: string[] = [
    `Decision: ${DECISION_TYPE_LABELS[block.content.decisionType]}`,
    `Owner: ${block.content.owner}`,
    `State: ${DECISION_STATE_LABELS[block.content.state]}`,
  ];

  if (block.content.scopeSummary) {
    parts.push(`Scope: ${block.content.scopeSummary}`);
  }
  if (block.content.riskSummary) {
    parts.push(`Risk: ${block.content.riskSummary}`);
  }
  if (block.content.expiresAt) {
    parts.push(`Expires: ${formatExpiry(block.content.expiresAt)}`);
  }
  if (submissionPending) {
    parts.push('Submission pending confirmation');
  }

  return parts.join('. ');
}

// ─── Surface Render ─────────────────────────────────────────────

/**
 * Render a concise, non-interactive DecisionSurface in the timeline.
 *
 * - Exactly one per collaboration identity (keyed by block stableKey)
 * - Non-interactive: no buttons, forms, or submission controls
 * - Shows type, owner, scope, risk, expiry, and authority state
 * - Retains authority state until compatible projection confirms
 * - Separate submission-pending indication
 * - Suppresses duplicate interactive controls (those are in the composer)
 *
 * Requirements: 9.1–9.12
 */
export function renderDecisionSurface(
  block: DecisionBlockV1,
  context: DecisionSurfaceContext = {},
): DecisionSurfaceHandle {
  const root = document.createElement('article');
  root.className = DECISION_SURFACE_CSS_CLASS;
  root.setAttribute('role', 'region');
  root.dataset.stableKey = block.stableKey;
  root.dataset.collaborationId = block.content.collaborationId;
  root.dataset.canonicalStableKey = block.content.canonicalStableKey;
  root.dataset.state = block.content.state;
  root.dataset.decisionType = block.content.decisionType;

  // Resolve effective state from conflicting responses
  const effectiveState = resolveEffectiveState(block, context);
  const submissionPending = isSubmissionPending(block.content.collaborationId, context);

  // Set aria-label
  const ariaBlock = { ...block, content: { ...block.content, state: effectiveState } };
  root.setAttribute('aria-label', buildAriaLabel(ariaBlock as DecisionBlockV1, submissionPending));

  // Mark non-interactive — no form semantics
  // Requirement 9.2: suppress duplicate interactive card for same identity
  root.setAttribute('aria-roledescription', 'decision summary');

  // Header row: type icon, type label, owner, revision
  const header = document.createElement('div');
  header.className = `${DECISION_SURFACE_CSS_CLASS}__header`;
  header.appendChild(createTypeIndicator(block.content.decisionType));
  header.appendChild(createTypeLabel(block.content.decisionType));
  header.appendChild(createOwnerLabel(block.content.owner));
  header.appendChild(createRevisionInfo(block.content.contractRevision, block.content.contractDigest));
  root.appendChild(header);

  // Prompt summary
  root.appendChild(createPromptSummary(block.content.prompt));

  // Metadata row: scope, risk, expiry
  const meta = document.createElement('div');
  meta.className = `${DECISION_SURFACE_CSS_CLASS}__meta`;

  const scopeEl = createScopeLabel(block.content.scopeSummary);
  if (scopeEl) meta.appendChild(scopeEl);

  const riskEl = createRiskLabel(block.content.riskSummary);
  if (riskEl) meta.appendChild(riskEl);

  const expiryEl = createExpiryLabel(block.content.expiresAt);
  if (expiryEl) meta.appendChild(expiryEl);

  if (meta.children.length > 0) {
    root.appendChild(meta);
  }

  // State indicator with submission-pending
  root.appendChild(createStateIndicator(effectiveState, submissionPending));

  // Internal state
  let disposed = false;
  let currentState = effectiveState;
  let currentSubmissionPending = submissionPending;

  const handle: DecisionSurfaceHandle = {
    get element() { return root; },
    get collaborationId() { return block.content.collaborationId; },
    get canonicalStableKey() { return block.content.canonicalStableKey; },
    get decisionType() { return block.content.decisionType; },
    get state() { return currentState; },
    get submissionPending() { return currentSubmissionPending; },
    get disposed() { return disposed; },

    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      root.replaceChildren();
    },
  };

  return handle;
}

/**
 * Resolve the effective display state for a decision block, taking into
 * account conflicting authority responses. Per Requirement 9.8, any
 * compatible confirmation takes precedence.
 */
function resolveEffectiveState(
  block: DecisionBlockV1,
  context: DecisionSurfaceContext,
): DecisionState {
  const conflicts = context.conflictingResponses?.get(block.content.collaborationId);
  if (conflicts && conflicts.length > 0) {
    const resolved = resolveConflictingResponses(conflicts);
    if (resolved !== null) {
      return resolved;
    }
  }
  return block.content.state;
}

/**
 * Update an existing DecisionSurface with new block data.
 * Preserves the element identity, re-renders content.
 */
export function updateDecisionSurface(
  handle: DecisionSurfaceHandle,
  block: DecisionBlockV1,
  context: DecisionSurfaceContext = {},
): DecisionSurfaceHandle {
  if (handle.disposed) return handle;

  // Dispose existing and re-render
  const parent = handle.element.parentNode;
  const nextSibling = handle.element.nextSibling;
  handle.dispose();

  const newHandle = renderDecisionSurface(block, context);

  // Re-attach to DOM if previously attached
  if (parent) {
    if (nextSibling) {
      parent.insertBefore(newHandle.element, nextSibling);
    } else {
      parent.appendChild(newHandle.element);
    }
  }

  return newHandle;
}

// ─── Surface Adapter ────────────────────────────────────────────

/**
 * Closed surface adapter conforming to ResponseSurfaceAdapter<'decision'>.
 *
 * The adapter is non-interactive by design. All interactive decision controls
 * are owned exclusively by the Composer_Workbench collaboration takeover.
 * This surface shows only a concise summary.
 *
 * Requirement 9.2: suppress duplicate interactive card for same collaboration identity.
 * Requirement 9.5: retain pre-submission authority state until compatible projection confirms.
 * Requirement 9.6: separate submission-pending indication.
 * Requirement 9.8: conflicting responses — any compatible confirmation takes precedence.
 * Requirement 9.12: no optimistic success styling before authority confirmation.
 */
export const DecisionSurface = Object.freeze({
  kind: 'decision' as const,

  render(
    block: DecisionBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: unknown },
  ): DecisionSurfaceHandle {
    const surfaceContext = extractDecisionContext(context);
    return renderDecisionSurface(block, surfaceContext);
  },

  update(
    handle: object,
    _previous: DecisionBlockV1,
    next: DecisionBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: unknown },
  ): void {
    const surfaceHandle = handle as DecisionSurfaceHandle;
    const surfaceContext = extractDecisionContext(context);
    const newHandle = updateDecisionSurface(surfaceHandle, next, surfaceContext);

    // Replace element in parent if the handle was already mounted
    const parent = surfaceHandle.element.parentNode;
    if (parent && newHandle.element !== surfaceHandle.element) {
      parent.replaceChild(newHandle.element, surfaceHandle.element);
    }
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as DecisionSurfaceHandle;
    surfaceHandle.dispose();
  },
});

/**
 * Extract typed DecisionSurfaceContext from the generic context record.
 */
function extractDecisionContext(context: Record<string, unknown>): DecisionSurfaceContext {
  const result: DecisionSurfaceContext = {};
  const raw = context as Record<string, unknown>;

  if (raw['suppressedCollaborationIds'] instanceof Set) {
    (result as { suppressedCollaborationIds?: ReadonlySet<string> }).suppressedCollaborationIds =
      raw['suppressedCollaborationIds'] as ReadonlySet<string>;
  }

  if (raw['submissionPendingIds'] instanceof Set) {
    (result as { submissionPendingIds?: ReadonlySet<string> }).submissionPendingIds =
      raw['submissionPendingIds'] as ReadonlySet<string>;
  }

  if (raw['conflictingResponses'] instanceof Map) {
    (result as { conflictingResponses?: ReadonlyMap<string, readonly DecisionState[]> }).conflictingResponses =
      raw['conflictingResponses'] as ReadonlyMap<string, readonly DecisionState[]>;
  }

  return result;
}
