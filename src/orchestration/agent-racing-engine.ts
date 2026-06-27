/**
 * Agent Racing Engine — Interfaces for concurrent multi-provider agent racing.
 *
 * Enables spawning multiple agent participants (each backed by a different LLM
 * provider/model) to race on the same prompt, then ranks results by quality score
 * and selects a winner.
 *
 * Requirements: 1.1–1.9
 */

import type { SubAgentResult } from './parallel-agent-executor.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for a single race participant */
export interface RaceParticipantConfig {
  providerId: string;
  model: string;
  systemPromptOverride?: string;
  temperature?: number;
}

/** Configuration for initiating a race */
export interface RaceConfig {
  prompt: string;
  participants: RaceParticipantConfig[];
  timeoutMs?: number;          // default: 300_000 (5 min)
  qualityScoringFn?: (result: SubAgentResult) => number;
}

/** Status of a single race participant */
export type RaceParticipantStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed-out';

/** Individual participant result with quality score */
export interface RaceParticipantResult {
  participantId: string;
  config: RaceParticipantConfig;
  status: RaceParticipantStatus;
  result?: SubAgentResult;
  qualityScore: number;
  durationMs: number;
  error?: string;
}

/** Complete race result */
export interface RaceResult {
  raceId: string;
  prompt: string;
  winner: RaceParticipantResult | null;
  participants: RaceParticipantResult[];
  totalDurationMs: number;
  status: 'completed' | 'all-failed' | 'timed-out';
}

/** Agent Racing Engine interface */
export interface IAgentRacingEngine {
  startRace(config: RaceConfig): Promise<RaceResult>;
  cancelRace(raceId: string): Promise<void>;
  getActiveRaces(): RaceResult[];
}
