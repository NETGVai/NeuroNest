/**
 * Certificate Authority client — authenticated CSR issuance and bounded renewal
 * (FUT-PKG-04-SECURITY/T-003).
 *
 * Implements the certificate-service boundary (NN-SEC-011) as seen by the
 * desktop/authority side that requests and renews certificates:
 *
 *   - **Authenticated HTTPS CSR only.** {@link requestCertificate} accepts only
 *     an authenticated request (a verified session principal) for the pinned
 *     `auth.neuronest.cc` host; an unauthenticated or wrong-host request is
 *     rejected with no issuance (fail closed, NN-INV-001).
 *
 *   - **Rate limiting: 5 per IP per 24h (NN-SEC-011).** A per-IP sliding
 *     24-hour window caps issuance at five; the sixth request in-window is a
 *     typed `BUDGET_EXCEEDED`/rate error with no issuance.
 *
 *   - **Renewal inside 48h, ≤3 hourly retries (NN-SEC-011).** {@link needsRenewal}
 *     is true only within 48 hours of expiry; {@link recordRenewalAttempt}
 *     enforces at most three attempts spaced at least an hour apart.
 *
 *   - **256-bit local private keys, permission 0600, never transmitted
 *     (NN-SEC-010).** The private key never leaves the boundary; only the CSR
 *     (public) is sent. This client models the request/response; the key store
 *     is the CredentialService (distinct `webauthn-credential`/cert class),
 *     never a transmitted value.
 *
 *   - **Health without secrets (NN-SEC-011).** {@link health} exposes rate/
 *     renewal counters with no credential material.
 *
 * The actual HTTPS issuance is injected as a {@link CertificateIssuerClient} so
 * the flow is deterministic and testable; Cloudflare/DNS-challenge credentials
 * live in worker secret storage, not here.
 *
 * Design anchors: D-16 (security), D-16.5 (destination policy).
 * Requirements: NN-SEC-010/011, NN-CLOUD-001/006, NN-INV-001/004, NN-LICENSE-009.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';

// ─── Pinned constants (NN-SEC-011) ──────────────────────────────────────────

/** The only certificate common name the worker will issue for (NN-SEC-011). */
export const CERTIFICATE_HOST = 'auth.neuronest.cc' as const;
/** Max issuance requests per IP per 24h (NN-SEC-011). */
export const RATE_LIMIT_PER_IP = 5;
/** The rate-limit window: 24 hours. */
export const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Renewal is allowed only within 48h of expiry (NN-SEC-011). */
export const RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Max renewal attempts (NN-SEC-011). */
export const MAX_RENEWAL_ATTEMPTS = 3;
/** Minimum spacing between renewal attempts: 1 hour (NN-SEC-011). */
export const RENEWAL_RETRY_SPACING_MS = 60 * 60 * 1000;

// ─── Request model ────────────────────────────────────────────────────────────

/** An authenticated CSR request. `principal` is a verified session subject. */
export const CsrRequestSchema = z.strictObject({
  /** The pinned host; must equal {@link CERTIFICATE_HOST}. */
  host: z.string().min(1).max(256),
  /** The PEM CSR (public). The private key never appears here. */
  csrPem: z.string().min(1).max(16384),
  /** Verified authenticated principal (absent → unauthenticated → deny). */
  principal: z.string().min(1).max(256).optional(),
  /** The source IP for rate limiting. */
  sourceIp: z.string().min(1).max(64),
});
export type CsrRequest = z.infer<typeof CsrRequestSchema>;

/** The issuer client response. */
export interface IssuedCertificate {
  readonly certificatePem: string;
  /** Absolute expiry (epoch ms). */
  readonly expiresAtMs: number;
  readonly serial: string;
}

/**
 * The authenticated HTTPS issuer (Cloudflare worker). Production performs and
 * cleans up the DNS challenge server-side; tests inject a deterministic fake.
 */
export interface CertificateIssuerClient {
  issue(request: { readonly host: string; readonly csrPem: string }): Promise<IssuedCertificate>;
}

// ─── Typed errors / results ──────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-certificate';

function certError(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: 'certificate-issuance',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'UNAVAILABLE',
    redaction: 'internal',
  };
}

export type CertificateResult =
  | { readonly ok: true; readonly certificate: IssuedCertificate }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── Health projection (no secrets) ─────────────────────────────────────────

export interface CertificateHealth {
  readonly host: string;
  readonly rateLimitPerIp: number;
  readonly windowMs: number;
  readonly maxRenewalAttempts: number;
  /** Number of IPs currently tracked in the rate window (no addresses shown). */
  readonly trackedIps: number;
}

// ─── The client ───────────────────────────────────────────────────────────────

export interface CertificateAuthorityOptions {
  readonly issuer: CertificateIssuerClient;
  readonly nowMs?: () => number;
}

export class CertificateAuthorityClient {
  private readonly issuer: CertificateIssuerClient;
  private readonly nowMs: () => number;
  /** Per-IP issuance timestamps (epoch ms), for the sliding 24h window. */
  private readonly issuanceLog = new Map<string, number[]>();
  /** Per-serial renewal attempt timestamps. */
  private readonly renewalLog = new Map<string, number[]>();

  constructor(options: CertificateAuthorityOptions) {
    this.issuer = options.issuer;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Request certificate issuance for an authenticated CSR (NN-SEC-011). Order,
   * all fail-closed: shape → host pin → authentication → per-IP rate limit →
   * issue. A rate-limited or unauthenticated request performs no issuance.
   */
  async requestCertificate(
    request: unknown,
    options: { correlationId?: string } = {},
  ): Promise<CertificateResult> {
    const corr = options.correlationId;
    const parsed = CsrRequestSchema.safeParse(request);
    if (!parsed.success) {
      return { ok: false, error: certError('VALIDATION', 'CSR request failed schema validation', corr) };
    }
    const req = parsed.data;

    if (req.host !== CERTIFICATE_HOST) {
      return { ok: false, error: certError('FORBIDDEN', 'certificate host is not the pinned auth host', corr) };
    }
    if (req.principal === undefined) {
      return { ok: false, error: certError('UNAUTHORIZED', 'certificate request is not authenticated', corr) };
    }

    // Per-IP sliding-window rate limit (NN-SEC-011).
    if (!this.withinRateLimit(req.sourceIp)) {
      return { ok: false, error: certError('BUDGET_EXCEEDED', 'certificate issuance rate limit exceeded for this IP', corr) };
    }

    let issued: IssuedCertificate;
    try {
      issued = await this.issuer.issue({ host: req.host, csrPem: req.csrPem });
    } catch {
      return { ok: false, error: certError('UNAVAILABLE', 'certificate issuer was unavailable', corr) };
    }

    this.recordIssuance(req.sourceIp);
    return { ok: true, certificate: issued };
  }

  /**
   * Whether a certificate expiring at `expiresAtMs` needs renewal now — true
   * only inside the 48-hour window before expiry (NN-SEC-011). An
   * already-expired certificate also needs renewal.
   */
  needsRenewal(expiresAtMs: number): boolean {
    const remaining = expiresAtMs - this.nowMs();
    return remaining <= RENEWAL_WINDOW_MS;
  }

  /**
   * Record a renewal attempt for `serial`, enforcing at most three attempts
   * spaced ≥1 hour apart (NN-SEC-011). Returns whether the attempt is permitted;
   * a fourth attempt, or one within an hour of the previous, is denied.
   */
  recordRenewalAttempt(serial: string): { allowed: boolean; reason?: string } {
    const now = this.nowMs();
    const attempts = this.renewalLog.get(serial) ?? [];
    if (attempts.length >= MAX_RENEWAL_ATTEMPTS) {
      return { allowed: false, reason: 'maximum renewal attempts reached' };
    }
    const last = attempts[attempts.length - 1];
    if (last !== undefined && now - last < RENEWAL_RETRY_SPACING_MS) {
      return { allowed: false, reason: 'renewal retry spacing (1h) not elapsed' };
    }
    attempts.push(now);
    this.renewalLog.set(serial, attempts);
    return { allowed: true };
  }

  /** Health without any secret material (NN-SEC-011). */
  health(): CertificateHealth {
    return {
      host: CERTIFICATE_HOST,
      rateLimitPerIp: RATE_LIMIT_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxRenewalAttempts: MAX_RENEWAL_ATTEMPTS,
      trackedIps: this.issuanceLog.size,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private withinRateLimit(ip: string): boolean {
    return this.prune(ip).length < RATE_LIMIT_PER_IP;
  }

  private recordIssuance(ip: string): void {
    const kept = this.prune(ip);
    kept.push(this.nowMs());
    this.issuanceLog.set(ip, kept);
  }

  /** Drop timestamps outside the 24h window and return the pruned list. */
  private prune(ip: string): number[] {
    const now = this.nowMs();
    const kept = (this.issuanceLog.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    this.issuanceLog.set(ip, kept);
    return kept;
  }
}
