/**
 * MergeRestorationService — Enforces always-attempted merge restoration.
 *
 * On every restore request, opens and attempts the merge workflow even when no
 * initial conflict is detected. Preserves both states and leaves restoration
 * unapplied when safety cannot be proven.
 *
 * Requirements: 9.7, 9.8
 */

import { randomUUID } from 'node:crypto';

// ─── Merge Restoration Types ────────────────────────────────────────────────

/**
 * Source of an edit event in the timeline.
 */
export type EditSource = 'user' | 'agent' | 'system';

/**
 * Kind of timeline event projected chronologically.
 */
export type TimelineEntryKind =
  | 'user_edit'
  | 'agent_edit'
  | 'approval'
  | 'validation'
  | 'restore';

/**
 * A chronological entry in the change timeline with source attribution.
 */
export interface ChangeTimelineEntry {
  /** Unique entry ID. */
  readonly id: string;
  /** Kind of timeline entry. */
  kind: TimelineEntryKind;
  /** Who produced this entry. */
  source: EditSource;
  /** Actor ID (user ID, agent ID, or system service). */
  actorId: string;
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  /** Affected file URI (if applicable). */
  targetUri?: string | undefined;
  /** Description of the change. */
  description: string;
  /** Associated Change_Set ID (if applicable). */
  changeSetId?: string | undefined;
  /** Associated checkpoint ID (if applicable). */
  checkpointId?: string | undefined;
  /** Associated run ID (if applicable). */
  runId?: string | undefined;
  /** Associated task ID (if applicable). */
  taskId?: string | undefined;
}

/**
 * State of the merge workflow.
 */
export type MergeWorkflowState =
  | 'opened'
  | 'merging'
  | 'resolved'
  | 'failed'
  | 'aborted';

/**
 * Outcome of a merge restoration attempt.
 */
export type MergeRestorationOutcome =
  | 'applied'
  | 'left_unapplied'
  | 'merge_required'
  | 'aborted';

/**
 * A merge workflow opened for a restore request.
 */
export interface MergeWorkflow {
  /** Unique workflow ID. */
  readonly id: string;
  /** Source checkpoint ID. */
  readonly checkpointId: string;
  /** Current workflow state. */
  state: MergeWorkflowState;
  /** Files involved in the merge. */
  readonly files: readonly MergeFileEntry[];
  /** Whether conflicts were detected (initial or during merge). */
  hasConflicts: boolean;
  /** Whether safety was proven (safe to apply). */
  safetyProven: boolean;
  /** Reason safety could not be proven (if applicable). */
  unsafetyReason?: string;
  /** Timestamp when workflow was opened. */
  readonly openedAt: string;
  /** Timestamp when workflow completed. */
  completedAt?: string;
  /** The outcome of the merge attempt. */
  outcome?: MergeRestorationOutcome;
  /** Preserved current state snapshot (for both-states preservation). */
  readonly currentStateSnapshot: Record<string, string | null>;
  /** Preserved target state snapshot (checkpoint content). */
  readonly targetStateSnapshot: Record<string, string | null>;
}

/**
 * A file entry within a merge workflow.
 */
export interface MergeFileEntry {
  /** The file URI. */
  readonly uri: string;
  /** Hash of the current file content. */
  readonly currentHash: string | null;
  /** Hash of the target (checkpoint) content. */
  readonly targetHash: string;
  /** Whether this file has newer user edits. */
  readonly hasNewerEdits: boolean;
  /** Whether merge for this file succeeded. */
  mergeResolved: boolean;
  /** Content after merge resolution (null if unresolved). */
  mergedContent: string | null;
}

/**
 * Adapter for reading workspace content during merge restoration.
 */
export interface MergeWorkspaceAdapter {
  /** Gets content hash for a URI. */
  getContentHash(uri: string): string | null;
  /** Reads full content for a URI. */
  readContent(uri: string): string | null;
  /** Checks if a file exists. */
  exists(uri: string): boolean;
}

/**
 * Adapter for retrieving checkpoint content.
 */
export interface CheckpointContentAdapter {
  /** Gets content stored in a checkpoint for a URI. */
  getCheckpointContent(checkpointId: string, uri: string): string | null;
  /** Gets the resource snapshots for a checkpoint. */
  getResourceSnapshots(checkpointId: string): Record<string, string> | null;
}

// ─── MergeRestorationService ────────────────────────────────────────────────

/**
 * MergeRestorationService enforces the always-attempted merge restoration policy.
 *
 * Key invariant: On EVERY restore request, the merge workflow is opened and
 * attempted, regardless of whether initial conflict is detected. If safety
 * cannot be proven, the restoration is left unapplied and both states are
 * preserved.
 */
export class MergeRestorationService {
  private readonly workspace: MergeWorkspaceAdapter;
  private readonly checkpointContent: CheckpointContentAdapter;

  /** Active and completed merge workflows indexed by ID. */
  private readonly workflows = new Map<string, MergeWorkflow>();
  /** Chronological timeline of change events. */
  private readonly timeline: ChangeTimelineEntry[] = [];

  constructor(
    workspace: MergeWorkspaceAdapter,
    checkpointContent: CheckpointContentAdapter
  ) {
    this.workspace = workspace;
    this.checkpointContent = checkpointContent;
  }

  /**
   * Initiates a merge restoration attempt. Always opens the merge workflow,
   * even when no initial conflict is detected.
   *
   * Requirement 9.7: "THE system SHALL preserve newer user work and open a
   * merge workflow whether or not an initial conflict is detected."
   */
  initiateRestore(
    checkpointId: string,
    targetUris: readonly string[],
    actorId: string
  ): MergeWorkflow {
    const resourceSnapshots = this.checkpointContent.getResourceSnapshots(checkpointId);
    if (!resourceSnapshots) {
      throw new Error(`Checkpoint ${checkpointId} not found or has no resource snapshots`);
    }

    // Preserve both current and target states
    const currentStateSnapshot: Record<string, string | null> = {};
    const targetStateSnapshot: Record<string, string | null> = {};
    const files: MergeFileEntry[] = [];
    let hasConflicts = false;

    for (const uri of targetUris) {
      const targetHash = resourceSnapshots[uri];
      if (!targetHash) continue;

      const currentHash = this.workspace.getContentHash(uri);
      const currentContent = this.workspace.readContent(uri);
      const targetContent = this.checkpointContent.getCheckpointContent(checkpointId, uri);

      currentStateSnapshot[uri] = currentContent;
      targetStateSnapshot[uri] = targetContent;

      const hasNewerEdits = currentHash !== null && currentHash !== targetHash;
      if (hasNewerEdits) {
        hasConflicts = true;
      }

      files.push({
        uri,
        currentHash,
        targetHash,
        hasNewerEdits,
        mergeResolved: false,
        mergedContent: null,
      });
    }

    // Always open the merge workflow — this is the key invariant
    const workflow: MergeWorkflow = {
      id: randomUUID(),
      checkpointId,
      state: 'opened',
      files,
      hasConflicts,
      safetyProven: false,
      openedAt: new Date().toISOString(),
      currentStateSnapshot,
      targetStateSnapshot,
    };

    this.workflows.set(workflow.id, workflow);

    // Record the restore initiation in the timeline
    const timelineParams: Omit<ChangeTimelineEntry, 'id' | 'timestamp'> = {
      kind: 'restore',
      source: 'user',
      actorId,
      description: `Restore initiated from checkpoint ${checkpointId} (${targetUris.length} files, merge workflow opened${hasConflicts ? ' with conflicts' : ' without initial conflicts'})`,
      checkpointId,
    };
    if (targetUris.length === 1) {
      timelineParams.targetUri = targetUris[0];
    }
    this.recordTimelineEntry(timelineParams);

    return workflow;
  }

  /**
   * Attempts to resolve the merge for a file in the workflow.
   * If the file has no newer edits, the merge resolves cleanly to the target.
   * If the file has newer edits, guided resolution is required.
   */
  attemptFileMerge(
    workflowId: string,
    uri: string,
    resolvedContent?: string
  ): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Merge workflow ${workflowId} not found`);
    }
    if (workflow.state !== 'opened' && workflow.state !== 'merging') {
      throw new Error(`Merge workflow ${workflowId} is in state ${workflow.state}, cannot merge`);
    }

    workflow.state = 'merging';

    const file = workflow.files.find((f) => f.uri === uri) as MergeFileEntry | undefined;
    if (!file) {
      throw new Error(`File ${uri} not found in merge workflow ${workflowId}`);
    }

    if (!file.hasNewerEdits) {
      // No newer edits — resolves cleanly to checkpoint content
      const targetContent = workflow.targetStateSnapshot[uri];
      (file as { mergeResolved: boolean }).mergeResolved = true;
      (file as { mergedContent: string | null }).mergedContent = targetContent ?? null;
      return true;
    }

    if (resolvedContent !== undefined) {
      // User provided a resolved merge
      (file as { mergeResolved: boolean }).mergeResolved = true;
      (file as { mergedContent: string | null }).mergedContent = resolvedContent;
      return true;
    }

    // Guided resolution required — cannot auto-resolve
    return false;
  }

  /**
   * Completes the merge workflow. Proves safety only if all files are resolved.
   * If safety cannot be proven, leaves restoration unapplied and preserves both states.
   *
   * Requirement 9.7: "IF the merge workflow cannot complete safely, THEN THE system
   * SHALL leave the restoration unapplied, preserve both states, and require guided resolution."
   */
  completeMerge(workflowId: string): MergeWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Merge workflow ${workflowId} not found`);
    }

    const allResolved = workflow.files.every((f) => f.mergeResolved);

    if (allResolved) {
      workflow.safetyProven = true;
      workflow.state = 'resolved';
      workflow.outcome = 'applied';
    } else {
      workflow.safetyProven = false;
      workflow.state = 'failed';
      workflow.outcome = 'left_unapplied';
      workflow.unsafetyReason = `${workflow.files.filter((f) => !f.mergeResolved).length} file(s) have unresolved merge conflicts`;
    }

    workflow.completedAt = new Date().toISOString();
    return workflow;
  }

  /**
   * Aborts a merge workflow, leaving both states intact.
   */
  abortMerge(workflowId: string): MergeWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Merge workflow ${workflowId} not found`);
    }

    workflow.state = 'aborted';
    workflow.outcome = 'aborted';
    workflow.completedAt = new Date().toISOString();
    return workflow;
  }

  /**
   * Gets the preserved states for a workflow (both current and target).
   * Used to ensure that no data is lost during restoration.
   */
  getPreservedStates(workflowId: string): {
    current: Record<string, string | null>;
    target: Record<string, string | null>;
  } | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    return {
      current: { ...workflow.currentStateSnapshot },
      target: { ...workflow.targetStateSnapshot },
    };
  }

  /**
   * Gets a merge workflow by ID.
   */
  getWorkflow(workflowId: string): MergeWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Lists all merge workflows for a checkpoint.
   */
  listWorkflowsForCheckpoint(checkpointId: string): MergeWorkflow[] {
    return Array.from(this.workflows.values()).filter(
      (w) => w.checkpointId === checkpointId
    );
  }

  // ─── Change Timeline Projection ────────────────────────────────────────

  /**
   * Records a timeline entry for source-attributed changes.
   *
   * Requirement 9.8: "THE timeline SHALL display user edits, agent edits,
   * approvals, validation, and restores in chronological order with source attribution."
   */
  recordTimelineEntry(params: Omit<ChangeTimelineEntry, 'id' | 'timestamp'>): ChangeTimelineEntry {
    const entry: ChangeTimelineEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...params,
    };
    this.timeline.push(entry);
    return entry;
  }

  /**
   * Records a user edit in the timeline.
   */
  recordUserEdit(
    actorId: string,
    targetUri: string,
    description: string,
    changeSetId?: string
  ): ChangeTimelineEntry {
    const params: Omit<ChangeTimelineEntry, 'id' | 'timestamp'> = {
      kind: 'user_edit',
      source: 'user',
      actorId,
      targetUri,
      description,
    };
    if (changeSetId !== undefined) {
      params.changeSetId = changeSetId;
    }
    return this.recordTimelineEntry(params);
  }

  /**
   * Records an agent edit in the timeline.
   */
  recordAgentEdit(
    actorId: string,
    targetUri: string,
    description: string,
    changeSetId?: string,
    runId?: string,
    taskId?: string
  ): ChangeTimelineEntry {
    const params: Omit<ChangeTimelineEntry, 'id' | 'timestamp'> = {
      kind: 'agent_edit',
      source: 'agent',
      actorId,
      targetUri,
      description,
    };
    if (changeSetId !== undefined) {
      params.changeSetId = changeSetId;
    }
    if (runId !== undefined) {
      params.runId = runId;
    }
    if (taskId !== undefined) {
      params.taskId = taskId;
    }
    return this.recordTimelineEntry(params);
  }

  /**
   * Records an approval event in the timeline.
   */
  recordApproval(
    actorId: string,
    description: string,
    changeSetId?: string
  ): ChangeTimelineEntry {
    const params: Omit<ChangeTimelineEntry, 'id' | 'timestamp'> = {
      kind: 'approval',
      source: 'user',
      actorId,
      description,
    };
    if (changeSetId !== undefined) {
      params.changeSetId = changeSetId;
    }
    return this.recordTimelineEntry(params);
  }

  /**
   * Records a validation event in the timeline.
   */
  recordValidation(
    description: string,
    changeSetId?: string,
    runId?: string
  ): ChangeTimelineEntry {
    const params: Omit<ChangeTimelineEntry, 'id' | 'timestamp'> = {
      kind: 'validation',
      source: 'system',
      actorId: 'validation-service',
      description,
    };
    if (changeSetId !== undefined) {
      params.changeSetId = changeSetId;
    }
    if (runId !== undefined) {
      params.runId = runId;
    }
    return this.recordTimelineEntry(params);
  }

  /**
   * Gets the full chronological timeline with source attribution.
   * Returns entries sorted by timestamp.
   */
  getTimeline(): readonly ChangeTimelineEntry[] {
    return [...this.timeline].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp)
    );
  }

  /**
   * Gets timeline entries filtered by kind.
   */
  getTimelineByKind(kind: TimelineEntryKind): readonly ChangeTimelineEntry[] {
    return this.timeline
      .filter((e) => e.kind === kind)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Gets timeline entries for a specific file.
   */
  getTimelineForFile(uri: string): readonly ChangeTimelineEntry[] {
    return this.timeline
      .filter((e) => e.targetUri === uri)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Gets timeline entries for a specific Change_Set.
   */
  getTimelineForChangeSet(changeSetId: string): readonly ChangeTimelineEntry[] {
    return this.timeline
      .filter((e) => e.changeSetId === changeSetId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
