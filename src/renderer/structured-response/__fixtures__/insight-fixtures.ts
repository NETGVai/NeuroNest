/**
 * Deterministic insight block fixtures.
 *
 * Covers metrics with complete data, missing fields,
 * time ranges, and accessible summaries.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { InsightBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function insightBlock(params: {
  entityId: string;
  insightId: string;
  title: string;
  metrics: Array<{
    metricId: string;
    label: string;
    value: number;
    unit: string;
  }>;
  timeRange?: string;
  accessibleSummary: string;
  sourceRevision: number;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): InsightBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'insight',
      entityId: params.entityId,
      role: 'evidence',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.projection,
    }),
    kind: 'insight',
    content: {
      insightId: params.insightId,
      title: params.title,
      metrics: params.metrics,
      ...(params.timeRange !== undefined && { timeRange: params.timeRange }),
      accessibleSummary: params.accessibleSummary,
      sourceRevision: params.sourceRevision,
    },
  };
}

export const insightFixtures: GalleryFixtureSet = {
  kind: 'insight',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'insight-complete-metrics',
      description: 'Insight with complete metrics, time range, and accessible summary',
      block: insightBlock({
        entityId: 'insight-complete-001',
        insightId: 'ins-complete-001',
        title: 'Session Token Usage',
        metrics: [
          { metricId: 'met-input', label: 'Input tokens', value: 12540, unit: 'tokens' },
          { metricId: 'met-output', label: 'Output tokens', value: 3280, unit: 'tokens' },
          { metricId: 'met-cost', label: 'Estimated cost', value: 0.042, unit: 'USD' },
        ],
        timeRange: '2026-08-17T09:00:00Z to 2026-08-17T10:00:00Z',
        accessibleSummary: 'This session used 12540 input tokens and 3280 output tokens over the past hour, with an estimated cost of 0.042 USD.',
        sourceRevision: 5,
      }),
    }),
    makeFixture({
      id: 'insight-single-metric',
      description: 'Insight with a single metric',
      block: insightBlock({
        entityId: 'insight-single-001',
        insightId: 'ins-single-001',
        title: 'Response Latency',
        metrics: [
          { metricId: 'met-latency', label: 'P95 latency', value: 1.23, unit: 'seconds' },
        ],
        accessibleSummary: 'The 95th percentile response latency is 1.23 seconds.',
        sourceRevision: 3,
      }),
    }),
    makeFixture({
      id: 'insight-no-time-range',
      description: 'Insight without time range (chart ineligible)',
      block: insightBlock({
        entityId: 'insight-notime-001',
        insightId: 'ins-notime-001',
        title: 'Memory Allocation',
        metrics: [
          { metricId: 'met-heap', label: 'Heap used', value: 142, unit: 'MB' },
          { metricId: 'met-rss', label: 'RSS', value: 210, unit: 'MB' },
        ],
        accessibleSummary: 'Current memory allocation shows 142 MB heap used and 210 MB RSS.',
        sourceRevision: 2,
      }),
    }),
    makeFixture({
      id: 'insight-many-metrics',
      description: 'Insight with many metrics for detailed view',
      block: insightBlock({
        entityId: 'insight-many-001',
        insightId: 'ins-many-001',
        title: 'Rendering Performance',
        metrics: [
          { metricId: 'met-fcp', label: 'First contentful paint', value: 38, unit: 'ms' },
          { metricId: 'met-lcp', label: 'Largest contentful paint', value: 120, unit: 'ms' },
          { metricId: 'met-tbt', label: 'Total blocking time', value: 5, unit: 'ms' },
          { metricId: 'met-cls', label: 'Cumulative layout shift', value: 0.01, unit: 'score' },
          { metricId: 'met-inp', label: 'Interaction to next paint', value: 45, unit: 'ms' },
        ],
        timeRange: '2026-08-17T10:00:00Z to 2026-08-17T10:05:00Z',
        accessibleSummary: 'Rendering performance over 5 minutes: FCP 38ms, LCP 120ms, TBT 5ms, CLS 0.01, INP 45ms. All within budget.',
        sourceRevision: 8,
      }),
    }),
    makeFixture({
      id: 'insight-stale',
      description: 'Insight with stale data',
      authorityState: 'expired',
      block: insightBlock({
        entityId: 'insight-stale-001',
        insightId: 'ins-stale-001',
        title: 'Outdated Usage Data',
        metrics: [
          { metricId: 'met-old', label: 'Requests', value: 1500, unit: 'count' },
        ],
        accessibleSummary: 'Usage data from a previous session showing 1500 requests.',
        sourceRevision: 1,
        status: 'stale',
      }),
    }),
  ],
};
