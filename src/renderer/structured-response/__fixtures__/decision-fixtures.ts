/**
 * Deterministic decision block fixtures.
 *
 * Covers all decision types, states, authority lifecycle,
 * and collaboration scenarios.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { DecisionBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type DecisionType = 'question' | 'approval' | 'permission' | 'plan_review';
type DecisionState = 'pending' | 'answered' | 'approved' | 'denied' | 'expired' | 'superseded' | 'unavailable';

function decisionBlock(params: {
  entityId: string;
  collaborationId: string;
  decisionType: DecisionType;
  owner: string;
  prompt: string;
  state: DecisionState;
  contractRevision: number;
  contractDigest: string;
  scopeSummary?: string;
  riskSummary?: string;
  expiresAt?: string;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): DecisionBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'decision',
      entityId: params.entityId,
      role: 'decision',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.collaboration,
    }),
    kind: 'decision',
    content: {
      collaborationId: params.collaborationId,
      canonicalStableKey: `decision-key-${params.collaborationId}`,
      decisionType: params.decisionType,
      owner: params.owner,
      prompt: params.prompt,
      ...(params.scopeSummary !== undefined && { scopeSummary: params.scopeSummary }),
      ...(params.riskSummary !== undefined && { riskSummary: params.riskSummary }),
      ...(params.expiresAt !== undefined && { expiresAt: params.expiresAt }),
      state: params.state,
      contractRevision: params.contractRevision,
      contractDigest: params.contractDigest,
    },
  };
}

export const decisionFixtures: GalleryFixtureSet = {
  kind: 'decision',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'decision-pending-approval',
      description: 'Pending approval for file write operation',
      authorityState: 'pending',
      block: decisionBlock({
        entityId: 'dec-pend-001',
        collaborationId: 'collab-001',
        decisionType: 'approval',
        owner: 'filesystem-authority',
        prompt: 'Allow writing to configuration file?',
        state: 'pending',
        contractRevision: 1,
        contractDigest: 'digest-approval-001',
        scopeSummary: 'Write access to project config',
        riskSummary: 'Medium risk - modifies build configuration',
      }),
    }),
    makeFixture({
      id: 'decision-pending-permission',
      description: 'Pending permission for network access',
      authorityState: 'pending',
      block: decisionBlock({
        entityId: 'dec-perm-001',
        collaborationId: 'collab-002',
        decisionType: 'permission',
        owner: 'security-authority',
        prompt: 'Grant network access to fetch package metadata?',
        state: 'pending',
        contractRevision: 1,
        contractDigest: 'digest-perm-001',
        riskSummary: 'Low risk - read-only HTTP GET',
      }),
    }),
    makeFixture({
      id: 'decision-approved',
      description: 'Decision confirmed by authority',
      authorityState: 'confirmed',
      block: decisionBlock({
        entityId: 'dec-approved-001',
        collaborationId: 'collab-003',
        decisionType: 'approval',
        owner: 'orchestration-engine',
        prompt: 'Proceed with refactoring plan?',
        state: 'approved',
        contractRevision: 2,
        contractDigest: 'digest-approved-001',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'decision-denied',
      description: 'Decision denied by user',
      authorityState: 'rejected',
      block: decisionBlock({
        entityId: 'dec-denied-001',
        collaborationId: 'collab-004',
        decisionType: 'permission',
        owner: 'process-authority',
        prompt: 'Execute shell command?',
        state: 'denied',
        contractRevision: 1,
        contractDigest: 'digest-denied-001',
        riskSummary: 'High risk - system command execution',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'decision-expired',
      description: 'Decision expired before response',
      authorityState: 'expired',
      block: decisionBlock({
        entityId: 'dec-expired-001',
        collaborationId: 'collab-005',
        decisionType: 'question',
        owner: 'orchestration-engine',
        prompt: 'Which approach do you prefer?',
        state: 'expired',
        contractRevision: 1,
        contractDigest: 'digest-expired-001',
        expiresAt: '2026-08-17T10:05:00.000Z',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'decision-superseded',
      description: 'Decision superseded by newer revision',
      authorityState: 'superseded',
      block: decisionBlock({
        entityId: 'dec-super-001',
        collaborationId: 'collab-006',
        decisionType: 'plan_review',
        owner: 'orchestration-engine',
        prompt: 'Review updated implementation plan',
        state: 'superseded',
        contractRevision: 3,
        contractDigest: 'digest-super-001',
        status: 'stale',
      }),
    }),
    makeFixture({
      id: 'decision-question-answered',
      description: 'Question answered by user',
      authorityState: 'confirmed',
      block: decisionBlock({
        entityId: 'dec-answered-001',
        collaborationId: 'collab-007',
        decisionType: 'question',
        owner: 'orchestration-engine',
        prompt: 'Should the output include line numbers?',
        state: 'answered',
        contractRevision: 1,
        contractDigest: 'digest-answered-001',
        status: 'terminal',
      }),
    }),
  ],
};
