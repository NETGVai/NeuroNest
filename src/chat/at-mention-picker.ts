/**
 * AtMentionPicker — Keyboard-operable context picker triggered by `@` input.
 *
 * Provides typed, searchable, keyboard-navigable context item suggestions
 * organized by provenance categories. Implements combobox semantics with
 * active-descendant, result-count, and selection state for accessibility.
 *
 * Requirements: 16.2, 16.3, 16.4, 23.6
 */

import type { ContextItemKind, ContextProvenance } from './context-item-store';

// ─── Types ──────────────────────────────────────────────────────

/** Category for organizing picker suggestions */
export type PickerCategory =
  | 'files'
  | 'symbols'
  | 'diagnostics'
  | 'git'
  | 'terminal'
  | 'planning'
  | 'artifacts'
  | 'urls'
  | 'recent';

/** A suggestion in the @ picker dropdown */
export interface PickerSuggestion {
  /** Unique ID for this suggestion */
  readonly id: string;
  /** The context item kind this suggestion represents */
  readonly kind: ContextItemKind;
  /** Display label shown in the picker */
  readonly label: string;
  /** Secondary description (path, signature, etc.) */
  readonly description?: string;
  /** Category for grouping */
  readonly category: PickerCategory;
  /** Token estimate for this item */
  readonly tokenEstimate: number;
  /** Whether the item is currently available (file exists, service connected, etc.) */
  readonly available: boolean;
  /** Unavailability reason if not available */
  readonly unavailableReason?: string;
  /** Relevance score for sorting (higher = more relevant) */
  readonly score: number;
}

/** State of the @ picker for accessibility and keyboard navigation */
export interface PickerState {
  /** Whether the picker is open */
  readonly isOpen: boolean;
  /** Current search/filter query (text after @) */
  readonly query: string;
  /** Index of the active (focused) suggestion */
  readonly activeIndex: number;
  /** Total available suggestions after filtering */
  readonly resultCount: number;
  /** Currently visible suggestions */
  readonly suggestions: readonly PickerSuggestion[];
  /** Active categories being shown */
  readonly activeCategories: readonly PickerCategory[];
}

/** Provider interface for resolving context items */
export interface PickerDataProvider {
  /** Get file suggestions matching a query */
  getFiles(query: string): PickerSuggestion[];
  /** Get symbol suggestions matching a query */
  getSymbols(query: string): PickerSuggestion[];
  /** Get diagnostic suggestions */
  getDiagnostics(query: string): PickerSuggestion[];
  /** Get Git diff/commit suggestions */
  getGitItems(query: string): PickerSuggestion[];
  /** Get terminal output suggestions */
  getTerminalItems(query: string): PickerSuggestion[];
  /** Get planning entity suggestions (specs, tasks, runs) */
  getPlanningItems(query: string): PickerSuggestion[];
  /** Get artifact suggestions */
  getArtifacts(query: string): PickerSuggestion[];
  /** Get approved URL suggestions */
  getUrls(query: string): PickerSuggestion[];
  /** Get recent items */
  getRecent(): PickerSuggestion[];
}

/** Maximum suggestions shown at once */
const MAX_VISIBLE_SUGGESTIONS = 20;

// ─── AtMentionPicker ────────────────────────────────────────────

/**
 * AtMentionPicker manages the keyboard-operable @ context picker.
 *
 * It exposes combobox-style navigation (up/down/enter/escape) with
 * active-descendant semantics for screen reader accessibility.
 */
export class AtMentionPicker {
  private state: PickerState = {
    isOpen: false,
    query: '',
    activeIndex: -1,
    resultCount: 0,
    suggestions: [],
    activeCategories: [],
  };

  private dataProvider: PickerDataProvider | null = null;

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Set the data provider for resolving suggestions.
   */
  setDataProvider(provider: PickerDataProvider): void {
    this.dataProvider = provider;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Open the picker with an optional initial query.
   * Triggers suggestion refresh.
   */
  open(query: string = ''): PickerState {
    this.state = {
      ...this.state,
      isOpen: true,
      query,
      activeIndex: -1,
    };
    return this.refreshSuggestions();
  }

  /**
   * Close the picker and reset state.
   */
  close(): PickerState {
    this.state = {
      isOpen: false,
      query: '',
      activeIndex: -1,
      resultCount: 0,
      suggestions: [],
      activeCategories: [],
    };
    return this.getState();
  }

  /**
   * Update the query (text typed after @). Refreshes suggestions.
   */
  updateQuery(query: string): PickerState {
    this.state = {
      ...this.state,
      query,
      activeIndex: -1,
    };
    return this.refreshSuggestions();
  }

  // ─── Keyboard Navigation ──────────────────────────────────────

  /**
   * Move active selection down. Wraps to top when at end.
   */
  moveDown(): PickerState {
    if (!this.state.isOpen || this.state.suggestions.length === 0) {
      return this.getState();
    }

    const nextIndex = this.state.activeIndex >= this.state.suggestions.length - 1
      ? 0
      : this.state.activeIndex + 1;

    this.state = { ...this.state, activeIndex: nextIndex };
    return this.getState();
  }

  /**
   * Move active selection up. Wraps to bottom when at start.
   */
  moveUp(): PickerState {
    if (!this.state.isOpen || this.state.suggestions.length === 0) {
      return this.getState();
    }

    const nextIndex = this.state.activeIndex <= 0
      ? this.state.suggestions.length - 1
      : this.state.activeIndex - 1;

    this.state = { ...this.state, activeIndex: nextIndex };
    return this.getState();
  }

  /**
   * Select the currently active suggestion. Returns the selected suggestion
   * or null if nothing is active.
   */
  selectActive(): PickerSuggestion | null {
    if (!this.state.isOpen || this.state.activeIndex < 0) {
      return null;
    }

    const selected = this.state.suggestions[this.state.activeIndex];
    if (!selected || !selected.available) {
      return null;
    }

    // Close picker after selection
    this.close();
    return selected;
  }

  /**
   * Select a suggestion by its ID. Returns the suggestion or null.
   */
  selectById(id: string): PickerSuggestion | null {
    const suggestion = this.state.suggestions.find(s => s.id === id);
    if (!suggestion || !suggestion.available) {
      return null;
    }

    this.close();
    return suggestion;
  }

  // ─── State Access ─────────────────────────────────────────────

  /**
   * Get the current picker state (for rendering and accessibility).
   */
  getState(): Readonly<PickerState> {
    return { ...this.state };
  }

  /**
   * Get the active descendant ID for aria-activedescendant.
   * Returns null when nothing is active.
   */
  getActiveDescendantId(): string | null {
    if (this.state.activeIndex < 0) return null;
    const active = this.state.suggestions[this.state.activeIndex];
    return active?.id ?? null;
  }

  /**
   * Get the result count announcement text for screen readers.
   */
  getResultCountAnnouncement(): string {
    const count = this.state.resultCount;
    if (count === 0) return 'No matching context items found';
    if (count === 1) return '1 context item available';
    return `${count} context items available`;
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Refresh suggestions from the data provider based on current query.
   */
  private refreshSuggestions(): PickerState {
    if (!this.dataProvider) {
      this.state = {
        ...this.state,
        suggestions: [],
        resultCount: 0,
        activeCategories: [],
      };
      return this.getState();
    }

    const query = this.state.query;
    let allSuggestions: PickerSuggestion[] = [];

    // Determine which category the query targets
    const colonIndex = query.indexOf(':');
    if (colonIndex > 0) {
      const prefix = query.slice(0, colonIndex);
      const argument = query.slice(colonIndex + 1);
      allSuggestions = this.getSuggestionsForPrefix(prefix, argument);
    } else {
      // No prefix — show all categories filtered by query
      allSuggestions = this.getAllCategorySuggestions(query);
    }

    // Sort by score descending and limit
    allSuggestions.sort((a, b) => b.score - a.score);
    const visible = allSuggestions.slice(0, MAX_VISIBLE_SUGGESTIONS);

    // Collect active categories
    const categories = new Set(visible.map(s => s.category));

    this.state = {
      ...this.state,
      suggestions: Object.freeze(visible),
      resultCount: allSuggestions.length,
      activeCategories: Object.freeze(Array.from(categories)),
    };

    return this.getState();
  }

  private getSuggestionsForPrefix(prefix: string, argument: string): PickerSuggestion[] {
    if (!this.dataProvider) return [];

    switch (prefix) {
      case 'file':
        return this.dataProvider.getFiles(argument);
      case 'symbol':
        return this.dataProvider.getSymbols(argument);
      case 'diagnostic':
        return this.dataProvider.getDiagnostics(argument);
      case 'git':
        return this.dataProvider.getGitItems(argument);
      case 'terminal':
        return this.dataProvider.getTerminalItems(argument);
      case 'task':
      case 'spec':
      case 'run':
        return this.dataProvider.getPlanningItems(argument);
      case 'artifact':
        return this.dataProvider.getArtifacts(argument);
      case 'url':
        return this.dataProvider.getUrls(argument);
      default:
        return [];
    }
  }

  private getAllCategorySuggestions(query: string): PickerSuggestion[] {
    if (!this.dataProvider) return [];

    const results: PickerSuggestion[] = [];

    // If query is empty or short, prioritize recent items
    if (query.length <= 2) {
      results.push(...this.dataProvider.getRecent());
    }

    // Add items from all categories filtered by query
    results.push(...this.dataProvider.getFiles(query));
    results.push(...this.dataProvider.getSymbols(query));
    results.push(...this.dataProvider.getDiagnostics(query));
    results.push(...this.dataProvider.getGitItems(query));
    results.push(...this.dataProvider.getTerminalItems(query));
    results.push(...this.dataProvider.getPlanningItems(query));
    results.push(...this.dataProvider.getArtifacts(query));
    results.push(...this.dataProvider.getUrls(query));

    return results;
  }
}
