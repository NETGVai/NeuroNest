// @ts-nocheck
/**
 * Enhanced Chat Input — file attachments, slash commands, auto-resize, and smart send.
 *
 * Features:
 * - Auto-resizing textarea (1-8 lines, then scroll)
 * - Enter to send, Shift+Enter for newline
 * - File attachment button with drag-drop overlay
 * - Attached file chips (filename, size, remove button)
 * - Slash command autocomplete (/new, /clear, /plan, /loop, /help)
 * - Loading spinner on send button during processing
 * - Character counter with warning at 90%
 *
 * Requirements: 18.1-18.9
 *
 * Plain-JS contract: var, no type annotations, no non-null assertions.
 */

/* ─── Constants ──────────────────────────────────────────────── */

var CIE_MAX_LINES = 8;
var CIE_LINE_HEIGHT = 21; // px per line (14px font * 1.5 line-height)
var CIE_MIN_HEIGHT = 24;  // single line
var CIE_MAX_HEIGHT = 200; // 8 lines with overflow
var CIE_MAX_CHARS = 32000;
var CIE_WARN_PERCENT = 0.9;

var CIE_SLASH_COMMANDS = [
  { name: '/new', description: 'Start a new conversation' },
  { name: '/clear', description: 'Clear chat history' },
  { name: '/plan', description: 'Enter plan mode' },
  { name: '/loop', description: 'Start an automation loop' },
  { name: '/help', description: 'Show available commands' }
];

var _cieAttachedFiles = [];
var _cieSlashVisible = false;
var _cieSlashIndex = 0;
var _cieFiltered = [];
var _cieIsProcessing = false;

/* ─── Styles (injected once) ─────────────────────────────────── */

function _cieInjectStyles() {
  if (document.getElementById('chat-input-enhanced-css')) return;
  var style = document.createElement('style');
  style.id = 'chat-input-enhanced-css';
  style.textContent = [
    /* Auto-resize textarea */
    '#chat-input.cie-enhanced {',
    '  min-height: ' + CIE_MIN_HEIGHT + 'px;',
    '  max-height: ' + CIE_MAX_HEIGHT + 'px;',
    '  overflow-y: auto;',
    '  resize: none;',
    '  line-height: 1.5;',
    '  transition: height 0.1s ease;',
    '}',

    /* Drag-drop overlay */
    '.cie-drop-overlay {',
    '  position: absolute;',
    '  inset: 0;',
    '  background: rgba(0, 122, 255, 0.1);',
    '  border: 2px dashed var(--accent);',
    '  border-radius: var(--radius);',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  font-size: 14px;',
    '  font-weight: 600;',
    '  color: var(--accent);',
    '  z-index: 50;',
    '  pointer-events: none;',
    '  opacity: 0;',
    '  transition: opacity var(--motion-quick);',
    '}',
    '.cie-drop-overlay.visible {',
    '  opacity: 1;',
    '}',

    /* File chips */
    '.cie-file-chips {',
    '  display: flex;',
    '  flex-wrap: wrap;',
    '  gap: 6px;',
    '  padding: 6px 0 2px;',
    '}',
    '.cie-file-chip {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  background: var(--surface-container-high);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-xs);',
    '  padding: 4px 8px;',
    '  font-size: 11px;',
    '  color: var(--text-secondary);',
    '  max-width: 200px;',
    '}',
    '.cie-file-chip-name {',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '  white-space: nowrap;',
    '  font-weight: 500;',
    '  color: var(--text-primary);',
    '}',
    '.cie-file-chip-size {',
    '  color: var(--text-dim);',
    '  font-size: 10px;',
    '}',
    '.cie-file-chip-remove {',
    '  background: none;',
    '  border: none;',
    '  color: var(--text-dim);',
    '  cursor: pointer;',
    '  font-size: 14px;',
    '  line-height: 1;',
    '  padding: 0 2px;',
    '  border-radius: 3px;',
    '  transition: color var(--motion-quick), background var(--motion-quick);',
    '}',
    '.cie-file-chip-remove:hover {',
    '  color: var(--red);',
    '  background: var(--red-container);',
    '}',

    /* Slash command dropdown */
    '.cie-slash-dropdown {',
    '  position: absolute;',
    '  bottom: 100%;',
    '  left: 0;',
    '  right: 0;',
    '  margin-bottom: 4px;',
    '  background: var(--bg-sidebar);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  overflow: hidden;',
    '  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.3);',
    '  z-index: 200;',
    '  display: none;',
    '}',
    '.cie-slash-dropdown.visible {',
    '  display: block;',
    '}',
    '.cie-slash-item {',
    '  padding: 8px 12px;',
    '  cursor: pointer;',
    '  display: flex;',
    '  justify-content: space-between;',
    '  align-items: center;',
    '  transition: background var(--motion-quick);',
    '}',
    '.cie-slash-item:hover, .cie-slash-item.selected {',
    '  background: rgba(0, 122, 255, 0.12);',
    '}',
    '.cie-slash-item-name {',
    '  color: var(--accent);',
    '  font-weight: 600;',
    '  font-size: 13px;',
    '  font-family: "SF Mono", Menlo, monospace;',
    '}',
    '.cie-slash-item-desc {',
    '  color: var(--text-dim);',
    '  font-size: 12px;',
    '}',

    /* Character counter */
    '.cie-char-counter {',
    '  position: absolute;',
    '  bottom: -18px;',
    '  right: 60px;',
    '  font-size: 10px;',
    '  color: var(--text-dim);',
    '  transition: color var(--motion-quick);',
    '  pointer-events: none;',
    '}',
    '.cie-char-counter.warning {',
    '  color: var(--yellow);',
    '  font-weight: 600;',
    '}',
    '.cie-char-counter.over {',
    '  color: var(--red);',
    '  font-weight: 700;',
    '}',

    /* Send button spinner */
    '#send-btn.cie-loading {',
    '  pointer-events: none;',
    '  position: relative;',
    '}',
    '#send-btn.cie-loading::after {',
    '  content: "";',
    '  position: absolute;',
    '  inset: 6px;',
    '  border: 2px solid rgba(255, 255, 255, 0.3);',
    '  border-top-color: #fff;',
    '  border-radius: 50%;',
    '  animation: cie-spin 0.6s linear infinite;',
    '}',
    '#send-btn.cie-loading .cie-arrow-text {',
    '  opacity: 0;',
    '}',
    '@keyframes cie-spin {',
    '  from { transform: rotate(0deg); }',
    '  to { transform: rotate(360deg); }',
    '}',
  ].join('\n');
  document.head.appendChild(style);
}

/* ─── Auto-resize Textarea ───────────────────────────────────── */

function _cieAutoResize(textarea) {
  if (!textarea) return;
  // Reset height to auto to get the correct scrollHeight
  textarea.style.height = 'auto';
  var newHeight = Math.min(textarea.scrollHeight, CIE_MAX_HEIGHT);
  newHeight = Math.max(newHeight, CIE_MIN_HEIGHT);
  textarea.style.height = newHeight + 'px';
  textarea.style.overflowY = textarea.scrollHeight > CIE_MAX_HEIGHT ? 'auto' : 'hidden';
}

/* ─── File Attachment ────────────────────────────────────────── */

function _cieFormatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function _cieAddFiles(files) {
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    // Avoid duplicates
    var isDuplicate = false;
    for (var j = 0; j < _cieAttachedFiles.length; j++) {
      if (_cieAttachedFiles[j].name === file.name && _cieAttachedFiles[j].size === file.size) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      _cieAttachedFiles.push(file);
    }
  }
  _cieRenderChips();
}

function _cieRemoveFile(index) {
  _cieAttachedFiles.splice(index, 1);
  _cieRenderChips();
}

function _cieRenderChips() {
  var container = document.getElementById('cie-file-chips');
  if (!container) return;

  if (_cieAttachedFiles.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'flex';
  var html = '';
  for (var i = 0; i < _cieAttachedFiles.length; i++) {
    var f = _cieAttachedFiles[i];
    html += '<div class="cie-file-chip">' +
      '<span class="cie-file-chip-name" title="' + f.name + '">' + f.name + '</span>' +
      '<span class="cie-file-chip-size">' + _cieFormatFileSize(f.size) + '</span>' +
      '<button class="cie-file-chip-remove" aria-label="Remove ' + f.name + '" data-index="' + i + '">\u00D7</button>' +
      '</div>';
  }
  container.innerHTML = html;

  // Attach remove handlers
  var removeButtons = container.querySelectorAll('.cie-file-chip-remove');
  for (var k = 0; k < removeButtons.length; k++) {
    removeButtons[k].addEventListener('click', function(e) {
      var idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      _cieRemoveFile(idx);
    });
  }
}

function cieGetAttachedFiles() {
  return _cieAttachedFiles.slice();
}

function cieClearAttachedFiles() {
  _cieAttachedFiles = [];
  _cieRenderChips();
}

/* ─── Slash Command Autocomplete ─────────────────────────────── */

function _cieShowSlash(filter) {
  var dropdown = document.getElementById('cie-slash-dropdown');
  if (!dropdown) return;

  var term = (filter || '').toLowerCase();
  _cieFiltered = CIE_SLASH_COMMANDS.filter(function(cmd) {
    return cmd.name.indexOf(term) === 0 || cmd.name.indexOf('/' + term) === 0;
  });

  if (_cieFiltered.length === 0) {
    _cieHideSlash();
    return;
  }

  _cieSlashIndex = 0;
  _cieSlashVisible = true;
  dropdown.classList.add('visible');
  _cieRenderSlash();
}

function _cieHideSlash() {
  var dropdown = document.getElementById('cie-slash-dropdown');
  if (dropdown) dropdown.classList.remove('visible');
  _cieSlashVisible = false;
  _cieSlashIndex = 0;
  _cieFiltered = [];
}

function _cieRenderSlash() {
  var dropdown = document.getElementById('cie-slash-dropdown');
  if (!dropdown) return;

  var html = '';
  for (var i = 0; i < _cieFiltered.length; i++) {
    var cmd = _cieFiltered[i];
    var cls = i === _cieSlashIndex ? 'cie-slash-item selected' : 'cie-slash-item';
    html += '<div class="' + cls + '" data-index="' + i + '">' +
      '<span class="cie-slash-item-name">' + cmd.name + '</span>' +
      '<span class="cie-slash-item-desc">' + cmd.description + '</span>' +
      '</div>';
  }
  dropdown.innerHTML = html;

  // Attach click handlers
  var items = dropdown.querySelectorAll('.cie-slash-item');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', function(e) {
      var idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      _cieSelectSlashCommand(idx);
    });
  }
}

function _cieSelectSlashCommand(index) {
  if (index < 0 || index >= _cieFiltered.length) return;
  var cmd = _cieFiltered[index];
  var input = document.getElementById('chat-input');
  if (input) {
    input.value = cmd.name + ' ';
    input.focus();
    _cieAutoResize(input);
    _cieUpdateCharCounter(input);
  }
  _cieHideSlash();
}

/* ─── Character Counter ──────────────────────────────────────── */

function _cieUpdateCharCounter(textarea) {
  var counter = document.getElementById('cie-char-counter');
  if (!counter || !textarea) return;

  var len = textarea.value.length;
  if (len === 0) {
    counter.style.display = 'none';
    return;
  }

  counter.style.display = 'block';
  counter.textContent = len + ' / ' + CIE_MAX_CHARS;

  counter.classList.remove('warning', 'over');
  if (len > CIE_MAX_CHARS) {
    counter.classList.add('over');
  } else if (len >= CIE_MAX_CHARS * CIE_WARN_PERCENT) {
    counter.classList.add('warning');
  }
}

/* ─── Send Button Spinner ────────────────────────────────────── */

function cieSetProcessing(isProcessing) {
  _cieIsProcessing = isProcessing;
  var sendBtn = document.getElementById('send-btn');
  if (!sendBtn) return;

  if (isProcessing) {
    sendBtn.classList.add('cie-loading');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="cie-arrow-text">\u2191</span>';
  } else {
    sendBtn.classList.remove('cie-loading');
    sendBtn.disabled = false;
    sendBtn.innerHTML = '\u2191';
  }
}

function cieIsProcessing() {
  return _cieIsProcessing;
}

/* ─── Keyboard Handling ──────────────────────────────────────── */

function _cieHandleKeyDown(e) {
  var textarea = e.target;

  // Slash command navigation
  if (_cieSlashVisible) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _cieSlashIndex = Math.min(_cieSlashIndex + 1, _cieFiltered.length - 1);
      _cieRenderSlash();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _cieSlashIndex = Math.max(_cieSlashIndex - 1, 0);
      _cieRenderSlash();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      _cieSelectSlashCommand(_cieSlashIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _cieHideSlash();
      return;
    }
  }

  // Enter to send, Shift+Enter for newline
  if (e.key === 'Enter' && !e.shiftKey && !_cieSlashVisible) {
    // Let the existing send handler handle it (do not prevent default here,
    // the app's index.ts already has Enter → send logic).
    // We just ensure we don't interfere with slash commands.
    return;
  }
}

function _cieHandleInput(e) {
  var textarea = e.target;
  _cieAutoResize(textarea);
  _cieUpdateCharCounter(textarea);

  // Slash command detection
  var val = textarea.value;
  if (val.indexOf('/') === 0 && val.indexOf('\n') === -1) {
    _cieShowSlash(val);
  } else {
    _cieHideSlash();
  }
}

/* ─── Drag and Drop ──────────────────────────────────────────── */

var _cieDragCounter = 0;

function _cieSetupDragDrop(mainContent) {
  if (!mainContent) return;

  // Create drop overlay
  var overlay = document.createElement('div');
  overlay.className = 'cie-drop-overlay';
  overlay.innerHTML = '\uD83D\uDCC2 Drop files here to attach';
  overlay.id = 'cie-drop-overlay';
  // Insert into input-bar for relative positioning
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.style.position = 'relative';
    inputBar.appendChild(overlay);
  }

  mainContent.addEventListener('dragenter', function(e) {
    e.preventDefault();
    _cieDragCounter++;
    var ov = document.getElementById('cie-drop-overlay');
    if (ov) ov.classList.add('visible');
  });

  mainContent.addEventListener('dragleave', function(e) {
    e.preventDefault();
    _cieDragCounter--;
    if (_cieDragCounter <= 0) {
      _cieDragCounter = 0;
      var ov = document.getElementById('cie-drop-overlay');
      if (ov) ov.classList.remove('visible');
    }
  });

  mainContent.addEventListener('dragover', function(e) {
    e.preventDefault();
  });

  mainContent.addEventListener('drop', function(e) {
    e.preventDefault();
    _cieDragCounter = 0;
    var ov = document.getElementById('cie-drop-overlay');
    if (ov) ov.classList.remove('visible');

    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      _cieAddFiles(e.dataTransfer.files);
    }
  });
}

/* ─── Initialization ─────────────────────────────────────────── */

function initChatInputEnhanced() {
  _cieInjectStyles();

  var textarea = document.getElementById('chat-input');
  var inputWrapper = document.getElementById('input-wrapper');
  var mainContent = document.getElementById('main-content');

  if (!textarea || !inputWrapper) {
    console.warn('[ChatInputEnhanced] Missing #chat-input or #input-wrapper');
    return;
  }

  // Add enhanced class for styling
  textarea.classList.add('cie-enhanced');

  // Create file chips container (above input wrapper)
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    var chipsContainer = document.getElementById('cie-file-chips');
    if (!chipsContainer) {
      chipsContainer = document.createElement('div');
      chipsContainer.id = 'cie-file-chips';
      chipsContainer.className = 'cie-file-chips';
      chipsContainer.style.display = 'none';
      inputBar.insertBefore(chipsContainer, inputWrapper);
    }
  }

  // Create slash command dropdown (inside input wrapper for absolute positioning)
  var slashDropdown = document.getElementById('cie-slash-dropdown');
  if (!slashDropdown) {
    slashDropdown = document.createElement('div');
    slashDropdown.id = 'cie-slash-dropdown';
    slashDropdown.className = 'cie-slash-dropdown';
    inputWrapper.appendChild(slashDropdown);
  }

  // Create character counter
  var charCounter = document.getElementById('cie-char-counter');
  if (!charCounter) {
    charCounter = document.createElement('div');
    charCounter.id = 'cie-char-counter';
    charCounter.className = 'cie-char-counter';
    charCounter.style.display = 'none';
    inputWrapper.appendChild(charCounter);
  }

  // Wire up textarea events
  textarea.addEventListener('keydown', _cieHandleKeyDown);
  textarea.addEventListener('input', _cieHandleInput);

  // Wire up file attachment button (existing #chat-attach-btn)
  var attachBtn = document.getElementById('chat-attach-btn');
  var fileInput = document.getElementById('chat-attach-file');
  if (attachBtn && fileInput) {
    // Re-wire to use our file chip system
    fileInput.addEventListener('change', function(e) {
      if (e.target.files && e.target.files.length > 0) {
        _cieAddFiles(e.target.files);
        // Reset the input so same file can be re-selected
        e.target.value = '';
      }
    });
  }

  // Setup drag-drop
  _cieSetupDragDrop(mainContent);

  // Initial auto-resize
  _cieAutoResize(textarea);

  console.log('[ChatInputEnhanced] Initialized - auto-resize, slash commands, file chips, char counter');
}

/* ─── Exports ────────────────────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.initChatInputEnhanced = initChatInputEnhanced;
  window.cieSetProcessing = cieSetProcessing;
  window.cieIsProcessing = cieIsProcessing;
  window.cieGetAttachedFiles = cieGetAttachedFiles;
  window.cieClearAttachedFiles = cieClearAttachedFiles;
  window.cieAddFiles = _cieAddFiles;
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatInputEnhanced);
  } else {
    initChatInputEnhanced();
  }
}
