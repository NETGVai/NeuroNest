/**
 * Agent Racing Engine Implementation — Concurrent multi-provider agent racing.
 *
 * Fans a single prompt to N parallel agents (each backed by a different LLM
 * provider/model), races them concurrently (max 4), ranks results by quality
 * score, and selects the winner. Handles partial failures, timeouts, and
 * cancellation. Emits lifecycle events through CallbackEngine and persists
 * race records in SQLite.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { ParallelAgentExecutor, type SubAgentTask, type SubAgentResult } from './parallel-agent-executor.js';
import { WorktreeIsolation, type WorktreeHandle } from './worktree-isolation.js';
import type {
  IAgentRacingEngine,
  RaceConfig,
  RaceResult,
  RaceParticipantConfig,
  RaceParticipantResult,
  RaceParticipantStatus,
} from './agent-racing-engine.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_CONCURRENT_PARTICIPANTS = 4;

// ─── Implementation ─────────────────────────────────────────────

export class AgentRacingEngine implements IAgentRacingEngine {
  private activeRaces: Map<string, RaceState> = new Map();

  constructor(
    private db: Database.Database,
    private callbackEngine: CallbackEngine,
    private featureGate: FeatureGateSystem,
    private worktreeIsolation: WorktreeIsolation,
    private parallelAgentExecutor: ParallelAgentExecutor,
  ) {}

  /**
   * Start a race with the given configuration.
   *
   * Spawns N participants (max 4 concurrent) via ParallelAgentExecutor with
   * worktree isolation. Applies configurable timeout. Ranks results by quality
   * score and selects winner. Returns all-failed status when no participants succeed.
   *
   * Feature gate guard: returns immediately with all-failed when agent_racing is disabled.
   */
  async startRace(config: RaceConfig): Promise<RaceResult> {
    // Null-check guard: zero overhead when disabled (Req 1.9)
    if (!this.featureGate.isEnabled('agent_racing')) {
      return {
        raceId: randomUUID(),
        prompt: config.prompt,
        winner: null,
        participants: [],
        totalDurationMs: 0,
        status: 'all-failed',
      };
    }

    const raceId = randomUUID();
    const startTime = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Persist race record as 'running'
    this.insertRaceRecord(raceId, config.prompt);

    // Build participant state
    const participantStates: ParticipantState[] = config.participants.map((participant) => ({
      id: randomUUID(),
      config: participant,
      status: 'pending' as RaceParticipantStatus,
      qualityScore: 0,
      durationMs: 0,
    }));

    // Persist participant records
    for (const participant of participantStates) {
      this.insertParticipantRecord(raceId, participant);
    }

    // Track active race state for cancellation support
    const abortController = new AbortController();
    const raceState: RaceState = {
      raceId,
      config,
      participants: participantStates,
      abortController,
      startTime,
    };
    this.activeRaces.set(raceId, raceState);

    // Emit race-start lifecycle event (Req 1.7)
    await this.emitLifecycleEvent(raceId, 'race-start', {
      prompt: config.prompt,
      participantCount: config.participants.length,
    });

    // Execute participants with concurrency limit and timeout
    const results = await this.executeParticipants(raceState, timeoutMs);

    // Rank results and select winner (Req 1.3, 1.4)
    const rankedResults = this.rankResults(results);
    const winner = this.selectWinner(rankedResults);

    const totalDurationMs = Date.now() - startTime;
    const status = this.determineRaceStatus(rankedResults, abortController.signal.aborted);

    // Build final race result
    const raceResult: RaceResult = {
      raceId,
      prompt: config.prompt,
      winner,
      participants: rankedResults,
      totalDurationMs,
      status,
    };

    // Update database records
    this.updateRaceRecord(raceId, status, winner?.participantId ?? null, totalDurationMs);
    for (const participant of rankedResults) {
      this.updateParticipantRecord(participant);
    }

    // Remove from active races
    this.activeRaces.delete(raceId);

    // Emit race-complete lifecycle event (Req 1.7)
    await this.emitLifecycleEvent(raceId, 'race-complete', {
      status,
      winnerId: winner?.participantId ?? null,
      totalDurationMs,
    });

    return raceResult;
  }

  /**
   * Cancel an in-progress race by aborting all participants.
   */
  async cancelRace(raceId: string): Promise<void> {
    // Null-check guard (Req 1.9)
    if (!this.featureGate.isEnabled('agent_racing')) {
      return;
    }

    const raceState = this.activeRaces.get(raceId);
    if (!raceState) {
      return;
    }

    raceState.abortController.abort();
  }

  /**
   * Get all currently active (in-progress) races.
   */
  getActiveRaces(): RaceResult[] {
    // Null-check guard (Req 1.9)
    if (!this.featureGate.isEnabled('agent_racing')) {
      return [];
    }

    const results: RaceResult[] = [];
    for (const [raceId, state] of this.activeRaces) {
      results.push({
        raceId,
        prompt: state.config.prompt,
        winner: null,
        participants: state.participants.map((p) => ({
          participantId: p.id,
          config: p.config,
          status: p.status,
          qualityScore: p.qualityScore,
          durationMs: p.durationMs,
        })),
        totalDurationMs: Date.now() - state.startTime,
        status: 'completed', // placeholder — still running
      });
    }
    return results;
  }

  // ─── Core Logic ───────────────────────────────────────────────

  /**
   * Execute all participants with concurrency ceiling of 4 and timeout.
   *
   * Uses a sliding window approach consistent with ParallelAgentExecutor.
   * Handles partial failures: marks failed participants, continues race.
   */
  private async executeParticipants(
    raceState: RaceState,
    timeoutMs: number,
  ): Promise<RaceParticipantResult[]> {
    const { participants, config, abortController } = raceState;
    const results: RaceParticipantResult[] = [];
    const executing: Promise<RaceParticipantResult>[] = [];
    const qualityScoringFn = config.qualityScoringFn ?? defaultQualityScoring;

    // Create a timeout promise
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      // Clean up timer if abort fires first
      abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve('timeout');
      });
    });

    let timedOut = false;

    for (const participant of participants) {
      if (abortController.signal.aborted || timedOut) {
        // Mark remaining as timed-out
        results.push({
          participantId: participant.id,
          config: participant.config,
          status: 'timed-out',
          qualityScore: 0,
          durationMs: 0,
        });
        continue;
      }

      participant.status = 'running';
      this.updateParticipantStatus(participant.id, 'running');

      const promise = this.executeParticipant(participant, config, qualityScoringFn, raceState.raceId);
      executing.push(promise);

      // Enforce max 4 concurrent (Req 1.2)
      if (executing.length >= MAX_CONCURRENT_PARTICIPANTS) {
        const raceResult = await Promise.race([
          Promise.race(
            executing.map((p, idx) => p.then((result) => ({ result, idx, type: 'result' as const }))),
          ),
          timeoutPromise.then(() => ({ type: 'timeout' as const, result: null, idx: -1 })),
        ]);

        if (raceResult.type === 'timeout') {
          timedOut = true;
          // Mark all still-executing participants as timed-out
          const remaining = await Promise.allSettled(executing);
          for (const settled of remaining) {
            if (settled.status === 'fulfilled') {
              const r = settled.value;
              if (r.status === 'running' || r.status === 'pending') {
                r.status = 'timed-out';
              }
              results.push(r);
            }
          }
          executing.length = 0;
          continue;
        }

        results.push(raceResult.result!);
        executing.splice(raceResult.idx, 1);
      }
    }

    if (!timedOut) {
      // Wait for remaining with timeout
      const remainingRace = await Promise.race([
        Promise.all(executing),
        timeoutPromise.then(() => 'timeout' as const),
      ]);

      if (remainingRace === 'timeout') {
        // Mark executing participants as timed-out
        const settled = await Promise.allSettled(executing);
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            if (s.value.status === 'running' || s.value.status === 'pending') {
              s.value.status = 'timed-out';
            }
            results.push(s.value);
          } else {
            // Should not happen but handle gracefully
            results.push({
              participantId: randomUUID(),
              config: { providerId: 'unknown', model: 'unknown' },
              status: 'timed-out',
              qualityScore: 0,
              durationMs: 0,
            });
          }
        }
      } else {
        results.push(...(remainingRace as RaceParticipantResult[]));
      }
    }

    // Mark participants that were never started as timed-out
    for (const participant of participants) {
      const hasResult = results.some((r) => r.participantId === participant.id);
      if (!hasResult) {
        results.push({
          participantId: participant.id,
          config: participant.config,
          status: 'timed-out',
          qualityScore: 0,
          durationMs: 0,
        });
      }
    }

    return results;
  }

  /**
   * Execute a single race participant in its own isolated worktree.
   *
   * Creates worktree isolation, runs the sub-agent task, scores the result,
   * and emits participant-complete event.
   */
  private async executeParticipant(
    participant: ParticipantState,
    config: RaceConfig,
    qualityScoringFn: (result: SubAgentResult) => number,
    raceId: string,
  ): Promise<RaceParticipantResult> {
    const startTime = Date.now();
    let worktreeHandle: WorktreeHandle | undefined;

    try {
      // Create isolated worktree for this participant (Req 1.1)
      worktreeHandle = await this.worktreeIsolation.create(participant.id);

      // Build a sub-agent task for the ParallelAgentExecutor
      const task: SubAgentTask = {
        id: participant.id,
        description: config.prompt,
        fileBoundaries: [],
        symbolBoundaries: [],
        role: `race-participant:${participant.config.providerId}:${participant.config.model}`,
      };

      // Execute the task via ParallelAgentExecutor
      const [subAgentResult] = await this.parallelAgentExecutor.execute([task]);

      if (!subAgentResult || subAgentResult.status === 'failed') {
        // Participant failed (Req 1.5)
        const durationMs = Date.now() - startTime;
        participant.status = 'failed';
        participant.durationMs = durationMs;

        const result: RaceParticipantResult = {
          participantId: participant.id,
          config: participant.config,
          status: 'failed',
          ...(subAgentResult ? { result: subAgentResult } : {}),
          qualityScore: 0,
          durationMs,
          error: subAgentResult?.error ?? 'Participant execution failed',
        };

        // Emit participant-complete event (Req 1.7)
        await this.emitLifecycleEvent(raceId, 'participant-complete', {
          participantId: participant.id,
          status: 'failed',
          error: result.error,
        });

        return result;
      }

      // Score the result (Req 1.3)
      const qualityScore = qualityScoringFn(subAgentResult);
      const durationMs = Date.now() - startTime;

      participant.status = 'completed';
      participant.qualityScore = qualityScore;
      participant.durationMs = durationMs;

      const result: RaceParticipantResult = {
        participantId: participant.id,
        config: participant.config,
        status: 'completed',
        result: subAgentResult,
        qualityScore,
        durationMs,
      };

      // Emit participant-complete event (Req 1.7)
      await this.emitLifecycleEvent(raceId, 'participant-complete', {
        participantId: participant.id,
        status: 'completed',
        qualityScore,
        durationMs,
      });

      return result;
    } catch (error: unknown) {
      // Handle unexpected errors — mark participant as failed (Req 1.5)
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      participant.status = 'failed';
      participant.durationMs = durationMs;

      const result: RaceParticipantResult = {
        participantId: participant.id,
        config: participant.config,
        status: 'failed',
        qualityScore: 0,
        durationMs,
        error: errorMessage,
      };

      // Emit participant-complete event (Req 1.7)
      await this.emitLifecycleEvent(raceId, 'participant-complete', {
        participantId: participant.id,
        status: 'failed',
        error: errorMessage,
      });

      return result;
    } finally {
      // Clean up worktree (best-effort)
      if (worktreeHandle) {
        try {
          await this.worktreeIsolation.cleanup(worktreeHandle);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /**
   * Rank results by quality score in descending order (Req 1.3).
   * Failed/timed-out participants get score 0.
   */
  rankResults(results: RaceParticipantResult[]): RaceParticipantResult[] {
    return [...results].sort((a, b) => b.qualityScore - a.qualityScore);
  }

  /**
   * Select the winner from ranked results (Req 1.4).
   * Winner must be a completed participant with the highest quality score.
   * Returns null if no participant completed successfully.
   */
  private selectWinner(rankedResults: RaceParticipantResult[]): RaceParticipantResult | null {
    const completedParticipants = rankedResults.filter((r) => r.status === 'completed');
    if (completedParticipants.length === 0) {
      return null;
    }
    return completedParticipants[0]!;
  }

  /**
   * Determine the overall race status based on results.
   */
  private determineRaceStatus(
    results: RaceParticipantResult[],
    aborted: boolean,
  ): RaceResult['status'] {
    const hasCompleted = results.some((r) => r.status === 'completed');
    const hasTimedOut = results.some((r) => r.status === 'timed-out');

    if (hasCompleted) {
      return 'completed';
    }

    if (hasTimedOut || aborted) {
      return 'timed-out';
    }

    // All participants failed (Req 1.6)
    return 'all-failed';
  }

  // ─── Lifecycle Events ─────────────────────────────────────────

  /**
   * Emit a lifecycle event via CallbackEngine (Req 1.7).
   * Uses 'on-task-complete' event type for race lifecycle events.
   */
  private async emitLifecycleEvent(
    raceId: string,
    eventName: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.callbackEngine.emit({
      event: 'on-task-complete',
      sessionId: raceId,
      iteration: 0,
      output: {
        type: eventName,
        raceId,
        ...data,
      },
    });
  }

  // ─── Database Operations ──────────────────────────────────────

  /**
   * Insert a new race record.
   */
  private insertRaceRecord(raceId: string, prompt: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO races (id, prompt, status, created_at)
      VALUES (?, ?, 'running', ?)
    `);
    stmt.run(raceId, prompt, new Date().toISOString());
  }

  /**
   * Insert a new participant record.
   */
  private insertParticipantRecord(raceId: string, participant: ParticipantState): void {
    const stmt = this.db.prepare(`
      INSERT INTO race_participants (id, race_id, provider_id, model, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `);
    stmt.run(
      participant.id,
      raceId,
      participant.config.providerId,
      participant.config.model,
      new Date().toISOString(),
    );
  }

  /**
   * Update race record with final status.
   */
  private updateRaceRecord(
    raceId: string,
    status: RaceResult['status'],
    winnerParticipantId: string | null,
    totalDurationMs: number,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE races
      SET status = ?, winner_participant_id = ?, total_duration_ms = ?, completed_at = ?
      WHERE id = ?
    `);
    stmt.run(status, winnerParticipantId, totalDurationMs, new Date().toISOString(), raceId);
  }

  /**
   * Update participant record with final result.
   */
  private updateParticipantRecord(participant: RaceParticipantResult): void {
    const stmt = this.db.prepare(`
      UPDATE race_participants
      SET status = ?, quality_score = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `);
    stmt.run(
      participant.status,
      participant.qualityScore,
      participant.durationMs,
      participant.error ?? null,
      participant.participantId,
    );
  }

  /**
   * Update participant status during execution.
   */
  private updateParticipantStatus(participantId: string, status: RaceParticipantStatus): void {
    const stmt = this.db.prepare(`
      UPDATE race_participants SET status = ? WHERE id = ?
    `);
    stmt.run(status, participantId);
  }
}

// ─── Internal Types ─────────────────────────────────────────────

interface ParticipantState {
  id: string;
  config: RaceParticipantConfig;
  status: RaceParticipantStatus;
  qualityScore: number;
  durationMs: number;
}

interface RaceState {
  raceId: string;
  config: RaceConfig;
  participants: ParticipantState[];
  abortController: AbortController;
  startTime: number;
}

// ─── Default Scoring ────────────────────────────────────────────

/**
 * Default quality scoring function.
 * Returns a normalized score based on completion status and output presence.
 */
function defaultQualityScoring(result: SubAgentResult): number {
  if (result.status !== 'completed') {
    return 0;
  }
  // Base score for completion
  let score = 0.5;
  // Bonus for having output
  if (result.output != null) {
    score += 0.5;
  }
  return score;
}
