/**
 * Credential contracts — `CredentialRef@1`, typed credential kinds, masking,
 * and the typed Auth Broker parse surface (D-04, D-07, D-16.6).
 *
 * This module is the *shared* half of the Credential Authority
 * (FUT-PKG-04-SECURITY/T-002). It is pure TypeScript with no Electron / Node
 * `fs` / `crypto` / DOM imports so it loads identically in the main process,
 * preload bridge, and renderer. The main-process authority
 * (`src/main/security/credential-service.ts`) owns storage, resolution, and
 * migration; this module owns only the contract shape, masking, redaction
 * helpers, and the typed broker classification that agents/renderers may see.
 *
 * Key invariants implemented here:
 *
 *   - `CredentialRef@1` has **no raw-value field** (design line 318). Only a
 *     masked `maskedDisplay` and non-secret metadata are ever exposed to
 *     agents/renderers (NN-SEC-008, NN-INV-004).
 *   - Credential *type* — not a regex/prefix guess — selects validation
 *     (NN-IDENT-007). The {@link classifyAuthScheme} broker parses an explicit
 *     scheme/type and returns a typed principal shape; ambiguous
 *     "try-one-regex-then-another" is forbidden (NN-PROXY-001).
 *   - The canonical newly-issued proxy credential is `NN_` + 32 lowercase hex
 *     (NN-PROXY-002). A JWT bearer is a *separately typed* audience contract
 *     and is never inferred merely because a bearer does not match `NN_`
 *     (NN-PROXY-003).
 *   - `secret`-classed material never crosses an observable boundary; the
 *     masking helpers only ever emit a fixed-shape mask, never a substring of
 *     the raw value.
 *
 * Design anchors: D-04 (CredentialRef ownership), D-07 (contracts), D-16
 * (security/privacy).
 * Requirements: NN-INV-004, NN-SEC-008, NN-IDENT-007,
 * NN-PROXY-001/002/003/005/008.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type RedactionClass,
  isOpaqueId,
} from './contract-primitives';

// ─── Credential types (NN-IDENT-007, NN-LICENSE / NN-PROXY) ─────────────────

/**
 * The distinct credential classes the authority manages. Each class selects a
 * different validation and audience policy; the class is *declared*, never
 * inferred by guessing (NN-IDENT-007). Keeping the set closed means a new
 * credential kind is an explicit, reviewed addition rather than a fuzzy match.
 */
export const CREDENTIAL_TYPES = Object.freeze([
  /** Local entitlement / license grant (`NN-LICENSE`). */
  'entitlement',
  /** NeuroNest proxy credential — canonical `NN_` + 32 hex (`NN-PROXY-002`). */
  'proxy-credential',
  /** Upstream provider secret held envelope-encrypted worker-side (`NN-PROXY-008`). */
  'upstream-provider-secret',
  /** Desktop activation code issued at first launch (`NN-LICENSE`). */
  'desktop-activation-code',
  /** WebAuthn passkey credential material (`NN-SEC-010`). */
  'webauthn-credential',
  /** Separately typed/audienced session JWT (`NN-PROXY-003`). */
  'session-jwt',
  /** Internal service-to-service token. */
  'internal-service-token',
] as const);

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CredentialTypeSchema = z.enum(CREDENTIAL_TYPES);

/** Whether a value is a recognized credential type. */
export function isCredentialType(value: unknown): value is CredentialType {
  return (
    typeof value === 'string' &&
    (CREDENTIAL_TYPES as readonly string[]).includes(value)
  );
}

// ─── Storage backend (NN-SEC-008) ──────────────────────────────────────────

/**
 * Where the raw value is protected. Both satisfy NN-SEC-008: the OS secure
 * store delegates protection to the platform keychain, and the envelope form
 * encrypts the value with a data key whose *wrapping* key resides in the OS
 * secure store — plaintext is never persisted in either mode.
 */
export const STORAGE_BACKENDS = Object.freeze([
  'os-secure-store',
  'envelope-encrypted',
] as const);

export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

export const StorageBackendSchema = z.enum(STORAGE_BACKENDS);

// ─── Credential status ──────────────────────────────────────────────────────

/**
 * Lifecycle status of a `CredentialRef@1`.
 *
 *   - `active`      — resolvable at the operation boundary.
 *   - `expired`     — past `expiresAt`; resolution is refused.
 *   - `revoked`     — explicitly revoked; resolution is refused and the epoch
 *     advanced so any cached reference is rejected.
 *   - `quarantined` — a migration/read-back/decrypt failure isolated the sole
 *     recoverable copy outside normal use; never forwarded, never a plaintext
 *     fallback (task migration rule).
 */
export const CREDENTIAL_STATUSES = Object.freeze([
  'active',
  'expired',
  'revoked',
  'quarantined',
] as const);

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CredentialStatusSchema = z.enum(CREDENTIAL_STATUSES);

// ─── Masking (NN-INV-004) ────────────────────────────────────────────────────

/** The fixed mask emitted when a value is too short to reveal any tail safely. */
export const FULL_MASK = '••••••••' as const;

/**
 * Produce a masked display for a raw secret. The result NEVER contains a
 * substring of the raw value except, at most, a short fixed-length tail for a
 * sufficiently long value, and only for classes where a tail aids recognition
 * without materially weakening secrecy. For short values the full mask is used.
 *
 * The mask is stable in shape (a run of bullets plus an optional 4-char tail)
 * so it is itself safe to log, render, and export (NN-INV-004). This function
 * is the ONLY approved way to derive a `maskedDisplay`.
 */
export function maskSecret(
  raw: string,
  options: { readonly revealTail?: boolean } = {},
): string {
  if (typeof raw !== 'string' || raw.length === 0) return FULL_MASK;
  if (options.revealTail !== true) return FULL_MASK;
  // Only reveal a tail for values long enough that 4 trailing chars cannot
  // meaningfully reconstruct the secret.
  if (raw.length < 12) return FULL_MASK;
  return `${FULL_MASK}${raw.slice(-4)}`;
}

// ─── CredentialRef@1 (design line 318) ──────────────────────────────────────

/**
 * `CredentialRef@1`. CredentialService owns it. **There is no raw-value
 * field.** Trusted resolution requires actor, scope, audience, and the current
 * epoch at the operation boundary; export redaction follows policy (design
 * line 318, NN-SEC-008).
 *
 * `revocationEpoch` is a monotonic counter that increments on every rotation
 * and revocation; a resolver that presents a stale epoch is rejected, which is
 * how rotation/revocation invalidates already-handed-out references.
 */
export const CredentialRefSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  credentialRefId: OpaqueIdSchema,
  credentialType: CredentialTypeSchema,
  issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(256),
  subject: z.string().min(1).max(256),
  scopes: z.array(z.string().min(1).max(128)),
  version: RevisionSchema,
  storageBackend: StorageBackendSchema,
  maskedDisplay: z.string().min(1).max(64),
  createdAt: TimestampSchema,
  rotatedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  revocationEpoch: RevisionSchema,
  status: CredentialStatusSchema,
});

export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/** Whether a value is a structurally valid `CredentialRef@1`. */
export function isCredentialRef(value: unknown): value is CredentialRef {
  return CredentialRefSchema.safeParse(value).success;
}

/**
 * Assert (at runtime, defensively) that a `CredentialRef` carries no property
 * that could hold a raw value. `CredentialRefSchema` is a strict object so an
 * extra key already fails parsing; this guards against a caller hand-building a
 * loosened object literal and is used by the masked-projection path.
 */
const FORBIDDEN_RAW_KEYS = Object.freeze([
  'value',
  'secret',
  'raw',
  'rawValue',
  'plaintext',
  'token',
  'ciphertext',
  'envelope',
]);

export function assertNoRawValueField(ref: object): void {
  for (const key of Object.keys(ref)) {
    if (FORBIDDEN_RAW_KEYS.includes(key.toLowerCase())) {
      throw new Error(
        `CredentialRef must not carry a raw-value field; found "${key}"`,
      );
    }
  }
}

// ─── Masked projection for agents/renderers (NN-SEC-008) ────────────────────

/**
 * The renderer/agent-safe projection of a credential. This is the ONLY shape
 * an agent or renderer receives (NN-SEC-008). It is a subset of
 * `CredentialRef@1` with the masked display and status — never issuer-internal
 * secrets, never the storage envelope.
 */
export interface MaskedCredentialView {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly credentialRefId: string;
  readonly credentialType: CredentialType;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly maskedDisplay: string;
  readonly status: CredentialStatus;
  readonly expiresAt?: string;
}

/**
 * Project a `CredentialRef@1` down to the masked view. The projection copies
 * only allow-listed non-secret fields; it never copies through unknown fields,
 * so even a loosened source object cannot leak a value into the renderer.
 */
export function toMaskedView(ref: CredentialRef): MaskedCredentialView {
  assertNoRawValueField(ref);
  const view: {
    -readonly [K in keyof MaskedCredentialView]: MaskedCredentialView[K];
  } = {
    schemaVersion: CONTRACT_WRITE_VERSION,
    credentialRefId: ref.credentialRefId,
    credentialType: ref.credentialType,
    audience: ref.audience,
    scopes: [...ref.scopes],
    maskedDisplay: ref.maskedDisplay,
    status: ref.status,
  };
  if (ref.expiresAt !== undefined) view.expiresAt = ref.expiresAt;
  return view;
}

// ─── Typed Auth Broker (NN-PROXY-001/002/003) ───────────────────────────────

/** Canonical newly-issued proxy credential shape: `NN_` + 32 lowercase hex. */
export const CANONICAL_PROXY_CREDENTIAL_PATTERN = /^NN_[0-9a-f]{32}$/;

/** Whether a raw bearer matches the canonical proxy credential shape. */
export function isCanonicalProxyCredential(raw: string): boolean {
  return CANONICAL_PROXY_CREDENTIAL_PATTERN.test(raw);
}

/**
 * The outcome of the typed broker classifying an inbound auth scheme. The
 * broker parses an explicit scheme/type; it does not guess among classes
 * (NN-PROXY-001). An unrecognized or ambiguous scheme is `unresolved`, which
 * the caller turns into a typed denial with **no fallback** to another class.
 */
export type AuthSchemeClassification =
  | {
      readonly kind: 'proxy-credential';
      readonly credentialType: 'proxy-credential';
      /** True only when the bearer matches the canonical `NN_` shape. */
      readonly canonical: boolean;
    }
  | {
      readonly kind: 'session-jwt';
      readonly credentialType: 'session-jwt';
    }
  | {
      readonly kind: 'legacy-lk';
      readonly credentialType: 'proxy-credential';
    }
  | { readonly kind: 'unresolved'; readonly reason: string };

/**
 * A declared inbound authentication attempt. The *type* is supplied by the
 * caller (parsed from an explicit header/scheme), never guessed from the token
 * body (NN-IDENT-007, NN-PROXY-001).
 */
export interface DeclaredAuthScheme {
  /**
   * The declared scheme name, e.g. `nn-proxy`, `jwt`, `lk-legacy`. This is the
   * explicit selector; it is NOT derived from the bearer value.
   */
  readonly scheme: string;
  /** The raw bearer value. Only inspected to *confirm* the declared class. */
  readonly bearer: string;
}

/**
 * Broker policy toggles. `LK-` acceptance is disabled by default and may be
 * enabled only after an inventory proves legacy records exist (NN-PROXY-004).
 */
export interface AuthBrokerPolicy {
  /** When true, a declared `lk-legacy` scheme is classified; else unresolved. */
  readonly acceptLegacyLk?: boolean;
}

/**
 * Classify a declared auth scheme into a typed credential class. The scheme
 * name selects the branch; the bearer is only inspected to *confirm* the
 * declared shape, never to choose among classes. An unknown scheme, or a
 * declared class whose bearer fails its own shape check, is `unresolved` — the
 * caller must not retry as another class (NN-PROXY-001/003).
 */
export function classifyAuthScheme(
  attempt: DeclaredAuthScheme,
  policy: AuthBrokerPolicy = {},
): AuthSchemeClassification {
  const scheme = attempt.scheme.trim().toLowerCase();
  switch (scheme) {
    case 'nn-proxy':
    case 'proxy-credential': {
      return {
        kind: 'proxy-credential',
        credentialType: 'proxy-credential',
        canonical: isCanonicalProxyCredential(attempt.bearer),
      };
    }
    case 'jwt':
    case 'session-jwt': {
      // A JWT is a separately typed/audienced contract; we do not require it to
      // match NN_, and we never infer it merely because the bearer is not NN_
      // (NN-PROXY-003). We only sanity-check the three-part dotted shape.
      if (attempt.bearer.split('.').length !== 3) {
        return { kind: 'unresolved', reason: 'declared jwt is not a three-part token' };
      }
      return { kind: 'session-jwt', credentialType: 'session-jwt' };
    }
    case 'lk-legacy':
    case 'lk': {
      if (policy.acceptLegacyLk !== true) {
        return {
          kind: 'unresolved',
          reason: 'legacy LK- acceptance is disabled by default (NN-PROXY-004)',
        };
      }
      if (!attempt.bearer.startsWith('LK-')) {
        return { kind: 'unresolved', reason: 'declared lk-legacy bearer lacks LK- prefix' };
      }
      return { kind: 'legacy-lk', credentialType: 'proxy-credential' };
    }
    default:
      return { kind: 'unresolved', reason: `unknown auth scheme "${scheme}"` };
  }
}

// ─── Typed errors ────────────────────────────────────────────────────────────

const CREDENTIAL_AUTHORITY_OWNER = 'authority-credential';

/**
 * Build a pre-redacted typed error for the credential authority. `message` is
 * assumed already safe: callers here never interpolate a raw secret or private
 * absolute path into it (NN-INV-004). Redaction defaults to `internal`.
 */
export function credentialError(
  code: ErrorCode,
  message: string,
  options: { readonly operation?: string; readonly correlationId?: string } = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: CREDENTIAL_AUTHORITY_OWNER,
    operation: options.operation ?? 'credential',
    correlationId: isOpaqueId(options.correlationId)
      ? options.correlationId
      : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction: 'internal' as RedactionClass,
  };
}
