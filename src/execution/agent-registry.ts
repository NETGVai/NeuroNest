/**
 * AgentRegistry — dynamic Agent catalog discovery, unique effective identity,
 * department membership, audit, orchestration selector, and self-improvement
 * proposals (FUT-PKG-06-EXECUTION/T-004).
 *
 * D-04 names `AgentRegistry` as the sole write authority for the Agent catalog
 * (canonical identity `agentId`, `manifest version/hash`, `registry revision`);
 * the selector, dashboard, and orchestrator view are read models. This module
 * implements that authority over a real SQLite database through the
 * single-writer, idempotent-receipt transaction from
 * {@link ../storage/authority-transaction} (D-08.2). The catalog is discovered
 * DYNAMICALLY from the configured manifest set — never a hard-coded list or
 * count (NN-AGENT-001, NN-IDENT-004).
 *
 * Fail-closed activation rules (NN-AGENT-001/007, NN-INV-001):
 *
 *   - Every VALID manifest appears EXACTLY ONCE in the effective catalog — set
 *     equality between the valid discovered set and the effective set
 *     (V-AGENT-001 catalog-set-equality).
 *   - A DUPLICATE effective identity (id/name/alias collision), a MALFORMED
 *     manifest (schema/digest/reserved-id), an INCOMPATIBLE range, an
 *     unexpectedly EMPTY catalog, an INCOMPLETE catalog (declared-count
 *     mismatch), or a LOW-QUALITY import blocks activation — the offending
 *     manifests are QUARANTINED with a typed reason and are never offered.
 *   - Every effective agent belongs to exactly ONE real department and appears
 *     exactly once in grouped views; a virtual selector is not a department
 *     (NN-AGENT-002, NN-IDENT-005, NN-COMPAT-009, CD-002).
 *
 * The orchestration selector (NN-IDENT-005, NN-COMPAT-009, CD-002/CD-027)
 * exposes exactly one visible virtual selector named `NeuroNest Orchestration`,
 * renders grouped REAL departments (excluding the virtual selector from those
 * groups), includes every effective agent exactly once, preserves agent status,
 * and derives every count from the registry — never a static total.
 *
 * Memory and self-improvement (NN-AGENT-008/009): learned rules/prompts/roles
 * are PROPOSED from repeated evidence and require configured approval; the
 * registry only records `proposed` records and never self-authorizes a change
 * to its own safety policy.
 *
 * Additive migration (NN-COMPAT-001/002): tables are created with
 * `IF NOT EXISTS`; callers SHADOW the prior static catalog and compare the
 * discovered set to the static set before switching the registry reader.
 * Rollback restores the prior reader, not a hard-coded authority.
 *
 * Design anchors: D-04, D-05, D-07 (`AgentManifest@1`), D-13, D-19.
 * Requirements: NN-AGENT-001–010, NN-IDENT-003/004/005, NN-COMPAT-009,
 * NN-INV-001/003/005/007/008.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import {
  effectiveIdentityTokens,
  isLiveAgentStatus,
  scoreImportedAgent,
  validateManifest,
  type AgentManifest,
  type AgentStatus,
  type ImportedQualityInput,
  type ManifestDefect,
} from './agent-types';

const AUTHORITY_ID = 'authority-agent-registry';

/** The single visible virtual orchestration selector name (NN-IDENT-005). */
export const ORCHESTRATION_SELECTOR_NAME = 'NeuroNest Orchestration' as const;

// ─── Canonical durable tables (additive; NN-COMPAT-001/002) ─────────────────

const AGENT_REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS agent_manifests (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    department_id TEXT NOT NULL,
    manifest_version INTEGER NOT NULL,
    content_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    registry_revision INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    agent_id TEXT,
    reason TEXT NOT NULL,
    detail TEXT NOT NULL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_departments (
    department_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_memory_proposals (
    proposal_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    evidence_count INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    proposed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_manifests_department
    ON agent_manifests (department_id);
  CREATE INDEX IF NOT EXISTS idx_agent_manifests_status
    ON agent_manifests (status);
  CREATE INDEX IF NOT EXISTS idx_agent_memory_proposals_agent
    ON agent_memory_proposals (agent_id);
`;

/** Create the canonical Agent Registry tables (idempotent, additive). */
export function ensureAgentRegistryTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(AGENT_REGISTRY_DDL);
}

// ─── Typed outcomes ──────────────────────────────────────────────────────────

/** A typed registry failure (secret-free). */
export interface AgentRegistryError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type AgentRegistryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: AgentRegistryError };

function fail<T>(code: ErrorCode, message: string): AgentRegistryOutcome<T> {
  return { ok: false, error: { code, message } };
}

function mapResult<T>(result: AuthorityMutationResult, value: T): AgentRegistryOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value, replayed: result.kind === 'replayed' };
}

// ─── Department declaration (NN-AGENT-002) ──────────────────────────────────

/** A real department. `kind` distinguishes a real department from the virtual selector. */
export interface Department {
  readonly departmentId: string;
  readonly name: string;
  readonly kind: 'real' | 'virtual';
}

// ─── Quarantine (fail-closed audit, NN-AGENT-007) ───────────────────────────

/** The reason a manifest was quarantined (never offered). */
export type QuarantineReason =
  | ManifestDefect
  | 'duplicate-effective-identity'
  | 'low-quality'
  | 'unknown-department'
  | 'incomplete-catalog'
  | 'empty-catalog';

/** A quarantine record: an agent (or catalog) blocked from activation. */
export interface QuarantineRecord {
  readonly quarantineId: string;
  readonly agentId: string | null;
  readonly reason: QuarantineReason;
  readonly detail: string;
  readonly source: string;
  readonly recordedAt: string;
}

// ─── Discovery input ─────────────────────────────────────────────────────────

/**
 * A discovered manifest candidate: the untrusted manifest value plus optional
 * imported-quality parse (for imported agents that must earn 100/100) and its
 * discovery source path/ref. The registry validates each candidate; a candidate
 * that fails any check is quarantined, never activated.
 */
export interface DiscoveredCandidate {
  readonly value: unknown;
  readonly source: string;
  /** Present for IMPORTED agents; absent for first-party manifests. */
  readonly importedQuality?: ImportedQualityInput;
}

/** Input to {@link discoverAndActivate}. */
export interface DiscoverInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  /** The dynamically discovered candidate set (NN-AGENT-001). */
  readonly candidates: readonly DiscoveredCandidate[];
  /** The real departments the candidates may belong to. */
  readonly departments: readonly Department[];
  /** The current app major for the compatibility check. */
  readonly appMajor: number;
  /**
   * The EXPECTED count of discovered candidates (a shadow/parity signal). When
   * provided and it does not equal `candidates.length`, the catalog is treated
   * as INCOMPLETE and activation is blocked fail-closed (NN-AGENT-001). This is
   * the "shadow static catalogs/counts and compare sets" parity check.
   */
  readonly expectedCount?: number;
  readonly now?: () => Date;
}

/** The result of a discovery/activation pass. */
export interface ActivationResult {
  /** The manifests that passed every check and were activated (deduped). */
  readonly activated: readonly AgentManifest[];
  /** The quarantined candidates with typed reasons (never offered). */
  readonly quarantined: readonly QuarantineRecord[];
  /** Whether the whole catalog was blocked (empty/incomplete). */
  readonly catalogBlocked: boolean;
  /** Safe, secret-free explanation when the catalog is blocked. */
  readonly blockReason?: string;
}

// ─── Discovery + activation (NN-AGENT-001, set equality) ────────────────────

/**
 * Discover the configured catalog dynamically and activate every VALID agent
 * EXACTLY ONCE (V-AGENT-001 catalog-set-equality). The pass:
 *
 *   1. blocks fail-closed when the catalog is unexpectedly EMPTY, or when an
 *      `expectedCount` parity signal does not match the discovered count
 *      (INCOMPLETE) — no agent is activated (NN-AGENT-001);
 *   2. validates each candidate against the schema, its own content digest, the
 *      reserved-id rule, and the compatibility range (malformed/incompatible →
 *      quarantine);
 *   3. scores IMPORTED candidates and quarantines any that did not earn 100/100
 *      with authenticity + provenance evidence (NN-AGENT-006, low-quality);
 *   4. verifies each candidate names a REAL department (NN-AGENT-002);
 *   5. detects DUPLICATE effective identities (id/name/alias collisions,
 *      case-insensitive) and quarantines EVERY manifest in a colliding set —
 *      duplicates block activation (NN-IDENT-003);
 *   6. commits the surviving manifests + quarantine records atomically through
 *      the single-writer authority transaction, bumping the registry revision.
 *
 * The result is deterministic: the activated set equals the set of valid,
 * unique, real-department, quality-passing candidates, each appearing once.
 * A duplicated call under the same idempotency key replays the prior receipt
 * (NN-INV-007). This function never mutates a candidate or the input.
 */
export function discoverAndActivate(
  db: Database.Database,
  input: DiscoverInput,
): AgentRegistryOutcome<ActivationResult> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const quarantine: QuarantineRecord[] = [];
  let quarantineSeq = 0;
  const nextQuarantineId = (): string => {
    quarantineSeq += 1;
    return makeOpaqueId('quar', `${input.commandId}${quarantineSeq}`);
  };

  const record = (
    agentId: string | null,
    reason: QuarantineReason,
    detail: string,
    source: string,
  ): void => {
    quarantine.push({
      quarantineId: nextQuarantineId(),
      agentId,
      reason,
      detail,
      source,
      recordedAt: now,
    });
  };

  // Step 1a: unexpectedly empty catalog blocks fail-closed (NN-AGENT-001).
  if (input.candidates.length === 0) {
    record(null, 'empty-catalog', 'no manifests discovered', 'catalog');
    return commitActivation(db, input, [], quarantine, {
      catalogBlocked: true,
      blockReason: 'catalog is unexpectedly empty; activation blocked',
    });
  }

  // Step 1b: incomplete catalog (parity mismatch) blocks fail-closed.
  if (
    typeof input.expectedCount === 'number' &&
    input.expectedCount !== input.candidates.length
  ) {
    record(
      null,
      'incomplete-catalog',
      `discovered ${input.candidates.length} manifests but expected ${input.expectedCount}`,
      'catalog',
    );
    return commitActivation(db, input, [], quarantine, {
      catalogBlocked: true,
      blockReason: 'catalog is incomplete; discovered count does not match parity signal',
    });
  }

  const realDepartments = new Set(
    input.departments.filter((d) => d.kind === 'real').map((d) => d.departmentId),
  );

  // Step 2: per-candidate SCHEMA/digest/range validation. A manifest that does
  // not even parse to a well-formed AgentManifest@1 is quarantined immediately;
  // it has no trustworthy effective identity and cannot participate in identity
  // collision detection.
  interface Parsed {
    readonly manifest: AgentManifest;
    readonly source: string;
    readonly tokens: string[];
    readonly importedQuality?: DiscoveredCandidate['importedQuality'];
  }
  const parsed: Parsed[] = [];
  for (const cand of input.candidates) {
    const validation = validateManifest(cand.value, input.appMajor);
    if (!validation.ok) {
      const agentId =
        typeof (cand.value as { agentId?: unknown })?.agentId === 'string'
          ? (cand.value as { agentId: string }).agentId
          : null;
      record(agentId, validation.defect, validation.detail, cand.source);
      continue;
    }
    parsed.push({
      manifest: validation.manifest,
      source: cand.source,
      tokens: effectiveIdentityTokens(validation.manifest),
      ...(cand.importedQuality ? { importedQuality: cand.importedQuality } : {}),
    });
  }

  // Step 3: duplicate EFFECTIVE identity across ALL well-formed manifests —
  // quarantine EVERY manifest in a colliding set fail-closed (NN-IDENT-003). A
  // collision is decided over the full discovered identity space, not just the
  // department/quality survivors, so a duplicate always blocks activation and a
  // last-writer-win is never possible.
  const tokenOwners = new Map<string, number>();
  for (const p of parsed) {
    for (const token of new Set(p.tokens)) {
      tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
    }
  }
  const unique: Parsed[] = [];
  for (const p of parsed) {
    const collidingToken = [...new Set(p.tokens)].find(
      (token) => (tokenOwners.get(token) ?? 0) > 1,
    );
    if (collidingToken !== undefined) {
      record(
        p.manifest.agentId,
        'duplicate-effective-identity',
        `effective identity token '${collidingToken}' collides with another manifest`,
        p.source,
      );
      continue;
    }
    unique.push(p);
  }

  // Step 4: quality + department checks on the unique survivors (NN-AGENT-002/006).
  const activated: AgentManifest[] = [];
  for (const p of unique) {
    // Imported agents must earn 100/100 with authenticity + provenance.
    if (p.importedQuality) {
      const score = scoreImportedAgent(p.importedQuality);
      if (!score.activationAllowed) {
        record(p.manifest.agentId, 'low-quality', score.reason, p.source);
        continue;
      }
    }
    // Department membership must reference a REAL department (NN-AGENT-002).
    if (!realDepartments.has(p.manifest.departmentId)) {
      record(
        p.manifest.agentId,
        'unknown-department',
        `department ${p.manifest.departmentId} is not a real department`,
        p.source,
      );
      continue;
    }
    activated.push(p.manifest);
  }

  return commitActivation(db, input, activated, quarantine, { catalogBlocked: false });
}

/**
 * Commit an activation pass atomically: replace the manifest table with the
 * newly-activated set, replace the quarantine table with this pass's records,
 * and upsert the declared departments — all inside one single-writer authority
 * transaction that bumps the registry revision (D-08.2). A quarantined manifest
 * is never written to `agent_manifests`, so it can never be offered.
 */
function commitActivation(
  db: Database.Database,
  input: DiscoverInput,
  activated: readonly AgentManifest[],
  quarantine: readonly QuarantineRecord[],
  extra: { readonly catalogBlocked: boolean; readonly blockReason?: string },
): AgentRegistryOutcome<ActivationResult> {
  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({
      op: 'discover-activate',
      activated: activated.map((m) => m.contentDigest).sort(),
      quarantined: quarantine.map((q) => `${q.agentId ?? ''}:${q.reason}`).sort(),
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      // Departments (upsert declared set).
      for (const dept of input.departments) {
        tx.prepare(
          `INSERT INTO agent_departments (department_id, name, kind)
           VALUES (?, ?, ?)
           ON CONFLICT(department_id) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
        ).run(dept.departmentId, dept.name, dept.kind);
      }
      // Replace the effective manifest set with the activated set (this pass is
      // the authoritative discovery result).
      tx.prepare('DELETE FROM agent_manifests').run();
      const revisionRow = tx
        .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
        .get(AUTHORITY_ID) as { revision: number } | undefined;
      const nextRevision = (revisionRow?.revision ?? 0) + 1;
      for (const manifest of activated) {
        tx.prepare(
          `INSERT INTO agent_manifests
             (agent_id, name, role, department_id, manifest_version, content_digest,
              status, record_json, registry_revision)
           VALUES (@agentId, @name, @role, @departmentId, @manifestVersion, @contentDigest,
              @status, @recordJson, @registryRevision)`,
        ).run({
          agentId: manifest.agentId,
          name: manifest.name,
          role: manifest.role,
          departmentId: manifest.departmentId,
          manifestVersion: manifest.manifestVersion,
          contentDigest: manifest.contentDigest,
          status: manifest.status,
          recordJson: serializeContract(manifest),
          registryRevision: nextRevision,
        });
      }
      // Replace quarantine records for this discovery pass.
      tx.prepare('DELETE FROM agent_quarantine').run();
      for (const q of quarantine) {
        tx.prepare(
          `INSERT INTO agent_quarantine
             (quarantine_id, agent_id, reason, detail, source, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(q.quarantineId, q.agentId, q.reason, q.detail, q.source, q.recordedAt);
      }
      return { resultRef: makeOpaqueId('actv', input.commandId) };
    },
    events: [
      {
        eventType: extra.catalogBlocked ? 'agent-catalog.blocked' : 'agent-catalog.activated',
        aggregateType: 'agent-catalog',
        aggregateId: 'agent-catalog',
        payloadSchemaName: 'AgentCatalog',
        payloadSchemaVersion: 1,
        payload: {
          activatedCount: activated.length,
          quarantinedCount: quarantine.length,
          catalogBlocked: extra.catalogBlocked,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, {
    activated: [...activated],
    quarantined: [...quarantine],
    catalogBlocked: extra.catalogBlocked,
    ...(extra.blockReason ? { blockReason: extra.blockReason } : {}),
  });
}

// ─── Read models (projections; NN-IDENT-004/005) ────────────────────────────

/** Read every effective (activated) manifest, ordered by agent id. */
export function readEffectiveAgents(db: Database.Database): AgentManifest[] {
  const rows = db
    .prepare('SELECT record_json FROM agent_manifests ORDER BY agent_id')
    .all() as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as AgentManifest);
}

/** Read the quarantine records from the last discovery pass. */
export function readQuarantine(db: Database.Database): QuarantineRecord[] {
  const rows = db
    .prepare(
      `SELECT quarantine_id AS quarantineId, agent_id AS agentId, reason, detail, source,
              recorded_at AS recordedAt
       FROM agent_quarantine ORDER BY quarantine_id`,
    )
    .all() as {
    quarantineId: string;
    agentId: string | null;
    reason: string;
    detail: string;
    source: string;
    recordedAt: string;
  }[];
  return rows.map((r) => ({
    quarantineId: r.quarantineId,
    agentId: r.agentId,
    reason: r.reason as QuarantineReason,
    detail: r.detail,
    source: r.source,
    recordedAt: r.recordedAt,
  }));
}

/**
 * The registry-derived effective agent count (NN-IDENT-004). Computed from the
 * effective manifest table at the current revision — NEVER a static/historic
 * constant such as 83/109/537.
 */
export function effectiveAgentCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM agent_manifests').get() as {
    c: number;
  };
  return row.c;
}

/** A department group in the orchestration selector (real departments only). */
export interface SelectorDepartmentGroup {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly agents: readonly {
    readonly agentId: string;
    readonly name: string;
    readonly status: AgentStatus;
  }[];
}

/**
 * The orchestration selector projection (NN-IDENT-005, NN-COMPAT-009,
 * CD-002/CD-027). It exposes exactly ONE visible virtual selector named
 * `NeuroNest Orchestration`, renders grouped REAL departments (the virtual
 * selector is excluded from those groups), includes every effective agent
 * EXACTLY ONCE, preserves agent status, and derives every count from the
 * registry. A duplicate pseudo-department is impossible: groups are keyed by
 * the real department id and each effective agent belongs to exactly one group.
 */
export interface OrchestrationSelector {
  /** The single visible virtual selector name (never a department). */
  readonly virtualSelector: string;
  /** Grouped REAL departments; the virtual selector is not among them. */
  readonly departmentGroups: readonly SelectorDepartmentGroup[];
  /** Registry-derived effective agent count (NN-IDENT-004). */
  readonly agentCount: number;
}

/**
 * Build the orchestration selector projection from the effective catalog. Every
 * effective agent appears in exactly one real-department group; a virtual
 * department is never rendered as a group. The `agentCount` is registry-derived.
 */
export function projectOrchestrationSelector(
  db: Database.Database,
): OrchestrationSelector {
  const agents = readEffectiveAgents(db);
  const deptRows = db
    .prepare(
      `SELECT department_id AS departmentId, name, kind FROM agent_departments
       WHERE kind = 'real' ORDER BY department_id`,
    )
    .all() as { departmentId: string; name: string; kind: string }[];

  const groups: SelectorDepartmentGroup[] = deptRows.map((d) => {
    const members = agents
      .filter((a) => a.departmentId === d.departmentId)
      .map((a) => ({ agentId: a.agentId, name: a.name, status: a.status }));
    return { departmentId: d.departmentId, departmentName: d.name, agents: members };
  });

  return {
    virtualSelector: ORCHESTRATION_SELECTOR_NAME,
    departmentGroups: groups,
    agentCount: agents.length,
  };
}

/**
 * Whether an agent is a MEMBER offered by the orchestration selector: it is an
 * effective (activated) agent, in a real department group, with a live status
 * (NN-IDENT-005). A quarantined/absent agent is never a member — the selector
 * only offers agents that are actually members
 * (V-IDENT-001 orchestration-selector-membership).
 */
export function isSelectorMember(
  selector: OrchestrationSelector,
  agentId: string,
): boolean {
  return selector.departmentGroups.some((g) =>
    g.agents.some((a) => a.agentId === agentId && isLiveAgentStatus(a.status)),
  );
}

// ─── Memory / self-improvement proposals (NN-AGENT-008/009) ─────────────────

/** The kinds of learned artifact that MAY be proposed (NN-AGENT-009). */
export const PROPOSAL_KINDS = Object.freeze([
  'rule',
  'prompt',
  'role',
  'skill',
] as const);
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * A learned self-improvement proposal (NN-AGENT-009). It is ALWAYS created in
 * the `proposed` state; the registry never self-authorizes. Approval (a
 * separate authority) transitions it to `approved`/`rejected`. Recorded from
 * REPEATED evidence: `evidenceCount` must be at least
 * {@link MIN_PROPOSAL_EVIDENCE}. The registry never silently rewrites its own
 * safety policy — a proposal is inert until approved.
 */
export const MIN_PROPOSAL_EVIDENCE = 2 as const;

export interface MemoryProposal {
  readonly proposalId: string;
  readonly agentId: string;
  readonly kind: ProposalKind;
  readonly state: 'proposed';
  readonly evidenceCount: number;
  /** A safe, secret-free description of the proposed change. */
  readonly description: string;
  readonly proposedAt: string;
}

/** Input to {@link proposeSelfImprovement}. */
export interface ProposeInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly agentId: string;
  readonly kind: ProposalKind;
  readonly evidenceCount: number;
  readonly description: string;
  readonly now?: () => Date;
}

/**
 * Record a self-improvement PROPOSAL (NN-AGENT-009). The proposal is created in
 * the `proposed` state ONLY — the registry never self-authorizes a change to
 * its own rules/prompts/roles/skills or its safety policy. A proposal from
 * insufficient evidence (fewer than {@link MIN_PROPOSAL_EVIDENCE} observations)
 * is refused with `VALIDATION`. The agent must be an effective agent; otherwise
 * `CONFLICT`.
 */
export function proposeSelfImprovement(
  db: Database.Database,
  input: ProposeInput,
): AgentRegistryOutcome<MemoryProposal> {
  if (input.evidenceCount < MIN_PROPOSAL_EVIDENCE) {
    return fail(
      'VALIDATION',
      `a proposal requires at least ${MIN_PROPOSAL_EVIDENCE} repeated observations`,
    );
  }
  const exists = db
    .prepare('SELECT 1 FROM agent_manifests WHERE agent_id = ?')
    .get(input.agentId);
  if (!exists) {
    return fail('CONFLICT', 'proposal references an unknown effective agent');
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const proposalId = makeOpaqueId('prop', input.idempotencyKey);
  const proposal: MemoryProposal = {
    proposalId,
    agentId: input.agentId,
    kind: input.kind,
    state: 'proposed',
    evidenceCount: input.evidenceCount,
    description: input.description,
    proposedAt: now,
  };

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({ op: 'propose', proposalId, agentId: input.agentId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO agent_memory_proposals
           (proposal_id, agent_id, kind, state, evidence_count, record_json, proposed_at)
         VALUES (?, ?, ?, 'proposed', ?, ?, ?)`,
      ).run(
        proposalId,
        input.agentId,
        input.kind,
        input.evidenceCount,
        serializeContract(proposal),
        now,
      );
      return { resultRef: proposalId };
    },
    events: [
      {
        eventType: 'agent.self-improvement-proposed',
        aggregateType: 'agent',
        aggregateId: input.agentId,
        payloadSchemaName: 'MemoryProposal',
        payloadSchemaVersion: 1,
        payload: { proposalId, kind: input.kind, state: 'proposed' },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, proposal);
}

/** Read the self-improvement proposals for an agent (all `proposed`). */
export function readProposals(db: Database.Database, agentId: string): MemoryProposal[] {
  const rows = db
    .prepare(
      'SELECT record_json FROM agent_memory_proposals WHERE agent_id = ? ORDER BY proposal_id',
    )
    .all(agentId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as MemoryProposal);
}

// ─── Catalog audit (NN-AGENT-007) ───────────────────────────────────────────

/**
 * The result of a catalog audit (NN-AGENT-007). Compares the dynamically
 * discovered SOURCE path set to the effective SET — never to a numeric total.
 * Reports missing, duplicate, malformed, orphan, and unreachable definitions
 * from the last discovery pass. `blocked` is true when any unresolved gap
 * exists (a quarantined manifest or a source with no effective agent), which
 * blocks activation/release (NN-AGENT-007).
 */
export interface CatalogAudit {
  /** Source paths discovered but with no effective (activated) agent. */
  readonly unreachableSources: readonly string[];
  /** The quarantine reasons present, grouped for the report. */
  readonly quarantineReasons: readonly QuarantineReason[];
  readonly effectiveCount: number;
  readonly quarantinedCount: number;
  readonly blocked: boolean;
}

/**
 * Audit the catalog by comparing the discovered source set to the effective
 * set (NN-AGENT-007). This uses the quarantine table (the record of blocked
 * definitions from the last pass) and the effective manifest table. A non-empty
 * quarantine means unresolved gaps → `blocked` true. Set-based, never
 * count-based.
 */
export function auditCatalog(
  db: Database.Database,
  discoveredSources: readonly string[],
): CatalogAudit {
  const quarantine = readQuarantine(db);
  const effective = readEffectiveAgents(db);
  const effectiveSources = new Set(effective.map((m) => m.provenance.source));
  const unreachable = [...new Set(discoveredSources)].filter(
    (src) => !effectiveSources.has(src) && !quarantine.some((q) => q.source === src),
  );
  const reasons = [...new Set(quarantine.map((q) => q.reason))];
  const blocked = quarantine.length > 0 || unreachable.length > 0;
  return {
    unreachableSources: unreachable,
    quarantineReasons: reasons,
    effectiveCount: effective.length,
    quarantinedCount: quarantine.length,
    blocked,
  };
}

/**
 * The set-equality assertion at the heart of V-AGENT-001 catalog-set-equality:
 * the set of activated agent ids EXACTLY equals the set of valid, unique,
 * real-department, quality-passing candidate ids — every valid agent appears
 * exactly once and no invalid agent appears. Returns `true` when the effective
 * set equals `expectedValidAgentIds`.
 */
export function effectiveSetEquals(
  db: Database.Database,
  expectedValidAgentIds: readonly string[],
): boolean {
  const effective = new Set(readEffectiveAgents(db).map((m) => m.agentId));
  const expected = new Set(expectedValidAgentIds);
  if (effective.size !== expected.size) return false;
  for (const id of expected) {
    if (!effective.has(id)) return false;
  }
  return true;
}
