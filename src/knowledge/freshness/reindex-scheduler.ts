// ─── Reindex Scheduler ──────────────────────────────────────────
// Manages scheduled re-indexing of KB sources based on their configured
// schedule mode (manual, on-change, hourly, daily).
//
// Behavior per schedule mode:
//   - manual: Only re-indexes when explicitly requested via `triggerManual()`
//   - on-change: Triggers re-indexing immediately when staleness is detected
//   - hourly: Uses a 1-hour interval timer to check and re-index stale sources
//   - daily: Uses a 24-hour interval timer to check and re-index stale sources
//
// Integrates with:
//   - FreshnessTracker: to check staleness and manage freshness state
//   - IngestPipeline: to perform incremental re-indexing via `ingestIncremental()`
//   - ConnectorFramework: to fetch changed documents from sources
//   - EventLog: to emit structured freshness events
//
// Requirements: 5.3, 5.4

import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log';
import type { FreshnessTracker, FreshnessRecord } from './freshness-tracker';
import type { IngestPipeline, IngestPipelineConfig, IngestResult } from '../ingest/ingest-pipeline';
import type { ConnectorFramework } from '../connectors/connector-framework';
import type { RawDocument } from '../connectors/types';
import { KB_EVENT_KINDS, KB_SOURCE_IDENTIFIERS } from '../events/kb-event-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Schedule modes supported by the KB source configuration.
 */
export type ScheduleMode = 'manual' | 'on-change' | 'hourly' | 'daily';

/**
 * Row shape from kb_sources table relevant for scheduling.
 */
interface SourceScheduleRow {
  id: string;
  uri: string;
  type: string;
  schedule: string;
  project_id: string;
}

/**
 * Result of a scheduled re-index operation for a single source.
 */
export interface ReindexResult {
  sourceId: string;
  sourceUri: string;
  success: boolean;
  ingestResult?: IngestResult;
  error?: string;
}

/**
 * Configuration for the ReindexScheduler.
 */
export interface ReindexSchedulerConfig {
  /** Project ID for scoping operations */
  projectId: string;
  /** Session ID for EventLog emission */
  sessionId: string;
  /** Hourly interval override in ms (default: 3_600_000 = 1 hour) */
  hourlyIntervalMs?: number;
  /** Daily interval override in ms (default: 86_400_000 = 24 hours) */
  dailyIntervalMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default hourly interval: 1 hour in milliseconds */
const DEFAULT_HOURLY_INTERVAL_MS = 3_600_000;

/** Default daily interval: 24 hours in milliseconds */
const DEFAULT_DAILY_INTERVAL_MS = 86_400_000;

// ─── ReindexScheduler ───────────────────────────────────────────

/**
 * ReindexScheduler — manages periodic and event-driven re-indexing of
 * KB sources based on their configured schedule mode.
 *
 * Schedule modes:
 *   - `manual`: No automatic re-indexing. Only triggered via `triggerManual()`.
 *   - `on-change`: Immediately triggers re-indexing when `onStalenessDetected()` is called.
 *   - `hourly`: Checks all hourly-scheduled sources on a 1-hour timer.
 *   - `daily`: Checks all daily-scheduled sources on a 24-hour timer.
 *
 * The scheduler performs incremental ingest (via IngestPipeline.ingestIncremental)
 * when re-indexing, only processing content that has actually changed.
 */
export class ReindexScheduler {
  private hourlyTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly hourlyIntervalMs: number;
  private readonly dailyIntervalMs: number;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly eventLog: EventLog,
    private readonly freshnessTracker: FreshnessTracker,
    private readonly ingestPipeline: IngestPipeline,
    private readonly connectorFramework: ConnectorFramework,
    private readonly config: ReindexSchedulerConfig,
  ) {
    this.hourlyIntervalMs = config.hourlyIntervalMs ?? DEFAULT_HOURLY_INTERVAL_MS;
    this.dailyIntervalMs = config.dailyIntervalMs ?? DEFAULT_DAILY_INTERVAL_MS;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Start the scheduler. Sets up interval timers for hourly and daily modes.
   * Does nothing if already running.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    // Set up hourly timer
    this.hourlyTimer = setInterval(() => {
      void this.checkAndReindexBySchedule('hourly');
    }, this.hourlyIntervalMs);

    // Set up daily timer
    this.dailyTimer = setInterval(() => {
      void this.checkAndReindexBySchedule('daily');
    }, this.dailyIntervalMs);

    // Unref timers so they don't keep the process alive
    if (this.hourlyTimer && typeof this.hourlyTimer === 'object' && 'unref' in this.hourlyTimer) {
      this.hourlyTimer.unref();
    }
    if (this.dailyTimer && typeof this.dailyTimer === 'object' && 'unref' in this.dailyTimer) {
      this.dailyTimer.unref();
    }
  }

  /**
   * Stop the scheduler. Clears all interval timers.
   */
  stop(): void {
    if (this.hourlyTimer !== null) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    if (this.dailyTimer !== null) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }
    this.running = false;
  }

  /**
   * Whether the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle a staleness detection event for on-change sources.
   * If the source is configured with schedule='on-change', triggers immediate re-indexing.
   *
   * @param sourceId - The source that was detected as stale
   * @returns ReindexResult if re-indexing was triggered, undefined if source is not on-change
   */
  async onStalenessDetected(sourceId: string): Promise<ReindexResult | undefined> {
    const source = this.getSourceScheduleRow(sourceId);
    if (!source) {
      return undefined;
    }

    if (source.schedule !== 'on-change') {
      return undefined;
    }

    return this.reindexSource(source);
  }

  /**
   * Manually trigger re-indexing for a specific source.
   * Works regardless of the source's configured schedule mode.
   *
   * @param sourceId - The source to re-index
   * @returns ReindexResult with the outcome
   */
  async triggerManual(sourceId: string): Promise<ReindexResult> {
    const source = this.getSourceScheduleRow(sourceId);
    if (!source) {
      return {
        sourceId,
        sourceUri: '',
        success: false,
        error: `Source "${sourceId}" not found in kb_sources`,
      };
    }

    return this.reindexSource(source);
  }

  /**
   * Check all sources with a given schedule mode for staleness,
   * and re-index any that are stale.
   *
   * @param schedule - The schedule mode to filter sources by
   * @returns Array of ReindexResults for sources that were re-indexed
   */
  async checkAndReindexBySchedule(schedule: ScheduleMode): Promise<ReindexResult[]> {
    const sources = this.getSourcesBySchedule(schedule);
    const results: ReindexResult[] = [];

    for (const source of sources) {
      // Check freshness first
      let freshnessRecord: FreshnessRecord;
      try {
        freshnessRecord = await this.freshnessTracker.checkSource(source.id);
      } catch {
        results.push({
          sourceId: source.id,
          sourceUri: source.uri,
          success: false,
          error: `Failed to check freshness for source "${source.id}"`,
        });
        continue;
      }

      // Only re-index if the source is stale
      if (freshnessRecord.state === 'stale') {
        const result = await this.reindexSource(source);
        results.push(result);
      }
    }

    return results;
  }

  // ─── Private: Re-indexing Logic ─────────────────────────────

  /**
   * Perform incremental re-indexing for a single source.
   * Fetches changed documents via the connector framework and passes them
   * to IngestPipeline.ingestIncremental().
   */
  private async reindexSource(source: SourceScheduleRow): Promise<ReindexResult> {
    try {
      // Mark source as re-indexing
      await this.freshnessTracker.markReindexing(source.id);

      // Emit reindex event
      this.emitReindexEvent(source.id, source.uri, this.resolveReindexTrigger(source.schedule));

      // Fetch changed documents from the connector framework
      const changedDocs: RawDocument[] = [];
      for await (const doc of this.connectorFramework.fetchSource(source.id)) {
        changedDocs.push(doc);
      }

      // Perform incremental ingest
      const pipelineConfig: IngestPipelineConfig = {
        projectId: this.config.projectId,
        sourceId: source.id,
        sessionId: this.config.sessionId,
      };

      const ingestResult = await this.ingestPipeline.ingestIncremental(
        source.uri,
        changedDocs,
        pipelineConfig,
      );

      // Mark source as fresh after successful re-indexing
      // Use the content hash of the last processed document, or a timestamp hash
      const newHash = changedDocs.length > 0
        ? changedDocs[changedDocs.length - 1]!.contentHash
        : String(Date.now());
      await this.freshnessTracker.markFresh(source.id, newHash);

      return {
        sourceId: source.id,
        sourceUri: source.uri,
        success: true,
        ingestResult,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        sourceId: source.id,
        sourceUri: source.uri,
        success: false,
        error: errorMessage,
      };
    }
  }

  // ─── Private: Database Queries ──────────────────────────────

  /**
   * Get a single source's schedule info from kb_sources.
   */
  private getSourceScheduleRow(sourceId: string): SourceScheduleRow | undefined {
    const stmt = this.db.prepare(
      'SELECT id, uri, type, schedule, project_id FROM kb_sources WHERE id = ?',
    );
    return stmt.get(sourceId) as SourceScheduleRow | undefined;
  }

  /**
   * Get all sources with a given schedule mode for the configured project.
   */
  private getSourcesBySchedule(schedule: ScheduleMode): SourceScheduleRow[] {
    const stmt = this.db.prepare(
      'SELECT id, uri, type, schedule, project_id FROM kb_sources WHERE schedule = ? AND project_id = ?',
    );
    return stmt.all(schedule, this.config.projectId) as SourceScheduleRow[];
  }

  // ─── Private: Event Emission ────────────────────────────────

  /**
   * Emit a kb.freshness.reindex event to the EventLog.
   */
  private emitReindexEvent(
    sourceId: string,
    sourceUri: string,
    trigger: 'scheduled' | 'manual' | 'on-change',
  ): void {
    try {
      this.eventLog.emit({
        sessionId: KB_SOURCE_IDENTIFIERS.FRESHNESS,
        kind: KB_EVENT_KINDS.FRESHNESS_REINDEX as EventKind,
        payload: {
          sourceUri,
          sourceId,
          trigger,
        },
      });
    } catch {
      // EventLog emission failure should never crash the scheduler
    }
  }

  /**
   * Resolve the trigger type for the reindex event based on schedule mode.
   */
  private resolveReindexTrigger(schedule: string): 'scheduled' | 'manual' | 'on-change' {
    switch (schedule) {
      case 'on-change':
        return 'on-change';
      case 'manual':
        return 'manual';
      case 'hourly':
      case 'daily':
      default:
        return 'scheduled';
    }
  }
}
