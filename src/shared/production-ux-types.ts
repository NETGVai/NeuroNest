// Production UX Audit — Shared TypeScript interfaces for IPC event protocol
// Matches the design document interfaces exactly

import type { LoopProgress } from '../pipeline/agent-loop';

// ─── Enhanced Loop Progress ─────────────────────────────────────

/** Extended progress event with human-readable phase labels and parallel info */
export interface EnhancedLoopProgress extends LoopProgress {
  /** Human-readable phase label for display */
  phaseLabel: string;
  /** Tool target (file path or command) when status is 'tool_executing' */
  toolTarget?: string;
  /** Number of parallel operations in progress */
  parallelCount?: number;
}

// ─── Tool Lifecycle Events ──────────────────────────────────────

/** Emitted on tool start, completion, or error during agent loop execution */
export interface ToolLifecycleEvent {
  type: 'tool_start' | 'tool_complete' | 'tool_error';
  toolName: string;
  toolCallId: string;
  filePath?: string;
  command?: string;
  iteration: number;
  timestamp: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  /** For parallel execution: group ID linking concurrent calls */
  parallelGroupId?: string;
}

// ─── File Change Events ─────────────────────────────────────────

/** Emitted when the agent creates, modifies, or deletes a file */
export interface FileChangeEvent {
  type: 'created' | 'modified' | 'deleted';
  filePath: string;
  timestamp: number;
  toolCallId: string;
  /** Snapshot of content before modification (for diffs) */
  beforeContent?: string;
}

// ─── Stream Token Events ────────────────────────────────────────

/** Emitted for each token during LLM response streaming */
export interface StreamTokenEvent {
  messageId: string;
  token: string;
  done: boolean;
}

// ─── Task Complete Events ───────────────────────────────────────

/** Emitted when the agent loop finishes a task */
export interface TaskCompleteEvent {
  sessionId: string;
  changeSummary: ChangeSummary;
  iterations: number;
  toolCallsExecuted: number;
  durationMs: number;
}

// ─── Agent Error Events ─────────────────────────────────────────

/** Structured error event with classification and optional recovery info */
export interface AgentErrorEvent {
  type: 'network' | 'rate_limit' | 'tool_failure' | 'timeout' | 'unknown';
  message: string;
  toolName?: string;
  filePath?: string;
  retryAfterMs?: number;
  suggestion?: string;
}

// ─── Parallel Status Events ─────────────────────────────────────

/** Reports the status of concurrently executing tool operations */
export interface ParallelStatusEvent {
  groupId: string;
  operations: Array<{
    toolCallId: string;
    toolName: string;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    filePath?: string;
  }>;
}

// ─── Approval Gate ──────────────────────────────────────────────

/** Request sent to the renderer for user approval of changes */
export interface ApprovalRequest {
  sessionId: string;
  changeSummary: ChangeSummary;
  hunks: DiffHunk[];
  mode: 'full' | 'per-hunk';
}

/** User decision on an approval request */
export type ApprovalDecision =
  | { action: 'approve_all' }
  | { action: 'reject_all' }
  | { action: 'selective'; approved: string[]; rejected: string[] };

// ─── Diff Hunks ─────────────────────────────────────────────────

/** A single diff hunk representing a contiguous change in a file */
export interface DiffHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

// ─── Change Summary ─────────────────────────────────────────────

/** Complete summary of all file changes made during a task execution */
export interface ChangeSummary {
  sessionId: string;
  created: FileChangeRecord[];
  modified: FileChangeRecord[];
  deleted: FileChangeRecord[];
  totalToolCalls: number;
  totalIterations: number;
  durationMs: number;
}

/** Record of a single file change within a task */
export interface FileChangeRecord {
  filePath: string;
  timestamp: number;
  toolCallId: string;
  /** Size delta in bytes (positive = grew, negative = shrunk) */
  sizeDelta?: number;
}
