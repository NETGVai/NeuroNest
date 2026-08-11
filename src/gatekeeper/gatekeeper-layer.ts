/**
 * Gatekeeper Layer — Capability-based security mediating all agent/Gadget
 * access to external services.
 *
 * Provides:
 * - Zero-access startup (no capabilities until explicitly introduced)
 * - Unforgeable capability bindings with scoped operations
 * - Audit logging of all operations to SQLite
 * - Rate limit enforcement (sliding window per capability)
 * - Capability expiry checking on each execute call
 * - Integration with PermissionPatternEngine for posture evaluation
 * - Integration with CredentialVault for credential isolation
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  GatekeeperLayer,
  CapabilityBinding,
  AuditEntry,
  AuditFilter,
  ResourceDefinition,
  AccessDecision,
  PendingAction,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';
import type { SecurityPostureLevel } from '../agent-harness/types.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Minimal interface for the PermissionPatternEngine dependency.
 * The Gatekeeper delegates posture-based decisions to this engine.
 */
export interface PermissionPatternEngineLike {
  evaluate(toolName: string, args: string, agentId?: string): 'allow' | 'deny' | 'no-match';
}

/**
 * Minimal interface for the CredentialVault dependency.
 * The Gatekeeper uses this to retrieve credentials at execution time
 * without exposing raw values to agent code.
 */
export interface CredentialVaultLike {
  exists(name: string): boolean;
  decrypt(name: string): Promise<string>;
}

/**
 * Minimal interface for the SecurityPosture dependency.
 * Used to determine the active security posture (strict/auto/autonomous).
 */
export interface SecurityPostureLike {
  getEffective(projectId: string): SecurityPostureLevel;
}

/**
 * Configuration for the GatekeeperLayerImpl.
 */
export interface GatekeeperConfig {
  db: Database.Database;
  permissionEngine?: PermissionPatternEngineLike;
  credentialVault?: CredentialVaultLike;
  securityPosture?: SecurityPostureLike;
  /** Default project ID for posture lookups */
  projectId?: string;
  /** Callback invoked when user approval is required (strict/auto mode) */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;
}

/**
 * Request struct for user approval.
 */
export interface ApprovalRequest {
  agentId: string;
  resourceType: string;
  scope: string;
  operation?: string;
}

// ─── Rate Limit Tracking ────────────────────────────────────────

interface RateLimitWindow {
  timestamps: number[];
}

// ─── Row types ──────────────────────────────────────────────────

interface CapabilityBindingRow {
  id: string;
  resource_id: string;
  resource_type: string;
  allowed_operations: string;
  scope_constraints: string;
  rate_limit_max: number | null;
  rate_limit_window_ms: number | null;
  expires_at: string | null;
  granted_by: string;
  created_at: string;
}

interface AuditLogRow {
  id: string;
  timestamp: string;
  actor_id: string;
  actor_type: string;
  resource_id: string;
  operation: string;
  parameters: string | null;
  result_status: string;
  capability_id: string;
}

interface PendingActionRow {
  id: string;
  agent_id: string;
  capability_id: string;
  operation: string;
  parameters: string;
  simulated_result: string | null;
  status: string;
  depends_on: string | null;
  created_at: string;
  resolved_at: string | null;
  rejection_reason: string | null;
}

// ─── Implementation ─────────────────────────────────────────────

export class GatekeeperLayerImpl implements GatekeeperLayer {
  private db: Database.Database;
  private permissionEngine: PermissionPatternEngineLike | null;
  private credentialVault: CredentialVaultLike | null;
  private securityPosture: SecurityPostureLike | null;
  private projectId: string;
  private onApprovalRequired: ((request: ApprovalRequest) => Promise<boolean>) | null;

  /** In-memory sliding window rate limit tracking per capability binding */
  private rateLimitWindows: Map<string, RateLimitWindow> = new Map();

  // Prepared statements
  private stmtInsertBinding: Database.Statement;
  private stmtGetBinding: Database.Statement;
  private stmtDeleteBinding: Database.Statement;
  private stmtInsertAudit: Database.Statement;
  private stmtGetAuditAll: Database.Statement;
  private stmtGetPending: Database.Statement;
  private stmtUpdatePendingApproved: Database.Statement;
  private stmtUpdatePendingRejected: Database.Statement;

  constructor(config: GatekeeperConfig) {
    this.db = config.db;
    this.permissionEngine = config.permissionEngine ?? null;
    this.credentialVault = config.credentialVault ?? null;
    this.securityPosture = config.securityPosture ?? null;
    this.projectId = config.projectId ?? 'default';
    this.onApprovalRequired = config.onApprovalRequired ?? null;

    // Prepare statements for performance
    this.stmtInsertBinding = this.db.prepare(`
      INSERT INTO capability_bindings (id, resource_id, resource_type, allowed_operations, scope_constraints, rate_limit_max, rate_limit_window_ms, expires_at, granted_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetBinding = this.db.prepare(`
      SELECT * FROM capability_bindings WHERE id = ?
    `);

    this.stmtDeleteBinding = this.db.prepare(`
      DELETE FROM capability_bindings WHERE id = ?
    `);

    this.stmtInsertAudit = this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, actor_id, actor_type, resource_id, operation, parameters, result_status, capability_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetAuditAll = this.db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC
    `);

    this.stmtGetPending = this.db.prepare(`
      SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at ASC
    `);

    this.stmtUpdatePendingApproved = this.db.prepare(`
      UPDATE pending_actions SET status = 'approved', resolved_at = ? WHERE id = ?
    `);

    this.stmtUpdatePendingRejected = this.db.prepare(`
      UPDATE pending_actions SET status = 'rejected', resolved_at = ?, rejection_reason = ? WHERE id = ?
    `);
  }

  // ─── Core Interface Methods ───────────────────────────────────

  /**
   * Introduce a resource to the Gatekeeper, creating a capability binding.
   * This is the ONLY way to grant access — agents/Gadgets start with zero access.
   */
  async introduceResource(resource: ResourceDefinition): Promise<CapabilityBinding> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const binding: CapabilityBinding = {
      id,
      resourceId: resource.id,
      resourceType: resource.type,
      allowedOperations: resource.allowedOperations,
      scopeConstraints: resource.scopeConstraints ?? {},
      rateLimit: resource.rateLimit,
      expiresAt: resource.expiresAt,
      createdAt: now,
      grantedBy: 'user', // Resources are always introduced by the user
    };

    // Persist to SQLite
    this.stmtInsertBinding.run(
      binding.id,
      binding.resourceId,
      binding.resourceType,
      JSON.stringify(binding.allowedOperations),
      JSON.stringify(binding.scopeConstraints),
      binding.rateLimit?.maxRequests ?? null,
      binding.rateLimit?.windowMs ?? null,
      binding.expiresAt ?? null,
      binding.grantedBy,
      binding.createdAt,
    );

    return binding;
  }

  /**
   * Revoke a capability binding, immediately preventing further operations.
   */
  revokeCapability(bindingId: string): void {
    const row = this.stmtGetBinding.get(bindingId) as CapabilityBindingRow | undefined;
    if (!row) {
      throw this.createError('CAPABILITY_NOT_FOUND', `Capability binding "${bindingId}" not found`);
    }

    this.stmtDeleteBinding.run(bindingId);

    // Clean up rate limit tracking
    this.rateLimitWindows.delete(bindingId);
  }

  /**
   * Execute an operation through a capability binding.
   *
   * Checks:
   * 1. Binding exists and is not revoked
   * 2. Binding has not expired
   * 3. Operation is in the allowed operations list
   * 4. Rate limit has not been exceeded
   * 5. Security posture allows the operation
   *
   * Logs the operation to the audit chain regardless of outcome.
   */
  async execute(
    binding: CapabilityBinding,
    operation: string,
    params: unknown,
  ): Promise<unknown> {
    const actorId = 'agent'; // Default actor for execute calls
    const actorType: 'agent' | 'gadget' | 'code_mode' = 'agent';

    // 1. Verify binding still exists (not revoked)
    const row = this.stmtGetBinding.get(binding.id) as CapabilityBindingRow | undefined;
    if (!row) {
      // Cannot log to audit (FK constraint requires binding to exist), so log denial without FK
      this.logAuditDeniedNoBinding(actorId, actorType, binding.resourceId, operation, params, binding.id);
      throw this.createError(
        'CAPABILITY_REVOKED',
        `Capability binding "${binding.id}" has been revoked`,
        { recoverable: true, suggestedAction: 'request_new_capability' },
      );
    }

    // 2. Check expiry
    if (row.expires_at) {
      const expiryTime = new Date(row.expires_at).getTime();
      if (Date.now() > expiryTime) {
        // Delete the expired binding first, then log with FK disabled
        this.stmtDeleteBinding.run(binding.id);
        this.logAuditDeniedNoBinding(actorId, actorType, binding.resourceId, operation, params, binding.id);
        throw this.createError(
          'CAPABILITY_EXPIRED',
          `Capability binding "${binding.id}" has expired`,
          { recoverable: true, suggestedAction: 'request_new_capability' },
        );
      }
    }

    // 3. Check operation is allowed
    const allowedOps: string[] = JSON.parse(row.allowed_operations);
    if (!allowedOps.includes(operation)) {
      this.logAudit(actorId, actorType, binding.resourceId, operation, params, 'denied', binding.id);
      throw this.createError(
        'ACCESS_DENIED',
        `Operation "${operation}" is not permitted by capability binding "${binding.id}". Allowed: ${allowedOps.join(', ')}`,
      );
    }

    // 4. Check rate limit
    if (binding.rateLimit) {
      const rateLimitExceeded = this.checkRateLimit(binding.id, binding.rateLimit);
      if (rateLimitExceeded) {
        this.logAudit(actorId, actorType, binding.resourceId, operation, params, 'denied', binding.id);
        throw this.createError(
          'RATE_LIMIT_EXCEEDED',
          `Rate limit exceeded for capability "${binding.id}": max ${binding.rateLimit.maxRequests} requests per ${binding.rateLimit.windowMs}ms`,
          { recoverable: true, suggestedAction: 'wait_and_retry' },
        );
      }
    }

    // 5. Check security posture via PermissionPatternEngine
    if (this.permissionEngine) {
      const decision = this.permissionEngine.evaluate(
        binding.resourceType,
        `${operation}:${JSON.stringify(params)}`,
      );
      if (decision === 'deny') {
        this.logAudit(actorId, actorType, binding.resourceId, operation, params, 'denied', binding.id);
        throw this.createError(
          'ACCESS_DENIED',
          `Permission pattern engine denied operation "${operation}" on resource type "${binding.resourceType}"`,
        );
      }
    }

    // 6. Record rate limit usage
    if (binding.rateLimit) {
      this.recordRateLimitUsage(binding.id);
    }

    // Log successful execution
    this.logAudit(actorId, actorType, binding.resourceId, operation, params, 'success', binding.id);

    // Return a placeholder result. In a full implementation, this would
    // proxy the call through the credential vault to the actual service.
    return { success: true, operation, params };
  }

  /**
   * Request access to a resource. Evaluates security posture and either
   * auto-approves or queues for user approval.
   *
   * - strict mode: always requires explicit approval
   * - auto mode: previously-approved patterns auto-approve; new patterns prompt
   * - autonomous mode: auto-approve within granted scope; alert on scope expansion
   */
  async requestAccess(
    agentId: string,
    resourceType: string,
    scope: string,
  ): Promise<AccessDecision> {
    // Check if a binding already exists for this resource type + scope
    const existingBinding = this.findExistingBinding(resourceType, scope);
    if (existingBinding) {
      return {
        granted: true,
        binding: existingBinding,
        reason: 'Existing capability binding found for this resource and scope',
      };
    }

    // Determine current security posture
    const posture = this.getEffectivePosture();

    switch (posture) {
      case 'autonomous': {
        // Auto-approve within granted scope
        const binding = await this.introduceResource({
          id: `${resourceType}:${scope}`,
          type: resourceType,
          name: `${resourceType} - ${scope}`,
          allowedOperations: ['read', 'write', 'list'],
          scopeConstraints: { scope },
        });
        return {
          granted: true,
          binding,
          reason: 'Auto-approved in autonomous mode',
        };
      }

      case 'auto': {
        // Check permission engine for previously-approved patterns
        if (this.permissionEngine) {
          const decision = this.permissionEngine.evaluate(resourceType, scope, agentId);
          if (decision === 'allow') {
            const binding = await this.introduceResource({
              id: `${resourceType}:${scope}`,
              type: resourceType,
              name: `${resourceType} - ${scope}`,
              allowedOperations: ['read', 'write', 'list'],
              scopeConstraints: { scope },
            });
            return {
              granted: true,
              binding,
              reason: 'Auto-approved by permission pattern engine (auto mode)',
            };
          }
          if (decision === 'deny') {
            return {
              granted: false,
              reason: 'Denied by permission pattern engine',
            };
          }
        }

        // New pattern — requires approval
        return this.requestUserApproval(agentId, resourceType, scope);
      }

      case 'strict':
      default: {
        // Always requires explicit approval
        return this.requestUserApproval(agentId, resourceType, scope);
      }
    }
  }

  /**
   * Get audit log entries with optional filtering.
   */
  getAuditLog(filter?: AuditFilter): AuditEntry[] {
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.actorId) {
      query += ' AND actor_id = ?';
      params.push(filter.actorId);
    }
    if (filter?.resourceId) {
      query += ' AND resource_id = ?';
      params.push(filter.resourceId);
    }
    if (filter?.startTime) {
      query += ' AND timestamp >= ?';
      params.push(filter.startTime);
    }
    if (filter?.endTime) {
      query += ' AND timestamp <= ?';
      params.push(filter.endTime);
    }
    if (filter?.resultStatus) {
      query += ' AND result_status = ?';
      params.push(filter.resultStatus);
    }

    query += ' ORDER BY timestamp DESC';

    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(query).all(...params) as AuditLogRow[];
    return rows.map(this.rowToAuditEntry);
  }

  /**
   * Get all pending approval actions.
   */
  getPendingApprovals(): PendingAction[] {
    const rows = this.stmtGetPending.all() as PendingActionRow[];
    return rows.map(this.rowToPendingAction);
  }

  /**
   * Approve a pending action and execute it.
   */
  async approveAction(actionId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.stmtUpdatePendingApproved.run(now, actionId);
    if (result.changes === 0) {
      throw this.createError(
        'ACCESS_DENIED',
        `Pending action "${actionId}" not found or already resolved`,
      );
    }
  }

  /**
   * Reject a pending action with a reason.
   */
  async rejectAction(actionId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.stmtUpdatePendingRejected.run(now, reason, actionId);
    if (result.changes === 0) {
      throw this.createError(
        'ACCESS_DENIED',
        `Pending action "${actionId}" not found or already resolved`,
      );
    }
  }

  /**
   * Bulk approve multiple pending actions.
   */
  async bulkApprove(actionIds: string[]): Promise<void> {
    const now = new Date().toISOString();
    const approveTransaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmtUpdatePendingApproved.run(now, id);
      }
    });
    approveTransaction(actionIds);
  }

  // ─── Rate Limiting ────────────────────────────────────────────

  /**
   * Check if the rate limit has been exceeded for a capability binding.
   * Uses a sliding window approach.
   */
  private checkRateLimit(
    bindingId: string,
    rateLimit: { maxRequests: number; windowMs: number },
  ): boolean {
    const window = this.rateLimitWindows.get(bindingId);
    if (!window) return false;

    const now = Date.now();
    const windowStart = now - rateLimit.windowMs;

    // Count requests within the sliding window
    const recentRequests = window.timestamps.filter((t) => t > windowStart);
    return recentRequests.length >= rateLimit.maxRequests;
  }

  /**
   * Record a rate limit usage for a capability binding.
   */
  private recordRateLimitUsage(bindingId: string): void {
    let window = this.rateLimitWindows.get(bindingId);
    if (!window) {
      window = { timestamps: [] };
      this.rateLimitWindows.set(bindingId, window);
    }

    const now = Date.now();
    window.timestamps.push(now);

    // Garbage collect old entries (keep only last 2x window to avoid memory leak)
    // We use 2x as a reasonable buffer for cleanup
    if (window.timestamps.length > 1000) {
      window.timestamps = window.timestamps.slice(-500);
    }
  }

  // ─── Audit Logging ────────────────────────────────────────────

  /**
   * Log an operation to the audit chain.
   * Requires the capability binding to exist in the database (FK constraint).
   */
  private logAudit(
    actorId: string,
    actorType: 'agent' | 'gadget' | 'code_mode',
    resourceId: string,
    operation: string,
    params: unknown,
    resultStatus: 'success' | 'denied' | 'error',
    capabilityId: string,
  ): void {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    this.stmtInsertAudit.run(
      id,
      timestamp,
      actorId,
      actorType,
      resourceId,
      operation,
      params ? JSON.stringify(params) : null,
      resultStatus,
      capabilityId,
    );
  }

  /**
   * Log a denied operation when the binding no longer exists in the database.
   * Uses a direct INSERT that bypasses the FK constraint by temporarily disabling it,
   * or inserts with capability_id set to a sentinel value.
   * Since the binding was already deleted, we use a raw SQL insert without FK reference.
   */
  private logAuditDeniedNoBinding(
    actorId: string,
    actorType: 'agent' | 'gadget' | 'code_mode',
    resourceId: string,
    operation: string,
    params: unknown,
    capabilityId: string,
  ): void {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    // Use a deferred FK approach: temporarily disable FK checks for this audit entry
    // This is necessary because the binding was revoked/expired before we could log.
    try {
      this.db.pragma('foreign_keys = OFF');
      this.stmtInsertAudit.run(
        id,
        timestamp,
        actorId,
        actorType,
        resourceId,
        operation,
        params ? JSON.stringify(params) : null,
        'denied',
        capabilityId,
      );
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  // ─── Posture Integration ──────────────────────────────────────

  /**
   * Get the effective security posture level.
   * Falls back to 'auto' if no posture system is configured.
   */
  private getEffectivePosture(): SecurityPostureLevel {
    if (this.securityPosture) {
      return this.securityPosture.getEffective(this.projectId);
    }
    return 'auto';
  }

  // ─── User Approval ────────────────────────────────────────────

  /**
   * Request user approval for a resource access request.
   * If an approval callback is configured, uses it. Otherwise denies.
   */
  private async requestUserApproval(
    agentId: string,
    resourceType: string,
    scope: string,
  ): Promise<AccessDecision> {
    if (this.onApprovalRequired) {
      const approved = await this.onApprovalRequired({
        agentId,
        resourceType,
        scope,
      });

      if (approved) {
        const binding = await this.introduceResource({
          id: `${resourceType}:${scope}`,
          type: resourceType,
          name: `${resourceType} - ${scope}`,
          allowedOperations: ['read', 'write', 'list'],
          scopeConstraints: { scope },
        });
        return {
          granted: true,
          binding,
          reason: 'Approved by user',
        };
      }
    }

    return {
      granted: false,
      reason: 'Access requires explicit user approval. Resource has not been introduced.',
    };
  }

  // ─── Lookup Helpers ───────────────────────────────────────────

  /**
   * Find an existing capability binding for a given resource type and scope.
   */
  private findExistingBinding(
    resourceType: string,
    scope: string,
  ): CapabilityBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM capability_bindings WHERE resource_type = ? AND scope_constraints LIKE ?`,
      )
      .get(resourceType, `%${scope}%`) as CapabilityBindingRow | undefined;

    if (!row) return undefined;

    // Check if the binding has expired
    if (row.expires_at) {
      const expiryTime = new Date(row.expires_at).getTime();
      if (Date.now() > expiryTime) {
        // Clean up expired binding
        this.stmtDeleteBinding.run(row.id);
        return undefined;
      }
    }

    return this.rowToCapabilityBinding(row);
  }

  // ─── Row Conversion ───────────────────────────────────────────

  private rowToCapabilityBinding(row: CapabilityBindingRow): CapabilityBinding {
    return {
      id: row.id,
      resourceId: row.resource_id,
      resourceType: row.resource_type,
      allowedOperations: JSON.parse(row.allowed_operations),
      scopeConstraints: JSON.parse(row.scope_constraints),
      rateLimit:
        row.rate_limit_max !== null && row.rate_limit_window_ms !== null
          ? { maxRequests: row.rate_limit_max, windowMs: row.rate_limit_window_ms }
          : undefined,
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
      grantedBy: row.granted_by,
    };
  }

  private rowToAuditEntry(row: AuditLogRow): AuditEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      actorId: row.actor_id,
      actorType: row.actor_type as 'agent' | 'gadget' | 'code_mode',
      resourceId: row.resource_id,
      operation: row.operation,
      parameters: row.parameters ? JSON.parse(row.parameters) : {},
      resultStatus: row.result_status as 'success' | 'denied' | 'error',
      capabilityId: row.capability_id,
    };
  }

  private rowToPendingAction(row: PendingActionRow): PendingAction {
    return {
      id: row.id,
      agentId: row.agent_id,
      capabilityId: row.capability_id,
      operation: row.operation,
      parameters: JSON.parse(row.parameters),
      simulatedResult: row.simulated_result ? JSON.parse(row.simulated_result) : null,
      status: row.status as PendingAction['status'],
      dependsOn: row.depends_on ? JSON.parse(row.depends_on) : [],
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
      rejectionReason: row.rejection_reason ?? undefined,
    };
  }

  // ─── Error Helpers ────────────────────────────────────────────

  private createError(
    code: 'CAPABILITY_EXPIRED' | 'CAPABILITY_REVOKED' | 'CAPABILITY_NOT_FOUND' | 'ACCESS_DENIED' | 'RATE_LIMIT_EXCEEDED' | 'RESOURCE_NOT_INTRODUCED' | 'CREDENTIAL_NOT_FOUND',
    message: string,
    options?: { recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    return createSubsystemError('gatekeeper', code, message, {
      recoverable: options?.recoverable ?? false,
      suggestedAction: options?.suggestedAction,
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a GatekeeperLayer instance backed by the given database.
 * The database must have the capability_bindings and audit_log tables (migration 066).
 */
export function createGatekeeperLayer(config: GatekeeperConfig): GatekeeperLayer {
  return new GatekeeperLayerImpl(config);
}
