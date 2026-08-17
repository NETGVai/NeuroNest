/**
 * Enhanced Content Sanitizer for Renderer Hardening
 *
 * Provides deep sanitization of markup content including:
 * - HTML tag stripping (dangerous elements)
 * - Attribute sanitization (event handlers, expressions)
 * - Link protocol enforcement (only http/https allowed)
 * - Embedded content blocking (object, embed, applet, iframe without sandbox)
 * - Data URI restriction
 *
 * Requirements: 9.9, 24.2–24.8, 37.9–37.11
 */

import type { SanitizationFinding } from './types';

// ─── Dangerous HTML Elements ────────────────────────────────────

/**
 * HTML elements that must be completely removed (open + close + content between).
 */
const FORBIDDEN_ELEMENTS: ReadonlyArray<string> = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'template',
  'slot',
  'portal',
];

/**
 * HTML attributes that must be removed from any element.
 * Includes all event handlers and expression attributes.
 */
const FORBIDDEN_ATTRIBUTES: ReadonlyArray<RegExp> = [
  /^on\w+$/i,              // All event handlers (onclick, onerror, etc.)
  /^style$/i,              // Inline styles (can contain expressions)
  /^srcdoc$/i,             // iframe srcdoc
  /^data-bind/i,           // framework binding attributes
  /^ng-/i,                 // Angular directives
  /^v-/i,                  // Vue directives
  /^x-/i,                  // Alpine.js directives
  /^\{/,                   // JSX expression attributes
  /^formaction$/i,         // form action override
  /^action$/i,             // form action
  /^method$/i,             // form method
  /^enctype$/i,            // form encoding
  /^dynsrc$/i,             // IE dynamic source
  /^lowsrc$/i,             // IE low-res source
  /^background$/i,         // background attribute (can load resources)
];

/**
 * URL protocols allowed in href/src attributes.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Patterns considered dangerous in attribute values.
 */
const DANGEROUS_ATTR_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /data\s*:\s*application/i,
  /expression\s*\(/i,
  /-moz-binding/i,
  /behavior\s*:/i,
  /url\s*\(/i,
];

// ─── Markup Sanitizer ───────────────────────────────────────────

/**
 * Result of markup sanitization.
 */
export interface MarkupSanitizeResult {
  /** Sanitized markup content. */
  output: string;
  /** Whether content was modified. */
  modified: boolean;
  /** Detailed findings from sanitization. */
  findings: SanitizationFinding[];
}

/**
 * Sanitize markup content by removing dangerous elements, attributes,
 * and enforcing safe link protocols.
 *
 * This is a pure function that produces no side effects.
 */
export function sanitizeMarkup(input: string): MarkupSanitizeResult {
  const findings: SanitizationFinding[] = [];
  let output = input;
  let modified = false;

  // 1. Remove forbidden elements and their content
  for (const element of FORBIDDEN_ELEMENTS) {
    const openClose = new RegExp(
      `<${element}[^>]*>[\\s\\S]*?<\\/${element}>`,
      'gi',
    );
    const selfClosing = new RegExp(`<${element}[^>]*\\/?>`, 'gi');

    if (openClose.test(output)) {
      output = output.replace(openClose, '');
      modified = true;
      findings.push({
        severity: 'critical',
        category: 'forbidden_element',
        description: `Removed forbidden element: <${element}>`,
      });
    }

    if (selfClosing.test(output)) {
      output = output.replace(selfClosing, '');
      modified = true;
      findings.push({
        severity: 'critical',
        category: 'forbidden_element',
        description: `Removed forbidden self-closing element: <${element}>`,
      });
    }
  }

  // 2. Remove forbidden attributes from remaining elements
  output = output.replace(/<([a-z][a-z0-9]*)\s+([^>]*?)>/gi, (match, tag, attrs) => {
    let cleanAttrs = attrs;
    let attrModified = false;

    // Remove each forbidden attribute by matching attribute name then checking it
    // Parse attributes as name=value pairs and filter out forbidden ones
    cleanAttrs = cleanAttrs.replace(
      /\s*([a-z_][\w-]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      (attrMatch: string, attrName: string) => {
        const name = attrName.toLowerCase();
        for (const pattern of FORBIDDEN_ATTRIBUTES) {
          if (pattern.test(name)) {
            attrModified = true;
            return '';
          }
        }
        return attrMatch;
      },
    );

    // Check remaining attribute values for dangerous content
    cleanAttrs = cleanAttrs.replace(
      /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      (attrMatch: string, attrName: string, doubleVal: string, singleVal: string) => {
        const value = doubleVal ?? singleVal ?? '';
        for (const dangerous of DANGEROUS_ATTR_VALUE_PATTERNS) {
          if (dangerous.test(value)) {
            attrModified = true;
            findings.push({
              severity: 'critical',
              category: 'dangerous_attribute_value',
              description: `Removed dangerous attribute value in ${attrName}`,
            });
            return '';
          }
        }
        return attrMatch;
      },
    );

    if (attrModified) {
      modified = true;
      findings.push({
        severity: 'warning',
        category: 'forbidden_attribute',
        description: `Cleaned attributes on <${tag}>`,
      });
    }

    const trimmed = cleanAttrs.trim();
    return trimmed ? `<${tag} ${trimmed}>` : `<${tag}>`;
  });

  // 3. Sanitize link href and src attributes
  output = output.replace(
    /(href|src|action)\s*=\s*"([^"]*)"/gi,
    (match, attr, url) => {
      const sanitized = sanitizeLinkUrl(url);
      if (sanitized === null) {
        modified = true;
        findings.push({
          severity: 'warning',
          category: 'unsafe_link',
          description: `Removed unsafe ${attr} URL`,
        });
        return `${attr}="#"`;
      }
      if (sanitized !== url) {
        modified = true;
      }
      return `${attr}="${sanitized}"`;
    },
  );

  return { output, modified, findings };
}

/**
 * Sanitize a single URL for use in link/src attributes.
 * Returns null if the URL is not safe.
 */
export function sanitizeLinkUrl(url: string): string | null {
  if (!url) return null;

  const trimmed = url.trim();

  // Allow fragment-only and relative paths
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    // Check for javascript: or data: disguised in relative paths
    for (const pattern of DANGEROUS_ATTR_VALUE_PATTERNS) {
      if (pattern.test(trimmed)) return null;
    }
    return trimmed;
  }

  // Parse protocol
  try {
    const parsed = new URL(trimmed, 'https://placeholder.invalid');
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    // If we can't parse it, check if it contains dangerous patterns
    for (const pattern of DANGEROUS_ATTR_VALUE_PATTERNS) {
      if (pattern.test(trimmed)) return null;
    }
    return trimmed;
  }
}

/**
 * Check if a string contains any HTML markup that needs sanitization.
 */
export function containsMarkup(input: string): boolean {
  return /<[a-z][^>]*>/i.test(input);
}
