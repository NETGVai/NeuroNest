/**
 * CheckpointTimeline — Timeline data management for visual checkpoint UI.
 *
 * Auto-creates checkpoints at key moments: session start, before each
 * modification batch, and execution mode changes. Links each checkpoint to
 * its corresponding diff turn for coordinated restore. Enforces a per-session
 * limit of 50 checkpoints with LRU eviction for unstarred checkpoints.
 *
 * Builds on the existing CheckpointService API and is gated behind the
 * `checkpoint_timeline` feature flag (which requires `checkpoint`).
 *
 * Requirements: 16.2, 16.5, 16.6, 16.7
 */

import { randomUUID } from 'node:crypto';
import { CheckpointService, type CheckpointData } from './checkpoint-service.js';

// ─── Types ──────────────────────────────────────────────────────

/** Reason a checkpoint was created */
export type CheckpointTrigger = 'session_start' | 'modification_batch' | 'mode_change';

/** Metadata for a single checkpoint in the timeline */
export interface TimelineCheckpoint {
  id: string;
  sessionId: string;
  trigger: CheckpointTrigger;
  description: string;
  agentId: string | null;
  filesAffected: number;
  diffTurnId: string | null;
  starred: boolean;
  createdAt: number;
  lastAccessedAt: number;
}

/** Options for creating a checkpoint */
export interface CreateCheckpointOptions {
  sessionId: string;
  trigger: CheckpointTrigger;
  description?: string;
  agentId?: string | null;
  filesAffected?: number;
  diffTurnId?: string | null;
}

/** Configuration for the CheckpointTimeline */
export interface CheckpointTimelineConfig {
  maxCheckpointsPerSession: number; // default: 50
  featureEnabled: boolean;          // checkpoint_timeline flag state
}

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULT_CHECKPOINT_TIMELINE_CONFIG: CheckpointTimelineConfig = {
  maxCheckpointsPerSession: 50,
  featureEnabled: false,
};

// ─── CheckpointTimeline Service ─────────────────────────────────

/**
 * CheckpointTimeline — Lazy-initialized singleton managing a per-session
 * timeline of auto-created checkpoints with LRU pruning.
 *
 * Usage:
 *   const timeline = CheckpointTimeline.getInstance(checkpointService, config);
 *   timeline.createCheckpoint({ sessionId, trigger: 'session_start' });
 *   timeline.starCheckpoint(checkpointId);
 *   timeline.getTimeline(sessionId);
 */
export class CheckpointTimeline {
  private static instance: CheckpointTimeline | null = null;

  /** In-memory store of timeline checkpoints grouped by session */
  private sessions: Map<string, TimelineCheckpoint[]> = new Map();

  private constructor(
    private checkpointService: CheckpointService,
    private config: CheckpointTimelineConfig,
  ) {}

  /**
   * Get or create the singleton CheckpointTimeline instance.
   * Follows the project's lazy-initialization singleton pattern.
   */
  static getInstance(
    checkpointService: CheckpointService,
    config: CheckpointTimelineConfig = DEFAULT_CHECKPOINT_TIMELINE_CONFIG,
  ): CheckpointTimeline {
    if (!CheckpointTimeline.instance) {
      CheckpointTimeline.instance = new CheckpointTimeline(checkpointService, config);
    }
    return CheckpointTimeline.instance;
  }

  /**
   * Reset the singleton (useful for testing).
   */
  static resetInstance(): void {
    CheckpointTimeline.instance = null;
  }

  /**
   * Check whether the checkpoint timeline feature is enabled.
   * Requires both the `checkpoint_timeline` flag AND the parent `checkpoint` flag.
   */
  isEnabled(): boolean {
    return this.config.featureEnabled;
  }

  /**
   * Create a new checkpoint in the timeline.
   * If the feature is disabled, this is a no-op returning null.
   *
   * Auto-triggers LRU pruning when the per-session limit is exceeded.
   * Links the checkpoint to a diff turn if provided.
   *
   * Requirements: 16.2, 16.5, 16.6
   */
  createCheckpoint(options: CreateCheckpointOptions): TimelineCheckpoint | null {
    if (!this.config.featureEnabled) {
      return null;
    }

    const now = Date.now();
    const checkpoint: TimelineCheckpoint = {
      id: randomUUID(),
      sessionId: options.sessionId,
      trigger: options.trigger,
      description: options.description || this.getDefaultDescription(options.trigger),
      agentId: options.agentId ?? null,
      filesAffected: options.filesAffected ?? 0,
      diffTurnId: options.diffTurnId ?? null,
      starred: false,
      createdAt: now,
      lastAccessedAt: now,
    };

    // Add to session timeline
    const timeline = this.getOrCreateSessionTimeline(options.sessionId);
    timeline.push(checkpoint);

    // Enforce limit with LRU pruning
    this.enforceLimitForSession(options.sessionId);

    // Persist via CheckpointService
    this.persistCheckpoint(checkpoint);

    return checkpoint;
  }

  /**
   * Star/pin a checkpoint to prevent automatic LRU pruning.
   * Returns true if the checkpoint was found and starred.
   *
   * Requirement: 16.7 (referenced via 16.6 exemption)
   */
  starCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.findCheckpointById(checkpointId);
    if (!checkpoint) {
      return false;
    }
    checkpoint.starred = true;
    return true;
  }

  /**
   * Unstar a checkpoint, making it eligible for LRU pruning again.
   * Returns true if the checkpoint was found and unstarred.
   */
  unstarCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.findCheckpointById(checkpointId);
    if (!checkpoint) {
      return false;
    }
    checkpoint.starred = false;
    return true;
  }

  /**
   * Get the full timeline for a session, ordered by creation time.
   */
  getTimeline(sessionId: string): TimelineCheckpoint[] {
    const timeline = this.sessions.get(sessionId);
    if (!timeline) {
      return [];
    }
    return [...timeline].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get a specific checkpoint by ID.
   * Updates lastAccessedAt for LRU tracking.
   */
  getCheckpoint(checkpointId: string): TimelineCheckpoint | null {
    const checkpoint = this.findCheckpointById(checkpointId);
    if (checkpoint) {
      checkpoint.lastAccessedAt = Date.now();
    }
    return checkpoint ? { ...checkpoint } : null;
  }

  /**
   * Get the number of checkpoints in a session.
   */
  getCheckpointCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.length ?? 0;
  }

  /**
   * Get the checkpoint linked to a specific diff turn.
   * Used for coordinated restore between DiffViewer and CheckpointTimeline.
   *
   * Requirement: 16.5
   */
  getCheckpointByDiffTurn(sessionId: string, diffTurnId: string): TimelineCheckpoint | null {
    const timeline = this.sessions.get(sessionId);
    if (!timeline) {
      return null;
    }
    const checkpoint = timeline.find((cp) => cp.diffTurnId === diffTurnId);
    return checkpoint ? { ...checkpoint } : null;
  }

  /**
   * Remove a specific checkpoint from the timeline.
   * Starred checkpoints can still be removed manually.
   */
  removeCheckpoint(checkpointId: string): boolean {
    for (const [sessionId, timeline] of this.sessions.entries()) {
      const index = timeline.findIndex((cp) => cp.id === checkpointId);
      if (index !== -1) {
        timeline.splice(index, 1);
        if (timeline.length === 0) {
          this.sessions.delete(sessionId);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all checkpoints for a session (e.g., on session end).
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Get or create the in-memory timeline array for a session.
   */
  private getOrCreateSessionTimeline(sessionId: string): TimelineCheckpoint[] {
    let timeline = this.sessions.get(sessionId);
    if (!timeline) {
      timeline = [];
      this.sessions.set(sessionId, timeline);
    }
    return timeline;
  }

  /**
   * Enforce the per-session checkpoint limit using LRU eviction.
   * Starred checkpoints are exempt from pruning.
   *
   * Requirement: 16.6
   */
  private enforceLimitForSession(sessionId: string): void {
    const timeline = this.sessions.get(sessionId);
    if (!timeline) {
      return;
    }

    const limit = this.config.maxCheckpointsPerSession;

    while (timeline.length > limit) {
      // Find the oldest unstarred checkpoint by lastAccessedAt (LRU)
      const unstarred = timeline
        .filter((cp) => !cp.starred)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      if (unstarred.length === 0) {
        // All checkpoints are starred — cannot prune further
        break;
      }

      // Remove the least recently used unstarred checkpoint
      const victim = unstarred[0]!;
      const victimIndex = timeline.findIndex((cp) => cp.id === victim.id);
      if (victimIndex !== -1) {
        timeline.splice(victimIndex, 1);
      }
    }
  }

  /**
   * Persist checkpoint data using the existing CheckpointService API.
   * Stores timeline metadata in the customState field.
   *
   * Requirement: 16.5
   */
  private persistCheckpoint(checkpoint: TimelineCheckpoint): void {
    const data: CheckpointData = {
      schemaVersion: 1,
      sessionId: checkpoint.sessionId,
      timestamp: new Date(checkpoint.createdAt).toISOString(),
      conversationHistory: [],
      planProgress: { completedSteps: [], pendingSteps: [] },
      fileChangeManifest: [],
      iterationCount: 0,
      customState: {
        timelineCheckpointId: checkpoint.id,
        trigger: checkpoint.trigger,
        description: checkpoint.description,
        agentId: checkpoint.agentId,
        filesAffected: checkpoint.filesAffected,
        diffTurnId: checkpoint.diffTurnId,
        starred: checkpoint.starred,
      },
    };

    // Fire and forget — persistence is best-effort for timeline metadata
    this.checkpointService.save(data).catch((err) => {
      console.warn('[CheckpointTimeline] Failed to persist checkpoint:', err);
    });
  }

  /**
   * Generate a default description based on the trigger type.
   */
  private getDefaultDescription(trigger: CheckpointTrigger): string {
    switch (trigger) {
      case 'session_start':
        return 'Session started';
      case 'modification_batch':
        return 'Before modification batch';
      case 'mode_change':
        return 'Execution mode change';
      default:
        return 'Checkpoint';
    }
  }

  /**
   * Find a checkpoint by ID across all sessions.
   */
  private findCheckpointById(checkpointId: string): TimelineCheckpoint | null {
    for (const timeline of this.sessions.values()) {
      const checkpoint = timeline.find((cp) => cp.id === checkpointId);
      if (checkpoint) {
        return checkpoint;
      }
    }
    return null;
  }
}
