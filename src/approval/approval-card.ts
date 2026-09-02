/**
 * Shared accessible approval card + notification accessibility contract
 * (FUT-PKG-04-SECURITY/T-006, FIX-RENDERER-A11Y-01).
 *
 * NN-APPROVAL-004 requires that agent-initiated questions and policy-triggered
 * approvals use ONE accessible inline card with: kind badge, actor, prompt,
 * risk/scope, options, free text, context links, countdown, cancel, answered
 * state, timestamp, and focus-safe keyboard operation. NN-APPROVAL-009 requires
 * notifications that fire once per request, reveal no secret context, and
 * focus/jump to the correct card.
 *
 * This module is a headless, DOM-free ACCESSIBILITY CONTRACT: it computes the
 * accessible model (roles, ARIA labels, focus order, live-region politeness,
 * disabled state, risk styling) for a request so the renderer builds a correct
 * card and so the contract is unit-/property-testable WITHOUT a browser. The
 * renderer maps this model onto real elements; the tests assert the model
 * satisfies the accessibility rules for every request/state combination.
 *
 * Design anchors: D-16 (approvals), D-25 (renderer). Requirements:
 * NN-APPROVAL-004/007/009. Canonical claim: CD-010.
 */

import type {
  ApprovalOption,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalState,
} from './approval-types.js';

// ─── Accessible model types ─────────────────────────────────────────────────

/** An accessible action control on the card (NN-APPROVAL-004/007). */
export interface CardControlModel {
  readonly optionId: string;
  readonly label: string;
  /** ARIA role for the control. */
  readonly role: 'button';
  /** Accessible name announced by screen readers. */
  readonly ariaLabel: string;
  /** Whether the control is disabled (answered/obsolete state, NN-APPROVAL-007). */
  readonly disabled: boolean;
  /** Whether destructive risk styling applies (NN-APPROVAL-007). */
  readonly destructive: boolean;
  /** 0-based position in the keyboard focus order. */
  readonly focusOrder: number;
}

/** A context link on the card. Never inline secret context (NN-APPROVAL-009). */
export interface CardContextLinkModel {
  readonly refId: string;
  readonly role: 'link';
  readonly ariaLabel: string;
  readonly focusOrder: number;
}

/** The full accessible model for one shared approval card (NN-APPROVAL-004). */
export interface ApprovalCardModel {
  /** The container is a labelled group so AT announces it as one unit. */
  readonly role: 'group';
  /** The card's accessible name (kind + safe action label; no secrets). */
  readonly ariaLabel: string;
  /** The element id the card is keyed by (stable across reload). */
  readonly cardId: string;
  /** Kind badge text (e.g. "Agent question", "Approval required"). */
  readonly kindBadge: string;
  /** Safe actor label. */
  readonly actorLabel: string;
  /** Safe prompt text (never a raw secret). */
  readonly prompt: string;
  readonly risk: ApprovalRisk;
  /** ARIA description that includes risk + scope for AT. */
  readonly riskScopeDescription: string;
  readonly controls: readonly CardControlModel[];
  /** Whether the free-text input is present and enabled. */
  readonly freeTextEnabled: boolean;
  readonly freeTextAriaLabel: string;
  readonly contextLinks: readonly CardContextLinkModel[];
  /** Whether a countdown is shown (only while non-terminal and not expired). */
  readonly countdownVisible: boolean;
  /** The live-region politeness for the countdown ("polite" — never assertive). */
  readonly countdownPoliteness: 'polite' | 'off';
  /** The answered-state announcement, present once terminal. */
  readonly answeredState?: string;
  /** ISO timestamp label shown on the card. */
  readonly timestampLabel: string;
  /** Whether the whole card is in a read-only answered state. */
  readonly answered: boolean;
}

/** The accessible model for a background approval notification (NN-APPROVAL-009). */
export interface ApprovalNotificationModel {
  /** The request this notification is for; used to focus/jump to the card. */
  readonly requestId: string;
  /** The card element id to focus when the notification is activated. */
  readonly focusTargetCardId: string;
  /** Safe title (no secret context). */
  readonly title: string;
  /** Safe body (no secret context). */
  readonly body: string;
  /** Live-region politeness — "polite" so it never steals focus abruptly. */
  readonly politeness: 'polite';
  /** A dedupe key so it fires ONCE per request (NN-APPROVAL-009). */
  readonly dedupeKey: string;
}

// ─── Card model builder ──────────────────────────────────────────────────────

const KIND_BADGE: Readonly<Record<ApprovalRequest['kind'], string>> = Object.freeze({
  'agent-question': 'Agent question',
  'policy-approval': 'Approval required',
});

/**
 * Build the accessible {@link ApprovalCardModel} for a request. The card is
 * ONE shared inline card for both kinds (NN-APPROVAL-004). Controls are disabled
 * once the request is terminal or suspended (an obsolete control can never be
 * clicked into a stale decision, NN-APPROVAL-007). The countdown live region is
 * `polite` so it never interrupts a screen-reader user. No field ever carries a
 * raw secret; the card renders the safe `actionLabel` and opaque context refs
 * only (NN-APPROVAL-009).
 *
 * `focusSafe` verifies the resulting focus order is a gap-free 0..n-1 sequence
 * so keyboard operation is deterministic (NN-APPROVAL-004 "focus-safe keyboard
 * operation").
 */
export function buildApprovalCardModel(
  request: ApprovalRequest,
  options: { readonly prompt: string; readonly actorLabel?: string; readonly now?: () => Date } = { prompt: '' },
): ApprovalCardModel {
  const answered = isAnswered(request.state);
  const interactive = request.state === 'pending';
  const now = (options.now ?? (() => new Date()))();
  const expired = new Date(request.expiresAt).getTime() <= now.getTime();

  let focus = 0;
  const controls: CardControlModel[] = request.options.map((opt: ApprovalOption) => ({
    optionId: opt.optionId,
    label: opt.label,
    role: 'button' as const,
    ariaLabel: buildControlAriaLabel(opt, request.risk),
    // A control is disabled unless the card is actively interactive.
    disabled: !interactive || expired,
    destructive: opt.destructive,
    focusOrder: focus++,
  }));

  const contextLinks: CardContextLinkModel[] = request.contextRefs.map((refId) => ({
    refId,
    role: 'link' as const,
    ariaLabel: `Context ${refId}`,
    focusOrder: focus++,
  }));

  const model: ApprovalCardModel = {
    role: 'group',
    ariaLabel: `${KIND_BADGE[request.kind]}: ${request.actionLabel}`,
    cardId: `approval-card-${request.requestId}`,
    kindBadge: KIND_BADGE[request.kind],
    actorLabel: options.actorLabel ?? request.actor,
    prompt: options.prompt,
    risk: request.risk,
    riskScopeDescription: `Risk ${request.risk}. Scope ${request.scopeKey.slice(0, 12)}…`,
    controls,
    freeTextEnabled: request.kind === 'agent-question' && interactive && !expired,
    freeTextAriaLabel: 'Free text answer',
    contextLinks,
    countdownVisible: interactive && !expired,
    countdownPoliteness: interactive && !expired ? 'polite' : 'off',
    ...(answered ? { answeredState: answeredAnnouncement(request.state) } : {}),
    timestampLabel: request.createdAt,
    answered,
  };
  return model;
}

function buildControlAriaLabel(opt: ApprovalOption, risk: ApprovalRisk): string {
  const risky = opt.destructive ? ` (destructive, ${risk} risk)` : '';
  return `${opt.label}${risky}`;
}

function isAnswered(state: ApprovalState): boolean {
  return state === 'approved' || state === 'rejected' || state === 'cancelled';
}

function answeredAnnouncement(state: ApprovalState): string {
  switch (state) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

/**
 * Verify a card model is focus-safe: every focusable element (controls +
 * context links) has a unique focus order forming a gap-free 0..n-1 sequence.
 * Returns the list of problems (empty = focus-safe). Used by the a11y contract
 * test to assert deterministic keyboard operation (NN-APPROVAL-004).
 */
export function verifyFocusOrder(model: ApprovalCardModel): string[] {
  const orders = [
    ...model.controls.map((c) => c.focusOrder),
    ...model.contextLinks.map((l) => l.focusOrder),
  ].sort((a, b) => a - b);
  const problems: string[] = [];
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      problems.push(`focus order gap or duplicate at index ${i} (got ${orders[i]})`);
      break;
    }
  }
  return problems;
}

/**
 * Verify a card model exposes the required accessible affordances for its state
 * (NN-APPROVAL-004/007). Returns a list of accessibility violations; an empty
 * list means the model satisfies the contract. This is the machine-checkable
 * form of FIX-RENDERER-A11Y-01.
 */
export function verifyCardAccessibility(model: ApprovalCardModel): string[] {
  const problems: string[] = [];

  if (model.role !== 'group') problems.push('card must be a labelled group');
  if (model.ariaLabel.trim().length === 0) problems.push('card must have a non-empty accessible name');
  if (model.kindBadge.trim().length === 0) problems.push('kind badge must be present');
  if (model.controls.length === 0) problems.push('card must expose at least one control');

  for (const c of model.controls) {
    if (c.ariaLabel.trim().length === 0) problems.push(`control ${c.optionId} missing accessible name`);
    if (c.role !== 'button') problems.push(`control ${c.optionId} must be a button`);
  }

  // Answered/terminal or suspended cards must NOT expose enabled controls
  // (NN-APPROVAL-007: new messages disable obsolete controls).
  if (model.answered && model.controls.some((c) => !c.disabled)) {
    problems.push('answered card must disable all controls');
  }

  // The countdown live region must never be assertive (would steal focus).
  if (model.countdownPoliteness !== 'polite' && model.countdownPoliteness !== 'off') {
    problems.push('countdown must be a polite live region or off');
  }

  // Focus order must be gap-free.
  problems.push(...verifyFocusOrder(model));

  return problems;
}

// ─── Notification model builder (NN-APPROVAL-009) ───────────────────────────

/**
 * Build a background notification model for a pending request. It reveals no
 * secret context (only the safe kind badge and action label), targets the
 * correct card for focus/jump, and carries a per-request dedupe key so it fires
 * exactly ONCE per request (NN-APPROVAL-009). A caller MUST honor
 * {@link ApprovalNotificationModel.dedupeKey}; {@link NotificationDeduper} makes
 * that easy.
 */
export function buildNotificationModel(request: ApprovalRequest): ApprovalNotificationModel {
  return {
    requestId: request.requestId,
    focusTargetCardId: `approval-card-${request.requestId}`,
    title: KIND_BADGE[request.kind],
    body: request.actionLabel,
    politeness: 'polite',
    dedupeKey: `approval-notify:${request.requestId}`,
  };
}

/**
 * A tiny once-per-request dedupe gate for notifications (NN-APPROVAL-009). The
 * first {@link shouldFire} for a dedupe key returns true; every subsequent call
 * for the same key returns false, so a re-surfaced request after reload does not
 * re-notify.
 */
export class NotificationDeduper {
  private readonly fired = new Set<string>();

  shouldFire(model: ApprovalNotificationModel): boolean {
    if (this.fired.has(model.dedupeKey)) return false;
    this.fired.add(model.dedupeKey);
    return true;
  }

  /** Reset a single dedupe key (e.g. after the card is dismissed). */
  clear(dedupeKey: string): void {
    this.fired.delete(dedupeKey);
  }
}
