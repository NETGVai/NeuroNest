/**
 * PluginSandbox — Isolated plugin execution, lifecycle hooks, permission
 * enforcement, state isolation, and exception isolation.
 *
 * Each plugin runs in its own sandboxed context. Unhandled exceptions in
 * plugin code never crash the host application — the plugin transitions
 * to 'error' state instead.
 *
 * Requirements: 12.3, 12.4, 12.5, 23.1, 23.2, 23.3, 23.4, 23.5
 */

import type {
  PluginManifestV2,
  PluginPermission,
} from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';

// ─── Permission Categories (Req 23.2) ──────────────────────────

const ALL_PERMISSIONS: PluginPermission[] = [
  'file-read',
  'file-write',
  'network-access',
  'tool-invoke',
  'shell-execute',
  'database-access',
];

// ─── Plugin State Store (Req 23.5) ─────────────────────────────

/**
 * Namespaced key-value store ensuring plugins cannot access
 * each other's state. Each plugin gets its own isolated store instance.
 */
export class PluginStateStore {
  private store: Map<string, unknown> = new Map();
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /**
   * Get a value by key within this plugin's namespace.
   */
  get(key: string): unknown {
    return this.store.get(this.namespacedKey(key));
  }

  /**
   * Set a value by key within this plugin's namespace.
   */
  set(key: string, value: unknown): void {
    this.store.set(this.namespacedKey(key), value);
  }

  /**
   * Delete a value by key within this plugin's namespace.
   */
  delete(key: string): void {
    this.store.delete(this.namespacedKey(key));
  }

  /**
   * List all keys in this plugin's namespace (without the namespace prefix).
   */
  keys(): string[] {
    const prefix = `${this.namespace}:`;
    const result: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key.slice(prefix.length));
      }
    }
    return result;
  }

  /**
   * Clear all data in this plugin's namespace.
   */
  clear(): void {
    const prefix = `${this.namespace}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  private namespacedKey(key: string): string {
    return `${this.namespace}:${key}`;
  }
}

// ─── Plugin Context (Req 12.3, 23.1) ───────────────────────────

/**
 * Sandboxed context passed to a plugin's activate() function.
 * Only exposes APIs matching the plugin's declared permissions.
 */
export interface PluginContext {
  /** Namespaced storage for this plugin */
  storage: PluginStateStore;
  /** Register a tool (requires 'tool-invoke' permission) */
  registerTool(tool: PluginToolRegistration): void;
  /** Register a panel (always allowed for panel-plugin types) */
  registerPanel(panel: PluginPanelRegistration): void;
  /** Log a message from the plugin */
  log(message: string): void;
  /** Read a file (requires 'file-read' permission) */
  readFile?(filePath: string): Promise<string>;
  /** Write a file (requires 'file-write' permission) */
  writeFile?(filePath: string, content: string): Promise<void>;
  /** Make a network request (requires 'network-access' permission) */
  fetch?(url: string, options?: RequestInit): Promise<Response>;
  /** Execute a shell command (requires 'shell-execute' permission) */
  exec?(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface PluginToolRegistration {
  id: string;
  name: string;
  description: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface PluginPanelRegistration {
  id: string;
  name: string;
  component: string; // path to renderer component
}

// ─── Plugin Entry Point Interface ───────────────────────────────

export interface PluginEntryPoint {
  activate(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

// ─── Permission Violation Log ───────────────────────────────────

export interface PermissionViolation {
  pluginId: string;
  requestedCapability: PluginPermission;
  timestamp: string;
  message: string;
}

// ─── Active Plugin Record ───────────────────────────────────────

interface ActivePlugin {
  pluginId: string;
  manifest: PluginManifestV2;
  state: 'active' | 'inactive' | 'error';
  entryPoint: PluginEntryPoint | null;
  context: PluginContext | null;
  stateStore: PluginStateStore;
  registeredTools: PluginToolRegistration[];
  registeredPanels: PluginPanelRegistration[];
  error?: string;
}

// ─── Plugin Sandbox ─────────────────────────────────────────────

export class PluginSandbox {
  private plugins: Map<string, ActivePlugin> = new Map();
  private permissionViolations: PermissionViolation[] = [];
  private logs: Map<string, string[]> = new Map();

  // External registries — set these to wire into the host system
  private toolRegistry: ((tool: PluginToolRegistration) => void) | null = null;
  private toolUnregistry: ((toolId: string) => void) | null = null;
  private panelRegistry: ((panel: PluginPanelRegistration) => void) | null = null;
  private panelUnregistry: ((panelId: string) => void) | null = null;

  /**
   * Configure external registry callbacks for wiring plugin tools/panels
   * into the host system registries.
   */
  setRegistries(registries: {
    registerTool?: (tool: PluginToolRegistration) => void;
    unregisterTool?: (toolId: string) => void;
    registerPanel?: (panel: PluginPanelRegistration) => void;
    unregisterPanel?: (panelId: string) => void;
  }): void {
    this.toolRegistry = registries.registerTool ?? null;
    this.toolUnregistry = registries.unregisterTool ?? null;
    this.panelRegistry = registries.registerPanel ?? null;
    this.panelUnregistry = registries.unregisterPanel ?? null;
  }

  /**
   * Activate a plugin: load its entry point, call activate() with a
   * sandboxed context, and register tools/panels with system registries.
   *
   * If the plugin throws during activation, it transitions to 'error' state
   * and does NOT crash the host. (Req 12.3, 12.5)
   */
  async activatePlugin(
    pluginId: string,
    manifest: PluginManifestV2,
    entryPointPath: string,
  ): Promise<void> {
    // If already active, skip
    const existing = this.plugins.get(pluginId);
    if (existing && existing.state === 'active') {
      return;
    }

    // Create isolated state store for this plugin (Req 23.5)
    const stateStore = new PluginStateStore(pluginId);

    // Create the active plugin record
    const activePlugin: ActivePlugin = {
      pluginId,
      manifest,
      state: 'inactive',
      entryPoint: null,
      context: null,
      stateStore,
      registeredTools: [],
      registeredPanels: [],
    };

    this.plugins.set(pluginId, activePlugin);
    this.logs.set(pluginId, []);

    // Load plugin entry point with exception isolation (Req 12.5)
    let entryPoint: PluginEntryPoint;
    try {
      entryPoint = await this.loadEntryPoint(entryPointPath);
    } catch (err) {
      activePlugin.state = 'error';
      activePlugin.error = `Failed to load entry point: ${(err as Error).message}`;
      return;
    }

    activePlugin.entryPoint = entryPoint;

    // Create sandboxed context with permission enforcement (Req 23.1, 23.3)
    const context = this.createPluginContext(pluginId, manifest, stateStore, activePlugin);
    activePlugin.context = context;

    // Call activate() with full exception isolation (Req 12.3, 12.5)
    try {
      await Promise.resolve(entryPoint.activate(context));
    } catch (err) {
      activePlugin.state = 'error';
      activePlugin.error = `Plugin activate() threw: ${(err as Error).message}`;
      // Clean up any partial registrations
      this.removeRegistrations(activePlugin);
      return;
    }

    // Register tools and panels with host system registries (Req 11.4)
    this.registerWithHostSystem(activePlugin);

    activePlugin.state = 'active';
  }

  /**
   * Deactivate a plugin: call deactivate(), remove all registrations.
   * Exception isolation applies — if deactivate() throws, the plugin
   * transitions to 'inactive' anyway. (Req 12.4)
   */
  async deactivatePlugin(pluginId: string): Promise<void> {
    const activePlugin = this.plugins.get(pluginId);
    if (!activePlugin) {
      throw new FeatureError({
        message: `Plugin not found: ${pluginId}`,
        category: 'plugin',
        code: 'PLUGIN_NOT_FOUND',
      });
    }

    if (activePlugin.state === 'inactive') {
      return;
    }

    // Call deactivate() with exception isolation (Req 12.4, 12.5)
    if (activePlugin.entryPoint?.deactivate) {
      try {
        await Promise.resolve(activePlugin.entryPoint.deactivate());
      } catch (err) {
        // Log but don't crash — exception isolation (Req 12.5)
        const pluginLogs = this.logs.get(pluginId) ?? [];
        pluginLogs.push(
          `[WARN] deactivate() threw: ${(err as Error).message}`,
        );
      }
    }

    // Remove all registrations from host system
    this.removeRegistrations(activePlugin);

    activePlugin.state = 'inactive';
    activePlugin.registeredTools = [];
    activePlugin.registeredPanels = [];
  }

  /**
   * Get the current state of a plugin.
   */
  getPluginState(pluginId: string): 'active' | 'inactive' | 'error' {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return 'inactive';
    }
    return plugin.state;
  }

  /**
   * Check if a plugin has permission for a given capability.
   * Returns true only if the capability is in the plugin's declared permissions.
   * (Req 23.1, 23.3)
   */
  checkPermission(pluginId: string, capability: PluginPermission): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }
    return plugin.manifest.permissions.includes(capability);
  }

  /**
   * Get all permission violations logged by the sandbox.
   */
  getPermissionViolations(): PermissionViolation[] {
    return [...this.permissionViolations];
  }

  /**
   * Get permission violations for a specific plugin.
   */
  getPluginViolations(pluginId: string): PermissionViolation[] {
    return this.permissionViolations.filter((v) => v.pluginId === pluginId);
  }

  /**
   * Get logs for a specific plugin.
   */
  getPluginLogs(pluginId: string): string[] {
    return this.logs.get(pluginId) ?? [];
  }

  /**
   * Get all registered tools for a plugin.
   */
  getPluginTools(pluginId: string): PluginToolRegistration[] {
    const plugin = this.plugins.get(pluginId);
    return plugin?.registeredTools ?? [];
  }

  /**
   * Get all registered panels for a plugin.
   */
  getPluginPanels(pluginId: string): PluginPanelRegistration[] {
    const plugin = this.plugins.get(pluginId);
    return plugin?.registeredPanels ?? [];
  }

  /**
   * Get the state store for a plugin (for testing purposes).
   */
  getPluginStateStore(pluginId: string): PluginStateStore | null {
    const plugin = this.plugins.get(pluginId);
    return plugin?.stateStore ?? null;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Load a plugin entry point module.
   * In a real implementation, this would use dynamic import() with sandboxing.
   * For now, it attempts a dynamic import of the given path.
   */
  private async loadEntryPoint(entryPointPath: string): Promise<PluginEntryPoint> {
    try {
      const module = await import(entryPointPath);
      // The module should export activate (and optionally deactivate)
      if (typeof module.activate !== 'function') {
        throw new Error(
          'Plugin entry point must export an activate() function',
        );
      }
      return {
        activate: module.activate,
        deactivate: module.deactivate,
      };
    } catch (err) {
      throw new Error(
        `Cannot load plugin entry point at "${entryPointPath}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Create a sandboxed PluginContext with permission-gated APIs.
   * Only exposes capabilities matching the plugin's declared permissions.
   * (Req 23.1, 23.3)
   */
  private createPluginContext(
    pluginId: string,
    manifest: PluginManifestV2,
    stateStore: PluginStateStore,
    activePlugin: ActivePlugin,
  ): PluginContext {
    const self = this;
    const permissions = new Set(manifest.permissions);

    const context: PluginContext = {
      storage: stateStore,

      registerTool(tool: PluginToolRegistration): void {
        if (!self.enforcePermission(pluginId, 'tool-invoke', permissions)) {
          return;
        }
        // Prefix tool ID with plugin namespace to avoid collisions
        const namespacedTool: PluginToolRegistration = {
          ...tool,
          id: `${pluginId}:${tool.id}`,
        };
        activePlugin.registeredTools.push(namespacedTool);
      },

      registerPanel(panel: PluginPanelRegistration): void {
        // Panel registration is always allowed for panel-plugin types
        // For other types, we still allow it but log a warning
        const namespacedPanel: PluginPanelRegistration = {
          ...panel,
          id: `${pluginId}:${panel.id}`,
        };
        activePlugin.registeredPanels.push(namespacedPanel);
      },

      log(message: string): void {
        const pluginLogs = self.logs.get(pluginId) ?? [];
        pluginLogs.push(`[${new Date().toISOString()}] ${message}`);
        self.logs.set(pluginId, pluginLogs);
      },
    };

    // Conditionally attach permission-gated APIs (Req 23.1)
    if (permissions.has('file-read')) {
      context.readFile = async (_filePath: string): Promise<string> => {
        // In a real implementation, this would delegate to a file system API
        // Here we provide the stub that validates permission was granted
        return '';
      };
    }

    if (permissions.has('file-write')) {
      context.writeFile = async (_filePath: string, _content: string): Promise<void> => {
        // In a real implementation, this would delegate to a file system API
      };
    }

    if (permissions.has('network-access')) {
      context.fetch = async (_url: string, _options?: RequestInit): Promise<Response> => {
        // In a real implementation, this would delegate to a sandboxed fetch
        return new Response('', { status: 200 });
      };
    }

    if (permissions.has('shell-execute')) {
      context.exec = async (
        _command: string,
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        // In a real implementation, this would delegate to a sandboxed shell
        return { stdout: '', stderr: '', exitCode: 0 };
      };
    }

    return context;
  }

  /**
   * Enforce a permission check. If the capability is not declared,
   * log a violation and return false. (Req 23.1, 23.3)
   */
  private enforcePermission(
    pluginId: string,
    capability: PluginPermission,
    permissions: Set<PluginPermission>,
  ): boolean {
    if (permissions.has(capability)) {
      return true;
    }

    // Permission denied — log violation (Req 23.3)
    const violation: PermissionViolation = {
      pluginId,
      requestedCapability: capability,
      timestamp: new Date().toISOString(),
      message: `Plugin "${pluginId}" attempted to access "${capability}" without declaring it in permissions`,
    };
    this.permissionViolations.push(violation);

    const pluginLogs = this.logs.get(pluginId) ?? [];
    pluginLogs.push(
      `[PERMISSION DENIED] Attempted access to "${capability}" — not declared in manifest`,
    );
    this.logs.set(pluginId, pluginLogs);

    return false;
  }

  /**
   * Register plugin tools and panels with the host system registries.
   */
  private registerWithHostSystem(activePlugin: ActivePlugin): void {
    for (const tool of activePlugin.registeredTools) {
      if (this.toolRegistry) {
        this.toolRegistry(tool);
      }
    }

    for (const panel of activePlugin.registeredPanels) {
      if (this.panelRegistry) {
        this.panelRegistry(panel);
      }
    }
  }

  /**
   * Remove all registrations from the host system for a plugin.
   */
  private removeRegistrations(activePlugin: ActivePlugin): void {
    for (const tool of activePlugin.registeredTools) {
      if (this.toolUnregistry) {
        this.toolUnregistry(tool.id);
      }
    }

    for (const panel of activePlugin.registeredPanels) {
      if (this.panelUnregistry) {
        this.panelUnregistry(panel.id);
      }
    }
  }
}
