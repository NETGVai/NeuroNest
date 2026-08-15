/**
 * Core types for the immutable multi-file Change_Set system.
 *
 * A Change_Set groups agent-originated file mutations under a unique stable ID,
 * supports create/modify/rename/move/delete operations, tracks base revision,
 * and follows a state machine from streaming through applied or rejected.
 */

/**
 * Allowed states for a Change_Set.
 * The state machine transitions are:
 *   streaming → incomplete | ready
 *   incomplete → ready | rejected | failed
 *   ready → reviewing
 *   reviewing → accepted | rejected
 *   accepted → applying
 *   applying → applied | failed
 *   rejected (terminal)
 *   applied (terminal)
 *   conflicted → ready | rejected
 *   failed (terminal)
 */
export type ChangeSetState =
  | 'streaming'
  | 'incomplete'
  | 'ready'
  | 'reviewing'
  | 'accepted'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'conflicted'
  | 'failed';

/**
 * Valid state transitions. Maps current state to allowed next states.
 */
export const VALID_STATE_TRANSITIONS: Record<ChangeSetState, readonly ChangeSetState[]> = {
  streaming: ['incomplete', 'ready', 'failed'],
  incomplete: ['ready', 'rejected', 'failed'],
  ready: ['reviewing', 'rejected'],
  reviewing: ['accepted', 'rejected', 'conflicted'],
  accepted: ['applying'],
  applying: ['applied', 'failed'],
  applied: [],
  rejected: [],
  conflicted: ['ready', 'rejected'],
  failed: [],
} as const;

/** Terminal states — once in these, no further transitions are allowed. */
export const TERMINAL_STATES: readonly ChangeSetState[] = ['applied', 'rejected', 'failed'];

/**
 * A file operation within a Change_Set.
 * Operations are immutable once the Change_Set leaves the 'streaming' state.
 */
export type FileOperation =
  | CreateOperation
  | ModifyOperation
  | RenameOperation
  | MoveOperation
  | DeleteOperation;

export interface CreateOperation {
  readonly kind: 'create';
  readonly targetUri: string;
  readonly proposedBlob: string;
}

export interface ModifyOperation {
  readonly kind: 'modify';
  readonly targetUri: string;
  readonly baseHash: string;
  readonly baseVersion?: number;
  readonly proposedBlob: string;
}

export interface RenameOperation {
  readonly kind: 'rename';
  readonly sourceUri: string;
  readonly targetUri: string;
  readonly baseHash: string;
  readonly baseVersion?: number;
}

export interface MoveOperation {
  readonly kind: 'move';
  readonly sourceUri: string;
  readonly targetUri: string;
  readonly baseHash: string;
  readonly baseVersion?: number;
}

export interface DeleteOperation {
  readonly kind: 'delete';
  readonly targetUri: string;
  readonly baseHash: string;
  readonly baseVersion?: number;
}

/**
 * Risk level for a Change_Set or individual operation.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Validation status for a Change_Set.
 */
export type ValidationStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'stale';

/**
 * Summary of a single file operation within a Change_Set.
 */
export interface FileOperationSummary {
  /** The target file URI */
  readonly targetUri: string;
  /** Operation kind */
  readonly kind: FileOperation['kind'];
  /** Number of lines added (0 for rename/move/delete) */
  readonly additions: number;
  /** Number of lines removed (0 for create/rename/move) */
  readonly removals: number;
  /** Number of hunks in this operation */
  readonly hunkCount: number;
  /** Whether this is a binary file */
  readonly isBinary: boolean;
  /** Risk flags for this operation */
  readonly riskFlags: readonly string[];
}

/**
 * Bidirectional provenance linking a Change_Set to related execution entities.
 */
export interface ChangeSetProvenance {
  /** Tool_Event IDs that produced or relate to this Change_Set */
  readonly toolEventIds: readonly string[];
  /** Checkpoint ID created before application (if any) */
  readonly preApplyCheckpointId: string | null;
  /** Checkpoint ID created after application (if any) */
  readonly postApplyCheckpointId: string | null;
  /** Evidence IDs linked to this Change_Set */
  readonly evidenceIds: readonly string[];
  /** Chat turn IDs that reference this Change_Set */
  readonly chatTurnIds: readonly string[];
}

/**
 * An immutable Change_Set representing a coordinated multi-file proposal.
 */
export interface ChangeSet {
  /** Unique stable identifier (UUID v4). */
  readonly id: string;
  /** Workspace this Change_Set belongs to. */
  readonly workspaceId: string;
  /** The Task this Change_Set is linked to. */
  readonly taskId: string;
  /** The Agent_Run that produced this Change_Set. */
  readonly runId: string;
  /** The chat event that originated this Change_Set. */
  readonly chatEventId: string;
  /** Base workspace revision this proposal is relative to. */
  readonly baseRevision: string;
  /** Current state in the lifecycle. */
  readonly state: ChangeSetState;
  /** Immutable list of file operations. */
  readonly operations: readonly FileOperation[];
  /** Content fingerprint for integrity checking. */
  readonly fingerprint: string;
  /** Creation timestamp (ISO 8601). */
  readonly createdAt: string;
  /** Last state transition timestamp (ISO 8601). */
  readonly updatedAt: string;
  /** Derived file/hunk summaries for this Change_Set. */
  readonly summaries: readonly FileOperationSummary[];
  /** Aggregate risk level for the entire Change_Set. */
  readonly risk: RiskLevel;
  /** Dependency order index — lower values should apply first. */
  readonly dependencyOrder: number;
  /** Validation status of this Change_Set. */
  readonly validationStatus: ValidationStatus;
  /** Bidirectional provenance links to execution entities. */
  readonly provenance: ChangeSetProvenance;
}

/**
 * Parameters for creating a new Change_Set.
 */
export interface CreateChangeSetParams {
  workspaceId: string;
  taskId: string;
  runId: string;
  chatEventId: string;
  baseRevision: string;
  operations?: FileOperation[];
  /** Optional dependency order index (default: 0). */
  dependencyOrder?: number;
  /** Optional initial risk level (default: 'low'). */
  risk?: RiskLevel;
  /** Optional initial tool event IDs for provenance. */
  toolEventIds?: string[];
}

/**
 * Parameters for adding operations during streaming.
 */
export interface AddOperationParams {
  changeSetId: string;
  operation: FileOperation;
}
