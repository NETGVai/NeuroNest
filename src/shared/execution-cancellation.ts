/**
 * Hierarchical cancellation token tree and truthful termination
 * (D-11 fail-closed governed execution, D-13 orchestration cancellation,
 * D-15 recovery/termination convergence).
 *
 * Implements FUT-PKG-05-RECOVERY/T-005: the Execution Controller Authority's
 * `CancellationToken@1` tree, descendant registration closure,
 * propagation/acknowledgement, deadlines, forced-survivor reporting, and
 * post-terminal effect/output rejection across every async subsystem (agents,
 * providers, tools, processes, PTYs, MCP, channels, training, approvals,
 * queues, barriers, background children).
 *
 * The guarantees this module enforces (task acceptance, NN-INV-012,
 * NN-EXEC-011/012/014, NN-ORCH-006/007, NN-CHANNEL stop-all; D-11/13/15):
 *
 *   1. Every execution owns a hierarchical cancellation token; registering a
 *      descendant operation mints a CHILD token whose scope is a subset of its
 *      parent and whose deadline never exceeds the parent's. Cancelling a node
 *      propagates cancellation to the whole subtree (NN-INV-012, NN-EXEC-014).
 *   2. On cancellation the controller CLOSES descendant registration before
 *      propagating (no new descendant may be created after a token enters a
 *      cancelling/terminal state — the registration is rejected with a typed
 *      `CANCELLED` error, D-06.2). Propagation then requests a cooperative stop
 *      of every registered descendant.
 *   3. Termination waits a BOUNDED acknowledgement window. A descendant that
 *      acknowledges cooperatively within the window is recorded as an
 *      acknowledged owner; a descendant that does not is escalated to forced
 *      termination and reported as a survivor. The terminal `TerminationResult@1`
 *      is `terminated` ONLY when every registered descendant acknowledged;
 *      otherwise it is `forced-termination` and NAMES the survivors — it never
 *      claims success while survivors remain (NN-INV-012, D-15,
 *      TerminationResult@1 invariant).
 *   4. Acknowledgements are IDEMPOTENT: a duplicate acknowledgement from the
 *      same descendant is a no-op, never a second effect (CancellationToken@1
 *      invariant).
 *   5. After a terminal state NO new descendant may be created and NO new
 *      effect/output/emission may occur: a post-terminal emission is REJECTED
 *      (dropped) with a typed `CANCELLED` error and is never observable
 *      (NN-INV-012, CD-012 "no post-terminal effect").
 *   6. A "stop-all" cancels the root, which cascades to every channel/subsystem
 *      descendant of the tree (NN-CHANNEL stop-all).
 *
 * The module is deliberately pure and adapter-injected. Cross-subsystem
 * descendants are represented GENERICALLY as a {@link CooperativeDescendant}
 * (a cooperative-stop hook plus an "is it still alive" probe) so the controller
 * is exercised deterministically in CI with injected cooperative and
 * unresponsive descendants — no real agent/provider/PTY/MCP/channel is required.
 * Process-tree descendants reuse the 3.5 process-tree cancellation
 * ({@link ProcessTreeController}/`cancelTree`) via a thin adapter so a process
 * subtree's forced kill and survivor listing are identical to the sandbox path.
 *
 * The task is additive and behind execution: the token tree wraps existing
 * abort surfaces (CD-012 "existing abort APIs adapt into token tree"). Rollback
 * disables a subsystem's cooperative hook but NEVER removes forced termination
 * (task rollback rule): a descendant without a cooperative hook is simply
 * treated as immediately unresponsive and force-reported.
 *
 * Design anchors: D-06 (D-06.2 CANCELLED/TIMEOUT), D-07 (CancellationToken@1,
 * TerminationResult@1), D-11, D-13, D-15, D-17.
 * Requirements: NN-INV-012, NN-EXEC-011/012/014, NN-ORCH-006/007, NN-CHANNEL.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from './contract-primitives';
import {
  SandboxExecutionManager,
  type CancellationResult,
  type ProcessTreeHandle,
  type ResourceLimits,
} from './platform-sandbox';

// ════════════════════════════════════════════════════════════════════════════
// 1. Descendant subsystem taxonomy (NN-EXEC-014)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The async subsystems a cancellation token may own descendants in. Kept as a
 * closed set so a "stop-all" and the evidence trace can enumerate every plane
 * the root token reaches (NN-EXEC-014, NN-CHANNEL stop-all).
 */
export const DESCENDANT_KINDS = Object.freeze([
  'agent',
  'subagent',
  'provider-stream',
  'tool',
  'skill',
  'process',
  'pty',
  'mcp',
  'channel',
  'browser',
  'training',
  'approval',
  'queue',
  'barrier',
  'background',
] as const);

export type DescendantKind = (typeof DESCENDANT_KINDS)[number];

/** Whether a value is a known descendant kind. */
export function isDescendantKind(value: unknown): value is DescendantKind {
  return (
    typeof value === 'string' &&
    (DESCENDANT_KINDS as readonly string[]).includes(value)
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Cooperative descendant (generic injected hook, NN-INV-012)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A generic cross-subsystem descendant operation. This is the injection seam
 * that keeps the controller testable and identical across every plane:
 *
 *   - `requestStop` — the cooperative cancellation hook. It is invoked once
 *     when the owning token is cancelled and SHOULD begin a graceful stop. It
 *     never throws to the controller (a hook error is treated as "did not
 *     acknowledge"). A subsystem whose rollback disabled its cooperative hook
 *     passes `requestStop: undefined` and is treated as immediately
 *     unresponsive — forced termination still applies (task rollback rule).
 *   - `isStopped` — a truthful probe of whether the descendant has actually
 *     stopped. The controller NEVER assumes a descendant stopped; it observes
 *     via this probe (D-15 truthful termination). A descendant that only
 *     signals via {@link CancellationController.acknowledge} may omit
 *     `isStopped`; an acknowledgement is then the sole stop evidence.
 *   - `forceTerminate` — an optional forced escalation (e.g. kill a process
 *     tree). If present it is invoked for a descendant that did not acknowledge
 *     within the window; it returns whether the descendant is confirmed stopped
 *     afterwards. If absent, an unresponsive descendant is reported as a
 *     survivor (never hidden).
 */
export interface CooperativeDescendant {
  readonly kind: DescendantKind;
  /** Cooperative stop hook; optional (rollback may disable it). */
  readonly requestStop?: () => void;
  /** Truthful stopped-probe; optional when acknowledgement is the evidence. */
  readonly isStopped?: () => boolean;
  /**
   * Optional forced escalation for an unresponsive descendant. Returns `true`
   * only when the descendant is confirmed stopped after the forced action.
   */
  readonly forceTerminate?: () => boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Token state machine (CancellationToken@1, D-07)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The lifecycle state of a cancellation token.
 *   - `active`     — running; new descendants may register.
 *   - `cancelling` — cancellation requested; registration is CLOSED and
 *     cooperative stop has been propagated, but the bounded acknowledgement
 *     window has not yet resolved. No new descendant/effect is admitted.
 *   - `terminated` — terminal: every registered descendant acknowledged
 *     cooperatively.
 *   - `forced`     — terminal: at least one descendant was force-terminated or
 *     survives; survivors are named. Both terminal states reject post-terminal
 *     descendants and emissions.
 */
export const TOKEN_STATES = Object.freeze([
  'active',
  'cancelling',
  'terminated',
  'forced',
] as const);
export type TokenState = (typeof TOKEN_STATES)[number];

/** Whether a token state is terminal (no new descendant/effect admitted). */
export function isTerminalState(state: TokenState): boolean {
  return state === 'terminated' || state === 'forced';
}

/** Whether a token state admits new descendants/effects (only `active`). */
export function admitsWork(state: TokenState): boolean {
  return state === 'active';
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Errors (D-06.2 typed CANCELLED)
// ════════════════════════════════════════════════════════════════════════════

const CONTROLLER_OWNER = 'authority-execution-controller';

function cancellationError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: CONTROLLER_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'The owning execution reached a cancelling or terminal state; ' +
      'no new descendant, effect, or emission is admitted after cancellation.',
    redaction: 'internal',
  };
}

/** A typed result: either an accepted value or a typed rejection. */
export type CancellationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ════════════════════════════════════════════════════════════════════════════
// 5. Terminal termination result (TerminationResult@1, D-07/D-15)
// ════════════════════════════════════════════════════════════════════════════

/**
 * How a descendant reached its terminal state during a cancellation.
 *   - `acknowledged` — stopped cooperatively within the bounded window.
 *   - `forced`       — force-terminated after the window and confirmed stopped.
 *   - `survivor`     — did NOT stop; still observed alive after any forced
 *     attempt (or had no forced escalation). Never hidden.
 */
export type OwnerDisposition = 'acknowledged' | 'forced' | 'survivor';

/** The per-descendant record inside a {@link TerminationResult}. */
export interface OwnerOutcome {
  readonly tokenId: string;
  readonly kind: DescendantKind;
  readonly disposition: OwnerDisposition;
}

/**
 * `TerminationResult@1`. `result` is exactly `terminated` or
 * `forced-termination`: `terminated` is legal ONLY when every registered
 * descendant acknowledged; otherwise `forced-termination` names survivors and
 * never claims success (D-07/D-15 TerminationResult invariant).
 */
export interface TerminationResult {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly terminationId: string;
  readonly rootTokenId: string;
  readonly result: 'terminated' | 'forced-termination';
  /** Tokens (root + descendants) that acknowledged cooperatively. */
  readonly acknowledgedOwners: readonly OwnerOutcome[];
  /** Tokens force-terminated after the window and confirmed stopped. */
  readonly forcedOwners: readonly OwnerOutcome[];
  /** Tokens still observed alive after any forced attempt (named, never hidden). */
  readonly forcedSurvivors: readonly OwnerOutcome[];
  /** True only when there are no survivors (whole tree confirmed stopped). */
  readonly allStopped: boolean;
  /** Time spent converging, in the injected clock's units (ms). */
  readonly convergenceMs: number;
  /** Safe, secret-free reason. */
  readonly reason: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Cancellation controller (the token tree, NN-INV-012)
// ════════════════════════════════════════════════════════════════════════════

interface TokenNode {
  readonly tokenId: string;
  readonly parentTokenId?: string;
  readonly kind: DescendantKind | 'root';
  readonly descendant?: CooperativeDescendant;
  state: TokenState;
  reason?: string;
  readonly deadlineAt?: number;
  readonly childIds: string[];
  acknowledged: boolean;
  /** Whether the cooperative stop hook has been invoked (idempotency guard). */
  stopRequested: boolean;
}

/** Options for {@link CancellationController}. */
export interface CancellationControllerOptions {
  /** Monotonic clock in ms; defaults to `Date.now`. Injectable for determinism. */
  readonly now?: () => number;
  /** Root token scope owner label for evidence. */
  readonly owner?: string;
  /** Optional deadline for the root token (ms epoch on the injected clock). */
  readonly deadlineAt?: number;
}

/**
 * The Execution Controller's hierarchical cancellation token tree. A single
 * controller owns one root token and every descendant token beneath it. The
 * controller is the observer; subsystems register cooperative descendants and
 * acknowledge cooperatively, and the controller drives bounded acknowledgement
 * then forced termination and produces the truthful {@link TerminationResult}.
 */
export class CancellationController {
  private readonly nodes = new Map<string, TokenNode>();
  private readonly rootId: string;
  private readonly now: () => number;
  private seq = 0;

  constructor(
    rootTokenId: string,
    options: CancellationControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.rootId = rootTokenId;
    this.nodes.set(rootTokenId, {
      tokenId: rootTokenId,
      kind: 'root',
      state: 'active',
      deadlineAt: options.deadlineAt,
      childIds: [],
      acknowledged: false,
      stopRequested: false,
    });
  }

  /** The root token id (the execution's own token). */
  get rootTokenId(): string {
    return this.rootId;
  }

  /** The current state of a token, or `undefined` if unknown. */
  stateOf(tokenId: string): TokenState | undefined {
    return this.nodes.get(tokenId)?.state;
  }

  /** Whether `tokenId` (default root) is in a terminal state. */
  isTerminal(tokenId: string = this.rootId): boolean {
    const node = this.nodes.get(tokenId);
    return node !== undefined && isTerminalState(node.state);
  }

  /** Whether `tokenId` (default root) still admits new work (`active`). */
  isActive(tokenId: string = this.rootId): boolean {
    const node = this.nodes.get(tokenId);
    return node !== undefined && admitsWork(node.state);
  }

  /** The direct child token ids of `tokenId` (default root). */
  childrenOf(tokenId: string = this.rootId): readonly string[] {
    return this.nodes.get(tokenId)?.childIds ?? [];
  }

  /**
   * Register a descendant operation under `parentTokenId` (default root),
   * minting a CHILD token. Fails closed with a typed `CANCELLED` when the parent
   * is not `active` (registration is closed the instant a token starts
   * cancelling — no new descendant after cancellation, NN-INV-012/EXEC-014).
   *
   * `deadlineAt` may not exceed the parent's deadline (child deadline is a
   * subset, CancellationToken@1 invariant); an over-long child deadline is
   * clamped to the parent's.
   */
  register(
    descendant: CooperativeDescendant,
    parentTokenId: string = this.rootId,
    options: { readonly tokenId?: string; readonly deadlineAt?: number } = {},
  ): CancellationOutcome<string> {
    const parent = this.nodes.get(parentTokenId);
    if (!parent) {
      return {
        ok: false,
        error: cancellationError(
          'VALIDATION',
          `unknown parent token '${parentTokenId}'`,
          'cancellation.register',
        ),
      };
    }
    if (!admitsWork(parent.state)) {
      // Registration is CLOSED after cancellation begins (D-15, NN-INV-012).
      return {
        ok: false,
        error: cancellationError(
          'CANCELLED',
          `parent token '${parentTokenId}' is '${parent.state}'; no new descendant is admitted after cancellation`,
          'cancellation.register',
        ),
      };
    }

    this.seq += 1;
    const tokenId =
      options.tokenId ??
      makeOpaqueId('cxl', `${this.rootId.replace(/[^a-z0-9]/g, '')}${this.seq}`);

    if (this.nodes.has(tokenId)) {
      return {
        ok: false,
        error: cancellationError(
          'CONFLICT',
          `token '${tokenId}' already registered`,
          'cancellation.register',
        ),
      };
    }

    // Child deadline cannot exceed the parent's (subset invariant).
    let deadlineAt = options.deadlineAt;
    if (parent.deadlineAt !== undefined) {
      deadlineAt =
        deadlineAt === undefined
          ? parent.deadlineAt
          : Math.min(deadlineAt, parent.deadlineAt);
    }

    this.nodes.set(tokenId, {
      tokenId,
      parentTokenId,
      kind: descendant.kind,
      descendant,
      state: 'active',
      deadlineAt,
      childIds: [],
      acknowledged: false,
      stopRequested: false,
    });
    parent.childIds.push(tokenId);
    return { ok: true, value: tokenId };
  }

  /**
   * Idempotently record a cooperative acknowledgement from `tokenId`. A
   * duplicate acknowledgement is a no-op (never a second effect,
   * CancellationToken@1 invariant). Acknowledging is only meaningful once
   * cancellation has been requested, but recording it early is harmless.
   */
  acknowledge(tokenId: string): CancellationOutcome<boolean> {
    const node = this.nodes.get(tokenId);
    if (!node) {
      return {
        ok: false,
        error: cancellationError(
          'VALIDATION',
          `unknown token '${tokenId}'`,
          'cancellation.acknowledge',
        ),
      };
    }
    if (node.acknowledged) {
      return { ok: true, value: false }; // idempotent no-op
    }
    node.acknowledged = true;
    return { ok: true, value: true };
  }

  /**
   * Attempt a post-terminal (or post-cancelling) emission/effect from
   * `tokenId`. Returns `ok` with the value only while the token still admits
   * work; once the token (or an ancestor) is cancelling/terminal the emission
   * is REJECTED with a typed `CANCELLED` and never becomes observable
   * (NN-INV-012, CD-012 "no post-terminal effect").
   */
  emit<T>(tokenId: string, produce: () => T): CancellationOutcome<T> {
    const node = this.nodes.get(tokenId);
    if (!node) {
      return {
        ok: false,
        error: cancellationError(
          'VALIDATION',
          `unknown token '${tokenId}'`,
          'cancellation.emit',
        ),
      };
    }
    if (!this.subtreeAdmitsWork(tokenId)) {
      return {
        ok: false,
        error: cancellationError(
          'CANCELLED',
          `token '${tokenId}' is cancelled/terminal; emission rejected (no post-terminal effect)`,
          'cancellation.emit',
        ),
      };
    }
    return { ok: true, value: produce() };
  }

  /** Whether `tokenId` and all its ancestors are `active`. */
  private subtreeAdmitsWork(tokenId: string): boolean {
    let cursor: string | undefined = tokenId;
    while (cursor !== undefined) {
      const node: TokenNode | undefined = this.nodes.get(cursor);
      if (!node || !admitsWork(node.state)) return false;
      cursor = node.parentTokenId;
    }
    return true;
  }

  /**
   * Cancel the whole tree from `tokenId` (default root — a "stop-all") and
   * converge to a truthful terminal result. Algorithm (NN-INV-012, D-15):
   *
   *   1. CLOSE registration by moving `tokenId` and every descendant to
   *      `cancelling` (no new descendant/effect is admitted from this instant).
   *   2. PROPAGATE a single cooperative `requestStop` to every descendant that
   *      owns a hook (idempotent; a hook error is swallowed and treated as
   *      "did not acknowledge").
   *   3. Wait a BOUNDED acknowledgement window: poll each descendant's truthful
   *      `isStopped`/acknowledgement up to `pollAttempts` times `pollIntervalMs`
   *      apart, until all acknowledged or the window/deadline elapses.
   *   4. For each descendant that did NOT acknowledge, invoke `forceTerminate`
   *      if present; classify it `forced` when confirmed stopped afterwards,
   *      else `survivor`. A descendant with no forced escalation and no
   *      acknowledgement is a `survivor`.
   *   5. Move acknowledged descendants to `terminated` and forced/survivor
   *      descendants to `forced`. The overall `result` is `terminated` ONLY when
   *      every descendant acknowledged; otherwise `forced-termination`, naming
   *      survivors — never claiming success while survivors remain.
   *
   * `sleep` is injected so the poll loop is deterministic in tests.
   */
  cancel(
    tokenId: string = this.rootId,
    options: {
      readonly reason?: string;
      readonly windowMs?: number;
      readonly pollIntervalMs?: number;
      readonly pollAttempts?: number;
      readonly sleep?: (ms: number) => void;
      readonly terminationId?: string;
    } = {},
  ): CancellationOutcome<TerminationResult> {
    const root = this.nodes.get(tokenId);
    if (!root) {
      return {
        ok: false,
        error: cancellationError(
          'VALIDATION',
          `unknown token '${tokenId}'`,
          'cancellation.cancel',
        ),
      };
    }

    const start = this.now();
    const reason = options.reason ?? 'cancellation requested';
    const windowMs = Math.max(0, options.windowMs ?? 100);
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 10);
    const pollAttempts = Math.max(1, options.pollAttempts ?? 8);
    const sleep = options.sleep ?? (() => {});

    // Collect the subtree (self + all descendants) in BFS order.
    const subtree = this.collectSubtree(tokenId);

    // (1) CLOSE registration: everything in the subtree becomes `cancelling`.
    for (const node of subtree) {
      if (admitsWork(node.state)) {
        node.state = 'cancelling';
        node.reason = reason;
      }
    }

    // (2) PROPAGATE the cooperative stop once per descendant (idempotent).
    for (const node of subtree) {
      if (!node.stopRequested && node.descendant?.requestStop) {
        node.stopRequested = true;
        try {
          node.descendant.requestStop();
        } catch {
          // A hook error is treated as "did not acknowledge"; never trusted.
        }
      }
    }

    // The descendants that carry an operation (exclude a pure `root` grouping
    // node unless it too owns a descendant hook).
    const owners = subtree.filter((n) => n.descendant !== undefined);
    const deadline =
      root.deadlineAt !== undefined
        ? Math.min(start + windowMs, root.deadlineAt)
        : start + windowMs;

    // (3) BOUNDED acknowledgement window.
    let attempt = 0;
    while (
      !owners.every((n) => this.observedStopped(n)) &&
      attempt < pollAttempts &&
      this.now() < deadline
    ) {
      sleep(pollIntervalMs);
      attempt += 1;
    }

    // (4)/(5) Classify each owner truthfully.
    const acknowledgedOwners: OwnerOutcome[] = [];
    const forcedOwners: OwnerOutcome[] = [];
    const forcedSurvivors: OwnerOutcome[] = [];

    for (const node of owners) {
      const outcome: OwnerOutcome = {
        tokenId: node.tokenId,
        kind: node.kind === 'root' ? 'background' : node.kind,
        disposition: 'acknowledged',
      };
      if (this.observedStopped(node)) {
        node.state = 'terminated';
        acknowledgedOwners.push(outcome);
        continue;
      }
      // Did not acknowledge within the window: escalate if possible.
      const force = node.descendant?.forceTerminate;
      if (force) {
        let confirmed = false;
        try {
          confirmed = force() === true;
        } catch {
          confirmed = false;
        }
        node.state = 'forced';
        // The forced adapter's own confirmation is the truthful stop evidence
        // (the descendant may have no cooperative `isStopped` probe).
        if (confirmed) {
          forcedOwners.push({ ...outcome, disposition: 'forced' });
        } else {
          forcedSurvivors.push({ ...outcome, disposition: 'survivor' });
        }
      } else {
        // No cooperative ack and no forced escalation: a survivor, never hidden.
        node.state = 'forced';
        forcedSurvivors.push({ ...outcome, disposition: 'survivor' });
      }
    }

    // Move the cancelled root/grouping node(s) to a terminal state too.
    const anyForced = forcedOwners.length > 0 || forcedSurvivors.length > 0;
    for (const node of subtree) {
      if (node.state === 'cancelling') {
        node.state = anyForced ? 'forced' : 'terminated';
      }
    }

    const allStopped = forcedSurvivors.length === 0;
    const result: TerminationResult = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      terminationId:
        options.terminationId ??
        makeOpaqueId('term', `${this.rootId.replace(/[^a-z0-9]/g, '')}${start}`),
      rootTokenId: tokenId,
      // `terminated` ONLY when nothing was forced AND no survivors.
      result: anyForced ? 'forced-termination' : 'terminated',
      acknowledgedOwners,
      forcedOwners,
      forcedSurvivors,
      allStopped,
      convergenceMs: this.now() - start,
      reason: anyForced
        ? forcedSurvivors.length > 0
          ? 'forced termination after bounded window; survivors named and not claimed stopped'
          : 'forced termination after bounded window; all descendants confirmed stopped'
        : 'all registered descendants acknowledged cooperatively within the bounded window',
    };
    return { ok: true, value: result };
  }

  /**
   * Whether a descendant is truthfully observed stopped: an idempotent
   * acknowledgement OR a truthful `isStopped` probe. A descendant with neither
   * is never assumed stopped (D-15 truthful termination) — only a confirmed
   * forced escalation can move it out of the survivor set.
   */
  private observedStopped(node: TokenNode): boolean {
    if (node.acknowledged) return true;
    const probe = node.descendant?.isStopped;
    if (probe) {
      try {
        return probe() === true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Collect `tokenId` plus all descendants in breadth-first order. */
  private collectSubtree(tokenId: string): TokenNode[] {
    const out: TokenNode[] = [];
    const queue = [tokenId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const node = this.nodes.get(id);
      if (!node) continue;
      out.push(node);
      queue.push(...node.childIds);
    }
    return out;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Process-tree descendant adapter (reuse 3.5 process-tree cancellation)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Adapt a spawned process tree (3.5 sandbox) into a {@link CooperativeDescendant}
 * for a process/pty subsystem. The forced escalation reuses
 * {@link SandboxExecutionManager.cancelTree} verbatim, so a process subtree's
 * bounded acknowledgement, forced kill, and survivor listing are identical to
 * the sandbox path (NN-INV-012, D-17). The last {@link CancellationResult} is
 * captured so survivors are never lost.
 */
export function processTreeDescendant(
  manager: SandboxExecutionManager,
  handle: ProcessTreeHandle,
  limits: ResourceLimits,
  options: {
    readonly kind?: Extract<DescendantKind, 'process' | 'pty'>;
    readonly livePids: (handle: ProcessTreeHandle) => readonly number[];
    readonly requestStop?: () => void;
    readonly cancelOptions?: {
      readonly pollIntervalMs?: number;
      readonly pollAttempts?: number;
      readonly sleep?: (ms: number) => void;
    };
  },
): CooperativeDescendant & { lastResult(): CancellationResult | undefined } {
  let last: CancellationResult | undefined;
  return {
    kind: options.kind ?? 'process',
    requestStop: options.requestStop,
    isStopped: () => options.livePids(handle).length === 0,
    forceTerminate: () => {
      last = manager.cancelTree(handle, limits, options.cancelOptions);
      return last.allStopped;
    },
    lastResult: () => last,
  };
}
