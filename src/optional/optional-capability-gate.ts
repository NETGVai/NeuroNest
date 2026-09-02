/**
 * Optional Capability Release Authority — per-capability release GATE
 * (FUT-PKG-08-OPTIONAL/T-007).
 *
 * This module is the FAIL-CLOSED evaluator that decides whether an OPTIONAL
 * capability (a channel adapter, an integration/MCP/browser adapter, an
 * optional knowledge/voice runtime, or an independently deployable cloud
 * boundary — all built by FUT-PKG-08-OPTIONAL/T-001..T-006) may be ADVERTISED
 * for a given revision. It is an OBSERVER over the evidence graph and the
 * Capability Registry (D-19.4): it re-implements NONE of the adapters; it only
 * READS revision/profile-bound `EvidenceRecord@1` passes
 * (src/shared/evidence-observability.ts) and renders a verdict.
 *
 * Trust posture (the task Acceptance, verbatim): "expected is advertisement
 * only for exact passed cell/revision; missing evidence, degraded dependency,
 * catalog-only entry, or failed rollback remains disabled/unavailable without
 * changing core readiness." This gate therefore blocks advertisement when ANY
 * of the following holds, and each is independent so no single optional failure
 * can ever flip the core:
 *
 *   1. A required per-capability evidence CELL is missing OR its only matching
 *      record is stale/mismatched-revision/wrong-profile/not-pass (a valid pass
 *      is bound to the EXACT criterion + source revision + implementation
 *      revision + fixture profile per D-07 / NN-INV-015).
 *   2. The capability declares a NON-IMPLEMENTABLE lifecycle (e.g. a
 *      `catalog-only` channel entry): a catalog-only entry can NEVER advertise,
 *      regardless of evidence (NN-CHANNEL-011, D-17). It is typed UNAVAILABLE.
 *   3. A DEPENDENCY is degraded/unavailable (a scoped optional failure), which
 *      keeps the capability degraded/unavailable — never `ready` (NN-EXEC-012,
 *      NN-PLATFORM-007, NN-UI-009).
 *   4. The independent kill/ROLLBACK control has no valid rehearsal pass at the
 *      matching revision (NN-CLOUD-006, D-23 abort/rollback). A capability that
 *      cannot be independently drained/rolled back stays disabled.
 *
 * The per-capability matrix is the D-22 "verification cell" idea: contract,
 * security, cancellation, reconnect, concurrency, failure-isolation, health,
 * platform, package, and e2e — each recorded as passed / unavailable /
 * not-applicable per advertised adapter. `not-applicable` cells are recorded
 * (an honest matrix records a cell that does not apply to an adapter, e.g.
 * `reconnect` for a stateless boundary) and do NOT block; a REQUIRED cell with
 * no valid pass DOES block.
 *
 * Core-readiness ISOLATION (NN-INV-014, D-24): the gate is a pure function over
 * its inputs and the (observer) evidence store. It performs NO writes to any
 * core table and returns `coreReadinessUnchanged: true` on every path — a
 * blocked optional capability changes nothing about the product's core
 * readiness. Rollout follows D-23: disabled -> developer -> internal -> bounded
 * cohort -> explicit default; abort disables/drains one capability only.
 *
 * Design anchors: D-17 (portability capability matrix), D-22 (verification /
 * release-evidence strategy), D-23 (phased rollout/rollback), D-24 (risks).
 * Requirements: NN-INV-014, NN-INV-015, NN-CHANNEL-001..012,
 * NN-INTEGRATION-001..012, NN-CLOUD-001..007, NN-PLATFORM-002, NN-PLATFORM-007,
 * NN-VERIFY-005.
 */

import { type CapabilityStatus } from '../shared/capability-registry.js';
import {
  type EvidenceService,
  type EvidenceQuery,
  type EvidenceMismatchReason,
  evidenceSatisfies,
} from '../shared/evidence-observability.js';

// ─── Per-capability verification matrix (D-22) ───────────────────────────────

/**
 * The ten verification CELLS every advertised optional adapter is evaluated
 * against (the task Deliverables: "contract/security/cancellation/reconnect/
 * concurrency/failure-isolation/health/platform/package/e2e evidence per
 * advertised adapter"). The set is fixed so the matrix is complete and
 * countable per adapter.
 */
export const GATE_CELLS = Object.freeze([
  'contract',
  'security',
  'cancellation',
  'reconnect',
  'concurrency',
  'failure-isolation',
  'health',
  'platform',
  'package',
  'e2e',
] as const);
export type GateCell = (typeof GATE_CELLS)[number];

/** Whether a value is a known gate cell. */
export function isGateCell(value: unknown): value is GateCell {
  return typeof value === 'string' && (GATE_CELLS as readonly string[]).includes(value);
}

/**
 * A capability lifecycle for gate purposes. `implementable` capabilities MAY
 * advertise when fully conformant; `catalog-only` (and any other
 * non-implementable) entries can NEVER advertise — they are typed UNAVAILABLE
 * regardless of evidence (NN-CHANNEL-011, D-17 dual-MCP style non-promotion).
 */
export const GATE_LIFECYCLES = Object.freeze(['implementable', 'catalog-only'] as const);
export type GateLifecycle = (typeof GATE_LIFECYCLES)[number];

/**
 * The requirement for a single matrix cell of a single advertised adapter.
 *
 *   - `kind: 'required'` — a valid revision/profile-bound pass MUST exist for
 *     `query`, or the cell (and thus the capability) is blocked.
 *   - `kind: 'not-applicable'` — the cell does not apply to this adapter and is
 *     recorded as such (honest matrix); it never blocks. A `reason` documents
 *     why (e.g. "stateless boundary has no reconnect").
 */
export type CellRequirement =
  | { readonly kind: 'required'; readonly query: EvidenceQuery }
  | { readonly kind: 'not-applicable'; readonly reason: string };

/** A dependency health snapshot for a capability (NN-EXEC-012). */
export interface DependencyHealth {
  /** Dependency id, e.g. `python-runtime`, `worker-binding`. */
  readonly id: string;
  /** Its scoped health status on the D-19.4 ladder. */
  readonly status: CapabilityStatus;
}

/**
 * The gate input for ONE optional capability / advertised adapter. Callers
 * supply the exact revision/profile-bound queries per cell (from the owning
 * authority's evidence), the lifecycle, the dependency snapshot, and the
 * independent rollback-rehearsal query.
 */
export interface CapabilityGateInput {
  /** Stable capability/adapter id, e.g. `channel:slack`, `cloud:license`. */
  readonly capabilityId: string;
  /** Lifecycle classification (catalog-only can never advertise). */
  readonly lifecycle: GateLifecycle;
  /** The per-cell requirements. Every {@link GateCell} MUST be present. */
  readonly cells: Readonly<Record<GateCell, CellRequirement>>;
  /** Dependency health snapshots; any non-advertisable dependency degrades. */
  readonly dependencies: readonly DependencyHealth[];
  /**
   * Query for the INDEPENDENT kill/rollback rehearsal evidence. A capability
   * that cannot be independently drained/rolled back at the matching revision
   * stays disabled (NN-CLOUD-006, D-23).
   */
  readonly rollbackRehearsal: EvidenceQuery;
}

/** Why a single cell failed to satisfy its requirement. */
export interface CellFinding {
  readonly cell: GateCell;
  readonly outcome: 'passed' | 'not-applicable' | 'missing' | 'mismatched';
  /** For a mismatch, the first reason the evidence did not satisfy the query. */
  readonly reason?: EvidenceMismatchReason;
}

/** A structured, human-safe blocking reason. */
export interface GateBlockReason {
  readonly code:
    | 'catalog-only'
    | 'missing-evidence'
    | 'mismatched-revision'
    | 'degraded-dependency'
    | 'failed-rollback';
  readonly detail: string;
}

/**
 * The verdict for one capability. `advertise` is the single fail-closed
 * decision; `status` is the D-19.4 ladder position; `cells` is the recorded
 * matrix (including not-applicable cells); `blockReasons` enumerates every
 * independent reason advertisement was withheld. `coreReadinessUnchanged` is
 * ALWAYS true: an optional verdict never changes core readiness (NN-INV-014).
 */
export interface CapabilityGateVerdict {
  readonly capabilityId: string;
  readonly advertise: boolean;
  readonly status: CapabilityStatus;
  readonly cells: readonly CellFinding[];
  readonly blockReasons: readonly GateBlockReason[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the release gate for ONE optional capability. Pure and total over
 * its input and the (observer) evidence store — NO writes, NO throws.
 *
 * Fail-closed decision order (each independent; ALL are evaluated so the
 * verdict reports every reason, not just the first):
 *   - catalog-only lifecycle              -> UNAVAILABLE, never advertise
 *   - any required cell missing/mismatched -> BLOCKED (evidence gate)
 *   - any dependency not advertisable      -> DEGRADED/UNAVAILABLE (scoped)
 *   - rollback rehearsal not valid         -> BLOCKED (cannot abort safely)
 * A capability advertises IFF none of the above holds AND every required cell
 * has a valid revision/profile-bound pass.
 */
export function evaluateCapabilityGate(
  input: CapabilityGateInput,
  evidence: EvidenceService,
): CapabilityGateVerdict {
  const blockReasons: GateBlockReason[] = [];
  const cellFindings: CellFinding[] = [];

  // (2) Catalog-only / non-implementable lifecycle: typed UNAVAILABLE, and it
  // can NEVER advertise regardless of any evidence present. We still record the
  // matrix below for an honest report, but the lifecycle alone is disqualifying.
  const catalogOnly = input.lifecycle === 'catalog-only';
  if (catalogOnly) {
    blockReasons.push({
      code: 'catalog-only',
      detail: `Capability ${input.capabilityId} is a catalog-only entry and is typed UNAVAILABLE; it can never advertise.`,
    });
  }

  // (1) Per-cell evidence matrix. A required cell needs a valid, bound pass; a
  // not-applicable cell is recorded and never blocks.
  for (const cell of GATE_CELLS) {
    const req = input.cells[cell];
    if (req.kind === 'not-applicable') {
      cellFindings.push({ cell, outcome: 'not-applicable' });
      continue;
    }
    const passes = evidence.findValidPasses(req.query);
    if (passes.length > 0) {
      cellFindings.push({ cell, outcome: 'passed' });
      continue;
    }
    // Distinguish "no matching record at all" from "record present but stale /
    // wrong revision / wrong profile / not-pass" for a precise report.
    const candidate = evidence
      .snapshot()
      .find((r) => r.canonicalLinks.includes(req.query.canonicalCriterion));
    if (!candidate) {
      cellFindings.push({ cell, outcome: 'missing' });
      blockReasons.push({
        code: 'missing-evidence',
        detail: `Cell "${cell}" for ${input.capabilityId} has no evidence for ${req.query.canonicalCriterion}.`,
      });
    } else {
      const why = evidenceSatisfies(candidate, req.query);
      const reason: EvidenceMismatchReason = why.ok ? 'not-pass' : why.reason;
      cellFindings.push({ cell, outcome: 'mismatched', reason });
      blockReasons.push({
        code:
          reason === 'source-revision' || reason === 'implementation-revision'
            ? 'mismatched-revision'
            : 'missing-evidence',
        detail: `Cell "${cell}" for ${input.capabilityId} has no valid pass for ${req.query.canonicalCriterion} (${reason}).`,
      });
    }
  }

  // (3) Dependency health: a scoped optional failure keeps the capability
  // degraded/unavailable — never ready. A dependency must itself be `ready` for
  // the capability to advertise as ready; a `degraded`/`unavailable`/`blocked`
  // dependency withholds advertisement (NN-EXEC-012, NN-PLATFORM-007). It does
  // NOT touch core readiness.
  const degradedDeps = input.dependencies.filter((d) => d.status !== 'ready');
  for (const dep of degradedDeps) {
    blockReasons.push({
      code: 'degraded-dependency',
      detail: `Dependency "${dep.id}" of ${input.capabilityId} is ${dep.status}; capability cannot be ready.`,
    });
  }

  // (4) Independent kill/rollback rehearsal: no valid pass -> cannot abort
  // safely -> stays disabled.
  const rollbackOk = evidence.hasValidPass(input.rollbackRehearsal);
  if (!rollbackOk) {
    blockReasons.push({
      code: 'failed-rollback',
      detail: `Capability ${input.capabilityId} has no valid independent rollback rehearsal for ${input.rollbackRehearsal.canonicalCriterion}.`,
    });
  }

  // Derive the fail-closed status + advertise decision.
  const status = deriveStatus({
    catalogOnly,
    hasEvidenceGap: cellFindings.some(
      (c) => c.outcome === 'missing' || c.outcome === 'mismatched',
    ),
    rollbackOk,
    degradedDepCount: degradedDeps.length,
  });

  // Advertise IFF nothing blocked AND the capability is truthfully `ready`.
  // (`degraded` is a present-but-reduced mode that is NOT advertised here: the
  // task requires advertisement only for a fully passed cell/revision.)
  const advertise = blockReasons.length === 0 && status === 'ready';

  return Object.freeze({
    capabilityId: input.capabilityId,
    advertise,
    status,
    cells: Object.freeze(cellFindings),
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Map the independent failure signals onto the D-19.4 ladder. `unavailable`
 * wins for a catalog-only entry (no adapter to advertise) or a hard evidence
 * gap / failed rollback (no current-truth prerequisite); `degraded` is a named
 * reduced mode driven ONLY by a degraded dependency when all mandatory gates
 * pass; `ready` requires everything to hold. `blocked` is used when an adapter
 * exists and its evidence is present-but-stale (prerequisite not met).
 */
function deriveStatus(signals: {
  readonly catalogOnly: boolean;
  readonly hasEvidenceGap: boolean;
  readonly rollbackOk: boolean;
  readonly degradedDepCount: number;
}): CapabilityStatus {
  if (signals.catalogOnly) return 'unavailable';
  if (signals.hasEvidenceGap || !signals.rollbackOk) return 'blocked';
  if (signals.degradedDepCount > 0) return 'degraded';
  return 'ready';
}

// ─── Batch evaluation (P7 capability review) ─────────────────────────────────

/** The result of a full P7 capability-review pass. */
export interface CapabilityReviewResult {
  readonly verdicts: readonly CapabilityGateVerdict[];
  /** Capability ids that advertised (exact passed cell/revision). */
  readonly advertised: readonly string[];
  /** Capability ids that remained disabled/unavailable, with reasons. */
  readonly withheld: readonly string[];
  /** Always true: no optional verdict changes core readiness (NN-INV-014). */
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the gate over every advertised capability. Deterministic: verdicts
 * are returned sorted by capability id. This is the "P7 capability review"
 * trigger; the Capability Registry and evidence graph are observers.
 */
export function reviewOptionalCapabilities(
  inputs: readonly CapabilityGateInput[],
  evidence: EvidenceService,
): CapabilityReviewResult {
  const verdicts = [...inputs]
    .map((input) => evaluateCapabilityGate(input, evidence))
    .sort((a, b) => (a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0));
  const advertised = verdicts.filter((v) => v.advertise).map((v) => v.capabilityId);
  const withheld = verdicts.filter((v) => !v.advertise).map((v) => v.capabilityId);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    advertised: Object.freeze(advertised),
    withheld: Object.freeze(withheld),
    coreReadinessUnchanged: true as const,
  });
}
