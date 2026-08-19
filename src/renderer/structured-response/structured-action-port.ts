import { z } from 'zod';
import type { DraftTransactionStore } from '../../harness/presentation/composer/draft-transaction-store';
import {
  ActionDescriptorV1Schema,
  AuthorityRefV1Schema,
  OpaqueResponseIdSchema,
  ResponseDigestSchema,
  type ActionDescriptorV1,
  type AuthorityRefV1,
} from '../../harness/contracts/response-support';
import {
  CommandEnvelopeV1Schema,
  CommandTransportReceiptV1Schema,
  InsertPromptPayloadV1Schema,
  RendererAuthorityCommandPayloadV1Schema,
  type CommandEnvelopeForV1,
  type CommandEnvelopeV1,
  type CommandTransportReceiptV1,
  type InsertPromptPayloadV1,
  type RendererAuthorityActionKindV1,
  type RendererAuthorityCommandPayloadForV1,
  type RendererAuthorityCommandPayloadV1,
} from '../../harness/contracts/structured-command';

/**
 * Closed renderer action boundary. There is deliberately no channel, command
 * name, URL, or arbitrary dispatch method in this API.
 *
 * Requirements: 9.10-9.11, 14.4, 14.8-14.11, 20.5-20.6
 */

export const RendererActionContextV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: OpaqueResponseIdSchema,
    branchId: OpaqueResponseIdSchema,
    projectionRevision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().nonnegative(),
    scopeDigest: ResponseDigestSchema.optional(),
  })
  .strict();

export type RendererActionContextV1 = z.infer<typeof RendererActionContextV1Schema>;

export interface AuthorityMethodBindingV1<K extends RendererAuthorityActionKindV1> {
  readonly owner: AuthorityRefV1;
  submit(command: CommandEnvelopeForV1<K>): Promise<unknown>;
}

export interface StructuredAuthorityMethodsV1 {
  readonly submitPrompt: AuthorityMethodBindingV1<'submit_prompt'>;
  readonly navigate: AuthorityMethodBindingV1<'navigate'>;
  readonly open: AuthorityMethodBindingV1<'open'>;
  readonly apply: AuthorityMethodBindingV1<'apply'>;
  readonly approve: AuthorityMethodBindingV1<'approve'>;
  readonly retry: AuthorityMethodBindingV1<'retry'>;
  readonly cancel: AuthorityMethodBindingV1<'cancel'>;
  readonly resume: AuthorityMethodBindingV1<'resume'>;
  readonly branch: AuthorityMethodBindingV1<'branch'>;
  readonly edit: AuthorityMethodBindingV1<'edit'>;
}

/**
 * Response-level feedback envelope (`feedback:submit`).
 *
 * The renderer emits this envelope when a user activates the up/down feedback
 * action on a response group. It sits alongside {@link CommandEnvelopeV1} so
 * the closed renderer-authority action kind union is not disturbed; the
 * main-process handler routes it through its own dedicated authority.
 *
 * Requirements: 9.5, 10.10, 13.8
 */
export const ResponseFeedbackEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: OpaqueResponseIdSchema,
    actionId: OpaqueResponseIdSchema,
    idempotencyKey: OpaqueResponseIdSchema,
    sessionId: OpaqueResponseIdSchema,
    branchId: OpaqueResponseIdSchema,
    targetResponseIdentity: OpaqueResponseIdSchema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    expectedSourceRevision: z.number().int().nonnegative(),
    scopeDigest: ResponseDigestSchema.optional(),
    rating: z.enum(['up', 'down']),
    correlationId: OpaqueResponseIdSchema,
  })
  .strict();

export type ResponseFeedbackEnvelopeV1 = z.infer<
  typeof ResponseFeedbackEnvelopeV1Schema
>;

/** Authority binding for the response-level `feedback:submit` command. */
export interface FeedbackAuthorityMethodV1 {
  readonly owner: AuthorityRefV1;
  submit(command: ResponseFeedbackEnvelopeV1): Promise<unknown>;
}

export type StructuredActionPortErrorCode =
  | 'schema_failure'
  | 'action_disabled'
  | 'wrong_action_kind'
  | 'wrong_owner'
  | 'stale_projection'
  | 'stale_source_revision'
  | 'scope_digest_mismatch'
  | 'target_mismatch'
  | 'session_mismatch'
  | 'authority_receipt_invalid'
  | 'feedback_authority_missing';

export class StructuredActionPortError extends Error {
  readonly name = 'StructuredActionPortError';

  constructor(readonly code: StructuredActionPortErrorCode) {
    super(code);
  }
}

export interface StructuredActionPortConfigV1 {
  readonly draftStore: DraftTransactionStore;
  readonly draftAuthority: AuthorityRefV1;
  readonly authorityMethods: StructuredAuthorityMethodsV1;
  readonly getContext: () => RendererActionContextV1;
  readonly createCommandId?: () => string;
  /**
   * Optional authority binding for the response-level `feedback:submit`
   * command. When absent, {@link StructuredActionPort.feedback} rejects with
   * `feedback_authority_missing` so callers surface a rejected receipt to
   * the user without silently discarding intent.
   *
   * The feedback envelope carries the target response identity, rating, and
   * a correlation ID; the main-process handler enforces stale/replay
   * protection using `expectedProjectionRevision`, `expectedSourceRevision`,
   * and `scopeDigest`.
   *
   * Requirements: 9.5, 10.10, 13.8
   */
  readonly feedbackAuthority?: FeedbackAuthorityMethodV1;
}

export interface StructuredActionPort {
  insertPrompt(action: unknown, payload: unknown): Promise<void>;
  submitPrompt(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  navigate(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  open(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  apply(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  approve(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  retry(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  cancel(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  resume(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  branch(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  edit(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1>;
  /**
   * `approval:decide` — high-level authoritative Approval Card command.
   *
   * Wraps the closed `approve` action with the fields the Approval Card
   * carries in its rendered form: the projection-supplied `collaborationId`,
   * the user's `decision`, and the `expectedRevision` and `contractDigest`
   * pair used by the main-process authority to detect stale or superseded
   * approvals. A stable idempotency key is derived from the tuple so a
   * duplicate submission produces the same envelope identity.
   *
   * Requirements: 13.5–13.9, 15.3–15.5
   */
  decideApproval(command: DecideApprovalCommandInput): Promise<CommandTransportReceiptV1>;

  /**
   * High-level response-group retry entry point.
   *
   * The response group exposes a "Retry" action after a terminal turn state
   * (`completed`, `failed`, `cancelled`, `interrupted`). This method builds
   * the retry envelope from the target response's `chatNodeStableKey`, using
   * the current renderer action context for projection/source revisions and
   * scope digest, and routes it through the same closed `retry` authority
   * binding the main process already accepts. The main-process retry service
   * (task 7.7) mints a fresh `(responseId, requestId, attempt)` and preserves
   * the turn lineage.
   *
   * Requirements: 9.5, 10.10
   */
  retryResponse(command: RetryResponseCommandInput): Promise<CommandTransportReceiptV1>;

  /**
   * `feedback:submit` — response-level up/down feedback.
   *
   * Submits a feedback envelope for a response group. The renderer emits
   * this after a user activates the `feedback_up` / `feedback_down` action.
   * A stable idempotency key derives from `(targetResponseIdentity,
   * expectedSourceRevision, rating)` so a duplicate click produces the same
   * envelope identity. When no feedback authority is configured this method
   * rejects with `feedback_authority_missing`.
   *
   * Requirements: 9.5, 10.10, 13.8
   */
  feedback(command: SubmitFeedbackCommandInput): Promise<CommandTransportReceiptV1>;
}

/**
 * High-level approval command envelope carried by the Approval Card.
 * `expectedRevision` maps to the envelope's `expectedSourceRevision`;
 * `contractDigest` maps to the envelope's `scopeDigest`. Both fields
 * participate in the main-process handler's replay protection.
 */
export interface DecideApprovalCommandInput {
  readonly collaborationId: string;
  readonly decision: 'approve' | 'reject';
  readonly expectedRevision: number;
  readonly contractDigest: string;
}

/**
 * High-level retry command input carried by the response group's "Retry"
 * action. The port derives the retry strategy and rebuilds the envelope
 * from the current renderer action context.
 */
export interface RetryResponseCommandInput {
  /** Assistant `chatNodeStableKey` of the response being retried. */
  readonly chatNodeStableKey: string;
  /**
   * Retry routing strategy. Defaults to `same_route`; callers can request
   * `alternate_authorized_route` when the previous route is no longer
   * authorized.
   */
  readonly strategy?: 'same_route' | 'alternate_authorized_route';
}

/**
 * High-level feedback command input carried by the response group's
 * up/down feedback actions.
 */
export interface SubmitFeedbackCommandInput {
  /** Assistant `chatNodeStableKey` of the response being rated. */
  readonly chatNodeStableKey: string;
  readonly rating: 'up' | 'down';
  /**
   * Optional correlation identifier used to correlate the feedback with
   * upstream diagnostics or telemetry surfaces. When omitted, a stable
   * value is derived from the target response identity, source revision,
   * and rating so a duplicate submission produces the same envelope.
   */
  readonly correlationId?: string;
}

const DESCRIPTOR_KIND_BY_AUTHORITY_ACTION = {
  submit_prompt: 'submit_prompt',
  navigate: 'navigate',
  open: 'authority_command',
  apply: 'authority_command',
  approve: 'authority_command',
  retry: 'authority_command',
  cancel: 'authority_command',
  resume: 'authority_command',
  branch: 'authority_command',
  edit: 'authority_command',
} as const satisfies Record<RendererAuthorityActionKindV1, ActionDescriptorV1['kind']>;

function sameAuthority(left: AuthorityRefV1, right: AuthorityRefV1): boolean {
  return (
    left.authorityKind === right.authorityKind &&
    left.authorityId === right.authorityId
  );
}

function defaultCommandId(): string {
  return `cmd-${globalThis.crypto.randomUUID()}`;
}

const DecideApprovalCommandInputSchema = z
  .object({
    collaborationId: OpaqueResponseIdSchema,
    decision: z.enum(['approve', 'reject']),
    expectedRevision: z.number().int().nonnegative(),
    contractDigest: ResponseDigestSchema,
  })
  .strict();

function parseDecideApprovalInput(
  input: DecideApprovalCommandInput,
): DecideApprovalCommandInput {
  const parsed = DecideApprovalCommandInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StructuredActionPortError('schema_failure');
  }
  return parsed.data;
}

const RetryResponseCommandInputSchema = z
  .object({
    chatNodeStableKey: OpaqueResponseIdSchema,
    strategy: z.enum(['same_route', 'alternate_authorized_route']).optional(),
  })
  .strict();

function parseRetryResponseInput(
  input: RetryResponseCommandInput,
): { chatNodeStableKey: string; strategy: 'same_route' | 'alternate_authorized_route' } {
  const parsed = RetryResponseCommandInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StructuredActionPortError('schema_failure');
  }
  return {
    chatNodeStableKey: parsed.data.chatNodeStableKey,
    strategy: parsed.data.strategy ?? 'same_route',
  };
}

const SubmitFeedbackCommandInputSchema = z
  .object({
    chatNodeStableKey: OpaqueResponseIdSchema,
    rating: z.enum(['up', 'down']),
    correlationId: OpaqueResponseIdSchema.optional(),
  })
  .strict();

function parseSubmitFeedbackInput(
  input: SubmitFeedbackCommandInput,
): {
  chatNodeStableKey: string;
  rating: 'up' | 'down';
  correlationId: string | undefined;
} {
  const parsed = SubmitFeedbackCommandInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StructuredActionPortError('schema_failure');
  }
  return {
    chatNodeStableKey: parsed.data.chatNodeStableKey,
    rating: parsed.data.rating,
    correlationId: parsed.data.correlationId,
  };
}

/**
 * Deterministic action identity for an authoritative approval decision.
 *
 * The port emits the same actionId (and therefore the same envelope-level
 * idempotency key) whenever the user submits the same `(collaborationId,
 * expectedRevision, decision)` tuple. Duplicate submissions across revision
 * bumps intentionally produce distinct identities so a stale click can be
 * rejected without shadowing a fresh decision.
 *
 * Requirement 15.5: duplicate submission produces the same envelope identity.
 */
export function buildApprovalActionId(input: DecideApprovalCommandInput): string {
  return `approval-decide-${input.collaborationId}-r${input.expectedRevision}-${input.decision}`;
}

/**
 * Deterministic action identity for a response-group retry.
 *
 * The port emits the same actionId whenever the user retries the same
 * `(chatNodeStableKey, sourceRevision, strategy)` tuple, so a duplicate click
 * cannot double-mint retries. When the source revision advances (e.g. a
 * fresh terminal event arrives), the identity changes so the retry attempt
 * targets the newest state.
 */
export function buildRetryResponseActionId(
  chatNodeStableKey: string,
  sourceRevision: number,
  strategy: 'same_route' | 'alternate_authorized_route',
): string {
  return `response-retry-${chatNodeStableKey}-r${sourceRevision}-${strategy}`;
}

/**
 * Deterministic action identity for response-level feedback.
 *
 * A duplicate click for the same `(chatNodeStableKey, sourceRevision, rating)`
 * tuple produces the same envelope identity so the authority can idempotently
 * accept it. Flipping the rating (up ↔ down) mints a new identity so the
 * change is observable.
 */
export function buildFeedbackActionId(
  chatNodeStableKey: string,
  sourceRevision: number,
  rating: 'up' | 'down',
): string {
  return `response-feedback-${chatNodeStableKey}-r${sourceRevision}-${rating}`;
}

export class StructuredActionPortV1 implements StructuredActionPort {
  private readonly draftStore: DraftTransactionStore;
  private readonly draftAuthority: AuthorityRefV1;
  private readonly authorityMethods: StructuredAuthorityMethodsV1;
  private readonly getContext: () => RendererActionContextV1;
  private readonly createCommandId: () => string;
  private readonly feedbackAuthority: FeedbackAuthorityMethodV1 | undefined;

  constructor(config: StructuredActionPortConfigV1) {
    const parsedDraftAuthority = AuthorityRefV1Schema.safeParse(config.draftAuthority);
    if (!parsedDraftAuthority.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    this.draftStore = config.draftStore;
    this.draftAuthority = parsedDraftAuthority.data;
    this.authorityMethods = config.authorityMethods;
    this.getContext = config.getContext;
    this.createCommandId = config.createCommandId ?? defaultCommandId;
    if (config.feedbackAuthority !== undefined) {
      const parsedFeedbackOwner = AuthorityRefV1Schema.safeParse(
        config.feedbackAuthority.owner,
      );
      if (!parsedFeedbackOwner.success) {
        throw new StructuredActionPortError('schema_failure');
      }
      this.feedbackAuthority = {
        owner: parsedFeedbackOwner.data,
        submit: config.feedbackAuthority.submit.bind(config.feedbackAuthority),
      };
    } else {
      this.feedbackAuthority = undefined;
    }
  }

  async insertPrompt(actionInput: unknown, payloadInput: unknown): Promise<void> {
    const action = this.parseAction(actionInput);
    const parsedPayload = InsertPromptPayloadV1Schema.safeParse(payloadInput);
    if (!parsedPayload.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    const context = this.validateAction(
      action,
      parsedPayload.data,
      'insert_prompt',
      this.draftAuthority,
    );
    if (this.draftStore.sessionId !== context.sessionId) {
      throw new StructuredActionPortError('session_mismatch');
    }

    const current = this.draftStore.getCurrentRevision();
    const text =
      parsedPayload.data.placement === 'replace'
        ? parsedPayload.data.text
        : `${current.text}${parsedPayload.data.text}`;
    this.draftStore.applyChange({
      text,
      selection: { start: text.length, end: text.length, direction: 'none' },
    });
  }

  submitPrompt(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'submit_prompt');
  }

  navigate(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'navigate');
  }

  open(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'open');
  }

  apply(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'apply');
  }

  approve(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'approve');
  }

  retry(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'retry');
  }

  cancel(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'cancel');
  }

  resume(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'resume');
  }

  branch(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'branch');
  }

  edit(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    return this.route(action, payload, 'edit');
  }

  /**
   * Authoritative Approval Card entry point. See `StructuredActionPort.decideApproval`.
   *
   * The main-process authority enforces:
   *   - stale-revision rejection when `expectedRevision` is behind the current
   *     recorded contract revision,
   *   - digest-based replay protection when `contractDigest` does not match,
   *   - idempotent duplicate handling keyed by the derived idempotency key,
   *   - execution blocking until the resulting `approval.upserted` terminal
   *     event is emitted.
   *
   * The renderer never treats the returned receipt as a durable outcome —
   * it is transport-only. The projection remains the source of truth.
   */
  async decideApproval(input: DecideApprovalCommandInput): Promise<CommandTransportReceiptV1> {
    const parsedInput = parseDecideApprovalInput(input);
    const parsedContext = RendererActionContextV1Schema.safeParse(this.getContext());
    if (!parsedContext.success) {
      throw new StructuredActionPortError('schema_failure');
    }
    const context = parsedContext.data;

    const owner = this.authorityMethods.approve.owner;
    const commandId = this.createCommandId();
    const actionId = buildApprovalActionId(parsedInput);
    const idempotencyKey = actionId;
    const payload: RendererAuthorityCommandPayloadForV1<'approve'> = {
      schemaVersion: 1,
      actionKind: 'approve',
      targetIdentity: parsedInput.collaborationId,
      decision: parsedInput.decision,
    };

    const commandInput: CommandEnvelopeForV1<'approve'> = {
      schemaVersion: 1,
      commandId,
      actionId,
      idempotencyKey,
      sessionId: context.sessionId,
      branchId: context.branchId,
      targetIdentity: parsedInput.collaborationId,
      expectedProjectionRevision: context.projectionRevision,
      expectedSourceRevision: parsedInput.expectedRevision,
      scopeDigest: parsedInput.contractDigest,
      payload,
    };
    const parsedCommand = CommandEnvelopeV1Schema.safeParse(commandInput);
    if (!parsedCommand.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    // Sanity: reject if the owner authority has been swapped between
    // construction and submission (should be impossible given the immutable
    // authority binding but defence-in-depth is cheap).
    if (!sameAuthority(owner, this.authorityMethods.approve.owner)) {
      throw new StructuredActionPortError('wrong_owner');
    }

    const rawReceipt = await this.authorityMethods.approve.submit(
      parsedCommand.data as CommandEnvelopeForV1<'approve'>,
    );
    const parsedReceipt = CommandTransportReceiptV1Schema.safeParse(rawReceipt);
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.commandId !== commandId ||
      parsedReceipt.data.actionId !== actionId
    ) {
      throw new StructuredActionPortError('authority_receipt_invalid');
    }
    return parsedReceipt.data;
  }

  /**
   * High-level response-group retry entry point. See
   * {@link StructuredActionPort.retryResponse}.
   *
   * The port builds the retry envelope using the current renderer action
   * context, sets `targetIdentity` to the assistant `chatNodeStableKey`, and
   * routes through the closed `retry` authority binding. The main-process
   * retry service (task 7.7) mints a fresh identity and preserves lineage.
   */
  async retryResponse(input: RetryResponseCommandInput): Promise<CommandTransportReceiptV1> {
    const parsedInput = parseRetryResponseInput(input);
    const parsedContext = RendererActionContextV1Schema.safeParse(this.getContext());
    if (!parsedContext.success) {
      throw new StructuredActionPortError('schema_failure');
    }
    const context = parsedContext.data;

    const owner = this.authorityMethods.retry.owner;
    const commandId = this.createCommandId();
    const actionId = buildRetryResponseActionId(
      parsedInput.chatNodeStableKey,
      context.sourceRevision,
      parsedInput.strategy,
    );
    const idempotencyKey = actionId;
    const payload: RendererAuthorityCommandPayloadForV1<'retry'> = {
      schemaVersion: 1,
      actionKind: 'retry',
      targetIdentity: parsedInput.chatNodeStableKey,
      strategy: parsedInput.strategy,
    };

    const commandInput: CommandEnvelopeForV1<'retry'> = {
      schemaVersion: 1,
      commandId,
      actionId,
      idempotencyKey,
      sessionId: context.sessionId,
      branchId: context.branchId,
      targetIdentity: parsedInput.chatNodeStableKey,
      expectedProjectionRevision: context.projectionRevision,
      expectedSourceRevision: context.sourceRevision,
      ...(context.scopeDigest !== undefined
        ? { scopeDigest: context.scopeDigest }
        : {}),
      payload,
    };
    const parsedCommand = CommandEnvelopeV1Schema.safeParse(commandInput);
    if (!parsedCommand.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    if (!sameAuthority(owner, this.authorityMethods.retry.owner)) {
      throw new StructuredActionPortError('wrong_owner');
    }

    const rawReceipt = await this.authorityMethods.retry.submit(
      parsedCommand.data as CommandEnvelopeForV1<'retry'>,
    );
    const parsedReceipt = CommandTransportReceiptV1Schema.safeParse(rawReceipt);
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.commandId !== commandId ||
      parsedReceipt.data.actionId !== actionId
    ) {
      throw new StructuredActionPortError('authority_receipt_invalid');
    }
    return parsedReceipt.data;
  }

  /**
   * `feedback:submit` — response-level feedback entry point. See
   * {@link StructuredActionPort.feedback}.
   *
   * The port validates the input, builds a dedicated feedback envelope, and
   * routes through the optional `feedbackAuthority` binding. When no
   * feedback authority is configured the promise rejects with
   * `feedback_authority_missing` so the calling surface can surface a
   * failure receipt to the user without silently discarding intent.
   */
  async feedback(input: SubmitFeedbackCommandInput): Promise<CommandTransportReceiptV1> {
    const parsedInput = parseSubmitFeedbackInput(input);
    const parsedContext = RendererActionContextV1Schema.safeParse(this.getContext());
    if (!parsedContext.success) {
      throw new StructuredActionPortError('schema_failure');
    }
    const context = parsedContext.data;

    if (this.feedbackAuthority === undefined) {
      throw new StructuredActionPortError('feedback_authority_missing');
    }

    const commandId = this.createCommandId();
    const actionId = buildFeedbackActionId(
      parsedInput.chatNodeStableKey,
      context.sourceRevision,
      parsedInput.rating,
    );
    const idempotencyKey = actionId;
    const correlationId = parsedInput.correlationId ?? actionId;
    const envelopeInput: ResponseFeedbackEnvelopeV1 = {
      schemaVersion: 1,
      commandId,
      actionId,
      idempotencyKey,
      sessionId: context.sessionId,
      branchId: context.branchId,
      targetResponseIdentity: parsedInput.chatNodeStableKey,
      expectedProjectionRevision: context.projectionRevision,
      expectedSourceRevision: context.sourceRevision,
      ...(context.scopeDigest !== undefined
        ? { scopeDigest: context.scopeDigest }
        : {}),
      rating: parsedInput.rating,
      correlationId,
    };
    const parsedEnvelope = ResponseFeedbackEnvelopeV1Schema.safeParse(envelopeInput);
    if (!parsedEnvelope.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    const rawReceipt = await this.feedbackAuthority.submit(parsedEnvelope.data);
    const parsedReceipt = CommandTransportReceiptV1Schema.safeParse(rawReceipt);
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.commandId !== commandId ||
      parsedReceipt.data.actionId !== actionId
    ) {
      throw new StructuredActionPortError('authority_receipt_invalid');
    }
    return parsedReceipt.data;
  }

  private async route<K extends RendererAuthorityActionKindV1>(
    actionInput: unknown,
    payloadInput: unknown,
    actionKind: K,
  ): Promise<CommandTransportReceiptV1> {
    const action = this.parseAction(actionInput);
    const parsedPayload = RendererAuthorityCommandPayloadV1Schema.safeParse(payloadInput);
    if (!parsedPayload.success || parsedPayload.data.actionKind !== actionKind) {
      throw new StructuredActionPortError(
        parsedPayload.success ? 'wrong_action_kind' : 'schema_failure',
      );
    }

    const payload = parsedPayload.data as RendererAuthorityCommandPayloadForV1<K>;
    const binding = this.getBinding(actionKind);
    const context = this.validateAction(
      action,
      payload,
      DESCRIPTOR_KIND_BY_AUTHORITY_ACTION[actionKind],
      binding.owner,
    );

    const commandId = this.createCommandId();
    const commandInput: CommandEnvelopeForV1<K> = {
      schemaVersion: 1,
      commandId,
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      sessionId: context.sessionId,
      branchId: context.branchId,
      targetIdentity: payload.targetIdentity,
      expectedProjectionRevision: action.expectedProjectionRevision,
      expectedSourceRevision: action.expectedSourceRevision!,
      scopeDigest: action.scopeDigest,
      payload,
    };
    const parsedCommand = CommandEnvelopeV1Schema.safeParse(commandInput);
    if (!parsedCommand.success) {
      throw new StructuredActionPortError('schema_failure');
    }

    const rawReceipt = await this.invokeExactMethod(
      parsedCommand.data as CommandEnvelopeForV1<K>,
    );
    const parsedReceipt = CommandTransportReceiptV1Schema.safeParse(rawReceipt);
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.commandId !== commandId ||
      parsedReceipt.data.actionId !== action.actionId
    ) {
      throw new StructuredActionPortError('authority_receipt_invalid');
    }
    return parsedReceipt.data;
  }

  private parseAction(input: unknown): ActionDescriptorV1 {
    const parsed = ActionDescriptorV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new StructuredActionPortError('schema_failure');
    }
    if (parsed.data.disabledReason !== undefined) {
      throw new StructuredActionPortError('action_disabled');
    }
    return parsed.data;
  }

  private validateAction(
    action: ActionDescriptorV1,
    payload: InsertPromptPayloadV1 | RendererAuthorityCommandPayloadV1,
    expectedDescriptorKind: ActionDescriptorV1['kind'],
    expectedOwner: AuthorityRefV1,
  ): RendererActionContextV1 {
    if (action.kind !== expectedDescriptorKind) {
      throw new StructuredActionPortError('wrong_action_kind');
    }
    if (!sameAuthority(action.owner, expectedOwner)) {
      throw new StructuredActionPortError('wrong_owner');
    }

    const parsedContext = RendererActionContextV1Schema.safeParse(this.getContext());
    if (!parsedContext.success) {
      throw new StructuredActionPortError('schema_failure');
    }
    const context = parsedContext.data;
    if (action.expectedProjectionRevision !== context.projectionRevision) {
      throw new StructuredActionPortError('stale_projection');
    }
    if (
      action.expectedSourceRevision === undefined ||
      action.expectedSourceRevision !== context.sourceRevision
    ) {
      throw new StructuredActionPortError('stale_source_revision');
    }
    if (action.scopeDigest !== context.scopeDigest) {
      throw new StructuredActionPortError('scope_digest_mismatch');
    }

    const expectedTarget = action.target?.locatorId ?? action.actionId;
    if (payload.targetIdentity !== expectedTarget) {
      throw new StructuredActionPortError('target_mismatch');
    }
    return context;
  }

  private getBinding<K extends RendererAuthorityActionKindV1>(
    actionKind: K,
  ): AuthorityMethodBindingV1<K> {
    switch (actionKind) {
      case 'submit_prompt':
        return this.authorityMethods.submitPrompt as unknown as AuthorityMethodBindingV1<K>;
      case 'navigate':
        return this.authorityMethods.navigate as unknown as AuthorityMethodBindingV1<K>;
      case 'open':
        return this.authorityMethods.open as unknown as AuthorityMethodBindingV1<K>;
      case 'apply':
        return this.authorityMethods.apply as unknown as AuthorityMethodBindingV1<K>;
      case 'approve':
        return this.authorityMethods.approve as unknown as AuthorityMethodBindingV1<K>;
      case 'retry':
        return this.authorityMethods.retry as unknown as AuthorityMethodBindingV1<K>;
      case 'cancel':
        return this.authorityMethods.cancel as unknown as AuthorityMethodBindingV1<K>;
      case 'resume':
        return this.authorityMethods.resume as unknown as AuthorityMethodBindingV1<K>;
      case 'branch':
        return this.authorityMethods.branch as unknown as AuthorityMethodBindingV1<K>;
      case 'edit':
        return this.authorityMethods.edit as unknown as AuthorityMethodBindingV1<K>;
    }
  }

  private invokeExactMethod<K extends RendererAuthorityActionKindV1>(
    command: CommandEnvelopeForV1<K>,
  ): Promise<unknown> {
    const broadCommand = command as CommandEnvelopeV1;
    switch (broadCommand.payload.actionKind) {
      case 'submit_prompt':
        return this.authorityMethods.submitPrompt.submit(
          broadCommand as CommandEnvelopeForV1<'submit_prompt'>,
        );
      case 'navigate':
        return this.authorityMethods.navigate.submit(
          broadCommand as CommandEnvelopeForV1<'navigate'>,
        );
      case 'open':
        return this.authorityMethods.open.submit(
          broadCommand as CommandEnvelopeForV1<'open'>,
        );
      case 'apply':
        return this.authorityMethods.apply.submit(
          broadCommand as CommandEnvelopeForV1<'apply'>,
        );
      case 'approve':
        return this.authorityMethods.approve.submit(
          broadCommand as CommandEnvelopeForV1<'approve'>,
        );
      case 'retry':
        return this.authorityMethods.retry.submit(
          broadCommand as CommandEnvelopeForV1<'retry'>,
        );
      case 'cancel':
        return this.authorityMethods.cancel.submit(
          broadCommand as CommandEnvelopeForV1<'cancel'>,
        );
      case 'resume':
        return this.authorityMethods.resume.submit(
          broadCommand as CommandEnvelopeForV1<'resume'>,
        );
      case 'branch':
        return this.authorityMethods.branch.submit(
          broadCommand as CommandEnvelopeForV1<'branch'>,
        );
      case 'edit':
        return this.authorityMethods.edit.submit(
          broadCommand as CommandEnvelopeForV1<'edit'>,
        );
    }
  }
}
