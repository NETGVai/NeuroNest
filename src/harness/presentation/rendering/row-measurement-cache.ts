/**
 * Row Measurement Cache
 *
 * Caches measured row heights by (stableKey, contentRevision, widthClass, textScaleClass).
 * When a cache entry is invalidated (content revision change, width change, scale change),
 * the invalidation triggers semantic-anchor correction.
 *
 * Requirements: 47.7, 47.17
 */

import type { RowMeasurementKey, RowMeasurement, ResolvedRenderingBounds } from './types';

/**
 * Callback invoked when a measurement invalidation occurs, triggering anchor correction.
 */
export type AnchorCorrectionCallback = (invalidatedKeys: string[]) => void;

/**
 * Serializes a RowMeasurementKey into a cache map key string.
 */
function serializeKey(key: RowMeasurementKey): string {
  return `${key.stableKey}|${key.contentRevision}|${key.widthClass}|${key.textScaleClass}`;
}

/**
 * RowMeasurementCache stores measured row heights keyed by the composite key
 * (stableKey, contentRevision, widthClass, textScaleClass). This enables:
 *
 * 1. Stable layout estimates without re-measuring unchanged rows
 * 2. Correct semantic-anchor restoration after layout changes
 * 3. Invalidation-driven anchor correction when content/width/scale changes
 *
 * The memory budget is sourced from Settings_Service with source revision provenance.
 */
export class RowMeasurementCache {
  private readonly cache: Map<string, RowMeasurement> = new Map();
  private readonly stableKeyIndex: Map<string, Set<string>> = new Map();
  private anchorCorrectionCallback: AnchorCorrectionCallback | null = null;
  private memoryBudgetBytes: number;
  private boundsSourceRevision: number;
  /** Estimated bytes per cache entry (key string + measurement object). */
  private static readonly BYTES_PER_ENTRY = 200;

  constructor(resolvedBounds: ResolvedRenderingBounds) {
    this.memoryBudgetBytes = resolvedBounds.bounds.memoryBudgetBytes;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
  }

  /**
   * Update bounds from a new Settings_Service revision (Req 47.21).
   */
  updateBounds(resolvedBounds: ResolvedRenderingBounds): void {
    this.memoryBudgetBytes = resolvedBounds.bounds.memoryBudgetBytes;
    this.boundsSourceRevision = resolvedBounds.sourceRevision;
    this.enforceMemoryBudget();
  }

  /**
   * Set the callback for anchor correction on invalidation.
   */
  onAnchorCorrection(callback: AnchorCorrectionCallback): void {
    this.anchorCorrectionCallback = callback;
  }

  /**
   * Get a cached measurement for the given composite key.
   * Returns undefined if not cached or if the entry has been evicted.
   */
  get(key: RowMeasurementKey): RowMeasurement | undefined {
    return this.cache.get(serializeKey(key));
  }

  /**
   * Store a measurement in the cache. If this causes the cache to exceed the
   * memory budget, the oldest entries are evicted.
   */
  set(key: RowMeasurementKey, measurement: RowMeasurement): void {
    const serialized = serializeKey(key);
    this.cache.set(serialized, measurement);

    // Update the stable-key index for efficient invalidation
    let keySet = this.stableKeyIndex.get(key.stableKey);
    if (!keySet) {
      keySet = new Set();
      this.stableKeyIndex.set(key.stableKey, keySet);
    }
    keySet.add(serialized);

    this.enforceMemoryBudget();
  }

  /**
   * Check if a measurement exists for the given composite key.
   */
  has(key: RowMeasurementKey): boolean {
    return this.cache.has(serializeKey(key));
  }

  /**
   * Invalidate all cached measurements for a given stableKey.
   * This is triggered when contentRevision, widthClass, or textScaleClass changes.
   * Invalidation triggers the anchor correction callback.
   */
  invalidateByStableKey(stableKey: string): void {
    const keySet = this.stableKeyIndex.get(stableKey);
    if (!keySet || keySet.size === 0) return;

    for (const serialized of keySet) {
      this.cache.delete(serialized);
    }
    keySet.clear();

    // Trigger anchor correction
    if (this.anchorCorrectionCallback) {
      this.anchorCorrectionCallback([stableKey]);
    }
  }

  /**
   * Invalidate every cached measurement because the active theme changed.
   *
   * Theme changes affect font metrics, letter spacing, and boxed content
   * padding driven by CSS custom properties, so previously-measured row
   * heights are no longer trustworthy. Only the measurement entries and
   * their reverse index are cleared; the caller's identity/stable-key
   * structures (`WindowedTimelineEngine`, `BoundedMountController`, mount
   * tracking) are untouched and continue to reference the same stable keys.
   *
   * Requirements: 15.9 (theme revision invalidates theme-dependent caches
   * only; identity/stable-key structures do not invalidate).
   */
  invalidateByThemeRevision(): void {
    if (this.cache.size === 0 && this.stableKeyIndex.size === 0) return;

    const affectedKeys = Array.from(this.stableKeyIndex.keys());
    this.cache.clear();
    this.stableKeyIndex.clear();

    if (affectedKeys.length > 0 && this.anchorCorrectionCallback) {
      this.anchorCorrectionCallback(affectedKeys);
    }
  }

  /**
   * Invalidate entries that don't match the current widthClass or textScaleClass.
   * This handles viewport resize or text scaling changes.
   */
  invalidateByContext(currentWidthClass: string, currentTextScaleClass: string): void {
    const invalidatedStableKeys: string[] = [];
    const toDelete: string[] = [];

    for (const [serialized] of this.cache) {
      const parts = serialized.split('|');
      const entryWidthClass = parts[2];
      const entryTextScaleClass = parts[3];

      if (entryWidthClass !== currentWidthClass || entryTextScaleClass !== currentTextScaleClass) {
        toDelete.push(serialized);
        const stableKey = parts[0]!;
        if (!invalidatedStableKeys.includes(stableKey)) {
          invalidatedStableKeys.push(stableKey);
        }
      }
    }

    for (const serialized of toDelete) {
      this.cache.delete(serialized);
      // Clean up the stableKey index
      for (const keySet of this.stableKeyIndex.values()) {
        keySet.delete(serialized);
      }
    }

    // Trigger anchor correction for all affected nodes
    if (invalidatedStableKeys.length > 0 && this.anchorCorrectionCallback) {
      this.anchorCorrectionCallback(invalidatedStableKeys);
    }
  }

  /**
   * Return the number of cached entries.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Return estimated memory usage in bytes.
   */
  estimatedMemoryBytes(): number {
    return this.cache.size * RowMeasurementCache.BYTES_PER_ENTRY;
  }

  /**
   * Return the bounds source revision.
   */
  getBoundsSourceRevision(): number {
    return this.boundsSourceRevision;
  }

  /**
   * Return the configured memory budget.
   */
  getMemoryBudget(): number {
    return this.memoryBudgetBytes;
  }

  /**
   * Clear all cached measurements. Triggers anchor correction for all affected nodes.
   */
  clear(): void {
    const affectedKeys = Array.from(this.stableKeyIndex.keys());
    this.cache.clear();
    this.stableKeyIndex.clear();

    if (affectedKeys.length > 0 && this.anchorCorrectionCallback) {
      this.anchorCorrectionCallback(affectedKeys);
    }
  }

  /**
   * Dispose the cache and release resources.
   */
  dispose(): void {
    this.cache.clear();
    this.stableKeyIndex.clear();
    this.anchorCorrectionCallback = null;
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Evict oldest entries until memory usage is within budget.
   */
  private enforceMemoryBudget(): void {
    const maxEntries = Math.floor(this.memoryBudgetBytes / RowMeasurementCache.BYTES_PER_ENTRY);
    if (maxEntries <= 0) return;

    while (this.cache.size > maxEntries) {
      // Map iteration order is insertion order, so first key is oldest
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);

      // Clean up stableKey index
      for (const keySet of this.stableKeyIndex.values()) {
        keySet.delete(firstKey);
      }
    }
  }
}
