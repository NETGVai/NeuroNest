/**
 * Deterministic turn status block fixtures.
 *
 * Covers every Turn_Activity_State, cancellation availability,
 * elapsed time display, and lifecycle transitions.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { TurnStatusBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type TurnState =
  | 'queued' | 'reasoning' | 'tool_running' | 'streaming'
  | 'waiting_for_user' | 'retrying' | 'cancelling' | 'cancelled'
  | 'interrupted' | 'completed' | 'failed' | 'reconnecting';

function turnStatusBlock(params: {
  entityId: string;
  state: TurnState;
  label: string;
  startedAt?: string;
  terminalAt?: string;
  cancellationAvailable?: boolean;
  cancellationReason?: string;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): TurnStatusBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'turn_status',
      entityId: params.entityId,
      role: 'status',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'turn_status',
    content: {
      state: params.state,
      label: params.label,
      ...(params.startedAt !== undefined && { startedAt: params.startedAt }),
      ...(params.terminalAt !== undefined && { terminalAt: params.terminalAt }),
      cancellation: {
        available: params.cancellationAvailable ?? false,
        ...(params.cancellationReason !== undefined && {
          unavailableReason: params.cancellationReason,
        }),
      },
    },
  };
}

export const turnStatusFixtures: GalleryFixtureSet = {
  kind: 'turn_status',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'turn-status-queued',
      description: 'Turn queued awaiting processing',
      lifecycle: 'streaming',
      block: turnStatusBlock({
        entityId: 'ts-queued-001',
        state: 'queued',
        label: 'Waiting in queue',
        cancellationAvailable: true,
      }),
    }),
    makeFixture({
      id: 'turn-status-reasoning',
      description: 'Turn actively reasoning',
      lifecycle: 'streaming',
      block: turnStatusBlock({
        entityId: 'ts-reason-001',
        state: 'reasoning',
        label: 'Thinking',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: true,
      }),
    }),
    makeFixture({
      id: 'turn-status-tool-running',
      description: 'Turn executing tool calls',
      lifecycle: 'streaming',
      block: turnStatusBlock({
        entityId: 'ts-tool-001',
        state: 'tool_running',
        label: 'Running file search',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: true,
      }),
    }),
    makeFixture({
      id: 'turn-status-streaming',
      description: 'Turn streaming response content',
      lifecycle: 'streaming',
      block: turnStatusBlock({
        entityId: 'ts-stream-001',
        state: 'streaming',
        label: 'Generating response',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: true,
      }),
    }),
    makeFixture({
      id: 'turn-status-waiting-for-user',
      description: 'Turn waiting for user decision',
      lifecycle: 'streaming',
      block: turnStatusBlock({
        entityId: 'ts-wait-001',
        state: 'waiting_for_user',
        label: 'Awaiting approval',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: false,
        cancellationReason: 'Decision required before cancellation',
      }),
    }),
    makeFixture({
      id: 'turn-status-retrying',
      description: 'Turn retrying after failure',
      lifecycle: 'retrying',
      block: turnStatusBlock({
        entityId: 'ts-retry-001',
        state: 'retrying',
        label: 'Retrying (attempt 2 of 3)',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: true,
      }),
    }),
    makeFixture({
      id: 'turn-status-cancelling',
      description: 'Turn being cancelled',
      lifecycle: 'cancelled',
      block: turnStatusBlock({
        entityId: 'ts-cancel-001',
        state: 'cancelling',
        label: 'Cancelling',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: false,
        cancellationReason: 'Already cancelling',
      }),
    }),
    makeFixture({
      id: 'turn-status-cancelled',
      description: 'Turn terminated by cancellation',
      lifecycle: 'cancelled',
      block: turnStatusBlock({
        entityId: 'ts-cancelled-001',
        state: 'cancelled',
        label: 'Cancelled by user',
        startedAt: '2026-08-17T10:00:00.000Z',
        terminalAt: '2026-08-17T10:00:05.000Z',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'turn-status-interrupted',
      description: 'Turn interrupted externally',
      lifecycle: 'failed',
      block: turnStatusBlock({
        entityId: 'ts-interrupt-001',
        state: 'interrupted',
        label: 'Interrupted by system',
        startedAt: '2026-08-17T10:00:00.000Z',
        terminalAt: '2026-08-17T10:00:03.000Z',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'turn-status-completed',
      description: 'Turn completed successfully',
      lifecycle: 'finalized',
      block: turnStatusBlock({
        entityId: 'ts-complete-001',
        state: 'completed',
        label: 'Completed',
        startedAt: '2026-08-17T10:00:00.000Z',
        terminalAt: '2026-08-17T10:00:12.000Z',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'turn-status-failed',
      description: 'Turn failed with error',
      lifecycle: 'failed',
      block: turnStatusBlock({
        entityId: 'ts-fail-001',
        state: 'failed',
        label: 'Failed: provider timeout',
        startedAt: '2026-08-17T10:00:00.000Z',
        terminalAt: '2026-08-17T10:00:30.000Z',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'turn-status-reconnecting',
      description: 'Turn reconnecting after connection loss',
      lifecycle: 'reconnecting',
      block: turnStatusBlock({
        entityId: 'ts-reconn-001',
        state: 'reconnecting',
        label: 'Reconnecting (attempt 1)',
        startedAt: '2026-08-17T10:00:00.000Z',
        cancellationAvailable: true,
      }),
    }),
  ],
};
