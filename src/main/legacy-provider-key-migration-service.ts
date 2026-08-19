import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY,
  CloudProviderKeysMigrationConfigPayloadSchema,
  LEGACY_KEY_STATUS_UNUSED_VALUE,
  LegacyProviderKeyListV1Schema,
  type CloudProviderKeyMigrationStatus,
  type CloudProviderKeysMigrationConfigPayload,
  type LegacyProviderKeyListV1,
  type LegacyProviderKeyRecordV1,
} from '../shared/app-bootstrap-contracts.js';

/**
 * Legacy Provider-Key Migration Service.
 *
 * Task 5.3 requirements (7.1, 7.2, 7.4, 7.5, 7.7):
 * - Inventory saved cloud provider records without resolving/logging apiKey values.
 * - Mark every key-bearing cloud record as `legacy-unused` before routing cutover.
 * - Preserve compatible provider/model selection metadata (id/type/model/baseUrl).
 * - Store aggregate migration status in `migration:cloud-provider-keys:v1` and
 *   the `enhanced_chat_ui_migration_audit` table without credential material.
 * - Implement transactional, idempotent protected-secret deletion that never
 *   echoes the value.
 *
 * The service intentionally holds no `apiKey` values in memory beyond the
 * minimum needed to detect presence and clear the field. Public method
 * results, audit rows, and status payloads carry only aggregate counts and
 * non-secret metadata.
 */

/**
 * Provider types that always run locally. They are outside the cloud-routing
 * migration boundary and their configured local endpoints must not be touched.
 * Kept in sync with the local set in `src/pipeline/llm-client.ts`.
 */
export const LEGACY_MIGRATION_LOCAL_PROVIDER_TYPES: ReadonlySet<string> =
  new Set(['ollama', 'llamacpp', 'openmythos']);

/** Config-table row key for the saved provider list. */
export const LEGACY_PROVIDERS_CONFIG_KEY = 'providers' as const;

/** Audit ledger key used by both the config payload and the audit table. */
export const CLOUD_PROVIDER_KEYS_MIGRATION_KEY =
  CLOUD_PROVIDER_KEYS_MIGRATION_CONFIG_KEY;

/**
 * Sentinel that annotates a cloud provider record as unused for NeuroNest
 * cloud routing. Cloud adapter construction must ignore any record with this
 * value even if a subsequent migration run fails.
 */
export const LEGACY_KEY_STATUS_UNUSED = 'legacy-unused' as const;
export type LegacyProviderKeyStatus = typeof LEGACY_KEY_STATUS_UNUSED;

/**
 * Non-secret inventory record. Only metadata that is safe to render or log
 * appears here — the apiKey value is never included, only presence.
 */
export interface LegacyProviderKeyRecord {
  readonly providerId: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly hasApiKey: boolean;
  readonly apiKeyMask: string | null;
  readonly legacyKeyStatus: LegacyProviderKeyStatus | null;
  readonly preservedSelection: {
    readonly providerId: string;
    readonly modelId: string | null;
  };
}

/** Return value from {@link LegacyProviderKeyMigrationService.runMigration}. */
export interface LegacyProviderKeyMigrationRunResult {
  readonly status: CloudProviderKeyMigrationStatus;
  readonly payload: CloudProviderKeysMigrationConfigPayload;
  readonly records: readonly LegacyProviderKeyRecord[];
}

/** Return value from {@link LegacyProviderKeyMigrationService.deleteLegacyKey}. */
export interface LegacyProviderKeyDeleteResult {
  readonly deleted: boolean;
  readonly alreadyRemoved: boolean;
  readonly payload: CloudProviderKeysMigrationConfigPayload;
}

export interface LegacyProviderKeyMigrationServiceOptions {
  readonly now?: () => Date;
}

interface ConfigRow {
  readonly value: string;
}

/**
 * Loose Zod schema for a single saved provider entry. The saved format has
 * evolved over time, so we tolerate unknown properties. Only the fields we
 * inspect or rewrite are validated by shape; everything else is preserved.
 */
const SavedProviderRecordSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value !== null, 'provider record must be an object');
type SavedProviderRecord = z.infer<typeof SavedProviderRecordSchema>;

/**
 * The saved providers row is an array whose elements have evolved over
 * releases. We treat it as an unknown[] and validate each element inline so
 * a single anomalous entry never destroys the rest of the user's provider
 * selections. Non-array payloads are treated as an empty list.
 */
const SavedProvidersDocumentSchema = z.array(z.unknown());

const MigrationStatusValues = [
  'not-started',
  'complete',
  'partial',
  'failed',
] as const satisfies readonly CloudProviderKeyMigrationStatus[];

const IDENTIFIER_FIELDS = ['id', 'name', 'type'] as const;

/**
 * Main-process authority for the legacy provider-key migration lifecycle.
 *
 * All writes run through a single immediate SQLite transaction so migration
 * audit, aggregate status, and the redacted providers list stay consistent
 * with each other. No method resolves or returns credential values.
 */
export class LegacyProviderKeyMigrationService {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(
    db: Database.Database,
    options: LegacyProviderKeyMigrationServiceOptions = {},
  ) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read the current aggregate migration status. Absent or corrupt payloads
   * degrade to a fresh `not-started` payload rather than throwing, so a
   * malformed config row cannot block startup.
   */
  getStatus(): CloudProviderKeysMigrationConfigPayload {
    const row = this.readConfig(CLOUD_PROVIDER_KEYS_MIGRATION_KEY);
    if (!row) return this.emptyStatus();

    try {
      const parsed = JSON.parse(row.value) as unknown;
      return CloudProviderKeysMigrationConfigPayloadSchema.parse(parsed);
    } catch {
      return this.emptyStatus();
    }
  }

  /**
   * Return the non-secret inventory. Values in the returned records are safe
   * to render or log; no `apiKey` string is included.
   */
  listRecords(): readonly LegacyProviderKeyRecord[] {
    const providers = this.readProvidersOrEmpty().providers;
    return providers
      .map((record) => this.buildRecord(record))
      .filter((record): record is LegacyProviderKeyRecord => record !== null);
  }

  /**
   * Same as {@link listRecords} but wrapped in the schema-versioned envelope
   * the fixed `legacy-provider-keys:list-records-v1` IPC channel expects. The
   * response is validated against the shared Zod schema so a malformed
   * inventory row can never cross the IPC boundary.
   */
  listRecordsV1(): LegacyProviderKeyListV1 {
    const records: LegacyProviderKeyRecordV1[] = this.listRecords().map(
      (record) => ({
        schemaVersion: 1 as const,
        providerId: record.providerId,
        providerType: record.providerType,
        displayName: record.displayName,
        hasApiKey: record.hasApiKey,
        apiKeyMask: record.apiKeyMask,
        legacyKeyStatus:
          record.legacyKeyStatus === LEGACY_KEY_STATUS_UNUSED_VALUE
            ? LEGACY_KEY_STATUS_UNUSED_VALUE
            : null,
        preservedSelection: {
          providerId: record.preservedSelection.providerId,
          modelId: record.preservedSelection.modelId,
        },
      }),
    );
    return LegacyProviderKeyListV1Schema.parse({
      schemaVersion: 1,
      records,
    });
  }

  /**
   * Inventory saved cloud provider records and mark every key-bearing entry
   * as `legacy-unused` before routing cutover. Re-runs are safe: entries that
   * are already marked stay marked, entries whose apiKey has been deleted are
   * counted as removed, and no unrelated provider fields are altered.
   */
  runMigration(): LegacyProviderKeyMigrationRunResult {
    return this.db.transaction(() => {
      const startedAt = this.timestamp();
      const previous = this.readStatusInTransaction();
      const parsedProviders = this.readProvidersOrEmpty();

      let recordsExamined = 0;
      let recordsDisabled = 0;
      let selectionsPreserved = 0;
      let recordsRemoved = 0;
      let failureCount = 0;
      let mutated = false;

      const nextProviders: unknown[] = [];
      for (const entry of parsedProviders.providers) {
        const record = this.buildRecord(entry);
        if (!record) {
          // Preserve the raw entry so parsing anomalies never destroy user
          // provider selections. Failure count is bumped so admins can see it.
          nextProviders.push(entry);
          if (this.isCloudProviderRecord(entry)) {
            recordsExamined += 1;
            failureCount += 1;
          }
          continue;
        }

        if (!this.isCloudProviderRecord(entry)) {
          // Local providers keep their configured endpoints and are outside
          // the cloud-routing migration boundary entirely.
          nextProviders.push(entry);
          continue;
        }

        if (record.hasApiKey || record.legacyKeyStatus === LEGACY_KEY_STATUS_UNUSED) {
          recordsExamined += 1;
          selectionsPreserved += 1;
          if (!record.hasApiKey) {
            // The record has been marked already and the key has been fully
            // deleted; count it toward removed for status transparency.
            recordsRemoved += 1;
          }

          const updated = this.markLegacyUnused(entry);
          if (updated.mutated) mutated = true;
          nextProviders.push(updated.record);
          recordsDisabled += 1;
        } else {
          // Cloud entry with no key at all is not a migration subject.
          nextProviders.push(entry);
        }
      }

      if (mutated) {
        this.writeProvidersInTransaction(nextProviders);
      }

      const status = this.classifyStatus({
        recordsExamined,
        recordsDisabled,
        failureCount,
      });
      const revision = previous.revision + 1;
      const completedAt = this.timestamp();

      const payload = CloudProviderKeysMigrationConfigPayloadSchema.parse({
        status,
        revision,
        recordsExamined,
        recordsDisabled,
        selectionsPreserved,
        recordsRemoved,
        failureCount,
        startedAt,
        completedAt,
      });
      this.writeStatusInTransaction(payload);
      this.appendAuditInTransaction(payload);

      const records = nextProviders
        .map((entry) => this.buildRecord(entry))
        .filter((record): record is LegacyProviderKeyRecord => record !== null);

      return { status, payload, records };
    }).immediate();
  }

  /**
   * Idempotently delete the protected `apiKey` value and its reference from a
   * single provider entry. Deletion never resolves, echoes, or logs the value.
   * Returns success/failure metadata and the updated aggregate audit payload.
   */
  deleteLegacyKey(providerId: string): LegacyProviderKeyDeleteResult {
    const trimmed = providerId.trim();
    if (trimmed.length === 0) {
      throw new Error('providerId must be non-empty');
    }

    return this.db.transaction(() => {
      const previous = this.readStatusInTransaction();
      const parsedProviders = this.readProvidersOrEmpty();

      let matched = false;
      let alreadyRemoved = false;
      let mutated = false;

      const nextProviders: unknown[] = parsedProviders.providers.map((entry) => {
        const record = this.buildRecord(entry);
        if (!record) return entry;
        if (record.providerId !== trimmed) return entry;
        matched = true;
        if (!this.isCloudProviderRecord(entry)) {
          // Local providers do not participate in the cloud key migration.
          return entry;
        }
        const cleared = this.clearApiKey(entry);
        if (cleared.mutated) {
          mutated = true;
        } else {
          alreadyRemoved = true;
        }
        return cleared.record;
      });

      if (mutated) {
        this.writeProvidersInTransaction(nextProviders);
      }

      const summary = this.summarize(nextProviders);
      const revision = previous.revision + (mutated ? 1 : 0);
      const status = this.classifyStatus(summary);
      const startedAt = mutated ? this.timestamp() : previous.startedAt;
      const completedAt = mutated ? this.timestamp() : previous.completedAt;

      const payload = CloudProviderKeysMigrationConfigPayloadSchema.parse({
        status,
        revision: Math.max(revision, previous.revision),
        recordsExamined: summary.recordsExamined,
        recordsDisabled: summary.recordsDisabled,
        selectionsPreserved: summary.selectionsPreserved,
        recordsRemoved: summary.recordsRemoved,
        failureCount: summary.failureCount,
        startedAt: startedAt ?? this.timestamp(),
        completedAt,
      });
      if (mutated) {
        this.writeStatusInTransaction(payload);
        this.appendAuditInTransaction(payload);
      }

      return {
        deleted: mutated,
        alreadyRemoved: !mutated && (matched || alreadyRemoved),
        payload,
      };
    }).immediate();
  }

  // ─── Internals ─────────────────────────────────────────────────

  private summarize(entries: readonly unknown[]): {
    recordsExamined: number;
    recordsDisabled: number;
    selectionsPreserved: number;
    recordsRemoved: number;
    failureCount: number;
  } {
    let recordsExamined = 0;
    let recordsDisabled = 0;
    let selectionsPreserved = 0;
    let recordsRemoved = 0;
    let failureCount = 0;

    for (const entry of entries) {
      const record = this.buildRecord(entry);
      if (!record) {
        if (this.isCloudProviderRecord(entry)) failureCount += 1;
        continue;
      }
      if (!this.isCloudProviderRecord(entry)) continue;
      if (record.hasApiKey || record.legacyKeyStatus === LEGACY_KEY_STATUS_UNUSED) {
        recordsExamined += 1;
        selectionsPreserved += 1;
        if (record.legacyKeyStatus === LEGACY_KEY_STATUS_UNUSED) {
          recordsDisabled += 1;
        }
        if (!record.hasApiKey) {
          recordsRemoved += 1;
        }
      }
    }

    return {
      recordsExamined,
      recordsDisabled,
      selectionsPreserved,
      recordsRemoved,
      failureCount,
    };
  }

  private classifyStatus(counts: {
    readonly recordsExamined: number;
    readonly recordsDisabled: number;
    readonly failureCount: number;
  }): CloudProviderKeyMigrationStatus {
    if (counts.recordsExamined === 0) {
      return counts.failureCount === 0 ? 'not-started' : 'failed';
    }
    if (counts.failureCount === 0 && counts.recordsDisabled === counts.recordsExamined) {
      return 'complete';
    }
    if (counts.recordsDisabled === 0) return 'failed';
    return 'partial';
  }

  private buildRecord(entry: unknown): LegacyProviderKeyRecord | null {
    const parsed = SavedProviderRecordSchema.safeParse(entry);
    if (!parsed.success) return null;
    const raw = parsed.data;

    const providerType = this.readString(raw, 'type') ?? '';
    if (providerType.length === 0) return null;

    const providerId = this.deriveProviderId(raw);
    if (providerId.length === 0) return null;

    const displayName = this.readString(raw, 'name') ?? providerType;
    const apiKey = this.readString(raw, 'apiKey');
    const hasApiKey = apiKey !== null && apiKey.length > 0;
    const legacyKeyStatus =
      this.readString(raw, 'legacyKeyStatus') === LEGACY_KEY_STATUS_UNUSED
        ? LEGACY_KEY_STATUS_UNUSED
        : null;
    const modelId =
      this.readString(raw, 'defaultModel') ?? this.readString(raw, 'model');

    return {
      providerId,
      providerType,
      displayName,
      hasApiKey,
      apiKeyMask: hasApiKey ? '••••••' : null,
      legacyKeyStatus,
      preservedSelection: {
        providerId,
        modelId,
      },
    };
  }

  private isCloudProviderRecord(entry: unknown): boolean {
    if (typeof entry !== 'object' || entry === null) return false;
    const rawType = (entry as Record<string, unknown>).type;
    if (typeof rawType !== 'string') return false;
    return !LEGACY_MIGRATION_LOCAL_PROVIDER_TYPES.has(rawType.trim().toLowerCase());
  }

  private markLegacyUnused(entry: unknown): { record: unknown; mutated: boolean } {
    if (typeof entry !== 'object' || entry === null) {
      return { record: entry, mutated: false };
    }
    const clone: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    const previous = clone['legacyKeyStatus'];
    if (previous === LEGACY_KEY_STATUS_UNUSED) {
      return { record: clone, mutated: false };
    }
    clone['legacyKeyStatus'] = LEGACY_KEY_STATUS_UNUSED;
    return { record: clone, mutated: true };
  }

  private clearApiKey(entry: unknown): { record: unknown; mutated: boolean } {
    if (typeof entry !== 'object' || entry === null) {
      return { record: entry, mutated: false };
    }
    const clone: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    let mutated = false;
    const existing = clone['apiKey'];
    if (typeof existing === 'string' && existing.length > 0) {
      clone['apiKey'] = '';
      mutated = true;
    } else if (existing !== undefined && existing !== '' && existing !== null) {
      // Non-string value: normalize to empty string so downstream JSON
      // consumers cannot mistake the residue for an active credential.
      clone['apiKey'] = '';
      mutated = true;
    }
    if (clone['legacyKeyStatus'] !== LEGACY_KEY_STATUS_UNUSED) {
      clone['legacyKeyStatus'] = LEGACY_KEY_STATUS_UNUSED;
      mutated = true;
    }
    return { record: clone, mutated };
  }

  private deriveProviderId(raw: SavedProviderRecord): string {
    for (const field of IDENTIFIER_FIELDS) {
      const candidate = this.readString(raw, field);
      if (candidate !== null && candidate.length > 0) return candidate;
    }
    return '';
  }

  private readString(raw: SavedProviderRecord, field: string): string | null {
    const value = raw[field];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private readProvidersOrEmpty(): { providers: unknown[]; raw: string | null } {
    const row = this.readConfig(LEGACY_PROVIDERS_CONFIG_KEY);
    if (!row) return { providers: [], raw: null };
    try {
      const parsed = JSON.parse(row.value) as unknown;
      const validated = SavedProvidersDocumentSchema.safeParse(parsed);
      if (!validated.success) {
        return { providers: [], raw: row.value };
      }
      return { providers: validated.data, raw: row.value };
    } catch {
      return { providers: [], raw: row.value };
    }
  }

  private readStatusInTransaction(): CloudProviderKeysMigrationConfigPayload {
    const row = this.readConfig(CLOUD_PROVIDER_KEYS_MIGRATION_KEY);
    if (!row) return this.emptyStatus();
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return CloudProviderKeysMigrationConfigPayloadSchema.parse(parsed);
    } catch {
      return this.emptyStatus();
    }
  }

  private writeStatusInTransaction(
    payload: CloudProviderKeysMigrationConfigPayload,
  ): void {
    this.writeConfig(CLOUD_PROVIDER_KEYS_MIGRATION_KEY, payload);
  }

  private appendAuditInTransaction(
    payload: CloudProviderKeysMigrationConfigPayload,
  ): void {
    const table = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'enhanced_chat_ui_migration_audit' LIMIT 1",
      )
      .get();
    if (!table) return;

    this.db
      .prepare(
        `INSERT INTO enhanced_chat_ui_migration_audit (
           migration_key,
           revision,
           status,
           records_examined,
           records_disabled,
           selections_preserved,
           records_removed,
           failure_count,
           started_at,
           completed_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        CLOUD_PROVIDER_KEYS_MIGRATION_KEY,
        payload.revision,
        payload.status,
        payload.recordsExamined,
        payload.recordsDisabled,
        payload.selectionsPreserved,
        payload.recordsRemoved,
        payload.failureCount,
        payload.startedAt,
        payload.completedAt,
        this.timestamp(),
      );
  }

  private writeProvidersInTransaction(providers: readonly unknown[]): void {
    const serialized = JSON.stringify(providers);
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(LEGACY_PROVIDERS_CONFIG_KEY, serialized, this.timestamp());
  }

  private readConfig(key: string): ConfigRow | undefined {
    return this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(key) as ConfigRow | undefined;
  }

  private writeConfig(key: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(payload), this.timestamp());
  }

  private emptyStatus(): CloudProviderKeysMigrationConfigPayload {
    return CloudProviderKeysMigrationConfigPayloadSchema.parse({
      status: 'not-started' as const,
      revision: 1,
      recordsExamined: 0,
      recordsDisabled: 0,
      selectionsPreserved: 0,
      recordsRemoved: 0,
      failureCount: 0,
      startedAt: null,
      completedAt: null,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** Exported constant list of terminal migration statuses for exhaustiveness tests. */
export const LEGACY_MIGRATION_STATUS_VALUES: readonly CloudProviderKeyMigrationStatus[] =
  MigrationStatusValues;
