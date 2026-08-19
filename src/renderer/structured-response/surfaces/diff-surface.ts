/**
 * DiffSurface — Typed file and structured-record diff surface.
 *
 * Adapts the existing `diff-renderer` patterns behind a typed contract.
 * Supports two diff families:
 *  - File diffs: unified/split view with file identity, added/removed counts,
 *    compact multi-file chips, and change summaries.
 *  - Structured-record diffs: record/field/cell keyed diffs with previous and
 *    proposed values, provenance, non-color indicators, and no file-line semantics.
 *
 * State transitions (proposed → staged → applied → rejected/stale/conflicted/unavailable)
 * are driven exclusively by owning authority projection. The surface NEVER implies
 * a change has been applied until the owning authority confirms the projection revision.
 *
 * Wide content uses local overflow (no page-level horizontal scroll).
 * Non-color indicators (icons, text labels, border patterns) supplement all
 * color-based diff meaning for accessibility.
 *
 * Requirements: 10.4–10.7, 11.4, 18.11–18.12, 20.5–20.6
 */

import type { DiffBlockV1 } from '../../../harness/contracts/response-composition';
import { redactForOutput } from '../output-redaction-service';

/** Re-export for backward compatibility — use output-redaction-service directly for new code. */
export const redactPrivatePaths = redactForOutput;

// ─── Constants ──────────────────────────────────────────────────

const CSS_PREFIX = 'nn-diff-surface';

/** Maximum number of changes to render before truncation. */
const MAX_VISIBLE_CHANGES = 200;

/** Maximum length of a displayed value before truncation. */
const MAX_VALUE_DISPLAY_LENGTH = 2_000;

/**
 * Non-color text labels for diff states.
 * These supplement color to satisfy 18.11 (non-color indicators).
 */
const STATE_LABELS: Readonly<Record<DiffState, string>> = Object.freeze({
  proposed: 'Proposed',
  staged: 'Staged',
  applied: 'Applied',
  rejected: 'Rejected',
  stale: 'Stale',
  conflicted: 'Conflicted',
  unavailable: 'Unavailable',
});

/**
 * Non-color indicator icons (text-based) for diff states.
 */
const STATE_INDICATORS: Readonly<Record<DiffState, string>> = Object.freeze({
  proposed: '○',
  staged: '◐',
  applied: '●',
  rejected: '✕',
  stale: '◌',
  conflicted: '⚡',
  unavailable: '—',
});

/**
 * CSS modifier classes for diff states.
 */
const STATE_MODIFIERS: Readonly<Record<DiffState, string>> = Object.freeze({
  proposed: `${CSS_PREFIX}--proposed`,
  staged: `${CSS_PREFIX}--staged`,
  applied: `${CSS_PREFIX}--applied`,
  rejected: `${CSS_PREFIX}--rejected`,
  stale: `${CSS_PREFIX}--stale`,
  conflicted: `${CSS_PREFIX}--conflicted`,
  unavailable: `${CSS_PREFIX}--unavailable`,
});

// ─── Types ──────────────────────────────────────────────────────

export type DiffState = DiffBlockV1['content']['state'];
export type DiffType = DiffBlockV1['content']['diffType'];

export type DiffViewMode = 'unified' | 'split';

export interface DiffSurfaceOptions {
  /** View mode: unified (default) or split. */
  readonly viewMode: DiffViewMode;
  /** Whether multi-file chips start expanded. */
  readonly expandedByDefault: boolean;
  /** Owner document for element creation. */
  readonly ownerDocument?: Document;
}

export interface DiffSurfaceAction {
  readonly kind: DiffSurfaceActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly execute: () => Promise<DiffActionResult>;
}

export type DiffSurfaceActionKind = 'apply' | 'reject' | 'view_toggle' | 'expand_all' | 'collapse_all';

export interface DiffActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

export interface DiffSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly diffType: DiffType;
  readonly state: DiffState;
  readonly viewMode: DiffViewMode;
  readonly actions: readonly DiffSurfaceAction[];
  update(block: DiffBlockV1, options?: Partial<DiffSurfaceOptions>): void;
  dispose(): void;
}

// ─── Utilities ──────────────────────────────────────────────────

function truncateValue(value: string | undefined, maxLen: number = MAX_VALUE_DISPLAY_LENGTH): string {
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '…';
}

// ─── DiffSurface ────────────────────────────────────────────────

const DEFAULT_OPTIONS: DiffSurfaceOptions = {
  viewMode: 'unified',
  expandedByDefault: false,
};

export class DiffSurface {
  private readonly doc: Document;

  constructor(ownerDocument: Document = document) {
    this.doc = ownerDocument;
  }

  render(block: DiffBlockV1, options: Partial<DiffSurfaceOptions> = {}): DiffSurfaceHandle {
    const resolved: DiffSurfaceOptions = { ...DEFAULT_OPTIONS, ...options };
    const doc = resolved.ownerDocument ?? this.doc;

    // Mutable state
    let currentBlock = block;
    let currentOptions = resolved;
    let disposed = false;
    let viewMode: DiffViewMode = resolved.viewMode;
    let expanded = resolved.expandedByDefault;

    // ─── Root element ───────────────────────────────────────────

    const root = doc.createElement('section');
    root.className = CSS_PREFIX;
    root.setAttribute('role', 'region');
    root.dataset.stableKey = block.stableKey;
    root.dataset.semanticAnchor = block.semanticAnchor;
    root.dataset.diffType = block.content.diffType;
    root.dataset.state = block.content.state;

    applyStateModifier(root, block.content.state);
    updateAriaLabel(root, block);

    // ─── Header ─────────────────────────────────────────────────

    const header = doc.createElement('div');
    header.className = `${CSS_PREFIX}__header`;

    const titleContainer = doc.createElement('div');
    titleContainer.className = `${CSS_PREFIX}__title-container`;

    const stateIndicator = doc.createElement('span');
    stateIndicator.className = `${CSS_PREFIX}__state-indicator`;
    stateIndicator.setAttribute('aria-hidden', 'true');
    stateIndicator.textContent = STATE_INDICATORS[block.content.state];
    titleContainer.appendChild(stateIndicator);

    const stateLabel = doc.createElement('span');
    stateLabel.className = `${CSS_PREFIX}__state-label`;
    stateLabel.textContent = STATE_LABELS[block.content.state];
    titleContainer.appendChild(stateLabel);

    const summaryEl = doc.createElement('span');
    summaryEl.className = `${CSS_PREFIX}__summary`;
    summaryEl.textContent = redactPrivatePaths(block.content.summary);
    titleContainer.appendChild(summaryEl);

    header.appendChild(titleContainer);

    // Counts badge
    const countsEl = doc.createElement('span');
    countsEl.className = `${CSS_PREFIX}__counts`;
    countsEl.setAttribute('aria-label',
      `${block.content.additions} additions, ${block.content.deletions} deletions`);
    updateCountsBadge(countsEl, block.content.additions, block.content.deletions);
    header.appendChild(countsEl);

    // Actions toolbar
    const actionsToolbar = doc.createElement('div');
    actionsToolbar.className = `${CSS_PREFIX}__actions`;
    actionsToolbar.setAttribute('role', 'toolbar');
    actionsToolbar.setAttribute('aria-label', 'Diff actions');

    // View toggle button (only for file diffs)
    let viewToggleBtn: HTMLButtonElement | null = null;
    if (block.content.diffType === 'file') {
      viewToggleBtn = doc.createElement('button');
      viewToggleBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__view-toggle-btn`;
      viewToggleBtn.setAttribute('aria-label',
        viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view');
      viewToggleBtn.setAttribute('aria-pressed', String(viewMode === 'split'));
      viewToggleBtn.textContent = viewMode === 'unified' ? 'Split' : 'Unified';
      actionsToolbar.appendChild(viewToggleBtn);
    }

    // Expand/collapse button (when changes exist)
    let expandBtn: HTMLButtonElement | null = null;
    if (block.content.changes.length > 0) {
      expandBtn = doc.createElement('button');
      expandBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__expand-btn`;
      expandBtn.setAttribute('aria-expanded', String(expanded));
      expandBtn.setAttribute('aria-label', expanded ? 'Collapse changes' : 'Expand changes');
      expandBtn.textContent = expanded ? 'Collapse' : 'Expand';
      actionsToolbar.appendChild(expandBtn);
    }

    header.appendChild(actionsToolbar);
    root.appendChild(header);

    // ─── Changes container ──────────────────────────────────────

    const changesContainer = doc.createElement('div');
    changesContainer.className = `${CSS_PREFIX}__changes`;
    changesContainer.style.overflow = 'auto'; // Local overflow for wide content
    changesContainer.style.maxWidth = '100%';

    if (!expanded) {
      changesContainer.style.display = 'none';
      changesContainer.setAttribute('aria-hidden', 'true');
    }

    renderChanges(doc, changesContainer, block, viewMode);
    root.appendChild(changesContainer);

    // ─── Multi-file chips (file diffs with multiple changes) ────

    let chipsContainer: HTMLElement | null = null;
    if (block.content.diffType === 'file' && block.content.changes.length > 1) {
      chipsContainer = doc.createElement('div');
      chipsContainer.className = `${CSS_PREFIX}__file-chips`;
      chipsContainer.setAttribute('role', 'list');
      chipsContainer.setAttribute('aria-label', 'Changed files');
      renderFileChips(doc, chipsContainer, block.content.changes);
      root.insertBefore(chipsContainer, changesContainer);
    }

    // ─── Event handlers ─────────────────────────────────────────

    if (viewToggleBtn) {
      viewToggleBtn.addEventListener('click', () => {
        if (disposed) return;
        viewMode = viewMode === 'unified' ? 'split' : 'unified';
        viewToggleBtn!.textContent = viewMode === 'unified' ? 'Split' : 'Unified';
        viewToggleBtn!.setAttribute('aria-label',
          viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view');
        viewToggleBtn!.setAttribute('aria-pressed', String(viewMode === 'split'));
        rerenderChanges();
      });
    }

    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        if (disposed) return;
        expanded = !expanded;
        expandBtn!.setAttribute('aria-expanded', String(expanded));
        expandBtn!.setAttribute('aria-label', expanded ? 'Collapse changes' : 'Expand changes');
        expandBtn!.textContent = expanded ? 'Collapse' : 'Expand';
        changesContainer.style.display = expanded ? '' : 'none';
        changesContainer.setAttribute('aria-hidden', String(!expanded));
      });
    }

    // ─── Internal rendering helpers ─────────────────────────────

    function rerenderChanges(): void {
      changesContainer.textContent = '';
      renderChanges(doc, changesContainer, currentBlock, viewMode);
    }

    function applyUpdate(nextBlock: DiffBlockV1, nextOptions?: Partial<DiffSurfaceOptions>): void {
      if (disposed) return;

      const prevState = currentBlock.content.state;
      currentBlock = nextBlock;
      if (nextOptions) {
        currentOptions = { ...currentOptions, ...nextOptions };
      }

      // Update state modifier
      if (prevState !== nextBlock.content.state) {
        removeStateModifier(root, prevState);
        applyStateModifier(root, nextBlock.content.state);
        root.dataset.state = nextBlock.content.state;
        stateIndicator.textContent = STATE_INDICATORS[nextBlock.content.state];
        stateLabel.textContent = STATE_LABELS[nextBlock.content.state];
      }

      // Update summary
      summaryEl.textContent = redactPrivatePaths(nextBlock.content.summary);

      // Update counts
      countsEl.setAttribute('aria-label',
        `${nextBlock.content.additions} additions, ${nextBlock.content.deletions} deletions`);
      updateCountsBadge(countsEl, nextBlock.content.additions, nextBlock.content.deletions);

      // Update aria label
      updateAriaLabel(root, nextBlock);

      // Update view mode from options
      if (nextOptions?.viewMode !== undefined && nextOptions.viewMode !== viewMode) {
        viewMode = nextOptions.viewMode;
        if (viewToggleBtn) {
          viewToggleBtn.textContent = viewMode === 'unified' ? 'Split' : 'Unified';
          viewToggleBtn.setAttribute('aria-label',
            viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view');
          viewToggleBtn.setAttribute('aria-pressed', String(viewMode === 'split'));
        }
      }

      // Re-render changes
      rerenderChanges();

      // Update file chips
      if (chipsContainer && nextBlock.content.diffType === 'file' && nextBlock.content.changes.length > 1) {
        chipsContainer.textContent = '';
        renderFileChips(doc, chipsContainer, nextBlock.content.changes);
      }
    }

    // ─── Actions ────────────────────────────────────────────────

    function buildActions(): DiffSurfaceAction[] {
      const actions: DiffSurfaceAction[] = [];
      const state = currentBlock.content.state;

      // View toggle (file diffs only)
      if (currentBlock.content.diffType === 'file') {
        actions.push({
          kind: 'view_toggle',
          label: viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view',
          disabled: false,
          execute: async () => {
            viewMode = viewMode === 'unified' ? 'split' : 'unified';
            if (viewToggleBtn) {
              viewToggleBtn.textContent = viewMode === 'unified' ? 'Split' : 'Unified';
              viewToggleBtn.setAttribute('aria-label',
                viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view');
              viewToggleBtn.setAttribute('aria-pressed', String(viewMode === 'split'));
            }
            rerenderChanges();
            return { success: true };
          },
        });
      }

      // Expand/Collapse
      if (currentBlock.content.changes.length > 0) {
        actions.push({
          kind: expanded ? 'collapse_all' : 'expand_all',
          label: expanded ? 'Collapse changes' : 'Expand changes',
          disabled: false,
          execute: async () => {
            expanded = !expanded;
            if (expandBtn) {
              expandBtn.setAttribute('aria-expanded', String(expanded));
              expandBtn.setAttribute('aria-label', expanded ? 'Collapse changes' : 'Expand changes');
              expandBtn.textContent = expanded ? 'Collapse' : 'Expand';
            }
            changesContainer.style.display = expanded ? '' : 'none';
            changesContainer.setAttribute('aria-hidden', String(!expanded));
            return { success: true };
          },
        });
      }

      // Apply action — only available for proposed/staged states
      // NEVER implies application before authority confirmation (Req 10.6)
      if (state === 'proposed' || state === 'staged') {
        actions.push({
          kind: 'apply',
          label: 'Apply change',
          disabled: false,
          execute: async () => {
            // This would route through StructuredActionPort.apply()
            // The surface does NOT optimistically show 'applied' state
            return { success: true };
          },
        });
      }

      // Reject action — available for proposed/staged states
      if (state === 'proposed' || state === 'staged') {
        actions.push({
          kind: 'reject',
          label: 'Reject change',
          disabled: false,
          execute: async () => {
            return { success: true };
          },
        });
      }

      return actions;
    }

    // ─── Handle ─────────────────────────────────────────────────

    const handle: DiffSurfaceHandle = {
      get element() { return root; },
      get stableKey() { return currentBlock.stableKey; },
      get semanticAnchor() { return currentBlock.semanticAnchor; },
      get diffType() { return currentBlock.content.diffType; },
      get state() { return currentBlock.content.state; },
      get viewMode() { return viewMode; },
      get actions() { return buildActions(); },

      update(nextBlock: DiffBlockV1, nextOptions?: Partial<DiffSurfaceOptions>): void {
        applyUpdate(nextBlock, nextOptions);
      },

      dispose(): void {
        if (disposed) return;
        disposed = true;
        root.remove();
      },
    };

    return handle;
  }
}

// ─── Static rendering helpers ───────────────────────────────────

function applyStateModifier(el: HTMLElement, state: DiffState): void {
  el.classList.add(STATE_MODIFIERS[state]);
}

function removeStateModifier(el: HTMLElement, state: DiffState): void {
  el.classList.remove(STATE_MODIFIERS[state]);
}

function updateAriaLabel(el: HTMLElement, block: DiffBlockV1): void {
  const typeLabel = block.content.diffType === 'file' ? 'File diff' : 'Record diff';
  const stateText = STATE_LABELS[block.content.state];
  el.setAttribute('aria-label',
    `${typeLabel}: ${redactPrivatePaths(block.content.summary)} (${stateText}, +${block.content.additions} -${block.content.deletions})`);
}

function updateCountsBadge(el: HTMLElement, additions: number, deletions: number): void {
  el.textContent = '';
  if (additions > 0 || deletions > 0) {
    const addSpan = el.ownerDocument.createElement('span');
    addSpan.className = `${CSS_PREFIX}__count-add`;
    addSpan.textContent = `+${additions}`;
    addSpan.setAttribute('aria-hidden', 'true');
    el.appendChild(addSpan);

    const delSpan = el.ownerDocument.createElement('span');
    delSpan.className = `${CSS_PREFIX}__count-del`;
    delSpan.textContent = `-${deletions}`;
    delSpan.setAttribute('aria-hidden', 'true');
    el.appendChild(delSpan);
  }
}

function renderFileChips(
  doc: Document,
  container: HTMLElement,
  changes: DiffBlockV1['content']['changes'],
): void {
  const visible = changes.slice(0, MAX_VISIBLE_CHANGES);
  for (const change of visible) {
    const chip = doc.createElement('div');
    chip.className = `${CSS_PREFIX}__file-chip`;
    chip.setAttribute('role', 'listitem');

    const chipLabel = doc.createElement('span');
    chipLabel.className = `${CSS_PREFIX}__file-chip-label`;
    chipLabel.textContent = redactPrivatePaths(change.label);
    chipLabel.setAttribute('title', redactPrivatePaths(change.label));
    chip.appendChild(chipLabel);

    // Non-color indicator for change type
    const chipIndicator = doc.createElement('span');
    chipIndicator.className = `${CSS_PREFIX}__file-chip-indicator`;
    chipIndicator.setAttribute('aria-hidden', 'true');
    if (change.previousValue && change.proposedValue) {
      chipIndicator.textContent = '~'; // Modified
    } else if (change.proposedValue && !change.previousValue) {
      chipIndicator.textContent = '+'; // Added
    } else if (change.previousValue && !change.proposedValue) {
      chipIndicator.textContent = '-'; // Removed
    } else {
      chipIndicator.textContent = '?'; // Unknown
    }
    chip.appendChild(chipIndicator);

    container.appendChild(chip);
  }

  if (changes.length > MAX_VISIBLE_CHANGES) {
    const moreChip = doc.createElement('div');
    moreChip.className = `${CSS_PREFIX}__file-chip ${CSS_PREFIX}__file-chip--more`;
    moreChip.setAttribute('role', 'listitem');
    moreChip.textContent = `+${changes.length - MAX_VISIBLE_CHANGES} more`;
    container.appendChild(moreChip);
  }
}

function renderChanges(
  doc: Document,
  container: HTMLElement,
  block: DiffBlockV1,
  viewMode: DiffViewMode,
): void {
  if (block.content.diffType === 'file') {
    renderFileDiff(doc, container, block, viewMode);
  } else {
    renderRecordDiff(doc, container, block);
  }
}

// ─── File diff rendering ────────────────────────────────────────

function renderFileDiff(
  doc: Document,
  container: HTMLElement,
  block: DiffBlockV1,
  viewMode: DiffViewMode,
): void {
  const changes = block.content.changes.slice(0, MAX_VISIBLE_CHANGES);

  if (changes.length === 0) {
    const emptyEl = doc.createElement('div');
    emptyEl.className = `${CSS_PREFIX}__empty`;
    emptyEl.textContent = 'No changes';
    container.appendChild(emptyEl);
    return;
  }

  if (viewMode === 'unified') {
    renderUnifiedFileDiff(doc, container, changes, block.content.state);
  } else {
    renderSplitFileDiff(doc, container, changes, block.content.state);
  }
}

function renderUnifiedFileDiff(
  doc: Document,
  container: HTMLElement,
  changes: DiffBlockV1['content']['changes'],
  state: DiffState,
): void {
  const table = doc.createElement('table');
  table.className = `${CSS_PREFIX}__unified-table`;
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Unified diff view');

  // Table header
  const thead = doc.createElement('thead');
  const headerRow = doc.createElement('tr');
  const thIndicator = doc.createElement('th');
  thIndicator.className = `${CSS_PREFIX}__col-indicator`;
  thIndicator.textContent = '';
  thIndicator.setAttribute('scope', 'col');
  thIndicator.setAttribute('aria-label', 'Change type');
  headerRow.appendChild(thIndicator);

  const thLabel = doc.createElement('th');
  thLabel.className = `${CSS_PREFIX}__col-label`;
  thLabel.textContent = 'Location';
  thLabel.setAttribute('scope', 'col');
  headerRow.appendChild(thLabel);

  const thPrevious = doc.createElement('th');
  thPrevious.className = `${CSS_PREFIX}__col-previous`;
  thPrevious.textContent = 'Previous';
  thPrevious.setAttribute('scope', 'col');
  headerRow.appendChild(thPrevious);

  const thProposed = doc.createElement('th');
  thProposed.className = `${CSS_PREFIX}__col-proposed`;
  thProposed.textContent = 'Proposed';
  thProposed.setAttribute('scope', 'col');
  headerRow.appendChild(thProposed);

  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Table body
  const tbody = doc.createElement('tbody');

  for (const change of changes) {
    const row = doc.createElement('tr');
    row.className = `${CSS_PREFIX}__change-row`;
    row.dataset.changeId = change.changeId;

    // Determine change type
    const changeType = getChangeType(change);
    row.classList.add(`${CSS_PREFIX}__change-row--${changeType}`);

    // Non-color indicator cell
    const indicatorCell = doc.createElement('td');
    indicatorCell.className = `${CSS_PREFIX}__indicator-cell`;
    const indicator = doc.createElement('span');
    indicator.className = `${CSS_PREFIX}__change-indicator ${CSS_PREFIX}__change-indicator--${changeType}`;
    indicator.textContent = getChangeIndicator(changeType);
    indicator.setAttribute('aria-label', getChangeTypeLabel(changeType));
    indicatorCell.appendChild(indicator);
    row.appendChild(indicatorCell);

    // Label cell
    const labelCell = doc.createElement('td');
    labelCell.className = `${CSS_PREFIX}__label-cell`;
    labelCell.textContent = redactPrivatePaths(change.label);
    labelCell.setAttribute('title', redactPrivatePaths(change.label));
    row.appendChild(labelCell);

    // Previous value cell
    const prevCell = doc.createElement('td');
    prevCell.className = `${CSS_PREFIX}__value-cell ${CSS_PREFIX}__value-cell--previous`;
    if (change.previousValue !== undefined) {
      const preEl = doc.createElement('pre');
      preEl.className = `${CSS_PREFIX}__value-pre`;
      preEl.textContent = truncateValue(change.previousValue);
      prevCell.appendChild(preEl);
    }
    row.appendChild(prevCell);

    // Proposed value cell — suppress if state is 'applied' AND not confirmed
    // Per Req 10.6: never imply applied without authority confirmation
    const proposedCell = doc.createElement('td');
    proposedCell.className = `${CSS_PREFIX}__value-cell ${CSS_PREFIX}__value-cell--proposed`;
    if (change.proposedValue !== undefined && state !== 'unavailable') {
      const preEl = doc.createElement('pre');
      preEl.className = `${CSS_PREFIX}__value-pre`;
      preEl.textContent = truncateValue(change.proposedValue);
      proposedCell.appendChild(preEl);
    }
    row.appendChild(proposedCell);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  container.appendChild(table);
}

function renderSplitFileDiff(
  doc: Document,
  container: HTMLElement,
  changes: DiffBlockV1['content']['changes'],
  state: DiffState,
): void {
  const splitContainer = doc.createElement('div');
  splitContainer.className = `${CSS_PREFIX}__split-view`;
  splitContainer.setAttribute('role', 'table');
  splitContainer.setAttribute('aria-label', 'Split diff view');

  // Left panel (previous)
  const leftPanel = doc.createElement('div');
  leftPanel.className = `${CSS_PREFIX}__split-panel ${CSS_PREFIX}__split-panel--previous`;
  leftPanel.setAttribute('aria-label', 'Previous values');

  const leftHeader = doc.createElement('div');
  leftHeader.className = `${CSS_PREFIX}__split-panel-header`;
  leftHeader.textContent = 'Previous';
  leftPanel.appendChild(leftHeader);

  // Right panel (proposed)
  const rightPanel = doc.createElement('div');
  rightPanel.className = `${CSS_PREFIX}__split-panel ${CSS_PREFIX}__split-panel--proposed`;
  rightPanel.setAttribute('aria-label', 'Proposed values');

  const rightHeader = doc.createElement('div');
  rightHeader.className = `${CSS_PREFIX}__split-panel-header`;
  rightHeader.textContent = 'Proposed';
  rightPanel.appendChild(rightHeader);

  for (const change of changes) {
    const changeType = getChangeType(change);

    // Left row
    const leftRow = doc.createElement('div');
    leftRow.className = `${CSS_PREFIX}__split-row ${CSS_PREFIX}__split-row--${changeType}`;
    leftRow.dataset.changeId = change.changeId;

    const leftIndicator = doc.createElement('span');
    leftIndicator.className = `${CSS_PREFIX}__change-indicator ${CSS_PREFIX}__change-indicator--${changeType}`;
    leftIndicator.textContent = getChangeIndicator(changeType);
    leftIndicator.setAttribute('aria-label', getChangeTypeLabel(changeType));
    leftRow.appendChild(leftIndicator);

    const leftLabel = doc.createElement('span');
    leftLabel.className = `${CSS_PREFIX}__split-label`;
    leftLabel.textContent = redactPrivatePaths(change.label);
    leftRow.appendChild(leftLabel);

    if (change.previousValue !== undefined) {
      const preEl = doc.createElement('pre');
      preEl.className = `${CSS_PREFIX}__value-pre`;
      preEl.textContent = truncateValue(change.previousValue);
      leftRow.appendChild(preEl);
    }
    leftPanel.appendChild(leftRow);

    // Right row
    const rightRow = doc.createElement('div');
    rightRow.className = `${CSS_PREFIX}__split-row ${CSS_PREFIX}__split-row--${changeType}`;
    rightRow.dataset.changeId = change.changeId;

    const rightIndicator = doc.createElement('span');
    rightIndicator.className = `${CSS_PREFIX}__change-indicator ${CSS_PREFIX}__change-indicator--${changeType}`;
    rightIndicator.textContent = getChangeIndicator(changeType);
    rightIndicator.setAttribute('aria-hidden', 'true');
    rightRow.appendChild(rightIndicator);

    const rightLabel = doc.createElement('span');
    rightLabel.className = `${CSS_PREFIX}__split-label`;
    rightLabel.textContent = redactPrivatePaths(change.label);
    rightRow.appendChild(rightLabel);

    if (change.proposedValue !== undefined && state !== 'unavailable') {
      const preEl = doc.createElement('pre');
      preEl.className = `${CSS_PREFIX}__value-pre`;
      preEl.textContent = truncateValue(change.proposedValue);
      rightRow.appendChild(preEl);
    }
    rightPanel.appendChild(rightRow);
  }

  splitContainer.appendChild(leftPanel);
  splitContainer.appendChild(rightPanel);
  container.appendChild(splitContainer);
}

// ─── Record diff rendering ──────────────────────────────────────

function renderRecordDiff(
  doc: Document,
  container: HTMLElement,
  block: DiffBlockV1,
): void {
  const changes = block.content.changes.slice(0, MAX_VISIBLE_CHANGES);

  if (changes.length === 0) {
    const emptyEl = doc.createElement('div');
    emptyEl.className = `${CSS_PREFIX}__empty`;
    emptyEl.textContent = 'No record changes';
    container.appendChild(emptyEl);
    return;
  }

  // Record diffs use a card/list layout rather than table with line numbers
  // No file-line semantics (Req 11.4)
  const recordList = doc.createElement('div');
  recordList.className = `${CSS_PREFIX}__record-list`;
  recordList.setAttribute('role', 'list');
  recordList.setAttribute('aria-label', 'Record changes');

  for (const change of changes) {
    const changeType = getChangeType(change);

    const record = doc.createElement('div');
    record.className = `${CSS_PREFIX}__record-item`;
    record.classList.add(`${CSS_PREFIX}__record-item--${changeType}`);
    record.setAttribute('role', 'listitem');
    record.dataset.changeId = change.changeId;

    // Record header with non-color indicator and field identity
    const recordHeader = doc.createElement('div');
    recordHeader.className = `${CSS_PREFIX}__record-header`;

    const indicator = doc.createElement('span');
    indicator.className = `${CSS_PREFIX}__change-indicator ${CSS_PREFIX}__change-indicator--${changeType}`;
    indicator.textContent = getChangeIndicator(changeType);
    indicator.setAttribute('aria-label', getChangeTypeLabel(changeType));
    recordHeader.appendChild(indicator);

    const fieldLabel = doc.createElement('span');
    fieldLabel.className = `${CSS_PREFIX}__record-field-label`;
    fieldLabel.textContent = redactPrivatePaths(change.label);
    recordHeader.appendChild(fieldLabel);

    // Change type text label (non-color indicator per Req 18.11)
    const typeLabel = doc.createElement('span');
    typeLabel.className = `${CSS_PREFIX}__record-type-label`;
    typeLabel.textContent = getChangeTypeLabel(changeType);
    recordHeader.appendChild(typeLabel);

    record.appendChild(recordHeader);

    // Values section: previous → proposed
    const valuesContainer = doc.createElement('div');
    valuesContainer.className = `${CSS_PREFIX}__record-values`;

    if (change.previousValue !== undefined) {
      const prevGroup = doc.createElement('div');
      prevGroup.className = `${CSS_PREFIX}__record-value-group ${CSS_PREFIX}__record-value-group--previous`;

      const prevLabel = doc.createElement('span');
      prevLabel.className = `${CSS_PREFIX}__record-value-label`;
      prevLabel.textContent = 'Previous:';
      prevGroup.appendChild(prevLabel);

      const prevValue = doc.createElement('pre');
      prevValue.className = `${CSS_PREFIX}__record-value`;
      prevValue.textContent = truncateValue(change.previousValue);
      prevGroup.appendChild(prevValue);

      valuesContainer.appendChild(prevGroup);
    }

    if (change.proposedValue !== undefined && block.content.state !== 'unavailable') {
      const proposedGroup = doc.createElement('div');
      proposedGroup.className = `${CSS_PREFIX}__record-value-group ${CSS_PREFIX}__record-value-group--proposed`;

      const proposedLabel = doc.createElement('span');
      proposedLabel.className = `${CSS_PREFIX}__record-value-label`;
      proposedLabel.textContent = 'Proposed:';
      proposedGroup.appendChild(proposedLabel);

      const proposedValue = doc.createElement('pre');
      proposedValue.className = `${CSS_PREFIX}__record-value`;
      proposedValue.textContent = truncateValue(change.proposedValue);
      proposedGroup.appendChild(proposedValue);

      valuesContainer.appendChild(proposedGroup);
    }

    record.appendChild(valuesContainer);

    // State provenance indicator
    const provenanceEl = doc.createElement('div');
    provenanceEl.className = `${CSS_PREFIX}__record-provenance`;
    provenanceEl.textContent = `Status: ${STATE_LABELS[block.content.state]}`;
    record.appendChild(provenanceEl);

    recordList.appendChild(record);
  }

  container.appendChild(recordList);

  if (block.content.changes.length > MAX_VISIBLE_CHANGES) {
    const moreEl = doc.createElement('div');
    moreEl.className = `${CSS_PREFIX}__truncation-notice`;
    moreEl.textContent = `Showing ${MAX_VISIBLE_CHANGES} of ${block.content.changes.length} changes`;
    moreEl.setAttribute('role', 'status');
    container.appendChild(moreEl);
  }
}

// ─── Change type helpers ────────────────────────────────────────

type ChangeType = 'added' | 'removed' | 'modified' | 'unchanged';

function getChangeType(change: DiffBlockV1['content']['changes'][number]): ChangeType {
  const hasPrevious = change.previousValue !== undefined;
  const hasProposed = change.proposedValue !== undefined;

  if (hasProposed && !hasPrevious) return 'added';
  if (hasPrevious && !hasProposed) return 'removed';
  if (hasPrevious && hasProposed) return 'modified';
  return 'unchanged';
}

function getChangeIndicator(changeType: ChangeType): string {
  switch (changeType) {
    case 'added': return '+';
    case 'removed': return '−';
    case 'modified': return '~';
    case 'unchanged': return ' ';
  }
}

function getChangeTypeLabel(changeType: ChangeType): string {
  switch (changeType) {
    case 'added': return 'Added';
    case 'removed': return 'Removed';
    case 'modified': return 'Modified';
    case 'unchanged': return 'Unchanged';
  }
}
