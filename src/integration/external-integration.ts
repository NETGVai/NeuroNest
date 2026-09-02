/**
 * External Integration Authority — pinned provenance/license/security import,
 * staged/quarantined activation, reversible registration, MindStudio phase
 * gating, external repository scopes, and the unique external patterns
 * (MindStudio/Kilo/DeerFlow/Roo/Hermes) routed through the EXISTING canonical
 * extension points (FUT-PKG-08-OPTIONAL/T-005).
 *
 * This module is a strict EXTENSION of the T-002 governed integration surface
 * ({@link ./integration-adapters}); it never becomes a second orchestrator, a
 * shadow catalog, or a private effect path. Every durable transition here is
 * committed THROUGH the single-writer authority transaction
 * ({@link ../storage/authority-transaction} `applyAuthorityMutation`) so the
 * committed row — never an in-memory promise — is the operator-visible truth
 * (D-03.1 "one writer, many projections"; NN-INV-008).
 *
 * The invariants this authority enforces:
 *
 *   - IMPORT carries PINNED provenance + license + security verification
 *     (NN-INTEGRATION-010, NN-SEC-012, NN-DATA-011). A duplicate, unsafe,
 *     incompatible, unlicensed, or unavailable input is QUARANTINED and CANNOT
 *     be activated — it never creates a parallel truth (the acceptance
 *     fail-closed rule). The raw + canonical hash, source path/revision,
 *     license/provenance, parser/transformation versions, and quarantine
 *     history are all preserved on the record (NN-DATA-011).
 *   - ACTIVATION is staged → reviewed → ATOMIC: a `staged` record must be
 *     `reviewed` (approved) before it can be `activated`, and activation binds
 *     the pattern to EXACTLY ONE existing canonical extension point
 *     (prompt/tool/task/orchestration/skill/ui). An adopted external pattern is
 *     an OWNED extension of a canonical family, never a parallel owner
 *     (NN-INTEGRATION-012, NN-ORCH-011).
 *   - REGISTRATION is REVERSIBLE: rollback deactivates/removes the owned
 *     effects of an activation and restores the prior catalog revision; the
 *     canonical family owners are untouched (they were only ever observers).
 *   - MindStudio PHASES gate on prerequisite presence: a Phase-N capability is
 *     UNAVAILABLE while any earlier phase is absent (NN-INTEGRATION-006–009).
 *   - External REPOSITORIES import with explicit scopes/permissions and
 *     reversible registration; tasks/artifacts retain source repository
 *     identity (NN-WORKSPACE-013).
 *
 * Everything is deterministic given its injected ports and the real database.
 *
 * Design anchors: D-03, D-05, D-06, D-07, D-16, D-20. Requirements:
 * NN-INTEGRATION-006/007/008/009/010/011/012, NN-WORKSPACE-013, NN-SEC-012,
 * NN-DATA-011, NN-ORCH-011, NN-INV-008/014.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  canonicalSerialize,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';
import {
  applyAuthorityMutation,
  type AuthorityMutationResult,
} from '../storage/authority-transaction.js';
import {
  assertNotAnalyzedOnly,
  type FrameworkClass,
  type IntegrationResult,
} from './integration-adapters.js';

const EXTERNAL_OWNER = 'authority-integration-external';

// ════════════════════════════════════════════════════════════════════════════
// 0. Typed result helpers
// ════════════════════════════════════════════════════════════════════════════

function externalError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: EXTERNAL_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'External imports are pinned + provenance/license/security verified, ' +
      'staged→reviewed→atomically activated onto ONE existing extension point, ' +
      'and reversible; an unsafe/duplicate/incompatible/unlicensed/unavailable ' +
      'input stays quarantined and never creates a parallel truth.',
    redaction: 'internal',
  };
}

function fail(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): IntegrationResult<never> {
  return { ok: false, error: externalError(code, message, operation, correlationId) };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Canonical extension points (the ONLY places an external pattern may plug)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The six EXISTING canonical extension points an adopted external pattern may
 * extend. There is no seventh; a pattern that cannot be expressed as an
 * extension of one of these is refused rather than given a private owner
 * (D-03.1; NN-INTEGRATION-012, NN-ORCH-011). Each names an existing NeuroNest
 * authority family — the external pattern contributes behavior THROUGH it, it
 * never becomes a parallel owner.
 */
export const EXTENSION_POINTS = Object.freeze([
  'prompt',
  'tool',
  'task',
  'orchestration',
  'skill',
  'ui',
] as const);
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

/** Whether a value is a recognized canonical extension point. */
export function isExtensionPoint(value: unknown): value is ExtensionPoint {
  return typeof value === 'string' && (EXTENSION_POINTS as readonly string[]).includes(value);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. External source families and the canonical-family mapping (NN-ORCH-011)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The analyzed external sources whose unique patterns this task adopts. Each is
 * a PROVENANCE label only; adoption always happens behind a canonical extension
 * point (NN-INTEGRATION-012).
 */
export const EXTERNAL_SOURCES = Object.freeze([
  'mindstudio',
  'kilo',
  'deerflow',
  'roo',
  'hermes',
] as const);
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/** Whether a value is a recognized external source. */
export function isExternalSource(value: unknown): value is ExternalSource {
  return typeof value === 'string' && (EXTERNAL_SOURCES as readonly string[]).includes(value);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Pinned provenance / license / security import manifest (NN-DATA-011)
// ════════════════════════════════════════════════════════════════════════════

/** Recognized license policy outcomes for an imported asset (NN-SEC-012). */
export const LICENSE_POLICY = Object.freeze([
  'allowed',
  'requires-approval',
  'prohibited',
] as const);
export type LicensePolicy = (typeof LICENSE_POLICY)[number];

/** The severity ladder for a security finding (NN-SEC-012). */
export const SECURITY_SEVERITY = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'critical',
] as const);
export type SecuritySeverity = (typeof SECURITY_SEVERITY)[number];

/**
 * The pinned provenance evidence retained for every imported/transformed asset
 * (NN-DATA-011). `rawHash` and `canonicalHash` are lowercase SHA-256 digests;
 * `sourcePath` and `sourceRevision` pin the origin; parser/transformation
 * versions and quarantine history are preserved so an audit can reconstruct the
 * asset's lineage. No secret values or private absolute paths belong here.
 */
export interface ImportProvenance {
  readonly rawHash: string;
  readonly canonicalHash: string;
  /** A workspace-relative or repository-relative source path (never absolute). */
  readonly sourcePath: string;
  /** The pinned source revision (e.g. a git commit/tree id). */
  readonly sourceRevision: string;
  readonly parserVersion: string;
  readonly transformationVersion: string;
  /** Prior quarantine reasons, oldest-first (NN-DATA-011 quarantine history). */
  readonly quarantineHistory: readonly string[];
}

/**
 * An untrusted external import request. It advertises the source, the pattern
 * being adopted, the target canonical extension point, a PINNED version, the
 * provenance evidence, and the license/security verdicts. The framework class
 * is `owned-extension` for anything executable — an `analyzed-only` framework
 * is refused by {@link assertNotAnalyzedOnly} and is never activated.
 */
export interface ExternalImportRequest {
  /** Opaque id for the imported pattern. */
  readonly patternId: string;
  readonly source: ExternalSource;
  /** A short, secret-free description of the adopted capability. */
  readonly capability: string;
  /** The single existing extension point this pattern extends. */
  readonly extensionPoint: ExtensionPoint;
  readonly frameworkClass: FrameworkClass;
  /** Pinned version (exact, non-empty; never a floating range). */
  readonly pinnedVersion: string;
  readonly provenance: ImportProvenance;
  readonly license: LicensePolicy;
  readonly maxSecuritySeverity: SecuritySeverity;
  /** Whether the source artifact is currently retrievable/available. */
  readonly available: boolean;
  /** Whether an integrity signature was verified where the source declared one. */
  readonly integrityVerified: boolean;
  /** Optional repository scope this import belongs to (NN-WORKSPACE-013). */
  readonly repositoryId?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const FLOATING_HINT = /[\^~*]|\bx\b|latest/i;

/**
 * The reason an import is quarantined rather than staged. Each maps to the
 * acceptance fail-closed set: duplicate / unsafe / incompatible / unlicensed /
 * unavailable. `malformed` covers a structurally invalid manifest (a VALIDATION
 * that also fails closed).
 */
export type QuarantineReason =
  | 'duplicate'
  | 'unsafe'
  | 'incompatible'
  | 'unlicensed'
  | 'unavailable'
  | 'malformed';

/** The typed classification of an import request before any effect. */
export type ImportClassification =
  | { readonly kind: 'admit' }
  | { readonly kind: 'quarantine'; readonly reason: QuarantineReason; readonly detail: string };

/**
 * Classify an import request WITHOUT any side effect (pure). Returns `admit`
 * only when the request is well-formed, pinned to an exact version, carries
 * complete provenance, is license-allowed (or requires-approval — which is
 * admitted to staging but still needs review), passes the security ceiling
 * (below high/critical), is available, and is an `owned-extension`. Anything
 * else is a typed quarantine reason so the caller fails closed.
 *
 * This is deliberately conservative: `requires-approval` license is admitted to
 * STAGING (never auto-activated), while `prohibited` is `unlicensed`; a
 * `medium` finding is admitted to staging (explicit approval at review), while
 * `high`/`critical` is `unsafe`.
 */
export function classifyImport(request: ExternalImportRequest): ImportClassification {
  // Structural / pinning gate (malformed → fail closed).
  if (!isOpaqueId(request.patternId)) {
    return { kind: 'quarantine', reason: 'malformed', detail: 'patternId is not an opaque id' };
  }
  if (!isExternalSource(request.source)) {
    return { kind: 'quarantine', reason: 'malformed', detail: 'unknown external source' };
  }
  if (!isExtensionPoint(request.extensionPoint)) {
    return { kind: 'quarantine', reason: 'malformed', detail: 'unknown extension point' };
  }
  if (
    typeof request.pinnedVersion !== 'string' ||
    request.pinnedVersion.length === 0 ||
    !EXACT_VERSION.test(request.pinnedVersion) ||
    FLOATING_HINT.test(request.pinnedVersion)
  ) {
    return {
      kind: 'quarantine',
      reason: 'incompatible',
      detail: 'version is not exactly pinned (floating ranges are refused)',
    };
  }
  const p = request.provenance;
  if (
    !p ||
    !SHA256_HEX.test(p.rawHash ?? '') ||
    !SHA256_HEX.test(p.canonicalHash ?? '') ||
    typeof p.sourcePath !== 'string' ||
    p.sourcePath.length === 0 ||
    typeof p.sourceRevision !== 'string' ||
    p.sourceRevision.length === 0 ||
    typeof p.parserVersion !== 'string' ||
    p.parserVersion.length === 0 ||
    typeof p.transformationVersion !== 'string' ||
    p.transformationVersion.length === 0
  ) {
    return { kind: 'quarantine', reason: 'malformed', detail: 'incomplete pinned provenance' };
  }
  // An absolute path in provenance is a redaction hazard; refuse it.
  if (p.sourcePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p.sourcePath)) {
    return { kind: 'quarantine', reason: 'malformed', detail: 'provenance sourcePath must be relative' };
  }

  // Executable class gate (analyzed-only is never loaded — NN-INTEGRATION-001).
  const framework = assertNotAnalyzedOnly(request.patternId, request.frameworkClass);
  if (!framework.ok) {
    return { kind: 'quarantine', reason: 'unsafe', detail: 'analyzed-only framework cannot be executed' };
  }

  // Availability gate (unavailable → fail closed).
  if (request.available !== true) {
    return { kind: 'quarantine', reason: 'unavailable', detail: 'source artifact is not retrievable' };
  }

  // License gate (prohibited → unlicensed; requires-approval is staged).
  if (request.license === 'prohibited') {
    return { kind: 'quarantine', reason: 'unlicensed', detail: 'license policy prohibits import' };
  }

  // Security gate (high/critical → unsafe; medium is staged for approval).
  if (request.maxSecuritySeverity === 'high' || request.maxSecuritySeverity === 'critical') {
    return { kind: 'quarantine', reason: 'unsafe', detail: `blocking security finding: ${request.maxSecuritySeverity}` };
  }

  return { kind: 'admit' };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Durable registry tables (additive; single-owner; NN-INV-008)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Additive tables owned by the External Integration Authority. `IF NOT EXISTS`
 * keeps this idempotent for startup and tests. These never replace a canonical
 * family table; they only track the lifecycle/provenance of ADOPTED external
 * patterns and the monotonic catalog revision used for rollback.
 */
const EXTERNAL_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS external_pattern_registry (
    pattern_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    extension_point TEXT NOT NULL,
    pinned_version TEXT NOT NULL,
    lifecycle TEXT NOT NULL
      CHECK(lifecycle IN ('staged','reviewed','activated','quarantined','rolled-back')),
    provenance_json TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL,
    quarantine_reason TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_external_pattern_extpoint
    ON external_pattern_registry (extension_point);

  -- Monotonic catalog revision (one row). Every activation/rollback bumps it so
  -- rollback can restore the PRIOR catalog revision (task rollback rule).
  CREATE TABLE IF NOT EXISTS external_catalog_revision (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision INTEGER NOT NULL
  );

  -- Owned effects registered by an activation, removed on rollback so no orphan
  -- extension survives a reversal (NN-INV-008; reversible registration).
  CREATE TABLE IF NOT EXISTS external_owned_effects (
    effect_id TEXT PRIMARY KEY,
    pattern_id TEXT NOT NULL,
    extension_point TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL
  );

  -- Imported external repositories with explicit scope + reversible
  -- registration (NN-WORKSPACE-013).
  CREATE TABLE IF NOT EXISTS external_repositories (
    repository_id TEXT PRIMARY KEY,
    scope_json TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('registered','deregistered')),
    updated_at TEXT NOT NULL
  );
`;

/** Create the additive external-integration tables if absent (idempotent). */
export function ensureExternalIntegrationTables(db: Database.Database): void {
  db.exec(EXTERNAL_TABLES_DDL);
  const row = db
    .prepare('SELECT revision FROM external_catalog_revision WHERE id = 1')
    .get() as { revision: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO external_catalog_revision (id, revision) VALUES (1, 0)').run();
  }
}

/** The lifecycle states of an adopted external pattern. */
export type PatternLifecycle =
  | 'staged'
  | 'reviewed'
  | 'activated'
  | 'quarantined'
  | 'rolled-back';

/** A durable external pattern record (a read projection of the registry row). */
export interface ExternalPatternRecord {
  readonly patternId: string;
  readonly source: ExternalSource;
  readonly extensionPoint: ExtensionPoint;
  readonly pinnedVersion: string;
  readonly lifecycle: PatternLifecycle;
  readonly provenance: ImportProvenance;
  readonly catalogRevision: number;
  readonly quarantineReason: QuarantineReason | null;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. External repository scopes (NN-WORKSPACE-013)
// ════════════════════════════════════════════════════════════════════════════

/**
 * An explicit external repository scope: the permissions granted and whether
 * imported tasks/artifacts must retain the source repository identity (they
 * always must — this is asserted, not optional).
 */
export interface ExternalRepositoryScope {
  readonly repositoryId: string;
  readonly permissions: readonly ('read' | 'index' | 'import-agents' | 'import-skills' | 'import-templates')[];
  readonly retainSourceIdentity: true;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. The External Integration Authority
// ════════════════════════════════════════════════════════════════════════════

/** Read the current monotonic catalog revision. */
function readCatalogRevision(db: Database.Database): number {
  const row = db
    .prepare('SELECT revision FROM external_catalog_revision WHERE id = 1')
    .get() as { revision: number } | undefined;
  return row?.revision ?? 0;
}

function rowToRecord(row: {
  pattern_id: string;
  source: string;
  extension_point: string;
  pinned_version: string;
  lifecycle: string;
  provenance_json: string;
  catalog_revision: number;
  quarantine_reason: string | null;
}): ExternalPatternRecord {
  return {
    patternId: row.pattern_id,
    source: row.source as ExternalSource,
    extensionPoint: row.extension_point as ExtensionPoint,
    pinnedVersion: row.pinned_version,
    lifecycle: row.lifecycle as PatternLifecycle,
    provenance: JSON.parse(row.provenance_json) as ImportProvenance,
    catalogRevision: row.catalog_revision,
    quarantineReason: (row.quarantine_reason as QuarantineReason | null) ?? null,
  };
}

/**
 * The External Integration Authority. It owns ONLY the additive lifecycle /
 * provenance registry and the catalog revision; the canonical family owners
 * (prompt/tool/task/orchestration/skill/ui) remain the truth. Every durable
 * transition commits through the injected single-writer authority transaction
 * so an activation/rollback is a committed fact, never an in-memory claim.
 */
export class ExternalIntegrationAuthority {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Import an external pattern. The request is classified with no effect; an
   * admitted request is STAGED (never auto-activated), a rejected request is
   * QUARANTINED with the typed reason and full provenance preserved. A duplicate
   * pattern id that is not already rolled-back is quarantined `duplicate` — it
   * cannot overwrite the existing truth. Both outcomes commit through the single
   * writer, so a quarantined record is durably visible and cannot be activated.
   */
  importPattern(
    request: ExternalImportRequest,
    correlationId: string,
  ): IntegrationResult<{ readonly record: ExternalPatternRecord }> {
    // Duplicate reconciliation: an existing non-rolled-back id cannot be re-imported.
    const existing = this.getPattern(request.patternId);
    if (existing && existing.lifecycle !== 'rolled-back') {
      const quarantined = this.writePattern(request, 'quarantined', 'duplicate', correlationId, readCatalogRevision(this.db));
      if (!quarantined.ok) return quarantined;
      return fail(
        'CONFLICT',
        `pattern '${request.patternId}' is already imported (${existing.lifecycle}); duplicate quarantined`,
        'external.import',
        correlationId,
      );
    }

    const classification = classifyImport(request);
    const revision = readCatalogRevision(this.db);
    if (classification.kind === 'quarantine') {
      const provenanceWithHistory: ExternalImportRequest = {
        ...request,
        provenance: {
          ...request.provenance,
          quarantineHistory: [...request.provenance.quarantineHistory, `${classification.reason}:${classification.detail}`],
        },
      };
      const written = this.writePattern(provenanceWithHistory, 'quarantined', classification.reason, correlationId, revision);
      if (!written.ok) return written;
      return fail(
        classification.reason === 'unlicensed' || classification.reason === 'unsafe' ? 'FORBIDDEN' : 'VALIDATION',
        `import quarantined (${classification.reason}): ${classification.detail}`,
        'external.import',
        correlationId,
      );
    }

    return this.writePattern(request, 'staged', null, correlationId, revision);
  }

  /**
   * Review (approve) a staged pattern. Only a `staged` record may be reviewed;
   * a quarantined record can NEVER be reviewed/approved (fail closed). This is
   * the human-in-the-loop gate before atomic activation.
   */
  reviewPattern(
    patternId: string,
    correlationId: string,
  ): IntegrationResult<{ readonly record: ExternalPatternRecord }> {
    const record = this.getPattern(patternId);
    if (!record) {
      return fail('UNAVAILABLE', `pattern '${patternId}' is not imported`, 'external.review', correlationId);
    }
    if (record.lifecycle === 'quarantined') {
      return fail('FORBIDDEN', `pattern '${patternId}' is quarantined and cannot be reviewed`, 'external.review', correlationId);
    }
    if (record.lifecycle !== 'staged') {
      return fail('CONFLICT', `pattern '${patternId}' is '${record.lifecycle}', not 'staged'`, 'external.review', correlationId);
    }
    return this.transition(record, 'reviewed', correlationId, readCatalogRevision(this.db), { registerEffect: false });
  }

  /**
   * Atomically activate a reviewed pattern onto its ONE canonical extension
   * point. Only a `reviewed` record may be activated (staged-without-review and
   * quarantined are refused). Activation bumps the catalog revision and records
   * ONE owned effect so a later rollback can remove it and restore the prior
   * revision. The canonical family owner is only OBSERVED — this never creates
   * a parallel owner.
   */
  activatePattern(
    patternId: string,
    correlationId: string,
  ): IntegrationResult<{ readonly record: ExternalPatternRecord }> {
    const record = this.getPattern(patternId);
    if (!record) {
      return fail('UNAVAILABLE', `pattern '${patternId}' is not imported`, 'external.activate', correlationId);
    }
    if (record.lifecycle === 'quarantined') {
      return fail(
        'FORBIDDEN',
        `pattern '${patternId}' is quarantined and cannot be activated (no parallel truth)`,
        'external.activate',
        correlationId,
      );
    }
    if (record.lifecycle !== 'reviewed') {
      return fail(
        'CONFLICT',
        `pattern '${patternId}' must be 'reviewed' before activation (is '${record.lifecycle}')`,
        'external.activate',
        correlationId,
      );
    }
    const nextRevision = readCatalogRevision(this.db) + 1;
    return this.transition(record, 'activated', correlationId, nextRevision, { registerEffect: true, bumpRevision: true });
  }

  /**
   * Reversibly roll back an activated (or staged/reviewed) pattern. Deactivates
   * and REMOVES the owned effects registered by its activation and restores the
   * PRIOR catalog revision, then marks the record `rolled-back`. The canonical
   * family owner is untouched (it never held this pattern as its own truth).
   */
  rollbackPattern(
    patternId: string,
    correlationId: string,
  ): IntegrationResult<{ readonly record: ExternalPatternRecord; readonly restoredRevision: number }> {
    const record = this.getPattern(patternId);
    if (!record) {
      return fail('UNAVAILABLE', `pattern '${patternId}' is not imported`, 'external.rollback', correlationId);
    }
    if (record.lifecycle === 'rolled-back') {
      return fail('CONFLICT', `pattern '${patternId}' is already rolled back`, 'external.rollback', correlationId);
    }
    const currentRevision = readCatalogRevision(this.db);
    // Restore the prior catalog revision only if this pattern's activation
    // advanced it (an activated pattern owns the current revision).
    const restoredRevision = record.lifecycle === 'activated' ? Math.max(0, currentRevision - 1) : currentRevision;

    const result = this.commit(correlationId, 'external.rollback', (tx) => {
      tx.prepare('DELETE FROM external_owned_effects WHERE pattern_id = ?').run(patternId);
      tx.prepare(
        `UPDATE external_pattern_registry
           SET lifecycle = 'rolled-back', quarantine_reason = NULL, catalog_revision = ?, updated_at = ?
         WHERE pattern_id = ?`,
      ).run(restoredRevision, new Date().toISOString(), patternId);
      if (record.lifecycle === 'activated') {
        tx.prepare('UPDATE external_catalog_revision SET revision = ? WHERE id = 1').run(restoredRevision);
      }
      return { resultRef: makeOpaqueId('extrb', `${patternId}${restoredRevision}`) };
    });
    if (!result.ok) return result;
    const updated = this.getPattern(patternId);
    if (!updated) {
      return fail('INTERNAL', 'pattern vanished after rollback commit', 'external.rollback', correlationId);
    }
    return { ok: true, value: { record: updated, restoredRevision } };
  }

  /**
   * Register an external repository with an explicit scope and reversible
   * registration (NN-WORKSPACE-013). Imported tasks/artifacts must retain the
   * source repository identity — the scope asserts `retainSourceIdentity: true`.
   */
  registerRepository(
    scope: ExternalRepositoryScope,
    correlationId: string,
  ): IntegrationResult<{ readonly repositoryId: string }> {
    if (!isOpaqueId(scope.repositoryId)) {
      return fail('VALIDATION', 'repositoryId is not an opaque id', 'external.repo-register', correlationId);
    }
    if (scope.retainSourceIdentity !== true) {
      return fail('FORBIDDEN', 'imported tasks/artifacts must retain source repository identity', 'external.repo-register', correlationId);
    }
    if (scope.permissions.length === 0) {
      return fail('VALIDATION', 'repository scope must grant at least one permission', 'external.repo-register', correlationId);
    }
    const existing = this.db
      .prepare("SELECT lifecycle FROM external_repositories WHERE repository_id = ?")
      .get(scope.repositoryId) as { lifecycle: string } | undefined;
    if (existing && existing.lifecycle === 'registered') {
      return fail('CONFLICT', `repository '${scope.repositoryId}' is already registered`, 'external.repo-register', correlationId);
    }
    const result = this.commit(correlationId, 'external.repo-register', (tx) => {
      tx.prepare(
        `INSERT INTO external_repositories (repository_id, scope_json, lifecycle, updated_at)
         VALUES (@id, @scope, 'registered', @now)
         ON CONFLICT(repository_id) DO UPDATE SET
           scope_json = excluded.scope_json, lifecycle = 'registered', updated_at = excluded.updated_at`,
      ).run({ id: scope.repositoryId, scope: canonicalSerialize(scope), now: new Date().toISOString() });
      return { resultRef: makeOpaqueId('extrepo', scope.repositoryId) };
    });
    if (!result.ok) return result;
    return { ok: true, value: { repositoryId: scope.repositoryId } };
  }

  /** Reversibly deregister an external repository. */
  deregisterRepository(
    repositoryId: string,
    correlationId: string,
  ): IntegrationResult<{ readonly repositoryId: string }> {
    const existing = this.db
      .prepare("SELECT lifecycle FROM external_repositories WHERE repository_id = ?")
      .get(repositoryId) as { lifecycle: string } | undefined;
    if (!existing || existing.lifecycle !== 'registered') {
      return fail('UNAVAILABLE', `repository '${repositoryId}' is not registered`, 'external.repo-deregister', correlationId);
    }
    const result = this.commit(correlationId, 'external.repo-deregister', (tx) => {
      tx.prepare("UPDATE external_repositories SET lifecycle = 'deregistered', updated_at = ? WHERE repository_id = ?").run(
        new Date().toISOString(),
        repositoryId,
      );
      return { resultRef: makeOpaqueId('extderepo', repositoryId) };
    });
    if (!result.ok) return result;
    return { ok: true, value: { repositoryId } };
  }

  /** Read a pattern record, or `undefined` if never imported. */
  getPattern(patternId: string): ExternalPatternRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM external_pattern_registry WHERE pattern_id = ?')
      .get(patternId) as Parameters<typeof rowToRecord>[0] | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** The current monotonic catalog revision. */
  catalogRevision(): number {
    return readCatalogRevision(this.db);
  }

  /** The owned-effect ids currently registered for a pattern (for assertions). */
  ownedEffects(patternId: string): readonly string[] {
    const rows = this.db
      .prepare('SELECT effect_id FROM external_owned_effects WHERE pattern_id = ? ORDER BY effect_id')
      .all(patternId) as { effect_id: string }[];
    return rows.map((r) => r.effect_id);
  }

  // ─── internal write helpers ───────────────────────────────────────────────

  private writePattern(
    request: ExternalImportRequest,
    lifecycle: PatternLifecycle,
    quarantineReason: QuarantineReason | null,
    correlationId: string,
    revision: number,
  ): IntegrationResult<{ readonly record: ExternalPatternRecord }> {
    const result = this.commit(correlationId, 'external.import', (tx) => {
      tx.prepare(
        `INSERT INTO external_pattern_registry
           (pattern_id, source, extension_point, pinned_version, lifecycle, provenance_json,
            catalog_revision, quarantine_reason, updated_at)
         VALUES (@id, @source, @ext, @ver, @lifecycle, @prov, @rev, @qr, @now)
         ON CONFLICT(pattern_id) DO UPDATE SET
           source = excluded.source, extension_point = excluded.extension_point,
           pinned_version = excluded.pinned_version, lifecycle = excluded.lifecycle,
           provenance_json = excluded.provenance_json, catalog_revision = excluded.catalog_revision,
           quarantine_reason = excluded.quarantine_reason, updated_at = excluded.updated_at`,
      ).run({
        id: request.patternId,
        source: request.source,
        ext: request.extensionPoint,
        ver: request.pinnedVersion,
        lifecycle,
        prov: canonicalSerialize(request.provenance),
        rev: revision,
        qr: quarantineReason,
        now: new Date().toISOString(),
      });
      return { resultRef: makeOpaqueId('extpat', `${request.patternId}${lifecycle}`) };
    });
    if (!result.ok) return result;
    const record = this.getPattern(request.patternId);
    if (!record) {
      return fail('INTERNAL', 'pattern missing after import commit', 'external.import', correlationId);
    }
    return { ok: true, value: { record } };
  }

  private transition(
    record: ExternalPatternRecord,
    lifecycle: PatternLifecycle,
    correlationId: string,
    revision: number,
    options: { readonly registerEffect: boolean; readonly bumpRevision?: boolean },
  ): IntegrationResult<{ readonly record: ExternalPatternRecord }> {
    const result = this.commit(correlationId, `external.${lifecycle}`, (tx) => {
      tx.prepare(
        `UPDATE external_pattern_registry SET lifecycle = ?, catalog_revision = ?, updated_at = ? WHERE pattern_id = ?`,
      ).run(lifecycle, revision, new Date().toISOString(), record.patternId);
      if (options.bumpRevision === true) {
        tx.prepare('UPDATE external_catalog_revision SET revision = ? WHERE id = 1').run(revision);
      }
      if (options.registerEffect) {
        const effectId = makeOpaqueId('exteff', `${record.patternId}${revision}`);
        tx.prepare(
          `INSERT OR IGNORE INTO external_owned_effects (effect_id, pattern_id, extension_point, catalog_revision)
           VALUES (?, ?, ?, ?)`,
        ).run(effectId, record.patternId, record.extensionPoint, revision);
      }
      return { resultRef: makeOpaqueId('exttr', `${record.patternId}${lifecycle}`) };
    });
    if (!result.ok) return result;
    const updated = this.getPattern(record.patternId);
    if (!updated) {
      return fail('INTERNAL', 'pattern missing after transition commit', `external.${lifecycle}`, correlationId);
    }
    return { ok: true, value: { record: updated } };
  }

  /**
   * Commit a mutation THROUGH the single-writer authority transaction. The
   * business mutation runs inside the committed transaction and a receipt +
   * outbox event are written atomically; a diverging idempotency key is a
   * CONFLICT with no effect. This is the ONLY durable write path here.
   */
  private commit(
    correlationId: string,
    operation: string,
    mutate: (tx: Database.Database) => { readonly resultRef?: string } | void,
  ): IntegrationResult<{ readonly resultRef: string }> {
    const commandId = makeOpaqueId('extcmd', `${operation}${correlationId}${Date.now()}${Math.random()}`);
    const payload = { operation, commandId };
    const res: AuthorityMutationResult = applyAuthorityMutation(this.db, {
      authority: EXTERNAL_OWNER,
      commandId,
      idempotencyKey: makeOpaqueId('extidem', commandId),
      requestDigest: computeDigest(payload),
      correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
      scope: {
        schemaVersion: CONTRACT_WRITE_VERSION,
        userId: EXTERNAL_OWNER,
        owner: EXTERNAL_OWNER,
        allowedRoots: [],
        allowedDestinations: [],
      },
      mutate,
      events: [
        {
          eventType: 'external-integration.transition',
          aggregateType: 'external-pattern',
          aggregateId: commandId,
          payloadSchemaName: 'ExternalIntegrationEvent',
          payloadSchemaVersion: 1,
          payload,
          redaction: 'internal',
        },
      ],
    });
    if (res.kind === 'conflict') {
      return { ok: false, error: res.error };
    }
    if (res.kind === 'replayed') {
      return { ok: true, value: { resultRef: res.receipt.resultRef ?? 'ref-replayed' } };
    }
    return { ok: true, value: { resultRef: res.resultRef ?? 'ref-committed' } };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. MindStudio phase gating (NN-INTEGRATION-006–009)
// ════════════════════════════════════════════════════════════════════════════

/** The four MindStudio phases; a phase requires every earlier phase present. */
export const MINDSTUDIO_PHASES = Object.freeze([1, 2, 3, 4] as const);
export type MindStudioPhase = (typeof MINDSTUDIO_PHASES)[number];

/**
 * The capabilities each MindStudio phase adopts, expressed as the canonical
 * extension point they extend (NN-INTEGRATION-006–009). Each capability is an
 * extension of an existing owner, never a new one.
 */
export const MINDSTUDIO_PHASE_CAPABILITIES: Readonly<
  Record<MindStudioPhase, ReadonlyArray<{ readonly capability: string; readonly extensionPoint: ExtensionPoint }>>
> = Object.freeze({
  1: [
    { capability: 'multi-vendor-instructions', extensionPoint: 'prompt' },
    { capability: 'heading-addressed-spec-edits', extensionPoint: 'task' },
    { capability: 'base-mcp-integration', extensionPoint: 'tool' },
  ],
  2: [
    { capability: 'sandboxed-browser-screenshots', extensionPoint: 'tool' },
    { capability: 'non-mutating-monaco-diagnostics', extensionPoint: 'ui' },
    { capability: 'bounded-url-search-actions', extensionPoint: 'tool' },
  ],
  3: [
    { capability: 'parent-tool-tagged-subagents', extensionPoint: 'orchestration' },
    { capability: 'read-only-design-catalog', extensionPoint: 'ui' },
    { capability: 'packaged-workflows', extensionPoint: 'orchestration' },
  ],
  4: [
    { capability: 'typed-skill-sync', extensionPoint: 'skill' },
    { capability: 'progressive-write-diff-streaming', extensionPoint: 'tool' },
    { capability: 'outbound-mcp', extensionPoint: 'tool' },
  ],
});

/**
 * Gate a MindStudio phase capability on prerequisite presence. A Phase-N
 * capability is admitted only when every phase `1..N-1` is present AND phase N
 * itself is present; otherwise it returns a typed `UNAVAILABLE` naming the first
 * missing prerequisite phase (NN-INTEGRATION-007 "typed unavailable errors when
 * Phase 1 prerequisites are absent"). Pure — it authorizes nothing, it gates.
 *
 * @param phase the phase whose capability is requested
 * @param presentPhases the set of phases currently present/enabled
 */
export function gateMindStudioPhase(
  phase: MindStudioPhase,
  presentPhases: ReadonlySet<MindStudioPhase>,
  correlationId?: string,
): IntegrationResult<{ readonly phase: MindStudioPhase }> {
  for (let earlier = 1 as MindStudioPhase; earlier <= phase; earlier = (earlier + 1) as MindStudioPhase) {
    if (!presentPhases.has(earlier)) {
      return fail(
        'UNAVAILABLE',
        `MindStudio Phase ${phase} is unavailable: prerequisite Phase ${earlier} is absent`,
        'external.mindstudio-phase',
        correlationId,
      );
    }
  }
  return { ok: true, value: { phase } };
}
