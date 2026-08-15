/**
 * ToolPolicyGateway — Central enforcement point for all tool invocations.
 *
 * Integrates ToolManifestService, PolicyResolver, ToolLifecycleService, and
 * ToolApprovalService into one gateway that:
 *
 * 1. Persists Tool_Event states from requested through terminal states (R18.1)
 * 2. Applies policy before mutations (R18.3) with once/run/scope approval (R18.4)
 * 3. Separates read vs mutation policy, enforces canonical containment (R18.5)
 * 4. Bounds searchable output, preserves full logs as artifacts (R18.6)
 * 5. Exposes typed retry guidance on failure (R18.7)
 * 6. Keeps parallel tools independently approvable and cancellable (R18.9)
 * 7. Prevents tool results from becoming user-authored content (R18.8)
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  ToolLifecycleService,
  type ToolInvocation,
  type ToolLifecycleState,
  TERMINAL_STATES,
} from './tool-lifecycle-service.js';
import {
  ToolApprovalService,
  type ApprovalScope,
  type ApprovalResponse,
} from './tool-approval-service.js';
import {
  type ToolManifest,
  type PolicyStack,
  type ResolvedPolicy,
  type ToolRiskLevel,
} from '../tool-manifest/types.js';
import { ToolManifestService } from '../tool-manifest/tool-manifest-service.js';
import { PolicyResolver } from '../tool-manifest/policy-resolver.js';

// ─── Types ──────────────────────────────────────────────────────

/** Tool operation category for policy classification */
export type ToolOperationKind = 'read' | 'mutation';

/** The categories of mutating tools that require policy enforcement (R18.3) */
export type MutatingToolCategory =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'network'
  | 'credential'
  | 'external-service'
  | 'mcp';

/** Result of a gateway invocation */
export interface GatewayInvocationResult {
  /** Whether the invocation was successful */
  success: boolean;
  /** The invocation record (always present for tracking) */
  invocation: ToolInvocation;
  /** Output from the tool, bounded to configured limits */
  output?: unknown;
  /** Full output artifact reference when output was truncated */
  fullOutputArtifactRef?: string;
  /** Error message if failed */
  error?: string;
  /** Typed retry guidance when the tool failed */
  retryGuidance?: RetryGuidance;
  /** Whether the invocation was denied by policy */
  denied?: boolean;
  /** Denial reason */
  denialReason?: string;
}

/** Typed retry guidance exposed on failure (R18.7) */
export interface RetryGuidance {
  /** Whether the error is classified as retryable */
  retryable: boolean;
  /** Error category for classification */
  errorCategory: 'transient' | 'permission' | 'validation' | 'resource' | 'timeout' | 'unknown';
  /** Suggested corrective action */
  suggestedAction: string;
  /** Maximum retry attempts remaining */
  retriesRemaining?: number;
  /** Minimum backoff in milliseconds before retry */
  backoffMs?: number;
}

/** Canonical containment check result */
export interface ContainmentCheckResult {
  allowed: boolean;
  reason?: string;
  canonicalPath?: string;
}

/** Configuration for the gateway */
export interface ToolPolicyGatewayConfig {
  /** Maximum output preview size in bytes (default: 4096) */
  maxOutputPreviewBytes?: number;
  /** Maximum full output size in bytes (default: 1_048_576 = 1MB) */
  maxFullOutputBytes?: number;
  /** Allowed workspace roots for canonical path containment */
  workspaceRoots?: string[];
  /** Maximum retry attempts per tool per run */
  maxRetriesPerTool?: number;
  /** Default timeout in milliseconds (used when manifest doesn't specify) */
  defaultTimeoutMs?: number;
}

/** Request to invoke a tool through the gateway */
export interface GatewayToolRequest {
  /** Tool name (stable identifier) */
  toolName: string;
  /** Human-readable purpose of this invocation */
  purpose: string;
  /** Target scope (path, URL, or resource identifier) */
  scope: string;
  /** Tool arguments (will be sanitized for display) */
  arguments: Record<string, unknown>;
  /** Agent requesting the tool */
  agentId: string;
  /** Session context */
  sessionId: string;
  /** Associated task */
  taskId?: string;
  /** Associated run */
  runId?: string;
  /** Policy stack for this invocation */
  policyStack: PolicyStack;
  /** Actual execution function */
  execute: (sanitizedArgs: Record<string, unknown>) => Promise<{
    success: boolean;
    output: unknown;
    error?: string;
  }>;
}

/** Listener for artifact creation from bounded output */
export type ArtifactCreationListener = (params: {
  invocationId: string;
  fullOutput: string;
  contentHash: string;
}) => string; // returns artifactRef

// ─── Utility: sanitize arguments for display (R18.2) ────────────

function sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['password', 'secret', 'token', 'key', 'credential', 'apikey', 'api_key'];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 256) {
      sanitized[key] = value.slice(0, 256) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ─── Utility: classify tool as read or mutation ─────────────────

function classifyOperationKind(manifest: ToolManifest): ToolOperationKind {
  if (manifest.riskLevel === 'read-only') {
    return 'read';
  }
  return 'mutation';
}

/** Classify the mutating category based on tool name and manifest */
function classifyMutatingCategory(toolName: string, manifest: ToolManifest): MutatingToolCategory | null {
  if (manifest.riskLevel === 'read-only') {
    return null;
  }

  const lower = toolName.toLowerCase();

  // MCP tools
  if (manifest.source === 'mcp') return 'mcp';

  // Git patterns
  if (lower.includes('git') || lower.includes('commit') || lower.includes('push')
      || lower.includes('merge') || lower.includes('rebase') || lower.includes('branch')) {
    return 'git';
  }

  // Network patterns
  if (manifest.networkPolicy !== 'none' || lower.includes('fetch') || lower.includes('http')
      || lower.includes('download') || lower.includes('upload') || lower.includes('deploy')) {
    return 'network';
  }

  // Credential patterns
  if (manifest.secretAccess.length > 0 || lower.includes('credential')
      || lower.includes('secret') || lower.includes('key')) {
    return 'credential';
  }

  // External service (plugins)
  if (manifest.source === 'plugin' || lower.includes('external')) {
    return 'external-service';
  }

  // Shell patterns
  if (lower.includes('shell') || lower.includes('bash') || lower.includes('exec')
      || lower.includes('spawn') || lower.includes('terminal') || lower.includes('command')) {
    return 'shell';
  }

  // Default to filesystem for remaining write/execute/destructive tools
  return 'filesystem';
}

// ─── Canonical path containment (R18.5) ─────────────────────────

function checkCanonicalContainment(
  targetPath: string,
  allowedRoots: string[],
): ContainmentCheckResult {
  if (!targetPath || allowedRoots.length === 0) {
    return { allowed: true, canonicalPath: targetPath };
  }

  // Resolve the target to an absolute canonical path
  const canonical = path.resolve(targetPath);

  // Check for path traversal attempts
  if (targetPath.includes('..') || targetPath.includes('\0')) {
    return {
      allowed: false,
      reason: `Path contains traversal or null bytes: ${targetPath}`,
    };
  }

  // Check containment against allowed roots
  for (const root of allowedRoots) {
    const canonicalRoot = path.resolve(root);
    if (canonical === canonicalRoot || canonical.startsWith(canonicalRoot + path.sep)) {
      return { allowed: true, canonicalPath: canonical };
    }
  }

  return {
    allowed: false,
    reason: `Path '${canonical}' is outside allowed workspace roots`,
    canonicalPath: canonical,
  };
}

// ─── ToolPolicyGateway ──────────────────────────────────────────

export class ToolPolicyGateway {
  private readonly lifecycleService: ToolLifecycleService;
  private readonly approvalService: ToolApprovalService;
  private readonly manifestService: ToolManifestService;
  private readonly policyResolver: PolicyResolver;
  private readonly config: Required<ToolPolicyGatewayConfig>;

  /** Track retry counts per tool per run */
  private retryCounts = new Map<string, number>();

  /** Artifact creation listener for full output preservation */
  private artifactListener: ArtifactCreationListener | null = null;

  constructor(
    lifecycleService: ToolLifecycleService,
    approvalService: ToolApprovalService,
    manifestService: ToolManifestService,
    policyResolver: PolicyResolver,
    config?: ToolPolicyGatewayConfig,
  ) {
    this.lifecycleService = lifecycleService;
    this.approvalService = approvalService;
    this.manifestService = manifestService;
    this.policyResolver = policyResolver;
    this.config = {
      maxOutputPreviewBytes: config?.maxOutputPreviewBytes ?? 4096,
      maxFullOutputBytes: config?.maxFullOutputBytes ?? 1_048_576,
      workspaceRoots: config?.workspaceRoots ?? [],
      maxRetriesPerTool: config?.maxRetriesPerTool ?? 3,
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 30_000,
    };
  }

  /**
   * Register a listener for artifact creation when output is truncated.
   */
  onArtifactCreation(listener: ArtifactCreationListener): void {
    this.artifactListener = listener;
  }

  /**
   * Invoke a tool through the gateway with full policy enforcement.
   *
   * This is the single entry point for governed tool execution (R18.1–R18.9).
   * Each invocation flows through:
   *   1. Create invocation record (requested state)
   *   2. Policy check (manifest validation, resolved policy, containment)
   *   3. Approval if required (based on read/mutation classification)
   *   4. Execution with timeout enforcement
   *   5. Output bounding and artifact preservation
   *   6. Typed retry guidance on failure
   */
  async invoke(request: GatewayToolRequest): Promise<GatewayInvocationResult> {
    // Step 1: Create invocation in 'requested' state (R18.1)
    const invocation = this.lifecycleService.createInvocation({
      toolName: request.toolName,
      purpose: request.purpose,
      scope: request.scope,
      arguments: sanitizeArguments(request.arguments),
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
    });

    // Step 2: Policy checking (R18.3, R18.5)
    this.lifecycleService.transition(invocation.id, 'policy_checking', request.sessionId);

    // 2a. Look up the tool manifest
    const manifest = this.manifestService.getLatest(request.toolName);
    if (!manifest) {
      return this.denyInvocation(invocation, request.sessionId,
        `No valid manifest found for tool '${request.toolName}'`);
    }

    // 2b. Resolve the most-restrictive policy stack
    const resolvedPolicy = this.policyResolver.resolve(request.policyStack);
    const policyCheck = this.policyResolver.isToolAllowed(
      manifest.name, manifest.riskLevel, resolvedPolicy,
    );
    if (!policyCheck.allowed) {
      return this.denyInvocation(invocation, request.sessionId, policyCheck.reason!);
    }

    // 2c. Classify operation kind and enforce read vs mutation policy (R18.5)
    const operationKind = classifyOperationKind(manifest);
    const mutatingCategory = classifyMutatingCategory(request.toolName, manifest);

    // 2d. Canonical path containment for both read and mutation (R18.5)
    if (this.config.workspaceRoots.length > 0) {
      const containmentResult = this.checkScopeContainment(request.scope, request.arguments);
      if (!containmentResult.allowed) {
        return this.denyInvocation(invocation, request.sessionId, containmentResult.reason!);
      }
    }

    // 2e. Network policy enforcement
    if (manifest.networkPolicy !== 'none' && !resolvedPolicy.networkAllowed) {
      return this.denyInvocation(invocation, request.sessionId,
        `Tool '${request.toolName}' requires network access but policy denies it`);
    }

    // 2f. Secret access enforcement
    if (manifest.secretAccess.length > 0 && !resolvedPolicy.secretAccessAllowed) {
      return this.denyInvocation(invocation, request.sessionId,
        `Tool '${request.toolName}' requires secret access but policy denies it`);
    }

    // Step 3: Approval for mutating operations (R18.3, R18.4)
    if (operationKind === 'mutation' && mutatingCategory !== null) {
      // Determine if this specific tool requires approval based on policy
      const requiresApproval = this.approvalService.requiresApproval(
        request.toolName,
        manifest.riskLevel as any,
        mutatingCategory === 'network' ? 'network'
          : mutatingCategory === 'credential' ? 'credential'
          : mutatingCategory === 'external-service' || mutatingCategory === 'mcp' ? 'external-service'
          : 'destructive',
      );

      if (requiresApproval) {
        // Check for existing grant
        const hasGrant = this.approvalService.hasActiveGrant(request.toolName, request.runId);

        if (!hasGrant) {
          // Transition to awaiting_approval
          this.lifecycleService.transition(invocation.id, 'awaiting_approval', request.sessionId);

          // Request approval (blocks until user responds)
          const approvalResponse = await this.approvalService.requestApproval(
            invocation, request.sessionId,
          );

          if (!approvalResponse.approved) {
            this.lifecycleService.transition(invocation.id, 'rejected', request.sessionId);
            return {
              success: false,
              invocation: this.lifecycleService.getInvocation(invocation.id)!,
              denied: true,
              denialReason: approvalResponse.reason ?? 'User rejected the tool invocation',
            };
          }

          // If arguments were edited during approval, use the edited version
          if (approvalResponse.editedArguments) {
            Object.assign(request.arguments, approvalResponse.editedArguments);
          }
        }
      }
    }

    // Step 4: Execute with timeout (R18.6, R18.7)
    this.lifecycleService.transition(invocation.id, 'running', request.sessionId);

    const timeoutMs = manifest.timeoutMs ?? this.config.defaultTimeoutMs;
    let result: { success: boolean; output: unknown; error?: string };

    try {
      result = await this.executeWithTimeout(request.execute, request.arguments, timeoutMs);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if it was a timeout
      if (errorMessage === 'TOOL_EXECUTION_TIMEOUT') {
        this.lifecycleService.transition(invocation.id, 'timed_out', request.sessionId);
        return {
          success: false,
          invocation: this.lifecycleService.getInvocation(invocation.id)!,
          error: `Tool '${request.toolName}' timed out after ${timeoutMs}ms`,
          retryGuidance: this.buildRetryGuidance('timeout', request),
        };
      }

      // General execution failure
      this.lifecycleService.fail(invocation.id, request.sessionId, {
        error: errorMessage,
        errorCategory: 'runtime',
        retryable: true,
      });
      return {
        success: false,
        invocation: this.lifecycleService.getInvocation(invocation.id)!,
        error: errorMessage,
        retryGuidance: this.buildRetryGuidance('unknown', request),
      };
    }

    // Step 5: Handle result
    if (!result.success) {
      this.lifecycleService.fail(invocation.id, request.sessionId, {
        error: result.error ?? 'Tool execution failed',
        errorCategory: 'runtime',
        retryable: true,
        modelFeedback: result.error,
      });
      return {
        success: false,
        invocation: this.lifecycleService.getInvocation(invocation.id)!,
        error: result.error,
        retryGuidance: this.buildRetryGuidance('unknown', request),
      };
    }

    // Step 6: Bound output and preserve full logs (R18.6)
    const { boundedOutput, fullOutputArtifactRef } = this.boundOutput(
      invocation.id, result.output, manifest.outputBoundsBytes,
    );

    // Set the output preview on the invocation
    if (typeof boundedOutput === 'string') {
      this.lifecycleService.setOutputPreview(invocation.id, boundedOutput);
    }

    // Transition to succeeded
    this.lifecycleService.transition(invocation.id, 'succeeded', request.sessionId);

    return {
      success: true,
      invocation: this.lifecycleService.getInvocation(invocation.id)!,
      output: boundedOutput,
      fullOutputArtifactRef,
    };
  }

  /**
   * Cancel a specific tool invocation (R18.9 - independent cancellation).
   */
  cancel(invocationId: string, sessionId: string): ToolInvocation {
    return this.lifecycleService.cancel(invocationId, sessionId);
  }

  /**
   * Get all active (non-terminal) invocations for independent management (R18.9).
   */
  getActiveInvocations(filter?: { runId?: string; taskId?: string }): ToolInvocation[] {
    return this.lifecycleService.getInvocations(filter).filter(
      (inv) => !TERMINAL_STATES.has(inv.state),
    );
  }

  /**
   * Check if an invocation result carries the correlation marker
   * that identifies it as tool-generated (R18.8).
   */
  isToolGeneratedContent(correlationId: string): boolean {
    // Tool results include a correlation ID that marks them as non-user-authored
    const allInvocations = this.lifecycleService.getInvocations();
    return allInvocations.some((inv) => inv.correlationId === correlationId);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Deny an invocation during policy checking and transition to rejected.
   */
  private denyInvocation(
    invocation: ToolInvocation,
    sessionId: string,
    reason: string,
  ): GatewayInvocationResult {
    this.lifecycleService.transition(invocation.id, 'rejected', sessionId);
    return {
      success: false,
      invocation: this.lifecycleService.getInvocation(invocation.id)!,
      denied: true,
      denialReason: reason,
    };
  }

  /**
   * Execute a tool function with timeout enforcement.
   */
  private async executeWithTimeout(
    executeFn: (args: Record<string, unknown>) => Promise<{ success: boolean; output: unknown; error?: string }>,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ success: boolean; output: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('TOOL_EXECUTION_TIMEOUT'));
      }, timeoutMs);

      executeFn(args)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Bound output to configured limits, preserve full logs as artifact (R18.6).
   */
  private boundOutput(
    invocationId: string,
    rawOutput: unknown,
    manifestBounds: number,
  ): { boundedOutput: unknown; fullOutputArtifactRef?: string } {
    if (rawOutput === null || rawOutput === undefined) {
      return { boundedOutput: rawOutput };
    }

    const outputStr = typeof rawOutput === 'string'
      ? rawOutput
      : JSON.stringify(rawOutput);

    const effectiveBound = Math.min(this.config.maxOutputPreviewBytes, manifestBounds);

    if (outputStr.length <= effectiveBound) {
      return { boundedOutput: rawOutput };
    }

    // Output exceeds bounds - truncate preview and preserve full as artifact
    const boundedOutput = outputStr.slice(0, effectiveBound) + '\n...[output truncated]';
    let fullOutputArtifactRef: string | undefined;

    // Preserve full output as artifact if within absolute max
    if (outputStr.length <= this.config.maxFullOutputBytes && this.artifactListener) {
      const contentHash = this.computeSimpleHash(outputStr);
      fullOutputArtifactRef = this.artifactListener({
        invocationId,
        fullOutput: outputStr,
        contentHash,
      });
    }

    return { boundedOutput, fullOutputArtifactRef };
  }

  /**
   * Check containment for scope and path-bearing arguments (R18.5).
   */
  private checkScopeContainment(
    scope: string,
    args: Record<string, unknown>,
  ): ContainmentCheckResult {
    // Check scope itself
    if (scope && scope.startsWith('/')) {
      const scopeCheck = checkCanonicalContainment(scope, this.config.workspaceRoots);
      if (!scopeCheck.allowed) return scopeCheck;
    }

    // Check path-bearing arguments
    const pathKeys = ['path', 'file', 'filePath', 'target', 'directory', 'dir', 'cwd'];
    for (const key of pathKeys) {
      const value = args[key];
      if (typeof value === 'string' && value.startsWith('/')) {
        const argCheck = checkCanonicalContainment(value, this.config.workspaceRoots);
        if (!argCheck.allowed) return argCheck;
      }
    }

    return { allowed: true };
  }

  /**
   * Build typed retry guidance for failed invocations (R18.7).
   */
  private buildRetryGuidance(
    category: 'transient' | 'permission' | 'validation' | 'resource' | 'timeout' | 'unknown',
    request: GatewayToolRequest,
  ): RetryGuidance {
    const retryKey = `${request.runId ?? 'no-run'}:${request.toolName}`;
    const currentCount = this.retryCounts.get(retryKey) ?? 0;
    this.retryCounts.set(retryKey, currentCount + 1);

    const retriesRemaining = Math.max(0, this.config.maxRetriesPerTool - currentCount - 1);
    const retryable = retriesRemaining > 0 && category !== 'permission';

    const actions: Record<string, string> = {
      transient: 'Retry after a brief delay; the issue is likely temporary',
      permission: 'Request the necessary permissions or adjust policy',
      validation: 'Fix the input arguments and retry',
      resource: 'Ensure the target resource exists and is accessible',
      timeout: 'Increase timeout or break the operation into smaller steps',
      unknown: 'Investigate the error and retry if appropriate',
    };

    return {
      retryable,
      errorCategory: category,
      suggestedAction: actions[category],
      retriesRemaining,
      backoffMs: category === 'transient' ? Math.min(1000 * 2 ** currentCount, 30_000) : undefined,
    };
  }

  /**
   * Simple hash for content identity (not cryptographic).
   */
  private computeSimpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return `hash-${Math.abs(hash).toString(16)}`;
  }
}
