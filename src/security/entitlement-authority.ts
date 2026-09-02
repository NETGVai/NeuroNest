/**
 * Entitlement Authority — signed launch validation and bounded offline grace
 * (FUT-PKG-04-SECURITY/T-003).
 *
 * The Entitlement Authority is the sole writable owner of the entitlement /
 * plan-state data class (D-04 "Entitlements/subscriptions → Entitlement
 * Service/business tables; signed cache and plan UI"). This module implements
 * the launch-time validation and offline-grace policy that gate every paid /
 * authenticated capability:
 *
 *   - **Signed entitlement (NN-LICENSE-001/003).** An entitlement is a distinct
 *     typed record — never reused as another credential class — carrying a
 *     detached signature over its canonical body. Validation checks the
 *     signature, issuer, audience, status, plan, expiry, revocation epoch,
 *     hardware/account binding, and policy revision *before* enabling gated
 *     features. A signature/issuer/audience/binding/epoch failure is a hard
 *     `deny` regardless of connectivity (CD-005: "invalid/revoked/expired fails
 *     closed").
 *
 *   - **Never trust unsigned localStorage (NN-LICENSE-006, NN-SEC-009).** A
 *     record whose signature does not verify against the trusted verification
 *     key has *no* paid authority. There is no unsigned/optimistic path; the
 *     renderer profile is a projection only.
 *
 *   - **Bounded offline grace with clock-fault tolerance
 *     (NN-LICENSE-004/005, CD-005; V-LICENSE-001/entitlement-clock-fault).**
 *     When the service is unreachable, a signed, unrevoked, unexpired cached
 *     entitlement MAY be used for a bounded grace window embedded in and
 *     verifiable against the entitlement. The window is anchored to a
 *     monotonic last-validated timestamp so a wall-clock *rollback* cannot
 *     extend grace, and a forward *skew* past the embedded grace deadline
 *     blocks. When grace expires, paid capabilities block; community downgrade
 *     is permitted only when the entitlement's product policy explicitly allows
 *     it, and is always visible.
 *
 *   - **Identity rebind (NN-LICENSE-009).** When an authenticated account
 *     identity differs from the activation identity, the authority refuses to
 *     silently transfer entitlement and instead emits a typed rebind-required
 *     result that an authorized rebind/reissue flow must satisfy.
 *
 * Ambiguity or a security failure *denies the affected paid/auth work* but must
 * NOT block approved local-shell behavior (local-first): {@link gateState}
 * returns `community` (local shell allowed) rather than a global lockout when
 * the only failure is paid-tier validation.
 *
 * Design anchors: D-04 (entitlement authority), D-06/D-07 (typed contracts /
 * errors), D-16 (security), D-18 (fail-closed / clock handling).
 * Requirements: NN-LICENSE-001/003/004/005/006/009, NN-SEC-009/010,
 * NN-INV-001, NN-UI-014, CD-005.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  RevisionSchema,
  TimestampSchema,
  canonicalSerialize,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';

// ─── Plans and status (NN-LICENSE-003 plan state) ───────────────────────────

/** Entitlement plan tiers. `community` is the free local tier (no paid auth). */
export const ENTITLEMENT_PLANS = Object.freeze([
  'community',
  'pro',
  'team',
  'enterprise',
] as const);
export type EntitlementPlan = (typeof ENTITLEMENT_PLANS)[number];
export const EntitlementPlanSchema = z.enum(ENTITLEMENT_PLANS);

/** Entitlement lifecycle status. */
export const ENTITLEMENT_STATUSES = Object.freeze([
  'active',
  'revoked',
  'expired',
  'suspended',
] as const);
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];
export const EntitlementStatusSchema = z.enum(ENTITLEMENT_STATUSES);

// ─── SignedEntitlement@ (typed, distinct class; NN-LICENSE-001) ─────────────

/**
 * The canonical entitlement *body* — everything that is signed. It is a
 * distinct schema type; no field is reused as another credential (NN-LICENSE-001).
 * `graceWindowMs` is embedded in and verifiable against the signature so grace
 * cannot be widened without invalidating the record (NN-LICENSE-004).
 */
export const EntitlementBodySchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  entitlementId: z.string().min(1).max(256),
  issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(256),
  /** The account subject this entitlement was issued to (NN-LICENSE-009). */
  accountId: z.string().min(1).max(256),
  /** The activation identity / hardware binding fingerprint (NN-LICENSE-003). */
  hardwareBinding: z.string().min(1).max(256),
  plan: EntitlementPlanSchema,
  status: EntitlementStatusSchema,
  /** Absolute expiry of the entitlement itself (UTC RFC3339). */
  expiresAt: TimestampSchema,
  /** Revocation epoch; a newer server epoch invalidates a cached record. */
  revocationEpoch: RevisionSchema,
  /** Versioned product-policy revision this record was minted under. */
  policyRevision: RevisionSchema,
  /** Bounded offline grace window in ms (NN-LICENSE-004). Non-negative. */
  graceWindowMs: z.number().int().nonnegative().finite(),
  /** Whether product policy allows silent downgrade to community on expiry. */
  allowCommunityDowngrade: z.boolean(),
  issuedAt: TimestampSchema,
});
export type EntitlementBody = z.infer<typeof EntitlementBodySchema>;

/**
 * A signed entitlement: the body plus a detached signature over its canonical
 * serialization. This is what is cached locally (the "signed cache" of D-04).
 * A renderer only ever sees a projection of {@link EntitlementProjection}.
 */
export const SignedEntitlementSchema = z.strictObject({
  body: EntitlementBodySchema,
  /** Lowercase hex HMAC-SHA256 (detached) over `canonicalSerialize(body)`. */
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  /** Key id selecting the verification key (supports rotation). */
  keyId: z.string().min(1).max(128),
});
export type SignedEntitlement = z.infer<typeof SignedEntitlementSchema>;

/**
 * The renderer-safe projection (NN-LICENSE-006). Contains no signature, no
 * bearer secret — only display/plan facts. Renderer profile data is a
 * projection and contains no bearer secret.
 */
export interface EntitlementProjection {
  readonly plan: EntitlementPlan;
  readonly status: EntitlementStatus;
  readonly expiresAt: string;
  readonly offline: boolean;
  readonly graceExpiresAt?: string;
}

// ─── Signing primitive (injectable verification keys) ───────────────────────

/**
 * The trusted verification keyring. Keys are HMAC secrets held by the authority
 * (in production sourced from OS secure storage via the CredentialService, not
 * here). The signing helper is exported so tests and the issuing service can
 * mint records; the *raw* key never leaves this boundary.
 */
export interface EntitlementKeyring {
  /** Resolve the HMAC secret for a key id, or `undefined` if unknown. */
  getKey(keyId: string): string | undefined;
}

/** A simple in-memory keyring for tests / headless issuance. */
export class InMemoryEntitlementKeyring implements EntitlementKeyring {
  private readonly keys = new Map<string, string>();
  constructor(entries: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(entries)) this.keys.set(k, v);
  }
  getKey(keyId: string): string | undefined {
    return this.keys.get(keyId);
  }
}

/** Compute the detached HMAC-SHA256 signature over an entitlement body. */
export function signEntitlementBody(body: EntitlementBody, key: string): string {
  return createHmac('sha256', key).update(canonicalSerialize(body), 'utf8').digest('hex');
}

/**
 * Mint a {@link SignedEntitlement} for `body` using `keyId` from `keyring`.
 * Throws if the key is unknown (issuance is a trusted path). Exported so the
 * issuing service and tests produce real signed records rather than fakes.
 */
export function mintSignedEntitlement(
  body: EntitlementBody,
  keyId: string,
  keyring: EntitlementKeyring,
): SignedEntitlement {
  const key = keyring.getKey(keyId);
  if (key === undefined) throw new Error(`unknown entitlement key id: ${keyId}`);
  return { body, signature: signEntitlementBody(body, key), keyId };
}

// ─── Typed errors ───────────────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-entitlement';

function entitlementError(
  code: ErrorCode,
  message: string,
  options: { operation?: string; correlationId?: string } = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: options.operation ?? 'entitlement',
    correlationId: isOpaqueId(options.correlationId) ? options.correlationId : 'corr-unset',
    retryable: code === 'UNAVAILABLE',
    redaction: 'internal',
  };
}

// ─── Validation inputs / results ────────────────────────────────────────────

/**
 * The connectivity mode of a validation attempt.
 *   - `online`  — the service was reachable and its response is authoritative.
 *   - `offline` — the service was unreachable; the bounded-grace policy applies.
 */
export type ConnectivityMode = 'online' | 'offline';

/** The launch validation request. */
export interface LaunchValidationInput {
  readonly signed: SignedEntitlement;
  /** Expected issuer for this build. */
  readonly expectedIssuer: string;
  /** Expected audience for this build. */
  readonly expectedAudience: string;
  /** The hardware binding fingerprint of the running install. */
  readonly hardwareBinding: string;
  /** The current server revocation epoch (from an online check), if known. */
  readonly serverRevocationEpoch?: number;
  /** The current product policy revision this build enforces. */
  readonly currentPolicyRevision: number;
  readonly connectivity: ConnectivityMode;
  /**
   * The monotonic timestamp (ms) of the last *successful online* validation.
   * Grace is measured from here so a wall-clock rollback cannot extend it
   * (V-LICENSE-001/entitlement-clock-fault). Absent means "never validated
   * online" → no grace is available offline.
   */
  readonly lastOnlineValidationAtMs?: number;
  /** Injected clock (ms). Tests advance/rollback this to exercise clock faults. */
  readonly nowMs: number;
  readonly correlationId?: string;
}

/**
 * The effective gate state (local-first). Paid/auth failures degrade to
 * `community` (local shell allowed), never a global lockout.
 */
export type GateState = 'full' | 'grace' | 'community' | 'blocked';

/** The result of launch validation. */
export type ValidationResult =
  | {
      readonly ok: true;
      /** `full` (online-valid) or `grace` (offline within bounded window). */
      readonly gate: Extract<GateState, 'full' | 'grace'>;
      readonly plan: EntitlementPlan;
      readonly projection: EntitlementProjection;
      /** When `grace`, the absolute grace deadline (UTC RFC3339). */
      readonly graceExpiresAt?: string;
    }
  | {
      readonly ok: false;
      /**
       * `community` — paid tier denied but local shell remains allowed
       * (downgrade permitted by policy). `blocked` — the record is unusable and
       * the affected paid/auth work is denied; local shell still runs.
       */
      readonly gate: Extract<GateState, 'community' | 'blocked'>;
      readonly error: ErrorEnvelope;
      /** True when an authorized rebind/reissue flow is required (NN-LICENSE-009). */
      readonly rebindRequired?: boolean;
      readonly projection?: EntitlementProjection;
    };

// ─── The authority ──────────────────────────────────────────────────────────

export interface EntitlementAuthorityOptions {
  readonly keyring: EntitlementKeyring;
}

/**
 * The Entitlement Authority. `validateLaunch` is a pure function of the input
 * plus the trusted keyring — it performs no I/O — so the clock-fault and
 * offline-grace behavior is fully deterministic and testable.
 */
export class EntitlementAuthority {
  private readonly keyring: EntitlementKeyring;

  constructor(options: EntitlementAuthorityOptions) {
    this.keyring = options.keyring;
  }

  /**
   * Validate a signed entitlement at launch (NN-LICENSE-003). Order:
   *   1. schema shape,
   *   2. signature (never trust unsigned; hard block),
   *   3. issuer / audience / hardware binding,
   *   4. status (revoked/expired/suspended → hard block, any connectivity),
   *   5. revocation epoch (a newer server epoch → hard block),
   *   6. absolute expiry,
   *   7. connectivity: online → `full`; offline → bounded-grace policy with
   *      clock-fault tolerance.
   *
   * A hard security failure (2–5) always fails closed (CD-005). Where product
   * policy allows community downgrade the gate is `community` (local shell
   * still allowed); otherwise `blocked` for the paid path only.
   */
  validateLaunch(input: LaunchValidationInput): ValidationResult {
    const op = 'validate-launch';
    const corr = input.correlationId;

    const parsed = SignedEntitlementSchema.safeParse(input.signed);
    if (!parsed.success) {
      return this.fail('VALIDATION', 'entitlement record failed schema validation', op, corr, false);
    }
    const { body, signature, keyId } = parsed.data;

    // 2. Signature — never trust an unsigned/forged record (NN-LICENSE-006).
    if (!this.verifySignature(body, signature, keyId)) {
      return this.fail('UNAUTHORIZED', 'entitlement signature did not verify', op, corr, false);
    }

    // 3. Issuer / audience / binding.
    if (body.issuer !== input.expectedIssuer) {
      return this.fail('FORBIDDEN', 'entitlement issuer mismatch', op, corr, false);
    }
    if (body.audience !== input.expectedAudience) {
      return this.fail('FORBIDDEN', 'entitlement audience mismatch', op, corr, false);
    }
    if (body.hardwareBinding !== input.hardwareBinding) {
      // A binding mismatch means a different identity/hardware — require an
      // authorized rebind rather than silently transferring (NN-LICENSE-009).
      return this.fail('FORBIDDEN', 'hardware/account binding mismatch; authorized rebind required', op, corr, true);
    }

    // 4. Status — revoked/expired/suspended fail closed regardless of network.
    if (body.status !== 'active') {
      return this.fail('FORBIDDEN', `entitlement status is ${body.status}`, op, corr, false, this.project(body, false));
    }

    // 5. Revocation epoch: a newer server epoch invalidates a cached record.
    if (
      input.serverRevocationEpoch !== undefined &&
      input.serverRevocationEpoch > body.revocationEpoch
    ) {
      return this.fail('FORBIDDEN', 'entitlement revoked by a newer revocation epoch', op, corr, false);
    }

    // 6. Absolute expiry (independent of grace).
    const expiresAtMs = Date.parse(body.expiresAt);
    if (Number.isFinite(expiresAtMs) && input.nowMs >= expiresAtMs) {
      return this.expiredResult(body, op, corr);
    }

    // 7. Connectivity.
    if (input.connectivity === 'online') {
      return {
        ok: true,
        gate: 'full',
        plan: body.plan,
        projection: this.project(body, false),
      };
    }

    // Offline: bounded grace with clock-fault tolerance.
    return this.evaluateOfflineGrace(body, input, op, corr);
  }

  /**
   * Bounded offline grace (NN-LICENSE-004/005). Grace is anchored to the
   * monotonic `lastOnlineValidationAtMs`; a rollback of the wall clock cannot
   * extend it, and forward skew past the embedded window blocks. When grace
   * expires, community downgrade is used only when policy allows it.
   */
  private evaluateOfflineGrace(
    body: EntitlementBody,
    input: LaunchValidationInput,
    op: string,
    corr: string | undefined,
  ): ValidationResult {
    // No prior successful online validation → no grace basis (fail closed).
    if (input.lastOnlineValidationAtMs === undefined) {
      return this.fail(
        'UNAVAILABLE',
        'service unreachable and no prior online validation to anchor offline grace',
        op,
        corr,
        false,
        this.project(body, true),
      );
    }

    const anchor = input.lastOnlineValidationAtMs;
    const graceDeadlineMs = anchor + body.graceWindowMs;

    // Clock rollback: now earlier than the anchor is impossible under a
    // monotonic reading — treat it as a fault and refuse to extend grace.
    if (input.nowMs < anchor) {
      return this.fail(
        'FORBIDDEN',
        'clock rollback detected relative to last online validation; refusing offline grace',
        op,
        corr,
        false,
        this.project(body, true),
      );
    }

    if (input.nowMs <= graceDeadlineMs) {
      const graceExpiresAt = new Date(graceDeadlineMs).toISOString();
      return {
        ok: true,
        gate: 'grace',
        plan: body.plan,
        graceExpiresAt,
        projection: { ...this.project(body, true), graceExpiresAt },
      };
    }

    // Grace expired.
    return this.expiredResult(body, op, corr, true);
  }

  /** Produce an expiry/grace-expiry result honoring the downgrade policy. */
  private expiredResult(
    body: EntitlementBody,
    op: string,
    corr: string | undefined,
    offline = false,
  ): ValidationResult {
    const projection = this.project(body, offline);
    if (body.allowCommunityDowngrade) {
      return {
        ok: false,
        gate: 'community',
        error: entitlementError('UNAVAILABLE', 'entitlement expired; downgraded to community per product policy', { operation: op, correlationId: corr }),
        projection,
      };
    }
    return {
      ok: false,
      gate: 'blocked',
      error: entitlementError('FORBIDDEN', 'entitlement expired and community downgrade is not permitted', { operation: op, correlationId: corr }),
      projection,
    };
  }

  /**
   * Resolve the effective gate for a validation result (local-first summary).
   * Local shell behavior is always allowed; only the paid/auth tier is gated.
   */
  gateState(result: ValidationResult): GateState {
    return result.gate;
  }

  /** Whether local shell behavior is allowed. Always true (local-first). */
  localShellAllowed(): boolean {
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private verifySignature(body: EntitlementBody, signature: string, keyId: string): boolean {
    const key = this.keyring.getKey(keyId);
    if (key === undefined) return false;
    const expected = signEntitlementBody(body, key);
    // Constant-time compare over equal-length hex strings.
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }

  private project(body: EntitlementBody, offline: boolean): EntitlementProjection {
    return {
      plan: body.plan,
      status: body.status,
      expiresAt: body.expiresAt,
      offline,
    };
  }

  private fail(
    code: ErrorCode,
    message: string,
    op: string,
    corr: string | undefined,
    rebindRequired: boolean,
    projection?: EntitlementProjection,
  ): ValidationResult {
    return {
      ok: false,
      gate: 'blocked',
      error: entitlementError(code, message, { operation: op, correlationId: corr }),
      ...(rebindRequired ? { rebindRequired: true } : {}),
      ...(projection ? { projection } : {}),
    };
  }
}
