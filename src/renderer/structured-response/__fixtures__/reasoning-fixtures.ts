/**
 * Deterministic reasoning disclosure block fixtures.
 *
 * Covers all disclosure states (permitted, protected, unavailable),
 * activity categories, streaming, and finalized states.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { ReasoningBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function reasoningBlock(params: {
  entityId: string;
  categories: ('summary' | 'search' | 'coding' | 'tool' | 'verification')[];
  summary: string;
  disclosure: 'permitted' | 'protected' | 'unavailable';
  finalized: boolean;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): ReasoningBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'reasoning',
      entityId: params.entityId,
      role: 'detail',
      status: params.status ?? (params.finalized ? 'ready' : 'streaming'),
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'reasoning',
    content: {
      categories: params.categories,
      summary: params.summary,
      disclosure: params.disclosure,
      finalized: params.finalized,
    },
  };
}

export const reasoningFixtures: GalleryFixtureSet = {
  kind: 'reasoning',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'reasoning-permitted-summary',
      description: 'Permitted reasoning with summary category',
      block: reasoningBlock({
        entityId: 'reason-perm-001',
        categories: ['summary'],
        summary: 'Analyzing the request to understand requirements and constraints.',
        disclosure: 'permitted',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'reasoning-permitted-multi-category',
      description: 'Permitted reasoning with multiple activity categories',
      block: reasoningBlock({
        entityId: 'reason-multi-001',
        categories: ['search', 'coding', 'verification'],
        summary: 'Searching documentation, writing implementation, and verifying correctness.',
        disclosure: 'permitted',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'reasoning-protected',
      description: 'Protected reasoning that cannot show chain-of-thought',
      block: reasoningBlock({
        entityId: 'reason-prot-001',
        categories: ['summary'],
        summary: 'Reasoning content is protected by policy.',
        disclosure: 'protected',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'reasoning-unavailable',
      description: 'Unavailable reasoning disclosure',
      block: reasoningBlock({
        entityId: 'reason-unavail-001',
        categories: [],
        summary: 'Reasoning trace is not available for this turn.',
        disclosure: 'unavailable',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'reasoning-streaming',
      description: 'Reasoning streaming in progress',
      lifecycle: 'streaming',
      block: reasoningBlock({
        entityId: 'reason-stream-001',
        categories: ['tool'],
        summary: 'Evaluating tool execution results',
        disclosure: 'permitted',
        finalized: false,
        status: 'streaming',
      }),
    }),
    makeFixture({
      id: 'reasoning-high-contrast',
      description: 'Reasoning under high-contrast theme',
      theme: 'high-contrast-light',
      block: reasoningBlock({
        entityId: 'reason-hc-001',
        categories: ['summary', 'search'],
        summary: 'Activity visible with high-contrast indicators.',
        disclosure: 'permitted',
        finalized: true,
      }),
    }),
  ],
};
