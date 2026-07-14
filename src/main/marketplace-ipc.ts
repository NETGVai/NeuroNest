/**
 * Marketplace IPC handlers — wires the renderer marketplace panel to the
 * backend MCP marketplace subsystem (catalog, detector, installer).
 *
 * Channels: marketplace:catalog, marketplace:search, marketplace:detect,
 *           marketplace:install, marketplace:uninstall, marketplace:health
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { MarketplaceCatalog, type CatalogSearchOptions } from '../mcp/marketplace-catalog.js';
import { MarketplaceDetector } from '../mcp/marketplace-detector.js';
import { MarketplaceInstaller } from '../mcp/marketplace-installer.js';
import type { FirewallEngineLike } from '../mcp/mcp-server-manager.js';

export interface MarketplaceIPCDeps {
  db: Database.Database;
  projectDir: string;
  firewallEngine?: FirewallEngineLike | null;
}

/**
 * Register all marketplace-related IPC handlers.
 * Called from registerIPCHandlers() in ipc.ts.
 */
export function registerMarketplaceIPC(deps: MarketplaceIPCDeps): void {
  const { db, projectDir, firewallEngine } = deps;

  const catalog = new MarketplaceCatalog(db);
  const detector = new MarketplaceDetector();
  const installer = new MarketplaceInstaller(db, projectDir, firewallEngine);

  // Start periodic catalog sync
  catalog.startPeriodicSync();

  // ── Catalog: get all entries ──

  ipcMain.handle('marketplace:catalog', async () => {
    try {
      return {
        success: true,
        entries: catalog.getAll(),
        categories: catalog.getCategories(),
        lastSync: catalog.getLastSyncTime(),
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Search: filter catalog entries ──

  ipcMain.handle('marketplace:search', async (_event, options: CatalogSearchOptions) => {
    try {
      const results = catalog.search(options || {});
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Detect: project-aware recommendations ──

  ipcMain.handle('marketplace:detect', async (_event, targetDir?: string) => {
    try {
      const dir = targetDir || projectDir;
      const installedIds = installer.getInstalledIds();
      const allEntries = catalog.getAll();
      const detection = detector.detect(dir, allEntries);
      const newRecommendations = detector.getNewRecommendations(dir, allEntries, installedIds);

      return {
        success: true,
        technologies: detection.technologies,
        recommendations: detection.recommendations,
        newRecommendations,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Install: one-click MCP installation ──

  ipcMain.handle('marketplace:install', async (_event, catalogId: string) => {
    try {
      const entry = catalog.getById(catalogId);
      if (!entry) {
        return { success: false, error: `Catalog entry not found: ${catalogId}` };
      }

      const result = await installer.install(entry);
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Uninstall: remove an installed MCP server ──

  ipcMain.handle('marketplace:uninstall', async (_event, serverId: string) => {
    try {
      return installer.uninstall(serverId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Health check: verify connectivity ──

  ipcMain.handle('marketplace:health', async (_event, serverId: string) => {
    try {
      const installation = installer.getInstallation(serverId);
      if (!installation) {
        return { success: false, error: `Installation not found: ${serverId}` };
      }

      const health = await installer.healthCheck(installation);
      return { success: true, ...health };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Sync: force a catalog refresh ──

  ipcMain.handle('marketplace:sync', async () => {
    try {
      const result = await catalog.syncFromRegistry();
      return result;
    } catch (err) {
      return { success: false, entriesUpdated: 0, lastSyncAt: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── List installations ──

  ipcMain.handle('marketplace:installations', async () => {
    try {
      return { success: true, installations: installer.listInstallations() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
