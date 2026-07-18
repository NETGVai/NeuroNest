// @ts-nocheck
/**
 * Chat Enhancements — Rich message rendering pipeline.
 *
 * Enhances chat messages with:
 * - Tool call results as collapsible cards
 * - File diffs with green/red line coloring
 * - Mermaid diagram rendering
 * - Image inline rendering with click-to-expand
 * - Long message truncation ("Show more")
 *
 * Requirements: 17.1-17.8
 *
 * Depends on: markdown-it (window.markdownit), hljs (window.hljs),
 *             mermaid-renderer (window.renderMermaid / window.renderMermaidAsync)
 */

/* ─── Constants ──────────────────────────────────────────────── */

var CHAT_ENHANCE_MAX_LINES = 500;
var _ceUniqueId = 0;

function _ceNextId(prefix) {
  return (prefix || 'ce') + '-' + (++_ceUniqueId) + '-' + Date.now().toString(36);
}

/* ─── Styles (injected once) ─────────────────────────────────── */

function _ceInjectStyles() {
  if (document.getElementById('chat-enhancements-css')) return;
  var style = document.createElement('style');
  style.id = 'chat-enhancements-css';
  style.textContent = [
    /* Tool call result cards */
    '.ce-tool-card {',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  margin: 8px 0;',
    '  background: var(--surface-container-high);',
    '  overflow: hidden;',
    '  transition: border-color var(--motion-quick);',
    '}',
    '.ce-tool-card:hover { border-color: var(--accent); }',
    '.ce-tool-header {',
    '  display: flex; align-items: center; gap: 8px;',
    '  padding: 8px 12px; cursor: pointer; user-select: none;',
    '  font-size: 12px; font-weight: 600; color: var(--text-primary);',
    '  background: var(--surface-container);',
    '}',
    '.ce-tool-header:hover { background: var(--surface-hover); }',
    '.ce-tool-arrow { font-size: 10px; transition: transform var(--motion-quick); }',
    '.ce-tool-arrow.open { transform: rotate(90deg); }',
    '.ce-tool-name { color: var(--accent); font-family: "SF Mono", Menlo, monospace; }',
    '.ce-tool-body {',
    '  display: none; padding: 10px 12px; border-top: 1px solid var(--border-color);',
    '  font-size: 12px; line-height: 1.5;',
    '}',
    '.ce-tool-body.open { display: block; }',
    '.ce-tool-section-label {',
    '  font-size: 10px; font-weight: 700; text-transform: uppercase;',
    '  letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 4px;',
    '}',
    '.ce-tool-args, .ce-tool-output {',
    '  background: var(--bg-input); border-radius: var(--radius-xs);',
    '  padding: 8px 10px; font-family: "SF Mono", Menlo, monospace;',
    '  font-size: 11px; color: var(--text-secondary); white-space: pre-wrap;',
    '  word-break: break-all; max-height: 200px; overflow-y: auto; margin-bottom: 8px;',
    '}',
  ].join('\n') + '\n' + [
    /* Diff rendering */
    '.ce-diff {',
    '  border: 1px solid var(--border-color); border-radius: var(--radius-sm);',
    '  margin: 8px 0; overflow: hidden; font-family: "SF Mono", Menlo, monospace;',
    '  font-size: 12px; line-height: 1.6;',
    '}',
    '.ce-diff-header {',
    '  padding: 6px 12px; background: var(--surface-container);',
    '  font-size: 11px; font-weight: 600; color: var(--text-secondary);',
    '  border-bottom: 1px solid var(--border-color);',
    '}',
    '.ce-diff-line { padding: 0 12px; white-space: pre-wrap; word-break: break-all; }',
    '.ce-diff-add { background: rgba(74, 222, 128, 0.1); color: var(--green); }',
    '.ce-diff-remove { background: rgba(248, 113, 113, 0.1); color: var(--red); }',
    '.ce-diff-context { color: var(--text-secondary); }',
    '.ce-diff-hunk { color: var(--accent); font-style: italic; padding: 4px 12px; background: var(--surface-container); }',
  ].join('\n') + '\n' + [
    /* Mermaid */
    '.ce-mermaid-container {',
    '  margin: 8px 0; border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm); overflow: hidden;',
    '  background: var(--surface-container-high); padding: 16px; text-align: center;',
    '}',
    '.ce-mermaid-error {',
    '  font-size: 11px; color: var(--red); padding: 8px;',
    '  background: var(--red-container); border-radius: var(--radius-xs);',
    '}',
    '.ce-mermaid-source {',
    '  margin-top: 8px; font-size: 11px; color: var(--text-dim);',
    '  text-align: left; cursor: pointer;',
    '}',
  ].join('\n') + '\n' + [
    /* Image rendering */
    '.ce-image-inline {',
    '  max-width: 100%; max-height: 300px; border-radius: var(--radius-sm);',
    '  margin: 8px 0; cursor: pointer; transition: transform var(--motion-quick);',
    '  border: 1px solid var(--border-color);',
    '}',
    '.ce-image-inline:hover { transform: scale(1.02); border-color: var(--accent); }',
    '.ce-image-overlay {',
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  background: rgba(0,0,0,0.85); z-index: 10000;',
    '  display: flex; align-items: center; justify-content: center;',
    '  cursor: zoom-out;',
    '}',
    '.ce-image-overlay img {',
    '  max-width: 90vw; max-height: 90vh; border-radius: var(--radius);',
    '  box-shadow: 0 12px 48px rgba(0,0,0,0.5);',
    '}',
  ].join('\n') + '\n' + [
    /* Show more truncation */
    '.ce-truncated-fade {',
    '  position: relative; max-height: 600px; overflow: hidden;',
    '}',
    '.ce-truncated-fade::after {',
    '  content: ""; position: absolute; bottom: 0; left: 0; right: 0;',
    '  height: 80px; background: linear-gradient(transparent, var(--bg-primary));',
    '  pointer-events: none;',
    '}',
    '.ce-show-more-btn {',
    '  display: block; width: 100%; padding: 8px 0; margin-top: 4px;',
    '  background: var(--surface-container); border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-xs); color: var(--accent);',
    '  font-size: 12px; font-weight: 600; cursor: pointer; text-align: center;',
    '  transition: all var(--motion-quick);',
    '}',
    '.ce-show-more-btn:hover { background: var(--accent-container); border-color: var(--accent); }',
    /* Inline code override */
    '.message-body code:not(pre code) {',
    '  font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;',
    '  background: var(--surface-container-highest); padding: 2px 6px;',
    '  border-radius: 4px; font-size: 12px;',
    '}',
  ].join('\n');
  document.head.appendChild(style);
}

/* ─── Tool Call Card Rendering ───────────────────────────────── */

/**
 * Render a tool call result as a collapsible card.
 * @param {string} toolName - Name of the tool
 * @param {object|string} args - Tool arguments
 * @param {string} output - Tool output/result
 * @returns {string} HTML string
 */
function ceRenderToolCard(toolName, args, output) {
  var id = _ceNextId('tool');
  var argsStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  var outputStr = output || '(no output)';

  // Escape HTML in args/output
  var escArgs = _ceEsc(argsStr);
  var escOutput = _ceEsc(outputStr);

  return '<div class="ce-tool-card">' +
    '<div class="ce-tool-header" onclick="ceToggleToolCard(\'' + id + '\')">' +
    '<span class="ce-tool-arrow" id="' + id + '-arrow">\u25B6</span>' +
    '<span>\uD83D\uDD27</span>' +
    '<span class="ce-tool-name">' + _ceEsc(toolName) + '</span>' +
    '</div>' +
    '<div class="ce-tool-body" id="' + id + '-body">' +
    '<div class="ce-tool-section-label">Arguments</div>' +
    '<div class="ce-tool-args">' + escArgs + '</div>' +
    '<div class="ce-tool-section-label">Output</div>' +
    '<div class="ce-tool-output">' + escOutput + '</div>' +
    '</div></div>';
}

function ceToggleToolCard(id) {
  var body = document.getElementById(id + '-body');
  var arrow = document.getElementById(id + '-arrow');
  if (!body || !arrow) return;
  var isOpen = body.classList.contains('open');
  if (isOpen) {
    body.classList.remove('open');
    arrow.classList.remove('open');
  } else {
    body.classList.add('open');
    arrow.classList.add('open');
  }
}

/* ─── Diff Rendering ─────────────────────────────────────────── */

/**
 * Render a unified diff with green/red line coloring.
 * @param {string} diffText - Unified diff string
 * @param {string} [fileName] - Optional file name for the header
 * @returns {string} HTML string
 */
function ceRenderDiff(diffText, fileName) {
  var lines = diffText.split('\n');
  var htmlLines = [];
  var headerName = fileName || '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var cls = 'ce-diff-context';
    if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) {
      if (!headerName && line.length > 4) {
        headerName = line.substring(4).replace(/^[ab]\//, '');
      }
      continue;
    } else if (line.indexOf('@@') === 0) {
      cls = 'ce-diff-hunk';
    } else if (line.indexOf('+') === 0) {
      cls = 'ce-diff-add';
    } else if (line.indexOf('-') === 0) {
      cls = 'ce-diff-remove';
    }
    htmlLines.push('<div class="ce-diff-line ' + cls + '">' + _ceEsc(line) + '</div>');
  }

  var header = headerName ? '<div class="ce-diff-header">\uD83D\uDCC4 ' + _ceEsc(headerName) + '</div>' : '';
  return '<div class="ce-diff">' + header + htmlLines.join('') + '</div>';
}

/**
 * Detect if text looks like a unified diff.
 */
function ceIsDiff(text) {
  if (!text) return false;
  var lines = text.split('\n');
  var diffIndicators = 0;
  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    if (lines[i].indexOf('---') === 0 || lines[i].indexOf('+++') === 0 ||
        lines[i].indexOf('@@') === 0 || lines[i].indexOf('diff --git') === 0) {
      diffIndicators++;
    }
  }
  return diffIndicators >= 2;
}

/* ─── Mermaid Integration ────────────────────────────────────── */

/**
 * Render a mermaid code block as a diagram.
 * Falls back to showing source if rendering fails.
 * @param {string} source - Mermaid diagram source
 * @returns {string} HTML string
 */
function ceRenderMermaidBlock(source) {
  var containerId = _ceNextId('mermaid');

  // Attempt synchronous render first
  if (typeof window.renderMermaid === 'function') {
    var result = window.renderMermaid(source);
    if (result && result.success && result.svg) {
      return '<div class="ce-mermaid-container">' + result.svg + '</div>';
    }
    // If blocked or error, show diagnostic
    if (result && result.error) {
      return '<div class="ce-mermaid-container">' +
        '<div class="ce-mermaid-error">\u26A0\uFE0F ' + _ceEsc(result.error) + '</div>' +
        '<pre class="ce-tool-args" style="margin-top:8px;text-align:left;">' + _ceEsc(source) + '</pre>' +
        '</div>';
    }
  }

  // Async fallback: render placeholder, populate later
  if (typeof window.renderMermaidAsync === 'function') {
    setTimeout(function() {
      var el = document.getElementById(containerId);
      if (!el) return;
      window.renderMermaidAsync(source).then(function(res) {
        if (res && res.success && res.svg) {
          el.innerHTML = res.svg;
        } else {
          el.innerHTML = '<div class="ce-mermaid-error">\u26A0\uFE0F ' +
            _ceEsc(res ? res.error : 'Render failed') + '</div>' +
            '<pre class="ce-tool-args" style="margin-top:8px;text-align:left;">' + _ceEsc(source) + '</pre>';
        }
      }).catch(function() {
        el.innerHTML = '<pre class="ce-tool-args" style="text-align:left;">' + _ceEsc(source) + '</pre>';
      });
    }, 50);
    return '<div class="ce-mermaid-container" id="' + containerId + '">' +
      '<span style="color:var(--text-dim);font-size:12px;">Rendering diagram...</span></div>';
  }

  // No mermaid available — show source
  return '<div class="ce-mermaid-container">' +
    '<div class="ce-mermaid-source" style="text-align:left;">' +
    '<pre class="ce-tool-args">' + _ceEsc(source) + '</pre></div></div>';
}

/* ─── Image Rendering ────────────────────────────────────────── */

/**
 * Render an image inline with click-to-expand.
 * @param {string} src - Image URL or data URI
 * @param {string} [alt] - Alt text
 * @returns {string} HTML string
 */
function ceRenderImage(src, alt) {
  var altText = alt ? _ceEsc(alt) : 'Image';
  return '<img class="ce-image-inline" src="' + _ceEsc(src) + '" alt="' + altText +
    '" onclick="ceExpandImage(this.src)" loading="lazy" />';
}

function ceExpandImage(src) {
  var overlay = document.createElement('div');
  overlay.className = 'ce-image-overlay';
  overlay.innerHTML = '<img src="' + _ceEsc(src) + '" />';
  overlay.addEventListener('click', function() { overlay.remove(); });
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
  });
  document.body.appendChild(overlay);
}

/* ─── Show More / Truncation ─────────────────────────────────── */

/**
 * Wrap content in a truncatable container if it exceeds max lines.
 * @param {string} html - Rendered HTML content
 * @param {string} rawText - Original raw text to count lines
 * @returns {string} Possibly wrapped HTML
 */
function ceApplyTruncation(html, rawText) {
  if (!rawText) return html;
  var lineCount = rawText.split('\n').length;
  if (lineCount <= CHAT_ENHANCE_MAX_LINES) return html;

  var id = _ceNextId('trunc');
  return '<div class="ce-truncated-fade" id="' + id + '">' + html + '</div>' +
    '<button class="ce-show-more-btn" onclick="ceShowMore(\'' + id + '\', this)">Show more (' + lineCount + ' lines)</button>';
}

function ceShowMore(id, btn) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('ce-truncated-fade');
  el.style.maxHeight = 'none';
  if (btn) btn.remove();
}

/* ─── Enhanced Format Engine ─────────────────────────────────── */

/**
 * Enhanced message rendering that processes tool results, diffs,
 * mermaid blocks, and images on top of the base markdown-it rendering.
 *
 * Call this after the base formatMsg() has been applied, or use
 * ceFormatMessage() as a complete replacement.
 *
 * @param {string} rawText - Raw message text
 * @returns {string} Fully rendered HTML
 */
function ceFormatMessage(rawText) {
  if (!rawText) return '';

  // Step 1: Detect and extract special blocks before markdown-it processing
  var processed = rawText;
  var toolCards = [];
  var diffs = [];

  // Extract tool call result blocks: ```tool-result ... ```
  processed = processed.replace(
    /```tool-result\s*\n([\s\S]*?)```/g,
    function(match, content) {
      var parsed = _ceParseToolResult(content);
      var html = ceRenderToolCard(parsed.name, parsed.args, parsed.output);
      var placeholder = '\x00TOOL_' + toolCards.length + '\x00';
      toolCards.push(html);
      return placeholder;
    }
  );

  // Extract diff blocks: ```diff ... ```
  processed = processed.replace(
    /```diff\s*\n([\s\S]*?)```/g,
    function(match, content) {
      if (ceIsDiff(content)) {
        var html = ceRenderDiff(content);
        var placeholder = '\x00DIFF_' + diffs.length + '\x00';
        diffs.push(html);
        return placeholder;
      }
      return match; // Let markdown-it handle it normally
    }
  );

  // Step 2: Run markdown-it rendering
  var html;
  if (window._nnMarkdownIt) {
    html = window._nnMarkdownIt.render(processed);
  } else {
    html = _ceFallbackFormat(processed);
  }

  // Step 3: Restore tool cards and diffs
  for (var t = 0; t < toolCards.length; t++) {
    html = html.replace('\x00TOOL_' + t + '\x00', toolCards[t]);
    // Also handle HTML-escaped version
    html = html.replace('\\x00TOOL_' + t + '\\x00', toolCards[t]);
  }
  for (var d = 0; d < diffs.length; d++) {
    html = html.replace('\x00DIFF_' + d + '\x00', diffs[d]);
    html = html.replace('\\x00DIFF_' + d + '\\x00', diffs[d]);
  }

  // Step 4: Post-process mermaid code blocks
  // markdown-it renders ```mermaid as <pre><code class="language-mermaid">...</code></pre>
  html = html.replace(
    /<pre><code class="(?:hljs )?language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    function(match, code) {
      var decoded = _ceDecodeHtml(code);
      return ceRenderMermaidBlock(decoded);
    }
  );

  // Step 5: Enhance images with click-to-expand
  html = html.replace(
    /<img\s+([^>]*?)src="([^"]+)"([^>]*?)>/g,
    function(match, before, src, after) {
      if (match.indexOf('ce-image-inline') !== -1) return match; // already enhanced
      var alt = '';
      var altMatch = (before + after).match(/alt="([^"]*)"/);
      if (altMatch) alt = altMatch[1];
      return ceRenderImage(src, alt);
    }
  );

  // Step 6: Apply truncation
  html = ceApplyTruncation(html, rawText);

  return html;
}

/* ─── Helpers ────────────────────────────────────────────────── */

function _ceEsc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _ceDecodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Parse a tool-result block content into structured data.
 * Expected format:
 *   tool: <name>
 *   args: <json or text>
 *   output: <text>
 */
function _ceParseToolResult(content) {
  var result = { name: 'Unknown Tool', args: '', output: '' };
  var lines = content.split('\n');
  var section = '';
  var buffer = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('tool:') === 0) {
      result.name = line.substring(5).trim();
      section = '';
    } else if (line.indexOf('args:') === 0) {
      if (section === 'output') result.output = buffer.join('\n');
      buffer = [line.substring(5).trim()];
      section = 'args';
    } else if (line.indexOf('output:') === 0) {
      if (section === 'args') result.args = buffer.join('\n');
      buffer = [line.substring(7).trim()];
      section = 'output';
    } else {
      buffer.push(line);
    }
  }

  if (section === 'args') result.args = buffer.join('\n');
  if (section === 'output') result.output = buffer.join('\n');

  // Try to parse args as JSON for pretty display
  try {
    var parsed = JSON.parse(result.args);
    result.args = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // Keep as-is
  }

  return result;
}

/**
 * Basic fallback formatter when markdown-it is not available.
 */
function _ceFallbackFormat(text) {
  var s = _ceEsc(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

/* ─── Initialization ─────────────────────────────────────────── */

/**
 * Initialize the chat enhancements module.
 * Call once on app startup.
 */
function initChatEnhancements() {
  _ceInjectStyles();

  // Patch the global formatMsg to use enhanced rendering if available
  if (typeof window.formatMsg === 'function') {
    var _origFormatMsg = window.formatMsg;
    window.formatMsg = function(text) {
      return ceFormatMessage(text);
    };
    window._origFormatMsg = _origFormatMsg;
  }

  console.log('[ChatEnhancements] Initialized - tool cards, diffs, mermaid, images, truncation');
}

/* ─── Exports ────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.ceFormatMessage = ceFormatMessage;
  window.ceRenderToolCard = ceRenderToolCard;
  window.ceRenderDiff = ceRenderDiff;
  window.ceRenderMermaidBlock = ceRenderMermaidBlock;
  window.ceRenderImage = ceRenderImage;
  window.ceExpandImage = ceExpandImage;
  window.ceToggleToolCard = ceToggleToolCard;
  window.ceShowMore = ceShowMore;
  window.ceIsDiff = ceIsDiff;
  window.ceApplyTruncation = ceApplyTruncation;
  window.initChatEnhancements = initChatEnhancements;
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatEnhancements);
  } else {
    initChatEnhancements();
  }
}
