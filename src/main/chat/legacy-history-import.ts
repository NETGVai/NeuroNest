import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { SessionEventPayloadV1, SessionEventV1 } from '../../harness/contracts/event.js';
import { SessionLog } from '../../harness/session-log/session-log.js';

export const LEGACY_HISTORY_IMPORT_VERSION = 1;

export type LegacyHistorySourceKind = 'messages' | 'chat_messages' | 'chat_messages_overflow';

export interface LegacyHistoryCompatibilityRecord {
  readonly sourceKind: LegacyHistorySourceKind;
  /** Stable internal locator. It is hashed before diagnostics or canonical payloads are written. */
  readonly sourceLocator: string;
  readonly sourceId: unknown;
  readonly sessionId: unknown;
  readonly role: unknown;
  readonly content: unknown;
  readonly occurredAt: unknown;
  readonly metadata?: unknown;
}

export interface LegacyHistoryImportMarkerV1 {
  readonly sessionId: string;
  readonly branchId: string;
  readonly migrationVersion: 1;
  readonly sourceDigest: string;
  readonly sourceCount: number;
  readonly importedCount: number;
  readonly quarantinedCount: number;
  readonly checkpointSequence: number;
  readonly checkpointHash: string;
  readonly contentDigest: string;
  readonly completedAt: string;
}

export type LegacyHistoryQuarantineReason =
  | 'invalid_identity'
  | 'invalid_session'
  | 'invalid_role'
  | 'invalid_content'
  | 'invalid_timestamp'
  | 'invalid_metadata'
  | 'conflicting_duplicate';

export interface LegacyHistoryQuarantineDiagnosticV1 {
  readonly schemaVersion: 1;
  readonly diagnosticId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly migrationVersion: 1;
  readonly sourceKind: LegacyHistorySourceKind;
  readonly sourceIdentityHash: string;
  readonly reasonCode: LegacyHistoryQuarantineReason;
  readonly observedSize: number;
  readonly payloadHash: string;
  readonly createdAt: string;
}

export interface LegacyHistoryImportStore {
  readCompatibilityRecords(sessionId: string): readonly LegacyHistoryCompatibilityRecord[];
  getMarker(sessionId: string, branchId: string, migrationVersion: 1): LegacyHistoryImportMarkerV1 | undefined;
  recordMarker(marker: LegacyHistoryImportMarkerV1): void;
  quarantine(diagnostic: LegacyHistoryQuarantineDiagnosticV1): void;
}

export type LegacyHistoryImportResult =
  | ({ status: 'completed' | 'already_completed' } & LegacyHistoryImportMarkerV1)
  | {
      status: 'interrupted';
      sessionId: string;
      branchId: string;
      processedCount: number;
      sourceCount: number;
      importedCount: number;
      quarantinedCount: number;
    }
  | {
      status: 'blocked';
      sessionId: string;
      branchId: string;
      reasonCode: 'source_changed_after_import' | 'checkpoint_unavailable' | 'parity_mismatch';
    };

export interface LegacyHistoryImportOptions {
  readonly branchId?: string;
  readonly signal?: AbortSignal;
  /** Bounded resume point used by startup migration scheduling. Omit to finish in one run. */
  readonly maxRecords?: number;
}

type JsonRecord = Record<string, unknown>;

/**
 * Deterministic canonical projection of a legacy compatibility row.
 *
 * Identity formula (never depends on wall-clock or counters):
 *
 *   sourceIdentityHash = sha256(stableSerialize([sourceKind, sourceLocator, sourceId]))
 *   messageId          = 'legacy-import-message-' +
 *                        sha256(stableSerialize([sessionId, sourceId])).slice(0, 32)
 *   turnId             = 'legacy-import-turn-' +
 *                        sha256(stableSerialize([sessionId, turnAnchorSourceIdentityHash])).slice(0, 32)
 *
 * `turnAnchorSourceIdentityHash` is the source identity of the most recent user
 * message (or, before any user turn is seen, the first accepted record) so a
 * user prompt and its assistant reply share one canonical turn.
 *
 * The Session_Log idempotency key is
 *
 *   'legacy-history-import-v1:' +
 *   sha256(stableSerialize([sessionId, branchId, sourceIdentityHash]))
 *
 * which makes a second import a no-op after the first successful pass and lets
 * an interrupted run resume by replaying accepted records without duplication.
 */
export interface NormalizedImportRecord {
  readonly sourceKind: LegacyHistorySourceKind;
  readonly sourceIdentityHash: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly eventType: 'message.user' | 'message.assistant' | 'message.system';
  readonly role: 'user' | 'assistant' | 'system';
  readonly originalRole: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly occurredAt: string;
  readonly metadata: JsonRecord;
}

/** Result of pure normalization: no side effects, no I/O. */
export interface LegacyHistoryNormalizationResult {
  readonly accepted: readonly NormalizedImportRecord[];
  readonly quarantined: readonly LegacyHistoryQuarantineDiagnosticV1[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function boundedSize(value: unknown): number {
  try {
    return Math.min(Buffer.byteLength(stableSerialize(value), 'utf8'), 10_000_000);
  } catch {
    return 0;
  }
}

function timestamp(value: unknown): string | undefined {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function cleanOptionalString(value: unknown, maxLength = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function parseMetadata(value: unknown): JsonRecord | undefined {
  if (value === undefined || value === null) return {};
  if (isRecord(value)) return { ...value };
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function authorizedMetadata(metadata: JsonRecord): JsonRecord | undefined {
  const attachmentIds = metadata['attachmentIds'];
  if (
    attachmentIds !== undefined &&
    (!Array.isArray(attachmentIds) ||
      attachmentIds.length > 128 ||
      !attachmentIds.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512))
  ) {
    return undefined;
  }

  const result: JsonRecord = {};
  if (Array.isArray(attachmentIds)) result['attachmentIds'] = [...attachmentIds];
  for (const key of ['agent', 'channel', 'provider', 'model'] as const) {
    const value = cleanOptionalString(metadata[key]);
    if (value !== undefined) result[key] = value;
  }
  if (typeof metadata['isCommand'] === 'boolean') result['isCommand'] = metadata['isCommand'];
  if (typeof metadata['streamed'] === 'boolean') result['streamed'] = metadata['streamed'];
  if (typeof metadata['isStreaming'] === 'boolean') result['streamed'] = metadata['isStreaming'];
  return result;
}

function roleDetails(role: unknown):
  | Pick<NormalizedImportRecord, 'eventType' | 'role' | 'originalRole'>
  | undefined {
  switch (role) {
    case 'user':
      return { eventType: 'message.user', role: 'user', originalRole: 'user' };
    case 'assistant':
      return { eventType: 'message.assistant', role: 'assistant', originalRole: 'assistant' };
    case 'system':
      return { eventType: 'message.system', role: 'system', originalRole: 'system' };
    case 'tool':
      return { eventType: 'message.system', role: 'system', originalRole: 'tool' };
    default:
      return undefined;
  }
}

function markerContentTuple(record: NormalizedImportRecord): JsonRecord {
  return {
    sourceIdentityHash: record.sourceIdentityHash,
    messageId: record.messageId,
    turnId: record.turnId,
    eventType: record.eventType,
    role: record.role,
    originalRole: record.originalRole,
    content: record.content,
    occurredAt: record.occurredAt,
    metadata: record.metadata,
  };
}

/** Metadata keys carried through from source rows to canonical payloads. */
const LEGACY_IMPORT_METADATA_KEYS: readonly string[] = [
  'attachmentIds',
  'agent',
  'channel',
  'provider',
  'model',
  'isCommand',
  'streamed',
];

export interface LegacyHistoryNormalizationInputs {
  readonly sessionId: string;
  readonly branchId: string;
  readonly clock?: () => Date;
}

/**
 * Pure normalization of legacy compatibility rows into canonical import
 * records and quarantine diagnostics. No I/O and no side effects. Callers
 * choose whether to persist the quarantine diagnostics (LegacyHistoryImporter)
 * or discard them (parity diagnostic).
 *
 * Produces the same deterministic identities documented on
 * {@link NormalizedImportRecord}, so re-running normalization on the same
 * source rows always yields identical accepted records.
 */
export function normalizeLegacyHistoryRecords(
  source: readonly LegacyHistoryCompatibilityRecord[],
  inputs: LegacyHistoryNormalizationInputs,
): LegacyHistoryNormalizationResult {
  const { sessionId, branchId } = inputs;
  const clock = inputs.clock ?? (() => new Date());
  const accepted: Array<Omit<NormalizedImportRecord, 'turnId'>> = [];
  const quarantined: LegacyHistoryQuarantineDiagnosticV1[] = [];
  const identities = new Map<string, string>();

  for (const raw of source) {
    const sourceIdentityHash = digest([raw.sourceKind, raw.sourceLocator, raw.sourceId]);
    const reject = (reasonCode: LegacyHistoryQuarantineReason): void => {
      quarantined.push({
        schemaVersion: 1,
        diagnosticId: `legacy-history-quarantine-${digest([sessionId, branchId, sourceIdentityHash, reasonCode]).slice(0, 32)}`,
        sessionId,
        branchId,
        migrationVersion: LEGACY_HISTORY_IMPORT_VERSION,
        sourceKind: raw.sourceKind,
        sourceIdentityHash,
        reasonCode,
        observedSize: boundedSize(raw),
        payloadHash: digest(raw),
        createdAt: clock().toISOString(),
      });
    };

    if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0 || raw.sourceId.length > 512) {
      reject('invalid_identity');
      continue;
    }
    if (raw.sessionId !== sessionId) {
      reject('invalid_session');
      continue;
    }
    const role = roleDetails(raw.role);
    if (role === undefined) {
      reject('invalid_role');
      continue;
    }
    if (typeof raw.content !== 'string') {
      reject('invalid_content');
      continue;
    }
    const occurredAt = timestamp(raw.occurredAt);
    if (occurredAt === undefined) {
      reject('invalid_timestamp');
      continue;
    }
    const parsedMetadata = parseMetadata(raw.metadata);
    const metadata = parsedMetadata === undefined ? undefined : authorizedMetadata(parsedMetadata);
    if (metadata === undefined) {
      reject('invalid_metadata');
      continue;
    }

    const duplicateIdentity = digest([sessionId, raw.sourceId]);
    const canonicalFingerprint = digest([role, raw.content, occurredAt, metadata]);
    const previousFingerprint = identities.get(duplicateIdentity);
    if (previousFingerprint !== undefined) {
      if (previousFingerprint !== canonicalFingerprint) reject('conflicting_duplicate');
      continue;
    }
    identities.set(duplicateIdentity, canonicalFingerprint);

    accepted.push({
      sourceKind: raw.sourceKind,
      sourceIdentityHash,
      messageId: `legacy-import-message-${duplicateIdentity.slice(0, 32)}`,
      ...role,
      content: raw.content,
      occurredAt,
      metadata,
    });
  }

  let currentTurnAnchor: string | undefined;
  const records: NormalizedImportRecord[] = accepted.map((record) => {
    if (record.originalRole === 'user' || currentTurnAnchor === undefined) {
      currentTurnAnchor = record.sourceIdentityHash;
    }
    return {
      ...record,
      turnId: `legacy-import-turn-${digest([sessionId, currentTurnAnchor]).slice(0, 32)}`,
    };
  });

  return { accepted: records, quarantined };
}

/**
 * A canonical Session_Log event that was produced by the legacy history
 * importer, projected back into the deterministic tuple shape used for
 * parity comparison. `metadata` retains only the keys transported by the
 * importer's authorization filter so callers do not compare noisy extras.
 */
export interface ImportedCanonicalRecord {
  readonly eventId: string;
  readonly sequence: number;
  readonly sourceIdentityHash: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly eventType: 'message.user' | 'message.assistant' | 'message.system';
  readonly role: 'user' | 'assistant' | 'system';
  readonly originalRole: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly occurredAt: string;
  readonly metadata: JsonRecord;
}

function importedRecordFromEvent(event: SessionEventV1): ImportedCanonicalRecord | undefined {
  const payload = event.payload as JsonRecord;
  const importInfo = payload['legacyImport'];
  if (!isRecord(importInfo)) return undefined;
  if (importInfo['migrationVersion'] !== LEGACY_HISTORY_IMPORT_VERSION) return undefined;

  const metadata: JsonRecord = {};
  for (const key of LEGACY_IMPORT_METADATA_KEYS) {
    if (payload[key] !== undefined) metadata[key] = payload[key];
  }

  const eventType = event.eventType as ImportedCanonicalRecord['eventType'];
  const role = payload['role'] as ImportedCanonicalRecord['role'];
  const originalRole = importInfo['originalRole'] as ImportedCanonicalRecord['originalRole'];

  return {
    eventId: event.eventId,
    sequence: event.sequence,
    sourceIdentityHash: String(importInfo['sourceIdentityHash'] ?? ''),
    messageId: String(payload['messageId'] ?? ''),
    turnId: String(payload['turnId'] ?? ''),
    eventType,
    role,
    originalRole,
    content: typeof payload['text'] === 'string' ? (payload['text'] as string) : '',
    occurredAt: typeof payload['originalOccurredAt'] === 'string'
      ? (payload['originalOccurredAt'] as string)
      : '',
    metadata,
  };
}

/**
 * Read canonical events produced by {@link LEGACY_HISTORY_IMPORT_VERSION}
 * from Session_Log and project them into deterministic parity tuples.
 * Non-import events are ignored so this is safe to call after canonical
 * producers have started appending fresh events.
 */
export function readImportedCanonicalRecords(
  sessionLog: SessionLog,
  sessionId: string,
  branchId: string,
): readonly ImportedCanonicalRecord[] {
  const events = sessionLog.readRange({ sessionId, branchId });
  const records: ImportedCanonicalRecord[] = [];
  for (const event of events) {
    const record = importedRecordFromEvent(event);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/**
 * Read-only adapter over the legacy SQLite tables used to populate
 * `chatMessageStore`. It never updates or deletes those source tables.
 */
export class SqliteLegacyHistoryImportStore implements LegacyHistoryImportStore {
  constructor(private readonly db: Database.Database) {}

  readCompatibilityRecords(sessionId: string): readonly LegacyHistoryCompatibilityRecord[] {
    const records: LegacyHistoryCompatibilityRecord[] = [];
    this.readTable('messages', 'session_id', sessionId, records);
    this.readTable('chat_messages', 'chat_session_id', sessionId, records);
    this.readTable('chat_messages_overflow', 'session_id', sessionId, records);
    return records.sort((left, right) => {
      const leftTime = timestamp(left.occurredAt) ?? '';
      const rightTime = timestamp(right.occurredAt) ?? '';
      return leftTime.localeCompare(rightTime) || left.sourceLocator.localeCompare(right.sourceLocator);
    });
  }

  getMarker(sessionId: string, branchId: string, migrationVersion: 1): LegacyHistoryImportMarkerV1 | undefined {
    const row = this.db.prepare(
      `SELECT session_id, branch_id, migration_version, source_digest, source_count,
              imported_count, quarantined_count, checkpoint_sequence, checkpoint_hash,
              content_digest, completed_at
       FROM legacy_history_import_markers
       WHERE session_id = ? AND branch_id = ? AND migration_version = ?`,
    ).get(sessionId, branchId, migrationVersion) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: String(row['session_id']),
      branchId: String(row['branch_id']),
      migrationVersion: 1,
      sourceDigest: String(row['source_digest']),
      sourceCount: Number(row['source_count']),
      importedCount: Number(row['imported_count']),
      quarantinedCount: Number(row['quarantined_count']),
      checkpointSequence: Number(row['checkpoint_sequence']),
      checkpointHash: String(row['checkpoint_hash']),
      contentDigest: String(row['content_digest']),
      completedAt: String(row['completed_at']),
    };
  }

  recordMarker(marker: LegacyHistoryImportMarkerV1): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO legacy_history_import_markers (
         session_id, branch_id, migration_version, source_digest, source_count,
         imported_count, quarantined_count, checkpoint_sequence, checkpoint_hash,
         content_digest, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      marker.sessionId,
      marker.branchId,
      marker.migrationVersion,
      marker.sourceDigest,
      marker.sourceCount,
      marker.importedCount,
      marker.quarantinedCount,
      marker.checkpointSequence,
      marker.checkpointHash,
      marker.contentDigest,
      marker.completedAt,
    );
  }

  quarantine(diagnostic: LegacyHistoryQuarantineDiagnosticV1): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO legacy_history_import_quarantine (
         id, session_id, branch_id, migration_version, source_kind,
         source_identity_hash, reason_code, observed_size, payload_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      diagnostic.diagnosticId,
      diagnostic.sessionId,
      diagnostic.branchId,
      diagnostic.migrationVersion,
      diagnostic.sourceKind,
      diagnostic.sourceIdentityHash,
      diagnostic.reasonCode,
      diagnostic.observedSize,
      diagnostic.payloadHash,
      diagnostic.createdAt,
    );
  }

  private readTable(
    table: LegacyHistorySourceKind,
    sessionColumn: 'session_id' | 'chat_session_id',
    sessionId: string,
    output: LegacyHistoryCompatibilityRecord[],
  ): void {
    const exists = this.db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (exists === undefined) return;

    const rows = this.db.prepare(
      `SELECT rowid AS _legacy_rowid, * FROM ${table} WHERE ${sessionColumn} = ?`,
    ).all(sessionId) as JsonRecord[];
    for (const row of rows) {
      const rawMetadata = row['tool_calls'] ?? row['metadata'];
      const metadata = parseMetadata(rawMetadata);
      if (metadata !== undefined) {
        const agent = cleanOptionalString(row['agent']);
        if (agent !== undefined) metadata['agent'] = agent;
        if (row['is_cmd'] === 1) metadata['isCommand'] = true;
        if (typeof row['channel'] === 'string') metadata['channel'] = row['channel'];
        if (typeof row['provider'] === 'string') metadata['provider'] = row['provider'];
        if (typeof row['model'] === 'string') metadata['model'] = row['model'];
        if (typeof row['is_streaming'] === 'number') metadata['streamed'] = row['is_streaming'] === 1;
      }
      output.push({
        sourceKind: table,
        sourceLocator: `${table}:${String(row['_legacy_rowid'])}`,
        sourceId: row['id'],
        sessionId: row[sessionColumn],
        role: row['role'],
        content: row['content'],
        occurredAt: row['created_at'] ?? row['timestamp'],
        metadata: metadata ?? rawMetadata,
      });
    }
  }
}

/**
 * One-time, resumable import from legacy chat history into Session Log facts.
 * Source rows are read-only; durable idempotency keys make interrupted runs safe.
 */
export class LegacyHistoryImporter {
  constructor(
    private readonly store: LegacyHistoryImportStore,
    private readonly sessionLog: SessionLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  importSession(sessionId: string, options: LegacyHistoryImportOptions = {}): LegacyHistoryImportResult {
    const branchId = options.branchId ?? 'main';
    const source = this.store.readCompatibilityRecords(sessionId);
    const sourceDigest = digest(source.map((record) => ({ ...record })));
    const existing = this.store.getMarker(sessionId, branchId, LEGACY_HISTORY_IMPORT_VERSION);
    if (existing !== undefined) {
      if (existing.sourceDigest !== sourceDigest) {
        return { status: 'blocked', sessionId, branchId, reasonCode: 'source_changed_after_import' };
      }
      return this.verifyExistingMarker(existing);
    }

    const prepared = this.prepare(source, sessionId, branchId);
    let importedCount = 0;
    let processedCount = 0;
    let lastCheckpoint: { sequence: number; integrityHash: string } | undefined;
    const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;

    for (const record of prepared.records) {
      if (options.signal?.aborted || processedCount >= maxRecords) {
        return {
          status: 'interrupted',
          sessionId,
          branchId,
          processedCount,
          sourceCount: source.length,
          importedCount,
          quarantinedCount: prepared.quarantinedCount,
        };
      }
      const receipt = this.sessionLog.append({
        sessionId,
        branchId,
        eventType: record.eventType,
        payload: this.toPayload(record),
        actor: { kind: 'service', id: 'legacy-history-importer', schemaVersion: 1 },
        scope: { sessionId, schemaVersion: 1 },
        idempotencyKey: `legacy-history-import-v1:${digest([sessionId, branchId, record.sourceIdentityHash])}`,
      });
      if (!receipt.alreadyExists) {
        importedCount += 1;
        processedCount += 1;
      }
      lastCheckpoint = { sequence: receipt.sequence, integrityHash: receipt.integrityHash };
    }

    if (lastCheckpoint === undefined) {
      const current = this.sessionLog.readRange({ sessionId, branchId });
      const tail = current[current.length - 1];
      lastCheckpoint = tail === undefined
        ? { sequence: -1, integrityHash: digest([]) }
        : { sequence: tail.sequence, integrityHash: tail.integrityHash };
    }

    const expectedContentDigest = digest(prepared.records.map(markerContentTuple));
    const actualContentDigest = this.importedContentDigest(sessionId, branchId);
    const integrity = this.sessionLog.verify({ sessionId, branchId });
    if (!integrity.valid || actualContentDigest !== expectedContentDigest) {
      return { status: 'blocked', sessionId, branchId, reasonCode: 'parity_mismatch' };
    }

    const marker: LegacyHistoryImportMarkerV1 = {
      sessionId,
      branchId,
      migrationVersion: LEGACY_HISTORY_IMPORT_VERSION,
      sourceDigest,
      sourceCount: source.length,
      importedCount: prepared.records.length,
      quarantinedCount: prepared.quarantinedCount,
      checkpointSequence: lastCheckpoint.sequence,
      checkpointHash: lastCheckpoint.integrityHash,
      contentDigest: actualContentDigest,
      completedAt: this.clock().toISOString(),
    };
    this.store.recordMarker(marker);
    return { status: 'completed', ...marker };
  }

  private prepare(
    source: readonly LegacyHistoryCompatibilityRecord[],
    sessionId: string,
    branchId: string,
  ): { records: NormalizedImportRecord[]; quarantinedCount: number } {
    const { accepted, quarantined } = normalizeLegacyHistoryRecords(source, {
      sessionId,
      branchId,
      clock: this.clock,
    });
    for (const diagnostic of quarantined) this.store.quarantine(diagnostic);
    return { records: [...accepted], quarantinedCount: quarantined.length };
  }

  private toPayload(record: NormalizedImportRecord): SessionEventPayloadV1 {
    return {
      type: record.eventType,
      messageId: record.messageId,
      turnId: record.turnId,
      text: record.content,
      role: record.role,
      finalized: true,
      originalOccurredAt: record.occurredAt,
      ...record.metadata,
      legacyImport: {
        schemaVersion: 1,
        migrationVersion: LEGACY_HISTORY_IMPORT_VERSION,
        sourceKind: record.sourceKind,
        sourceIdentityHash: record.sourceIdentityHash,
        originalRole: record.originalRole,
      },
    };
  }

  private importedContentDigest(sessionId: string, branchId: string): string {
    const tuples = readImportedCanonicalRecords(this.sessionLog, sessionId, branchId).map(
      (record) => ({
        sourceIdentityHash: record.sourceIdentityHash,
        messageId: record.messageId,
        turnId: record.turnId,
        eventType: record.eventType,
        role: record.role,
        originalRole: record.originalRole,
        content: record.content,
        occurredAt: record.occurredAt,
        metadata: record.metadata,
      }),
    );
    return digest(tuples);
  }

  private verifyExistingMarker(marker: LegacyHistoryImportMarkerV1): LegacyHistoryImportResult {
    const checkpoint = marker.checkpointSequence < 0
      ? undefined
      : this.sessionLog.readRange({
          sessionId: marker.sessionId,
          branchId: marker.branchId,
          fromSequence: marker.checkpointSequence,
          toSequence: marker.checkpointSequence,
        })[0];
    if (
      marker.checkpointSequence >= 0 &&
      (checkpoint === undefined || checkpoint.integrityHash !== marker.checkpointHash)
    ) {
      return {
        status: 'blocked',
        sessionId: marker.sessionId,
        branchId: marker.branchId,
        reasonCode: 'checkpoint_unavailable',
      };
    }
    if (
      !this.sessionLog.verify({ sessionId: marker.sessionId, branchId: marker.branchId }).valid ||
      this.importedContentDigest(marker.sessionId, marker.branchId) !== marker.contentDigest
    ) {
      return {
        status: 'blocked',
        sessionId: marker.sessionId,
        branchId: marker.branchId,
        reasonCode: 'parity_mismatch',
      };
    }
    return { status: 'already_completed', ...marker };
  }
}
