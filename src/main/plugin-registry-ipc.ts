/**
 * IPC handler registration for the Plugin Registry System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, pipeline-ipc.ts).
 *
 * Channels:
 *   plugin:catalog     — fetch remote plugin catalog from registry URL
 *   plugin:install     — install a plugin from a package URL
 *   plugin:uninstall   — uninstall an installed plugin
 *   plugin:enable      — enable a disabled plugin
 *   plugin:disable     — disable an enabled plugin
 *   plugin:permissions — get permission details for a plugin
 *   plugin:list        — list all installed plugins
 *
 * Requirements: 11.1, 11.6, 23.4
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { PluginSystem } from '../plugins/plugin-system.js';
import type { PluginPermission } from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface PluginRegistryIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let pluginRegistry: PluginRegistry | null = null;

function getPluginRegistry(pluginsDir: string): PluginRegistry {
  if (!pluginRegistry) {
    const pluginSystem = new PluginSystem();
    pluginRegistry = new PluginRegistry(pluginSystem, pluginsDir);
  }
  return pluginRegistry;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): PluginRegistryIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

export interface PluginRegistryIPCOptions {
  pluginsDir: string;
  registryUrl?: string;
}

export function registerPluginRegistryIPC(
  _mainWindow: BrowserWindow,
  options: PluginRegistryIPCOptions,
): void {
  const registry = getPluginRegistry(options.pluginsDir);

  // ── plugin:catalog ──
  // Requirement 11.1: Fetch remote catalog of available plugins from a configured registry URL
  ipcMain.handle(
    'plugin:catalog',
    async (_event, args?: { registryUrl?: string }) => {
      try {
        const url = args?.registryUrl ?? options.registryUrl;
        if (!url) {
          return makeError(
            'NO_REGISTRY_URL',
            new Error('No registry URL configured. Set a registry URL in settings.'),
          );
        }
        const catalog = await registry.fetchRemoteCatalog(url);
        return catalog;
      } catch (err) {
        return makeError('PLUGIN_CATALOG_FAILED', err);
      }
    },
  );

  // ── plugin:install ──
  // Requirement 11.2: Install a plugin from a package URL
  ipcMain.handle(
    'plugin:install',
    async (_event, args: { packageUrl: string }) => {
      try {
        const plugin = await registry.install(args.packageUrl);
        return plugin;
      } catch (err) {
        return makeError('PLUGIN_INSTALL_FAILED', err);
      }
    },
  );

  // ── plugin:uninstall ──
  // Requirement 11.6: Uninstall plugins without restarting the application
  ipcMain.handle(
    'plugin:uninstall',
    async (_event, args: { pluginId: string }) => {
      try {
        await registry.uninstall(args.pluginId);
        return { success: true };
      } catch (err) {
        return makeError('PLUGIN_UNINSTALL_FAILED', err);
      }
    },
  );

  // ── plugin:enable ──
  // Requirement 11.6: Enable plugins without restarting the application
  ipcMain.handle(
    'plugin:enable',
    async (_event, args: { pluginId: string }) => {
      try {
        await registry.enable(args.pluginId);
        return { success: true };
      } catch (err) {
        return makeError('PLUGIN_ENABLE_FAILED', err);
      }
    },
  );

  // ── plugin:disable ──
  // Requirement 11.6: Disable plugins without restarting the application
  ipcMain.handle(
    'plugin:disable',
    async (_event, args: { pluginId: string }) => {
      try {
        await registry.disable(args.pluginId);
        return { success: true };
      } catch (err) {
        return makeError('PLUGIN_DISABLE_FAILED', err);
      }
    },
  );

  // ── plugin:permissions ──
  // Requirement 23.4: Display permission summary showing all requested capabilities
  ipcMain.handle(
    'plugin:permissions',
    async (_event, args: { pluginId: string }) => {
      try {
        const plugins = registry.getInstalledPlugins();
        const plugin = plugins.find((p) => p.id === args.pluginId);

        if (!plugin) {
          return makeError(
            'PLUGIN_NOT_FOUND',
            new Error(`Plugin not found: ${args.pluginId}`),
          );
        }

        const permissions = plugin.manifest.permissions as PluginPermission[];
        const permissionDetails = permissions.map((perm) => ({
          permission: perm,
          granted: registry.checkPermissions(args.pluginId, perm),
          description: getPermissionDescription(perm),
        }));

        return {
          pluginId: args.pluginId,
          pluginName: plugin.manifest.name,
          permissions: permissionDetails,
        };
      } catch (err) {
        return makeError('PLUGIN_PERMISSIONS_FAILED', err);
      }
    },
  );

  // ── plugin:list ──
  // Requirement 11.1: Maintain a local catalog of installed plugins
  ipcMain.handle(
    'plugin:list',
    async () => {
      try {
        const plugins = registry.getInstalledPlugins();
        return plugins.map((p) => ({
          id: p.id,
          name: p.manifest.name,
          version: p.manifest.version,
          description: p.manifest.description,
          author: p.manifest.author,
          permissions: p.manifest.permissions,
          state: p.state,
          installedAt: p.installedAt?.toISOString(),
        }));
      } catch (err) {
        return makeError('PLUGIN_LIST_FAILED', err);
      }
    },
  );
}

// ─── Permission descriptions ────────────────────────────────────

function getPermissionDescription(permission: PluginPermission): string {
  const descriptions: Record<PluginPermission, string> = {
    'file-read': 'Read files from the project workspace',
    'file-write': 'Write or modify files in the project workspace',
    'network-access': 'Make outbound network requests to external services',
    'tool-invoke': 'Invoke other tools registered in the Tool System',
    'shell-execute': 'Execute shell commands on the host system',
    'database-access': 'Access the application database for storage',
  };
  return descriptions[permission] ?? `Unknown permission: ${permission}`;
}
