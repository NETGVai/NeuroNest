/**
 * Deterministic context/citation block fixtures.
 *
 * Covers all source types, source states, partial citations,
 * and group scenarios.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { ContextBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type SourceType = 'web' | 'file' | 'attachment' | 'session' | 'artifact' | 'tool' | 'provider';
type SourceState = 'available' | 'stale' | 'unavailable' | 'redacted' | 'unverified' | 'no_longer_authorized';

function contextBlock(params: {
  entityId: string;
  sources: Array<{
    citationId: string;
    sourceType: SourceType;
    state: SourceState;
    sourceRevision: number;
    permittedTitle?: string;
    permittedExcerpt?: string;
    retrievedAt?: string;
    contentDigest?: string;
  }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): ContextBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'context',
      entityId: params.entityId,
      role: 'evidence',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.web,
    }),
    kind: 'context',
    content: {
      sources: params.sources.map((s) => ({
        schemaVersion: 1 as const,
        citationId: s.citationId,
        sourceType: s.sourceType,
        state: s.state,
        sourceRevision: s.sourceRevision,
        authority: FIXTURE_AUTHORITIES.web,
        ...(s.permittedTitle !== undefined && { permittedTitle: s.permittedTitle }),
        ...(s.permittedExcerpt !== undefined && { permittedExcerpt: s.permittedExcerpt }),
        ...(s.retrievedAt !== undefined && { retrievedAt: s.retrievedAt }),
        ...(s.contentDigest !== undefined && { contentDigest: s.contentDigest }),
      })),
    },
  };
}

export const contextFixtures: GalleryFixtureSet = {
  kind: 'context',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'context-web-available',
      description: 'Available web source with full citation data',
      sourceState: 'available',
      block: contextBlock({
        entityId: 'ctx-web-001',
        sources: [
          {
            citationId: 'cite-web-001',
            sourceType: 'web',
            state: 'available',
            sourceRevision: 2,
            permittedTitle: 'TypeScript Handbook - Generics',
            permittedExcerpt: 'Generics provide a way to create reusable components that work with multiple types.',
            retrievedAt: '2026-08-17T09:30:00.000Z',
            contentDigest: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-file-available',
      description: 'Available file source reference',
      sourceState: 'available',
      block: contextBlock({
        entityId: 'ctx-file-001',
        sources: [
          {
            citationId: 'cite-file-001',
            sourceType: 'file',
            state: 'available',
            sourceRevision: 1,
            permittedTitle: 'response-composition.ts',
            permittedExcerpt: 'Closed versioned presentation contracts for assistant response blocks.',
            retrievedAt: '2026-08-17T09:31:00.000Z',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-stale-source',
      description: 'Source that has become stale',
      sourceState: 'stale',
      block: contextBlock({
        entityId: 'ctx-stale-001',
        sources: [
          {
            citationId: 'cite-stale-001',
            sourceType: 'web',
            state: 'stale',
            sourceRevision: 1,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-unavailable-source',
      description: 'Source that is no longer accessible',
      sourceState: 'unavailable',
      block: contextBlock({
        entityId: 'ctx-unavail-001',
        sources: [
          {
            citationId: 'cite-unavail-001',
            sourceType: 'attachment',
            state: 'unavailable',
            sourceRevision: 3,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-redacted-source',
      description: 'Source with redacted content',
      sourceState: 'redacted',
      block: contextBlock({
        entityId: 'ctx-redact-001',
        sources: [
          {
            citationId: 'cite-redact-001',
            sourceType: 'session',
            state: 'redacted',
            sourceRevision: 2,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-unverified-source',
      description: 'Source that could not be verified',
      sourceState: 'unverified',
      block: contextBlock({
        entityId: 'ctx-unverified-001',
        sources: [
          {
            citationId: 'cite-unverified-001',
            sourceType: 'tool',
            state: 'unverified',
            sourceRevision: 1,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-no-longer-authorized',
      description: 'Source where authorization was revoked',
      sourceState: 'no_longer_authorized',
      block: contextBlock({
        entityId: 'ctx-noauth-001',
        sources: [
          {
            citationId: 'cite-noauth-001',
            sourceType: 'provider',
            state: 'no_longer_authorized',
            sourceRevision: 4,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'context-multi-source-group',
      description: 'Multiple sources grouped together',
      sourceState: 'available',
      block: contextBlock({
        entityId: 'ctx-group-001',
        sources: [
          {
            citationId: 'cite-group-001',
            sourceType: 'web',
            state: 'available',
            sourceRevision: 1,
            permittedTitle: 'API Reference - Request Handling',
            permittedExcerpt: 'All requests are validated against the schema before processing.',
            retrievedAt: '2026-08-17T09:32:00.000Z',
          },
          {
            citationId: 'cite-group-002',
            sourceType: 'file',
            state: 'available',
            sourceRevision: 1,
            permittedTitle: 'validation-service.ts',
            permittedExcerpt: 'Schema validation with Zod for runtime type safety.',
            retrievedAt: '2026-08-17T09:32:01.000Z',
          },
          {
            citationId: 'cite-group-003',
            sourceType: 'artifact',
            state: 'stale',
            sourceRevision: 2,
          },
        ],
      }),
    }),
  ],
};
