/**
 * Experience view contracts — the render-ready, authority-derived view models
 * for the dashboards, orchestration selector, firewall UI, provider cards,
 * channel catalog, voice status, and system monitor
 * (FUT-PKG-07-EXPERIENCE/T-006).
 *
 * These are VIEW shapes only. Every field is DERIVED from a canonical registry,
 * projection, or authority read — none is a durable writer and none carries a
 * hardcoded total (NN-IDENT-004). The types live here so the dashboard, selector,
 * firewall, provider, channel, voice, and monitor derivations share one
 * vocabulary for freshness labeling and truthful availability.
 *
 * Design anchors: D-05 (components/responsibilities), D-19 (observability/health),
 * D-21 (performance measurement). Requirements: NN-UI-007/008/009/010,
 * NN-IDENT-004/005, NN-CHANNEL-003/011, NN-COMPAT-007/009/012/014.
 */

/**
 * The freshness a derived value carries to its surface. This mirrors the
 * ProjectionService checkpoint status ladder (D-08.3) so a dashboard card can
 * never present a stale/blocked read model as current truth (NN-EVENT-004,
 * NN-UI-007 "label stale/partial data"):
 *   - `current`     — the source read model is caught up; safe as current truth.
 *   - `stale`       — the source is behind (recoverable lag); shown labeled.
 *   - `partial`     — some contributing source is missing/unavailable; the value
 *                     is shown for the parts that resolved, labeled partial.
 *   - `unavailable` — no trustworthy value is available; the surface shows an
 *                     explicit unavailable state rather than a fabricated zero.
 */
export type Freshness = 'current' | 'stale' | 'partial' | 'unavailable';

/**
 * A single derived scalar with its freshness. A count/total NEVER carries a
 * hardcoded constant: `value` is null when the source could not be derived, and
 * the surface renders the labeled `freshness` state instead of a fabricated 0
 * (NN-IDENT-004, NN-UI-007).
 */
export interface DerivedValue<T> {
  /** The derived value, or null when unavailable/blocked (never fabricated). */
  readonly value: T | null;
  readonly freshness: Freshness;
  /** A short, secret-free reason when not `current` (renderer-safe). */
  readonly note?: string;
}

/** Convenience constructor for a current derived value. */
export function derived<T>(value: T): DerivedValue<T> {
  return { value, freshness: 'current' };
}

/** Convenience constructor for a labeled (non-current) derived value. */
export function labeled<T>(
  value: T | null,
  freshness: Exclude<Freshness, 'current'>,
  note?: string,
): DerivedValue<T> {
  return note === undefined ? { value, freshness } : { value, freshness, note };
}

/**
 * Fold several contributing freshness labels into the worst-case for a card
 * that aggregates multiple sources. Ordering (best→worst):
 * current < stale < partial < unavailable. An aggregate is only `current` when
 * every contributing source is current; any missing source degrades the whole
 * card so the surface never over-reports confidence (NN-UI-007).
 */
export function worstFreshness(labels: readonly Freshness[]): Freshness {
  const rank: Record<Freshness, number> = {
    current: 0,
    stale: 1,
    partial: 2,
    unavailable: 3,
  };
  let worst: Freshness = 'current';
  for (const l of labels) {
    if (rank[l] > rank[worst]) worst = l;
  }
  return worst;
}
