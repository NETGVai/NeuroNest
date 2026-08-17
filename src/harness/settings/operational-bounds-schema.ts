/**
 * Operational Bounds V1 — Zod schema for all configurable operational bounds.
 *
 * All values must be positive, finite numbers. No Infinity, NaN, zero, or negative.
 * Each bound category covers a distinct operational concern and is documented
 * with unit, supported range, and purpose via BoundDescriptor.
 *
 * NO hard-coded product limits. All bounds come from Settings_Service configuration.
 *
 * Requirements: 5.6, 7.4, 11.3, 14.2, 18.2, 22.4–22.8, 31.1, 36.5, 37.3, 40.14, 40.17, 42.4, 47.1, 47.9, 47.14–47.15, 47.20–47.21
 */

import { z } from 'zod';
import type { BoundDescriptor } from './bound-descriptor';

// ─── Primitive Bound Schema ─────────────────────────────────────

/**
 * A positive finite number — rejects Infinity, NaN, zero, and negatives.
 */
export const PositiveFiniteSchema = z.number().finite().positive();

// ─── Category Schemas ───────────────────────────────────────────

export const DatabaseBoundsSchema = z.object({
  busyTimeoutMs: PositiveFiniteSchema,
  walCheckpointThresholdPages: PositiveFiniteSchema,
});

export const TransactionBoundsSchema = z.object({
  maxDurationMs: PositiveFiniteSchema,
  maxStatements: PositiveFiniteSchema,
});

export const OutboxBoundsSchema = z.object({
  batchSize: PositiveFiniteSchema,
  pollIntervalMs: PositiveFiniteSchema,
});

export const ProjectionBoundsSchema = z.object({
  checkpointFrequency: PositiveFiniteSchema,
});

export const RendererBoundsSchema = z.object({
  mountLimit: PositiveFiniteSchema,
  updateRateMs: PositiveFiniteSchema,
});

export const PreviewBoundsSchema = z.object({
  sizeLimitBytes: PositiveFiniteSchema,
});

export const RetryBoundsSchema = z.object({
  maxAttempts: PositiveFiniteSchema,
  maxBackoffMs: PositiveFiniteSchema,
  initialDelayMs: PositiveFiniteSchema,
});

export const ConcurrencyBoundsSchema = z.object({
  parallelToolLimit: PositiveFiniteSchema,
});

export const LoopBoundsSchema = z.object({
  consecutiveCallThreshold: PositiveFiniteSchema,
  graceCount: PositiveFiniteSchema,
});

export const OrchestrationBoundsSchema = z.object({
  subagentLimit: PositiveFiniteSchema,
  budgetTokens: PositiveFiniteSchema,
});

export const SandboxBoundsSchema = z.object({
  timeoutMs: PositiveFiniteSchema,
  memoryLimitBytes: PositiveFiniteSchema,
});

export const AttachmentBoundsSchema = z.object({
  sizeLimitBytes: PositiveFiniteSchema,
  countLimit: PositiveFiniteSchema,
});

export const AccessibilityAnnouncementBoundsSchema = z.object({
  coalesceIntervalMs: PositiveFiniteSchema,
});

export const MeasurementFixtureBoundsSchema = z.object({
  budgetMs: PositiveFiniteSchema,
  budgetBytes: PositiveFiniteSchema,
});

// ─── Composite Schema ───────────────────────────────────────────

export const OperationalBoundsV1Schema = z.object({
  schemaVersion: z.literal(1),
  database: DatabaseBoundsSchema,
  transactions: TransactionBoundsSchema,
  outbox: OutboxBoundsSchema,
  projections: ProjectionBoundsSchema,
  renderer: RendererBoundsSchema,
  previews: PreviewBoundsSchema,
  retries: RetryBoundsSchema,
  concurrency: ConcurrencyBoundsSchema,
  loops: LoopBoundsSchema,
  orchestration: OrchestrationBoundsSchema,
  sandbox: SandboxBoundsSchema,
  attachment: AttachmentBoundsSchema,
  accessibilityAnnouncement: AccessibilityAnnouncementBoundsSchema,
  measurementFixture: MeasurementFixtureBoundsSchema,
});

export type OperationalBoundsV1 = z.infer<typeof OperationalBoundsV1Schema>;

// ─── Bound Descriptors Registry ─────────────────────────────────

/**
 * Complete registry of bound descriptors documenting each bound's unit, range, and purpose.
 * Used by Diagnostics_Service for inspection and validation feedback.
 */
export const BOUND_DESCRIPTORS: Readonly<Record<string, BoundDescriptor>> = {
  'database.busyTimeoutMs': {
    key: 'database.busyTimeoutMs',
    label: 'Database Busy Timeout',
    unit: 'milliseconds',
    min: 1,
    max: 60_000,
    purpose: 'Maximum time to wait for a locked database before returning a busy error',
    category: 'database',
  },
  'database.walCheckpointThresholdPages': {
    key: 'database.walCheckpointThresholdPages',
    label: 'WAL Checkpoint Threshold',
    unit: 'count',
    min: 1,
    max: 100_000,
    purpose: 'Number of WAL pages that triggers an automatic checkpoint',
    category: 'database',
  },
  'transactions.maxDurationMs': {
    key: 'transactions.maxDurationMs',
    label: 'Transaction Max Duration',
    unit: 'milliseconds',
    min: 1,
    max: 30_000,
    purpose: 'Maximum allowed duration of a database transaction before forced abort',
    category: 'transactions',
  },
  'transactions.maxStatements': {
    key: 'transactions.maxStatements',
    label: 'Transaction Max Statements',
    unit: 'count',
    min: 1,
    max: 10_000,
    purpose: 'Maximum number of SQL statements permitted in a single transaction',
    category: 'transactions',
  },
  'outbox.batchSize': {
    key: 'outbox.batchSize',
    label: 'Outbox Batch Size',
    unit: 'count',
    min: 1,
    max: 10_000,
    purpose: 'Maximum number of outbox records consumed per polling cycle',
    category: 'outbox',
  },
  'outbox.pollIntervalMs': {
    key: 'outbox.pollIntervalMs',
    label: 'Outbox Poll Interval',
    unit: 'milliseconds',
    min: 1,
    max: 60_000,
    purpose: 'Interval between outbox consumer polling cycles',
    category: 'outbox',
  },
  'projections.checkpointFrequency': {
    key: 'projections.checkpointFrequency',
    label: 'Projection Checkpoint Frequency',
    unit: 'count',
    min: 1,
    max: 100_000,
    purpose: 'Number of events processed between projection checkpoint writes',
    category: 'projections',
  },
  'renderer.mountLimit': {
    key: 'renderer.mountLimit',
    label: 'Renderer Mount Limit',
    unit: 'count',
    min: 1,
    max: 10_000,
    purpose: 'Maximum number of chat nodes mounted simultaneously in the viewport',
    category: 'renderer',
  },
  'renderer.updateRateMs': {
    key: 'renderer.updateRateMs',
    label: 'Renderer Update Rate',
    unit: 'milliseconds',
    min: 1,
    max: 5_000,
    purpose: 'Minimum interval between coalesced visual delta flushes',
    category: 'renderer',
  },
  'previews.sizeLimitBytes': {
    key: 'previews.sizeLimitBytes',
    label: 'Preview Size Limit',
    unit: 'bytes',
    min: 1,
    max: 104_857_600,
    purpose: 'Maximum size of a tool-spill preview returned to model context',
    category: 'previews',
  },
  'retries.maxAttempts': {
    key: 'retries.maxAttempts',
    label: 'Retry Max Attempts',
    unit: 'count',
    min: 1,
    max: 100,
    purpose: 'Maximum number of retry attempts for a retriable failure class',
    category: 'retries',
  },
  'retries.maxBackoffMs': {
    key: 'retries.maxBackoffMs',
    label: 'Retry Max Backoff',
    unit: 'milliseconds',
    min: 1,
    max: 300_000,
    purpose: 'Maximum backoff duration between retry attempts',
    category: 'retries',
  },
  'retries.initialDelayMs': {
    key: 'retries.initialDelayMs',
    label: 'Retry Initial Delay',
    unit: 'milliseconds',
    min: 1,
    max: 60_000,
    purpose: 'Initial delay before the first retry attempt',
    category: 'retries',
  },
  'concurrency.parallelToolLimit': {
    key: 'concurrency.parallelToolLimit',
    label: 'Parallel Tool Limit',
    unit: 'count',
    min: 1,
    max: 1_000,
    purpose: 'Maximum number of tool calls executing in parallel within a turn',
    category: 'concurrency',
  },
  'loops.consecutiveCallThreshold': {
    key: 'loops.consecutiveCallThreshold',
    label: 'Loop Consecutive Call Threshold',
    unit: 'count',
    min: 1,
    max: 1_000,
    purpose: 'Number of equivalent consecutive calls before Loop_Guard advisory',
    category: 'loops',
  },
  'loops.graceCount': {
    key: 'loops.graceCount',
    label: 'Loop Grace Count',
    unit: 'count',
    min: 1,
    max: 100,
    purpose: 'Additional equivalent calls allowed after advisory before intervention',
    category: 'loops',
  },
  'orchestration.subagentLimit': {
    key: 'orchestration.subagentLimit',
    label: 'Subagent Limit',
    unit: 'count',
    min: 1,
    max: 1_000,
    purpose: 'Maximum number of concurrent subagent delegations per session',
    category: 'orchestration',
  },
  'orchestration.budgetTokens': {
    key: 'orchestration.budgetTokens',
    label: 'Orchestration Budget',
    unit: 'tokens',
    min: 1,
    max: 10_000_000,
    purpose: 'Maximum token budget allocated across all subagent delegations',
    category: 'orchestration',
  },
  'sandbox.timeoutMs': {
    key: 'sandbox.timeoutMs',
    label: 'Sandbox Timeout',
    unit: 'milliseconds',
    min: 1,
    max: 600_000,
    purpose: 'Maximum execution time for sandbox-confined code',
    category: 'sandbox',
  },
  'sandbox.memoryLimitBytes': {
    key: 'sandbox.memoryLimitBytes',
    label: 'Sandbox Memory Limit',
    unit: 'bytes',
    min: 1,
    max: 4_294_967_296,
    purpose: 'Maximum memory allocation for sandbox-confined execution',
    category: 'sandbox',
  },
  'attachment.sizeLimitBytes': {
    key: 'attachment.sizeLimitBytes',
    label: 'Attachment Size Limit',
    unit: 'bytes',
    min: 1,
    max: 1_073_741_824,
    purpose: 'Maximum file size for a single attachment',
    category: 'attachment',
  },
  'attachment.countLimit': {
    key: 'attachment.countLimit',
    label: 'Attachment Count Limit',
    unit: 'count',
    min: 1,
    max: 10_000,
    purpose: 'Maximum number of attachments per session',
    category: 'attachment',
  },
  'accessibilityAnnouncement.coalesceIntervalMs': {
    key: 'accessibilityAnnouncement.coalesceIntervalMs',
    label: 'Accessibility Announcement Coalesce Interval',
    unit: 'milliseconds',
    min: 1000,
    max: 30_000,
    purpose: 'Minimum interval between coalesced accessibility announcements (never below 1s)',
    category: 'accessibilityAnnouncement',
  },
  'measurementFixture.budgetMs': {
    key: 'measurementFixture.budgetMs',
    label: 'Measurement Fixture Time Budget',
    unit: 'milliseconds',
    min: 1,
    max: 60_000,
    purpose: 'Maximum time allocated for measurement fixture operations',
    category: 'measurementFixture',
  },
  'measurementFixture.budgetBytes': {
    key: 'measurementFixture.budgetBytes',
    label: 'Measurement Fixture Size Budget',
    unit: 'bytes',
    min: 1,
    max: 1_073_741_824,
    purpose: 'Maximum output size for measurement fixture operations',
    category: 'measurementFixture',
  },
};

/**
 * Get a flat list of all bound descriptor keys.
 */
export function getAllBoundKeys(): string[] {
  return Object.keys(BOUND_DESCRIPTORS);
}

/**
 * Get a bound descriptor by its dot-notation key.
 */
export function getBoundDescriptor(key: string): BoundDescriptor | undefined {
  return BOUND_DESCRIPTORS[key];
}
