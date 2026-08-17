/**
 * Renderer Benchmark Measurements
 *
 * Implements measurement functions for all required performance metrics:
 * - Initial render time
 * - Keyed update time
 * - Input latency (composer response)
 * - Prepend stabilization time
 * - Scrolling frame time
 * - Cancellation time (deferred work)
 * - Steady-state memory usage
 *
 * All measurements compare against Settings_Service-configured budgets
 * and record source revision for traceability.
 *
 * Requirements: 47.9–47.11, 47.14, 47.18
 */

import type {
  BenchmarkFixtureConfig,
  MeasurementResult,
  MeasurementMetric,
  SessionSizeFixture,
  ViewportFixture,
  UpdateRateFixture,
  BenchmarkReport,
} from './types';
import type { SyntheticTimelineNode } from './fixture-generator';
import {
  generateTimeline,
  generateTimelineDelta,
  generatePrependNodes,
} from './fixture-generator';

// ─── Measurement Configuration ──────────────────────────────────

/** Number of warmup iterations before measured run. */
const WARMUP_ITERATIONS = 20;
/** Number of measured iterations for stable timing. */
const MEASURED_ITERATIONS = 50;

// ─── Core Measurement Utility ───────────────────────────────────

/**
 * Measure the median duration of a synchronous operation in milliseconds.
 * Uses warmup + measured iterations for JIT stability.
 */
export function measureMedianMs(fn: () => void): number {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    fn();
  }

  // Measured
  const durations: number[] = [];
  for (let i = 0; i < MEASURED_ITERATIONS; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    durations.push(end - start);
  }

  durations.sort((a, b) => a - b);
  return durations[Math.floor(durations.length / 2)] ?? 0;
}

/**
 * Measure peak memory delta of an operation in bytes.
 * Relies on Node.js process.memoryUsage() heapUsed.
 */
export function measureMemoryBytes(fn: () => unknown): number {
  // Force GC if available (node --expose-gc)
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const before = getHeapUsed();
  const result = fn();
  const after = getHeapUsed();

  // Keep reference alive to prevent premature GC
  void result;

  return Math.max(0, after - before);
}

function getHeapUsed(): number {
  if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
    return process.memoryUsage().heapUsed;
  }
  return 0;
}

// ─── Individual Metric Measurements ─────────────────────────────

/**
 * Measure initial render: time to process and lay out the full visible timeline
 * from an empty state to a populated windowed view.
 */
export function measureInitialRender(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  return measureMedianMs(() => {
    // Simulate initial render: process all nodes, compute visible window,
    // measure heights, and produce the windowed output.
    const visibleCount = computeVisibleNodeCount(timeline, viewport);
    const windowedNodes = timeline.slice(0, visibleCount);

    // Simulate layout computation per visible node
    for (const node of windowedNodes) {
      computeNodeLayout(node, viewport);
    }
  });
}

/**
 * Measure keyed update: time to process an incremental content update
 * to an existing mounted node without full re-render.
 */
export function measureKeyedUpdate(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  // Pre-compute the windowed view
  const visibleCount = computeVisibleNodeCount(timeline, viewport);
  const windowedNodes = timeline.slice(0, visibleCount);

  return measureMedianMs(() => {
    // Simulate keyed update: find the target node, diff content, update layout
    const targetIndex = Math.floor(windowedNodes.length / 2);
    const target = windowedNodes[targetIndex]!;
    const delta = generateTimelineDelta(windowedNodes, targetIndex);

    // Diff: compare stableKey, contentRevision
    if (delta.stableKey === target.stableKey && delta.contentRevision !== target.contentRevision) {
      computeNodeLayout(delta, viewport);
    }
  });
}

/**
 * Measure input latency: time from simulated keystroke to composed state update.
 */
export function measureInputLatency(
  timeline: SyntheticTimelineNode[],
  _viewport: ViewportFixture,
): number {
  // Simulate the input pipeline: validate input, update draft, recompute context items
  return measureMedianMs(() => {
    const draftText = 'User typing a message about code review ' + Date.now();
    const validated = validateInputText(draftText);
    computeContextImpact(validated, timeline.length);
  });
}

/**
 * Measure prepend: time to insert older nodes at the top of the timeline
 * and stabilize layout without scroll jump.
 */
export function measurePrepend(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  const prependCount = Math.min(20, Math.max(1, Math.floor(timeline.length * 0.1)));

  return measureMedianMs(() => {
    const prependNodes = generatePrependNodes(prependCount, timeline.length);

    // Simulate prepend: compute anchor, insert nodes, re-measure, restore anchor
    const anchorKey = timeline[0]?.stableKey;
    const anchorOffset = 0;

    // Insert at front
    const merged = [...prependNodes, ...timeline.slice(0, computeVisibleNodeCount(timeline, viewport))];

    // Re-compute layout for new nodes
    for (const node of prependNodes) {
      computeNodeLayout(node, viewport);
    }

    // Restore semantic anchor position
    restoreAnchor(merged, anchorKey, anchorOffset);
  });
}

/**
 * Measure scrolling frame: time to process a single scroll event
 * and update the windowed view.
 */
export function measureScrollingFrame(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  const visibleCount = computeVisibleNodeCount(timeline, viewport);

  return measureMedianMs(() => {
    // Simulate scroll: recalculate visible window range from new scroll offset
    const scrollOffset = Math.random() * (timeline.length - visibleCount);
    const newStart = Math.floor(scrollOffset);
    const newEnd = Math.min(newStart + visibleCount, timeline.length);

    // Compute layout for newly entering nodes
    for (let i = newStart; i < newEnd; i++) {
      const node = timeline[i];
      if (node && node.measuredHeightDip === 0) {
        computeNodeLayout(node, viewport);
      }
    }
  });
}

/**
 * Measure cancellation: time to cancel deferred rendering work
 * (e.g., syntax highlighting, diagram parsing) for nodes leaving the viewport.
 */
export function measureCancellation(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  const visibleCount = computeVisibleNodeCount(timeline, viewport);
  // Simulate deferred work tokens for nodes beyond viewport
  const deferredWork = timeline.slice(visibleCount).map((node) => ({
    stableKey: node.stableKey,
    kind: node.contentKind,
    cancelled: false,
  }));

  return measureMedianMs(() => {
    // Cancel all deferred work
    for (const work of deferredWork) {
      work.cancelled = true;
    }
    // Verify all cancelled
    const allCancelled = deferredWork.every((w) => w.cancelled);
    if (!allCancelled) {
      throw new Error('Cancellation incomplete');
    }
    // Reset for next iteration
    for (const work of deferredWork) {
      work.cancelled = false;
    }
  });
}

/**
 * Measure memory: steady-state heap usage when the full timeline is loaded
 * and the windowed view is active.
 */
export function measureMemory(
  sessionSize: SessionSizeFixture,
  viewport: ViewportFixture,
  requiredKinds: readonly string[],
): number {
  return measureMemoryBytes(() => {
    // Generate and retain the full timeline plus windowed view state
    const timeline = generateTimeline(sessionSize, requiredKinds as any);
    const visibleCount = computeVisibleNodeCount(timeline, viewport);
    const windowedView = timeline.slice(0, visibleCount).map((node) => ({
      ...node,
      layoutResult: computeNodeLayout(node, viewport),
    }));
    return { timeline, windowedView };
  });
}

// ─── Full Benchmark Execution ───────────────────────────────────

/**
 * Execute the complete benchmark suite for a single fixture combination.
 * Returns individual measurement results with pass/fail against budgets.
 */
export function executeBenchmark(
  sessionSize: SessionSizeFixture,
  viewport: ViewportFixture,
  updateRate: UpdateRateFixture,
  config: BenchmarkFixtureConfig,
): MeasurementResult[] {
  const timeline = generateTimeline(sessionSize, config.requiredContentKinds);
  const budget = config.budget;
  const results: MeasurementResult[] = [];

  const metrics: Array<{
    metric: MeasurementMetric;
    measure: () => number;
    threshold: number;
    unit: 'ms' | 'bytes';
  }> = [
    {
      metric: 'initial_render',
      measure: () => measureInitialRender(timeline, viewport),
      threshold: budget.initialRenderMs,
      unit: 'ms',
    },
    {
      metric: 'keyed_update',
      measure: () => measureKeyedUpdate(timeline, viewport),
      threshold: budget.keyedUpdateMs,
      unit: 'ms',
    },
    {
      metric: 'input_latency',
      measure: () => measureInputLatency(timeline, viewport),
      threshold: budget.inputLatencyMs,
      unit: 'ms',
    },
    {
      metric: 'prepend',
      measure: () => measurePrepend(timeline, viewport),
      threshold: budget.prependMs,
      unit: 'ms',
    },
    {
      metric: 'scrolling_frame',
      measure: () => measureScrollingFrame(timeline, viewport),
      threshold: budget.scrollingFrameMs,
      unit: 'ms',
    },
    {
      metric: 'cancellation',
      measure: () => measureCancellation(timeline, viewport),
      threshold: budget.cancellationMs,
      unit: 'ms',
    },
    {
      metric: 'memory',
      measure: () => measureMemory(sessionSize, viewport, config.requiredContentKinds),
      threshold: budget.memoryBytes,
      unit: 'bytes',
    },
  ];

  for (const { metric, measure, threshold, unit } of metrics) {
    const value = measure();
    results.push({
      metric,
      value,
      unit,
      budgetThreshold: threshold,
      passed: value <= threshold,
      sessionSizeTier: sessionSize.tier,
      viewportClass: viewport.viewportClass,
      updateRateProfile: updateRate.profile,
      sourceRevision: config.sourceRevision,
    });
  }

  return results;
}

/**
 * Execute the full benchmark suite across all fixture combinations and
 * produce a structured report.
 */
export function executeFullBenchmarkSuite(
  config: BenchmarkFixtureConfig,
): BenchmarkReport {
  const allMeasurements: MeasurementResult[] = [];

  for (const sessionSize of config.sessionSizes) {
    for (const viewport of config.viewports) {
      for (const updateRate of config.updateRates) {
        const results = executeBenchmark(sessionSize, viewport, updateRate, config);
        allMeasurements.push(...results);
      }
    }
  }

  return {
    sourceRevision: config.sourceRevision,
    executedAt: new Date().toISOString(),
    measurements: allMeasurements,
    allPassed: allMeasurements.every((m) => m.passed),
  };
}

// ─── Simulation Helpers ─────────────────────────────────────────

/**
 * Compute the number of visible nodes that fit in the viewport.
 */
function computeVisibleNodeCount(
  timeline: SyntheticTimelineNode[],
  viewport: ViewportFixture,
): number {
  if (timeline.length === 0) return 0;

  let totalHeight = 0;
  let count = 0;
  const availableHeight = viewport.heightPx / viewport.deviceScale;

  for (const node of timeline) {
    totalHeight += node.measuredHeightDip * viewport.textScale;
    count++;
    if (totalHeight >= availableHeight) break;
  }

  return Math.min(count, timeline.length);
}

/**
 * Simulate node layout computation (height measurement, position, overflow).
 */
function computeNodeLayout(
  node: SyntheticTimelineNode,
  viewport: ViewportFixture,
): { height: number; width: number; overflow: boolean } {
  const width = viewport.widthPx / viewport.deviceScale;
  const height = node.measuredHeightDip * viewport.textScale;
  const contentWidth = node.content.length * 7 * viewport.textScale; // approximate char width
  const overflow = contentWidth > width;

  return { height, width, overflow };
}

/**
 * Simulate text input validation (sanitization, length check).
 */
function validateInputText(text: string): string {
  // Simulate input pipeline: trim, validate length, check for injection
  const trimmed = text.trim();
  if (trimmed.length > 100_000) {
    return trimmed.slice(0, 100_000);
  }
  return trimmed;
}

/**
 * Simulate context impact computation from input change.
 */
function computeContextImpact(text: string, timelineLength: number): number {
  // Estimate token count for context budget
  const estimatedTokens = Math.ceil(text.length / 4);
  return estimatedTokens + timelineLength;
}

/**
 * Simulate semantic anchor restoration after prepend.
 */
function restoreAnchor(
  nodes: SyntheticTimelineNode[],
  anchorKey: string | undefined,
  _anchorOffset: number,
): { found: boolean; index: number } {
  if (!anchorKey) return { found: false, index: 0 };

  const index = nodes.findIndex((n) => n.stableKey === anchorKey);
  return { found: index >= 0, index: Math.max(0, index) };
}
