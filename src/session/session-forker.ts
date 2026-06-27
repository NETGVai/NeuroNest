/**
 * Session Forker — Interfaces for duplicating agent sessions with full state.
 *
 * Enables forking an existing parallel session (conversation history + worktree state)
 * into an independent new session for divergent exploration or recovery.
 *
 * Requirements: 2.1–2.9
 */

import type { ParallelSession } from './parallel-session-manager.js';

// ─── Types ──────────────────────────────────────────────────────

/** Options for creating a fork */
export interface ForkOptions {
  sourceSessionId: string;
  label?: string;
  divergePrompt?: string;   // optional new instruction for the fork
}

/** Result of a fork operation */
export interface ForkResult {
  success: boolean;
  forkedSession?: ParallelSession;
  forkedWorktreeBranch?: string;
  error?: string;
}

/** Session Forker interface */
export interface ISessionForker {
  fork(options: ForkOptions): Promise<ForkResult>;
  getForksOf(sourceSessionId: string): ParallelSession[];
}
