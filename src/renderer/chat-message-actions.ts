// @ts-nocheck
/**
 * Chat Message Actions — Hover action bar, code block copy, expand overlay,
 * editable user messages, and retry on error messages.
 *
 * Requirements: 23.1-23.6
 *
 * Depends on: window.showThemedToast (toast feedback)
 */

/* ─── Constants ──────────────────────────────────────────────── */

var _cmaUniqueId = 0;

function _cmaNextId(prefix) {
  return (prefix || 'cma') + '-' + (++_cmaUniqueId) + '-' + Date.now().toString(36);
}

/* ─── Styles (injected once) ─────────────────────────────────── */

function _cmaInjectStyles() {
  if (document.getElementById('chat-message-actions-css')) return;
  var style = document.createElement('style');
  style.id = 'chat-message-actions-css';
  style.textContent = [
    /* Hover action bar */
    '.cma-action-bar {',
    '  position: absolute;',
    '  top: -6px;',
    '  right: 12px;',
    '  display: none;',
    '  align-items: center;',
    '  gap: 2px;',
    '  background: var(--surface-container-highest);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  padding: 2px 4px;',
    '  box-shadow: var(--shadow-sm);',
    '  z-index: 100;',
    '  transition: opacity var(--motion-quick);',
    '}',
    '.message:hover .cma-action-bar,',
    '.message .cma-action-bar:hover {',
    '  display: flex;',
    '}',
    '.cma-action-btn {',
    '  background: transparent;',
    '  border: none;',
    '  color: var(--text-secondary);',
    '  border-radius: var(--radius-xs);',
    '  padding: 4px 8px;',
    '  font-size: 11px;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  white-space: nowrap;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-action-btn:hover {',
    '  background: var(--surface-hover);',
    '  color: var(--text-primary);',
    '}',
    '',
    /* More menu */
    '.cma-more-menu {',
    '  position: absolute;',
    '  top: 100%;',
    '  right: 0;',
    '  margin-top: 4px;',
    '  background: var(--surface-container-highest);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  padding: 4px 0;',
    '  min-width: 140px;',
    '  box-shadow: var(--shadow-md);',
    '  z-index: 200;',
    '  display: none;',
    '}',
    '.cma-more-menu.open { display: block; }',
    '.cma-menu-item {',
    '  padding: 6px 12px;',
    '  font-size: 12px;',
    '  color: var(--text-secondary);',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '}',
    '.cma-menu-item:hover {',
    '  background: var(--surface-hover);',
    '  color: var(--text-primary);',
    '}',
    '',
    /* Code block copy button */
    '.cma-code-copy-btn {',
    '  position: absolute;',
    '  top: 6px;',
    '  right: 6px;',
    '  background: var(--surface-container-highest);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-xs);',
    '  padding: 3px 8px;',
    '  font-size: 10px;',
    '  color: var(--text-secondary);',
    '  cursor: pointer;',
    '  opacity: 0;',
    '  transition: opacity var(--motion-quick), background var(--motion-quick);',
    '  z-index: 10;',
    '}',
    'pre:hover .cma-code-copy-btn,',
    '.cma-code-copy-btn:hover {',
    '  opacity: 1;',
    '}',
    '.cma-code-copy-btn:hover {',
    '  background: var(--accent);',
    '  color: #fff;',
    '  border-color: var(--accent);',
    '}',
    '',
    /* Expand overlay */
    '.cma-expand-overlay {',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    '  right: 0;',
    '  bottom: 0;',
    '  background: rgba(0, 0, 0, 0.85);',
    '  z-index: 10000;',
    '  display: flex;',
    '  flex-direction: column;',
    '  padding: 24px;',
    '  overflow-y: auto;',
    '}',
    '.cma-expand-content {',
    '  max-width: 900px;',
    '  width: 100%;',
    '  margin: 0 auto;',
    '  background: var(--bg-primary);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius);',
    '  padding: 24px 32px;',
    '  color: var(--text-primary);',
    '  font-size: 14px;',
    '  line-height: 1.7;',
    '  position: relative;',
    '  -webkit-user-select: text;',
    '  user-select: text;',
    '}',
    '.cma-expand-close {',
    '  position: fixed;',
    '  top: 32px;',
    '  right: 32px;',
    '  z-index: 10001;',
    '  background: var(--surface-container-highest);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  padding: 6px 14px;',
    '  font-size: 12px;',
    '  color: var(--text-primary);',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-expand-close:hover {',
    '  background: var(--accent);',
    '  color: #fff;',
    '  border-color: var(--accent);',
    '}',
    '',
    /* Editable user message */
    '.cma-edit-container {',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 8px;',
    '  width: 100%;',
    '}',
    '.cma-edit-textarea {',
    '  width: 100%;',
    '  min-height: 60px;',
    '  padding: 10px 12px;',
    '  background: var(--bg-input);',
    '  border: 1px solid var(--accent);',
    '  border-radius: var(--radius-sm);',
    '  color: var(--text-primary);',
    '  font-family: inherit;',
    '  font-size: 13px;',
    '  line-height: 1.5;',
    '  resize: vertical;',
    '  outline: none;',
    '}',
    '.cma-edit-textarea:focus {',
    '  box-shadow: 0 0 0 3px var(--accent-container);',
    '}',
    '.cma-edit-actions {',
    '  display: flex;',
    '  gap: 8px;',
    '  justify-content: flex-end;',
    '}',
    '.cma-edit-save {',
    '  background: var(--accent);',
    '  color: #fff;',
    '  border: none;',
    '  border-radius: var(--radius-xs);',
    '  padding: 6px 14px;',
    '  font-size: 12px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-edit-save:hover { background: var(--accent-hover); }',
    '.cma-edit-cancel {',
    '  background: transparent;',
    '  color: var(--text-secondary);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-xs);',
    '  padding: 6px 14px;',
    '  font-size: 12px;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-edit-cancel:hover { background: var(--surface-hover); }',
    '',
    /* Retry button for error messages */
    '.cma-retry-btn {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  background: transparent;',
    '  border: 1px solid var(--red);',
    '  color: var(--red);',
    '  border-radius: var(--radius-xs);',
    '  padding: 4px 10px;',
    '  font-size: 11px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  margin-top: 8px;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-retry-btn:hover {',
    '  background: var(--red-container);',
    '}',
    '',
    /* Message needs relative positioning for action bar */
    '.message {',
    '  position: relative;',
    '}',
    '',
    /* Expand overlay animated entrance */
    '@keyframes cma-expand-fade-in {',
    '  from { opacity: 0; transform: scale(0.95); }',
    '  to { opacity: 1; transform: scale(1); }',
    '}',
    '.cma-expand-overlay--animated {',
    '  animation: cma-expand-fade-in 0.2s ease-out forwards;',
    '}',
    '',
    /* Reasoning section */
    '.cma-expand-reasoning {',
    '  background: var(--surface-container);',
    '  font-style: italic;',
    '  border-left: 3px solid var(--accent);',
    '  border-radius: var(--radius-sm);',
    '  padding: 16px;',
    '  margin-bottom: 16px;',
    '}',
    '.cma-expand-reasoning__header {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  font-style: normal;',
    '  font-weight: 600;',
    '  font-size: 13px;',
    '  color: var(--text-primary);',
    '  margin-bottom: 8px;',
    '}',
    '.cma-expand-reasoning__toggle {',
    '  background: transparent;',
    '  border: none;',
    '  color: var(--text-secondary);',
    '  cursor: pointer;',
    '  font-size: 12px;',
    '  padding: 4px 8px;',
    '  border-radius: var(--radius-xs);',
    '  transition: all var(--motion-quick);',
    '}',
    '.cma-expand-reasoning__toggle:hover {',
    '  background: var(--surface-hover);',
    '  color: var(--text-primary);',
    '}',
    '.cma-expand-reasoning__body {',
    '  max-height: 400px;',
    '  overflow-y: auto;',
    '  font-size: 13px;',
    '  line-height: 1.6;',
    '  color: var(--text-secondary);',
    '}',
    '.cma-expand-reasoning[data-collapsed="true"] .cma-expand-reasoning__body {',
    '  display: none;',
    '}',
    '',
    /* Final response header */
    '.cma-expand-response__header {',
    '  font-weight: 600;',
    '  font-size: 13px;',
    '  color: var(--text-primary);',
    '  margin-bottom: 12px;',
    '  padding-bottom: 8px;',
    '  border-bottom: 1px solid var(--border-color);',
    '}',
  ].join('\n');
  document.head.appendChild(style);
}

/* ─── Action Bar ─────────────────────────────────────────────── */

/**
 * Attach action bars to all messages in the chat area.
 * Should be called whenever new messages are rendered.
 */
function cmaAttachActionBars() {
  var messages = document.querySelectorAll('#chat-area .message');
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    // Skip if already has action bar
    if (msg.querySelector('.cma-action-bar')) continue;
    _cmaCreateActionBar(msg);
  }
}

/**
 * Create and append an action bar to a message element.
 */
function _cmaCreateActionBar(msgEl) {
  var isUser = msgEl.classList.contains('user');
  var isError = msgEl.classList.contains('error') || msgEl.querySelector('.cma-retry-btn');

  var bar = document.createElement('div');
  bar.className = 'cma-action-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Message actions');

  // Copy button (only for user messages)
  if (isUser) {
    var copyBtn = document.createElement('button');
    copyBtn.className = 'cma-action-btn';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '\uD83D\uDCCB Copy';
    copyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _cmaCopyMessage(msgEl);
    });
    bar.appendChild(copyBtn);
  }

  // Expand button
  var expandBtn = document.createElement('button');
  expandBtn.className = 'cma-action-btn';
  expandBtn.setAttribute('aria-label', 'Expand message');
  expandBtn.innerHTML = '\u2922 Expand';
  expandBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _cmaExpandMessage(msgEl);
  });
  bar.appendChild(expandBtn);

  // More menu button
  var moreContainer = document.createElement('div');
  moreContainer.style.position = 'relative';
  var moreBtn = document.createElement('button');
  moreBtn.className = 'cma-action-btn';
  moreBtn.setAttribute('aria-label', 'More actions');
  moreBtn.innerHTML = '\u22EF';
  var moreMenu = document.createElement('div');
  moreMenu.className = 'cma-more-menu';

  // Edit option (user messages only)
  if (isUser) {
    var editItem = document.createElement('div');
    editItem.className = 'cma-menu-item';
    editItem.innerHTML = '\u270F\uFE0F Edit';
    editItem.addEventListener('click', function(e) {
      e.stopPropagation();
      moreMenu.classList.remove('open');
      _cmaEditMessage(msgEl);
    });
    moreMenu.appendChild(editItem);
  }

  // Retry option (error messages)
  if (isError) {
    var retryItem = document.createElement('div');
    retryItem.className = 'cma-menu-item';
    retryItem.innerHTML = '\uD83D\uDD04 Retry';
    retryItem.addEventListener('click', function(e) {
      e.stopPropagation();
      moreMenu.classList.remove('open');
      _cmaRetryMessage(msgEl);
    });
    moreMenu.appendChild(retryItem);
  }

  moreBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var wasOpen = moreMenu.classList.contains('open');
    _cmaCloseAllMenus();
    if (!wasOpen) {
      moreMenu.classList.add('open');
    }
  });

  moreContainer.appendChild(moreBtn);
  moreContainer.appendChild(moreMenu);
  bar.appendChild(moreContainer);

  // Ensure message has relative positioning
  var computedPos = window.getComputedStyle(msgEl).position;
  if (computedPos === 'static') {
    msgEl.style.position = 'relative';
  }

  msgEl.appendChild(bar);
}

/* ─── Copy Message (Req 23.2) ────────────────────────────────── */

function _cmaCopyMessage(msgEl) {
  var rawText = msgEl.getAttribute('data-raw') || '';
  if (!rawText) {
    // Fallback: get text content from message body
    var body = msgEl.querySelector('.message-body');
    rawText = body ? body.textContent || '' : msgEl.textContent || '';
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(rawText).then(function() {
      _cmaToast('Copied!', 'success');
    }).catch(function() {
      _cmaFallbackCopy(rawText);
    });
  } else {
    _cmaFallbackCopy(rawText);
  }
}

function _cmaFallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    _cmaToast('Copied!', 'success');
  } catch (e) {
    _cmaToast('Failed to copy', 'error');
  }
  document.body.removeChild(ta);
}

/* ─── Render Expand Overlay (Req 3.1-3.8, 5.2, 5.4) ─────────── */

/**
 * Create the enhanced Expand overlay DOM element with optional reasoning section
 * and a final response section rendered with full markdown.
 *
 * @param {string} content - The final response message content (raw text/markdown)
 * @param {string} [reasoning] - Optional reasoning/thinking content from the LLM
 * @returns {HTMLElement} The overlay root element (not yet appended to DOM)
 */
function renderExpandOverlay(content, reasoning) {
  var overlay = document.createElement('div');
  overlay.className = 'cma-expand-overlay cma-expand-overlay--animated';

  // Close button
  var closeBtn = document.createElement('button');
  closeBtn.className = 'cma-expand-close';
  closeBtn.textContent = '\u2715 Close';

  // Content wrapper
  var contentArea = document.createElement('div');
  contentArea.className = 'cma-expand-content';

  // Determine if reasoning is present (non-empty, non-whitespace)
  var hasReasoning = typeof reasoning === 'string' && reasoning.trim().length > 0;

  // Reasoning section (conditional)
  if (hasReasoning) {
    var reasoningSection = document.createElement('div');
    reasoningSection.className = 'cma-expand-reasoning';
    reasoningSection.setAttribute('data-collapsed', 'false');

    // Reasoning header
    var reasoningHeader = document.createElement('div');
    reasoningHeader.className = 'cma-expand-reasoning__header';

    var reasoningLabel = document.createElement('span');
    reasoningLabel.textContent = '\uD83D\uDCAD Reasoning & Thinking';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'cma-expand-reasoning__toggle';
    toggleBtn.setAttribute('aria-label', 'Collapse reasoning');
    toggleBtn.textContent = '\u25BC';
    toggleBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var section = reasoningSection;
      var isCollapsed = section.getAttribute('data-collapsed') === 'true';
      if (isCollapsed) {
        section.setAttribute('data-collapsed', 'false');
        toggleBtn.textContent = '\u25BC';
        toggleBtn.setAttribute('aria-label', 'Collapse reasoning');
      } else {
        section.setAttribute('data-collapsed', 'true');
        toggleBtn.textContent = '\u25B6';
        toggleBtn.setAttribute('aria-label', 'Expand reasoning');
      }
    });

    reasoningHeader.appendChild(reasoningLabel);
    reasoningHeader.appendChild(toggleBtn);

    // Reasoning body — preserve newlines with whitespace pre-wrap
    var reasoningBody = document.createElement('div');
    reasoningBody.className = 'cma-expand-reasoning__body';
    reasoningBody.style.whiteSpace = 'pre-wrap';
    reasoningBody.style.wordBreak = 'break-word';
    // Render reasoning as escaped text with preserved newlines
    reasoningBody.textContent = reasoning;

    reasoningSection.appendChild(reasoningHeader);
    reasoningSection.appendChild(reasoningBody);
    contentArea.appendChild(reasoningSection);
  }

  // Final Response section (always rendered)
  var responseSection = document.createElement('div');
  responseSection.className = 'cma-expand-response';

  var responseHeader = document.createElement('div');
  responseHeader.className = 'cma-expand-response__header';
  responseHeader.textContent = '\u2728 Final Response';

  var responseBody = document.createElement('div');
  responseBody.className = 'cma-expand-response__body';

  // Render final response with full markdown
  var renderedContent = '';
  if (typeof window.ceFormatMessage === 'function') {
    renderedContent = window.ceFormatMessage(content || '');
  } else if (window._nnMarkdownIt) {
    renderedContent = window._nnMarkdownIt.render(content || '');
  } else {
    // Fallback: escape HTML and convert newlines to <br>
    renderedContent = _cmaEscapeHtml(content || '').replace(/\n/g, '<br>');
  }
  responseBody.innerHTML = renderedContent;

  responseSection.appendChild(responseHeader);
  responseSection.appendChild(responseBody);
  contentArea.appendChild(responseSection);

  overlay.appendChild(closeBtn);
  overlay.appendChild(contentArea);

  return overlay;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function _cmaEscapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/* ─── Expand Message (Req 23.3) ──────────────────────────────── */

function _cmaExpandMessage(msgEl) {
  var body = msgEl.querySelector('.message-body');
  if (!body) return;

  // Read reasoning from data attribute
  var reasoning = msgEl.getAttribute('data-reasoning') || undefined;

  // Get raw message content for markdown rendering
  var rawContent = msgEl.getAttribute('data-raw') || '';
  if (!rawContent) {
    rawContent = body.textContent || '';
  }

  var overlay = renderExpandOverlay(rawContent, reasoning);
  var closeBtn = overlay.querySelector('.cma-expand-close');
  var contentArea = overlay.querySelector('.cma-expand-content');

  // Close handlers
  var closeOverlay = function() {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };

  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    e.preventDefault();
    closeOverlay();
  });

  // Close on Escape
  var escHandler = function(e) {
    if (e.key === 'Escape') {
      closeOverlay();
    }
  };
  document.addEventListener('keydown', escHandler);

  // Close on click outside the content area
  overlay.addEventListener('click', function(e) {
    if (!contentArea.contains(e.target) && e.target !== closeBtn && !closeBtn.contains(e.target)) {
      closeOverlay();
    }
  });

  document.body.appendChild(overlay);
}

/* ─── Code Block Copy Buttons (Req 23.4) ─────────────────────── */

/**
 * Add copy buttons to all code blocks within the chat area.
 */
function cmaAttachCodeBlockCopyButtons() {
  var codeBlocks = document.querySelectorAll('#chat-area pre');
  for (var i = 0; i < codeBlocks.length; i++) {
    var pre = codeBlocks[i];
    if (pre.querySelector('.cma-code-copy-btn')) continue;
    // Ensure pre has relative positioning
    if (window.getComputedStyle(pre).position === 'static') {
      pre.style.position = 'relative';
    }
    var btn = document.createElement('button');
    btn.className = 'cma-code-copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', (function(preEl) {
      return function(e) {
        e.stopPropagation();
        var code = preEl.querySelector('code');
        var text = code ? code.textContent || '' : preEl.textContent || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            _cmaToast('Copied!', 'success');
            e.target.textContent = 'Copied!';
            setTimeout(function() { e.target.textContent = 'Copy'; }, 1500);
          }).catch(function() {
            _cmaFallbackCopy(text);
          });
        } else {
          _cmaFallbackCopy(text);
        }
      };
    })(pre));
    pre.appendChild(btn);
  }
}

/* ─── Edit User Message (Req 23.5) ───────────────────────────── */

function _cmaEditMessage(msgEl) {
  var body = msgEl.querySelector('.message-body');
  if (!body) return;

  var rawText = msgEl.getAttribute('data-raw') || body.textContent || '';
  var originalHTML = body.innerHTML;

  var container = document.createElement('div');
  container.className = 'cma-edit-container';

  var textarea = document.createElement('textarea');
  textarea.className = 'cma-edit-textarea';
  textarea.value = rawText;
  textarea.setAttribute('aria-label', 'Edit message');

  var actions = document.createElement('div');
  actions.className = 'cma-edit-actions';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'cma-edit-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() {
    body.innerHTML = originalHTML;
    body.style.display = '';
  });

  var saveBtn = document.createElement('button');
  saveBtn.className = 'cma-edit-save';
  saveBtn.textContent = 'Save & Resend';
  saveBtn.addEventListener('click', function() {
    var newText = textarea.value.trim();
    if (!newText) {
      _cmaToast('Message cannot be empty', 'error');
      return;
    }
    // Restore body and update content
    body.innerHTML = '';
    body.textContent = newText;
    msgEl.setAttribute('data-raw', newText);

    // Dispatch custom event for branching conversation
    var event = new CustomEvent('cma:message-edited', {
      bubbles: true,
      detail: { messageEl: msgEl, newText: newText, originalText: rawText }
    });
    msgEl.dispatchEvent(event);

    // Trigger re-send if there is a global handler
    if (typeof window.cmaSendEditedMessage === 'function') {
      window.cmaSendEditedMessage(newText, msgEl);
    } else if (typeof window.sendMessage === 'function') {
      window.sendMessage(newText);
    }

    _cmaToast('Message edited — new branch created', 'info');
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  container.appendChild(textarea);
  container.appendChild(actions);

  body.innerHTML = '';
  body.appendChild(container);

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/* ─── Retry on Error (Req 23.6) ──────────────────────────────── */

function _cmaRetryMessage(msgEl) {
  // Find the preceding user message
  var prev = msgEl.previousElementSibling;
  while (prev && !prev.classList.contains('user')) {
    prev = prev.previousElementSibling;
  }

  if (!prev) {
    _cmaToast('No user message found to retry', 'error');
    return;
  }

  var rawText = prev.getAttribute('data-raw') || '';
  if (!rawText) {
    var body = prev.querySelector('.message-body');
    rawText = body ? body.textContent || '' : '';
  }

  if (!rawText) {
    _cmaToast('Could not determine message to retry', 'error');
    return;
  }

  // Dispatch retry event
  var event = new CustomEvent('cma:message-retry', {
    bubbles: true,
    detail: { messageEl: msgEl, retryText: rawText }
  });
  msgEl.dispatchEvent(event);

  // Re-send through available mechanism
  if (typeof window.sendMessage === 'function') {
    window.sendMessage(rawText);
    _cmaToast('Retrying...', 'info');
  } else {
    _cmaToast('Retry dispatched', 'info');
  }
}

/**
 * Attach retry buttons to error messages.
 */
function cmaAttachRetryButtons() {
  var messages = document.querySelectorAll('#chat-area .message.error, #chat-area .message.assistant');
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    // Only attach to messages that have error indicators
    var body = msg.querySelector('.message-body');
    if (!body) continue;
    var hasError = msg.classList.contains('error') ||
      (body.textContent && body.textContent.indexOf('Error:') === 0) ||
      (body.textContent && body.textContent.indexOf('error') !== -1 && body.textContent.length < 200);

    if (!hasError) continue;
    if (msg.querySelector('.cma-retry-btn')) continue;

    var retryBtn = document.createElement('button');
    retryBtn.className = 'cma-retry-btn';
    retryBtn.innerHTML = '\uD83D\uDD04 Retry';
    retryBtn.setAttribute('aria-label', 'Retry this request');
    retryBtn.addEventListener('click', (function(m) {
      return function(e) {
        e.stopPropagation();
        _cmaRetryMessage(m);
      };
    })(msg));
    body.appendChild(retryBtn);
  }
}

/* ─── Helpers ────────────────────────────────────────────────── */

function _cmaToast(message, type) {
  if (typeof window.showThemedToast === 'function') {
    window.showThemedToast(message, type || 'info');
  } else {
    console.log('[CMA Toast]', type, message);
  }
}

function _cmaCloseAllMenus() {
  var menus = document.querySelectorAll('.cma-more-menu.open');
  for (var i = 0; i < menus.length; i++) {
    menus[i].classList.remove('open');
  }
}

/* ─── MutationObserver for Auto-Attach ───────────────────────── */

var _cmaObserver = null;

function _cmaStartObserver() {
  var chatArea = document.getElementById('chat-area');
  if (!chatArea || _cmaObserver) return;

  _cmaObserver = new MutationObserver(function(mutations) {
    var shouldUpdate = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0) {
        shouldUpdate = true;
        break;
      }
    }
    if (shouldUpdate) {
      // Debounce the attachment
      clearTimeout(_cmaObserver._debounce);
      _cmaObserver._debounce = setTimeout(function() {
        cmaAttachActionBars();
        cmaAttachCodeBlockCopyButtons();
      }, 100);
    }
  });

  _cmaObserver.observe(chatArea, { childList: true, subtree: true });
}

/* ─── Close menus on outside click ───────────────────────────── */

function _cmaGlobalClickHandler(e) {
  if (!e.target.closest('.cma-more-menu') && !e.target.closest('.cma-action-btn')) {
    _cmaCloseAllMenus();
  }
}

/* ─── Initialization ─────────────────────────────────────────── */

function initChatMessageActions() {
  _cmaInjectStyles();

  // Attach to existing messages
  cmaAttachActionBars();
  cmaAttachCodeBlockCopyButtons();

  // Start observing for new messages
  _cmaStartObserver();

  // Global click handler to close menus
  document.addEventListener('click', _cmaGlobalClickHandler);

  console.log('[ChatMessageActions] Initialized - hover bar, copy, expand, edit, retry');
}

/* ─── Exports ────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.initChatMessageActions = initChatMessageActions;
  window.cmaAttachActionBars = cmaAttachActionBars;
  window.cmaAttachCodeBlockCopyButtons = cmaAttachCodeBlockCopyButtons;
  window.cmaAttachRetryButtons = cmaAttachRetryButtons;
  window.renderExpandOverlay = renderExpandOverlay;
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatMessageActions);
  } else {
    initChatMessageActions();
  }
}
