/**
 * Authority Registry — Singleton registry that tracks registered NeuroNest authorities
 * and their extension ports. Prevents parallel replacement authorities and routes
 * all extension operations through their owning authority.
 *
 * Requirements: 1.1–1.6, 25.4, 35.12, 39.13, 43.3
 */

import { randomUUID } from 'node:crypto';
import type {
  AuthorityKind,
  ExtensionPortId,
  ExtensionPortRegistration,
  AuthorityDenial,
  DenialCode,
} from './types.js';
import { AUTHORITY_LABELS } from './types.js';

// ─── Authority Registration Record ─────────────────────────────

interface AuthorityRecord {
  kind: AuthorityKind;
  instance: unknown;
  registeredAt: number;
  ports: Map<string, ExtensionPortRegistration>;
}

// ─── Bypass Attempt Record ──────────────────────────────────────

export interface BypassAttemptRecord {
  correlationId: string;
  authority: AuthorityKind;
  attemptedOperation: string;
  code: DenialCode;
  timestamp: number;
}

// ─── Authority Registry ─────────────────────────────────────────

/**
 * Central registry of NeuroNest authorities and their extension ports.
 *
 * Invariants:
 * - Each AuthorityKind has at most one registered authority instance.
 * - A second registration for the same kind is rejected (parallel authority prevention).
 * - Extension ports are scoped to their owning authority.
 * - Operations targeting an authority that isn't registered are denied with redacted diagnostics.
 */
export class AuthorityRegistry {
  private authorities: Map<AuthorityKind, AuthorityRecord> = new Map();
  private bypassAttempts: BypassAttemptRecord[] = [];

  // ─── Authority Registration ─────────────────────────────────

  /**
   * Register an authority instance. Only one instance per AuthorityKind is allowed.
   * A second registration attempt is rejected as a parallel replacement authority.
   *
   * @throws Never — returns a denial result on failure.
   */
  registerAuthority(
    kind: AuthorityKind,
    instance: unknown,
  ): { ok: true } | { ok: false; denial: AuthorityDenial } {
    if (this.authorities.has(kind)) {
      const denial = this.createDenial(
        kind,
        'PARALLEL_AUTHORITY_DETECTED',
        `Authority '${AUTHORITY_LABELS[kind]}' is already registered. Parallel replacement authorities are not permitted.`,
      );
      this.recordBypassAttempt(kind, 'registerAuthority', 'PARALLEL_AUTHORITY_DETECTED');
      return { ok: false, denial };
    }

    this.authorities.set(kind, {
      kind,
      instance,
      registeredAt: Date.now(),
      ports: new Map(),
    });

    return { ok: true };
  }

  /**
   * Unregister an authority. Used only during teardown/testing.
   */
  unregisterAuthority(kind: AuthorityKind): boolean {
    return this.authorities.delete(kind);
  }

  /**
   * Retrieve the registered authority instance.
   */
  getAuthority<T>(kind: AuthorityKind): T | undefined {
    const record = this.authorities.get(kind);
    return record?.instance as T | undefined;
  }

  /**
   * Check whether an authority is currently registered.
   */
  hasAuthority(kind: AuthorityKind): boolean {
    return this.authorities.has(kind);
  }

  /**
   * List all registered authorities and their port counts.
   */
  listAuthorities(): Array<{ kind: AuthorityKind; label: string; portCount: number; registeredAt: number }> {
    const result: Array<{ kind: AuthorityKind; label: string; portCount: number; registeredAt: number }> = [];
    for (const [kind, record] of this.authorities) {
      result.push({
        kind,
        label: AUTHORITY_LABELS[kind],
        portCount: record.ports.size,
        registeredAt: record.registeredAt,
      });
    }
    return result;
  }

  // ─── Extension Port Registration ───────────────────────────

  /**
   * Register an extension port under its owning authority.
   * The authority must already be registered.
   */
  registerPort(
    portId: ExtensionPortId,
    description: string,
  ): { ok: true; registration: ExtensionPortRegistration } | { ok: false; denial: AuthorityDenial } {
    const record = this.authorities.get(portId.authority);
    if (!record) {
      const denial = this.createDenial(
        portId.authority,
        'PORT_NOT_REGISTERED',
        `Cannot register port '${portId.name}': owning authority '${AUTHORITY_LABELS[portId.authority]}' is not registered.`,
      );
      return { ok: false, denial };
    }

    const portKey = `${portId.name}@${portId.version}`;
    const registration: ExtensionPortRegistration = {
      id: portId,
      registeredAt: Date.now(),
      active: true,
      description,
    };

    record.ports.set(portKey, registration);
    return { ok: true, registration };
  }

  /**
   * Deactivate an extension port.
   */
  deactivatePort(portId: ExtensionPortId): boolean {
    const record = this.authorities.get(portId.authority);
    if (!record) return false;

    const portKey = `${portId.name}@${portId.version}`;
    const reg = record.ports.get(portKey);
    if (!reg) return false;

    reg.active = false;
    return true;
  }

  /**
   * List all ports registered under an authority.
   */
  listPorts(authority: AuthorityKind): ExtensionPortRegistration[] {
    const record = this.authorities.get(authority);
    if (!record) return [];
    return Array.from(record.ports.values());
  }

  // ─── Bypass Detection and Denial ───────────────────────────

  /**
   * Validate that an operation targets the correct authority owner.
   * Returns a denial if the operation would bypass the registered authority.
   */
  validateRouting(
    claimedAuthority: AuthorityKind,
    portName: string,
  ): { ok: true } | { ok: false; denial: AuthorityDenial } {
    // Authority must be registered
    if (!this.authorities.has(claimedAuthority)) {
      const denial = this.createDenial(
        claimedAuthority,
        'AUTHORITY_BYPASS_REJECTED',
        `Operation rejected: authority '${AUTHORITY_LABELS[claimedAuthority]}' is not registered. All operations must route through a registered authority.`,
      );
      this.recordBypassAttempt(claimedAuthority, portName, 'AUTHORITY_BYPASS_REJECTED');
      return { ok: false, denial };
    }

    // Port must exist and be active
    const record = this.authorities.get(claimedAuthority)!;
    const matchingPort = Array.from(record.ports.values()).find(
      (p) => p.id.name === portName,
    );

    if (!matchingPort) {
      const denial = this.createDenial(
        claimedAuthority,
        'PORT_NOT_REGISTERED',
        `Operation rejected: port '${portName}' is not registered under authority '${AUTHORITY_LABELS[claimedAuthority]}'.`,
      );
      return { ok: false, denial };
    }

    if (!matchingPort.active) {
      const denial = this.createDenial(
        claimedAuthority,
        'PORT_INACTIVE',
        `Operation rejected: port '${portName}' is inactive.`,
      );
      return { ok: false, denial };
    }

    return { ok: true };
  }

  /**
   * Reject an operation that attempts to bypass an existing authority.
   * Records the attempt and returns a redacted diagnostic.
   */
  rejectBypass(
    targetAuthority: AuthorityKind,
    attemptedOperation: string,
  ): AuthorityDenial {
    const denial = this.createDenial(
      targetAuthority,
      'AUTHORITY_BYPASS_REJECTED',
      `Operation '${attemptedOperation}' rejected: must route through the registered '${AUTHORITY_LABELS[targetAuthority]}' authority. Direct access is not permitted.`,
    );
    this.recordBypassAttempt(targetAuthority, attemptedOperation, 'AUTHORITY_BYPASS_REJECTED');
    return denial;
  }

  /**
   * Get all recorded bypass attempts (for audit / diagnostics).
   */
  getBypassAttempts(): readonly BypassAttemptRecord[] {
    return this.bypassAttempts;
  }

  /**
   * Clear bypass attempt history (for testing).
   */
  clearBypassAttempts(): void {
    this.bypassAttempts = [];
  }

  // ─── Internal Helpers ──────────────────────────────────────

  private createDenial(
    authority: AuthorityKind,
    code: DenialCode,
    message: string,
  ): AuthorityDenial {
    return {
      authority,
      code,
      message,
      timestamp: Date.now(),
      correlationId: randomUUID(),
    };
  }

  private recordBypassAttempt(
    authority: AuthorityKind,
    attemptedOperation: string,
    code: DenialCode,
  ): void {
    this.bypassAttempts.push({
      correlationId: randomUUID(),
      authority,
      attemptedOperation,
      code,
      timestamp: Date.now(),
    });
  }
}
