/**
 * Deterministic structured data block fixtures.
 *
 * Covers tables with various column counts, viewport adaptations,
 * and bounded row sets.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { StructuredDataBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function structuredDataBlock(params: {
  entityId: string;
  dataId: string;
  caption?: string;
  columns: Array<{ columnId: string; label: string }>;
  rows: Array<{ rowId: string; label: string; values: (string | number | boolean | null)[] }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): StructuredDataBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'structured_data',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.projection,
    }),
    kind: 'structured_data',
    content: {
      dataId: params.dataId,
      ...(params.caption !== undefined && { caption: params.caption }),
      columns: params.columns,
      rows: params.rows,
    },
  };
}

export const structuredDataFixtures: GalleryFixtureSet = {
  kind: 'structured_data',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'data-simple-table',
      description: 'Simple 3-column table with scalar values',
      block: structuredDataBlock({
        entityId: 'data-simple-001',
        dataId: 'dataset-simple-001',
        caption: 'Dependency Versions',
        columns: [
          { columnId: 'col-name', label: 'Package' },
          { columnId: 'col-current', label: 'Current' },
          { columnId: 'col-latest', label: 'Latest' },
        ],
        rows: [
          { rowId: 'row-1', label: 'vitest', values: ['vitest', '4.1.10', '4.2.0'] },
          { rowId: 'row-2', label: 'typescript', values: ['typescript', '6.0.2', '6.1.0'] },
          { rowId: 'row-3', label: 'zod', values: ['zod', '3.23.0', '3.23.5'] },
        ],
      }),
    }),
    makeFixture({
      id: 'data-wide-table',
      description: 'Wide table with many columns requiring overflow',
      viewport: 'narrow',
      block: structuredDataBlock({
        entityId: 'data-wide-001',
        dataId: 'dataset-wide-001',
        caption: 'Performance Metrics Comparison',
        columns: [
          { columnId: 'col-metric', label: 'Metric' },
          { columnId: 'col-baseline', label: 'Baseline' },
          { columnId: 'col-current', label: 'Current' },
          { columnId: 'col-delta', label: 'Delta' },
          { columnId: 'col-budget', label: 'Budget' },
          { columnId: 'col-status', label: 'Status' },
        ],
        rows: [
          { rowId: 'row-render', label: 'Initial render', values: ['Initial render', 45, 38, -7, 50, 'pass'] },
          { rowId: 'row-stream', label: 'Stream update', values: ['Stream update', 12, 14, 2, 16, 'pass'] },
          { rowId: 'row-compose', label: 'Composer input', values: ['Composer input', 8, 9, 1, 10, 'pass'] },
          { rowId: 'row-memory', label: 'Steady memory', values: ['Steady memory (MB)', 128, 135, 7, 150, 'pass'] },
        ],
      }),
    }),
    makeFixture({
      id: 'data-boolean-null-values',
      description: 'Table with mixed types including booleans and nulls',
      block: structuredDataBlock({
        entityId: 'data-mixed-001',
        dataId: 'dataset-mixed-001',
        caption: 'Feature Flags',
        columns: [
          { columnId: 'col-flag', label: 'Flag' },
          { columnId: 'col-enabled', label: 'Enabled' },
          { columnId: 'col-rollout', label: 'Rollout %' },
          { columnId: 'col-owner', label: 'Owner' },
        ],
        rows: [
          { rowId: 'row-f1', label: 'structured-renderer', values: ['structured_response_renderer', false, 0, 'platform-team'] },
          { rowId: 'row-f2', label: 'chat-timeline', values: ['chat_timeline', true, 100, 'platform-team'] },
          { rowId: 'row-f3', label: 'new-composer', values: ['new_composer', true, 50, null] },
        ],
      }),
    }),
    makeFixture({
      id: 'data-single-row',
      description: 'Table with a single data row',
      block: structuredDataBlock({
        entityId: 'data-single-001',
        dataId: 'dataset-single-001',
        columns: [
          { columnId: 'col-key', label: 'Setting' },
          { columnId: 'col-value', label: 'Value' },
        ],
        rows: [
          { rowId: 'row-only', label: 'max-tokens', values: ['max_tokens', 4096] },
        ],
      }),
    }),
    makeFixture({
      id: 'data-many-rows',
      description: 'Table with many rows exceeding default display bounds',
      block: structuredDataBlock({
        entityId: 'data-many-001',
        dataId: 'dataset-many-001',
        caption: 'Test Results (25 cases)',
        columns: [
          { columnId: 'col-test', label: 'Test Case' },
          { columnId: 'col-result', label: 'Result' },
          { columnId: 'col-duration', label: 'Duration (ms)' },
        ],
        rows: Array.from({ length: 25 }, (_, i) => ({
          rowId: `row-test-${i + 1}`,
          label: `test-${i + 1}`,
          values: [`test_case_${i + 1}`, i % 5 === 0 ? 'failed' : 'passed', Math.round(10 + i * 3.7)] as (string | number)[],
        })),
      }),
    }),
    makeFixture({
      id: 'data-stale',
      description: 'Structured data that has become stale',
      authorityState: 'expired',
      block: structuredDataBlock({
        entityId: 'data-stale-001',
        dataId: 'dataset-stale-001',
        caption: 'Outdated Results',
        columns: [
          { columnId: 'col-item', label: 'Item' },
          { columnId: 'col-status', label: 'Status' },
        ],
        rows: [
          { rowId: 'row-s1', label: 'item-1', values: ['Component A', 'pending'] },
        ],
        status: 'stale',
      }),
    }),
  ],
};
