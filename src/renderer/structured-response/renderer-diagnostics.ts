import { z } from 'zod';
import {
  DiagnosticEntityKindV1Schema,
  DiagnosticScopeV1Schema,
  OpaqueResponseIdSchema,
  RedactedDiagnosticReasonCodeV1Schema,
  ResponseDigestSchema,
  type DiagnosticScopeV1,
  type RedactedDiagnosticReasonCodeV1,
  type RedactedDiagnosticV1,
} from '../../harness/contracts/response-support';

/**
 * Structured renderer diagnostics service.
 *
 * Emits redacted adapter/projection/fallback/render/coalescing/window/anchor/
 * focus/announcement/command/inspector/performance/gate metrics with versions,
 * counts, timings, hashes, reason codes, and authority correlation.
 *
 * All content is strictly redacted: no raw text, arguments, output, paths, URLs,
 * prompts, hidden reasoning, secrets, or locators appear in any metric record or
 * export.
 *
 * Cardinality and retention are bounded with configurable limits. Rate limiting
 * prevents diagnostic flood per projection revision.
 *
 * Requirements: 2.4, 19.9, 20.7-20.8, 22.7, 22.10
 */

// ─── Metric Subsystem Categories ───────────────────────────────────────────

export const MetricSubsystemSchema = z.enum([
  'adapter',
  'projection',
  'fallback',
  'render',
  'coalescing',
  'window',
  'anchor',
  'focus',
  'announcement',
  'command',
  'inspector',
  'performance',
  'gate',
]);

export type MetricSubsystem = z.infer<typeof MetricSubsystemSchema>;

// ─── Metric Record Schema ──────────────────────────────────────────────────

export const RendererMetricV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    metricId: OpaqueResponseIdSchema,
    subsystem: MetricSubsystemSchema,
    eventKind: z.string().min(1).max(64),
    projectionRevision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().nonnegative().optional(),
    contractVersion: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
    contentDigest: ResponseDigestSchema.optional(),
    reasonCode: RedactedDiagnosticReasonCodeV1Schema.optional(),
    entityKind: DiagnosticEntityKindV1Schema.optional(),
    scope: DiagnosticScopeV1Schema.optional(),
    authorityCorrelation: OpaqueResponseIdSchema.optional(),
    timestamp: z.number().int().positive(),
  })
  .strict();

export type RendererMetricV1 = z.infer<typeof RendererMetricV1Schema>;

// ─── Diagnostics Export Schema ─────────────────────────────────────────────

export const RendererDiagnosticsExportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    metrics: z.array(RendererMetricV1Schema),
    configuredBounds: z.object({
      maxMetrics: z.number().int().positive(),
      maxMetricsPerRevision: z.number().int().positive(),
      maxTrackedRevisions: z.number().int().positive(),
      retentionWindowMs: z.number().int().positive(),
    }).strict(),
    effectiveBounds: z.object({
      currentMetricCount: z.number().int().nonnegative(),
      currentRevisionCount: z.number().int().nonnegative(),
      oldestTimestamp: z.number().int().nonnegative(),
    }).strict(),
    activationBlockers: z.array(z.string().min(1).max(128)),
    suppressedByRateLimit: z.number().int().nonnegative(),
    droppedByCardinality: z.number().int().nonnegative(),
    droppedByRetention: z.number().int().nonnegative(),
  })
  .strict();

export type RendererDiagnosticsExportV1 = z.infer<typeof RendererDiagnosticsExportV1Schema>;

// ─── Metric Input ──────────────────────────────────────────────────────────

export interface RendererMetricInput {
  readonly subsystem: MetricSubsystem;
  readonly eventKind: string;
  readonly projectionRevision: number;
  readonly sourceRevision?: number;
  readonly contractVersion?: number;
  readonly count?: number;
  readonly durationMs?: number;
  readonly contentDigest?: string;
  readonly reasonCode?: RedactedDiagnosticReasonCodeV1;
  readonly entityKind?: string;
  readonly scope?: DiagnosticScopeV1;
  readonly authorityCorrelation?: string;
}

// ─── Configuration ─────────────────────────────────────────────────────────

export interface RendererDiagnosticsConfig {
  readonly maxMetrics?: number;
  readonly maxMetricsPerRevision?: number;
  readonly maxTrackedRevisions?: number;
  readonly retentionWindowMs?: number;
  readonly hashSalt?: string;
  readonly nowFn?: () => number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_METRICS = 512;
const DEFAULT_MAX_METRICS_PER_REVISION = 16;
const DEFAULT_MAX_TRACKED_REVISIONS = 64;
const DEFAULT_RETENTION_WINDOW_MS = 300_000; // 5 minutes
const MAX_ALLOWED_METRICS = 4_096;
const MAX_ALLOWED_PER_REVISION = 256;
const MAX_ALLOWED_REVISIONS = 512;
const MAX_RETENTION_MS = 3_600_000; // 1 hour

// ─── Helpers ───────────────────────────────────────────────────────────────

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min) {
    return Math.min(value, max);
  }
  return fallback;
}

function generateMetricId(salt: string, key: string, counter: number): string {
  // Deterministic opaque ID based on salt, key, and counter
  const raw = `${salt}\u0000metric-v1\u0000${key}\u0000${counter}`;
  // Simple FNV-1a hash for short opaque IDs (no need for cryptographic strength here)
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `rdiag-${hex}${counter.toString(16).padStart(6, '0')}`;
}

function defaultSalt(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `rdiag-${Date.now()}-${Math.random()}`;
  }
}

/** Patterns that indicate the event kind contains sensitive content. */
const SENSITIVE_EVENT_KIND_PATTERN =
  /(?:\/[A-Za-z]|[A-Za-z]:[\\/]|https?:|ftp:|file:|\\\\[^\s]|api[_-]?key|password|secret|bearer|token=|\.env\b|\.ssh|\.pem|id_rsa|chain[- ]of[- ]thought|system\s*prompt)/i;

function sanitizeEventKind(value: string): string {
  // If the event kind looks like it contains a path, URL, secret, or prompt, redact it entirely.
  if (SENSITIVE_EVENT_KIND_PATTERN.test(value)) {
    return 'redacted_event';
  }
  // Only alphanumeric, underscore, dash, dot allowed; bounded length
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return cleaned.slice(0, 64) || 'unknown';
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Bounded in-memory diagnostic metrics collector for all renderer subsystems.
 *
 * Metrics contain only redacted versions, counts, timings, hashes, reason codes,
 * and authority correlation. No raw content, arguments, paths, prompts, URLs,
 * locators, secrets, or hidden reasoning is ever recorded.
 *
 * Cardinality is bounded globally and per-revision. Retention enforces a sliding
 * time window. Rate limiting caps emissions per projection revision.
 */
export class RendererDiagnosticsService {
  private readonly maxMetrics: number;
  private readonly maxMetricsPerRevision: number;
  private readonly maxTrackedRevisions: number;
  private readonly retentionWindowMs: number;
  private readonly salt: string;
  private readonly nowFn: () => number;

  private readonly metrics: RendererMetricV1[] = [];
  private readonly revisionCounts = new Map<number, number>();
  private counter = 0;
  private suppressedByRateLimit = 0;
  private droppedByCardinality = 0;
  private droppedByRetention = 0;
  private activationBlockers: string[] = [];

  constructor(config: RendererDiagnosticsConfig = {}) {
    this.maxMetrics = boundedInt(config.maxMetrics, DEFAULT_MAX_METRICS, 1, MAX_ALLOWED_METRICS);
    this.maxMetricsPerRevision = boundedInt(
      config.maxMetricsPerRevision,
      DEFAULT_MAX_METRICS_PER_REVISION,
      1,
      MAX_ALLOWED_PER_REVISION,
    );
    this.maxTrackedRevisions = boundedInt(
      config.maxTrackedRevisions,
      DEFAULT_MAX_TRACKED_REVISIONS,
      1,
      MAX_ALLOWED_REVISIONS,
    );
    this.retentionWindowMs = boundedInt(
      config.retentionWindowMs,
      DEFAULT_RETENTION_WINDOW_MS,
      1_000,
      MAX_RETENTION_MS,
    );
    this.salt =
      typeof config.hashSalt === 'string' && config.hashSalt.length > 0
        ? config.hashSalt.slice(0, 256)
        : defaultSalt();
    this.nowFn = typeof config.nowFn === 'function' ? config.nowFn : () => Date.now();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Record a renderer metric. Returns whether the metric was accepted (not
   * suppressed by rate limiting or cardinality bounds).
   */
  record(input: RendererMetricInput): boolean {
    const now = this.nowFn();
    this.evictExpired(now);

    const projectionRevision = isFiniteNonnegative(input.projectionRevision)
      ? Math.floor(input.projectionRevision)
      : 0;

    // Rate limit per revision
    if (!this.reserveRevisionSlot(projectionRevision)) {
      this.suppressedByRateLimit += 1;
      return false;
    }

    // Cardinality bound - evict oldest if at capacity
    if (this.metrics.length >= this.maxMetrics) {
      this.metrics.shift();
      this.droppedByCardinality += 1;
    }

    const subsystemResult = MetricSubsystemSchema.safeParse(input.subsystem);
    const subsystem: MetricSubsystem = subsystemResult.success ? subsystemResult.data : 'render';
    const eventKind = sanitizeEventKind(input.eventKind || 'unknown');

    this.counter += 1;
    const metricId = generateMetricId(this.salt, `${subsystem}.${eventKind}`, this.counter);

    const metric: RendererMetricV1 = {
      schemaVersion: 1,
      metricId,
      subsystem,
      eventKind,
      projectionRevision,
      count: isFiniteNonnegative(input.count) ? Math.floor(input.count) : 1,
      timestamp: now,
      ...(isFiniteNonnegative(input.sourceRevision)
        ? { sourceRevision: Math.floor(input.sourceRevision!) }
        : {}),
      ...(isFiniteNonnegative(input.contractVersion)
        ? { contractVersion: Math.floor(input.contractVersion!) }
        : {}),
      ...(isFiniteNonnegative(input.durationMs) ? { durationMs: input.durationMs } : {}),
      ...(typeof input.contentDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.contentDigest)
        ? { contentDigest: input.contentDigest }
        : {}),
      ...(input.reasonCode &&
      RedactedDiagnosticReasonCodeV1Schema.safeParse(input.reasonCode).success
        ? { reasonCode: input.reasonCode }
        : {}),
      ...(input.entityKind &&
      DiagnosticEntityKindV1Schema.safeParse(input.entityKind).success
        ? { entityKind: input.entityKind as RendererMetricV1['entityKind'] }
        : {}),
      ...(input.scope && DiagnosticScopeV1Schema.safeParse(input.scope).success
        ? { scope: input.scope }
        : {}),
      ...(typeof input.authorityCorrelation === 'string' &&
      OpaqueResponseIdSchema.safeParse(input.authorityCorrelation).success
        ? { authorityCorrelation: input.authorityCorrelation }
        : {}),
    };

    this.metrics.push(metric);
    return true;
  }

  // ─── Convenience Subsystem Recorders ───────────────────────────────────

  recordAdapter(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'adapter', eventKind, projectionRevision: revision, ...extra });
  }

  recordProjection(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'projection', eventKind, projectionRevision: revision, ...extra });
  }

  recordFallback(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'fallback', eventKind, projectionRevision: revision, ...extra });
  }

  recordRender(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'render', eventKind, projectionRevision: revision, ...extra });
  }

  recordCoalescing(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'coalescing', eventKind, projectionRevision: revision, ...extra });
  }

  recordWindow(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'window', eventKind, projectionRevision: revision, ...extra });
  }

  recordAnchor(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'anchor', eventKind, projectionRevision: revision, ...extra });
  }

  recordFocus(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'focus', eventKind, projectionRevision: revision, ...extra });
  }

  recordAnnouncement(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'announcement', eventKind, projectionRevision: revision, ...extra });
  }

  recordCommand(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'command', eventKind, projectionRevision: revision, ...extra });
  }

  recordInspector(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'inspector', eventKind, projectionRevision: revision, ...extra });
  }

  recordPerformance(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'performance', eventKind, projectionRevision: revision, ...extra });
  }

  recordGate(eventKind: string, revision: number, extra?: Partial<RendererMetricInput>): boolean {
    return this.record({ subsystem: 'gate', eventKind, projectionRevision: revision, ...extra });
  }

  // ─── Activation Blockers ───────────────────────────────────────────────

  setActivationBlockers(blockers: readonly string[]): void {
    this.activationBlockers = blockers
      .filter((b) => typeof b === 'string' && b.length > 0)
      .map((b) => b.slice(0, 128))
      .slice(0, 32);
  }

  getActivationBlockers(): readonly string[] {
    return [...this.activationBlockers];
  }

  // ─── Export ────────────────────────────────────────────────────────────

  export(): RendererDiagnosticsExportV1 {
    const now = this.nowFn();
    this.evictExpired(now);

    const oldestTimestamp = this.metrics.length > 0 ? (this.metrics[0]?.timestamp ?? 0) : 0;

    return {
      schemaVersion: 1,
      metrics: this.metrics.map((m) => ({ ...m })),
      configuredBounds: {
        maxMetrics: this.maxMetrics,
        maxMetricsPerRevision: this.maxMetricsPerRevision,
        maxTrackedRevisions: this.maxTrackedRevisions,
        retentionWindowMs: this.retentionWindowMs,
      },
      effectiveBounds: {
        currentMetricCount: this.metrics.length,
        currentRevisionCount: this.revisionCounts.size,
        oldestTimestamp,
      },
      activationBlockers: [...this.activationBlockers],
      suppressedByRateLimit: this.suppressedByRateLimit,
      droppedByCardinality: this.droppedByCardinality,
      droppedByRetention: this.droppedByRetention,
    };
  }

  /**
   * Returns the current metric count without triggering eviction.
   */
  getMetricCount(): number {
    return this.metrics.length;
  }

  /**
   * Clear all metrics and counters. Used for testing and reset scenarios.
   */
  reset(): void {
    this.metrics.length = 0;
    this.revisionCounts.clear();
    this.counter = 0;
    this.suppressedByRateLimit = 0;
    this.droppedByCardinality = 0;
    this.droppedByRetention = 0;
    this.activationBlockers = [];
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private evictExpired(now: number): void {
    const cutoff = now - this.retentionWindowMs;
    let evicted = 0;
    while (this.metrics.length > 0 && (this.metrics[0]?.timestamp ?? now) < cutoff) {
      const removed = this.metrics.shift();
      if (removed) {
        const count = this.revisionCounts.get(removed.projectionRevision) ?? 0;
        if (count <= 1) {
          this.revisionCounts.delete(removed.projectionRevision);
        } else {
          this.revisionCounts.set(removed.projectionRevision, count - 1);
        }
      }
      evicted += 1;
    }
    if (evicted > 0) {
      this.droppedByRetention += evicted;
    }
  }

  private reserveRevisionSlot(revision: number): boolean {
    const count = this.revisionCounts.get(revision) ?? 0;
    if (count >= this.maxMetricsPerRevision) {
      return false;
    }

    // Evict oldest tracked revision if at capacity
    if (!this.revisionCounts.has(revision) && this.revisionCounts.size >= this.maxTrackedRevisions) {
      const oldest = this.revisionCounts.keys().next().value as number | undefined;
      if (oldest !== undefined) {
        this.revisionCounts.delete(oldest);
      }
    }

    this.revisionCounts.set(revision, count + 1);
    return true;
  }
}
