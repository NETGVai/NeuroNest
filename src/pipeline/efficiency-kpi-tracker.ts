/**
 * Efficiency KPI Tracker — instruments per-session efficiency metrics.
 *
 * Tracks four KPIs per session/task:
 *   - tokens_per_task: total tokens consumed to complete a task
 *   - llm_round_trips: number of LLM calls made per task
 *   - wall_time_ms: wall-clock duration from task start to completion
 *   - wasted_tokens: tokens burned on loops, retries, and re-established context
 *
 * Stores metrics in the `efficiency_kpis` table (migration 040) and integrates
 * with the existing CostStore for cost dashboard access. Surfaces KPI deltas
 * per mechanism when feature flags are toggled (A/B comparison).
 *
 * Gated behind the `efficiency_kpi_instrumentation` flag.
 *
 * Requirements: 24.1, 24.2, 24.4
 */

import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { FeatureGateFlags } from '../feature-gate/feature-gate-config.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** KPI metrics recorded per session/task */
export interface EfficiencyKpiRecord {
  sessionId: string;
  taskId: string | null;
  tokensPerTask: number;
  llmRoundTrips: number;
  wallTimeMs: number;
  wastedTokens: number;
  mechanismFlags: Record<string, boolean>;
}

/** In-flight session tracking state */
export interface KpiSessionState {
  sessionId: string;
  taskId: string | null;
  startTime: number;
  totalTokens: number;
  llmRoundTrips: number;
  wastedTokens: number;
}

/** KPI delta comparison between two mechanism configurations */
export interface KpiDelta {
  mechanism: string;
  baselineKpis: EfficiencyKpiRecord;
  currentKpis: EfficiencyKpiRecord;
  tokensPerTaskDelta: number;
  llmRoundTripsDelta: number;
  wallTimeMsDelta: number;
  wastedTokensDelta: number;
  percentImprovement: {
    tokensPerTask: number;
    llmRoundTrips: number;
    wallTimeMs: number;
    wastedTokens: number;
  };
}

/** Stored KPI row from the database */
export interface StoredKpiRow {
  id: number;
  session_id: string;
  task_id: string | null;
  tokens_per_task: number | null;
  llm_round_trips: number | null;
  wall_time_ms: number | null;
  wasted_tokens: number | null;
  mechanism_flags: string;
  created_at: number;
}

// ─── Efficiency mechanism flag names for A/B comparison ─────────

const EFFICIENCY_MECHANISM_FLAGS: (keyof FeatureGateFlags)[] = [
  'context_condenser_v2',
  'prompt_cache_discipline',
  'stuck_detector',
  'session_shell',
  'context_scoped_delegation',
  'trigger_gated_knowledge',
];

// ─── EfficiencyKpiTracker ───────────────────────────────────────

export class EfficiencyKpiTracker {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;

  // Prepared statements
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtGetByTask: Database.Statement;
  private readonly stmtGetByMechanismFlags: Database.Statement;
  private readonly stmtGetAverageByFlags: Database.Statement;

  // In-flight session trackers
  private readonly activeSessions: Map<string, KpiSessionState> = new Map();

  constructor(db: Database.Database, featureGate: FeatureGateSystem) {
    this.db = db;
    this.featureGate = featureGate;

    this.stmtInsert = db.prepare(
      `INSERT INTO efficiency_kpis (session_id, task_id, tokens_per_task, llm_round_trips, wall_time_ms, wasted_tokens, mechanism_flags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtGetBySession = db.prepare(
      `SELECT id, session_id, task_id, tokens_per_task, llm_round_trips, wall_time_ms, wasted_tokens, mechanism_flags, created_at
       FROM efficiency_kpis WHERE session_id = ? ORDER BY created_at DESC`,
    );

    this.stmtGetByTask = db.prepare(
      `SELECT id, session_id, task_id, tokens_per_task, llm_round_trips, wall_time_ms, wasted_tokens, mechanism_flags, created_at
       FROM efficiency_kpis WHERE task_id = ? ORDER BY created_at DESC`,
    );

    this.stmtGetByMechanismFlags = db.prepare(
      `SELECT id, session_id, task_id, tokens_per_task, llm_round_trips, wall_time_ms, wasted_tokens, mechanism_flags, created_at
       FROM efficiency_kpis WHERE mechanism_flags = ? ORDER BY created_at DESC`,
    );

    this.stmtGetAverageByFlags = db.prepare(
      `SELECT
         AVG(tokens_per_task) as avg_tokens_per_task,
         AVG(llm_round_trips) as avg_llm_round_trips,
         AVG(wall_time_ms) as avg_wall_time_ms,
         AVG(wasted_tokens) as avg_wasted_tokens,
         COUNT(*) as sample_count
       FROM efficiency_kpis WHERE mechanism_flags = ?`,
    );
  }

  // ─── Feature gate guard ─────────────────────────────────────

  /** Returns true if KPI instrumentation is enabled */
  isEnabled(): boolean {
    return this.featureGate.isEnabled('efficiency_kpi_instrumentation');
  }

  // ─── Session lifecycle ──────────────────────────────────────

  /**
   * Start tracking KPIs for a session/task. Call this when a task begins.
   * No-op if instrumentation is disabled.
   */
  startTracking(sessionId: string, taskId: string | null = null): void {
    if (!this.isEnabled()) return;

    const key = this.sessionKey(sessionId, taskId);
    this.activeSessions.set(key, {
      sessionId,
      taskId,
      startTime: Date.now(),
      totalTokens: 0,
      llmRoundTrips: 0,
      wastedTokens: 0,
    });
  }

  /**
   * Record tokens consumed by an LLM call. Call this after each LLM response.
   * No-op if instrumentation is disabled or session not tracked.
   */
  recordLlmCall(sessionId: string, taskId: string | null, tokens: number): void {
    if (!this.isEnabled()) return;

    const state = this.getSessionState(sessionId, taskId);
    if (!state) return;

    state.totalTokens += tokens;
    state.llmRoundTrips += 1;
  }

  /**
   * Record wasted tokens (from loops, retries, re-established context).
   * No-op if instrumentation is disabled or session not tracked.
   */
  recordWastedTokens(sessionId: string, taskId: string | null, tokens: number): void {
    if (!this.isEnabled()) return;

    const state = this.getSessionState(sessionId, taskId);
    if (!state) return;

    state.wastedTokens += tokens;
  }

  /**
   * Finalize tracking for a session/task, persist the KPI record, and
   * return the completed record. Call this when a task completes.
   * No-op (returns null) if instrumentation is disabled or session not tracked.
   */
  finishTracking(sessionId: string, taskId: string | null = null): EfficiencyKpiRecord | null {
    if (!this.isEnabled()) return null;

    const key = this.sessionKey(sessionId, taskId);
    const state = this.activeSessions.get(key);
    if (!state) return null;

    const wallTimeMs = Date.now() - state.startTime;
    const mechanismFlags = this.captureActiveMechanismFlags();

    const record: EfficiencyKpiRecord = {
      sessionId: state.sessionId,
      taskId: state.taskId,
      tokensPerTask: state.totalTokens,
      llmRoundTrips: state.llmRoundTrips,
      wallTimeMs,
      wastedTokens: state.wastedTokens,
      mechanismFlags,
    };

    this.persistRecord(record);
    this.activeSessions.delete(key);

    return record;
  }

  // ─── Persistence ────────────────────────────────────────────

  /** Persist a KPI record to the efficiency_kpis table */
  persistRecord(record: EfficiencyKpiRecord): void {
    this.stmtInsert.run(
      record.sessionId,
      record.taskId,
      record.tokensPerTask,
      record.llmRoundTrips,
      record.wallTimeMs,
      record.wastedTokens,
      JSON.stringify(record.mechanismFlags),
      Math.floor(Date.now() / 1000),
    );
  }

  // ─── Query methods ──────────────────────────────────────────

  /** Get all KPI records for a given session */
  getBySession(sessionId: string): EfficiencyKpiRecord[] {
    const rows = this.stmtGetBySession.all(sessionId) as StoredKpiRow[];
    return rows.map(rowToRecord);
  }

  /** Get all KPI records for a given task */
  getByTask(taskId: string): EfficiencyKpiRecord[] {
    const rows = this.stmtGetByTask.all(taskId) as StoredKpiRow[];
    return rows.map(rowToRecord);
  }

  // ─── A/B Comparison (Req 24.4) ─────────────────────────────

  /**
   * Compute KPI deltas for a specific mechanism by comparing records where
   * that mechanism was enabled vs disabled. Enables A/B comparison when
   * feature flags are toggled.
   */
  computeKpiDelta(mechanism: keyof FeatureGateFlags): KpiDelta | null {
    // Build the "baseline" flag set: all current flags, but with the target mechanism off
    const baselineFlags = this.captureActiveMechanismFlags();
    const currentFlags = { ...baselineFlags };

    // Baseline: mechanism OFF
    const baselineFlagsKey = { ...baselineFlags, [mechanism]: false };
    // Current: mechanism ON
    const currentFlagsKey = { ...currentFlags, [mechanism]: true };

    const baselineAvg = this.stmtGetAverageByFlags.get(
      JSON.stringify(baselineFlagsKey),
    ) as { avg_tokens_per_task: number | null; avg_llm_round_trips: number | null; avg_wall_time_ms: number | null; avg_wasted_tokens: number | null; sample_count: number } | undefined;

    const currentAvg = this.stmtGetAverageByFlags.get(
      JSON.stringify(currentFlagsKey),
    ) as { avg_tokens_per_task: number | null; avg_llm_round_trips: number | null; avg_wall_time_ms: number | null; avg_wasted_tokens: number | null; sample_count: number } | undefined;

    if (!baselineAvg || !currentAvg || baselineAvg.sample_count === 0 || currentAvg.sample_count === 0) {
      return null;
    }

    const baseline: EfficiencyKpiRecord = {
      sessionId: 'aggregate',
      taskId: null,
      tokensPerTask: baselineAvg.avg_tokens_per_task ?? 0,
      llmRoundTrips: baselineAvg.avg_llm_round_trips ?? 0,
      wallTimeMs: baselineAvg.avg_wall_time_ms ?? 0,
      wastedTokens: baselineAvg.avg_wasted_tokens ?? 0,
      mechanismFlags: baselineFlagsKey,
    };

    const current: EfficiencyKpiRecord = {
      sessionId: 'aggregate',
      taskId: null,
      tokensPerTask: currentAvg.avg_tokens_per_task ?? 0,
      llmRoundTrips: currentAvg.avg_llm_round_trips ?? 0,
      wallTimeMs: currentAvg.avg_wall_time_ms ?? 0,
      wastedTokens: currentAvg.avg_wasted_tokens ?? 0,
      mechanismFlags: currentFlagsKey,
    };

    return {
      mechanism: mechanism as string,
      baselineKpis: baseline,
      currentKpis: current,
      tokensPerTaskDelta: current.tokensPerTask - baseline.tokensPerTask,
      llmRoundTripsDelta: current.llmRoundTrips - baseline.llmRoundTrips,
      wallTimeMsDelta: current.wallTimeMs - baseline.wallTimeMs,
      wastedTokensDelta: current.wastedTokens - baseline.wastedTokens,
      percentImprovement: {
        tokensPerTask: safePercentDelta(baseline.tokensPerTask, current.tokensPerTask),
        llmRoundTrips: safePercentDelta(baseline.llmRoundTrips, current.llmRoundTrips),
        wallTimeMs: safePercentDelta(baseline.wallTimeMs, current.wallTimeMs),
        wastedTokens: safePercentDelta(baseline.wastedTokens, current.wastedTokens),
      },
    };
  }

  /**
   * Compute KPI deltas for all efficiency mechanisms at once.
   * Returns a map of mechanism name → delta (or null if insufficient data).
   */
  computeAllDeltas(): Map<string, KpiDelta | null> {
    const deltas = new Map<string, KpiDelta | null>();
    for (const mechanism of EFFICIENCY_MECHANISM_FLAGS) {
      deltas.set(mechanism, this.computeKpiDelta(mechanism));
    }
    return deltas;
  }

  // ─── Cost-store integration ─────────────────────────────────

  /**
   * Get a summary of efficiency metrics suitable for the cost dashboard.
   * Aggregates across all sessions to provide high-level KPI overview.
   */
  getCostDashboardSummary(): {
    totalSessions: number;
    avgTokensPerTask: number;
    avgLlmRoundTrips: number;
    avgWallTimeMs: number;
    avgWastedTokens: number;
    wastedTokenRatio: number;
  } {
    const row = this.db.prepare(
      `SELECT
         COUNT(*) as total_sessions,
         AVG(tokens_per_task) as avg_tokens_per_task,
         AVG(llm_round_trips) as avg_llm_round_trips,
         AVG(wall_time_ms) as avg_wall_time_ms,
         AVG(wasted_tokens) as avg_wasted_tokens,
         CASE WHEN SUM(tokens_per_task) > 0
           THEN CAST(SUM(wasted_tokens) AS REAL) / SUM(tokens_per_task)
           ELSE 0
         END as wasted_ratio
       FROM efficiency_kpis
       WHERE tokens_per_task IS NOT NULL`,
    ).get() as {
      total_sessions: number;
      avg_tokens_per_task: number | null;
      avg_llm_round_trips: number | null;
      avg_wall_time_ms: number | null;
      avg_wasted_tokens: number | null;
      wasted_ratio: number;
    };

    return {
      totalSessions: row.total_sessions,
      avgTokensPerTask: row.avg_tokens_per_task ?? 0,
      avgLlmRoundTrips: row.avg_llm_round_trips ?? 0,
      avgWallTimeMs: row.avg_wall_time_ms ?? 0,
      avgWastedTokens: row.avg_wasted_tokens ?? 0,
      wastedTokenRatio: row.wasted_ratio,
    };
  }

  // ─── Internal helpers ───────────────────────────────────────

  /** Get the in-flight session state for a session/task */
  private getSessionState(sessionId: string, taskId: string | null): KpiSessionState | undefined {
    const key = this.sessionKey(sessionId, taskId);
    return this.activeSessions.get(key);
  }

  /** Generate a composite key for the active sessions map */
  private sessionKey(sessionId: string, taskId: string | null): string {
    return taskId ? `${sessionId}:${taskId}` : sessionId;
  }

  /** Snapshot which efficiency mechanism flags are currently enabled */
  private captureActiveMechanismFlags(): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const flag of EFFICIENCY_MECHANISM_FLAGS) {
      flags[flag] = this.featureGate.isEnabled(flag);
    }
    return flags;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Convert a stored DB row to an EfficiencyKpiRecord */
function rowToRecord(row: StoredKpiRow): EfficiencyKpiRecord {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    tokensPerTask: row.tokens_per_task ?? 0,
    llmRoundTrips: row.llm_round_trips ?? 0,
    wallTimeMs: row.wall_time_ms ?? 0,
    wastedTokens: row.wasted_tokens ?? 0,
    mechanismFlags: parseJsonSafe(row.mechanism_flags),
  };
}

/** Safely parse JSON mechanism flags, defaulting to empty object */
function parseJsonSafe(json: string): Record<string, boolean> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Calculate percentage delta (negative = improvement/reduction) */
function safePercentDelta(baseline: number, current: number): number {
  if (baseline === 0) return 0;
  return ((current - baseline) / baseline) * 100;
}
