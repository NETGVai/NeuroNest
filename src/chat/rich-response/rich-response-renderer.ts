/**
 * RichResponseRenderer — Renders Markdown, code, mermaid diagrams, tables,
 * interactive cards, diff previews, and structured data in chat responses.
 *
 * Sanitizes all output under Electron CSP (no inline scripts, no unsafe-inline).
 * Requires consent for remote resource loading (images, iframes).
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8
 */

import type {
  RichContentBlock,
  RenderResult,
  CspPolicy,
  RemoteResourceConsent,
  CodeBlockOptions,
  InteractiveCard,
  DiffPreview,
  TableData,
} from './types';

/**
 * Default CSP policy: no inline scripts, no unsafe-inline, require consent for remote.
 */
const DEFAULT_CSP_POLICY: CspPolicy = {
  allowInlineStyles: false,
  allowInlineScripts: false,
  allowedImageSources: [],
  allowedFrameSources: [],
  requireConsent: true,
};

export class RichResponseRenderer {
  private readonly cspPolicy: CspPolicy;
  private readonly consents: Map<string, RemoteResourceConsent> = new Map();

  constructor(cspPolicy?: Partial<CspPolicy>) {
    this.cspPolicy = { ...DEFAULT_CSP_POLICY, ...cspPolicy };
  }

  /**
   * Grant consent for a remote resource.
   */
  grantConsent(uri: string, grantedBy: string): void {
    this.consents.set(uri, {
      uri,
      granted: true,
      grantedAt: new Date().toISOString(),
      grantedBy,
    });
  }

  /**
   * Revoke consent for a remote resource.
   */
  revokeConsent(uri: string): void {
    this.consents.delete(uri);
  }

  /**
   * Check if consent is granted for a URI.
   */
  hasConsent(uri: string): boolean {
    return this.consents.get(uri)?.granted === true;
  }

  /**
   * Render a rich content block to sanitized HTML.
   */
  render(block: RichContentBlock): RenderResult {
    switch (block.type) {
      case 'markdown':
        return this.renderMarkdown(block.content);
      case 'code':
        return this.renderCode({
          language: block.metadata?.language ?? 'plaintext',
          content: block.content,
          sourceAttribution: block.metadata?.sourceUri,
        });
      case 'mermaid':
        return this.renderMermaid(block.content);
      case 'table':
        return this.renderTableFromContent(block.content);
      case 'interactive_card':
        return this.renderInteractiveCardFromContent(block.content);
      case 'diff_preview':
        return this.renderDiffPreviewFromContent(block.content);
      case 'structured_data':
        return this.renderStructuredData(block.content);
      default:
        return this.renderMarkdown(block.content);
    }
  }

  /**
   * Render Markdown content (headings, lists, links, emphasis).
   * Processes Markdown syntax first, then sanitizes.
   */
  renderMarkdown(content: string): RenderResult {
    const blockedResources: string[] = [];
    let html = content;

    // Images BEFORE links (since ![...] is a superset of [...])
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, src: string) => {
      if (this.isRemoteUri(src)) {
        if (this.cspPolicy.requireConsent && !this.hasConsent(src)) {
          blockedResources.push(src);
          return `<span class="blocked-image" data-src="${this.escapeAttr(src)}">[Image: ${this.escapeHtml(alt) || 'remote'} - consent required]</span>`;
        }
        if (!this.cspPolicy.allowedImageSources.some(allowed => src.startsWith(allowed))) {
          blockedResources.push(src);
          return `<span class="blocked-image" data-src="${this.escapeAttr(src)}">[Image: ${this.escapeHtml(alt) || 'remote'} - not in allowlist]</span>`;
        }
      }
      return `<img src="${this.escapeAttr(src)}" alt="${this.escapeAttr(alt)}" />`;
    });

    // Links (check remote consent)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) => {
      if (this.isRemoteUri(href) && this.cspPolicy.requireConsent && !this.hasConsent(href)) {
        blockedResources.push(href);
        return `<span class="blocked-link" data-href="${this.escapeAttr(href)}">${this.escapeHtml(text)} [consent required]</span>`;
      }
      return `<a href="${this.escapeAttr(href)}" rel="noopener noreferrer">${this.escapeHtml(text)}</a>`;
    });

    // Headings
    html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes: string, text: string) => {
      const level = hashes.length;
      return `<h${level}>${this.escapeHtml(text)}</h${level}>`;
    });

    // Blockquotes (before escaping the remaining content)
    html = html.replace(/^>\s+(.+)$/gm, (_match, text: string) => {
      return `<blockquote>${this.escapeHtml(text)}</blockquote>`;
    });

    // Unordered lists
    html = html.replace(/^[-*]\s+(.+)$/gm, (_match, text: string) => {
      return `<li>${this.escapeHtml(text)}</li>`;
    });
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

    // Inline code (escape content inside code)
    html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
      return `<code>${this.escapeHtml(code)}</code>`;
    });

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, (_match, text: string) => `<strong>${this.escapeHtml(text)}</strong>`);

    // Italic
    html = html.replace(/\*(.+?)\*/g, (_match, text: string) => `<em>${this.escapeHtml(text)}</em>`);

    // Escape remaining raw text that wasn't handled by patterns above
    // We need to selectively escape only the parts not already turned into HTML tags
    html = this.escapeRemainingText(html);

    // Line breaks
    html = html.replace(/\n/g, '<br/>');

    // Sanitize output
    html = this.sanitize(html);

    return {
      html,
      sanitized: true,
      remoteResourcesBlocked: blockedResources,
    };
  }

  /**
   * Render a code block with language-specific syntax highlighting markers.
   */
  renderCode(options: CodeBlockOptions): RenderResult {
    const { language, content, sourceAttribution } = options;
    const escapedContent = this.escapeHtml(content);

    const attrStr = sourceAttribution
      ? ` data-source="${this.escapeAttr(sourceAttribution)}"`
      : '';

    const html = `<pre class="code-block" data-language="${this.escapeAttr(language)}"${attrStr}><code class="language-${this.escapeAttr(language)}">${escapedContent}</code></pre>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  /**
   * Render a mermaid diagram block.
   */
  renderMermaid(content: string): RenderResult {
    const escapedContent = this.escapeHtml(content);
    const html = `<div class="mermaid-container" role="img" aria-label="Mermaid diagram"><pre class="mermaid">${escapedContent}</pre></div>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  /**
   * Render a table from structured TableData.
   */
  renderTable(data: TableData): RenderResult {
    const headerCells = data.headers
      .map(h => `<th>${this.escapeHtml(h)}</th>`)
      .join('');
    const headerRow = `<thead><tr>${headerCells}</tr></thead>`;

    const bodyRows = data.rows
      .map(row => {
        const cells = row.map(cell => `<td>${this.escapeHtml(cell)}</td>`).join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    const tbody = `<tbody>${bodyRows}</tbody>`;

    const caption = data.caption
      ? `<caption>${this.escapeHtml(data.caption)}</caption>`
      : '';

    const html = `<table class="rich-table">${caption}${headerRow}${tbody}</table>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  /**
   * Render an interactive card.
   */
  renderInteractiveCard(card: InteractiveCard): RenderResult {
    const actionsHtml = card.actions
      ? card.actions
          .map(
            action =>
              `<button class="card-action card-action-${this.escapeAttr(action.kind)}" data-action-id="${this.escapeAttr(action.id)}"${action.disabled ? ' disabled' : ''}>${this.escapeHtml(action.label)}</button>`
          )
          .join('')
      : '';

    const html = `<div class="interactive-card interactive-card-${this.escapeAttr(card.kind)}" data-card-id="${this.escapeAttr(card.id)}" role="region" aria-label="${this.escapeAttr(card.title)}"><div class="card-title">${this.escapeHtml(card.title)}</div><div class="card-body">${this.escapeHtml(card.body)}</div>${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ''}</div>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  /**
   * Render a diff preview (before/after).
   */
  renderDiffPreview(diff: DiffPreview): RenderResult {
    const language = diff.language ?? 'plaintext';
    const beforeHtml = this.escapeHtml(diff.before);
    const afterHtml = this.escapeHtml(diff.after);

    const html = `<div class="diff-preview" data-target-uri="${this.escapeAttr(diff.targetUri)}" role="region" aria-label="Diff preview for ${this.escapeAttr(diff.targetUri)}"><div class="diff-before"><div class="diff-label">Before</div><pre class="code-block" data-language="${this.escapeAttr(language)}"><code>${beforeHtml}</code></pre></div><div class="diff-after"><div class="diff-label">After</div><pre class="code-block" data-language="${this.escapeAttr(language)}"><code>${afterHtml}</code></pre></div></div>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  /**
   * Render structured data (JSON) as a formatted display.
   */
  renderStructuredData(content: string): RenderResult {
    let formattedContent: string;
    try {
      const parsed = JSON.parse(content);
      formattedContent = JSON.stringify(parsed, null, 2);
    } catch {
      formattedContent = content;
    }

    const escapedContent = this.escapeHtml(formattedContent);
    const html = `<pre class="structured-data" data-type="json"><code>${escapedContent}</code></pre>`;

    return {
      html: this.sanitize(html),
      sanitized: true,
      remoteResourcesBlocked: [],
    };
  }

  // ─── Private helpers ──────────────────────────────────────────

  private renderTableFromContent(content: string): RenderResult {
    try {
      const data: TableData = JSON.parse(content);
      return this.renderTable(data);
    } catch {
      return this.renderMarkdown(content);
    }
  }

  private renderInteractiveCardFromContent(content: string): RenderResult {
    try {
      const card: InteractiveCard = JSON.parse(content);
      return this.renderInteractiveCard(card);
    } catch {
      return this.renderMarkdown(content);
    }
  }

  private renderDiffPreviewFromContent(content: string): RenderResult {
    try {
      const diff: DiffPreview = JSON.parse(content);
      return this.renderDiffPreview(diff);
    } catch {
      return this.renderMarkdown(content);
    }
  }

  /**
   * Sanitize HTML under CSP: remove script tags, event handlers, and unsafe-inline.
   */
  private sanitize(html: string): string {
    // Remove <script> tags entirely
    let sanitized = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Remove on* event handler attributes
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');

    // Remove javascript: URIs
    sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
    sanitized = sanitized.replace(/src\s*=\s*["']javascript:[^"']*["']/gi, 'src=""');

    // Remove data: URIs for scripts (keep for images when allowed)
    sanitized = sanitized.replace(/src\s*=\s*["']data:text\/html[^"']*["']/gi, 'src=""');

    // Remove inline style attributes if not allowed
    if (!this.cspPolicy.allowInlineStyles) {
      sanitized = sanitized.replace(/\s+style\s*=\s*["'][^"']*["']/gi, '');
    }

    // Remove <iframe> tags unless explicitly allowed sources are present
    if (this.cspPolicy.allowedFrameSources.length === 0) {
      sanitized = sanitized.replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '');
      sanitized = sanitized.replace(/<iframe\b[^>]*\/>/gi, '');
    }

    return sanitized;
  }

  /**
   * Escape remaining raw text segments that are not already wrapped in HTML tags.
   * This selectively escapes only content outside of already-processed HTML tags.
   */
  private escapeRemainingText(html: string): string {
    // Split on HTML tags and escape only the text parts
    return html.replace(/([^<>]+)(?=<|$)/g, (segment) => {
      // Don't re-escape content that's already entity-encoded
      if (segment.includes('&amp;') || segment.includes('&lt;') || segment.includes('&gt;') || segment.includes('&quot;')) {
        return segment;
      }
      // Escape raw <, >, & but leave already-encoded entities
      return segment
        .replace(/&(?!amp;|lt;|gt;|quot;|#x27;)/g, '&amp;')
        .replace(/<(?!\/?\w)/g, '&lt;')
        .replace(/(?<!\w)>/g, '&gt;');
    });
  }

  /**
   * Escape HTML special characters.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Escape a value for safe use in HTML attributes.
   */
  private escapeAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Determine if a URI is remote (http/https).
   */
  private isRemoteUri(uri: string): boolean {
    return uri.startsWith('http://') || uri.startsWith('https://');
  }
}
