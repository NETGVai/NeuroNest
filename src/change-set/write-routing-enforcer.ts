/**
 * WriteRoutingEnforcer — Routes all agent proposal writes through
 * ChangeSetCoordinator and disables direct write bypasses behind
 * compatibility gates.
 *
 * This module enforces the design rule that ChangeSetCoordinator is
 * "the only path from agent-originated proposed mutations to accepted
 * workspace mutations." Direct writes are either routed through the
 * coordinator or blocked when the compatibility gate is enabled.
 *
 * Requirements: 5.1, 28.4
 */

import type { ChangeSetCoordinator } from './change-set-coordinator';
import type { FileOperation } from './types';

// ─── Write Routing Types ────────────────────────────────────────────────────

/**
 * Origin of a write request.
 */
export type WriteOrigin = 'agent' | 'user' | 'system' | 'legacy';

/**
 * Result of a write routing decision.
 */
export type WriteRoutingDecision =
  | 'routed_through_coordinator'
  | 'blocked_by_gate'
  | 'allowed_direct'
  | 'legacy_compatibility';

/**
 * A write request intercepted by the enforcer.
 */
export interface WriteRequest {
  /** Unique request ID. */
  readonly id: string;
  /** Origin of the write. */
  readonly origin: WriteOrigin;
  /** Target URI for the write. */
  readonly targetUri: string;
  /** The content to write. */
  readonly content: string;
  /** Workspace ID context. */
  readonly workspaceId: string;
  /** Associated run ID (for agent writes). */
  readonly runId?: string;
  /** Associated task ID. */
  readonly taskId?: string;
  /** Base content hash (for modify operations). */
  readonly baseHash?: string;
}

/**
 * Result of routing a write request.
 */
export interface WriteRoutingResult {
  /** The routing decision made. */
  readonly decision: WriteRoutingDecision;
  /** Whether the write was allowed to proceed. */
  readonly allowed: boolean;
  /** The Change_Set created (if routed through coordinator). */
  readonly changeSetId?: string;
  /** Reason the write was blocked (if blocked). */
  readonly blockReason?: string;
  /** Timestamp of the decision. */
  readonly timestamp: string;
}

/**
 * Audit record for write routing decisions.
 */
export interface WriteRoutingAuditEntry {
  /** The write request. */
  readonly request: WriteRequest;
  /** The routing result. */
  readonly result: WriteRoutingResult;
}

/**
 * Configuration for the compatibility gate controlling direct writes.
 */
export interface DirectWriteGateConfig {
  /** Whether the change_sets gate is enabled (blocks direct agent writes). */
  readonly changeSetGateEnabled: boolean;
  /** Whether legacy direct writes are allowed in compatibility mode. */
  readonly legacyCompatibilityMode: boolean;
  /** Whether to audit (log) all write decisions even in compatibility mode. */
  readonly auditAllWrites: boolean;
}

// ─── WriteRoutingEnforcer ───────────────────────────────────────────────────

/**
 * WriteRoutingEnforcer ensures all agent-originated file mutations flow through
 * ChangeSetCoordinator. When the change_sets gate is enabled, direct writes
 * from agents are blocked unless they pass through the coordinator.
 *
 * Legacy systems that haven't migrated yet can still write in compatibility
 * mode, but those writes are audited and will be disabled at cutover.
 */
export class WriteRoutingEnforcer {
  private readonly coordinator: ChangeSetCoordinator;
  private config: DirectWriteGateConfig;

  /** Audit trail of all routing decisions. */
  private readonly auditLog: WriteRoutingAuditEntry[] = [];
  /** Count of blocked writes for monitoring. */
  private blockedWriteCount = 0;
  /** Count of routed writes for monitoring. */
  private routedWriteCount = 0;
  /** Count of legacy compatibility writes for monitoring. */
  private legacyWriteCount = 0;

  constructor(
    coordinator: ChangeSetCoordinator,
    config?: Partial<DirectWriteGateConfig>
  ) {
    this.coordinator = coordinator;
    this.config = {
      changeSetGateEnabled: config?.changeSetGateEnabled ?? false,
      legacyCompatibilityMode: config?.legacyCompatibilityMode ?? true,
      auditAllWrites: config?.auditAllWrites ?? true,
    };
  }

  /**
   * Routes a write request through the appropriate path.
   *
   * Agent writes: always routed through ChangeSetCoordinator (when gate enabled)
   * or blocked if routing fails.
   *
   * User writes: allowed directly (users edit through the editor).
   *
   * Legacy writes: allowed in compatibility mode with audit, blocked after cutover.
   */
  routeWrite(request: WriteRequest): WriteRoutingResult {
    let result: WriteRoutingResult;

    switch (request.origin) {
      case 'agent':
        result = this.routeAgentWrite(request);
        break;
      case 'user':
        result = this.routeUserWrite(request);
        break;
      case 'legacy':
        result = this.routeLegacyWrite(request);
        break;
      case 'system':
        result = this.routeSystemWrite(request);
        break;
      default:
        result = {
          decision: 'blocked_by_gate',
          allowed: false,
          blockReason: `Unknown write origin: ${request.origin}`,
          timestamp: new Date().toISOString(),
        };
    }

    // Record audit entry
    if (this.config.auditAllWrites || !result.allowed) {
      this.auditLog.push({ request, result });
    }

    return result;
  }

  /**
   * Updates the gate configuration. Used during staged rollout.
   */
  updateConfig(config: Partial<DirectWriteGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Gets current gate configuration.
   */
  getConfig(): Readonly<DirectWriteGateConfig> {
    return { ...this.config };
  }

  /**
   * Returns whether the direct write bypass is disabled (cutover complete).
   */
  isDirectWriteBypassDisabled(): boolean {
    return this.config.changeSetGateEnabled && !this.config.legacyCompatibilityMode;
  }

  /**
   * Gets the audit log for inspection.
   */
  getAuditLog(): readonly WriteRoutingAuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Gets routing statistics.
   */
  getStats(): {
    blocked: number;
    routed: number;
    legacy: number;
    total: number;
  } {
    return {
      blocked: this.blockedWriteCount,
      routed: this.routedWriteCount,
      legacy: this.legacyWriteCount,
      total: this.auditLog.length,
    };
  }

  /**
   * Clears the audit log (for testing or after export).
   */
  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  // ─── Private Routing Methods ──────────────────────────────────────────

  private routeAgentWrite(request: WriteRequest): WriteRoutingResult {
    if (!this.config.changeSetGateEnabled) {
      // Gate disabled — agent writes are allowed but audited
      this.routedWriteCount++;
      return {
        decision: 'legacy_compatibility',
        allowed: true,
        timestamp: new Date().toISOString(),
      };
    }

    // Gate enabled — all agent writes MUST go through ChangeSetCoordinator
    try {
      const operation: FileOperation = this.buildFileOperation(request);
      const { changeSet } = this.coordinator.proposeOperation({
        operation,
        baseContent: null,
        createParams: {
          workspaceId: request.workspaceId,
          taskId: request.taskId ?? 'unknown',
          runId: request.runId ?? 'unknown',
          chatEventId: `write-${request.id}`,
          baseRevision: 'head',
          operations: [],
        },
      });

      this.routedWriteCount++;
      return {
        decision: 'routed_through_coordinator',
        allowed: true,
        changeSetId: changeSet.id,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      this.blockedWriteCount++;
      return {
        decision: 'blocked_by_gate',
        allowed: false,
        blockReason: `Failed to route through ChangeSetCoordinator: ${(err as Error).message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private routeUserWrite(_request: WriteRequest): WriteRoutingResult {
    // User writes go directly through the editor — no coordinator routing needed
    return {
      decision: 'allowed_direct',
      allowed: true,
      timestamp: new Date().toISOString(),
    };
  }

  private routeLegacyWrite(_request: WriteRequest): WriteRoutingResult {
    if (!this.config.changeSetGateEnabled) {
      // Gate not yet enabled — allow legacy writes
      this.legacyWriteCount++;
      return {
        decision: 'legacy_compatibility',
        allowed: true,
        timestamp: new Date().toISOString(),
      };
    }

    if (this.config.legacyCompatibilityMode) {
      // Gate enabled but compatibility mode active — allow with audit
      this.legacyWriteCount++;
      return {
        decision: 'legacy_compatibility',
        allowed: true,
        timestamp: new Date().toISOString(),
      };
    }

    // Gate enabled and compatibility mode off — block legacy writes
    this.blockedWriteCount++;
    return {
      decision: 'blocked_by_gate',
      allowed: false,
      blockReason:
        'Direct write bypass is disabled. All agent writes must use ChangeSetCoordinator. ' +
        'Legacy compatibility mode has been disabled after cutover.',
      timestamp: new Date().toISOString(),
    };
  }

  private routeSystemWrite(_request: WriteRequest): WriteRoutingResult {
    // System writes (e.g., configuration, metadata) are allowed directly
    return {
      decision: 'allowed_direct',
      allowed: true,
      timestamp: new Date().toISOString(),
    };
  }

  private buildFileOperation(request: WriteRequest): FileOperation {
    if (request.baseHash) {
      return {
        kind: 'modify',
        targetUri: request.targetUri,
        baseHash: request.baseHash,
        proposedBlob: request.content,
      };
    }
    return {
      kind: 'create',
      targetUri: request.targetUri,
      proposedBlob: request.content,
    };
  }
}
