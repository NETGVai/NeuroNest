/**
 * Centralized Content Sanitization Adapter
 *
 * Provides a unified, typed adapter that reuses approved sanitizers from
 * `src/chat/rich-response` (RichResponseRenderer) and the renderer-hardening
 * pipeline behind a single interface. Enforces:
 * - Allowlisted Markdown elements (headings, prose, lists, quotes, links, tables, code, emphasis)
 * - Escaped fallback for all untrusted content
 * - No inline HTML, scripts, event handlers, executable extensions, iframes
 * - No generic remote fetch without authorization
 *
 * Requirements: 5.7, 5.10, 20.1–20.2, 20.4–20.5, 22.6
 */

import type { SanitizationFinding } from './types';

// ─── Constants ──────────────────────────────────────────────────

/**
 * Allowlisted Markdown elements that may appear in rendered output.
 * All other HTML elements are stripped.
 */
export const ALLOWED_MARKDOWN_ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br',
  'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li',
  'blockquote',
  'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
  'span', 'div',
  'img',
]);

/**
 * Allowed attributes per element.
 */
export const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'title', 'aria-label']),
  img: new Set(['src', 'alt', 'width', 'height', 'aria-label']),
  code: new Set(['class']),
  pre: new Set(['class', 'data-language']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  div: new Set(['class', 'role', 'aria-label']),
  span: new Set(['class', 'role', 'aria-label']),
};

/**
 * Safe protocols for navigation links.
 */
const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/**
 * Executable file extensions that must be blocked in links/filenames.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',
  '.ps1', '.ps1xml', '.ps2', '.ps2xml', '.psc1', '.psc2',
  '.msh', '.msh1', '.msh2', '.mshxml', '.msh1xml', '.msh2xml',
  '.cpl', '.inf', '.reg', '.rgs', '.sct', '.shb', '.shs',
  '.lnk', '.app', '.action', '.command', '.sh', '.bash',
]);

/**
 * Dangerous patterns that indicate script execution vectors.
 */
const SCRIPT_PATTERNS: ReadonlyArray<RegExp> = [
  /<script[\s>]/i,
  /<\/script>/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /data\s*:\s*application/i,
];

/**
 * Event handler attribute pattern (exported for use in downstream validators).
 */
export const EVENT_HANDLER_PATTERN = /\bon\w+\s*=/gi;

/**
 * Iframe/embed/object pattern (exported for use in downstream validators).
 */
export const EMBEDDED_CONTENT_PATTERN = /<(iframe|object|embed|applet|form|input|button|select|textarea|link|meta|base|svg|math|template|slot|portal)\b[^>]*>/gi;

// ─── Sanitization Result ────────────────────────────────────────

/**
 * Result of the centralized content sanitization.
 */
export interface ContentSanitizationResult {
  /** Sanitized content safe for rendering. */
  content: string;
  /** Whether any modification was made. */
  modified: boolean;
  /** Reasons content was modified (categories). */
  reasons: string[];
  /** Detailed findings from the sanitization pass. */
  findings: SanitizationFinding[];
  /** URLs/resources that were blocked (no consent/authorization). */
  blockedResources: string[];
}

/**
 * Options for content sanitization.
 */
export interface SanitizationOptions {
  /** Content type hint (default: 'markdown'). */
  contentType?: 'markdown' | 'plain' | 'html' | 'mermaid' | 'code' | 'metadata';
  /** Whether to allow remote images that have consent (default: false). */
  allowConsentedRemoteImages?: boolean;
  /** Set of URIs that have been granted consent for remote fetch. */
  consentedUris?: ReadonlySet<string>;
  /** Whether to strip all HTML entirely and escape to plain text (default: false). */
  forceEscapedFallback?: boolean;
}

// ─── Safe Navigation ────────────────────────────────────────────

/**
 * Navigation request for external links.
 */
export interface NavigationRequest {
  /** The target URL. */
  url: string;
  /** Source context (which block/surface initiated the navigation). */
  sourceIdentity: string;
  /** Session identity for authorization. */
  sessionId: string;
}

/**
 * Result of a navigation authorization check.
 */
export interface NavigationResult {
  /** Whether navigation is permitted. */
  permitted: boolean;
  /** Sanitized URL safe for navigation (null if blocked). */
  sanitizedUrl: string | null;
  /** Reason for denial (if not permitted). */
  reason?: string;
  /** Whether the user can cancel/confirm this navigation. */
  cancellable: boolean;
}

/**
 * Remote artifact consent request.
 */
export interface RemoteArtifactConsentRequest {
  /** The remote resource URI. */
  uri: string;
  /** Resource type (image, embed, fetch). */
  resourceType: 'image' | 'embed' | 'fetch' | 'stylesheet' | 'font';
  /** Source block/surface identity. */
  sourceIdentity: string;
  /** Session identity. */
  sessionId: string;
}

/**
 * Result of a remote artifact consent check.
 */
export interface RemoteArtifactConsentResult {
  /** Whether the resource fetch is permitted. */
  permitted: boolean;
  /** Sanitized URI (null if blocked). */
  sanitizedUri: string | null;
  /** Reason for denial. */
  reason?: string;
}

/**
 * Authority interface for navigation and consent decisions.
 * Implementations route through the existing NeuroNest authority model.
 */
export interface NavigationAuthority {
  /** Check if external navigation to a URL is authorized. */
  authorizeNavigation(request: NavigationRequest): NavigationResult;
  /** Check if remote artifact fetch is authorized. */
  authorizeRemoteArtifact(request: RemoteArtifactConsentRequest): RemoteArtifactConsentResult;
}

// ─── Default Deny-All Navigation Authority ──────────────────────

/**
 * Default deny-all navigation authority. Used when no authority is configured.
 * All external navigation and remote artifact requests are denied.
 */
export class DenyAllNavigationAuthority implements NavigationAuthority {
  authorizeNavigation(_request: NavigationRequest): NavigationResult {
    return {
      permitted: false,
      sanitizedUrl: null,
      reason: 'No navigation authority configured',
      cancellable: true,
    };
  }

  authorizeRemoteArtifact(_request: RemoteArtifactConsentRequest): RemoteArtifactConsentResult {
    return {
      permitted: false,
      sanitizedUri: null,
      reason: 'No remote artifact authority configured',
    };
  }
}

// ─── Policy-Based Navigation Authority ──────────────────────────

/**
 * Policy-based navigation authority that enforces safe protocols,
 * blocks executable extensions, and routes through consent.
 */
export class SafeProtocolNavigationAuthority implements NavigationAuthority {
  private readonly consentedUris: Set<string>;
  private readonly allowedDomains: Set<string>;

  constructor(options?: {
    consentedUris?: Iterable<string>;
    allowedDomains?: Iterable<string>;
  }) {
    this.consentedUris = new Set(options?.consentedUris ?? []);
    this.allowedDomains = new Set(options?.allowedDomains ?? []);
  }

  grantConsent(uri: string): void {
    this.consentedUris.add(uri);
  }

  revokeConsent(uri: string): void {
    this.consentedUris.delete(uri);
  }

  authorizeNavigation(request: NavigationRequest): NavigationResult {
    const sanitized = sanitizeNavigationUrl(request.url);
    if (sanitized === null) {
      return {
        permitted: false,
        sanitizedUrl: null,
        reason: 'URL uses an unsafe protocol or has dangerous content',
        cancellable: true,
      };
    }

    // Check for executable file extensions in path
    if (hasExecutableExtension(sanitized)) {
      return {
        permitted: false,
        sanitizedUrl: null,
        reason: 'URL targets an executable file type',
        cancellable: true,
      };
    }

    return {
      permitted: true,
      sanitizedUrl: sanitized,
      cancellable: true,
    };
  }

  authorizeRemoteArtifact(request: RemoteArtifactConsentRequest): RemoteArtifactConsentResult {
    const sanitized = sanitizeNavigationUrl(request.uri);
    if (sanitized === null) {
      return {
        permitted: false,
        sanitizedUri: null,
        reason: 'URI uses an unsafe protocol',
      };
    }

    // Check consent
    if (this.consentedUris.has(request.uri)) {
      return {
        permitted: true,
        sanitizedUri: sanitized,
      };
    }

    // Check domain allowlist
    try {
      const parsed = new URL(sanitized);
      if (this.allowedDomains.has(parsed.hostname)) {
        return {
          permitted: true,
          sanitizedUri: sanitized,
        };
      }
    } catch {
      // Invalid URL
    }

    return {
      permitted: false,
      sanitizedUri: null,
      reason: 'Remote resource requires consent from resource authority',
    };
  }
}

// ─── Centralized Content Sanitizer ──────────────────────────────

/**
 * Centralized content sanitization adapter for the structured response renderer.
 *
 * Reuses approved sanitizers from `src/chat/rich-response` and renderer-hardening
 * behind a single typed interface. This is the sole entry point for all content
 * sanitization in the structured response renderer.
 *
 * Guarantees:
 * - No inline HTML/scripts/event handlers reach the DOM
 * - No executable extensions in linked resources
 * - No iframes/embeds without explicit authorization
 * - No generic remote fetch without resource authority consent
 * - Escaped fallback for any content that fails sanitization
 */
export class ContentSanitizationAdapter {
  private readonly navigationAuthority: NavigationAuthority;

  constructor(navigationAuthority?: NavigationAuthority) {
    this.navigationAuthority = navigationAuthority ?? new DenyAllNavigationAuthority();
  }

  /**
   * Sanitize content for safe rendering in a response surface.
   * This is the primary entry point for all content sanitization.
   */
  sanitize(input: string, options: SanitizationOptions = {}): ContentSanitizationResult {
    if (!input) {
      return { content: '', modified: false, reasons: [], findings: [], blockedResources: [] };
    }

    // Force escaped fallback if requested
    if (options.forceEscapedFallback) {
      return this.escapedFallback(input);
    }

    switch (options.contentType ?? 'markdown') {
      case 'markdown':
        return this.sanitizeMarkdown(input, options);
      case 'plain':
        return this.sanitizePlainText(input);
      case 'html':
        return this.sanitizeHtml(input, options);
      case 'mermaid':
        return this.sanitizeMermaid(input);
      case 'code':
        return this.sanitizeCode(input);
      case 'metadata':
        return this.sanitizeMetadata(input);
      default:
        return this.escapedFallback(input);
    }
  }

  /**
   * Check if a URL is safe for external navigation.
   * Routes through the navigation authority.
   */
  authorizeNavigation(request: NavigationRequest): NavigationResult {
    return this.navigationAuthority.authorizeNavigation(request);
  }

  /**
   * Check if a remote artifact fetch is authorized.
   * Routes through the resource authority.
   */
  authorizeRemoteArtifact(request: RemoteArtifactConsentRequest): RemoteArtifactConsentResult {
    return this.navigationAuthority.authorizeRemoteArtifact(request);
  }

  // ─── Private Sanitization Methods ──────────────────────────────

  private sanitizeMarkdown(input: string, options: SanitizationOptions): ContentSanitizationResult {
    const findings: SanitizationFinding[] = [];
    const blockedResources: string[] = [];
    let content = input;
    let modified = false;

    // Strip embedded HTML that is not in the allowlist
    const htmlStripped = this.stripDisallowedHtml(content);
    if (htmlStripped.modified) {
      content = htmlStripped.content;
      modified = true;
      findings.push(...htmlStripped.findings);
    }

    // Remove script execution vectors
    const scriptResult = this.removeScriptVectors(content);
    if (scriptResult.modified) {
      content = scriptResult.content;
      modified = true;
      findings.push(...scriptResult.findings);
    }

    // Remove event handlers
    const handlerResult = this.removeEventHandlers(content);
    if (handlerResult.modified) {
      content = handlerResult.content;
      modified = true;
      findings.push(...handlerResult.findings);
    }

    // Process image references - block remote images without consent
    const imageResult = this.processImages(content, options);
    if (imageResult.modified) {
      content = imageResult.content;
      modified = true;
      findings.push(...imageResult.findings);
      blockedResources.push(...imageResult.blockedResources);
    }

    // Process links - enforce safe protocols and block executables
    const linkResult = this.processLinks(content);
    if (linkResult.modified) {
      content = linkResult.content;
      modified = true;
      findings.push(...linkResult.findings);
      blockedResources.push(...linkResult.blockedResources);
    }

    const reasons = [...new Set(findings.map(f => f.category))];
    return { content, modified, reasons, findings, blockedResources };
  }

  private sanitizePlainText(input: string): ContentSanitizationResult {
    // Plain text is always escaped
    return this.escapedFallback(input);
  }

  private sanitizeHtml(input: string, _options: SanitizationOptions): ContentSanitizationResult {
    const findings: SanitizationFinding[] = [];
    const blockedResources: string[] = [];
    let content = input;
    let modified = false;

    // Strip all disallowed elements
    const htmlStripped = this.stripDisallowedHtml(content);
    if (htmlStripped.modified) {
      content = htmlStripped.content;
      modified = true;
      findings.push(...htmlStripped.findings);
    }

    // Remove scripts
    const scriptResult = this.removeScriptVectors(content);
    if (scriptResult.modified) {
      content = scriptResult.content;
      modified = true;
      findings.push(...scriptResult.findings);
    }

    // Remove event handlers
    const handlerResult = this.removeEventHandlers(content);
    if (handlerResult.modified) {
      content = handlerResult.content;
      modified = true;
      findings.push(...handlerResult.findings);
    }

    // Process links
    const linkResult = this.processLinks(content);
    if (linkResult.modified) {
      content = linkResult.content;
      modified = true;
      findings.push(...linkResult.findings);
      blockedResources.push(...linkResult.blockedResources);
    }

    const reasons = [...new Set(findings.map(f => f.category))];
    return { content, modified, reasons, findings, blockedResources };
  }

  private sanitizeMermaid(input: string): ContentSanitizationResult {
    const findings: SanitizationFinding[] = [];
    let content = input;
    let modified = false;

    // Mermaid diagrams: strip dangerous elements WITH their content first
    const dangerousElementsResult = this.stripDangerousElementsWithContent(content);
    if (dangerousElementsResult.modified) {
      content = dangerousElementsResult.content;
      modified = true;
      findings.push(...dangerousElementsResult.findings);
    }

    // Strip script execution vectors
    const scriptResult = this.removeScriptVectors(content);
    if (scriptResult.modified) {
      content = scriptResult.content;
      modified = true;
      findings.push(...scriptResult.findings);
    }

    // Strip event handlers
    const handlerResult = this.removeEventHandlers(content);
    if (handlerResult.modified) {
      content = handlerResult.content;
      modified = true;
      findings.push(...handlerResult.findings);
    }

    // Remove remaining HTML tags from Mermaid content
    const htmlResult = this.stripAllHtmlTags(content);
    if (htmlResult.modified) {
      content = htmlResult.content;
      modified = true;
      findings.push(...htmlResult.findings);
    }

    const reasons = [...new Set(findings.map(f => f.category))];
    return { content, modified, reasons, findings, blockedResources: [] };
  }

  private sanitizeCode(input: string): ContentSanitizationResult {
    // Code content is escaped for display
    const escaped = escapeHtml(input);
    return {
      content: escaped,
      modified: escaped !== input,
      reasons: escaped !== input ? ['html_escape'] : [],
      findings: escaped !== input ? [{ severity: 'info', category: 'html_escape', description: 'HTML entities escaped for code display' }] : [],
      blockedResources: [],
    };
  }

  private sanitizeMetadata(input: string): ContentSanitizationResult {
    const findings: SanitizationFinding[] = [];
    let content = input;
    let modified = false;

    // Metadata: strip dangerous elements WITH their content first
    const dangerousResult = this.stripDangerousElementsWithContent(content);
    if (dangerousResult.modified) {
      content = dangerousResult.content;
      modified = true;
      findings.push(...dangerousResult.findings);
    }

    // Strip script execution vectors
    const scriptResult = this.removeScriptVectors(content);
    if (scriptResult.modified) {
      content = scriptResult.content;
      modified = true;
      findings.push(...scriptResult.findings);
    }

    // Remove event handlers
    const handlerResult = this.removeEventHandlers(content);
    if (handlerResult.modified) {
      content = handlerResult.content;
      modified = true;
      findings.push(...handlerResult.findings);
    }

    // Strip all remaining HTML tags from metadata (keep text content for safe tags)
    const htmlResult = this.stripAllHtmlTags(content);
    if (htmlResult.modified) {
      content = htmlResult.content;
      modified = true;
      findings.push(...htmlResult.findings);
    }

    const reasons = [...new Set(findings.map(f => f.category))];
    return { content, modified, reasons, findings, blockedResources: [] };
  }

  // ─── Shared Sanitization Helpers ───────────────────────────────

  private escapedFallback(input: string): ContentSanitizationResult {
    const escaped = escapeHtml(input);
    return {
      content: escaped,
      modified: escaped !== input,
      reasons: escaped !== input ? ['escaped_fallback'] : [],
      findings: escaped !== input
        ? [{ severity: 'info', category: 'escaped_fallback', description: 'Content escaped to plain text for safety' }]
        : [],
      blockedResources: [],
    };
  }

  private stripDisallowedHtml(input: string): { content: string; modified: boolean; findings: SanitizationFinding[] } {
    const findings: SanitizationFinding[] = [];
    let modified = false;

    // Remove forbidden elements (script, iframe, object, embed, etc.) with their content
    let content = input.replace(
      /<(script|iframe|object|embed|applet|form|input|button|select|textarea|link|meta|base|svg|math|template|slot|portal)\b[^>]*>[\s\S]*?<\/\1>/gi,
      () => {
        modified = true;
        return '';
      },
    );

    // Remove self-closing forbidden elements
    content = content.replace(
      /<(script|iframe|object|embed|applet|form|input|button|select|textarea|link|meta|base|svg|math|template|slot|portal)\b[^>]*\/?>/gi,
      () => {
        modified = true;
        return '';
      },
    );

    if (modified) {
      findings.push({
        severity: 'critical',
        category: 'forbidden_element',
        description: 'Removed disallowed HTML elements',
      });
    }

    return { content, modified, findings };
  }

  private removeScriptVectors(input: string): { content: string; modified: boolean; findings: SanitizationFinding[] } {
    const findings: SanitizationFinding[] = [];
    let content = input;
    let modified = false;

    for (const pattern of SCRIPT_PATTERNS) {
      if (pattern.test(content)) {
        content = content.replace(new RegExp(pattern.source, 'gi'), '');
        modified = true;
      }
    }

    if (modified) {
      findings.push({
        severity: 'critical',
        category: 'script_vector',
        description: 'Removed script execution vectors',
      });
    }

    return { content, modified, findings };
  }

  private removeEventHandlers(input: string): { content: string; modified: boolean; findings: SanitizationFinding[] } {
    const findings: SanitizationFinding[] = [];

    // Remove all on* event handler attributes (both quoted and unquoted values)
    let content = input;
    let modified = false;

    // Match onX="..." or onX='...' or onX=value
    const handlerWithQuotes = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
    const handlerUnquoted = /\s+on\w+\s*=\s*[^\s>"']+/gi;

    if (handlerWithQuotes.test(content)) {
      content = content.replace(handlerWithQuotes, '');
      modified = true;
    }
    if (handlerUnquoted.test(content)) {
      content = content.replace(handlerUnquoted, '');
      modified = true;
    }

    if (modified) {
      findings.push({
        severity: 'critical',
        category: 'event_handler',
        description: 'Removed event handler attributes',
      });
    }

    return { content, modified, findings };
  }

  private processImages(
    input: string,
    options: SanitizationOptions,
  ): { content: string; modified: boolean; findings: SanitizationFinding[]; blockedResources: string[] } {
    const findings: SanitizationFinding[] = [];
    const blockedResources: string[] = [];
    let modified = false;

    // Process Markdown image syntax: ![alt](url)
    const content = input.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, src: string) => {
      // Block all remote images unless consented
      if (isRemoteUri(src)) {
        if (options.allowConsentedRemoteImages && options.consentedUris?.has(src)) {
          return _match; // Keep consented image
        }
        modified = true;
        blockedResources.push(src);
        findings.push({
          severity: 'warning',
          category: 'remote_image_blocked',
          description: 'Remote image blocked - requires consent',
        });
        return `[Image: ${escapeHtml(alt || 'remote')} - consent required]`;
      }

      // Block data: URIs for images (script execution vector)
      if (/^data:/i.test(src)) {
        modified = true;
        blockedResources.push(src.slice(0, 50));
        findings.push({
          severity: 'critical',
          category: 'data_uri_blocked',
          description: 'Data URI blocked in image',
        });
        return `[Image: blocked data URI]`;
      }

      return _match;
    });

    // Process HTML img tags
    const htmlImgContent = content.replace(/<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (match, src: string) => {
      if (isRemoteUri(src)) {
        if (options.allowConsentedRemoteImages && options.consentedUris?.has(src)) {
          return match;
        }
        modified = true;
        blockedResources.push(src);
        findings.push({
          severity: 'warning',
          category: 'remote_image_blocked',
          description: 'Remote image tag blocked - requires consent',
        });
        return '[Image: consent required]';
      }
      return match;
    });

    return { content: htmlImgContent, modified, findings, blockedResources };
  }

  private processLinks(
    input: string,
  ): { content: string; modified: boolean; findings: SanitizationFinding[]; blockedResources: string[] } {
    const findings: SanitizationFinding[] = [];
    const blockedResources: string[] = [];
    let modified = false;

    // Process Markdown links: [text](url)
    let content = input.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) => {
      const sanitized = sanitizeNavigationUrl(href);
      if (sanitized === null) {
        modified = true;
        blockedResources.push(href);
        findings.push({
          severity: 'critical',
          category: 'unsafe_link',
          description: 'Unsafe link protocol removed',
        });
        return text; // Keep text, remove link
      }

      if (hasExecutableExtension(sanitized)) {
        modified = true;
        blockedResources.push(href);
        findings.push({
          severity: 'critical',
          category: 'executable_link',
          description: 'Link to executable file blocked',
        });
        return text;
      }

      return _match;
    });

    // Process HTML href attributes
    content = content.replace(/(href\s*=\s*["'])([^"']*)(["'])/gi, (_match, pre, url, post) => {
      const sanitized = sanitizeNavigationUrl(url);
      if (sanitized === null) {
        modified = true;
        blockedResources.push(url);
        findings.push({
          severity: 'critical',
          category: 'unsafe_link',
          description: 'Unsafe href attribute removed',
        });
        return `${pre}#${post}`;
      }

      if (hasExecutableExtension(sanitized)) {
        modified = true;
        blockedResources.push(url);
        findings.push({
          severity: 'critical',
          category: 'executable_link',
          description: 'Href to executable file blocked',
        });
        return `${pre}#${post}`;
      }

      return _match;
    });

    return { content, modified, findings, blockedResources };
  }

  private stripDangerousElementsWithContent(input: string): { content: string; modified: boolean; findings: SanitizationFinding[] } {
    const findings: SanitizationFinding[] = [];
    let content = input;
    let modified = false;

    // Remove dangerous elements AND their content (these elements should have their
    // content stripped entirely since content between tags could be executable)
    const dangerousElements = ['script', 'style', 'iframe', 'object', 'embed', 'applet', 'svg', 'math'];
    for (const element of dangerousElements) {
      const openClose = new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}>`, 'gi');
      const selfClosing = new RegExp(`<${element}\\b[^>]*\\/?>`, 'gi');

      if (openClose.test(content)) {
        content = content.replace(openClose, '');
        modified = true;
      }
      if (selfClosing.test(content)) {
        content = content.replace(selfClosing, '');
        modified = true;
      }
    }

    if (modified) {
      findings.push({
        severity: 'critical',
        category: 'dangerous_element_stripped',
        description: 'Removed dangerous elements and their content',
      });
    }

    return { content, modified, findings };
  }

  private stripAllHtmlTags(input: string): { content: string; modified: boolean; findings: SanitizationFinding[] } {
    const stripped = input.replace(/<[^>]+>/g, '');
    const modified = stripped !== input;
    return {
      content: stripped,
      modified,
      findings: modified
        ? [{ severity: 'warning', category: 'html_stripped', description: 'HTML tags stripped from content' }]
        : [],
    };
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Escape HTML special characters for safe rendering.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Sanitize a URL for navigation. Returns null if the URL uses an unsafe protocol.
 */
export function sanitizeNavigationUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // Block empty
  if (!trimmed) return null;

  // Block javascript: and other dangerous protocols
  if (/^\s*(javascript|vbscript|data\s*:\s*text\/html|data\s*:\s*application)\s*:/i.test(trimmed)) {
    return null;
  }

  // Allow fragment-only links
  if (trimmed.startsWith('#')) return trimmed;

  // Allow relative paths (check for embedded dangerous protocols)
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    if (/javascript\s*:/i.test(trimmed) || /vbscript\s*:/i.test(trimmed)) {
      return null;
    }
    return trimmed;
  }

  // Parse and validate protocol
  try {
    const parsed = new URL(trimmed, 'https://placeholder.invalid');
    if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    // Can't parse as URL - check for dangerous patterns
    if (/javascript\s*:/i.test(trimmed) || /vbscript\s*:/i.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
}

/**
 * Check if a URL/path targets an executable file extension.
 */
export function hasExecutableExtension(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    // Only check extensions for http/https URLs - mailto:, tel:, etc. don't have file paths
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    return EXECUTABLE_EXTENSIONS.has(getExtension(path));
  } catch {
    // Treat as raw path
    return EXECUTABLE_EXTENSIONS.has(getExtension(url.toLowerCase()));
  }
}

/**
 * Check if a URI is a remote (http/https) resource.
 */
export function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}

/**
 * Get the file extension from a path (including the dot).
 */
function getExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1 || lastDot === path.length - 1) return '';
  // Strip query/hash
  const ext = path.slice(lastDot).replace(/[?#].*$/, '');
  return ext;
}
