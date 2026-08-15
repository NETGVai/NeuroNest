/**
 * GutterIndicatorService — Provides optional gutter and overview ruler
 * indications that do not obscure diagnostics.
 *
 * Indicates lines linked to:
 * - Tasks (linked code regions)
 * - Pending agent edits (proposed changes)
 * - Review status (accepted/rejected hunks)
 * - Failing evidence (validation failures)
 *
 * These indicators are:
 * - Optional (can be toggled on/off)
 * - Non-obstructive (positioned so they don't obscure diagnostic markers)
 * - Semantic (different visual treatment per indication type)
 *
 * Requirements: 19.4
 */

/**
 * Types of gutter indicators.
 */
export type GutterIndicatorKind =
  | 'task-linked'
  | 'pending-agent-edit'
  | 'review-accepted'
  | 'review-rejected'
  | 'review-pending'
  | 'failing-evidence';

/**
 * A single gutter indicator for a line range.
 */
export interface GutterIndicator {
  id: string;
  uri: string;
  kind: GutterIndicatorKind;
  range: { startLine: number; endLine: number };
  entityId: string;
  label: string;
  /** Whether this indicator is currently visible (respects user preference) */
  visible: boolean;
}

/**
 * Overview ruler mark for the minimap/scrollbar area.
 */
export interface OverviewRulerMark {
  id: string;
  uri: string;
  kind: GutterIndicatorKind;
  startLine: number;
  endLine: number;
  entityId: string;
}

/**
 * User preference for gutter indicator visibility.
 */
export interface GutterPreferences {
  /** Master toggle for all gutter indicators */
  enabled: boolean;
  /** Per-kind visibility */
  showTaskLinked: boolean;
  showPendingAgentEdits: boolean;
  showReviewStatus: boolean;
  showFailingEvidence: boolean;
  /** Whether to show overview ruler marks */
  showOverviewRuler: boolean;
}

const DEFAULT_PREFERENCES: GutterPreferences = {
  enabled: true,
  showTaskLinked: true,
  showPendingAgentEdits: true,
  showReviewStatus: true,
  showFailingEvidence: true,
  showOverviewRuler: true,
};

/**
 * Listener for indicator changes.
 */
export type GutterIndicatorListener = (indicators: GutterIndicator[], overviewMarks: OverviewRulerMark[]) => void;

/**
 * GutterIndicatorService manages optional, non-obstructive gutter
 * and overview ruler indicators for planning-linked code regions.
 */
export class GutterIndicatorService {
  private indicators = new Map<string, GutterIndicator>();
  private overviewMarks = new Map<string, OverviewRulerMark>();
  private preferences: GutterPreferences = { ...DEFAULT_PREFERENCES };
  private listeners = new Set<GutterIndicatorListener>();
  private nextId = 1;

  /**
   * Get current preferences.
   */
  getPreferences(): Readonly<GutterPreferences> {
    return this.preferences;
  }

  /**
   * Update user preferences.
   */
  setPreferences(prefs: Partial<GutterPreferences>): void {
    this.preferences = { ...this.preferences, ...prefs };
    this.recalculateVisibility();
    this.notifyListeners();
  }

  /**
   * Add a gutter indicator for a code region.
   * Returns the indicator ID.
   */
  addIndicator(
    uri: string,
    kind: GutterIndicatorKind,
    range: { startLine: number; endLine: number },
    entityId: string,
    label: string,
  ): string {
    const id = `gutter-${this.nextId++}`;
    const visible = this.isKindVisible(kind);

    const indicator: GutterIndicator = {
      id,
      uri,
      kind,
      range,
      entityId,
      label,
      visible,
    };

    this.indicators.set(id, indicator);

    // Also create an overview ruler mark
    if (this.preferences.showOverviewRuler) {
      const markId = `mark-${id}`;
      this.overviewMarks.set(markId, {
        id: markId,
        uri,
        kind,
        startLine: range.startLine,
        endLine: range.endLine,
        entityId,
      });
    }

    this.notifyListeners();
    return id;
  }

  /**
   * Remove an indicator by ID.
   */
  removeIndicator(indicatorId: string): boolean {
    const removed = this.indicators.delete(indicatorId);
    this.overviewMarks.delete(`mark-${indicatorId}`);
    if (removed) {
      this.notifyListeners();
    }
    return removed;
  }

  /**
   * Remove all indicators for a given entity.
   */
  removeIndicatorsForEntity(entityId: string): number {
    let removed = 0;
    for (const [id, indicator] of this.indicators) {
      if (indicator.entityId === entityId) {
        this.indicators.delete(id);
        this.overviewMarks.delete(`mark-${id}`);
        removed++;
      }
    }
    if (removed > 0) this.notifyListeners();
    return removed;
  }

  /**
   * Remove all indicators for a given file URI.
   */
  removeIndicatorsForFile(uri: string): number {
    let removed = 0;
    for (const [id, indicator] of this.indicators) {
      if (indicator.uri === uri) {
        this.indicators.delete(id);
        this.overviewMarks.delete(`mark-${id}`);
        removed++;
      }
    }
    if (removed > 0) this.notifyListeners();
    return removed;
  }

  /**
   * Get all visible indicators for a specific file.
   */
  getIndicatorsForFile(uri: string): GutterIndicator[] {
    if (!this.preferences.enabled) return [];
    return [...this.indicators.values()].filter(
      (ind) => ind.uri === uri && ind.visible,
    );
  }

  /**
   * Get all visible overview ruler marks for a specific file.
   */
  getOverviewMarksForFile(uri: string): OverviewRulerMark[] {
    if (!this.preferences.enabled || !this.preferences.showOverviewRuler) return [];
    return [...this.overviewMarks.values()].filter(
      (mark) => mark.uri === uri && this.isKindVisible(mark.kind),
    );
  }

  /**
   * Get all indicators (regardless of visibility) for inspection.
   */
  getAllIndicators(): GutterIndicator[] {
    return [...this.indicators.values()];
  }

  /**
   * Get total count of indicators.
   */
  get size(): number {
    return this.indicators.size;
  }

  /**
   * Clear all indicators.
   */
  clear(): void {
    this.indicators.clear();
    this.overviewMarks.clear();
    this.notifyListeners();
  }

  /**
   * Subscribe to indicator changes.
   */
  subscribe(listener: GutterIndicatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Batch update indicators for a file (replaces all for that URI).
   */
  setIndicatorsForFile(
    uri: string,
    entries: Array<{
      kind: GutterIndicatorKind;
      range: { startLine: number; endLine: number };
      entityId: string;
      label: string;
    }>,
  ): void {
    // Remove existing indicators for this file
    for (const [id, indicator] of this.indicators) {
      if (indicator.uri === uri) {
        this.indicators.delete(id);
        this.overviewMarks.delete(`mark-${id}`);
      }
    }

    // Add new ones
    for (const entry of entries) {
      const id = `gutter-${this.nextId++}`;
      const visible = this.isKindVisible(entry.kind);

      this.indicators.set(id, {
        id,
        uri,
        kind: entry.kind,
        range: entry.range,
        entityId: entry.entityId,
        label: entry.label,
        visible,
      });

      if (this.preferences.showOverviewRuler) {
        this.overviewMarks.set(`mark-${id}`, {
          id: `mark-${id}`,
          uri,
          kind: entry.kind,
          startLine: entry.range.startLine,
          endLine: entry.range.endLine,
          entityId: entry.entityId,
        });
      }
    }

    this.notifyListeners();
  }

  private isKindVisible(kind: GutterIndicatorKind): boolean {
    if (!this.preferences.enabled) return false;
    switch (kind) {
      case 'task-linked':
        return this.preferences.showTaskLinked;
      case 'pending-agent-edit':
        return this.preferences.showPendingAgentEdits;
      case 'review-accepted':
      case 'review-rejected':
      case 'review-pending':
        return this.preferences.showReviewStatus;
      case 'failing-evidence':
        return this.preferences.showFailingEvidence;
    }
  }

  private recalculateVisibility(): void {
    for (const indicator of this.indicators.values()) {
      indicator.visible = this.isKindVisible(indicator.kind);
    }
  }

  private notifyListeners(): void {
    const indicators = [...this.indicators.values()];
    const marks = [...this.overviewMarks.values()];
    for (const listener of this.listeners) {
      listener(indicators, marks);
    }
  }
}
