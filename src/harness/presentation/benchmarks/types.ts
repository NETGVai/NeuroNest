/**
 * Renderer Benchmark Types
 *
 * Types and schemas for Settings_Service-driven benchmark fixtures and
 * measurement results. All budgets and fixture definitions come from
 * Settings_Service configuration with source revision tracking.
 *
 * Requirements: 47.9–47.11, 47.14, 47.18
 */

import { z } from 'zod';
import { PositiveFiniteSchema } from '../../settings/operational-bounds-schema';

// ─── Content Kind ───────────────────────────────────────────────

/**
 * Declared content kinds that must be represented in benchmark fixtures.
 * Requirement 47.11: messages, nested tools, images, diffs, diagrams,
 * retries, queue entries, collaboration takeovers, and streaming updates.
 */
export const CONTENT_KINDS = [
  'message',
  'tool_call',
  'nested_tool',
  'diff',
  'image',
  'diagram',
  'terminal',
  'retry',
  'queue_entry',
  'collaboration_takeover',
  'streaming_update',
  'web_citation',
  'compaction_marker',
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

// ─── Session Size Fixture ───────────────────────────────────────

/**
 * Session sizes from smallest to stress tier.
 * Requirement 47.10: declared session-size fixtures.
 */
export const SESSION_SIZE_TIERS = ['small', 'medium', 'large', 'stress'] as const;
export type SessionSizeTier = (typeof SESSION_SIZE_TIERS)[number];

export const SessionSizeFixtureSchema = z.object({
  tier: z.enum(SESSION_SIZE_TIERS),
  nodeCount: z.number().int().positive(),
});

export type SessionSizeFixture = z.infer<typeof SessionSizeFixtureSchema>;

// ─── Viewport Fixture ───────────────────────────────────────────

export const VIEWPORT_CLASSES = ['narrow', 'tablet', 'desktop'] as const;
export type ViewportClass = (typeof VIEWPORT_CLASSES)[number];

export const ViewportFixtureSchema = z.object({
  viewportClass: z.enum(VIEWPORT_CLASSES),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  textScale: z.number().positive().finite(),
  deviceScale: z.number().positive().finite(),
});

export type ViewportFixture = z.infer<typeof ViewportFixtureSchema>;

// ─── Update Rate Fixture ────────────────────────────────────────

export const UPDATE_RATE_PROFILES = ['target_60fps', 'budget_30fps', 'burst'] as const;
export type UpdateRateProfile = (typeof UPDATE_RATE_PROFILES)[number];

export const UpdateRateFixtureSchema = z.object({
  profile: z.enum(UPDATE_RATE_PROFILES),
  /** Target interval between frames in milliseconds. */
  frameIntervalMs: PositiveFiniteSchema,
  /** Number of deltas to simulate in the measurement window. */
  deltaCount: z.number().int().positive(),
});

export type UpdateRateFixture = z.infer<typeof UpdateRateFixtureSchema>;

// ─── Performance Budget (from Settings_Service) ─────────────────

export const PerformanceBudgetSchema = z.object({
  /** Maximum allowed initial render time in milliseconds. */
  initialRenderMs: PositiveFiniteSchema,
  /** Maximum allowed keyed node update time in milliseconds. */
  keyedUpdateMs: PositiveFiniteSchema,
  /** Maximum allowed composer input response time in milliseconds. */
  inputLatencyMs: PositiveFiniteSchema,
  /** Maximum allowed page prepend stabilization time in milliseconds. */
  prependMs: PositiveFiniteSchema,
  /** Maximum allowed per-frame scrolling time in milliseconds. */
  scrollingFrameMs: PositiveFiniteSchema,
  /** Maximum allowed cancellation time for deferred work in milliseconds. */
  cancellationMs: PositiveFiniteSchema,
  /** Maximum allowed steady-state memory in bytes. */
  memoryBytes: PositiveFiniteSchema,
});

export type PerformanceBudget = z.infer<typeof PerformanceBudgetSchema>;

// ─── Complete Fixture Configuration ─────────────────────────────

export const BenchmarkFixtureConfigSchema = z.object({
  /** Source revision from Settings_Service. */
  sourceRevision: z.number().int().positive(),
  /** Session size fixtures keyed by tier. */
  sessionSizes: z.array(SessionSizeFixtureSchema).min(1),
  /** Viewport fixtures keyed by class. */
  viewports: z.array(ViewportFixtureSchema).min(1),
  /** Update rate profiles. */
  updateRates: z.array(UpdateRateFixtureSchema).min(1),
  /** Performance budgets. */
  budget: PerformanceBudgetSchema,
  /** Content kinds that must appear in generated timelines. */
  requiredContentKinds: z.array(z.enum(CONTENT_KINDS)).min(1),
});

export type BenchmarkFixtureConfig = z.infer<typeof BenchmarkFixtureConfigSchema>;

// ─── Measurement Result ─────────────────────────────────────────

export interface MeasurementResult {
  /** The metric being measured. */
  metric: MeasurementMetric;
  /** Measured value. */
  value: number;
  /** Unit of the measurement. */
  unit: 'ms' | 'bytes';
  /** Budget threshold from Settings_Service. */
  budgetThreshold: number;
  /** Whether the measurement passes the budget. */
  passed: boolean;
  /** Session size tier used for this measurement. */
  sessionSizeTier: SessionSizeTier;
  /** Viewport class used. */
  viewportClass: ViewportClass;
  /** Update rate profile used. */
  updateRateProfile: UpdateRateProfile;
  /** Source revision from Settings_Service. */
  sourceRevision: number;
}

export type MeasurementMetric =
  | 'initial_render'
  | 'keyed_update'
  | 'input_latency'
  | 'prepend'
  | 'scrolling_frame'
  | 'cancellation'
  | 'memory';

// ─── Benchmark Report ───────────────────────────────────────────

export interface BenchmarkReport {
  /** Settings_Service source revision used for all budgets/fixtures. */
  sourceRevision: number;
  /** Timestamp when the benchmark was executed. */
  executedAt: string;
  /** All individual measurements. */
  measurements: MeasurementResult[];
  /** Whether all measurements pass their budgets. */
  allPassed: boolean;
}
