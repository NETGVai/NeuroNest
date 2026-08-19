/**
 * Deterministic follow-up actions block fixtures.
 *
 * Covers all action kinds, disabled states, and
 * valid action count variants (2-4).
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { FollowUpActionsBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function followUpBlock(params: {
  entityId: string;
  sourceRevision: number;
  actions: Array<{
    actionId: string;
    kind: 'insert_prompt' | 'submit_prompt' | 'navigate' | 'authority_command';
    label: string;
    disabledReason?: string;
    risk?: 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
    idempotencyKey?: string;
  }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): FollowUpActionsBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'follow_up_actions',
      entityId: params.entityId,
      role: 'actions',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'follow_up_actions',
    content: {
      sourceRevision: params.sourceRevision,
      actions: params.actions.map((a) => ({
        schemaVersion: 1 as const,
        actionId: a.actionId,
        kind: a.kind,
        label: a.label,
        owner: FIXTURE_AUTHORITIES.orchestration,
        expectedProjectionRevision: params.sourceRevision,
        ...(a.disabledReason !== undefined && { disabledReason: a.disabledReason }),
        ...(a.risk !== undefined && { risk: a.risk }),
        ...(a.idempotencyKey !== undefined && { idempotencyKey: a.idempotencyKey }),
      })),
    },
  };
}

export const followUpActionsFixtures: GalleryFixtureSet = {
  kind: 'follow_up_actions',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'followup-two-prompt-insertions',
      description: 'Two follow-up actions that insert prompts',
      block: followUpBlock({
        entityId: 'followup-two-001',
        sourceRevision: 5,
        actions: [
          { actionId: 'act-explain-001', kind: 'insert_prompt', label: 'Explain in more detail' },
          { actionId: 'act-example-001', kind: 'insert_prompt', label: 'Show an example' },
        ],
      }),
    }),
    makeFixture({
      id: 'followup-three-mixed-kinds',
      description: 'Three follow-up actions with mixed kinds',
      block: followUpBlock({
        entityId: 'followup-three-001',
        sourceRevision: 8,
        actions: [
          { actionId: 'act-apply-001', kind: 'authority_command', label: 'Apply all changes', risk: 'medium', idempotencyKey: 'idem-apply-001' },
          { actionId: 'act-review-001', kind: 'navigate', label: 'Review diff' },
          { actionId: 'act-alt-001', kind: 'insert_prompt', label: 'Try alternative approach' },
        ],
      }),
    }),
    makeFixture({
      id: 'followup-four-actions-max',
      description: 'Maximum four follow-up actions',
      block: followUpBlock({
        entityId: 'followup-four-001',
        sourceRevision: 3,
        actions: [
          { actionId: 'act-continue-001', kind: 'insert_prompt', label: 'Continue implementation' },
          { actionId: 'act-test-001', kind: 'authority_command', label: 'Run tests', risk: 'low' },
          { actionId: 'act-docs-001', kind: 'navigate', label: 'View documentation' },
          { actionId: 'act-branch-001', kind: 'submit_prompt', label: 'Start new branch' },
        ],
      }),
    }),
    makeFixture({
      id: 'followup-with-disabled',
      description: 'Follow-up actions with some disabled',
      block: followUpBlock({
        entityId: 'followup-disabled-001',
        sourceRevision: 6,
        actions: [
          { actionId: 'act-deploy-001', kind: 'authority_command', label: 'Deploy to staging', disabledReason: 'Tests must pass before deployment', risk: 'high' },
          { actionId: 'act-fix-001', kind: 'insert_prompt', label: 'Fix failing tests' },
          { actionId: 'act-skip-001', kind: 'insert_prompt', label: 'Skip deployment' },
        ],
      }),
    }),
    makeFixture({
      id: 'followup-stale',
      description: 'Follow-up actions that have become stale',
      authorityState: 'expired',
      block: followUpBlock({
        entityId: 'followup-stale-001',
        sourceRevision: 2,
        actions: [
          { actionId: 'act-old-001', kind: 'insert_prompt', label: 'Outdated suggestion' },
          { actionId: 'act-old-002', kind: 'insert_prompt', label: 'Another outdated option' },
        ],
        status: 'stale',
      }),
    }),
    makeFixture({
      id: 'followup-high-risk-command',
      description: 'Follow-up with high-risk authority command requiring confirmation',
      block: followUpBlock({
        entityId: 'followup-risk-001',
        sourceRevision: 10,
        actions: [
          { actionId: 'act-delete-001', kind: 'authority_command', label: 'Delete branch', risk: 'high', idempotencyKey: 'idem-delete-001' },
          { actionId: 'act-keep-001', kind: 'insert_prompt', label: 'Keep branch' },
        ],
      }),
    }),
  ],
};
