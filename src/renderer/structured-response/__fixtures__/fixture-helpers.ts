/**
 * Shared helpers for building deterministic fixture data.
 *
 * All identifiers, content, and keys are hardcoded constants — no randomness,
 * no network calls, no model inference. This ensures snapshots and digests
 * remain stable across test runs.
 */

import { createHash } from 'crypto';
import type {
  ResponseBlockKind,
  ResponseBlockRole,
  ResponseBlockStatus,
  ResponseBlockV1,
} from '../../../harness/contracts/response-composition';
import type { AuthorityRefV1 } from '../../../harness/contracts/response-support';
import type {
  AccessibilityVariant,
  AuthorityStateVariant,
  FallbackVariant,
  GalleryFixture,
  LifecycleVariant,
  ThemeVariant,
  ViewportVariant,
} from './types';

/** Deterministic session/branch/turn identifiers shared across all fixtures. */
export const FIXTURE_SESSION_ID = 'fixture-session-001';
export const FIXTURE_BRANCH_ID = 'fixture-branch-main';
export const FIXTURE_TURN_ID = 'fixture-turn-001';
export const FIXTURE_COMPOSITION_ID = 'fixture-composition-001';
export const FIXTURE_SEMANTIC_ANCHOR = 'fixture-anchor-001';

/** Authority references used in fixtures. */
export const FIXTURE_AUTHORITIES: Record<string, AuthorityRefV1> = {
  orchestration: {
    schemaVersion: 1,
    authorityKind: 'orchestration_engine',
    authorityId: 'fixture-orch-001',
  },
  filesystem: {
    schemaVersion: 1,
    authorityKind: 'filesystem_authority',
    authorityId: 'fixture-fs-001',
  },
  projection: {
    schemaVersion: 1,
    authorityKind: 'projection_service',
    authorityId: 'fixture-proj-001',
  },
  tool: {
    schemaVersion: 1,
    authorityKind: 'tool_system',
    authorityId: 'fixture-tool-001',
  },
  web: {
    schemaVersion: 1,
    authorityKind: 'web_retrieval_service',
    authorityId: 'fixture-web-001',
  },
  collaboration: {
    schemaVersion: 1,
    authorityKind: 'collaboration_authority',
    authorityId: 'fixture-collab-001',
  },
  security: {
    schemaVersion: 1,
    authorityKind: 'security_authority',
    authorityId: 'fixture-sec-001',
  },
  session: {
    schemaVersion: 1,
    authorityKind: 'session_store',
    authorityId: 'fixture-session-store-001',
  },
};

/**
 * Compute a deterministic content digest from block data.
 * Uses JSON.stringify with sorted keys for stability.
 */
export function computeFixtureDigest(block: ResponseBlockV1): string {
  const normalized = JSON.stringify(block, Object.keys(block).sort());
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Compute a deterministic stable key for a fixture block.
 */
export function computeFixtureStableKey(
  kind: ResponseBlockKind,
  entityId: string,
  role: ResponseBlockRole,
): string {
  return `${FIXTURE_SESSION_ID}:${FIXTURE_BRANCH_ID}:${FIXTURE_COMPOSITION_ID}:${kind}:${entityId}:${role}`;
}

/**
 * Build base block fields shared by all fixture blocks.
 */
export function makeBlockBase(params: {
  kind: ResponseBlockKind;
  entityId: string;
  role?: ResponseBlockRole;
  status?: ResponseBlockStatus;
  contentRevision?: number;
  authority?: AuthorityRefV1;
  permittedSummary?: string;
}): {
  schemaVersion: 1;
  stableKey: string;
  role: ResponseBlockRole;
  semanticAnchor: string;
  sourceIdentity: {
    sessionId: string;
    branchId: string;
    turnId: string;
    entityId: string;
  };
  contentRevision: number;
  status: ResponseBlockStatus;
  permittedSummary?: string;
  authority?: AuthorityRefV1;
} {
  const role = params.role ?? 'primary';
  return {
    schemaVersion: 1 as const,
    stableKey: computeFixtureStableKey(params.kind, params.entityId, role),
    role,
    semanticAnchor: `anchor-${params.kind}-${params.entityId}`,
    sourceIdentity: {
      sessionId: FIXTURE_SESSION_ID,
      branchId: FIXTURE_BRANCH_ID,
      turnId: FIXTURE_TURN_ID,
      entityId: params.entityId,
    },
    contentRevision: params.contentRevision ?? 1,
    status: params.status ?? 'ready',
    ...(params.permittedSummary !== undefined && { permittedSummary: params.permittedSummary }),
    ...(params.authority !== undefined && { authority: params.authority }),
  };
}

/**
 * Wrap a block into a full GalleryFixture entry with defaults.
 */
export function makeFixture(params: {
  id: string;
  description: string;
  block: ResponseBlockV1;
  theme?: ThemeVariant;
  viewport?: ViewportVariant;
  accessibility?: AccessibilityVariant;
  lifecycle?: LifecycleVariant;
  authorityState?: AuthorityStateVariant;
  sourceState?: string;
  fallback?: FallbackVariant;
}): GalleryFixture {
  const block = params.block;
  return {
    id: params.id,
    description: params.description,
    blockKind: block.kind,
    contractVersion: 1,
    status: block.status,
    role: block.role,
    theme: params.theme ?? 'light',
    viewport: params.viewport ?? 'medium',
    accessibility: params.accessibility ?? 'default',
    lifecycle: params.lifecycle ?? 'finalized',
    authorityState: params.authorityState ?? 'confirmed',
    ...(params.sourceState !== undefined && { sourceState: params.sourceState as any }),
    fallback: params.fallback ?? 'normal',
    block,
    contentDigest: computeFixtureDigest(block),
    expectedStableKey: block.stableKey,
  };
}
