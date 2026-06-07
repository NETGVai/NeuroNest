/**
 * PluginSystem — Plugin lifecycle, isolation, registration.
 *
 * Stub implementation with in-memory state. Manages plugin loading,
 * manifest validation, lifecycle hooks, and execution isolation.
 *
 * Requirements: 17.1–17.9
 */

import type { PluginManifest } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export type PluginState = 'loaded' | 'active' | 'disabled' | 'error';

export interface Plugin {
  id: string;
  manifest: PluginManifest;
  state: PluginState;
  installedAt: Date;
  error?: string;
}

export interface PluginLifecycleHooks {
  init?: () => Promise<void>;
  activate?: () => Promise<void>;
  deactivate?: () => Promise<void>;
  uninstall?: () => Promise<void>;
}

// ─── Manifest validation ────────────────────────────────────────

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    errors.push('version is required and must be a non-empty string');
  }
  if (typeof m.description !== 'string') {
    errors.push('description is required and must be a string');
  }
  if (typeof m.author !== 'string') {
    errors.push('author is required and must be a string');
  }
  if (typeof m.entryPoint !== 'string' || m.entryPoint.length === 0) {
    errors.push('entryPoint is required and must be a non-empty string');
  }
  if (!m.permissions || !Array.isArray(m.permissions)) {
    errors.push('permissions must be an array');
  }
  if (!m.dependencies || typeof m.dependencies !== 'object') {
    errors.push('dependencies must be an object');
  }

  return { valid: errors.length === 0, errors };
}

// ─── PluginSystem ───────────────────────────────────────────────

export class PluginSystem {
  private plugins = new Map<string, Plugin>();
  private hooks = new Map<string, PluginLifecycleHooks>();

  /**
   * Load plugins from a directory (stub: accepts manifest array).
   * Requirements: 17.2, 17.3
   */
  async loadPlugins(manifests: PluginManifest[]): Promise<Plugin[]> {
    const loaded: Plugin[] = [];

    for (const manifest of manifests) {
      const validation = validateManifest(manifest);
      if (!validation.valid) {
        const plugin: Plugin = {
          id: manifest.name ?? `invalid-${Date.now()}`,
          manifest,
          state: 'error',
          installedAt: new Date(),
          error: `Invalid manifest: ${validation.errors.join('; ')}`,
        };
        this.plugins.set(plugin.id, plugin);
        continue;
      }

      const plugin: Plugin = {
        id: manifest.name,
        manifest,
        state: 'loaded',
        installedAt: new Date(),
      };
      this.plugins.set(plugin.id, plugin);
      loaded.push(plugin);
    }

    return loaded;
  }

  /**
   * Get a plugin by ID.
   */
  getPlugin(pluginId: string): Plugin | null {
    return this.plugins.get(pluginId) ?? null;
  }

  /**
   * List all plugins.
   */
  listPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Enable a plugin.
   * Requirements: 17.5, 17.6
   */
  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    if (plugin.state === 'error') throw new Error(`Cannot enable plugin with errors: ${plugin.error}`);

    // Run lifecycle hooks
    const hooks = this.hooks.get(pluginId);
    if (hooks?.activate) {
      await hooks.activate();
    }

    plugin.state = 'active';
  }

  /**
   * Disable a plugin.
   * Requirements: 17.5, 17.6
   */
  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

    const hooks = this.hooks.get(pluginId);
    if (hooks?.deactivate) {
      await hooks.deactivate();
    }

    plugin.state = 'disabled';
  }

  /**
   * Remove a plugin.
   * Requirements: 17.6
   */
  async removePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

    const hooks = this.hooks.get(pluginId);
    if (hooks?.uninstall) {
      await hooks.uninstall();
    }

    this.plugins.delete(pluginId);
    this.hooks.delete(pluginId);
  }

  /**
   * Register lifecycle hooks for a plugin.
   * Requirements: 17.5
   */
  registerHooks(pluginId: string, hooks: PluginLifecycleHooks): void {
    this.hooks.set(pluginId, hooks);
  }
}
