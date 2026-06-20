/**
 * PluginRegistryPanel — Panel for browsing, installing, and managing plugins.
 *
 * Features:
 * - Browse remote plugin catalog
 * - View installed plugins with their status (enabled/disabled)
 * - Install, uninstall, enable, and disable plugins
 * - Display permission summary for each plugin (Requirement 23.4)
 *
 * Requirements: 11.1, 11.6, 23.4
 */

import type { PluginPermission } from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface InstalledPluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: PluginPermission[];
  state: string;
  installedAt?: string;
}

interface CatalogEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  pluginType: string;
  packageUrl: string;
  checksum: string;
  downloads?: number;
  rating?: number;
}

interface PermissionDetail {
  permission: PluginPermission;
  granted: boolean;
  description: string;
}

interface PermissionResponse {
  pluginId: string;
  pluginName: string;
  permissions: PermissionDetail[];
}

type PanelView = 'installed' | 'catalog' | 'detail' | 'permissions';

// ─── Constants ──────────────────────────────────────────────────

const PERMISSION_ICONS: Record<PluginPermission, string> = {
  'file-read': '📖',
  'file-write': '✏️',
  'network-access': '🌐',
  'tool-invoke': '🔧',
  'shell-execute': '💻',
  'database-access': '🗄️',
};

const STATE_BADGES: Record<string, { label: string; color: string }> = {
  active: { label: 'Enabled', color: '#22c55e' },
  loaded: { label: 'Installed', color: '#3b82f6' },
  disabled: { label: 'Disabled', color: '#6b7280' },
  error: { label: 'Error', color: '#ef4444' },
};

// ─── Helpers ────────────────────────────────────────────────────

function formatDate(date: string | undefined): string {
  if (!date) return 'Unknown';
  const d = new Date(date);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── PluginRegistryPanel ────────────────────────────────────────

export class PluginRegistryPanel {
  private container: HTMLElement;
  private currentView: PanelView = 'installed';
  private installedPlugins: InstalledPluginInfo[] = [];
  private catalogEntries: CatalogEntry[] = [];
  private selectedPlugin: InstalledPluginInfo | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Render the panel and load installed plugins. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.loadInstalledPlugins();
  }

  /** Refresh the installed plugins list. */
  async loadInstalledPlugins(): Promise<void> {
    this.currentView = 'installed';
    this.selectedPlugin = null;

    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading plugins…</div>';

    try {
      const result = await eapi().invoke('plugin:list');

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.installedPlugins = (result as InstalledPluginInfo[]) ?? [];
      this.renderInstalledList();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Installed Plugins View ───────────────────────────────────

  private renderInstalledList(): void {
    this.container.innerHTML = '';

    // Header with tab switcher
    const header = this.createHeader('🧩 Plugins', [
      { label: '🔍', title: 'Browse Catalog', onClick: () => this.loadCatalog() },
      { label: '↻', title: 'Refresh', onClick: () => this.loadInstalledPlugins() },
    ]);
    this.container.appendChild(header);

    // Tab bar
    this.container.appendChild(this.createTabBar('installed'));

    // Empty state
    if (this.installedPlugins.length === 0) {
      this.container.appendChild(
        this.createEmptyState('No plugins installed. Browse the catalog to find plugins.'),
      );
      return;
    }

    // Plugin list
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    for (const plugin of this.installedPlugins) {
      listContainer.appendChild(this.createPluginRow(plugin));
    }

    this.container.appendChild(listContainer);
  }

  private createPluginRow(plugin: InstalledPluginInfo): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;cursor:pointer;transition:background 0.15s;';
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover,rgba(255,255,255,0.05))'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'var(--bg-input)'; });
    row.addEventListener('click', () => this.openPluginDetail(plugin));

    // Icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:18px;flex-shrink:0;';
    icon.textContent = '🧩';
    row.appendChild(icon);

    // Content area
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = plugin.name;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    meta.textContent = `v${plugin.version} · ${plugin.author}`;
    content.appendChild(meta);

    row.appendChild(content);

    // State badge
    const stateInfo = STATE_BADGES[plugin.state] ?? STATE_BADGES.loaded;
    const badge = document.createElement('span');
    badge.style.cssText = `font-size:10px;padding:2px 6px;border-radius:4px;color:white;background:${stateInfo.color};flex-shrink:0;`;
    badge.textContent = stateInfo.label;
    row.appendChild(badge);

    return row;
  }

  // ─── Plugin Detail View ───────────────────────────────────────

  private async openPluginDetail(plugin: InstalledPluginInfo): Promise<void> {
    this.selectedPlugin = plugin;
    this.currentView = 'detail';
    this.renderPluginDetail(plugin);
  }

  private renderPluginDetail(plugin: InstalledPluginInfo): void {
    this.container.innerHTML = '';

    const header = this.createHeader(
      `🧩 ${plugin.name}`,
      [{ label: '←', title: 'Back to list', onClick: () => this.loadInstalledPlugins() }],
    );
    this.container.appendChild(header);

    const detailContainer = document.createElement('div');
    detailContainer.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    // Info section
    const infoSection = document.createElement('div');
    infoSection.style.cssText = 'margin-bottom:16px;';

    const description = document.createElement('p');
    description.style.cssText = 'font-size:12px;color:var(--text-secondary);margin:0 0 8px 0;line-height:1.5;';
    description.textContent = plugin.description;
    infoSection.appendChild(description);

    const metaInfo = document.createElement('div');
    metaInfo.style.cssText = 'font-size:11px;color:var(--text-dim);';
    metaInfo.innerHTML = `
      <div style="margin-bottom:4px;">Author: <strong>${this.escHtml(plugin.author)}</strong></div>
      <div style="margin-bottom:4px;">Version: <strong>${this.escHtml(plugin.version)}</strong></div>
      <div style="margin-bottom:4px;">Installed: <strong>${formatDate(plugin.installedAt)}</strong></div>
    `;
    infoSection.appendChild(metaInfo);
    detailContainer.appendChild(infoSection);

    // Permission summary (Requirement 23.4)
    const permSection = document.createElement('div');
    permSection.style.cssText = 'margin-bottom:16px;';

    const permTitle = document.createElement('div');
    permTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;';
    permTitle.textContent = 'Permissions';
    permSection.appendChild(permTitle);

    if (plugin.permissions.length === 0) {
      const noPerm = document.createElement('div');
      noPerm.style.cssText = 'font-size:11px;color:var(--text-dim);';
      noPerm.textContent = 'This plugin requires no special permissions.';
      permSection.appendChild(noPerm);
    } else {
      for (const perm of plugin.permissions) {
        permSection.appendChild(this.createPermissionRow(perm));
      }
    }
    detailContainer.appendChild(permSection);

    // Action buttons
    const actionSection = document.createElement('div');
    actionSection.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    const isEnabled = plugin.state === 'active';

    // Toggle enable/disable
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = isEnabled ? 'Disable' : 'Enable';
    toggleBtn.style.cssText = this.getButtonStyle(isEnabled ? 'warning' : 'primary');
    toggleBtn.addEventListener('click', () => this.togglePlugin(plugin));
    actionSection.appendChild(toggleBtn);

    // Uninstall
    const uninstallBtn = document.createElement('button');
    uninstallBtn.textContent = 'Uninstall';
    uninstallBtn.style.cssText = this.getButtonStyle('danger');
    uninstallBtn.addEventListener('click', () => this.confirmUninstall(plugin));
    actionSection.appendChild(uninstallBtn);

    // View permissions
    const permBtn = document.createElement('button');
    permBtn.textContent = 'Permission Details';
    permBtn.style.cssText = this.getButtonStyle('secondary');
    permBtn.addEventListener('click', () => this.openPermissions(plugin));
    actionSection.appendChild(permBtn);

    detailContainer.appendChild(actionSection);
    this.container.appendChild(detailContainer);
  }

  private createPermissionRow(permission: PluginPermission): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;';

    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:12px;';
    icon.textContent = PERMISSION_ICONS[permission] ?? '🔒';
    row.appendChild(icon);

    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    label.textContent = permission;
    row.appendChild(label);

    return row;
  }

  // ─── Permissions View ─────────────────────────────────────────

  private async openPermissions(plugin: InstalledPluginInfo): Promise<void> {
    this.currentView = 'permissions';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading permissions…</div>';

    try {
      const result = await eapi().invoke('plugin:permissions', {
        pluginId: plugin.id,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.renderPermissions(plugin, result as PermissionResponse);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderPermissions(plugin: InstalledPluginInfo, permResponse: PermissionResponse): void {
    this.container.innerHTML = '';

    const header = this.createHeader(
      `🔒 Permissions: ${plugin.name}`,
      [{ label: '←', title: 'Back to detail', onClick: () => this.openPluginDetail(plugin) }],
    );
    this.container.appendChild(header);

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:12px;';

    if (permResponse.permissions.length === 0) {
      listContainer.appendChild(
        this.createEmptyState('This plugin does not request any permissions.'),
      );
      this.container.appendChild(listContainer);
      return;
    }

    for (const detail of permResponse.permissions) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:6px;';

      const icon = document.createElement('span');
      icon.style.cssText = 'font-size:16px;flex-shrink:0;margin-top:2px;';
      icon.textContent = PERMISSION_ICONS[detail.permission] ?? '🔒';
      row.appendChild(icon);

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';

      const permName = document.createElement('div');
      permName.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
      permName.textContent = detail.permission;
      info.appendChild(permName);

      const permDesc = document.createElement('div');
      permDesc.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';
      permDesc.textContent = detail.description;
      info.appendChild(permDesc);

      row.appendChild(info);

      // Granted indicator
      const status = document.createElement('span');
      status.style.cssText = `font-size:11px;padding:2px 6px;border-radius:4px;flex-shrink:0;color:white;background:${detail.granted ? '#22c55e' : '#ef4444'};`;
      status.textContent = detail.granted ? 'Granted' : 'Denied';
      row.appendChild(status);

      listContainer.appendChild(row);
    }

    this.container.appendChild(listContainer);
  }

  // ─── Catalog View ─────────────────────────────────────────────

  private async loadCatalog(): Promise<void> {
    this.currentView = 'catalog';
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Fetching catalog…</div>';

    try {
      const result = await eapi().invoke('plugin:catalog');

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      this.catalogEntries = (result as CatalogEntry[]) ?? [];
      this.renderCatalog();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderCatalog(): void {
    this.container.innerHTML = '';

    const header = this.createHeader('🧩 Plugin Catalog', [
      { label: '↻', title: 'Refresh Catalog', onClick: () => this.loadCatalog() },
    ]);
    this.container.appendChild(header);

    // Tab bar
    this.container.appendChild(this.createTabBar('catalog'));

    // Empty state
    if (this.catalogEntries.length === 0) {
      this.container.appendChild(
        this.createEmptyState('No plugins available in the catalog.'),
      );
      return;
    }

    // Catalog list
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

    for (const entry of this.catalogEntries) {
      listContainer.appendChild(this.createCatalogRow(entry));
    }

    this.container.appendChild(listContainer);
  }

  private createCatalogRow(entry: CatalogEntry): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);margin-bottom:4px;';

    // Icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:18px;flex-shrink:0;';
    icon.textContent = '📦';
    row.appendChild(icon);

    // Content
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    title.textContent = entry.name;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    const parts = [`v${entry.version}`, entry.author, entry.pluginType];
    if (entry.downloads !== undefined) parts.push(`${entry.downloads} downloads`);
    meta.textContent = parts.join(' · ');
    content.appendChild(meta);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    desc.textContent = entry.description;
    content.appendChild(desc);

    row.appendChild(content);

    // Install button
    const isInstalled = this.installedPlugins.some((p) => p.name === entry.name);
    const installBtn = document.createElement('button');
    installBtn.textContent = isInstalled ? 'Installed' : 'Install';
    installBtn.disabled = isInstalled;
    installBtn.style.cssText = this.getButtonStyle(isInstalled ? 'secondary' : 'primary');
    if (isInstalled) {
      installBtn.style.opacity = '0.5';
      installBtn.style.cursor = 'default';
    }
    if (!isInstalled) {
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.installPlugin(entry);
      });
    }
    row.appendChild(installBtn);

    return row;
  }

  // ─── Actions ──────────────────────────────────────────────────

  private async installPlugin(entry: CatalogEntry): Promise<void> {
    try {
      const result = await eapi().invoke('plugin:install', {
        packageUrl: entry.packageUrl,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      // Refresh and switch to installed view
      await this.loadInstalledPlugins();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private async togglePlugin(plugin: InstalledPluginInfo): Promise<void> {
    const isEnabled = plugin.state === 'active';
    const channel = isEnabled ? 'plugin:disable' : 'plugin:enable';

    try {
      const result = await eapi().invoke(channel, { pluginId: plugin.id });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      // Refresh the list and re-open detail
      await this.loadInstalledPlugins();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private async confirmUninstall(plugin: InstalledPluginInfo): Promise<void> {
    const confirmed = window.confirm(
      `Uninstall plugin "${plugin.name}"? This will remove the plugin and all its data.`,
    );
    if (!confirmed) return;

    try {
      const result = await eapi().invoke('plugin:uninstall', {
        pluginId: plugin.id,
      });

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.showError((result as any).message);
        return;
      }

      await this.loadInstalledPlugins();
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── UI Helpers ───────────────────────────────────────────────

  private createHeader(
    title: string,
    buttons: Array<{ label: string; title: string; onClick: () => void }>,
  ): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-bottom:1px solid var(--border-color);min-height:36px;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      for (const btn of buttons) {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.title = btn.title;
        el.setAttribute('aria-label', btn.title);
        el.style.cssText =
          'font-size:13px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
        el.addEventListener('click', btn.onClick);
        btnGroup.appendChild(el);
      }

      header.appendChild(btnGroup);
    }

    return header;
  }

  private createTabBar(activeTab: 'installed' | 'catalog'): HTMLElement {
    const bar = document.createElement('div');
    bar.style.cssText =
      'display:flex;border-bottom:1px solid var(--border-color);background:var(--bg-input);';

    const tabs = [
      { id: 'installed' as const, label: 'Installed', onClick: () => this.loadInstalledPlugins() },
      { id: 'catalog' as const, label: 'Catalog', onClick: () => this.loadCatalog() },
    ];

    for (const tab of tabs) {
      const el = document.createElement('button');
      el.textContent = tab.label;
      const isActive = tab.id === activeTab;
      el.style.cssText = `
        flex:1;padding:8px 12px;font-size:11px;font-weight:${isActive ? '600' : '400'};
        color:${isActive ? 'var(--text-primary)' : 'var(--text-dim)'};
        background:transparent;border:none;cursor:pointer;
        border-bottom:2px solid ${isActive ? 'var(--accent,#3b82f6)' : 'transparent'};
      `;
      el.addEventListener('click', tab.onClick);
      bar.appendChild(el);
    }

    return bar;
  }

  private createEmptyState(message: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'text-align:center;padding:32px 16px;color:var(--text-dim);font-size:12px;';
    el.textContent = message;
    return el;
  }

  private showError(message: string): void {
    this.container.innerHTML = '';

    const header = this.createHeader('🧩 Plugins', [
      { label: '↻', title: 'Retry', onClick: () => this.loadInstalledPlugins() },
    ]);
    this.container.appendChild(header);

    const errorEl = document.createElement('div');
    errorEl.style.cssText =
      'margin:12px;padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red,#ef4444);border-radius:8px;font-size:12px;color:var(--red,#ef4444);';
    errorEl.textContent = `Error: ${message}`;
    this.container.appendChild(errorEl);
  }

  private getButtonStyle(variant: 'primary' | 'secondary' | 'danger' | 'warning'): string {
    const base = 'font-size:11px;padding:6px 12px;border-radius:4px;cursor:pointer;border:1px solid;font-weight:500;';
    switch (variant) {
      case 'primary':
        return base + 'background:var(--accent,#3b82f6);color:white;border-color:var(--accent,#3b82f6);';
      case 'secondary':
        return base + 'background:var(--bg-input);color:var(--text-secondary);border-color:var(--border-color);';
      case 'danger':
        return base + 'background:rgba(239,68,68,0.1);color:#ef4444;border-color:#ef4444;';
      case 'warning':
        return base + 'background:rgba(234,179,8,0.1);color:#eab308;border-color:#eab308;';
    }
  }

  private escHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /** Clean up resources. */
  destroy(): void {
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the plugin registry panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderPluginRegistryPanel(
  container: HTMLElement,
): PluginRegistryPanel {
  const panel = new PluginRegistryPanel(container);
  panel.render();
  return panel;
}
