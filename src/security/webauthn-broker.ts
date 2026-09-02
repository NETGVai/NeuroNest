/**
 * WebAuthn Broker — system-browser passkey ceremonies and signed deep-link
 * handoff (FUT-PKG-04-SECURITY/T-003).
 *
 * Implements the production WebAuthn / session-auth boundary (NN-SEC-010):
 *
 *   - **System browser only.** Passkey ceremonies run in the OS default
 *     browser, never inside an in-app webview/BrowserWindow. {@link openCeremony}
 *     hands a ceremony URL to an injected {@link SystemBrowserOpener}; there is
 *     no in-app WebAuthn surface (D-16.1, NN-SEC-009). The ceremony origin is
 *     pinned to `https://auth.neuronest.cc` with RP ID `neuronest.cc`.
 *
 *   - **Signed deep-link handoff tokens.** After a successful ceremony the
 *     service returns a short-lived (15-minute) signed handoff token via a
 *     custom deep link. {@link consumeHandoff} verifies the detached signature,
 *     the audience, the RP origin, and the 15-minute expiry, and rejects a
 *     tampered/expired/wrong-audience token with no session established
 *     (fail closed, NN-INV-001). The token is single-use: a replay is rejected.
 *
 *   - **Distinct credential classes (NN-LICENSE-001).** The WebAuthn credential
 *     reference and the resulting session JWT are distinct credential types and
 *     never reused as one another.
 *
 * The signing is HMAC-SHA256 over the canonical token body with an injected
 * keyring, so the handoff verification is deterministic and testable without a
 * live service. No raw token secret is ever logged or surfaced.
 *
 * Design anchors: D-16.1 (Electron/system-browser), D-16.6 (credentials).
 * Requirements: NN-SEC-009/010, NN-LICENSE-001, NN-INV-001/004, NN-UI-011.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  canonicalSerialize,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';

// ─── Pinned production constants (NN-SEC-010) ───────────────────────────────

/** The only permitted production ceremony origin (NN-SEC-010). */
export const WEBAUTHN_ORIGIN = 'https://auth.neuronest.cc' as const;
/** The pinned Relying Party ID (NN-SEC-010). */
export const WEBAUTHN_RP_ID = 'neuronest.cc' as const;
/** The signed deep-link handoff token lifetime: 15 minutes (NN-SEC-010). */
export const HANDOFF_TOKEN_TTL_MS = 15 * 60 * 1000;

// ─── System browser opener (injected) ───────────────────────────────────────

/**
 * Opens a URL in the OS default browser. Production wires Electron
 * `shell.openExternal`; tests inject a recorder. The broker NEVER opens a
 * ceremony inside an in-app window (NN-SEC-009/010).
 */
export interface SystemBrowserOpener {
  openExternal(url: string): void;
}

// ─── Handoff token model ─────────────────────────────────────────────────────

/** The signed handoff token body (everything that is signed). */
export const HandoffTokenBodySchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  /** Opaque nonce making the token single-use. */
  nonce: z.string().min(8).max(256),
  /** RP origin the ceremony ran under; must equal {@link WEBAUTHN_ORIGIN}. */
  origin: z.string().min(1).max(256),
  /** RP ID; must equal {@link WEBAUTHN_RP_ID}. */
  rpId: z.string().min(1).max(256),
  /** The audience (this desktop build) the token is issued for. */
  audience: z.string().min(1).max(256),
  /** The authenticated account subject. */
  accountId: z.string().min(1).max(256),
  /** Issue time (epoch ms). */
  issuedAtMs: z.number().int().nonnegative().finite(),
  /** Absolute expiry (epoch ms); must be issuedAt + 15min. */
  expiresAtMs: z.number().int().nonnegative().finite(),
});
export type HandoffTokenBody = z.infer<typeof HandoffTokenBodySchema>;

/** A signed handoff token (body + detached HMAC-SHA256 signature). */
export const SignedHandoffTokenSchema = z.strictObject({
  body: HandoffTokenBodySchema,
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  keyId: z.string().min(1).max(128),
});
export type SignedHandoffToken = z.infer<typeof SignedHandoffTokenSchema>;

// ─── Signing keyring ──────────────────────────────────────────────────────────

export interface HandoffKeyring {
  getKey(keyId: string): string | undefined;
}

export class InMemoryHandoffKeyring implements HandoffKeyring {
  private readonly keys = new Map<string, string>();
  constructor(entries: Readonly<Record<string, string>> = {}) {
    for (const [k, v] of Object.entries(entries)) this.keys.set(k, v);
  }
  getKey(keyId: string): string | undefined {
    return this.keys.get(keyId);
  }
}

/** Sign a handoff token body. Exported so the service and tests mint tokens. */
export function signHandoffBody(body: HandoffTokenBody, key: string): string {
  return createHmac('sha256', key).update(canonicalSerialize(body), 'utf8').digest('hex');
}

/** Mint a signed handoff token. Throws on unknown key id (trusted path). */
export function mintHandoffToken(
  body: HandoffTokenBody,
  keyId: string,
  keyring: HandoffKeyring,
): SignedHandoffToken {
  const key = keyring.getKey(keyId);
  if (key === undefined) throw new Error(`unknown handoff key id: ${keyId}`);
  return { body, signature: signHandoffBody(body, key), keyId };
}

// ─── Typed errors / results ──────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-webauthn';

function webauthnError(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: 'webauthn-handoff',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    redaction: 'internal',
  };
}

/** The result of consuming a handoff token. */
export type HandoffResult =
  | { readonly ok: true; readonly accountId: string; readonly expiresAtMs: number }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── The broker ───────────────────────────────────────────────────────────────

export interface WebAuthnBrokerOptions {
  readonly opener: SystemBrowserOpener;
  readonly keyring: HandoffKeyring;
  readonly audience: string;
  readonly nowMs?: () => number;
}

export class WebAuthnBroker {
  private readonly opener: SystemBrowserOpener;
  private readonly keyring: HandoffKeyring;
  private readonly audience: string;
  private readonly nowMs: () => number;
  /** Single-use nonce ledger — a consumed token cannot be replayed. */
  private readonly consumedNonces = new Set<string>();

  constructor(options: WebAuthnBrokerOptions) {
    this.opener = options.opener;
    this.keyring = options.keyring;
    this.audience = options.audience;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Open a passkey ceremony in the system browser (NN-SEC-010). The URL must be
   * on the pinned {@link WEBAUTHN_ORIGIN}; any other origin is refused so a
   * ceremony can never be opened against an untrusted host. Returns the URL
   * that was opened for audit.
   */
  openCeremony(
    ceremonyPath: string,
    options: { correlationId?: string } = {},
  ): { ok: true; url: string } | { ok: false; error: ErrorEnvelope } {
    let url: URL;
    try {
      url = new URL(ceremonyPath, WEBAUTHN_ORIGIN);
    } catch {
      return { ok: false, error: webauthnError('VALIDATION', 'malformed ceremony path', options.correlationId) };
    }
    if (url.origin !== WEBAUTHN_ORIGIN) {
      return { ok: false, error: webauthnError('FORBIDDEN', 'ceremony origin is not the pinned auth origin', options.correlationId) };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, error: webauthnError('FORBIDDEN', 'ceremony must use https', options.correlationId) };
    }
    this.opener.openExternal(url.toString());
    return { ok: true, url: url.toString() };
  }

  /**
   * Verify and consume a signed deep-link handoff token (NN-SEC-010). Checks,
   * in order and all fail-closed:
   *   1. schema shape,
   *   2. detached signature,
   *   3. RP origin / RP ID pin,
   *   4. audience,
   *   5. 15-minute TTL invariant and current expiry,
   *   6. single-use (nonce not previously consumed).
   *
   * On success the nonce is burned and the account subject is returned; a
   * session JWT is minted by the caller through the CredentialService (distinct
   * class). Any failure establishes no session.
   */
  consumeHandoff(
    token: unknown,
    options: { correlationId?: string } = {},
  ): HandoffResult {
    const corr = options.correlationId;
    const parsed = SignedHandoffTokenSchema.safeParse(token);
    if (!parsed.success) {
      return { ok: false, error: webauthnError('VALIDATION', 'handoff token failed schema validation', corr) };
    }
    const { body, signature, keyId } = parsed.data;

    if (!this.verify(body, signature, keyId)) {
      return { ok: false, error: webauthnError('UNAUTHORIZED', 'handoff token signature did not verify', corr) };
    }
    if (body.origin !== WEBAUTHN_ORIGIN || body.rpId !== WEBAUTHN_RP_ID) {
      return { ok: false, error: webauthnError('FORBIDDEN', 'handoff token RP origin/id mismatch', corr) };
    }
    if (body.audience !== this.audience) {
      return { ok: false, error: webauthnError('FORBIDDEN', 'handoff token audience mismatch', corr) };
    }
    // TTL invariant: the token must declare exactly the 15-minute window.
    if (body.expiresAtMs - body.issuedAtMs !== HANDOFF_TOKEN_TTL_MS) {
      return { ok: false, error: webauthnError('FORBIDDEN', 'handoff token does not honor the 15-minute TTL', corr) };
    }
    const now = this.nowMs();
    if (now >= body.expiresAtMs) {
      return { ok: false, error: webauthnError('UNAUTHORIZED', 'handoff token has expired', corr) };
    }
    if (now < body.issuedAtMs) {
      return { ok: false, error: webauthnError('FORBIDDEN', 'handoff token issued in the future (clock fault)', corr) };
    }
    if (this.consumedNonces.has(body.nonce)) {
      return { ok: false, error: webauthnError('CONFLICT', 'handoff token has already been consumed (replay)', corr) };
    }

    this.consumedNonces.add(body.nonce);
    return { ok: true, accountId: body.accountId, expiresAtMs: body.expiresAtMs };
  }

  private verify(body: HandoffTokenBody, signature: string, keyId: string): boolean {
    const key = this.keyring.getKey(keyId);
    if (key === undefined) return false;
    const expected = signHandoffBody(body, key);
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }
}
