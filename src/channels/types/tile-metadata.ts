// ─── Tile Metadata ──────────────────────────────────────────────
// Type definition for the static UI-tile metadata each adapter exposes.

/**
 * Static metadata each adapter exposes for the channels-view UI panel.
 * The panel renders one tile per registered adapter using these fields.
 */
export interface TileMetadata {
  /**
   * Human-readable name shown on the tile (e.g. "WhatsApp").
   * @satisfies REQ 30.4
   */
  displayName: string;

  /**
   * Emoji or SVG marker. Non-ASCII glyphs allowed.
   * @satisfies REQ 30.4
   */
  emoji: string;

  /**
   * One-sentence description shown under the title.
   * @satisfies REQ 30.4
   */
  description: string;

  /**
   * Pill-list of action tags rendered on the tile.
   * @satisfies REQ 30.4, REQ 31.3
   */
  actionTags: readonly string[];

  /**
   * Stable sort key across renders.
   *
   * Real adapters occupy 0..99 in activity-bar order
   * (WhatsApp=10, Telegram=20, Discord=30, Slack=40, GitHub=50,
   * Email=60, Teams=70); stubs occupy 1000+ in enumeration order
   * from REQ 30.3.
   *
   * When omitted, defaults to the adapter's registration-order index
   * at registry-build time (i.e., the `registrationIndex` assigned
   * by `AdapterRegistry.registerAdapter`).
   *
   * @satisfies REQ 31.6
   */
  sortOrder?: number;
}
