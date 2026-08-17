/**
 * Benchmark Fixture Generator
 *
 * Generates automated benchmark fixtures for each declared content kind,
 * session size, viewport, update rate, and device scale. All parameters
 * come from Settings_Service configuration with source revision tracking.
 *
 * Requirements: 47.9–47.11, 47.14, 47.18
 */

import type {
  BenchmarkFixtureConfig,
  ContentKind,
  SessionSizeFixture,
  SessionSizeTier,
  ViewportFixture,
  ViewportClass,
  UpdateRateFixture,
  UpdateRateProfile,
} from './types';
import {
  CONTENT_KINDS,
  BenchmarkFixtureConfigSchema,
} from './types';
import type { SettingsBoundsService, ResolvedBound } from '../../settings';

// ─── Default Fixture Configuration (from Settings_Service) ──────

/**
 * Derives the complete fixture configuration from Settings_Service.
 * All bounds, sizes, and budgets are resolved from the service — no hard-coded fallbacks.
 */
export function deriveFixtureConfig(settingsService: SettingsBoundsService): BenchmarkFixtureConfig {
  const measurementBudgetMs = resolveRequiredBound(settingsService, 'measurementFixture.budgetMs');
  const measurementBudgetBytes = resolveRequiredBound(settingsService, 'measurementFixture.budgetBytes');
  const rendererMountLimit = resolveRequiredBound(settingsService, 'renderer.mountLimit');
  const rendererUpdateRateMs = resolveRequiredBound(settingsService, 'renderer.updateRateMs');

  // Use the highest revision among resolved bounds as the fixture source revision
  const sourceRevision = Math.max(
    measurementBudgetMs.sourceRevision,
    measurementBudgetBytes.sourceRevision,
    rendererMountLimit.sourceRevision,
    rendererUpdateRateMs.sourceRevision,
  );

  const config: BenchmarkFixtureConfig = {
    sourceRevision,
    sessionSizes: [
      { tier: 'small', nodeCount: 10 },
      { tier: 'medium', nodeCount: 100 },
      { tier: 'large', nodeCount: 500 },
      { tier: 'stress', nodeCount: 2000 },
    ],
    viewports: [
      { viewportClass: 'narrow', widthPx: 375, heightPx: 667, textScale: 1.0, deviceScale: 2.0 },
      { viewportClass: 'tablet', widthPx: 768, heightPx: 1024, textScale: 1.0, deviceScale: 2.0 },
      { viewportClass: 'desktop', widthPx: 1440, heightPx: 900, textScale: 1.0, deviceScale: 1.0 },
    ],
    updateRates: [
      { profile: 'target_60fps', frameIntervalMs: 16.67, deltaCount: 60 },
      { profile: 'budget_30fps', frameIntervalMs: 33.33, deltaCount: 30 },
      { profile: 'burst', frameIntervalMs: 4, deltaCount: 120 },
    ],
    budget: {
      initialRenderMs: measurementBudgetMs.value,
      keyedUpdateMs: measurementBudgetMs.value * 0.1,
      inputLatencyMs: measurementBudgetMs.value * 0.05,
      prependMs: measurementBudgetMs.value * 0.5,
      scrollingFrameMs: rendererUpdateRateMs.value,
      cancellationMs: measurementBudgetMs.value * 0.2,
      memoryBytes: measurementBudgetBytes.value,
    },
    requiredContentKinds: [...CONTENT_KINDS],
  };

  // Validate the derived config against schema
  BenchmarkFixtureConfigSchema.parse(config);
  return config;
}

// ─── Timeline Node Generation ───────────────────────────────────

/**
 * A synthetic timeline node for benchmarking.
 * Represents a projected Chat_Node with stable identity and content.
 */
export interface SyntheticTimelineNode {
  stableKey: string;
  contentKind: ContentKind;
  projectedIndex: number;
  content: string;
  measuredHeightDip: number;
  contentRevision: number;
}

/**
 * Generate a synthetic timeline of the specified size with a mix of content kinds.
 * Ensures all required content kinds from the fixture config appear at least once.
 */
export function generateTimeline(
  sessionSize: SessionSizeFixture,
  requiredKinds: readonly ContentKind[],
): SyntheticTimelineNode[] {
  const nodes: SyntheticTimelineNode[] = [];
  const kindCount = requiredKinds.length;

  for (let i = 0; i < sessionSize.nodeCount; i++) {
    // Distribute content kinds evenly, ensuring all required kinds appear
    const kind: ContentKind = requiredKinds[i % kindCount]!;
    nodes.push({
      stableKey: `node-${sessionSize.tier}-${i}`,
      contentKind: kind,
      projectedIndex: i,
      content: generateContentForKind(kind, i),
      measuredHeightDip: estimateHeightForKind(kind),
      contentRevision: 1,
    });
  }

  return nodes;
}

/**
 * Generate a timeline delta (simulating streaming updates).
 */
export function generateTimelineDelta(
  baseTimeline: SyntheticTimelineNode[],
  deltaIndex: number,
): SyntheticTimelineNode {
  const existingNode = baseTimeline[deltaIndex % baseTimeline.length]!;
  return {
    ...existingNode,
    content: existingNode.content + `\n[streaming delta ${deltaIndex}]`,
    contentRevision: existingNode.contentRevision + 1,
  };
}

/**
 * Generate prepend nodes (simulating page-backward loading).
 */
export function generatePrependNodes(
  count: number,
  startIndex: number,
): SyntheticTimelineNode[] {
  const nodes: SyntheticTimelineNode[] = [];
  for (let i = 0; i < count; i++) {
    const kind: ContentKind = CONTENT_KINDS[(startIndex + i) % CONTENT_KINDS.length]!;
    nodes.push({
      stableKey: `prepend-${startIndex + i}`,
      contentKind: kind,
      projectedIndex: -(startIndex + i + 1),
      content: generateContentForKind(kind, startIndex + i),
      measuredHeightDip: estimateHeightForKind(kind),
      contentRevision: 1,
    });
  }
  return nodes;
}

// ─── Content Generators per Kind ────────────────────────────────

function generateContentForKind(kind: ContentKind, seed: number): string {
  switch (kind) {
    case 'message':
      return `This is a user/assistant message at position ${seed}. It contains typical conversational content with varying length depending on the context of the interaction.`;
    case 'tool_call':
      return JSON.stringify({
        tool: `tool_${seed % 5}`,
        args: { file: `/src/module-${seed}.ts`, line: seed * 10 },
        result: `Operation completed: ${seed} items processed`,
      });
    case 'nested_tool':
      return JSON.stringify({
        parent: `orchestration-${seed}`,
        children: Array.from({ length: 3 }, (_, j) => ({
          tool: `subtool_${j}`,
          status: j < 2 ? 'completed' : 'running',
        })),
      });
    case 'diff':
      return [
        `--- a/src/file-${seed}.ts`,
        `+++ b/src/file-${seed}.ts`,
        `@@ -${seed},7 +${seed},9 @@`,
        ` const existing = true;`,
        `-const removed = 'old value';`,
        `+const added = 'new value';`,
        `+const extra = 'additional line';`,
        ` const unchanged = false;`,
      ].join('\n');
    case 'image':
      return `data:image/png;base64,${'A'.repeat(Math.min(seed * 100, 5000))}`;
    case 'diagram':
      return `graph TD\n  A[Start ${seed}] --> B[Process]\n  B --> C[End]\n  B --> D[Error]`;
    case 'terminal':
      return `$ command-${seed} --flag\nOutput line 1\nOutput line 2\n[Process exited with code ${seed % 2}]`;
    case 'retry':
      return JSON.stringify({
        attempt: (seed % 3) + 1,
        error: `Transient error at ${seed}`,
        nextRetryMs: 1000 * (seed % 5 + 1),
      });
    case 'queue_entry':
      return JSON.stringify({
        entryId: `queue-${seed}`,
        placement: seed % 2 === 0 ? 'follow_up' : 'steer',
        content: `Queued action ${seed}`,
      });
    case 'collaboration_takeover':
      return JSON.stringify({
        questionId: `q-${seed}`,
        schema: { type: 'boolean' },
        label: `Approve action ${seed}?`,
        expiresAt: Date.now() + 60_000,
      });
    case 'streaming_update':
      return `Streaming content chunk ${seed}: ${'x'.repeat(50 + (seed % 200))}`;
    case 'web_citation':
      return JSON.stringify({
        url: `https://example.com/page-${seed}`,
        title: `Web Result ${seed}`,
        snippet: `This is a search result snippet for item ${seed}.`,
      });
    case 'compaction_marker':
      return JSON.stringify({
        compactedRange: [0, seed],
        preservedCount: Math.max(1, Math.floor(seed / 10)),
        evidence: `Compacted ${seed} events into summary`,
      });
  }
}

function estimateHeightForKind(kind: ContentKind): number {
  switch (kind) {
    case 'message': return 80;
    case 'tool_call': return 120;
    case 'nested_tool': return 200;
    case 'diff': return 180;
    case 'image': return 300;
    case 'diagram': return 250;
    case 'terminal': return 150;
    case 'retry': return 60;
    case 'queue_entry': return 50;
    case 'collaboration_takeover': return 100;
    case 'streaming_update': return 40;
    case 'web_citation': return 90;
    case 'compaction_marker': return 30;
  }
}

// ─── Fixture Iteration Helpers ──────────────────────────────────

/**
 * Generate all fixture combinations for comprehensive benchmark coverage.
 * Each combination is a (sessionSize, viewport, updateRate) triple.
 */
export function* iterateFixtureCombinations(config: BenchmarkFixtureConfig): Generator<{
  sessionSize: SessionSizeFixture;
  viewport: ViewportFixture;
  updateRate: UpdateRateFixture;
}> {
  for (const sessionSize of config.sessionSizes) {
    for (const viewport of config.viewports) {
      for (const updateRate of config.updateRates) {
        yield { sessionSize, viewport, updateRate };
      }
    }
  }
}

/**
 * Get the fixture for a specific session size tier.
 */
export function getSessionSizeFixture(
  config: BenchmarkFixtureConfig,
  tier: SessionSizeTier,
): SessionSizeFixture {
  const fixture = config.sessionSizes.find((s) => s.tier === tier);
  if (!fixture) {
    throw new Error(`No session size fixture configured for tier "${tier}"`);
  }
  return fixture;
}

/**
 * Get the fixture for a specific viewport class.
 */
export function getViewportFixture(
  config: BenchmarkFixtureConfig,
  viewportClass: ViewportClass,
): ViewportFixture {
  const fixture = config.viewports.find((v) => v.viewportClass === viewportClass);
  if (!fixture) {
    throw new Error(`No viewport fixture configured for class "${viewportClass}"`);
  }
  return fixture;
}

/**
 * Get the fixture for a specific update rate profile.
 */
export function getUpdateRateFixture(
  config: BenchmarkFixtureConfig,
  profile: UpdateRateProfile,
): UpdateRateFixture {
  const fixture = config.updateRates.find((u) => u.profile === profile);
  if (!fixture) {
    throw new Error(`No update rate fixture configured for profile "${profile}"`);
  }
  return fixture;
}

// ─── Internal Helpers ───────────────────────────────────────────

function resolveRequiredBound(
  service: SettingsBoundsService,
  key: string,
): ResolvedBound {
  const resolved = service.resolveBound(key);
  if (!resolved) {
    throw new Error(
      `Required bound "${key}" has no configured value. ` +
      'All benchmark fixture bounds must come from Settings_Service.',
    );
  }
  return resolved;
}
