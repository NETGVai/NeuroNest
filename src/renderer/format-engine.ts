import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export interface FormatEngineOptions {
  /** Enable syntax highlighting (default: true) */
  highlight?: boolean;
  /** Enable HTML sanitization (default: true) */
  sanitize?: boolean;
}

interface FormatEngineState {
  md: MarkdownIt;
  codeBlockCounter: number;
}

let state: FormatEngineState | null = null;

/**
 * Initialize the format engine. Must be called once at app startup.
 * Configures markdown-it with highlight.js integration.
 */
export function initFormatEngine(options?: FormatEngineOptions): void {
  const opts = {
    highlight: options?.highlight !== false,
    sanitize: options?.sanitize !== false,
  };

  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight: opts.highlight ? highlightCode : undefined,
  });

  // Enable tables (built-in) and strikethrough
  md.enable(['table', 'strikethrough']);

  // Custom fence renderer for code blocks with language badge + copy button
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, mdOptions, env, self) => {
    return renderCodeBlock(tokens, idx, mdOptions, env, self, defaultFence);
  };

  // Make links open externally
  const defaultLinkOpen = md.renderer.rules.link_open ||
    function (tokens: any[], idx: number, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  state = {
    md,
    codeBlockCounter: 0,
  };
}

/**
 * Render markdown text to sanitized HTML.
 * Replaces the old formatMsg() function.
 */
export function renderMarkdown(text: string): string {
  if (text == null || text === '') {
    return '';
  }
  if (!state) {
    initFormatEngine();
  }
  return state!.md.render(text);
}

/**
 * Extract plain text from markdown (strips all formatting).
 * Used for clipboard operations and accessibility.
 */
export function extractText(markdown: string): string {
  if (markdown == null || markdown === '') {
    return '';
  }
  if (!state) {
    initFormatEngine();
  }
  // Render to HTML, then strip tags to get plain text
  const html = state!.md.render(markdown);
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/**
 * Custom highlight function for markdown-it.
 * Delegates to highlight.js with fallback for unknown languages.
 */
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      // Fall through to plain text
    }
  }
  // No language or unknown language — return empty string to let markdown-it escape it
  return '';
}

/**
 * Custom fence renderer producing .code-block-wrapper HTML
 * with language badge and copy button.
 */
function renderCodeBlock(
  tokens: any[],
  idx: number,
  mdOptions: any,
  _env: any,
  self: any,
  _defaultFence: any,
): string {
  const token = tokens[idx];
  const info = token.info ? token.info.trim() : '';
  const lang = info.split(/\s+/g)[0] || '';
  const code = token.content;

  if (!state) {
    initFormatEngine();
  }

  const codeId = `cb-${state!.codeBlockCounter++}`;

  // Highlight the code if a language is specified
  let highlightedCode: string;
  let langClass = '';

  if (lang && hljs.getLanguage(lang)) {
    try {
      highlightedCode = hljs.highlight(code, { language: lang }).value;
      langClass = ` class="hljs language-${escapeAttr(lang)}"`;
    } catch {
      highlightedCode = escapeHtml(code);
    }
  } else if (lang) {
    // Language specified but not recognized — render without hljs classes
    highlightedCode = escapeHtml(code);
  } else {
    // No language specified — plain preformatted block
    highlightedCode = escapeHtml(code);
  }

  // Build the header with language badge and copy button
  const langBadge = lang
    ? `<span class="code-lang-badge">${escapeHtml(lang)}</span>`
    : '';

  const copyButton = `<button class="code-copy-btn" data-code-id="${codeId}" aria-label="Copy code"><span class="copy-icon">📋</span></button>`;

  const header = `<div class="code-block-header">${langBadge}${copyButton}</div>`;

  const codeTag = langClass
    ? `<code${langClass}>${highlightedCode}</code>`
    : `<code>${highlightedCode}</code>`;

  return `<div class="code-block-wrapper">${header}<pre class="code-block-pre">${codeTag}</pre></div>\n`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
