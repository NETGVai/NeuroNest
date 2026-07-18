// @ts-nocheck
/**
 * Event Stream Bus — Renderer-side event subscription system for IPC receive channels.
 *
 * Provides:
 * - window.subscribeEvent(channel, handler)   — subscribe to an IPC event channel
 * - window.unsubscribeEvent(channel, handler) — unsubscribe from an IPC event channel
 * - window._eventSubscriptions               — internal subscription map
 * - window.EventStreamBus                    — bus controller with status/reconnect API
 *
 * Features:
 * - Incremental rendering: handlers append new items vs full re-fetch
 * - "Live" indicator component showing real-time connection status
 * - Auto-reconnect on disconnect with visual state
 * - No polling intervals shorter than 5s as fallback
 *
 * Requirements: 16.1-16.5
 * Renderer constraint: Plain JavaScript (var, no type annotations).
 */

(function() {
  'use strict';

  // ─── Inject Styles ───────────────────────────────────────────────

  var styleEl = document.createElement('style');
  styleEl.id = 'event-stream-bus-styles';
  styleEl.textContent = [
    /* Live indicator */
    '.esb-live-indicator{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:var(--radius-full,9999px);font-size:10px;font-weight:600;letter-spacing:0.3px;transition:all var(--motion-quick,0.15s);user-select:none;}',
    '.esb-live-indicator.esb-connected{background:var(--green-container,rgba(74,222,128,0.12));color:var(--green,#4ade80);}',
    '.esb-live-indicator.esb-disconnected{background:var(--yellow-container,rgba(251,191,36,0.12));color:var(--yellow,#fbbf24);}',
    '.esb-live-indicator.esb-error{background:var(--red-container,rgba(248,113,113,0.12));color:var(--red,#f87171);}',

    /* Status dot */
    '.esb-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;transition:background var(--motion-quick,0.15s);}',
    '.esb-connected .esb-dot{background:var(--green,#4ade80);box-shadow:0 0 4px var(--green,#4ade80);}',
    '.esb-disconnected .esb-dot{background:var(--yellow,#fbbf24);animation:esb-pulse 1.5s ease-in-out infinite;}',
    '.esb-error .esb-dot{background:var(--red,#f87171);}',

    /* Pulse animation for reconnecting state */
    '@keyframes esb-pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}',

    /* Incremental item fade-in */
    '.esb-item-new{animation:esb-fade-in 0.3s ease-out;}',
    '@keyframes esb-fade-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
  ].join('\n');
  document.head.appendChild(styleEl);

  // ─── Subscription Map ────────────────────────────────────────────

  var subscriptions = new Map();
  window._eventSubscriptions = subscriptions;

  // ─── Connection State ────────────────────────────────────────────

  var STATE_CONNECTED = 'connected';
  var STATE_DISCONNECTED = 'disconnected';
  var STATE_ERROR = 'error';

  var connectionState = STATE_CONNECTED;
  var lastEventTime = Date.now();
  var reconnectTimer = null;
  var heartbeatTimer = null;
  var liveIndicators = [];

  // Fallback polling interval — must NOT be shorter than 5s (Req 16.5)
  var FALLBACK_POLL_INTERVAL = 10000; // 10s
  var HEARTBEAT_TIMEOUT = 30000; // 30s without event = disconnected
  var RECONNECT_DELAY = 5000; // 5s reconnect attempt interval

  // ─── Core Subscribe/Unsubscribe ──────────────────────────────────

  function subscribeEvent(channel, handler) {
    if (!channel || typeof handler !== 'function') return;

    if (!subscriptions.has(channel)) {
      subscriptions.set(channel, new Set());
      // Register with electronAPI if available
      registerIPCListener(channel);
    }
    subscriptions.get(channel).add(handler);
  }

  function unsubscribeEvent(channel, handler) {
    if (!channel || typeof handler !== 'function') return;

    var handlers = subscriptions.get(channel);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        subscriptions.delete(channel);
        // Could unregister IPC listener if we had a cleanup mechanism
      }
    }
  }

  // ─── IPC Listener Registration ──────────────────────────────────

  function registerIPCListener(channel) {
    // Use electronAPI.receive if available (standard pattern in this project)
    if (window.electronAPI && typeof window.electronAPI.receive === 'function') {
      window.electronAPI.receive(channel, function(data) {
        handleIncomingEvent(channel, data);
      });
    }
  }

  function handleIncomingEvent(channel, data) {
    // Update connection state
    lastEventTime = Date.now();
    if (connectionState !== STATE_CONNECTED) {
      setConnectionState(STATE_CONNECTED);
    }

    // Dispatch to all handlers
    var handlers = subscriptions.get(channel);
    if (handlers) {
      handlers.forEach(function(handler) {
        try {
          handler(data);
        } catch (err) {
          console.error('[EventStreamBus] Handler error for channel "' + channel + '":', err);
        }
      });
    }
  }

  // ─── Connection State Management ────────────────────────────────

  function setConnectionState(state) {
    connectionState = state;
    updateLiveIndicators();

    // If disconnected, start reconnect attempts
    if (state === STATE_DISCONNECTED || state === STATE_ERROR) {
      scheduleReconnect();
    } else {
      clearReconnectTimer();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(function() {
      attemptReconnect();
    }, RECONNECT_DELAY);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function attemptReconnect() {
    // Try to ping main process to verify connection
    if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
      window.electronAPI.invoke('app:ping').then(function() {
        setConnectionState(STATE_CONNECTED);
      }).catch(function() {
        // Still disconnected
        setConnectionState(STATE_ERROR);
      });
    } else {
      // No electronAPI — check if we've received events recently
      if (Date.now() - lastEventTime < HEARTBEAT_TIMEOUT) {
        setConnectionState(STATE_CONNECTED);
      }
    }
  }

  // ─── Heartbeat Monitor ──────────────────────────────────────────

  function startHeartbeat() {
    heartbeatTimer = setInterval(function() {
      if (subscriptions.size > 0 && Date.now() - lastEventTime > HEARTBEAT_TIMEOUT) {
        if (connectionState === STATE_CONNECTED) {
          setConnectionState(STATE_DISCONNECTED);
        }
      }
    }, FALLBACK_POLL_INTERVAL);
  }

  // ─── Live Indicator Component ───────────────────────────────────

  function createLiveIndicator() {
    var el = document.createElement('div');
    el.className = 'esb-live-indicator esb-connected';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', 'Event stream status: connected');
    el.innerHTML = '<span class="esb-dot"></span><span class="esb-label">Live</span>';
    liveIndicators.push(el);
    updateIndicatorState(el);
    return el;
  }

  function updateIndicatorState(el) {
    var labelEl = el.querySelector('.esb-label');
    el.className = 'esb-live-indicator';

    if (connectionState === STATE_CONNECTED) {
      el.classList.add('esb-connected');
      if (labelEl) labelEl.textContent = 'Live';
      el.setAttribute('aria-label', 'Event stream status: connected');
    } else if (connectionState === STATE_DISCONNECTED) {
      el.classList.add('esb-disconnected');
      if (labelEl) labelEl.textContent = 'Reconnecting\u2026';
      el.setAttribute('aria-label', 'Event stream status: reconnecting');
    } else {
      el.classList.add('esb-error');
      if (labelEl) labelEl.textContent = 'Disconnected';
      el.setAttribute('aria-label', 'Event stream status: disconnected');
    }
  }

  function updateLiveIndicators() {
    for (var i = 0; i < liveIndicators.length; i++) {
      updateIndicatorState(liveIndicators[i]);
    }
  }

  // ─── Incremental Rendering Helper ──────────────────────────────

  function appendIncremental(container, itemElement) {
    if (!container || !itemElement) return;
    itemElement.classList.add('esb-item-new');
    container.prepend(itemElement);

    // Remove animation class after transition completes
    setTimeout(function() {
      itemElement.classList.remove('esb-item-new');
    }, 350);
  }

  // ─── Default Channel Subscriptions for Workspace Panels ─────────

  function wireDefaultChannels() {
    // These channels are defined in the design doc as the primary event channels
    // that workspace panels should subscribe to.
    var defaultChannels = [
      'loop:state-changed',
      'loop:pass-completed',
      'drift:signal',
      'sandbox:activity-update',
    ];

    defaultChannels.forEach(function(channel) {
      if (!subscriptions.has(channel)) {
        subscriptions.set(channel, new Set());
        registerIPCListener(channel);
      }
    });
  }

  // ─── Public Bus API ─────────────────────────────────────────────

  var EventStreamBus = {
    /**
     * Get current connection state: 'connected' | 'disconnected' | 'error'
     */
    getState: function() {
      return connectionState;
    },

    /**
     * Create a "Live" indicator DOM element to embed in a panel.
     * Returns HTMLElement with auto-updating status.
     */
    createLiveIndicator: createLiveIndicator,

    /**
     * Append an item to a container with incremental rendering animation.
     * Use instead of full re-fetch for real-time updates (Req 16.2).
     */
    appendIncremental: appendIncremental,

    /**
     * Force a reconnect attempt.
     */
    reconnect: function() {
      attemptReconnect();
    },

    /**
     * Get time since last event in ms.
     */
    getTimeSinceLastEvent: function() {
      return Date.now() - lastEventTime;
    },

    /**
     * Check if connected.
     */
    isConnected: function() {
      return connectionState === STATE_CONNECTED;
    },

    /**
     * Subscribe with auto-cleanup. Returns an unsubscribe function.
     */
    on: function(channel, handler) {
      subscribeEvent(channel, handler);
      return function() {
        unsubscribeEvent(channel, handler);
      };
    },

    /**
     * Subscribe to multiple channels at once. Returns an unsubscribe-all function.
     */
    onMany: function(channels, handler) {
      var unsubs = [];
      for (var i = 0; i < channels.length; i++) {
        unsubs.push(EventStreamBus.on(channels[i], handler));
      }
      return function() {
        for (var j = 0; j < unsubs.length; j++) {
          unsubs[j]();
        }
      };
    },
  };

  // ─── Expose Globals ─────────────────────────────────────────────

  window.subscribeEvent = subscribeEvent;
  window.unsubscribeEvent = unsubscribeEvent;
  window.EventStreamBus = EventStreamBus;

  // ─── Initialize ─────────────────────────────────────────────────

  wireDefaultChannels();
  startHeartbeat();

  console.log('[EventStreamBus] Initialized — subscriptions active for default channels');

})();
