/**
 * Telemetry privacy: local-only metrics by default, consented export with
 * retention, and redaction-abort on uncertainty or a raw secret canary
 * (NN-OBS-001/002/007, NN-DATA-007, NN-SEC-014/015, D-16.7, D-19).
 *
 * FUT-PKG-04-SECURITY/T-008. The Observability Authority records bounded local
 * liveness / readiness / error / queue / performance metrics ON-DEVICE. Product
 * telemetry EXPORT is OFF by default for every profile (D-16.7). Enabling any
 * export requires an explicit consent transition that names destination,
 * fields, purpose, retention, and revocation. Missing, stale, unavailable, or
 * ambiguous consent keeps export off.
 *
 * The export path previews redaction and ABORTS on uncertainty (NN-SEC-015):
 * IF redaction cannot be completed, OR a raw secret canary is detected
 * (FIX-SECRETS-CANARY-01), THEN export aborts WITHOUT partial output and
 * WITHOUT transmission. There is no "partial export" state.
 *
 * Retention (NN-DATA-007): every local metric row carries an authority-owned
 * age policy; prune removes only rows past the retention horizon.
 *
 * Rollback: `revokeConsent` removes the export capability and disables
 * transmission while PRESERVING the local audit evidence (the consent + export
 * decision rows are append-only).
 *
 * All durable state lives in real SQLite tables owned by this authority; the
 * store is injected so tests use a real temporary better-sqlite3 database with
 * no mocks.
 *
 * Requirements: NN-OBS-001, NN-OBS-002, NN-OBS-007, NN-DATA-007, NN-SEC-014,
 * NN-SEC-015, NN-INV-003, NN-INV-004, NN-INV-011.
 * Design anchors: D-16 (D-16.7), D-19, D-24.
 */

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  type ErrorEnvelope,
} from '../../shared/contract-primitives';
import {
  redactValue,
  containsRedactableContent,
  findUnredactedStringShapedCanaries,
  redactString,
  getFieldOnlyCanaryValues,
} from '../../shared/observable-redaction';

const TELEMETRY_OWNER = 'authority-observability';

// ─── Minimal SQLite surface (real store, injected) ──────────────────────────

/**
 * The subset of the better-sqlite3 `Database` surface this module uses. Kept
 * minimal so a test can pass a real on-disk database directly.
 */
export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatementLike;
}
export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ─── Metrics (local-only by default) ─────────────────────────────────────────

/** The bounded local metric classes the Observability Authority records. */
export const LOCAL_METRIC_CLASSES = Object.freeze([
  'liveness',
  'readiness',
  'error',
  'queue',
  'performance',
] as const);
export type LocalMetricClass = (typeof LOCAL_METRIC_CLASSES)[number];

/** A single local metric sample. Stays on-device unless export is consented. */
export interface LocalMetricSample {
  readonly metricClass: LocalMetricClass;
  readonly name: string;
  readonly value: number;
  /** Bounded, low-cardinality labels. Redacted before persistence. */
  readonly labels: Record<string, string>;
  readonly occurredAtMs: number;
}

// ─── Consent (export off by default) ─────────────────────────────────────────

/**
 * An explicit consent transition that names the five required facets
 * (D-16.7). Absent this exact record, export stays OFF.
 */
export interface ExportConsent {
  readonly destination: string;
  /** Exact metric field names authorized for export (allow-list). */
  readonly fields: readonly string[];
  readonly purpose: string;
  /** Retention horizon at the destination, in milliseconds. */
  readonly retentionMs: number;
  /** Consent validity window; a stale consent keeps export off. */
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
}

/** The result of a consent-state lookup. */
export type ConsentState =
  | { readonly enabled: false; readonly reason: string }
  | { readonly enabled: true; readonly consent: ExportConsent; readonly consentDigest: string };

// ─── Export outcome ───────────────────────────────────────────────────────────

/** The terminal outcome of an export attempt (never partial). */
export type ExportResult =
  /** Consent verified, redaction certain, no canary: safe payload produced. */
  | {
      readonly outcome: 'exported';
      readonly destination: string;
      readonly rowCount: number;
      /** The redacted, field-filtered payload ready for transmission. */
      readonly payload: readonly Record<string, unknown>[];
      readonly consentDigest: string;
    }
  /**
   * Aborted: export is off / consent invalid / redaction uncertain / a raw
   * secret canary was detected. NO output and NO transmission occurred.
   */
  | {
      readonly outcome: 'aborted';
      readonly error: ErrorEnvelope;
      readonly reason:
        | 'export-disabled'
        | 'consent-stale'
        | 'consent-missing'
        | 'redaction-uncertain'
        | 'secret-canary-detected';
    };

function telemetryError(
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: TELEMETRY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Metrics remain local-only until an explicit, unexpired consent naming ' +
      'destination, fields, purpose, retention, and revocation exists. Export ' +
      'aborts with no partial output if redaction is uncertain or a raw secret ' +
      'is detected.',
    redaction: 'internal',
  };
}

// ─── The privacy authority ─────────────────────────────────────────────────────

/**
 * Owns the local metric store, the append-only consent/export audit ledger,
 * and the redaction-aborting export path. Constructing the authority creates
 * its tables if absent (idempotent).
 */
export class TelemetryPrivacyAuthority {
  private readonly db: SqliteLike;

  constructor(db: SqliteLike) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_class TEXT NOT NULL,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        labels_json TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS export_consent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consent_digest TEXT NOT NULL,
        destination TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        purpose TEXT NOT NULL,
        retention_ms INTEGER NOT NULL,
        granted_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL,           -- 'granted' | 'revoked'
        recorded_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS export_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,          -- 'consent-granted' | 'consent-revoked' | 'export' | 'export-aborted'
        detail TEXT NOT NULL,
        consent_digest TEXT,
        recorded_at_ms INTEGER NOT NULL
      );
    `);
  }

  /**
   * Record a local metric sample. Labels are redacted before persistence so a
   * caller that accidentally passes a secret in a label cannot leak it into the
   * local store (defense in depth, NN-INV-004). Metrics NEVER leave the device
   * on this path (NN-OBS-007).
   */
  recordMetric(sample: LocalMetricSample): void {
    const safeLabels = redactValue(sample.labels);
    this.db
      .prepare(
        `INSERT INTO local_metrics
           (metric_class, name, value, labels_json, occurred_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sample.metricClass,
        sample.name,
        sample.value,
        JSON.stringify(safeLabels),
        sample.occurredAtMs,
      );
  }

  /** Count local metric rows (test/diagnostic helper). */
  localMetricCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM local_metrics`)
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * Grant export consent. This is the ONLY transition that can enable export;
   * it is appended to the audit ledger. Returns the consent digest.
   */
  grantConsent(consent: ExportConsent, nowMs: number): string {
    const consentDigest = computeDigest({
      destination: consent.destination,
      fields: [...consent.fields].sort(),
      purpose: consent.purpose,
      retentionMs: consent.retentionMs,
      grantedAtMs: consent.grantedAtMs,
      expiresAtMs: consent.expiresAtMs,
    });
    this.db
      .prepare(
        `INSERT INTO export_consent
           (consent_digest, destination, fields_json, purpose, retention_ms,
            granted_at_ms, expires_at_ms, state, recorded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'granted', ?)`,
      )
      .run(
        consentDigest,
        consent.destination,
        JSON.stringify(consent.fields),
        consent.purpose,
        consent.retentionMs,
        consent.grantedAtMs,
        consent.expiresAtMs,
        nowMs,
      );
    this.appendAudit('consent-granted', `destination=${consent.destination}`, consentDigest, nowMs);
    return consentDigest;
  }

  /**
   * Revoke export consent (rollback of the export capability). The consent row
   * is marked revoked and an audit row is appended; the append-only audit
   * evidence is PRESERVED (NN-DATA-007, task rollback rule).
   */
  revokeConsent(consentDigest: string, nowMs: number): void {
    this.db
      .prepare(`UPDATE export_consent SET state = 'revoked' WHERE consent_digest = ?`)
      .run(consentDigest);
    this.appendAudit('consent-revoked', 'export capability revoked', consentDigest, nowMs);
  }

  /**
   * Resolve the current export-consent state. Export is enabled only when a
   * `granted` (not revoked), unexpired consent exists at `nowMs`. Otherwise it
   * returns a typed disabled reason (fail closed, NN-INV-001).
   */
  consentState(nowMs: number): ConsentState {
    const row = this.db
      .prepare(
        `SELECT consent_digest, destination, fields_json, purpose, retention_ms,
                granted_at_ms, expires_at_ms
           FROM export_consent
          WHERE state = 'granted'
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get() as
      | {
          consent_digest: string;
          destination: string;
          fields_json: string;
          purpose: string;
          retention_ms: number;
          granted_at_ms: number;
          expires_at_ms: number;
        }
      | undefined;

    if (!row) return { enabled: false, reason: 'no granted consent (export off by default)' };
    if (nowMs < row.granted_at_ms) {
      return { enabled: false, reason: 'consent not yet valid' };
    }
    if (nowMs >= row.expires_at_ms) {
      return { enabled: false, reason: 'consent expired (stale)' };
    }
    const fields = JSON.parse(row.fields_json) as string[];
    return {
      enabled: true,
      consentDigest: row.consent_digest,
      consent: {
        destination: row.destination,
        fields,
        purpose: row.purpose,
        retentionMs: row.retention_ms,
        grantedAtMs: row.granted_at_ms,
        expiresAtMs: row.expires_at_ms,
      },
    };
  }

  /**
   * Attempt a consented export of local metrics. The full guard sequence:
   *
   *   1. Consent must be granted and unexpired, else abort `export-disabled` /
   *      `consent-stale` / `consent-missing`.
   *   2. Only the consented fields are projected (allow-list, NN-SEC-014).
   *   3. Every projected string is passed through redaction; if any string
   *      STILL contains redactable content after scrubbing, redaction is
   *      uncertain → abort `redaction-uncertain` (NN-SEC-015).
   *   4. A raw secret canary (FIX-SECRETS-CANARY-01) anywhere in the payload →
   *      abort `secret-canary-detected`.
   *
   * On any abort NO payload is produced and NO transmission occurs; an audit
   * row records the aborted attempt (NN-INV-011). Success returns the redacted,
   * field-filtered payload for the caller to transmit.
   */
  exportMetrics(nowMs: number, correlationId?: string): ExportResult {
    const state = this.consentState(nowMs);
    if (!state.enabled) {
      const abortReason = state.reason.includes('expired')
        ? ('consent-stale' as const)
        : state.reason.includes('no granted')
          ? ('export-disabled' as const)
          : ('consent-missing' as const);
      this.appendAudit('export-aborted', state.reason, null, nowMs);
      return {
        outcome: 'aborted',
        reason: abortReason,
        error: telemetryError(
          'FORBIDDEN',
          `export aborted: ${state.reason}`,
          'export-metrics',
          correlationId,
        ),
      };
    }

    const allow = new Set(state.consent.fields);
    const rows = this.db
      .prepare(
        `SELECT metric_class, name, value, labels_json, occurred_at_ms
           FROM local_metrics
          ORDER BY id ASC`,
      )
      .all() as {
      metric_class: string;
      name: string;
      value: number;
      labels_json: string;
      occurred_at_ms: number;
    }[];

    const payload: Record<string, unknown>[] = [];
    for (const r of rows) {
      const full: Record<string, unknown> = {
        metricClass: r.metric_class,
        name: r.name,
        value: r.value,
        labels: JSON.parse(r.labels_json),
        occurredAtMs: r.occurred_at_ms,
      };
      const projected: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(full)) {
        if (allow.has(k)) projected[k] = v;
      }
      // Redact the projected row (defense in depth over the allow-list).
      payload.push(redactValue(projected));
    }

    // Serialize the whole payload once for the redaction-certainty and canary
    // sweeps. If redaction were uncertain the serialized form would still hold
    // redactable content or an intact field-only canary.
    const serialized = JSON.stringify(payload);

    // Guard 3: redaction certainty. If any redactable shape survived, abort.
    if (containsRedactableContent(serialized)) {
      this.appendAudit('export-aborted', 'redaction uncertain', state.consentDigest, nowMs);
      return {
        outcome: 'aborted',
        reason: 'redaction-uncertain',
        error: telemetryError(
          'INTEGRITY',
          'export aborted: redaction could not be completed',
          'export-metrics',
          correlationId,
        ),
      };
    }

    // Guard 4: raw secret canary. A field-only canary value (a bare secret
    // string that no regex shape catches) surviving in the payload means a raw
    // secret is present — abort with no transmission (FIX-SECRETS-CANARY-01).
    const stringShaped = findUnredactedStringShapedCanaries(serialized);
    const fieldOnlyPresent = getFieldOnlyCanaryValues().filter((c) => serialized.includes(c));
    if (stringShaped.length > 0 || fieldOnlyPresent.length > 0) {
      this.appendAudit('export-aborted', 'raw secret canary detected', state.consentDigest, nowMs);
      return {
        outcome: 'aborted',
        reason: 'secret-canary-detected',
        error: telemetryError(
          'INTEGRITY',
          'export aborted: raw secret detected in export payload',
          'export-metrics',
          correlationId,
        ),
      };
    }

    this.appendAudit(
      'export',
      `destination=${state.consent.destination}; rows=${payload.length}`,
      state.consentDigest,
      nowMs,
    );
    return {
      outcome: 'exported',
      destination: state.consent.destination,
      rowCount: payload.length,
      payload,
      consentDigest: state.consentDigest,
    };
  }

  /**
   * Prune local metrics older than the retention horizon (NN-DATA-007). Rows at
   * or newer than `nowMs - retentionMs` are preserved. Returns pruned count.
   */
  pruneLocalMetrics(nowMs: number, retentionMs: number): number {
    const horizon = nowMs - retentionMs;
    const before = this.localMetricCount();
    this.db.prepare(`DELETE FROM local_metrics WHERE occurred_at_ms < ?`).run(horizon);
    return before - this.localMetricCount();
  }

  /** Read the append-only export audit ledger (rollback evidence preserved). */
  auditTrail(): {
    action: string;
    detail: string;
    consentDigest: string | null;
    recordedAtMs: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT action, detail, consent_digest, recorded_at_ms
           FROM export_audit ORDER BY id ASC`,
      )
      .all() as {
      action: string;
      detail: string;
      consent_digest: string | null;
      recorded_at_ms: number;
    }[];
    return rows.map((r) => ({
      action: r.action,
      detail: r.detail,
      consentDigest: r.consent_digest,
      recordedAtMs: r.recorded_at_ms,
    }));
  }

  private appendAudit(
    action: string,
    detail: string,
    consentDigest: string | null,
    nowMs: number,
  ): void {
    // Redact the detail defensively — it is a human string that must never
    // carry a secret or private path into the audit ledger (NN-INV-004).
    this.db
      .prepare(
        `INSERT INTO export_audit (action, detail, consent_digest, recorded_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(action, redactString(detail), consentDigest, nowMs);
  }
}
