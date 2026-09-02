/**
 * Evidence, observability, health, readiness, and diagnostic foundations
 * (D-07 EvidenceRecord@1, D-19 observability/health/readiness, D-21, D-22).
 *
 * Implements the Evidence/Observability Authority foundation for
 * FUT-PKG-02-FOUNDATION/T-005 as additive, local-first primitives with product
 * telemetry OFF by default:
 *
 *   - {@link EvidenceRecord} — a typed `EvidenceRecord@1` model plus validation
 *     and a searchable, revision/profile-bound {@link EvidenceService}. A pass
 *     is valid only for the exact criterion, revisions, profile, and unexpired
 *     waiver policy (D-07). Stale or mismatched evidence never satisfies a query
 *     and never exports.
 *   - Structured, redacted logs / traces / audits with `correlationId` and
 *     `causationId` threading (D-19.1/D-19.2). Secrets and private absolute
 *     paths never cross an observable boundary; every log/trace/audit routes
 *     through {@link observable-redaction} and refuses `secret`-classed records.
 *   - Liveness / readiness / scoped-health reporting reusing the capability
 *     status ladder (`ready | degraded | unavailable | blocked`, D-19.4).
 *   - Bounded metrics with a fixed name/label allow-list and bounded label
 *     cardinality (D-19.3); a malformed metric is rejected and cannot pass or
 *     export.
 *   - A registry-revision descriptor for catalog/migration counts (D-19.3
 *     "Migration/catalog count" row) recorded with its registry revision.
 *   - Diagnostic export with a redacted preview and abort-on-unredactable: if
 *     redaction or authorization cannot be completed, or a secret/private-path
 *     canary or an ambiguous redaction remains, export ABORTS with NO partial
 *     output (NN-SEC-015, D-19.4). Security-classified content is
 *     non-exportable.
 *   - Evidence retention: a bounded policy that preserves mandatory
 *     audit/recovery evidence and prunes expired non-mandatory evidence.
 *
 * Trust posture (NN-INV-003/004/011/015, NN-OBS-001..008, NN-OPS-006/007,
 * NN-SEC-014/015): the Evidence Service and readiness report are OBSERVERS;
 * they gate no consumer here (task rollout). Rollback stops export/collection
 * and preserves mandatory audit/recovery evidence under the retention policy.
 *
 * Design anchors: D-07, D-19, D-21, D-22.
 * Requirements: NN-INV-003/004/011/015, NN-OBS-001..008, NN-OPS-006/007,
 * NN-SEC-014/015.
 */

import {
  CONTRACT_WRITE_VERSION,
  isDigest,
  isOpaqueId,
  isRevision,
  isTimestamp,
  type RedactionClass,
} from './contract-primitives';
import {
  isCapabilityStatus,
  type CapabilityStatus,
} from './capability-registry';
import {
  containsRedactableContent,
  redactForDiagnostic,
  redactString,
  redactValue,
} from './observable-redaction';

// ─── EvidenceRecord@1 (D-07) ─────────────────────────────────────────────────

/**
 * Verification types (D-22 verification-type column). Every executed
 * verification produces an `EvidenceRecord@1` at the same implementation
 * revision.
 */
export const VERIFICATION_TYPES = Object.freeze([
  'test',
  'property',
  'security',
  'accessibility',
  'performance',
  'failure-injection',
  'migration',
  'manual',
] as const);
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** Terminal result of a verification. */
export const EVIDENCE_RESULTS = Object.freeze([
  'pass',
  'fail',
  'blocked',
  'skipped',
] as const);
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/** Whether a value is a known verification type. */
export function isVerificationType(value: unknown): value is VerificationType {
  return (
    typeof value === 'string' &&
    (VERIFICATION_TYPES as readonly string[]).includes(value)
  );
}

/** Whether a value is a known evidence result. */
export function isEvidenceResult(value: unknown): value is EvidenceResult {
  return (
    typeof value === 'string' &&
    (EVIDENCE_RESULTS as readonly string[]).includes(value)
  );
}

/**
 * `EvidenceRecord@1` (D-07). EvidenceService/ReleaseAuthority own it. A digest
 * is recorded only when computed. A pass is valid only for the exact criterion,
 * revisions, profile, and unexpired waiver policy.
 */
export interface EvidenceRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  /** Opaque evidence id, e.g. `ev-foundation-t005-...`. */
  readonly evidenceId: string;
  readonly verificationType: VerificationType;
  /** Verification slug, e.g. `V-OBS-001/evidence-redaction`. */
  readonly verificationId: string;
  /** Canonical requirement links, e.g. `NN-OBS-001`. */
  readonly canonicalLinks: readonly string[];
  /** Design anchors, e.g. `D-19`. */
  readonly designAnchors: readonly string[];
  /** Task links, e.g. `FUT-PKG-02-FOUNDATION/T-005`. */
  readonly taskLinks: readonly string[];
  /** Immutable source revision this evidence was produced against. */
  readonly sourceRevision: string;
  /** Immutable implementation revision the evidence binds to. */
  readonly implementationRevision: string;
  /** Fixture profile, e.g. `FIX-SECRETS-CANARY-01`. */
  readonly fixtureProfile: string;
  /** Human-safe, secret-free, private-path-free method description. */
  readonly method: string;
  /** Optional command that produced the evidence. */
  readonly command?: string;
  readonly result: EvidenceResult;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Reference to the artifact (never a private absolute path). */
  readonly artifactRef: string;
  /** Lowercase SHA-256 hex digest, recorded only when computed. */
  readonly artifactDigest?: string;
  /** Producing actor/authority id. */
  readonly actor: string;
  /** Environment fingerprint (os/node/electron/etc.), secret-free. */
  readonly environmentFingerprint: string;
  /** Redaction class of the record; NEVER `secret` (D-06.1). */
  readonly redaction: RedactionClass;
  /** Unexpired waiver id, when a policy waiver applies (NN-OPS-007). */
  readonly waiverId?: string;
}

const EVIDENCE_OWNER = 'authority-evidence-observability';

/** Result of validating an untrusted value as an `EvidenceRecord@1`. */
export type EvidenceValidation =
  | { readonly ok: true; readonly value: EvidenceRecord }
  | { readonly ok: false; readonly issues: readonly string[] };

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

/**
 * Validate an untrusted value as an `EvidenceRecord@1`. Deterministic and
 * side-effect-free: the same invalid input always yields the same issues. A
 * `secret`-classed record is rejected (D-06.1 — evidence is observable). A
 * digest is accepted only when it is a lowercase SHA-256 hex string.
 */
export function validateEvidenceRecord(value: unknown): EvidenceValidation {
  const issues: string[] = [];
  if (value === null || typeof value !== 'object') {
    return { ok: false, issues: ['record must be an object'] };
  }
  const r = value as Record<string, unknown>;

  if (r.schemaVersion !== CONTRACT_WRITE_VERSION) {
    issues.push(`schemaVersion must be ${CONTRACT_WRITE_VERSION}`);
  }
  if (!isOpaqueId(r.evidenceId)) issues.push('evidenceId must be an opaque id');
  if (!isVerificationType(r.verificationType)) {
    issues.push('verificationType is not a known type');
  }
  if (typeof r.verificationId !== 'string' || r.verificationId.length === 0) {
    issues.push('verificationId must be a non-empty string');
  }
  if (!isNonEmptyStringArray(r.canonicalLinks) || r.canonicalLinks.length === 0) {
    issues.push('canonicalLinks must be a non-empty string array');
  }
  if (!isNonEmptyStringArray(r.designAnchors)) {
    issues.push('designAnchors must be a string array');
  }
  if (!isNonEmptyStringArray(r.taskLinks) || r.taskLinks.length === 0) {
    issues.push('taskLinks must be a non-empty string array');
  }
  if (typeof r.sourceRevision !== 'string' || r.sourceRevision.length === 0) {
    issues.push('sourceRevision must be a non-empty string');
  }
  if (
    typeof r.implementationRevision !== 'string' ||
    r.implementationRevision.length === 0
  ) {
    issues.push('implementationRevision must be a non-empty string');
  }
  if (typeof r.fixtureProfile !== 'string' || r.fixtureProfile.length === 0) {
    issues.push('fixtureProfile must be a non-empty string');
  }
  if (typeof r.method !== 'string' || r.method.length === 0) {
    issues.push('method must be a non-empty string');
  }
  if (r.command !== undefined && typeof r.command !== 'string') {
    issues.push('command must be a string when present');
  }
  if (!isEvidenceResult(r.result)) issues.push('result is not a known result');
  if (!isTimestamp(r.startedAt)) issues.push('startedAt must be an RFC3339 timestamp');
  if (!isTimestamp(r.endedAt)) issues.push('endedAt must be an RFC3339 timestamp');
  if (typeof r.artifactRef !== 'string' || r.artifactRef.length === 0) {
    issues.push('artifactRef must be a non-empty string');
  }
  if (r.artifactDigest !== undefined && !isDigest(r.artifactDigest)) {
    issues.push('artifactDigest must be a lowercase sha-256 hex digest');
  }
  if (!isOpaqueId(r.actor)) issues.push('actor must be an opaque id');
  if (
    typeof r.environmentFingerprint !== 'string' ||
    r.environmentFingerprint.length === 0
  ) {
    issues.push('environmentFingerprint must be a non-empty string');
  }
  if (r.redaction === 'secret') {
    issues.push('evidence records must never be secret-classed');
  } else if (
    r.redaction !== 'public' &&
    r.redaction !== 'internal' &&
    r.redaction !== 'sensitive'
  ) {
    issues.push('redaction must be public|internal|sensitive');
  }
  if (r.waiverId !== undefined && !isOpaqueId(r.waiverId)) {
    issues.push('waiverId must be an opaque id when present');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as EvidenceRecord };
}

// ─── Evidence query binding (D-07 pass-validity) ─────────────────────────────

/**
 * A revision/profile-bound query for evidence. A stored `pass` satisfies the
 * query only when it matches the exact criterion, both revisions, and the
 * fixture profile, and its waiver (if any) is not listed as expired (D-07,
 * NN-OPS-007). This models "a pass is valid only for the exact criterion,
 * revisions, profile, and unexpired waiver policy."
 */
export interface EvidenceQuery {
  /** Canonical criterion the pass must attest, e.g. `NN-OBS-001`. */
  readonly canonicalCriterion: string;
  /** Required source revision (exact match). */
  readonly sourceRevision: string;
  /** Required implementation revision (exact match). */
  readonly implementationRevision: string;
  /** Required fixture profile (exact match). */
  readonly fixtureProfile: string;
  /** Waiver ids known to be expired; a record using one cannot pass. */
  readonly expiredWaiverIds?: readonly string[];
}

/** Why a candidate record fails to satisfy a binding query. */
export type EvidenceMismatchReason =
  | 'criterion'
  | 'source-revision'
  | 'implementation-revision'
  | 'profile'
  | 'not-pass'
  | 'expired-waiver';

/**
 * Classify whether a record satisfies a revision/profile-bound query, or the
 * first reason it does not. Pure and total. Stale (mismatched-revision) or
 * cross-profile evidence never satisfies the query.
 */
export function evidenceSatisfies(
  record: EvidenceRecord,
  query: EvidenceQuery,
): { readonly ok: true } | { readonly ok: false; readonly reason: EvidenceMismatchReason } {
  if (!record.canonicalLinks.includes(query.canonicalCriterion)) {
    return { ok: false, reason: 'criterion' };
  }
  if (record.sourceRevision !== query.sourceRevision) {
    return { ok: false, reason: 'source-revision' };
  }
  if (record.implementationRevision !== query.implementationRevision) {
    return { ok: false, reason: 'implementation-revision' };
  }
  if (record.fixtureProfile !== query.fixtureProfile) {
    return { ok: false, reason: 'profile' };
  }
  if (record.result !== 'pass') {
    return { ok: false, reason: 'not-pass' };
  }
  if (
    record.waiverId !== undefined &&
    (query.expiredWaiverIds ?? []).includes(record.waiverId)
  ) {
    return { ok: false, reason: 'expired-waiver' };
  }
  return { ok: true };
}

// ─── Evidence retention (rollback-safe) ──────────────────────────────────────

/**
 * Verification types whose evidence is MANDATORY audit/recovery evidence that
 * retention must preserve even on rollback (task rollback rule: "preserves
 * mandatory audit/recovery evidence under retention policy").
 */
export const MANDATORY_RETAINED_TYPES: readonly VerificationType[] = Object.freeze([
  'security',
  'migration',
  'failure-injection',
]);

/** Whether a record must be retained regardless of age (mandatory evidence). */
export function isMandatoryRetained(record: EvidenceRecord): boolean {
  return MANDATORY_RETAINED_TYPES.includes(record.verificationType);
}

export interface RetentionPolicy {
  /** Maximum age in milliseconds for non-mandatory evidence. */
  readonly maxAgeMs: number;
  /** Clock; defaults to `Date.now`. Injectable for tests. */
  readonly now?: () => number;
}

/** Partition of a retention pass. */
export interface RetentionOutcome {
  readonly retained: readonly EvidenceRecord[];
  readonly pruned: readonly EvidenceRecord[];
}

/**
 * Apply the retention policy to a set of records. Mandatory audit/recovery
 * evidence is always retained; non-mandatory evidence older than `maxAgeMs`
 * (measured from `endedAt`) is pruned. Deterministic and side-effect-free.
 */
export function applyRetention(
  records: readonly EvidenceRecord[],
  policy: RetentionPolicy,
): RetentionOutcome {
  const now = (policy.now ?? Date.now)();
  const retained: EvidenceRecord[] = [];
  const pruned: EvidenceRecord[] = [];
  for (const record of records) {
    if (isMandatoryRetained(record)) {
      retained.push(record);
      continue;
    }
    const endedMs = Date.parse(record.endedAt);
    const ageMs = Number.isFinite(endedMs) ? now - endedMs : Number.POSITIVE_INFINITY;
    if (ageMs > policy.maxAgeMs) {
      pruned.push(record);
    } else {
      retained.push(record);
    }
  }
  return { retained, pruned };
}

// ─── Evidence Service (searchable, observer-only) ────────────────────────────

/**
 * The Evidence Service: an in-memory, searchable, revision/profile-bound store
 * of `EvidenceRecord@1` instances. It is an OBSERVER (D-19.4): it gates no
 * consumer. It rejects invalid records, refuses to record a `secret`-classed
 * record, and never returns a stale/mismatched record for a bound query.
 */
export class EvidenceService {
  private readonly records = new Map<string, EvidenceRecord>();

  /**
   * Record a validated `EvidenceRecord@1`. Returns the accepted record or the
   * validation issues. Re-recording the same `evidenceId` with a different
   * body is rejected (evidence is immutable once recorded).
   */
  record(
    value: unknown,
  ): { readonly ok: true; readonly record: EvidenceRecord } | { readonly ok: false; readonly issues: readonly string[] } {
    const validation = validateEvidenceRecord(value);
    if (!validation.ok) {
      return { ok: false, issues: validation.issues };
    }
    const record = validation.value;
    const existing = this.records.get(record.evidenceId);
    if (existing && !recordsEqual(existing, record)) {
      return {
        ok: false,
        issues: [`evidenceId ${record.evidenceId} already recorded with a different body`],
      };
    }
    this.records.set(record.evidenceId, record);
    return { ok: true, record };
  }

  /** Get a record by id. */
  get(evidenceId: string): EvidenceRecord | undefined {
    return this.records.get(evidenceId);
  }

  /** Number of stored records. */
  get size(): number {
    return this.records.size;
  }

  /** Snapshot every record, sorted by id for determinism. */
  snapshot(): readonly EvidenceRecord[] {
    return Object.freeze(
      [...this.records.values()].sort((a, b) =>
        a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0,
      ),
    );
  }

  /**
   * Free-text search over redacted, searchable fields (verificationId,
   * canonicalLinks, taskLinks, method, fixtureProfile). The query is matched
   * case-insensitively against a redacted projection so no secret/private path
   * is ever searchable (NN-OBS-001/002; NN-SEC-014). Returns records sorted by
   * id.
   */
  search(text: string): readonly EvidenceRecord[] {
    const needle = text.trim().toLowerCase();
    if (needle.length === 0) return this.snapshot();
    return this.snapshot().filter((record) => {
      const haystack = redactString(
        [
          record.verificationId,
          record.canonicalLinks.join(' '),
          record.taskLinks.join(' '),
          record.fixtureProfile,
          record.method,
        ].join(' '),
      ).toLowerCase();
      return haystack.includes(needle);
    });
  }

  /**
   * Find the passing records that satisfy a revision/profile-bound query. A
   * stale/mismatched record is never returned; the caller receives only the
   * valid passes for the exact criterion, revisions, and profile (D-07).
   */
  findValidPasses(query: EvidenceQuery): readonly EvidenceRecord[] {
    return this.snapshot().filter(
      (record) => evidenceSatisfies(record, query).ok,
    );
  }

  /**
   * Whether the store has at least one valid, revision/profile-bound pass for
   * the query. The core "stale/mismatched evidence cannot pass" gate (D-07,
   * NN-INV-015).
   */
  hasValidPass(query: EvidenceQuery): boolean {
    return this.findValidPasses(query).length > 0;
  }

  /**
   * Apply a retention policy, dropping pruned non-mandatory records from the
   * store and preserving all mandatory audit/recovery evidence. Returns the
   * partition. Mirrors the rollback rule (collection stops; mandatory evidence
   * is preserved).
   */
  prune(policy: RetentionPolicy): RetentionOutcome {
    const outcome = applyRetention(this.snapshot(), policy);
    for (const record of outcome.pruned) {
      this.records.delete(record.evidenceId);
    }
    return outcome;
  }
}

function recordsEqual(a: EvidenceRecord, b: EvidenceRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Structured logs / traces / audits (D-19.1, D-19.2) ──────────────────────

/** Log severity levels (D-19.2). */
export const LOG_LEVELS = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A structured log envelope (D-19.2). `scopeIds` are redacted; `correlationId`
 * threads a unit of work; `code`/`retryable` echo a typed error when present.
 * Timestamps are for diagnostics only — never cross-process order (D-19.1).
 */
export interface LogEnvelope {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly authority: string;
  readonly operation: string;
  readonly scopeIds: Record<string, string>;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly durationMs?: number;
  readonly redaction: RedactionClass;
  readonly message: string;
  readonly detailsRef?: string;
}

/** Fields a caller supplies to build a redacted log envelope. */
export interface LogInput {
  readonly level: LogLevel;
  readonly component: string;
  readonly authority: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly scopeIds?: Record<string, string>;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly durationMs?: number;
  readonly message: string;
  readonly detailsRef?: string;
  readonly redaction?: RedactionClass;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Build a redacted {@link LogEnvelope}. The message and scope ids are scrubbed
 * through the shared redaction authority so secrets and private absolute paths
 * never appear in a log (NN-OBS-001, NN-SEC-014). A `secret` redaction class is
 * downgraded to `sensitive` because a secret record never reaches an observable
 * channel (D-06.1). Timestamps are diagnostic-only.
 */
export function buildLogEnvelope(input: LogInput): LogEnvelope {
  const now = input.now ?? Date.now;
  const redaction = normalizeObservableRedaction(input.redaction);
  const scopeIds = redactValue(input.scopeIds ?? {});
  return {
    timestamp: new Date(now()).toISOString(),
    level: input.level,
    component: input.component,
    authority: input.authority,
    operation: input.operation,
    scopeIds,
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    redaction,
    message: redactString(input.message),
    ...(input.detailsRef !== undefined ? { detailsRef: input.detailsRef } : {}),
  };
}

/**
 * A trace span (D-19.2). Includes monotonic start/end duration, parent linkage
 * via `causationId`, route/tool/manifest versions, policy/approval/budget refs,
 * an outcome, and evidence refs — never hidden reasoning or raw secrets.
 */
export interface TraceSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly component: string;
  readonly operation: string;
  readonly startMonotonicMs: number;
  readonly endMonotonicMs: number;
  readonly durationMs: number;
  readonly routeVersion?: string;
  readonly toolVersion?: string;
  readonly manifestVersion?: string;
  readonly policyRef?: string;
  readonly approvalRef?: string;
  readonly budgetRef?: string;
  readonly outcome: 'ok' | 'error' | 'cancelled' | 'timeout';
  readonly evidenceRefs: readonly string[];
  readonly redaction: RedactionClass;
}

/** Fields a caller supplies to build a redacted trace span. */
export interface TraceSpanInput {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly component: string;
  readonly operation: string;
  readonly startMonotonicMs: number;
  readonly endMonotonicMs: number;
  readonly routeVersion?: string;
  readonly toolVersion?: string;
  readonly manifestVersion?: string;
  readonly policyRef?: string;
  readonly approvalRef?: string;
  readonly budgetRef?: string;
  readonly outcome: 'ok' | 'error' | 'cancelled' | 'timeout';
  readonly evidenceRefs?: readonly string[];
  readonly redaction?: RedactionClass;
}

/**
 * Build a redacted {@link TraceSpan} with a monotonic (non-negative) duration.
 * Duration comes only from the monotonic start/end pair — never from wall-clock
 * timestamps (D-19.1). A negative or non-finite delta clamps to 0 so a span can
 * never claim negative work.
 */
export function buildTraceSpan(input: TraceSpanInput): TraceSpan {
  const delta = input.endMonotonicMs - input.startMonotonicMs;
  const durationMs = Number.isFinite(delta) && delta > 0 ? delta : 0;
  return {
    spanId: input.spanId,
    traceId: input.traceId,
    ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    component: input.component,
    operation: input.operation,
    startMonotonicMs: input.startMonotonicMs,
    endMonotonicMs: input.endMonotonicMs,
    durationMs,
    ...(input.routeVersion !== undefined ? { routeVersion: input.routeVersion } : {}),
    ...(input.toolVersion !== undefined ? { toolVersion: input.toolVersion } : {}),
    ...(input.manifestVersion !== undefined
      ? { manifestVersion: input.manifestVersion }
      : {}),
    ...(input.policyRef !== undefined ? { policyRef: input.policyRef } : {}),
    ...(input.approvalRef !== undefined ? { approvalRef: input.approvalRef } : {}),
    ...(input.budgetRef !== undefined ? { budgetRef: input.budgetRef } : {}),
    outcome: input.outcome,
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
    redaction: normalizeObservableRedaction(input.redaction),
  };
}

/** Audit-record kinds (D-19.2 append-only logical facts). */
export const AUDIT_KINDS = Object.freeze([
  'security-decision',
  'credential-lifecycle',
  'approval',
  'migration',
  'setting-change',
  'import',
  'deployment',
  'retention',
] as const);
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** An append-only audit record for a security-relevant decision (D-19.2). */
export interface AuditRecord {
  readonly auditId: string;
  readonly kind: AuditKind;
  readonly actor: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly decision: string;
  readonly recordedAt: string;
  readonly redaction: RedactionClass;
  readonly detailsRef?: string;
}

/** Fields a caller supplies to build a redacted audit record. */
export interface AuditInput {
  readonly auditId: string;
  readonly kind: AuditKind;
  readonly actor: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly decision: string;
  readonly detailsRef?: string;
  readonly redaction?: RedactionClass;
  readonly now?: () => number;
}

/** Whether a value is a known audit kind. */
export function isAuditKind(value: unknown): value is AuditKind {
  return (
    typeof value === 'string' && (AUDIT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Build a redacted append-only {@link AuditRecord}. The decision text is
 * scrubbed of secrets/private paths; a `secret` class is downgraded to
 * `sensitive` (audits are observable). Timestamps are diagnostic only.
 */
export function buildAuditRecord(input: AuditInput): AuditRecord {
  const now = input.now ?? Date.now;
  return {
    auditId: input.auditId,
    kind: input.kind,
    actor: input.actor,
    operation: input.operation,
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    decision: redactString(input.decision),
    recordedAt: new Date(now()).toISOString(),
    redaction: normalizeObservableRedaction(input.redaction),
    ...(input.detailsRef !== undefined ? { detailsRef: input.detailsRef } : {}),
  };
}

/**
 * Normalize a redaction class for an observable channel: `secret` never reaches
 * an observable boundary, so it is downgraded to `sensitive` (D-06.1). Any
 * unknown/absent value defaults to `internal`.
 */
function normalizeObservableRedaction(cls: RedactionClass | undefined): RedactionClass {
  if (cls === 'public' || cls === 'internal' || cls === 'sensitive') return cls;
  // `secret` never crosses an observable boundary; downgrade to the highest
  // observable class so the record is still marked sensitive (D-06.1).
  if (cls === 'secret') return 'sensitive';
  return 'internal';
}

// ─── Bounded metrics (D-19.3) ────────────────────────────────────────────────

/**
 * The bounded metric name allow-list (D-19.3 metrics table). A metric name not
 * in this set is malformed and cannot be recorded or exported.
 */
export const METRIC_NAMES = Object.freeze([
  'startup_phase_duration_ms',
  'ipc_latency_ms',
  'ipc_errors_total',
  'db_transaction_ms',
  'migration_ms',
  'outbox_lag_records',
  'outbox_oldest_age_seconds',
  'projection_lag_sequence',
  'projection_lag_age_seconds',
  'queue_depth_records',
  'tool_provider_latency_ms',
  'token_usage_total',
  'cost_budget_amount',
  'cancellation_convergence_ms',
  'capability_health',
  'registry_count',
] as const);
export type MetricName = (typeof METRIC_NAMES)[number];

/** Metric kind (D-19.3 unit/type column). */
export type MetricKind = 'histogram' | 'counter' | 'gauge';

/** The kind of each allow-listed metric. */
export const METRIC_KINDS: Readonly<Record<MetricName, MetricKind>> = Object.freeze({
  startup_phase_duration_ms: 'histogram',
  ipc_latency_ms: 'histogram',
  ipc_errors_total: 'counter',
  db_transaction_ms: 'histogram',
  migration_ms: 'histogram',
  outbox_lag_records: 'gauge',
  outbox_oldest_age_seconds: 'gauge',
  projection_lag_sequence: 'gauge',
  projection_lag_age_seconds: 'gauge',
  queue_depth_records: 'gauge',
  tool_provider_latency_ms: 'histogram',
  token_usage_total: 'counter',
  cost_budget_amount: 'gauge',
  cancellation_convergence_ms: 'histogram',
  capability_health: 'gauge',
  registry_count: 'gauge',
});

/**
 * The bounded label keys allowed per metric (D-19.3 "bounded cardinality"
 * column). No metric permits a session/user/scope id label; only class-level
 * labels are allowed, so metric cardinality stays bounded.
 */
export const METRIC_LABEL_KEYS: Readonly<Record<MetricName, readonly string[]>> =
  Object.freeze({
    startup_phase_duration_ms: ['phase', 'coldWarm', 'platformProfile'],
    ipc_latency_ms: ['contract', 'version', 'outcome', 'tier'],
    ipc_errors_total: ['contract', 'version', 'outcome', 'tier'],
    db_transaction_ms: ['authorityOrMigration', 'outcome'],
    migration_ms: ['authorityOrMigration', 'outcome'],
    outbox_lag_records: ['destination', 'state'],
    outbox_oldest_age_seconds: ['destination', 'state'],
    projection_lag_sequence: ['projection', 'status'],
    projection_lag_age_seconds: ['projection', 'status'],
    queue_depth_records: ['queueClass'],
    tool_provider_latency_ms: ['toolProviderClass', 'outcome'],
    token_usage_total: ['reportedEstimated', 'modelClass'],
    cost_budget_amount: ['scopeClass', 'routeClass', 'pricingVersion', 'currency'],
    cancellation_convergence_ms: ['subsystem', 'result'],
    capability_health: ['capability', 'platform', 'adapterVersion'],
    registry_count: ['registryType', 'applicationRevision'],
  });

/** A single bounded metric sample. */
export interface MetricSample {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
}

/** Whether a value is an allow-listed metric name. */
export function isMetricName(value: unknown): value is MetricName {
  return (
    typeof value === 'string' && (METRIC_NAMES as readonly string[]).includes(value)
  );
}

/** Result of validating an untrusted metric sample. */
export type MetricValidation =
  | { readonly ok: true; readonly sample: MetricSample }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Maximum number of labels a single metric sample may carry. */
export const MAX_METRIC_LABELS = 8;

/** Maximum length of a metric label value (bounded cardinality guard). */
export const MAX_METRIC_LABEL_VALUE_LENGTH = 64;

/**
 * Validate an untrusted metric sample against the D-19.3 allow-list. A
 * malformed metric — unknown name, wrong kind, non-finite value, an unknown or
 * unbounded label key, a session/user/scope id label, or a redactable label
 * value — is rejected and cannot be recorded or exported (task acceptance:
 * "malformed metric cannot pass or export").
 */
export function validateMetricSample(value: unknown): MetricValidation {
  const issues: string[] = [];
  if (value === null || typeof value !== 'object') {
    return { ok: false, issues: ['metric must be an object'] };
  }
  const m = value as Record<string, unknown>;
  if (!isMetricName(m.name)) {
    return { ok: false, issues: [`unknown metric name: ${String(m.name)}`] };
  }
  const name = m.name;
  const expectedKind = METRIC_KINDS[name];
  if (m.kind !== expectedKind) {
    issues.push(`metric ${name} must be kind ${expectedKind}`);
  }
  if (typeof m.value !== 'number' || !Number.isFinite(m.value)) {
    issues.push('metric value must be a finite number');
  }
  if (m.labels === null || typeof m.labels !== 'object' || Array.isArray(m.labels)) {
    issues.push('metric labels must be an object');
    return { ok: false, issues };
  }
  const labels = m.labels as Record<string, unknown>;
  const allowed = METRIC_LABEL_KEYS[name];
  const keys = Object.keys(labels);
  if (keys.length > MAX_METRIC_LABELS) {
    issues.push(`metric ${name} exceeds ${MAX_METRIC_LABELS} labels`);
  }
  for (const key of keys) {
    if (!allowed.includes(key)) {
      issues.push(`metric ${name} has unpermitted label '${key}'`);
      continue;
    }
    const labelValue = labels[key];
    if (typeof labelValue !== 'string') {
      issues.push(`metric ${name} label '${key}' must be a string`);
      continue;
    }
    if (labelValue.length > MAX_METRIC_LABEL_VALUE_LENGTH) {
      issues.push(`metric ${name} label '${key}' exceeds bounded length`);
    }
    if (containsRedactableContent(labelValue)) {
      issues.push(`metric ${name} label '${key}' contains redactable content`);
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    sample: {
      name,
      kind: expectedKind,
      value: m.value as number,
      labels: Object.freeze({ ...(labels as Record<string, string>) }),
    },
  };
}

// ─── Registry revision descriptor (D-19.3 registry-count row) ────────────────

/**
 * A registry/catalog count recorded with its registry revision (D-19.3
 * "Migration/catalog count" metric). The count is descriptive truth bound to a
 * revision, never a hard-coded constant (D-20 migration-registry rule).
 */
export interface RegistryRevisionDescriptor {
  readonly registryType: string;
  readonly applicationRevision: number;
  readonly count: number;
  readonly recordedAt: string;
}

/** Build a validated {@link RegistryRevisionDescriptor} or throw on bad input. */
export function makeRegistryRevisionDescriptor(input: {
  readonly registryType: string;
  readonly applicationRevision: number;
  readonly count: number;
  readonly now?: () => number;
}): RegistryRevisionDescriptor {
  if (typeof input.registryType !== 'string' || input.registryType.length === 0) {
    throw new Error('registryType must be a non-empty string');
  }
  if (!isRevision(input.applicationRevision)) {
    throw new Error('applicationRevision must be a non-negative integer revision');
  }
  if (!Number.isInteger(input.count) || input.count < 0) {
    throw new Error('count must be a non-negative integer');
  }
  const now = input.now ?? Date.now;
  return {
    registryType: input.registryType,
    applicationRevision: input.applicationRevision,
    count: input.count,
    recordedAt: new Date(now()).toISOString(),
  };
}

// ─── Health / readiness (D-19.4) ─────────────────────────────────────────────

/**
 * A scoped-health entry for an optional capability (D-19.4). Reuses the
 * capability status ladder. Reports last-checked and the evidence revision that
 * justified the status.
 */
export interface ScopedHealthEntry {
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly lastCheckedAt: string;
  readonly evidenceRevision?: number;
  readonly reason: string;
}

/**
 * Liveness: whether the event loop/process responds. Liveness does NOT mean
 * ready (D-19.4). A distinct type keeps the two from being conflated.
 */
export interface LivenessReport {
  readonly live: boolean;
  readonly checkedAt: string;
}

/** Build a liveness report. Live means the loop responded; not readiness. */
export function buildLivenessReport(
  live: boolean,
  now: () => number = Date.now,
): LivenessReport {
  return { live, checkedAt: new Date(now()).toISOString() };
}

/**
 * A required readiness capability for the requested profile: schema, integrity,
 * contracts, projections, or a security capability. Readiness is current only
 * when EVERY required capability is `ready` (D-19.4). `degraded`, `unavailable`,
 * or `blocked` in any required capability makes the profile not-ready.
 */
export interface RequiredCapabilityState {
  readonly capability: string;
  readonly status: CapabilityStatus;
}

/**
 * Operational pressure signals that readiness reports (D-19.4): migration
 * state, projection/outbox lag, queue depth, budget pressure, circuit state,
 * and stale evidence. These are descriptive; they do not by themselves flip
 * readiness unless a required capability is not `ready`, but stale evidence is
 * surfaced so a consumer never treats stale as current.
 */
export interface ReadinessSignals {
  readonly migrationState: 'current' | 'pending' | 'blocked';
  readonly projectionLag: number;
  readonly outboxLag: number;
  readonly queueDepth: number;
  readonly budgetPressure: 'none' | 'warning' | 'hard-cap';
  readonly circuitState: 'closed' | 'half-open' | 'open';
  readonly staleEvidence: boolean;
}

/** A readiness report for a requested profile (D-19.4). */
export interface ReadinessReport {
  readonly profile: string;
  readonly ready: boolean;
  readonly requiredCapabilities: readonly RequiredCapabilityState[];
  /** Names of required capabilities that are not `ready`. */
  readonly notReadyCapabilities: readonly string[];
  readonly scopedHealth: readonly ScopedHealthEntry[];
  readonly signals: ReadinessSignals;
  readonly checkedAt: string;
}

/**
 * Compute a readiness report for a profile. Readiness is current only when
 * every required capability is `ready` AND migration state is `current` AND
 * evidence is not stale (D-19.4 "required schema/integrity/contracts/
 * projections/security capabilities for the requested profile are current").
 * Scoped-health entries are advisory and never lift readiness on their own.
 */
export function computeReadiness(input: {
  readonly profile: string;
  readonly requiredCapabilities: readonly RequiredCapabilityState[];
  readonly scopedHealth?: readonly ScopedHealthEntry[];
  readonly signals: ReadinessSignals;
  readonly now?: () => number;
}): ReadinessReport {
  const now = input.now ?? Date.now;
  const notReady = input.requiredCapabilities
    .filter((c) => c.status !== 'ready')
    .map((c) => c.capability);
  const ready =
    notReady.length === 0 &&
    input.signals.migrationState === 'current' &&
    input.signals.staleEvidence === false;
  return {
    profile: input.profile,
    ready,
    requiredCapabilities: Object.freeze([...input.requiredCapabilities]),
    notReadyCapabilities: Object.freeze(notReady),
    scopedHealth: Object.freeze([...(input.scopedHealth ?? [])]),
    signals: input.signals,
    checkedAt: new Date(now()).toISOString(),
  };
}

/** Whether a scoped-health entry is well-formed (status is a known ladder value). */
export function isScopedHealthEntry(value: unknown): value is ScopedHealthEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.capability === 'string' &&
    isCapabilityStatus(e.status) &&
    typeof e.lastCheckedAt === 'string' &&
    typeof e.reason === 'string' &&
    (e.evidenceRevision === undefined || isRevision(e.evidenceRevision))
  );
}

// ─── Diagnostic export (D-19.4, NN-SEC-015) ──────────────────────────────────

/**
 * The bounded payload a diagnostic export may contain (D-19.4): capability
 * matrix, registry-derived counts/revisions, schemas, lag/health, error
 * correlations, and environment fingerprints. It EXCLUDES source content,
 * secrets, and private paths unless explicitly authorized (never here).
 */
export interface DiagnosticExportInput {
  readonly capabilityMatrix: readonly ScopedHealthEntry[];
  readonly registryDescriptors: readonly RegistryRevisionDescriptor[];
  readonly schemas: readonly { readonly name: string; readonly version: number }[];
  readonly readiness: ReadinessReport;
  readonly errorCorrelations: readonly {
    readonly correlationId: string;
    readonly code: string;
    readonly count: number;
  }[];
  readonly environmentFingerprint: string;
  /** Whether the export was authorized by the user (NN-SEC-015). */
  readonly authorized: boolean;
  /** Whether any included session is security-classified (non-exportable). */
  readonly containsSecurityClassifiedSession?: boolean;
}

/** The reasons a diagnostic export aborts (NN-SEC-015, D-19.4). */
export type ExportAbortReason =
  | 'unauthorized'
  | 'security-classified'
  | 'unredactable-content'
  | 'malformed-metric'
  | 'redaction-uncertain';

/**
 * The outcome of a diagnostic export. A success carries the redacted,
 * content-addressed preview payload and NO secret/private path. An abort
 * carries a typed reason and NEVER a partial payload (NN-SEC-015).
 */
export type DiagnosticExportOutcome =
  | {
      readonly ok: true;
      readonly preview: Readonly<Record<string, unknown>>;
      readonly serialized: string;
    }
  | { readonly ok: false; readonly reason: ExportAbortReason; readonly detail: string };

/**
 * The maximum number of bytes a diagnostic export preview may serialize to
 * (bounded export, D-19.4). Exceeding it aborts rather than truncating into a
 * partial payload.
 */
export const MAX_EXPORT_BYTES = 512 * 1024;

/**
 * Build a diagnostic export preview, aborting without partial output if
 * redaction or authorization cannot be completed (NN-SEC-015, D-19.4):
 *
 *   - Unauthorized export aborts (`unauthorized`).
 *   - A security-classified session makes the export non-exportable
 *     (`security-classified`).
 *   - The payload is fully redacted via the diagnostic redaction adapter; if
 *     ANY secret/private-path canary or ambiguous redactable content REMAINS
 *     after redaction, the export aborts (`unredactable-content`).
 *   - If any supplied metric sample is malformed, the export aborts
 *     (`malformed-metric`).
 *   - Over-size or non-serializable payloads abort (`redaction-uncertain`).
 *
 * On success it returns the redacted preview plus its canonical serialization,
 * so the caller can content-address it. There is no path that returns a partial
 * payload.
 */
export function buildDiagnosticExport(
  input: DiagnosticExportInput,
  options: { readonly metrics?: readonly unknown[] } = {},
): DiagnosticExportOutcome {
  if (input.authorized !== true) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: 'diagnostic export requires explicit user authorization',
    };
  }
  if (input.containsSecurityClassifiedSession === true) {
    return {
      ok: false,
      reason: 'security-classified',
      detail: 'security-classified sessions are non-exportable',
    };
  }

  // Any supplied metric must be well-formed; a malformed metric cannot export.
  for (const metric of options.metrics ?? []) {
    const validation = validateMetricSample(metric);
    if (!validation.ok) {
      return {
        ok: false,
        reason: 'malformed-metric',
        detail: validation.issues.join('; '),
      };
    }
  }

  // Assemble the bounded payload, then redact the whole tree.
  const rawPayload = {
    capabilityMatrix: input.capabilityMatrix,
    registryDescriptors: input.registryDescriptors,
    schemas: input.schemas,
    readiness: input.readiness,
    errorCorrelations: input.errorCorrelations,
    environmentFingerprint: input.environmentFingerprint,
  };
  const preview = redactForDiagnostic(rawPayload);

  // Serialize deterministically; abort on any serialization failure.
  let serialized: string;
  try {
    serialized = JSON.stringify(preview);
  } catch {
    return {
      ok: false,
      reason: 'redaction-uncertain',
      detail: 'export payload could not be serialized deterministically',
    };
  }

  // Bounded export: never truncate into a partial payload.
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EXPORT_BYTES) {
    return {
      ok: false,
      reason: 'redaction-uncertain',
      detail: 'export payload exceeds the bounded size and would be partial',
    };
  }

  // Redaction uncertainty aborts export (D-19.4): if any canary survived the
  // redaction pass, we cannot prove the payload is safe.
  if (containsRedactableContent(serialized)) {
    return {
      ok: false,
      reason: 'unredactable-content',
      detail: 'a secret, private path, or ambiguous value survived redaction',
    };
  }

  return {
    ok: true,
    preview: Object.freeze(preview as Record<string, unknown>),
    serialized,
  };
}

/** The authority id that owns the evidence/observability foundation. */
export const EVIDENCE_OBSERVABILITY_OWNER = EVIDENCE_OWNER;

/**
 * Whether product telemetry is enabled. Additive/local-only foundation: product
 * telemetry stays OFF by default (task migration/rollout rule). A build/opt-in
 * may flip this later; the foundation itself emits only local evidence.
 */
export const PRODUCT_TELEMETRY_ENABLED = false as const;
