// @ts-nocheck
/**
 * Mermaid Renderer — in-process safe rendering for diagrams in chat, wiki,
 * architecture views, and Loop Engine debriefs.
 *
 * Features:
 * - In-process rendering (no subprocess spawning)
 * - Source text remains accessible and copyable
 * - Rendering failure preserves source block with diagnostic
 * - Untrusted content sanitized; arbitrary scripts blocked
 * - If sanitization cannot guarantee safety, rendering is blocked
 *
 * Requirements: 26.1, 26.2, 26.3, 26.4, 26.5
 */

// ─── Types ──────────────────────────────────────────────────────

// ─── Types (documentation only) ─────────────────────────────────
//
// MermaidRenderResult: { success, svg, source, error, blocked }
// MermaidRendererOptions: { maxSourceLength, theme, securityLevel }
//

// ─── Constants ──────────────────────────────────────────────────

var MERMAID_MAX_SOURCE = 50000;
var MERMAID_DANGEROUS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /on\w+\s*=/i,
  /data:\s*text\/html/i,
  /import\s*\(/,
  /require\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/,
  /document\./,
  /window\./,
  /location\./,
  /navigator\./,
];

// ─── Sanitization ───────────────────────────────────────────────

/**
 * Check if Mermaid source content is safe to render.
 * Returns null if safe, or a reason string if blocked.
 *
 * Requirement 26.5
 */
function checkSafety(source) {
  if (!source || typeof source !== 'string') return 'Empty or invalid source';
  if (source.length > MERMAID_MAX_SOURCE) return 'Source exceeds maximum length (' + MERMAID_MAX_SOURCE + ' chars)';

  for (var i = 0; i < MERMAID_DANGEROUS_PATTERNS.length; i++) {
    if (MERMAID_DANGEROUS_PATTERNS[i].test(source)) {
      return 'Potentially unsafe content detected (pattern: ' + MERMAID_DANGEROUS_PATTERNS[i].source + ')';
    }
  }

  return null; // safe
}

/**
 * Sanitize SVG output to remove dangerous attributes and elements.
 */
function sanitizeSvg(svg) {
  if (!svg) return '';
  // Remove script tags
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove event handlers
  svg = svg.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  // Remove javascript: URLs
  svg = svg.replace(/javascript:[^"']*/gi, '');
  return svg;
}

// ─── Renderer ───────────────────────────────────────────────────

/**
 * Render a Mermaid diagram from source text.
 * Uses in-process rendering via the mermaid library (no subprocess).
 *
 * Requirements 26.1, 26.2, 26.3, 26.4
 */
function renderMermaid(source, options) {
  var opts = options || {};
  var maxLen = opts.maxSourceLength || MERMAID_MAX_SOURCE;

  // Always preserve source
  var result = {
    success: false,
    svg: null,
    source: source || '',
    error: null,
    blocked: false,
  };

  // Safety check
  var safetyIssue = checkSafety(source);
  if (safetyIssue) {
    result.error = safetyIssue;
    result.blocked = true;
    return result;
  }

  // Check if mermaid library is available
  var mermaid = null;
  try {
    if (typeof window !== 'undefined' && window.mermaid) {
      mermaid = window.mermaid;
    } else {
      // Try require for non-browser environments
      mermaid = require('mermaid');
    }
  } catch (e) {
    // Mermaid not available — return with error but preserve source
    result.error = 'Mermaid library not available: ' + (e.message || 'load failed');
    return result;
  }

  if (!mermaid || typeof mermaid.render !== 'function') {
    result.error = 'Mermaid library loaded but render function not found';
    return result;
  }

  // Configure mermaid
  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: opts.theme || 'dark',
      securityLevel: opts.securityLevel || 'strict',
      suppressErrors: true,
    });
  } catch (e) {
    // Non-fatal — proceed with default config
  }

  // Render
  try {
    var id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var renderResult = mermaid.render(id, source);

    // mermaid.render may return a promise or a direct result depending on version
    if (renderResult && typeof renderResult.then === 'function') {
      // Async path — return a promise-like result
      result.error = 'Async rendering not supported in synchronous context; use renderMermaidAsync';
      return result;
    }

    var svg = typeof renderResult === 'string' ? renderResult : (renderResult && renderResult.svg) || '';
    if (svg) {
      result.svg = sanitizeSvg(svg);
      result.success = true;
    } else {
      result.error = 'Mermaid render returned empty output';
    }
  } catch (e) {
    result.error = 'Render failed: ' + (e.message || 'unknown error');
  }

  return result;
}

/**
 * Async render for environments where mermaid uses promises.
 */
async function renderMermaidAsync(source, options) {
  var opts = options || {};
  var result = {
    success: false,
    svg: null,
    source: source || '',
    error: null,
    blocked: false,
  };

  var safetyIssue = checkSafety(source);
  if (safetyIssue) {
    result.error = safetyIssue;
    result.blocked = true;
    return result;
  }

  var mermaid = null;
  try {
    if (typeof window !== 'undefined' && window.mermaid) {
      mermaid = window.mermaid;
    }
  } catch (e) {
    result.error = 'Mermaid not available';
    return result;
  }

  if (!mermaid) {
    result.error = 'Mermaid library not loaded';
    return result;
  }

  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: opts.theme || 'dark',
      securityLevel: 'strict',
    });

    var id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var renderResult = await mermaid.render(id, source);
    var svg = typeof renderResult === 'string' ? renderResult : (renderResult && renderResult.svg) || '';

    if (svg) {
      result.svg = sanitizeSvg(svg);
      result.success = true;
    } else {
      result.error = 'Mermaid render returned empty output';
    }
  } catch (e) {
    result.error = 'Render failed: ' + (e.message || 'unknown error');
  }

  return result;
}

// ─── Exports ───────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.renderMermaid = renderMermaid;
  window.renderMermaidAsync = renderMermaidAsync;
  window.checkMermaidSafety = checkSafety;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMermaid: renderMermaid, renderMermaidAsync: renderMermaidAsync, checkMermaidSafety: checkSafety, sanitizeSvg: sanitizeSvg };
}
