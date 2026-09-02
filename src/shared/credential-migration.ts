/**
 * Rescue-backed, reversible migration of scattered/plaintext secret stores into
 * the one Credential Authority (FUT-PKG-04-SECURITY/T-002, D-20).
 *
 * Task 0.4 inventory found 4+ credential owner classes (BLOCKS-CUTOVER B2):
 * `src/security/credential-vault.ts`, `src/harness/credentials/credential-
 * service.ts`, `src/main/proxy-credential-service.ts`,
 * `src/main/auth/sqlite-credential-store.ts`, `src/main/auth/credential-
 * store.ts`, plus `src/main/app-secrets.ts` / `src/main/secret-loader.ts`.
 * This module folds each legacy source into the single {@link CredentialService}
 * authority without deleting anything the operator might still need to recover.
 *
 * The migration follows the D-20 secret stream rule and NN-INV-006:
 *
 *   1. Read each legacy entry through a {@link LegacySecretSource} adapter
 *      (read-old), classifying it by credential type.
 *   2. Store it in the authority (write-new) in a protected backend, with a
 *      read-back verify (the authority does this internally).
 *   3. Quarantine the legacy location — move the raw entry into a sealed
 *      quarantine record set rather than deleting it. Nothing is destroyed.
 *   4. Emit a {@link MigrationReport} that references every migrated secret by
 *      key name only, never by value (NN-INV-004).
 *
 * Rollback restores a *read adapter* over the quarantined entries — it never
 * re-enables a plaintext fallback and never revives a plaintext writer
 * (task rollback rule: "rollback restores a read adapter, never a plaintext
 * fallback").
 *
 * Design anchors: D-04, D-20. Requirements: NN-SEC-008, NN-INV-004, NN-INV-006,
 * NN-DATA-001, NN-LICENSE-001.
 */

import { canonicalSerialize, computeDigest } from './contract-primitives';
import {
  CredentialService,
  type CredentialRef,
  type CredentialType,
  type StorageBackend,
} from './credential-service';

// ─── Legacy source adapter ──────────────────────────────────────────────────

/** One legacy secret entry to migrate. Carries the raw value transiently. */
export interface LegacySecretEntry {
  /** The legacy location key (e.g. vault name, env var, provider key). */
  readonly legacyKey: string;
  /** The originating legacy store, for the quarantine + audit trail. */
  readonly sourceId: string;
  readonly credentialType: CredentialType;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  /** The raw secret value read from the legacy store. */
  readonly value: string;
  /** Optional deterministic ref id to assign in the authority. */
  readonly credentialRefId?: string;
}

/**
 * A read-only adapter over a legacy credential store. Implementations wrap the
 * `CredentialVault`, `secrets_v2`/proxy service, env `SecretLoader`, etc. The
 * migration only ever *reads* through this port.
 */
export interface LegacySecretSource {
  readonly sourceId: string;
  /** Enumerate every legacy entry (reading its raw value for migration). */
  readEntries(): readonly LegacySecretEntry[];
}

// ─── Quarantine ─────────────────────────────────────────────────────────────

/**
 * A sealed record of a legacy entry that has been migrated. The raw value is
 * retained here (encrypted at the sink layer) as the sole recoverable copy,
 * kept outside normal use so rollback can restore a read adapter. It is never
 * logged or exported (NN-INV-004).
 */
export interface QuarantineRecord {
  readonly sourceId: string;
  readonly legacyKey: string;
  readonly credentialRefId: string;
  readonly quarantinedAt: string;
  /** Digest of the raw value, for verification. Never the value itself. */
  readonly valueDigest: string;
  /** The retained raw value. Held only inside the quarantine sink. */
  readonly value: string;
}

/**
 * Where quarantined legacy entries are held. Production backs this with an
 * OS-protected/encrypted store; the raw value never touches plaintext logs. An
 * in-memory implementation is provided for tests.
 */
export interface QuarantineSink {
  seal(record: QuarantineRecord): void;
  get(sourceId: string, legacyKey: string): QuarantineRecord | undefined;
  list(): readonly QuarantineRecord[];
}

/** In-memory quarantine sink. Its map is not serialized (NN-INV-004). */
export class InMemoryQuarantineSink implements QuarantineSink {
  private readonly records = new Map<string, QuarantineRecord>();

  private static keyOf(sourceId: string, legacyKey: string): string {
    return `${sourceId}::${legacyKey}`;
  }

  seal(record: QuarantineRecord): void {
    this.records.set(InMemoryQuarantineSink.keyOf(record.sourceId, record.legacyKey), record);
  }

  get(sourceId: string, legacyKey: string): QuarantineRecord | undefined {
    return this.records.get(InMemoryQuarantineSink.keyOf(sourceId, legacyKey));
  }

  list(): readonly QuarantineRecord[] {
    return Array.from(this.records.values());
  }

  toJSON(): Record<string, unknown> {
    return { kind: 'in-memory-quarantine', entries: this.records.size };
  }
}

// ─── Migration report (references by key name only) ─────────────────────────

export interface MigratedEntry {
  readonly sourceId: string;
  readonly legacyKey: string;
  readonly credentialRefId: string;
  readonly credentialType: CredentialType;
  readonly storageBackend: StorageBackend;
  readonly maskedDisplay: string;
}

export interface FailedEntry {
  readonly sourceId: string;
  readonly legacyKey: string;
  /** Typed error code from the authority (VALIDATION/UNAVAILABLE/INTEGRITY…). */
  readonly code: string;
  readonly message: string;
}

/**
 * The outcome of a migration run. It references migrated secrets by
 * source/legacyKey/refId only; no value or masked-prefix appears (NN-INV-004).
 * `digest` is a stable digest of the (value-free) report body for evidence.
 */
export interface MigrationReport {
  readonly migrated: readonly MigratedEntry[];
  readonly failed: readonly FailedEntry[];
  readonly quarantinedCount: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly digest: string;
}

// ─── Migrator ────────────────────────────────────────────────────────────────

export interface CredentialMigratorOptions {
  readonly service: CredentialService;
  readonly quarantine: QuarantineSink;
  readonly now?: () => Date;
}

/**
 * Migrates legacy secret sources into the {@link CredentialService} authority
 * and quarantines the legacy entries. It never deletes the legacy value; the
 * quarantine holds the sole recoverable copy so rollback stays possible.
 */
export class CredentialMigrator {
  private readonly service: CredentialService;
  private readonly quarantine: QuarantineSink;
  private readonly now: () => Date;

  constructor(options: CredentialMigratorOptions) {
    this.service = options.service;
    this.quarantine = options.quarantine;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Migrate every entry from every source. For each entry: store in the
   * authority (with read-back verify), then — only if the store succeeded —
   * quarantine the legacy entry. A failed store leaves the legacy entry in
   * place and records a typed failure; nothing is quarantined or lost.
   */
  migrate(sources: readonly LegacySecretSource[]): MigrationReport {
    const startedAt = this.now().toISOString();
    const migrated: MigratedEntry[] = [];
    const failed: FailedEntry[] = [];

    for (const source of sources) {
      for (const entry of source.readEntries()) {
        const result = this.service.store({
          credentialType: entry.credentialType,
          issuer: entry.issuer,
          audience: entry.audience,
          subject: entry.subject,
          scopes: entry.scopes,
          expiresAt: entry.expiresAt,
          value: entry.value,
          credentialRefId: entry.credentialRefId,
        });

        if (!result.ok) {
          failed.push({
            sourceId: source.sourceId,
            legacyKey: entry.legacyKey,
            code: result.error.code,
            message: result.error.message,
          });
          continue;
        }

        const ref: CredentialRef = result.value;
        // Quarantine the legacy entry (retain, do not delete).
        this.quarantine.seal({
          sourceId: source.sourceId,
          legacyKey: entry.legacyKey,
          credentialRefId: ref.credentialRefId,
          quarantinedAt: this.now().toISOString(),
          valueDigest: computeDigest(entry.value),
          value: entry.value,
        });

        migrated.push({
          sourceId: source.sourceId,
          legacyKey: entry.legacyKey,
          credentialRefId: ref.credentialRefId,
          credentialType: ref.credentialType,
          storageBackend: ref.storageBackend,
          maskedDisplay: ref.maskedDisplay,
        });
      }
    }

    const endedAt = this.now().toISOString();
    const body = { migrated, failed, quarantinedCount: this.quarantine.list().length, startedAt, endedAt };
    return { ...body, digest: computeDigest(canonicalSerialize(body)) };
  }
}

// ─── Rollback: read adapter over quarantine (never a plaintext writer) ──────

/**
 * A read-only adapter that exposes quarantined legacy entries after a rollback.
 * It can look up a retained value by refId (verifying the digest) but exposes
 * **no writer** and reinstates **no plaintext fallback** — it is a recovery
 * reader only (task rollback rule). Once cutover is trusted, the quarantine can
 * be retired; until then this reader is the reversible escape hatch.
 */
export class QuarantineReadAdapter {
  private readonly byRefId = new Map<string, QuarantineRecord>();

  constructor(private readonly quarantine: QuarantineSink) {
    for (const record of quarantine.list()) {
      this.byRefId.set(record.credentialRefId, record);
    }
  }

  /** Whether a quarantined entry exists for `credentialRefId`. */
  has(credentialRefId: string): boolean {
    return this.byRefId.has(credentialRefId);
  }

  /**
   * Read a quarantined raw value by refId, verifying its digest. Returns
   * `undefined` on absence or integrity mismatch. This is the sole rollback
   * read path; there is no corresponding write path.
   */
  read(credentialRefId: string): string | undefined {
    const record = this.byRefId.get(credentialRefId);
    if (!record) return undefined;
    if (computeDigest(record.value) !== record.valueDigest) return undefined;
    return record.value;
  }

  /** Enumerate the quarantined refIds available for recovery. */
  refIds(): readonly string[] {
    return Array.from(this.byRefId.keys());
  }
}
