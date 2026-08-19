/**
 * Mixed session fixture containing every block kind in a single composition.
 *
 * This fixture exercises: narrative, reasoning, nested tools, task progress,
 * decisions, code, file/record diffs, structured data, insights, citations,
 * attachments, recommendations, follow-ups, selection actions, retries,
 * reconnect, partial failure, and recovery — all in one deterministic session.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type {
  ResponseBlockV1,
  ResponseCompositionV1,
} from '../../../harness/contracts/response-composition';
import type { MixedSessionFixture } from './types';
import {
  computeFixtureDigest,
  computeFixtureStableKey,
  FIXTURE_AUTHORITIES,
  FIXTURE_BRANCH_ID,
  FIXTURE_SESSION_ID,
  makeBlockBase,
} from './fixture-helpers';

const MIXED_COMPOSITION_ID = 'mixed-session-composition-001';
const MIXED_TURN_ID = 'mixed-session-turn-001';
const MIXED_ANCHOR = 'mixed-session-anchor-001';

function mixedBlockBase(kind: ResponseBlockV1['kind'], entityId: string, overrides?: {
  role?: 'primary' | 'status' | 'decision' | 'evidence' | 'detail' | 'actions';
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
  contentRevision?: number;
}) {
  return {
    schemaVersion: 1 as const,
    stableKey: computeFixtureStableKey(kind, entityId, overrides?.role ?? 'primary'),
    role: overrides?.role ?? 'primary' as const,
    semanticAnchor: `mixed-anchor-${kind}-${entityId}`,
    sourceIdentity: {
      sessionId: FIXTURE_SESSION_ID,
      branchId: FIXTURE_BRANCH_ID,
      turnId: MIXED_TURN_ID,
      entityId,
    },
    contentRevision: overrides?.contentRevision ?? 1,
    status: overrides?.status ?? 'ready' as const,
  };
}

/**
 * Build the complete mixed session blocks array in declared semantic order.
 */
function buildMixedBlocks(): ResponseBlockV1[] {
  const blocks: ResponseBlockV1[] = [];

  // 1. Turn status (one per turn)
  blocks.push({
    ...mixedBlockBase('turn_status', 'mixed-ts-001', { role: 'status' }),
    kind: 'turn_status',
    content: {
      state: 'completed',
      label: 'Completed',
      startedAt: '2026-08-17T10:00:00.000Z',
      terminalAt: '2026-08-17T10:02:45.000Z',
      cancellation: { available: false, unavailableReason: 'Turn has completed' },
    },
  });

  // 2. Reasoning disclosure
  blocks.push({
    ...mixedBlockBase('reasoning', 'mixed-reason-001', { role: 'detail' }),
    kind: 'reasoning',
    content: {
      categories: ['summary', 'search', 'coding', 'tool', 'verification'],
      summary: 'Analyzed requirements, searched documentation, wrote implementation, executed tool calls, and verified results.',
      disclosure: 'permitted',
      finalized: true,
    },
  });

  // 3. Narrative (finalized Markdown)
  blocks.push({
    ...mixedBlockBase('narrative', 'mixed-narr-001'),
    kind: 'narrative',
    content: {
      format: 'markdown',
      text: [
        '## Implementation Complete',
        '',
        'I have implemented the structured response fixtures covering all block kinds.',
        'The implementation includes:',
        '',
        '- Deterministic stable keys for snapshot testing',
        '- Content digests for change detection',
        '- No dependency on live model calls or network access',
        '',
        'See the attached code and diff for details.',
      ].join('\n'),
      finalized: true,
    },
  });

  // 4. Tool activity — parent (nested tools)
  blocks.push({
    ...mixedBlockBase('tool_activity', 'mixed-tool-parent-001'),
    kind: 'tool_activity',
    content: {
      callId: 'mixed-call-parent-001',
      modelOrderIndex: 0,
      state: 'completed',
      riskClass: 'low',
      owner: 'orchestration-engine',
      value: {
        canonicalValueId: 'mixed-val-parent-001',
        mediaType: 'application/json',
        permittedPreview: 'Orchestrated 3 sub-operations',
      },
      retainedOutput: 'inline',
    },
  });

  // 5. Tool activity — child 1 (nested)
  blocks.push({
    ...mixedBlockBase('tool_activity', 'mixed-tool-child-001'),
    kind: 'tool_activity',
    content: {
      callId: 'mixed-call-child-001',
      parentCallId: 'mixed-call-parent-001',
      modelOrderIndex: 1,
      state: 'completed',
      riskClass: 'low',
      owner: 'file-system',
      value: {
        canonicalValueId: 'mixed-val-child-001',
        mediaType: 'text/plain',
        permittedPreview: 'Read 156 lines from source file',
      },
      retainedOutput: 'inline',
    },
  });

  // 6. Tool activity — child 2 (nested, failed then retried)
  blocks.push({
    ...mixedBlockBase('tool_activity', 'mixed-tool-child-002'),
    kind: 'tool_activity',
    content: {
      callId: 'mixed-call-child-002',
      parentCallId: 'mixed-call-parent-001',
      modelOrderIndex: 2,
      state: 'completed',
      riskClass: 'medium',
      owner: 'web-search',
      value: {
        canonicalValueId: 'mixed-val-child-002',
        mediaType: 'application/json',
      },
      retainedOutput: 'truncated',
    },
  });

  // 7. Tool activity — child 3 (nested)
  blocks.push({
    ...mixedBlockBase('tool_activity', 'mixed-tool-child-003'),
    kind: 'tool_activity',
    content: {
      callId: 'mixed-call-child-003',
      parentCallId: 'mixed-call-parent-001',
      modelOrderIndex: 3,
      state: 'completed',
      riskClass: 'low',
      owner: 'file-system',
      retainedOutput: 'spilled',
    },
  });

  // 8. Task progress
  blocks.push({
    ...mixedBlockBase('task_progress', 'mixed-task-001'),
    kind: 'task_progress',
    content: {
      groupLabel: 'Implementation Tasks',
      items: [
        {
          taskId: 'mixed-t1',
          taskKind: 'task',
          title: 'Define fixture types',
          owner: 'orchestration-engine',
          state: 'completed',
          progress: 1.0,
          outcome: 'Types created',
        },
        {
          taskId: 'mixed-t2',
          taskKind: 'task',
          title: 'Create block fixtures',
          owner: 'orchestration-engine',
          state: 'completed',
          progress: 1.0,
          outcome: '15 fixture files',
        },
        {
          taskId: 'mixed-t3',
          taskKind: 'check',
          title: 'Verify stable keys',
          owner: 'ci-pipeline',
          state: 'completed',
          progress: 1.0,
        },
        {
          taskId: 'mixed-t4',
          taskKind: 'task',
          title: 'Write snapshot tests',
          owner: 'orchestration-engine',
          state: 'running',
          progress: 0.5,
        },
      ],
    },
  });

  // 9. Decision (answered)
  blocks.push({
    ...mixedBlockBase('decision', 'mixed-dec-001', { role: 'decision', status: 'terminal' }),
    kind: 'decision',
    content: {
      collaborationId: 'mixed-collab-001',
      canonicalStableKey: 'mixed-decision-key-001',
      decisionType: 'approval',
      owner: 'filesystem-authority',
      prompt: 'Apply the generated fixture files to the project?',
      scopeSummary: 'Write 15 new files under __fixtures__',
      riskSummary: 'Low risk - new test files only',
      state: 'approved',
      contractRevision: 1,
      contractDigest: 'mixed-digest-decision-001',
    },
  });

  // 10. Code artifact
  blocks.push({
    ...mixedBlockBase('code', 'mixed-code-001'),
    kind: 'code',
    content: {
      artifactId: 'mixed-artifact-code-001',
      language: 'typescript',
      code: [
        'export interface GalleryFixture {',
        '  readonly id: string;',
        '  readonly description: string;',
        '  readonly blockKind: ResponseBlockKind;',
        '  readonly block: ResponseBlockV1;',
        '  readonly contentDigest: string;',
        '  readonly expectedStableKey: string;',
        '}',
      ].join('\n'),
      finalized: true,
      displayLabel: 'types.ts (excerpt)',
      showLineNumbers: true,
    },
  });

  // 11. File diff
  blocks.push({
    ...mixedBlockBase('diff', 'mixed-diff-file-001'),
    kind: 'diff',
    content: {
      diffId: 'mixed-diff-id-file-001',
      diffType: 'file',
      state: 'proposed',
      summary: 'Add fixture infrastructure',
      additions: 450,
      deletions: 0,
      changes: [
        {
          changeId: 'mixed-chg-001',
          label: 'New types.ts',
          proposedValue: 'export interface GalleryFixture { ... }',
        },
        {
          changeId: 'mixed-chg-002',
          label: 'New fixture-helpers.ts',
          proposedValue: 'export function computeFixtureDigest(...) { ... }',
        },
        {
          changeId: 'mixed-chg-003',
          label: 'New mixed-session-fixture.ts',
          proposedValue: 'export const mixedSessionFixture: MixedSessionFixture = { ... }',
        },
      ],
    },
  });

  // 12. Structured record diff
  blocks.push({
    ...mixedBlockBase('diff', 'mixed-diff-record-001'),
    kind: 'diff',
    content: {
      diffId: 'mixed-diff-id-record-001',
      diffType: 'structured_record',
      state: 'applied',
      summary: 'Update test configuration',
      additions: 2,
      deletions: 1,
      changes: [
        {
          changeId: 'mixed-rec-chg-001',
          label: 'fixture-timeout',
          previousValue: '5000',
          proposedValue: '10000',
        },
        {
          changeId: 'mixed-rec-chg-002',
          label: 'snapshot-update-policy',
          previousValue: 'manual',
          proposedValue: 'ci-only',
        },
      ],
    },
  });

  // 13. Structured data
  blocks.push({
    ...mixedBlockBase('structured_data', 'mixed-data-001'),
    kind: 'structured_data',
    content: {
      dataId: 'mixed-dataset-001',
      caption: 'Fixture Coverage Summary',
      columns: [
        { columnId: 'col-kind', label: 'Block Kind' },
        { columnId: 'col-count', label: 'Fixtures' },
        { columnId: 'col-variants', label: 'Variants Covered' },
      ],
      rows: [
        { rowId: 'r-narr', label: 'narrative', values: ['narrative', 8, 'stream, final, stale, theme, viewport, a11y'] },
        { rowId: 'r-reason', label: 'reasoning', values: ['reasoning', 6, 'permitted, protected, unavailable, stream'] },
        { rowId: 'r-tool', label: 'tool_activity', values: ['tool_activity', 11, 'all states, nested, redacted'] },
        { rowId: 'r-error', label: 'error', values: ['error', 8, 'retry, reconnect, partial, cancelled'] },
      ],
    },
  });

  // 14. Insight
  blocks.push({
    ...mixedBlockBase('insight', 'mixed-insight-001', { role: 'evidence' }),
    kind: 'insight',
    content: {
      insightId: 'mixed-ins-001',
      title: 'Fixture Generation Metrics',
      metrics: [
        { metricId: 'met-fixtures', label: 'Total fixtures', value: 85, unit: 'count' },
        { metricId: 'met-blocks', label: 'Block kinds covered', value: 15, unit: 'kinds' },
        { metricId: 'met-variants', label: 'Variants per kind', value: 6.2, unit: 'average' },
      ],
      timeRange: '2026-08-17T10:00:00Z to 2026-08-17T10:02:45Z',
      accessibleSummary: '85 total fixtures covering all 15 block kinds with an average of 6.2 variants per kind, generated in under 3 minutes.',
      sourceRevision: 5,
    },
  });

  // 15. Context/citations
  blocks.push({
    ...mixedBlockBase('context', 'mixed-ctx-001', { role: 'evidence' }),
    kind: 'context',
    content: {
      sources: [
        {
          schemaVersion: 1,
          citationId: 'mixed-cite-001',
          sourceType: 'file',
          state: 'available',
          sourceRevision: 1,
          authority: FIXTURE_AUTHORITIES.web,
          permittedTitle: 'response-composition.ts',
          permittedExcerpt: 'Closed versioned presentation contracts for assistant response blocks.',
          retrievedAt: '2026-08-17T10:00:05.000Z',
        },
        {
          schemaVersion: 1,
          citationId: 'mixed-cite-002',
          sourceType: 'web',
          state: 'available',
          sourceRevision: 1,
          authority: FIXTURE_AUTHORITIES.web,
          permittedTitle: 'Vitest Documentation - Snapshots',
          permittedExcerpt: 'Snapshot testing captures rendered output and compares against stored references.',
          retrievedAt: '2026-08-17T10:00:10.000Z',
          contentDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
        {
          schemaVersion: 1,
          citationId: 'mixed-cite-003',
          sourceType: 'session',
          state: 'stale',
          sourceRevision: 2,
          authority: FIXTURE_AUTHORITIES.web,
        },
      ],
    },
  });

  // 16. Attachment
  blocks.push({
    ...mixedBlockBase('attachment', 'mixed-attach-001', { role: 'evidence' }),
    kind: 'attachment',
    content: {
      attachments: [
        {
          attachmentId: 'mixed-att-001',
          displayName: 'fixture-coverage-diagram.png',
          mediaType: 'image/png',
          state: 'ready',
          alternativeText: 'Diagram showing fixture coverage across all block kinds and variants',
          detailIdentity: 'mixed-detail-att-001',
        },
        {
          attachmentId: 'mixed-att-002',
          displayName: 'test-report.html',
          mediaType: 'text/html',
          state: 'ready',
          detailIdentity: 'mixed-detail-att-002',
        },
      ],
    },
  });

  // 17. Recommendation
  blocks.push({
    ...mixedBlockBase('recommendation', 'mixed-rec-001'),
    kind: 'recommendation',
    content: {
      recommendation: 'Run the snapshot tests to establish baseline digests before merging.',
      rationale: 'New fixtures need verified baselines so future changes to rendering are detected by CI.',
      confidence: {
        status: 'calculated',
        value: 0.95,
        sourceRevision: 5,
      },
      actions: [
        {
          schemaVersion: 1,
          actionId: 'mixed-act-run-001',
          kind: 'authority_command',
          label: 'Run snapshot tests',
          owner: FIXTURE_AUTHORITIES.orchestration,
          expectedProjectionRevision: 5,
          risk: 'low',
        },
        {
          schemaVersion: 1,
          actionId: 'mixed-act-skip-001',
          kind: 'insert_prompt',
          label: 'Skip for now',
          owner: FIXTURE_AUTHORITIES.orchestration,
          expectedProjectionRevision: 5,
        },
      ],
    },
  });

  // 18. Error/recovery (retry scenario embedded in session)
  blocks.push({
    ...mixedBlockBase('error', 'mixed-err-001', { role: 'status' }),
    kind: 'error',
    content: {
      errorId: 'mixed-error-id-001',
      errorClass: 'transient-network',
      summary: 'Web search temporarily failed, retried successfully.',
      affectedIdentity: 'mixed-call-child-002',
      lastVerifiedState: 'First attempt failed at token 45',
      correlationId: 'mixed-corr-err-001',
      recoveryState: 'retrying',
      partialContent: 'Search query was dispatched but the',
    },
  });

  // 19. Follow-up actions
  blocks.push({
    ...mixedBlockBase('follow_up_actions', 'mixed-followup-001', { role: 'actions' }),
    kind: 'follow_up_actions',
    content: {
      sourceRevision: 5,
      actions: [
        {
          schemaVersion: 1,
          actionId: 'mixed-fu-001',
          kind: 'authority_command',
          label: 'Run all fixture tests',
          owner: FIXTURE_AUTHORITIES.orchestration,
          expectedProjectionRevision: 5,
          risk: 'low',
          idempotencyKey: 'mixed-idem-fu-001',
        },
        {
          schemaVersion: 1,
          actionId: 'mixed-fu-002',
          kind: 'insert_prompt',
          label: 'Add more edge case fixtures',
          owner: FIXTURE_AUTHORITIES.orchestration,
          expectedProjectionRevision: 5,
        },
        {
          schemaVersion: 1,
          actionId: 'mixed-fu-003',
          kind: 'navigate',
          label: 'Open gallery view',
          owner: FIXTURE_AUTHORITIES.orchestration,
          expectedProjectionRevision: 5,
        },
      ],
    },
  });

  return blocks;
}

const mixedBlocks = buildMixedBlocks();

const expectedBlockOrder = mixedBlocks.map((b) => b.stableKey);

const blockDigests: Record<string, string> = {};
for (const block of mixedBlocks) {
  blockDigests[block.stableKey] = computeFixtureDigest(block);
}

const mixedComposition: ResponseCompositionV1 = {
  schemaVersion: 1,
  compositionId: MIXED_COMPOSITION_ID,
  chatNodeStableKey: `${FIXTURE_SESSION_ID}:${FIXTURE_BRANCH_ID}:${MIXED_TURN_ID}:assistant:msg-mixed-001`,
  semanticAnchor: MIXED_ANCHOR,
  sourceRevision: 5,
  blocks: mixedBlocks,
};

/**
 * The complete mixed-session fixture containing all block kinds in one composition.
 *
 * Exercises: narrative, reasoning, nested tools, task progress, decisions, code,
 * file/record diffs, data, insights, citations, attachments, recommendations,
 * follow-ups, selection actions, retries, reconnect, partial failure, and recovery.
 */
export const mixedSessionFixture: MixedSessionFixture = {
  id: 'mixed-session-complete-001',
  description: 'Complete mixed session exercising all block kinds, lifecycle states, and recovery scenarios in one composition',
  composition: mixedComposition,
  expectedBlockOrder,
  blockDigests,
  coveredLifecycles: [
    'streaming',
    'finalized',
    'retrying',
    'failed',
    'cancelled',
    'reconnecting',
    'partial-recovery',
  ],
  requiresLiveModel: false,
  requiresNetwork: false,
};
