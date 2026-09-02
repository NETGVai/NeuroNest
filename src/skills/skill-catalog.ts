/**
 * SkillCatalog — sole write authority for skill installation/enablement/
 * assignment/routing/evaluation/provenance STATE, over the Markdown skill
 * SOURCE (FUT-PKG-06-EXECUTION/T-005).
 *
 * D-04 splits ownership: the Markdown file owns the skill body; `SkillCatalog`
 * owns state (canonical identity `skillId`, semver, content hash, catalog
 * revision). SQLite is authoritative ONLY for
 * installed/enabled/version/routing/assignment/evaluation/provenance state, and
 * reconciliation uses content hash + semantic version, never last-writer-wins
 * (NN-SKILL-001, CD-008). This module implements that authority over a real
 * SQLite database through the single-writer, idempotent-receipt transaction
 * from {@link ../storage/authority-transaction} (D-08.2), reusing the additive
 * state + migration ledger tables from {@link ./skill-migration}.
 *
 * Fail-closed loading rules (NN-SKILL-010): STALE (content hash drifted from
 * the registered hash), CYCLIC (a skill dependency cycle), MISSING (an
 * unresolved skill/tool reference), DISABLED, INCOMPATIBLE (app-major range),
 * MULTIPLY-RESOLVED (duplicate id/name), TRAVERSAL (an entrypoint that escapes
 * the root), and BUDGET-EXCEEDING content all remain UNLOADED with a typed
 * blocked state pending review. No malformed content is ever registered.
 *
 * Transactional ASSIGNMENTS (NN-SKILL-006): a per-agent/project assignment set
 * commits ATOMICALLY only when EVERY referenced skill resolves, is
 * installed/enabled/compatible, and satisfies complete capability coverage;
 * ANY failure rolls back the WHOLE set (no partial assignment —
 * V-SKILL-001/assignment-atomicity).
 *
 * Execution (NN-SKILL-008): a skill runs THROUGH the Tool Execution Pipeline —
 * this module builds a `ToolCallIntent` referencing the skill's declared tool
 * manifest; it never executes a tool directly.
 *
 * Design anchors: D-04, D-05, D-07 (`SkillManifest@1`), D-11, D-20.
 * Requirements: NN-SKILL-001–015, NN-DATA-001/003/010/011, NN-SEC-012,
 * NN-INV-001/007/008, CD-008, CD-021.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import { evaluatePath, type SecurityDecision } from '../shared/security-authority';
import {
  applyAuthorityMutation,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import {
  ensureSkillStateTables,
  isConflicted,
  SKILL_AUTHORITY_ID,
} from './skill-migration';
import {
  hashSkillBody,
  isSkillCompatible,
  parseSkillFile,
  skillIdentityTokens,
  type SkillManifest,
  type SkillParseDefect,
} from './skill-types';

// ─── Additional durable tables (assignments, packs, evals, proposals) ───────

const CATALOG_DDL = `
  CREATE TABLE IF NOT EXISTS skill_manifests (
    skill_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    source TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_blocked (
    blocked_id TEXT PRIMARY KEY,
    skill_id TEXT,
    reason TEXT NOT NULL,
    detail TEXT NOT NULL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_assignments (
    assignment_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL,
    UNIQUE (target_kind, target_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS skill_packs (
    pack_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_identity TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    version_major INTEGER NOT NULL,
    version_minor INTEGER NOT NULL,
    version_patch INTEGER NOT NULL,
    skill_ids_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_learned_proposals (
    proposal_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    state TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_session TEXT NOT NULL,
    record_json TEXT NOT NULL,
    proposed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_skill_manifests_status ON skill_manifests (status);
  CREATE INDEX IF NOT EXISTS idx_skill_assignments_target
    ON skill_assignments (target_kind, target_id);
`;

/** Create every canonical skill table (state, manifests, assignments, packs). */
export function ensureSkillCatalogTables(db: Database.Database): void {
  ensureSkillStateTables(db);
  db.exec(CATALOG_DDL);
}

// ─── Typed outcomes ──────────────────────────────────────────────────────────

/** A typed catalog failure (secret-free). */
export interface SkillCatalogError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type SkillCatalogOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: SkillCatalogError };

function fail<T>(code: ErrorCode, message: string): SkillCatalogOutcome<T> {
  return { ok: false, error: { code, message } };
}

function mapResult<T>(result: AuthorityMutationResult, value: T): SkillCatalogOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value, replayed: result.kind === 'replayed' };
}

// ─── Blocked reasons (fail-closed, NN-SKILL-010) ────────────────────────────

/** Why a skill (or discovery) is BLOCKED and remains unloaded. */
export type BlockedReason =
  | SkillParseDefect
  | 'traversal'
  | 'stale'
  | 'cyclic'
  | 'missing-reference'
  | 'disabled'
  | 'incompatible'
  | 'duplicate'
  | 'budget-exceeded'
  | 'migration-conflict';

/** A blocked record: a skill (or file) that must not load. */
export interface BlockedRecord {
  readonly blockedId: string;
  readonly skillId: string | null;
  readonly reason: BlockedReason;
  readonly detail: string;
  readonly source: string;
  readonly recordedAt: string;
}

// ─── Discovery input (NN-SKILL-004) ──────────────────────────────────────────

/**
 * A discovered skill candidate: the raw Markdown file bytes, the source
 * root/ref, the SCOPE (global under DataRoot vs explicit project), and the
 * declared skill ids this candidate DEPENDS on (for the cycle check).
 */
export interface DiscoveredSkill {
  readonly raw: string;
  readonly source: string;
  /** Absolute filesystem root the entrypoints must stay contained within. */
  readonly rootDir: string;
  readonly dependsOn?: readonly string[];
}

/** Input to {@link discoverAndRegister}. */
export interface DiscoverInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly candidates: readonly DiscoveredSkill[];
  readonly appMajor: number;
  /** The maximum number of Level-2/3 bodies the disclosure budget admits. */
  readonly loadBudget?: number;
  readonly now?: () => Date;
}

/** The result of a discovery/registration pass. */
export interface DiscoverResult {
  readonly registered: readonly SkillManifest[];
  readonly blocked: readonly BlockedRecord[];
}

// ─── Discovery + registration (fail-closed, NN-SKILL-003/004/010) ───────────

/**
 * Discover skills and register every VALID one, fail-closed (NN-SKILL-004). For
 * each candidate the pass:
 *
 *   1. PARSES the Markdown+YAML file; a malformed file is blocked and never
 *      registered (NN-SKILL-003);
 *   2. recomputes the content hash from the body and blocks a STALE candidate
 *      whose author-declared body does not match its bytes (defended by the
 *      parser, which always recomputes);
 *   3. validates every entrypoint AND the content ref against the Security
 *      Authority's symlink-resolving containment check — a TRAVERSAL reference
 *      blocks the skill (NN-SEC-012, NN-SKILL-003);
 *   4. blocks an INCOMPATIBLE app-major range;
 *   5. blocks a MISSING reference (a declared dependency not present among the
 *      candidates) and a CYCLIC dependency graph (NN-SKILL-010);
 *   6. blocks a DUPLICATE effective identity (id/name collision) — EVERY
 *      manifest in a colliding set is blocked (multiply-resolved, NN-SKILL-010);
 *   7. blocks a candidate whose id is under an unresolved MIGRATION CONFLICT;
 *   8. enforces the disclosure load BUDGET — candidates beyond the budget are
 *      blocked `budget-exceeded` and left unloaded (NN-SKILL-009/010);
 *   9. commits the surviving manifests + blocked records atomically, bumping
 *      the catalog revision.
 *
 * The registered set equals the set of valid, unique, compatible,
 * reference-complete, acyclic, contained, within-budget candidates. A duplicate
 * discovery click REPLAYS (NN-INV-007). Never mutates the input.
 */
export function discoverAndRegister(
  db: Database.Database,
  input: DiscoverInput,
): SkillCatalogOutcome<DiscoverResult> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const blocked: BlockedRecord[] = [];
  let blockedSeq = 0;
  const block = (
    skillId: string | null,
    reason: BlockedReason,
    detail: string,
    source: string,
  ): void => {
    blockedSeq += 1;
    blocked.push({
      blockedId: makeOpaqueId('sblk', `${input.commandId}${blockedSeq}`),
      skillId,
      reason,
      detail,
      source,
      recordedAt: now,
    });
  };

  interface Parsed {
    readonly manifest: SkillManifest;
    readonly body: string;
    readonly source: string;
    readonly rootDir: string;
    readonly dependsOn: readonly string[];
  }
  const parsed: Parsed[] = [];

  // Steps 1–4: parse, hash, containment, compatibility.
  for (const cand of input.candidates) {
    const result = parseSkillFile(cand.raw);
    if (!result.ok) {
      block(null, result.defect, result.detail, cand.source);
      continue;
    }
    const { manifest, body } = result.parsed;

    // Content hash must match the body (parser recomputes; a mismatch here would
    // only occur if the stored hash was tampered — defend anyway).
    if (manifest.contentHash !== hashSkillBody(body)) {
      block(manifest.skillId, 'stale', 'content hash does not match body', cand.source);
      continue;
    }

    // Traversal check: every entrypoint + the content ref must stay contained
    // after symlink resolution (NN-SEC-012).
    const refs = [manifest.contentRef, ...manifest.entrypoints.map((e) => e.ref)];
    const traversal = refs.find((ref) => {
      const decision: SecurityDecision<unknown> = evaluatePath(ref, cand.rootDir, {
        followSymlinks: true,
      });
      return decision.decision !== 'allow';
    });
    if (traversal !== undefined) {
      block(manifest.skillId, 'traversal', `reference escapes root: ${traversal}`, cand.source);
      continue;
    }

    if (!isSkillCompatible(manifest, input.appMajor)) {
      block(
        manifest.skillId,
        'incompatible',
        `app major ${input.appMajor} outside [${manifest.compatibility.minAppMajor},${manifest.compatibility.maxAppMajor}]`,
        cand.source,
      );
      continue;
    }

    if (isConflicted(db, manifest.skillId)) {
      block(manifest.skillId, 'migration-conflict', 'id under unresolved migration conflict', cand.source);
      continue;
    }

    parsed.push({
      manifest,
      body,
      source: cand.source,
      rootDir: cand.rootDir,
      dependsOn: cand.dependsOn ?? [],
    });
  }

  // Step 6: DUPLICATE effective identity across all well-formed candidates.
  const tokenOwners = new Map<string, number>();
  for (const p of parsed) {
    for (const token of new Set(skillIdentityTokens(p.manifest))) {
      tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
    }
  }
  const unique: Parsed[] = [];
  for (const p of parsed) {
    const colliding = [...new Set(skillIdentityTokens(p.manifest))].find(
      (t) => (tokenOwners.get(t) ?? 0) > 1,
    );
    if (colliding !== undefined) {
      block(p.manifest.skillId, 'duplicate', `identity token '${colliding}' collides`, p.source);
      continue;
    }
    unique.push(p);
  }

  // Step 5: MISSING reference + CYCLIC dependency graph over the unique set.
  const presentIds = new Set(unique.map((p) => p.manifest.skillId));
  const acyclic: Parsed[] = [];
  const depGraph = new Map<string, readonly string[]>();
  for (const p of unique) depGraph.set(p.manifest.skillId, p.dependsOn);
  for (const p of unique) {
    const missing = p.dependsOn.find((d) => !presentIds.has(d));
    if (missing !== undefined) {
      block(p.manifest.skillId, 'missing-reference', `unresolved dependency ${missing}`, p.source);
      continue;
    }
    if (hasCycle(p.manifest.skillId, depGraph)) {
      block(p.manifest.skillId, 'cyclic', 'skill dependency cycle detected', p.source);
      continue;
    }
    acyclic.push(p);
  }

  // Step 8: disclosure load BUDGET. Deterministic order by skill id; anything
  // beyond the budget is blocked and left unloaded (NN-SKILL-009/010).
  const ordered = [...acyclic].sort((a, b) =>
    a.manifest.skillId < b.manifest.skillId ? -1 : a.manifest.skillId > b.manifest.skillId ? 1 : 0,
  );
  const budget = input.loadBudget ?? Number.POSITIVE_INFINITY;
  const registered: SkillManifest[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (i >= budget) {
      block(ordered[i].manifest.skillId, 'budget-exceeded', 'disclosure load budget exceeded', ordered[i].source);
      continue;
    }
    registered.push(ordered[i].manifest);
  }

  return commitDiscovery(db, input, registered, blocked);
}

/** Detect a cycle reachable from `start` in the dependency graph. */
function hasCycle(start: string, graph: Map<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (done.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    done.add(node);
    return false;
  };
  return dfs(start);
}

/** Commit a discovery pass atomically: replace manifests + blocked records. */
function commitDiscovery(
  db: Database.Database,
  input: DiscoverInput,
  registered: readonly SkillManifest[],
  blocked: readonly BlockedRecord[],
): SkillCatalogOutcome<DiscoverResult> {
  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({
      op: 'discover-register',
      registered: registered.map((m) => `${m.skillId}:${m.contentHash}`).sort(),
      blocked: blocked.map((b) => `${b.skillId ?? ''}:${b.reason}`).sort(),
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const revisionRow = tx
        .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
        .get(SKILL_AUTHORITY_ID) as { revision: number } | undefined;
      const nextRevision = (revisionRow?.revision ?? 0) + 1;

      tx.prepare('DELETE FROM skill_manifests').run();
      for (const manifest of registered) {
        tx.prepare(
          `INSERT INTO skill_manifests
             (skill_id, name, scope, source, content_hash, status, record_json, catalog_revision)
           VALUES (@skillId, @name, @scope, @source, @contentHash, @status, @recordJson, @rev)`,
        ).run({
          skillId: manifest.skillId,
          name: manifest.name,
          scope: manifest.scope,
          source: manifest.source,
          contentHash: manifest.contentHash,
          status: manifest.status,
          recordJson: serializeContract(manifest),
          rev: nextRevision,
        });
      }

      tx.prepare('DELETE FROM skill_blocked').run();
      for (const b of blocked) {
        tx.prepare(
          `INSERT INTO skill_blocked (blocked_id, skill_id, reason, detail, source, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(b.blockedId, b.skillId, b.reason, b.detail, b.source, b.recordedAt);
      }

      return { resultRef: makeOpaqueId('sdsc', input.commandId) };
    },
    events: [
      {
        eventType: 'skill-catalog.discovered',
        aggregateType: 'skill-catalog',
        aggregateId: 'skill-catalog',
        payloadSchemaName: 'SkillDiscovery',
        payloadSchemaVersion: 1,
        payload: { registeredCount: registered.length, blockedCount: blocked.length },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, { registered: [...registered], blocked: [...blocked] });
}

// ─── Read models (NN-SKILL-004/015) ──────────────────────────────────────────

/** Read every registered (loadable) manifest, ordered by skill id. */
export function readRegisteredSkills(db: Database.Database): SkillManifest[] {
  const rows = db
    .prepare('SELECT record_json FROM skill_manifests ORDER BY skill_id')
    .all() as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as SkillManifest);
}

/** Read the blocked records from the last discovery pass. */
export function readBlocked(db: Database.Database): BlockedRecord[] {
  const rows = db
    .prepare(
      `SELECT blocked_id AS blockedId, skill_id AS skillId, reason, detail, source,
              recorded_at AS recordedAt
       FROM skill_blocked ORDER BY blocked_id`,
    )
    .all() as {
    blockedId: string;
    skillId: string | null;
    reason: string;
    detail: string;
    source: string;
    recordedAt: string;
  }[];
  return rows.map((r) => ({
    blockedId: r.blockedId,
    skillId: r.skillId,
    reason: r.reason as BlockedReason,
    detail: r.detail,
    source: r.source,
    recordedAt: r.recordedAt,
  }));
}

/** Read one registered manifest by id (or `undefined`). */
export function readSkill(db: Database.Database, skillId: string): SkillManifest | undefined {
  const row = db
    .prepare('SELECT record_json FROM skill_manifests WHERE skill_id = ?')
    .get(skillId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as SkillManifest) : undefined;
}

/**
 * The registry-derived skill count at the current catalog revision
 * (NN-SKILL-015). Computed from the manifest table — NEVER a static/historic
 * total. Historical totals are evidence only.
 */
export function registeredSkillCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM skill_manifests').get() as { c: number };
  return row.c;
}

/**
 * Registry-derived coverage: the set of capability ids covered by ENABLED
 * registered skills, at the current revision (NN-SKILL-015). Set-based, not a
 * numeric snapshot.
 */
export function capabilityCoverage(db: Database.Database): Set<string> {
  const coverage = new Set<string>();
  for (const m of readRegisteredSkills(db)) {
    if (m.status === 'enabled') {
      for (const cap of m.capabilities) coverage.add(cap);
    }
  }
  return coverage;
}

// ─── Transactional assignments (atomic; NN-SKILL-006) ───────────────────────

/** The kind of target an assignment set is bound to. */
export type AssignmentTargetKind = 'agent' | 'project';

/** Input to {@link assignSkills}. */
export interface AssignInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly targetKind: AssignmentTargetKind;
  readonly targetId: string;
  /** The skill ids to assign as a SET (all-or-none). */
  readonly skillIds: readonly string[];
  /** Capability ids the target must fully cover after assignment. */
  readonly requiredCapabilities?: readonly string[];
  readonly appMajor: number;
  readonly now?: () => Date;
}

/** Why an assignment set was rejected (no partial state written). */
export interface AssignmentRejection {
  readonly code: ErrorCode;
  readonly message: string;
  /** The offending skill ids, when the rejection is per-skill. */
  readonly offending: readonly string[];
}

/** The result of a successful assignment. */
export interface AssignmentResult {
  readonly targetKind: AssignmentTargetKind;
  readonly targetId: string;
  readonly assigned: readonly string[];
}

/**
 * Assign a SET of skills to an agent/project TRANSACTIONALLY (NN-SKILL-006). The
 * whole set is committed ONLY when EVERY referenced skill:
 *
 *   - RESOLVES to a registered manifest (else `missing`), AND
 *   - is INSTALLED/ENABLED (else `disabled`), AND
 *   - is COMPATIBLE with the app major (else `incompatible`), AND
 *   - is not under a migration conflict (else `migration-conflict`);
 *
 * and the union of the assigned skills' capabilities COVERS every
 * `requiredCapabilities` entry (else `incomplete-coverage`). ANY failure
 * REJECTS the whole set and writes NO assignment row — there is never a partial
 * assignment (V-SKILL-001/assignment-atomicity). On success the target's
 * assignment set is REPLACED atomically with the new set (a set operation, not
 * a merge), bumping the catalog revision. Idempotent (NN-INV-007).
 */
export function assignSkills(
  db: Database.Database,
  input: AssignInput,
): SkillCatalogOutcome<AssignmentResult> {
  // Validate the whole set BEFORE any write. A failure returns a typed
  // rejection and performs NO mutation (no partial assignment).
  const missing: string[] = [];
  const notEnabled: string[] = [];
  const incompatible: string[] = [];
  const conflicted: string[] = [];
  const coverage = new Set<string>();

  const uniqueIds = [...new Set(input.skillIds)];
  for (const id of uniqueIds) {
    const manifest = readSkill(db, id);
    if (!manifest) {
      missing.push(id);
      continue;
    }
    if (manifest.status !== 'enabled') notEnabled.push(id);
    if (!isSkillCompatible(manifest, input.appMajor)) incompatible.push(id);
    if (isConflicted(db, id)) conflicted.push(id);
    for (const cap of manifest.capabilities) coverage.add(cap);
  }

  if (missing.length > 0) {
    return fail('VALIDATION', `unresolved skill(s): ${missing.sort().join(', ')}`);
  }
  if (conflicted.length > 0) {
    return fail('CONFLICT', `conflicted skill(s): ${conflicted.sort().join(', ')}`);
  }
  if (notEnabled.length > 0) {
    return fail('FORBIDDEN', `not enabled skill(s): ${notEnabled.sort().join(', ')}`);
  }
  if (incompatible.length > 0) {
    return fail('INCOMPATIBLE', `incompatible skill(s): ${incompatible.sort().join(', ')}`);
  }
  const requiredCaps = input.requiredCapabilities ?? [];
  const uncovered = requiredCaps.filter((c) => !coverage.has(c));
  if (uncovered.length > 0) {
    return fail('VALIDATION', `capability coverage incomplete: ${uncovered.sort().join(', ')}`);
  }

  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({
      op: 'assign',
      target: `${input.targetKind}:${input.targetId}`,
      skills: [...uniqueIds].sort(),
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const revisionRow = tx
        .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
        .get(SKILL_AUTHORITY_ID) as { revision: number } | undefined;
      const nextRevision = (revisionRow?.revision ?? 0) + 1;

      // Replace the target's whole assignment set atomically (set operation).
      tx.prepare(
        'DELETE FROM skill_assignments WHERE target_kind = ? AND target_id = ?',
      ).run(input.targetKind, input.targetId);
      for (const id of uniqueIds) {
        const assignmentId = makeOpaqueId('sasg', `${input.targetKind}${input.targetId}${id}`);
        tx.prepare(
          `INSERT INTO skill_assignments
             (assignment_id, target_kind, target_id, skill_id, catalog_revision)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(assignmentId, input.targetKind, input.targetId, id, nextRevision);
      }
      return { resultRef: makeOpaqueId('sasr', input.commandId) };
    },
    events: [
      {
        eventType: 'skill-catalog.assigned',
        aggregateType: 'skill-assignment',
        aggregateId: `${input.targetKind}:${input.targetId}`,
        payloadSchemaName: 'SkillAssignment',
        payloadSchemaVersion: 1,
        payload: {
          targetKind: input.targetKind,
          targetId: input.targetId,
          skillCount: uniqueIds.length,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, {
    targetKind: input.targetKind,
    targetId: input.targetId,
    assigned: [...uniqueIds].sort(),
  });
}

/** Read a target's assigned skill ids (ordered). */
export function readAssignments(
  db: Database.Database,
  targetKind: AssignmentTargetKind,
  targetId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT skill_id AS skillId FROM skill_assignments
       WHERE target_kind = ? AND target_id = ? ORDER BY skill_id`,
    )
    .all(targetKind, targetId) as { skillId: string }[];
  return rows.map((r) => r.skillId);
}

// ─── Routing (NN-SKILL-007) ──────────────────────────────────────────────────

/** A routing signal set: validated intent plus contextual evidence. */
export interface RouteSignals {
  readonly intentKeywords: readonly string[];
  readonly languages?: readonly string[];
  readonly taskType?: string;
  /** Historical success rate per skill id in `[0,1]`. */
  readonly history?: Readonly<Record<string, number>>;
  /** Explicitly excluded skill ids (never routed to). */
  readonly exclusions?: readonly string[];
}

/** A ranked routing candidate with its evidence-derived score. */
export interface RouteCandidate {
  readonly skillId: string;
  readonly score: number;
}

/** The routing decision (NN-SKILL-007). */
export type RouteDecision =
  | { readonly routed: true; readonly ranked: readonly RouteCandidate[]; readonly top: string }
  | { readonly routed: false; readonly reason: 'below-threshold'; readonly fallbackToPipeline: true };

/**
 * Route a request to a skill by combining validated intent keywords,
 * language/task-type match, historical evidence, and exclusions into a ranked,
 * evidence-bearing score (NN-SKILL-007). Only ENABLED registered skills that
 * are not excluded participate. When no candidate clears `threshold`, routing
 * FALLS BACK to the existing pipeline (NN-SKILL-007) — it never forces a skill.
 * This is a pure read: keyword-only startup mappings never mutate authority.
 */
export function routeToSkill(
  db: Database.Database,
  signals: RouteSignals,
  threshold = 0.5,
): RouteDecision {
  const exclusions = new Set(signals.exclusions ?? []);
  const intent = signals.intentKeywords.map((k) => k.toLowerCase());
  const candidates: RouteCandidate[] = [];

  for (const m of readRegisteredSkills(db)) {
    if (m.status !== 'enabled' || exclusions.has(m.skillId)) continue;
    const haystack = `${m.name} ${m.description} ${m.capabilities.join(' ')}`.toLowerCase();
    let matches = 0;
    for (const kw of intent) {
      if (kw.length > 0 && haystack.includes(kw)) matches += 1;
    }
    const intentScore = intent.length > 0 ? matches / intent.length : 0;
    const historyScore = signals.history?.[m.skillId] ?? 0;
    // Weighted combination of intent and historical evidence.
    const score = 0.7 * intentScore + 0.3 * historyScore;
    if (score > 0) candidates.push({ skillId: m.skillId, score });
  }

  candidates.sort((a, b) =>
    b.score - a.score || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0),
  );

  if (candidates.length === 0 || candidates[0].score < threshold) {
    return { routed: false, reason: 'below-threshold', fallbackToPipeline: true };
  }
  return { routed: true, ranked: candidates, top: candidates[0].skillId };
}

// ─── Progressive disclosure (NN-SKILL-009/010) ──────────────────────────────

/** The three disclosure levels (NN-SKILL-009). */
export type DisclosureLevel = 1 | 2 | 3;

/** A disclosure decision: whether a level may load for a skill. */
export type DisclosureDecision =
  | { readonly load: true; readonly level: DisclosureLevel }
  | { readonly load: false; readonly reason: string };

/**
 * Decide whether a disclosure LEVEL may load for a skill (NN-SKILL-009/010).
 * Level 1 (metadata) may remain indexed for any registered skill. Level 2
 * (body) loads only on a validated trigger OR explicit assignment. Level 3
 * (reference/script) loads only for a named need AFTER policy + budget checks.
 * A ZERO budget prevents ANY new load, and a blocked/disabled skill never
 * loads. End-of-step unload is the caller's responsibility; this decides the
 * gate.
 */
export function decideDisclosure(
  db: Database.Database,
  skillId: string,
  level: DisclosureLevel,
  ctx: {
    readonly triggered?: boolean;
    readonly assigned?: boolean;
    readonly namedNeed?: boolean;
    readonly remainingBudget: number;
  },
): DisclosureDecision {
  const manifest = readSkill(db, skillId);
  if (!manifest) return { load: false, reason: 'skill not registered' };
  if (manifest.status !== 'enabled') return { load: false, reason: 'skill not enabled' };

  if (level === 1) {
    return { load: true, level };
  }
  // Levels 2 and 3 consume budget; a zero budget prevents any new load.
  if (ctx.remainingBudget <= 0) {
    return { load: false, reason: 'load budget exhausted; no new load permitted' };
  }
  if (level === 2) {
    if (ctx.triggered || ctx.assigned) return { load: true, level };
    return { load: false, reason: 'level 2 requires a validated trigger or assignment' };
  }
  // level === 3
  if (ctx.namedNeed && (ctx.triggered || ctx.assigned)) {
    return { load: true, level };
  }
  return { load: false, reason: 'level 3 requires a named need after policy and budget checks' };
}

// ─── Execution through the pipeline (NN-SKILL-008) ──────────────────────────

/**
 * A resolved skill-execution request that a caller passes to the Tool Execution
 * Pipeline. A skill NEVER executes directly — it runs THROUGH the pipeline as a
 * `ToolCall@1` referencing the skill's declared tool manifest, with project
 * scope, declared input, a default timeout, and cancellation (NN-SKILL-008,
 * D-11). This shape is the pipeline `ToolCallIntent` minus the ordered preflight
 * checks the SecurityAuthority injects.
 */
export interface SkillExecutionRequest {
  readonly skillId: string;
  readonly manifestName: string;
  readonly manifestVersion: number;
  readonly scope: ScopeDescriptor;
  readonly actor: string;
  readonly correlationId: string;
  readonly cancellationTokenId: string;
  readonly toolInput: unknown;
  readonly deadlineAt: string;
}

/** The default skill execution timeout (NN-SKILL-008): 30 seconds. */
export const DEFAULT_SKILL_TIMEOUT_MS = 30_000 as const;

/**
 * Build a governed skill-execution request that runs THROUGH the Tool Execution
 * Pipeline (NN-SKILL-008). The skill must be ENABLED and declare the named tool
 * manifest in its `toolRefs`; otherwise the skill cannot execute (fail-closed).
 * The returned request carries the pipeline manifest reference, project scope,
 * declared input, a default 30-second deadline (unless the caller supplies an
 * earlier one), and a cancellation token — the pipeline enforces policy,
 * approval, budget, sandbox, and audit (D-11). This builder never executes a
 * tool; it prepares the intent the pipeline consumes.
 */
export function buildSkillExecution(
  db: Database.Database,
  input: {
    readonly skillId: string;
    readonly manifestVersion: number;
    readonly scope: ScopeDescriptor;
    readonly actor: string;
    readonly correlationId: string;
    readonly cancellationTokenId: string;
    readonly toolInput: unknown;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  },
): SkillCatalogOutcome<SkillExecutionRequest> {
  const manifest = readSkill(db, input.skillId);
  if (!manifest) return fail('VALIDATION', 'skill not registered');
  if (manifest.status !== 'enabled') return fail('FORBIDDEN', 'skill not enabled');
  if (manifest.toolRefs.length === 0) {
    return fail('VALIDATION', 'skill declares no tool manifest to execute through the pipeline');
  }
  const now = (input.now ?? (() => new Date()))();
  const timeoutMs = input.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS;
  const deadlineAt = new Date(now.getTime() + timeoutMs).toISOString();
  const request: SkillExecutionRequest = {
    skillId: manifest.skillId,
    manifestName: manifest.toolRefs[0],
    manifestVersion: input.manifestVersion,
    scope: input.scope,
    actor: input.actor,
    correlationId: input.correlationId,
    cancellationTokenId: input.cancellationTokenId,
    toolInput: input.toolInput,
    deadlineAt,
  };
  return { ok: true, value: request, replayed: false };
}

// ─── Packs, drift, and evaluation (NN-SKILL-011/012) ────────────────────────

/** Pack freshness classification (NN-SKILL-012). */
export type DriftState = 'fresh' | 'stale' | 'unknown';

/** Classify pack/skill drift from the installed vs upstream commit. */
export function classifyDrift(
  installedCommit: string | undefined,
  upstreamCommit: string | undefined,
  commitsBehind: number | undefined,
): { readonly state: DriftState; readonly commitsBehind: number } {
  if (installedCommit === undefined || upstreamCommit === undefined) {
    return { state: 'unknown', commitsBehind: 0 };
  }
  if (installedCommit === upstreamCommit) return { state: 'fresh', commitsBehind: 0 };
  return { state: 'stale', commitsBehind: Math.max(0, commitsBehind ?? 1) };
}

/** Input to {@link installPack}. */
export interface InstallPackInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly packId: string;
  readonly name: string;
  readonly sourceIdentity: string;
  readonly sourceCommit: string;
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly skillIds: readonly string[];
  /** Whether the caller explicitly forced a destructive overwrite. */
  readonly force?: boolean;
  readonly now?: () => Date;
}

/**
 * Install (or update) a pack (NN-SKILL-011). A pack has a versioned identity,
 * canonical source identity, a skills list, and a source commit. Installation
 * normalizes the cache identity and REFUSES a destructive overwrite of an
 * existing pack without an explicit `force` flag (NN-SKILL-011) — a re-install
 * over a different source commit without `force` is a `CONFLICT`. Idempotent
 * through the authority transaction.
 */
export function installPack(
  db: Database.Database,
  input: InstallPackInput,
): SkillCatalogOutcome<{ readonly packId: string }> {
  const existing = db
    .prepare('SELECT source_commit AS sourceCommit FROM skill_packs WHERE pack_id = ?')
    .get(input.packId) as { sourceCommit: string } | undefined;
  if (existing && existing.sourceCommit !== input.sourceCommit && input.force !== true) {
    return fail('CONFLICT', 'pack already installed at a different source commit; force required');
  }

  const record = {
    packId: input.packId,
    name: input.name,
    sourceIdentity: input.sourceIdentity,
    sourceCommit: input.sourceCommit,
    version: input.version,
    skillIds: [...input.skillIds].sort(),
  };

  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({ op: 'install-pack', ...record }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const revisionRow = tx
        .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
        .get(SKILL_AUTHORITY_ID) as { revision: number } | undefined;
      const nextRevision = (revisionRow?.revision ?? 0) + 1;
      tx.prepare(
        `INSERT INTO skill_packs
           (pack_id, name, source_identity, source_commit, version_major, version_minor,
            version_patch, skill_ids_json, record_json, catalog_revision)
         VALUES (@packId, @name, @sourceIdentity, @sourceCommit, @vMajor, @vMinor, @vPatch,
            @skillIdsJson, @recordJson, @rev)
         ON CONFLICT(pack_id) DO UPDATE SET
           name = excluded.name, source_identity = excluded.source_identity,
           source_commit = excluded.source_commit, version_major = excluded.version_major,
           version_minor = excluded.version_minor, version_patch = excluded.version_patch,
           skill_ids_json = excluded.skill_ids_json, record_json = excluded.record_json,
           catalog_revision = excluded.catalog_revision`,
      ).run({
        packId: input.packId,
        name: input.name,
        sourceIdentity: input.sourceIdentity,
        sourceCommit: input.sourceCommit,
        vMajor: input.version.major,
        vMinor: input.version.minor,
        vPatch: input.version.patch,
        skillIdsJson: serializeContract(record.skillIds),
        recordJson: serializeContract(record),
        rev: nextRevision,
      });
      return { resultRef: input.packId };
    },
    events: [
      {
        eventType: 'skill-catalog.pack-installed',
        aggregateType: 'skill-pack',
        aggregateId: input.packId,
        payloadSchemaName: 'SkillPack',
        payloadSchemaVersion: 1,
        payload: { packId: input.packId, skillCount: input.skillIds.length },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, { packId: input.packId });
}

/** An evaluation threshold set (NN-SKILL-012). */
export interface EvalThresholds {
  readonly minQuality: number;
  readonly maxLatencyMs: number;
  readonly maxTokens: number;
  readonly maxCostCents: number;
  readonly minSafety: number;
}

/** An evaluation measurement for one case. */
export interface EvalMeasurement {
  readonly quality: number;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly costCents: number;
  readonly safety: number;
}

/**
 * Decide whether an evaluation PASSES its thresholds (NN-SKILL-012). Every
 * threshold must hold (quality/safety at or above minimum; latency/token/cost
 * at or below maximum). A failure means the update must NOT promote and an
 * atomic rollback keeps the prior version — this function reports pass/fail;
 * the caller performs the atomic rollback.
 */
export function evaluationPasses(
  measurement: EvalMeasurement,
  thresholds: EvalThresholds,
): { readonly pass: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (measurement.quality < thresholds.minQuality) reasons.push('quality below minimum');
  if (measurement.safety < thresholds.minSafety) reasons.push('safety below minimum');
  if (measurement.latencyMs > thresholds.maxLatencyMs) reasons.push('latency above maximum');
  if (measurement.tokens > thresholds.maxTokens) reasons.push('tokens above maximum');
  if (measurement.costCents > thresholds.maxCostCents) reasons.push('cost above maximum');
  return { pass: reasons.length === 0, reasons };
}

// ─── Learned skill proposals (NN-SKILL-013, CD-021) ─────────────────────────

/**
 * The minimum confidence for AUTOMATIC application of a learned skill
 * (NN-SKILL-013, CD-021). Confidence > 0.8 is NECESSARY but NOT SUFFICIENT:
 * automatic application also requires policy, provenance, evaluation, low risk,
 * and a permission subset (CD-021). This module records PROPOSALS only.
 */
export const MIN_AUTO_APPLY_CONFIDENCE = 0.8 as const;

/** A learned skill proposal (always `proposed`; never self-applied). */
export interface LearnedProposal {
  readonly proposalId: string;
  readonly skillId: string;
  readonly state: 'proposed';
  readonly confidence: number;
  readonly sourceSession: string;
  readonly proposedAt: string;
}

/** Input to {@link proposeLearnedSkill}. */
export interface ProposeLearnedInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly skillId: string;
  readonly confidence: number;
  readonly sourceSession: string;
  readonly now?: () => Date;
}

/**
 * Record a learned skill PROPOSAL from a successful complex execution
 * (NN-SKILL-013). The proposal is ALWAYS created in the `proposed` state with
 * its source session, confidence, and provenance; the catalog NEVER
 * self-authorizes automatic application. A proposal is inert until a separate
 * approval authority applies it — and even then only when confidence > 0.8 AND
 * every independent gate (policy, provenance, evaluation, low risk, permission
 * subset) holds (CD-021).
 */
export function proposeLearnedSkill(
  db: Database.Database,
  input: ProposeLearnedInput,
): SkillCatalogOutcome<LearnedProposal> {
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    return fail('VALIDATION', 'confidence must be within [0,1]');
  }
  const now = (input.now ?? (() => new Date()))().toISOString();
  const proposalId = makeOpaqueId('slrn', input.idempotencyKey);
  const proposal: LearnedProposal = {
    proposalId,
    skillId: input.skillId,
    state: 'proposed',
    confidence: input.confidence,
    sourceSession: input.sourceSession,
    proposedAt: now,
  };

  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({ op: 'propose-learned', proposalId, skillId: input.skillId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO skill_learned_proposals
           (proposal_id, skill_id, state, confidence, source_session, record_json, proposed_at)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?)`,
      ).run(
        proposalId,
        input.skillId,
        input.confidence,
        input.sourceSession,
        serializeContract(proposal),
        now,
      );
      return { resultRef: proposalId };
    },
    events: [
      {
        eventType: 'skill-catalog.learned-proposed',
        aggregateType: 'skill',
        aggregateId: input.skillId,
        payloadSchemaName: 'LearnedProposal',
        payloadSchemaVersion: 1,
        payload: { proposalId, confidence: input.confidence, state: 'proposed' },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, proposal);
}

/**
 * Whether a learned proposal is ELIGIBLE for automatic application (CD-021).
 * Confidence > 0.8 is necessary but not sufficient — EVERY independent gate must
 * also hold: policy allows, provenance present, evaluation passed, risk is low,
 * and the requested permissions are a SUBSET of the target's. This is a pure
 * decision; the catalog never self-applies (it only records proposals).
 */
export function isAutoApplyEligible(
  proposal: Pick<LearnedProposal, 'confidence'>,
  gates: {
    readonly policyAllows: boolean;
    readonly provenancePresent: boolean;
    readonly evaluationPassed: boolean;
    readonly lowRisk: boolean;
    readonly permissionSubset: boolean;
  },
): boolean {
  return (
    proposal.confidence > MIN_AUTO_APPLY_CONFIDENCE &&
    gates.policyAllows &&
    gates.provenancePresent &&
    gates.evaluationPassed &&
    gates.lowRisk &&
    gates.permissionSubset
  );
}

/** Read the learned proposals for a skill (all `proposed`). */
export function readLearnedProposals(db: Database.Database, skillId: string): LearnedProposal[] {
  const rows = db
    .prepare(
      'SELECT record_json FROM skill_learned_proposals WHERE skill_id = ? ORDER BY proposal_id',
    )
    .all(skillId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as LearnedProposal);
}

// ─── Typed clients (NN-SKILL-014) ────────────────────────────────────────────

/**
 * Generate stable, non-executing, git-diffable TypeScript declarations for the
 * installed skill contracts (`neuronest sync`, NN-SKILL-014). The output is a
 * pure `.d.ts`-style string: an exported const map from skill id to its
 * capability/tool contract, and a union type of installed skill ids. It
 * contains NO runtime/executable code and is DETERMINISTIC (skills sorted by
 * id), so the diff is stable across runs. The caller creates the target package
 * directory when absent (NN-SKILL-014); this function only produces the text.
 */
export function generateTypedClients(db: Database.Database): string {
  const skills = readRegisteredSkills(db); // already ordered by id
  const lines: string[] = [
    '// GENERATED by `neuronest sync` — do not edit. Non-executing declarations.',
    '// Stable, git-diffable typed clients for installed skill contracts (NN-SKILL-014).',
    '',
  ];
  if (skills.length === 0) {
    lines.push('export type InstalledSkillId = never;');
    lines.push('export const INSTALLED_SKILLS = {} as const;');
    return `${lines.join('\n')}\n`;
  }
  const idUnion = skills.map((s) => `'${s.skillId}'`).join(' | ');
  lines.push(`export type InstalledSkillId = ${idUnion};`);
  lines.push('');
  lines.push('export interface SkillContract {');
  lines.push('  readonly skillId: InstalledSkillId;');
  lines.push('  readonly capabilities: readonly string[];');
  lines.push('  readonly toolRefs: readonly string[];');
  lines.push('}');
  lines.push('');
  lines.push('export const INSTALLED_SKILLS: Readonly<Record<InstalledSkillId, SkillContract>> = {');
  for (const s of skills) {
    const caps = s.capabilities.map((c) => `'${c}'`).join(', ');
    const tools = s.toolRefs.map((t) => `'${t}'`).join(', ');
    lines.push(`  '${s.skillId}': { skillId: '${s.skillId}', capabilities: [${caps}], toolRefs: [${tools}] },`);
  }
  lines.push('} as const;');
  return `${lines.join('\n')}\n`;
}
