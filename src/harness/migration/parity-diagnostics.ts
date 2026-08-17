/**
 * Parity Diagnostics
 *
 * Publishes redacted parity diagnostics from the shadow comparison
 * without changing visible rendering. Diagnostics expose structural
 * divergences between the legacy reducer output and the new canonical
 * projection output while redacting any user content, secrets, or
 * private paths.
 *
 * The diagnostics service:
 * - Receives comparison results from ShadowProjectionRunner
 * - Redacts all content fields (only structural/type info is retained)
 * - Publishes to Diagnostics_Service-compatible channels
 * - Tracks parity health over time (rolling window)
 * - Does NOT affect visible rendering in any way
 *
 * Requirements: 1.3–1.5, 29.5–29.8, 35.1–35.4
 */

import type { ParityComparisonResult, ParityDivergence } from './shadow-projection-runner.js';
import type { AdaptationStats } from './legacy-session-adapter.js';
import type { WriterStats } from './canonical-event-writer.js';

// ─── Configuration ──────────────────────────────────────────────

export interface ParityDiagnosticsConfig {
  /** Maximum number of diagnostic records to retain */
  maxRetainedRecords?: number;
  /** Rolling window size for parity health calculation */
  healthWindowSize?: number;
  /** Threshold ratio below which parity is considered unhealthy */
  parityHealthThreshold?: number;
  /** Whether to include expected divergences in health calculation */
  includeExpectedInHealth?: boolean;
}

// ─── Diagnostic Record ──────────────────────────────────────────

/**
 * A single parity diagnostic record, redacted and safe for exposure
 * through Diagnostics_Service.
 */
export interface ParityDiagnosticRecord {
  /** Unique diagnostic ID */
  diagnosticId: string;
  /** Session being diagnosed */
  sessionId: string;
  /** Timestamp of the diagnostic */
  timestamp: string;
  /** Whether parity was achieved */
  parityAchieved: boolean;
  /** Total events compared */
  totalEvents: number;
  /** Number of matching events */
  matchingEvents: number;
  /** Parity ratio (matchingEvents / totalEvents) */
  parityRatio: number;
  /** Count of unexpected divergences */
  unexpectedDivergenceCount: number;
  /** Count of expected divergences (known lossy translations) */
  expectedDivergenceCount: number;
  /** Redacted divergence summaries (no content, only structure) */
  divergenceSummaries: RedactedDivergenceSummary[];
  /** Adaptation stats snapshot */
  adaptationSnapshot: AdaptationStats;
  /** Writer stats snapshot (if available) */
  writerSnapshot?: WriterStats;
  /** Migration phase */
  phase: MigrationPhase;
}

/**
 * Redacted divergence summary — contains no user content.
 */
export interface RedactedDivergenceSummary {
  kind: string;
  count: number;
  expected: boolean;
  /** Redacted description with content stripped */
  redactedDescription: string;
}

export type MigrationPhase =
  | 'shadow_comparison'
  | 'dual_write'
  | 'canonical_primary'
  | 'legacy_retired';

// ─── Health Report ──────────────────────────────────────────────

/**
 * Rolling parity health report across recent comparisons.
 */
export interface ParityHealthReport {
  /** Whether parity health is acceptable */
  healthy: boolean;
  /** Number of comparisons in the window */
  windowSize: number;
  /** Ratio of comparisons that achieved parity */
  parityAchievementRatio: number;
  /** Average parity ratio across comparisons */
  averageParityRatio: number;
  /** Most common divergence kinds in the window */
  topDivergenceKinds: Array<{ kind: string; count: number }>;
  /** Total unexpected divergences in window */
  totalUnexpectedDivergences: number;
  /** Report generation timestamp */
  generatedAt: string;
}

// ─── Parity Diagnostics Service ─────────────────────────────────

/**
 * ParityDiagnostics receives shadow comparison results and produces
 * redacted diagnostic records suitable for Diagnostics_Service exposure.
 *
 * It maintains a rolling history window for health assessment and
 * provides a structured view of migration parity without exposing
 * any user content, secrets, or private paths.
 */
export class ParityDiagnostics {
  private readonly config: ParityDiagnosticsConfig;
  private readonly records: ParityDiagnosticRecord[] = [];
  private diagnosticCounter = 0;

  constructor(config: ParityDiagnosticsConfig = {}) {
    this.config = config;
  }

  /**
   * Record a parity comparison result as a diagnostic.
   *
   * Redacts content from divergences and retains only structural info.
   */
  recordComparison(
    result: ParityComparisonResult,
    adaptationStats: AdaptationStats,
    writerStats?: WriterStats,
    phase: MigrationPhase = 'shadow_comparison'
  ): ParityDiagnosticRecord {
    this.diagnosticCounter++;

    const divergenceSummaries = this.summarizeDivergences(result.divergences);
    const unexpectedCount = result.divergences.filter(d => !d.expected).length;
    const expectedCount = result.divergences.filter(d => d.expected).length;

    const record: ParityDiagnosticRecord = {
      diagnosticId: `parity-diag-${this.diagnosticCounter}`,
      sessionId: result.sessionId,
      timestamp: result.comparedAt,
      parityAchieved: result.parity,
      totalEvents: result.totalEvents,
      matchingEvents: result.matchingEvents,
      parityRatio: result.totalEvents > 0
        ? result.matchingEvents / result.totalEvents
        : 1,
      unexpectedDivergenceCount: unexpectedCount,
      expectedDivergenceCount: expectedCount,
      divergenceSummaries,
      adaptationSnapshot: adaptationStats,
      writerSnapshot: writerStats,
      phase,
    };

    this.records.push(record);
    this.trimRecords();

    return record;
  }

  /**
   * Get a parity health report over the rolling window.
   */
  getHealthReport(): ParityHealthReport {
    const windowSize = this.config.healthWindowSize ?? 10;
    const threshold = this.config.parityHealthThreshold ?? 0.95;
    const recentRecords = this.records.slice(-windowSize);

    if (recentRecords.length === 0) {
      return {
        healthy: true,
        windowSize: 0,
        parityAchievementRatio: 1,
        averageParityRatio: 1,
        topDivergenceKinds: [],
        totalUnexpectedDivergences: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    const parityCount = recentRecords.filter(r => r.parityAchieved).length;
    const parityAchievementRatio = parityCount / recentRecords.length;
    const averageParityRatio = recentRecords.reduce(
      (sum, r) => sum + r.parityRatio, 0
    ) / recentRecords.length;

    // Aggregate divergence kinds
    const kindCounts = new Map<string, number>();
    let totalUnexpected = 0;

    for (const record of recentRecords) {
      for (const summary of record.divergenceSummaries) {
        if (!summary.expected || this.config.includeExpectedInHealth) {
          kindCounts.set(
            summary.kind,
            (kindCounts.get(summary.kind) ?? 0) + summary.count
          );
        }
        if (!summary.expected) {
          totalUnexpected += summary.count;
        }
      }
    }

    const topDivergenceKinds = Array.from(kindCounts.entries())
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      healthy: averageParityRatio >= threshold && totalUnexpected === 0,
      windowSize: recentRecords.length,
      parityAchievementRatio,
      averageParityRatio,
      topDivergenceKinds,
      totalUnexpectedDivergences: totalUnexpected,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get all diagnostic records (for export/audit).
   */
  getRecords(): readonly ParityDiagnosticRecord[] {
    return this.records;
  }

  /**
   * Get only the most recent diagnostic record.
   */
  getLatestRecord(): ParityDiagnosticRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /**
   * Get the total number of diagnostics recorded.
   */
  getRecordCount(): number {
    return this.records.length;
  }

  /**
   * Clear all diagnostic records (for testing or reset).
   */
  clear(): void {
    this.records.length = 0;
    this.diagnosticCounter = 0;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Summarize divergences by kind, redacting any content.
   */
  private summarizeDivergences(
    divergences: ParityDivergence[]
  ): RedactedDivergenceSummary[] {
    const grouped = new Map<string, { count: number; expected: boolean; descriptions: Set<string> }>();

    for (const d of divergences) {
      const key = `${d.kind}:${d.expected}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
        existing.descriptions.add(this.redactDescription(d.description));
      } else {
        grouped.set(key, {
          count: 1,
          expected: d.expected,
          descriptions: new Set([this.redactDescription(d.description)]),
        });
      }
    }

    return Array.from(grouped.entries()).map(([key, value]) => ({
      kind: key.split(':')[0]!,
      count: value.count,
      expected: value.expected,
      redactedDescription: Array.from(value.descriptions).join('; '),
    }));
  }

  /**
   * Redact a description to remove any potential user content.
   * Keeps structural info (types, counts, sequences) but removes
   * any content that might contain user data.
   */
  private redactDescription(description: string): string {
    // Remove any quoted strings that might contain user content
    let redacted = description.replace(/"[^"]*"/g, '"[redacted]"');
    // Remove any payloadRef values (content hashes that could be sensitive)
    redacted = redacted.replace(/payload[Rr]ef:\s*\S+/g, 'payloadRef: [redacted]');
    // Remove file paths
    redacted = redacted.replace(/\/[\w/./-]+/g, '[path]');
    return redacted;
  }

  /**
   * Trim records to stay within the configured retention limit.
   */
  private trimRecords(): void {
    const maxRecords = this.config.maxRetainedRecords ?? 1000;
    while (this.records.length > maxRecords) {
      this.records.shift();
    }
  }
}
