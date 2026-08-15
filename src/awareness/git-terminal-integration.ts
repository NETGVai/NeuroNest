/**
 * Git and Terminal Awareness Integration — Projects authoritative Git and terminal
 * state into editor and chat, provides workspace-scoped agent tools, commit
 * confirmation with file/hunk selection, destructive-op confirmation, and
 * terminal Evidence preservation.
 *
 * Implements the integration layer that:
 * 1. Projects branch, dirty, divergence, conflict, and worktree state into editor/chat (R21.1)
 * 2. Attaches only explicitly selected Git or terminal Context_Items (R21.2)
 * 3. Scopes agent terminal and Git tools to the assigned workspace (R21.3)
 * 4. Shows exact files/Hunks before commits, excluding unrelated user changes (R21.4)
 * 5. Keeps generated commit messages editable (R21.5)
 * 6. Applies risk-appropriate permissions to push, pull, rebase, merge, etc. (R21.6)
 * 7. Requires destructive confirmation naming branch and risk (R21.7)
 * 8. Preserves exit status and workspace identity in terminal Evidence (R21.8)
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */

import type { GitState, GitAwarenessService, DirtyFile } from './git-awareness-service.js';
import type { TerminalState, TerminalAwarenessService, CommandRecord } from './terminal-awareness-service.js';

// ─── Types ──────────────────────────────────────────────────────

/** Risk level for Git operations */
export type GitOperationRisk = 'low' | 'medium' | 'high' | 'destructive';

/** Git operation categories with associated risk levels (R21.6) */
export type GitOperationType =
  | 'commit'
  | 'push'
  | 'pull'
  | 'rebase'
  | 'merge'
  | 'reset'
  | 'branch-delete'
  | 'pull-request';

/** Permission level required for an operation */
export type PermissionLevel = 'auto' | 'confirm' | 'explicit-destructive';

/** A file/hunk selection for commit staging (R21.4) */
export interface CommitFileSelection {
  /** File path relative to workspace root */
  filePath: string;
  /** Whether the entire file is selected */
  fullFile: boolean;
  /** Selected hunk indices (if not full file) */
  selectedHunks?: number[];
  /** Whether this file was modified by the agent (vs. user) */
  agentModified: boolean;
}

/** A proposed commit with editable message (R21.5) */
export interface ProposedCommit {
  /** Unique commit proposal ID */
  id: string;
  /** Workspace ID this commit is scoped to */
  workspaceId: string;
  /** Generated commit message (editable by user) */
  message: string;
  /** Whether the message has been edited by the user */
  messageEdited: boolean;
  /** Files selected for this commit */
  selectedFiles: CommitFileSelection[];
  /** Files excluded from this commit (unrelated user changes) */
  excludedFiles: DirtyFile[];
  /** Branch this commit targets */
  targetBranch: string;
  /** Timestamp of proposal creation */
  createdAt: string;
  /** Current status */
  status: 'proposed' | 'confirmed' | 'committed' | 'rejected';
}

/** Destructive operation confirmation request (R21.7) */
export interface DestructiveConfirmation {
  /** Unique confirmation ID */
  id: string;
  /** Operation type being confirmed */
  operation: GitOperationType;
  /** Target branch name */
  targetBranch: string;
  /** Risk level of the operation */
  risk: GitOperationRisk;
  /** Human-readable description of what will happen */
  description: string;
  /** Specific risks or potential losses */
  riskDetails: string[];
  /** Whether the operation is reversible */
  reversible: boolean;
  /** Workspace ID this confirmation is scoped to */
  workspaceId: string;
  /** Status of the confirmation */
  status: 'pending' | 'confirmed' | 'rejected';
  /** Timestamp of request */
  requestedAt: string;
  /** Timestamp of resolution */
  resolvedAt: string | null;
}

/** Terminal Evidence record (R21.8) */
export interface TerminalEvidence {
  /** Unique evidence ID */
  id: string;
  /** Workspace ID this evidence belongs to */
  workspaceId: string;
  /** Command that was executed */
  command: string;
  /** Exit code of the command */
  exitCode: number;
  /** Working directory at execution */
  cwd: string;
  /** Bounded output */
  output: string;
  /** Whether output was truncated */
  outputTruncated: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp when started */
  startedAt: string;
  /** Timestamp when completed */
  completedAt: string;
  /** Associated task ID (if any) */
  taskId?: string;
  /** Associated run ID (if any) */
  runId?: string;
}

/** Git context item that can be attached to chat (R21.2) */
export interface GitContextItem {
  /** Context item type */
  type: 'git-diff' | 'git-commit' | 'git-branch-comparison' | 'git-log';
  /** Human-readable label */
  label: string;
  /** Workspace ID this context belongs to */
  workspaceId: string;
  /** Content of the context item */
  content: string;
  /** Whether this was explicitly selected by the user */
  explicitlySelected: boolean;
  /** Timestamp of selection */
  selectedAt: string;
}

/** Terminal context item that can be attached to chat (R21.2) */
export interface TerminalContextItem {
  /** Context item type */
  type: 'terminal-command' | 'terminal-output';
  /** Human-readable label */
  label: string;
  /** Workspace ID this context belongs to */
  workspaceId: string;
  /** The command record this refers to */
  commandId: string;
  /** Content (bounded output or command string) */
  content: string;
  /** Whether this was explicitly selected by the user */
  explicitlySelected: boolean;
  /** Timestamp of selection */
  selectedAt: string;
}

/** Projection of Git state for editor/chat headers (R21.1) */
export interface GitStateProjection {
  /** Current branch (null if detached) */
  branch: string | null;
  /** Whether there are uncommitted changes */
  isDirty: boolean;
  /** Ahead/behind remote count */
  ahead: number;
  behind: number;
  /** Whether there are unresolved conflicts */
  hasConflicts: boolean;
  /** Whether this is a worktree */
  isWorktree: boolean;
  /** Workspace ID */
  workspaceId: string;
  /** Workspace path */
  workspacePath: string;
  /** Timestamp of last refresh */
  lastRefreshed: string;
}

/** Configuration for the integration service */
export interface GitTerminalIntegrationConfig {
  /** Maximum number of context items that can be selected */
  maxContextItems: number;
  /** Maximum output size for terminal evidence (bytes) */
  maxEvidenceOutputSize: number;
  /** Whether to auto-exclude unrelated user changes from commits */
  autoExcludeUnrelatedChanges: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: GitTerminalIntegrationConfig = {
  maxContextItems: 20,
  maxEvidenceOutputSize: 50_000,
  autoExcludeUnrelatedChanges: true,
};

/** Risk classification for Git operations (R21.6) */
const OPERATION_RISK_MAP: Record<GitOperationType, GitOperationRisk> = {
  'commit': 'low',
  'pull': 'low',
  'push': 'medium',
  'merge': 'medium',
  'rebase': 'high',
  'reset': 'destructive',
  'branch-delete': 'destructive',
  'pull-request': 'medium',
};

/** Permission level required based on risk (R21.6) */
const RISK_PERMISSION_MAP: Record<GitOperationRisk, PermissionLevel> = {
  'low': 'auto',
  'medium': 'confirm',
  'high': 'confirm',
  'destructive': 'explicit-destructive',
};

// ─── GitTerminalIntegrationService ──────────────────────────────

/**
 * Integrates Git and terminal awareness into editor and chat.
 * All operations are scoped to a specific workspace — never operates globally.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */
export class GitTerminalIntegrationService {
  private workspaceId: string;
  private workspacePath: string;
  private gitService: GitAwarenessService;
  private terminalService: TerminalAwarenessService;
  private config: GitTerminalIntegrationConfig;

  private pendingCommits: Map<string, ProposedCommit> = new Map();
  private pendingConfirmations: Map<string, DestructiveConfirmation> = new Map();
  private evidenceRecords: TerminalEvidence[] = [];
  private selectedGitContextItems: GitContextItem[] = [];
  private selectedTerminalContextItems: TerminalContextItem[] = [];
  private idCounter = 0;

  constructor(
    workspaceId: string,
    workspacePath: string,
    gitService: GitAwarenessService,
    terminalService: TerminalAwarenessService,
    config?: Partial<GitTerminalIntegrationConfig>,
  ) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.gitService = gitService;
    this.terminalService = terminalService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── State Projection (R21.1) ──────────────────────────────────

  /**
   * Get the authoritative Git state projection for editor/chat headers.
   * Projects branch, dirty, divergence, conflict, and worktree state.
   */
  async getGitStateProjection(): Promise<GitStateProjection> {
    const state = await this.gitService.getState();
    return {
      branch: state.branch,
      isDirty: state.isDirty,
      ahead: state.remoteTracking?.ahead ?? 0,
      behind: state.remoteTracking?.behind ?? 0,
      hasConflicts: state.hasConflicts,
      isWorktree: state.isWorktree,
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      lastRefreshed: state.capturedAt,
    };
  }

  /**
   * Get terminal state projection for the workspace.
   */
  getTerminalStateProjection(): TerminalState {
    return this.terminalService.getState();
  }

  // ─── Context Item Selection (R21.2) ────────────────────────────

  /**
   * Attach a Git diff as a context item. Only explicitly selected items are attached.
   */
  selectGitDiffContext(label: string, diffContent: string): GitContextItem | { error: string } {
    if (this.selectedGitContextItems.length >= this.config.maxContextItems) {
      return { error: `Maximum context items (${this.config.maxContextItems}) reached` };
    }

    const item: GitContextItem = {
      type: 'git-diff',
      label,
      workspaceId: this.workspaceId,
      content: diffContent,
      explicitlySelected: true,
      selectedAt: new Date().toISOString(),
    };

    this.selectedGitContextItems.push(item);
    return item;
  }

  /**
   * Attach a Git commit as a context item.
   */
  selectGitCommitContext(label: string, commitContent: string): GitContextItem | { error: string } {
    if (this.selectedGitContextItems.length >= this.config.maxContextItems) {
      return { error: `Maximum context items (${this.config.maxContextItems}) reached` };
    }

    const item: GitContextItem = {
      type: 'git-commit',
      label,
      workspaceId: this.workspaceId,
      content: commitContent,
      explicitlySelected: true,
      selectedAt: new Date().toISOString(),
    };

    this.selectedGitContextItems.push(item);
    return item;
  }

  /**
   * Attach a branch comparison as a context item.
   */
  selectGitBranchComparisonContext(
    label: string,
    comparisonContent: string,
  ): GitContextItem | { error: string } {
    if (this.selectedGitContextItems.length >= this.config.maxContextItems) {
      return { error: `Maximum context items (${this.config.maxContextItems}) reached` };
    }

    const item: GitContextItem = {
      type: 'git-branch-comparison',
      label,
      workspaceId: this.workspaceId,
      content: comparisonContent,
      explicitlySelected: true,
      selectedAt: new Date().toISOString(),
    };

    this.selectedGitContextItems.push(item);
    return item;
  }

  /**
   * Attach a terminal command/output as a context item.
   */
  selectTerminalContext(
    commandId: string,
    type: 'terminal-command' | 'terminal-output',
  ): TerminalContextItem | { error: string } {
    if (this.selectedTerminalContextItems.length >= this.config.maxContextItems) {
      return { error: `Maximum context items (${this.config.maxContextItems}) reached` };
    }

    const command = this.terminalService.getCommand(commandId);
    if (!command) {
      return { error: `Command record not found: ${commandId}` };
    }

    const content = type === 'terminal-command' ? command.command : command.output;
    const label = type === 'terminal-command'
      ? `$ ${command.command}`
      : `Output of: ${command.command}`;

    const item: TerminalContextItem = {
      type,
      label,
      workspaceId: this.workspaceId,
      commandId,
      content,
      explicitlySelected: true,
      selectedAt: new Date().toISOString(),
    };

    this.selectedTerminalContextItems.push(item);
    return item;
  }

  /**
   * Remove a selected Git context item.
   */
  removeGitContextItem(index: number): boolean {
    if (index < 0 || index >= this.selectedGitContextItems.length) return false;
    this.selectedGitContextItems.splice(index, 1);
    return true;
  }

  /**
   * Remove a selected terminal context item.
   */
  removeTerminalContextItem(index: number): boolean {
    if (index < 0 || index >= this.selectedTerminalContextItems.length) return false;
    this.selectedTerminalContextItems.splice(index, 1);
    return true;
  }

  /**
   * Get all currently selected context items.
   */
  getSelectedContextItems(): {
    git: readonly GitContextItem[];
    terminal: readonly TerminalContextItem[];
  } {
    return {
      git: [...this.selectedGitContextItems],
      terminal: [...this.selectedTerminalContextItems],
    };
  }

  /**
   * Clear all selected context items.
   */
  clearSelectedContextItems(): void {
    this.selectedGitContextItems = [];
    this.selectedTerminalContextItems = [];
  }

  // ─── Commit Staging (R21.4, R21.5) ────────────────────────────

  /**
   * Propose a commit with exact file/hunk selection, excluding unrelated user changes.
   * Shows exactly which files and Hunks will be included.
   */
  async proposeCommit(
    agentModifiedFiles: string[],
    generatedMessage: string,
  ): Promise<ProposedCommit> {
    const gitState = await this.gitService.getState();
    const proposalId = this.generateId('commit');

    // Separate agent-modified files from user changes (R21.4)
    const selectedFiles: CommitFileSelection[] = [];
    const excludedFiles: DirtyFile[] = [];

    for (const dirtyFile of gitState.dirtyFiles) {
      const isAgentModified = agentModifiedFiles.includes(dirtyFile.path);
      if (isAgentModified) {
        selectedFiles.push({
          filePath: dirtyFile.path,
          fullFile: true,
          agentModified: true,
        });
      } else if (this.config.autoExcludeUnrelatedChanges) {
        excludedFiles.push(dirtyFile);
      }
    }

    const proposal: ProposedCommit = {
      id: proposalId,
      workspaceId: this.workspaceId,
      message: generatedMessage,
      messageEdited: false,
      selectedFiles,
      excludedFiles,
      targetBranch: gitState.branch ?? 'HEAD',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };

    this.pendingCommits.set(proposalId, proposal);
    return proposal;
  }

  /**
   * Update the commit message (R21.5 — messages remain editable).
   */
  editCommitMessage(proposalId: string, newMessage: string): ProposedCommit | { error: string } {
    const proposal = this.pendingCommits.get(proposalId);
    if (!proposal) {
      return { error: `Commit proposal not found: ${proposalId}` };
    }
    if (proposal.status !== 'proposed') {
      return { error: `Cannot edit message for commit in status: ${proposal.status}` };
    }

    proposal.message = newMessage;
    proposal.messageEdited = true;
    return proposal;
  }

  /**
   * Update file selection for a commit proposal (add or remove files).
   */
  updateCommitFileSelection(
    proposalId: string,
    filePath: string,
    selected: boolean,
    selectedHunks?: number[],
  ): ProposedCommit | { error: string } {
    const proposal = this.pendingCommits.get(proposalId);
    if (!proposal) {
      return { error: `Commit proposal not found: ${proposalId}` };
    }
    if (proposal.status !== 'proposed') {
      return { error: `Cannot update file selection for commit in status: ${proposal.status}` };
    }

    if (selected) {
      // Add to selected if not already
      const existing = proposal.selectedFiles.find(f => f.filePath === filePath);
      if (!existing) {
        proposal.selectedFiles.push({
          filePath,
          fullFile: !selectedHunks || selectedHunks.length === 0,
          selectedHunks,
          agentModified: false,
        });
      } else {
        existing.selectedHunks = selectedHunks;
        existing.fullFile = !selectedHunks || selectedHunks.length === 0;
      }
      // Remove from excluded
      proposal.excludedFiles = proposal.excludedFiles.filter(f => f.path !== filePath);
    } else {
      // Remove from selected
      const removed = proposal.selectedFiles.find(f => f.filePath === filePath);
      proposal.selectedFiles = proposal.selectedFiles.filter(f => f.filePath !== filePath);
      if (removed) {
        proposal.excludedFiles.push({ path: filePath, status: 'modified', staged: false });
      }
    }

    return proposal;
  }

  /**
   * Confirm a commit proposal (transitions status to confirmed).
   */
  confirmCommit(proposalId: string): ProposedCommit | { error: string } {
    const proposal = this.pendingCommits.get(proposalId);
    if (!proposal) {
      return { error: `Commit proposal not found: ${proposalId}` };
    }
    if (proposal.status !== 'proposed') {
      return { error: `Cannot confirm commit in status: ${proposal.status}` };
    }
    if (proposal.selectedFiles.length === 0) {
      return { error: 'Cannot confirm commit with no selected files' };
    }

    proposal.status = 'confirmed';
    return proposal;
  }

  /**
   * Reject a commit proposal.
   */
  rejectCommit(proposalId: string): ProposedCommit | { error: string } {
    const proposal = this.pendingCommits.get(proposalId);
    if (!proposal) {
      return { error: `Commit proposal not found: ${proposalId}` };
    }
    if (proposal.status !== 'proposed') {
      return { error: `Cannot reject commit in status: ${proposal.status}` };
    }

    proposal.status = 'rejected';
    return proposal;
  }

  /**
   * Get a pending commit proposal by ID.
   */
  getCommitProposal(proposalId: string): ProposedCommit | undefined {
    return this.pendingCommits.get(proposalId);
  }

  /**
   * Get all pending commit proposals.
   */
  getPendingCommits(): ProposedCommit[] {
    return Array.from(this.pendingCommits.values()).filter(c => c.status === 'proposed');
  }

  // ─── Operation Permissions (R21.6) ────────────────────────────

  /**
   * Get the risk level for a Git operation.
   */
  getOperationRisk(operation: GitOperationType): GitOperationRisk {
    return OPERATION_RISK_MAP[operation];
  }

  /**
   * Get the required permission level for a Git operation.
   */
  getRequiredPermission(operation: GitOperationType): PermissionLevel {
    const risk = this.getOperationRisk(operation);
    return RISK_PERMISSION_MAP[risk];
  }

  /**
   * Check if an operation requires confirmation.
   */
  requiresConfirmation(operation: GitOperationType): boolean {
    const permission = this.getRequiredPermission(operation);
    return permission === 'confirm' || permission === 'explicit-destructive';
  }

  /**
   * Check if an operation requires destructive confirmation (naming branch and risk).
   */
  requiresDestructiveConfirmation(operation: GitOperationType): boolean {
    return this.getRequiredPermission(operation) === 'explicit-destructive';
  }

  // ─── Destructive Confirmation (R21.7) ─────────────────────────

  /**
   * Request destructive confirmation naming branch and risk.
   * Never force-push, hard-reset, or auto-merge without this confirmation.
   */
  requestDestructiveConfirmation(
    operation: GitOperationType,
    targetBranch: string,
    description: string,
    riskDetails: string[],
  ): DestructiveConfirmation {
    const confirmId = this.generateId('confirm');
    const risk = this.getOperationRisk(operation);

    const confirmation: DestructiveConfirmation = {
      id: confirmId,
      operation,
      targetBranch,
      risk,
      description,
      riskDetails,
      reversible: operation !== 'reset' && operation !== 'branch-delete',
      workspaceId: this.workspaceId,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
    };

    this.pendingConfirmations.set(confirmId, confirmation);
    return confirmation;
  }

  /**
   * Resolve a destructive confirmation (confirm or reject).
   */
  resolveDestructiveConfirmation(
    confirmId: string,
    confirmed: boolean,
  ): DestructiveConfirmation | { error: string } {
    const confirmation = this.pendingConfirmations.get(confirmId);
    if (!confirmation) {
      return { error: `Confirmation not found: ${confirmId}` };
    }
    if (confirmation.status !== 'pending') {
      return { error: `Confirmation already resolved: ${confirmation.status}` };
    }

    confirmation.status = confirmed ? 'confirmed' : 'rejected';
    confirmation.resolvedAt = new Date().toISOString();
    return confirmation;
  }

  /**
   * Get a pending destructive confirmation.
   */
  getDestructiveConfirmation(confirmId: string): DestructiveConfirmation | undefined {
    return this.pendingConfirmations.get(confirmId);
  }

  /**
   * Get all pending destructive confirmations.
   */
  getPendingConfirmations(): DestructiveConfirmation[] {
    return Array.from(this.pendingConfirmations.values()).filter(c => c.status === 'pending');
  }

  // ─── Terminal Evidence (R21.8) ─────────────────────────────────

  /**
   * Record terminal command output as Evidence preserving exit status and workspace identity.
   */
  recordTerminalEvidence(
    commandRecord: CommandRecord,
    taskId?: string,
    runId?: string,
  ): TerminalEvidence {
    const evidenceId = this.generateId('evidence');

    // Bound output size
    let output = commandRecord.output;
    let outputTruncated = commandRecord.outputTruncated;
    if (output.length > this.config.maxEvidenceOutputSize) {
      output = output.slice(-this.config.maxEvidenceOutputSize);
      outputTruncated = true;
    }

    const evidence: TerminalEvidence = {
      id: evidenceId,
      workspaceId: this.workspaceId,
      command: commandRecord.command,
      exitCode: commandRecord.exitCode,
      cwd: commandRecord.cwd,
      output,
      outputTruncated,
      durationMs: commandRecord.durationMs,
      startedAt: commandRecord.startedAt,
      completedAt: commandRecord.completedAt,
      taskId,
      runId,
    };

    this.evidenceRecords.push(evidence);
    return evidence;
  }

  /**
   * Get terminal evidence records for this workspace.
   */
  getTerminalEvidence(limit?: number): TerminalEvidence[] {
    if (limit === undefined || limit >= this.evidenceRecords.length) {
      return [...this.evidenceRecords];
    }
    return this.evidenceRecords.slice(-limit);
  }

  /**
   * Get terminal evidence for a specific task.
   */
  getEvidenceForTask(taskId: string): TerminalEvidence[] {
    return this.evidenceRecords.filter(e => e.taskId === taskId);
  }

  /**
   * Get terminal evidence for a specific run.
   */
  getEvidenceForRun(runId: string): TerminalEvidence[] {
    return this.evidenceRecords.filter(e => e.runId === runId);
  }

  // ─── Workspace Scoping (R21.3) ────────────────────────────────

  /**
   * Validate that a path is within this integration's workspace.
   * Agents can only access terminal and Git within their assigned workspace.
   */
  isWithinWorkspace(targetPath: string): boolean {
    // Normalize and check containment
    const normalizedTarget = normalizePath(targetPath);
    const normalizedWorkspace = normalizePath(this.workspacePath);
    return normalizedTarget.startsWith(normalizedWorkspace);
  }

  /**
   * Get the workspace ID this integration is scoped to.
   */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /**
   * Get the workspace path this integration is scoped to.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Clear all pending state (for testing or shutdown).
   */
  clear(): void {
    this.pendingCommits.clear();
    this.pendingConfirmations.clear();
    this.evidenceRecords = [];
    this.selectedGitContextItems = [];
    this.selectedTerminalContextItems = [];
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private generateId(prefix: string): string {
    this.idCounter++;
    return `${prefix}-${this.workspaceId}-${Date.now()}-${this.idCounter}`;
  }
}

// ─── Utility ────────────────────────────────────────────────────

/**
 * Normalize a file path for comparison (resolve trailing slashes, etc.)
 */
function normalizePath(p: string): string {
  // Remove trailing slash and normalize
  let normalized = p.replace(/\\/g, '/');
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
