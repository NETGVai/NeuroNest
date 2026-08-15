/**
 * ContextItemStore — Stores all supported Context_Items as typed versioned references.
 *
 * Supports: file, folder, range, symbol, diagnostic, terminal, git, planning,
 * run, artifact, image, and approved-URL Context_Items.
 *
 * Context_Items are stored as structured references with identifiers and versions.
 * Display text is never reparsed as the source of truth.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10
 */

// ─── Context Item Types ─────────────────────────────────────────

/** All supported context item kinds */
export type ContextItemKind =
  | 'file'
  | 'folder'
  | 'range'
  | 'symbol'
  | 'diagnostic'
  | 'terminal'
  | 'git'
  | 'planning'
  | 'run'
  | 'artifact'
  | 'image'
  | 'url';

/** Provenance category indicating how the item was added */
export type ContextProvenance =
  | 'explicit'     // User explicitly added via @ picker or drag
  | 'suggested'    // System auto-suggested based on context
  | 'mandatory'    // Required by the active task
  | 'excluded';    // Excluded by policy or user

/** Staleness status of a context item */
export type StalenessStatus =
  | 'current'      // Content matches pinned version
  | 'stale'        // Content changed since attachment
  | 'unavailable'; // Source no longer exists

/** A typed versioned context item reference */
export interface ContextItem {
  /** Unique identifier for this context item instance */
  readonly id: string;
  /** The kind of context (file, symbol, diagnostic, etc.) */
  readonly kind: ContextItemKind;
  /** The structured source identifier (URI, symbol path, diagnostic ID, etc.) */
  readonly sourceId: string;
  /** Human-readable display label */
  readonly displayLabel: string;
  /** Version or content hash at attachment time */
  readonly version: string;
  /** How this item was added to context */
  readonly provenance: ContextProvenance;
  /** Staleness status */
  staleness: StalenessStatus;
  /** Whether the item is pinned (prevents automatic removal) */
  pinned: boolean;
  /** Whether the item has been redacted before send */
  redacted: boolean;
  /** Estimated token count for this item */
  readonly tokenEstimate: number;
  /** Timestamp when the item was added */
  readonly addedAt: number;
  /** Optional workspace-relative path for file-based items */
  readonly workspacePath?: string;
  /** Optional line range for range-based items */
  readonly lineRange?: { start: number; end: number };
  /** Optional metadata specific to the item kind */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Controls available for a context item */
export interface ContextItemControls {
  canInspect: boolean;
  canRemove: boolean;
  canPin: boolean;
  canRefresh: boolean;
  canRedact: boolean;
}

/** Context usage summary against model limits */
export interface ContextUsageSummary {
  /** Total estimated tokens across all included items */
  totalTokens: number;
  /** Model's maximum context window */
  modelLimit: number;
  /** Number of items that were omitted due to limits */
  omittedCount: number;
  /** Number of items that were condensed/summarized */
  condensedCount: number;
  /** IDs of omitted items for display */
  omittedItemIds: readonly string[];
}

// ─── ContextItemStore ───────────────────────────────────────────

/**
 * ContextItemStore manages the lifecycle of typed versioned Context_Items
 * attached to a chat composer session.
 *
 * Items are stored as structured references — display text is decorative
 * and never the source of truth.
 */
export class ContextItemStore {
  private readonly items = new Map<string, ContextItem>();
  private modelLimit: number;

  constructor(modelLimit: number = 128_000) {
    this.modelLimit = modelLimit;
  }

  // ─── Core Operations ──────────────────────────────────────────

  /**
   * Add a context item to the store.
   * Returns false if an item with the same id already exists.
   */
  addItem(item: ContextItem): boolean {
    if (this.items.has(item.id)) {
      return false;
    }
    this.items.set(item.id, { ...item });
    return true;
  }

  /**
   * Remove a context item by id.
   * Returns false if the item did not exist.
   */
  removeItem(id: string): boolean {
    return this.items.delete(id);
  }

  /**
   * Get a context item by id.
   */
  getItem(id: string): ContextItem | undefined {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  /**
   * Get all context items in the store.
   */
  getAllItems(): readonly ContextItem[] {
    return Array.from(this.items.values()).map(item => ({ ...item }));
  }

  /**
   * Get items filtered by provenance category.
   */
  getItemsByProvenance(provenance: ContextProvenance): readonly ContextItem[] {
    return Array.from(this.items.values())
      .filter(item => item.provenance === provenance)
      .map(item => ({ ...item }));
  }

  /**
   * Get items filtered by kind.
   */
  getItemsByKind(kind: ContextItemKind): readonly ContextItem[] {
    return Array.from(this.items.values())
      .filter(item => item.kind === kind)
      .map(item => ({ ...item }));
  }

  // ─── Item Controls ────────────────────────────────────────────

  /**
   * Pin an item so it is not automatically removed.
   */
  pinItem(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.pinned = true;
    return true;
  }

  /**
   * Unpin an item.
   */
  unpinItem(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.pinned = false;
    return true;
  }

  /**
   * Mark an item as redacted before send.
   */
  redactItem(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.redacted = true;
    return true;
  }

  /**
   * Unredact an item.
   */
  unredactItem(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.redacted = false;
    return true;
  }

  /**
   * Mark an item as stale (content changed since attachment).
   */
  markStale(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.staleness = 'stale';
    return true;
  }

  /**
   * Mark an item as refreshed (version updated).
   * Returns a new ContextItem with the updated version.
   */
  refreshItem(id: string, newVersion: string, newTokenEstimate?: number): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    // Replace with refreshed version
    const refreshed: ContextItem = {
      ...item,
      version: newVersion,
      staleness: 'current',
      tokenEstimate: newTokenEstimate ?? item.tokenEstimate,
    };
    this.items.set(id, refreshed);
    return true;
  }

  /**
   * Get available controls for a context item based on its state.
   */
  getControls(id: string): ContextItemControls | null {
    const item = this.items.get(id);
    if (!item) return null;

    return {
      canInspect: true,
      canRemove: item.provenance !== 'mandatory',
      canPin: !item.pinned,
      canRefresh: item.staleness === 'stale',
      canRedact: !item.redacted,
    };
  }

  // ─── Limits and Usage ─────────────────────────────────────────

  /**
   * Set the model token limit for context usage calculations.
   */
  setModelLimit(limit: number): void {
    this.modelLimit = limit;
  }

  /**
   * Get the current model token limit.
   */
  getModelLimit(): number {
    return this.modelLimit;
  }

  /**
   * Compute the context usage summary, identifying which items would
   * be omitted or condensed if the total exceeds the model limit.
   *
   * Items are prioritized: mandatory > pinned > explicit > suggested.
   * Excluded and redacted items are never sent.
   */
  computeUsageSummary(): ContextUsageSummary {
    const includable = Array.from(this.items.values())
      .filter(item =>
        item.provenance !== 'excluded' &&
        !item.redacted &&
        item.staleness !== 'unavailable'
      );

    // Sort by priority: mandatory first, then pinned, then explicit, then suggested
    const sorted = includable.sort((a, b) => {
      const priority = (item: ContextItem): number => {
        if (item.provenance === 'mandatory') return 0;
        if (item.pinned) return 1;
        if (item.provenance === 'explicit') return 2;
        return 3;
      };
      return priority(a) - priority(b);
    });

    let totalTokens = 0;
    const omittedItemIds: string[] = [];
    let condensedCount = 0;

    // Reserve ~20% for response
    const effectiveLimit = Math.floor(this.modelLimit * 0.8);

    for (const item of sorted) {
      if (totalTokens + item.tokenEstimate <= effectiveLimit) {
        totalTokens += item.tokenEstimate;
      } else {
        omittedItemIds.push(item.id);
      }
    }

    return {
      totalTokens,
      modelLimit: this.modelLimit,
      omittedCount: omittedItemIds.length,
      condensedCount,
      omittedItemIds,
    };
  }

  /**
   * Get the total number of items in the store.
   */
  get size(): number {
    return this.items.size;
  }

  /**
   * Clear all items from the store.
   */
  clear(): void {
    this.items.clear();
  }
}
