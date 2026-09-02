/**
 * IndexCoordinator — the single file-change authority for one workspace root
 * (FUT-PKG-07-EXPERIENCE/T-004, D-05 IndexCoordinator).
 *
 * D-05 / NN-INDEX-001 designate ONE Index Coordinator that consumes the
 * monotonic file-change sequence for a workspace root and fans out to the file
 * tree, text index, semantic embeddings, call graph, knowledge graph, context
 * map, and cache invalidation. Independent competing watchers are forbidden
 * (NN-INV-008 one owner per data class): caches, event streams, adapters,
 * legacy stores, and UI models MUST NOT become competing writers of the tree.
 *
 * This module implements that ownership as a cohesive coordinator so that, for
 * a given workspace root:
 *
 *   1. Exactly ONE filesystem watch exists per root, deduplicated: consumers
 *      subscribe to the coordinator's event stream instead of starting their
 *      own watcher (NN-INDEX-001, NN-INV-008). The active file tree is a
 *      *projection* derived from the sequence — never swapped by an independent
 *      watcher (NN-INDEX-012).
 *   2. Raw filesystem notifications (create/modify/delete/rename/permission)
 *      are debounced and collapsed, then assigned a strictly monotonic
 *      `sequence` within the root scope (NN-EVENT-003, NN-WORKSPACE-009). The
 *      emitted `FileChangeRecord` ordering is total and gap-free.
 *   3. Path normalization + exclusion (`.neuronestignore` / `.gitignore` /
 *      explicit private paths) is evaluated ONCE, before any consumer or the
 *      projection sees the change, through the Security Authority's `index`
 *      egress channel (NN-INDEX-002, NN-SEC-014). Excluded paths never enter
 *      the projection and never fan out.
 *   4. A deterministic, idempotent, rebuildable file-tree projection is derived
 *      from the ordered sequence (NN-EVENT-004): replaying the same records in
 *      order always yields the same tree, and the tree can be reconciled from
 *      disk after batches/final events (NN-INDEX-012, NN-WORKSPACE-009/010).
 *
 * The watcher backend is INJECTED (see {@link WatcherBackend}) so tests exercise
 * ordering, exclusion, and projection deterministically without depending on
 * real OS filesystem events; the default backend is a thin chokidar adapter for
 * production use. The coordinator itself performs no privileged I/O beyond the
 * projection reconciliation read it is asked to run.
 *
 * Migration/rollback (task rule): existing watchers route through this
 * coordinator as *consumers*; rollback returns a bounded read adapter, never an
 * independent watcher that swaps the tree store.
 *
 * Design anchors: D-03 (trust boundaries), D-05 (IndexCoordinator), D-08
 * (event/sequence), D-19/D-20 (observability, projections). Requirements:
 * NN-INDEX-001/002/012, NN-EVENT-003/004, NN-INV-008, NN-SEC-014,
 * NN-WORKSPACE-009/010, NN-UI file tree.
 */

import * as nodePath from 'node:path';

import {
  computeDigest,
  CONTRACT_WRITE_VERSION,
} from '../shared/contract-primitives.js';
import {
  evaluateExclusion,
  type ExclusionPolicy,
} from '../shared/security-authority.js';

// ─── Raw watcher backend (injectable) ───────────────────────────────────────

/**
 * The kind of raw filesystem notification a backend reports. These map to the
 * acceptance trigger set (create/modify/delete/rename/permission). `rename` is
 * modeled as a delete of the old path plus an add of the new path by the
 * backend, so the coordinator only has to reason about add/change/delete plus
 * a permission-only change.
 */
export type RawChangeKind = 'add' | 'change' | 'unlink' | 'permission';

/** A raw, un-normalized notification from the injected watcher backend. */
export interface RawFileEvent {
  /** Absolute path the backend observed. */
  readonly absolutePath: string;
  readonly kind: RawChangeKind;
  /** Whether the path is a directory (best-effort from the backend). */
  readonly isDirectory?: boolean;
}

/** Callback the coordinator registers with the backend. */
export type RawEventListener = (event: RawFileEvent) => void;

/**
 * A watcher backend owns the concrete OS watch for a single root. It is
 * injected so tests can drive deterministic event sequences and so exactly one
 * watch exists per root (the coordinator never instantiates more than one).
 */
export interface WatcherBackend {
  /** Begin watching `rootPath`, delivering raw events to `listener`. */
  start(rootPath: string, listener: RawEventListener): void;
  /** Stop watching and release all resources. Idempotent. */
  stop(): void;
}

// ─── Ordered file-change record (the monotonic sequence) ────────────────────

/**
 * The normalized change type after `rename` decomposition. `permission` is a
 * metadata-only change that keeps the node but marks it touched.
 */
export type FileChangeType = 'create' | 'modify' | 'delete' | 'permission';

/**
 * One record in the root-scoped monotonic file-change sequence
 * (NN-EVENT-003, NN-WORKSPACE-009). `sequence` is strictly increasing and
 * gap-free within a coordinator; `relativePath` is POSIX and root-relative and
 * is the only representation safe to surface (never the absolute path).
 */
export interface FileChangeRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  /** Strictly monotonic within this coordinator's root scope. */
  readonly sequence: number;
  readonly type: FileChangeType;
  /** POSIX path relative to the workspace root. */
  readonly relativePath: string;
  readonly isDirectory: boolean;
  /** Monotonic emit clock (ms). Ordering never depends on this value. */
  readonly occurredAt: number;
}

/** A subscriber to the ordered change stream (a fan-out consumer). */
export type ChangeConsumer = (record: FileChangeRecord) => void;

// ─── File-tree projection ────────────────────────────────────────────────────

/** A single node in the derived file-tree projection. */
export interface FileTreeNode {
  /** POSIX path relative to the workspace root (`''` is the root itself). */
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  /** Direct children keyed by name, sorted deterministically on read. */
  readonly children: ReadonlyMap<string, FileTreeNode>;
}

/**
 * A snapshot of the file-tree projection at a given sequence. `revision`
 * equals the sequence of the last applied record (NN-EVENT-004 revision-label);
 * `digest` is a canonical content hash of the ordered path set so two replays
 * that produce the same tree produce the same digest (determinism proof).
 */
export interface FileTreeProjection {
  readonly root: FileTreeNode;
  readonly revision: number;
  readonly digest: string;
  /** Sorted list of all node paths (excluding the root). Deterministic. */
  readonly paths: readonly string[];
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface IndexCoordinatorOptions {
  /** The resolved, explicit workspace root (NN-WORKSPACE-001). */
  readonly rootPath: string;
  /** The injected watcher backend that owns the single OS watch. */
  readonly backend: WatcherBackend;
  /**
   * Exclusion policy applied ONCE before fan-out/projection (NN-INDEX-002,
   * NN-SEC-014). Defaults to an empty policy (nothing excluded) if omitted.
   */
  readonly exclusion?: ExclusionPolicy;
  /**
   * Debounce window (ms) for collapsing rapid same-path modifications
   * (NN-WORKSPACE-010 batching ≤ 200 ms). Default 200. A value of 0 disables
   * debouncing (each raw event emits immediately) — useful for tests.
   */
  readonly debounceMs?: number;
  /** Injectable timers so tests need no real wall-clock. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Injectable monotonic clock (ms) for `occurredAt`. Default Date.now. */
  readonly now?: () => number;
  /** Correlation id threaded into exclusion decisions. */
  readonly correlationId?: string;
}

const EMPTY_EXCLUSION: ExclusionPolicy = { patterns: [], privatePaths: [] };
const DEFAULT_DEBOUNCE_MS = 200;

/** The coordinator owner id stamped on decisions/telemetry. */
export const INDEX_COORDINATOR_OWNER = 'authority-index-coordinator';

// ─── The coordinator ─────────────────────────────────────────────────────────

/**
 * The single file-change coordinator for one workspace root. Instantiate one
 * per resolved root; do NOT create competing watchers elsewhere.
 */
export class IndexCoordinator {
  private readonly rootPath: string;
  private readonly backend: WatcherBackend;
  private readonly exclusion: ExclusionPolicy;
  private readonly debounceMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly now: () => number;
  private readonly correlationId: string;

  /** Strictly monotonic sequence counter (NN-EVENT-003). */
  private sequence = 0;
  /** The ordered, exclusion-filtered change log (the authoritative sequence). */
  private readonly log: FileChangeRecord[] = [];
  /** Fan-out consumers (NN-INDEX-001: subscribe, do not watch). */
  private readonly consumers = new Set<ChangeConsumer>();
  /** Pending debounce timers keyed by relative path. */
  private readonly pending = new Map<
    string,
    { handle: ReturnType<typeof setTimeout>; type: FileChangeType; isDirectory: boolean }
  >();

  private started = false;
  private disposed = false;

  constructor(options: IndexCoordinatorOptions) {
    this.rootPath = nodePath.resolve(options.rootPath);
    this.backend = options.backend;
    this.exclusion = options.exclusion ?? EMPTY_EXCLUSION;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.now = options.now ?? (() => Date.now());
    this.correlationId = options.correlationId ?? 'corr-index-coordinator';
  }

  /**
   * Begin owning the single watch for this root. Idempotent: a second call has
   * no effect (there is never more than one backend watch per coordinator).
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.backend.start(this.rootPath, (raw) => this.onRawEvent(raw));
  }

  /**
   * Subscribe a fan-out consumer to the ordered change stream. Consumers MUST
   * use this instead of starting their own watcher (NN-INDEX-001, NN-INV-008).
   * Returns an unsubscribe function.
   */
  subscribe(consumer: ChangeConsumer): () => void {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }

  /** Number of active fan-out consumers (observability/tests). */
  get consumerCount(): number {
    return this.consumers.size;
  }

  /** The last assigned sequence value (0 before any change). */
  get lastSequence(): number {
    return this.sequence;
  }

  /** A copy of the ordered change log (NN-EVENT-004 replayable source). */
  get changeLog(): readonly FileChangeRecord[] {
    return this.log.slice();
  }

  /**
   * Flush any pending debounced events immediately (e.g. before reading a
   * final projection in a test or on a "final reconciliation" boundary,
   * NN-WORKSPACE-010). Emits collapsed records in path order.
   */
  flush(): void {
    if (this.pending.size === 0) return;
    // Emit in a stable order so a flush is itself deterministic.
    const entries = [...this.pending.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [relativePath, entry] of entries) {
      this.clearTimeoutFn(entry.handle);
      this.pending.delete(relativePath);
      this.commit(relativePath, entry.type, entry.isDirectory);
    }
  }

  /**
   * Stop the watch, cancel pending debounces, and drop consumers. Idempotent.
   * Rollback semantics (task rule) return a bounded read adapter elsewhere; the
   * coordinator never leaves a competing watcher running after dispose.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) this.clearTimeoutFn(entry.handle);
    this.pending.clear();
    this.consumers.clear();
    this.backend.stop();
  }

  /**
   * Derive the deterministic file-tree projection from the ordered change log
   * (NN-EVENT-004: deterministic, idempotent, rebuildable, revision-labeled).
   * The tree is rebuilt by folding the log in sequence order, so the same log
   * always yields the same projection. Pending debounced events are NOT
   * included until flushed; call {@link flush} first for a settled view.
   */
  projectFileTree(): FileTreeProjection {
    // Set of live relative paths after applying create/delete in order.
    const live = new Map<string, { isDirectory: boolean }>();
    let revision = 0;
    for (const record of this.log) {
      revision = record.sequence;
      switch (record.type) {
        case 'create':
        case 'modify':
        case 'permission':
          // create/modify/permission keep (or introduce) the node.
          live.set(record.relativePath, { isDirectory: record.isDirectory });
          break;
        case 'delete':
          // Delete the node and any descendants (delete-all semantics,
          // NN-INDEX-012 reconcile deletions from disk).
          this.deleteSubtree(live, record.relativePath);
          break;
      }
    }

    const paths = [...live.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const root = this.buildTree(paths, live);
    // Canonical digest of the ordered path set + directory bits: two replays
    // that yield the same tree yield the same digest (determinism proof).
    const digest = computeDigest(paths.map((p) => `${live.get(p)!.isDirectory ? 'd' : 'f'}:${p}`));
    return { root, revision, digest, paths };
  }

  // ─── Internal: raw → normalized → ordered ──────────────────────────────────

  /**
   * Handle one raw backend event: normalize its path, run exclusion ONCE
   * (NN-INDEX-002/NN-SEC-014) BEFORE anything else sees it, map it to a
   * normalized change type, then debounce-collapse or commit it.
   */
  private onRawEvent(raw: RawFileEvent): void {
    if (this.disposed) return;

    const relativePath = this.toRelative(raw.absolutePath);
    // A path outside the root (defensive) is ignored: it never belongs to this
    // root's sequence (NN-WORKSPACE-009 "ignore events for other projects").
    if (relativePath === null) return;

    // EXCLUSION BEFORE FAN-OUT / PROJECTION (NN-INDEX-002, NN-SEC-014). The
    // `index` egress channel gate runs before the change enters the log, the
    // projection, or any consumer. Excluded paths are dropped silently.
    const decision = evaluateExclusion(relativePath, 'index', this.exclusion, {
      correlationId: this.correlationId,
      operation: 'index:file-change',
    });
    if (decision.decision !== 'allow') return;

    const isDirectory = raw.isDirectory ?? false;
    const type = normalizeChangeType(raw.kind);

    if (this.debounceMs <= 0) {
      this.commit(relativePath, type, isDirectory);
      return;
    }

    // Debounce-collapse rapid events on the same path (NN-WORKSPACE-010). A
    // delete supersedes any pending create/modify for the same path; otherwise
    // the latest non-delete type wins.
    const existing = this.pending.get(relativePath);
    if (existing) {
      this.clearTimeoutFn(existing.handle);
    }
    const collapsedType = collapseType(existing?.type, type);
    const handle = this.setTimeoutFn(() => {
      const entry = this.pending.get(relativePath);
      if (!entry) return;
      this.pending.delete(relativePath);
      this.commit(relativePath, entry.type, entry.isDirectory);
    }, this.debounceMs);
    this.pending.set(relativePath, { handle, type: collapsedType, isDirectory });
  }

  /**
   * Append a normalized change to the ordered sequence with a fresh monotonic
   * `sequence`, then fan out to consumers in subscription order. This is the
   * only place a sequence number is assigned (NN-EVENT-003 single owner of
   * ordering).
   */
  private commit(relativePath: string, type: FileChangeType, isDirectory: boolean): void {
    this.sequence += 1;
    const record: FileChangeRecord = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      sequence: this.sequence,
      type,
      relativePath,
      isDirectory,
      occurredAt: this.now(),
    };
    this.log.push(record);
    for (const consumer of this.consumers) {
      consumer(record);
    }
  }

  /**
   * Normalize an absolute path to a POSIX root-relative path, or `null` if it
   * escapes the root. Uses segment-wise containment, never a string prefix.
   */
  private toRelative(absolutePath: string): string | null {
    const resolved = nodePath.resolve(absolutePath);
    const rel = nodePath.relative(this.rootPath, resolved);
    if (rel === '') return null; // the root itself is not a change node
    if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
      return null;
    }
    return rel.split(nodePath.sep).join('/');
  }

  /** Remove a path and all of its descendants from the live set. */
  private deleteSubtree(live: Map<string, { isDirectory: boolean }>, prefix: string): void {
    live.delete(prefix);
    const dirPrefix = `${prefix}/`;
    for (const key of [...live.keys()]) {
      if (key.startsWith(dirPrefix)) live.delete(key);
    }
  }

  /**
   * Build a nested tree from a sorted list of relative paths. Intermediate
   * directory nodes are synthesized so a file at `a/b/c.txt` yields `a` and
   * `a/b` directory nodes even if no explicit create was recorded for them.
   */
  private buildTree(
    paths: readonly string[],
    live: Map<string, { isDirectory: boolean }>,
  ): FileTreeNode {
    const rootChildren = new Map<string, MutableTreeNode>();
    const rootNode: MutableTreeNode = {
      path: '',
      name: '',
      isDirectory: true,
      children: rootChildren,
    };

    for (const p of paths) {
      const segments = p.split('/');
      let cursor = rootNode;
      let accum = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        accum = accum === '' ? seg : `${accum}/${seg}`;
        const isLast = i === segments.length - 1;
        const isDir = isLast ? (live.get(p)?.isDirectory ?? false) : true;
        let child = cursor.children.get(seg);
        if (!child) {
          child = { path: accum, name: seg, isDirectory: isDir, children: new Map() };
          cursor.children.set(seg, child);
        } else if (isDir) {
          // An intermediate segment is always a directory.
          child.isDirectory = true;
        }
        cursor = child;
      }
    }

    return freezeNode(rootNode);
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

interface MutableTreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children: Map<string, MutableTreeNode>;
}

/** Recursively convert a mutable node into a sorted, immutable projection node. */
function freezeNode(node: MutableTreeNode): FileTreeNode {
  const sortedChildren = new Map<string, FileTreeNode>();
  const names = [...node.children.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    sortedChildren.set(name, freezeNode(node.children.get(name)!));
  }
  return {
    path: node.path,
    name: node.name,
    isDirectory: node.isDirectory,
    children: sortedChildren,
  };
}

/** Map a raw backend change kind to a normalized change type. */
export function normalizeChangeType(kind: RawChangeKind): FileChangeType {
  switch (kind) {
    case 'add':
      return 'create';
    case 'change':
      return 'modify';
    case 'unlink':
      return 'delete';
    case 'permission':
      return 'permission';
  }
}

/**
 * Collapse a pending change type with an incoming one during debouncing. A
 * delete always wins (the node is going away); a create followed by a modify
 * stays a create (the node is still new); otherwise the incoming type wins.
 */
export function collapseType(
  pending: FileChangeType | undefined,
  incoming: FileChangeType,
): FileChangeType {
  if (pending === undefined) return incoming;
  if (incoming === 'delete' || pending === 'delete') return 'delete';
  if (pending === 'create') return 'create';
  return incoming;
}
