/**
 * Admin Audit — least-privilege lifecycle administration with masked audit
 * (FUT-PKG-04-SECURITY/T-003).
 *
 * Implements the operator/admin surface for entitlement, subscription, and
 * credential lifecycle (NN-LICENSE-010):
 *
 *   - **Authenticated least-privilege APIs (NN-LICENSE-010, NN-INV-005).** Every
 *     admin action declares a required privilege; an operator lacking it is
 *     denied with no effect. Privilege is checked before the action runs.
 *
 *   - **Audited transitions with masked references (NN-LICENSE-010,
 *     NN-INV-004).** issuance, rotation, revocation, replenishment, validation,
 *     and reconciliation each append an immutable audit record that references
 *     the affected credential/subscription by masked reference only — never a
 *     full secret. Audit records are routed through the shared redaction
 *     authority so no secret can leak into the audit trail.
 *
 * Audit records are append-only logical facts (D-19.2). The audit sink is
 * injected; production persists to the durable audit log, tests use an
 * in-memory sink.
 *
 * Design anchors: D-16.6 (credentials/redaction), D-19.2 (audit records).
 * Requirements: NN-LICENSE-010, NN-INV-004/005, NN-SEC-008.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import { redactValue } from '../shared/observable-redaction';

// ─── Admin actions and privileges (least privilege) ─────────────────────────

/** The admin lifecycle actions that MUST be audited (NN-LICENSE-010). */
export const ADMIN_ACTIONS = Object.freeze([
  'issuance',
  'rotation',
  'revocation',
  'replenishment',
  'validation',
  'reconciliation',
] as const);
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** The privileges an operator may hold (least-privilege). */
export const ADMIN_PRIVILEGES = Object.freeze([
  'entitlement:issue',
  'entitlement:rotate',
  'entitlement:revoke',
  'entitlement:replenish',
  'entitlement:validate',
  'entitlement:reconcile',
] as const);
export type AdminPrivilege = (typeof ADMIN_PRIVILEGES)[number];

/** The privilege required by each action. */
const ACTION_PRIVILEGE: Readonly<Record<AdminAction, AdminPrivilege>> = Object.freeze({
  issuance: 'entitlement:issue',
  rotation: 'entitlement:rotate',
  revocation: 'entitlement:revoke',
  replenishment: 'entitlement:replenish',
  validation: 'entitlement:validate',
  reconciliation: 'entitlement:reconcile',
});

/** The required privilege for an action. */
export function requiredPrivilege(action: AdminAction): AdminPrivilege {
  return ACTION_PRIVILEGE[action];
}

// ─── Audit record (masked; append-only) ─────────────────────────────────────

/** An append-only audit record (D-19.2). No full secrets (NN-INV-004). */
export interface AdminAuditRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly auditId: string;
  readonly action: AdminAction;
  /** The operator principal (opaque id). */
  readonly operator: string;
  /** The affected credential/subscription, by MASKED reference only. */
  readonly targetMaskedRef: string;
  readonly outcome: 'allowed' | 'denied';
  readonly reason: string;
  readonly correlationId: string;
  readonly recordedAt: string;
}

/** The append-only audit sink. */
export interface AdminAuditSink {
  append(record: AdminAuditRecord): void;
}

/** In-memory append-only audit sink for tests. */
export class InMemoryAdminAuditSink implements AdminAuditSink {
  private readonly records: AdminAuditRecord[] = [];
  append(record: AdminAuditRecord): void {
    this.records.push(record);
  }
  list(): readonly AdminAuditRecord[] {
    return [...this.records];
  }
}

// ─── Typed errors / results ──────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-entitlement';

function adminError(code: ErrorCode, message: string, correlationId?: string): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: 'admin-lifecycle',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    redaction: 'internal',
  };
}

export interface AdminRequest {
  readonly action: AdminAction;
  readonly operator: string;
  readonly operatorPrivileges: readonly AdminPrivilege[];
  /** The target's MASKED reference (never a raw secret). */
  readonly targetMaskedRef: string;
  readonly correlationId?: string;
}

export type AdminResult =
  | { readonly ok: true; readonly audit: AdminAuditRecord }
  | { readonly ok: false; readonly error: ErrorEnvelope; readonly audit: AdminAuditRecord };

// ─── The admin service ──────────────────────────────────────────────────────

export interface AdminAuditServiceOptions {
  readonly sink: AdminAuditSink;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class AdminAuditService {
  private readonly sink: AdminAuditSink;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private counter = 0;

  constructor(options: AdminAuditServiceOptions) {
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `${Date.now()}-${this.counter++}`);
  }

  /**
   * Authorize and audit an admin lifecycle action (NN-LICENSE-010). The
   * operator must hold the required privilege (least privilege, NN-INV-005);
   * every attempt — allowed or denied — appends a masked, redaction-scrubbed
   * audit record (NN-INV-004). Returns the audit record with the outcome.
   */
  perform(request: AdminRequest): AdminResult {
    const corr = request.correlationId ?? 'corr-unset';
    const needed = requiredPrivilege(request.action);
    const authorized = request.operatorPrivileges.includes(needed);

    const baseRecord: AdminAuditRecord = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      auditId: `audit-${this.createId()}`,
      action: request.action,
      operator: request.operator,
      // Route the masked ref through redaction for defense in depth — a caller
      // that accidentally passes a raw secret is scrubbed before persistence.
      targetMaskedRef: redactValue(request.targetMaskedRef),
      outcome: authorized ? 'allowed' : 'denied',
      reason: authorized
        ? `operator authorized for ${request.action}`
        : `operator lacks required privilege ${needed}`,
      correlationId: isOpaqueId(corr) ? corr : 'corr-unset',
      recordedAt: this.now().toISOString(),
    };

    // Redact the whole record before it is persisted (NN-INV-004).
    const record = redactValue(baseRecord);
    this.sink.append(record);

    if (!authorized) {
      return { ok: false, error: adminError('FORBIDDEN', baseRecord.reason, corr), audit: record };
    }
    return { ok: true, audit: record };
  }
}
