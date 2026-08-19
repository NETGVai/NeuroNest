/**
 * Deterministic task progress block fixtures.
 *
 * Covers all task kinds, states, progress variants,
 * indeterminate progress, and multi-item groups.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { TaskProgressBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type TaskKind = 'plan' | 'task' | 'workflow' | 'subagent' | 'job' | 'check' | 'result_injection';
type TaskState = 'queued' | 'running' | 'blocked' | 'waiting' | 'failed' | 'cancelled' | 'completed';

interface TaskItem {
  taskId: string;
  taskKind: TaskKind;
  title: string;
  owner: string;
  state: TaskState;
  progress?: number;
  outcome?: string;
}

function taskProgressBlock(params: {
  entityId: string;
  groupLabel?: string;
  items: TaskItem[];
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): TaskProgressBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'task_progress',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.orchestration,
    }),
    kind: 'task_progress',
    content: {
      ...(params.groupLabel !== undefined && { groupLabel: params.groupLabel }),
      items: params.items,
    },
  };
}

export const taskProgressFixtures: GalleryFixtureSet = {
  kind: 'task_progress',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'task-single-running',
      description: 'Single running task with known progress',
      lifecycle: 'streaming',
      block: taskProgressBlock({
        entityId: 'task-single-001',
        groupLabel: 'Implementation Plan',
        items: [
          {
            taskId: 'task-impl-001',
            taskKind: 'task',
            title: 'Implement response composition contract',
            owner: 'orchestration-engine',
            state: 'running',
            progress: 0.65,
          },
        ],
      }),
    }),
    makeFixture({
      id: 'task-multi-mixed-states',
      description: 'Multiple tasks in various states',
      block: taskProgressBlock({
        entityId: 'task-multi-001',
        groupLabel: 'Deployment Workflow',
        items: [
          {
            taskId: 'task-build-001',
            taskKind: 'job',
            title: 'Build artifacts',
            owner: 'ci-pipeline',
            state: 'completed',
            progress: 1.0,
            outcome: 'Built in 45s',
          },
          {
            taskId: 'task-test-001',
            taskKind: 'check',
            title: 'Run test suite',
            owner: 'ci-pipeline',
            state: 'running',
            progress: 0.8,
          },
          {
            taskId: 'task-deploy-001',
            taskKind: 'workflow',
            title: 'Deploy to staging',
            owner: 'deployment-engine',
            state: 'queued',
          },
          {
            taskId: 'task-verify-001',
            taskKind: 'check',
            title: 'Smoke tests',
            owner: 'deployment-engine',
            state: 'queued',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'task-indeterminate-progress',
      description: 'Task with no known progress (indeterminate)',
      lifecycle: 'streaming',
      block: taskProgressBlock({
        entityId: 'task-indet-001',
        items: [
          {
            taskId: 'task-search-001',
            taskKind: 'subagent',
            title: 'Researching codebase patterns',
            owner: 'search-agent',
            state: 'running',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'task-blocked',
      description: 'Task blocked waiting for dependency',
      block: taskProgressBlock({
        entityId: 'task-blocked-001',
        items: [
          {
            taskId: 'task-dep-001',
            taskKind: 'task',
            title: 'Apply database migration',
            owner: 'migration-agent',
            state: 'blocked',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'task-failed-with-outcome',
      description: 'Task that failed with outcome description',
      lifecycle: 'failed',
      block: taskProgressBlock({
        entityId: 'task-fail-001',
        items: [
          {
            taskId: 'task-lint-001',
            taskKind: 'check',
            title: 'Lint source files',
            owner: 'ci-pipeline',
            state: 'failed',
            outcome: '3 errors in formatting',
          },
        ],
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'task-cancelled-group',
      description: 'Plan group where remaining tasks were cancelled',
      lifecycle: 'cancelled',
      block: taskProgressBlock({
        entityId: 'task-cancel-001',
        groupLabel: 'Cancelled Plan',
        items: [
          {
            taskId: 'task-c1',
            taskKind: 'task',
            title: 'Step 1: Setup',
            owner: 'orchestration-engine',
            state: 'completed',
            progress: 1.0,
          },
          {
            taskId: 'task-c2',
            taskKind: 'task',
            title: 'Step 2: Execute',
            owner: 'orchestration-engine',
            state: 'cancelled',
          },
          {
            taskId: 'task-c3',
            taskKind: 'task',
            title: 'Step 3: Verify',
            owner: 'orchestration-engine',
            state: 'cancelled',
          },
        ],
        status: 'terminal',
      }),
    }),
  ],
};
