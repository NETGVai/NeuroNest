// @ts-nocheck
/**
 * Registry-driven Channels-View panel renderer (browser-loadable version).
 *
 * Populates the channels panel at runtime from the Adapter_Registry
 * via IPC, replacing the old hardcoded tile markup. Uses a full
 * inner-HTML re-render strategy — tile count is bounded at 43 and
 * full re-paint keeps ordering deterministic without incremental-diff bugs.
 *
 * Exposes window.renderChannelsView and window.subscribeToRegistryEvents
 * for consumption by src/renderer/index.ts.
 *
 * Requirements: REQ 30.5, REQ 31.1, REQ 31.2, REQ 31.3, REQ 31.4, REQ 31.5, REQ 31.6, REQ 31.7
 */

/* ─── IPC Bridge Helper ──────────────────────────────────────────── */

function _chViewGetIpcBridge() {
  var bridge = window.electronAPI;
  return {
    invoke: (bridge && bridge.invoke) ? bridge.invoke.bind(bridge) : function() { return Promise.resolve(undefined); },
    on: (bridge && bridge.on) ? bridge.on.bind(bridge) : function() {},
    removeListener: (bridge && bridge.removeListener) ? bridge.removeListener.bind(bridge) : function() {}
  };
}

/* ─── HTML Utility ───────────────────────────────────────────────── */

function _chViewEscHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── Tile Rendering ─────────────────────────────────────────────── */

function _chViewRenderTile(tile) {
  var available = tile.implementationStatus === 'available';
  var connected = tile.connectionStatus === 'connected';

  var btnLabel;
  if (!available) {
    btnLabel = 'Not Available';
  } else if (connected) {
    btnLabel = 'Configure';
  } else {
    btnLabel = 'Setup';
  }

  var btnDisabledAttr = !available
    ? 'disabled aria-disabled="true"'
    : '';
  var btnClass = !available
    ? 'setting-btn ch-config-btn ch-btn-disabled'
    : 'setting-btn ch-config-btn';

  var pills = '';
  for (var i = 0; i < tile.actionTags.length; i++) {
    pills += '<span class="ch-action-tag">' + _chViewEscHtml(tile.actionTags[i]) + '</span>';
  }

  var statusIndicator = connected ? 'ch-on' : 'ch-off';
  var statusLabel = connected ? 'ON' : 'OFF';
  var cardClass = connected ? 'ch-card ch-connected' : 'ch-card';

  return '<div class="' + cardClass + '"' +
    ' data-chid="' + _chViewEscHtml(tile.channelId) + '"' +
    ' data-chname="' + _chViewEscHtml(tile.displayName) + '"' +
    ' role="article"' +
    ' aria-label="' + _chViewEscHtml(tile.displayName) + ' channel">' +
    '<div class="ch-card-header">' +
    '<span class="ch-emoji" aria-hidden="true">' + tile.emoji + '</span>' +
    '<span class="ch-name">' + _chViewEscHtml(tile.displayName) + '</span>' +
    '<span class="ch-status ' + statusIndicator + '" aria-label="Status: ' + statusLabel + '">' + statusLabel + '</span>' +
    '</div>' +
    '<div class="ch-desc">' + _chViewEscHtml(tile.description) + '</div>' +
    '<div class="ch-actions" aria-label="Capabilities">' + pills + '</div>' +
    '<div class="ch-controls">' +
    '<button class="' + btnClass + '"' +
    ' data-chid="' + _chViewEscHtml(tile.channelId) + '"' +
    ' data-chname="' + _chViewEscHtml(tile.displayName) + '"' +
    ' ' + btnDisabledAttr + '>' + btnLabel + '</button>' +
    '</div></div>';
}

/* ─── Data Fetching ──────────────────────────────────────────────── */

function _chViewBuildTileViewModels() {
  var ipc = _chViewGetIpcBridge();

  return ipc.invoke('channel:list').then(function(result) {
    var channelIds = result || [];

    var promises = [];
    for (var i = 0; i < channelIds.length; i++) {
      (function(channelId) {
        var p = Promise.all([
          ipc.invoke('channel:metadata', { channelId: channelId }),
          ipc.invoke('get-channel-status', { channelId: channelId })
        ]).then(function(results) {
          var meta = results[0] || {};
          var status = results[1] || {};
          var tileMeta = meta.tileMetadata || {};
          var caps = meta.capabilities || {};
          return {
            channelId: channelId,
            displayName: tileMeta.displayName || channelId,
            emoji: tileMeta.emoji || '',
            description: tileMeta.description || '',
            actionTags: tileMeta.actionTags || [],
            sortOrder: tileMeta.sortOrder != null ? tileMeta.sortOrder : Number.MAX_SAFE_INTEGER,
            implementationStatus: caps.implementationStatus || 'coming-soon',
            connectionStatus: (status && status.status) || 'disconnected'
          };
        });
        promises.push(p);
      })(channelIds[i]);
    }

    return Promise.all(promises).then(function(tiles) {
      // REQ 31.6 — stable sort ascending by tileMetadata.sortOrder
      tiles.sort(function(a, b) { return a.sortOrder - b.sortOrder; });
      return tiles;
    });
  });
}

/* ─── Public API ─────────────────────────────────────────────────── */

/**
 * Render the channels-view panel into the given container.
 *
 * Queries the Adapter_Registry via IPC, builds tile view-models sorted by sortOrder,
 * and renders all tiles into `#ch-grid-area` inside the container.
 *
 * REQ 31.2: queries channelManager.listRegisteredChannels() + per-adapter metadata
 * REQ 31.3: renders displayName, emoji, description, actionTags pills
 * REQ 31.4: available adapters show an enabled Setup/Configure button
 * REQ 31.5: coming-soon adapters show a disabled Not Available button
 * REQ 31.6: tile order stable via ascending sortOrder
 */
function renderChannelsView(container) {
  // Set up the grid area container if not already present
  var gridArea = container.querySelector('#ch-grid-area');
  if (!gridArea) {
    container.innerHTML = '<div id="ch-grid-area" role="list" aria-label="Channel tiles">Loading\u2026</div>';
    gridArea = container.querySelector('#ch-grid-area');
  }

  return _chViewBuildTileViewModels().then(function(tiles) {
    // Full inner-HTML re-render strategy (tile count bounded at 43).
    var html = '';
    for (var i = 0; i < tiles.length; i++) {
      html += _chViewRenderTile(tiles[i]);
    }
    gridArea.innerHTML = html;

    // Wire click handlers on enabled buttons (REQ 31.4, REQ 31.5)
    _chViewWireTileHandlers(gridArea);
  }).catch(function(err) {
    gridArea.innerHTML = '<div class="ch-error">Failed to load channels. Please try again.</div>';
    console.error('[channels-view] render error:', err);
  });
}

/**
 * Subscribe to registry and status change events for live re-rendering.
 *
 * Listens for `channel-status-update` and `channel-registry-update` and
 * re-renders the whole `#ch-grid-area` on either event (REQ 31.7).
 *
 * Returns an unsubscribe function for panel unmount cleanup.
 */
function subscribeToRegistryEvents(container) {
  var ipc = _chViewGetIpcBridge();

  var handleChange = function() {
    renderChannelsView(container).catch(function(err) {
      console.error('[channels-view] re-render on event failed:', err);
    });
  };

  // Listen for both event types that should trigger a re-render
  ipc.on('channel-status-update', handleChange);
  ipc.on('channel-registry-update', handleChange);

  // Return unsubscribe function for panel unmount
  return function() {
    ipc.removeListener('channel-status-update', handleChange);
    ipc.removeListener('channel-registry-update', handleChange);
  };
}

/* ─── Event Wiring ───────────────────────────────────────────────── */

function _chViewWireTileHandlers(gridArea) {
  var buttons = gridArea.querySelectorAll('.ch-config-btn');
  for (var i = 0; i < buttons.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        // coming-soon buttons are disabled — but guard explicitly as well
        if (btn.disabled || btn.hasAttribute('aria-disabled')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        var channelId = btn.getAttribute('data-chid') || '';
        var channelName = btn.getAttribute('data-chname') || '';

        // Dispatch a bubbling custom event so the parent can handle
        // opening the connect/configure dialog
        btn.dispatchEvent(
          new CustomEvent('channel-tile-action', {
            bubbles: true,
            detail: { channelId: channelId, channelName: channelName, action: (btn.textContent || '').trim() }
          })
        );
      });
    })(buttons[i]);
  }
}

/* ─── Window Global Exposure ─────────────────────────────────────── */

window.renderChannelsView = renderChannelsView;
window.subscribeToRegistryEvents = subscribeToRegistryEvents;
