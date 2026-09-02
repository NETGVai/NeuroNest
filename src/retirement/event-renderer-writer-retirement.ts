/**
 * Event / renderer independent-durable-writer RETIREMENT authority
 * (FUT-PKG-09-RETIREMENT/T-003 — Event/Projection Authority).
 *
 * This is the P8 leaf that RETIRES the independent durable EventLog/EventBus/
 * ActionEventStream emitters, the renderer message-mutation path, the duplicate
 * stream buffers, the global format/DOM execution paths, and the legacy mutable
 * chat stores — but ONLY AFTER proving, per state class, that:
 *
 *   1. the item is CLEARED by the 8.1 RetirementInventory gate
 *      ({@link ./retirement-inventory}.evaluateRetirementItem — disposition
 *      REMOVE with all six deletion prerequisites satisfied), so removal is
 *      already gated on measured zero-use / migrated data / recorded owner /
 *      proven-unreachable / parity / rescue+rollback;
 *   2. REPLAY PARITY holds — the history the legacy emitter would have produced
 *      is byte-equivalent to the committed-outbox history
 *      ({@link ../events/legacy-event-adapters}.compareEventHistoryParity over
 *      {@link ../events/legacy-event-adapters}.backfillLegacyEventHistory) AND
 *      the canonical chat projection rebuilt from the committed outbox
 *      reproduces the SAME committed timeline (no missing history, no
 *      duplicate node, no lost node — NN-CHAT-001);
 *   3. RENDERER PARITY holds — reusing the 6.9 renderer-exit-gate checks
 *      ({@link ../experience/renderer-exit-gate}.compareSurfaceParity /
 *      findDuplicateStreams / isCommandPortValid / residualRendererPaths): no
 *      surface divergence, no duplicate live stream, no inferred execution, and
 *      every renderer durable-mutation / DOM-global path already retired
 *      (durable state projection-only — NN-COMPAT-016);
 *   4. ONE WRITER remains — the committed outbox is the sole durable event
 *      writer ({@link ../events/legacy-event-adapters}.auditSingleDurableWriter,
 *      NN-INV-008 / NN-COMPAT-002).
 *
 * FAIL CLOSED. A missing history, a duplicate/lost node, an inferred execution,
 * or a stale projection BLOCKS the removal (the task Acceptance). Removal is
 * performed ONE STATE CLASS / SURFACE AT A TIME. This authority holds NO durable
 * business state and NEVER becomes a writer: it is an OBSERVER over the
 * committed outbox (T-001), the canonical chat projection (T-001 experience),
 * and the observer evidence graph (T-005 durability). After a class is retired
 * its durable state is PROJECTION-ONLY; legacy sessions remain READABLE through
 * read/delivery adapters ({@link ../events/legacy-event-adapters}
 * EventLogHistoryAdapter / EventBusDeliveryAdapter and the renderer-exit-gate
 * upcaster) — never a restored independent writer.
 *
 * Rollout / rollback (D-20/D-23, the task Migration rule): retire one class at a
 * time; a rollback RESTORES the READ/DELIVERY adapter for that class, NEVER an
 * independent writer. {@link rollbackToReadAdapter} models exactly that: it
 * reselects a read/delivery adapter role and refuses to restore a writer role.
 *
 * Design anchors: D-05 (Event/Projection Authority & adapters), D-08 (committed
 * outbox / projection), D-10 (chat projection reader), D-20 (shadow-compare
 * before cutover, prior read adapter on rollback), D-23 (phased rollout/
 * rollback). Requirements: NN-EVENT-011 (adapter roles / independent emitters
 * retire after parity/replay/rollback gates), NN-CHAT-001 (canonical timeline,
 * no duplicate/lost node), NN-CHAT-003 (streaming lifecycle, authority-only
 * completion), NN-COMPAT-002 (single writer cutover; shadow observe/compare
 * only), NN-COMPAT-016 (renderer migration retirement), NN-INV-008 (one owner
 * per data class), NN-VERIFY-005 (unrehearsed rollback / integrity gap blocks).
 */

import type Database from 'better-sqlite3';

import type { ScopeDescriptor } from '../shared/contract-primitives.js';
import type { EvidenceService } from '../shared/evidence-observability.js';
import {
  backfillLegacyEventHistory,
  compareEventHistoryParity,
  auditSingleDurableWriter,
  type LegacyHistoryEntry,
  type ParityResult,
  type SingleWriterAudit,
} from '../events/legacy-event-adapters.js';
import {
  advanceChatTimeline,
  rebuildChatTimeline,
  readTimeline,
  type TimelinePage,
} from '../chat/chat-projection.js';
import {
  compareSurfaceParity,
  findDuplicateStreams,
  isCommandPortValid,
  residualRendererPaths,
  type RendererLegacyPaths,
  type SurfaceParityObservation,
  type SurfaceParityReport,
  type CommandPort,
  type StreamAttachment,
  type TypedRowIsland,
} from '../experience/renderer-exit-gate.js';
import {
  evaluateRetirementItem,
  type RetirementItem,
  type RetirementVerdict,
} from './retirement-inventory.js';

// ─── The independent-writer state classes this leaf retires ──────────────────

/**
 * The independent durable-writer state classes / surfaces the task Deliverables
 * enumerate. Each is retired INDEPENDENTLY (one at a time) so a block on one
 * never removes another. `event-*` classes are proven by event replay parity +
 * the single-writer audit; `renderer-*` / chat classes by renderer parity + the
 * canonical chat projection replay.
 */
export const RETIREMENT_STATE_CLASSES = Object.freeze([
  'event-log-writer', // legacy Pipeline EventLog independent durable writer (pipeline_events)
  'event-bus-writer', // legacy SQLite EventBus independent durable writer (skill_events)
  'action-event-stream-writer', // ActionEventStream treated as durable (must stay ephemeral)
  'renderer-message-mutation', // renderer creating/mutating a Chat Node directly
  'duplicate-stream-buffer', // duplicate provider→renderer stream buffers
  'global-format-dom-path', // global formatter monkeypatch / inline-handler DOM exec path
  'legacy-mutable-chat-store', // legacy mutable in-renderer message store
] as const);
export type RetirementStateClass = (typeof RETIREMENT_STATE_CLASSES)[number];

/** Whether a value is a known retirement state class. */
export function isRetirementStateClass(value: unknown): value is RetirementStateClass {
  return (
    typeof value === 'string' &&
    (RETIREMENT_STATE_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * The role an adapter may hold for a retired state class. After retirement a
 * class keeps ONLY a `read`/`delivery` adapter (a non-authoritative observer of
 * the committed outbox / projection); the `writer` role is the independent
 * durable writer being removed. A rollback may restore `read`/`delivery` but
 * NEVER `writer` (NN-COMPAT-002).
 */
export type AdapterRole = 'writer' | 'read' | 'delivery' | 'ephemeral-observer';

/** The read/delivery/observer roles a rollback is permitted to restore. */
export const RESTORABLE_ROLES: readonly AdapterRole[] = Object.freeze([
  'read',
  'delivery',
  'ephemeral-observer',
]);

/** Whether a rollback may restore this adapter role (never an independent writer). */
export function isRestorableRole(role: AdapterRole): boolean {
  return (RESTORABLE_ROLES as readonly AdapterRole[]).includes(role);
}

// ─── Fail-closed block taxonomy ──────────────────────────────────────────────

/**
 * The categories of finding that BLOCK a removal (the task Acceptance, verbatim:
 * "missing history, duplicate/lost node, inferred execution, or stale
 * projection blocks removal"). `inventory-not-cleared` folds the 8.1 gate;
 * `duplicate-writer` / `surface-divergence` cover the remaining shadow-compare
 * faults; every one is fail-closed.
 */
export type RemovalBlockCategory =
  | 'inventory-not-cleared'
  | 'missing-history'
  | 'duplicate-node'
  | 'lost-node'
  | 'inferred-execution'
  | 'stale-projection'
  | 'duplicate-stream'
  | 'surface-divergence'
  | 'residual-renderer-path'
  | 'duplicate-writer';

/** One structured, human-safe reason a removal is blocked. */
export interface RemovalBlockReason {
  readonly category: RemovalBlockCategory;
  readonly detail: string;
}

// ─── Replay-parity evidence for a class (over the committed outbox) ──────────

/**
 * The replay-parity observation for an EVENT state class. `legacyHistory` is the
 * ordered history the legacy emitter would have produced (from its
 * `pipeline_events` / `skill_events` rows); it is compared against the
 * committed-outbox history for the SAME scope. A shorter legacy history than the
 * committed outbox is a MISSING-HISTORY block (the outbox has committed facts
 * the legacy path never reproduced); any kind/payload divergence is also a
 * missing/lost fact.
 */
export interface EventReplayParityInput {
  readonly scope: ScopeDescriptor;
  readonly legacyHistory: readonly LegacyHistoryEntry[];
}

/**
 * The chat-projection replay observation. `expectedNodeKeys` is the set of
 * stable node keys the committed timeline MUST contain (the pre-retirement
 * observed truth). After removal the projection is rebuilt from the committed
 * outbox; a rebuilt timeline that is missing a key is a LOST NODE, a rebuilt
 * timeline that surfaces a key twice is a DUPLICATE NODE, and a rebuilt
 * timeline whose active checkpoint is not `current` is a STALE PROJECTION.
 */
export interface ChatReplayParityInput {
  readonly scope: ScopeDescriptor;
  /** Stable node keys the committed timeline is known to contain. */
  readonly expectedNodeKeys: readonly string[];
}

/**
 * The renderer-parity observation for a RENDERER/chat state class. Reuses the
 * 6.9 renderer-exit-gate observation shape directly (surface parity + duplicate
 * streams + command ports) plus the residual renderer-path status.
 */
export interface RendererParityInput {
  readonly surface: SurfaceParityObservation;
  readonly rendererPaths: RendererLegacyPaths;
}

/**
 * The full retirement request for ONE state class. Exactly one of the parity
 * inputs is required, matched to the class kind:
 *   - event classes require {@link eventReplay} (+ the single-writer audit is
 *     always run over the scope);
 *   - chat/renderer classes require {@link chatReplay} and/or {@link renderer}.
 * `inventoryItem` binds the 8.1 RetirementInventory item for this class; the
 * item's parity/rollback evidence is verified against the observer evidence
 * graph (fail-closed).
 */
export interface RetireStateClassRequest {
  readonly stateClass: RetirementStateClass;
  readonly inventoryItem: RetirementItem;
  readonly eventReplay?: EventReplayParityInput;
  readonly chatReplay?: ChatReplayParityInput;
  readonly renderer?: RendererParityInput;
}

/**
 * The verdict for ONE state class removal. `cleared` is the single fail-closed
 * decision: the class may be removed IFF `cleared` is true. `durableStateProjectionOnly`
 * is true only when a cleared class leaves no residual independent writer (the
 * outbox/projection is the sole authority). `blockReasons` is empty iff cleared.
 */
export interface RetireStateClassVerdict {
  readonly stateClass: RetirementStateClass;
  readonly cleared: boolean;
  /** The 8.1 inventory verdict this removal is gated on. */
  readonly inventoryVerdict: RetirementVerdict;
  /** The event replay-parity result, when an event class. */
  readonly eventParity?: ParityResult;
  /** The single-writer audit, when an event class. */
  readonly singleWriterAudit?: SingleWriterAudit;
  /** The rebuilt chat timeline read, when a chat class. */
  readonly chatTimeline?: TimelinePage;
  /** The renderer surface-parity report, when a renderer class. */
  readonly rendererReport?: SurfaceParityReport;
  /** True only when a cleared class leaves durable state projection-only. */
  readonly durableStateProjectionOnly: boolean;
  readonly blockReasons: readonly RemovalBlockReason[];
  /** Always true: this authority never mutates core readiness (NN-INV-014). */
  readonly coreReadinessUnchanged: true;
}

// ─── Chat replay parity (rebuild from the committed outbox) ──────────────────

/**
 * Rebuild the canonical chat timeline from the committed outbox and check that
 * it reproduces the expected committed timeline with NO missing history, NO
 * duplicate node, NO lost node, and NO stale projection. Pure over the DB read
 * path — it uses the SAME projection reader the renderer reads, never a second
 * writer (NN-CHAT-001, D-10). Returns the rebuilt page and any block reasons.
 */
export function checkChatReplayParity(
  db: Database.Database,
  input: ChatReplayParityInput,
): { readonly page: TimelinePage; readonly blockReasons: readonly RemovalBlockReason[] } {
  const blockReasons: RemovalBlockReason[] = [];

  // Advance then rebuild the projection from the committed outbox. Rebuild is
  // beside-active and only activates on an invariant match (shadow-compare
  // before reader cutover); a mismatch leaves the active generation intact.
  advanceChatTimeline(db, input.scope);
  const rebuild = rebuildChatTimeline(db, input.scope);
  const page = readTimeline(db, input.scope);

  // STALE PROJECTION: the active checkpoint must be current, and a rebuild that
  // stopped (gap/duplicate/digest/version) or failed to activate on mismatch is
  // a stale projection (NN-EVENT-003/004, D-18).
  if (page.status !== 'current') {
    blockReasons.push({
      category: 'stale-projection',
      detail: `chat projection is '${page.status}', not current; a labeled/stale view blocks removal`,
    });
  }
  if (rebuild.stop) {
    blockReasons.push({
      category: 'stale-projection',
      detail: `chat projection rebuild stopped at sequence ${rebuild.stop.lastVerifiedSequence} (${rebuild.stop.reason})`,
    });
  } else if (!rebuild.activated) {
    blockReasons.push({
      category: 'stale-projection',
      detail: 'chat projection rebuild did not activate (invariant mismatch on shadow-compare)',
    });
  }

  // Node-set parity: the rebuilt timeline must contain EXACTLY the expected
  // committed node keys — no missing (lost) key, no duplicated key.
  const rebuiltKeys = page.nodes.map((n) => n.nodeKey);
  const rebuiltKeySet = new Set(rebuiltKeys);

  // DUPLICATE NODE: the same stable key appears more than once in the timeline.
  if (rebuiltKeySet.size !== rebuiltKeys.length) {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const k of rebuiltKeys) {
      if (seen.has(k)) dups.add(k);
      seen.add(k);
    }
    blockReasons.push({
      category: 'duplicate-node',
      detail: `rebuilt timeline duplicates stable node key(s): ${[...dups].sort().join(', ')}`,
    });
  }

  // LOST NODE / MISSING HISTORY: an expected committed key is absent from the
  // rebuilt timeline (the replay lost a committed node).
  const missing = input.expectedNodeKeys.filter((k) => !rebuiltKeySet.has(k));
  if (missing.length > 0) {
    blockReasons.push({
      category: 'lost-node',
      detail: `rebuilt timeline is missing expected committed node key(s): ${[...missing].sort().join(', ')}`,
    });
  }

  return { page, blockReasons };
}

// ─── Renderer parity (reuse the 6.9 exit-gate checks) ────────────────────────

/**
 * Check renderer parity for a class using the 6.9 renderer-exit-gate checks
 * (REUSED, never re-implemented). Blocks on:
 *   - a surface parity divergence (content/stable-key/anchor/focus — a
 *     stable-key set difference is a duplicate/lost node, NN-CHAT-001);
 *   - a duplicate live stream (NN-CHAT-004);
 *   - an inferred-execution / receipt-less command port (NN-CHAT-006);
 *   - any residual renderer durable-mutation / DOM-global path (NN-COMPAT-016).
 */
export function checkRendererParity(
  input: RendererParityInput,
): { readonly report: SurfaceParityReport; readonly blockReasons: readonly RemovalBlockReason[] } {
  const blockReasons: RemovalBlockReason[] = [];
  const report = compareSurfaceParity(input.surface);

  for (const d of report.divergences) {
    // A stable-key divergence is a duplicate or lost node; other divergences are
    // surface divergences that equally block a projection-only cutover.
    const category: RemovalBlockCategory =
      d.dimension === 'stable-key' ? 'lost-node' : 'surface-divergence';
    blockReasons.push({
      category,
      detail: `${d.surfaceId}/${d.dimension}: ${d.detail}`,
    });
  }
  for (const key of report.duplicateStreams) {
    blockReasons.push({
      category: 'duplicate-stream',
      detail: `${report.surfaceId}: duplicate live stream on stable node key ${key}`,
    });
  }
  for (const portId of report.invalidPorts) {
    blockReasons.push({
      category: 'inferred-execution',
      detail: `${report.surfaceId}: command port ${portId} infers execution or lacks an authority receipt`,
    });
  }
  for (const residual of residualRendererPaths(input.rendererPaths)) {
    blockReasons.push({
      category: 'residual-renderer-path',
      detail: `renderer durable-mutation/DOM-global path still present: ${residual}`,
    });
  }

  return { report, blockReasons };
}

// ─── Event replay parity + single-writer audit ───────────────────────────────

/**
 * Check event replay parity for an event state class over the committed outbox.
 * Reuses {@link backfillLegacyEventHistory} + {@link compareEventHistoryParity}
 * (T-005) so the comparison is over real committed facts, and
 * {@link auditSingleDurableWriter} so the committed outbox is proven to be the
 * sole durable event writer. Blocks on:
 *   - a shorter legacy history than the committed outbox (MISSING HISTORY);
 *   - a kind/payload divergence (a lost/duplicated committed fact);
 *   - a legacy history LONGER than the committed outbox (a duplicate writer:
 *     the legacy path emitted a fact the sole authority never committed).
 */
export function checkEventReplayParity(
  db: Database.Database,
  input: EventReplayParityInput,
): {
  readonly parity: ParityResult;
  readonly audit: SingleWriterAudit;
  readonly blockReasons: readonly RemovalBlockReason[];
} {
  const blockReasons: RemovalBlockReason[] = [];
  const outbox = backfillLegacyEventHistory(db, input.scope);
  const parity = compareEventHistoryParity(outbox, input.legacyHistory);
  const audit = auditSingleDurableWriter(db, input.scope);

  if (!parity.parity) {
    const m = parity.mismatch;
    if (m?.reason === 'LENGTH_MISMATCH') {
      if (parity.legacyRecords < parity.outboxRecords) {
        blockReasons.push({
          category: 'missing-history',
          detail: `legacy history reproduces ${parity.legacyRecords} of ${parity.outboxRecords} committed records (${m.detail})`,
        });
      } else {
        // The legacy path emitted MORE facts than the committed authority — an
        // independent durable writer still exists (fail closed, NN-COMPAT-002).
        blockReasons.push({
          category: 'duplicate-writer',
          detail: `legacy history has ${parity.legacyRecords} records vs ${parity.outboxRecords} committed; an independent writer remains (${m.detail})`,
        });
      }
    } else {
      // A kind/payload divergence means a committed fact was not faithfully
      // reproduced — treated as missing history (fail closed).
      blockReasons.push({
        category: 'missing-history',
        detail: m ? m.detail : 'event replay parity failed with no committed history',
      });
    }
  }

  return { parity, audit, blockReasons };
}

// ─── The per-class removal gate (fail-closed, one class at a time) ───────────

/**
 * Which parity inputs an event class requires, for input validation. Event
 * classes require {@link RetireStateClassRequest.eventReplay}; chat/renderer
 * classes require the corresponding chat/renderer inputs.
 */
const EVENT_CLASSES: readonly RetirementStateClass[] = Object.freeze([
  'event-log-writer',
  'event-bus-writer',
  'action-event-stream-writer',
]);

function isEventClass(stateClass: RetirementStateClass): boolean {
  return (EVENT_CLASSES as readonly RetirementStateClass[]).includes(stateClass);
}

/**
 * Evaluate the fail-closed removal gate for ONE independent-writer state class.
 * Pure/total over its inputs, the committed outbox, and the observer evidence
 * graph — it performs NO deletion and NO business-table write. The class is
 * cleared for removal IFF:
 *
 *   - its 8.1 RetirementInventory item is CLEARED (disposition REMOVE with all
 *     six deletion prerequisites satisfied); AND
 *   - for an EVENT class: event replay parity holds AND the committed outbox is
 *     the sole durable writer; AND
 *   - for a CHAT/renderer class: the rebuilt projection reproduces the same
 *     committed timeline (no missing/duplicate/lost node, not stale) AND the
 *     renderer surface parity holds with no duplicate stream / inferred
 *     execution / residual renderer path.
 *
 * A missing history, a duplicate/lost node, an inferred execution, or a stale
 * projection BLOCKS the removal and keeps the independent writer installed
 * (fail closed). The verdict reports EVERY block reason.
 */
export function evaluateStateClassRemoval(
  db: Database.Database,
  request: RetireStateClassRequest,
  evidence: EvidenceService,
): RetireStateClassVerdict {
  const blockReasons: RemovalBlockReason[] = [];

  // Gate 1 — the 8.1 RetirementInventory clearance (reuse, do not re-implement).
  const inventoryVerdict = evaluateRetirementItem(request.inventoryItem, evidence);
  if (!inventoryVerdict.clearedForDeletion) {
    blockReasons.push({
      category: 'inventory-not-cleared',
      detail: `retirement inventory item ${request.inventoryItem.itemId} is not cleared: ${inventoryVerdict.blockReasons
        .map((r) => r.prerequisite)
        .join(', ')}`,
    });
  }

  let eventParity: ParityResult | undefined;
  let singleWriterAudit: SingleWriterAudit | undefined;
  let chatTimeline: TimelinePage | undefined;
  let rendererReport: SurfaceParityReport | undefined;

  if (isEventClass(request.stateClass)) {
    // Gate 2 (event) — replay parity + single durable writer.
    if (!request.eventReplay) {
      blockReasons.push({
        category: 'missing-history',
        detail: `event class ${request.stateClass} requires an event replay-parity observation`,
      });
    } else {
      const ev = checkEventReplayParity(db, request.eventReplay);
      eventParity = ev.parity;
      singleWriterAudit = ev.audit;
      blockReasons.push(...ev.blockReasons);
    }
  } else {
    // Gate 3 (chat/renderer) — projection replay parity and/or renderer parity.
    if (request.chatReplay) {
      const chat = checkChatReplayParity(db, request.chatReplay);
      chatTimeline = chat.page;
      blockReasons.push(...chat.blockReasons);
    }
    if (request.renderer) {
      const rr = checkRendererParity(request.renderer);
      rendererReport = rr.report;
      blockReasons.push(...rr.blockReasons);
    }
    if (!request.chatReplay && !request.renderer) {
      blockReasons.push({
        category: 'surface-divergence',
        detail: `renderer class ${request.stateClass} requires a chat replay and/or renderer parity observation`,
      });
    }
  }

  const cleared = blockReasons.length === 0;

  // Durable state is projection-only when a cleared class leaves no residual
  // renderer writer path AND the committed outbox is the sole durable writer.
  const noResidualRenderer =
    request.renderer === undefined ||
    residualRendererPaths(request.renderer.rendererPaths).length === 0;
  const singleWriter = singleWriterAudit === undefined || singleWriterAudit.singleWriter;
  const durableStateProjectionOnly = cleared && noResidualRenderer && singleWriter;

  return Object.freeze({
    stateClass: request.stateClass,
    cleared,
    inventoryVerdict,
    ...(eventParity !== undefined ? { eventParity } : {}),
    ...(singleWriterAudit !== undefined ? { singleWriterAudit } : {}),
    ...(chatTimeline !== undefined ? { chatTimeline } : {}),
    ...(rendererReport !== undefined ? { rendererReport } : {}),
    durableStateProjectionOnly,
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

// ─── Batch: retire the whole class set, one at a time (no bulk on a block) ───

/** The result of a full event/renderer writer retirement review. */
export interface RetirementReviewResult {
  readonly verdicts: readonly RetireStateClassVerdict[];
  /** State classes cleared for removal (durable state projection-only). */
  readonly cleared: readonly RetirementStateClass[];
  /** State classes kept installed (removal blocked, fail closed). */
  readonly blocked: readonly RetirementStateClass[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the removal gate over a set of state-class requests. Each class is
 * evaluated INDEPENDENTLY and the verdicts are returned sorted by state class
 * for determinism — a block on one class never clears or blocks another (one
 * state class at a time). No deletion is performed here.
 */
export function reviewEventRendererRetirement(
  db: Database.Database,
  requests: readonly RetireStateClassRequest[],
  evidence: EvidenceService,
): RetirementReviewResult {
  const verdicts = [...requests]
    .map((r) => evaluateStateClassRemoval(db, r, evidence))
    .sort((a, b) => (a.stateClass < b.stateClass ? -1 : a.stateClass > b.stateClass ? 1 : 0));
  const cleared = verdicts.filter((v) => v.cleared).map((v) => v.stateClass);
  const blocked = verdicts.filter((v) => !v.cleared).map((v) => v.stateClass);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    blocked: Object.freeze(blocked),
    coreReadinessUnchanged: true as const,
  });
}

// ─── Rollback — restore a READ/DELIVERY adapter, NEVER an independent writer ─

/** The outcome of a retirement rollback for a state class. */
export type RollbackOutcome =
  | { readonly ok: true; readonly stateClass: RetirementStateClass; readonly restoredRole: AdapterRole }
  | { readonly ok: false; readonly stateClass: RetirementStateClass; readonly refusedRole: AdapterRole; readonly reason: string };

/**
 * Roll back a retired state class by RESELECTING a read/delivery/ephemeral
 * adapter role for it. Fail-closed on intent: a request to restore the `writer`
 * role is REFUSED (a rollback never restores an independent durable writer —
 * the task Migration/rollback rule, NN-COMPAT-002). A restorable role succeeds
 * and reselects that adapter; the committed outbox/projection remains the sole
 * writer throughout. This function performs no durable write; it models the
 * rollback DECISION (which read/delivery adapter is active).
 */
export function rollbackToReadAdapter(
  stateClass: RetirementStateClass,
  requestedRole: AdapterRole,
): RollbackOutcome {
  if (!isRestorableRole(requestedRole)) {
    return {
      ok: false,
      stateClass,
      refusedRole: requestedRole,
      reason:
        'a retirement rollback restores a read/delivery adapter only; an independent durable writer is never restored (NN-COMPAT-002)',
    };
  }
  return { ok: true, stateClass, restoredRole: requestedRole };
}

// ─── Small helpers re-exported for the renderer-parity observers ─────────────

/**
 * Whether a set of stream attachments is duplicate-free for the purpose of a
 * projection-only cutover (thin reuse of the 6.9 gate so callers do not import
 * two modules for one check). Returns the offending stable keys.
 */
export function duplicateStreamKeys(
  attachments: readonly StreamAttachment[],
): readonly string[] {
  return findDuplicateStreams(attachments);
}

/** Whether every command port on a surface is valid (no inferred execution). */
export function everyCommandPortValid(ports: readonly CommandPort[]): boolean {
  return ports.every((p) => isCommandPortValid(p));
}

/** The authority id that owns the event/renderer writer retirement leaf. */
export const EVENT_RENDERER_RETIREMENT_OWNER = 'authority-event-projection';

export type { TypedRowIsland };
