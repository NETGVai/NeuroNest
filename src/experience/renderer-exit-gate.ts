/**
 * Renderer strangler migration + the P6 EXPERIENCE EXIT GATE
 * (FUT-PKG-07-EXPERIENCE/T-009 — Renderer Migration Authority).
 *
 * This is the FINAL leaf of the P6 EXPERIENCE package. It completes the renderer
 * strangler migration (D-20 "Chat/projections" stream) and renders the explicit,
 * fail-closed EXIT GATE that a surface must pass before its reader is cut over
 * from the legacy renderer path to the canonical projection-only path.
 *
 * It is deliberately ADDITIVE over the prior P6 leaves and NEVER creates a
 * parallel truth (NN-INV-008):
 *
 *   - The canonical timeline is the READER from {@link ../chat/chat-projection}
 *     over the committed `DomainEvent@1` outbox (T-001, D-10). The shadow
 *     projection here compares the LEGACY renderer view against that canonical
 *     projection surface-by-surface; it is never a second durable writer.
 *   - The accessibility matrix reuses {@link ./accessibility}
 *     `verifyAccessibilityMatrix`/`hasCriticalFinding` (T-007, FIX-RENDERER-A11Y-01)
 *     — a whole inaccessible surface cannot pass.
 *   - The performance gate reuses {@link ./performance-profile}
 *     `gatePerformanceReport` (T-008, FIX-PERF-REFERENCE-01) — a configured SLO
 *     blocker cannot pass.
 *
 * Durable state is PROJECTION-ONLY. The renderer never creates/mutates a Chat
 * Node after cutover (NN-COMPAT-016): the durable writer is the shared authority
 * mutation transaction, the projection is the sole read-model author, and this
 * module classifies whether the renderer's remaining durable-mutation and
 * DOM-global paths have been removed. Legacy sessions remain READABLE via
 * upcasters that normalize a legacy ingress record into the canonical shape
 * WITHOUT re-introducing a durable writer (NN-COMPAT-010/016, D-20).
 *
 * The EXIT GATE is FAIL-CLOSED. It aggregates the full chat/editor/index/
 * dashboard parity matrix plus the accessibility and performance authorities and
 * BLOCKS cutover on ANY of:
 *   - a content / stable-key / focus / anchor / performance divergence;
 *   - a duplicate stream (two live streams for one correlated node);
 *   - an inferred execution (a text pattern treated as a verified tool run);
 *   - an inaccessible surface (a critical accessibility finding);
 *   - a configured SLO blocker (the D-21 performance report does not pass).
 * The verdict is `block` unless every observer is a conformant parity observer
 * AND the accessibility matrix and performance report both pass.
 *
 * Migration/rollout/rollback (D-20/D-23): surface-by-surface developer →
 * internal → cohort → default reader. A rollback reselects the prior
 * reader/upcaster; the canonical writers and safety policies remain — a rollback
 * NEVER restores a renderer durable writer and NEVER re-enables a safety bypass.
 *
 * Design anchors: D-10 (chat projection), D-12 (workbench/editor), D-13 (file
 * tree/task surfaces), D-14 (renderer islands / checkpoint restore), D-18 (error
 * handling/consistency), D-19 (observability), D-20 (migration/compatibility),
 * D-21 (performance), D-22 (verification), D-23 (rollout/rollback), D-24 (risks).
 * Requirements: NN-CHAT-001–014, NN-UI-001–015, NN-COMPAT-010/016,
 * NN-VERIFY-002/005.
 */

import type { ChatTimelineNode } from '../chat/chat-types.js';
import { nodeText } from '../chat/chat-types.js';
import {
  verifyAccessibilityMatrix,
  hasCriticalFinding,
  type AccessibilityFinding,
  type SurfaceAccessibilityModel,
} from './accessibility.js';
import {
  gatePerformanceReport,
  type PerformanceReportGate,
  type RawPerformanceArtifact,
  type D21ProfileId,
} from './performance-profile.js';

// ═══════════════════════════════════════════════════════════════════════════
// Surfaces under migration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The four experience surfaces whose reader is migrated off the legacy renderer
 * path onto the canonical projection-only path in P6: chat, editor/workbench,
 * index/search, and the authority dashboard. The exit gate requires a parity
 * observer for EVERY one of these; a missing surface is a fail-closed gap so a
 * surface cannot pass cutover by omission (NN-COMPAT-010/016, NN-VERIFY-005).
 */
export const MIGRATION_SURFACES = Object.freeze([
  'chat',
  'editor',
  'index',
  'dashboard',
] as const);

export type MigrationSurfaceId = (typeof MIGRATION_SURFACES)[number];

// ═══════════════════════════════════════════════════════════════════════════
// Typed row islands + keyed windowing (NN-CHAT-001/002, NN-UI-005, D-14)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A typed row island — the render-ready projection of one stable-keyed timeline
 * node into a row the renderer paints WITHOUT owning durable truth. The island
 * carries only projected, safe fields: its stable key, the ordering anchor
 * derived from the committed sequence, the rendered text, the terminal status,
 * and whether a live stream is currently attached. The renderer never mutates
 * these; they are recomputed from the projection (NN-CHAT-001/002, D-10/D-14).
 */
export interface TypedRowIsland {
  /** The stable node key from the canonical projection (identity). */
  readonly stableKey: string;
  /**
   * The deterministic ordering anchor for this row. Derived purely from the
   * committed identity so paging/compaction/replay place the row identically
   * (NN-CHAT-001, NN-UI-003 "stable identities").
   */
  readonly anchor: string;
  /** The projected rendered text (concatenated committed tokens/blocks). */
  readonly content: string;
  /** The terminal/streaming status projected from the committed events. */
  readonly status: ChatTimelineNode['status'];
  /** Whether a single live provider stream is attached to this row. */
  readonly liveStreamAttached: boolean;
}

/**
 * Project a canonical timeline node into a typed row island. Purely derived —
 * the anchor is `${turnId}#${attempt}` (a stable, workspace-relative identity,
 * never an absolute path, NN-UI-003) and the content is the projection's own
 * committed text. `liveStreamAttached` reflects whether a stream is currently
 * feeding this node (a `streaming` status). No durable write occurs.
 */
export function projectRowIsland(node: ChatTimelineNode): TypedRowIsland {
  return {
    stableKey: node.nodeKey,
    anchor: `${node.turnId}#${node.attempt}`,
    content: nodeText(node),
    status: node.status,
    liveStreamAttached: node.status === 'streaming',
  };
}

/** A deterministic, stable-key-ordered window over a list of typed row islands. */
export interface RowWindow {
  /** The islands in this window, in stable order. */
  readonly rows: readonly TypedRowIsland[];
  /** Total islands across all windows. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

/**
 * Compute a KEYED window over typed row islands (NN-CHAT-001, NN-UI-013). The
 * order is derived purely from the stable key so the SAME window bounds always
 * yield the SAME rows regardless of arrival order — windowing never duplicates
 * or drops a row. `offset`/`limit` are clamped to the island count.
 */
export function windowRows(
  islands: readonly TypedRowIsland[],
  offset = 0,
  limit?: number,
): RowWindow {
  const sorted = [...islands].sort((a, b) =>
    a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0,
  );
  const start = Math.max(0, offset);
  const size = limit ?? sorted.length;
  return {
    rows: sorted.slice(start, start + size),
    total: sorted.length,
    offset: start,
    limit: size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Command ports (NN-CHAT-006/011, NN-UI-001, D-18) — no inferred execution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A typed command port descriptor. Renderer intents flow through a typed command
 * port to the authority; a port NEVER executes and NEVER infers a tool run from
 * text. `requiresAuthority` records whether dispatching this command requires an
 * authority receipt before any effect is shown (NN-CHAT-006 "text patterns SHALL
 * not be treated as verified execution", NN-INV-003).
 */
export interface CommandPort {
  readonly portId: string;
  /** The typed command this port dispatches (e.g. `submitChat`, `applyChange`). */
  readonly command: string;
  /** Whether an authority receipt is required before any effect is surfaced. */
  readonly requiresAuthority: boolean;
  /**
   * Whether this port was reached by INFERRING execution from rendered text
   * (a heuristic tool-run). An inferred-execution port is invalid and blocks
   * cutover (NN-CHAT-006, NN-COMPAT-016 "heuristic tool execution … retire").
   */
  readonly inferredFromText: boolean;
}

/**
 * Whether a command port is valid for cutover: it must NOT be reached by
 * inferring execution from text, and a command with any effect must require an
 * authority receipt. A port that infers execution is always invalid.
 */
export function isCommandPortValid(port: CommandPort): boolean {
  if (port.inferredFromText) return false;
  return port.requiresAuthority;
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-session draft state (NN-CHAT-007, D-14) — survives recoverable failure
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The per-session draft state the renderer keeps for a composer. It is a
 * projected island (see {@link ../chat/chat-experience} ComposerIsland) — the
 * renderer holds NO durable truth; the draft/focus survive a recoverable failure
 * because they are recomputed from committed composer events (NN-CHAT-007/010).
 */
export interface PerSessionDraft {
  readonly sessionId: string;
  readonly draftText: string;
  readonly focusHeld: boolean;
}

/**
 * Preserve a per-session draft across a recoverable failure. Because the draft
 * is a pure projection of committed events, "preserving" it is identity — the
 * SAME session yields the SAME draft/focus after a reload. This function makes
 * the invariant explicit and copy-safe (never a mutation of the input).
 */
export function preserveDraft(draft: PerSessionDraft): PerSessionDraft {
  return {
    sessionId: draft.sessionId,
    draftText: draft.draftText,
    focusHeld: draft.focusHeld,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Durable streaming (NN-CHAT-004) — one live stream per correlated node
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A record of the live provider→renderer streams attached to correlated nodes.
 * NN-CHAT-004 forbids a duplicate stream: at most ONE live stream may feed a
 * given stable node key at a time. {@link findDuplicateStreams} detects any
 * node key that has more than one live stream so the exit gate can block it
 * (NN-COMPAT-016 "duplicate streams … retire after parity").
 */
export interface StreamAttachment {
  /** The stable node key the stream feeds. */
  readonly stableKey: string;
  /** A stable id for the live stream (e.g. a transport/connection id). */
  readonly streamId: string;
  /** Whether the stream is currently live (open, forwarding deltas). */
  readonly live: boolean;
}

/**
 * Find every stable node key that has MORE THAN ONE live stream attached (a
 * duplicate stream, NN-CHAT-004). Returns the offending stable keys. An empty
 * result means every node has at most one live stream.
 */
export function findDuplicateStreams(
  attachments: readonly StreamAttachment[],
): readonly string[] {
  const liveByKey = new Map<string, number>();
  for (const a of attachments) {
    if (!a.live) continue;
    liveByKey.set(a.stableKey, (liveByKey.get(a.stableKey) ?? 0) + 1);
  }
  const dups: string[] = [];
  for (const [key, count] of liveByKey.entries()) {
    if (count > 1) dups.push(key);
  }
  return dups.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

// ═══════════════════════════════════════════════════════════════════════════
// Sanitized adapters + old-session upcasters (NN-CHAT-005, NN-COMPAT-010/016)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A legacy ingress record from a mutable renderer message store — the shape a
 * pre-migration session persisted. The upcaster normalizes it into the canonical
 * projected row island WITHOUT re-introducing a durable renderer writer: it is a
 * READ adapter only (NN-COMPAT-016 "Legacy chat ingress MAY normalize into
 * canonical events, but after cutover it SHALL NOT create/mutate Chat Nodes").
 */
export interface LegacySessionRecord {
  readonly legacyId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly role: string;
  /** The legacy rendered text (may contain unsafe markup to be sanitized). */
  readonly text: string;
  /** Whether the legacy record was marked completed by the OLD renderer. */
  readonly legacyCompleted: boolean;
}

/** The result of upcasting a legacy session record. */
export type UpcastResult =
  | { readonly ok: true; readonly island: TypedRowIsland }
  | { readonly ok: false; readonly reason: string };

/**
 * Markup that must never survive a sanitized adapter — a legacy record that
 * smuggled script/handlers/iframes is refused surfacing rather than rendered
 * (fail closed, NN-CHAT-005, NN-UI-011, D-16.6).
 */
const LEGACY_UNSAFE = Object.freeze([
  /<\s*script/i,
  /<\s*\/\s*script/i,
  /<\s*iframe/i,
  /javascript:/i,
  /\bon\w+\s*=/i,
]);

function legacyContainsUnsafe(text: string): boolean {
  return LEGACY_UNSAFE.some((p) => p.test(text));
}

/**
 * Upcast a legacy session record into a canonical typed row island so an OLD
 * session stays READABLE after the migration (NN-COMPAT-010/016). Fails closed:
 *
 *   - a record whose text contains unsafe markup is REFUSED (never rendered);
 *   - an empty/whitespace turn id is refused (no stable identity);
 *   - a legacy `completed` flag is honored only as `complete` status, but the
 *     upcaster never marks completion from renderer text alone — the flag came
 *     from a committed legacy record, so it maps to the terminal status without
 *     inferring a new completion (NN-INV-003).
 *
 * The upcaster is a pure READ adapter: it produces an island, never a durable
 * write. Rollback reselects this adapter and never restores a renderer writer.
 */
export function upcastLegacySession(record: LegacySessionRecord): UpcastResult {
  if (record.turnId.trim().length === 0) {
    return { ok: false, reason: 'legacy record has no stable turn identity' };
  }
  if (legacyContainsUnsafe(record.text)) {
    return { ok: false, reason: 'legacy record contains unsafe markup and cannot be surfaced' };
  }
  const stableKey = `${record.turnId}::${record.attempt}::${record.role}`;
  return {
    ok: true,
    island: {
      stableKey,
      anchor: `${record.turnId}#${record.attempt}`,
      content: record.text,
      status: record.legacyCompleted ? 'complete' : 'streaming',
      liveStreamAttached: false,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Gated removal of renderer durable-mutation / DOM-global paths (NN-COMPAT-016)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The legacy renderer paths D-20/NN-COMPAT-016 require to RETIRE after parity: a
 * renderer durable mutation (the renderer creating/mutating a Chat Node
 * directly), a global formatter patch, an inline handler, heuristic tool
 * execution, a duplicate stream, and a mutable message store. This model records
 * whether each has been removed for a surface. Removal is GATED on parity —
 * {@link isRendererCutoverReady} refuses cutover while ANY remains.
 */
export interface RendererLegacyPaths {
  /** Whether the renderer can still durably create/mutate a Chat Node. */
  readonly rendererDurableWriterPresent: boolean;
  /** Whether a global markdown/formatter monkeypatch is still installed. */
  readonly globalFormatterPatchPresent: boolean;
  /** Whether inline DOM event handlers are still emitted. */
  readonly inlineHandlersPresent: boolean;
  /** Whether tool runs are still inferred from rendered text (heuristic). */
  readonly heuristicToolExecutionPresent: boolean;
  /** Whether a mutable in-renderer message store still holds durable truth. */
  readonly mutableMessageStorePresent: boolean;
}

/** A fully-retired legacy path set (every renderer durable/DOM-global path gone). */
export function retiredRendererPaths(): RendererLegacyPaths {
  return {
    rendererDurableWriterPresent: false,
    globalFormatterPatchPresent: false,
    inlineHandlersPresent: false,
    heuristicToolExecutionPresent: false,
    mutableMessageStorePresent: false,
  };
}

/**
 * Whether the renderer legacy paths are fully retired so durable state is
 * projection-only. Fail-closed: returns the list of paths that are STILL present
 * (empty = ready). Any present path blocks cutover (NN-COMPAT-016).
 */
export function residualRendererPaths(paths: RendererLegacyPaths): readonly string[] {
  const residual: string[] = [];
  if (paths.rendererDurableWriterPresent) residual.push('renderer-durable-writer');
  if (paths.globalFormatterPatchPresent) residual.push('global-formatter-patch');
  if (paths.inlineHandlersPresent) residual.push('inline-handlers');
  if (paths.heuristicToolExecutionPresent) residual.push('heuristic-tool-execution');
  if (paths.mutableMessageStorePresent) residual.push('mutable-message-store');
  return residual;
}

/** True when every renderer durable-mutation/DOM-global path is retired. */
export function isRendererCutoverReady(paths: RendererLegacyPaths): boolean {
  return residualRendererPaths(paths).length === 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shadow projection + parity diagnostics (D-20 shadow compare)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The dimensions a shadow parity comparison checks between the legacy renderer
 * view and the canonical projection view (NN-COMPAT-010/016, D-20 "content/
 * stable-key/scroll/accessibility parity"). Each maps to a blocking divergence.
 */
export type ParityDimension =
  | 'content'
  | 'stable-key'
  | 'focus'
  | 'anchor'
  | 'performance';

/**
 * One surface's shadow-comparison observer. The legacy view and the canonical
 * projection view are BOTH observers (neither is a writer) so the comparison is
 * safe; the exit gate cuts over only on a full parity match (D-20). Each field
 * is the observed value from the corresponding view; divergence in any recorded
 * dimension blocks cutover.
 */
export interface SurfaceParityObservation {
  readonly surfaceId: MigrationSurfaceId;
  /** The typed row islands the LEGACY renderer view produced (observer). */
  readonly legacyRows: readonly TypedRowIsland[];
  /** The typed row islands the CANONICAL projection view produced (observer). */
  readonly canonicalRows: readonly TypedRowIsland[];
  /** The focused stable key in the legacy view (null = no focus owner). */
  readonly legacyFocusKey: string | null;
  /** The focused stable key in the canonical view. */
  readonly canonicalFocusKey: string | null;
  /** Live stream attachments observed on this surface (duplicate detection). */
  readonly streamAttachments: readonly StreamAttachment[];
  /** The command ports the surface exposes (inferred-execution detection). */
  readonly commandPorts: readonly CommandPort[];
}

/** A single parity divergence with the dimension and a safe description. */
export interface ParityDivergence {
  readonly surfaceId: MigrationSurfaceId;
  readonly dimension: ParityDimension;
  readonly detail: string;
}

/** The full parity diagnostic for one surface. */
export interface SurfaceParityReport {
  readonly surfaceId: MigrationSurfaceId;
  /** True only when every parity dimension matches and no stream/port fault. */
  readonly parity: boolean;
  readonly divergences: readonly ParityDivergence[];
  /** Duplicate-stream stable keys observed (NN-CHAT-004). */
  readonly duplicateStreams: readonly string[];
  /** Command ports that infer execution or omit an authority receipt. */
  readonly invalidPorts: readonly string[];
}

/**
 * Compare the legacy and canonical views for one surface and produce a parity
 * diagnostic. It is a pure comparison of two observers — it never mutates a
 * view. Divergences are recorded for:
 *   - content: the ordered projected text differs;
 *   - stable-key: the set of stable keys differs (a duplicate or lost node);
 *   - anchor: a stable key's ordering anchor differs;
 *   - focus: the focused stable key differs (focus loss/steal, NN-VERIFY-005);
 *   - performance: (aggregated at the gate level — see the performance report).
 * A duplicate live stream and an inferred-execution command port are recorded
 * separately so the gate can block them explicitly (NN-CHAT-004/006).
 */
export function compareSurfaceParity(
  observation: SurfaceParityObservation,
): SurfaceParityReport {
  const divergences: ParityDivergence[] = [];
  const push = (dimension: ParityDimension, detail: string): void => {
    divergences.push({ surfaceId: observation.surfaceId, dimension, detail });
  };

  const legacyByKey = new Map(observation.legacyRows.map((r) => [r.stableKey, r]));
  const canonicalByKey = new Map(observation.canonicalRows.map((r) => [r.stableKey, r]));

  // Stable-key parity: same set of keys (no duplicate, no lost node).
  const legacyKeys = [...legacyByKey.keys()].sort();
  const canonicalKeys = [...canonicalByKey.keys()].sort();
  const keySetMatches =
    legacyKeys.length === canonicalKeys.length &&
    legacyKeys.every((k, i) => k === canonicalKeys[i]);
  if (!keySetMatches) {
    push(
      'stable-key',
      `legacy keys [${legacyKeys.length}] differ from canonical keys [${canonicalKeys.length}]`,
    );
  }

  // Content + anchor parity per shared stable key.
  for (const key of legacyKeys) {
    const legacyRow = legacyByKey.get(key);
    const canonicalRow = canonicalByKey.get(key);
    if (!legacyRow || !canonicalRow) continue;
    if (legacyRow.content !== canonicalRow.content) {
      push('content', `content differs for stable key ${key}`);
    }
    if (legacyRow.anchor !== canonicalRow.anchor) {
      push('anchor', `ordering anchor differs for stable key ${key}`);
    }
  }

  // Focus parity: the focused stable key must match (no focus loss/steal).
  if (observation.legacyFocusKey !== observation.canonicalFocusKey) {
    push(
      'focus',
      `focused key differs (legacy=${observation.legacyFocusKey ?? 'none'} canonical=${observation.canonicalFocusKey ?? 'none'})`,
    );
  }

  const duplicateStreams = findDuplicateStreams(observation.streamAttachments);
  const invalidPorts = observation.commandPorts
    .filter((p) => !isCommandPortValid(p))
    .map((p) => p.portId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const parity =
    divergences.length === 0 && duplicateStreams.length === 0 && invalidPorts.length === 0;

  return {
    surfaceId: observation.surfaceId,
    parity,
    divergences,
    duplicateStreams,
    invalidPorts,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The P6 EXPERIENCE EXIT GATE (fail-closed) — NN-VERIFY-005
// ═══════════════════════════════════════════════════════════════════════════

/** A configured SLO blocker declared for the release (D-21/D-23 abort threshold). */
export interface SloBlocker {
  readonly id: string;
  /** A safe, secret-free description of the configured blocker. */
  readonly reason: string;
}

/**
 * The full input to the exit gate: a parity observation for EVERY migration
 * surface, the accessibility matrix (T-007), the D-21 performance report
 * (T-008), the renderer legacy path status, and any configured SLO blockers.
 */
export interface ExitGateInput {
  readonly surfaces: readonly SurfaceParityObservation[];
  readonly accessibilitySurfaces: readonly SurfaceAccessibilityModel[];
  readonly performanceArtifacts: Readonly<
    Partial<Record<D21ProfileId, RawPerformanceArtifact>>
  >;
  readonly rendererPaths: RendererLegacyPaths;
  readonly configuredSloBlockers: readonly SloBlocker[];
}

/** The categories the exit gate can block on (each maps to NN-VERIFY-005). */
export type ExitGateBlockCategory =
  | 'parity-divergence'
  | 'duplicate-stream'
  | 'inferred-execution'
  | 'inaccessible-surface'
  | 'slo-blocker'
  | 'residual-renderer-path'
  | 'missing-surface';

/** One blocking reason with its category and a safe description. */
export interface ExitGateBlockReason {
  readonly category: ExitGateBlockCategory;
  readonly detail: string;
}

/** The explicit exit-gate verdict. */
export interface ExitGateVerdict {
  /** `pass` only when every check is green; otherwise `block`. */
  readonly verdict: 'pass' | 'block';
  /** Every blocking reason (empty on pass). */
  readonly blockingReasons: readonly ExitGateBlockReason[];
  /** Per-surface parity reports (for diagnostics). */
  readonly parityReports: readonly SurfaceParityReport[];
  /** The accessibility findings observed across the matrix. */
  readonly accessibilityFindings: readonly AccessibilityFinding[];
  /** The performance report gate result. */
  readonly performanceGate: PerformanceReportGate;
}

/**
 * Evaluate the P6 EXPERIENCE EXIT GATE. FAIL-CLOSED: the verdict is `pass` ONLY
 * when EVERY condition holds and there are ZERO blocking reasons:
 *
 *   - every migration surface (chat/editor/index/dashboard) has a parity
 *     observation AND that observation is a full parity match (a missing surface
 *     is a fail-closed gap);
 *   - no surface has a content/stable-key/focus/anchor divergence;
 *   - no surface has a duplicate live stream (NN-CHAT-004);
 *   - no surface exposes an inferred-execution command port (NN-CHAT-006);
 *   - the accessibility matrix has NO critical finding (an inaccessible surface
 *     blocks — NN-UI-011, NN-VERIFY-005);
 *   - the D-21 performance report PASSES (a configured SLO miss blocks —
 *     NN-PERF-*, NN-VERIFY-005);
 *   - every renderer durable-mutation/DOM-global path is retired (durable state
 *     is projection-only — NN-COMPAT-016);
 *   - no configured SLO blocker is declared (D-23 abort threshold).
 *
 * Any single violation forces `block` and records every reason. This gate is the
 * machine-checkable core of V-UI-001/experience-exit-gate; it can detect a
 * planted failure of each blocking condition and is not a rubber stamp.
 */
export function evaluateExitGate(input: ExitGateInput): ExitGateVerdict {
  const blockingReasons: ExitGateBlockReason[] = [];
  const parityReports: SurfaceParityReport[] = [];

  // 1) Every migration surface must be present and pass parity.
  const observedSurfaces = new Set(input.surfaces.map((s) => s.surfaceId));
  for (const required of MIGRATION_SURFACES) {
    if (!observedSurfaces.has(required)) {
      blockingReasons.push({
        category: 'missing-surface',
        detail: `migration surface ${required} has no parity observation`,
      });
    }
  }

  for (const observation of input.surfaces) {
    const report = compareSurfaceParity(observation);
    parityReports.push(report);
    for (const d of report.divergences) {
      blockingReasons.push({
        category: 'parity-divergence',
        detail: `${d.surfaceId}/${d.dimension}: ${d.detail}`,
      });
    }
    for (const key of report.duplicateStreams) {
      blockingReasons.push({
        category: 'duplicate-stream',
        detail: `${report.surfaceId}: duplicate live stream on stable key ${key}`,
      });
    }
    for (const portId of report.invalidPorts) {
      blockingReasons.push({
        category: 'inferred-execution',
        detail: `${report.surfaceId}: command port ${portId} infers execution or lacks an authority receipt`,
      });
    }
  }

  // 2) Accessibility matrix — a critical finding is an inaccessible surface.
  const accessibilityFindings = verifyAccessibilityMatrix(input.accessibilitySurfaces);
  for (const f of accessibilityFindings) {
    if (f.severity === 'critical') {
      blockingReasons.push({
        category: 'inaccessible-surface',
        detail: `${f.target ?? 'surface'}: ${f.code} — ${f.message}`,
      });
    }
  }

  // 3) Performance report — a configured SLO miss / missing profile blocks.
  const performanceGate = gatePerformanceReport(input.performanceArtifacts);
  if (!performanceGate.pass) {
    for (const p of performanceGate.profiles) {
      if (!p.pass) {
        blockingReasons.push({
          category: 'slo-blocker',
          detail: `performance profile ${p.profileId} failed: ${p.failureReasons.join(', ')}`,
        });
      }
    }
  }

  // 4) Renderer durable-mutation / DOM-global paths must be retired.
  for (const residual of residualRendererPaths(input.rendererPaths)) {
    blockingReasons.push({
      category: 'residual-renderer-path',
      detail: `renderer legacy path still present: ${residual}`,
    });
  }

  // 5) Any explicitly configured SLO blocker blocks (D-23 abort threshold).
  for (const b of input.configuredSloBlockers) {
    blockingReasons.push({
      category: 'slo-blocker',
      detail: `configured SLO blocker ${b.id}: ${b.reason}`,
    });
  }

  return {
    verdict: blockingReasons.length === 0 ? 'pass' : 'block',
    blockingReasons,
    parityReports,
    accessibilityFindings,
    performanceGate,
  };
}

/**
 * Assert the exit gate passes. Throws a visible error listing every blocking
 * reason when the verdict is `block`, so a divergence / duplicate stream /
 * inferred execution / inaccessible surface / SLO blocker / residual renderer
 * path HARD-BLOCKS cutover rather than being silently passed (NN-VERIFY-005).
 */
export function assertExitGatePasses(input: ExitGateInput): ExitGateVerdict {
  const verdict = evaluateExitGate(input);
  if (verdict.verdict === 'block') {
    const detail = verdict.blockingReasons
      .map((r) => `${r.category}: ${r.detail}`)
      .join('; ');
    throw new Error(`P6 experience exit gate BLOCKED cutover: ${detail}`);
  }
  return verdict;
}

/** True when the accessibility matrix has a release-blocking critical finding. */
export function matrixHasInaccessibleSurface(
  surfaces: readonly SurfaceAccessibilityModel[],
): boolean {
  return hasCriticalFinding(verifyAccessibilityMatrix(surfaces));
}
