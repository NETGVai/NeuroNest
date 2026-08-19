/**
 * Response Composition V1
 *
 * Closed, versioned presentation contracts for assistant response blocks.
 * Values crossing this boundary are treated as untrusted and parsed without
 * throwing. Unknown object fields are stripped so only declared,
 * authority-approved presentation fields survive parsing.
 *
 * Requirements: 2.1–2.2, 2.6–2.7, 2.9–2.10, 20.1, 22.1
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from './primitives';
import {
  ActionDescriptorV1Schema,
  AuthorityRefV1Schema,
  SourceReferenceV1Schema,
  type ActionDescriptorV1,
  type AuthorityRefV1,
} from './response-support';

export const RESPONSE_CONTRACT_VERSION = 1 as const;
export const MAX_RESPONSE_BLOCKS = 256;
export const MAX_RESPONSE_BLOCK_KEY_LENGTH = 512;
export const MAX_PRESENTATION_TEXT_LENGTH = 100_000;
export const MAX_PRESENTATION_SUMMARY_LENGTH = 4_096;
export const MAX_PRESENTATION_ITEMS = 1_000;

const PresentationTextSchema = z.string().max(MAX_PRESENTATION_TEXT_LENGTH);
const PresentationSummarySchema = z.string().max(MAX_PRESENTATION_SUMMARY_LENGTH);
const RevisionSchema = z.number().int().nonnegative().finite();
const RatioSchema = z.number().min(0).max(1).finite();

export const ResponseBlockStableKeyV1Schema = IdentifierSchema.max(MAX_RESPONSE_BLOCK_KEY_LENGTH);

export const ResponseBlockKindSchema = z.enum([
  'narrative',
  'reasoning',
  'turn_status',
  'tool_activity',
  'task_progress',
  'decision',
  'recommendation',
  'context',
  'code',
  'diff',
  'structured_data',
  'insight',
  'attachment',
  'error',
  'follow_up_actions',
]);
export type ResponseBlockKind = z.infer<typeof ResponseBlockKindSchema>;

export const ResponseBlockRoleSchema = z.enum([
  'primary',
  'status',
  'decision',
  'evidence',
  'detail',
  'actions',
]);
export type ResponseBlockRole = z.infer<typeof ResponseBlockRoleSchema>;

export const ResponseBlockStatusSchema = z.enum([
  'pending',
  'ready',
  'streaming',
  'stale',
  'unavailable',
  'terminal',
]);
export type ResponseBlockStatus = z.infer<typeof ResponseBlockStatusSchema>;

/** Task 1.1 compatibility alias for the canonical task 1.4 authority contract. */
export const ResponseAuthorityRefV1Schema = AuthorityRefV1Schema;
export type ResponseAuthorityRefV1 = AuthorityRefV1;

export const ResponseSourceIdentityV1Schema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  turnId: IdentifierSchema,
  entityId: IdentifierSchema,
});
export type ResponseSourceIdentityV1 = z.infer<typeof ResponseSourceIdentityV1Schema>;

const ResponseBlockBaseShape = {
  schemaVersion: z.literal(RESPONSE_CONTRACT_VERSION),
  stableKey: ResponseBlockStableKeyV1Schema,
  role: ResponseBlockRoleSchema,
  semanticAnchor: IdentifierSchema,
  sourceIdentity: ResponseSourceIdentityV1Schema,
  contentRevision: RevisionSchema,
  status: ResponseBlockStatusSchema,
  permittedSummary: PresentationSummarySchema.optional(),
  renderIntent: z.unknown().optional(),
  authority: ResponseAuthorityRefV1Schema.optional(),
};

export const ResponseBlockBaseV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: ResponseBlockKindSchema,
});
export type ResponseBlockBaseV1 = z.infer<typeof ResponseBlockBaseV1Schema>;

export const NarrativeBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('narrative'),
  content: z.object({
    format: z.enum(['plain_stream', 'markdown']),
    text: PresentationTextSchema,
    finalized: z.boolean(),
  }),
});

export const ReasoningBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('reasoning'),
  content: z.object({
    categories: z.array(z.enum(['summary', 'search', 'coding', 'tool', 'verification'])).max(5),
    summary: PresentationSummarySchema,
    disclosure: z.enum(['permitted', 'protected', 'unavailable']),
    finalized: z.boolean(),
  }),
});

export const TurnStatusBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('turn_status'),
  content: z.object({
    state: z.enum([
      'queued',
      'reasoning',
      'tool_running',
      'streaming',
      'waiting_for_user',
      'retrying',
      'cancelling',
      'cancelled',
      'interrupted',
      'completed',
      'failed',
      'reconnecting',
    ]),
    label: PresentationSummarySchema,
    startedAt: TimestampSchema.optional(),
    terminalAt: TimestampSchema.optional(),
    cancellation: z.object({
      available: z.boolean(),
      unavailableReason: PresentationSummarySchema.optional(),
    }).optional(),
  }),
});

export const ToolActivityBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('tool_activity'),
  content: z.object({
    callId: IdentifierSchema,
    parentCallId: IdentifierSchema.optional(),
    modelOrderIndex: z.number().int().nonnegative().finite(),
    state: z.enum([
      'planned',
      'executing',
      'completed',
      'failed',
      'cancelled',
      'awaiting_approval',
    ]),
    riskClass: IdentifierSchema,
    owner: IdentifierSchema,
    value: z.object({
      canonicalValueId: IdentifierSchema,
      mediaType: z.string().min(1).max(256),
      permittedPreview: PresentationTextSchema.optional(),
    }).optional(),
    retainedOutput: z.enum(['inline', 'spilled', 'truncated', 'redacted', 'unavailable']),
  }),
});

export const TaskProgressBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('task_progress'),
  content: z.object({
    groupLabel: PresentationSummarySchema.optional(),
    items: z.array(z.object({
      taskId: IdentifierSchema,
      taskKind: z.enum(['plan', 'task', 'workflow', 'subagent', 'job', 'check', 'result_injection']),
      title: PresentationSummarySchema,
      owner: IdentifierSchema,
      state: z.enum(['queued', 'running', 'blocked', 'waiting', 'failed', 'cancelled', 'completed']),
      progress: RatioSchema.optional(),
      outcome: PresentationSummarySchema.optional(),
    })).max(MAX_PRESENTATION_ITEMS),
  }),
});

export const DecisionBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('decision'),
  content: z.object({
    collaborationId: IdentifierSchema,
    canonicalStableKey: IdentifierSchema,
    decisionType: z.enum(['question', 'approval', 'permission', 'plan_review']),
    owner: IdentifierSchema,
    prompt: PresentationSummarySchema,
    scopeSummary: PresentationSummarySchema.optional(),
    riskSummary: PresentationSummarySchema.optional(),
    expiresAt: TimestampSchema.optional(),
    state: z.enum(['pending', 'answered', 'approved', 'denied', 'expired', 'superseded', 'unavailable']),
    contractRevision: RevisionSchema,
    contractDigest: IdentifierSchema,
  }),
});

export const ConfidenceStatusSchema = z.enum([
  'reported',
  'calculated',
  'estimated',
  'partial',
  'unavailable',
]);

/** Task 1.1 compatibility alias for the canonical task 1.4 action contract. */
export const ResponseActionDescriptorV1Schema = ActionDescriptorV1Schema;
export type ResponseActionDescriptorV1 = ActionDescriptorV1;

export const RecommendationBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('recommendation'),
  content: z.object({
    recommendation: PresentationSummarySchema,
    rationale: PresentationTextSchema.optional(),
    confidence: z.object({
      status: ConfidenceStatusSchema,
      value: RatioSchema.optional(),
      sourceRevision: RevisionSchema,
    }),
    actions: z.array(ResponseActionDescriptorV1Schema).max(4),
  }),
});

export const ContextBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('context'),
  content: z.object({
    sources: z.array(SourceReferenceV1Schema).max(MAX_PRESENTATION_ITEMS),
  }),
});

export const CodeBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('code'),
  content: z.object({
    artifactId: IdentifierSchema,
    language: z.string().min(1).max(128),
    code: PresentationTextSchema,
    finalized: z.boolean(),
    displayLabel: PresentationSummarySchema.optional(),
    showLineNumbers: z.boolean().optional(),
  }),
});

export const DiffBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('diff'),
  content: z.object({
    diffId: IdentifierSchema,
    diffType: z.enum(['file', 'structured_record']),
    state: z.enum(['proposed', 'staged', 'applied', 'rejected', 'stale', 'conflicted', 'unavailable']),
    summary: PresentationSummarySchema,
    additions: z.number().int().nonnegative().finite(),
    deletions: z.number().int().nonnegative().finite(),
    changes: z.array(z.object({
      changeId: IdentifierSchema,
      label: PresentationSummarySchema,
      previousValue: PresentationTextSchema.optional(),
      proposedValue: PresentationTextSchema.optional(),
    })).max(MAX_PRESENTATION_ITEMS),
  }),
});

export const PresentationScalarV1Schema = z.union([
  z.string().max(MAX_PRESENTATION_TEXT_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type PresentationScalarV1 = z.infer<typeof PresentationScalarV1Schema>;

export const StructuredDataBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('structured_data'),
  content: z.object({
    dataId: IdentifierSchema,
    caption: PresentationSummarySchema.optional(),
    columns: z.array(z.object({
      columnId: IdentifierSchema,
      label: PresentationSummarySchema,
    })).min(1).max(100),
    rows: z.array(z.object({
      rowId: IdentifierSchema,
      label: PresentationSummarySchema,
      values: z.array(PresentationScalarV1Schema).max(100),
    })).max(MAX_PRESENTATION_ITEMS),
  }),
});

export const InsightBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('insight'),
  content: z.object({
    insightId: IdentifierSchema,
    title: PresentationSummarySchema,
    metrics: z.array(z.object({
      metricId: IdentifierSchema,
      label: PresentationSummarySchema,
      value: z.number().finite(),
      unit: z.string().min(1).max(128),
    })).max(MAX_PRESENTATION_ITEMS),
    timeRange: PresentationSummarySchema.optional(),
    accessibleSummary: PresentationTextSchema,
    sourceRevision: RevisionSchema,
  }),
});

export const AttachmentBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('attachment'),
  content: z.object({
    attachments: z.array(z.object({
      attachmentId: IdentifierSchema,
      displayName: PresentationSummarySchema,
      mediaType: z.string().min(1).max(256),
      state: z.enum(['processing', 'ready', 'unavailable', 'failed', 'redacted']),
      alternativeText: PresentationTextSchema.optional(),
      detailIdentity: IdentifierSchema.optional(),
    })).max(MAX_PRESENTATION_ITEMS),
  }),
});

export const ErrorBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('error'),
  content: z.object({
    errorId: IdentifierSchema,
    errorClass: IdentifierSchema,
    summary: PresentationSummarySchema,
    affectedIdentity: IdentifierSchema,
    lastVerifiedState: PresentationSummarySchema,
    correlationId: IdentifierSchema,
    recoveryState: z.enum(['failed', 'retrying', 'reconnecting', 'interrupted', 'cancelled', 'stale']),
    partialContent: PresentationTextSchema.optional(),
  }),
});

export const FollowUpActionsBlockV1Schema = z.object({
  ...ResponseBlockBaseShape,
  kind: z.literal('follow_up_actions'),
  content: z.object({
    sourceRevision: RevisionSchema,
    actions: z.array(ResponseActionDescriptorV1Schema).min(2).max(4),
  }),
});

/** The only response block kinds accepted by the V1 boundary. */
export const ResponseBlockV1Schema = z.discriminatedUnion('kind', [
  NarrativeBlockV1Schema,
  ReasoningBlockV1Schema,
  TurnStatusBlockV1Schema,
  ToolActivityBlockV1Schema,
  TaskProgressBlockV1Schema,
  DecisionBlockV1Schema,
  RecommendationBlockV1Schema,
  ContextBlockV1Schema,
  CodeBlockV1Schema,
  DiffBlockV1Schema,
  StructuredDataBlockV1Schema,
  InsightBlockV1Schema,
  AttachmentBlockV1Schema,
  ErrorBlockV1Schema,
  FollowUpActionsBlockV1Schema,
]);

export type NarrativeBlockV1 = z.infer<typeof NarrativeBlockV1Schema>;
export type ReasoningBlockV1 = z.infer<typeof ReasoningBlockV1Schema>;
export type TurnStatusBlockV1 = z.infer<typeof TurnStatusBlockV1Schema>;
export type ToolActivityBlockV1 = z.infer<typeof ToolActivityBlockV1Schema>;
export type TaskProgressBlockV1 = z.infer<typeof TaskProgressBlockV1Schema>;
export type DecisionBlockV1 = z.infer<typeof DecisionBlockV1Schema>;
export type RecommendationBlockV1 = z.infer<typeof RecommendationBlockV1Schema>;
export type ContextBlockV1 = z.infer<typeof ContextBlockV1Schema>;
export type CodeBlockV1 = z.infer<typeof CodeBlockV1Schema>;
export type DiffBlockV1 = z.infer<typeof DiffBlockV1Schema>;
export type StructuredDataBlockV1 = z.infer<typeof StructuredDataBlockV1Schema>;
export type InsightBlockV1 = z.infer<typeof InsightBlockV1Schema>;
export type AttachmentBlockV1 = z.infer<typeof AttachmentBlockV1Schema>;
export type ErrorBlockV1 = z.infer<typeof ErrorBlockV1Schema>;
export type FollowUpActionsBlockV1 = z.infer<typeof FollowUpActionsBlockV1Schema>;
export type ResponseBlockV1 = z.infer<typeof ResponseBlockV1Schema>;

export const ResponseCompositionV1Schema = z.object({
  schemaVersion: z.literal(RESPONSE_CONTRACT_VERSION),
  compositionId: IdentifierSchema,
  chatNodeStableKey: IdentifierSchema,
  semanticAnchor: IdentifierSchema,
  sourceRevision: RevisionSchema,
  blocks: z.array(ResponseBlockV1Schema).max(MAX_RESPONSE_BLOCKS),
}).superRefine((composition, context) => {
  if (findDuplicateBlockStableKey(composition.blocks) !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['blocks'],
      message: 'Response block stable keys must be unique within a composition.',
    });
  }
});
export type ResponseCompositionV1 = z.infer<typeof ResponseCompositionV1Schema>;

const ResponseCompositionEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(RESPONSE_CONTRACT_VERSION),
  compositionId: IdentifierSchema,
  chatNodeStableKey: IdentifierSchema,
  semanticAnchor: IdentifierSchema,
  sourceRevision: RevisionSchema,
  blocks: z.array(z.unknown()).max(MAX_RESPONSE_BLOCKS),
});

export const ResponseCompositionFailureCodeSchema = z.enum([
  'invalid_composition',
  'unsupported_composition_version',
  'invalid_block',
  'unsupported_block_version',
  'unsupported_block_kind',
  'duplicate_block_stable_key',
  'boundary_exception',
]);
export type ResponseCompositionFailureCode = z.infer<typeof ResponseCompositionFailureCodeSchema>;

export interface ResponseCompositionFailureDiagnosticV1 {
  readonly code: ResponseCompositionFailureCode;
  readonly message: string;
  readonly issueCount: number;
  readonly issuePaths: readonly string[];
}

export type ResponseCompositionParseResult =
  | { ok: true; value: ResponseCompositionV1 }
  | {
      ok: false;
      scope: 'block';
      blockKey: string;
      diagnostic: ResponseCompositionFailureDiagnosticV1;
    }
  | {
      ok: false;
      scope: 'composition';
      diagnostic: ResponseCompositionFailureDiagnosticV1;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function boundedIssuePaths(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, 8).map((issue) => issue.path.slice(0, 8).map((part) => {
    const segment = String(part);
    return /^[A-Za-z0-9_]+$/.test(segment) ? segment : '?';
  }).join('.').slice(0, 128));
}

function diagnostic(
  code: ResponseCompositionFailureCode,
  message: string,
  error?: z.ZodError,
): ResponseCompositionFailureDiagnosticV1 {
  return Object.freeze({
    code,
    message,
    issueCount: Math.min(error?.issues.length ?? 0, 1_000),
    issuePaths: Object.freeze(error ? boundedIssuePaths(error) : []),
  });
}

function compositionFailureCode(raw: unknown): ResponseCompositionFailureCode {
  const version = asRecord(raw)?.['schemaVersion'];
  return version !== undefined && version !== RESPONSE_CONTRACT_VERSION
    ? 'unsupported_composition_version'
    : 'invalid_composition';
}

function blockFailureCode(raw: unknown): ResponseCompositionFailureCode {
  const record = asRecord(raw);
  if (record?.['schemaVersion'] !== undefined && record['schemaVersion'] !== RESPONSE_CONTRACT_VERSION) {
    return 'unsupported_block_version';
  }
  if (record?.['kind'] !== undefined && !ResponseBlockKindSchema.safeParse(record['kind']).success) {
    return 'unsupported_block_kind';
  }
  return 'invalid_block';
}

function identifiableBlockKey(raw: unknown): string | undefined {
  const parsed = ResponseBlockStableKeyV1Schema.safeParse(asRecord(raw)?.['stableKey']);
  return parsed.success ? parsed.data : undefined;
}

function findDuplicateBlockStableKey(blocks: readonly unknown[]): string | undefined {
  const seen = new Set<string>();
  for (const block of blocks) {
    const stableKey = identifiableBlockKey(block);
    if (stableKey === undefined) {
      continue;
    }
    if (seen.has(stableKey)) {
      return stableKey;
    }
    seen.add(stableKey);
  }
  return undefined;
}

/**
 * Parse an untrusted response composition without throwing. A malformed block
 * is block-scoped only when its stable key can still uniquely identify it;
 * otherwise the failure is composition-scoped.
 */
export function parseResponseComposition(raw: unknown): ResponseCompositionParseResult {
  try {
    const envelope = ResponseCompositionEnvelopeV1Schema.safeParse(raw);
    if (!envelope.success) {
      const code = compositionFailureCode(raw);
      return {
        ok: false,
        scope: 'composition',
        diagnostic: diagnostic(code, 'Response composition validation failed.', envelope.error),
      };
    }

    if (findDuplicateBlockStableKey(envelope.data.blocks) !== undefined) {
      return {
        ok: false,
        scope: 'composition',
        diagnostic: diagnostic(
          'duplicate_block_stable_key',
          'Response composition contains an ambiguous block identity.',
        ),
      };
    }

    const blocks: ResponseBlockV1[] = [];
    for (const rawBlock of envelope.data.blocks) {
      const parsedBlock = ResponseBlockV1Schema.safeParse(rawBlock);
      if (!parsedBlock.success) {
        const blockKey = identifiableBlockKey(rawBlock);
        const code = blockFailureCode(rawBlock);
        const failureDiagnostic = diagnostic(code, 'Response block validation failed.', parsedBlock.error);
        if (blockKey !== undefined) {
          return { ok: false, scope: 'block', blockKey, diagnostic: failureDiagnostic };
        }
        return { ok: false, scope: 'composition', diagnostic: failureDiagnostic };
      }
      blocks.push(parsedBlock.data);
    }

    return {
      ok: true,
      value: {
        schemaVersion: RESPONSE_CONTRACT_VERSION,
        compositionId: envelope.data.compositionId,
        chatNodeStableKey: envelope.data.chatNodeStableKey,
        semanticAnchor: envelope.data.semanticAnchor,
        sourceRevision: envelope.data.sourceRevision,
        blocks,
      },
    };
  } catch {
    return {
      ok: false,
      scope: 'composition',
      diagnostic: diagnostic('boundary_exception', 'Response composition boundary could not inspect the input.'),
    };
  }
}
