/**
 * IndexProjectionService — atomic index generations for text search, code
 * graph, context map, and local knowledge (FUT-PKG-07-EXPERIENCE/T-005,
 * D-05 IndexKnowledge / IndexCoordinator).
 *
 * D-05 designates ONE Index Coordinator (see {@link ../index/index-coordinator})
 * that owns the monotonic, exclusion-filtered file-change sequence for a
 * workspace root and fans out to the derived indexes: file tree, text search,
 * code/knowledge graph, context map, semantic embeddings, and local knowledge.
 * This module implements those derived indexes as DETERMINISTIC PROJECTIONS
 * over that ordered {@link FileChangeRecord} sequence, each carrying:
 *
 *   1. a monotonic *source sequence* range (`fromSequence..toSequence`) that
 *      records exactly which coordinator sequences the generation folded
 *      (NN-EVENT-003/004, NN-INDEX-001);
 *   2. exactly ONE active atomic generation per (index, provider fingerprint)
 *      plus a content fingerprint over the ordered derived entries
 *      (NN-INDEX-003/004, NN-DATA-005 atomic generation promotion);
 *   3. exclusion INHERITED by construction: a generation is built only from the
 *      records the coordinator already passed through its `index` egress gate,
 *      so an excluded path never appears in any derived embedding/cache/graph/
 *      knowledge entry (NN-INDEX-002, NN-SEC-014);
 *   4. queued deltas: change records that arrive while a generation build is in
 *      flight are queued and folded into the NEXT build, never into the frozen
 *      in-flight generation (NN-INDEX-004);
 *   5. beside-active build + atomic swap + crash-before-swap safety: a new
 *      generation is materialized beside the active one and only becomes active
 *      on an explicit atomic swap, so a crash before the swap leaves the prior
 *      generation active (NN-INDEX-004 "Failure leaves the prior generation
 *      active"); and
 *   6. provider-swap handling: an embedding/provider change rebuilds a new
 *      generation tagged with the new provider fingerprint and swaps it
 *      atomically; stale-provider entries never mix with the current generation
 *      (NN-INDEX-006 "provider change schedules a new generation").
 *
 * This mirrors the beside-active generation-swap + rollback-retention pattern
 * of {@link ../storage/projection-service} (D-08.3), but the *source* here is
 * the coordinator's file-change sequence rather than the committed outbox, and
 * the derived state is a rebuildable read model that is never authority
 * (NN-DATA-009). The projections are pure functions of the ordered change
 * records + the provider fingerprint, so replaying the same records with the
 * same provider always yields the same derived entries and the same content
 * fingerprint (determinism / idempotency / rebuildability, NN-EVENT-004).
 *
 * Rollback (task rule): a rollback reselects a prior retained generation +
 * fingerprint; it never restores a second independent index writer.
 *
 * Design anchors: D-03 (trust boundaries), D-05 (IndexCoordinator/IndexKnowledge),
 * D-08 (generation swap), D-19/D-20 (observability, projections). Requirements:
 * NN-INDEX-001..012, NN-KNOWLEDGE-001..004, NN-EVENT-003/004, NN-SEC-014,
 * NN-DATA-005/009.
 */

import {
  computeDigest,
  CONTRACT_WRITE_VERSION,
} from '../shared/contract-primitives.js';
import type { FileChangeRecord } from './index-coordinator.js';

// ─── Index kinds (the derived projections a generation covers) ───────────────

/**
 * The derived index projections a generation materializes. Each is a
 * deterministic fold over the same ordered change sequence:
 *   - `text-search` — a lexical entry per live file path;
 *   - `code-graph`  — typed nodes + import/containment edges over live files;
 *   - `context-map` — a directory→member context grouping over live files;
 *   - `local-knowledge` — a local knowledge entry per live document path.
 */
export const INDEX_KINDS = Object.freeze([
  'text-search',
  'code-graph',
  'context-map',
  'local-knowledge',
] as const);
export type IndexKind = (typeof INDEX_KINDS)[number];

// ─── Provider fingerprint (NN-INDEX-003/006) ─────────────────────────────────

/**
 * A pluggable provider/model fingerprint that a generation is keyed by. A
 * provider swap (embedding model change, chunker version bump) changes this
 * fingerprint, which schedules a NEW generation; stale-provider entries never
 * mix with the current generation (NN-INDEX-003/006).
 */
export interface ProviderFingerprint {
  /** Stable provider id, e.g. `local-lexical` or `onnx-minilm`. */
  readonly providerId: string;
  /** Provider/model version so a version bump is a distinct fingerprint. */
  readonly version: string;
  /** Chunker/schema version folded into the fingerprint. */
  readonly chunkerVersion?: string;
}

/** Canonical fingerprint digest — the value a generation is tagged with. */
export function fingerprintDigest(fp: ProviderFingerprint): string {
  return computeDigest({
    providerId: fp.providerId,
    version: fp.version,
    chunkerVersion: fp.chunkerVersion ?? '',
  });
}

// ─── Derived entry + generation (the atomic projection unit) ─────────────────

/**
 * One derived index entry. `key` is the stable derived key (e.g. a file path or
 * a `from->to` edge id); `payload` is the deterministic derived value. Entries
 * are always produced in a canonical (sorted-by-key) order so the generation
 * fingerprint is stable across replays (NN-EVENT-004).
 */
export interface DerivedEntry {
  readonly kind: IndexKind;
  readonly key: string;
  readonly payload: unknown;
}

/**
 * An atomic index generation: a frozen, deterministic projection of the ordered
 * change sequence for one index kind under one provider fingerprint. The
 * generation records the monotonic source-sequence range it folded and a
 * content fingerprint over its ordered entries (NN-INDEX-003/004, NN-DATA-005).
 */
export interface IndexGeneration {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly kind: IndexKind;
  /** Monotonic generation number within (kind); increases on every build. */
  readonly generation: number;
  /** The provider fingerprint this generation was built under. */
  readonly providerFingerprint: string;
  /** The lowest source sequence folded (0 if empty). */
  readonly fromSequence: number;
  /** The highest source sequence folded (0 if empty) — monotonic. */
  readonly toSequence: number;
  /** The derived entries, canonically ordered by key. */
  readonly entries: readonly DerivedEntry[];
  /** Content fingerprint over (providerFingerprint, ordered entries). */
  readonly contentFingerprint: string;
  /** Whether the generation is currently the active reader. */
  readonly active: boolean;
}

// ─── Deterministic reducers (pure: records + fingerprint → entries) ──────────

/**
 * A pure derived-index reducer: fold the ordered, exclusion-filtered change
 * records into the canonical entry set for one index kind under a provider
 * fingerprint. It MUST be a pure function of `(records, fingerprint)` — no I/O,
 * no clock, no randomness — so the same inputs always yield the same ordered
 * entries and the same content fingerprint (NN-EVENT-004).
 */
export type DerivedReducer = (
  records: readonly FileChangeRecord[],
  fingerprint: ProviderFingerprint,
) => DerivedEntry[];

/**
 * Fold the change sequence into the set of LIVE (non-deleted) file paths in
 * source order. create/modify/permission introduce/keep a path; delete removes
 * the path and every descendant (delete-all subtree semantics, matching the
 * coordinator's file-tree projection, NN-INDEX-012). The result is the shared
 * substrate every derived reducer projects from — because it is derived only
 * from records that already passed the coordinator's exclusion gate, no
 * excluded path can ever appear (exclusion inheritance, NN-SEC-014).
 */
export function foldLivePaths(
  records: readonly FileChangeRecord[],
): { path: string; isDirectory: boolean }[] {
  const live = new Map<string, boolean>();
  for (const record of records) {
    switch (record.type) {
      case 'create':
      case 'modify':
      case 'permission':
        live.set(record.relativePath, record.isDirectory);
        break;
      case 'delete': {
        live.delete(record.relativePath);
        const dirPrefix = `${record.relativePath}/`;
        for (const key of [...live.keys()]) {
          if (key.startsWith(dirPrefix)) live.delete(key);
        }
        break;
      }
    }
  }
  return [...live.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, isDirectory: live.get(path)! }));
}

/** Whether a path looks like source code the graph/context reducers index. */
function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|rb|cs)$/.test(path);
}

/** Text-search reducer: one lexical entry per live file (NN-INDEX-007). */
const reduceTextSearch: DerivedReducer = (records, fingerprint) => {
  return foldLivePaths(records)
    .filter((n) => !n.isDirectory)
    .map((n) => ({
      kind: 'text-search' as const,
      key: n.path,
      payload: {
        path: n.path,
        // The lexical token is provider-independent, but the entry is still
        // tagged with the fingerprint so a provider swap yields a new digest.
        provider: fingerprint.providerId,
      },
    }));
};

/**
 * Code-graph reducer: a typed node per live source file plus containment edges
 * from each file to its parent directory node (NN-INDEX-008 typed stable
 * nodes/edges, no dangling/duplicate effective relationships). Edges are keyed
 * `edge:<from>-><to>` so a duplicate effective relationship is impossible (a
 * Map dedupes by key).
 */
const reduceCodeGraph: DerivedReducer = (records) => {
  const nodes = new Map<string, DerivedEntry>();
  const edges = new Map<string, DerivedEntry>();
  for (const n of foldLivePaths(records)) {
    if (n.isDirectory) continue;
    if (!isSourceFile(n.path)) continue;
    nodes.set(n.path, {
      kind: 'code-graph',
      key: `node:${n.path}`,
      payload: { type: 'file', path: n.path },
    });
    const slash = n.path.lastIndexOf('/');
    if (slash >= 0) {
      const parent = n.path.slice(0, slash);
      const edgeKey = `edge:${n.path}->${parent}`;
      edges.set(edgeKey, {
        kind: 'code-graph',
        key: edgeKey,
        payload: { type: 'contained-by', from: n.path, to: parent },
      });
    }
  }
  return [...nodes.values(), ...edges.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
};

/**
 * Context-map reducer: group live source files by their parent directory into a
 * deterministic context membership entry per directory (NN-INDEX-001 context
 * map fan-out). Members are sorted so the entry payload is canonical.
 */
const reduceContextMap: DerivedReducer = (records) => {
  const groups = new Map<string, string[]>();
  for (const n of foldLivePaths(records)) {
    if (n.isDirectory) continue;
    const slash = n.path.lastIndexOf('/');
    const dir = slash >= 0 ? n.path.slice(0, slash) : '';
    const members = groups.get(dir) ?? [];
    members.push(n.path);
    groups.set(dir, members);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir, members]) => ({
      kind: 'context-map' as const,
      key: `context:${dir}`,
      payload: { directory: dir, members: members.slice().sort() },
    }));
};

/** File extensions the local-knowledge connector ingests (NN-KNOWLEDGE-001/002). */
function isKnowledgeDoc(path: string): boolean {
  return /\.(md|markdown|txt|rst|pdf|adoc)$/.test(path);
}

/**
 * Local-knowledge reducer: one local knowledge entry per live document path
 * (NN-KNOWLEDGE-001/002 file connector + ingest). Only local file documents are
 * ingested here; the entry is tagged with the provider fingerprint so a
 * provider/embedding swap schedules a fresh generation.
 */
const reduceLocalKnowledge: DerivedReducer = (records, fingerprint) => {
  return foldLivePaths(records)
    .filter((n) => !n.isDirectory && isKnowledgeDoc(n.path))
    .map((n) => ({
      kind: 'local-knowledge' as const,
      key: n.path,
      payload: { source: 'file', uri: n.path, provider: fingerprint.providerId },
    }));
};

/** The reducer registry keyed by index kind. */
export const DERIVED_REDUCERS: Readonly<Record<IndexKind, DerivedReducer>> =
  Object.freeze({
    'text-search': reduceTextSearch,
    'code-graph': reduceCodeGraph,
    'context-map': reduceContextMap,
    'local-knowledge': reduceLocalKnowledge,
  });

// ─── Pure generation build (beside active; touches no active state) ──────────

/**
 * Build a candidate generation for one index kind from an ordered change
 * sequence under a provider fingerprint. Pure: it derives entries, records the
 * monotonic source-sequence range, and computes a content fingerprint over the
 * ordered entries + provider fingerprint. It never mutates any active
 * generation, so it is the "build beside active" step (NN-INDEX-004).
 */
export function buildGeneration(
  kind: IndexKind,
  records: readonly FileChangeRecord[],
  fingerprint: ProviderFingerprint,
  generation: number,
): IndexGeneration {
  // Records are consumed in source-sequence order regardless of arrival order.
  const ordered = records
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const providerFingerprint = fingerprintDigest(fingerprint);
  const entries = DERIVED_REDUCERS[kind](ordered, fingerprint).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const fromSequence = ordered.length > 0 ? ordered[0]!.sequence : 0;
  const toSequence = ordered.length > 0 ? ordered[ordered.length - 1]!.sequence : 0;
  const contentFingerprint = computeDigest({
    kind,
    providerFingerprint,
    entries: entries.map((e) => [e.key, e.payload]),
  });
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    kind,
    generation,
    providerFingerprint,
    fromSequence,
    toSequence,
    entries,
    contentFingerprint,
    active: false,
  };
}

// ─── The atomic index projection service (one per workspace root) ────────────

/** The outcome of a rebuild + atomic swap for one index kind. */
export interface RebuildResult {
  readonly kind: IndexKind;
  /** The newly built candidate generation number. */
  readonly builtGeneration: number;
  /** The generation active before this rebuild (0 if none). */
  readonly priorActiveGeneration: number;
  /** Whether the new generation was atomically swapped active. */
  readonly swapped: boolean;
  readonly contentFingerprint: string;
  readonly fromSequence: number;
  readonly toSequence: number;
}

/**
 * The single atomic index projection authority for one workspace root. It holds
 * the ordered, exclusion-filtered change records it has consumed from the
 * coordinator (its source), the queued deltas that arrived during an in-flight
 * build, and — per (index kind) — the retained generations plus which one is
 * active. Exactly one generation per kind is active at any time; a crash before
 * a swap leaves the prior generation active because a candidate is only
 * activated by an explicit, all-or-nothing {@link swap}.
 */
export class IndexProjectionService {
  /** The consumed source records (already exclusion-filtered by construction). */
  private readonly source: FileChangeRecord[] = [];
  /** Deltas queued while a build is in flight; folded into the next build. */
  private readonly queued: FileChangeRecord[] = [];
  private buildInFlight = false;

  /** Retained generations per kind (rollback candidates), by generation no. */
  private readonly generations = new Map<IndexKind, Map<number, IndexGeneration>>();
  /** The active generation number per kind (undefined until first swap). */
  private readonly activeGeneration = new Map<IndexKind, number>();
  /** The next generation number to allocate per kind. */
  private readonly nextGeneration = new Map<IndexKind, number>();

  /** The current provider fingerprint (a swap of this schedules a rebuild). */
  private provider: ProviderFingerprint;

  constructor(options: { readonly provider: ProviderFingerprint }) {
    this.provider = options.provider;
    for (const kind of INDEX_KINDS) {
      this.generations.set(kind, new Map());
      this.nextGeneration.set(kind, 1);
    }
  }

  /** The active provider fingerprint digest. */
  get providerFingerprint(): string {
    return fingerprintDigest(this.provider);
  }

  /**
   * Consume one ordered change record from the coordinator. When a build is in
   * flight the record is QUEUED and applied to the next build; otherwise it
   * enters the source immediately. Records arrive already exclusion-filtered
   * (the coordinator gated them before fan-out), so exclusion is inherited —
   * this service never re-admits an excluded path (NN-INDEX-002, NN-SEC-014).
   */
  consume(record: FileChangeRecord): void {
    if (this.buildInFlight) {
      this.queued.push(record);
      return;
    }
    this.source.push(record);
  }

  /** Number of records queued while a build is in flight. */
  get queuedCount(): number {
    return this.queued.length;
  }

  /** A copy of the consumed source records (source-sequence order). */
  get sourceRecords(): readonly FileChangeRecord[] {
    return this.source.slice().sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Begin an in-flight build for a kind: build the candidate generation beside
   * the active one from the CURRENT source (queued deltas are held back for the
   * next build). Returns the frozen candidate. This models "build a new
   * generation beside active" — the active generation is untouched, and if the
   * process crashes before {@link swap}, the prior generation stays active
   * (NN-INDEX-004). Call {@link swap} to atomically activate the candidate.
   */
  beginBuild(kind: IndexKind): IndexGeneration {
    this.buildInFlight = true;
    const generation = this.nextGeneration.get(kind)!;
    const candidate = buildGeneration(kind, this.source, this.provider, generation);
    this.generations.get(kind)!.set(generation, candidate);
    this.nextGeneration.set(kind, generation + 1);
    return candidate;
  }

  /**
   * Atomically activate a previously built candidate generation for a kind and
   * end the in-flight build, draining any queued deltas into the source so the
   * NEXT build folds them (NN-INDEX-004 queued deltas). Deactivating the prior
   * active and activating the candidate is a single in-memory swap: there is no
   * observable intermediate state where two generations are active or none is.
   */
  swap(kind: IndexKind, generation: number): void {
    const gens = this.generations.get(kind)!;
    const candidate = gens.get(generation);
    if (!candidate) {
      throw new Error(`swap: generation ${generation} for ${kind} does not exist`);
    }
    const prior = this.activeGeneration.get(kind);
    if (prior !== undefined) {
      const priorGen = gens.get(prior);
      if (priorGen) gens.set(prior, { ...priorGen, active: false });
    }
    gens.set(generation, { ...candidate, active: true });
    this.activeGeneration.set(kind, generation);
    // The build is complete: drain queued deltas into the source for next time.
    this.drainQueue();
  }

  /**
   * Build a candidate and atomically swap it active in one call — the common
   * path when there is no need to observe the beside-active window. Queued
   * deltas that arrived during the build are folded into the next build.
   */
  rebuild(kind: IndexKind): RebuildResult {
    const priorActive = this.activeGeneration.get(kind) ?? 0;
    const candidate = this.beginBuild(kind);
    this.swap(kind, candidate.generation);
    return {
      kind,
      builtGeneration: candidate.generation,
      priorActiveGeneration: priorActive,
      swapped: true,
      contentFingerprint: candidate.contentFingerprint,
      fromSequence: candidate.fromSequence,
      toSequence: candidate.toSequence,
    };
  }

  /**
   * Simulate a crash before the swap: the in-flight candidate is discarded and
   * queued deltas are preserved as still-queued. The prior active generation is
   * unchanged — it remains the active reader (NN-INDEX-004 "Failure leaves the
   * prior generation active"). Used to prove crash-before-swap safety.
   */
  abandonBuild(kind: IndexKind): void {
    if (!this.buildInFlight) return;
    // Drop the most-recently allocated (not-yet-swapped) candidate generation.
    const gens = this.generations.get(kind)!;
    const active = this.activeGeneration.get(kind);
    const next = this.nextGeneration.get(kind)!;
    const abandoned = next - 1;
    if (abandoned !== active && gens.has(abandoned)) {
      gens.delete(abandoned);
      this.nextGeneration.set(kind, abandoned);
    }
    this.buildInFlight = false;
    // Queued deltas remain queued (they were never applied).
  }

  /**
   * Swap the provider fingerprint and rebuild every index kind under the new
   * fingerprint, atomically activating each new generation. Stale-provider
   * generations are retained as rollback candidates but are no longer active,
   * so stale-provider entries never mix with the current generation
   * (NN-INDEX-006 "provider change schedules a new generation").
   */
  swapProvider(next: ProviderFingerprint): RebuildResult[] {
    this.provider = next;
    return INDEX_KINDS.map((kind) => this.rebuild(kind));
  }

  /**
   * Roll back the active reader for a kind to a prior retained generation. Only
   * reselects which retained generation is active; it never restores a second
   * index writer (task rollback). The target must still be retained.
   */
  rollback(kind: IndexKind, targetGeneration: number): void {
    const gens = this.generations.get(kind)!;
    if (!gens.has(targetGeneration)) {
      throw new Error(
        `rollback: generation ${targetGeneration} for ${kind} is not retained`,
      );
    }
    const prior = this.activeGeneration.get(kind);
    if (prior !== undefined && prior !== targetGeneration) {
      const priorGen = gens.get(prior);
      if (priorGen) gens.set(prior, { ...priorGen, active: false });
    }
    const target = gens.get(targetGeneration)!;
    gens.set(targetGeneration, { ...target, active: true });
    this.activeGeneration.set(kind, targetGeneration);
  }

  /** The active generation for a kind, or undefined if none is active. */
  active(kind: IndexKind): IndexGeneration | undefined {
    const gen = this.activeGeneration.get(kind);
    if (gen === undefined) return undefined;
    return this.generations.get(kind)!.get(gen);
  }

  /** A retained generation for a kind by number (rollback candidate). */
  generationAt(kind: IndexKind, generation: number): IndexGeneration | undefined {
    return this.generations.get(kind)!.get(generation);
  }

  /** Every retained generation number for a kind, ascending. */
  retainedGenerations(kind: IndexKind): number[] {
    return [...this.generations.get(kind)!.keys()].sort((a, b) => a - b);
  }

  /** Move queued deltas into the source in source-sequence order. */
  private drainQueue(): void {
    if (this.queued.length === 0) {
      this.buildInFlight = false;
      return;
    }
    for (const record of this.queued) this.source.push(record);
    this.queued.length = 0;
    this.buildInFlight = false;
  }
}

/** The authority id that owns the atomic index projection service. */
export const INDEX_PROJECTION_OWNER = 'authority-index-coordinator';
