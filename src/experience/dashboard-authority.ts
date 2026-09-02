/**
 * DashboardAuthority — the single VIEW authority that derives every dashboard,
 * selector, provider, firewall, channel, voice, and system-monitor surface from
 * the canonical registries/projections rather than from a parallel truth
 * (FUT-PKG-07-EXPERIENCE/T-006).
 *
 * NN-UI-007 requires "Agent/run/task/cost/quality/adoption/provider/
 * system-monitor dashboards SHALL derive from authorities, label stale/partial
 * data, suppress catalog-only provider cards, and show professional cloud
 * routing as proxy-backed rather than missing-key failure." NN-IDENT-004 forbids
 * a live application constant for any catalog total — every count "SHALL be
 * generated from the owning registry at a named revision." This module is the
 * reader that realizes both: it consumes the pre-existing authorities
 * (FUT-PKG-06-EXECUTION/T-004 AgentRegistry, T-007 Provider/Proxy route service,
 * the ProjectionService read models, the channel registry capability metadata,
 * the voice model manifest/integrity path, and the async system monitor) and
 * folds their reads into render-ready VIEW models. It never becomes a durable
 * writer and never emits a hardcoded total.
 *
 * What this module adds on top of the canonical authorities:
 *
 *   1. {@link deriveCountCard} / {@link deriveDashboard} — the agent/run/task/
 *      cost/quality/adoption dashboard cards. Every card's total is read from
 *      the owning registry/projection; a card whose source read model is
 *      stale/blocked is LABELED (never served as current), and a card whose
 *      source is unavailable shows an explicit unavailable state instead of a
 *      fabricated 0 (NN-IDENT-004, NN-UI-007, NN-EVENT-004).
 *   2. {@link deriveOrchestrationSelector} — a thin, single-source wrapper over
 *      the AgentRegistry's {@link projectOrchestrationSelector} that guarantees
 *      EXACTLY ONE visible virtual selector and derives the agent count from the
 *      registry (NN-IDENT-005, NN-COMPAT-009, V-IDENT-001/selector-set-equality).
 *   3. {@link deriveProviderCards} — provider cards that show proxy/local TRUTH:
 *      a professional cloud (proxy) route is shown proxy-backed (not a
 *      missing-key false failure), a catalog-only provider card is SUPPRESSED
 *      (never rendered as an active/available capability), and a local route is
 *      shown as local truth (NN-UI-007, NN-COMPAT-012, NN-PROXY-006).
 *   4. {@link deriveFirewallView} + {@link resetFirewall} / {@link exportFirewall}
 *      — registered, typed reset/export handlers and the agent-override /
 *      project lists, derived from the firewall config + the enabled-agent and
 *      project inputs, while the underlying engine/enforcement is untouched
 *      (NN-UI-008, NN-COMPAT-007).
 *   5. {@link deriveChannelCatalog} — the registry-driven channel catalog that
 *      distinguishes `available` from `coming-soon` and marks catalog-only
 *      entries as disabled controls, consuming the same registry metadata for
 *      every entry point (NN-CHANNEL-003, NN-CHANNEL-011).
 *   6. {@link deriveVoiceStatus} + {@link verifyVoicePromotion} — voice
 *      listening/download/model status that NEVER reports an unavailable model
 *      as ready, and the exact managed-manifest integrity behavior: a completed
 *      download is promoted ONLY after SHA-256 verification passes; a corrupt/
 *      unverified/malformed digest refuses promotion and preserves the prior
 *      verified file (NN-UI-009, NN-UI-010, NN-COMPAT-012).
 *   7. {@link deriveSystemMonitorProfile} — the cold system-monitor profile that
 *      classifies whether cold load meets the NN-PERF-010 budget while preserving
 *      refresh interval/accuracy/cleanup (NN-COMPAT-014, V-PERF-001).
 *
 * Migration/rollback (D-20): each card/surface cuts its reader over independently
 * (shadow old/new projection values); a rollback restores the prior reader (and,
 * for voice, the prior verified file) and never a static authority or a corrupt
 * download.
 *
 * Design anchors: D-05, D-10, D-17, D-19, D-20, D-21.
 * Requirements: NN-IDENT-004/005, NN-UI-007/008/009/010, NN-CHANNEL-003/011,
 * NN-COMPAT-007/009/012/014, NN-PROXY-006.
 */

import type Database from 'better-sqlite3';

import {
  ORCHESTRATION_SELECTOR_NAME,
  projectOrchestrationSelector,
  type OrchestrationSelector,
} from '../execution/agent-registry.js';
import type { ProviderRoute, RouteLocality } from '../provider/provider-types.js';
import {
  type DerivedValue,
  type Freshness,
  derived,
  labeled,
  worstFreshness,
} from './experience-types.js';

// ─── Dashboard count/cost/quality/adoption cards (NN-UI-007, NN-IDENT-004) ───

/**
 * The kinds of dashboard card this authority derives. Each maps to an owning
 * registry/projection read — never a live application constant (NN-IDENT-004).
 */
export type DashboardCardKind =
  | 'agents'
  | 'runs'
  | 'tasks'
  | 'cost'
  | 'quality'
  | 'adoption'
  | 'providers'
  | 'system-monitor';

/**
 * A source read as it arrives from an owning authority: a derived count/value
 * and the freshness of the read model it came from. `sourceStatus` mirrors the
 * ProjectionService checkpoint status; when it is `stale`/`blocked`/`missing`
 * the card is labeled and never served as current (NN-EVENT-004, NN-UI-007).
 */
export interface SourceRead {
  /** The value read from the owning registry/projection, or null if none. */
  readonly value: number | null;
  /** The freshness reported by the owning read model. */
  readonly sourceStatus: 'current' | 'stale' | 'blocked' | 'missing';
}

/** A render-ready dashboard card. */
export interface DashboardCard {
  readonly kind: DashboardCardKind;
  /** The derived total/value with its freshness label (NN-IDENT-004). */
  readonly metric: DerivedValue<number>;
}

/**
 * Map an owning read model's status onto a card freshness. A `blocked`
 * integrity stop or a `missing` source degrades to `unavailable` (never a
 * fabricated 0); a recoverable `stale` lag stays labeled `stale` with the
 * last-good value (D-08.3, NN-UI-007).
 */
function statusToFreshness(status: SourceRead['sourceStatus']): Freshness {
  switch (status) {
    case 'current':
      return 'current';
    case 'stale':
      return 'stale';
    case 'blocked':
    case 'missing':
      return 'unavailable';
  }
}

/**
 * Derive one dashboard count/value card from an owning authority read. The card
 * total is exactly the source value — this module never substitutes a hardcoded
 * total such as 83/109/537 (NN-IDENT-004). A `current` source produces a current
 * card; a `stale` source is labeled with the last-good value retained; a
 * `blocked`/`missing` source produces an `unavailable` card with a null value so
 * the surface shows an explicit unavailable state, not a fake zero.
 */
export function deriveCountCard(kind: DashboardCardKind, read: SourceRead): DashboardCard {
  const freshness = statusToFreshness(read.sourceStatus);
  if (freshness === 'current') {
    return { kind, metric: derived(read.value ?? 0) };
  }
  if (freshness === 'stale') {
    // A recoverable lag: retain the last-good value but LABEL it stale.
    return {
      kind,
      metric: labeled(read.value, 'stale', 'source read model is behind (recoverable lag)'),
    };
  }
  // blocked / missing → explicit unavailable, never a fabricated total.
  return {
    kind,
    metric: labeled<number>(null, 'unavailable', 'source authority is unavailable'),
  };
}

/** The set of source reads that back the dashboard (all from owning authorities). */
export interface DashboardSources {
  readonly agents: SourceRead;
  readonly runs: SourceRead;
  readonly tasks: SourceRead;
  readonly cost: SourceRead;
  readonly quality: SourceRead;
  readonly adoption: SourceRead;
}

/** A render-ready dashboard: the derived cards + an aggregate freshness. */
export interface DashboardView {
  readonly cards: readonly DashboardCard[];
  /** The worst-case freshness across all cards (NN-UI-007 aggregate honesty). */
  readonly aggregateFreshness: Freshness;
}

/**
 * Derive the whole dashboard from the owning authority reads. Each card is
 * derived independently (so one stale/blocked source never poisons an unrelated
 * card), and the dashboard reports the worst-case aggregate freshness so the UI
 * never over-reports confidence (NN-UI-007, NN-IDENT-004).
 */
export function deriveDashboard(sources: DashboardSources): DashboardView {
  const cards: DashboardCard[] = [
    deriveCountCard('agents', sources.agents),
    deriveCountCard('runs', sources.runs),
    deriveCountCard('tasks', sources.tasks),
    deriveCountCard('cost', sources.cost),
    deriveCountCard('quality', sources.quality),
    deriveCountCard('adoption', sources.adoption),
  ];
  return {
    cards,
    aggregateFreshness: worstFreshness(cards.map((c) => c.metric.freshness)),
  };
}

// ─── Orchestration selector (NN-IDENT-005, NN-COMPAT-009) ────────────────────

/** The single visible virtual selector name re-exported for surface parity. */
export { ORCHESTRATION_SELECTOR_NAME } from '../execution/agent-registry.js';

/**
 * Derive the orchestration selector view. This is a thin single-source wrapper
 * over the AgentRegistry projection: the UI renders EXACTLY ONE visible virtual
 * selector named `NeuroNest Orchestration`, the real departments are the grouped
 * members, and the agent count is registry-derived (NN-IDENT-005, NN-COMPAT-009).
 * There is no second selector construction path — the renderer consumes exactly
 * this projection (V-IDENT-001/selector-set-equality).
 */
export function deriveOrchestrationSelector(db: Database.Database): OrchestrationSelector {
  return projectOrchestrationSelector(db);
}

/**
 * The number of VISIBLE orchestration selectors a renderer must show. It is
 * always exactly one: the single virtual `NeuroNest Orchestration` selector.
 * The real departments are groups WITHIN that selector, never sibling
 * selectors, so a duplicate pseudo-department selector is impossible
 * (NN-IDENT-005, NN-COMPAT-009).
 */
export function visibleSelectorCount(selector: OrchestrationSelector): number {
  return selector.virtualSelector === ORCHESTRATION_SELECTOR_NAME ? 1 : 0;
}

// ─── Provider cards: proxy/local truth (NN-UI-007, NN-COMPAT-012) ────────────

/**
 * How a provider surface renders after deriving from the route authority:
 *   - `local`             — a directly-usable on-device route (local truth).
 *   - `proxy-backed`      — a professional cloud route reached through the proxy
 *                           edge; shown as proxy-backed, NOT a missing-key
 *                           failure, when its upstream credential reference is
 *                           present (NN-PROXY-006, NN-UI-007).
 *   - `missing-key`       — a proxy route whose upstream credential reference is
 *                           absent: shown TRUTHFULLY as needing a key, not a
 *                           false failure and not silently available.
 */
export type ProviderCardStatus = 'local' | 'proxy-backed' | 'missing-key';

/** A render-ready provider card (secret-free). */
export interface ProviderCard {
  readonly routeId: string;
  readonly providerId: string;
  readonly locality: RouteLocality;
  readonly status: ProviderCardStatus;
  /** Whether the surface may present this route as usable now. */
  readonly usable: boolean;
}

/**
 * A catalog-only provider entry: a provider that appears in a catalog but has no
 * real, validated route. It must be SUPPRESSED from the active provider cards —
 * a catalog entry alone must never report an active/available capability
 * (NN-UI-007, NN-CHANNEL-003 catalog-only-vs-real principle applied to
 * providers).
 */
export interface CatalogOnlyProvider {
  readonly providerId: string;
  readonly catalogOnly: true;
}

/** The result of deriving provider cards. */
export interface ProviderCardsView {
  /** Cards for REAL routes only; catalog-only entries are excluded. */
  readonly cards: readonly ProviderCard[];
  /** The provider ids suppressed because they are catalog-only. */
  readonly suppressedCatalogOnly: readonly string[];
}

/**
 * Derive the truthful provider status for a single real route:
 *   - a `local` route → `local` (usable);
 *   - a `proxy` route WITH an upstream credential reference → `proxy-backed`
 *     (usable) — professional cloud routing is proxy-backed, not a missing-key
 *     failure (NN-UI-007, NN-COMPAT-012, NN-PROXY-006);
 *   - a `proxy` route WITHOUT an upstream credential reference → `missing-key`
 *     (NOT usable) — shown truthfully as needing a key, never a false failure
 *     and never silently available.
 * Pure; reads only the route shape and never a raw secret (NN-PROXY-013).
 */
export function deriveProviderCardStatus(route: ProviderRoute): ProviderCardStatus {
  if (route.locality === 'local') return 'local';
  return route.upstreamCredentialRefId ? 'proxy-backed' : 'missing-key';
}

/**
 * Derive the provider cards from the real routes and the catalog-only provider
 * ids. Every real route becomes a card whose status reflects proxy/local truth;
 * every catalog-only provider is SUPPRESSED (never rendered as an available
 * capability) and reported in `suppressedCatalogOnly` for an explicit
 * "coming soon"/catalog affordance (NN-UI-007, NN-COMPAT-012).
 */
export function deriveProviderCards(
  routes: readonly ProviderRoute[],
  catalogOnly: readonly CatalogOnlyProvider[],
): ProviderCardsView {
  const cards: ProviderCard[] = routes.map((route) => {
    const status = deriveProviderCardStatus(route);
    return {
      routeId: route.routeId,
      providerId: route.providerId,
      locality: route.locality,
      status,
      usable: status !== 'missing-key',
    };
  });
  return {
    cards,
    suppressedCatalogOnly: catalogOnly.map((c) => c.providerId),
  };
}

// ─── Firewall UI: reset/export handlers + lists (NN-UI-008, NN-COMPAT-007) ───

/** An agent that is enabled with a configured route (NN-UI-008 override list). */
export interface FirewallAgentOverride {
  readonly agentId: string;
  readonly enabled: boolean;
  /** The configured route ref, if any. Only enabled+routed agents are listed. */
  readonly routeRef: string | null;
}

/** A project entry for the firewall project list (NN-UI-008 all projects). */
export interface FirewallProjectEntry {
  readonly projectId: string;
  readonly name: string;
}

/** The firewall config snapshot the view derives from (engine untouched). */
export interface FirewallConfigSnapshot {
  readonly enabled: boolean;
  readonly sensitivity: number;
  readonly categories: readonly string[];
  /** The local-model startup port; must be preserved unchanged (NN-UI-008). */
  readonly localModelPort: number;
}

/** A render-ready firewall view (NN-UI-008). */
export interface FirewallView {
  readonly config: FirewallConfigSnapshot;
  /** Only agents that are enabled AND have a configured route (NN-UI-008). */
  readonly agentOverrides: readonly FirewallAgentOverride[];
  /** ALL projects, none dropped (NN-UI-008). */
  readonly projects: readonly FirewallProjectEntry[];
  /** Whether the reset and export handlers are registered and typed. */
  readonly handlersRegistered: boolean;
}

/**
 * Derive the firewall view from the config snapshot, the full agent list, and
 * the full project list. The agent-override list includes ONLY agents that are
 * enabled AND have a configured route (NN-UI-008); the project list includes
 * EVERY project (none dropped). The reset/export handlers are registered and
 * typed ({@link resetFirewall} / {@link exportFirewall}). The underlying engine,
 * its enforcement, the local-model startup port, and navigation are untouched —
 * this derivation only reads config (NN-UI-008, NN-COMPAT-007).
 */
export function deriveFirewallView(input: {
  readonly config: FirewallConfigSnapshot;
  readonly agents: readonly FirewallAgentOverride[];
  readonly projects: readonly FirewallProjectEntry[];
}): FirewallView {
  return {
    config: input.config,
    agentOverrides: input.agents.filter((a) => a.enabled && a.routeRef !== null),
    projects: [...input.projects],
    handlersRegistered: true,
  };
}

/**
 * The reset handler (registered + typed, NN-UI-008/NN-COMPAT-007). Returns the
 * default config snapshot to apply; it does NOT mutate the engine's enforcement
 * or the local-model startup behavior. The caller applies the returned defaults
 * through the config authority.
 */
export function resetFirewall(defaults: FirewallConfigSnapshot): FirewallConfigSnapshot {
  return { ...defaults, categories: [...defaults.categories] };
}

/**
 * The export handler (registered + typed, NN-UI-008/NN-COMPAT-007). Returns a
 * canonical, secret-free JSON string of the current firewall config so an
 * operator can export the policy. Reads config only; enforcement is untouched.
 */
export function exportFirewall(config: FirewallConfigSnapshot): string {
  return JSON.stringify(
    {
      enabled: config.enabled,
      sensitivity: config.sensitivity,
      categories: [...config.categories].sort(),
      localModelPort: config.localModelPort,
    },
    null,
    2,
  );
}

// ─── Channel catalog: real vs catalog-only (NN-CHANNEL-003/011) ──────────────

/** A channel's implementation status as declared by its adapter capabilities. */
export type ChannelImplementationStatus = 'available' | 'coming-soon';

/** A single channel registry entry the catalog view derives from. */
export interface ChannelRegistryEntry {
  readonly channelId: string;
  readonly displayName: string;
  readonly implementationStatus: ChannelImplementationStatus;
  /** Stable sort key from the tile metadata (NN-CHANNEL-011 stable sort). */
  readonly sortOrder: number;
}

/** A render-ready channel tile (NN-CHANNEL-003/011). */
export interface ChannelTile {
  readonly channelId: string;
  readonly displayName: string;
  readonly implementationStatus: ChannelImplementationStatus;
  /**
   * Whether the connect/setup controls are enabled. A `coming-soon` catalog-only
   * entry renders DISABLED controls and can never connect/report success
   * (NN-CHANNEL-003).
   */
  readonly controlsEnabled: boolean;
}

/** The result of deriving the channel catalog. */
export interface ChannelCatalogView {
  /** Every registered channel as a tile, in stable sort order (NN-CHANNEL-011). */
  readonly tiles: readonly ChannelTile[];
  /** Registry-derived count of channels that are actually `available`. */
  readonly availableCount: number;
  /** Registry-derived count of `coming-soon` catalog-only channels. */
  readonly comingSoonCount: number;
}

/**
 * Derive the registry-driven channel catalog. Every entry point (slash command,
 * IM gateway, IPC list, settings, channel panel) consumes THIS single derivation
 * so a runtime registration updates all of them without editing an independent
 * whitelist (NN-CHANNEL-011). A `coming-soon` entry renders disabled controls
 * and is never presented as connectable (NN-CHANNEL-003). Tiles are ordered by
 * the stable sort metadata, then channel id for a deterministic tiebreak. Counts
 * are registry-derived, never hardcoded (NN-IDENT-004).
 */
export function deriveChannelCatalog(
  entries: readonly ChannelRegistryEntry[],
): ChannelCatalogView {
  const tiles: ChannelTile[] = [...entries]
    .sort((a, b) =>
      a.sortOrder !== b.sortOrder
        ? a.sortOrder - b.sortOrder
        : a.channelId < b.channelId
          ? -1
          : a.channelId > b.channelId
            ? 1
            : 0,
    )
    .map((e) => ({
      channelId: e.channelId,
      displayName: e.displayName,
      implementationStatus: e.implementationStatus,
      controlsEnabled: e.implementationStatus === 'available',
    }));
  return {
    tiles,
    availableCount: tiles.filter((t) => t.implementationStatus === 'available').length,
    comingSoonCount: tiles.filter((t) => t.implementationStatus === 'coming-soon').length,
  };
}

// ─── Re-export the voice + system-monitor derivations ────────────────────────

export * from './voice-status.js';
export * from './system-monitor-profile.js';
