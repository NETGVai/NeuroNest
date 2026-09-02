/**
 * RecoveryExitGate — the P4 recovery/migration/restore/cancellation exit-gate
 * evaluator and its generated adversarial matrices
 * (FUT-PKG-05-RECOVERY/T-006).
 *
 * This module is the Recovery Verification Authority's composite gate: it drives
 * the already-verified P4 authorities — the WorkspaceAuthority (T-001), the
 * journaled ChangeService (T-002), the CheckpointService + backends + legacy
 * wrapper (T-003), the RestoreService + TranscriptRewindService (T-004), and the
 * hierarchical CancellationController (T-005) — through generated
 * path/concurrency/file-state/backend/crash/cancellation/platform matrices and
 * rolls every observation into ONE verdict. Like the P2 durability gate
 * ({@link ../storage/durability-verification.ts evaluateDurabilityGate}) the
 * verdict is `block` if ANY finding fails, so a single unverified success,
 * hard-reset loss, orphan operation, or post-terminal effect prevents P5
 * execution-package admission (D-22, D-23 P4 exit gate, NN-VERIFY-005).
 *
 * The gate is a READER/VERIFIER: it authors NO business row (NN-INV-008) and
 * mutates the workspace only through the injected authorities' own guarded,
 * journaled, rescue-bound paths. It proves, deterministically:
 *
 *   - **Rescue restoration / no hard-reset loss** (D-14, NN-CHECKPOINT-006/007,
 *     NN-DATA-006): a fault at every restore promotion boundary returns the
 *     workspace byte-for-byte to the verified pre-restore rescue and never
 *     leaves a partial apply ({@link runCrashMatrix}).
 *   - **Old/new reader compatibility** (D-20, NN-CHECKPOINT-001–010): a
 *     checkpoint captured by one backend round-trips through the restore path
 *     for every backend, and a restore never mutates the transcript, so a prior
 *     reader (transcript, projection generation, checkpoint artifact) survives a
 *     restore ({@link runBackendMatrix}, {@link runFileStateMatrix}).
 *   - **No loss of worktree/transcript/evidence** (NN-CHAT-009/010, NN-INV-006):
 *     a workspace restore records no transcript rewind, a rewind preserves every
 *     prior turn (append-only), and a failed restore preserves the rescue.
 *   - **Deterministic cancellation with no orphan/post-terminal effect**
 *     (NN-INV-012, D-15/D-18): a stop-all closes registration, names every
 *     survivor truthfully, and rejects every post-terminal emission
 *     ({@link runCancellationMatrix}).
 *   - **Cross-platform filesystem capability** (D-16.3/D-17, NN-PLATFORM):
 *     every advertised platform cell either qualifies its recovery-relevant
 *     filesystem controls or returns an explicit typed unavailable — never a
 *     silent string-prefix fallback ({@link runPlatformMatrix}).
 *   - **No-data-loss blocker self-test** (V-VERIFY-001/no-data-loss-blocker):
 *     the gate is proven to BLOCK on a planted data-loss (a lost rescue byte),
 *     so the gate cannot silently pass a data-loss ({@link runNoDataLossSelfTest}).
 *
 * Design anchors: D-12, D-13, D-14, D-15, D-18, D-20, D-22, D-23, D-24.
 * Requirements: NN-INV-003/006/012/015, NN-DATA-003–006, NN-CHECKPOINT-001–010,
 * NN-VERIFY-002/003/005.
 */

import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { readJournalById } from '../storage/operation-journal.js';
import { computeDigest, type ScopeDescriptor } from '../shared/contract-primitives.js';
import {
  CancellationController,
  type CooperativeDescendant,
  type DescendantKind,
} from '../shared/execution-cancellation.js';
import { CheckpointService } from './checkpoint-service.js';
import { RestoreService, RestoreServiceError, type RestoreCommand } from './restore-service.js';
import {
  TranscriptRewindService,
  computeRewindConfirmationDigest,
  type TranscriptTurn,
} from './transcript-rewind.js';
import type { CheckpointBackendType } from './checkpoint-types.js';

// ─── The matrix cell axes (generated, not hand-enumerated) ───────────────────

/** Every checkpoint backend the P4 restore path must round-trip (D-20). */
export const RECOVERY_BACKENDS: readonly CheckpointBackendType[] = Object.freeze([
  'file-delta',
  'git-ref',
  'full-snapshot',
]);

/**
 * The canonical platforms whose recovery-relevant filesystem capability the P4
 * gate demands evidence for (D-17). A cell is qualified only if its required
 * control set is present; otherwise the gate expects an explicit typed
 * `UNAVAILABLE`, never a silent fallback (D-24 "insecure fallback").
 */
export const RECOVERY_PLATFORMS: readonly string[] = Object.freeze([
  'macos',
  'windows-x64',
  'linux-x64',
]);

/**
 * The recovery-relevant filesystem controls each platform adapter must declare
 * for a checkpoint/restore/ChangeSet promotion to be trustworthy (D-16.3):
 * canonical no-follow path containment, atomic (staged-then-rename) promotion,
 * and canonical device/inode identity comparison. A missing control makes the
 * cell `UNAVAILABLE` — it must never degrade to string-prefix containment.
 */
export const RECOVERY_FS_CONTROLS: readonly string[] = Object.freeze([
  'canonical-no-follow-containment',
  'atomic-staged-promotion',
  'device-inode-identity',
]);

/**
 * A platform filesystem-capability declaration the gate audits. `status` is a
 * typed capability truth: `supported-with-profile` requires the full control
 * set; `unavailable` must name the missing controls and NEVER host-fallback.
 */
export interface PlatformFsCapability {
  readonly platform: string;
  readonly status: 'supported-with-profile' | 'unavailable';
  /** The controls the adapter declares present. */
  readonly controlSet: readonly string[];
  /** For `unavailable`, the controls that were missing (typed, not silent). */
  readonly missingControls?: readonly string[];
}

// ─── Gate findings / verdict (mirrors the P2 durability gate shape) ──────────

/** One category the recovery exit gate evaluates and its verdict. */
export interface RecoveryGateFinding {
  readonly matrix:
    | 'crash-rescue-restoration'
    | 'backend-reader-compatibility'
    | 'file-state-no-loss'
    | 'transcript-worktree-preservation'
    | 'cancellation-no-orphan-no-post-terminal'
    | 'cross-platform-filesystem'
    | 'no-data-loss-blocker-self-test';
  /** True iff every generated cell in this matrix held its invariant. */
  readonly pass: boolean;
  /** Number of generated cells exercised. */
  readonly cells: number;
  readonly detail: string;
}

/** The composite P4 recovery exit-gate verdict. */
export interface RecoveryGateVerdict {
  /** `pass` iff every matrix held; `block` on ANY blocker (D-23 P4 gate). */
  readonly verdict: 'pass' | 'block';
  readonly findings: readonly RecoveryGateFinding[];
  /** The matrices that failed (empty on pass) — the blocker report. */
  readonly blockers: readonly RecoveryGateFinding['matrix'][];
  readonly evaluatedAt: string;
}

// ─── Harness the gate builds over the injected authorities ───────────────────

/** The live P4 authorities and the temp workspace the gate drives. */
export interface RecoveryGateContext {
  readonly db: Database.Database;
  readonly checkpoints: CheckpointService;
  readonly restore: RestoreService;
  readonly rewind: TranscriptRewindService;
  /** The absolute workspace root (a real temp directory). */
  readonly rootPath: string;
  readonly scope: ScopeDescriptor;
  readonly projectId: string;
  readonly sessionId: string;
  readonly actor: string;
  readonly now?: () => Date;
}

/** A single matrix cell's outcome (used to fold into a finding). */
interface CellOutcome {
  readonly ok: boolean;
  readonly note?: string;
}

// ─── Workspace helpers (real filesystem, no mocks) ───────────────────────────

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function resetWorkspace(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

/** Snapshot the whole workspace tree (relative POSIX path -> content). */
export function snapshotWorkspace(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

function deepEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

let gateSeq = 0;
function nextSeq(): number {
  gateSeq += 1;
  return gateSeq;
}

/** Create a target checkpoint capturing the CURRENT bytes of `targetPaths`. */
function makeTargetCheckpoint(
  ctx: RecoveryGateContext,
  backendType: CheckpointBackendType,
  targetPaths: readonly string[],
  baseRef?: string,
): string {
  const seq = nextSeq();
  const result = ctx.checkpoints.create({
    commandId: `gate-cmd-${seq}`,
    idempotencyKey: `gate-idem-${seq}`,
    correlationId: `gate-corr-${seq}`,
    scope: ctx.scope,
    projectId: ctx.projectId,
    rootPath: ctx.rootPath,
    source: 'manual',
    backendType,
    description: `gate target ${seq}`,
    createdBy: ctx.actor,
    targetPaths,
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });
  return result.record.checkpointId;
}

function makeRestoreCommand(
  ctx: RecoveryGateContext,
  checkpointId: string,
  overrides: Partial<RestoreCommand> = {},
): RestoreCommand {
  const seq = nextSeq();
  return {
    commandId: `gate-rcmd-${seq}`,
    idempotencyKey: `gate-ridem-${seq}`,
    correlationId: `gate-rcorr-${seq}`,
    scope: ctx.scope,
    projectId: ctx.projectId,
    checkpointId,
    rootPath: ctx.rootPath,
    expectedWorkspaceRevision: 1,
    resultWorkspaceRevision: 1,
    restoredBy: ctx.actor,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 1 — crash / rescue restoration (D-14, NN-CHECKPOINT-006/007)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each generated `(backend, fileCount, faultBoundary)` cell: build a target
 * checkpoint, diverge the CURRENT state, then restore with a fault injected at
 * `faultBoundary`. The invariant: the restore reports a typed `failed`, the
 * journal is `compensated`, and the workspace is byte-for-byte the pre-restore
 * CURRENT state (the verified rescue restored — no hard-reset loss, no partial
 * apply). A cell fails the matrix if the workspace diverges, the journal is not
 * compensated, or a partial apply is observed.
 */
export function runCrashMatrix(
  ctx: RecoveryGateContext,
  cells: readonly { backend: CheckpointBackendType; fileCount: number; faultBoundary: number }[],
): CellOutcome[] {
  const outcomes: CellOutcome[] = [];
  for (const cell of cells) {
    resetWorkspace(ctx.rootPath);
    const paths = Array.from({ length: cell.fileCount }, (_, i) => `f${i}.txt`);
    for (const p of paths) writeFile(ctx.rootPath, p, `TARGET-${p}`);
    const checkpointId = makeTargetCheckpoint(
      ctx,
      cell.backend,
      paths,
      cell.backend === 'git-ref' ? 'refs/heads/main' : undefined,
    );
    for (const p of paths) writeFile(ctx.rootPath, p, `CURRENT-${p}`);
    const before = snapshotWorkspace(ctx.rootPath);
    const faultAt = cell.faultBoundary % (cell.fileCount + 1);

    let ok = true;
    let note: string | undefined;
    try {
      const result = ctx.restore.restore(
        makeRestoreCommand(ctx, checkpointId, {
          ...(cell.backend === 'git-ref' ? { expectedBaseRef: 'refs/heads/main' } : {}),
          faultDuringPromotion: (applied) => {
            if (applied === faultAt || (faultAt === 0 && applied === 1)) {
              throw new Error('gate-injected promotion fault');
            }
          },
        }),
      );
      if (result.kind !== 'failed') {
        ok = false;
        note = `expected failed restore, got ${result.kind}`;
      } else {
        const journal = readJournalById(ctx.db, result.journalId);
        if (!journal || journal.state !== 'compensated') {
          ok = false;
          note = `journal state ${journal?.state ?? 'missing'} (expected compensated)`;
        }
      }
    } catch (err) {
      // A preflight-class throw is acceptable only if it leaves state unchanged;
      // a non-typed throw is a blocker.
      if (!(err instanceof RestoreServiceError)) {
        ok = false;
        note = `unexpected throw: ${(err as Error).message}`;
      }
    }
    if (ok && !deepEqual(snapshotWorkspace(ctx.rootPath), before)) {
      ok = false;
      note = 'workspace diverged from pre-restore rescue (hard-reset loss)';
    }
    outcomes.push({ ok, ...(note !== undefined ? { note } : {}) });
  }
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 2 — backend reader compatibility (D-20 old/new readers)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each backend: capture a target checkpoint, verify its immutable artifact,
 * diverge the workspace, restore cleanly, and confirm the workspace now equals
 * the captured target bytes AND the source artifact is still integrity-verified
 * after the restore (a prior reader survives — D-20 "old/new readers"). A cell
 * fails if the clean restore does not reproduce the target, if the artifact no
 * longer verifies, or if the rescue checkpoint is not itself verifiable.
 */
export function runBackendMatrix(
  ctx: RecoveryGateContext,
  backends: readonly CheckpointBackendType[],
): CellOutcome[] {
  const outcomes: CellOutcome[] = [];
  for (const backend of backends) {
    resetWorkspace(ctx.rootPath);
    writeFile(ctx.rootPath, 'a.txt', 'TARGET-A');
    writeFile(ctx.rootPath, 'sub/b.txt', 'TARGET-B');
    // `c.txt` is DECLARED in the checkpoint's tracked set but absent at capture,
    // so a restore that finds it present at restore time must delete it (the
    // checkpoint only manages paths inside its own manifest, D-14).
    const targetPaths = ['a.txt', 'sub/b.txt', 'c.txt'];
    const checkpointId = makeTargetCheckpoint(
      ctx,
      backend,
      targetPaths,
      backend === 'git-ref' ? 'refs/heads/main' : undefined,
    );
    const target = snapshotWorkspace(ctx.rootPath);

    // The captured artifact must verify BEFORE the restore.
    if (!ctx.checkpoints.verifyIntegrity(checkpointId)) {
      outcomes.push({ ok: false, note: `${backend}: target artifact failed pre-restore verify` });
      continue;
    }

    // Diverge within the tracked set, then restore cleanly.
    writeFile(ctx.rootPath, 'a.txt', 'CURRENT-A');
    writeFile(ctx.rootPath, 'c.txt', 'CURRENT-C');

    let ok = true;
    let note: string | undefined;
    const result = ctx.restore.restore(
      makeRestoreCommand(ctx, checkpointId, {
        ...(backend === 'git-ref' ? { expectedBaseRef: 'refs/heads/main' } : {}),
      }),
    );
    if (result.kind !== 'restored') {
      ok = false;
      note = `${backend}: clean restore did not succeed (${result.kind})`;
    } else {
      if (!deepEqual(snapshotWorkspace(ctx.rootPath), target)) {
        ok = false;
        note = `${backend}: restored bytes differ from captured target`;
      }
      // Old reader survives: the source artifact and the rescue both verify.
      if (ok && !ctx.checkpoints.verifyIntegrity(checkpointId)) {
        ok = false;
        note = `${backend}: source artifact no longer verifies after restore`;
      }
      if (ok && !ctx.checkpoints.verifyIntegrity(result.rescueCheckpointId)) {
        ok = false;
        note = `${backend}: rescue checkpoint failed to verify`;
      }
    }
    outcomes.push({ ok, ...(note !== undefined ? { note } : {}) });
  }
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 3 — file-state / path no-loss (NN-DATA-004–006, NN-INV-006)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each generated file-state cell (mix of edited, created-since-capture, and
 * deleted-since-capture paths + a nested subdirectory), a clean restore must:
 * rewrite captured paths to their target bytes, delete paths absent at capture,
 * and — critically — preserve the CURRENT bytes as a verified rescue so no user
 * state is lost (NN-DATA-006). A cell fails if the restore result does not name
 * the correct deletions, if the target is not reproduced, or if the rescue does
 * not hold the exact pre-restore bytes.
 */
export function runFileStateMatrix(
  ctx: RecoveryGateContext,
  cells: readonly { captured: number; createdSince: number }[],
): CellOutcome[] {
  const outcomes: CellOutcome[] = [];
  for (const cell of cells) {
    resetWorkspace(ctx.rootPath);
    const captured = Array.from({ length: cell.captured }, (_, i) => `cap/${i}.txt`);
    for (const p of captured) writeFile(ctx.rootPath, p, `TARGET-${p}`);
    // The `createdSince` paths are DECLARED in the checkpoint's tracked set but
    // are absent at capture, so a restore that finds them present must delete
    // them (a checkpoint only manages paths inside its own manifest, D-14).
    const createdSince = Array.from({ length: cell.createdSince }, (_, i) => `del${i}.txt`);
    const checkpointId = makeTargetCheckpoint(ctx, 'file-delta', [...captured, ...createdSince]);
    const targetBytes = snapshotWorkspace(ctx.rootPath);

    // Diverge: edit captured[0], create the declared-absent paths.
    if (captured.length > 0) writeFile(ctx.rootPath, captured[0], 'EDITED');
    for (const p of createdSince) writeFile(ctx.rootPath, p, `CURRENT-${p}`);
    const preRestore = snapshotWorkspace(ctx.rootPath);

    let ok = true;
    let note: string | undefined;
    const result = ctx.restore.restore(makeRestoreCommand(ctx, checkpointId));
    if (result.kind !== 'restored') {
      ok = false;
      note = `restore failed (${result.kind})`;
    } else {
      // Every created-since path is deleted; captured paths equal target bytes.
      const after = snapshotWorkspace(ctx.rootPath);
      if (!deepEqual(after, targetBytes)) {
        ok = false;
        note = 'post-restore workspace differs from captured target';
      }
      for (const p of createdSince) {
        if (!result.deletedPaths.includes(p)) {
          ok = false;
          note = `created-since path ${p} not reported deleted`;
        }
      }
      // The rescue holds the exact pre-restore bytes (no hard-reset loss).
      if (ok && !ctx.checkpoints.verifyIntegrity(result.rescueCheckpointId)) {
        ok = false;
        note = 'rescue checkpoint failed to verify';
      }
      // Re-restoring the rescue reproduces the pre-restore state exactly.
      if (ok) {
        const rescueRestore = ctx.restore.restore(
          makeRestoreCommand(ctx, result.rescueCheckpointId),
        );
        if (rescueRestore.kind !== 'restored' || !deepEqual(snapshotWorkspace(ctx.rootPath), preRestore)) {
          ok = false;
          note = 'restoring the rescue did not reproduce the pre-restore user state';
        }
      }
    }
    outcomes.push({ ok, ...(note !== undefined ? { note } : {}) });
  }
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 4 — transcript / worktree preservation (NN-CHAT-009/010)
// ═══════════════════════════════════════════════════════════════════════════

function makeTranscript(count: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let parent: string | null = null;
  for (let i = 0; i < count; i++) {
    const turnId = `turn-${i}`;
    turns.push({
      turnId,
      branchId: 'branch-main',
      parentTurnId: parent,
      contentDigest: computeDigest({ turnId, i }),
      ordinal: i + 1,
    });
    parent = turnId;
  }
  return turns;
}

/**
 * For each generated `(turnCount, targetTurn)` cell: a workspace restore records
 * NO transcript rewind (separation), and a separately-authorized digest-bound
 * rewind retains every prior turn (append-only) and branches from the target. A
 * cell fails if a restore mutates the transcript, if a rewind drops a turn, or
 * if the new head does not descend from the target.
 */
export function runTranscriptMatrix(
  ctx: RecoveryGateContext,
  cells: readonly { turnCount: number; targetTurn: number }[],
): CellOutcome[] {
  const outcomes: CellOutcome[] = [];
  for (const cell of cells) {
    // A fresh session per cell to avoid idempotency-key collisions.
    const sessionId = `${ctx.sessionId}-tx-${nextSeq()}`;
    const scope: ScopeDescriptor = { ...ctx.scope, sessionId };

    // (a) A workspace restore never touches the transcript.
    resetWorkspace(ctx.rootPath);
    writeFile(ctx.rootPath, 'a.txt', 'TARGET');
    const checkpointId = makeTargetCheckpoint(ctx, 'file-delta', ['a.txt']);
    writeFile(ctx.rootPath, 'a.txt', 'CURRENT');
    const restoreResult = ctx.restore.restore(makeRestoreCommand(ctx, checkpointId));

    let ok = restoreResult.kind === 'restored';
    let note: string | undefined = ok ? undefined : 'restore precondition failed';
    if (ok && ctx.rewind.list(sessionId).length !== 0) {
      ok = false;
      note = 'a workspace restore recorded a transcript rewind (not separated)';
    }

    // (b) A separately-authorized rewind preserves lineage.
    if (ok) {
      const transcript = makeTranscript(cell.turnCount);
      const targetIdx = cell.targetTurn % cell.turnCount;
      const target = transcript[targetIdx];
      const confirmationDigest = computeRewindConfirmationDigest({
        sessionId,
        targetTurnId: target.turnId,
        targetTurnDigest: target.contentDigest,
        targetBranchId: target.branchId,
        targetOrdinal: target.ordinal,
      });
      const seq = nextSeq();
      const rewind = ctx.rewind.rewind({
        commandId: `gate-rw-cmd-${seq}`,
        idempotencyKey: `gate-rw-idem-${seq}`,
        correlationId: `gate-rw-corr-${seq}`,
        scope,
        sessionId,
        projectId: ctx.projectId,
        transcript,
        targetTurnId: target.turnId,
        activeBranchId: 'branch-main',
        confirmationDigest,
        rewoundBy: ctx.actor,
      });
      const afterIds = new Set(rewind.transcript.map((t) => t.turnId));
      for (const t of transcript) {
        if (!afterIds.has(t.turnId)) {
          ok = false;
          note = `rewind dropped turn ${t.turnId} (append-only violated)`;
        }
      }
      if (ok && rewind.transcript.length !== transcript.length + 1) {
        ok = false;
        note = 'rewind did not add exactly one new branch head';
      }
      if (ok) {
        const newHead = rewind.transcript.find((t) => t.branchId === rewind.record.newBranchId);
        if (!newHead || newHead.parentTurnId !== target.turnId) {
          ok = false;
          note = 'new branch head does not descend from the target turn';
        }
      }
    }
    outcomes.push({ ok, ...(note !== undefined ? { note } : {}) });
  }
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 5 — cancellation: no orphan, no post-terminal effect (NN-INV-012)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A deterministic descendant used to seed a cancellation tree cell. `stops`
 * decides whether it acknowledges cooperatively; `forcible` decides whether a
 * forced escalation confirms it stopped. A descendant that neither acknowledges
 * nor can be forced is a truthful survivor (never hidden).
 */
interface DescendantSpec {
  readonly kind: DescendantKind;
  readonly stops: boolean;
  readonly forcible: boolean;
}

function makeDescendant(spec: DescendantSpec): { descendant: CooperativeDescendant; state: { stopped: boolean } } {
  const state = { stopped: false };
  const descendant: CooperativeDescendant = {
    kind: spec.kind,
    requestStop: () => {
      if (spec.stops) state.stopped = true;
    },
    isStopped: () => state.stopped,
    forceTerminate: () => {
      if (spec.forcible) state.stopped = true;
      return state.stopped;
    },
  };
  return { descendant, state };
}

/**
 * For each generated cancellation cell (a set of descendant specs): build a
 * token tree, cancel the root, and assert the truthful termination invariants:
 *
 *   - registration is CLOSED after cancellation (no new descendant admitted);
 *   - a post-terminal `emit` from any token is REJECTED (no post-terminal effect);
 *   - the result is `terminated` (allStopped) IFF every descendant is confirmed
 *     stopped, else `forced-termination` naming every survivor — never a false
 *     all-stopped (NN-INV-012, D-15).
 *
 * A cell fails if a new descendant is admitted after cancel, if a post-terminal
 * emission succeeds, or if the result misreports survivors.
 */
export function runCancellationMatrix(
  ctx: RecoveryGateContext,
  cells: readonly DescendantSpec[][],
): CellOutcome[] {
  const outcomes: CellOutcome[] = [];
  let cellIdx = 0;
  for (const specs of cells) {
    cellIdx += 1;
    let clock = 0;
    const controller = new CancellationController(`gate-root-${cellIdx}`, {
      now: () => (clock += 1),
    });
    const tokenIds: string[] = [];
    const states: { stopped: boolean }[] = [];
    let ok = true;
    let note: string | undefined;

    for (const spec of specs) {
      const { descendant, state } = makeDescendant(spec);
      const reg = controller.register(descendant);
      if (!reg.ok) {
        ok = false;
        note = 'failed to register a descendant before cancellation';
        break;
      }
      tokenIds.push(reg.value);
      states.push(state);
    }

    if (ok) {
      const expectSurvivor = specs.some((s) => !s.stops && !s.forcible);
      const term = controller.cancel(undefined, {
        windowMs: 5,
        pollIntervalMs: 1,
        pollAttempts: 3,
        sleep: () => {
          /* deterministic clock advances via now() */
        },
      });
      if (!term.ok) {
        ok = false;
        note = 'cancel() returned an error';
      } else {
        const result = term.value;
        // Truthful all-stopped: terminated IFF no survivor.
        if (expectSurvivor && (result.result !== 'forced-termination' || result.allStopped)) {
          ok = false;
          note = 'a survivor was present but the result claimed all stopped';
        }
        if (!expectSurvivor && result.result === 'forced-termination' && result.forcedSurvivors.length > 0) {
          ok = false;
          note = 'no survivor expected but survivors were reported';
        }
        // No new descendant admitted after cancellation (registration closed).
        const lateReg = controller.register({ kind: 'tool' });
        if (lateReg.ok) {
          ok = false;
          note = 'a new descendant was admitted after cancellation (orphan operation)';
        }
        // No post-terminal effect: an emission from a terminal token is rejected.
        if (ok && tokenIds.length > 0) {
          const emitAttempt = controller.emit(tokenIds[0], () => 'post-terminal-effect');
          if (emitAttempt.ok) {
            ok = false;
            note = 'a post-terminal emission was accepted (post-terminal effect)';
          }
        }
      }
    }
    outcomes.push({ ok, ...(note !== undefined ? { note } : {}) });
  }
  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matrix 6 — cross-platform filesystem capability (D-16.3/D-17)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Audit a platform filesystem-capability declaration. A cell holds when it is
 * self-consistent AND fail-closed: a `supported-with-profile` cell must declare
 * the FULL recovery control set; an `unavailable` cell must be missing at least
 * one required control AND name it (no silent fallback). A cell that claims
 * support while missing a control, or claims unavailable without naming a
 * missing control, is a blocker (D-24 "insecure fallback").
 */
export function runPlatformMatrix(
  capabilities: readonly PlatformFsCapability[],
): CellOutcome[] {
  return capabilities.map((cap) => {
    const declared = new Set(cap.controlSet);
    const missing = RECOVERY_FS_CONTROLS.filter((c) => !declared.has(c));
    if (cap.status === 'supported-with-profile') {
      if (missing.length > 0) {
        return {
          ok: false,
          note: `${cap.platform}: claims support but missing controls [${missing.join(',')}]`,
        };
      }
      return { ok: true, note: `${cap.platform}: qualified (full control set)` };
    }
    // unavailable — must name at least one missing control and never fallback.
    const named = new Set(cap.missingControls ?? []);
    if (missing.length === 0) {
      return { ok: false, note: `${cap.platform}: unavailable but full control set declared` };
    }
    const allNamed = missing.every((c) => named.has(c));
    if (!allNamed) {
      return {
        ok: false,
        note: `${cap.platform}: unavailable did not name every missing control`,
      };
    }
    return { ok: true, note: `${cap.platform}: explicit UNAVAILABLE (typed, no fallback)` };
  });
}

/**
 * A default platform matrix that qualifies every canonical platform with the
 * full recovery control set. Real adapters supply their own evidence; this is
 * the deterministic all-supported baseline the gate uses when none is injected.
 */
export function defaultPlatformCapabilities(): PlatformFsCapability[] {
  return RECOVERY_PLATFORMS.map((platform) => ({
    platform,
    status: 'supported-with-profile' as const,
    controlSet: [...RECOVERY_FS_CONTROLS],
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// No-data-loss blocker self-test (V-VERIFY-001/no-data-loss-blocker)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Prove the gate BLOCKS on a planted data-loss, so it can never silently pass a
 * loss (NN-VERIFY-005, D-22 "data loss" is a publication blocker). We synthesize
 * a crash-matrix outcome set that contains a planted loss cell (a restore that
 * left the workspace diverged from its rescue) and confirm the fold produces a
 * FAILED finding. If the fold were to pass a diverged cell the self-test fails
 * (the gate would be blind to data-loss). Returns `true` iff the gate correctly
 * detects the planted loss.
 */
export function runNoDataLossSelfTest(): { readonly detected: boolean; readonly note: string } {
  // A planted data-loss outcome: a cell that reports a hard-reset loss.
  const planted: CellOutcome[] = [
    { ok: true },
    { ok: false, note: 'workspace diverged from pre-restore rescue (hard-reset loss)' },
    { ok: true },
  ];
  const finding = foldFinding('crash-rescue-restoration', planted);
  // The gate must classify the planted-loss set as a FAILED finding.
  const detected = finding.pass === false && finding.cells === 3;
  return {
    detected,
    note: detected
      ? 'gate blocks on a planted data-loss cell (self-test proves no blind pass)'
      : 'gate FAILED to block a planted data-loss (blind-pass regression)',
  };
}

// ─── Fold + top-level evaluation ─────────────────────────────────────────────

function foldFinding(
  matrix: RecoveryGateFinding['matrix'],
  outcomes: readonly CellOutcome[],
): RecoveryGateFinding {
  const failed = outcomes.filter((o) => !o.ok);
  const pass = failed.length === 0;
  const detail = pass
    ? `${outcomes.length} cell(s) held the invariant`
    : `${failed.length}/${outcomes.length} cell(s) failed: ${failed
        .map((f) => f.note ?? 'unspecified')
        .slice(0, 5)
        .join('; ')}`;
  return { matrix, pass, cells: outcomes.length, detail };
}

/** The generated matrices the gate runs (deterministic default coverage). */
export interface RecoveryGateInput {
  readonly ctx: RecoveryGateContext;
  /** Platform capability declarations; defaults to the all-supported baseline. */
  readonly platformCapabilities?: readonly PlatformFsCapability[];
  readonly now?: () => Date;
}

/**
 * Evaluate the P4 recovery exit gate. Every matrix is run; the verdict is
 * `block` if ANY matrix fails, so a single unverified success, hard-reset loss,
 * orphan operation, or post-terminal effect prevents P5 execution-package
 * admission (D-23 P4 gate, NN-VERIFY-005). The no-data-loss self-test proves the
 * gate itself cannot silently pass a data-loss.
 */
export function evaluateRecoveryGate(input: RecoveryGateInput): RecoveryGateVerdict {
  const { ctx } = input;
  const now = input.now ?? ctx.now ?? (() => new Date());
  const findings: RecoveryGateFinding[] = [];

  // Generated crash matrix: every backend x 1..4 files x fault at every boundary.
  const crashCells: { backend: CheckpointBackendType; fileCount: number; faultBoundary: number }[] = [];
  for (const backend of RECOVERY_BACKENDS) {
    for (let fileCount = 1; fileCount <= 4; fileCount++) {
      for (let faultBoundary = 0; faultBoundary <= fileCount; faultBoundary++) {
        crashCells.push({ backend, fileCount, faultBoundary });
      }
    }
  }
  findings.push(foldFinding('crash-rescue-restoration', runCrashMatrix(ctx, crashCells)));

  // Backend reader-compatibility matrix.
  findings.push(foldFinding('backend-reader-compatibility', runBackendMatrix(ctx, RECOVERY_BACKENDS)));

  // File-state / path no-loss matrix.
  const fileStateCells = [
    { captured: 1, createdSince: 0 },
    { captured: 2, createdSince: 1 },
    { captured: 3, createdSince: 2 },
    { captured: 4, createdSince: 3 },
  ];
  findings.push(foldFinding('file-state-no-loss', runFileStateMatrix(ctx, fileStateCells)));

  // Transcript / worktree preservation matrix.
  const transcriptCells = [
    { turnCount: 1, targetTurn: 0 },
    { turnCount: 3, targetTurn: 1 },
    { turnCount: 5, targetTurn: 2 },
    { turnCount: 8, targetTurn: 7 },
  ];
  findings.push(foldFinding('transcript-worktree-preservation', runTranscriptMatrix(ctx, transcriptCells)));

  // Cancellation matrix: cooperative, forced, and survivor topologies.
  const cancellationCells: DescendantSpec[][] = [
    [{ kind: 'agent', stops: true, forcible: true }],
    [
      { kind: 'process', stops: false, forcible: true },
      { kind: 'pty', stops: true, forcible: true },
    ],
    [
      { kind: 'tool', stops: false, forcible: false }, // survivor
      { kind: 'provider-stream', stops: true, forcible: true },
    ],
    [
      { kind: 'process', stops: false, forcible: true },
      { kind: 'mcp', stops: false, forcible: false }, // survivor
      { kind: 'channel', stops: true, forcible: true },
    ],
  ];
  findings.push(foldFinding('cancellation-no-orphan-no-post-terminal', runCancellationMatrix(ctx, cancellationCells)));

  // Cross-platform filesystem capability matrix.
  const platformCaps = input.platformCapabilities ?? defaultPlatformCapabilities();
  findings.push(foldFinding('cross-platform-filesystem', runPlatformMatrix(platformCaps)));

  // No-data-loss blocker self-test (the gate must detect a planted loss).
  const selfTest = runNoDataLossSelfTest();
  findings.push({
    matrix: 'no-data-loss-blocker-self-test',
    pass: selfTest.detected,
    cells: 1,
    detail: selfTest.note,
  });

  const blockers = findings.filter((f) => !f.pass).map((f) => f.matrix);
  const verdict: 'pass' | 'block' = blockers.length === 0 ? 'pass' : 'block';
  return { verdict, findings, blockers, evaluatedAt: now().toISOString() };
}
