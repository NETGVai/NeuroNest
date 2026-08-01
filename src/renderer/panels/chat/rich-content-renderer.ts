/**
 * Rich Content Renderer for the chat panel.
 * Orchestrates rendering of Mermaid diagrams, tables, and LaTeX math
 * within chat messages. Leverages the existing mermaid-renderer
 * (window.renderMermaid / window.renderMermaidAsync) and markdown-it pipeline.
 *
 * Requirements: 23.13
 */

/** Result of rendering a Mermaid diagram. */
export interface MermaidRenderResult {
  success: boolean;
  svg: string | null;
  source: string;
  error: string | null;
  blocked: boolean;
}

/** Options for the rich content renderer. */
export interface RichContentRenderOptions {
  /** Enable Mermaid diagram rendering. Default: true. */
  enableMermaid?: boolean;
  /** Enable LaTeX math rendering. Default: true. */
  enableLatex?: boolean;
  /** Enable enhanced table rendering. Default: true. */
  enableTables?: boolean;
  /** Mermaid theme override. */
  mermaidTheme?: string;
}

/** CSS class names scoped to the rich content renderer. */
const CSS = {
  mermaidContainer: 'nn-rich-mermaid',
  mermaidError: 'nn-rich-mermaid__error',
  mermaidSource: 'nn-rich-mermaid__source',
  mermaidFallback: 'nn-rich-mermaid__fallback',
  latexBlock: 'nn-rich-latex',
  latexInline: 'nn-rich-latex--inline',
  latexError: 'nn-rich-latex__error',
  table: 'nn-rich-table',
  tableWrapper: 'nn-rich-table__wrapper',
} as const;

/** Injects scoped styles for rich content rendering. */
function injectStyles(): void {
  if (document.getElementById('nn-rich-content-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-rich-content-styles';
  style.textContent = `
    .${CSS.mermaidContainer} {
      margin: 8px 0;
      padding: 16px;
      border: 1px solid var(--rich-mermaid-border, #3d3d3d);
      border-radius: 8px;
      background: var(--rich-mermaid-bg, #1a1a2e);
      text-align: center;
      overflow-x: auto;
    }
    .${CSS.mermaidContainer} svg {
      max-width: 100%;
      height: auto;
    }
    .${CSS.mermaidError} {
      font-size: 12px;
      color: var(--rich-mermaid-error-text, #f44336);
      padding: 8px 12px;
      background: var(--rich-mermaid-error-bg, rgba(244, 67, 54, 0.1));
      border-radius: 4px;
      text-align: left;
    }
    .${CSS.mermaidSource} {
      margin-top: 8px;
      font-size: 11px;
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      color: var(--rich-mermaid-source-text, #888888);
      text-align: left;
      white-space: pre-wrap;
      word-wrap: break-word;
      background: var(--rich-mermaid-source-bg, #111111);
      padding: 8px;
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
    }
    .${CSS.mermaidFallback} {
      font-size: 12px;
      color: var(--text-secondary, #aaaaaa);
      font-style: italic;
    }
    .${CSS.latexBlock} {
      margin: 8px 0;
      padding: 12px 16px;
      background: var(--rich-latex-bg, #1a1a1a);
      border-radius: 6px;
      overflow-x: auto;
      text-align: center;
      font-size: 15px;
      line-height: 1.6;
    }
    .${CSS.latexInline} {
      display: inline;
      margin: 0;
      padding: 2px 4px;
      background: var(--rich-latex-inline-bg, rgba(255, 255, 255, 0.04));
      border-radius: 3px;
      font-size: inherit;
      text-align: inherit;
    }
    .${CSS.latexError} {
      font-size: 11px;
      color: var(--rich-latex-error-text, #ff9800);
      font-family: var(--font-mono, monospace);
    }
    .${CSS.tableWrapper} {
      margin: 8px 0;
      overflow-x: auto;
      border-radius: 6px;
      border: 1px solid var(--rich-table-border, #3d3d3d);
    }
    .${CSS.table} {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      line-height: 1.5;
    }
    .${CSS.table} th {
      background: var(--rich-table-header-bg, #252526);
      color: var(--rich-table-header-text, #e0e0e0);
      font-weight: 600;
      padding: 8px 12px;
      text-align: left;
      border-bottom: 2px solid var(--rich-table-border, #3d3d3d);
    }
    .${CSS.table} td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--rich-table-border, #2d2d2d);
      color: var(--text-primary, #cccccc);
    }
    .${CSS.table} tr:last-child td {
      border-bottom: none;
    }
    .${CSS.table} tr:hover td {
      background: var(--rich-table-hover-bg, rgba(255, 255, 255, 0.03));
    }
  `;
  document.head.appendChild(style);
}

/**
 * Escape HTML special characters for safe insertion.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Access the global mermaid renderer (renderMermaid / renderMermaidAsync).
 * Returns null if not available.
 */
function getMermaidRenderer(): {
  renderSync?: (source: string) => MermaidRenderResult;
  renderAsync?: (source: string) => Promise<MermaidRenderResult>;
} {
  const win = window as unknown as Record<string, unknown>;
  return {
    renderSync: typeof win.renderMermaid === 'function'
      ? (win.renderMermaid as (source: string) => MermaidRenderResult)
      : undefined,
    renderAsync: typeof win.renderMermaidAsync === 'function'
      ? (win.renderMermaidAsync as (source: string) => Promise<MermaidRenderResult>)
      : undefined,
  };
}

/**
 * Access the global LaTeX renderer (e.g., KaTeX).
 * Returns null if not available.
 */
function getLatexRenderer(): {
  renderToString?: (latex: string, options?: { displayMode?: boolean }) => string;
} | null {
  const win = window as unknown as Record<string, unknown>;

  // Check for KaTeX
  if (win.katex && typeof (win.katex as Record<string, unknown>).renderToString === 'function') {
    return win.katex as { renderToString: (latex: string, options?: { displayMode?: boolean }) => string };
  }

  return null;
}

/**
 * Render a Mermaid diagram from source code.
 * Uses the existing mermaid-renderer infrastructure (window.renderMermaid).
 *
 * @param source - Mermaid diagram source code
 * @returns Rendered HTMLElement (SVG container or fallback)
 */
export function renderMermaidDiagram(source: string): HTMLElement {
  injectStyles();

  const container = document.createElement('div');
  container.className = CSS.mermaidContainer;
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', 'Mermaid diagram');

  const renderer = getMermaidRenderer();

  // Try synchronous render first
  if (renderer.renderSync) {
    const result = renderer.renderSync(source);
    if (result.success && result.svg) {
      container.innerHTML = result.svg;
      return container;
    }
    if (result.error) {
      const errorEl = document.createElement('div');
      errorEl.className = CSS.mermaidError;
      errorEl.textContent = `\u26A0\uFE0F ${result.error}`;
      container.appendChild(errorEl);

      const sourceEl = document.createElement('pre');
      sourceEl.className = CSS.mermaidSource;
      sourceEl.textContent = source;
      container.appendChild(sourceEl);
      return container;
    }
  }

  // Try async render with placeholder
  if (renderer.renderAsync) {
    const placeholder = document.createElement('span');
    placeholder.className = CSS.mermaidFallback;
    placeholder.textContent = 'Rendering diagram...';
    container.appendChild(placeholder);

    renderer.renderAsync(source).then((result) => {
      if (result.success && result.svg) {
        container.innerHTML = result.svg;
      } else {
        container.innerHTML = '';
        const errorEl = document.createElement('div');
        errorEl.className = CSS.mermaidError;
        errorEl.textContent = `\u26A0\uFE0F ${result.error || 'Render failed'}`;
        container.appendChild(errorEl);

        const sourceEl = document.createElement('pre');
        sourceEl.className = CSS.mermaidSource;
        sourceEl.textContent = source;
        container.appendChild(sourceEl);
      }
    }).catch(() => {
      container.innerHTML = '';
      const sourceEl = document.createElement('pre');
      sourceEl.className = CSS.mermaidSource;
      sourceEl.textContent = source;
      container.appendChild(sourceEl);
    });

    return container;
  }

  // No renderer available — show source as fallback
  const fallback = document.createElement('pre');
  fallback.className = CSS.mermaidSource;
  fallback.textContent = source;
  container.appendChild(fallback);

  return container;
}

/**
 * Render a LaTeX math expression.
 * Uses KaTeX if available, otherwise falls back to displaying the source.
 *
 * @param latex - LaTeX expression string
 * @param displayMode - Whether to render in display (block) mode. Default: false (inline).
 * @returns Rendered HTMLElement
 */
export function renderLatex(latex: string, displayMode: boolean = false): HTMLElement {
  injectStyles();

  const container = document.createElement('span');
  container.className = displayMode ? CSS.latexBlock : `${CSS.latexBlock} ${CSS.latexInline}`;

  const renderer = getLatexRenderer();

  if (renderer?.renderToString) {
    try {
      const html = renderer.renderToString(latex, {
        displayMode,
      });
      container.innerHTML = html;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Render failed';
      const errorEl = document.createElement('span');
      errorEl.className = CSS.latexError;
      errorEl.textContent = latex;
      errorEl.title = `LaTeX error: ${errorMsg}`;
      container.appendChild(errorEl);
    }
  } else {
    // Fallback: display raw LaTeX in monospace
    const fallback = document.createElement('code');
    fallback.textContent = displayMode ? `$$${latex}$$` : `$${latex}$`;
    fallback.title = 'LaTeX rendering unavailable';
    container.appendChild(fallback);
  }

  return container;
}

/**
 * Render a markdown table with enhanced styling.
 * Parses a markdown table string and renders it as a styled HTML table.
 *
 * @param tableMarkdown - Raw markdown table string (lines with pipes)
 * @returns Rendered HTMLElement (table wrapped in scrollable container)
 */
export function renderTable(tableMarkdown: string): HTMLElement {
  injectStyles();

  const wrapper = document.createElement('div');
  wrapper.className = CSS.tableWrapper;

  const table = document.createElement('table');
  table.className = CSS.table;
  table.setAttribute('role', 'table');

  const lines = tableMarkdown.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return wrapper;
  }

  // Parse header row
  const headerCells = parseTableRow(lines[0]);

  // Check for separator row (e.g., |---|---|)
  let dataStartIndex = 1;
  if (lines.length > 1 && isSeparatorRow(lines[1])) {
    dataStartIndex = 2;
  }

  // Build thead
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const cell of headerCells) {
    const th = document.createElement('th');
    th.textContent = cell.trim();
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Build tbody
  const tbody = document.createElement('tbody');
  for (let i = dataStartIndex; i < lines.length; i++) {
    const cells = parseTableRow(lines[i]);
    const row = document.createElement('tr');
    for (let j = 0; j < headerCells.length; j++) {
      const td = document.createElement('td');
      td.textContent = (cells[j] ?? '').trim();
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  wrapper.appendChild(table);
  return wrapper;
}

/**
 * Parse a single markdown table row into cells.
 * Handles leading/trailing pipes and escaped pipes.
 */
function parseTableRow(row: string): string[] {
  let trimmed = row.trim();
  // Remove leading and trailing pipes
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  // Split by unescaped pipes
  return trimmed.split('|').map((cell) => cell.replace(/\\\|/g, '|'));
}

/**
 * Check if a row is a table separator (e.g., |---|---|).
 */
function isSeparatorRow(row: string): boolean {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return /^[\s\-:|]+$/.test(trimmed) && trimmed.includes('-');
}

/**
 * Process markdown content and render rich content (Mermaid, LaTeX, tables).
 * Returns processed HTML string with special blocks replaced by rendered elements.
 *
 * This function works on raw markdown text and produces an HTML string.
 * Mermaid code blocks, LaTeX expressions, and tables are rendered inline.
 *
 * @param html - HTML content (after markdown-it processing)
 * @param options - Rendering options
 * @returns Processed HTML string with rich content rendered
 */
export function processRichContent(
  html: string,
  options: RichContentRenderOptions = {}
): string {
  const {
    enableMermaid = true,
    enableLatex = true,
    enableTables = true,
  } = options;

  let processed = html;

  // Process Mermaid blocks: <pre><code class="language-mermaid">...</code></pre>
  if (enableMermaid) {
    processed = processed.replace(
      /<pre><code class="(?:hljs )?language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      (_match, code: string) => {
        const source = decodeHtmlEntities(code);
        const el = renderMermaidDiagram(source);
        return el.outerHTML;
      }
    );
  }

  // Process LaTeX block expressions: $$...$$
  if (enableLatex) {
    processed = processed.replace(
      /\$\$([\s\S]*?)\$\$/g,
      (_match, latex: string) => {
        const el = renderLatex(decodeHtmlEntities(latex.trim()), true);
        return el.outerHTML;
      }
    );

    // Process LaTeX inline expressions: $...$
    // Avoid matching already-processed $$ or currency amounts
    processed = processed.replace(
      /(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g,
      (_match, latex: string) => {
        const el = renderLatex(decodeHtmlEntities(latex.trim()), false);
        return el.outerHTML;
      }
    );
  }

  // Enhanced table styling: wrap <table> elements in styled container
  if (enableTables) {
    processed = processed.replace(
      /<table>([\s\S]*?)<\/table>/g,
      (_match, inner: string) => {
        return `<div class="${CSS.tableWrapper}"><table class="${CSS.table}">${inner}</table></div>`;
      }
    );
  }

  return processed;
}

/**
 * Decode HTML entities back to plain text.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * RichContentRenderer class — provides a higher-level API for rendering
 * rich content within chat messages. Integrates Mermaid diagrams, tables,
 * and LaTeX math through the existing rendering pipeline.
 */
export class RichContentRenderer {
  private options: RichContentRenderOptions;

  constructor(options: RichContentRenderOptions = {}) {
    this.options = options;
    injectStyles();
  }

  /**
   * Process HTML content and enhance with rich rendering.
   * Call this after markdown-it has processed the raw markdown.
   */
  process(html: string): string {
    return processRichContent(html, this.options);
  }

  /**
   * Render a standalone Mermaid diagram.
   */
  renderMermaid(source: string): HTMLElement {
    return renderMermaidDiagram(source);
  }

  /**
   * Render a standalone LaTeX expression.
   */
  renderLatex(latex: string, displayMode?: boolean): HTMLElement {
    return renderLatex(latex, displayMode);
  }

  /**
   * Render a standalone table from markdown.
   */
  renderTable(tableMarkdown: string): HTMLElement {
    return renderTable(tableMarkdown);
  }

  /**
   * Check if the Mermaid rendering pipeline is available.
   */
  isMermaidAvailable(): boolean {
    const renderer = getMermaidRenderer();
    return renderer.renderSync !== undefined || renderer.renderAsync !== undefined;
  }

  /**
   * Check if the LaTeX rendering pipeline is available.
   */
  isLatexAvailable(): boolean {
    return getLatexRenderer() !== null;
  }
}
