/**
 * Credential Service / Auth Broker — the single Credential Authority
 * (FUT-PKG-04-SECURITY/T-002, D-04 CredentialRef ownership).
 *
 * This main-process authority is the one place that stores credentials and
 * resolves raw values. It satisfies the NN-SEC-008 secret authority:
 *
 *   - Every raw value is stored in **OS secure storage** (Electron
 *     `safeStorage`, which delegates to the platform keychain) OR as an
 *     **envelope-encrypted** record (AES-256-GCM) whose wrapping data key is
 *     itself protected by the OS secure store via {@link KeyProvider}.
 *     Plaintext is never persisted in either mode.
 *   - Agents and renderers receive only a masked {@link MaskedCredentialView}
 *     built from `CredentialRef@1`; the ref carries no raw-value field.
 *   - Raw values are resolved only at the operation boundary through
 *     {@link CredentialService.resolveAtBoundary}, scoped per actor and audience
 *     and gated on the current revocation epoch.
 *   - Rotation and revocation advance the `revocationEpoch`, so any reference a
 *     caller already holds becomes non-resolvable.
 *
 * The typed credential *class* (never a regex/prefix guess) selects validation
 * (NN-IDENT-007), and the typed Auth Broker classification lives in the shared
 * {@link classifyAuthScheme} broker (NN-PROXY-001/003).
 *
 * Migration (CD-015 / CD-020) is rescue-backed and reversible: legacy plaintext
 * or scattered records are written to protected storage, read-back verified,
 * the config/renderer state atomically replaced with a `CredentialRef@1`, the
 * observable surfaces scanned, and only then is the legacy location
 * **quarantined** (never deleted). A failed step leaves the legacy record in
 * place and the credential unavailable — no plaintext fallback (task rule).
 *
 * Design anchors: D-04, D-07, D-16, D-20.
 * Requirements: NN-INV-004/006, NN-SEC-008/009, NN-IDENT-007,
 * NN-PROXY-001–005/008/015, NN-COMPAT-012, CD-004/015/020.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorEnvelope,
} from '../../shared/contract-primitives.js';
import {
  CredentialRefSchema,
  StorageBackendSchema,
  assertNoRawValueField,
  credentialError,
  maskSecret,
  toMaskedView,
  type CredentialRef,
  type CredentialStatus,
  type CredentialType,
  type MaskedCredentialView,
  type StorageBackend,
} from '../../shared/credential-authority.js';
import { containsRedactableContent } from '../../shared/observable-redaction.js';

// ─── Adapters (shared with proxy-credential-service) ────────────────────────

/** Electron `safeStorage`-shaped adapter for OS secure storage. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/**
 * Wrapping-key provider whose key material is protected by the OS secure store
 * (macOS Keychain / Windows DPAPI / Linux secret-service). Mirrors
 * `src/storage/encrypted-blob-store.ts` `KeyProvider`.
 */
export interface KeyProvider {
  getKey(): Buffer | null;
  getKeyId(): string;
  isAvailable(): boolean;
}

// ─── Storage envelope ────────────────────────────────────────────────────────

const OsSecureEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protection: z.literal('os-secure-store'),
  ciphertext: z.string().min(1),
});

const AesEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protection: z.literal('envelope-encrypted'),
  keyId: z.string().min(1),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  authTag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().min(1),
});

const ProtectedEnvelopeSchema = z.discriminatedUnion('protection', [
  OsSecureEnvelopeSchema,
  AesEnvelopeSchema,
]);

type ProtectedEnvelope = z.infer<typeof ProtectedEnvelopeSchema>;

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** A request to store a new credential. The raw value is protected, never persisted plaintext. */
export interface StoreCredentialInput {
  readonly credentialType: CredentialType;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  /** The raw secret value. Consumed for storage; never retained by the ref. */
  readonly rawValue: string;
  readonly expiresAt?: string;
  /** Reveal a short tail in the masked display (recognition aid only). */
  readonly revealTail?: boolean;
}

/** The actor + audience + scope presented at the operation boundary. */
export interface ResolutionActor {
  /** The requesting principal id (per-actor scoping, NN-SEC-008). */
  readonly actor: string;
  /** The audience the caller intends to use the secret for. */
  readonly audience: string;
  /** The revocation epoch the caller believes is current. */
  readonly presentedEpoch: number;
  /** The scope the caller needs; must be a subset of the credential's scopes. */
  readonly requiredScopes?: readonly string[];
}

/** A resolution outcome. `raw` is present only on success and must not be stored. */
export type ResolutionResult =
  | { readonly ok: true; readonly raw: string; readonly ref: MaskedCredentialView }
  | { readonly ok: false; readonly error: ErrorEnvelope };

export interface CredentialServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

class ProtectedStorageUnavailableError extends Error {
  constructor() {
    super('protected credential storage is unavailable');
    this.name = 'ProtectedStorageUnavailableError';
  }
}

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

/**
 * Ensure the authority tables exist. `credential_refs` holds `CredentialRef@1`
 * records (no secret); `secrets_v2` (migration 033) holds the protected
 * envelopes keyed by the ref's protected storage key; `credential_quarantine`
 * holds rescue-backed migration originals that could not be verified.
 */
export function ensureCredentialTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets_v2 (
      key TEXT PRIMARY KEY,
      envelope TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS credential_refs (
      credential_ref_id TEXT PRIMARY KEY,
      storage_key TEXT NOT NULL,
      ref_json TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS credential_quarantine (
      quarantine_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      reason TEXT NOT NULL,
      envelope TEXT NOT NULL,
      quarantined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─── Credential Service ────────────────────────────────────────────────────────

export class CredentialService {
  private readonly db: Database.Database;
  private readonly safeStorage: SafeStorageAdapter;
  private readonly keyProvider: KeyProvider;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    db: Database.Database,
    safeStorage: SafeStorageAdapter,
    keyProvider: KeyProvider,
    options: CredentialServiceOptions = {},
  ) {
    this.db = db;
    this.safeStorage = safeStorage;
    this.keyProvider = keyProvider;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString('hex'));
    ensureCredentialTables(db);
  }

  // ── Store (create) ──────────────────────────────────────────────────────────

  /**
   * Store a new credential. The raw value is protected (OS secure store or
   * envelope-encrypted) and read-back verified before the `CredentialRef@1` is
   * persisted. On any failure nothing is committed and the protected row is
   * removed, so a half-written credential is never left resolvable.
   *
   * Returns the masked view; the raw value is never returned here.
   */
  store(input: StoreCredentialInput): { ok: true; ref: MaskedCredentialView } | { ok: false; error: ErrorEnvelope } {
    if (typeof input.rawValue !== 'string' || input.rawValue.length === 0) {
      return { ok: false, error: credentialError('VALIDATION', 'raw credential value must be non-empty', { operation: 'credential:store' }) };
    }

    const credentialRefId = makeOpaqueId('credref', this.createId());
    const storageKey = `credential:${credentialRefId}`;
    const createdAt = this.now().toISOString();

    let backend: StorageBackend;
    try {
      backend = this.writeProtected(storageKey, input.rawValue);
    } catch (error) {
      if (error instanceof ProtectedStorageUnavailableError) {
        return { ok: false, error: credentialError('UNAVAILABLE', 'protected credential storage is unavailable; refusing to store in plaintext', { operation: 'credential:store' }) };
      }
      return { ok: false, error: credentialError('INTERNAL', 'failed to protect credential value', { operation: 'credential:store' }) };
    }

    // Read-back verification (NN-INV-006 recoverability before mutation).
    const readBack = this.readProtected(storageKey);
    if (readBack !== input.rawValue) {
      this.removeProtected(storageKey);
      return { ok: false, error: credentialError('INTEGRITY', 'stored credential failed read-back verification', { operation: 'credential:store' }) };
    }

    const ref: CredentialRef = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      credentialRefId,
      credentialType: input.credentialType,
      issuer: input.issuer,
      audience: input.audience,
      subject: input.subject,
      scopes: [...input.scopes],
      version: 1,
      storageBackend: backend,
      maskedDisplay: maskSecret(input.rawValue, { revealTail: input.revealTail }),
      createdAt,
      expiresAt: input.expiresAt,
      revocationEpoch: 0,
      status: 'active',
    };

    const parsed = CredentialRefSchema.safeParse(ref);
    if (!parsed.success) {
      this.removeProtected(storageKey);
      return { ok: false, error: credentialError('VALIDATION', 'credential metadata failed contract validation', { operation: 'credential:store' }) };
    }

    try {
      this.persistRef(parsed.data, storageKey);
    } catch {
      this.removeProtected(storageKey);
      return { ok: false, error: credentialError('INTERNAL', 'failed to persist credential reference', { operation: 'credential:store' }) };
    }

    return { ok: true, ref: toMaskedView(parsed.data) };
  }

  // ── Masked inspection (renderer/agent-safe) ──────────────────────────────────

  /** Return the masked view for a credential ref, or undefined if unknown. */
  getMaskedView(credentialRefId: string): MaskedCredentialView | undefined {
    const ref = this.loadRef(credentialRefId);
    return ref ? toMaskedView(ref) : undefined;
  }

  /** List every credential as masked views (never raw). */
  listMaskedViews(): MaskedCredentialView[] {
    return this.loadAllRefs().map((ref) => toMaskedView(ref));
  }

  /** The current revocation epoch a resolver must present, or undefined. */
  getCurrentEpoch(credentialRefId: string): number | undefined {
    return this.loadRef(credentialRefId)?.revocationEpoch;
  }

  // ── Resolve at the operation boundary (per actor) ────────────────────────────

  /**
   * Resolve the raw value AT THE OPERATION BOUNDARY, scoped per actor. The
   * caller must present the current revocation epoch, an audience matching the
   * credential, and (optionally) a scope subset. Any mismatch, an inactive
   * status, or an expired credential returns a typed error with no raw value.
   *
   * The returned `raw` must be used immediately and never stored, logged, or
   * placed in any command/event/evidence payload (NN-SEC-008, NN-INV-004).
   */
  resolveAtBoundary(credentialRefId: string, actor: ResolutionActor): ResolutionResult {
    const op = 'credential:resolve';
    const ref = this.loadRef(credentialRefId);
    if (!ref) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'credential reference not found', { operation: op }) };
    }
    if (ref.status !== 'active') {
      return { ok: false, error: credentialError('FORBIDDEN', `credential is ${ref.status}`, { operation: op }) };
    }
    if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= this.now().getTime()) {
      return { ok: false, error: credentialError('FORBIDDEN', 'credential is expired', { operation: op }) };
    }
    if (actor.presentedEpoch !== ref.revocationEpoch) {
      return { ok: false, error: credentialError('CONFLICT', 'presented revocation epoch is stale; re-fetch the reference', { operation: op }) };
    }
    if (actor.audience !== ref.audience) {
      return { ok: false, error: credentialError('FORBIDDEN', 'audience does not match the credential', { operation: op }) };
    }
    if (actor.requiredScopes && actor.requiredScopes.length > 0) {
      const granted = new Set(ref.scopes);
      const missing = actor.requiredScopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        return { ok: false, error: credentialError('FORBIDDEN', `requested scope not granted (${missing.length} missing)`, { operation: op }) };
      }
    }

    const storageKey = this.loadStorageKey(credentialRefId);
    if (!storageKey) {
      return { ok: false, error: credentialError('INTEGRITY', 'credential reference has no protected storage binding', { operation: op }) };
    }
    const raw = this.readProtected(storageKey);
    if (raw === undefined) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'protected credential value could not be resolved', { operation: op }) };
    }
    return { ok: true, raw, ref: toMaskedView(ref) };
  }

  // ── Rotate ────────────────────────────────────────────────────────────────

  /**
   * Rotate the credential to a new raw value. The new value is protected and
   * read-back verified before the ref is updated; the `revocationEpoch` and
   * `version` advance so any previously handed-out reference is rejected on its
   * next resolution. The old protected value is removed only after the new one
   * verifies.
   */
  rotate(credentialRefId: string, newRawValue: string, options: { revealTail?: boolean } = {}): { ok: true; ref: MaskedCredentialView } | { ok: false; error: ErrorEnvelope } {
    const op = 'credential:rotate';
    if (typeof newRawValue !== 'string' || newRawValue.length === 0) {
      return { ok: false, error: credentialError('VALIDATION', 'new credential value must be non-empty', { operation: op }) };
    }
    const ref = this.loadRef(credentialRefId);
    const oldStorageKey = this.loadStorageKey(credentialRefId);
    if (!ref || !oldStorageKey) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'credential reference not found', { operation: op }) };
    }

    const newStorageKey = `credential:${credentialRefId}:v${ref.version + 1}`;
    let backend: StorageBackend;
    try {
      backend = this.writeProtected(newStorageKey, newRawValue);
    } catch (error) {
      if (error instanceof ProtectedStorageUnavailableError) {
        return { ok: false, error: credentialError('UNAVAILABLE', 'protected credential storage is unavailable; rotation refused', { operation: op }) };
      }
      return { ok: false, error: credentialError('INTERNAL', 'failed to protect rotated value', { operation: op }) };
    }
    if (this.readProtected(newStorageKey) !== newRawValue) {
      this.removeProtected(newStorageKey);
      return { ok: false, error: credentialError('INTEGRITY', 'rotated credential failed read-back verification', { operation: op }) };
    }

    const rotated: CredentialRef = {
      ...ref,
      version: ref.version + 1,
      storageBackend: backend,
      maskedDisplay: maskSecret(newRawValue, { revealTail: options.revealTail }),
      rotatedAt: this.now().toISOString(),
      revocationEpoch: ref.revocationEpoch + 1,
      status: 'active',
    };
    const parsed = CredentialRefSchema.safeParse(rotated);
    if (!parsed.success) {
      this.removeProtected(newStorageKey);
      return { ok: false, error: credentialError('VALIDATION', 'rotated metadata failed contract validation', { operation: op }) };
    }

    try {
      this.persistRef(parsed.data, newStorageKey);
    } catch {
      this.removeProtected(newStorageKey);
      return { ok: false, error: credentialError('INTERNAL', 'failed to persist rotated reference', { operation: op }) };
    }
    // Old protected value is now superseded; remove it.
    if (oldStorageKey !== newStorageKey) this.removeProtected(oldStorageKey);
    return { ok: true, ref: toMaskedView(parsed.data) };
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * Revoke a credential. The status becomes `revoked`, the epoch advances so
   * held references stop resolving, and the protected value is removed. The ref
   * record is retained (masked) for audit/provenance (NN-IDENT-006).
   */
  revoke(credentialRefId: string): { ok: true; ref: MaskedCredentialView } | { ok: false; error: ErrorEnvelope } {
    const op = 'credential:revoke';
    const ref = this.loadRef(credentialRefId);
    const storageKey = this.loadStorageKey(credentialRefId);
    if (!ref || !storageKey) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'credential reference not found', { operation: op }) };
    }
    const revoked: CredentialRef = {
      ...ref,
      status: 'revoked',
      revocationEpoch: ref.revocationEpoch + 1,
      rotatedAt: this.now().toISOString(),
    };
    const parsed = CredentialRefSchema.parse(revoked);
    this.persistRef(parsed, storageKey);
    this.removeProtected(storageKey);
    return { ok: true, ref: toMaskedView(parsed) };
  }

  // ── Rescue-backed, reversible migration (CD-015 / CD-020) ────────────────────

  /**
   * Migrate a scattered/plaintext legacy secret into the authority. The flow is
   * additive and reversible:
   *
   *   1. Protect the legacy raw value (OS secure store / envelope).
   *   2. Read-back verify.
   *   3. Persist the `CredentialRef@1` and atomically clear the legacy location
   *      via the supplied `clearLegacy` callback (e.g. delete a plaintext config
   *      key). The legacy value is first copied into `credential_quarantine`
   *      as a recoverable rescue copy so the cutover is reversible.
   *
   * On any failure BEFORE the cutover, nothing is committed and the legacy
   * location is left intact — no plaintext fallback, no forwarding. The rescue
   * copy is what a rollback restores; the authority never re-enables a
   * plaintext reader after a verified cutover.
   */
  migrateLegacySecret(input: {
    readonly origin: string;
    readonly rawValue: string;
    readonly credential: Omit<StoreCredentialInput, 'rawValue'>;
    /** Clears the legacy plaintext location. Called only after verification. */
    readonly clearLegacy: () => void;
  }): { ok: true; ref: MaskedCredentialView } | { ok: false; error: ErrorEnvelope; quarantined: boolean } {
    const op = 'credential:migrate';
    if (typeof input.rawValue !== 'string' || input.rawValue.length === 0) {
      return { ok: false, quarantined: false, error: credentialError('VALIDATION', 'legacy secret value must be non-empty', { operation: op }) };
    }

    // Rescue copy FIRST so the cutover is reversible (NN-INV-006).
    const quarantineId = this.quarantineLegacy(input.origin, 'migration-rescue', input.rawValue);
    if (quarantineId === undefined) {
      return { ok: false, quarantined: false, error: credentialError('UNAVAILABLE', 'could not create rescue copy; migration blocked', { operation: op }) };
    }

    const stored = this.store({ ...input.credential, rawValue: input.rawValue });
    if (!stored.ok) {
      // Rescue copy remains; legacy untouched. No plaintext fallback.
      return { ok: false, quarantined: true, error: stored.error };
    }

    // Cutover: clear the legacy plaintext location now that the protected copy
    // is verified and the rescue copy exists.
    try {
      input.clearLegacy();
    } catch {
      // Cutover clearing failed; the protected credential still exists and the
      // rescue copy remains. Report but do not roll back the protected write.
      return { ok: false, quarantined: true, error: credentialError('INTERNAL', 'legacy location could not be cleared; left quarantined', { operation: op }) };
    }
    return { ok: true, ref: stored.ref };
  }

  /**
   * Restore a quarantined rescue copy back to a live credential (rollback path).
   * This restores a *verified protected reference*, never a plaintext location
   * (task rollback rule). Returns the new masked view.
   */
  restoreFromQuarantine(quarantineId: string, credential: Omit<StoreCredentialInput, 'rawValue'>): { ok: true; ref: MaskedCredentialView } | { ok: false; error: ErrorEnvelope } {
    const op = 'credential:restore';
    const raw = this.readQuarantine(quarantineId);
    if (raw === undefined) {
      return { ok: false, error: credentialError('UNAVAILABLE', 'quarantined rescue copy not found or unreadable', { operation: op }) };
    }
    return this.store({ ...credential, rawValue: raw });
  }

  /** List quarantine origins (never values) for diagnostics. */
  listQuarantineOrigins(): { quarantineId: string; origin: string; reason: string }[] {
    return (
      this.db
        .prepare('SELECT quarantine_id, origin, reason FROM credential_quarantine')
        .all() as { quarantine_id: string; origin: string; reason: string }[]
    ).map((r) => ({ quarantineId: r.quarantine_id, origin: r.origin, reason: r.reason }));
  }

  // ── Secret-canary scan (defense-in-depth, NN-INV-004) ────────────────────────

  /**
   * Scan an observable payload (already destined for a log/renderer/export/etc.)
   * and report whether it still contains string-shaped secret material. This is
   * a defense-in-depth check on top of schema classification; the authority
   * itself never emits raw values, so a positive result on an authority-built
   * payload indicates a defect. Returns true when the payload is clean.
   */
  scanObservablePayloadClean(serializedPayload: string): boolean {
    return !containsRedactableContent(serializedPayload);
  }

  // ── Storage primitives ────────────────────────────────────────────────────

  /** Write a protected envelope, preferring OS secure storage. Returns the backend used. */
  private writeProtected(storageKey: string, value: string): StorageBackend {
    const envelope = this.safeStorage.isEncryptionAvailable()
      ? this.encryptWithSafeStorage(value)
      : this.encryptWithEnvelope(value);
    this.db
      .prepare(
        `INSERT INTO secrets_v2 (key, envelope, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET envelope = excluded.envelope, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(storageKey, JSON.stringify(envelope));
    return StorageBackendSchema.parse(envelope.protection);
  }

  private readProtected(storageKey: string): string | undefined {
    const row = this.db.prepare('SELECT envelope FROM secrets_v2 WHERE key = ?').get(storageKey) as { envelope: string } | undefined;
    if (!row) return undefined;
    return this.decryptEnvelope(row.envelope);
  }

  private removeProtected(storageKey: string): void {
    this.db.prepare('DELETE FROM secrets_v2 WHERE key = ?').run(storageKey);
  }

  private decryptEnvelope(raw: string): string | undefined {
    let envelope: ProtectedEnvelope;
    try {
      envelope = ProtectedEnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
    try {
      if (envelope.protection === 'os-secure-store') {
        if (!this.safeStorage.isEncryptionAvailable()) return undefined;
        return this.safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
      }
      const key = this.keyProvider.getKey();
      if (!key || key.length !== 32 || this.keyProvider.getKeyId() !== envelope.keyId) {
        return undefined;
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private encryptWithSafeStorage(value: string): z.infer<typeof OsSecureEnvelopeSchema> {
    return {
      schemaVersion: 1,
      protection: 'os-secure-store',
      ciphertext: this.safeStorage.encryptString(value).toString('base64'),
    };
  }

  private encryptWithEnvelope(value: string): z.infer<typeof AesEnvelopeSchema> {
    const key = this.keyProvider.getKey();
    if (!key || key.length !== 32) {
      throw new ProtectedStorageUnavailableError();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      schemaVersion: 1,
      protection: 'envelope-encrypted',
      keyId: this.keyProvider.getKeyId(),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  // ── Ref persistence ─────────────────────────────────────────────────────────

  private persistRef(ref: CredentialRef, storageKey: string): void {
    assertNoRawValueField(ref);
    this.db
      .prepare(
        `INSERT INTO credential_refs (credential_ref_id, storage_key, ref_json, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(credential_ref_id) DO UPDATE SET
           storage_key = excluded.storage_key,
           ref_json = excluded.ref_json,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(ref.credentialRefId, storageKey, JSON.stringify(ref));
  }

  private loadRef(credentialRefId: string): CredentialRef | undefined {
    const row = this.db.prepare('SELECT ref_json FROM credential_refs WHERE credential_ref_id = ?').get(credentialRefId) as { ref_json: string } | undefined;
    if (!row) return undefined;
    const parsed = CredentialRefSchema.safeParse(JSON.parse(row.ref_json));
    return parsed.success ? parsed.data : undefined;
  }

  private loadStorageKey(credentialRefId: string): string | undefined {
    const row = this.db.prepare('SELECT storage_key FROM credential_refs WHERE credential_ref_id = ?').get(credentialRefId) as { storage_key: string } | undefined;
    return row?.storage_key;
  }

  private loadAllRefs(): CredentialRef[] {
    const rows = this.db.prepare('SELECT ref_json FROM credential_refs').all() as { ref_json: string }[];
    const out: CredentialRef[] = [];
    for (const row of rows) {
      const parsed = CredentialRefSchema.safeParse(JSON.parse(row.ref_json));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  // ── Quarantine ──────────────────────────────────────────────────────────────

  /** Protect and store a legacy value as a recoverable rescue copy. */
  private quarantineLegacy(origin: string, reason: string, rawValue: string): string | undefined {
    let envelope: ProtectedEnvelope;
    try {
      envelope = this.safeStorage.isEncryptionAvailable()
        ? this.encryptWithSafeStorage(rawValue)
        : this.encryptWithEnvelope(rawValue);
    } catch {
      return undefined;
    }
    const quarantineId = makeOpaqueId('cquar', this.createId());
    this.db
      .prepare('INSERT INTO credential_quarantine (quarantine_id, origin, reason, envelope) VALUES (?, ?, ?, ?)')
      .run(quarantineId, origin, reason, JSON.stringify(envelope));
    // Verify the rescue copy is readable before trusting it.
    if (this.readQuarantine(quarantineId) !== rawValue) {
      this.db.prepare('DELETE FROM credential_quarantine WHERE quarantine_id = ?').run(quarantineId);
      return undefined;
    }
    return quarantineId;
  }

  private readQuarantine(quarantineId: string): string | undefined {
    const row = this.db.prepare('SELECT envelope FROM credential_quarantine WHERE quarantine_id = ?').get(quarantineId) as { envelope: string } | undefined;
    if (!row) return undefined;
    return this.decryptEnvelope(row.envelope);
  }

  // ── Serialization safety ─────────────────────────────────────────────────────

  /** No secrets leak through JSON serialization of the service itself. */
  toJSON(): Record<string, unknown> {
    return {
      refCount: (this.db.prepare('SELECT COUNT(*) AS c FROM credential_refs').get() as { c: number }).c,
      quarantineCount: (this.db.prepare('SELECT COUNT(*) AS c FROM credential_quarantine').get() as { c: number }).c,
    };
  }
}

/** Stable digest of a masked view — safe to use as an evidence artifact ref. */
export function maskedViewDigest(view: MaskedCredentialView): string {
  return computeDigest(view);
}

/** Re-exported for callers that only need the status union. */
export type { CredentialStatus };
