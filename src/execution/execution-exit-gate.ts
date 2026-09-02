/**
 * Composite EXECUTION exit gate (FUT-PKG-06-EXECUTION/T-009).
 *
 * This module is the P5 EXECUTION EXIT GATE — the last leaf of the EXECUTION
 * package and an ADVERSARIAL verification surface. It adds NO new execution
 * capability. It *proves*, across every P5 authority built by T-001..T-008,
 * that the prohibited outcomes are impossible, and it publishes a blocker
 * report that decides whether the affected scope may be admitted to P6/P7
 * consumer capability (D-22, D-23, NN-VERIFY-005, NN-INV-015).
 *
 * The gate runs one adversarial matrix per prohibited outcome the task names:
 *
 *   tool-bypass          — no built-in / skill / plugin / MCP / terminal / LSP /
 *                          browser / generated tool executes OUTSIDE the one
 *                          governed Tool Execution Pipeline; a non-committed
 *                          (failed / denied) pipeline call leaves no success and
 *                          no side effect (src/execution/tool-execution-pipeline.ts,
 *                          D-11, NN-EXEC-001/003, NN-INV-003/014).
 *   secret-in-context    — a raw secret canary placed in a prompt input never
 *                          survives assembly into model context, and a
 *                          `secret`-classed item is refused entry
 *                          (src/shared/prompt-context-authority.ts, D-10,
 *                          NN-INV-004, NN-CONTEXT-004).
 *   false-completion     — a task/run reports `succeeded`/`completed` ONLY when
 *                          evidence is durably committed and matches; an
 *                          unavailable reviewer or missing evidence BLOCKS
 *                          completion (src/execution/orchestration-service.ts,
 *                          src/execution/task-plan-service.ts, D-13,
 *                          NN-INV-003, NN-ORCH-009, NN-TASK-005).
 *   duplicate-identity   — a duplicated drive of an idempotent authority command
 *                          (a run lock re-acquire, a run start) produces NO second
 *                          identity and NO second effect
 *                          (src/execution/run-locks.ts, NN-INV-007/003,
 *                          NN-ORCH-005).
 *   unbounded-topology   — a cyclic acyclic-topology graph, an over-cap bounded
 *                          batch, or a delegation past the nesting/spawn/
 *                          concurrency bound is REJECTED with no row
 *                          (src/execution/dag-validation.ts,
 *                          src/execution/orchestration-service.ts, D-13,
 *                          NN-ORCH-001/002/003, NN-TASK-002/003).
 *   post-terminal-output — after a stream/token reaches terminal or is
 *                          cancelled, no further output is admitted (no
 *                          post-terminal effect) (src/provider/streaming.ts,
 *                          src/shared/execution-cancellation.ts, D-18,
 *                          NN-INV-012, NN-EXEC-014/015).
 *   accounting-drift     — computed cost is exact / non-negative / deterministic
 *                          and durable usage RECONCILES to committed credits;
 *                          any drift BLOCKS (src/provider/billing.ts, D-18,
 *                          NN-ORCH-013, NN-INV-003).
 *   catalog-reachability — every VALID, unique, quality-passing agent and every
 *                          registered skill is reachable EXACTLY once from the
 *                          orchestration selector / assignment path; an
 *                          unresolved catalog gap BLOCKS activation/release
 *                          (src/execution/agent-registry.ts,
 *                          src/skills/skill-catalog.ts, NN-AGENT-002/007,
 *                          NN-SKILL-006, NN-INV-014).
 *   restart-resilience   — a durable receipt (run / lock / usage) SURVIVES a
 *                          close/reopen of the store byte-for-byte (durable
 *                          receipts survive close/reopen) (D-08, NN-INV-003).
 *
 * The pure matrices ({@link runUnboundedTopologyMatrix},
 * {@link runAccountingMatrix}, {@link runCatalogReachabilityMatrix}) run on
 * pure inputs directly. The remaining matrices are folded from real
 * authority+SQLite outcomes the harness injects via {@link ExecutionGateInjected}
 * so the module stays a pure decision surface: it NEVER performs the risky
 * effect it evaluates (no host spawn, no real network, no credential read); it
 * only asks the real P5 authorities to make their DENY/HOLD decision on hostile
 * input and records whether they held.
 *
 * A single matrix cell that does NOT hold is a blocker; the verdict is `block`
 * on ANY blocker, and an empty matrix is a `block` (deny-by-default — a gate
 * that proved nothing may not admit anything). {@link runSelfTest} proves the
 * gate's detection is real by planting a failing cell and asserting the gate
 * BLOCKS while a secure set PASSES.
 *
 * No raw secret VALUES appear here — canaries are placeholder strings from the
 * shared observable-redaction corpus and are asserted ABSENT from any assembled
 * prompt (NN-INV-004).
 *
 * Design anchors: D-10, D-11, D-13, D-15, D-18, D-22, D-23, D-24.
 * Requirements: NN-INV-003/012/014/015, NN-EXEC-001–015, NN-AGENT-001–010,
 * NN-ORCH-001–013, NN-TASK-001–009, NN-SKILL-001–015.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import { validateDag, hasCycle } from './dag-validation';
import { validateTopology } from './orchestration-types';
import { computeCost, type ModelPrice, type TokenUsage } from '../provider/billing';
import type { PlanEdge } from './task-types';

// ════════════════════════════════════════════════════════════════════════════
// 1. Matrix vocabulary
// ════════════════════════════════════════════════════════════════════════════

/**
 * The nine adversarial execution domains the exit gate covers. These map
 * one-to-one to the prohibited P5 outcomes: "no bypass, secret in context,
 * false completion, duplicate identity/effect, unbounded topology, post-terminal
 * output, or accounting drift" plus catalog reachability and restart resilience.
 */
export const EXECUTION_DOMAINS = Object.freeze([
  'tool-bypass',
  'secret-in-context',
  'false-completion',
  'duplicate-identity',
  'unbounded-topology',
  'post-terminal-output',
  'accounting-drift',
  'catalog-reachability',
  'restart-resilience',
] as const);
export type ExecutionDomain = (typeof EXECUTION_DOMAINS)[number];

/**
 * The class of unauthorized outcome a matrix guards against. A cell that is NOT
 * held is a P5 admission blocker (NN-VERIFY-005).
 */
export const EXECUTION_VIOLATION_CLASSES = Object.freeze([
  'pipeline-bypass',
  'secret-leak',
  'false-completion',
  'duplicate-effect',
  'unbounded-topology',
  'post-terminal-effect',
  'accounting-drift',
  'unreachable-catalog',
  'lost-receipt',
] as const);
export type ExecutionViolationClass = (typeof EXECUTION_VIOLATION_CLASSES)[number];

/** The result of one adversarial case: did the authority DENY/HOLD as required? */
export interface ExecutionCaseResult {
  readonly domain: ExecutionDomain;
  /** Stable, secret-free id of the adversarial case. */
  readonly caseId: string;
  /** The prohibited outcome this case proves is impossible. */
  readonly violationClass: ExecutionViolationClass;
  /**
   * `true` when the authority correctly DENIED / failed-closed / held the
   * invariant on the hostile input. `false` is a critical execution violation.
   */
  readonly held: boolean;
  /** Safe, secret-free note describing the observed decision. */
  readonly detail: string;
}

/** A blocker finding: a matrix case that did not hold. Only `critical` blocks. */
export interface ExecutionGateBlocker {
  readonly domain: ExecutionDomain;
  readonly caseId: string;
  readonly violationClass: ExecutionViolationClass;
  readonly severity: 'critical';
  readonly reason: string;
}

/** The overall gate verdict. `block` denies P6/P7 admission for the scope. */
export type ExecutionGateVerdict = 'pass' | 'block';

/** The published EXECUTION exit-gate report. */
export interface ExecutionExitGateReport {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly verdict: ExecutionGateVerdict;
  /** Every matrix case that ran, in domain order. */
  readonly cases: readonly ExecutionCaseResult[];
  /** Every critical blocker (empty on a pass). */
  readonly blockers: readonly ExecutionGateBlocker[];
  readonly totals: {
    readonly cases: number;
    readonly held: number;
    readonly critical: number;
  };
  /** A typed FORBIDDEN error present only when the verdict is `block`. */
  readonly error?: ErrorEnvelope;
}

const GATE_OWNER = 'authority-execution-verification';

function gateError(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: GATE_OWNER,
    operation: 'execution-exit-gate',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'An execution matrix case did not hold. Abort admission, drain/cancel in-flight work, ' +
      'reconcile receipts/budgets, and block P6/P7 consumer-capability admission until the ' +
      'affected authority denies the hostile input.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Pure matrix — unbounded topology (DAG / batch / delegation bounds)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Topology matrix (D-13, NN-ORCH-001/002, NN-TASK-002/003): a cyclic graph on an
 * `acyclic` topology is INVALID; a `bounded-loop` topology permits a declared
 * loop but still requires edge containment; a race / bounded-batch fan-out
 * rejects inter-task edges; a bounded batch over the hard cap is rejected. Each
 * cell HELD iff the pure validator classified the hostile graph as rejected (or,
 * for the acyclic-happy-path cell, accepted). These are the DAG/topology guards
 * that make an unbounded topology impossible before any dispatch.
 */
export function runUnboundedTopologyMatrix(): ExecutionCaseResult[] {
  const cases: ExecutionCaseResult[] = [];
  const push = (
    caseId: string,
    held: boolean,
    heldNote: string,
    brokeNote: string,
  ): void => {
    cases.push({
      domain: 'unbounded-topology',
      caseId: `topology/${caseId}`,
      violationClass: 'unbounded-topology',
      held,
      detail: held ? heldNote : brokeNote,
    });
  };

  // A two-node cycle on an acyclic topology must be INVALID.
  const cyclic = validateDag(
    ['a', 'b'],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
    'acyclic',
  );
  push(
    'acyclic-cycle-rejected',
    cyclic.ok === false && cyclic.reason === 'cycle',
    'a directed cycle on an acyclic topology is rejected (no unbounded loop)',
    'ACCEPTED a directed cycle on an acyclic topology (unbounded loop)',
  );

  // hasCycle agrees with the validator (pure cross-check).
  push(
    'has-cycle-detects-back-edge',
    hasCycle(['x', 'y', 'z'], [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'z' },
      { from: 'z', to: 'x' },
    ]) === true,
    'hasCycle detects a back edge in a three-node cycle',
    'hasCycle MISSED a three-node cycle',
  );

  // A dangling edge (edge to an undeclared task) is rejected.
  const dangling = validateDag(['a'], [{ from: 'a', to: 'ghost' }], 'acyclic');
  push(
    'dangling-edge-rejected',
    dangling.ok === false && dangling.reason === 'dangling-edge',
    'an edge to an undeclared task is rejected (graph not self-contained)',
    'ACCEPTED an edge to an undeclared task',
  );

  // An acyclic pipeline is accepted (the guard is not vacuous — it lets valid
  // graphs through).
  const acyclic = validateDag(['a', 'b'], [{ from: 'a', to: 'b' }], 'acyclic');
  push(
    'acyclic-pipeline-accepted',
    acyclic.ok === true,
    'a valid acyclic pipeline is accepted (guard is not vacuous)',
    'REJECTED a valid acyclic pipeline (guard is vacuous / over-broad)',
  );

  // A bounded loop is explicitly permitted (the caller declared it) yet still
  // requires edge containment; a self-contained loop is accepted.
  const loop = validateDag(
    ['a', 'b'],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
    'bounded-loop',
  );
  push(
    'bounded-loop-permitted',
    loop.ok === true,
    'an explicitly declared bounded loop is permitted (bounded, not unbounded)',
    'REJECTED an explicitly declared bounded loop',
  );

  // race / bounded-batch fan-out reject inter-task edges.
  push(
    'race-rejects-inter-task-edge',
    validateTopology('race', ['a', 'b'], [{ from: 'a', to: 'b' }]).ok === false,
    'a race fan-out rejects an inter-task dependency edge',
    'ACCEPTED an inter-task edge in a race fan-out',
  );

  // A bounded batch over the hard cap is rejected.
  const overCap = Array.from({ length: 51 }, (_, i) => `t${i}`);
  push(
    'bounded-batch-over-cap-rejected',
    validateTopology('bounded-batch', overCap, [], { maxBatch: 50 }).ok === false,
    'a bounded batch over the hard cap is rejected (bounded parallelism)',
    'ACCEPTED a bounded batch over the hard cap (unbounded parallelism)',
  );

  // A bounded batch at/under the cap is accepted.
  push(
    'bounded-batch-within-cap-accepted',
    validateTopology('bounded-batch', ['t0', 't1'], [], { maxBatch: 50 }).ok === true,
    'a bounded batch within the cap is accepted',
    'REJECTED a bounded batch within the cap',
  );

  return cases;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Pure matrix — accounting drift (exact / non-negative / deterministic cost)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Accounting matrix (D-18, NN-ORCH-013, NN-INV-003): the pure cost computation
 * must be exact, non-negative, and deterministic (a given price+usage always
 * yields the same charged amount), and a zero-usage cost must be zero. Reconcile
 * (usage records equal committed credits) is a stateful outcome the harness
 * injects; here we assert the pure arithmetic that reconciliation depends on
 * cannot itself drift. A cell that fails is an accounting-drift blocker.
 */
export function runAccountingMatrix(): ExecutionCaseResult[] {
  const cases: ExecutionCaseResult[] = [];
  const price: ModelPrice = {
    pricingVersion: 'pv-gate-1',
    modelId: 'mdl-gate',
    promptMicroUsdPerToken: 3n,
    completionMicroUsdPerToken: 6n,
    markupPpm: 200_000, // +20%
    planMultiplierPpm: 1_000_000, // 1.0x
  };

  const usage: TokenUsage = {
    promptTokens: 1000,
    completionTokens: 500,
    usageSource: 'reported',
  };

  const a = computeCost(price, usage);
  const b = computeCost(price, usage);

  // Deterministic: identical inputs → identical charged/provider amounts.
  const deterministic =
    a.chargedAmount.minorUnits === b.chargedAmount.minorUnits &&
    a.providerCost.minorUnits === b.providerCost.minorUnits;
  cases.push({
    domain: 'accounting-drift',
    caseId: 'accounting/deterministic-cost',
    violationClass: 'accounting-drift',
    held: deterministic,
    detail: deterministic
      ? 'identical price+usage yields identical cost (no drift)'
      : 'identical price+usage yielded DIFFERENT costs (non-deterministic drift)',
  });

  // Non-negative: charged and provider cost are never negative.
  const nonNegative =
    a.chargedAmount.minorUnits >= 0n && a.providerCost.minorUnits >= 0n;
  cases.push({
    domain: 'accounting-drift',
    caseId: 'accounting/non-negative-cost',
    violationClass: 'accounting-drift',
    held: nonNegative,
    detail: nonNegative
      ? 'computed cost is non-negative'
      : 'computed cost went NEGATIVE',
  });

  // Markup applied exactly: charged >= provider cost (markup is non-negative).
  const markupApplied = a.chargedAmount.minorUnits >= a.providerCost.minorUnits;
  cases.push({
    domain: 'accounting-drift',
    caseId: 'accounting/markup-not-below-provider-cost',
    violationClass: 'accounting-drift',
    held: markupApplied,
    detail: markupApplied
      ? 'charged amount is at least the provider cost (markup applied exactly)'
      : 'charged amount fell BELOW the provider cost (accounting drift)',
  });

  // Zero usage → zero cost (no phantom charge).
  const zero = computeCost(price, {
    promptTokens: 0,
    completionTokens: 0,
    usageSource: 'reported',
  });
  const zeroCost =
    zero.chargedAmount.minorUnits === 0n && zero.providerCost.minorUnits === 0n;
  cases.push({
    domain: 'accounting-drift',
    caseId: 'accounting/zero-usage-zero-cost',
    violationClass: 'accounting-drift',
    held: zeroCost,
    detail: zeroCost
      ? 'zero usage produces zero cost (no phantom charge)'
      : 'zero usage produced a NON-ZERO charge (phantom charge)',
  });

  // Negative token counts are clamped to zero, never a negative charge.
  const negative = computeCost(price, {
    promptTokens: -1000,
    completionTokens: -1,
    usageSource: 'reported',
  });
  const clamped =
    negative.chargedAmount.minorUnits === 0n && negative.providerCost.minorUnits === 0n;
  cases.push({
    domain: 'accounting-drift',
    caseId: 'accounting/negative-tokens-clamped',
    violationClass: 'accounting-drift',
    held: clamped,
    detail: clamped
      ? 'negative token counts clamp to a zero (non-negative) charge'
      : 'negative token counts produced a non-zero/negative charge',
  });

  return cases;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Pure matrix — catalog reachability (set equality, exactly-once)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A catalog reachability observation the harness computes from the REAL registry
 * / skill catalog over SQLite: the set of reachable (activated / registered)
 * identities, the set of VALID identities that SHOULD be reachable, the count of
 * duplicate appearances in the grouped/selector view (must be zero — every valid
 * identity appears EXACTLY once), and whether an unresolved catalog gap
 * (quarantine / orphan / unreachable source) is present (must block).
 */
export interface CatalogReachabilityObservation {
  /** A safe id for the observation (e.g. `agents`, `skills`). */
  readonly kind: string;
  /** The identities actually reachable from the selector / assignment path. */
  readonly reachableIds: readonly string[];
  /** The identities that are valid and SHOULD be reachable exactly once. */
  readonly validIds: readonly string[];
  /**
   * Count of identities appearing MORE THAN ONCE across grouped views. Must be
   * zero (exactly-once membership — no duplicate identity).
   */
  readonly duplicateAppearances: number;
  /** Whether the catalog audit reports an unresolved gap (must block). */
  readonly auditBlocked: boolean;
  /**
   * Whether an INVALID identity (quarantined / not quality-passing) was found
   * reachable. Must be false (no invalid identity is reachable).
   */
  readonly invalidReachable: boolean;
}

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sb) if (!sa.has(id)) return false;
  return true;
}

/**
 * Catalog reachability matrix (NN-AGENT-002/007, NN-SKILL-006, NN-INV-014). For
 * each observation the harness derived from the real catalog, a cell HELD iff:
 * the reachable set EXACTLY equals the valid set (every valid identity reachable
 * exactly once, no invalid identity reachable), there are zero duplicate
 * appearances, and — for the "clean" observation — the audit is not blocked. A
 * separate "gap blocks" observation asserts that an unresolved gap correctly
 * reports blocked (the audit is not vacuous).
 */
export function runCatalogReachabilityMatrix(
  observations: readonly CatalogReachabilityObservation[],
): ExecutionCaseResult[] {
  return observations.map((obs) => {
    const equal = setEquals(obs.reachableIds, obs.validIds);
    const held =
      equal &&
      obs.duplicateAppearances === 0 &&
      obs.invalidReachable === false &&
      obs.auditBlocked === false;
    let detail: string;
    if (held) {
      detail = `${obs.kind}: reachable set equals the valid set exactly-once (${obs.validIds.length} identities), audit clean`;
    } else if (!equal) {
      detail = `${obs.kind}: reachable set DIFFERS from the valid set (unreachable or extra identity)`;
    } else if (obs.duplicateAppearances > 0) {
      detail = `${obs.kind}: ${obs.duplicateAppearances} identity appeared more than once (duplicate identity)`;
    } else if (obs.invalidReachable) {
      detail = `${obs.kind}: an INVALID identity was reachable`;
    } else {
      detail = `${obs.kind}: catalog audit reports an unresolved gap`;
    }
    return {
      domain: 'catalog-reachability' as const,
      caseId: `catalog/${obs.kind}`,
      violationClass: 'unreachable-catalog' as const,
      held,
      detail,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Injected (stateful-authority) outcomes
// ════════════════════════════════════════════════════════════════════════════

/**
 * The stateful authorities (tool pipeline, prompt assembly over exclusion,
 * orchestration/council over SQLite, run locks, streaming, budget reconcile,
 * restart) are driven by the harness against REAL temporary SQLite; the harness
 * injects the OUTCOME of each real adversarial call so the gate stays a pure
 * decision surface. Every field states the invariant the real authority MUST
 * have held.
 */
export interface ExecutionGateInjected {
  /**
   * A tool call that FAILS/DENIES in the pipeline (policy deny, missing
   * credential, or executor failure) left NO committed success and NO side
   * effect — there is no bypass path around the pipeline. MUST be true.
   */
  readonly deniedToolLeftNoEffect: boolean;
  /**
   * A tool call NEVER executed outside the single pipeline: every advertised
   * tool surface (built-in/skill/plugin/mcp/terminal/lsp/browser/generated)
   * resolves to the one pipeline entry, and an unimplemented capability returns
   * a typed unavailable (never a success path). MUST be true.
   */
  readonly noToolExecutedOutsidePipeline: boolean;
  /**
   * A raw secret canary placed in a prompt input did NOT survive assembly into
   * the model context (scrubbed / refused). MUST be true.
   */
  readonly secretCanaryAbsentFromContext: boolean;
  /**
   * A `secret`-classed prompt item was REFUSED entry to the context. MUST be
   * true.
   */
  readonly secretClassedItemRefused: boolean;
  /**
   * A run/task reported completion ONLY after evidence was durably committed and
   * matched; an unavailable reviewer / missing evidence BLOCKED completion (no
   * false completion). MUST be true.
   */
  readonly completionRequiresEvidence: boolean;
  /**
   * A completion attempt with a MISSING/unavailable reviewer did NOT auto-pass.
   * MUST be true.
   */
  readonly missingReviewerBlockedCompletion: boolean;
  /**
   * A DUPLICATE drive of an idempotent authority command (re-acquire the same
   * lock / re-run the same start with the same idempotency key) produced NO
   * second identity and NO second effect. MUST be true.
   */
  readonly duplicateDriveNoSecondEffect: boolean;
  /**
   * A contended lock held by a DIFFERENT run was DENIED (CONFLICT) without
   * discarding the holder's lock/work. MUST be true.
   */
  readonly contendedLockDenied: boolean;
  /**
   * After a stream reached terminal or was cancelled, a further chunk/emission
   * was REJECTED (no post-terminal output). MUST be true.
   */
  readonly postTerminalOutputRejected: boolean;
  /**
   * A new descendant registered AFTER cancellation was REJECTED (no orphan).
   * MUST be true.
   */
  readonly postCancelDescendantRejected: boolean;
  /**
   * Durable usage records RECONCILE exactly to the budget's committed credits
   * (no accounting drift). MUST be true.
   */
  readonly usageReconcilesToCredits: boolean;
  /**
   * A durable receipt (run / lock / usage) SURVIVED a close/reopen of the store
   * byte-for-byte (restart resilience). MUST be true.
   */
  readonly receiptSurvivesRestart: boolean;
}

/** Build the injected matrix cases from the real authority outcomes. */
export function runInjectedMatrices(
  injected: ExecutionGateInjected,
): ExecutionCaseResult[] {
  const cell = (
    domain: ExecutionDomain,
    caseId: string,
    violationClass: ExecutionViolationClass,
    held: boolean,
    heldNote: string,
    brokeNote: string,
  ): ExecutionCaseResult => ({
    domain,
    caseId,
    violationClass,
    held,
    detail: held ? heldNote : brokeNote,
  });

  return [
    cell(
      'tool-bypass',
      'tool-bypass/denied-tool-no-effect',
      'pipeline-bypass',
      injected.deniedToolLeftNoEffect,
      'a denied/failed tool call left no committed success and no side effect',
      'a denied/failed tool call left a committed success or a side effect (bypass)',
    ),
    cell(
      'tool-bypass',
      'tool-bypass/no-execution-outside-pipeline',
      'pipeline-bypass',
      injected.noToolExecutedOutsidePipeline,
      'every tool surface routes through the one governed pipeline; unavailable is typed',
      'a tool executed OUTSIDE the governed pipeline (choke-point bypass)',
    ),
    cell(
      'secret-in-context',
      'secret-in-context/canary-absent',
      'secret-leak',
      injected.secretCanaryAbsentFromContext,
      'a raw secret canary did not survive assembly into the model context',
      'a raw secret canary SURVIVED into the assembled model context',
    ),
    cell(
      'secret-in-context',
      'secret-in-context/secret-classed-refused',
      'secret-leak',
      injected.secretClassedItemRefused,
      'a secret-classed prompt item was refused entry to the context',
      'a secret-classed prompt item ENTERED the context',
    ),
    cell(
      'false-completion',
      'false-completion/evidence-gated',
      'false-completion',
      injected.completionRequiresEvidence,
      'completion reported only after durably committed matching evidence',
      'completion reported WITHOUT durably committed matching evidence',
    ),
    cell(
      'false-completion',
      'false-completion/missing-reviewer-blocks',
      'false-completion',
      injected.missingReviewerBlockedCompletion,
      'a missing/unavailable reviewer blocked completion (no auto-pass)',
      'a missing/unavailable reviewer AUTO-PASSED completion',
    ),
    cell(
      'duplicate-identity',
      'duplicate-identity/idempotent-no-second-effect',
      'duplicate-effect',
      injected.duplicateDriveNoSecondEffect,
      'a duplicated drive produced no second identity and no second effect',
      'a duplicated drive produced a SECOND identity or a SECOND effect',
    ),
    cell(
      'duplicate-identity',
      'duplicate-identity/contended-lock-denied',
      'duplicate-effect',
      injected.contendedLockDenied,
      'a contended lock held by another run was denied without discarding work',
      'a contended lock was GRANTED to a second run (duplicate exclusive effect)',
    ),
    cell(
      'post-terminal-output',
      'post-terminal-output/stream-rejects-after-terminal',
      'post-terminal-effect',
      injected.postTerminalOutputRejected,
      'a post-terminal / post-cancel stream chunk was rejected',
      'a post-terminal / post-cancel stream chunk was ADMITTED (post-terminal output)',
    ),
    cell(
      'post-terminal-output',
      'post-terminal-output/post-cancel-descendant-rejected',
      'post-terminal-effect',
      injected.postCancelDescendantRejected,
      'a descendant registered after cancellation was rejected (no orphan)',
      'a descendant registered after cancellation was ADMITTED (orphan operation)',
    ),
    cell(
      'accounting-drift',
      'accounting-drift/usage-reconciles',
      'accounting-drift',
      injected.usageReconcilesToCredits,
      'durable usage records reconcile exactly to the committed credits',
      'durable usage records did NOT reconcile to the committed credits (drift)',
    ),
    cell(
      'restart-resilience',
      'restart-resilience/receipt-survives-reopen',
      'lost-receipt',
      injected.receiptSurvivesRestart,
      'a durable receipt survived a store close/reopen byte-for-byte',
      'a durable receipt did NOT survive a store close/reopen (lost receipt)',
    ),
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Gate evaluation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a full set of matrix cases into a verdict. ANY case that did not hold
 * is a `critical` blocker and forces `block` (NN-INV-015, NN-VERIFY-005). A gate
 * with zero cases is a `block` (deny-by-default: an empty matrix proves nothing,
 * so it may not admit P6/P7 consumer capability).
 */
export function evaluateGate(
  cases: readonly ExecutionCaseResult[],
  correlationId?: string,
): ExecutionExitGateReport {
  const blockers: ExecutionGateBlocker[] = [];
  let held = 0;
  for (const c of cases) {
    if (c.held) {
      held += 1;
    } else {
      blockers.push({
        domain: c.domain,
        caseId: c.caseId,
        violationClass: c.violationClass,
        severity: 'critical',
        reason: c.detail,
      });
    }
  }

  const emptyMatrix = cases.length === 0;
  const verdict: ExecutionGateVerdict =
    blockers.length === 0 && !emptyMatrix ? 'pass' : 'block';

  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    verdict,
    cases,
    blockers,
    totals: { cases: cases.length, held, critical: blockers.length },
    ...(verdict === 'block'
      ? {
          error: gateError(
            'FORBIDDEN',
            emptyMatrix
              ? 'execution exit gate ran no cases; deny-by-default (nothing proven)'
              : `execution exit gate BLOCKED: ${blockers.length} critical execution case(s) did not hold`,
            correlationId,
          ),
        }
      : {}),
  };
}

/** The full set of inputs the gate composes into one verdict. */
export interface ExecutionGateInput {
  /** Real authority outcomes the harness injected (stateful matrices). */
  readonly injected: ExecutionGateInjected;
  /** Catalog reachability observations the harness derived from the catalog. */
  readonly catalog: readonly CatalogReachabilityObservation[];
  readonly correlationId?: string;
}

/**
 * Run every pure matrix plus the injected (stateful-authority) matrices and
 * evaluate the gate. The pure DAG/accounting matrices need no input; the
 * catalog matrix and the injected matrices are supplied by the harness from real
 * authority calls over temp SQLite.
 */
export function runExecutionExitGate(
  input: ExecutionGateInput,
): ExecutionExitGateReport {
  const cases: ExecutionCaseResult[] = [
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'tool-bypass'),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'secret-in-context'),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'false-completion'),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'duplicate-identity'),
    ...runUnboundedTopologyMatrix(),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'post-terminal-output'),
    ...runAccountingMatrix(),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'accounting-drift'),
    ...runCatalogReachabilityMatrix(input.catalog),
    ...runInjectedMatrices(input.injected).filter((c) => c.domain === 'restart-resilience'),
  ];
  return evaluateGate(cases, input.correlationId);
}

/**
 * A fully-secure injected set (every invariant held). The harness overrides
 * individual fields from real authority calls; the self-test uses this baseline.
 */
export function secureInjectedBaseline(): ExecutionGateInjected {
  return {
    deniedToolLeftNoEffect: true,
    noToolExecutedOutsidePipeline: true,
    secretCanaryAbsentFromContext: true,
    secretClassedItemRefused: true,
    completionRequiresEvidence: true,
    missingReviewerBlockedCompletion: true,
    duplicateDriveNoSecondEffect: true,
    contendedLockDenied: true,
    postTerminalOutputRejected: true,
    postCancelDescendantRejected: true,
    usageReconcilesToCredits: true,
    receiptSurvivesRestart: true,
  };
}

/** A fully-clean catalog observation (exactly-once, audit clean). */
export function secureCatalogBaseline(): CatalogReachabilityObservation[] {
  return [
    {
      kind: 'agents',
      reachableIds: ['agt-a', 'agt-b'],
      validIds: ['agt-a', 'agt-b'],
      duplicateAppearances: 0,
      auditBlocked: false,
      invalidReachable: false,
    },
    {
      kind: 'skills',
      reachableIds: ['skl-a'],
      validIds: ['skl-a'],
      duplicateAppearances: 0,
      auditBlocked: false,
      invalidReachable: false,
    },
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Gate self-test (V-EXEC-001/execution-exit-gate blocker self-test)
// ════════════════════════════════════════════════════════════════════════════

/** The result of the gate self-test. */
export interface SelfTestResult {
  /**
   * `true` when the gate correctly BLOCKED the planted-failure scenario AND
   * PASSED the all-secure scenario. A self-test that does not distinguish the
   * two means the gate cannot detect a real failure and is itself a blocker.
   */
  readonly detectsPlantedFailure: boolean;
  readonly plantedVerdict: ExecutionGateVerdict;
  readonly secureVerdict: ExecutionGateVerdict;
  /** The domain of the blocker the gate reported for the planted failure. */
  readonly plantedBlockerDomain?: ExecutionDomain;
  readonly detail: string;
}

/**
 * Prove the gate's detection is real (NN-VERIFY-005, D-22). We do NOT weaken any
 * real authority. Instead we run the full gate twice:
 *
 *   1. a "planted failure" run where exactly one injected invariant is flipped
 *      to `false` (simulating a broken authority that allowed a prohibited
 *      outcome) — the gate MUST BLOCK and name the planted domain;
 *   2. an all-secure run where every injected invariant held and the catalog is
 *      clean — the gate MUST PASS.
 *
 * If the gate blocks on the planted failure and passes on the secure run, its
 * detection is demonstrably non-vacuous. A gate that passed the planted failure
 * would be worthless and this self-test reports `detectsPlantedFailure:false`.
 */
export function runSelfTest(): SelfTestResult {
  const secure = runExecutionExitGate({
    injected: secureInjectedBaseline(),
    catalog: secureCatalogBaseline(),
    correlationId: 'corr-selftest',
  });

  // Plant a single false-completion failure: a run that completed without
  // committed evidence.
  const planted = runExecutionExitGate({
    injected: { ...secureInjectedBaseline(), completionRequiresEvidence: false },
    catalog: secureCatalogBaseline(),
    correlationId: 'corr-selftest',
  });

  const plantedBlocker = planted.blockers.find(
    (b) => b.caseId === 'false-completion/evidence-gated',
  );
  const detects =
    planted.verdict === 'block' &&
    secure.verdict === 'pass' &&
    plantedBlocker !== undefined;

  return {
    detectsPlantedFailure: detects,
    plantedVerdict: planted.verdict,
    secureVerdict: secure.verdict,
    ...(plantedBlocker ? { plantedBlockerDomain: plantedBlocker.domain } : {}),
    detail: detects
      ? 'gate blocked the planted false-completion and passed the secure run; detection is non-vacuous'
      : 'gate FAILED to distinguish a planted failure from a secure run',
  };
}
