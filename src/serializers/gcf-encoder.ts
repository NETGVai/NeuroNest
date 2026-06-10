/**
 * GCF_Encoder — F10 GCF_Wire_Format.
 *
 * A thin TypeScript wrapper around the `@blackwell-systems/gcf` library that
 * gives every NeuroNest call site one consistent encoding API with clear,
 * non-throwing failure semantics. The library implements GCF (Graph Compact
 * Format) — a token-optimized wire format for LLM tool responses.
 *
 * v1.0.0 header format: all GCF payloads start with a mandatory header line:
 *   - Graph profile: `GCF profile=graph tool=<toolName>`
 *   - Generic profile: `GCF profile=generic`
 * The old `GCF tool=...` header (without profile=) is no longer valid.
 *
 * LLM primer (inject into system prompt when GCF is active):
 *   GCF format: header starts with "GCF profile=graph tool=", symbols are
 *   @id kind qname score provenance, edges are @target<@source type (< not >),
 *   sections are ## targets/related/extended/edges. Kind abbreviations:
 *   function=fn, type=type, method=method, interface=iface.
 *
 * Failure contract: `encodeGraph` and `encodeGeneric` NEVER throw. Any error
 * raised by the underlying library (or by payload mapping) is swallowed and
 * `null` is returned, so call sites can fall back to JSON deterministically
 * (Requirement 51.4).
 *
 * Purity contract: when invoked WITHOUT a `sessionId` and WITHOUT a
 * `previousPayload`, the encoder is a pure function of its payload argument —
 * no I/O, no clock, no RNG, no observable mutation (Requirement 51.5). Session
 * deduplication (Requirement 52, task 38.2) and delta encoding (Requirement 53,
 * task 38.3) are the only stateful paths and are opt-in via explicit `opts`.
 * Those tasks extend this file by branching on `opts.sessionId` /
 * `opts.previousPayload` at the marked extension point below.
 *
 * Session dedup (task 38.2 / Requirement 52) is implemented here on top of the
 * library's `Session` + `encodeWithSession(payload, session)` API. Per-session
 * `Session` state lives in an in-memory `Map<sessionId, { state, lastUsed }>`
 * that evicts entries idle for more than one hour. Eviction runs both lazily on
 * every session-path access and via an `unref()`'d 5-minute interval so it never
 * keeps the host process alive. The no-`sessionId` path is untouched and stays
 * pure/deterministic.
 *
 * Delta encoding (task 38.3 / Requirement 53) is implemented here on top of the
 * library's `encodeDelta(d: DeltaPayload)` API. When the caller supplies a
 * graph-shaped `opts.previousPayload`, the encoder measures structural overlap
 * as the Jaccard similarity of the two symbol sets (keyed by `qualifiedName`):
 * `|A ∩ B| / |A ∪ B|`. At ≥ 0.5 overlap it emits a delta-only encoding of the
 * changes (Req 53.1); below 0.5 it emits a full encoding (Req 53.2). The delta
 * is computed purely from the two payloads the caller passes — there is NO
 * internal previous-payload cache — so the path stays deterministic.
 *
 * Precedence when more than one stateful option is supplied:
 *   1. A usable (graph-shaped) `opts.previousPayload` takes priority and fully
 *      decides the output: a delta encoding when symbol-set overlap ≥ 0.5
 *      (Req 53.1), otherwise a plain full encode (Req 53.2). The `sessionId` is
 *      NOT consulted on this path — the caller has opted into delta semantics.
 *   2. Otherwise, an `opts.sessionId` routes through session dedup.
 *   3. Otherwise, a pure/deterministic full encode (Req 51.5 / 52.4).
 * A `previousPayload` that is absent or not graph-shaped is ignored and falls
 * through to the sessionId / pure paths.
 *
 * Requirements: 51, 52, 53, 57.2
 */

import type {
  DeltaPayload,
  Edge,
  Payload,
  Symbol as GcfSymbol,
  Session as SessionType,
} from '@blackwell-systems/gcf';

// ---------------------------------------------------------------------------
// ESM-only library loading (boot-safe)
// ---------------------------------------------------------------------------
//
// `@blackwell-systems/gcf` is published as an ESM-only package (`"type":
// "module"`, an `exports` map that exposes only the `import` condition).
// The NeuroNest main process is compiled to CommonJS and runs on Electron's
// bundled Node (v20.x), which CANNOT `require()` an ESM-only package — doing
// so throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and crashes the main process at
// load time, before the renderer ever loads. A static `import` here would be
// downlevelled by tsc to exactly that fatal `require()`.
//
// Instead the bindings are loaded lazily through a genuine dynamic `import()`:
//   - In compiled CommonJS, the `Function('s', 'return import(s)')` form
//     survives tsc emit as a real `import()` (tsc never rewrites string
//     contents), which Node 20 DOES support for ESM.
//   - Under vitest's module runner that callback is unavailable, so we fall
//     back to a plain `import()` which the Vite transform resolves directly.
//
// The encode functions stay SYNCHRONOUS and read the cached bindings. Until
// {@link initGcf} has resolved, they return `null` — the same JSON-fallback
// signal the failure contract already defines (Requirement 51.4). Callers
// (the four F10 surfaces) await {@link initGcf} at app boot; tests pre-load it
// via the vitest setup file.

/** The subset of the GCF library this wrapper binds to. */
interface GcfBindings {
  encode: (payload: Payload) => string;
  encodeDelta: (delta: DeltaPayload) => string;
  encodeGeneric: (value: unknown) => string;
  encodeWithSession: (payload: Payload, session: SessionType) => string;
  Session: new () => SessionType;
}

/**
 * GCF v1.0.0 LLM primer — inject into the system prompt when GCF_WIRE_FORMAT
 * is active so the LLM knows how to parse the compact encoding. This single
 * sentence raises comprehension from ~70% to 90%+ across all tested providers.
 */
export const GCF_PRIMER = 'GCF format: header starts with "GCF profile=graph tool=", symbols are @id kind qname score provenance, edges are @target<@source type (< not >), sections are ## targets/related/extended/edges. Kind abbreviations: function=fn, type=type, method=method, interface=iface.';

/**
 * Process-global cache key for the resolved bindings. Stored on `globalThis`
 * (not just a module-local) so that once {@link initGcf} has loaded the library
 * on ANY module instance, every other instance can recover the bindings
 * synchronously — including fresh instances created by a test runner's module
 * reset (e.g. vitest's `vi.resetModules()`), which clears the module registry
 * but never touches globals.
 */
const GCF_BINDINGS_GLOBAL = Symbol.for('neuronest.gcf.bindings');

type GcfGlobal = typeof globalThis & { [GCF_BINDINGS_GLOBAL]?: GcfBindings };

/** Read the globally-cached bindings, if the library has been loaded anywhere. */
function readGlobalBindings(): GcfBindings | null {
  return (globalThis as GcfGlobal)[GCF_BINDINGS_GLOBAL] ?? null;
}

/** De-dupes concurrent {@link initGcf} calls into a single load. */
let initPromise: Promise<void> | null = null;

/** Load the ESM-only module through a non-downlevelled dynamic import. */
async function loadGcfModule(): Promise<Record<string, unknown>> {
  try {
    const dynamicImport = new Function('s', 'return import(s)') as (
      s: string,
    ) => Promise<Record<string, unknown>>;
    return await dynamicImport('@blackwell-systems/gcf');
  } catch {
    // Vitest / bundler path: the Function-scoped import() callback is not
    // available, so use the lexical import() the transform can resolve.
    return (await import('@blackwell-systems/gcf')) as unknown as Record<string, unknown>;
  }
}

/**
 * Load and cache the GCF library bindings. Idempotent and concurrency-safe.
 * MUST be awaited once (at app boot, or in the test setup file) before any
 * encode call can produce GCF output; until then encodes return `null` and
 * callers fall back to JSON.
 */
export async function initGcf(): Promise<void> {
  if (readGlobalBindings()) return;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await loadGcfModule();
      (globalThis as GcfGlobal)[GCF_BINDINGS_GLOBAL] = {
        encode: mod.encode as GcfBindings['encode'],
        encodeDelta: mod.encodeDelta as GcfBindings['encodeDelta'],
        encodeGeneric: mod.encodeGeneric as GcfBindings['encodeGeneric'],
        encodeWithSession: mod.encodeWithSession as GcfBindings['encodeWithSession'],
        Session: mod.Session as GcfBindings['Session'],
      };
    })().catch((err) => {
      // Leave bindings unset (encodes keep returning null → JSON fallback) and
      // allow a later retry by clearing the memoized promise.
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

/**
 * Return the loaded bindings or throw. Every caller is inside the
 * `try/catch` of {@link encodeGraph} / {@link encodeGeneric}, so a throw here
 * is converted into the `null` JSON-fallback signal (Requirement 51.4) when
 * the library has not been initialized yet.
 */
function requireBindings(): GcfBindings {
  const b = readGlobalBindings();
  if (!b) {
    throw new Error('GCF bindings not initialized — call initGcf() at boot');
  }
  return b;
}

/**
 * Test/maintenance hook: report whether the GCF bindings are loaded. Lets the
 * boot-verification suite assert the library resolved without reaching into
 * module-private state.
 */
export function _isGcfReady(): boolean {
  return readGlobalBindings() !== null;
}

/**
 * Graph-shaped payload accepted by {@link encodeGraph}. Mirrors the library's
 * graph profile but treats `tokenBudget`, `tokensUsed`, and `edges` as optional
 * so call sites that don't track them can still encode.
 */
export interface GraphPayload {
  tool: string;
  tokenBudget?: number;
  tokensUsed?: number;
  symbols: Array<{
    qualifiedName: string;
    kind: 'function' | 'class' | 'method' | 'variable' | 'type';
    score: number;
    provenance: string;
    distance: number;
  }>;
  edges?: Array<{ source: string; target: string; edgeType: string }>;
}

/**
 * Optional encoding controls.
 *
 * `sessionId` drives session-scoped symbol dedup (task 38.2, Requirement 52)
 * and `previousPayload` drives delta encoding (task 38.3, Requirement 53). When
 * both are supplied, a usable (graph-shaped) `previousPayload` wins — see the
 * precedence note in the file header and {@link encodeGraph}.
 */
export interface EncodeOptions {
  /** Per-conversation session id enabling symbol dedup across calls. */
  sessionId?: string;
  /** Previous encoded payload for delta-only emission. */
  previousPayload?: GraphPayload | unknown;
}

/**
 * Maps the wrapper's {@link GraphPayload} onto the library's required `Payload`
 * shape, supplying safe defaults for the fields the library treats as required.
 */
function toLibraryPayload(payload: GraphPayload): Payload {
  return {
    tool: payload.tool,
    tokenBudget: payload.tokenBudget ?? 0,
    tokensUsed: payload.tokensUsed ?? 0,
    symbols: payload.symbols.map((s) => ({
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      score: s.score,
      provenance: s.provenance,
      distance: s.distance,
    })),
    edges: (payload.edges ?? []).map((e) => ({
      source: e.source,
      target: e.target,
      edgeType: e.edgeType,
    })),
  };
}

// ---------------------------------------------------------------------------
// Delta encoding (task 38.3 / Requirement 53)
// ---------------------------------------------------------------------------

/**
 * Emit a delta encoding when the current and previous symbol sets overlap by at
 * least this Jaccard similarity (Req 53.1); below it, emit a full encode
 * (Req 53.2).
 */
const DELTA_SIMILARITY_THRESHOLD = 0.5;

/**
 * Structural type guard: is `value` shaped enough like a {@link GraphPayload}
 * to drive delta encoding? We require a string `tool` and a `symbols` array
 * whose entries carry a string `qualifiedName` (the key the overlap heuristic
 * and the diff are computed on). Edges are optional. Anything else falls
 * through to the sessionId / pure paths, so a malformed or unrelated
 * `previousPayload` can never break the encode.
 */
function isGraphPayloadLike(value: unknown): value is GraphPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.tool !== 'string') return false;
  if (!Array.isArray(candidate.symbols)) return false;
  return candidate.symbols.every(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as Record<string, unknown>).qualifiedName === 'string',
  );
}

/** Stable key for an edge, used for set membership in the edge diff. */
function edgeKey(e: { source: string; target: string; edgeType: string }): string {
  return `${e.source}\u0000${e.target}\u0000${e.edgeType}`;
}

/**
 * Canonical string identity for a symbol's *content* (not just its name), so a
 * symbol whose attributes changed is detected as changed even though its
 * `qualifiedName` is unchanged.
 */
function symbolFingerprint(s: GraphPayload['symbols'][number]): string {
  return [s.qualifiedName, s.kind, s.score, s.provenance, s.distance].join('\u0000');
}

/**
 * Deterministic, dependency-free content hash (FNV-1a, 32-bit) rendered as
 * hex. Used to fill the library `DeltaPayload.baseRoot` / `newRoot` identity
 * tags. Pure: identical content always yields the same root, which keeps the
 * whole delta path deterministic (Req 51.5 / 53).
 */
function contentRoot(payload: GraphPayload): string {
  const symbols = [...payload.symbols]
    .map(symbolFingerprint)
    .sort()
    .join('\u0001');
  const edges = [...(payload.edges ?? [])]
    .map(edgeKey)
    .sort()
    .join('\u0001');
  const canonical = `${payload.tool}\u0002${symbols}\u0002${edges}`;

  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in 32-bit range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Jaccard similarity of the two payloads' symbol sets, keyed by
 * `qualifiedName`: `|A ∩ B| / |A ∪ B|`. Two empty sets are defined as identical
 * (similarity 1), so a pair of symbol-free payloads takes the delta path rather
 * than dividing by zero.
 */
function symbolJaccard(current: GraphPayload, previous: GraphPayload): number {
  const a = new Set(current.symbols.map((s) => s.qualifiedName));
  const b = new Set(previous.symbols.map((s) => s.qualifiedName));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const name of a) {
    if (b.has(name)) intersection++;
  }
  return intersection / union.size;
}

/** Rough token estimate (~4 chars/token) over a canonical rendering. */
function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

/**
 * Build a library {@link DeltaPayload} describing how to turn `previous` into
 * `current`. The diff is keyed by `qualifiedName`:
 *
 *  - A symbol present only in `current` is *added* (full declaration).
 *  - A symbol present only in `previous` is *removed* (bare reference).
 *  - A symbol present in both whose attributes changed is emitted in BOTH
 *    `removed` and `added`, so a consumer holding the base drops the stale
 *    declaration and re-learns the new one. This keeps the delta fully
 *    round-trippable: `base − removed + added === current` (Req 53.3).
 *
 * Edges are diffed the same way on a `source|target|edgeType` key.
 */
function buildDeltaPayload(
  current: GraphPayload,
  previous: GraphPayload,
): DeltaPayload {
  const prevByName = new Map(previous.symbols.map((s) => [s.qualifiedName, s]));
  const currByName = new Map(current.symbols.map((s) => [s.qualifiedName, s]));

  const added: GcfSymbol[] = [];
  const removed: GcfSymbol[] = [];

  for (const sym of current.symbols) {
    const prior = prevByName.get(sym.qualifiedName);
    // New name, or same name with changed content → re-declare it.
    if (!prior || symbolFingerprint(prior) !== symbolFingerprint(sym)) {
      added.push({ ...sym });
    }
  }
  for (const sym of previous.symbols) {
    const next = currByName.get(sym.qualifiedName);
    // Gone, or changed → drop the stale declaration the consumer holds.
    if (!next || symbolFingerprint(next) !== symbolFingerprint(sym)) {
      removed.push({ ...sym });
    }
  }

  const prevEdges = previous.edges ?? [];
  const currEdges = current.edges ?? [];
  const prevEdgeKeys = new Set(prevEdges.map(edgeKey));
  const currEdgeKeys = new Set(currEdges.map(edgeKey));
  const addedEdges: Edge[] = currEdges.filter((e) => !prevEdgeKeys.has(edgeKey(e)));
  const removedEdges: Edge[] = prevEdges.filter((e) => !currEdgeKeys.has(edgeKey(e)));

  // Token figures drive only the header `savings=%` and never affect
  // correctness/round-trip. Estimate the full encode vs. the changed content.
  const fullTokens = estimateTokens(requireBindings().encode(toLibraryPayload(current)));
  const deltaText = [
    ...added.map((s) => `${s.qualifiedName} ${s.score} ${s.provenance}`),
    ...removed.map((s) => s.qualifiedName),
    ...addedEdges.map(edgeKey),
    ...removedEdges.map(edgeKey),
  ].join('\n');
  const deltaTokens = estimateTokens(deltaText);

  return {
    tool: current.tool,
    baseRoot: contentRoot(previous),
    newRoot: contentRoot(current),
    removed,
    added,
    removedEdges,
    addedEdges,
    deltaTokens,
    fullTokens,
  };
}

// ---------------------------------------------------------------------------
// Session dedup state (task 38.2 / Requirement 52)
// ---------------------------------------------------------------------------

/** Drop a session after this much idle time (Requirement 52.3: 1 hour). */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/** How often the background sweep runs (every 5 minutes). */
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** A tracked session: the library `Session` plus its last-access timestamp. */
interface SessionEntry {
  state: SessionType;
  lastUsed: number;
}

/**
 * In-memory dedup state keyed by caller-supplied `sessionId`. Each entry owns a
 * library `Session` that remembers which qualified names were already
 * transmitted, so repeat encodes in the same session emit bare `@N` references
 * instead of full records (Requirement 52.2).
 */
const sessions = new Map<string, SessionEntry>();

/**
 * Evict sessions idle longer than {@link SESSION_IDLE_MS} (Requirement 52.3).
 * Pure with respect to live sessions; only stale entries are removed. `now` is
 * injectable for tests but defaults to the wall clock.
 */
function sweepSessions(now: number = Date.now()): void {
  const cutoff = now - SESSION_IDLE_MS;
  for (const [id, entry] of sessions) {
    if (entry.lastUsed < cutoff) {
      sessions.delete(id);
    }
  }
}

// Background sweep so idle sessions are reclaimed even without further encode
// traffic. `unref()` ensures this timer never keeps the host process alive.
// `setInterval` may be undefined in non-Node runtimes, so guard defensively.
const sweepTimer =
  typeof setInterval === 'function'
    ? setInterval(() => sweepSessions(), SESSION_SWEEP_INTERVAL_MS)
    : undefined;
if (sweepTimer && typeof sweepTimer.unref === 'function') {
  sweepTimer.unref();
}

/**
 * Fetch (or lazily create) the {@link Session} for `sessionId`, refreshing its
 * `lastUsed` stamp and lazily sweeping stale peers on the way in so eviction
 * happens even if the background timer is unavailable.
 */
function getSession(sessionId: string): SessionType {
  const now = Date.now();
  sweepSessions(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { state: new (requireBindings().Session)(), lastUsed: now };
    sessions.set(sessionId, entry);
  } else {
    entry.lastUsed = now;
  }
  return entry.state;
}

/**
 * Test/maintenance hook: drop all tracked sessions. Not part of the encode
 * contract; exposed so callers (and tests) can reset dedup state deterministically.
 */
export function _resetSessions(): void {
  sessions.clear();
}

/**
 * Test/maintenance hook: number of sessions currently tracked. Lets tests
 * assert eviction without reaching into module-private state.
 */
export function _sessionCount(): number {
  return sessions.size;
}

/**
 * Test/maintenance hook: run the idle-eviction sweep with an injectable clock,
 * so the 1-hour eviction (Requirement 52.3) can be exercised deterministically
 * without waiting on the background timer.
 */
export function _sweepSessions(now?: number): void {
  sweepSessions(now);
}

/**
 * Encode a graph-shaped payload via the GCF graph profile.
 *
 * @returns the GCF text encoding, or `null` if encoding fails (Req 51.4).
 */
export function encodeGraph(
  payload: GraphPayload,
  opts?: EncodeOptions,
): string | null {
  try {
    const libPayload = toLibraryPayload(payload);

    // Delta encoding (task 38.3 / Req 53) takes priority when the caller
    // supplies a graph-shaped previous payload. We measure structural overlap
    // as the Jaccard similarity of the two symbol sets (by qualifiedName). At
    // >= 0.5 we emit a delta-only encoding of the changes (Req 53.1); below the
    // threshold we emit a full encode (Req 53.2). The diff is computed purely
    // from the two payloads passed in — no internal cache — so this stays
    // deterministic, and the sessionId path is intentionally not consulted here
    // because the caller has opted into delta semantics.
    if (opts?.previousPayload !== undefined && isGraphPayloadLike(opts.previousPayload)) {
      const similarity = symbolJaccard(payload, opts.previousPayload);
      if (similarity >= DELTA_SIMILARITY_THRESHOLD) {
        return requireBindings().encodeDelta(buildDeltaPayload(payload, opts.previousPayload));
      }
      return requireBindings().encode(libPayload);
    }

    // Session dedup (task 38.2 / Req 52): route through the session-scoped
    // encoder so symbols already transmitted in this session collapse to bare
    // `@N` references.
    if (opts?.sessionId) {
      return requireBindings().encodeWithSession(libPayload, getSession(opts.sessionId));
    }

    // No delta, no sessionId: pure/deterministic full encoding (Req 52.4 / 51.5).
    return requireBindings().encode(libPayload);
  } catch {
    return null;
  }
}

/**
 * Encode an arbitrary value via the GCF tabular profile.
 *
 * @returns the GCF text encoding, or `null` if encoding fails (Req 51.4).
 */
export function encodeGeneric(
  payload: unknown,
  opts?: EncodeOptions,
): string | null {
  try {
    // Session dedup (task 38.2 / Req 52) is intentionally NOT applied here: the
    // library only exposes `encodeWithSession` for the graph `Payload` shape
    // (symbol-keyed dedup), whereas `encodeGeneric` serializes arbitrary values
    // via the tabular profile and has no symbols to deduplicate. Routing it
    // through the session encoder would change the wire format, so session
    // dedup stays graph-only (see `encodeGraph`). Delta encoding (task 38.3 /
    // Req 53) is likewise graph-only: it diffs symbol/edge sets keyed by
    // `qualifiedName`, which the tabular profile does not expose, so
    // `opts.previousPayload` is inert here.
    void opts;

    return requireBindings().encodeGeneric(payload);
  } catch {
    return null;
  }
}
