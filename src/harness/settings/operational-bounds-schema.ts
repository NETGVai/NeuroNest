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
  readableWidthDip: PositiveFiniteSchema,
  minimumMainColumnWidthDip: PositiveFiniteSchema,
  mountedNodeBound: PositiveFiniteSchema,
  overscanNodeCount: PositiveFiniteSchema,
  focusRetentionAllowance: PositiveFiniteSchema,
  pageSize: PositiveFiniteSchema,
  streamCoalesceMs: PositiveFiniteSchema,
  markdownCollapseChars: PositiveFiniteSchema,
  codeMaxHeightDip: PositiveFiniteSchema,
  previewMaxChars: PositiveFiniteSchema,
  tableInitialRows: PositiveFiniteSchema,
  inspectorMaxWidthDip: PositiveFiniteSchema,
  viewportMarginDip: PositiveFiniteSchema,
  layoutStabilizationTimeoutMs: PositiveFiniteSchema,
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
  'renderer.readableWidthDip': {
    key: 'renderer.readableWidthDip',
    label: 'Readable Column Width',
    unit: 'dip',
    min: 300,
    max: 2400,
    purpose: 'Maximum readable width of the centered chat reading column',
    category: 'renderer',
  },
  'renderer.minimumMainColumnWidthDip': {
    key: 'renderer.minimumMainColumnWidthDip',
    label: 'Minimum Main Column Width',
    unit: 'dip',
    min: 200,
    max: 1200,
    purpose: 'Minimum width of the main column before inspector switches to dialog mode',
    category: 'renderer',
  },
  'renderer.mountedNodeBound': {
    key: 'renderer.mountedNodeBound',
    label: 'Mounted Node Bound',
    unit: 'count',
    min: 1,
    max: 5_000,
    purpose: 'Maximum number of chat nodes simultaneously mounted in the windowed timeline',
    category: 'renderer',
  },
  'renderer.overscanNodeCount': {
    key: 'renderer.overscanNodeCount',
    label: 'Overscan Node Count',
    unit: 'count',
    min: 1,
    max: 500,
    purpose: 'Number of nodes rendered beyond the visible viewport edges for smooth scrolling',
    category: 'renderer',
  },
  'renderer.focusRetentionAllowance': {
    key: 'renderer.focusRetentionAllowance',
    label: 'Focus Retention Allowance',
    unit: 'count',
    min: 1,
    max: 200,
    purpose: 'Maximum number of additional rows kept mounted to retain focused content',
    category: 'renderer',
  },
  'renderer.pageSize': {
    key: 'renderer.pageSize',
    label: 'Page Size',
    unit: 'count',
    min: 1,
    max: 1_000,
    purpose: 'Number of chat nodes loaded per page query from the projection service',
    category: 'renderer',
  },
  'renderer.streamCoalesceMs': {
    key: 'renderer.streamCoalesceMs',
    label: 'Stream Coalesce Interval',
    unit: 'milliseconds',
    min: 1,
    max: 2_000,
    purpose: 'Minimum interval between coalesced visual updates during streaming',
    category: 'renderer',
  },
  'renderer.markdownCollapseChars': {
    key: 'renderer.markdownCollapseChars',
    label: 'Markdown Collapse Threshold',
    unit: 'count',
    min: 100,
    max: 100_000,
    purpose: 'Character threshold above which narrative content shows expand/collapse controls',
    category: 'renderer',
  },
  'renderer.codeMaxHeightDip': {
    key: 'renderer.codeMaxHeightDip',
    label: 'Code Block Max Height',
    unit: 'dip',
    min: 50,
    max: 5_000,
    purpose: 'Initial maximum height for code artifact surfaces before expand',
    category: 'renderer',
  },
  'renderer.previewMaxChars': {
    key: 'renderer.previewMaxChars',
    label: 'Preview Max Characters',
    unit: 'count',
    min: 50,
    max: 100_000,
    purpose: 'Maximum characters shown in preview or collapsed content surfaces',
    category: 'renderer',
  },
  'renderer.tableInitialRows': {
    key: 'renderer.tableInitialRows',
    label: 'Table Initial Rows',
    unit: 'count',
    min: 1,
    max: 500,
    purpose: 'Number of data table rows initially visible before requiring user expansion',
    category: 'renderer',
  },
  'renderer.inspectorMaxWidthDip': {
    key: 'renderer.inspectorMaxWidthDip',
    label: 'Inspector Max Width',
    unit: 'dip',
    min: 200,
    max: 2400,
    purpose: 'Maximum width of the detail inspector pane',
    category: 'renderer',
  },
  'renderer.viewportMarginDip': {
    key: 'renderer.viewportMarginDip',
    label: 'Viewport Margin',
    unit: 'dip',
    min: 1,
    max: 2_000,
    purpose: 'Margin beyond the visible viewport within which lazy work may begin',
    category: 'renderer',
  },
  'renderer.layoutStabilizationTimeoutMs': {
    key: 'renderer.layoutStabilizationTimeoutMs',
    label: 'Layout Stabilization Timeout',
    unit: 'milliseconds',
    min: 1,
    max: 5_000,
    purpose: 'Maximum time to wait for layout to stabilize after mutation before restoring anchor',
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
