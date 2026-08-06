/**
 * Registry-driven Channels-View panel renderer.
 *
 * Populates the channels panel at runtime from the Adapter_Registry
 * via IPC, replacing the old hardcoded tile markup. Uses a full
 * inner-HTML re-render strategy — tile count is bounded at 43 and
 * full re-paint keeps ordering deterministic without incremental-diff bugs.
 *
 * Requirements: REQ 31.2, REQ 31.3, REQ 31.4, REQ 31.5, REQ 31.6, REQ 31.7
 */

// ─── Types ──────────────────────────────────────────────────────

/** View-model for a single channel tile. */
interface TileVM {
  channelId: string;
  displayName: string;
  emoji: string;
  description: string;
  actionTags: readonly string[];
  sortOrder: number;
  implementationStatus: 'available' | 'coming-soon';
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
}

/** Shape of the IPC bridge exposed by preload as `window.electronAPI`. */
declare const eapi: {
  invoke(channel: string, ...args: any[]): Promise<any>;
  receive(channel: string, callback: (...args: any[]) => void): void;
  removeListener?(channel: string, callback: (...args: any[]) => void): void;
};

// ─── IPC Bridge Helper ──────────────────────────────────────────

/**
 * Returns the Electron IPC bridge exposed by preload.
 * Uses the `electronAPI` global (contextBridge-exposed) with fallback stubs.
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const win = window as unknown as Record<string, unknown>;
  const bridge = win['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    removeListener?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    removeListener: bridge?.removeListener ?? (() => {}),
  };
}

// ─── HTML Utility ───────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS in tile rendering. */
function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Tile Rendering ─────────────────────────────────────────────

/**
 * Render a single channel tile as an HTML string.
 *
 * - `available` adapters show an enabled Setup/Configure button (REQ 31.4)
 * - `coming-soon` adapters show a disabled "Not Available" button (REQ 31.5)
 * - Action tags are rendered as pills (REQ 31.3)
 */
function renderTile(tile: TileVM): string {
  const available = tile.implementationStatus === 'available';
  const connected = tile.connectionStatus === 'connected';

  let btnLabel: string;
  if (!available) {
    btnLabel = 'Not Available';
  } else if (connected) {
    btnLabel = 'Configure';
  } else {
    btnLabel = 'Setup';
  }

  const btnDisabledAttr = !available
    ? 'disabled aria-disabled="true"'
    : '';
  const btnClass = !available
    ? 'setting-btn ch-config-btn ch-btn-disabled'
    : 'setting-btn ch-config-btn';

  const pills = tile.actionTags
    .map((tag) => `<span class="ch-action-tag">${escHtml(tag)}</span>`)
    .join('');

  const statusIndicator = connected ? 'ch-on' : 'ch-off';
  const statusLabel = connected ? 'ON' : 'OFF';
  const cardClass = connected ? 'ch-card ch-connected' : 'ch-card';

  return `
    <div class="${cardClass}"
         data-chid="${escHtml(tile.channelId)}"
         data-chname="${escHtml(tile.displayName)}"
         role="article"
         aria-label="${escHtml(tile.displayName)} channel">
      <div class="ch-card-header">
        <span class="ch-emoji" aria-hidden="true">${tile.emoji}</span>
        <span class="ch-name">${escHtml(tile.displayName)}</span>
        <span class="ch-status ${statusIndicator}" aria-label="Status: ${statusLabel}">${statusLabel}</span>
      </div>
      <div class="ch-desc">${escHtml(tile.description)}</div>
      <div class="ch-actions" aria-label="Capabilities">
        ${pills}
      </div>
      <div class="ch-controls">
        <button class="${btnClass}"
                data-chid="${escHtml(tile.channelId)}"
                data-chname="${escHtml(tile.displayName)}"
                ${btnDisabledAttr}>${btnLabel}</button>
      </div>
    </div>`;
}

// ─── Data Fetching ──────────────────────────────────────────────

/**
 * Fetch registry data via IPC and build the TileVM array.
 * Calls channel:list, then per-channel channel:metadata + get-channel-status.
 */
async function buildTileViewModels(): Promise<TileVM[]> {
  const ipc = getIpcBridge();

  // Get the list of all registered channel IDs
  const channelIds: string[] =
    (await ipc.invoke('channel:list') as string[] | undefined) ?? [];

  // For each channel, fetch metadata and status in parallel
  const tiles = await Promise.all(
    channelIds.map(async (channelId: string): Promise<TileVM> => {
      const [metaResult, statusResult] = await Promise.all([
        ipc.invoke('channel:metadata', { channelId }),
        ipc.invoke('get-channel-status', { channelId }),
      ]);

      const meta = metaResult as {
        tileMetadata?: {
          displayName?: string;
          emoji?: string;
          description?: string;
          actionTags?: readonly string[];
          sortOrder?: number;
        };
        capabilities?: {
          implementationStatus?: 'available' | 'coming-soon';
        };
      } | undefined;

      const status = statusResult as {
        status?: 'disconnected' | 'connecting' | 'connected' | 'error';
      } | undefined;

      return {
        channelId,
        displayName: meta?.tileMetadata?.displayName ?? channelId,
        emoji: meta?.tileMetadata?.emoji ?? '',
        description: meta?.tileMetadata?.description ?? '',
        actionTags: meta?.tileMetadata?.actionTags ?? [],
        sortOrder: meta?.tileMetadata?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        implementationStatus: meta?.capabilities?.implementationStatus ?? 'coming-soon',
        connectionStatus: status?.status ?? 'disconnected',
      };
    }),
  );

  // REQ 31.6 — stable sort ascending by tileMetadata.sortOrder
  tiles.sort((a, b) => a.sortOrder - b.sortOrder);

  return tiles;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Render the channels-view panel into the given container.
 *
 * Queries the Adapter_Registry via IPC, builds TileVM[] sorted by sortOrder,
 * and renders all tiles into `#ch-grid-area` inside the container.
 *
 * REQ 31.2: queries channelManager.listRegisteredChannels() + per-adapter metadata
 * REQ 31.3: renders displayName, emoji, description, actionTags pills
 * REQ 31.4: available adapters show an enabled Setup/Configure button
 * REQ 31.5: coming-soon adapters show a disabled Not Available button
 * REQ 31.6: tile order stable via ascending sortOrder
 */
export async function renderChannelsView(container: HTMLElement): Promise<void> {
  // Set up the grid area container if not already present
  let gridArea = container.querySelector('#ch-grid-area') as HTMLElement | null;
  if (!gridArea) {
    container.innerHTML = '<div id="ch-grid-area" role="list" aria-label="Channel tiles">Loading\u2026</div>';
    gridArea = container.querySelector('#ch-grid-area') as HTMLElement;
  }

  try {
    const tiles = await buildTileViewModels();

    // Full inner-HTML re-render strategy (tile count bounded at 43).
    gridArea.innerHTML = tiles.map(renderTile).join('');

    // Wire click handlers on enabled buttons (REQ 31.4, REQ 31.5)
    wireTileHandlers(gridArea);
  } catch (err) {
    gridArea.innerHTML = '<div class="ch-error">Failed to load channels. Please try again.</div>';
    console.error('[channels-view] render error:', err);
  }
}

/**
 * Subscribe to registry and status change events for live re-rendering.
 *
 * Listens for `channel-status-update` and `channel-registry-update` and
 * re-renders the whole `#ch-grid-area` on either event (REQ 31.7).
 *
 * Returns an unsubscribe function for panel unmount cleanup.
 */
export function subscribeToRegistryEvents(container: HTMLElement): () => void {
  const ipc = getIpcBridge();

  const handleChange = (): void => {
    renderChannelsView(container).catch((err) => {
      console.error('[channels-view] re-render on event failed:', err);
    });
  };

  // Listen for both event types that should trigger a re-render
  ipc.on('channel-status-update', handleChange);
  ipc.on('channel-registry-update', handleChange);

  // Return unsubscribe function for panel unmount
  return () => {
    ipc.removeListener('channel-status-update', handleChange);
    ipc.removeListener('channel-registry-update', handleChange);
  };
}

// ─── Event Wiring ───────────────────────────────────────────────

/**
 * Attach click handlers to tile buttons.
 *
 * - Enabled buttons (available adapters) dispatch a custom event
 *   that the parent panel (or index.ts) can handle to open a connect dialog.
 * - Disabled buttons (coming-soon) must NOT open a connect dialog (REQ 31.5).
 */
function wireTileHandlers(gridArea: HTMLElement): void {
  const buttons = gridArea.querySelectorAll<HTMLButtonElement>('.ch-config-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      // coming-soon buttons are disabled — but guard explicitly as well
      if (btn.disabled || btn.hasAttribute('aria-disabled')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const channelId = btn.getAttribute('data-chid') ?? '';
      const channelName = btn.getAttribute('data-chname') ?? '';

      // Dispatch a bubbling custom event so the parent can handle
      // opening the connect/configure dialog
      btn.dispatchEvent(
        new CustomEvent('channel-tile-action', {
          bubbles: true,
          detail: { channelId, channelName, action: btn.textContent?.trim() },
        }),
      );
    });
  });
}

// ─── Window Global Exposure ─────────────────────────────────────
// Expose public API on `window` for consumption by `src/renderer/index.ts`
// which runs as a plain browser script (no ES module bundling).
// This allows index.ts to call `window.renderChannelsView(container)` and
// `window.subscribeToRegistryEvents(container)` without an import statement.

if (typeof window !== 'undefined') {
  (window as any).renderChannelsView = renderChannelsView;
  (window as any).subscribeToRegistryEvents = subscribeToRegistryEvents;
}
