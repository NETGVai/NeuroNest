/**
 * ComboboxAccessibility — Provides complete combobox ARIA semantics for
 * the @-mention context picker and similar dropdown patterns.
 *
 * Implements:
 * - role="combobox" on the input
 * - role="listbox" on the dropdown
 * - role="option" on each item
 * - aria-activedescendant for virtual focus
 * - aria-expanded for open/closed state
 * - aria-selected for current selection
 * - Result count announcement via aria-live
 *
 * Requirements: 23.6
 */

/** State tracked for combobox accessibility */
export interface ComboboxState {
  /** Whether the listbox is expanded */
  readonly isExpanded: boolean;
  /** Total available options */
  readonly resultCount: number;
  /** Index of the active descendant (keyboard-focused option) */
  readonly activeDescendantIndex: number;
  /** ID of the active descendant element */
  readonly activeDescendantId: string | null;
  /** IDs of selected options (multi-select mode) */
  readonly selectedIds: readonly string[];
}

/**
 * ComboboxAccessibility manages ARIA attributes and announcements
 * for combobox/listbox patterns like the @-mention picker.
 *
 * It does not render DOM elements but provides the attribute values
 * that a renderer should apply to its elements.
 */
export class ComboboxAccessibility {
  private state: ComboboxState = {
    isExpanded: false,
    resultCount: 0,
    activeDescendantIndex: -1,
    activeDescendantId: null,
    selectedIds: [],
  };

  private readonly inputId: string;
  private readonly listboxId: string;
  private optionIds: string[] = [];

  constructor(inputId: string, listboxId: string) {
    this.inputId = inputId;
    this.listboxId = listboxId;
  }

  /**
   * Get attributes to apply to the combobox input element.
   */
  getInputAttributes(): Record<string, string> {
    return {
      role: 'combobox',
      'aria-expanded': String(this.state.isExpanded),
      'aria-controls': this.listboxId,
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      ...(this.state.activeDescendantId
        ? { 'aria-activedescendant': this.state.activeDescendantId }
        : {}),
    };
  }

  /**
   * Get attributes to apply to the listbox container.
   */
  getListboxAttributes(): Record<string, string> {
    return {
      id: this.listboxId,
      role: 'listbox',
      'aria-label': 'Context items',
    };
  }

  /**
   * Get attributes for an individual option element.
   */
  getOptionAttributes(optionId: string, index: number): Record<string, string> {
    const isActive = index === this.state.activeDescendantIndex;
    const isSelected = this.state.selectedIds.includes(optionId);

    return {
      id: optionId,
      role: 'option',
      'aria-selected': String(isSelected),
      ...(isActive ? { 'aria-current': 'true' } : {}),
    };
  }

  /**
   * Open the combobox and update option IDs.
   */
  open(optionIds: string[]): ComboboxState {
    this.optionIds = optionIds;
    this.state = {
      ...this.state,
      isExpanded: true,
      resultCount: optionIds.length,
      activeDescendantIndex: -1,
      activeDescendantId: null,
    };
    return this.getState();
  }

  /**
   * Close the combobox.
   */
  close(): ComboboxState {
    this.state = {
      ...this.state,
      isExpanded: false,
      activeDescendantIndex: -1,
      activeDescendantId: null,
    };
    return this.getState();
  }

  /**
   * Update the option list (e.g., after filtering).
   */
  updateOptions(optionIds: string[]): ComboboxState {
    this.optionIds = optionIds;
    this.state = {
      ...this.state,
      resultCount: optionIds.length,
      activeDescendantIndex: -1,
      activeDescendantId: null,
    };
    return this.getState();
  }

  /**
   * Move active descendant down.
   */
  moveDown(): ComboboxState {
    if (this.optionIds.length === 0) return this.getState();

    const nextIndex = this.state.activeDescendantIndex >= this.optionIds.length - 1
      ? 0
      : this.state.activeDescendantIndex + 1;

    this.state = {
      ...this.state,
      activeDescendantIndex: nextIndex,
      activeDescendantId: this.optionIds[nextIndex] ?? null,
    };
    return this.getState();
  }

  /**
   * Move active descendant up.
   */
  moveUp(): ComboboxState {
    if (this.optionIds.length === 0) return this.getState();

    const prevIndex = this.state.activeDescendantIndex <= 0
      ? this.optionIds.length - 1
      : this.state.activeDescendantIndex - 1;

    this.state = {
      ...this.state,
      activeDescendantIndex: prevIndex,
      activeDescendantId: this.optionIds[prevIndex] ?? null,
    };
    return this.getState();
  }

  /**
   * Select the active descendant.
   */
  selectActive(): string | null {
    if (this.state.activeDescendantIndex < 0) return null;
    const id = this.optionIds[this.state.activeDescendantIndex];
    if (!id) return null;

    this.state = {
      ...this.state,
      selectedIds: [...this.state.selectedIds, id],
    };
    return id;
  }

  /**
   * Toggle selection of the active descendant.
   */
  toggleActive(): string | null {
    if (this.state.activeDescendantIndex < 0) return null;
    const id = this.optionIds[this.state.activeDescendantIndex];
    if (!id) return null;

    const isSelected = this.state.selectedIds.includes(id);
    this.state = {
      ...this.state,
      selectedIds: isSelected
        ? this.state.selectedIds.filter(s => s !== id)
        : [...this.state.selectedIds, id],
    };
    return id;
  }

  /**
   * Clear all selections.
   */
  clearSelections(): void {
    this.state = { ...this.state, selectedIds: [] };
  }

  /**
   * Get the current state.
   */
  getState(): Readonly<ComboboxState> {
    return { ...this.state };
  }

  /**
   * Get a result count announcement string for aria-live.
   */
  getResultCountAnnouncement(): string {
    const count = this.state.resultCount;
    if (count === 0) return 'No results found.';
    if (count === 1) return '1 result available.';
    return `${count} results available.`;
  }

  /**
   * Get the label for the currently active option (for announcement).
   */
  getActiveOptionLabel(labels: Map<string, string>): string | null {
    if (!this.state.activeDescendantId) return null;
    return labels.get(this.state.activeDescendantId) ?? null;
  }
}
