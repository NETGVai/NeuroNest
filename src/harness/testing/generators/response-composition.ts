import fc from 'fast-check';
import {
  MAX_PRESENTATION_SUMMARY_LENGTH,
  MAX_PRESENTATION_TEXT_LENGTH,
  ResponseBlockV1Schema,
  type ResponseActionDescriptorV1,
  type ResponseBlockKind,
  type ResponseBlockRole,
  type ResponseBlockV1,
  type ResponseCompositionV1,
} from '../../contracts/response-composition';
import type { CommandV1 } from '../../contracts/command';
import type { RenderIntentV1 } from '../../contracts/render-intent';
import {
  ActionDescriptorV1Schema,
  type ActionDescriptorV1,
  type AuthorityRefV1,
} from '../../contracts/response-support';
import type { OperationalBoundsV1 } from '../../settings/operational-bounds-schema';
import {
  LEGAL_TRANSITIONS,
  type TurnActivityState,
  type TurnTransitionRecord,
} from '../../runtime/turn-controller-schemas';
import { computeResponseBlockStableKey } from '../../projections/response-block-identity';
import { RESPONSE_COMPATIBILITY_MATRIX_V1, type ResponseIntentKind } from '../../presentation/response-compatibility';

/**
 * Reusable, bounded fast-check generators for the structured-response contract family.
 *
 * All collections and free-form strings intentionally use small generation bounds so a
 * counterexample shrinks to one block, transition, command, or action. Production schemas
 * remain the only source of validation truth; these generators do not relax them.
 *
 * Requirements: 2.1–2.8, 20.1–20.8, 22.1–22.2, 22.4, 22.6
 */

export const RESPONSE_BLOCK_KINDS = [
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
] as const satisfies readonly ResponseBlockKind[];

export const RESPONSE_BLOCK_ROLES = [
  'primary',
  'status',
  'decision',
  'evidence',
  'detail',
  'actions',
] as const satisfies readonly ResponseBlockRole[];

export const RENDER_INTENT_KINDS = [
  'generic',
  'read',
  'search',
  'diff',
  'terminal',
  'web',
  'image',
  'table',
  'tree',
  'artifact',
] as const satisfies readonly ResponseIntentKind[];

export const TURN_ACTIVITY_STATES = [
  'queued',
  'assembling',
  'awaiting_first_token',
  'reasoning',
  'streaming',
  'tool_running',
  'retrying',
  'waiting_for_user',
  'cancelling',
  'reconnecting',
  'completed',
  'interrupted',
  'failed',
] as const satisfies readonly TurnActivityState[];

export const SUPPORTED_RESPONSE_CONTRACT_VERSIONS = [1] as const;

export const maliciousCanaries = [
  { kind: 'html', value: '<img src=x onerror=alert(1)>' },
  { kind: 'markdown', value: '[open](javascript:alert(1))' },
  { kind: 'url', value: 'file:///Users/private/.ssh/id_rsa' },
  { kind: 'diagram', value: 'click node "javascript:alert(1)"' },
  { kind: 'tool_output', value: 'authorization: Bearer secret-token' },
  { kind: 'filename', value: '/Users/private/project/.env' },
  { kind: 'locator', value: 'https://private.example.test/detail?id=secret' },
  { kind: 'action', value: 'rm -rf /' },
  { kind: 'protected_prompt', value: 'system prompt: hidden reasoning' },
] as const;

export type MaliciousCanary = (typeof maliciousCanaries)[number];

const IDENTIFIER_INITIAL_CHARACTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789'] as const;
const IDENTIFIER_REST_CHARACTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789_-'] as const;
const AUTHORIZED_TEXT_CHARACTERS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;!?_-',
] as const;
const HEX_CHARACTERS = [...'0123456789abcdef'] as const;
const boundedIdentifierArbitrary = fc
  .tuple(
    fc.constantFrom(...IDENTIFIER_INITIAL_CHARACTERS),
    fc.array(fc.constantFrom(...IDENTIFIER_REST_CHARACTERS), { maxLength: 23 }),
  )
  .map(([first, rest]) => `${first}${rest.join('')}`);
const authorizedTextArbitrary = fc
  .array(fc.constantFrom(...AUTHORIZED_TEXT_CHARACTERS), { minLength: 1, maxLength: 160 })
  .map((characters) => characters.join(''));
const sha256DigestArbitrary = fc
  .array(fc.constantFrom(...HEX_CHARACTERS), { minLength: 64, maxLength: 64 })
  .map((characters) => `sha256:${characters.join('')}`);
const boundedTextArbitrary = fc.string({ maxLength: 256 });
const boundedNonEmptyTextArbitrary = fc.string({ minLength: 1, maxLength: 160 });
const boundedSummaryArbitrary = fc.string({ maxLength: Math.min(160, MAX_PRESENTATION_SUMMARY_LENGTH) });
const revisionArbitrary = fc.nat({ max: 1_000_000 });
const ratioArbitrary = fc.double({ min: 0, max: 1, noNaN: true });
const timestampArbitrary = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((timestamp) => new Date(timestamp).toISOString());
const optional = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arbitrary, { nil: undefined });

export const responseBlockKindArbitrary = fc.constantFrom(...RESPONSE_BLOCK_KINDS);
export const responseBlockRoleArbitrary = fc.constantFrom(...RESPONSE_BLOCK_ROLES);
export const supportedResponseContractVersionArbitrary = fc.constant(1 as const);
export const unsupportedResponseContractVersionArbitrary = fc
  .integer({ min: 0, max: 32 })
  .filter((version) => version !== 1);
export const maliciousCanaryArbitrary = fc.constantFrom(...maliciousCanaries);

export interface StableResponseIdentity {
  readonly sessionId: string;
  readonly branchId: string;
  readonly compositionId: string;
  readonly entityKind: ResponseBlockKind;
  readonly entityId: string;
  readonly role: ResponseBlockRole;
}

export const stableResponseIdentityArbitrary: fc.Arbitrary<StableResponseIdentity> = fc.record({
  sessionId: boundedIdentifierArbitrary,
  branchId: boundedIdentifierArbitrary,
  compositionId: boundedIdentifierArbitrary,
  entityKind: responseBlockKindArbitrary,
  entityId: boundedIdentifierArbitrary,
  role: responseBlockRoleArbitrary,
});

const responseAuthorityRefArbitrary: fc.Arbitrary<AuthorityRefV1> = fc.record({
  schemaVersion: fc.constant(1 as const),
  authorityKind: fc.constantFrom(
    'mcp_server_manager' as const,
    'provider_registry' as const,
    'session_store' as const,
    'plugin_registry' as const,
    'orchestration_engine' as const,
    'skill_catalog' as const,
    'security_authority' as const,
    'filesystem_authority' as const,
    'process_authority' as const,
    'terminal_authority' as const,
    'language_service_authority' as const,
    'tool_system' as const,
    'projection_service' as const,
    'web_retrieval_service' as const,
    'attachment_service' as const,
    'session_query_service' as const,
    'draft_authority' as const,
    'collaboration_authority' as const,
    'external_navigation_authority' as const,
  ),
  authorityId: boundedIdentifierArbitrary,
});

const sourceIdentityArbitrary = fc.record({
  sessionId: boundedIdentifierArbitrary,
  branchId: boundedIdentifierArbitrary,
  turnId: boundedIdentifierArbitrary,
  entityId: boundedIdentifierArbitrary,
});

export const responseActionDescriptorV1Arbitrary: fc.Arbitrary<ResponseActionDescriptorV1> = fc.record({
  schemaVersion: fc.constant(1 as const),
  actionId: boundedIdentifierArbitrary,
  kind: fc.constantFrom(
    'insert_prompt' as const,
    'submit_prompt' as const,
    'navigate' as const,
    'authority_command' as const,
  ),
  label: authorizedTextArbitrary,
  owner: responseAuthorityRefArbitrary,
  expectedProjectionRevision: revisionArbitrary,
  idempotencyKey: optional(boundedIdentifierArbitrary),
  disabledReason: optional(authorizedTextArbitrary),
  risk: optional(
    fc.constantFrom(
      'none' as const,
      'low' as const,
      'medium' as const,
      'high' as const,
      'critical' as const,
      'unknown' as const,
    ),
  ),
  scopeDigest: optional(sha256DigestArbitrary),
});

const contentArbitraries = {
  narrative: fc.record({
    format: fc.constantFrom('plain_stream' as const, 'markdown' as const),
    text: boundedTextArbitrary,
    finalized: fc.boolean(),
  }),
  reasoning: fc.record({
    categories: fc.uniqueArray(
      fc.constantFrom(
        'summary' as const,
        'search' as const,
        'coding' as const,
        'tool' as const,
        'verification' as const,
      ),
      { maxLength: 5 },
    ),
    summary: boundedSummaryArbitrary,
    disclosure: fc.constantFrom('permitted' as const, 'protected' as const, 'unavailable' as const),
    finalized: fc.boolean(),
  }),
  turn_status: fc.record({
    state: fc.constantFrom(
      'queued' as const,
      'reasoning' as const,
      'tool_running' as const,
      'streaming' as const,
      'waiting_for_user' as const,
      'retrying' as const,
      'cancelling' as const,
      'cancelled' as const,
      'interrupted' as const,
      'completed' as const,
      'failed' as const,
      'reconnecting' as const,
    ),
    label: boundedSummaryArbitrary,
    startedAt: optional(timestampArbitrary),
    terminalAt: optional(timestampArbitrary),
    cancellation: optional(
      fc.record({
        available: fc.boolean(),
        unavailableReason: optional(boundedSummaryArbitrary),
      }),
    ),
  }),
  tool_activity: fc.record({
    callId: boundedIdentifierArbitrary,
    parentCallId: optional(boundedIdentifierArbitrary),
    modelOrderIndex: fc.nat({ max: 1_000 }),
    state: fc.constantFrom(
      'planned' as const,
      'executing' as const,
      'completed' as const,
      'failed' as const,
      'cancelled' as const,
      'awaiting_approval' as const,
    ),
    riskClass: boundedIdentifierArbitrary,
    owner: boundedIdentifierArbitrary,
    value: optional(
      fc.record({
        canonicalValueId: boundedIdentifierArbitrary,
        mediaType: boundedNonEmptyTextArbitrary,
        permittedPreview: optional(boundedTextArbitrary),
      }),
    ),
    retainedOutput: fc.constantFrom(
      'inline' as const,
      'spilled' as const,
      'truncated' as const,
      'redacted' as const,
      'unavailable' as const,
    ),
  }),
  task_progress: fc.record({
    groupLabel: optional(boundedSummaryArbitrary),
    items: fc.array(
      fc.record({
        taskId: boundedIdentifierArbitrary,
        taskKind: fc.constantFrom(
          'plan' as const,
          'task' as const,
          'workflow' as const,
          'subagent' as const,
          'job' as const,
          'check' as const,
          'result_injection' as const,
        ),
        title: boundedSummaryArbitrary,
        owner: boundedIdentifierArbitrary,
        state: fc.constantFrom(
          'queued' as const,
          'running' as const,
          'blocked' as const,
          'waiting' as const,
          'failed' as const,
          'cancelled' as const,
          'completed' as const,
        ),
        progress: optional(ratioArbitrary),
        outcome: optional(boundedSummaryArbitrary),
      }),
      { maxLength: 4 },
    ),
  }),
  decision: fc.record({
    collaborationId: boundedIdentifierArbitrary,
    canonicalStableKey: boundedIdentifierArbitrary,
    decisionType: fc.constantFrom(
      'question' as const,
      'approval' as const,
      'permission' as const,
      'plan_review' as const,
    ),
    owner: boundedIdentifierArbitrary,
    prompt: boundedSummaryArbitrary,
    scopeSummary: optional(boundedSummaryArbitrary),
    riskSummary: optional(boundedSummaryArbitrary),
    expiresAt: optional(timestampArbitrary),
    state: fc.constantFrom(
      'pending' as const,
      'answered' as const,
      'approved' as const,
      'denied' as const,
      'expired' as const,
      'superseded' as const,
      'unavailable' as const,
    ),
    contractRevision: revisionArbitrary,
    contractDigest: boundedIdentifierArbitrary,
  }),
  recommendation: fc.record({
    recommendation: boundedSummaryArbitrary,
    rationale: optional(boundedTextArbitrary),
    confidence: fc.record({
      status: fc.constantFrom(
        'reported' as const,
        'calculated' as const,
        'estimated' as const,
        'partial' as const,
        'unavailable' as const,
      ),
      value: optional(ratioArbitrary),
      sourceRevision: revisionArbitrary,
    }),
    actions: fc.array(responseActionDescriptorV1Arbitrary, { maxLength: 4 }),
  }),
  context: fc.record({
    sources: fc.array(
      fc.record({
        schemaVersion: fc.constant(1 as const),
        citationId: boundedIdentifierArbitrary,
        sourceType: fc.constantFrom(
          'web' as const,
          'file' as const,
          'attachment' as const,
          'session' as const,
          'artifact' as const,
          'tool' as const,
          'provider' as const,
        ),
        state: fc.constant('available' as const),
        sourceRevision: revisionArbitrary,
        authority: responseAuthorityRefArbitrary,
        contentDigest: optional(sha256DigestArbitrary),
        retrievedAt: optional(timestampArbitrary),
        permittedTitle: optional(authorizedTextArbitrary),
        permittedExcerpt: optional(authorizedTextArbitrary),
      }),
      { maxLength: 4 },
    ),
  }),
  code: fc.record({
    artifactId: boundedIdentifierArbitrary,
    language: boundedNonEmptyTextArbitrary,
    code: boundedTextArbitrary,
    finalized: fc.boolean(),
    displayLabel: optional(boundedSummaryArbitrary),
    showLineNumbers: optional(fc.boolean()),
  }),
  diff: fc.record({
    diffId: boundedIdentifierArbitrary,
    diffType: fc.constantFrom('file' as const, 'structured_record' as const),
    state: fc.constantFrom(
      'proposed' as const,
      'staged' as const,
      'applied' as const,
      'rejected' as const,
      'stale' as const,
      'conflicted' as const,
      'unavailable' as const,
    ),
    summary: boundedSummaryArbitrary,
    additions: fc.nat({ max: 10_000 }),
    deletions: fc.nat({ max: 10_000 }),
    changes: fc.array(
      fc.record({
        changeId: boundedIdentifierArbitrary,
        label: boundedSummaryArbitrary,
        previousValue: optional(boundedTextArbitrary),
        proposedValue: optional(boundedTextArbitrary),
      }),
      { maxLength: 4 },
    ),
  }),
  structured_data: fc.record({
    dataId: boundedIdentifierArbitrary,
    caption: optional(boundedSummaryArbitrary),
    columns: fc.array(
      fc.record({
        columnId: boundedIdentifierArbitrary,
        label: boundedSummaryArbitrary,
      }),
      { minLength: 1, maxLength: 4 },
    ),
    rows: fc.array(
      fc.record({
        rowId: boundedIdentifierArbitrary,
        label: boundedSummaryArbitrary,
        values: fc.array(
          fc.oneof(
            boundedTextArbitrary,
            fc.double({ noNaN: true, noDefaultInfinity: true }),
            fc.boolean(),
            fc.constant(null),
          ),
          { maxLength: 4 },
        ),
      }),
      { maxLength: 4 },
    ),
  }),
  insight: fc.record({
    insightId: boundedIdentifierArbitrary,
    title: boundedSummaryArbitrary,
    metrics: fc.array(
      fc.record({
        metricId: boundedIdentifierArbitrary,
        label: boundedSummaryArbitrary,
        value: fc.double({ noNaN: true, noDefaultInfinity: true }),
        unit: boundedNonEmptyTextArbitrary,
      }),
      { maxLength: 4 },
    ),
    timeRange: optional(boundedSummaryArbitrary),
    accessibleSummary: boundedTextArbitrary,
    sourceRevision: revisionArbitrary,
  }),
  attachment: fc.record({
    attachments: fc.array(
      fc.record({
        attachmentId: boundedIdentifierArbitrary,
        displayName: boundedSummaryArbitrary,
        mediaType: boundedNonEmptyTextArbitrary,
        state: fc.constantFrom(
          'processing' as const,
          'ready' as const,
          'unavailable' as const,
          'failed' as const,
          'redacted' as const,
        ),
        alternativeText: optional(boundedTextArbitrary),
        detailIdentity: optional(boundedIdentifierArbitrary),
      }),
      { maxLength: 4 },
    ),
  }),
  error: fc.record({
    errorId: boundedIdentifierArbitrary,
    errorClass: boundedIdentifierArbitrary,
    summary: boundedSummaryArbitrary,
    affectedIdentity: boundedIdentifierArbitrary,
    lastVerifiedState: boundedSummaryArbitrary,
    correlationId: boundedIdentifierArbitrary,
    recoveryState: fc.constantFrom(
      'failed' as const,
      'retrying' as const,
      'reconnecting' as const,
      'interrupted' as const,
      'cancelled' as const,
      'stale' as const,
    ),
    partialContent: optional(boundedTextArbitrary),
  }),
  follow_up_actions: fc.record({
    sourceRevision: revisionArbitrary,
    actions: fc.uniqueArray(responseActionDescriptorV1Arbitrary, {
      minLength: 2,
      maxLength: 4,
      selector: (action) => action.actionId,
    }),
  }),
} as const;

function blockContentArbitrary(kind: ResponseBlockKind): fc.Arbitrary<unknown> {
  return contentArbitraries[kind];
}

export function responseBlockV1ArbitraryForKind(kind: ResponseBlockKind): fc.Arbitrary<ResponseBlockV1> {
  return fc
    .tuple(
      sourceIdentityArbitrary,
      responseBlockRoleArbitrary,
      boundedIdentifierArbitrary,
      revisionArbitrary,
      fc.constantFrom(
        'pending' as const,
        'ready' as const,
        'streaming' as const,
        'stale' as const,
        'unavailable' as const,
        'terminal' as const,
      ),
      optional(boundedSummaryArbitrary),
      optional(responseAuthorityRefArbitrary),
      blockContentArbitrary(kind),
    )
    .map(([sourceIdentity, role, compositionId, contentRevision, status, permittedSummary, authority, content]) =>
      ResponseBlockV1Schema.parse({
        schemaVersion: 1,
        stableKey: computeResponseBlockStableKey({
          sessionId: sourceIdentity.sessionId,
          branchId: sourceIdentity.branchId,
          compositionId,
          entityKind: kind,
          entityId: sourceIdentity.entityId,
          role,
        }),
        kind,
        role,
        semanticAnchor: `anchor-${sourceIdentity.entityId}`,
        sourceIdentity,
        contentRevision,
        status,
        permittedSummary,
        authority,
        content,
      }),
    );
}

export const responseBlockV1Arbitrary: fc.Arbitrary<ResponseBlockV1> = responseBlockKindArbitrary.chain(
  responseBlockV1ArbitraryForKind,
);

export const responseCompositionV1Arbitrary: fc.Arbitrary<ResponseCompositionV1> = fc
  .record({
    compositionId: boundedIdentifierArbitrary,
    chatNodeStableKey: boundedIdentifierArbitrary,
    semanticAnchor: boundedIdentifierArbitrary,
    sourceRevision: revisionArbitrary,
    sessionId: boundedIdentifierArbitrary,
    branchId: boundedIdentifierArbitrary,
    turnId: boundedIdentifierArbitrary,
    blocks: fc.uniqueArray(responseBlockV1Arbitrary, {
      maxLength: RESPONSE_BLOCK_KINDS.length,
      selector: (block) => `${block.kind}:${block.sourceIdentity.entityId}:${block.role}`,
    }),
  })
  .map((value) => ({
    schemaVersion: 1,
    compositionId: value.compositionId,
    chatNodeStableKey: value.chatNodeStableKey,
    semanticAnchor: value.semanticAnchor,
    sourceRevision: value.sourceRevision,
    blocks: value.blocks.map((block) => {
      const sourceIdentity = {
        ...block.sourceIdentity,
        sessionId: value.sessionId,
        branchId: value.branchId,
        turnId: value.turnId,
      };
      return {
        ...block,
        sourceIdentity,
        stableKey: computeResponseBlockStableKey({
          sessionId: value.sessionId,
          branchId: value.branchId,
          compositionId: value.compositionId,
          entityKind: block.kind,
          entityId: sourceIdentity.entityId,
          role: block.role,
        }),
      };
    }),
  }));

export interface InvalidContractCase {
  readonly reason:
    | 'unsupported_composition_version'
    | 'missing_composition_identity'
    | 'unsupported_block_version'
    | 'unsupported_block_kind'
    | 'missing_block_identity'
    | 'malformed_block_content';
  readonly value: unknown;
}

const oneBlockCompositionArbitrary = responseBlockV1Arbitrary.chain((block) =>
  responseCompositionV1Arbitrary.map((composition) => ({ ...composition, blocks: [block] })),
);

export const invalidResponseCompositionArbitrary: fc.Arbitrary<InvalidContractCase> = fc.oneof(
  oneBlockCompositionArbitrary.map((composition) => ({
    reason: 'unsupported_composition_version' as const,
    value: { ...composition, schemaVersion: 2 },
  })),
  oneBlockCompositionArbitrary.map((composition) => {
    const { compositionId: _removed, ...withoutIdentity } = composition;
    return { reason: 'missing_composition_identity' as const, value: withoutIdentity };
  }),
  oneBlockCompositionArbitrary.map((composition) => ({
    reason: 'unsupported_block_version' as const,
    value: {
      ...composition,
      blocks: [{ ...composition.blocks[0], schemaVersion: 2 }],
    },
  })),
  oneBlockCompositionArbitrary.map((composition) => ({
    reason: 'unsupported_block_kind' as const,
    value: {
      ...composition,
      blocks: [{ ...composition.blocks[0], kind: 'unsupported_response_kind' }],
    },
  })),
  oneBlockCompositionArbitrary.map((composition) => {
    const { stableKey: _removed, ...withoutStableKey } = composition.blocks[0];
    return {
      reason: 'missing_block_identity' as const,
      value: { ...composition, blocks: [withoutStableKey] },
    };
  }),
  oneBlockCompositionArbitrary.map((composition) => ({
    reason: 'malformed_block_content' as const,
    value: {
      ...composition,
      blocks: [{ ...composition.blocks[0], content: null }],
    },
  })),
);

export const duplicateStableKeyCompositionArbitrary: fc.Arbitrary<unknown> = oneBlockCompositionArbitrary.map(
  (composition) => ({
    ...composition,
    blocks: [composition.blocks[0], { ...composition.blocks[0] }],
  }),
);

export function renderIntentV1ArbitraryForKind(kind: ResponseIntentKind): fc.Arbitrary<RenderIntentV1> {
  switch (kind) {
    case 'generic':
      return fc.record({
        kind: fc.constant(kind),
        label: optional(boundedSummaryArbitrary),
        truncated: optional(fc.boolean()),
      });
    case 'read':
      return fc.record({
        kind: fc.constant(kind),
        filePath: boundedTextArbitrary,
        language: optional(boundedNonEmptyTextArbitrary),
        startLine: optional(revisionArbitrary),
        endLine: optional(revisionArbitrary),
      });
    case 'search':
      return fc.record({
        kind: fc.constant(kind),
        query: boundedTextArbitrary,
        resultCount: optional(revisionArbitrary),
      });
    case 'diff':
      return fc.record({
        kind: fc.constant(kind),
        filePath: boundedTextArbitrary,
        hunks: optional(revisionArbitrary),
        additions: optional(revisionArbitrary),
        deletions: optional(revisionArbitrary),
      });
    case 'terminal':
      return fc.record({
        kind: fc.constant(kind),
        command: optional(boundedTextArbitrary),
        exitCode: optional(fc.integer()),
      });
    case 'web':
      return fc.record({
        kind: fc.constant(kind),
        url: optional(fc.webUrl()),
        title: optional(boundedSummaryArbitrary),
        citation: optional(boundedIdentifierArbitrary),
      });
    case 'image':
      return fc.record({
        kind: fc.constant(kind),
        alt: optional(boundedSummaryArbitrary),
        width: optional(fc.integer({ min: 1, max: 8_192 })),
        height: optional(fc.integer({ min: 1, max: 8_192 })),
        mediaType: optional(boundedNonEmptyTextArbitrary),
      });
    case 'table':
      return fc.record({
        kind: fc.constant(kind),
        columns: optional(fc.integer({ min: 1, max: 100 })),
        rows: optional(revisionArbitrary),
        caption: optional(boundedSummaryArbitrary),
      });
    case 'tree':
      return fc.record({
        kind: fc.constant(kind),
        rootLabel: optional(boundedSummaryArbitrary),
        depth: optional(revisionArbitrary),
        nodeCount: optional(revisionArbitrary),
      });
    case 'artifact':
      return fc.record({
        kind: fc.constant(kind),
        artifactId: boundedIdentifierArbitrary,
        artifactType: optional(boundedNonEmptyTextArbitrary),
        title: optional(boundedSummaryArbitrary),
      });
  }
}

export const renderIntentV1Arbitrary: fc.Arbitrary<RenderIntentV1> = fc
  .constantFrom(...RENDER_INTENT_KINDS)
  .chain(renderIntentV1ArbitraryForKind);

export interface CompatibilityPair {
  readonly blockKind: ResponseBlockKind;
  readonly intent: RenderIntentV1;
  readonly contractVersion: number;
  readonly compatible: boolean;
}

const compatiblePairKinds = RESPONSE_BLOCK_KINDS.flatMap((blockKind) =>
  RESPONSE_COMPATIBILITY_MATRIX_V1[blockKind].map((intentKind) => ({ blockKind, intentKind })),
);
const incompatiblePairKinds = RESPONSE_BLOCK_KINDS.flatMap((blockKind) =>
  RENDER_INTENT_KINDS.filter((intentKind) => !RESPONSE_COMPATIBILITY_MATRIX_V1[blockKind].includes(intentKind)).map(
    (intentKind) => ({ blockKind, intentKind }),
  ),
);

export const compatibleResponsePairArbitrary: fc.Arbitrary<CompatibilityPair> = fc
  .constantFrom(...compatiblePairKinds)
  .chain(({ blockKind, intentKind }) =>
    renderIntentV1ArbitraryForKind(intentKind).map((intent) => ({
      blockKind,
      intent,
      contractVersion: 1,
      compatible: true,
    })),
  );

export const incompatibleResponsePairArbitrary: fc.Arbitrary<CompatibilityPair> = fc.oneof(
  fc.constantFrom(...incompatiblePairKinds).chain(({ blockKind, intentKind }) =>
    renderIntentV1ArbitraryForKind(intentKind).map((intent) => ({
      blockKind,
      intent,
      contractVersion: 1,
      compatible: false,
    })),
  ),
  fc
    .tuple(responseBlockKindArbitrary, renderIntentV1Arbitrary, unsupportedResponseContractVersionArbitrary)
    .map(([blockKind, intent, contractVersion]) => ({
      blockKind,
      intent,
      contractVersion,
      compatible: false,
    })),
);

export const compatibilityPairArbitrary: fc.Arbitrary<CompatibilityPair> = fc.oneof(
  compatibleResponsePairArbitrary,
  incompatibleResponsePairArbitrary,
);

export const operationalBoundsV1Arbitrary: fc.Arbitrary<OperationalBoundsV1> = fc.record({
  schemaVersion: fc.constant(1 as const),
  database: fc.record({
    busyTimeoutMs: fc.integer({ min: 1, max: 60_000 }),
    walCheckpointThresholdPages: fc.integer({ min: 1, max: 100_000 }),
  }),
  transactions: fc.record({
    maxDurationMs: fc.integer({ min: 1, max: 30_000 }),
    maxStatements: fc.integer({ min: 1, max: 10_000 }),
  }),
  outbox: fc.record({
    batchSize: fc.integer({ min: 1, max: 10_000 }),
    pollIntervalMs: fc.integer({ min: 1, max: 60_000 }),
  }),
  projections: fc.record({ checkpointFrequency: fc.integer({ min: 1, max: 100_000 }) }),
  renderer: fc.record({
    mountLimit: fc.integer({ min: 1, max: 10_000 }),
    updateRateMs: fc.integer({ min: 1, max: 5_000 }),
    readableWidthDip: fc.integer({ min: 200, max: 2000 }),
    minimumMainColumnWidthDip: fc.integer({ min: 200, max: 1200 }),
    mountedNodeBound: fc.integer({ min: 10, max: 5000 }),
    overscanNodeCount: fc.integer({ min: 1, max: 100 }),
    focusRetentionAllowance: fc.integer({ min: 1, max: 100 }),
    pageSize: fc.integer({ min: 5, max: 200 }),
    streamCoalesceMs: fc.integer({ min: 10, max: 5000 }),
    markdownCollapseChars: fc.integer({ min: 100, max: 100_000 }),
    codeMaxHeightDip: fc.integer({ min: 100, max: 5000 }),
    previewMaxChars: fc.integer({ min: 100, max: 100_000 }),
    tableInitialRows: fc.integer({ min: 1, max: 1000 }),
    inspectorMaxWidthDip: fc.integer({ min: 100, max: 2000 }),
    viewportMarginDip: fc.integer({ min: 1, max: 500 }),
    layoutStabilizationTimeoutMs: fc.integer({ min: 10, max: 5000 }),
  }),
  previews: fc.record({ sizeLimitBytes: fc.integer({ min: 1, max: 104_857_600 }) }),
  retries: fc.record({
    maxAttempts: fc.integer({ min: 1, max: 100 }),
    maxBackoffMs: fc.integer({ min: 1, max: 300_000 }),
    initialDelayMs: fc.integer({ min: 1, max: 60_000 }),
  }),
  concurrency: fc.record({ parallelToolLimit: fc.integer({ min: 1, max: 1_000 }) }),
  loops: fc.record({
    consecutiveCallThreshold: fc.integer({ min: 1, max: 1_000 }),
    graceCount: fc.integer({ min: 1, max: 100 }),
  }),
  orchestration: fc.record({
    subagentLimit: fc.integer({ min: 1, max: 1_000 }),
    budgetTokens: fc.integer({ min: 1, max: 10_000_000 }),
  }),
  sandbox: fc.record({
    timeoutMs: fc.integer({ min: 1, max: 600_000 }),
    memoryLimitBytes: fc.integer({ min: 1, max: 4_294_967_296 }),
  }),
  attachment: fc.record({
    sizeLimitBytes: fc.integer({ min: 1, max: 1_073_741_824 }),
    countLimit: fc.integer({ min: 1, max: 10_000 }),
  }),
  accessibilityAnnouncement: fc.record({ coalesceIntervalMs: fc.integer({ min: 1_000, max: 30_000 }) }),
  measurementFixture: fc.record({
    budgetMs: fc.integer({ min: 1, max: 60_000 }),
    budgetBytes: fc.integer({ min: 1, max: 1_073_741_824 }),
  }),
});

export const invalidOperationalBoundsV1Arbitrary: fc.Arbitrary<unknown> = operationalBoundsV1Arbitrary.chain((bounds) =>
  fc.oneof(
    fc.constant({ ...bounds, schemaVersion: 2 }),
    fc.constant({ ...bounds, renderer: { ...bounds.renderer, mountLimit: 0 } }),
  ),
);

const actorRefArbitrary = fc.record({
  kind: fc.constantFrom('user' as const, 'system' as const, 'agent' as const, 'service' as const),
  id: boundedIdentifierArbitrary,
  displayName: optional(boundedSummaryArbitrary),
  schemaVersion: fc.constant(1 as const),
});

const scopeDescriptorArbitrary = fc.record({
  userId: optional(boundedIdentifierArbitrary),
  workspaceId: optional(boundedIdentifierArbitrary),
  projectId: optional(boundedIdentifierArbitrary),
  sessionId: optional(boundedIdentifierArbitrary),
  agentId: optional(boundedIdentifierArbitrary),
  ownerId: optional(boundedIdentifierArbitrary),
  schemaVersion: fc.constant(1 as const),
});

export const commandV1Arbitrary: fc.Arbitrary<CommandV1> = fc.record({
  commandId: boundedIdentifierArbitrary,
  commandType: boundedIdentifierArbitrary,
  actor: actorRefArbitrary,
  scope: scopeDescriptorArbitrary,
  idempotencyKey: fc.record({
    key: boundedIdentifierArbitrary,
    producer: boundedIdentifierArbitrary,
    createdAt: timestampArbitrary,
    schemaVersion: fc.constant(1 as const),
  }),
  expectedRevision: optional(revisionArbitrary),
  sourceProjectionRevision: optional(revisionArbitrary),
  authorityTarget: boundedIdentifierArbitrary,
  payload: fc.dictionary(
    boundedIdentifierArbitrary,
    fc.oneof(boundedTextArbitrary, fc.integer(), fc.boolean(), fc.constant(null)),
    { maxKeys: 4 },
  ),
  issuedAt: timestampArbitrary,
  schemaVersion: fc.constant(1 as const),
});

export const invalidCommandV1Arbitrary: fc.Arbitrary<unknown> = commandV1Arbitrary.chain((command) =>
  fc.oneof(
    fc.constant({ ...command, schemaVersion: 2 }),
    fc.constant({ ...command, commandId: '' }),
    fc.constant({ ...command, authorityTarget: '' }),
  ),
);

const authorityRefV1Arbitrary = responseAuthorityRefArbitrary;

export const actionDescriptorV1Arbitrary: fc.Arbitrary<ActionDescriptorV1> = fc
  .tuple(authorityRefV1Arbitrary, optional(revisionArbitrary))
  .chain(([owner, expectedSourceRevision]) =>
    fc.record({
      schemaVersion: fc.constant(1 as const),
      actionId: boundedIdentifierArbitrary,
      kind: fc.constantFrom(
        'insert_prompt' as const,
        'submit_prompt' as const,
        'navigate' as const,
        'authority_command' as const,
      ),
      label: authorizedTextArbitrary,
      owner: fc.constant(owner),
      expectedProjectionRevision: revisionArbitrary,
      expectedSourceRevision: fc.constant(expectedSourceRevision),
      target: optional(
        fc.record({
          schemaVersion: fc.constant(1 as const),
          locatorId: boundedIdentifierArbitrary,
          kind: fc.constantFrom(
            'tool' as const,
            'source' as const,
            'diff' as const,
            'data' as const,
            'trajectory' as const,
            'insight' as const,
            'attachment' as const,
            'provenance' as const,
          ),
          authority: fc.constant(owner),
          sourceRevision:
            expectedSourceRevision === undefined ? revisionArbitrary : fc.constant(expectedSourceRevision),
        }),
      ),
      idempotencyKey: optional(boundedIdentifierArbitrary),
      disabledReason: optional(authorizedTextArbitrary),
      risk: optional(
        fc.constantFrom(
          'none' as const,
          'low' as const,
          'medium' as const,
          'high' as const,
          'critical' as const,
          'unknown' as const,
        ),
      ),
      scopeDigest: optional(sha256DigestArbitrary),
    }),
  )
  .map((action) => ActionDescriptorV1Schema.parse(action));

export const invalidActionDescriptorV1Arbitrary: fc.Arbitrary<unknown> = actionDescriptorV1Arbitrary.chain((action) =>
  fc.oneof(
    fc.constant({ ...action, schemaVersion: 2 }),
    fc.constant({ ...action, actionId: '' }),
    fc.constant({ ...action, label: 'javascript:alert(1)' }),
    fc.constant({ ...action, command: 'rm -rf /' }),
  ),
);

const legalTransitionPairs = TURN_ACTIVITY_STATES.flatMap((priorState) =>
  [...LEGAL_TRANSITIONS[priorState]].map((newState) => ({ priorState, newState })),
);
const illegalTransitionPairs = TURN_ACTIVITY_STATES.flatMap((priorState) =>
  TURN_ACTIVITY_STATES.filter((newState) => !LEGAL_TRANSITIONS[priorState].has(newState)).map((newState) => ({
    priorState,
    newState,
  })),
);

export const legalLifecycleTransitionArbitrary = fc.constantFrom(...legalTransitionPairs);
export const invalidLifecycleTransitionArbitrary = fc.constantFrom(...illegalTransitionPairs);

export const lifecycleTransitionRecordArbitrary: fc.Arbitrary<TurnTransitionRecord> =
  legalLifecycleTransitionArbitrary.chain(({ priorState, newState }) =>
    fc.record({
      transitionId: boundedIdentifierArbitrary,
      turnId: boundedIdentifierArbitrary,
      stepId: optional(boundedIdentifierArbitrary),
      priorState: fc.constant(priorState),
      newState: fc.constant(newState),
      cause: fc.constantFrom(
        'provider_event' as const,
        'tool_event' as const,
        'user_action' as const,
        'system_policy' as const,
        'cancellation_request' as const,
        'cancellation_convergence' as const,
        'connection_event' as const,
        'retry_decision' as const,
        'plugin_failure' as const,
        'budget_exhausted' as const,
        'assembly_complete' as const,
        'reconnection_success' as const,
        'teardown_complete' as const,
      ),
      causeEventId: optional(boundedIdentifierArbitrary),
      owner: boundedIdentifierArbitrary,
      attempt: fc.nat({ max: 32 }),
      timestamp: timestampArbitrary,
      schemaVersion: fc.constant(1 as const),
    }),
  );

export const invalidLifecycleTransitionRecordArbitrary: fc.Arbitrary<TurnTransitionRecord> =
  invalidLifecycleTransitionArbitrary.chain(({ priorState, newState }) =>
    lifecycleTransitionRecordArbitrary.map((record) => ({ ...record, priorState, newState })),
  );

export const generatorBounds = Object.freeze({
  maxGeneratedTextLength: 256,
  maxGeneratedSummaryLength: 160,
  maxGeneratedBlocks: 15,
  maxGeneratedNestedItems: 4,
  productionMaxTextLength: MAX_PRESENTATION_TEXT_LENGTH,
});
