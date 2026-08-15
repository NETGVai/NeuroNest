/**
 * RecoverableSessionPersistence — Atomically or recoverably persists lightweight
 * session metadata separately from full ordered timeline records.
 *
 * Restores without replaying mutating tools. Supports branching edited prior turns
 * while preserving original branches and Change_Sets. Offers confirmed in-place
 * editing only after immutable preservation when branch storage fails.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface SessionMetadata {
  id: string;
  projectId: string;
  title: string;
  activeTaskId: string | null;
  agentId: string | null;
  selectedModelRoles: Record<string, string>;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'quarantined';
  lastSequenceNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineRecord {
  id: string;
  sessionId: string;
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown>;
  /** Linked Change_Set IDs associated with this timeline record */
  linkedChangeSetIds: string[];
  /** Linked Tool_Event IDs with accepted edits */
  linkedToolEventIds: string[];
  createdAt: string;
}

export interface ImmutableRecoveryRecord {
  id: string;
  sessionId: string;
  /** The original turn content before edit */
  originalContent: Record<string, unknown>;
  /** Linked Change_Set IDs that were preserved */
  preservedChangeSetIds: string[];
  /** Linked Tool_Event IDs that were preserved */
  preservedToolEventIds: string[];
  /** Branch ID this was created for (if branch succeeded) */
  branchId: string | null;
  /** Whether this is a fallback preservation (branch failed) */
  isFallbackPreservation: boolean;
  createdAt: string;
  fingerprint: string;
}

export interface BranchEditResult {
  success: boolean;
  branchId?: string;
  /** Whether in-place fallback was used */
  usedInPlaceFallback: boolean;
  /** ID of the immutable recovery record */
  recoveryRecordId?: string;
  error?: string;
}

export interface QuarantineRecord {
  id: string;
  sessionId: string;
  reason: string;
  rawData: string;
  recoverable: boolean;
  createdAt: string;
}

export interface LinkedRetentionImpact {
  checkpointIds: string[];
  worktreeIds: string[];
  artifactIds: string[];
  changeSetIds: string[];
  sourceRetentionDays: number | null;
}

export interface SessionDeletionPreview {
  sessionId: string;
  impacts: LinkedRetentionImpact;
  warnings: string[];
}

export interface PersistenceResult {
  success: boolean;
  error?: string;
}

/**
 * Optional interface for injecting branch storage behavior.
 * Allows testing failure scenarios.
 */
export interface BranchStorageProvider {
  /** If set, branch creation will use this to determine success/failure */
  canCreateBranch?: (sessionId: string, branchPoint: number) => boolean;
}

// ─── Service ────────────────────────────────────────────────────

export class RecoverableSessionPersistence {
  private branchStorageProvider: BranchStorageProvider | null = null;

  constructor(private readonly db: any) {
    this.ensureTables();
  }

  /**
   * Set an optional branch storage provider for testing or advanced scenarios.
   */
  setBranchStorageProvider(provider: BranchStorageProvider | null): void {
    this.branchStorageProvider = provider;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        active_task_id TEXT,
        agent_id TEXT,
        selected_model_roles TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'paused', 'completed', 'failed', 'quarantined')),
        last_sequence_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_metadata_project
        ON session_metadata(project_id);
      CREATE INDEX IF NOT EXISTS idx_session_metadata_status
        ON session_metadata(status);

      CREATE TABLE IF NOT EXISTS session_timeline_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        linked_change_set_ids TEXT NOT NULL DEFAULT '[]',
        linked_tool_event_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session_metadata(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_records_session_seq
        ON session_timeline_records(session_id, sequence_number ASC);

      CREATE TABLE IF NOT EXISTS immutable_recovery_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        original_content TEXT NOT NULL,
        preserved_change_set_ids TEXT NOT NULL DEFAULT '[]',
        preserved_tool_event_ids TEXT NOT NULL DEFAULT '[]',
        branch_id TEXT,
        is_fallback_preservation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session_metadata(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_records_session
        ON immutable_recovery_records(session_id);

      CREATE TABLE IF NOT EXISTS session_quarantine (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        raw_data TEXT NOT NULL,
        recoverable INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quarantine_session
        ON session_quarantine(session_id);

      CREATE TABLE IF NOT EXISTS session_linked_assets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('checkpoint', 'worktree', 'artifact', 'change_set')),
        asset_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session_metadata(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_linked_assets_session
        ON session_linked_assets(session_id, asset_type);
    `);
  }

  // ─── Metadata Persistence (R22.1, R22.2) ─────────────────────

  /**
   * Persist session metadata atomically. Writes metadata in one transaction
   * without requiring the full timeline to be committed simultaneously.
   * Uses INSERT with ON CONFLICT UPDATE to avoid CASCADE deletion of child rows.
   */
  persistMetadata(metadata: SessionMetadata): PersistenceResult {
    try {
      this.db
        .prepare(
          `INSERT INTO session_metadata
           (id, project_id, title, active_task_id, agent_id, selected_model_roles, status, last_sequence_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             title = excluded.title,
             active_task_id = excluded.active_task_id,
             agent_id = excluded.agent_id,
             selected_model_roles = excluded.selected_model_roles,
             status = excluded.status,
             last_sequence_number = excluded.last_sequence_number,
             updated_at = excluded.updated_at`,
        )
        .run(
          metadata.id,
          metadata.projectId,
          metadata.title,
          metadata.activeTaskId,
          metadata.agentId,
          JSON.stringify(metadata.selectedModelRoles),
          metadata.status,
          metadata.lastSequenceNumber,
          metadata.createdAt,
          metadata.updatedAt,
        );

      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Metadata persistence failed: ${err.message}` };
    }
  }

  /**
   * Persist a timeline record separately from metadata.
   * Uses a transaction to atomically update both the record and the session's
   * last_sequence_number.
   */
  persistTimelineRecord(record: TimelineRecord): PersistenceResult {
    try {
      const persistTx = this.db.transaction(() => {
        // Check session exists and is not quarantined
        const session = this.db
          .prepare('SELECT status FROM session_metadata WHERE id = ?')
          .get(record.sessionId) as { status: string } | undefined;

        if (!session) {
          throw new Error(`Session not found: ${record.sessionId}`);
        }
        if (session.status === 'quarantined') {
          throw new Error(`Session is quarantined: ${record.sessionId}`);
        }

        // Insert timeline record
        this.db
          .prepare(
            `INSERT INTO session_timeline_records
             (id, session_id, sequence_number, event_type, payload, linked_change_set_ids, linked_tool_event_ids, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.sessionId,
            record.sequenceNumber,
            record.eventType,
            JSON.stringify(record.payload),
            JSON.stringify(record.linkedChangeSetIds),
            JSON.stringify(record.linkedToolEventIds),
            record.createdAt,
          );

        // Update last sequence number on metadata
        this.db
          .prepare(
            `UPDATE session_metadata SET last_sequence_number = ?, updated_at = ? WHERE id = ? AND last_sequence_number < ?`,
          )
          .run(record.sequenceNumber, new Date().toISOString(), record.sessionId, record.sequenceNumber);
      });

      persistTx();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Timeline record persistence failed: ${err.message}` };
    }
  }

  // ─── Restore Without Replay (R22.3) ──────────────────────────

  /**
   * Restore a session state from metadata and timeline without replaying mutating tools.
   * Returns the metadata and timeline records as-is for the caller to reconstruct state.
   */
  restoreSession(sessionId: string): {
    metadata: SessionMetadata | null;
    timelineRecords: TimelineRecord[];
    quarantined: boolean;
  } {
    const row = this.db
      .prepare('SELECT * FROM session_metadata WHERE id = ?')
      .get(sessionId) as any;

    if (!row) {
      return { metadata: null, timelineRecords: [], quarantined: false };
    }

    if (row.status === 'quarantined') {
      return { metadata: this.rowToMetadata(row), timelineRecords: [], quarantined: true };
    }

    const records = this.db
      .prepare(
        `SELECT * FROM session_timeline_records WHERE session_id = ? ORDER BY sequence_number ASC`,
      )
      .all(sessionId) as any[];

    return {
      metadata: this.rowToMetadata(row),
      timelineRecords: records.map((r) => this.rowToTimelineRecord(r)),
      quarantined: false,
    };
  }

  // ─── Branching with Immutable Preservation (R22.4) ────────────

  /**
   * Branch an edited prior turn while preserving the original branch and its Change_Sets.
   *
   * If branch creation fails due to storage failure, offers confirmed in-place editing
   * fallback ONLY after preserving prior turn content and linked Change_Sets as an
   * immutable recovery and audit record. If that prior state cannot be preserved,
   * blocks in-place editing and reports the storage failure.
   */
  branchEditedTurn(
    sessionId: string,
    sequenceNumber: number,
    newContent: Record<string, unknown>,
    options?: { allowInPlaceFallback?: boolean },
  ): BranchEditResult {
    // 1. Get the existing turn at this sequence
    const existingRecord = this.db
      .prepare(
        `SELECT * FROM session_timeline_records WHERE session_id = ? AND sequence_number = ?`,
      )
      .get(sessionId, sequenceNumber) as any;

    if (!existingRecord) {
      return {
        success: false,
        usedInPlaceFallback: false,
        error: `No timeline record found at sequence ${sequenceNumber} for session ${sessionId}`,
      };
    }

    const originalContent = JSON.parse(existingRecord.payload);
    const linkedChangeSetIds: string[] = JSON.parse(existingRecord.linked_change_set_ids);
    const linkedToolEventIds: string[] = JSON.parse(existingRecord.linked_tool_event_ids);

    // 2. Attempt to create immutable recovery record FIRST
    const recoveryRecord = this.createImmutableRecoveryRecord(
      sessionId,
      originalContent,
      linkedChangeSetIds,
      linkedToolEventIds,
    );

    if (!recoveryRecord) {
      // Cannot preserve prior state — BLOCK in-place editing (R22.4 final clause)
      return {
        success: false,
        usedInPlaceFallback: false,
        error: 'Cannot preserve prior state: storage failure. In-place editing is blocked.',
      };
    }

    // 3. Attempt to create a new branch
    const branchResult = this.attemptBranchCreation(sessionId, sequenceNumber, newContent);

    if (branchResult.success) {
      // Update recovery record with branch ID
      this.db
        .prepare('UPDATE immutable_recovery_records SET branch_id = ? WHERE id = ?')
        .run(branchResult.branchId, recoveryRecord.id);

      return {
        success: true,
        branchId: branchResult.branchId,
        usedInPlaceFallback: false,
        recoveryRecordId: recoveryRecord.id,
      };
    }

    // 4. Branch creation failed — offer in-place fallback only if allowed
    if (options?.allowInPlaceFallback) {
      // Mark recovery record as fallback preservation
      this.db
        .prepare('UPDATE immutable_recovery_records SET is_fallback_preservation = 1 WHERE id = ?')
        .run(recoveryRecord.id);

      // Perform in-place edit
      const editResult = this.performInPlaceEdit(sessionId, sequenceNumber, newContent);

      if (editResult.success) {
        return {
          success: true,
          usedInPlaceFallback: true,
          recoveryRecordId: recoveryRecord.id,
        };
      }

      return {
        success: false,
        usedInPlaceFallback: false,
        recoveryRecordId: recoveryRecord.id,
        error: `In-place edit failed after preservation: ${editResult.error}`,
      };
    }

    // Branch failed and in-place not allowed
    return {
      success: false,
      usedInPlaceFallback: false,
      recoveryRecordId: recoveryRecord.id,
      error: `Branch creation failed: ${branchResult.error}. In-place fallback not confirmed.`,
    };
  }

  // ─── Regeneration with Preserved Edits (R22.5) ───────────────

  /**
   * Regenerate an assistant turn while preserving accepted edits and Tool_Events
   * from the prior branch.
   */
  regenerateTurn(
    sessionId: string,
    sequenceNumber: number,
    newContent: Record<string, unknown>,
  ): PersistenceResult {
    try {
      const regenerateTx = this.db.transaction(() => {
        const existingRecord = this.db
          .prepare(
            'SELECT * FROM session_timeline_records WHERE session_id = ? AND sequence_number = ?',
          )
          .get(sessionId, sequenceNumber) as any;

        if (!existingRecord) {
          throw new Error(`No timeline record at sequence ${sequenceNumber}`);
        }

        // Preserve the original as an immutable recovery record
        const originalContent = JSON.parse(existingRecord.payload);
        const linkedChangeSetIds: string[] = JSON.parse(existingRecord.linked_change_set_ids);
        const linkedToolEventIds: string[] = JSON.parse(existingRecord.linked_tool_event_ids);

        const recoveryId = randomUUID();
        const now = new Date().toISOString();
        const fingerprint = this.computeFingerprint(sessionId, originalContent);

        this.db
          .prepare(
            `INSERT INTO immutable_recovery_records
             (id, session_id, original_content, preserved_change_set_ids, preserved_tool_event_ids, branch_id, is_fallback_preservation, created_at, fingerprint)
             VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
          )
          .run(
            recoveryId,
            sessionId,
            JSON.stringify(originalContent),
            JSON.stringify(linkedChangeSetIds),
            JSON.stringify(linkedToolEventIds),
            now,
            fingerprint,
          );

        // Update the record with new content but keep the linked edits and tool events
        this.db
          .prepare(
            `UPDATE session_timeline_records SET payload = ? WHERE id = ?`,
          )
          .run(JSON.stringify(newContent), existingRecord.id);
      });

      regenerateTx();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Regeneration failed: ${err.message}` };
    }
  }

  // ─── Quarantine (R22.6) ──────────────────────────────────────

  /**
   * Quarantine a malformed or partially written history without blocking other sessions.
   */
  quarantineSession(sessionId: string, reason: string): PersistenceResult {
    try {
      const quarantineTx = this.db.transaction(() => {
        // Get all timeline records for this session as raw data
        const records = this.db
          .prepare('SELECT * FROM session_timeline_records WHERE session_id = ?')
          .all(sessionId) as any[];

        const rawData = JSON.stringify(records);

        // Create quarantine record
        const quarantineId = randomUUID();
        const now = new Date().toISOString();

        this.db
          .prepare(
            `INSERT INTO session_quarantine (id, session_id, reason, raw_data, recoverable, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`,
          )
          .run(quarantineId, sessionId, reason, rawData, now);

        // Mark the session as quarantined (does NOT delete it)
        this.db
          .prepare("UPDATE session_metadata SET status = 'quarantined', updated_at = ? WHERE id = ?")
          .run(now, sessionId);
      });

      quarantineTx();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Quarantine failed: ${err.message}` };
    }
  }

  /**
   * Attempt to recover a quarantined session.
   */
  recoverQuarantinedSession(sessionId: string): PersistenceResult {
    const quarantine = this.db
      .prepare(
        'SELECT * FROM session_quarantine WHERE session_id = ? AND recoverable = 1 ORDER BY created_at DESC LIMIT 1',
      )
      .get(sessionId) as any;

    if (!quarantine) {
      return { success: false, error: `No recoverable quarantine record found for session: ${sessionId}` };
    }

    try {
      this.db
        .prepare("UPDATE session_metadata SET status = 'active', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sessionId);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Recovery failed: ${err.message}` };
    }
  }

  // ─── Linked Retention Disclosure (R22.7) ─────────────────────

  /**
   * Disclose linked retention impacts before session deletion.
   * Returns a preview of what will be affected.
   */
  previewDeletionImpact(sessionId: string): SessionDeletionPreview {
    const checkpoints = this.getLinkedAssets(sessionId, 'checkpoint');
    const worktrees = this.getLinkedAssets(sessionId, 'worktree');
    const artifacts = this.getLinkedAssets(sessionId, 'artifact');
    const changeSets = this.getLinkedAssets(sessionId, 'change_set');

    const warnings: string[] = [];

    if (checkpoints.length > 0) {
      warnings.push(`${checkpoints.length} checkpoint(s) will lose their session reference.`);
    }
    if (worktrees.length > 0) {
      warnings.push(`${worktrees.length} worktree(s) may become orphaned.`);
    }
    if (artifacts.length > 0) {
      warnings.push(`${artifacts.length} artifact(s) will lose session provenance.`);
    }
    if (changeSets.length > 0) {
      warnings.push(`${changeSets.length} Change_Set(s) will lose session correlation.`);
    }

    // Check for recovery records that reference this session
    const recoveryCount = this.db
      .prepare('SELECT COUNT(*) as count FROM immutable_recovery_records WHERE session_id = ?')
      .get(sessionId) as { count: number };

    if (recoveryCount.count > 0) {
      warnings.push(
        `${recoveryCount.count} immutable recovery record(s) will be deleted. Branch history may be lost.`,
      );
    }

    return {
      sessionId,
      impacts: {
        checkpointIds: checkpoints,
        worktreeIds: worktrees,
        artifactIds: artifacts,
        changeSetIds: changeSets,
        sourceRetentionDays: 30, // default local-only retention
      },
      warnings,
    };
  }

  /**
   * Link an asset to a session for retention tracking.
   */
  linkAsset(sessionId: string, assetType: string, assetId: string): void {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_linked_assets (id, session_id, asset_type, asset_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, assetType, assetId, new Date().toISOString());
  }

  // ─── Queries ─────────────────────────────────────────────────

  /**
   * Get metadata for a session (without loading the full timeline).
   */
  getMetadata(sessionId: string): SessionMetadata | null {
    const row = this.db
      .prepare('SELECT * FROM session_metadata WHERE id = ?')
      .get(sessionId) as any;

    return row ? this.rowToMetadata(row) : null;
  }

  /**
   * List all non-quarantined sessions for a project.
   */
  listActiveSessions(projectId: string): SessionMetadata[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_metadata WHERE project_id = ? AND status != 'quarantined' ORDER BY updated_at DESC",
      )
      .all(projectId) as any[];

    return rows.map((r) => this.rowToMetadata(r));
  }

  /**
   * Get immutable recovery records for a session (for audit/restore).
   */
  getRecoveryRecords(sessionId: string): ImmutableRecoveryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM immutable_recovery_records WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as any[];

    return rows.map((r) => this.rowToRecoveryRecord(r));
  }

  /**
   * Get quarantine records for a session.
   */
  getQuarantineRecords(sessionId: string): QuarantineRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM session_quarantine WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as any[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      reason: r.reason,
      rawData: r.raw_data,
      recoverable: r.recoverable === 1,
      createdAt: r.created_at,
    }));
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private createImmutableRecoveryRecord(
    sessionId: string,
    originalContent: Record<string, unknown>,
    linkedChangeSetIds: string[],
    linkedToolEventIds: string[],
  ): ImmutableRecoveryRecord | null {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const fingerprint = this.computeFingerprint(sessionId, originalContent);

      this.db
        .prepare(
          `INSERT INTO immutable_recovery_records
           (id, session_id, original_content, preserved_change_set_ids, preserved_tool_event_ids, branch_id, is_fallback_preservation, created_at, fingerprint)
           VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          JSON.stringify(originalContent),
          JSON.stringify(linkedChangeSetIds),
          JSON.stringify(linkedToolEventIds),
          now,
          fingerprint,
        );

      return {
        id,
        sessionId,
        originalContent,
        preservedChangeSetIds: linkedChangeSetIds,
        preservedToolEventIds: linkedToolEventIds,
        branchId: null,
        isFallbackPreservation: false,
        createdAt: now,
        fingerprint,
      };
    } catch {
      return null;
    }
  }

  private attemptBranchCreation(
    sessionId: string,
    branchPoint: number,
    newContent: Record<string, unknown>,
  ): { success: boolean; branchId?: string; error?: string } {
    // Check if branch storage provider indicates failure
    if (this.branchStorageProvider?.canCreateBranch) {
      if (!this.branchStorageProvider.canCreateBranch(sessionId, branchPoint)) {
        return { success: false, error: 'Branch storage unavailable' };
      }
    }

    try {
      const branchId = randomUUID();
      const now = new Date().toISOString();
      const newRecordId = randomUUID();

      // Find the next available sequence number above the branch point
      const maxSeqRow = this.db
        .prepare(
          'SELECT MAX(sequence_number) as max_seq FROM session_timeline_records WHERE session_id = ?',
        )
        .get(sessionId) as { max_seq: number | null } | undefined;

      const nextSeq = (maxSeqRow?.max_seq ?? branchPoint) + 1;

      const branchTx = this.db.transaction(() => {
        // Insert the branched record at the next available sequence
        this.db
          .prepare(
            `INSERT INTO session_timeline_records
             (id, session_id, sequence_number, event_type, payload, linked_change_set_ids, linked_tool_event_ids, created_at)
             VALUES (?, ?, ?, 'message', ?, '[]', '[]', ?)`,
          )
          .run(newRecordId, sessionId, nextSeq, JSON.stringify(newContent), now);
      });

      branchTx();

      return { success: true, branchId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private performInPlaceEdit(
    sessionId: string,
    sequenceNumber: number,
    newContent: Record<string, unknown>,
  ): PersistenceResult {
    try {
      this.db
        .prepare(
          `UPDATE session_timeline_records SET payload = ? WHERE session_id = ? AND sequence_number = ?`,
        )
        .run(JSON.stringify(newContent), sessionId, sequenceNumber);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private getLinkedAssets(sessionId: string, assetType: string): string[] {
    const rows = this.db
      .prepare('SELECT asset_id FROM session_linked_assets WHERE session_id = ? AND asset_type = ?')
      .all(sessionId, assetType) as Array<{ asset_id: string }>;

    return rows.map((r) => r.asset_id);
  }

  private rowToMetadata(row: any): SessionMetadata {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      activeTaskId: row.active_task_id ?? null,
      agentId: row.agent_id ?? null,
      selectedModelRoles: JSON.parse(row.selected_model_roles || '{}'),
      status: row.status,
      lastSequenceNumber: row.last_sequence_number,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTimelineRecord(row: any): TimelineRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      sequenceNumber: row.sequence_number,
      eventType: row.event_type,
      payload: JSON.parse(row.payload),
      linkedChangeSetIds: JSON.parse(row.linked_change_set_ids || '[]'),
      linkedToolEventIds: JSON.parse(row.linked_tool_event_ids || '[]'),
      createdAt: row.created_at,
    };
  }

  private rowToRecoveryRecord(row: any): ImmutableRecoveryRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      originalContent: JSON.parse(row.original_content),
      preservedChangeSetIds: JSON.parse(row.preserved_change_set_ids || '[]'),
      preservedToolEventIds: JSON.parse(row.preserved_tool_event_ids || '[]'),
      branchId: row.branch_id ?? null,
      isFallbackPreservation: row.is_fallback_preservation === 1,
      createdAt: row.created_at,
      fingerprint: row.fingerprint,
    };
  }

  private computeFingerprint(sessionId: string, content: Record<string, unknown>): string {
    const data = `${sessionId}:${JSON.stringify(content)}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `fp_${Math.abs(hash).toString(36)}`;
  }
}
