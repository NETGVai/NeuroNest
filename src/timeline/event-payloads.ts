/**
 * Event payload types for the unified chat timeline.
 *
 * Each TimelineEvent has a discriminated `type` field and a corresponding
 * payload. Payloads are stored separately (by payloadRef) but typed here
 * for deserialization and rendering.
 *
 * Requirements: 15.1 — persist messages, assistant prose, reasoning summaries,
 * Tool_Events, approvals, artifacts, Change_Sets, Evidence, errors, and run states.
 */

// ─── Message payloads ──────────────────────────────────────────

/** Role of the message author */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Terminal states for a streaming message */
export type MessageTerminalState =
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed'
  | 'disconnected';

/**
 * Payload for a 'message' event. Represents user or assistant prose,
 * optionally with reasoning summaries.
 */
export interface MessagePayload {
  readonly role: MessageRole;
  /** The final rendered text content (Markdown) */
  readonly content: string;
  /** Permitted reasoning summary when policy allows disclosure */
  readonly reasoningSummary?: string;
  /** Terminal state once streaming completes */
  readonly terminalState: MessageTerminalState;
  /** Whether this message was selectable during streaming */
  readonly selectableDuringStream: boolean;
  /** Sequence of code blocks for deferred highlighting */
  readonly codeBlocks?: readonly CodeBlockRef[];
}

/** Reference to a fenced code block for deferred highlighting */
export interface CodeBlockRef {
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Whether highlighting has been applied */
  readonly highlighted: boolean;
}

// ─── Tool event payloads ───────────────────────────────────────

/** Lifecycle states for a tool event */
export type ToolEventState =
  | 'requested'
  | 'policy_checking'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out';

/**
 * Payload for a 'tool_event' timeline event.
 */
export interface ToolEventPayload {
  readonly toolName: string;
  readonly purpose: string;
  readonly targetScope: string;
  readonly state: ToolEventState;
  readonly sanitizedArgs?: Record<string, unknown>;
  readonly outputSummary?: string;
  readonly startedAt?: string;
  readonly elapsedMs?: number;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly correlationId: string;
}

// ─── Approval payloads ─────────────────────────────────────────

/** Approval status */
export type ApprovalStatus =
  | 'pending'
  | 'approved_once'
  | 'approved_for_run'
  | 'approved_for_scope'
  | 'rejected'
  | 'edited';

/**
 * Payload for an 'approval' timeline event.
 */
export interface ApprovalPayload {
  readonly toolName: string;
  readonly purpose: string;
  readonly status: ApprovalStatus;
  readonly scope?: string;
  readonly editedArgs?: Record<string, unknown>;
  readonly respondedAt?: string;
  readonly respondedBy?: string;
}

// ─── Artifact payloads ─────────────────────────────────────────

/**
 * Payload for an 'artifact' timeline event.
 */
export interface ArtifactPayload {
  readonly artifactId: string;
  readonly artifactType: string;
  readonly title: string;
  readonly version: number;
  readonly originMessageId?: string;
  readonly originTaskId?: string;
  readonly contentRef: string;
}

// ─── Change set payloads ───────────────────────────────────────

/**
 * Payload for a 'change_set' timeline event.
 */
export interface ChangeSetPayload {
  readonly changeSetId: string;
  readonly state: string;
  readonly fileCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly taskId?: string;
  readonly runId?: string;
}

// ─── Evidence payloads ─────────────────────────────────────────

/**
 * Payload for an 'evidence' timeline event.
 */
export interface EvidencePayload {
  readonly evidenceId: string;
  readonly kind: string;
  readonly outcome: 'pass' | 'fail' | 'blocked' | 'cancelled' | 'stale' | 'waived';
  readonly summary: string;
  readonly taskId?: string;
  readonly changeSetId?: string;
}

// ─── Run transition payloads ───────────────────────────────────

/**
 * Payload for a 'run_transition' timeline event.
 */
export interface RunTransitionPayload {
  readonly runId: string;
  readonly previousState: string;
  readonly newState: string;
  readonly reason?: string;
  readonly agentId?: string;
  readonly taskId?: string;
}

// ─── Error payloads ────────────────────────────────────────────

/** Error severity */
export type ErrorSeverity = 'warning' | 'error' | 'critical';

/**
 * Payload for an 'error' timeline event.
 */
export interface ErrorPayload {
  readonly severity: ErrorSeverity;
  readonly message: string;
  readonly category: string;
  readonly recoverable: boolean;
  readonly nextAction?: string;
  readonly technicalDetail?: string;
  readonly correlationId?: string;
}

// ─── Union type for all payloads ───────────────────────────────

export type TimelineEventPayload =
  | { type: 'message'; data: MessagePayload }
  | { type: 'tool_event'; data: ToolEventPayload }
  | { type: 'approval'; data: ApprovalPayload }
  | { type: 'artifact'; data: ArtifactPayload }
  | { type: 'change_set'; data: ChangeSetPayload }
  | { type: 'evidence'; data: EvidencePayload }
  | { type: 'run_transition'; data: RunTransitionPayload }
  | { type: 'error'; data: ErrorPayload };
