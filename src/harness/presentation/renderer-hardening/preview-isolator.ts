/**
 * Preview Isolator — Determines isolation requirements for untrusted content.
 *
 * Risky previews (HTML content, embedded resources, data URIs, SVG, etc.)
 * are assigned appropriate isolation levels to prevent execution in
 * the renderer's trust boundary.
 *
 * Requirements: 9.9, 24.2–24.8, 37.9, 37.10
 */

import type { IsolationAssessment, IsolationLevel } from './types';

// ─── Content Risk Classification ────────────────────────────────

/**
 * Media types that require sandbox iframe isolation.
 */
const IFRAME_ISOLATED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/pdf',
]);

/**
 * Media types that should be rendered as text only (no interpretation).
 */
const TEXT_ONLY_MEDIA_TYPES = new Set([
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'text/x-script',
  'application/xml',
]);

/**
 * Media types that can use blob isolation (safe binary display).
 */
const BLOB_ISOLATED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

/**
 * Content patterns that elevate risk regardless of declared media type.
 */
const HIGH_RISK_CONTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /<svg[\s>]/i,
  /on\w+\s*=\s*["']/i,
  /javascript\s*:/i,
  /data:\s*text\/html/i,
];

// ─── Sandbox Flags ──────────────────────────────────────────────

/**
 * Standard sandbox flags for iframe isolation.
 * These prevent script execution, form submission, and navigation.
 */
const STRICT_SANDBOX_FLAGS: ReadonlyArray<string> = [
  'sandbox',                // Base sandbox (all restrictions)
  // Intentionally NOT added: allow-scripts, allow-same-origin, allow-forms
];

/**
 * CSP directives for isolated previews.
 */
const STRICT_CSP_DIRECTIVES: ReadonlyArray<string> = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "navigate-to 'none'",
];

/**
 * CSP directives for blob-isolated previews (images/media).
 */
const BLOB_CSP_DIRECTIVES: ReadonlyArray<string> = [
  "default-src 'none'",
  "img-src blob: data:",
  "media-src blob: data:",
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Assess the isolation requirements for rendering untrusted content.
 *
 * Evaluates the content's media type and actual content patterns to
 * determine the minimum safe isolation level.
 *
 * @param mediaType - Declared media type of the content
 * @param content - The actual content to analyze (may be partial/preview)
 * @returns Isolation assessment with level, reason, and policy directives
 */
export function assessIsolation(
  mediaType: string | undefined,
  content: string,
): IsolationAssessment {
  const normalizedType = mediaType?.toLowerCase().trim() ?? '';

  // Check content for high-risk patterns regardless of declared type
  if (contentContainsHighRiskPatterns(content)) {
    return {
      level: 'sandbox_iframe',
      reason: 'Content contains executable patterns regardless of declared type',
      sandboxFlags: [...STRICT_SANDBOX_FLAGS],
      cspDirectives: [...STRICT_CSP_DIRECTIVES],
    };
  }

  // Classify by media type
  if (IFRAME_ISOLATED_MEDIA_TYPES.has(normalizedType)) {
    return {
      level: 'sandbox_iframe',
      reason: `Media type ${normalizedType} requires iframe isolation`,
      sandboxFlags: [...STRICT_SANDBOX_FLAGS],
      cspDirectives: [...STRICT_CSP_DIRECTIVES],
    };
  }

  if (TEXT_ONLY_MEDIA_TYPES.has(normalizedType)) {
    return {
      level: 'text_only',
      reason: `Media type ${normalizedType} must be rendered as text only`,
    };
  }

  if (BLOB_ISOLATED_MEDIA_TYPES.has(normalizedType)) {
    return {
      level: 'blob_isolation',
      reason: `Media type ${normalizedType} uses blob isolation for display`,
      cspDirectives: [...BLOB_CSP_DIRECTIVES],
    };
  }

  // Plain text types with no markup are safe
  if (normalizedType.startsWith('text/plain') || normalizedType === '') {
    if (!containsAnyMarkup(content)) {
      return {
        level: 'none',
        reason: 'Plain text content with no markup detected',
      };
    }
    // Plain text that somehow contains markup — render as text only
    return {
      level: 'text_only',
      reason: 'Plain text content contains unexpected markup',
    };
  }

  // Unknown media type — default to text_only
  return {
    level: 'text_only',
    reason: `Unknown media type: ${normalizedType || 'unspecified'}`,
  };
}

/**
 * Check whether content contains high-risk executable patterns.
 */
function contentContainsHighRiskPatterns(content: string): boolean {
  for (const pattern of HIGH_RISK_CONTENT_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}

/**
 * Check whether content contains any HTML-like markup.
 */
function containsAnyMarkup(content: string): boolean {
  return /<[a-z/!][^>]*>/i.test(content);
}

/**
 * Get the sandbox attribute value for an iframe.
 * Returns an empty string (maximum restriction) for strictest isolation.
 */
export function getSandboxAttribute(assessment: IsolationAssessment): string {
  if (assessment.level !== 'sandbox_iframe') return '';
  // An empty sandbox attribute applies all restrictions
  return '';
}

/**
 * Get the Content-Security-Policy meta tag content for isolated previews.
 */
export function getCspMetaContent(assessment: IsolationAssessment): string | null {
  if (!assessment.cspDirectives || assessment.cspDirectives.length === 0) return null;
  return assessment.cspDirectives.join('; ');
}
