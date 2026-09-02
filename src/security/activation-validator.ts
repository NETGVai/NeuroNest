/**
 * Activation Validator — first activation and signed launch gating
 * (FUT-PKG-04-SECURITY/T-003).
 *
 * Implements the first-activation flow (NN-LICENSE-002) and the launch gate
 * that decides whether main functionality is exposed (NN-LICENSE-003):
 *
 *   - **First activation (NN-LICENSE-002).** When no valid local activation
 *     exists, the app SHALL present an accessible blocking activation flow,
 *     validate the invitation/activation code with the service, bind authorized
 *     hardware, persist only protected typed records, and expose no main
 *     functionality until activation succeeds. This module produces the typed
 *     gate decisions; it stores the activation code and the signed entitlement
 *     only through the {@link CredentialService} (protected, typed, masked) —
 *     never in unsigned localStorage (NN-SEC-009, NN-LICENSE-006).
 *
 *   - **Distinct credential classes (NN-LICENSE-001).** The desktop activation
 *     code is stored under the `desktop-activation-code` credential type and
 *     the signed entitlement under `entitlement`. No field is reused across
 *     classes; the two live in separate store slots.
 *
 *   - **Hardware binding.** Activation binds authorized hardware; the resulting
 *     entitlement embeds a hardware-binding fingerprint that the
 *     {@link EntitlementAuthority} checks at every launch (NN-LICENSE-003/009).
 *
 * The service call itself is injected as an {@link ActivationServiceClient} so
 * the flow is deterministic and testable without network. A service failure
 * during first activation fails closed — no main functionality is exposed
 * (NN-INV-001) — but does not corrupt any existing local shell state.
 *
 * Design anchors: D-04 (entitlement/credential authorities), D-16 (security).
 * Requirements: NN-LICENSE-001/002/003/006, NN-SEC-008/009, NN-INV-001.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import type { CredentialService } from '../shared/credential-service';
import {
  EntitlementAuthority,
  SignedEntitlementSchema,
  type ConnectivityMode,
  type SignedEntitlement,
  type ValidationResult,
} from './entitlement-authority';

// ─── Activation code (accessible blocking flow input) ───────────────────────

/** A raw activation/invitation code as entered by the user. */
export const ActivationCodeSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9._-]+$/, 'activation code has an invalid character');

// ─── Service client (injected) ──────────────────────────────────────────────

/** The response from the activation service for a valid code. */
export interface ActivationServiceResult {
  readonly ok: boolean;
  /** The freshly-issued signed entitlement, present iff `ok`. */
  readonly signed?: SignedEntitlement;
  /** A safe, secret-free failure reason for `!ok`. */
  readonly reason?: string;
}

/**
 * The authenticated activation service. Production wires an HTTPS client to
 * `auth.neuronest.cc`; tests inject a deterministic fake. The client validates
 * the code and binds the supplied hardware fingerprint server-side.
 */
export interface ActivationServiceClient {
  activate(input: {
    readonly code: string;
    readonly hardwareBinding: string;
    readonly expectedAudience: string;
  }): Promise<ActivationServiceResult>;
}

// ─── Typed errors / results ──────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-entitlement';

function activationError(
  code: ErrorCode,
  message: string,
  options: { operation?: string; correlationId?: string } = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: options.operation ?? 'activation',
    correlationId: isOpaqueId(options.correlationId) ? options.correlationId : 'corr-unset',
    retryable: code === 'UNAVAILABLE',
    redaction: 'internal',
  };
}

/**
 * The gate that decides whether main functionality is exposed
 * (NN-LICENSE-002/003).
 *   - `activation-required` — no valid local activation; show blocking flow.
 *   - `active` — a valid signed entitlement gates paid features (see `result`).
 */
export type ActivationGate =
  | { readonly kind: 'activation-required'; readonly reason: string }
  | { readonly kind: 'active'; readonly result: ValidationResult };

export type ActivationResult =
  | { readonly ok: true; readonly gate: ActivationGate }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── Credential-type constants (distinct classes) ───────────────────────────

const ACTIVATION_CODE_TYPE = 'desktop-activation-code' as const;
const ENTITLEMENT_TYPE = 'entitlement' as const;

// ─── The validator ───────────────────────────────────────────────────────────

export interface ActivationValidatorOptions {
  readonly credentials: CredentialService;
  readonly entitlementAuthority: EntitlementAuthority;
  readonly service: ActivationServiceClient;
  readonly issuer: string;
  readonly audience: string;
  readonly hardwareBinding: string;
  readonly policyRevision: number;
  /** Where the signed entitlement was cached (credentialRefId), if activated. */
  readonly entitlementRefId?: string;
}

export class ActivationValidator {
  private readonly credentials: CredentialService;
  private readonly entitlementAuthority: EntitlementAuthority;
  private readonly service: ActivationServiceClient;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly hardwareBinding: string;
  private readonly policyRevision: number;

  constructor(private readonly options: ActivationValidatorOptions) {
    this.credentials = options.credentials;
    this.entitlementAuthority = options.entitlementAuthority;
    this.service = options.service;
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.hardwareBinding = options.hardwareBinding;
    this.policyRevision = options.policyRevision;
  }

  /**
   * Perform first activation (NN-LICENSE-002). Validates the code shape,
   * validates it with the service (binding hardware), and — only on success —
   * persists the activation code and the signed entitlement as distinct
   * protected typed credentials. Returns a typed error and persists nothing on
   * any failure (fail closed).
   */
  async activate(
    rawCode: string,
    options: { correlationId?: string } = {},
  ): Promise<ActivationResult> {
    const op = 'first-activation';
    const corr = options.correlationId;

    const codeParsed = ActivationCodeSchema.safeParse(rawCode);
    if (!codeParsed.success) {
      return { ok: false, error: activationError('VALIDATION', 'activation code is malformed', { operation: op, correlationId: corr }) };
    }
    const code = codeParsed.data;

    let serviceResult: ActivationServiceResult;
    try {
      serviceResult = await this.service.activate({
        code,
        hardwareBinding: this.hardwareBinding,
        expectedAudience: this.audience,
      });
    } catch {
      return { ok: false, error: activationError('UNAVAILABLE', 'activation service was unreachable', { operation: op, correlationId: corr }) };
    }

    if (!serviceResult.ok || serviceResult.signed === undefined) {
      return { ok: false, error: activationError('UNAUTHORIZED', serviceResult.reason ?? 'activation code was rejected', { operation: op, correlationId: corr }) };
    }

    const signed = SignedEntitlementSchema.safeParse(serviceResult.signed);
    if (!signed.success) {
      return { ok: false, error: activationError('VALIDATION', 'service returned a malformed entitlement', { operation: op, correlationId: corr }) };
    }

    // Confirm the issued record actually validates online before we commit it.
    const validation = this.entitlementAuthority.validateLaunch({
      signed: signed.data,
      expectedIssuer: this.issuer,
      expectedAudience: this.audience,
      hardwareBinding: this.hardwareBinding,
      currentPolicyRevision: this.policyRevision,
      connectivity: 'online',
      nowMs: Date.now(),
      correlationId: corr,
    });
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    // Persist distinct protected typed records (NN-LICENSE-001, NN-SEC-008).
    const codeStore = this.credentials.store({
      credentialType: ACTIVATION_CODE_TYPE,
      issuer: this.issuer,
      audience: this.audience,
      subject: signed.data.body.accountId,
      scopes: ['activation'],
      value: code,
    });
    if (!codeStore.ok) return { ok: false, error: codeStore.error };

    const entStore = this.credentials.store({
      credentialType: ENTITLEMENT_TYPE,
      issuer: this.issuer,
      audience: this.audience,
      subject: signed.data.body.accountId,
      scopes: ['entitlement'],
      // The signed entitlement is itself the protected value (it carries the
      // signature). It is a distinct credential class from the activation code.
      value: JSON.stringify(signed.data),
    });
    if (!entStore.ok) {
      // Roll back the code credential so a half-activation leaves no record.
      this.credentials.revoke(codeStore.value.credentialRefId, { correlationId: corr });
      return { ok: false, error: entStore.error };
    }

    return {
      ok: true,
      gate: { kind: 'active', result: validation },
    };
  }

  /**
   * The launch gate (NN-LICENSE-003). Given the cached signed entitlement (if
   * any) plus connectivity, decide whether the blocking activation flow must be
   * shown or gated features may be enabled. `signed === undefined` means no
   * valid local activation → activation is required.
   */
  gateAtLaunch(input: {
    readonly signed?: SignedEntitlement;
    readonly connectivity: ConnectivityMode;
    readonly serverRevocationEpoch?: number;
    readonly lastOnlineValidationAtMs?: number;
    readonly nowMs: number;
    readonly correlationId?: string;
  }): ActivationGate {
    if (input.signed === undefined) {
      return { kind: 'activation-required', reason: 'no valid local activation exists' };
    }
    const result = this.entitlementAuthority.validateLaunch({
      signed: input.signed,
      expectedIssuer: this.issuer,
      expectedAudience: this.audience,
      hardwareBinding: this.hardwareBinding,
      serverRevocationEpoch: input.serverRevocationEpoch,
      currentPolicyRevision: this.policyRevision,
      connectivity: input.connectivity,
      lastOnlineValidationAtMs: input.lastOnlineValidationAtMs,
      nowMs: input.nowMs,
      correlationId: input.correlationId,
    });
    return { kind: 'active', result };
  }
}
