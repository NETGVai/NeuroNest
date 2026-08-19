import { z } from 'zod';
import {
  OpaqueResponseIdSchema,
  ResponseDigestSchema,
} from './response-support';

/**
 * Renderer-safe command contracts for structured response actions.
 *
 * Payloads are a closed union of opaque identities and enums. They cannot
 * select an IPC channel, carry a shell command, or provide an arbitrary URL.
 * A delivered receipt acknowledges transport only; durable outcomes remain
 * projection-owned.
 *
 * Requirements: 9.10-9.11, 14.4, 14.8-14.11, 20.5-20.6
 */

export const RendererAuthorityActionKindV1Schema = z.enum([
  'submit_prompt',
  'navigate',
  'open',
  'apply',
  'approve',
  'retry',
  'cancel',
  'resume',
  'branch',
  'edit',
]);

export type RendererAuthorityActionKindV1 = z.infer<
  typeof RendererAuthorityActionKindV1Schema
>;

const AuthorityPayloadBaseV1Schema = z.object({
  schemaVersion: z.literal(1),
  targetIdentity: OpaqueResponseIdSchema,
});

export const SubmitPromptCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('submit_prompt'),
  submissionMode: z.enum(['send', 'queue', 'steer', 'spec']),
}).strict();

export const NavigateCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('navigate'),
  destination: z.enum(['source', 'message', 'trajectory', 'inspector', 'settings']),
}).strict();

export const OpenCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('open'),
  resource: z.enum(['file', 'range', 'source', 'attachment', 'artifact']),
}).strict();

export const ApplyCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('apply'),
  changeType: z.enum(['file_diff', 'structured_data_diff', 'plan']),
}).strict();

export const ApproveCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('approve'),
  decision: z.enum(['approve', 'reject']),
}).strict();

export const RetryCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('retry'),
  strategy: z.enum(['same_route', 'alternate_authorized_route']),
}).strict();

export const CancelCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('cancel'),
  operation: z.enum(['turn', 'task', 'tool_call', 'workflow']),
}).strict();

export const ResumeCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('resume'),
  operation: z.enum(['turn', 'task', 'tool_call', 'workflow']),
}).strict();

export const BranchCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('branch'),
  placement: z.enum(['from_message', 'from_turn']),
}).strict();

export const EditCommandPayloadV1Schema = AuthorityPayloadBaseV1Schema.extend({
  actionKind: z.literal('edit'),
  mode: z.enum(['edit_and_resend', 'edit_draft']),
}).strict();

export const RendererAuthorityCommandPayloadV1Schema = z.discriminatedUnion(
  'actionKind',
  [
    SubmitPromptCommandPayloadV1Schema,
    NavigateCommandPayloadV1Schema,
    OpenCommandPayloadV1Schema,
    ApplyCommandPayloadV1Schema,
    ApproveCommandPayloadV1Schema,
    RetryCommandPayloadV1Schema,
    CancelCommandPayloadV1Schema,
    ResumeCommandPayloadV1Schema,
    BranchCommandPayloadV1Schema,
    EditCommandPayloadV1Schema,
  ],
);

export type RendererAuthorityCommandPayloadV1 = z.infer<
  typeof RendererAuthorityCommandPayloadV1Schema
>;

export type RendererAuthorityCommandPayloadForV1<
  K extends RendererAuthorityActionKindV1,
> = Extract<RendererAuthorityCommandPayloadV1, { actionKind: K }>;

export const InsertPromptPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    actionKind: z.literal('insert_prompt'),
    targetIdentity: OpaqueResponseIdSchema,
    text: z
      .string()
      .min(1)
      .max(32_768)
      .refine(
        (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
        'control characters are not permitted',
      ),
    placement: z.enum(['replace', 'append']),
  })
  .strict();

export type InsertPromptPayloadV1 = z.infer<typeof InsertPromptPayloadV1Schema>;

export const CommandEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: OpaqueResponseIdSchema,
    actionId: OpaqueResponseIdSchema,
    idempotencyKey: OpaqueResponseIdSchema.optional(),
    sessionId: OpaqueResponseIdSchema,
    branchId: OpaqueResponseIdSchema,
    targetIdentity: OpaqueResponseIdSchema,
    expectedProjectionRevision: z.number().int().nonnegative(),
    expectedSourceRevision: z.number().int().nonnegative(),
    scopeDigest: ResponseDigestSchema.optional(),
    payload: RendererAuthorityCommandPayloadV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetIdentity !== value.payload.targetIdentity) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'targetIdentity'],
        message: 'payload target must match command target',
      });
    }
  });

export type CommandEnvelopeV1 = z.infer<typeof CommandEnvelopeV1Schema>;

export type CommandEnvelopeForV1<K extends RendererAuthorityActionKindV1> =
  Omit<CommandEnvelopeV1, 'payload'> & {
    payload: RendererAuthorityCommandPayloadForV1<K>;
  };

export const CommandTransportReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: OpaqueResponseIdSchema,
    actionId: OpaqueResponseIdSchema,
    receiptId: OpaqueResponseIdSchema,
    transportStatus: z.enum(['delivered', 'rejected']),
    rejectionCode: z.enum([
      'authority_unavailable',
      'invalid_command',
      'stale_command',
      'scope_mismatch',
      'policy_denied',
      'transport_failure',
    ]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transportStatus === 'rejected' && value.rejectionCode === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionCode'],
        message: 'rejected transport receipts require a rejection code',
      });
    }
    if (value.transportStatus === 'delivered' && value.rejectionCode !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionCode'],
        message: 'delivered transport receipts cannot include a rejection code',
      });
    }
  });

export type CommandTransportReceiptV1 = z.infer<
  typeof CommandTransportReceiptV1Schema
>;
