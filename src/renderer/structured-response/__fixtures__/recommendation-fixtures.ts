/**
 * Deterministic recommendation block fixtures.
 *
 * Covers all confidence statuses, action types,
 * and disabled/unavailable states.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { RecommendationBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type ConfidenceStatus = 'reported' | 'calculated' | 'estimated' | 'partial' | 'unavailable';

function recommendationBlock(params: {
  entityId: string;
  recommendation: string;
  rationale?: string;
  confidenceStatus: ConfidenceStatus;
  confidenceValue?: number;
  sourceRevision: number;
  actions: Array<{
    actionId: string;
    kind: 'insert_prompt' | 'submit_prompt' | 'navigate' | 'authority_command';
    label: string;
    disabledReason?: string;
  }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): RecommendationBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'recommendation',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'recommendation',
    content: {
      recommendation: params.recommendation,
      ...(params.rationale !== undefined && { rationale: params.rationale }),
      confidence: {
        status: params.confidenceStatus,
        ...(params.confidenceValue !== undefined && { value: params.confidenceValue }),
        sourceRevision: params.sourceRevision,
      },
      actions: params.actions.map((a) => ({
        schemaVersion: 1 as const,
        actionId: a.actionId,
        kind: a.kind,
        label: a.label,
        owner: FIXTURE_AUTHORITIES.orchestration,
        expectedProjectionRevision: params.sourceRevision,
        ...(a.disabledReason !== undefined && { disabledReason: a.disabledReason }),
      })),
    },
  };
}

export const recommendationFixtures: GalleryFixtureSet = {
  kind: 'recommendation',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'recommendation-reported-confidence',
      description: 'Recommendation with reported confidence and actions',
      block: recommendationBlock({
        entityId: 'rec-reported-001',
        recommendation: 'Consider extracting this logic into a shared utility module.',
        rationale: 'The pattern appears in 4 files and would benefit from centralized maintenance.',
        confidenceStatus: 'reported',
        confidenceValue: 0.85,
        sourceRevision: 5,
        actions: [
          { actionId: 'act-apply-001', kind: 'insert_prompt', label: 'Apply refactoring' },
          { actionId: 'act-skip-001', kind: 'insert_prompt', label: 'Skip for now' },
        ],
      }),
    }),
    makeFixture({
      id: 'recommendation-calculated-confidence',
      description: 'Recommendation with calculated confidence',
      block: recommendationBlock({
        entityId: 'rec-calc-001',
        recommendation: 'Add input validation to the API handler.',
        rationale: 'Static analysis detected unvalidated user input reaching the database layer.',
        confidenceStatus: 'calculated',
        confidenceValue: 0.92,
        sourceRevision: 3,
        actions: [
          { actionId: 'act-fix-001', kind: 'authority_command', label: 'Add validation' },
        ],
      }),
    }),
    makeFixture({
      id: 'recommendation-estimated-confidence',
      description: 'Recommendation with estimated confidence',
      block: recommendationBlock({
        entityId: 'rec-est-001',
        recommendation: 'Upgrade the testing framework to the latest major version.',
        confidenceStatus: 'estimated',
        confidenceValue: 0.6,
        sourceRevision: 7,
        actions: [
          { actionId: 'act-upgrade-001', kind: 'insert_prompt', label: 'Plan upgrade' },
          { actionId: 'act-docs-001', kind: 'navigate', label: 'View changelog' },
        ],
      }),
    }),
    makeFixture({
      id: 'recommendation-partial-confidence',
      description: 'Recommendation with partial confidence data',
      block: recommendationBlock({
        entityId: 'rec-partial-001',
        recommendation: 'Review memory usage patterns in the event loop.',
        confidenceStatus: 'partial',
        sourceRevision: 2,
        actions: [
          { actionId: 'act-profile-001', kind: 'authority_command', label: 'Run profiler' },
        ],
      }),
    }),
    makeFixture({
      id: 'recommendation-unavailable-confidence',
      description: 'Recommendation with unavailable confidence',
      block: recommendationBlock({
        entityId: 'rec-unavail-001',
        recommendation: 'Consider adding error boundaries around third-party components.',
        confidenceStatus: 'unavailable',
        sourceRevision: 1,
        actions: [
          { actionId: 'act-boundary-001', kind: 'insert_prompt', label: 'Add boundaries' },
          {
            actionId: 'act-later-001',
            kind: 'insert_prompt',
            label: 'Defer to next sprint',
            disabledReason: 'Sprint planning not yet available',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'recommendation-stale',
      description: 'Recommendation that has become stale',
      authorityState: 'expired',
      block: recommendationBlock({
        entityId: 'rec-stale-001',
        recommendation: 'Apply formatting fixes from the linter.',
        confidenceStatus: 'reported',
        confidenceValue: 1.0,
        sourceRevision: 1,
        actions: [
          { actionId: 'act-format-001', kind: 'authority_command', label: 'Auto-format' },
        ],
        status: 'stale',
      }),
    }),
  ],
};
