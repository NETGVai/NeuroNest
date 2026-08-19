/**
 * Deterministic tool activity block fixtures.
 *
 * Covers all tool states, parent-child lineage, risk classes,
 * retained output states, and nested tool scenarios.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { ToolActivityBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type ToolState = 'planned' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
type RetainedOutput = 'inline' | 'spilled' | 'truncated' | 'redacted' | 'unavailable';

function toolBlock(params: {
  entityId: string;
  callId: string;
  parentCallId?: string;
  modelOrderIndex: number;
  state: ToolState;
  riskClass: string;
  owner: string;
  retainedOutput: RetainedOutput;
  value?: { canonicalValueId: string; mediaType: string; permittedPreview?: string };
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): ToolActivityBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'tool_activity',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.tool,
    }),
    kind: 'tool_activity',
    content: {
      callId: params.callId,
      ...(params.parentCallId !== undefined && { parentCallId: params.parentCallId }),
      modelOrderIndex: params.modelOrderIndex,
      state: params.state,
      riskClass: params.riskClass,
      owner: params.owner,
      ...(params.value !== undefined && { value: params.value }),
      retainedOutput: params.retainedOutput,
    },
  };
}

export const toolActivityFixtures: GalleryFixtureSet = {
  kind: 'tool_activity',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'tool-planned',
      description: 'Tool call planned but not yet executing',
      block: toolBlock({
        entityId: 'tool-plan-001',
        callId: 'call-plan-001',
        modelOrderIndex: 0,
        state: 'planned',
        riskClass: 'low',
        owner: 'orchestration-engine',
        retainedOutput: 'unavailable',
        status: 'pending',
      }),
    }),
    makeFixture({
      id: 'tool-executing',
      description: 'Tool call currently executing',
      lifecycle: 'streaming',
      block: toolBlock({
        entityId: 'tool-exec-001',
        callId: 'call-exec-001',
        modelOrderIndex: 0,
        state: 'executing',
        riskClass: 'low',
        owner: 'file-system',
        retainedOutput: 'unavailable',
        status: 'streaming',
      }),
    }),
    makeFixture({
      id: 'tool-completed-inline',
      description: 'Tool call completed with inline output',
      block: toolBlock({
        entityId: 'tool-done-001',
        callId: 'call-done-001',
        modelOrderIndex: 0,
        state: 'completed',
        riskClass: 'low',
        owner: 'file-system',
        retainedOutput: 'inline',
        value: {
          canonicalValueId: 'val-001',
          mediaType: 'text/plain',
          permittedPreview: 'File content retrieved successfully (42 lines)',
        },
      }),
    }),
    makeFixture({
      id: 'tool-completed-spilled',
      description: 'Tool call completed with spilled output',
      block: toolBlock({
        entityId: 'tool-spill-001',
        callId: 'call-spill-001',
        modelOrderIndex: 1,
        state: 'completed',
        riskClass: 'low',
        owner: 'file-system',
        retainedOutput: 'spilled',
        value: {
          canonicalValueId: 'val-002',
          mediaType: 'application/json',
        },
      }),
    }),
    makeFixture({
      id: 'tool-completed-truncated',
      description: 'Tool call completed with truncated output',
      block: toolBlock({
        entityId: 'tool-trunc-001',
        callId: 'call-trunc-001',
        modelOrderIndex: 2,
        state: 'completed',
        riskClass: 'medium',
        owner: 'web-search',
        retainedOutput: 'truncated',
        value: {
          canonicalValueId: 'val-003',
          mediaType: 'text/html',
          permittedPreview: 'Search results (showing 10 of 247)',
        },
      }),
    }),
    makeFixture({
      id: 'tool-completed-redacted',
      description: 'Tool call completed with redacted output',
      block: toolBlock({
        entityId: 'tool-redact-001',
        callId: 'call-redact-001',
        modelOrderIndex: 3,
        state: 'completed',
        riskClass: 'high',
        owner: 'security-authority',
        retainedOutput: 'redacted',
      }),
    }),
    makeFixture({
      id: 'tool-failed',
      description: 'Tool call that failed',
      lifecycle: 'failed',
      block: toolBlock({
        entityId: 'tool-fail-001',
        callId: 'call-fail-001',
        modelOrderIndex: 4,
        state: 'failed',
        riskClass: 'medium',
        owner: 'terminal-authority',
        retainedOutput: 'unavailable',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'tool-cancelled',
      description: 'Tool call that was cancelled',
      lifecycle: 'cancelled',
      block: toolBlock({
        entityId: 'tool-cancel-001',
        callId: 'call-cancel-001',
        modelOrderIndex: 5,
        state: 'cancelled',
        riskClass: 'low',
        owner: 'orchestration-engine',
        retainedOutput: 'unavailable',
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'tool-awaiting-approval',
      description: 'Tool call awaiting user approval',
      block: toolBlock({
        entityId: 'tool-approval-001',
        callId: 'call-approval-001',
        modelOrderIndex: 6,
        state: 'awaiting_approval',
        riskClass: 'high',
        owner: 'process-authority',
        retainedOutput: 'unavailable',
      }),
    }),
    makeFixture({
      id: 'tool-nested-parent',
      description: 'Parent tool call in a nested hierarchy',
      block: toolBlock({
        entityId: 'tool-parent-001',
        callId: 'call-parent-001',
        modelOrderIndex: 0,
        state: 'completed',
        riskClass: 'low',
        owner: 'orchestration-engine',
        retainedOutput: 'inline',
        value: {
          canonicalValueId: 'val-parent-001',
          mediaType: 'application/json',
          permittedPreview: 'Orchestrated 3 sub-tasks',
        },
      }),
    }),
    makeFixture({
      id: 'tool-nested-child',
      description: 'Child tool call with parent lineage',
      block: toolBlock({
        entityId: 'tool-child-001',
        callId: 'call-child-001',
        parentCallId: 'call-parent-001',
        modelOrderIndex: 1,
        state: 'executing',
        riskClass: 'low',
        owner: 'file-system',
        retainedOutput: 'unavailable',
        status: 'streaming',
      }),
    }),
  ],
};
