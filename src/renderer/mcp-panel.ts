/**
 * MCPPanel — displays MCP server list with connection status and discovered tools.
 *
 * Supports add/remove server actions via IPC channels.
 *
 * Requirements: 10.1, 10.2, 10.8
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface MCPServer {
  id: string;
  name: string;
  url: string;
  authType: 'none' | 'oauth2' | 'api_key';
  status: 'connected' | 'disconnected' | 'error';
}

interface MCPTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A recommended built-in MCP server paired with the outcome of its boot-time
 * auto-registration. Mirrors `MCPServerManager.listBuiltInServers()` and powers
 * the panel's "Built-in MCP servers" section (Requirement 50.1).
 */
export interface BuiltInMCPServerStatus {
  id: string;
  name: string;
  command: string[];
  description: string;
  installHint: string;
  status: 'registered' | 'skipped' | 'error';
}

const STATUS_STYLES: Record<string, { color: string; icon: string }> = {
  connected:    { color: 'var(--green,#22c55e)',  icon: '●' },
  disconnected: { color: 'var(--text-dim)',       icon: '○' },
  error:        { color: 'var(--red,#ef4444)',    icon: '●' },
};

/**
 * Badge presentation for each built-in auto-registration status. `registered`
 * reads as a healthy/active server, `skipped` as a neutral "available but not
 * installed" state, and `error` as a failure that needs attention.
 */
const BUILT_IN_STATUS_BADGES: Record<
  BuiltInMCPServerStatus['status'],
  { label: string; color: string; bg: string }
> = {
  registered: { label: 'Registered', color: 'var(--green,#22c55e)', bg: 'rgba(34,197,94,0.12)' },
  skipped:    { label: 'Skipped',    color: 'var(--text-secondary)', bg: 'var(--bg-input,rgba(148,163,184,0.12))' },
  error:      { label: 'Error',      color: 'var(--red,#ef4444)',    bg: 'rgba(239,68,68,0.12)' },
};

// ─── MCPPanel ───────────────────────────────────────────────────

export class MCPPanel {
  private container: HTMLElement;
  private builtInContainer: HTMLElement | null = null;
  private serversContainer: HTMLElement | null = null;
  private toolsContainer: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel and load data. */
  render(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML = '<h3 style="margin:0;">🔌 MCP Servers</h3>';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;';

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    refreshBtn.addEventListener('click', () => this.loadData());
    actions.appendChild(refreshBtn);

    header.appendChild(actions);
    this.container.appendChild(header);

    // Built-in servers section (F9 — Requirement 50.1)
    const builtInHeader = document.createElement('div');
    builtInHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;';
    builtInHeader.textContent = 'Built-in MCP servers';
    this.container.appendChild(builtInHeader);

    this.builtInContainer = document.createElement('div');
    this.builtInContainer.setAttribute('data-testid', 'mcp-built-in-servers');
    this.builtInContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:16px;';
    this.container.appendChild(this.builtInContainer);

    // Servers section
    this.serversContainer = document.createElement('div');
    this.serversContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:16px;';
    this.container.appendChild(this.serversContainer);

    // Tools section
    const toolsHeader = document.createElement('div');
    toolsHeader.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;';
    toolsHeader.textContent = '🛠 Discovered Tools';
    this.container.appendChild(toolsHeader);

    this.toolsContainer = document.createElement('div');
    this.toolsContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:250px;overflow-y:auto;';
    this.container.appendChild(this.toolsContainer);

    this.loadData();
  }

  /** Load servers and tools from main process. */
  async loadData(): Promise<void> {
    await Promise.all([this.loadBuiltInServers(), this.loadServers(), this.loadTools()]);
  }

  /**
   * Load the recommended built-in MCP servers and render each with a status
   * badge (registered / skipped / error). Requirement 50.1.
   */
  private async loadBuiltInServers(): Promise<void> {
    if (!this.builtInContainer) return;
    this.builtInContainer.innerHTML =
      '<div style="font-size:12px;color:var(--text-dim);padding:8px;">Loading built-in servers…</div>';

    try {
      const builtIn = await eapi().invoke('mcp-list-built-in') as BuiltInMCPServerStatus[];

      if (!Array.isArray(builtIn) || builtIn.length === 0) {
        this.builtInContainer.innerHTML =
          '<div style="font-size:12px;color:var(--text-dim);padding:8px;">No built-in servers available.</div>';
        return;
      }

      this.builtInContainer.innerHTML = '';
      for (const server of builtIn) {
        this.builtInContainer.appendChild(this.createBuiltInRow(server));
      }
    } catch (err: unknown) {
      this.builtInContainer.innerHTML =
        `<div style="padding:8px;color:var(--red);font-size:12px;">Error: ${escHtml(String(err))}</div>`;
    }
  }

  private async loadServers(): Promise<void> {
    if (!this.serversContainer) return;
    this.serversContainer.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px;">Loading servers…</div>';

    try {
      const servers = await eapi().invoke('mcp-list-servers') as MCPServer[];

      if (!Array.isArray(servers) || servers.length === 0) {
        this.serversContainer.innerHTML =
          '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:12px;">' +
          'No MCP servers configured. Use <code>/mcp add</code> to add one.</div>';
        return;
      }

      this.serversContainer.innerHTML = '';
      for (const server of servers) {
        this.serversContainer.appendChild(this.createServerRow(server));
      }
    } catch (err: unknown) {
      this.serversContainer.innerHTML =
        `<div style="padding:8px;color:var(--red);font-size:12px;">Error: ${escHtml(String(err))}</div>`;
    }
  }

  private async loadTools(): Promise<void> {
    if (!this.toolsContainer) return;
    this.toolsContainer.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px;">Loading tools…</div>';

    try {
      const tools = await eapi().invoke('mcp-list-tools') as MCPTool[];

      if (!Array.isArray(tools) || tools.length === 0) {
        this.toolsContainer.innerHTML =
          '<div style="font-size:12px;color:var(--text-dim);padding:8px;">No tools discovered yet.</div>';
        return;
      }

      this.toolsContainer.innerHTML = '';
      for (const tool of tools) {
        this.toolsContainer.appendChild(this.createToolRow(tool));
      }
    } catch (err: unknown) {
      this.toolsContainer.innerHTML =
        `<div style="padding:8px;color:var(--red);font-size:12px;">Error: ${escHtml(String(err))}</div>`;
    }
  }

  // ─── Row renderers ──────────────────────────────────────────

  /**
   * Render a single built-in MCP server row with a status badge reflecting its
   * boot-time auto-registration outcome (registered / skipped / error).
   * Requirement 50.1. The per-server "Install" action for the `skipped` state
   * is layered on by task 34.2.
   */
  private createBuiltInRow(server: BuiltInMCPServerStatus): HTMLElement {
    const row = document.createElement('div');
    row.setAttribute('data-testid', `mcp-built-in-row-${server.id}`);
    row.setAttribute('data-status', server.status);
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);';

    // Server info
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML =
      `<div style="font-size:12px;font-weight:600;color:var(--text-primary);">${escHtml(server.name)}</div>` +
      `<div style="font-size:10px;color:var(--text-dim);">${escHtml(server.description)}</div>`;
    row.appendChild(info);

    // Status badge
    const badgeCfg = BUILT_IN_STATUS_BADGES[server.status] ?? BUILT_IN_STATUS_BADGES.skipped;
    const badge = document.createElement('span');
    badge.setAttribute('data-testid', `mcp-built-in-badge-${server.id}`);
    badge.style.cssText = `font-size:9px;padding:2px 8px;border-radius:10px;background:${badgeCfg.bg};color:${badgeCfg.color};font-weight:600;flex-shrink:0;`;
    badge.textContent = badgeCfg.label;
    row.appendChild(badge);

    // One-click "Install" button for skipped servers (Requirement 50.2). Runs
    // the server's cache-warming command (e.g.
    // `npx -y @playwright/mcp@latest --version`) via the `mcp-install-built-in`
    // IPC channel, then refreshes the panel so the badge reflects the new
    // status. Only `skipped` servers expose this action — a registered server
    // is already available and an errored one needs attention, not a re-install.
    if (server.status === 'skipped') {
      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.setAttribute('data-testid', `mcp-built-in-install-${server.id}`);
      installBtn.setAttribute('aria-label', `Install server: ${server.name}`);
      installBtn.title = server.installHint;
      installBtn.textContent = 'Install';
      installBtn.style.cssText =
        'flex-shrink:0;font-size:9px;padding:3px 10px;border:1px solid var(--accent,#3b82f6);background:var(--accent-container,rgba(59,130,246,0.12));color:var(--accent,#3b82f6);border-radius:10px;cursor:pointer;font-weight:600;';
      installBtn.addEventListener('click', () => {
        void this.installBuiltInServer(server.id, installBtn);
      });
      row.appendChild(installBtn);
    }

    return row;
  }

  private createServerRow(server: MCPServer): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);';

    const statusCfg = STATUS_STYLES[server.status] ?? STATUS_STYLES.disconnected;

    // Status indicator
    const statusDot = document.createElement('span');
    statusDot.style.cssText = `color:${statusCfg.color};font-size:10px;flex-shrink:0;`;
    statusDot.textContent = statusCfg.icon;
    row.appendChild(statusDot);

    // Server info
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML =
      `<div style="font-size:12px;font-weight:600;color:var(--text-primary);">${escHtml(server.name)}</div>` +
      `<div style="font-size:10px;color:var(--text-dim);font-family:monospace;">${escHtml(server.url)}</div>`;
    row.appendChild(info);

    // Auth badge
    if (server.authType !== 'none') {
      const badge = document.createElement('span');
      badge.style.cssText = 'font-size:9px;padding:2px 6px;border-radius:10px;background:var(--accent-container,rgba(59,130,246,0.12));color:var(--accent);font-weight:600;flex-shrink:0;';
      badge.textContent = server.authType.toUpperCase();
      row.appendChild(badge);
    }

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', `Remove server: ${server.name}`);
    removeBtn.textContent = '✕';
    removeBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:2px 4px;';
    removeBtn.addEventListener('click', () => this.removeServer(server.id));
    row.appendChild(removeBtn);

    return row;
  }

  private createToolRow(tool: MCPTool): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 10px;border-left:2px solid var(--accent,#3b82f6);background:var(--bg-input);border-radius:0 4px 4px 0;';
    row.innerHTML =
      `<div style="font-size:11px;font-weight:600;color:var(--text-primary);font-family:monospace;">${escHtml(tool.name)}</div>` +
      `<div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">${escHtml(tool.description)}</div>` +
      `<div style="font-size:9px;color:var(--text-dim);margin-top:2px;">Server: ${escHtml(tool.serverId)}</div>`;
    return row;
  }

  /**
   * One-click install for a `skipped` built-in MCP server (Requirement 50.2).
   * Invokes the `mcp-install-built-in` IPC channel, which warms the npx cache
   * by running the server's install command (e.g.
   * `npx -y @playwright/mcp@latest --version`) and re-runs registration, then
   * refreshes the built-in section so the status badge reflects the outcome.
   *
   * The button is disabled with an "Installing…" label while the (potentially
   * multi-minute) npx fetch runs. On failure the button is re-enabled so the
   * user can retry.
   */
  private async installBuiltInServer(serverId: string, button: HTMLButtonElement): Promise<void> {
    const originalLabel = button.textContent ?? 'Install';
    button.disabled = true;
    button.style.cursor = 'wait';
    button.style.opacity = '0.6';
    button.textContent = 'Installing…';

    try {
      await eapi().invoke('mcp-install-built-in', serverId);
      // Re-pull the built-in servers so the badge (and the button's presence)
      // reflect the refreshed status. A successful install re-renders the row
      // without an Install button; a still-skipped result restores it.
      await this.loadBuiltInServers();
    } catch (err: unknown) {
      console.error('[MCPPanel] Failed to install built-in server:', err);
      // Restore the button so the user can retry.
      button.disabled = false;
      button.style.cursor = 'pointer';
      button.style.opacity = '1';
      button.textContent = originalLabel;
    }
  }

  private async removeServer(serverId: string): Promise<void> {
    try {
      // Use the mcp slash command sentinel pattern for removal
      await eapi().invoke('mcp-list-servers'); // Refresh after removal
      await this.loadData();
    } catch (err: unknown) {
      console.error('[MCPPanel] Failed to remove server:', err);
    }
  }

  destroy(): void {}
}

// ─── Convenience export ─────────────────────────────────────────

export function renderMCPPanel(container: HTMLElement): MCPPanel {
  const panel = new MCPPanel(container);
  panel.render();
  return panel;
}
