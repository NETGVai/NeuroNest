/**
 * PluginAPI — Typed extension APIs for plugins to register capabilities.
 *
 * Exposes registration functions:
 * - registerAgent()    — register an AI agent contribution
 * - registerProvider() — register an LLM/model provider
 * - registerTool()     — register a tool contribution
 * - registerPanel()    — register a UI panel contribution
 * - registerCommand()  — register a command contribution
 *
 * Security:
 * - Sandboxes filesystem access to the plugin's declared scope only
 * - Passes all plugin inputs through FirewallEngine for content inspection
 *
 * Requirements: 21.4, 21.8
 */

import * as path from 'path';
import * as fs from 'fs';
import type { PluginCapability, ManifestPermission } from './plugin-manifest.js';

// ─── Registration Types ─────────────────────────────────────────

export interface AgentContribution {
  id: string;
  name: string;
  description: string;
  handler: AgentHandler;
}

export interface ProviderContribution {
  id: string;
  name: string;
  description: string;
  models: string[];
  handler: ProviderHandler;
}

export interface ToolContribution {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export interface PanelContribution {
  id: string;
  name: string;
  description: string;
  renderer: PanelRenderer;
}

export interface CommandContribution {
  id: string;
  name: string;
  description: string;
  handler: CommandHandler;
  keybinding?: string;
}

// ─── Handler Types ──────────────────────────────────────────────

export type AgentHandler = (input: { prompt: string; context?: unknown }) => Promise<{ response: string }>;
export type ProviderHandler = (input: { model: string; messages: unknown[] }) => Promise<{ content: string }>;
export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
export type PanelRenderer = (container: unknown) => void;
export type CommandHandler = (args?: Record<string, unknown>) => Promise<void>;

// ─── Firewall Interface ─────────────────────────────────────────

export interface FirewallGate {
  evaluate(input: string): { allowed: boolean; reason?: string };
}

// ─── Sandbox File System ────────────────────────────────────────

export interface SandboxedFS {
  readFile(relativePath: string): string;
  writeFile(relativePath: string, content: string): void;
  exists(relativePath: string): boolean;
  listDir(relativePath: string): string[];
}

// ─── Plugin API Context ─────────────────────────────────────────

export interface PluginAPIContext {
  pluginName: string;
  pluginDir: string;
  capabilities: PluginCapability[];
  permissions: ManifestPermission[];
  firewallGate?: FirewallGate;
}

// ─── PluginAPI Class ────────────────────────────────────────────

export class PluginAPI {
  private context: PluginAPIContext;
  private agents: Map<string, AgentContribution> = new Map();
  private providers: Map<string, ProviderContribution> = new Map();
  private tools: Map<string, ToolContribution> = new Map();
  private panels: Map<string, PanelContribution> = new Map();
  private commands: Map<string, CommandContribution> = new Map();

  constructor(context: PluginAPIContext) {
    this.context = context;
  }

  /**
   * Register an AI agent contribution.
   *
   * Requires the 'agents' capability in the plugin manifest.
   *
   * Requirements: 21.4
   */
  registerAgent(contribution: AgentContribution): void {
    this.assertCapability('agents');
    this.assertFirewall(contribution.name);

    const qualifiedId = `${this.context.pluginName}.${contribution.id}`;
    this.agents.set(qualifiedId, {
      ...contribution,
      id: qualifiedId,
    });
  }

  /**
   * Register a model/LLM provider contribution.
   *
   * Requires the 'providers' capability in the plugin manifest.
   *
   * Requirements: 21.4
   */
  registerProvider(contribution: ProviderContribution): void {
    this.assertCapability('providers');
    this.assertFirewall(contribution.name);

    const qualifiedId = `${this.context.pluginName}.${contribution.id}`;
    this.providers.set(qualifiedId, {
      ...contribution,
      id: qualifiedId,
    });
  }

  /**
   * Register a tool contribution.
   *
   * Requires the 'tools' capability in the plugin manifest.
   *
   * Requirements: 21.4
   */
  registerTool(contribution: ToolContribution): void {
    this.assertCapability('tools');
    this.assertFirewall(contribution.name);

    const qualifiedId = `${this.context.pluginName}.${contribution.id}`;
    this.tools.set(qualifiedId, {
      ...contribution,
      id: qualifiedId,
    });
  }

  /**
   * Register a UI panel contribution.
   *
   * Requires the 'panels' capability in the plugin manifest.
   *
   * Requirements: 21.4
   */
  registerPanel(contribution: PanelContribution): void {
    this.assertCapability('panels');
    this.assertFirewall(contribution.name);

    const qualifiedId = `${this.context.pluginName}.${contribution.id}`;
    this.panels.set(qualifiedId, {
      ...contribution,
      id: qualifiedId,
    });
  }

  /**
   * Register a command contribution.
   *
   * Requires the 'commands' capability in the plugin manifest.
   *
   * Requirements: 21.4
   */
  registerCommand(contribution: CommandContribution): void {
    this.assertCapability('commands');
    this.assertFirewall(contribution.name);

    const qualifiedId = `${this.context.pluginName}.${contribution.id}`;
    this.commands.set(qualifiedId, {
      ...contribution,
      id: qualifiedId,
    });
  }

  // ─── Sandboxed File System ──────────────────────────────────────

  /**
   * Get a sandboxed filesystem scoped to the plugin's directory.
   *
   * Prevents path traversal outside the plugin's declared scope.
   *
   * Requirements: 21.8
   */
  getSandboxedFS(): SandboxedFS {
    const pluginDir = this.context.pluginDir;
    const hasReadPerm = this.context.permissions.includes('file-read');
    const hasWritePerm = this.context.permissions.includes('file-write');

    const resolveSafe = (relativePath: string): string => {
      const resolved = path.resolve(pluginDir, relativePath);
      // Prevent path traversal outside plugin directory
      if (!resolved.startsWith(pluginDir + path.sep) && resolved !== pluginDir) {
        throw new Error(`Path traversal denied: "${relativePath}" resolves outside plugin scope`);
      }
      return resolved;
    };

    return {
      readFile(relativePath: string): string {
        if (!hasReadPerm) {
          throw new Error('Plugin does not have "file-read" permission');
        }
        const resolved = resolveSafe(relativePath);
        return fs.readFileSync(resolved, 'utf-8');
      },

      writeFile(relativePath: string, content: string): void {
        if (!hasWritePerm) {
          throw new Error('Plugin does not have "file-write" permission');
        }
        const resolved = resolveSafe(relativePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, content, 'utf-8');
      },

      exists(relativePath: string): boolean {
        if (!hasReadPerm) {
          throw new Error('Plugin does not have "file-read" permission');
        }
        const resolved = resolveSafe(relativePath);
        return fs.existsSync(resolved);
      },

      listDir(relativePath: string): string[] {
        if (!hasReadPerm) {
          throw new Error('Plugin does not have "file-read" permission');
        }
        const resolved = resolveSafe(relativePath);
        if (!fs.existsSync(resolved)) return [];
        return fs.readdirSync(resolved);
      },
    };
  }

  // ─── Query Methods ──────────────────────────────────────────────

  /** Get all registered agents for this plugin */
  getAgents(): AgentContribution[] {
    return Array.from(this.agents.values());
  }

  /** Get all registered providers for this plugin */
  getProviders(): ProviderContribution[] {
    return Array.from(this.providers.values());
  }

  /** Get all registered tools for this plugin */
  getTools(): ToolContribution[] {
    return Array.from(this.tools.values());
  }

  /** Get all registered panels for this plugin */
  getPanels(): PanelContribution[] {
    return Array.from(this.panels.values());
  }

  /** Get all registered commands for this plugin */
  getCommands(): CommandContribution[] {
    return Array.from(this.commands.values());
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Assert that the plugin has the required capability.
   */
  private assertCapability(required: PluginCapability): void {
    if (!this.context.capabilities.includes(required)) {
      throw new Error(
        `Plugin "${this.context.pluginName}" attempted to register a ${required} contribution ` +
          `but does not declare the "${required}" capability in its manifest.`,
      );
    }
  }

  /**
   * Pass plugin input through the FirewallEngine for content inspection.
   *
   * Requirements: 21.8
   */
  private assertFirewall(input: string): void {
    if (!this.context.firewallGate) return;

    const result = this.context.firewallGate.evaluate(input);
    if (!result.allowed) {
      throw new Error(
        `Firewall blocked plugin "${this.context.pluginName}" input: ${result.reason ?? 'policy violation'}`,
      );
    }
  }
}

/**
 * Create a PluginAPI instance for a specific plugin.
 *
 * This is the factory function called when a plugin is activated,
 * providing it with its typed extension API.
 */
export function createPluginAPI(context: PluginAPIContext): PluginAPI {
  return new PluginAPI(context);
}
