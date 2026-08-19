/**
 * Deterministic error/recovery block fixtures.
 *
 * Covers all recovery states, retry scenarios,
 * reconnection, partial content, and bounded diagnostics.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { ErrorBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type RecoveryState = 'failed' | 'retrying' | 'reconnecting' | 'interrupted' | 'cancelled' | 'stale';

function errorBlock(params: {
  entityId: string;
  errorId: string;
  errorClass: string;
  summary: string;
  affectedIdentity: string;
  lastVerifiedState: string;
  correlationId: string;
  recoveryState: RecoveryState;
  partialContent?: string;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): ErrorBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'error',
      entityId: params.entityId,
      role: 'status',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'error',
    content: {
      errorId: params.errorId,
      errorClass: params.errorClass,
      summary: params.summary,
      affectedIdentity: params.affectedIdentity,
      lastVerifiedState: params.lastVerifiedState,
      correlationId: params.correlationId,
      recoveryState: params.recoveryState,
      ...(params.partialContent !== undefined && { partialContent: params.partialContent }),
    },
  };
}

export const errorFixtures: GalleryFixtureSet = {
  kind: 'error',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'error-provider-timeout',
      description: 'Provider timeout with retry available',
      lifecycle: 'retrying',
      block: errorBlock({
        entityId: 'err-timeout-001',
        errorId: 'err-id-timeout-001',
        errorClass: 'provider-timeout',
        summary: 'The model provider did not respond within the configured timeout.',
        affectedIdentity: 'turn-001',
        lastVerifiedState: 'Reasoning phase completed, streaming started',
        correlationId: 'corr-timeout-001',
        recoveryState: 'retrying',
        partialContent: 'The implementation should use a typed dispatch mechanism that',
      }),
    }),
    makeFixture({
      id: 'error-connection-lost',
      description: 'Connection lost during streaming',
      lifecycle: 'reconnecting',
      block: errorBlock({
        entityId: 'err-conn-001',
        errorId: 'err-id-conn-001',
        errorClass: 'connection-lost',
        summary: 'Connection to the provider was interrupted.',
        affectedIdentity: 'turn-002',
        lastVerifiedState: 'Streaming in progress, 240 tokens received',
        correlationId: 'corr-conn-001',
        recoveryState: 'reconnecting',
        partialContent: 'Here is the partial response that was received before the connection was lost. The typed composition model ensures that',
      }),
    }),
    makeFixture({
      id: 'error-rate-limit',
      description: 'Rate limit exceeded with scheduled retry',
      lifecycle: 'retrying',
      block: errorBlock({
        entityId: 'err-rate-001',
        errorId: 'err-id-rate-001',
        errorClass: 'rate-limit-exceeded',
        summary: 'Request rate limit exceeded. Retry scheduled.',
        affectedIdentity: 'turn-003',
        lastVerifiedState: 'Request queued',
        correlationId: 'corr-rate-001',
        recoveryState: 'retrying',
      }),
    }),
    makeFixture({
      id: 'error-permanent-failure',
      description: 'Permanent failure with no recovery available',
      lifecycle: 'failed',
      block: errorBlock({
        entityId: 'err-perm-001',
        errorId: 'err-id-perm-001',
        errorClass: 'authentication-failed',
        summary: 'Provider authentication failed. Check API key configuration.',
        affectedIdentity: 'turn-004',
        lastVerifiedState: 'Connection attempt',
        correlationId: 'corr-perm-001',
        recoveryState: 'failed',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'error-interrupted',
      description: 'Turn interrupted by system',
      lifecycle: 'failed',
      block: errorBlock({
        entityId: 'err-interrupt-001',
        errorId: 'err-id-interrupt-001',
        errorClass: 'system-interrupt',
        summary: 'Processing was interrupted due to resource constraints.',
        affectedIdentity: 'turn-005',
        lastVerifiedState: 'Tool execution in progress',
        correlationId: 'corr-interrupt-001',
        recoveryState: 'interrupted',
        partialContent: 'The search returned 15 results. Analyzing the first batch',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'error-cancelled',
      description: 'Turn cancelled by user',
      lifecycle: 'cancelled',
      block: errorBlock({
        entityId: 'err-cancel-001',
        errorId: 'err-id-cancel-001',
        errorClass: 'user-cancellation',
        summary: 'Cancelled by user request.',
        affectedIdentity: 'turn-006',
        lastVerifiedState: 'Streaming response',
        correlationId: 'corr-cancel-001',
        recoveryState: 'cancelled',
        partialContent: 'Based on the analysis of the codebase',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'error-stale-projection',
      description: 'Error due to stale projection state',
      block: errorBlock({
        entityId: 'err-stale-001',
        errorId: 'err-id-stale-001',
        errorClass: 'stale-projection',
        summary: 'The projected state is outdated and needs refresh.',
        affectedIdentity: 'turn-007',
        lastVerifiedState: 'Composition at revision 5',
        correlationId: 'corr-stale-001',
        recoveryState: 'stale',
        status: 'stale',
      }),
    }),
    makeFixture({
      id: 'error-partial-recovery',
      description: 'Partial failure with some content recovered',
      lifecycle: 'partial-recovery',
      block: errorBlock({
        entityId: 'err-partial-001',
        errorId: 'err-id-partial-001',
        errorClass: 'partial-completion',
        summary: 'Response partially completed before failure. Partial content preserved.',
        affectedIdentity: 'turn-008',
        lastVerifiedState: '3 of 5 tool calls completed',
        correlationId: 'corr-partial-001',
        recoveryState: 'failed',
        partialContent: 'The first three operations completed successfully:\n1. File read - OK\n2. Search - OK\n3. Analysis - OK\n\nRemaining operations could not complete.',
      }),
    }),
  ],
};
