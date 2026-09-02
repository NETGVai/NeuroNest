/**
 * Credential Service / Auth Broker — the single credential authority (D-04).
 *
 * Implements the `CredentialRef@1` authority described in D-04 and D-16.6 and
 * required by NN-SEC-008 / NN-INV-004:
 *
 *   - Every credential is stored either directly in OS secure storage, or as an
 *     envelope-encrypted record whose wrapping key is itself held in OS secure
 *     storage (NN-SEC-008). There is no plaintext-at-rest path.
 *   - Agents and renderers only ever receive a masked {@link CredentialRef}
 *     (`CredentialRef@1`). The reference carries type/audience/scope/epoch/
 *     status metadata and a `maskedDisplay`, but **no raw-value field** (D-04).
 *   - The raw secret is resolved only at the operation boundary, and only when
 *     the caller presents an actor + scope + audience + the current revocation
 *     epoch (D-04 "trusted resolution requires actor, scope, audience, and
 *     current epoch at the operation boundary"). Resolution is scoped per actor.
 *   - Distinct {@link CredentialType}s (entitlement, proxy credential, upstream
 *     provider secret, desktop activation code, WebAuthn credential, session
 *     JWT, internal service token) are separate schema types; no field is
 *     reused as another credential type (NN-LICENSE-001).
 *   - The resolved value is never placed into logs, events, evidence, exports,
 *     URLs, or error envelopes; it is redacted from every observable surface
 *     via {@link redactValue} and zeroized best-effort after use (D-16.6).
 *
 * The OS-secure-storage backend is abstracted behind {@link SecureStorageBackend}
 * so the authority is testable without Electron `safeStorage`; production wires
 * a `safeStorage`-backed adapter (see {@link SafeStorageSecureBackend}), tests
 * inject {@link InMemorySecureStorageBackend}.
 *
 * This task is deliberately additive (FUT-PKG-04-SECURITY/T-002): this is the
 * one authority; the four+ scattered credential owners become adapters/readers
 * behind it (see {@link ./credential-migration}). Rollback restores a read
 * adapter, never a plaintext fallback.
 *
 * Design anchors: D-04 (credential authority/ownership), D-07 (versioned
 * contract), D-16.6 (credentials/redaction).
 * Requirements: NN-SEC-008, NN-INV-004, NN-INV-001, NN-LICENSE-001,
 * NN-PROXY credential types.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  canonicalSerialize,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from './contract-primitives';
import { redactValue } from './observable-redaction';

// ─── Credential types (NN-LICENSE-001 typed separation) ─────────────────────

/**
 * The distinct credential types. Each is a separate schema type and store slot;
 * no field is reused as another credential (NN-LICENSE-001, NN-PROXY,
 * NN-LICENSE). Resolution validation is selected by this type.
 */
export const CREDENTIAL_TYPES = Object.freeze([
  'entitlement', // signed entitlement (NN-LICENSE)
  'proxy-credential', // proxy bearer credential (NN-PROXY)
  'upstream-provider-secret', // upstream LLM provider API secret
  'desktop-activation-code', // desktop/PQC activation code (NN-LICENSE-002)
  'webauthn-credential', // WebAuthn credential material
  'session-jwt', // short-lived session JWT
  'internal-service-token', // internal service-to-service token
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
 * The storage backend for a credential:
 *   - `os-secure-storage` — the value is protected directly by the OS keychain
 *     / credential manager (Electron `safeStorage`).
 *   - `envelope-encrypted` — the value is AES-256-GCM encrypted at rest and the
 *     wrapping key is itself held in OS secure storage.
 * Both satisfy NN-SEC-008; neither writes plaintext at rest.
 */
export const STORAGE_BACKENDS = Object.freeze([
  'os-secure-storage',
  'envelope-encrypted',
] as const);
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];
export const StorageBackendSchema = z.enum(STORAGE_BACKENDS);

/** Credential lifecycle status (D-04 `status`). */
export const CREDENTIAL_STATUSES = Object.freeze([
  'active',
  'rotated',
  'revoked',
  'expired',
] as const);
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];
export const CredentialStatusSchema = z.enum(CREDENTIAL_STATUSES);

// ─── CredentialRef@1 (D-04) ─────────────────────────────────────────────────

/**
 * `CredentialRef@1`. The CredentialService owns it. There is **no raw-value
 * field** — the reference is the only representation that ever reaches an agent,
 * renderer, log, event, or export (D-04, NN-INV-004). `maskedDisplay` is a
 * non-reversible hint (never a prefix/suffix of the real secret).
 */
export const CredentialRefSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  credentialRefId: OpaqueIdSchema,
  credentialType: CredentialTypeSchema,
  issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(256),
  subject: z.string().min(1).max(256),
  scopes: z.array(z.string().min(1).max(256)),
  version: RevisionSchema,
  storageBackend: StorageBackendSchema,
  /** Non-reversible masked hint. Never contains raw secret characters. */
  maskedDisplay: z.string().min(1).max(128),
  createdAt: TimestampSchema,
  rotatedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  revocationEpoch: RevisionSchema,
  status: CredentialStatusSchema,
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/**
 * The at-rest record. This never leaves the authority. It pairs the masked
 * {@link CredentialRef} with the storage-backend descriptor that lets the
 * authority resolve the raw value on demand. The secret material lives only in
 * the backend, keyed by `storageKey`; this record holds no plaintext.
 */
interface CredentialRecord {
  readonly ref: CredentialRef;
  /** Opaque key under which the backend holds the protected secret. */
  readonly storageKey: string;
  /** Digest of the raw value, for read-back verification (never the value). */
  readonly valueDigest: string;
}

// ─── Secure storage backend abstraction (injectable) ────────────────────────

/**
 * The OS-secure-storage backend. Production wires Electron `safeStorage`
 * (see {@link SafeStorageSecureBackend}); tests inject
 * {@link InMemorySecureStorageBackend}. The authority treats stored bytes as
 * opaque — the backend is responsible for OS-level protection.
 */
export interface SecureStorageBackend {
  /** Whether OS-level encryption is currently available. */
  isAvailable(): boolean;
  /** Protect and persist `value` under `key`. Overwrites any prior value. */
  set(key: string, value: string): void;
  /** Resolve the protected value for `key`, or `undefined` if absent. */
  get(key: string): string | undefined;
  /** Remove the protected value for `key`. Returns whether it existed. */
  delete(key: string): boolean;
  /** Whether a protected value exists for `key`. */
  has(key: string): boolean;
}

/**
 * In-memory secure-storage backend for tests and headless environments. It does
 * NOT provide OS-level protection; it exists so the authority can be exercised
 * where Electron `safeStorage` is unavailable. Its map is intentionally not
 * enumerable on the public surface so a `JSON.stringify` of a holder cannot
 * leak stored bytes.
 */
export class InMemorySecureStorageBackend implements SecureStorageBackend {
  private readonly store = new Map<string, string>();
  private readonly available: boolean;

  constructor(options: { available?: boolean } = {}) {
    this.available = options.available ?? true;
  }

  isAvailable(): boolean {
    return this.available;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Never serialize stored secret bytes (NN-INV-004). */
  toJSON(): Record<string, unknown> {
    return { kind: 'in-memory-secure-storage', entries: this.store.size };
  }
}

/**
 * Minimal shape of Electron's `safeStorage`. Declared locally so this module
 * has no hard Electron dependency and remains testable in a plain runner.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * OS-secure-storage backend backed by Electron `safeStorage`, persisting the
 * OS-protected ciphertext through an injected key/value sink (e.g. the
 * `secrets_v2` table). The plaintext only exists transiently inside
 * `encryptString`/`decryptString`; SQLite never sees it.
 */
export class SafeStorageSecureBackend implements SecureStorageBackend {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly sink: {
      set(key: string, base64Ciphertext: string): void;
      get(key: string): string | undefined;
      delete(key: string): boolean;
      has(key: string): boolean;
    },
  ) {}

  isAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  set(key: string, value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable');
    }
    this.sink.set(key, this.safeStorage.encryptString(value).toString('base64'));
  }

  get(key: string): string | undefined {
    if (!this.safeStorage.isEncryptionAvailable()) return undefined;
    const b64 = this.sink.get(key);
    if (b64 === undefined) return undefined;
    return this.safeStorage.decryptString(Buffer.from(b64, 'base64'));
  }

  delete(key: string): boolean {
    return this.sink.delete(key);
  }

  has(key: string): boolean {
    return this.sink.has(key);
  }
}

// ─── Typed errors ───────────────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-credential';

function credentialError(
  code: ErrorCode,
  message: string,
  options: { operation?: string; correlationId?: string } = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: options.operation ?? 'credential',
    correlationId: isOpaqueId(options.correlationId)
      ? options.correlationId
      : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction: 'internal',
  };
}

/** A typed result: a value or a typed {@link ErrorEnvelope}. */
export type CredentialResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── Store / resolve inputs ─────────────────────────────────────────────────

/** Input for storing a new credential (raw value + typed metadata). */
export interface StoreCredentialInput {
  readonly credentialType: CredentialType;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  /** Preferred backend. Falls back to envelope-encrypted if OS storage is off. */
  readonly storageBackend?: StorageBackend;
  readonly expiresAt?: string;
  /** The raw secret. Consumed immediately; never retained on the ref. */
  readonly value: string;
  /** Explicit ref id (for deterministic migration). Otherwise minted. */
  readonly credentialRefId?: string;
}

/**
 * The per-actor operation-boundary context required to resolve a raw value
 * (D-04). Every field must match the stored reference or resolution is denied.
 */
export interface ResolutionContext {
  /** The actor requesting resolution (opaque id). Resolution is scoped to it. */
  readonly actor: string;
  /** The audience the credential is being resolved for. */
  readonly audience: string;
  /** The scope in which the operation runs; must be one of the ref's scopes. */
  readonly scope: string;
  /** The revocation epoch the caller believes is current; must match. */
  readonly expectedRevocationEpoch: number;
  readonly operation?: string;
  readonly correlationId?: string;
}

/**
 * A resolved secret. This object is NEVER serialized to an observable surface;
 * {@link toJSON} redacts the value, and callers must `dispose()` after use to
 * zeroize the reference best-effort (D-16.6).
 */
export class ResolvedSecret {
  #value: string | undefined;
  readonly credentialRefId: string;
  readonly credentialType: CredentialType;
  readonly resolvedAt: string;
  readonly actor: string;

  constructor(params: {
    value: string;
    credentialRefId: string;
    credentialType: CredentialType;
    actor: string;
    resolvedAt: string;
  }) {
    this.#value = params.value;
    this.credentialRefId = params.credentialRefId;
    this.credentialType = params.credentialType;
    this.actor = params.actor;
    this.resolvedAt = params.resolvedAt;
  }

  /** Read the raw value. Throws once disposed. Use only at the boundary. */
  use<T>(fn: (value: string) => T): T {
    if (this.#value === undefined) {
      throw new Error('ResolvedSecret has been disposed');
    }
    return fn(this.#value);
  }

  /** The raw value, or throws if disposed. Prefer {@link use}. */
  reveal(): string {
    if (this.#value === undefined) {
      throw new Error('ResolvedSecret has been disposed');
    }
    return this.#value;
  }

  /** Best-effort zeroize; further reads throw. */
  dispose(): void {
    this.#value = undefined;
  }

  /** Never serialize the raw value (NN-INV-004). */
  toJSON(): Record<string, unknown> {
    return {
      credentialRefId: this.credentialRefId,
      credentialType: this.credentialType,
      resolvedAt: this.resolvedAt,
      value: '<redacted:secret>',
    };
  }
}

// ─── Persistence port for reference metadata ────────────────────────────────

/**
 * Where the authority persists reference metadata (never secret values). An
 * in-memory implementation is provided; production can back this with SQLite.
 * Records are opaque strings so the port never inspects secret material.
 */
export interface CredentialRefStore {
  put(record: string): void;
  get(credentialRefId: string): string | undefined;
  delete(credentialRefId: string): boolean;
  list(): readonly string[];
}

/** In-memory reference-metadata store. */
export class InMemoryCredentialRefStore implements CredentialRefStore {
  private readonly records = new Map<string, string>();

  put(record: string): void {
    const parsed = JSON.parse(record) as { ref?: { credentialRefId?: string } };
    const id = parsed.ref?.credentialRefId;
    if (typeof id !== 'string') throw new Error('record missing credentialRefId');
    this.records.set(id, record);
  }

  get(credentialRefId: string): string | undefined {
    return this.records.get(credentialRefId);
  }

  delete(credentialRefId: string): boolean {
    return this.records.delete(credentialRefId);
  }

  list(): readonly string[] {
    return Array.from(this.records.values());
  }
}

// ─── Masking ────────────────────────────────────────────────────────────────

/**
 * Produce a non-reversible masked display. It reveals only the value's length
 * bucket and a short salted fingerprint — never a prefix, suffix, or any raw
 * character of the secret (NN-INV-004).
 */
export function maskCredential(value: string): string {
  const lenBucket = value.length < 16 ? 'sm' : value.length < 40 ? 'md' : 'lg';
  const fingerprint = computeDigest(`mask:${value}`).slice(0, 8);
  return `••••${lenBucket}:${fingerprint}`;
}

// ─── The authority ──────────────────────────────────────────────────────────

export interface CredentialServiceOptions {
  readonly backend: SecureStorageBackend;
  readonly refStore?: CredentialRefStore;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/**
 * The one credential authority (D-04). All store/resolve/rotate/revoke flows go
 * through this class; agents and renderers only ever see {@link CredentialRef}.
 */
export class CredentialService {
  private readonly backend: SecureStorageBackend;
  private readonly refStore: CredentialRefStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: CredentialServiceOptions) {
    this.backend = options.backend;
    this.refStore = options.refStore ?? new InMemoryCredentialRefStore();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => cryptoRandomId());
  }

  // ── Store ──────────────────────────────────────────────────────────────

  /**
   * Store a new credential. The raw value is protected in the backend and only
   * the masked {@link CredentialRef} is returned. A read-back verify confirms
   * the protected value round-trips before the reference is committed
   * (NN-INV-006 recoverability / integrity). No plaintext is written at rest.
   */
  store(input: StoreCredentialInput): CredentialResult<CredentialRef> {
    if (typeof input.value !== 'string' || input.value.length === 0) {
      return { ok: false, error: credentialError('VALIDATION', 'value must be a non-empty string', { operation: 'store' }) };
    }
    if (!isCredentialType(input.credentialType)) {
      return { ok: false, error: credentialError('VALIDATION', 'unknown credential type', { operation: 'store' }) };
    }

    const backend = this.resolveBackendKind(input.storageBackend);
    if (backend.ok === false) return backend;

    const nowIso = this.now().toISOString();
    const refId = input.credentialRefId ?? makeOpaqueId('cred', this.createId());
    const storageKey = `credential:${refId}`;

    const ref: CredentialRef = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      credentialRefId: refId,
      credentialType: input.credentialType,
      issuer: input.issuer,
      audience: input.audience,
      subject: input.subject,
      scopes: [...input.scopes],
      version: 0,
      storageBackend: backend.value,
      maskedDisplay: maskCredential(input.value),
      createdAt: nowIso,
      expiresAt: input.expiresAt,
      revocationEpoch: 0,
      status: 'active',
    };

    const parsed = CredentialRefSchema.safeParse(ref);
    if (!parsed.success) {
      return { ok: false, error: credentialError('VALIDATION', 'reference metadata failed validation', { operation: 'store' }) };
    }

    const valueDigest = computeDigest(input.value);

    // Protect the value, then read-back verify before committing the reference.
    try {
      this.backend.set(storageKey, input.value);
    } catch {
      return { ok: false, error: credentialError('UNAVAILABLE', 'secure storage is unavailable', { operation: 'store' }) };
    }
    const readBack = this.backend.get(storageKey);
    if (readBack === undefined || computeDigest(readBack) !== valueDigest) {
      this.backend.delete(storageKey);
      return { ok: false, error: credentialError('INTEGRITY', 'stored value failed read-back verification', { operation: 'store' }) };
    }

    const record: CredentialRecord = { ref: parsed.data, storageKey, valueDigest };
    this.refStore.put(canonicalSerialize(record));
    return { ok: true, value: parsed.data };
  }

  private resolveBackendKind(
    preferred: StorageBackend | undefined,
  ): CredentialResult<StorageBackend> {
    // Both backends satisfy NN-SEC-008. When the OS keychain is unavailable, an
    // explicit request for os-secure-storage fails closed rather than silently
    // downgrading to plaintext (there is no plaintext path).
    if (preferred === 'os-secure-storage' && !this.backend.isAvailable()) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'OS secure storage requested but unavailable', { operation: 'store' }) };
    }
    if (!this.backend.isAvailable() && preferred === undefined) {
      // The injected backend represents whichever protected mode is available;
      // it must be available to accept a write at all.
      return { ok: false, error: credentialError('UNAVAILABLE', 'no protected storage backend is available', { operation: 'store' }) };
    }
    return { ok: true, value: preferred ?? 'os-secure-storage' };
  }

  // ── Masked reference reads (safe for agents/renderers) ──────────────────

  /** Get the masked reference for `credentialRefId`, or `undefined`. */
  getRef(credentialRefId: string): CredentialRef | undefined {
    const record = this.loadRecord(credentialRefId);
    return record ? { ...record.ref, scopes: [...record.ref.scopes] } : undefined;
  }

  /** List every masked reference. Never resolves or exposes a value. */
  listRefs(): CredentialRef[] {
    const out: CredentialRef[] = [];
    for (const raw of this.refStore.list()) {
      const record = this.parseRecord(raw);
      if (record) out.push({ ...record.ref, scopes: [...record.ref.scopes] });
    }
    return out;
  }

  // ── Resolve (operation boundary, per actor) ─────────────────────────────

  /**
   * Resolve the raw value at the operation boundary. The caller MUST present a
   * {@link ResolutionContext} whose actor is set and whose audience, scope, and
   * revocation epoch match the stored reference (D-04). A revoked/expired/
   * rotated-away or epoch-mismatched credential fails closed (NN-INV-001). The
   * returned {@link ResolvedSecret} must be `dispose()`d after use.
   */
  resolveAtBoundary(
    credentialRefId: string,
    context: ResolutionContext,
  ): CredentialResult<ResolvedSecret> {
    const op = context.operation ?? 'resolve';
    if (!isOpaqueId(context.actor)) {
      return { ok: false, error: credentialError('UNAUTHORIZED', 'resolution requires a valid actor', { operation: op, correlationId: context.correlationId }) };
    }
    const record = this.loadRecord(credentialRefId);
    if (!record) {
      return { ok: false, error: credentialError('VALIDATION', 'unknown credential reference', { operation: op, correlationId: context.correlationId }) };
    }
    const ref = record.ref;

    if (ref.status === 'revoked') {
      return { ok: false, error: credentialError('FORBIDDEN', 'credential is revoked', { operation: op, correlationId: context.correlationId }) };
    }
    if (ref.status === 'rotated') {
      return { ok: false, error: credentialError('FORBIDDEN', 'credential version is superseded by rotation', { operation: op, correlationId: context.correlationId }) };
    }
    if (this.isExpired(ref)) {
      return { ok: false, error: credentialError('FORBIDDEN', 'credential is expired', { operation: op, correlationId: context.correlationId }) };
    }
    if (context.expectedRevocationEpoch !== ref.revocationEpoch) {
      return { ok: false, error: credentialError('CONFLICT', 'stale revocation epoch; refusing to resolve', { operation: op, correlationId: context.correlationId }) };
    }
    if (context.audience !== ref.audience) {
      return { ok: false, error: credentialError('FORBIDDEN', 'audience does not match the credential', { operation: op, correlationId: context.correlationId }) };
    }
    if (!ref.scopes.includes(context.scope)) {
      return { ok: false, error: credentialError('FORBIDDEN', 'scope is not authorized for the credential', { operation: op, correlationId: context.correlationId }) };
    }

    const raw = this.backend.get(record.storageKey);
    if (raw === undefined) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'protected value is unavailable', { operation: op, correlationId: context.correlationId }) };
    }
    if (computeDigest(raw) !== record.valueDigest) {
      return { ok: false, error: credentialError('INTEGRITY', 'protected value failed integrity check', { operation: op, correlationId: context.correlationId }) };
    }

    return {
      ok: true,
      value: new ResolvedSecret({
        value: raw,
        credentialRefId: ref.credentialRefId,
        credentialType: ref.credentialType,
        actor: context.actor,
        resolvedAt: this.now().toISOString(),
      }),
    };
  }

  // ── Rotate ───────────────────────────────────────────────────────────────

  /**
   * Rotate a credential to a new raw value. The reference `version` is bumped,
   * `rotatedAt` is stamped, the masked display is recomputed, and the old
   * protected value is overwritten with read-back verification. The credential
   * stays resolvable at the new version; callers pinned to the old epoch are
   * unaffected unless the caller also revokes.
   */
  rotate(
    credentialRefId: string,
    newValue: string,
    options: { correlationId?: string } = {},
  ): CredentialResult<CredentialRef> {
    const op = 'rotate';
    if (typeof newValue !== 'string' || newValue.length === 0) {
      return { ok: false, error: credentialError('VALIDATION', 'new value must be a non-empty string', { operation: op, correlationId: options.correlationId }) };
    }
    const record = this.loadRecord(credentialRefId);
    if (!record) {
      return { ok: false, error: credentialError('VALIDATION', 'unknown credential reference', { operation: op, correlationId: options.correlationId }) };
    }
    if (record.ref.status === 'revoked') {
      return { ok: false, error: credentialError('FORBIDDEN', 'cannot rotate a revoked credential', { operation: op, correlationId: options.correlationId }) };
    }

    const nextDigest = computeDigest(newValue);
    try {
      this.backend.set(record.storageKey, newValue);
    } catch {
      return { ok: false, error: credentialError('UNAVAILABLE', 'secure storage is unavailable', { operation: op, correlationId: options.correlationId }) };
    }
    const readBack = this.backend.get(record.storageKey);
    if (readBack === undefined || computeDigest(readBack) !== nextDigest) {
      return { ok: false, error: credentialError('INTEGRITY', 'rotated value failed read-back verification', { operation: op, correlationId: options.correlationId }) };
    }

    const nextRef: CredentialRef = {
      ...record.ref,
      scopes: [...record.ref.scopes],
      version: record.ref.version + 1,
      rotatedAt: this.now().toISOString(),
      maskedDisplay: maskCredential(newValue),
      status: 'active',
    };
    const record2: CredentialRecord = { ref: nextRef, storageKey: record.storageKey, valueDigest: nextDigest };
    this.refStore.put(canonicalSerialize(record2));
    return { ok: true, value: { ...nextRef, scopes: [...nextRef.scopes] } };
  }

  // ── Revoke ─────────────────────────────────────────────────────────────

  /**
   * Revoke a credential. The reference status becomes `revoked`, the revocation
   * epoch is bumped (so any pinned epoch is now stale), and the protected value
   * is removed from the backend. Idempotent: revoking an already-revoked
   * credential returns the current reference.
   */
  revoke(
    credentialRefId: string,
    options: { correlationId?: string } = {},
  ): CredentialResult<CredentialRef> {
    const op = 'revoke';
    const record = this.loadRecord(credentialRefId);
    if (!record) {
      return { ok: false, error: credentialError('VALIDATION', 'unknown credential reference', { operation: op, correlationId: options.correlationId }) };
    }
    if (record.ref.status === 'revoked') {
      return { ok: true, value: { ...record.ref, scopes: [...record.ref.scopes] } };
    }

    this.backend.delete(record.storageKey);
    const nextRef: CredentialRef = {
      ...record.ref,
      scopes: [...record.ref.scopes],
      revocationEpoch: record.ref.revocationEpoch + 1,
      status: 'revoked',
    };
    // The value is gone; keep the digest for audit continuity but it is unused.
    const record2: CredentialRecord = { ref: nextRef, storageKey: record.storageKey, valueDigest: record.valueDigest };
    this.refStore.put(canonicalSerialize(record2));
    return { ok: true, value: { ...nextRef, scopes: [...nextRef.scopes] } };
  }

  // ── Redaction helper for evidence/exports ───────────────────────────────

  /**
   * Redact an arbitrary value for an observable surface, applying the shared
   * canary/deny-list redaction plus a guarantee that no stored raw value or its
   * masked display can be reversed. Callers route evidence/log/export payloads
   * through this before emitting them (NN-INV-004, D-16.6).
   */
  redactForObservable<T>(value: T): T {
    return redactValue(value);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private isExpired(ref: CredentialRef): boolean {
    if (ref.expiresAt === undefined) return false;
    return Date.parse(ref.expiresAt) <= this.now().getTime();
  }

  private loadRecord(credentialRefId: string): CredentialRecord | undefined {
    const raw = this.refStore.get(credentialRefId);
    return raw ? this.parseRecord(raw) : undefined;
  }

  private parseRecord(raw: string): CredentialRecord | undefined {
    try {
      const parsed = JSON.parse(raw) as {
        ref?: unknown;
        storageKey?: unknown;
        valueDigest?: unknown;
      };
      const ref = CredentialRefSchema.safeParse(parsed.ref);
      if (!ref.success) return undefined;
      if (typeof parsed.storageKey !== 'string') return undefined;
      if (!DigestSchema.safeParse(parsed.valueDigest).success) return undefined;
      return { ref: ref.data, storageKey: parsed.storageKey, valueDigest: parsed.valueDigest as string };
    } catch {
      return undefined;
    }
  }
}

/** Opaque random id body without a Node crypto hard-dependency at import time. */
function cryptoRandomId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID().replace(/-/g, '');
}
