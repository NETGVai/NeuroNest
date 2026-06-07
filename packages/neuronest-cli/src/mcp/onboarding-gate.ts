// File: packages/neuronest-cli/src/mcp/onboarding-gate.ts
//
// Implementation of the `OnboardingGate` interface declared in
// `./types.ts`. The gate is the per-request guard the seven outbound
// MCP tool handlers consult to decide whether a workspace-mutating
// tool (`runSpec`, `runSkill`, `runWorkflow`) may proceed (Req 6.9).
//
// Design contract (mirrors the comment in `types.ts` and design § Item 6):
//
//   - The desktop app's current `OnboardingState` is read from the
//     Headless_Protocol startup banner. Phase 3 already populates this
//     banner on transport open; Phase 4 just consumes it.
//   - On each MCP request that needs the gate, the cached snapshot is
//     refreshed via a banner-refresh action, so a long-lived MCP server
//     observes onboarding-state transitions in the desktop app without
//     restarting.
//   - `isWorkspaceMutationAllowed()` returns `true` iff the freshly
//     refreshed state is in the allow-set `{taskExecuting, complete}`.
//   - `currentState()` returns the cached snapshot — used for the
//     human-readable detail in the `onboarding_incomplete` MCP error.
//     It does NOT trigger a refresh; the handler always calls
//     `isWorkspaceMutationAllowed()` first, which is what actually
//     drives the refresh. If the gate is asked for a state before any
//     refresh has happened, it lazily falls back to one read so the
//     diagnostic is never undefined.
//
// The constructor takes an injected `BannerReader` rather than a
// concrete `HeadlessTransport`. Phase 3's full banner-refresh action
// shape lands in a follow-up task; this gate stays decoupled from the
// wire format so it remains trivially swappable.
//
// Validates: Requirements 6.8, 6.9.

import type { OnboardingGate, OnboardingState } from './types.js';

// ─── Allow-set ──────────────────────────────────────────────────

/**
 * The two onboarding states under which workspace-mutating MCP tools
 * are permitted (Req 6.9). Frozen so accidental mutation surfaces as
 * a TypeError on strict-mode hosts.
 *
 * Kept private to this module: callers consult the gate via
 * `isWorkspaceMutationAllowed()` rather than checking the set
 * directly, so the allow-set membership rule lives in exactly one
 * place.
 */
const MUTATION_ALLOWED_STATES = Object.freeze(
  new Set<OnboardingState>(['taskExecuting', 'complete']),
);

// ─── Banner reader contract ─────────────────────────────────────

/**
 * Minimal projection of the Headless_Protocol startup banner that the
 * gate consumes. Phase 3 emits a richer banner shape (license summary,
 * protocol version, capabilities, …); this gate only reads the field
 * it actually needs, so it stays decoupled from the rest of the wire
 * format.
 */
export interface BannerSnapshot {
  onboardingState: OnboardingState;
}

/**
 * The injected reader function. Each call performs a fresh
 * banner-refresh action against the underlying `HeadlessTransport`
 * and resolves to the latest snapshot. The gate never assumes
 * idempotency or caching at the reader layer — caching lives in this
 * module.
 *
 * Errors propagate to the caller of `isWorkspaceMutationAllowed` /
 * `currentState`. The MCP handler that calls the gate is the one that
 * decides how to surface them (typically as `headless_failed`).
 */
export type BannerReader = () => Promise<BannerSnapshot>;

// ─── Gate implementation ────────────────────────────────────────

/**
 * Caching gate over a `BannerReader`. Refreshes on every
 * `isWorkspaceMutationAllowed` call (the per-request entry point);
 * `currentState` returns the cached snapshot (with a one-time lazy
 * refresh if no read has yet succeeded).
 *
 * Concurrent callers share a single in-flight banner refresh — this
 * keeps an MCP server that fans out to multiple parallel handlers
 * from issuing redundant banner-refresh actions for one request
 * cycle. Once the in-flight read settles, subsequent calls trigger a
 * fresh refresh.
 */
export class CachingOnboardingGate implements OnboardingGate {
  private cached: OnboardingState | undefined;
  private inFlight: Promise<OnboardingState> | undefined;

  constructor(private readonly readBanner: BannerReader) {}

  /**
   * Refreshes the cached state and returns whether the new state
   * permits workspace mutation. Used by `runSpec` / `runSkill` /
   * `runWorkflow` handlers; non-mutating handlers (`listSpecs`,
   * `listSkills`, `askWorkspace`, `listWorkflows`) do not need to
   * call this.
   */
  async isWorkspaceMutationAllowed(): Promise<boolean> {
    const state = await this.refresh();
    return MUTATION_ALLOWED_STATES.has(state);
  }

  /**
   * Returns the cached snapshot. If no refresh has ever succeeded —
   * i.e. the very first call into the gate is `currentState` rather
   * than `isWorkspaceMutationAllowed` — we lazily perform one read so
   * the diagnostic never reports `undefined`.
   *
   * Diagnostic-only: this method is invoked by handlers building the
   * `onboarding_incomplete` error message, so it MUST NOT race the
   * value `isWorkspaceMutationAllowed` just produced. By returning
   * the cached snapshot (the same one that drove the boolean
   * decision), the two methods are guaranteed to agree within a
   * single MCP request.
   */
  async currentState(): Promise<OnboardingState> {
    if (this.cached === undefined) {
      return this.refresh();
    }
    return this.cached;
  }

  /**
   * Performs (or joins) a banner refresh and updates the cache.
   * Concurrent callers receive the same in-flight promise; once it
   * settles, the next call starts a new refresh.
   */
  private refresh(): Promise<OnboardingState> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    const pending = this.readBanner()
      .then((banner) => {
        this.cached = banner.onboardingState;
        return banner.onboardingState;
      })
      .finally(() => {
        // Clear the in-flight slot regardless of success/failure —
        // a failed refresh should not poison subsequent attempts,
        // and a successful one should not pin the cache to a stale
        // promise.
        this.inFlight = undefined;
      });
    this.inFlight = pending;
    return pending;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Convenience factory matching the task's hint signature
 *
 *   `(banner: BannerReader) => OnboardingGate`
 *
 * so call sites stay decoupled from the concrete class. The factory
 * is the single supported construction path; the class is exported
 * only to keep the unit tests' typing straightforward.
 */
export function createOnboardingGate(banner: BannerReader): OnboardingGate {
  return new CachingOnboardingGate(banner);
}
