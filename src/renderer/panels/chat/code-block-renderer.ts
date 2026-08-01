/**
 * Enhanced code block renderer for the chat panel.
 * Renders code blocks with syntax highlighting (language detection from markdown fence),
 * a language label badge, a copy-to-clipboard button, and an "Apply to file" button
 * that triggers IPC to insert code at cursor position.
 *
 * Requirements: 23.1
 */

/** CSS class names scoped to the code block renderer. */
const CSS = {
  wrapper: 'nn-code-block',
  header: 'nn-code-block__header',
  languageBadge: 'nn-code-block__lang-badge',
  actions: 'nn-code-block__actions',
  actionBtn: 'nn-code-block__action-btn',
  copyBtn: 'nn-code-block__copy-btn',
  applyBtn: 'nn-code-block__apply-btn',
  codeContainer: 'nn-code-block__code-container',
  pre: 'nn-code-block__pre',
  code: 'nn-code-block__code',
  lineNumber: 'nn-code-block__line-number',
  line: 'nn-code-block__line',
  copied: 'nn-code-block__copied',
} as const;

/** Map of common language aliases to display names. */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  ruby: 'Ruby',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  cpp: 'C++',
  'c++': 'C++',
  c: 'C',
  cs: 'C#',
  csharp: 'C#',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  fish: 'Fish',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  md: 'Markdown',
  markdown: 'Markdown',
  dockerfile: 'Dockerfile',
  docker: 'Dockerfile',
  toml: 'TOML',
  ini: 'INI',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  swift: 'Swift',
  kotlin: 'Kotlin',
  kt: 'Kotlin',
  dart: 'Dart',
  lua: 'Lua',
  php: 'PHP',
  r: 'R',
  scala: 'Scala',
  elixir: 'Elixir',
  ex: 'Elixir',
  haskell: 'Haskell',
  hs: 'Haskell',
  clojure: 'Clojure',
  clj: 'Clojure',
  vim: 'Vim',
  plaintext: 'Plain Text',
  text: 'Plain Text',
  txt: 'Plain Text',
};

/** Simple keyword-based syntax highlighting token types. */
type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'operator' | 'punctuation' | 'text';

/** Common programming keywords for basic highlighting. */
const KEYWORDS = new Set([
  'abstract', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of',
  'package', 'private', 'protected', 'public', 'readonly', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
  'undefined', 'var', 'void', 'while', 'with', 'yield',
  // Python
  'def', 'lambda', 'pass', 'raise', 'global', 'nonlocal', 'assert', 'elif',
  'except', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self',
  // Rust/Go
  'fn', 'impl', 'mod', 'pub', 'use', 'crate', 'struct', 'trait', 'where',
  'mut', 'ref', 'match', 'loop', 'move', 'unsafe', 'extern',
  'func', 'go', 'defer', 'chan', 'select', 'range', 'map',
]);

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Injects scoped styles for the code block renderer. */
function injectStyles(): void {
  if (document.getElementById('nn-code-block-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-code-block-styles';
  style.textContent = `
    .${CSS.wrapper} {
      border-radius: 8px;
      overflow: hidden;
      margin: 8px 0;
      background: var(--code-block-bg, #1e1e1e);
      border: 1px solid var(--code-block-border, #333333);
      font-family: var(--font-mono, 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace);
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--code-block-header-bg, #252526);
      border-bottom: 1px solid var(--code-block-border, #333333);
      min-height: 32px;
    }
    .${CSS.languageBadge} {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--code-block-lang-text, #9cdcfe);
      background: var(--code-block-lang-bg, rgba(156, 220, 254, 0.1));
      padding: 2px 8px;
      border-radius: 4px;
      line-height: 1.2;
    }
    .${CSS.actions} {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .${CSS.actionBtn} {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, opacity 0.15s ease;
      line-height: 1.2;
    }
    .${CSS.actionBtn}:focus-visible {
      outline: 2px solid var(--focus-ring, #007acc);
      outline-offset: 1px;
    }
    .${CSS.copyBtn} {
      background: var(--code-block-btn-bg, rgba(255, 255, 255, 0.06));
      color: var(--code-block-btn-text, #cccccc);
    }
    .${CSS.copyBtn}:hover {
      background: var(--code-block-btn-hover-bg, rgba(255, 255, 255, 0.12));
    }
    .${CSS.applyBtn} {
      background: var(--code-block-apply-bg, rgba(55, 148, 255, 0.15));
      color: var(--code-block-apply-text, #3794ff);
    }
    .${CSS.applyBtn}:hover {
      background: var(--code-block-apply-hover-bg, rgba(55, 148, 255, 0.25));
    }
    .${CSS.codeContainer} {
      overflow-x: auto;
      padding: 12px 0;
    }
    .${CSS.pre} {
      margin: 0;
      padding: 0 16px;
      font-size: 13px;
      line-height: 1.5;
      tab-size: 2;
    }
    .${CSS.code} {
      display: block;
      white-space: pre;
    }
    .${CSS.line} {
      display: flex;
      min-height: 20px;
    }
    .${CSS.lineNumber} {
      display: inline-block;
      min-width: 32px;
      padding-right: 12px;
      text-align: right;
      color: var(--code-block-line-number, #555555);
      user-select: none;
      flex-shrink: 0;
    }
    .${CSS.copied} {
      color: var(--code-block-success, #73c991) !important;
    }

    /* Syntax highlighting token colors */
    .nn-token-keyword {
      color: var(--syntax-keyword, #c586c0);
    }
    .nn-token-string {
      color: var(--syntax-string, #ce9178);
    }
    .nn-token-comment {
      color: var(--syntax-comment, #6a9955);
      font-style: italic;
    }
    .nn-token-number {
      color: var(--syntax-number, #b5cea8);
    }
    .nn-token-operator {
      color: var(--syntax-operator, #d4d4d4);
    }
    .nn-token-punctuation {
      color: var(--syntax-punctuation, #d4d4d4);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Escape HTML special characters to prevent XSS when rendering code content.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Simple tokenizer for basic syntax highlighting.
 * Provides keyword, string, comment, and number highlighting.
 */
function tokenizeLine(line: string): Array<{ type: TokenType; text: string }> {
  const tokens: Array<{ type: TokenType; text: string }> = [];
  let i = 0;

  while (i < line.length) {
    // Single-line comment (//)
    if (line[i] === '/' && line[i + 1] === '/') {
      tokens.push({ type: 'comment', text: line.slice(i) });
      break;
    }

    // Hash comment (#)
    if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      tokens.push({ type: 'comment', text: line.slice(i) });
      break;
    }

    // String (double quotes)
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== '"') {
        if (line[end] === '\\') end++; // skip escaped character
        end++;
      }
      end = Math.min(end + 1, line.length);
      tokens.push({ type: 'string', text: line.slice(i, end) });
      i = end;
      continue;
    }

    // String (single quotes)
    if (line[i] === "'") {
      let end = i + 1;
      while (end < line.length && line[end] !== "'") {
        if (line[end] === '\\') end++;
        end++;
      }
      end = Math.min(end + 1, line.length);
      tokens.push({ type: 'string', text: line.slice(i, end) });
      i = end;
      continue;
    }

    // Template literal (backtick)
    if (line[i] === '`') {
      let end = i + 1;
      while (end < line.length && line[end] !== '`') {
        if (line[end] === '\\') end++;
        end++;
      }
      end = Math.min(end + 1, line.length);
      tokens.push({ type: 'string', text: line.slice(i, end) });
      i = end;
      continue;
    }

    // Number
    if (/\d/.test(line[i]) && (i === 0 || /[\s(,=+\-*/<>[\]{};:]/.test(line[i - 1]))) {
      let end = i;
      while (end < line.length && /[\d.xXa-fA-F_]/.test(line[end])) end++;
      tokens.push({ type: 'number', text: line.slice(i, end) });
      i = end;
      continue;
    }

    // Word (potential keyword or identifier)
    if (/[a-zA-Z_$]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[\w$]/.test(line[end])) end++;
      const word = line.slice(i, end);
      const type: TokenType = KEYWORDS.has(word) ? 'keyword' : 'text';
      tokens.push({ type, text: word });
      i = end;
      continue;
    }

    // Operators and punctuation
    if (/[=+\-*/<>!&|^~%?:]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[=+\-*/<>!&|^~%?:]/.test(line[end])) end++;
      tokens.push({ type: 'operator', text: line.slice(i, end) });
      i = end;
      continue;
    }

    if (/[{}()[\],;.]/.test(line[i])) {
      tokens.push({ type: 'punctuation', text: line[i] });
      i++;
      continue;
    }

    // Whitespace and other characters
    let end = i;
    while (
      end < line.length &&
      !/[a-zA-Z_$\d"'`#/=+\-*/<>!&|^~%?:{}()[\],;.]/.test(line[end])
    ) {
      end++;
    }
    if (end === i) end = i + 1; // prevent infinite loop
    tokens.push({ type: 'text', text: line.slice(i, end) });
    i = end;
  }

  return tokens;
}

/**
 * Get the display name for a language identifier.
 */
export function getLanguageDisplayName(language: string): string {
  if (!language) return 'Code';
  const lower = language.toLowerCase().trim();
  return LANGUAGE_DISPLAY_NAMES[lower] || language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * Parsed code block extracted from markdown content.
 */
export interface ParsedCodeBlock {
  /** The language identifier from the markdown fence (e.g., 'typescript', 'python') */
  language: string;
  /** The raw code content inside the fenced block */
  code: string;
}

/**
 * Parse markdown content and extract fenced code blocks.
 * Detects ```language\ncode\n``` patterns.
 */
export function parseCodeBlocks(markdown: string): ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];
  const regex = /^```(\w*)\s*\n([\s\S]*?)^```\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    blocks.push({
      language: match[1] || '',
      code: match[2].replace(/\n$/, ''), // Remove trailing newline
    });
  }

  return blocks;
}

/**
 * Options for rendering a code block.
 */
export interface CodeBlockRenderOptions {
  /** The code content to render */
  code: string;
  /** The language identifier for highlighting and badge display */
  language?: string;
  /** Whether to show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Whether to show the "Apply to file" button (default: true) */
  showApplyButton?: boolean;
  /** File path context for the apply action (optional) */
  filePath?: string;
}

/**
 * Render an enhanced code block element with syntax highlighting,
 * language badge, copy button, and apply-to-file button.
 *
 * @param options - Configuration for the code block rendering
 * @returns The rendered HTMLElement ready for DOM insertion
 */
export function renderCodeBlock(options: CodeBlockRenderOptions): HTMLElement {
  injectStyles();

  const {
    code,
    language = '',
    showLineNumbers = true,
    showApplyButton = true,
    filePath,
  } = options;

  // Wrapper
  const wrapper = document.createElement('div');
  wrapper.className = CSS.wrapper;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', `Code block${language ? `: ${getLanguageDisplayName(language)}` : ''}`);

  // Header
  const header = document.createElement('div');
  header.className = CSS.header;

  // Language badge
  const badge = document.createElement('span');
  badge.className = CSS.languageBadge;
  badge.textContent = getLanguageDisplayName(language);
  header.appendChild(badge);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = CSS.actions;

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = `${CSS.actionBtn} ${CSS.copyBtn}`;
  copyBtn.setAttribute('aria-label', 'Copy code to clipboard');
  copyBtn.setAttribute('title', 'Copy');
  copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h8v8H4V4zm1 1v6h6V5H5zM2 2v8h1V3h7V2H2z"/></svg><span>Copy</span>`;
  copyBtn.addEventListener('click', () => handleCopy(copyBtn, code));
  actions.appendChild(copyBtn);

  // Apply to file button
  if (showApplyButton) {
    const applyBtn = document.createElement('button');
    applyBtn.className = `${CSS.actionBtn} ${CSS.applyBtn}`;
    applyBtn.setAttribute('aria-label', 'Apply code to active editor');
    applyBtn.setAttribute('title', 'Apply to file');
    applyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 1l3.5 3.5v10.5h-11v-14h7.5zm-.5 1h-6v12h9v-9h-3v-3zm-1 7l-3 3-1-1 2-2-2-2 1-1 3 3z"/></svg><span>Apply to file</span>`;
    applyBtn.addEventListener('click', () => handleApply(code, filePath));
    actions.appendChild(applyBtn);
  }

  header.appendChild(actions);
  wrapper.appendChild(header);

  // Code container
  const codeContainer = document.createElement('div');
  codeContainer.className = CSS.codeContainer;

  const pre = document.createElement('pre');
  pre.className = CSS.pre;

  const codeEl = document.createElement('code');
  codeEl.className = CSS.code;
  if (language) {
    codeEl.dataset.language = language;
  }

  // Render lines with syntax highlighting and optional line numbers
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineEl = document.createElement('span');
    lineEl.className = CSS.line;

    if (showLineNumbers) {
      const lineNum = document.createElement('span');
      lineNum.className = CSS.lineNumber;
      lineNum.setAttribute('aria-hidden', 'true');
      lineNum.textContent = String(i + 1);
      lineEl.appendChild(lineNum);
    }

    const lineContent = document.createElement('span');
    const tokens = tokenizeLine(lines[i]);
    for (const token of tokens) {
      if (token.type === 'text') {
        lineContent.appendChild(document.createTextNode(escapeHtml(token.text)));
      } else {
        const span = document.createElement('span');
        span.className = `nn-token-${token.type}`;
        span.textContent = token.text;
        lineContent.appendChild(span);
      }
    }

    // If line is empty, add a space to maintain line height
    if (tokens.length === 0) {
      lineContent.appendChild(document.createTextNode('\n'));
    }

    lineEl.appendChild(lineContent);
    codeEl.appendChild(lineEl);
  }

  pre.appendChild(codeEl);
  codeContainer.appendChild(pre);
  wrapper.appendChild(codeContainer);

  return wrapper;
}

/**
 * Handle the copy button click: copy code to clipboard and show feedback.
 */
async function handleCopy(button: HTMLButtonElement, code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);

    // Visual feedback
    const originalHtml = button.innerHTML;
    button.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6 11.5l-3.5-3.5 1-1 2.5 2.5 5.5-5.5 1 1-6.5 6.5z"/></svg><span>Copied!</span>`;
    button.classList.add(CSS.copied);
    button.setAttribute('aria-label', 'Code copied to clipboard');

    setTimeout(() => {
      button.innerHTML = originalHtml;
      button.classList.remove(CSS.copied);
      button.setAttribute('aria-label', 'Copy code to clipboard');
    }, 2000);
  } catch {
    // Fallback: use legacy execCommand if clipboard API is unavailable
    try {
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);

      const originalHtml = button.innerHTML;
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6 11.5l-3.5-3.5 1-1 2.5 2.5 5.5-5.5 1 1-6.5 6.5z"/></svg><span>Copied!</span>`;
      button.classList.add(CSS.copied);

      setTimeout(() => {
        button.innerHTML = originalHtml;
        button.classList.remove(CSS.copied);
      }, 2000);
    } catch {
      // Silently fail if both methods are unavailable
    }
  }
}

/**
 * Handle the "Apply to file" button: send code via IPC to insert at cursor position.
 */
async function handleApply(code: string, filePath?: string): Promise<void> {
  const bridge = getIpcBridge();
  await bridge.invoke('chat:apply-code', { code, filePath });
}

/**
 * CodeBlockRenderer class for managing code block rendering within the chat panel.
 * Provides a higher-level API for rendering multiple code blocks from markdown content.
 */
export class CodeBlockRenderer {
  /**
   * Render all code blocks found in a markdown string.
   * Returns an array of rendered HTMLElements.
   */
  renderFromMarkdown(markdown: string): HTMLElement[] {
    const blocks = parseCodeBlocks(markdown);
    return blocks.map((block) =>
      renderCodeBlock({
        code: block.code,
        language: block.language,
      })
    );
  }

  /**
   * Render a single code block with the given options.
   */
  render(options: CodeBlockRenderOptions): HTMLElement {
    return renderCodeBlock(options);
  }

  /**
   * Get the display name for a language identifier.
   */
  getLanguageDisplayName(language: string): string {
    return getLanguageDisplayName(language);
  }
}
