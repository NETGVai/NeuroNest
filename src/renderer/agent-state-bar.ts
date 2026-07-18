// @ts-nocheck
/**
 * Agent State Bar — Status bar above chat input showing agent state and controls.
 *
 * Features:
 * - Status bar above input showing agent state (idle/thinking/executing/verifying/blocked)
 * - State-specific icons and colors with pulse animation for "thinking"
 * - Stop button during active execution
 * - Inline approval cards for permission/plan requests (Accept/Reject buttons)
 * - Retry button on failed messages
 *
 * Requirements: 19.1-19.6
 *
 * Plain-JS contract: var, no type annotations, no non-null assertions.
 */

/* ─── State Definitions ──────────────────────────────────────── */

var ASB_STATES = {
  idle: { label: 'Idle', color: 'var(--text-dim)', icon: '●', pulse: false },
  thinking: { label: 'Thinking', color: 'var(--accent)', icon: '●', pulse: true },
  executing: { label: 'Executing', color: 'var(--green)', icon: '●', pulse: false },
  verifying: { label: 'Verifying', color: 'var(--yellow)', icon: '●', pulse: false },
  'awaiting-approval': { label: 'Awaiting Approval', color: 'var(--yellow)', icon: '●', pulse: true },
  blocked: { label: 'Blocked', color: 'var(--red)', icon: '●', pulse: false }
};

var _asbCurrentState = 'idle';
var _asbDescription = '';
var _asbBarEl = null;
var _asbInitialized = false;

/* ─── Styles (injected once) ─────────────────────────────────── */

function _asbInjectStyles() {
  if (document.getElementById('agent-state-bar-css')) return;
  var style = document.createElement('style');
  style.id = 'agent-state-bar-css';
  style.textContent = [
    /* State bar container */
    '.asb-bar {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 10px;',
    '  padding: 6px 16px;',
    '  background: var(--surface-container);',
    '  border: 1px solid var(--border-color);',
    '  border-radius: var(--radius-sm);',
    '  margin: 0 16px 6px;',
    '  font-size: 12px;',
    '  transition: opacity var(--motion-quick), transform var(--motion-quick);',
    '  min-height: 32px;',
    '}',
    '.asb-bar.asb-hidden {',
    '  opacity: 0;',
    '  transform: translateY(4px);',
    '  pointer-events: none;',
    '  height: 0;',
    '  min-height: 0;',
    '  padding: 0 16px;',
    '  margin: 0 16px;',
    '  overflow: hidden;',
    '  border: none;',
    '}',

    /* State indicator (left) */
    '.asb-indicator {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  flex-shrink: 0;',
    '}',
    '.asb-dot {',
    '  font-size: 10px;',
    '  line-height: 1;',
    '  transition: color var(--motion-quick);',
    '}',
    '.asb-dot.asb-pulse {',
    '  animation: asbPulse 1.5s ease-in-out infinite;',
    '}',
    '@keyframes asbPulse {',
    '  0%, 100% { opacity: 1; transform: scale(1); }',
    '  50% { opacity: 0.4; transform: scale(0.85); }',
    '}',
    '.asb-state-label {',
    '  font-weight: 600;',
    '  color: var(--text-primary);',
    '  white-space: nowrap;',
    '}',

    /* Activity description (center) */
    '.asb-description {',
    '  flex: 1;',
    '  color: var(--text-secondary);',
    '  font-size: 11px;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '  white-space: nowrap;',
    '  min-width: 0;',
    '}',

    /* Stop button (right) */
    '.asb-stop-btn {',
    '  flex-shrink: 0;',
    '  background: transparent;',
    '  border: 1px solid var(--red);',
    '  color: var(--red);',
    '  border-radius: var(--radius-xs);',
    '  padding: 3px 10px;',
    '  font-size: 11px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '  display: none;',
    '}',
    '.asb-stop-btn:hover {',
    '  background: var(--red);',
    '  color: #fff;',
    '}',
    '.asb-stop-btn.asb-visible {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '}',

    /* Inline approval card */
    '.asb-approval-card {',
    '  background: var(--surface-container-high);',
    '  border: 1px solid var(--yellow);',
    '  border-radius: var(--radius-sm);',
    '  padding: 12px 16px;',
    '  margin: 8px 0;',
    '  animation: asbSlideIn 0.2s ease;',
    '}',
    '@keyframes asbSlideIn {',
    '  from { opacity: 0; transform: translateY(8px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    '.asb-approval-header {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '  margin-bottom: 8px;',
    '  font-size: 12px;',
    '  font-weight: 600;',
    '  color: var(--text-primary);',
    '}',
    '.asb-approval-icon {',
    '  font-size: 16px;',
    '}',
    '.asb-approval-body {',
    '  font-size: 12px;',
    '  color: var(--text-secondary);',
    '  line-height: 1.5;',
    '  margin-bottom: 10px;',
    '  background: var(--bg-input);',
    '  border-radius: var(--radius-xs);',
    '  padding: 8px 10px;',
    '  font-family: "SF Mono", "Menlo", monospace;',
    '  max-height: 120px;',
    '  overflow-y: auto;',
    '  white-space: pre-wrap;',
    '  word-break: break-word;',
    '}',
    '.asb-approval-actions {',
    '  display: flex;',
    '  gap: 8px;',
    '}',
    '.asb-approval-accept {',
    '  background: var(--green);',
    '  color: #fff;',
    '  border: none;',
    '  border-radius: var(--radius-xs);',
    '  padding: 5px 14px;',
    '  font-size: 12px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.asb-approval-accept:hover {',
    '  filter: brightness(1.1);',
    '  transform: translateY(-1px);',
    '}',
    '.asb-approval-reject {',
    '  background: transparent;',
    '  border: 1px solid var(--red);',
    '  color: var(--red);',
    '  border-radius: var(--radius-xs);',
    '  padding: 5px 14px;',
    '  font-size: 12px;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '  transition: all var(--motion-quick);',
    '}',
    '.asb-approval-reject:hover {',
    '  background: var(--red);',
    '  color: #fff;',
    '}',

    /* Retry button on failed messages */
    '.asb-retry-btn {',
    '  background: transparent;',
    '  border: 1px solid var(--border-color);',
    '  color: var(--text-secondary);',
    '  border-radius: var(--radius-xs);',
    '  padding: 4px 10px;',
    '  font-size: 11px;',
    '  font-weight: 500;',
    '  cursor: pointer;',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  margin-top: 6px;',
    '  transition: all var(--motion-quick);',
    '}',
    '.asb-retry-btn:hover {',
    '  border-color: var(--accent);',
    '  color: var(--accent);',
    '  background: var(--accent-container);',
    '}'
  ].join('\n');
  document.head.appendChild(style);
}

/* ─── DOM Creation ───────────────────────────────────────────── */

function _asbCreateBar() {
  if (_asbBarEl) return _asbBarEl;

  var bar = document.createElement('div');
  bar.className = 'asb-bar asb-hidden';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.setAttribute('aria-label', 'Agent status');

  // Indicator (left)
  var indicator = document.createElement('div');
  indicator.className = 'asb-indicator';

  var dot = document.createElement('span');
  dot.className = 'asb-dot';
  dot.textContent = '●';
  indicator.appendChild(dot);

  var label = document.createElement('span');
  label.className = 'asb-state-label';
  label.textContent = 'Idle';
  indicator.appendChild(label);

  bar.appendChild(indicator);

  // Description (center)
  var desc = document.createElement('span');
  desc.className = 'asb-description';
  desc.textContent = '';
  bar.appendChild(desc);

  // Stop button (right)
  var stopBtn = document.createElement('button');
  stopBtn.className = 'asb-stop-btn';
  stopBtn.setAttribute('aria-label', 'Stop agent execution');
  stopBtn.innerHTML = '&#9632; Stop';
  stopBtn.addEventListener('click', function() {
    _asbHandleStop();
  });
  bar.appendChild(stopBtn);

  _asbBarEl = bar;
  return bar;
}

function _asbInsertBar() {
  if (_asbInitialized) return;
  _asbInjectStyles();

  var bar = _asbCreateBar();

  // Insert above the input-bar
  var inputBar = document.getElementById('input-bar');
  if (inputBar && inputBar.parentNode) {
    inputBar.parentNode.insertBefore(bar, inputBar);
  }

  _asbInitialized = true;
}

/* ─── State Update ───────────────────────────────────────────── */

function asbSetState(state, description) {
  if (!_asbBarEl) return;

  var stateConfig = ASB_STATES[state];
  if (!stateConfig) {
    state = 'idle';
    stateConfig = ASB_STATES.idle;
  }

  _asbCurrentState = state;
  _asbDescription = description || '';

  var dot = _asbBarEl.querySelector('.asb-dot');
  var label = _asbBarEl.querySelector('.asb-state-label');
  var desc = _asbBarEl.querySelector('.asb-description');
  var stopBtn = _asbBarEl.querySelector('.asb-stop-btn');

  // Update dot color and pulse
  if (dot) {
    dot.style.color = stateConfig.color;
    if (stateConfig.pulse) {
      dot.classList.add('asb-pulse');
    } else {
      dot.classList.remove('asb-pulse');
    }
  }

  // Update label
  if (label) {
    label.textContent = stateConfig.label;
    label.style.color = stateConfig.color;
  }

  // Update description
  if (desc) {
    desc.textContent = _asbDescription;
  }

  // Show/hide stop button for active states
  var isActive = (state === 'thinking' || state === 'executing' || state === 'verifying');
  if (stopBtn) {
    if (isActive) {
      stopBtn.classList.add('asb-visible');
    } else {
      stopBtn.classList.remove('asb-visible');
    }
  }

  // Show/hide entire bar
  if (state === 'idle') {
    _asbBarEl.classList.add('asb-hidden');
  } else {
    _asbBarEl.classList.remove('asb-hidden');
  }
}

/* ─── Stop Handler ───────────────────────────────────────────── */

function _asbHandleStop() {
  // Try to cancel via electronAPI
  if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
    window.electronAPI.invoke('agent:cancel', {}).then(function() {
      if (typeof window.showThemedToast === 'function') {
        window.showThemedToast('Agent execution stopped', 'info');
      }
      asbSetState('idle', '');
    }).catch(function(err) {
      if (typeof window.showThemedToast === 'function') {
        window.showThemedToast('Failed to stop: ' + (err && err.message ? err.message : String(err)), 'error');
      }
    });
  } else {
    // Fallback: just emit event and update UI
    asbSetState('idle', '');
    if (typeof window.showThemedToast === 'function') {
      window.showThemedToast('Stop requested', 'info');
    }
  }
}

/* ─── Approval Cards ─────────────────────────────────────────── */

function asbShowApprovalCard(container, options) {
  if (!container) return null;

  var card = document.createElement('div');
  card.className = 'asb-approval-card';

  // Header
  var header = document.createElement('div');
  header.className = 'asb-approval-header';

  var icon = document.createElement('span');
  icon.className = 'asb-approval-icon';
  icon.textContent = options.type === 'plan' ? '📋' : '🔐';
  header.appendChild(icon);

  var title = document.createElement('span');
  title.textContent = options.title || (options.type === 'plan' ? 'Plan Approval Required' : 'Permission Required');
  header.appendChild(title);

  card.appendChild(header);

  // Body — context about what is being approved
  var body = document.createElement('div');
  body.className = 'asb-approval-body';
  body.textContent = options.context || '';
  card.appendChild(body);

  // Actions
  var actions = document.createElement('div');
  actions.className = 'asb-approval-actions';

  var acceptBtn = document.createElement('button');
  acceptBtn.className = 'asb-approval-accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.setAttribute('aria-label', 'Accept ' + (options.title || 'request'));
  acceptBtn.addEventListener('click', function() {
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    if (options.onAccept) options.onAccept();
    setTimeout(function() {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 300);
  });
  actions.appendChild(acceptBtn);

  var rejectBtn = document.createElement('button');
  rejectBtn.className = 'asb-approval-reject';
  rejectBtn.textContent = 'Reject';
  rejectBtn.setAttribute('aria-label', 'Reject ' + (options.title || 'request'));
  rejectBtn.addEventListener('click', function() {
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    if (options.onReject) options.onReject();
    setTimeout(function() {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 300);
  });
  actions.appendChild(rejectBtn);

  card.appendChild(actions);
  container.appendChild(card);

  return card;
}

/* ─── Retry Button ───────────────────────────────────────────── */

function asbAddRetryButton(messageEl, onRetry) {
  if (!messageEl) return null;

  // Check if retry already exists
  if (messageEl.querySelector('.asb-retry-btn')) return null;

  var retryBtn = document.createElement('button');
  retryBtn.className = 'asb-retry-btn';
  retryBtn.setAttribute('aria-label', 'Retry failed message');
  retryBtn.innerHTML = '&#x21bb; Retry';
  retryBtn.addEventListener('click', function() {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';
    if (onRetry) onRetry();
  });

  // Append to message body or message element
  var body = messageEl.querySelector('.message-body') || messageEl.querySelector('.message-content') || messageEl;
  body.appendChild(retryBtn);

  return retryBtn;
}

/* ─── IPC Event Integration ──────────────────────────────────── */

function _asbListenForStateChanges() {
  // Listen for agent state change events from main process
  if (window.electronAPI && typeof window.electronAPI.receive === 'function') {
    window.electronAPI.receive('agent:state-changed', function(data) {
      var state = (data && data.state) ? data.state : 'idle';
      var desc = (data && data.description) ? data.description : '';
      asbSetState(state, desc);
    });

    window.electronAPI.receive('agent:approval-request', function(data) {
      var chatArea = document.getElementById('chat-area');
      if (chatArea) {
        asbSetState('awaiting-approval', data && data.title ? data.title : 'Approval needed');
        asbShowApprovalCard(chatArea, {
          type: (data && data.type) || 'permission',
          title: (data && data.title) || 'Permission Required',
          context: (data && data.context) || '',
          onAccept: function() {
            if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
              window.electronAPI.invoke('agent:approve', { id: data && data.id, decision: 'accept' });
            }
            asbSetState('executing', 'Resuming...');
          },
          onReject: function() {
            if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
              window.electronAPI.invoke('agent:approve', { id: data && data.id, decision: 'reject' });
            }
            asbSetState('idle', '');
          }
        });
      }
    });
  }
}

/* ─── Initialization ─────────────────────────────────────────── */

function initAgentStateBar() {
  _asbInsertBar();
  _asbListenForStateChanges();
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAgentStateBar);
} else {
  initAgentStateBar();
}

// Expose public API on window
window.asbSetState = asbSetState;
window.asbShowApprovalCard = asbShowApprovalCard;
window.asbAddRetryButton = asbAddRetryButton;
window.initAgentStateBar = initAgentStateBar;
