/**
 * SessionForker — Implementation of session forking with full state duplication.
 *
 * Duplicates an existing parallel session (conversation history + worktree state)
 * into an independent new session for divergent exploration or drift recovery.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9
 */

import { randomUUID } from 'node:crypto';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { ParallelSessionManager, ParallelSession } from './parallel-session-manager.js';
import type { WorktreeIsolation } from '../orchestration/worktree-isolation.js';
import type { ForkOptions, ForkResult, ISessionForker } from './session-forker.js';

// ─── Configuration ──────────────────────────────────────────────

export interface SessionForkerConfig {
  /** Maximum number of concurrent sessions allowed (default: 4) */
  maxConcurrentSessions?: number;
  /** Project ID used when creating forked sessions */
  projectId: string;
}

// ─── Implementation ─────────────────────────────────────────────

export class SessionForker implements ISessionForker {
  private readonly maxConcurrentSessions: number;
  private readonly projectId: string;

  /** Tracks parent → forked session relationships */
  private forkRegistry: Map<string, string[]> = new Map();

  constructor(
    private readonly featureGate: FeatureGateSystem,
    private readonly sessionManager: ParallelSessionManager,
    private readonly worktreeIsolation: WorktreeIsolation,
    config: SessionForkerConfig,
  ) {
    this.maxConcurrentSessions = config.maxConcurrentSessions ?? 4;
    this.projectId = config.projectId;
  }

  /**
   * Fork an existing session, duplicating conversation history and creating
   * a new worktree branch from the source session's current git state.
   *
   * Applies null-check guard when `session_forking` flag is disabled (Req 2.9).
   */
  async fork(options: ForkOptions): Promise<ForkResult> {
    // Null-check guard — zero overhead when disabled (Req 2.9)
    if (!this.featureGate.isEnabled('session_forking')) {
      return {
        success: false,
        error: 'Session forking is disabled via feature gate.',
      };
    }

    const { sourceSessionId, label, divergePrompt } = options;

    // Validate source session exists before expensive operations (Req 2.5)
    const sourceSession = this.sessionManager.get(sourceSessionId);
    if (!sourceSession) {
      return {
        success: false,
        error: `Source session not found: ${sourceSessionId}`,
      };
    }

    // Check concurrent session capacity (Req 2.7, 2.8)
    const stats = this.sessionManager.getStats(this.projectId);
    if (stats.total >= this.maxConcurrentSessions) {
      return {
        success: false,
        error: 'Cannot fork session: concurrent session capacity exhausted.',
      };
    }

    // Create new worktree branch from source session's git state (Req 2.1)
    const forkedSessionId = randomUUID();
    let worktreeBranch: string | undefined;

    try {
      const worktreeHandle = await this.worktreeIsolation.create(forkedSessionId);
      worktreeBranch = worktreeHandle.branch;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to create worktree branch for fork: ${errorMessage}`,
      };
    }

    // Create new session and persist via ParallelSessionManager (Req 2.2)
    const sessionName = label
      ? `Fork: ${label}`
      : `Fork of ${sourceSession.name}`;

    const createOpts: { projectId: string; name: string; agentId?: string; task?: string } = {
      projectId: this.projectId,
      name: sessionName,
    };
    if (sourceSession.agentId !== undefined) {
      createOpts.agentId = sourceSession.agentId;
    }
    const taskValue = divergePrompt ?? sourceSession.task;
    if (taskValue !== undefined) {
      createOpts.task = taskValue;
    }
    const forkedSession = this.sessionManager.create(createOpts);

    // Duplicate conversation history from source session (Req 2.1, 2.3)
    // Source session state is preserved without modification (Req 2.3)
    const messages = this.sessionManager.getMessages(sourceSessionId);
    for (const msg of messages) {
      this.sessionManager.addMessage(
        forkedSession.id,
        msg.role,
        msg.content,
        msg.agent,
      );
    }

    // Track fork relationship
    const existingForks = this.forkRegistry.get(sourceSessionId) ?? [];
    existingForks.push(forkedSession.id);
    this.forkRegistry.set(sourceSessionId, existingForks);

    return {
      success: true,
      forkedSession,
      forkedWorktreeBranch: worktreeBranch,
    };
  }

  /**
   * Get all sessions that were forked from the given source session.
   */
  getForksOf(sourceSessionId: string): ParallelSession[] {
    // Null-check guard — zero overhead when disabled (Req 2.9)
    if (!this.featureGate.isEnabled('session_forking')) {
      return [];
    }

    const forkedIds = this.forkRegistry.get(sourceSessionId) ?? [];
    const sessions: ParallelSession[] = [];

    for (const id of forkedIds) {
      const session = this.sessionManager.get(id);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }
}
