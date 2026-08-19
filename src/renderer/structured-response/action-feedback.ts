import { z } from 'zod';
import {
  ActionDescriptorV1Schema,
  ActionRiskV1Schema,
  AuthorityRefV1Schema,
  AuthorizedPresentationTextSchema,
  OpaqueResponseIdSchema,
  ResponseDigestSchema,
  type ActionDescriptorV1,
  type ActionRiskV1,
  type AuthorityRefV1,
} from '../../harness/contracts/response-support';

/**
 * Authority-derived presentation policy for one consequential action.
 *
 * `scopeSummary` is the only scope value permitted in the DOM. The digest is
 * retained solely for exact binding checks and is never rendered.
 *
 * Validates: Requirements 7.7, 9.3, 13.2, 20.6, 20.7, 20.8
 */
export const AuthorityActionPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    policyRevision: z.number().int().nonnegative(),
    actionId: OpaqueResponseIdSchema,
    owner: AuthorityRefV1Schema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    expectedSourceRevision: z.number().int().nonnegative().optional(),
    risk: ActionRiskV1Schema,
    scopeSummary: AuthorizedPresentationTextSchema.max(512),
    scopeDigest: ResponseDigestSchema,
    approval: z.enum(['not_required', 'exact']),
  })
  .strict();

export type AuthorityActionPolicyV1 = z.infer<typeof AuthorityActionPolicyV1Schema>;

/** A positive approval bound to every material authority-derived field. */
export const ExactActionApprovalV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    approved: z.literal(true),
    policyRevision: z.number().int().nonnegative(),
    actionId: OpaqueResponseIdSchema,
    owner: AuthorityRefV1Schema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    expectedSourceRevision: z.number().int().nonnegative().optional(),
    risk: ActionRiskV1Schema,
    scopeDigest: ResponseDigestSchema,
  })
  .strict();

export type ExactActionApprovalV1 = z.infer<typeof ExactActionApprovalV1Schema>;

export const ActionFailureClassV1Schema = z.enum([
  'transport',
  'authority',
  'stale',
  'duplicate',
  'approval_required',
]);

export type ActionFailureClassV1 = z.infer<typeof ActionFailureClassV1Schema>;

export interface ActionFailureInputV1 {
  readonly failureClass: Exclude<ActionFailureClassV1, 'approval_required'>;
  readonly correlationId?: string;
  /** Must already be authorized for presentation; invalid text is discarded. */
  readonly authorizedSummary?: unknown;
  readonly retryable?: boolean;
}

export interface ActionFailureFeedbackV1 {
  readonly schemaVersion: 1;
  readonly failureClass: ActionFailureClassV1;
  readonly summary: string;
  readonly correlationId: string;
  readonly affectedAuthority: AuthorityRefV1;
  readonly retryable: boolean;
}

export type AuthorityActionResult<T> =
  | { readonly ok: true; readonly receipt: T }
  | { readonly ok: false; readonly failure: ActionFailureInputV1 };

export type ActionExecutionResult<T> =
  | { readonly ok: true; readonly receipt: T }
  | { readonly ok: false; readonly failure: ActionFailureFeedbackV1 };

/**
 * Adapter for renderer-local state. The controller never reads fields from the
 * snapshot and never passes it to an authority. On failure it restores the
 * exact opaque snapshot so focus, disclosure, selection, draft, and partial
 * content remain caller-owned.
 */
export interface ActionStatePreserver<S> {
  capture(): S;
  restore(snapshot: S): void;
}

export interface ActionExecutionRequest<T> {
  readonly approval?: ExactActionApprovalV1;
  readonly invoke: () => Promise<AuthorityActionResult<T>>;
}

export interface ActionRiskScopeView {
  readonly label: string;
  readonly risk: ActionRiskV1;
  readonly riskLabel: string;
  readonly scopeSummary: string;
  readonly approvalRequired: boolean;
  readonly owner: AuthorityRefV1;
}

const FAILURE_SUMMARIES: Readonly<Record<ActionFailureClassV1, string>> = {
  transport: 'The action could not reach its owning authority.',
  authority: 'The owning authority did not accept the action.',
  stale: 'The action is no longer valid for the current response.',
  duplicate: 'This action has already been submitted.',
  approval_required: 'Exact approval is required before this action can run.',
};

const RISK_LABELS: Readonly<Record<ActionRiskV1, string>> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  unknown: 'Unknown',
};

function sameAuthority(left: AuthorityRefV1, right: AuthorityRefV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.authorityKind === right.authorityKind &&
    left.authorityId === right.authorityId
  );
}

function actionMatchesPolicy(
  action: ActionDescriptorV1,
  policy: AuthorityActionPolicyV1,
): boolean {
  return (
    action.actionId === policy.actionId &&
    sameAuthority(action.owner, policy.owner) &&
    action.expectedProjectionRevision === policy.expectedProjectionRevision &&
    action.expectedSourceRevision === policy.expectedSourceRevision &&
    action.risk === policy.risk &&
    action.scopeDigest === policy.scopeDigest
  );
}

function approvalMatchesPolicy(
  approval: ExactActionApprovalV1 | undefined,
  policy: AuthorityActionPolicyV1,
): boolean {
  if (approval === undefined) return false;
  const parsed = ExactActionApprovalV1Schema.safeParse(approval);
  if (!parsed.success) return false;

  return (
    parsed.data.policyRevision === policy.policyRevision &&
    parsed.data.actionId === policy.actionId &&
    sameAuthority(parsed.data.owner, policy.owner) &&
    parsed.data.expectedProjectionRevision === policy.expectedProjectionRevision &&
    parsed.data.expectedSourceRevision === policy.expectedSourceRevision &&
    parsed.data.risk === policy.risk &&
    parsed.data.scopeDigest === policy.scopeDigest
  );
}

function safeCorrelationId(value: string | undefined, actionId: string): string {
  const parsed = OpaqueResponseIdSchema.safeParse(value);
  return parsed.success ? parsed.data : `action-${actionId}`;
}

function safeAuthorizedSummary(value: unknown): string | undefined {
  const parsed = AuthorizedPresentationTextSchema.max(512).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function failureFeedback(
  action: ActionDescriptorV1,
  failureClass: ActionFailureClassV1,
  input?: ActionFailureInputV1,
): ActionFailureFeedbackV1 {
  return Object.freeze({
    schemaVersion: 1,
    failureClass,
    summary: safeAuthorizedSummary(input?.authorizedSummary) ?? FAILURE_SUMMARIES[failureClass],
    correlationId: safeCorrelationId(input?.correlationId, action.actionId),
    affectedAuthority: action.owner,
    retryable: input?.retryable === true && failureClass === 'transport',
  });
}

function appendDefinition(
  documentRef: Document,
  list: HTMLDListElement,
  term: string,
  description: string,
): void {
  const dt = documentRef.createElement('dt');
  dt.textContent = term;
  const dd = documentRef.createElement('dd');
  dd.textContent = description;
  list.append(dt, dd);
}

export function createActionRiskScopeView(
  action: ActionDescriptorV1,
  policy: AuthorityActionPolicyV1,
): ActionRiskScopeView | null {
  const parsedAction = ActionDescriptorV1Schema.safeParse(action);
  const parsedPolicy = AuthorityActionPolicyV1Schema.safeParse(policy);
  if (
    !parsedAction.success ||
    !parsedPolicy.success ||
    !actionMatchesPolicy(parsedAction.data, parsedPolicy.data)
  ) {
    return null;
  }

  return Object.freeze({
    label: parsedAction.data.label,
    risk: parsedPolicy.data.risk,
    riskLabel: RISK_LABELS[parsedPolicy.data.risk],
    scopeSummary: parsedPolicy.data.scopeSummary,
    approvalRequired: parsedPolicy.data.approval === 'exact',
    owner: parsedPolicy.data.owner,
  });
}

/** Renders only authorized presentation text; scope digests are never emitted. */
export function renderActionRiskScope(
  documentRef: Document,
  action: ActionDescriptorV1,
  policy: AuthorityActionPolicyV1,
): HTMLElement {
  const view = createActionRiskScopeView(action, policy);
  const root = documentRef.createElement('section');
  root.setAttribute('role', 'group');

  if (view === null) {
    root.setAttribute('aria-label', 'Action unavailable');
    root.dataset.actionState = 'stale';
    root.textContent = FAILURE_SUMMARIES.stale;
    return root;
  }

  root.setAttribute('aria-label', `${view.label} action details`);
  root.dataset.actionState = 'ready';
  const details = documentRef.createElement('dl');
  appendDefinition(documentRef, details, 'Risk', view.riskLabel);
  appendDefinition(documentRef, details, 'Scope', view.scopeSummary);
  root.append(details);

  if (view.approvalRequired) {
    const notice = documentRef.createElement('p');
    notice.textContent = FAILURE_SUMMARIES.approval_required;
    root.append(notice);
  }

  return root;
}

export function renderActionFailureFeedback(
  documentRef: Document,
  failure: ActionFailureFeedbackV1,
): HTMLElement {
  const root = documentRef.createElement('section');
  root.setAttribute('role', 'alert');
  root.dataset.failureClass = failure.failureClass;

  const heading = documentRef.createElement('strong');
  heading.textContent = 'Action failed';
  const summary = documentRef.createElement('p');
  summary.textContent = failure.summary;
  const details = documentRef.createElement('dl');
  appendDefinition(documentRef, details, 'Failure type', failure.failureClass.replace('_', ' '));
  appendDefinition(documentRef, details, 'Correlation', failure.correlationId);
  appendDefinition(
    documentRef,
    details,
    'Authority',
    `${failure.affectedAuthority.authorityKind}:${failure.affectedAuthority.authorityId}`,
  );
  root.append(heading, summary, details);
  return root;
}

/**
 * Failure-only action middleware. It has no canonical-state mutation API and
 * does not infer domain success from a transport receipt.
 */
export class ActionFeedbackController<S> {
  constructor(
    private readonly action: ActionDescriptorV1,
    private readonly policy: AuthorityActionPolicyV1,
    private readonly statePreserver: ActionStatePreserver<S>,
  ) {}

  getView(): ActionRiskScopeView | null {
    return createActionRiskScopeView(this.action, this.policy);
  }

  async execute<T>(request: ActionExecutionRequest<T>): Promise<ActionExecutionResult<T>> {
    const snapshot = this.statePreserver.capture();

    if (this.getView() === null) {
      return this.fail(snapshot, failureFeedback(this.action, 'stale'));
    }

    if (
      this.policy.approval === 'exact' &&
      !approvalMatchesPolicy(request.approval, this.policy)
    ) {
      return this.fail(snapshot, failureFeedback(this.action, 'approval_required'));
    }

    try {
      const result = await request.invoke();
      if (result.ok) return result;

      const parsedClass = ActionFailureClassV1Schema.exclude(['approval_required']).safeParse(
        result.failure.failureClass,
      );
      const failureClass = parsedClass.success ? parsedClass.data : 'authority';
      return this.fail(
        snapshot,
        failureFeedback(this.action, failureClass, result.failure),
      );
    } catch {
      return this.fail(snapshot, failureFeedback(this.action, 'transport'));
    }
  }

  private fail<T>(snapshot: S, failure: ActionFailureFeedbackV1): ActionExecutionResult<T> {
    try {
      this.statePreserver.restore(snapshot);
    } catch {
      // State restoration is best-effort at this boundary. Never replace the
      // typed authority failure with local state or exception details.
    }
    return { ok: false, failure };
  }
}