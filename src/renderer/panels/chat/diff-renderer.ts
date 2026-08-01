/**
 * Inline diff renderer for chat messages.
 * Renders unified diff format with added lines in green, removed lines in red,
 * and line numbers. Matches VS Code's inline diff visual style.
 */

/** Represents a single line in the diff output. */
export interface DiffLine {
  /** Line type: added, removed, or context (unchanged). */
  type: 'added' | 'removed' | 'context';
  /** The text content of the line (without the +/- prefix). */
  content: string;
  /** Original file line number (for removed/context lines). */
  oldLineNumber: number | null;
  /** New file line number (for added/context lines). */
  newLineNumber: number | null;
}

/** Represents a hunk in a unified diff. */
export interface DiffHunk {
  /** Header line (e.g. @@ -1,3 +1,4 @@). */
  header: string;
  /** Lines within this hunk. */
  lines: DiffLine[];
}

/** Parsed unified diff structure. */
export interface ParsedDiff {
  /** Original file path. */
  oldFile: string;
  /** New file path. */
  newFile: string;
  /** Diff hunks. */
  hunks: DiffHunk[];
}

/** CSS class names scoped to the diff renderer. */
const CSS = {
  container: 'nn-diff-renderer',
  header: 'nn-diff-renderer__header',
  fileName: 'nn-diff-renderer__filename',
  hunk: 'nn-diff-renderer__hunk',
  hunkHeader: 'nn-diff-renderer__hunk-header',
  table: 'nn-diff-renderer__table',
  row: 'nn-diff-renderer__row',
  rowAdded: 'nn-diff-renderer__row--added',
  rowRemoved: 'nn-diff-renderer__row--removed',
  rowContext: 'nn-diff-renderer__row--context',
  lineNum: 'nn-diff-renderer__line-num',
  lineNumOld: 'nn-diff-renderer__line-num--old',
  lineNumNew: 'nn-diff-renderer__line-num--new',
  lineContent: 'nn-diff-renderer__line-content',
  prefix: 'nn-diff-renderer__prefix',
} as const;

/** Injects scoped styles for the diff renderer component. */
function injectStyles(): void {
  if (document.getElementById('nn-diff-renderer-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-diff-renderer-styles';
  style.textContent = `
    .${CSS.container} {
      font-family: var(--font-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace);
      font-size: 12px;
      line-height: 1.5;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--diff-border, #333333);
      margin: 8px 0;
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      background: var(--diff-header-bg, #252526);
      border-bottom: 1px solid var(--diff-border, #333333);
    }
    .${CSS.fileName} {
      font-size: 12px;
      font-weight: 500;
      color: var(--diff-header-text, #cccccc);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${CSS.hunk} {
      border-bottom: 1px solid var(--diff-border, #333333);
    }
    .${CSS.hunk}:last-child {
      border-bottom: none;
    }
    .${CSS.hunkHeader} {
      padding: 4px 12px;
      background: var(--diff-hunk-header-bg, #1e3a5f);
      color: var(--diff-hunk-header-text, #8db9e8);
      font-size: 11px;
      font-style: italic;
    }
    .${CSS.table} {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .${CSS.row} {
      border: none;
    }
    .${CSS.rowAdded} {
      background: var(--diff-added-bg, rgba(35, 134, 54, 0.15));
    }
    .${CSS.rowRemoved} {
      background: var(--diff-removed-bg, rgba(248, 81, 73, 0.15));
    }
    .${CSS.rowContext} {
      background: var(--diff-context-bg, transparent);
    }
    .${CSS.lineNum} {
      width: 40px;
      min-width: 40px;
      padding: 0 8px;
      text-align: right;
      color: var(--diff-line-num-text, #636369);
      user-select: none;
      vertical-align: top;
      white-space: nowrap;
    }
    .${CSS.prefix} {
      width: 16px;
      min-width: 16px;
      padding: 0 2px;
      text-align: center;
      user-select: none;
      vertical-align: top;
    }
    .${CSS.rowAdded} .${CSS.prefix} {
      color: var(--diff-added-prefix, #3fb950);
    }
    .${CSS.rowRemoved} .${CSS.prefix} {
      color: var(--diff-removed-prefix, #f85149);
    }
    .${CSS.lineContent} {
      padding: 0 12px 0 4px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--diff-content-text, #e0e0e0);
    }
    .${CSS.rowAdded} .${CSS.lineContent} {
      color: var(--diff-added-text, #aff5b4);
    }
    .${CSS.rowRemoved} .${CSS.lineContent} {
      color: var(--diff-removed-text, #ffa7a3);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Parses a unified diff string into a structured representation.
 * Supports standard unified diff format as produced by `git diff`.
 */
export function parseDiff(diffText: string): ParsedDiff {
  const lines = diffText.split('\n');
  let oldFile = '';
  let newFile = '';
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Parse file headers
    if (line.startsWith('--- ')) {
      oldFile = line.slice(4).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      newFile = line.slice(4).replace(/^b\//, '');
      continue;
    }

    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = {
        header: line,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    // Skip diff metadata lines (index, diff --git, etc.)
    if (!currentHunk) continue;

    // Parse diff content lines
    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'added',
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      newLine++;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'removed',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      // Context line (unchanged) — only if we're inside a hunk
      const content = line.startsWith(' ') ? line.slice(1) : line;
      currentHunk.lines.push({
        type: 'context',
        content,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return { oldFile, newFile, hunks };
}

/**
 * Renders a parsed diff as a DOM element with inline preview styling.
 * Added lines are shown in green, removed lines in red, with line numbers.
 */
export function renderDiff(parsed: ParsedDiff): HTMLElement {
  injectStyles();

  const container = document.createElement('div');
  container.className = CSS.container;
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', `Diff for ${parsed.newFile || parsed.oldFile || 'file'}`);

  // File header
  const displayFileName = parsed.newFile || parsed.oldFile;
  if (displayFileName) {
    const header = document.createElement('div');
    header.className = CSS.header;

    const fileName = document.createElement('span');
    fileName.className = CSS.fileName;
    fileName.textContent = displayFileName;
    fileName.setAttribute('title', displayFileName);

    header.appendChild(fileName);
    container.appendChild(header);
  }

  // Hunks
  for (const hunk of parsed.hunks) {
    const hunkEl = document.createElement('div');
    hunkEl.className = CSS.hunk;

    // Hunk header
    const hunkHeader = document.createElement('div');
    hunkHeader.className = CSS.hunkHeader;
    hunkHeader.textContent = hunk.header;
    hunkEl.appendChild(hunkHeader);

    // Diff table
    const table = document.createElement('table');
    table.className = CSS.table;
    table.setAttribute('role', 'presentation');

    for (const diffLine of hunk.lines) {
      const row = document.createElement('tr');
      row.className = CSS.row;

      switch (diffLine.type) {
        case 'added':
          row.classList.add(CSS.rowAdded);
          break;
        case 'removed':
          row.classList.add(CSS.rowRemoved);
          break;
        case 'context':
          row.classList.add(CSS.rowContext);
          break;
      }

      // Old line number column
      const oldNumCell = document.createElement('td');
      oldNumCell.className = `${CSS.lineNum} ${CSS.lineNumOld}`;
      oldNumCell.textContent = diffLine.oldLineNumber != null ? String(diffLine.oldLineNumber) : '';
      row.appendChild(oldNumCell);

      // New line number column
      const newNumCell = document.createElement('td');
      newNumCell.className = `${CSS.lineNum} ${CSS.lineNumNew}`;
      newNumCell.textContent = diffLine.newLineNumber != null ? String(diffLine.newLineNumber) : '';
      row.appendChild(newNumCell);

      // Prefix column (+/-/space)
      const prefixCell = document.createElement('td');
      prefixCell.className = CSS.prefix;
      switch (diffLine.type) {
        case 'added':
          prefixCell.textContent = '+';
          break;
        case 'removed':
          prefixCell.textContent = '-';
          break;
        default:
          prefixCell.textContent = ' ';
          break;
      }
      row.appendChild(prefixCell);

      // Content column
      const contentCell = document.createElement('td');
      contentCell.className = CSS.lineContent;
      contentCell.textContent = diffLine.content;
      row.appendChild(contentCell);

      table.appendChild(row);
    }

    hunkEl.appendChild(table);
    container.appendChild(hunkEl);
  }

  return container;
}

/**
 * Convenience function that parses a unified diff string and renders it to a DOM element.
 * Returns the rendered element ready to be appended to a chat message.
 */
export function createDiffPreview(diffText: string): HTMLElement {
  const parsed = parseDiff(diffText);
  return renderDiff(parsed);
}

/**
 * Detects whether a string appears to be a unified diff.
 * Checks for common diff markers (--- /+++ headers or @@ hunk markers).
 */
export function isDiffContent(content: string): boolean {
  return (
    content.includes('@@') &&
    (content.includes('--- ') || content.includes('+++ '))
  );
}
