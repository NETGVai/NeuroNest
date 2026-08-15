/**
 * ToolApprovalService — Identifies tools requiring approval and manages the
 * confirmation flow for destructive and network tools.
 *
 * Emits confirmation requests, blocks execution until user approves/denies,
 * and surfaces model feedback for failed tools.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8
 */

import type { RiskLevel } from '../shared/types.js';
import type { ToolLifecycleService, ToolInvocation } from './tool-lifecycle-service.js';

// ─── Types ──────────────────────────────────────────────────────

/** Category of tool that requires approval */
export type ApprovalCategory = 'destructive' | 'network' | 'credential' | 'external-service';

/** Scope-level for an approval grant */
export type ApprovalScope = 'once' | 'run' | 'scope';

/** A pending confirmation request */
export interface ConfirmationRequest {
  id: string;
  invocationId: string;
  toolName: string;
  category: ApprovalCategory;
  explanation: string;
  scope: string;
  arguments: Record<string, unknown>;
  agentId: string;
  taskId?: string;
  runId?: string;
  createdAt: string;
}

/** User response to a confirmation request */
export interface ApprovalResponse {
  requestId: string;
  approved: boolean;
  scope?: ApprovalScope;
  editedArguments?: Record<string, unknown>;
  reason?: string;
}

/** An active approval grant */
export interface ApprovalGrant {
  toolName: string;
  scope: ApprovalScope;
  runId?: string;
  grantedAt: string;
  expiresAt?: string;
}

/** Model feedback for a failed tool */
export interface ModelFeedback {
  invocationId: string;
  toolName: string;
  errorSummary: string;
  suggestedFix: string;
  retryable: boolean;
  alternativeActions: string[];
}

/** Listener for confirmation requests */
export type ConfirmationRequestListener = (request: ConfirmationRequest) => void;

/** Listener for model feedback on failures */
export type ModelFeedbackListener = (feedback: ModelFeedback) => void;

/** Policy configuration for approval */
export interface ApprovalPolicy {
  /** Tools that always require approval regardless of risk level */
  alwaysRequireApproval: string[];
  /** Risk levels that require approval */
  requireApprovalForRiskLevels: RiskLevel[];
  /** Categories of operations requiring approval */
  requireApprovalForCategories: ApprovalCategory[];
  /** Tools that never require approval (read-only, pre-approved) */
  neverRequireApproval: string[];
}

// ─── Default policy ─────────────────────────────────────────────

const DEFAULT_POLICY: ApprovalPolicy = {
  alwaysRequireApproval: [],
  requireApprovalForRiskLevels: ['destructive', 'execute'],
  requireApprovalForCategories: ['destructive', 'network', 'credential', 'external-service'],
  neverRequireApproval: [],
};

// ─── Category classification ────────────────────────────────────

/** Known destructive tool patterns — use segment-boundary matching to avoid false positives */
const DESTRUCTIVE_PATTERNS = [
  'delete', 'remove', 'drop', 'truncate', 'destroy', 'reset',
  'force-push', 'hard-reset', 'unlink',
];

/** Check if a tool name matches a destructive pattern at a segment boundary */
function matchesDestructivePattern(toolNameLower: string): boolean {
  // Split on common separators (-, _, .) and check each segment
  const segments = toolNameLower.split(/[-_./]/);
  return segments.some((seg) => DESTRUCTIVE_PATTERNS.includes(seg)) ||
    DESTRUCTIVE_PATTERNS.some((p) => p.includes('-') && toolNameLower.includes(p));
}

/** Known network tool patterns — use segment-boundary matching */
const NETWORK_PATTERNS = [
  'fetch', 'http', 'request', 'download', 'upload', 'api',
  'curl', 'webhook', 'push', 'deploy', 'publish',
];

/** Check if a tool name matches a network pattern at a segment boundary */
function matchesNetworkPattern(toolNameLower: string): boolean {
  const segments = toolNameLower.split(/[-_./]/);
  return segments.some((seg) => NETWORK_PATTERNS.includes(seg)) ||
    NETWORK_PATTERNS.some((p) => p.includes('-') && toolNameLower.includes(p));
}

// ─── Service ────────────────────────────────────────────────────

export class ToolApprovalService {
  private policy: ApprovalPolicy;
  private lifecycleService: ToolLifecycleService;
  private pendingRequests = new Map<string, ConfirmationRequest>();
  private grants: ApprovalGrant[] = [];
  private confirmationListeners: ConfirmationRequestListener[] = [];
  private feedbackListeners: ModelFeedbackListener[] = [];
  private pendingResolvers = new Map<string, (response: ApprovalResponse) => void>();

  constructor(lifecycleService: ToolLifecycleService, policy?: Partial<ApprovalPolicy>) {
    this.lifecycleService = lifecycleService;
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * Determine if a tool invocation requires approval.
   */
  requiresApproval(toolName: string, riskLevel: RiskLevel, category?: ApprovalCategory): boolean {
    // Check never-require list first
    if (this.policy.neverRequireApproval.includes(toolName)) {
      return false;
    }

    // Check always-require list
    if (this.policy.alwaysRequireApproval.includes(toolName)) {
      return true;
    }

    // Check risk level
    if (this.policy.requireApprovalForRiskLevels.includes(riskLevel)) {
      return true;
    }

    // Check category
    if (category && this.policy.requireApprovalForCategories.includes(category)) {
      return true;
    }

    return false;
  }

  /**
   * Classify a tool into an approval category based on its name and risk level.
   * Classification checks external-service first (most specific), then credential,
   * then destructive, then network. Returns null if no category applies.
   */
  classifyTool(toolName: string, riskLevel: RiskLevel): ApprovalCategory | null {
    const lower = toolName.toLowerCase();

    // Check external-service patterns first (most specific)
    if (lower.includes('external') || lower.includes('mcp') || lower.includes('plugin')) {
      return 'external-service';
    }

    // Check credential patterns
    if (lower.includes('credential') || lower.includes('secret') || lower.includes('key')) {
      return 'credential';
    }

    // Check destructive by risk level or name pattern
    if (riskLevel === 'destructive' || matchesDestructivePattern(lower)) {
      return 'destructive';
    }

    // Check network patterns
    if (matchesNetworkPattern(lower)) {
      return 'network';
    }

    return null;
  }

  /**
   * Check if an existing grant covers this invocation.
   */
  hasActiveGrant(toolName: string, runId?: string): boolean {
    const now = new Date().toISOString();
    return this.grants.some((grant) => {
      if (grant.toolName !== toolName) return false;
      if (grant.expiresAt && grant.expiresAt < now) return false;
      if (grant.scope === 'run' && grant.runId !== runId) return false;
      return true;
    });
  }

  /**
   * Request approval for a tool invocation.
   * Emits a confirmation request and blocks until the user responds.
   */
  async requestApproval(invocation: ToolInvocation, sessionId: string): Promise<ApprovalResponse> {
    const category = this.classifyTool(invocation.toolName, 'execute') ?? 'destructive';

    const request: ConfirmationRequest = {
      id: `approval-${invocation.id}`,
      invocationId: invocation.id,
      toolName: invocation.toolName,
      category,
      explanation: this.buildExplanation(invocation, category),
      scope: invocation.scope,
      arguments: invocation.arguments,
      agentId: invocation.agentId,
      taskId: invocation.taskId,
      runId: invocation.runId,
      createdAt: new Date().toISOString(),
    };

    this.pendingRequests.set(request.id, request);

    // Emit to listeners
    for (const listener of this.confirmationListeners) {
      listener(request);
    }

    // Block until resolved
    return new Promise<ApprovalResponse>((resolve) => {
      this.pendingResolvers.set(request.id, resolve);
    });
  }

  /**
   * Resolve a pending confirmation request with the user's decision.
   */
  resolveApproval(response: ApprovalResponse): void {
    const request = this.pendingRequests.get(response.requestId);
    if (!request) {
      throw new Error(`No pending request found: ${response.requestId}`);
    }

    // If approved, record the grant
    if (response.approved && response.scope) {
      this.grants.push({
        toolName: request.toolName,
        scope: response.scope,
        runId: request.runId,
        grantedAt: new Date().toISOString(),
      });
    }

    // Remove from pending
    this.pendingRequests.delete(response.requestId);

    // Resolve the promise
    const resolver = this.pendingResolvers.get(response.requestId);
    if (resolver) {
      resolver(response);
      this.pendingResolvers.delete(response.requestId);
    }
  }

  /**
   * Surface model feedback for a failed tool invocation.
   */
  surfaceModelFeedback(params: {
    invocationId: string;
    toolName: string;
    error: string;
    suggestedFix: string;
    retryable: boolean;
    alternativeActions?: string[];
  }): ModelFeedback {
    const feedback: ModelFeedback = {
      invocationId: params.invocationId,
      toolName: params.toolName,
      errorSummary: params.error,
      suggestedFix: params.suggestedFix,
      retryable: params.retryable,
      alternativeActions: params.alternativeActions ?? [],
    };

    // Also record on the invocation
    const invocation = this.lifecycleService.getInvocation(params.invocationId);
    if (invocation) {
      invocation.modelFeedback = params.suggestedFix;
    }

    // Emit to listeners
    for (const listener of this.feedbackListeners) {
      listener(feedback);
    }

    return feedback;
  }

  /**
   * Subscribe to confirmation request events.
   */
  onConfirmationRequest(listener: ConfirmationRequestListener): () => void {
    this.confirmationListeners.push(listener);
    return () => {
      const idx = this.confirmationListeners.indexOf(listener);
      if (idx >= 0) this.confirmationListeners.splice(idx, 1);
    };
  }

  /**
   * Subscribe to model feedback events.
   */
  onModelFeedback(listener: ModelFeedbackListener): () => void {
    this.feedbackListeners.push(listener);
    return () => {
      const idx = this.feedbackListeners.indexOf(listener);
      if (idx >= 0) this.feedbackListeners.splice(idx, 1);
    };
  }

  /**
   * Get all pending confirmation requests.
   */
  getPendingRequests(): ConfirmationRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Get all active grants.
   */
  getActiveGrants(): ApprovalGrant[] {
    const now = new Date().toISOString();
    return this.grants.filter((g) => !g.expiresAt || g.expiresAt >= now);
  }

  /**
   * Revoke all grants for a run (e.g., when a run completes or is cancelled).
   */
  revokeGrantsForRun(runId: string): void {
    this.grants = this.grants.filter((g) => g.runId !== runId);
  }

  private buildExplanation(invocation: ToolInvocation, category: ApprovalCategory): string {
    const action = category === 'destructive'
      ? 'perform a destructive operation'
      : category === 'network'
        ? 'make a network request'
        : category === 'credential'
          ? 'access credentials'
          : 'invoke an external service';

    return `Tool "${invocation.toolName}" will ${action} in scope "${invocation.scope}". Purpose: ${invocation.purpose}`;
  }
}
