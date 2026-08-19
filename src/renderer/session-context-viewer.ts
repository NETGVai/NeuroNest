// @ts-nocheck
/**
 * SessionContextViewer — Channel session context management panel.
 *
 * Accessible from the Chat Panel toolbar via a "Sessions" button.
 * Displays active channel sessions (channelId + senderId + last activity),
 * allows viewing message history for a selected session, and clearing
 * individual session contexts.
 *
 * Features:
 * - Session list: shows all active channel sessions grouped by channel
 * - Session detail: message history view for a selected channel-sender pair
 * - Clear Context: per-session action button to clear conversation history
 * - Auto-refresh: session list refreshes when new inbound messages arrive
 *
 * Uses window.electronAPI.invoke(channel, args) for IPC.
 * Uses window.wk namespace utilities (toast, confirm, emptyState, badge).
 *
 * IPC channels:
 * - list-active-sessions → returns SessionListItem[]
 * - get-session-info → returns SessionEntry (full history)
 * - clear-session-context → clears session for a channel-sender pair
 *
 * Renderer constraint: Plain JavaScript (var declarations, no type annotations).
 *
 * Task 13.2 (enhanced-chat-ui): the auto-refresh handler subscribes to the
 * legacy `chat-response` IPC channel ONLY to detect the arrival of a
 * channel-sourced inbound message so it can refresh the session list. The
 * subscription is an unrelated diagnostic surface, not a chat rendering
 * fallback: it never reads the message body and never mutates chat DOM.
 * Production chat content flows exclusively through the canonical
 * projection integration; this viewer's `chat-response` listener continues
 * to work because the compatibility ingress in the main process still
 * publishes the channel for main-side subscribers.
 *
 * Requirements: 5.4, 5.5
 */

(function () {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────

  function api() { return window.electronAPI; }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function relTime(ts) {
    if (!ts) return 'unknown';
    var diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    if (diff < 0) diff = 0;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function disableBtn(btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
  function enableBtn(btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }

  // ─── Inject Panel Styles ─────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'session-viewer-styles';
  styleEl.textContent = [
    '.scv-panel{padding:16px;height:100%;overflow-y:auto;font-family:var(--font-family,-apple-system,BlinkMacSystemFont,sans-serif);}',
    '.scv-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
    '.scv-title{margin:0;font-size:16px;font-weight:600;color:var(--text-primary);}',
    '.scv-back-btn{background:none;border:none;color:var(--accent);cursor:pointer;font-size:13px;padding:4px 8px;border-radius:var(--radius-sm);}',
    '.scv-back-btn:hover{background:var(--surface-container-high);}',
    '.scv-session-list{list-style:none;padding:0;margin:0;}',
    '.scv-session-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:8px;cursor:pointer;transition:border-color var(--motion-quick,150ms);}',
    '.scv-session-item:hover{border-color:var(--accent);}',
    '.scv-session-info{flex:1;min-width:0;}',
    '.scv-session-channel{font-size:13px;font-weight:500;color:var(--text-primary);display:flex;align-items:center;gap:6px;}',
    '.scv-session-meta{font-size:11px;color:var(--text-secondary);margin-top:3px;}',
    '.scv-session-actions{display:flex;gap:6px;align-items:center;flex-shrink:0;}',
    '.scv-msg-count{font-size:10px;color:var(--text-dim);background:var(--surface-container-highest);padding:2px 6px;border-radius:10px;}',
    '.scv-detail-header{display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border-color);}',
    '.scv-detail-title{font-size:14px;font-weight:500;color:var(--text-primary);}',
    '.scv-messages{display:flex;flex-direction:column;gap:8px;padding-bottom:16px;}',
    '.scv-msg{padding:8px 12px;border-radius:var(--radius-sm);max-width:85%;word-break:break-word;font-size:12px;line-height:1.5;}',
    '.scv-msg-user{background:var(--accent-container,rgba(99,102,241,0.1));align-self:flex-end;color:var(--text-primary);}',
    '.scv-msg-assistant{background:var(--surface-container-high);align-self:flex-start;color:var(--text-primary);}',
    '.scv-msg-role{font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:3px;text-transform:uppercase;}',
    '.scv-msg-time{font-size:9px;color:var(--text-dim);margin-top:4px;}',
    '.scv-loading{text-align:center;padding:48px 24px;color:var(--text-secondary);}',
    '@keyframes scvPulse{0%,100%{opacity:0.6}50%{opacity:1}}',
    '.scv-loading-icon{font-size:24px;animation:scvPulse 1.2s infinite;}',
    '.scv-status-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface-container-high);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:12px;font-size:11px;color:var(--text-secondary);}',
  ].join('\n');
  if (!document.getElementById('session-viewer-styles')) {
    document.head.appendChild(styleEl);
  }

  // ─── SessionContextViewer class ───────────────────────────────────

  function SessionContextViewer(container, options) {
    this.container = container;
    this.sessions = [];
    this.selectedSession = null;
    this.isLoading = false;
    this.contentEl = null;
    this.unsubscribe = null;
  }

  SessionContextViewer.prototype.render = function () {
    var self = this;
    this.container.innerHTML = '';
    this.container.className = 'scv-panel wk-scroll';

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'scv-header';

    var title = document.createElement('h3');
    title.className = 'scv-title';
    title.textContent = 'Channel Sessions';
    header.appendChild(title);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'wk-btn-secondary';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.style.fontSize = '11px';
    refreshBtn.style.padding = '4px 10px';
    refreshBtn.setAttribute('aria-label', 'Refresh session list');
    refreshBtn.addEventListener('click', function () {
      disableBtn(refreshBtn);
      self.loadSessions();
      setTimeout(function () { enableBtn(refreshBtn); }, 1000);
    });
    header.appendChild(refreshBtn);

    this.container.appendChild(header);

    // ── Content area ──
    this.contentEl = document.createElement('div');
    this.container.appendChild(this.contentEl);

    // ── Load data ──
    this.loadSessions();

    // ── Auto-refresh: subscribe to chat-response for inbound messages ──
    this.subscribeToUpdates();
  };

  // ─── Data Loading ────────────────────────────────────────────────

  SessionContextViewer.prototype.loadSessions = function () {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    self.isLoading = true;
    self.renderLoading();

    eapi.invoke('list-active-sessions').then(function (result) {
      self.isLoading = false;
      self.sessions = result || [];
      self.renderSessionList();
    }).catch(function (err) {
      self.isLoading = false;
      self.sessions = [];
      self.renderSessionList();
      if (typeof wk !== 'undefined' && wk.toast) {
        wk.toast('Failed to load sessions: ' + (err.message || 'Unknown error'), 'error');
      }
    });
  };

  SessionContextViewer.prototype.loadSessionDetail = function (channelId, senderId) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    self.isLoading = true;
    self.renderLoading();

    eapi.invoke('get-session-info', { channelId: channelId, senderId: senderId }).then(function (session) {
      self.isLoading = false;
      self.selectedSession = session;
      self.renderSessionDetail(channelId, senderId, session);
    }).catch(function (err) {
      self.isLoading = false;
      self.renderSessionDetail(channelId, senderId, null);
      if (typeof wk !== 'undefined' && wk.toast) {
        wk.toast('Failed to load session: ' + (err.message || 'Unknown error'), 'error');
      }
    });
  };

  // ─── Render States ───────────────────────────────────────────────

  SessionContextViewer.prototype.renderLoading = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '<div class="scv-loading"><div class="scv-loading-icon">💬</div><div>Loading sessions...</div></div>';
  };

  SessionContextViewer.prototype.renderSessionList = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '';

    if (!this.sessions || this.sessions.length === 0) {
      var emptyMsg = 'No active channel sessions.';
      var emptyHint = 'Sessions appear when messages arrive from connected channels.';
      if (typeof wk !== 'undefined' && wk.emptyState) {
        this.contentEl.appendChild(wk.emptyState('💬', emptyMsg, emptyHint));
      } else {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'scv-loading';
        emptyDiv.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">💬</div><div>' + escHtml(emptyMsg) + '</div><div style="font-size:11px;color:var(--text-dim);margin-top:4px;">' + escHtml(emptyHint) + '</div>';
        this.contentEl.appendChild(emptyDiv);
      }
      return;
    }

    // Status bar
    var statusBar = document.createElement('div');
    statusBar.className = 'scv-status-bar';
    statusBar.textContent = this.sessions.length + ' active session' + (this.sessions.length !== 1 ? 's' : '');
    this.contentEl.appendChild(statusBar);

    // Session list
    var list = document.createElement('div');
    list.className = 'scv-session-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Active channel sessions');

    var self = this;
    for (var i = 0; i < this.sessions.length; i++) {
      list.appendChild(this.renderSessionItem(this.sessions[i]));
    }

    this.contentEl.appendChild(list);
  };

  SessionContextViewer.prototype.renderSessionItem = function (session) {
    var self = this;

    var item = document.createElement('div');
    item.className = 'scv-session-item';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', 'Session: ' + session.channelId + ' - ' + session.senderId);

    // ── Info section ──
    var infoDiv = document.createElement('div');
    infoDiv.className = 'scv-session-info';

    var channelRow = document.createElement('div');
    channelRow.className = 'scv-session-channel';
    channelRow.textContent = session.channelId;
    infoDiv.appendChild(channelRow);

    var metaRow = document.createElement('div');
    metaRow.className = 'scv-session-meta';
    metaRow.textContent = session.senderId + ' · ' + relTime(session.lastActivity);
    infoDiv.appendChild(metaRow);

    item.appendChild(infoDiv);

    // ── Actions section ──
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'scv-session-actions';

    // Message count badge
    var countBadge = document.createElement('span');
    countBadge.className = 'scv-msg-count';
    countBadge.textContent = (session.messageCount || 0) + ' msgs';
    actionsDiv.appendChild(countBadge);

    // Clear button
    var clearBtn = document.createElement('button');
    clearBtn.className = 'wk-btn-danger';
    clearBtn.style.cssText = 'padding:3px 8px;font-size:10px;';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear session context';
    clearBtn.setAttribute('aria-label', 'Clear context for ' + session.channelId + ' - ' + session.senderId);
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.clearSession(session.channelId, session.senderId, item);
    });
    actionsDiv.appendChild(clearBtn);

    item.appendChild(actionsDiv);

    // ── Click to view detail ──
    item.addEventListener('click', function () {
      self.loadSessionDetail(session.channelId, session.senderId);
    });

    return item;
  };

  SessionContextViewer.prototype.renderSessionDetail = function (channelId, senderId, session) {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = '';

    var self = this;

    // ── Back button + header ──
    var headerDiv = document.createElement('div');
    headerDiv.className = 'scv-detail-header';

    var backBtn = document.createElement('button');
    backBtn.className = 'scv-back-btn';
    backBtn.textContent = '← Back';
    backBtn.setAttribute('aria-label', 'Back to session list');
    backBtn.addEventListener('click', function () {
      self.selectedSession = null;
      self.renderSessionList();
    });
    headerDiv.appendChild(backBtn);

    var titleEl = document.createElement('span');
    titleEl.className = 'scv-detail-title';
    titleEl.textContent = channelId + ' · ' + senderId;
    headerDiv.appendChild(titleEl);

    this.contentEl.appendChild(headerDiv);

    // ── Clear context button for this session ──
    var actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:12px;';

    var clearBtn = document.createElement('button');
    clearBtn.className = 'wk-btn-danger';
    clearBtn.style.cssText = 'padding:4px 12px;font-size:11px;';
    clearBtn.textContent = 'Clear Context';
    clearBtn.setAttribute('aria-label', 'Clear session context');
    clearBtn.addEventListener('click', function () {
      self.clearSession(channelId, senderId, null);
    });
    actionBar.appendChild(clearBtn);
    this.contentEl.appendChild(actionBar);

    // ── Message history ──
    if (!session || !session.messages || session.messages.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'scv-loading';
      emptyDiv.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">📭</div><div>No messages in this session.</div>';
      this.contentEl.appendChild(emptyDiv);
      return;
    }

    var messagesDiv = document.createElement('div');
    messagesDiv.className = 'scv-messages';

    for (var i = 0; i < session.messages.length; i++) {
      var msg = session.messages[i];
      var msgEl = document.createElement('div');
      msgEl.className = 'scv-msg scv-msg-' + msg.role;

      var roleEl = document.createElement('div');
      roleEl.className = 'scv-msg-role';
      roleEl.textContent = msg.role === 'user' ? 'User' : 'Assistant';
      msgEl.appendChild(roleEl);

      var contentEl = document.createElement('div');
      contentEl.textContent = msg.content;
      msgEl.appendChild(contentEl);

      if (msg.timestamp) {
        var timeEl = document.createElement('div');
        timeEl.className = 'scv-msg-time';
        timeEl.textContent = relTime(msg.timestamp);
        msgEl.appendChild(timeEl);
      }

      messagesDiv.appendChild(msgEl);
    }

    this.contentEl.appendChild(messagesDiv);
  };

  // ─── Actions ─────────────────────────────────────────────────────

  SessionContextViewer.prototype.clearSession = function (channelId, senderId, itemEl) {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    var doIt = function () {
      eapi.invoke('clear-session-context', { channelId: channelId, senderId: senderId }).then(function (result) {
        if (result && result.success) {
          if (typeof wk !== 'undefined' && wk.toast) {
            wk.toast('Session context cleared', 'success');
          }
          // Remove from local list
          self.sessions = self.sessions.filter(function (s) {
            return !(s.channelId === channelId && s.senderId === senderId);
          });
          // If viewing detail, go back to list
          if (self.selectedSession) {
            self.selectedSession = null;
          }
          self.renderSessionList();
        } else {
          if (typeof wk !== 'undefined' && wk.toast) {
            wk.toast('Failed to clear session', 'error');
          }
        }
      }).catch(function (err) {
        if (typeof wk !== 'undefined' && wk.toast) {
          wk.toast('Clear failed: ' + (err.message || 'Unknown error'), 'error');
        }
      });
    };

    // Use confirm dialog if wk.confirm is available
    if (typeof wk !== 'undefined' && wk.confirm && itemEl) {
      var confirmEl = wk.confirm('Clear this session? Conversation history will be lost.', doIt);
      itemEl.appendChild(confirmEl);
    } else {
      doIt();
    }
  };

  // ─── Auto-refresh subscription ───────────────────────────────────

  SessionContextViewer.prototype.subscribeToUpdates = function () {
    var self = this;
    var eapi = api();
    if (!eapi) return;

    // Task 13.2: this listener is an unrelated diagnostic — it reads only
    // the `isChannelMessage` marker and never renders chat content. The
    // canonical projection integration remains the sole chat rendering
    // input. See the file header for the retention rationale.
    var handler = function (data) {
      // Refresh session list when a channel-sourced message arrives
      if (data && data.isChannelMessage) {
        self.loadSessions();
      }
    };

    eapi.on('chat-response', handler);
    self.unsubscribe = function () {
      eapi.removeListener('chat-response', handler);
    };
  };

  // ─── Cleanup ─────────────────────────────────────────────────────

  SessionContextViewer.prototype.destroy = function () {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.container) this.container.innerHTML = '';
    this.sessions = [];
    this.selectedSession = null;
  };

  // ─── Export ──────────────────────────────────────────────────────

  window.SessionContextViewer = SessionContextViewer;

})();
