/**
 * Deterministic narrative block fixtures.
 *
 * Covers streaming and finalized Markdown, plain text, long content,
 * lifecycle variants, and all status/role combinations.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { NarrativeBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function narrativeBlock(params: {
  entityId: string;
  format: 'plain_stream' | 'markdown';
  text: string;
  finalized: boolean;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
  contentRevision?: number;
}): NarrativeBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'narrative',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? (params.finalized ? 'ready' : 'streaming'),
      contentRevision: params.contentRevision,
      authority: FIXTURE_AUTHORITIES.projection,
    }),
    kind: 'narrative',
    content: {
      format: params.format,
      text: params.text,
      finalized: params.finalized,
    },
  };
}

export const narrativeFixtures: GalleryFixtureSet = {
  kind: 'narrative',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'narrative-streaming-plain',
      description: 'Plain text streaming in progress',
      lifecycle: 'streaming',
      block: narrativeBlock({
        entityId: 'narr-stream-001',
        format: 'plain_stream',
        text: 'The assistant is currently generating a response about code architecture',
        finalized: false,
        status: 'streaming',
      }),
    }),
    makeFixture({
      id: 'narrative-finalized-markdown',
      description: 'Finalized Markdown narrative with headings and code',
      lifecycle: 'finalized',
      block: narrativeBlock({
        entityId: 'narr-final-001',
        format: 'markdown',
        text: [
          '## Summary',
          '',
          'The implementation uses a **typed composition** model where each response block',
          'has a stable identity and declared semantic role.',
          '',
          '```typescript',
          'const block: ResponseBlockV1 = { kind: "narrative", ... };',
          '```',
          '',
          '- First point about architecture',
          '- Second point about stability',
          '- Third point about accessibility',
        ].join('\n'),
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'narrative-long-collapsed',
      description: 'Long narrative exceeding collapse threshold',
      lifecycle: 'finalized',
      block: narrativeBlock({
        entityId: 'narr-long-001',
        format: 'markdown',
        text: Array.from({ length: 50 }, (_, i) =>
          `Paragraph ${i + 1}: This is explanatory content that demonstrates how the renderer handles long narrative blocks with progressive disclosure controls.`
        ).join('\n\n'),
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'narrative-stale',
      description: 'Narrative that has become stale after projection update',
      lifecycle: 'finalized',
      authorityState: 'expired',
      block: narrativeBlock({
        entityId: 'narr-stale-001',
        format: 'markdown',
        text: 'This content was valid at revision 3 but the projection has advanced.',
        finalized: true,
        status: 'stale',
        contentRevision: 3,
      }),
    }),
    makeFixture({
      id: 'narrative-unavailable',
      description: 'Narrative block that is unavailable',
      lifecycle: 'failed',
      authorityState: 'unavailable',
      block: narrativeBlock({
        entityId: 'narr-unavail-001',
        format: 'plain_stream',
        text: '',
        finalized: false,
        status: 'unavailable',
      }),
    }),
    makeFixture({
      id: 'narrative-dark-theme',
      description: 'Finalized narrative under dark theme',
      theme: 'dark',
      block: narrativeBlock({
        entityId: 'narr-dark-001',
        format: 'markdown',
        text: '## Dark Theme Test\n\nRendered with dark semantic tokens.',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'narrative-narrow-viewport',
      description: 'Narrative in narrow viewport mode',
      viewport: 'narrow',
      block: narrativeBlock({
        entityId: 'narr-narrow-001',
        format: 'markdown',
        text: 'Content adapts to the narrow reading column without horizontal overflow.',
        finalized: true,
      }),
    }),
    makeFixture({
      id: 'narrative-reduced-motion',
      description: 'Narrative with reduced motion accessibility',
      accessibility: 'reduced-motion',
      block: narrativeBlock({
        entityId: 'narr-a11y-001',
        format: 'plain_stream',
        text: 'Streaming without animation indicators',
        finalized: false,
        status: 'streaming',
      }),
    }),
  ],
};
