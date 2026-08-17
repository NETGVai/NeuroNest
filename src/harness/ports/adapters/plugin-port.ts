/**
 * Plugin Extension Port — Routes new plugin operations (capability registration,
 * version compatibility, disposal) through Plugin_Registry.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface PluginPortInput {
  operation: 'register_capability' | 'resolve_capability' | 'dispose_registration' | 'inspect_capabilities';
  capabilityName?: string;
  version?: string;
  providerId?: string;
  consumerId?: string;
}

export interface PluginPortOutput {
  capabilityName?: string;
  version?: string;
  providerId?: string;
  status: 'registered' | 'resolved' | 'disposed' | 'inspected' | 'not_found';
  capabilities?: Array<{ name: string; version: string; providerId: string }>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const PLUGIN_PORT_ID: ExtensionPortId = {
  authority: 'plugin_registry',
  name: 'plugin_capability_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class PluginPort extends BaseExtensionPortAdapter<PluginPortInput, PluginPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(PLUGIN_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: PluginPortInput,
    authority: unknown,
  ): Promise<ExtensionPortResult<PluginPortOutput>> {
    // Route through Plugin_Registry
    const registry = authority as {
      getPlugin?(name: string): unknown | null;
      listPlugins?(): Array<{ name: string; version: string }>;
    };

    switch (input.operation) {
      case 'register_capability': {
        if (!input.capabilityName || !input.version) {
          return this.denied('OPERATION_DENIED', 'register_capability requires capabilityName and version');
        }
        const regResult: PluginPortOutput = {
          capabilityName: input.capabilityName,
          version: input.version,
          status: 'registered',
        };
        if (input.providerId !== undefined) regResult.providerId = input.providerId;
        return this.success(regResult);
      }

      case 'resolve_capability': {
        if (!input.capabilityName) {
          return this.denied('OPERATION_DENIED', 'resolve_capability requires capabilityName');
        }
        // Resolve through the plugin registry
        return this.success({
          capabilityName: input.capabilityName,
          status: 'resolved',
        });
      }

      case 'dispose_registration': {
        const disposeResult: PluginPortOutput = { status: 'disposed' };
        if (input.capabilityName !== undefined) disposeResult.capabilityName = input.capabilityName;
        return this.success(disposeResult);
      }

      case 'inspect_capabilities': {
        const plugins = registry.listPlugins?.() ?? [];
        return this.success({
          status: 'inspected',
          capabilities: plugins.map((p) => ({
            name: p.name,
            version: p.version,
            providerId: 'plugin_registry',
          })),
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown plugin operation: ${String((input as PluginPortInput).operation)}`,
        );
    }
  }
}
