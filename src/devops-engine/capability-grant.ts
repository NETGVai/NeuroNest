/**
 * Capability Grant System — Time-limited, scope-bound permissions for dangerous operations.
 *
 * Manages the lifecycle of capability grants: propose → approve → active → consumed/expired/revoked.
 * Enforces proposer/approver separation, atomic execution count decrement, automatic revocation
 * on lifetime expiry or execution exhaustion, and audit chain logging of all revocation events.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CapabilityGrant, GrantStatus } from './types';
import type { AuditChainInterface } from './audit-chain';

// ─── Database Row Shape ─────────────────────────────────────────

interface GrantRow {
  id: string;
  environment: string;
  capability_type: string;
  target_set_json: string;
  reason: string;
  proposed_by: string;
  approved_by: string | null;
  lifetime_ms: number;
  max_executions: number;
  remaining_executions: number;
  dry_run_required: number;
  status: string;
  created_at: number;
  expires_at: number;
  activated_at: number | null;
}

/** Convert a database row into a CapabilityGrant object. */
function rowToGrant(row: GrantRow): CapabilityGrant {
  return {
    id: row.id,
    environment: row.environment,
    capabilityType: row.capability_type,
    targetSet: JSON.parse(row.target_set_json) as string[],
    reason: row.reason,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    lifetime: row.lifetime_ms,
    maxExecutions: row.max_executions,
    remainingExecutions: row.remaining_executions,
    dryRunRequired: row.dry_run_required === 1,
    status: row.status as GrantStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    activatedAt: row.activated_at,
  };
}

// ─── CapabilityGrantSystem Interface ────────────────────────────

export interface CapabilityGrantSystem {
  /** Propose a new grant (returns proposed grant with generated fields). */
  propose(
    request: Omit<
      CapabilityGrant,
      'id' | 'status' | 'approvedBy' | 'remainingExecutions' | 'createdAt' | 'expiresAt' | 'activatedAt'
    >
  ): CapabilityGrant;

  /** Approve a grant (must be different identity than proposer). Transitions to 'active'. */
  approve(grantId: string, approverIdentity: string): CapabilityGrant;

  /** Consume one execution from an active grant (atomic decrement). */
  consume(grantId: string): { allowed: boolean; remaining: number };

  /** Revoke a grant (manual or automatic), logging to audit chain. */
  revoke(grantId: string, reason: string): void;

  /** Get active grants for an environment. */
  getActiveGrants(environment: string): CapabilityGrant[];

  /** Check expiration and auto-revoke expired grants. */
  enforceLifetimes(): void;
}

export interface CapabilityGrantOptions {
  auditChain?: AuditChainInterface;
}

/**
 * Creates a CapabilityGrantSystem backed by the provided SQLite database.
 * The `capability_grants` table must already exist (created by migration 063).
 */
export function createCapabilityGrantSystem(
  db: Database.Database,
  options: CapabilityGrantOptions = {}
): CapabilityGrantSystem {
  const { auditChain } = options;

  // ─── Prepared Statements ────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO capability_grants (
      id, environment, capability_type, target_set_json, reason,
      proposed_by, approved_by, lifetime_ms, max_executions,
      remaining_executions, dry_run_required, status, created_at,
      expires_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getByIdStmt = db.prepare(
    `SELECT * FROM capability_grants WHERE id = ?`
  );

  const updateStatusStmt = db.prepare(
    `UPDATE capability_grants SET status = ? WHERE id = ?`
  );

  const approveStmt = db.prepare(
    `UPDATE capability_grants SET status = 'active', approved_by = ?, activated_at = ? WHERE id = ?`
  );

  const decrementStmt = db.prepare(
    `UPDATE capability_grants SET remaining_executions = remaining_executions - 1 WHERE id = ? AND remaining_executions > 0 AND status = 'active'`
  );

  const getActiveByEnvStmt = db.prepare(
    `SELECT * FROM capability_grants WHERE environment = ? AND status = 'active'`
  );

  const getAllActiveStmt = db.prepare(
    `SELECT * FROM capability_grants WHERE status = 'active'`
  );

  // ─── Audit Logging Helper ─────────────────────────────────────

  function logRevocation(grant: CapabilityGrant, reason: string): void {
    if (!auditChain) return;
    try {
      auditChain.append({
        timestamp: Date.now(),
        agentId: 'capability-grant-system',
        toolName: 'grant:revoke',
        arguments: {
          grantId: grant.id,
          environment: grant.environment,
          capabilityType: grant.capabilityType,
          reason,
          previousStatus: grant.status,
        },
        resultSummary: `Grant ${grant.id} revoked: ${reason}`,
        duration: 0,
        cost: 0,
      });
    } catch {
      // Best-effort audit logging — do not let logging failures break grant operations
    }
  }

  // ─── Core Methods ───────────────────────────────────────────

  function propose(
    request: Omit<
      CapabilityGrant,
      'id' | 'status' | 'approvedBy' | 'remainingExecutions' | 'createdAt' | 'expiresAt' | 'activatedAt'
    >
  ): CapabilityGrant {
    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + request.lifetime;
    const status: GrantStatus = 'proposed';

    const grant: CapabilityGrant = {
      id,
      environment: request.environment,
      capabilityType: request.capabilityType,
      targetSet: request.targetSet,
      reason: request.reason,
      proposedBy: request.proposedBy,
      approvedBy: null,
      lifetime: request.lifetime,
      maxExecutions: request.maxExecutions,
      remainingExecutions: request.maxExecutions,
      dryRunRequired: request.dryRunRequired,
      status,
      createdAt,
      expiresAt,
      activatedAt: null,
    };

    insertStmt.run(
      grant.id,
      grant.environment,
      grant.capabilityType,
      JSON.stringify(grant.targetSet),
      grant.reason,
      grant.proposedBy,
      grant.approvedBy,
      grant.lifetime,
      grant.maxExecutions,
      grant.remainingExecutions,
      grant.dryRunRequired ? 1 : 0,
      grant.status,
      grant.createdAt,
      grant.expiresAt,
      grant.activatedAt
    );

    return grant;
  }

  function approve(grantId: string, approverIdentity: string): CapabilityGrant {
    const row = getByIdStmt.get(grantId) as GrantRow | undefined;

    if (!row) {
      throw new Error(`Grant '${grantId}' not found`);
    }

    if (row.status !== 'proposed') {
      throw new Error(
        `Grant '${grantId}' cannot be approved: current status is '${row.status}', expected 'proposed'`
      );
    }

    // Enforce proposer/approver separation (Requirement 8.2)
    if (approverIdentity === row.proposed_by) {
      throw new Error(
        `Proposer-approver separation violated: identity '${approverIdentity}' cannot both propose and approve grant '${grantId}'`
      );
    }

    const activatedAt = Date.now();
    approveStmt.run(approverIdentity, activatedAt, grantId);

    return {
      ...rowToGrant(row),
      status: 'active',
      approvedBy: approverIdentity,
      activatedAt,
    };
  }

  function consume(grantId: string): { allowed: boolean; remaining: number } {
    // Use a transaction to ensure atomic check-and-decrement
    const result = db.transaction(() => {
      const row = getByIdStmt.get(grantId) as GrantRow | undefined;

      if (!row) {
        return { allowed: false, remaining: 0 };
      }

      // Check grant is active
      if (row.status !== 'active') {
        return { allowed: false, remaining: row.remaining_executions };
      }

      // Check expiration
      if (Date.now() >= row.expires_at) {
        // Auto-revoke expired grant
        updateStatusStmt.run('expired', grantId);
        logRevocation(rowToGrant(row), 'Lifetime expired during consume attempt');
        return { allowed: false, remaining: row.remaining_executions };
      }

      // Check remaining executions
      if (row.remaining_executions <= 0) {
        // Should already be 'exhausted' but enforce just in case
        updateStatusStmt.run('exhausted', grantId);
        return { allowed: false, remaining: 0 };
      }

      // Atomic decrement
      const decrementResult = decrementStmt.run(grantId);

      if (decrementResult.changes === 0) {
        // Race condition or already at 0 — deny
        return { allowed: false, remaining: 0 };
      }

      const newRemaining = row.remaining_executions - 1;

      // If remaining hits 0 after decrement, auto-revoke with 'exhausted' status
      if (newRemaining === 0) {
        updateStatusStmt.run('exhausted', grantId);
        logRevocation(
          { ...rowToGrant(row), remainingExecutions: newRemaining },
          'Execution count exhausted'
        );
      }

      return { allowed: true, remaining: newRemaining };
    })();

    return result;
  }

  function revoke(grantId: string, reason: string): void {
    const row = getByIdStmt.get(grantId) as GrantRow | undefined;

    if (!row) {
      throw new Error(`Grant '${grantId}' not found`);
    }

    if (row.status === 'revoked' || row.status === 'exhausted' || row.status === 'expired') {
      // Already in a terminal state — idempotent no-op
      return;
    }

    updateStatusStmt.run('revoked', grantId);
    logRevocation(rowToGrant(row), reason);
  }

  function getActiveGrants(environment: string): CapabilityGrant[] {
    const rows = getActiveByEnvStmt.all(environment) as GrantRow[];
    return rows.map(rowToGrant);
  }

  function enforceLifetimes(): void {
    const now = Date.now();
    const rows = getAllActiveStmt.all() as GrantRow[];

    for (const row of rows) {
      if (now >= row.expires_at) {
        updateStatusStmt.run('expired', row.id);
        logRevocation(rowToGrant(row), 'Lifetime expired (enforced by enforceLifetimes)');
      }
    }
  }

  return {
    propose,
    approve,
    consume,
    revoke,
    getActiveGrants,
    enforceLifetimes,
  };
}
