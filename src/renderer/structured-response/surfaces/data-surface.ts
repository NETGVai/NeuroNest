/**
 * DataSurface — Accessible table or record list for structured data.
 *
 * Renders `StructuredDataBlockV1` as either an accessible table or a record
 * list, selected by column count, viewport width, and semantic relationships.
 *
 * Key responsibilities:
 * - Select accessible table or record list based on column count, viewport
 *   width, and typed semantic relationships (11.1)
 * - Provide semantic headers, accessible row labels, bounded initial rows,
 *   and an explicit "show more" control (11.2)
 * - Support contract-authorized non-mutating sorting/filtering that does not
 *   change the durable source data (11.3)
 * - Render a bounded safe fallback only for malformed/oversized/incompatible
 *   data; valid compatible data renders valid presentation, never fallback
 *   alongside it (11.11, 11.12)
 * - Contain horizontal overflow within the surface rather than forcing the
 *   entire page to scroll horizontally (3.7, 19.5)
 * - Provide semantic labels for data tables (18.12)
 *
 * Requirements: 11.1–11.4, 11.11–11.12, 18.12, 19.5
 */

import type { StructuredDataBlockV1 } from '../../../harness/contracts/response-composition';
import {
  MAX_PRESENTATION_ITEMS,
} from '../../../harness/contracts/response-composition';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DataPresentationMode = 'table' | 'record_list';

export type SortDirection = 'asc' | 'desc' | 'none';

export interface DataSortState {
  readonly columnId: string;
  readonly direction: SortDirection;
}

export interface DataFilterState {
  readonly columnId: string;
  readonly filterText: string;
}

export interface DataSurfaceConfig {
  /** Initial rows to display before "show more" is activated. */
  readonly initialRowBound: number;
  /** Viewport width in device-independent pixels for mode selection. */
  readonly viewportWidthDip: number;
  /** Column threshold above which table mode is preferred over record list. */
  readonly tableColumnThreshold: number;
  /** Maximum number of rows before data is considered oversized. */
  readonly maxRows: number;
  /** Narrow viewport threshold below which record list is preferred. */
  readonly narrowViewportThresholdDip: number;
}

export const DEFAULT_DATA_SURFACE_CONFIG: Readonly<DataSurfaceConfig> = Object.freeze({
  initialRowBound: 10,
  viewportWidthDip: 800,
  tableColumnThreshold: 2,
  maxRows: MAX_PRESENTATION_ITEMS,
  narrowViewportThresholdDip: 480,
});

export interface DataSurfaceAction {
  readonly kind: 'sort' | 'filter' | 'show_more' | 'show_less' | 'copy';
  readonly label: string;
  readonly disabled: boolean;
  readonly execute: () => Promise<DataActionResult>;
}

export interface DataActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

export interface DataSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly mode: DataPresentationMode;
  readonly visibleRowCount: number;
  readonly totalRowCount: number;
  readonly isFallback: boolean;
  readonly sortState: DataSortState | null;
  readonly filterState: DataFilterState | null;
  update(block: StructuredDataBlockV1, config?: Partial<DataSurfaceConfig>): void;
  dispose(): void;
}

export interface DataSurfaceFallbackReason {
  readonly code: 'malformed' | 'oversized' | 'incompatible' | 'empty_columns';
  readonly detail: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SORT_DIRECTION_LABELS: Readonly<Record<SortDirection, string>> = Object.freeze({
  asc: 'Sorted ascending',
  desc: 'Sorted descending',
  none: 'Not sorted',
});

const SORT_ARIA_LABELS: Readonly<Record<SortDirection, string>> = Object.freeze({
  asc: 'ascending',
  desc: 'descending',
  none: 'none',
});

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates a StructuredDataBlockV1 for rendering eligibility.
 * Returns a fallback reason if the data is malformed, oversized, or incompatible.
 * Returns null if the data is valid and should render the primary surface.
 */
export function validateDataBlock(
  block: StructuredDataBlockV1,
  config: DataSurfaceConfig,
): DataSurfaceFallbackReason | null {
  if (!block.content || !block.content.columns || !Array.isArray(block.content.columns)) {
    return { code: 'malformed', detail: 'Missing or invalid columns definition' };
  }

  if (block.content.columns.length === 0) {
    return { code: 'empty_columns', detail: 'No columns defined in structured data' };
  }

  if (!block.content.rows || !Array.isArray(block.content.rows)) {
    return { code: 'malformed', detail: 'Missing or invalid rows definition' };
  }

  if (block.content.rows.length > config.maxRows) {
    return {
      code: 'oversized',
      detail: `Row count ${block.content.rows.length} exceeds maximum ${config.maxRows}`,
    };
  }

  // Check for incompatible row data (value count mismatch)
  const columnCount = block.content.columns.length;
  for (const row of block.content.rows) {
    if (!Array.isArray(row.values)) {
      return { code: 'malformed', detail: `Row ${row.rowId} has invalid values` };
    }
    if (row.values.length > columnCount) {
      return {
        code: 'incompatible',
        detail: `Row ${row.rowId} has ${row.values.length} values but only ${columnCount} columns`,
      };
    }
  }

  return null;
}

// ─── Mode Selection ───────────────────────────────────────────────────────────

/**
 * Selects the presentation mode based on column count, viewport width, and
 * semantic relationships. This is the sole mode-selection logic; tool names,
 * prose, or emoji are never considered.
 *
 * Requirement 11.1: select based on column count, viewport width, semantic relationships.
 */
export function selectPresentationMode(
  columnCount: number,
  config: DataSurfaceConfig,
): DataPresentationMode {
  // Narrow viewport always uses record list for accessibility
  if (config.viewportWidthDip < config.narrowViewportThresholdDip) {
    return 'record_list';
  }

  // Few columns use record list (better for key-value style data)
  if (columnCount < config.tableColumnThreshold) {
    return 'record_list';
  }

  // Default to table for multi-column data
  return 'table';
}

// ─── Non-Mutating Sort ────────────────────────────────────────────────────────

type RowData = StructuredDataBlockV1['content']['rows'][number];

/**
 * Produces a sorted view of rows without mutating the source array.
 * Returns a new array with the same row references in different order.
 *
 * Requirement 11.3: non-mutating sorting that does not change durable source data.
 */
export function sortRows(
  rows: readonly RowData[],
  columns: readonly { columnId: string }[],
  sort: DataSortState,
): readonly RowData[] {
  if (sort.direction === 'none') {
    return rows;
  }

  const colIndex = columns.findIndex((c) => c.columnId === sort.columnId);
  if (colIndex < 0) {
    return rows;
  }

  const sorted = [...rows];
  const multiplier = sort.direction === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    const aVal = a.values[colIndex] ?? null;
    const bVal = b.values[colIndex] ?? null;

    // null/undefined always sorts last
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return (aVal - bVal) * multiplier;
    }

    if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
      return ((aVal ? 1 : 0) - (bVal ? 1 : 0)) * multiplier;
    }

    return String(aVal).localeCompare(String(bVal)) * multiplier;
  });

  return sorted;
}

// ─── Non-Mutating Filter ──────────────────────────────────────────────────────

/**
 * Produces a filtered view of rows without mutating the source array.
 * Returns a new array with the same row references.
 *
 * Requirement 11.3: non-mutating filtering that does not change durable source data.
 */
export function filterRows(
  rows: readonly RowData[],
  columns: readonly { columnId: string }[],
  filter: DataFilterState,
): readonly RowData[] {
  if (!filter.filterText.trim()) {
    return rows;
  }

  const colIndex = columns.findIndex((c) => c.columnId === filter.columnId);
  if (colIndex < 0) {
    return rows;
  }

  const searchText = filter.filterText.toLowerCase().trim();

  return rows.filter((row) => {
    const value = row.values[colIndex];
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(searchText);
  });
}

// ─── Scalar Formatting ────────────────────────────────────────────────────────

/**
 * Formats a presentation scalar value for display.
 * Strings are escaped for safe HTML rendering; numbers, booleans, and null
 * produce readable text.
 */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '\u2014'; // em dash
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── DataSurface Class ────────────────────────────────────────────────────────

/**
 * DataSurface renders structured data as an accessible table or record list.
 * Implements the render/update/dispose lifecycle.
 */
export class DataSurface {
  private readonly doc: Document;

  constructor(ownerDocument: Document = document) {
    this.doc = ownerDocument;
  }

  /**
   * Renders a StructuredDataBlockV1 as either a table or record list.
   *
   * Returns a DataSurfaceHandle for lifecycle management.
   * If the data is malformed/oversized/incompatible, renders a bounded safe fallback.
   * Valid data never renders fallback alongside it (Requirement 11.12).
   */
  render(
    block: StructuredDataBlockV1,
    config: DataSurfaceConfig = DEFAULT_DATA_SURFACE_CONFIG,
  ): DataSurfaceHandle {
    let currentBlock = block;
    let currentConfig = { ...DEFAULT_DATA_SURFACE_CONFIG, ...config };
    let disposed = false;
    let expanded = false;
    let sortState: DataSortState | null = null;
    let filterState: DataFilterState | null = null;

    // Root element
    const root = this.doc.createElement('section');
    root.className = 'nn-data-surface';
    root.setAttribute('role', 'region');
    root.dataset.stableKey = block.stableKey;
    root.dataset.semanticAnchor = block.semanticAnchor;

    // Determine if fallback is needed
    const fallbackReason = validateDataBlock(block, currentConfig);

    if (fallbackReason !== null) {
      // Render bounded safe fallback
      root.setAttribute('aria-label', 'Structured data (fallback view)');
      root.dataset.fallback = 'true';
      root.dataset.fallbackCode = fallbackReason.code;
      renderFallback(root, this.doc, block, fallbackReason);

      return createFallbackHandle(root, block, disposed, () => {
        disposed = true;
        root.remove();
        root.replaceChildren();
      });
    }

    // Valid data — render the primary surface
    const mode = selectPresentationMode(
      block.content.columns.length,
      currentConfig,
    );

    root.setAttribute(
      'aria-label',
      block.content.caption
        ? `Structured data: ${block.content.caption}`
        : 'Structured data',
    );
    root.dataset.mode = mode;

    // Content container with local overflow (Requirement 19.5, 3.7)
    const contentContainer = this.doc.createElement('div');
    contentContainer.className = 'nn-data-surface__content';
    contentContainer.style.overflowX = 'auto';
    contentContainer.style.maxWidth = '100%';
    root.appendChild(contentContainer);

    // Controls container (sort/filter)
    const controlsContainer = this.doc.createElement('div');
    controlsContainer.className = 'nn-data-surface__controls';
    root.appendChild(controlsContainer);

    // Pagination controls container
    const paginationContainer = this.doc.createElement('div');
    paginationContainer.className = 'nn-data-surface__pagination';
    root.appendChild(paginationContainer);

    const renderContent = (): void => {
      contentContainer.replaceChildren();
      controlsContainer.replaceChildren();
      paginationContainer.replaceChildren();

      const columns = currentBlock.content.columns;
      const allRows = currentBlock.content.rows;

      // Apply non-mutating filter (does not change source)
      let viewRows: readonly RowData[] = allRows;
      if (filterState) {
        viewRows = filterRows(viewRows, columns, filterState);
      }

      // Apply non-mutating sort (does not change source)
      if (sortState) {
        viewRows = sortRows(viewRows, columns, sortState);
      }

      // Bounded initial rows (Requirement 11.2)
      const rowBound = currentConfig.initialRowBound;
      const visibleRows = expanded ? viewRows : viewRows.slice(0, rowBound);
      const currentMode = selectPresentationMode(columns.length, currentConfig);
      root.dataset.mode = currentMode;

      if (currentMode === 'table') {
        renderTable(contentContainer, this.doc, columns, visibleRows, sortState);
      } else {
        renderRecordList(contentContainer, this.doc, columns, visibleRows);
      }

      // Sort controls (only if multiple columns)
      if (columns.length > 1) {
        renderSortControls(controlsContainer, this.doc, columns, sortState, (newSort) => {
          sortState = newSort;
          renderContent();
        });
      }

      // Filter control
      renderFilterControl(controlsContainer, this.doc, columns, filterState, (newFilter) => {
        filterState = newFilter;
        expanded = false; // Reset pagination on filter change
        renderContent();
      });

      // Explicit "show more" control (Requirement 11.2)
      if (viewRows.length > rowBound) {
        const moreBtn = this.doc.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'nn-data-surface__show-more';

        if (expanded) {
          moreBtn.textContent = `Show fewer rows`;
          moreBtn.setAttribute('aria-label', `Show fewer rows, currently showing all ${viewRows.length}`);
        } else {
          const remaining = viewRows.length - rowBound;
          moreBtn.textContent = `Show ${remaining} more row${remaining !== 1 ? 's' : ''}`;
          moreBtn.setAttribute('aria-label', `Show ${remaining} more rows`);
        }
        moreBtn.setAttribute('aria-expanded', String(expanded));
        moreBtn.addEventListener('click', () => {
          expanded = !expanded;
          renderContent();
        });
        paginationContainer.appendChild(moreBtn);
      }

      root.dataset.status = currentBlock.status;
      root.dataset.visibleRows = String(visibleRows.length);
      root.dataset.totalRows = String(viewRows.length);
    };

    renderContent();

    const handle: DataSurfaceHandle = {
      get element() {
        return root;
      },
      get stableKey() {
        return currentBlock.stableKey;
      },
      get semanticAnchor() {
        return currentBlock.semanticAnchor;
      },
      get mode() {
        return selectPresentationMode(currentBlock.content.columns.length, currentConfig);
      },
      get visibleRowCount() {
        const allRows = currentBlock.content.rows;
        let viewRows: readonly RowData[] = allRows;
        if (filterState) {
          viewRows = filterRows(viewRows, currentBlock.content.columns, filterState);
        }
        return expanded
          ? viewRows.length
          : Math.min(viewRows.length, currentConfig.initialRowBound);
      },
      get totalRowCount() {
        return currentBlock.content.rows.length;
      },
      get isFallback() {
        return false;
      },
      get sortState() {
        return sortState;
      },
      get filterState() {
        return filterState;
      },
      update(nextBlock: StructuredDataBlockV1, nextConfig?: Partial<DataSurfaceConfig>): void {
        if (disposed) return;
        currentBlock = nextBlock;
        if (nextConfig) {
          currentConfig = { ...currentConfig, ...nextConfig };
        }
        root.dataset.stableKey = nextBlock.stableKey;
        root.dataset.semanticAnchor = nextBlock.semanticAnchor;

        // Re-validate after update
        const newFallback = validateDataBlock(nextBlock, currentConfig);
        if (newFallback !== null) {
          // Switch to fallback mode
          root.replaceChildren();
          root.dataset.fallback = 'true';
          root.dataset.fallbackCode = newFallback.code;
          root.setAttribute('aria-label', 'Structured data (fallback view)');
          renderFallback(root, handle.element.ownerDocument, nextBlock, newFallback);
          return;
        }

        // Remove fallback state if previously in fallback
        delete root.dataset.fallback;
        delete root.dataset.fallbackCode;
        root.setAttribute(
          'aria-label',
          nextBlock.content.caption
            ? `Structured data: ${nextBlock.content.caption}`
            : 'Structured data',
        );

        // Rebuild content containers if they were cleared
        if (!root.contains(contentContainer)) {
          root.replaceChildren();
          root.appendChild(contentContainer);
          root.appendChild(controlsContainer);
          root.appendChild(paginationContainer);
        }

        renderContent();
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        root.remove();
        root.replaceChildren();
      },
    };

    return handle;
  }
}

// ─── Rendering Helpers ────────────────────────────────────────────────────────

function renderTable(
  container: HTMLElement,
  doc: Document,
  columns: readonly { columnId: string; label: string }[],
  rows: readonly RowData[],
  sortState: DataSortState | null,
): void {
  const table = doc.createElement('table');
  table.className = 'nn-data-surface__table';
  table.setAttribute('role', 'table');

  // Caption if needed
  const caption = doc.createElement('caption');
  caption.className = 'nn-data-surface__caption';
  caption.textContent = `Data table with ${columns.length} columns and ${rows.length} rows`;
  table.appendChild(caption);

  // Table header (Requirement 11.2: semantic headers)
  const thead = doc.createElement('thead');
  const headerRow = doc.createElement('tr');

  // Row label column header
  const rowLabelHeader = doc.createElement('th');
  rowLabelHeader.scope = 'col';
  rowLabelHeader.className = 'nn-data-surface__header nn-data-surface__header--row-label';
  rowLabelHeader.textContent = 'Row';
  headerRow.appendChild(rowLabelHeader);

  for (const col of columns) {
    const th = doc.createElement('th');
    th.scope = 'col';
    th.className = 'nn-data-surface__header';
    th.dataset.columnId = col.columnId;
    th.textContent = col.label;

    // Sort indicator (non-color cue)
    if (sortState && sortState.columnId === col.columnId && sortState.direction !== 'none') {
      th.setAttribute('aria-sort', SORT_ARIA_LABELS[sortState.direction]);
      const sortIndicator = doc.createElement('span');
      sortIndicator.className = 'nn-data-surface__sort-indicator';
      sortIndicator.textContent = sortState.direction === 'asc' ? ' \u25B2' : ' \u25BC';
      sortIndicator.setAttribute('aria-hidden', 'true');
      th.appendChild(sortIndicator);
    }

    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Table body
  const tbody = doc.createElement('tbody');
  for (const row of rows) {
    const tr = doc.createElement('tr');
    tr.dataset.rowId = row.rowId;

    // Accessible row label (Requirement 11.2)
    const rowLabelCell = doc.createElement('th');
    rowLabelCell.scope = 'row';
    rowLabelCell.className = 'nn-data-surface__row-label';
    rowLabelCell.textContent = row.label;
    tr.appendChild(rowLabelCell);

    for (let i = 0; i < columns.length; i++) {
      const td = doc.createElement('td');
      td.className = 'nn-data-surface__cell';
      td.dataset.columnId = columns[i].columnId;
      const value = i < row.values.length ? row.values[i] : null;
      td.textContent = formatScalar(value);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}

function renderRecordList(
  container: HTMLElement,
  doc: Document,
  columns: readonly { columnId: string; label: string }[],
  rows: readonly RowData[],
): void {
  const list = doc.createElement('div');
  list.className = 'nn-data-surface__record-list';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', `Data records: ${rows.length} items`);

  for (const row of rows) {
    const record = doc.createElement('article');
    record.className = 'nn-data-surface__record';
    record.setAttribute('role', 'listitem');
    record.dataset.rowId = row.rowId;

    // Record heading with accessible label
    const heading = doc.createElement('h4');
    heading.className = 'nn-data-surface__record-label';
    heading.textContent = row.label;
    record.appendChild(heading);

    // Key-value pairs
    const dl = doc.createElement('dl');
    dl.className = 'nn-data-surface__record-fields';
    for (let i = 0; i < columns.length; i++) {
      const dt = doc.createElement('dt');
      dt.className = 'nn-data-surface__field-label';
      dt.textContent = columns[i].label;
      dl.appendChild(dt);

      const dd = doc.createElement('dd');
      dd.className = 'nn-data-surface__field-value';
      const value = i < row.values.length ? row.values[i] : null;
      dd.textContent = formatScalar(value);
      dl.appendChild(dd);
    }
    record.appendChild(dl);

    list.appendChild(record);
  }

  container.appendChild(list);
}

function renderSortControls(
  container: HTMLElement,
  doc: Document,
  columns: readonly { columnId: string; label: string }[],
  sortState: DataSortState | null,
  onSort: (sort: DataSortState) => void,
): void {
  const sortGroup = doc.createElement('div');
  sortGroup.className = 'nn-data-surface__sort-controls';
  sortGroup.setAttribute('role', 'toolbar');
  sortGroup.setAttribute('aria-label', 'Sort controls');

  const sortLabel = doc.createElement('span');
  sortLabel.className = 'nn-data-surface__sort-label';
  sortLabel.textContent = 'Sort by:';
  sortLabel.id = `sort-label-${Date.now()}`;
  sortGroup.appendChild(sortLabel);

  const select = doc.createElement('select');
  select.className = 'nn-data-surface__sort-select';
  select.setAttribute('aria-labelledby', sortLabel.id);

  const noneOption = doc.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'None';
  select.appendChild(noneOption);

  for (const col of columns) {
    const option = doc.createElement('option');
    option.value = col.columnId;
    option.textContent = col.label;
    if (sortState && sortState.columnId === col.columnId && sortState.direction !== 'none') {
      option.selected = true;
    }
    select.appendChild(option);
  }

  select.addEventListener('change', () => {
    if (!select.value) {
      onSort({ columnId: '', direction: 'none' });
    } else {
      onSort({ columnId: select.value, direction: 'asc' });
    }
  });
  sortGroup.appendChild(select);

  // Direction toggle button
  if (sortState && sortState.direction !== 'none') {
    const dirBtn = doc.createElement('button');
    dirBtn.type = 'button';
    dirBtn.className = 'nn-data-surface__sort-direction';
    dirBtn.textContent = sortState.direction === 'asc' ? '\u25B2 Ascending' : '\u25BC Descending';
    dirBtn.setAttribute(
      'aria-label',
      `Sort direction: ${SORT_DIRECTION_LABELS[sortState.direction]}. Click to toggle.`,
    );
    dirBtn.addEventListener('click', () => {
      const newDir = sortState!.direction === 'asc' ? 'desc' : 'asc';
      onSort({ columnId: sortState!.columnId, direction: newDir });
    });
    sortGroup.appendChild(dirBtn);
  }

  container.appendChild(sortGroup);
}

function renderFilterControl(
  container: HTMLElement,
  doc: Document,
  columns: readonly { columnId: string; label: string }[],
  filterState: DataFilterState | null,
  onFilter: (filter: DataFilterState) => void,
): void {
  const filterGroup = doc.createElement('div');
  filterGroup.className = 'nn-data-surface__filter-controls';
  filterGroup.setAttribute('role', 'search');
  filterGroup.setAttribute('aria-label', 'Filter data');

  const filterLabel = doc.createElement('label');
  filterLabel.className = 'nn-data-surface__filter-label';
  filterLabel.textContent = 'Filter:';
  const filterId = `filter-input-${Date.now()}`;
  filterLabel.htmlFor = filterId;
  filterGroup.appendChild(filterLabel);

  // Column select
  const colSelect = doc.createElement('select');
  colSelect.className = 'nn-data-surface__filter-column';
  colSelect.setAttribute('aria-label', 'Filter column');

  for (const col of columns) {
    const option = doc.createElement('option');
    option.value = col.columnId;
    option.textContent = col.label;
    if (filterState && filterState.columnId === col.columnId) {
      option.selected = true;
    }
    colSelect.appendChild(option);
  }
  filterGroup.appendChild(colSelect);

  // Filter text input
  const input = doc.createElement('input');
  input.type = 'text';
  input.id = filterId;
  input.className = 'nn-data-surface__filter-input';
  input.placeholder = 'Type to filter...';
  input.value = filterState?.filterText ?? '';
  input.setAttribute('aria-label', 'Filter text');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onFilter({
        columnId: colSelect.value || columns[0]?.columnId || '',
        filterText: input.value,
      });
    }, 200);
  });

  colSelect.addEventListener('change', () => {
    if (input.value) {
      onFilter({
        columnId: colSelect.value,
        filterText: input.value,
      });
    }
  });

  filterGroup.appendChild(input);
  container.appendChild(filterGroup);
}

// ─── Fallback Rendering ───────────────────────────────────────────────────────

function renderFallback(
  container: HTMLElement,
  doc: Document,
  block: StructuredDataBlockV1,
  reason: DataSurfaceFallbackReason,
): void {
  const fallbackEl = doc.createElement('div');
  fallbackEl.className = 'nn-data-surface__fallback';
  fallbackEl.setAttribute('role', 'alert');

  // Status indicator
  const statusEl = doc.createElement('p');
  statusEl.className = 'nn-data-surface__fallback-status';
  statusEl.textContent = `Data cannot be displayed: ${reason.detail}`;
  fallbackEl.appendChild(statusEl);

  // Bounded summary of available data
  if (block.content && block.content.columns && block.content.columns.length > 0) {
    const summaryEl = doc.createElement('p');
    summaryEl.className = 'nn-data-surface__fallback-summary';
    summaryEl.textContent = `Columns: ${block.content.columns.map((c) => c.label).join(', ')}`;
    fallbackEl.appendChild(summaryEl);
  }

  // Caption if available
  if (block.content?.caption) {
    const captionEl = doc.createElement('p');
    captionEl.className = 'nn-data-surface__fallback-caption';
    captionEl.textContent = `Caption: ${escapeHtml(block.content.caption)}`;
    fallbackEl.appendChild(captionEl);
  }

  // Correlation identity
  const corrEl = doc.createElement('p');
  corrEl.className = 'nn-data-surface__fallback-correlation';
  corrEl.textContent = `Data ID: ${block.content?.dataId ?? block.stableKey}`;
  fallbackEl.appendChild(corrEl);

  container.appendChild(fallbackEl);
}

// ─── Fallback Handle ──────────────────────────────────────────────────────────

function createFallbackHandle(
  root: HTMLElement,
  block: StructuredDataBlockV1,
  disposed: boolean,
  disposeFn: () => void,
): DataSurfaceHandle {
  let currentBlock = block;
  let isDisposed = disposed;

  return {
    get element() {
      return root;
    },
    get stableKey() {
      return currentBlock.stableKey;
    },
    get semanticAnchor() {
      return currentBlock.semanticAnchor;
    },
    get mode(): DataPresentationMode {
      return 'table'; // default, not actually used for fallback
    },
    get visibleRowCount() {
      return 0;
    },
    get totalRowCount() {
      return currentBlock.content?.rows?.length ?? 0;
    },
    get isFallback() {
      return true;
    },
    get sortState() {
      return null;
    },
    get filterState() {
      return null;
    },
    update(nextBlock: StructuredDataBlockV1): void {
      if (isDisposed) return;
      currentBlock = nextBlock;
      root.dataset.stableKey = nextBlock.stableKey;
      root.dataset.semanticAnchor = nextBlock.semanticAnchor;
      // Re-render fallback with new data
      root.replaceChildren();
      const newReason = validateDataBlock(nextBlock, DEFAULT_DATA_SURFACE_CONFIG);
      if (newReason) {
        renderFallback(root, root.ownerDocument, nextBlock, newReason);
      }
    },
    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      disposeFn();
    },
  };
}
