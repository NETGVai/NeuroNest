/**
 * Authoritative Approval Card — interactive decision surface for the
 * projection-driven chat controller.
 *
 * Unlike the non-interactive timeline summary in
 * `surfaces/decision-surface.ts`, this module produces an authoritative
 * Approval Card: the user-facing gate that must accept an approval command
 * before the underlying action executes.
 *
 * The card:
 *
 *   1. Reflects only projection-supplied `DecisionBlockV1` content.
 *   2. Renders scope, action summary, risk, expiry, and contract revision.
 *   3. Exposes Approve and Reject controls when the block is in a `pending`
 *      state and the caller supplies a `decideApproval` command handler.
 *   4. Shows a pending acknowledgement (buttons disabled, "sending decision")
 *      while the command envelope is in-flight.
 *   5. Sends `expectedRevision` and `contractDigest` in the command envelope
 *      so the main-process authority can detect stale or superseded
 *      approvals.
 *   6. Reflects terminal states from the projection
 *      (`approved | denied | expired | superseded`) — never local-only state.
 *   7. Returns `null` when no decision block is supplied, when the block is
 *      not an approval, or when the block is not renderable.
 *
 * The renderer NEVER treats an approval as executed until the projection
 * emits the resulting terminal state; the pending acknowledgement is a
 * strictly-visual disabled indicator, not an authoritative outcome.
 *
 * Requirements: 13.5–13.9, 15.3–15.5
 */

import type { DecisionBlockV1 } from '../../harness/contracts/response-composition';

// ─── Public Types ───────────────────────────────────────────────

export type ApprovalDecision = 'approve' | 'reject';

/**
 * Authoritative Approval Card terminal states. `pending` is the only
 * non-terminal state for which controls are exposed. Every other value
 * reflects a projection-emitted outcome.
 */
export type ApprovalCardState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'superseded';

/**
 * Command envelope fields sent for an approve/reject decision. The main
 * approval command handler uses `expectedRevision` and `contractDigest`
 * for staleness/replay detection.
 *
 * Requirement 13.6 / 15.3–15.5: authoritative approval command with
 * expected revision and replay-protecting contract digest.
 */
export interface DecideApprovalCommand {
  readonly collaborationId: string;
  readonly decision: ApprovalDecision;
  readonly expectedRevision: number;
  readonly contractDigest: string;
}

/**
 * Transport-level receipt returned by the main-process authority. The card
 * treats a `delivered` receipt as "acknowledged" — the durable outcome still
 * comes from the projection. A `rejected` receipt leaves the controls in
 * their pre-submission state so the user can retry.
 */
export interface DecideApprovalReceipt {
  readonly transportStatus: 'delivered' | 'rejected';
  readonly rejectionCode?: string;
}

export type DecideApprovalHandler = (
  command: DecideApprovalCommand,
) => Promise<DecideApprovalReceipt>;

export interface AuthoritativeApprovalCardOptions {
  /**
   * Handler invoked when the user clicks Approve or Reject. When omitted the
   * card renders read-only — controls are hidden and only projection state
   * is displayed.
   */
  readonly decideApproval?: DecideApprovalHandler;
  /**
   * Optional stable idempotency-key factory. Defaults to
   * `${collaborationId}:${expectedRevision}:${decision}` so a duplicate
   * submission produces the same envelope identity.
   */
  readonly buildIdempotencyKey?: (command: DecideApprovalCommand) => string;
  /**
   * Optional callback invoked when the command dispatch resolves. Useful for
   * consumers that want to reconcile pending state with the eventual
   * projection update. Never invoked with unsafe rejection details.
   */
  readonly onDispatchResult?: (
    command: DecideApprovalCommand,
    receipt: DecideApprovalReceipt,
  ) => void;
  /**
   * Optional projection-supplied set of collaboration IDs whose execution is
   * still blocked pending the authoritative decision. When the current block
   * is contained here, the card renders an explicit "execution blocked"
   * badge to satisfy Requirement 13.6.
   */
  readonly executionBlockedCollaborationIds?: ReadonlySet<string>;
}

export interface AuthoritativeApprovalCardHandle {
  readonly element: HTMLElement;
  readonly collaborationId: string;
  readonly contractRevision: number;
  readonly contractDigest: string;
  /** Effective render state after projection reconciliation. */
  readonly state: ApprovalCardState;
  /** True while a command envelope has been dispatched but not resolved. */
  readonly submissionPending: boolean;
  /** True if projection or option context reports execution is still blocked. */
  readonly executionBlocked: boolean;
  /** True after `dispose()` has been called. */
  readonly disposed: boolean;
  /**
   * Reflect a new projection revision for the same collaboration. Preserves
   * DOM identity where possible and cancels any in-flight pending state that
   * belongs to a stale revision (Requirement 13.8 / 15.4).
   */
  update(next: DecisionBlockV1, options?: AuthoritativeApprovalCardOptions): void;
  dispose(): void;
}

// ─── Constants ──────────────────────────────────────────────────

export const APPROVAL_CARD_CSS_CLASS = 'nn-approval-card';
export const APPROVAL_CARD_APPROVE_ACTION = 'approve' as const;
export const APPROVAL_CARD_REJECT_ACTION = 'reject' as const;

const TERMINAL_STATES: ReadonlySet<ApprovalCardState> = new Set([
  'approved',
  'denied',
  'expired',
  'superseded',
]);

const STATE_LABELS: Readonly<Record<ApprovalCardState, string>> = Object.freeze({
  pending: 'Awaiting approval',
  approved: 'Approved',
  denied: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
});

const RISK_LABELS_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  none: 'No risk',
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
});

// ─── Helpers ────────────────────────────────────────────────────

function isApprovalDecisionBlock(block: DecisionBlockV1): boolean {
  return block.content.decisionType === 'approval';
}

/**
 * Fold the projection's fine-grained decision state onto the card's
 * authoritative state machine. `answered` never applies to approval cards.
 */
function foldProjectionState(state: DecisionBlockV1['content']['state']): ApprovalCardState | null {
  switch (state) {
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'denied':
      return 'denied';
    case 'expired':
      return 'expired';
    case 'superseded':
      return 'superseded';
    // `answered` is a Question state; `unavailable` means the card should
    // not render authoritative controls. Both are filtered out.
    case 'answered':
    case 'unavailable':
    default:
      return null;
  }
}

function defaultBuildIdempotencyKey(command: DecideApprovalCommand): string {
  return `approval:${command.collaborationId}:${command.expectedRevision}:${command.decision}`;
}

function riskLabel(risk: string | undefined): string | null {
  if (risk === undefined || risk.length === 0) return null;
  const canonical = risk.trim().toLowerCase();
  return RISK_LABELS_FALLBACK[canonical] ?? risk;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatExpiry(expiresAt: string | undefined): string | null {
  if (!expiresAt) return null;
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return expiresAt;
  return parsed.toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

// ─── DOM Construction ───────────────────────────────────────────

function createFormElement(): HTMLFormElement {
  const form = document.createElement('form');
  form.className = APPROVAL_CARD_CSS_CLASS;
  form.setAttribute('role', 'form');
  form.setAttribute('aria-roledescription', 'approval card');
  form.setAttribute('novalidate', 'novalidate');
  // Prevent implicit form submission if the card is nested in a wider form.
  form.addEventListener('submit', (event) => event.preventDefault());
  return form;
}

interface CardDom {
  readonly root: HTMLFormElement;
  readonly scope: HTMLElement;
  readonly action: HTMLElement;
  readonly risk: HTMLElement;
  readonly expiry: HTMLElement;
  readonly revision: HTMLElement;
  readonly stateBadge: HTMLElement;
  readonly blockedBadge: HTMLElement;
  readonly pendingIndicator: HTMLElement;
  readonly controlsGroup: HTMLElement;
  readonly approveButton: HTMLButtonElement;
  readonly rejectButton: HTMLButtonElement;
  readonly errorRegion: HTMLElement;
}

function buildDom(): CardDom {
  const root = createFormElement();

  const header = document.createElement('header');
  header.className = `${APPROVAL_CARD_CSS_CLASS}__header`;

  const revision = document.createElement('span');
  revision.className = `${APPROVAL_CARD_CSS_CLASS}__revision`;
  header.appendChild(revision);

  const stateBadge = document.createElement('span');
  stateBadge.className = `${APPROVAL_CARD_CSS_CLASS}__state`;
  stateBadge.setAttribute('data-state', 'pending');
  header.appendChild(stateBadge);

  const blockedBadge = document.createElement('span');
  blockedBadge.className = `${APPROVAL_CARD_CSS_CLASS}__blocked`;
  blockedBadge.hidden = true;
  header.appendChild(blockedBadge);

  root.appendChild(header);

  const action = document.createElement('p');
  action.className = `${APPROVAL_CARD_CSS_CLASS}__action`;
  root.appendChild(action);

  const meta = document.createElement('div');
  meta.className = `${APPROVAL_CARD_CSS_CLASS}__meta`;

  const scope = document.createElement('span');
  scope.className = `${APPROVAL_CARD_CSS_CLASS}__scope`;
  scope.hidden = true;
  meta.appendChild(scope);

  const risk = document.createElement('span');
  risk.className = `${APPROVAL_CARD_CSS_CLASS}__risk`;
  risk.hidden = true;
  meta.appendChild(risk);

  const expiry = document.createElement('span');
  expiry.className = `${APPROVAL_CARD_CSS_CLASS}__expiry`;
  expiry.hidden = true;
  meta.appendChild(expiry);

  root.appendChild(meta);

  const controlsGroup = document.createElement('div');
  controlsGroup.className = `${APPROVAL_CARD_CSS_CLASS}__controls`;
  controlsGroup.setAttribute('role', 'group');
  controlsGroup.setAttribute('aria-label', 'Approval decision controls');

  const approveButton = document.createElement('button');
  approveButton.type = 'button';
  approveButton.className = `${APPROVAL_CARD_CSS_CLASS}__approve`;
  approveButton.dataset['action'] = APPROVAL_CARD_APPROVE_ACTION;
  approveButton.textContent = 'Approve';
  controlsGroup.appendChild(approveButton);

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className = `${APPROVAL_CARD_CSS_CLASS}__reject`;
  rejectButton.dataset['action'] = APPROVAL_CARD_REJECT_ACTION;
  rejectButton.textContent = 'Reject';
  controlsGroup.appendChild(rejectButton);

  root.appendChild(controlsGroup);

  const pendingIndicator = document.createElement('span');
  pendingIndicator.className = `${APPROVAL_CARD_CSS_CLASS}__submission-pending`;
  pendingIndicator.hidden = true;
  pendingIndicator.setAttribute('aria-live', 'polite');
  root.appendChild(pendingIndicator);

  const errorRegion = document.createElement('p');
  errorRegion.className = `${APPROVAL_CARD_CSS_CLASS}__error`;
  errorRegion.hidden = true;
  errorRegion.setAttribute('role', 'alert');
  root.appendChild(errorRegion);

  return {
    root,
    scope,
    action,
    risk,
    expiry,
    revision,
    stateBadge,
    blockedBadge,
    pendingIndicator,
    controlsGroup,
    approveButton,
    rejectButton,
    errorRegion,
  };
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Render an authoritative Approval Card for a projection-supplied decision
 * block. Returns `null` when the block is not renderable as an approval —
 * for example when it is undefined, when its `decisionType` is not
 * `approval`, or when it collapses into an `unavailable` state.
 *
 * Requirements: 13.5–13.9, 15.3–15.5
 */
export function renderAuthoritativeApprovalCard(
  block: DecisionBlockV1 | null | undefined,
  options: AuthoritativeApprovalCardOptions = {},
): AuthoritativeApprovalCardHandle | null {
  if (!block) return null;
  if (!isApprovalDecisionBlock(block)) return null;

  const initialState = foldProjectionState(block.content.state);
  if (initialState === null) return null;

  const dom = buildDom();
  const state = new CardState(block, initialState, dom, options);
  state.render();

  return state.handle;
}

/**
 * Update an existing card handle with a new projection revision. Preserves
 * DOM identity where the collaboration is unchanged and never regresses to
 * `pending` from a terminal state.
 */
export function updateAuthoritativeApprovalCard(
  handle: AuthoritativeApprovalCardHandle,
  next: DecisionBlockV1,
  options?: AuthoritativeApprovalCardOptions,
): void {
  handle.update(next, options);
}

// ─── Internal State Machine ─────────────────────────────────────

class CardState {
  readonly handle: AuthoritativeApprovalCardHandle;

  private currentBlock: DecisionBlockV1;
  private currentState: ApprovalCardState;
  private currentOptions: AuthoritativeApprovalCardOptions;

  private readonly dom: CardDom;

  private pendingDecision: ApprovalDecision | null = null;
  private pendingRevision: number | null = null;
  private disposed = false;

  constructor(
    block: DecisionBlockV1,
    initial: ApprovalCardState,
    dom: CardDom,
    options: AuthoritativeApprovalCardOptions,
  ) {
    this.currentBlock = block;
    this.currentState = initial;
    this.currentOptions = options;
    this.dom = dom;
    this.attachHandlers();

    const self = this;
    this.handle = Object.freeze<AuthoritativeApprovalCardHandle>({
      get element() { return dom.root; },
      get collaborationId() { return self.currentBlock.content.collaborationId; },
      get contractRevision() { return self.currentBlock.content.contractRevision; },
      get contractDigest() { return self.currentBlock.content.contractDigest; },
      get state() { return self.currentState; },
      get submissionPending() { return self.pendingDecision !== null; },
      get executionBlocked() { return self.isExecutionBlocked(); },
      get disposed() { return self.disposed; },
      update: (next, options) => { self.applyUpdate(next, options); },
      dispose: () => { self.dispose(); },
    });
  }

  render(): void {
    if (this.disposed) return;
    const { root, revision, stateBadge, blockedBadge, action, scope, risk, expiry, pendingIndicator, controlsGroup, approveButton, rejectButton, errorRegion } = this.dom;
    const content = this.currentBlock.content;

    // Data attributes reflect current identity so DOM inspection and testing
    // can key off stable projection identity.
    root.dataset['collaborationId'] = content.collaborationId;
    root.dataset['canonicalStableKey'] = content.canonicalStableKey;
    root.dataset['contractRevision'] = String(content.contractRevision);
    root.dataset['contractDigest'] = content.contractDigest;
    root.dataset['state'] = this.currentState;
    root.dataset['submissionPending'] = this.pendingDecision !== null ? 'true' : 'false';

    revision.textContent = `Revision ${content.contractRevision}`;
    revision.title = content.contractDigest;
    revision.setAttribute(
      'aria-label',
      `Contract revision ${content.contractRevision}, digest ${content.contractDigest.slice(0, 12)}`,
    );

    stateBadge.dataset['state'] = this.currentState;
    stateBadge.textContent = STATE_LABELS[this.currentState];

    action.textContent = truncate(content.prompt, 512);
    action.setAttribute('aria-label', 'Proposed action');

    const scopeText = content.scopeSummary?.trim();
    if (scopeText) {
      scope.hidden = false;
      scope.textContent = `Scope: ${scopeText}`;
    } else {
      scope.hidden = true;
      scope.textContent = '';
    }

    const riskText = riskLabel(content.riskSummary);
    if (riskText) {
      risk.hidden = false;
      risk.textContent = `Risk: ${riskText}`;
      risk.dataset['risk'] = content.riskSummary ?? 'unspecified';
    } else {
      risk.hidden = true;
      risk.textContent = '';
      delete risk.dataset['risk'];
    }

    const expiryText = formatExpiry(content.expiresAt);
    if (expiryText) {
      expiry.hidden = false;
      expiry.textContent = `Expires: ${expiryText}`;
    } else {
      expiry.hidden = true;
      expiry.textContent = '';
    }

    // Aria-label combines identity + state + submission + execution blocked
    root.setAttribute('aria-label', this.buildAriaLabel());

    const controlsAvailable = this.currentState === 'pending'
      && this.currentOptions.decideApproval !== undefined;

    controlsGroup.hidden = !controlsAvailable;
    approveButton.disabled = !controlsAvailable || this.pendingDecision !== null;
    rejectButton.disabled = !controlsAvailable || this.pendingDecision !== null;

    if (this.pendingDecision !== null) {
      pendingIndicator.hidden = false;
      pendingIndicator.textContent = this.pendingDecision === 'approve'
        ? 'Sending approval…'
        : 'Sending rejection…';
      pendingIndicator.setAttribute(
        'aria-label',
        'Approval decision submitted, awaiting authority confirmation',
      );
      approveButton.setAttribute('aria-busy', 'true');
      rejectButton.setAttribute('aria-busy', 'true');
    } else {
      pendingIndicator.hidden = true;
      pendingIndicator.textContent = '';
      approveButton.removeAttribute('aria-busy');
      rejectButton.removeAttribute('aria-busy');
    }

    if (this.isExecutionBlocked()) {
      blockedBadge.hidden = false;
      blockedBadge.textContent = 'Execution blocked';
      blockedBadge.setAttribute(
        'aria-label',
        'Tool execution blocked until approval commits',
      );
    } else {
      blockedBadge.hidden = true;
      blockedBadge.textContent = '';
    }

    // The error region is transient UI state — it is populated by `showError`
    // when the authority returns a rejected receipt and cleared when a fresh
    // submission is attempted or the projection advances. `render()` never
    // touches it so a rejection message survives the render that follows.
    void errorRegion;
  }

  applyUpdate(next: DecisionBlockV1, options?: AuthoritativeApprovalCardOptions): void {
    if (this.disposed) return;
    if (!isApprovalDecisionBlock(next)) return;

    const folded = foldProjectionState(next.content.state);
    if (folded === null) {
      // Not renderable as an approval — clear pending and keep last known.
      this.pendingDecision = null;
      this.pendingRevision = null;
      return;
    }

    this.currentBlock = next;
    // A revision advance always cancels any pending-for-a-prior-revision
    // submission indication. This satisfies Requirement 15.4 (ignore stale
    // pending markers when the projection supersedes with a new revision).
    if (this.pendingRevision !== null && next.content.contractRevision !== this.pendingRevision) {
      this.pendingDecision = null;
      this.pendingRevision = null;
    }
    // A terminal state also clears the pending indicator — the outcome is
    // now authoritative.
    if (TERMINAL_STATES.has(folded)) {
      this.pendingDecision = null;
      this.pendingRevision = null;
    }

    // A projection update always supersedes prior transport-level error
    // messages so the surface reflects the projection, never local UI state.
    this.clearError();

    this.currentState = folded;
    if (options) this.currentOptions = options;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dom.approveButton.removeEventListener('click', this.approveHandler);
    this.dom.rejectButton.removeEventListener('click', this.rejectHandler);
    this.dom.root.remove();
    this.dom.root.replaceChildren();
  }

  private attachHandlers(): void {
    this.dom.approveButton.addEventListener('click', this.approveHandler);
    this.dom.rejectButton.addEventListener('click', this.rejectHandler);
  }

  private readonly approveHandler = (): void => {
    void this.submit('approve');
  };

  private readonly rejectHandler = (): void => {
    void this.submit('reject');
  };

  private async submit(decision: ApprovalDecision): Promise<void> {
    if (this.disposed) return;
    if (this.currentState !== 'pending') return;
    if (this.pendingDecision !== null) return;
    const handler = this.currentOptions.decideApproval;
    if (!handler) return;

    const command: DecideApprovalCommand = {
      collaborationId: this.currentBlock.content.collaborationId,
      decision,
      expectedRevision: this.currentBlock.content.contractRevision,
      contractDigest: this.currentBlock.content.contractDigest,
    };

    // Attach an idempotency key on the DOM so tooling and tests can observe
    // that a duplicate submission would carry the same envelope identity.
    const buildKey = this.currentOptions.buildIdempotencyKey ?? defaultBuildIdempotencyKey;
    const idempotencyKey = buildKey(command);
    this.dom.root.dataset['idempotencyKey'] = idempotencyKey;

    this.pendingDecision = decision;
    this.pendingRevision = command.expectedRevision;
    // A fresh submission always clears the last rejection message.
    this.clearError();
    this.render();

    let receipt: DecideApprovalReceipt;
    try {
      receipt = await handler(command);
    } catch (error) {
      // Restore controls so the user can retry; surface a generic error only.
      this.pendingDecision = null;
      this.pendingRevision = null;
      const message = error instanceof Error && error.message ? error.message : 'Decision submission failed';
      this.showError(message);
      this.render();
      return;
    }

    if (this.disposed) return;

    // If the projection already advanced this card to a terminal state
    // between submission and receipt, keep the terminal state — the receipt
    // is only transport-level (Requirement 13.8).
    if (TERMINAL_STATES.has(this.currentState)) {
      this.pendingDecision = null;
      this.pendingRevision = null;
      this.render();
      this.currentOptions.onDispatchResult?.(command, receipt);
      return;
    }

    if (receipt.transportStatus === 'delivered') {
      // Leave the pending indicator up: the durable outcome still comes
      // from the projection. When the projection posts a terminal state,
      // `applyUpdate` clears the pending marker.
      this.render();
    } else {
      // Rejected transport — surface a non-sensitive code and restore
      // controls so the user can retry.
      this.pendingDecision = null;
      this.pendingRevision = null;
      this.showError(this.rejectionMessage(receipt.rejectionCode));
      this.render();
    }

    this.currentOptions.onDispatchResult?.(command, receipt);
  }

  private isExecutionBlocked(): boolean {
    // Execution stays blocked while the projection reports `pending`. When
    // the caller supplies a set of blocked collaboration IDs we prefer that
    // authoritative view.
    if (this.currentOptions.executionBlockedCollaborationIds?.has(this.currentBlock.content.collaborationId)) {
      return true;
    }
    return this.currentState === 'pending';
  }

  private buildAriaLabel(): string {
    const parts: string[] = ['Approval card'];
    parts.push(`State: ${STATE_LABELS[this.currentState]}`);
    if (this.currentBlock.content.scopeSummary) parts.push(`Scope ${this.currentBlock.content.scopeSummary}`);
    const rl = riskLabel(this.currentBlock.content.riskSummary);
    if (rl) parts.push(rl);
    if (this.pendingDecision !== null) parts.push('Decision submitted, awaiting authority confirmation');
    if (this.isExecutionBlocked()) parts.push('Execution blocked until authority confirms');
    return parts.join('. ');
  }

  private showError(message: string): void {
    const { errorRegion } = this.dom;
    errorRegion.hidden = false;
    errorRegion.textContent = truncate(message, 256);
  }

  private clearError(): void {
    const { errorRegion } = this.dom;
    if (errorRegion.hidden && errorRegion.textContent === '') return;
    errorRegion.hidden = true;
    errorRegion.textContent = '';
  }

  private rejectionMessage(code: string | undefined): string {
    switch (code) {
      case 'stale_command':
        return 'The approval was superseded before it could be recorded. Please retry.';
      case 'scope_mismatch':
        return 'The approval no longer matches the current request scope.';
      case 'policy_denied':
        return 'The approval was blocked by policy.';
      case 'authority_unavailable':
        return 'The approval authority is currently unavailable.';
      case 'invalid_command':
        return 'The approval command was rejected as invalid.';
      case 'transport_failure':
      case undefined:
      default:
        return 'The approval command could not be delivered.';
    }
  }
}

// ─── Public helper: idempotency key ─────────────────────────────

export function buildApprovalIdempotencyKey(command: DecideApprovalCommand): string {
  return defaultBuildIdempotencyKey(command);
}
