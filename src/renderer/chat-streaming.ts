// @ts-nocheck
/**
 * Chat Streaming — Token-by-token streaming rendering with real-time updates.
 *
 * Features:
 * - Token-by-token streaming rendering with cursor animation
 * - Defer code block highlighting until block complete
 * - Stop button active during streaming
 * - Full re-render with Markdown/highlighting after stream completes
 * - WebSocket auto-reconnect with "Reconnecting..." indicator
 *
 * Requirements: 20.1-20.6
 *
 * Plain-JS contract: var, no type annotations, no non-null assertions.
 */

/* ─── State ──────────────────────────────────────────────────── */

var _csStreaming = false;
var _csBuffer = '';
var _csCodeBlockBuffer = '';
var _csInCodeBlock = false;
var _csCodeBlockLang = '';
var _csStreamEl = null;
var _csMessageEl = null;
var _csCursorEl = null;
var _csStopCallback = null;
var _csReconnectIndicator = null;
var _csReconnectTimeout = null;
var _csReconnectAttempts = 0;
var _csMaxReconnectDelay = 30000;
var _csBaseReconnectDelay = 1000;
var _csWs = null;
var _csWsUrl = '';
var _csInitialized = false;

/* ─── Styles (injected once) ─────────────────────────────────── */

function _csInjectStyles() {
  if (document.getElementById('chat-streaming-css')) return;
  var style = document.createElement('style');
  style.id = 'chat-streaming-css';
  style.textContent = [
    /* Streaming text container */
    '.cs-streaming-text {',
    '  white-space: pre-wrap;',
    '  word-break: break-word;',
    '  line-height: 1.6;',
    '  font-size: 14px;',
    '  color: var(--text-primary);',
    '}',

    /* Blinking cursor */
    '.cs-cursor {',
    '  display: inline-block;',
    '  width: 2px;',
    '  height: 1em;',
    '  background: var(--accent);',
    '  margin-left: 1px;',
    '  vertical-align: text-bottom;',
    '  animation: csCursorBlink 0.8s step-end infinite;',
    '}',
    '@keyframes csCursorBlink {',
    '  0%, 100% { opacity: 1; }',
    '  50% { opacity: 0; }',
    '}',

    /* Code block in progress (unhighlighted) */
    '.cs-code-pending {',
    '  display: block;',
    '  background: var(--surface-container, rgba(0,0,0,0.15));',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  padding: 12px 14px;',
    '  margin: 8px 0;',
    '  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;',
    '  font-size: 13px;',
    '  line-height: 1.5;',
    '  color: var(--text-secondary);',
    '  overflow-x: auto;',
    '  white-space: pre-wrap;',
    '  word-break: break-all;',
    '}',
    '.cs-code-pending-lang {',
    '  display: block;',
    '  font-size: 10px;',
    '  color: var(--text-dim);',
    '  text-transform: uppercase;',
    '  letter-spacing: 0.5px;',
    '  margin-bottom: 6px;',
    '  font-weight: 600;',
    '}',

    /* Reconnecting indicator */
    '.cs-reconnect-bar {',
    '  position: fixed;',
    '  top: var(--titlebar-height, 38px);',
    '  left: 50%;',
    '  transform: translateX(-50%);',
    '  z-index: 9999;',
    '  padding: 6px 16px;',
    '  background: var(--yellow-container, rgba(251,191,36,0.12));',
    '  border: 1px solid var(--yellow, #fbbf24);',
    '  border-radius: var(--radius-sm);',
    '  font-size: 12px;',
    '  font-weight: 600;',
    '  color: var(--yellow, #fbbf24);',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '  box-shadow: var(--shadow-md);',
    '  transition: opacity var(--motion-standard), transform var(--motion-standard);',
    '}',
    '.cs-reconnect-bar.cs-hidden {',
    '  opacity: 0;',
    '  transform: translateX(-50%) translateY(-10px);',
    '  pointer-events: none;',
    '}',
    '.cs-reconnect-spinner {',
    '  width: 12px;',
    '  height: 12px;',
    '  border: 2px solid var(--yellow, #fbbf24);',
    '  border-top-color: transparent;',
    '  border-radius: 50%;',
    '  animation: csReconnectSpin 0.8s linear infinite;',
    '}',
    '@keyframes csReconnectSpin {',
    '  from { transform: rotate(0deg); }',
    '  to { transform: rotate(360deg); }',
    '}',

    /* Stop button enhancement during streaming */
    '.cs-stop-btn {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  padding: 4px 12px;',
    '  background: var(--red);',
    '  color: #fff;',
    '  border: none;',
    '  border-radius: var(--radius-xs);',
    '  font-size: 11px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.cs-stop-btn:hover {',
    '  background: #ef4444;',
    '  transform: scale(1.05);',
    '}'
  ].join('\n');
  document.head.appendChild(style);
}

/* ─── Core Streaming API ─────────────────────────────────────── */

/**
 * Begin a new streaming message. Creates the message bubble and cursor.
 * @param {HTMLElement} chatArea - The chat area container
 * @param {object} [options] - Optional configuration
 * @param {function} [options.onStop] - Callback when stop is clicked
 * @returns {object} Stream handle with appendToken, complete, abort methods
 */
function csStartStream(chatArea, options) {
  var opts = options || {};
  _csStreaming = true;
  _csBuffer = '';
  _csCodeBlockBuffer = '';
  _csInCodeBlock = false;
  _csCodeBlockLang = '';
  _csStopCallback = opts.onStop || null;

  // Create message container (matching existing agent message structure)
  _csMessageEl = document.createElement('div');
  _csMessageEl.className = 'message assistant';
  _csMessageEl.innerHTML =
    '<div class="message-inner">' +
      '<div class="message-avatar">\uD83E\uDDE0</div>' +
      '<div class="message-content">' +
        '<div class="role-label">Agent</div>' +
        '<div class="message-body"><span class="cs-streaming-text"></span><span class="cs-cursor"></span></div>' +
      '</div>' +
    '</div>';

  chatArea.appendChild(_csMessageEl);

  _csStreamEl = _csMessageEl.querySelector('.cs-streaming-text');
  _csCursorEl = _csMessageEl.querySelector('.cs-cursor');

  // Activate the stop button in the agent state bar if present
  _csActivateStopButton();

  // Auto-scroll to bottom
  _csScrollToBottom(chatArea);

  return {
    appendToken: function(token) { csAppendToken(token, chatArea); },
    complete: function() { csCompleteStream(chatArea); },
    abort: function() { csAbortStream(chatArea); }
  };
}

/**
 * Append a token/chunk to the current streaming message.
 * Handles code block detection and deferred highlighting.
 * @param {string} token - The token text to append
 * @param {HTMLElement} chatArea - The chat area for scroll management
 */
function csAppendToken(token, chatArea) {
  if (!_csStreaming || !_csStreamEl) return;

  _csBuffer += token;

  // Check for code block boundaries
  var lines = _csBuffer.split('\n');
  var lastLines = lines.slice(-3);

  // Detect opening of code block: ```lang
  if (!_csInCodeBlock) {
    var openMatch = _csBuffer.match(/```(\w*)\s*\n([^]*)$/);
    if (openMatch && !_csBuffer.match(/```(\w*)\s*\n[^]*```/)) {
      // We are inside an unclosed code block
      _csInCodeBlock = true;
      _csCodeBlockLang = openMatch[1] || '';
      _csCodeBlockBuffer = openMatch[2] || '';
    }
  } else {
    // Check if code block closed
    var closeIdx = _csBuffer.lastIndexOf('```');
    var openIdx = _csBuffer.indexOf('```');
    // Count pairs of ``` to determine if we're still inside
    var parts = _csBuffer.split('```');
    // Odd number of splits means open block
    if (parts.length % 2 === 1 && parts.length > 2) {
      // Code block closed
      _csInCodeBlock = false;
      _csCodeBlockBuffer = '';
      _csCodeBlockLang = '';
    }
  }

  // Render current state
  _csRenderStreamContent();

  // Auto-scroll if near bottom
  if (chatArea) {
    _csScrollToBottom(chatArea);
  }
}

/**
 * Complete the stream — do full Markdown re-render with syntax highlighting.
 * @param {HTMLElement} chatArea - The chat area container
 */
function csCompleteStream(chatArea) {
  if (!_csStreaming) return;
  _csStreaming = false;

  // Remove cursor
  if (_csCursorEl && _csCursorEl.parentNode) {
    _csCursorEl.remove();
  }
  _csCursorEl = null;

  // Full re-render with markdown
  var bodyEl = _csMessageEl ? _csMessageEl.querySelector('.message-body') : null;
  if (bodyEl && _csBuffer) {
    var rendered = '';
    if (typeof window.ceFormatMessage === 'function') {
      rendered = window.ceFormatMessage(_csBuffer);
    } else if (window._nnMarkdownIt) {
      rendered = window._nnMarkdownIt.render(_csBuffer);
    } else {
      rendered = _csEsc(_csBuffer).replace(/\n/g, '<br>');
    }
    bodyEl.innerHTML = rendered;

    // Apply syntax highlighting to code blocks
    if (window.hljs) {
      var codeBlocks = bodyEl.querySelectorAll('pre code');
      for (var i = 0; i < codeBlocks.length; i++) {
        try {
          window.hljs.highlightElement(codeBlocks[i]);
        } catch (e) {
          // Ignore highlight errors
        }
      }
    }
  }

  // Deactivate stop button
  _csDeactivateStopButton();

  // Reset state
  _csStreamEl = null;
  _csMessageEl = null;
  _csBuffer = '';
  _csInCodeBlock = false;
  _csCodeBlockBuffer = '';
  _csCodeBlockLang = '';
  _csStopCallback = null;

  // Final scroll
  if (chatArea) {
    _csScrollToBottom(chatArea);
  }
}

/**
 * Abort the stream (user clicked Stop).
 * Shows whatever has been received so far with full rendering.
 * @param {HTMLElement} chatArea - The chat area container
 */
function csAbortStream(chatArea) {
  if (!_csStreaming) return;

  // Add abort indicator to buffer
  _csBuffer += '\n\n*[Streaming interrupted by user]*';

  // Complete rendering with what we have
  csCompleteStream(chatArea);
}

/**
 * Check if streaming is currently active.
 * @returns {boolean}
 */
function csIsStreaming() {
  return _csStreaming;
}

/**
 * Get the current streamed buffer content.
 * @returns {string}
 */
function csGetBuffer() {
  return _csBuffer;
}

/* ─── Internal Rendering ─────────────────────────────────────── */

function _csRenderStreamContent() {
  if (!_csStreamEl) return;

  if (_csInCodeBlock) {
    // Show text before code block as HTML, then pending code block
    var parts = _csBuffer.split(/```\w*\s*\n/);
    var beforeCode = parts[0] || '';
    var codeContent = parts.slice(1).join('');

    var html = _csEsc(beforeCode).replace(/\n/g, '<br>');
    html += '<div class="cs-code-pending">';
    if (_csCodeBlockLang) {
      html += '<span class="cs-code-pending-lang">' + _csEsc(_csCodeBlockLang) + '</span>';
    }
    html += _csEsc(codeContent);
    html += '</div>';
    _csStreamEl.innerHTML = html;
  } else {
    // Simple text rendering — preserve newlines, escape HTML
    // Don't do full markdown rendering during streaming to avoid flicker
    var text = _csBuffer;
    var html = _csEsc(text).replace(/\n/g, '<br>');
    // Basic inline formatting for readability during streaming
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`\n]+)`/g, '<code style="background:var(--surface-container-highest);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px;">$1</code>');
    _csStreamEl.innerHTML = html;
  }
}

/* ─── Stop Button Management ─────────────────────────────────── */

function _csActivateStopButton() {
  // Activate the stop button in agent-state-bar if it exists
  if (typeof window.asbSetState === 'function') {
    window.asbSetState('executing', 'Streaming response...');
  }

  // Also show the terminate button
  var termBtn = document.getElementById('terminate-btn');
  if (termBtn) {
    termBtn.style.display = 'flex';
    // Store original click handler
    termBtn._csOrigClick = termBtn.onclick;
    termBtn.onclick = function() {
      csStopStreaming();
    };
  }
}

function _csDeactivateStopButton() {
  // Reset agent state bar
  if (typeof window.asbSetState === 'function') {
    window.asbSetState('idle', '');
  }

  // Hide terminate button
  var termBtn = document.getElementById('terminate-btn');
  if (termBtn) {
    termBtn.style.display = 'none';
    if (termBtn._csOrigClick) {
      termBtn.onclick = termBtn._csOrigClick;
      delete termBtn._csOrigClick;
    }
  }
}

/**
 * Stop the current stream (called by stop button).
 */
function csStopStreaming() {
  if (!_csStreaming) return;

  // Call the stop callback if provided
  if (typeof _csStopCallback === 'function') {
    _csStopCallback();
  }

  // Notify main process to cancel
  if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
    window.electronAPI.invoke('agent:stop-streaming').catch(function() {
      // Ignore errors — best effort
    });
  }

  // Abort the stream rendering
  var chatArea = document.getElementById('chat-area');
  csAbortStream(chatArea);
}

/* ─── WebSocket Reconnection ─────────────────────────────────── */

/**
 * Initialize WebSocket connection with auto-reconnect.
 * @param {string} url - WebSocket URL
 * @param {object} [handlers] - Event handlers
 * @param {function} [handlers.onMessage] - Message handler
 * @param {function} [handlers.onOpen] - Connection open handler
 * @param {function} [handlers.onClose] - Connection close handler
 */
function csConnectWebSocket(url, handlers) {
  _csWsUrl = url;
  var h = handlers || {};

  function connect() {
    try {
      _csWs = new WebSocket(url);
    } catch (e) {
      console.error('[ChatStreaming] WebSocket creation failed:', e);
      _csScheduleReconnect(h);
      return;
    }

    _csWs.onopen = function() {
      _csReconnectAttempts = 0;
      _csHideReconnectIndicator();
      if (typeof h.onOpen === 'function') h.onOpen();
      console.log('[ChatStreaming] WebSocket connected');
    };

    _csWs.onmessage = function(event) {
      if (typeof h.onMessage === 'function') h.onMessage(event.data);
    };

    _csWs.onclose = function(event) {
      if (typeof h.onClose === 'function') h.onClose(event);
      // Auto-reconnect unless intentionally closed
      if (event.code !== 1000) {
        _csShowReconnectIndicator();
        _csScheduleReconnect(h);
      }
    };

    _csWs.onerror = function() {
      // Error will trigger onclose, which handles reconnect
    };
  }

  connect();
  return {
    send: function(data) { if (_csWs && _csWs.readyState === WebSocket.OPEN) _csWs.send(data); },
    close: function() { if (_csWs) { _csWs.close(1000); _csWs = null; } },
    getState: function() { return _csWs ? _csWs.readyState : WebSocket.CLOSED; }
  };
}

function _csScheduleReconnect(handlers) {
  _csReconnectAttempts++;
  // Exponential backoff with jitter
  var delay = Math.min(
    _csBaseReconnectDelay * Math.pow(2, _csReconnectAttempts - 1),
    _csMaxReconnectDelay
  );
  delay += Math.random() * 1000; // jitter

  console.log('[ChatStreaming] Reconnecting in ' + Math.round(delay) + 'ms (attempt ' + _csReconnectAttempts + ')');

  if (_csReconnectTimeout) clearTimeout(_csReconnectTimeout);
  _csReconnectTimeout = setTimeout(function() {
    csConnectWebSocket(_csWsUrl, handlers);
  }, delay);
}

function _csShowReconnectIndicator() {
  if (!_csReconnectIndicator) {
    _csReconnectIndicator = document.createElement('div');
    _csReconnectIndicator.className = 'cs-reconnect-bar';
    _csReconnectIndicator.innerHTML =
      '<div class="cs-reconnect-spinner"></div>' +
      '<span>Reconnecting...</span>';
    document.body.appendChild(_csReconnectIndicator);
  }
  _csReconnectIndicator.classList.remove('cs-hidden');
}

function _csHideReconnectIndicator() {
  if (_csReconnectIndicator) {
    _csReconnectIndicator.classList.add('cs-hidden');
    // Remove after transition
    setTimeout(function() {
      if (_csReconnectIndicator && _csReconnectIndicator.parentNode) {
        _csReconnectIndicator.remove();
        _csReconnectIndicator = null;
      }
    }, 300);
  }
}

/* ─── IPC Stream Integration ─────────────────────────────────── */

/**
 * Set up IPC-based streaming for Electron environments.
 * Listens for streaming events from the main process.
 */
function csSetupIPCStreaming() {
  if (!window.electronAPI || typeof window.electronAPI.receive !== 'function') {
    console.warn('[ChatStreaming] electronAPI.receive not available — IPC streaming disabled');
    return;
  }

  var currentHandle = null;

  // Listen for stream start
  window.electronAPI.receive('agent:stream-start', function() {
    var chatArea = document.getElementById('chat-area');
    if (!chatArea) return;
    currentHandle = csStartStream(chatArea, {
      onStop: function() {
        console.log('[ChatStreaming] User stopped stream via IPC');
      }
    });
  });

  // Listen for stream tokens
  window.electronAPI.receive('agent:stream-token', function(token) {
    if (currentHandle) {
      currentHandle.appendToken(token);
    }
  });

  // Listen for stream complete
  window.electronAPI.receive('agent:stream-complete', function() {
    if (currentHandle) {
      currentHandle.complete();
      currentHandle = null;
    }
  });

  // Listen for stream error/abort
  window.electronAPI.receive('agent:stream-error', function() {
    if (currentHandle) {
      currentHandle.abort();
      currentHandle = null;
    }
  });

  console.log('[ChatStreaming] IPC streaming listeners registered');
}

/* ─── Scroll Helpers ─────────────────────────────────────────── */

function _csScrollToBottom(chatArea) {
  if (!chatArea) return;
  // Only auto-scroll if user is near the bottom (within 150px)
  var distFromBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
  if (distFromBottom < 150) {
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

/* ─── Utilities ──────────────────────────────────────────────── */

function _csEsc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── Initialization ─────────────────────────────────────────── */

function initChatStreaming() {
  if (_csInitialized) return;
  _csInitialized = true;

  _csInjectStyles();
  csSetupIPCStreaming();

  console.log('[ChatStreaming] Initialized — streaming rendering, stop control, WebSocket reconnect');
}

/* ─── Exports ────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.csStartStream = csStartStream;
  window.csAppendToken = csAppendToken;
  window.csCompleteStream = csCompleteStream;
  window.csAbortStream = csAbortStream;
  window.csIsStreaming = csIsStreaming;
  window.csGetBuffer = csGetBuffer;
  window.csStopStreaming = csStopStreaming;
  window.csConnectWebSocket = csConnectWebSocket;
  window.csSetupIPCStreaming = csSetupIPCStreaming;
  window.initChatStreaming = initChatStreaming;
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatStreaming);
  } else {
    initChatStreaming();
  }
}
