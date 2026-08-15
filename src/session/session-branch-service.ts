/**
 * SessionBranchService — Forks timeline state from any sequence point,
 * preserving the trunk (original timeline) intact.
 *
 * Supports switching between trunk and branches while preserving
 * original Change_Sets and tool events on the trunk.
 *
 * Requirements: 22.2, 22.4, 22.5
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  sequenceNumber: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionBranch {
  id: string;
  sessionId: string;
  /** The trunk or parent branch this was forked from */
  parentBranchId: string | null;
  /** Sequence number in the parent where this branch diverges */
  branchPoint: number;
  /** Label for user identification */
  label: string;
  /** Whether this is the trunk (original timeline) */
  isTrunk: boolean;
  /** Events specific to this branch (after the branch point) */
  events: TimelineEvent[];
  /** Context state at the branch point (copied from parent) */
  contextAtBranchPoint: Record<string, unknown>;
  createdAt: string;
}

export interface BranchCreateResult {
  success: boolean;
  branch?: SessionBranch;
  error?: string;
}

export interface BranchSwitchResult {
  success: boolean;
  activeBranch?: SessionBranch;
  /** Combined events: parent events up to branch point + branch events */
  effectiveTimeline: TimelineEvent[];
  error?: string;
}

// ─── Service ────────────────────────────────────────────────────

export class SessionBranchService {
  constructor(private readonly db: any) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_branches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_branch_id TEXT,
        branch_point INTEGER NOT NULL,
        label TEXT NOT NULL,
        is_trunk INTEGER NOT NULL DEFAULT 0,
        context_at_branch_point TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_branches_session
        ON session_branches(session_id);

      CREATE TABLE IF NOT EXISTS branch_events (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (branch_id) REFERENCES session_branches(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_branch_events_branch
        ON branch_events(branch_id, sequence_number ASC);

      CREATE TABLE IF NOT EXISTS active_branch (
        session_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        FOREIGN KEY (branch_id) REFERENCES session_branches(id)
      );
    `);
  }

  /**
   * Initialize a trunk for a session. Called once when a session is created.
   * The trunk represents the original unmodified timeline.
   */
  initializeTrunk(sessionId: string, initialContext?: Record<string, unknown>): SessionBranch {
    const existing = this.getTrunk(sessionId);
    if (existing) return existing;

    const id = randomUUID();
    const now = new Date().toISOString();
    const context = initialContext ?? {};

    this.db
      .prepare(
        `INSERT INTO session_branches
         (id, session_id, parent_branch_id, branch_point, label, is_trunk, context_at_branch_point, created_at)
         VALUES (?, ?, NULL, 0, ?, 1, ?, ?)`,
      )
      .run(id, sessionId, 'trunk', JSON.stringify(context), now);

    // Set as active branch
    this.db
      .prepare(`INSERT OR REPLACE INTO active_branch (session_id, branch_id) VALUES (?, ?)`)
      .run(sessionId, id);

    return {
      id,
      sessionId,
      parentBranchId: null,
      branchPoint: 0,
      label: 'trunk',
      isTrunk: true,
      events: [],
      contextAtBranchPoint: context,
      createdAt: now,
    };
  }

  /**
   * Create a branch from a specific sequence point.
   * The trunk is preserved intact.
   */
  createBranch(
    sessionId: string,
    branchPoint: number,
    label: string,
    contextAtPoint: Record<string, unknown>,
  ): BranchCreateResult {
    const trunk = this.getTrunk(sessionId);
    if (!trunk) {
      return {
        success: false,
        error: `No trunk found for session: ${sessionId}. Initialize trunk first.`,
      };
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO session_branches
         (id, session_id, parent_branch_id, branch_point, label, is_trunk, context_at_branch_point, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, sessionId, trunk.id, branchPoint, label, JSON.stringify(contextAtPoint), now);

    const branch: SessionBranch = {
      id,
      sessionId,
      parentBranchId: trunk.id,
      branchPoint,
      label,
      isTrunk: false,
      events: [],
      contextAtBranchPoint: contextAtPoint,
      createdAt: now,
    };

    return { success: true, branch };
  }

  /**
   * Add an event to a branch's timeline.
   */
  addEvent(branchId: string, event: Omit<TimelineEvent, 'id'>): TimelineEvent {
    const id = randomUUID();
    const fullEvent: TimelineEvent = { ...event, id };

    this.db
      .prepare(
        `INSERT INTO branch_events (id, branch_id, sequence_number, event_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, branchId, event.sequenceNumber, event.type, JSON.stringify(event.payload), event.createdAt);

    return fullEvent;
  }

  /**
   * Switch the active branch for a session.
   * Returns the effective timeline (parent events up to branch point + branch events).
   */
  switchBranch(sessionId: string, branchId: string): BranchSwitchResult {
    const branch = this.getBranch(branchId);
    if (!branch) {
      return {
        success: false,
        effectiveTimeline: [],
        error: `Branch not found: ${branchId}`,
      };
    }

    if (branch.sessionId !== sessionId) {
      return {
        success: false,
        effectiveTimeline: [],
        error: `Branch ${branchId} does not belong to session ${sessionId}`,
      };
    }

    // Update active branch
    this.db
      .prepare(`INSERT OR REPLACE INTO active_branch (session_id, branch_id) VALUES (?, ?)`)
      .run(sessionId, branchId);

    // Build effective timeline
    const effectiveTimeline = this.buildEffectiveTimeline(branch);

    return {
      success: true,
      activeBranch: branch,
      effectiveTimeline,
    };
  }

  /**
   * Get the trunk for a session.
   */
  getTrunk(sessionId: string): SessionBranch | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, parent_branch_id, branch_point, label, is_trunk, context_at_branch_point, created_at
         FROM session_branches
         WHERE session_id = ? AND is_trunk = 1`,
      )
      .get(sessionId) as any;

    if (!row) return null;
    return this.rowToBranch(row);
  }

  /**
   * Get a specific branch by ID.
   */
  getBranch(branchId: string): SessionBranch | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, parent_branch_id, branch_point, label, is_trunk, context_at_branch_point, created_at
         FROM session_branches
         WHERE id = ?`,
      )
      .get(branchId) as any;

    if (!row) return null;
    return this.rowToBranch(row);
  }

  /**
   * List all branches for a session.
   */
  listBranches(sessionId: string): SessionBranch[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, parent_branch_id, branch_point, label, is_trunk, context_at_branch_point, created_at
         FROM session_branches
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as any[];

    return rows.map((row) => this.rowToBranch(row));
  }

  /**
   * Get the currently active branch for a session.
   */
  getActiveBranch(sessionId: string): SessionBranch | null {
    const row = this.db
      .prepare(
        `SELECT b.id, b.session_id, b.parent_branch_id, b.branch_point, b.label, b.is_trunk, b.context_at_branch_point, b.created_at
         FROM session_branches b
         INNER JOIN active_branch ab ON ab.branch_id = b.id
         WHERE ab.session_id = ?`,
      )
      .get(sessionId) as any;

    if (!row) return null;
    return this.rowToBranch(row);
  }

  /**
   * Get all events for a branch.
   */
  getBranchEvents(branchId: string): TimelineEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, sequence_number, event_type, payload, created_at
         FROM branch_events
         WHERE branch_id = ?
         ORDER BY sequence_number ASC`,
      )
      .all(branchId) as any[];

    return rows.map((row: any) => ({
      id: row.id,
      sequenceNumber: row.sequence_number,
      type: row.event_type,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    }));
  }

  /**
   * Build the effective timeline for a branch:
   * - If trunk: all trunk events
   * - If branch: parent events up to branch point + branch-specific events
   */
  private buildEffectiveTimeline(branch: SessionBranch): TimelineEvent[] {
    if (branch.isTrunk) {
      return this.getBranchEvents(branch.id);
    }

    const timeline: TimelineEvent[] = [];

    // Get parent events up to and including the branch point
    if (branch.parentBranchId) {
      const parentEvents = this.db
        .prepare(
          `SELECT id, sequence_number, event_type, payload, created_at
           FROM branch_events
           WHERE branch_id = ? AND sequence_number <= ?
           ORDER BY sequence_number ASC`,
        )
        .all(branch.parentBranchId, branch.branchPoint) as any[];

      for (const row of parentEvents) {
        timeline.push({
          id: row.id,
          sequenceNumber: row.sequence_number,
          type: row.event_type,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
        });
      }
    }

    // Append branch-specific events
    const branchEvents = this.getBranchEvents(branch.id);
    timeline.push(...branchEvents);

    return timeline;
  }

  private rowToBranch(row: any): SessionBranch {
    const events = this.getBranchEvents(row.id);
    return {
      id: row.id,
      sessionId: row.session_id,
      parentBranchId: row.parent_branch_id ?? null,
      branchPoint: row.branch_point,
      label: row.label,
      isTrunk: row.is_trunk === 1,
      events,
      contextAtBranchPoint: JSON.parse(row.context_at_branch_point),
      createdAt: row.created_at,
    };
  }
}
