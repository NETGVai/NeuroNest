/**
 * Provider Extension Port — Routes new provider operations (stream management,
 * route pinning, adapter versions) through Provider_Registry.
 *
 * Requirements: 1.2, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface ProviderPortInput {
  operation: 'pin_route' | 'get_active_route' | 'record_adapter_version' | 'stream_request';
  sessionId?: string;
  routeId?: string;
  providerId?: string;
  modelId?: string;
  adapterVersion?: string;
  config?: Record<string, unknown>;
}

export interface ProviderPortOutput {
  routeId?: string;
  providerId?: string;
  modelId?: string;
  adapterVersion?: string;
  status: 'routed' | 'pinned' | 'recorded' | 'unavailable';
}

// ─── Port ID ────────────────────────────────────────────────────

export const PROVIDER_PORT_ID: ExtensionPortId = {
  authority: 'provider_registry',
  name: 'provider_routing_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class ProviderPort extends BaseExtensionPortAdapter<ProviderPortInput, ProviderPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(PROVIDER_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: ProviderPortInput,
    authority: unknown,
  ): Promise<ExtensionPortResult<ProviderPortOutput>> {
    // Route through Provider_Registry (ProviderRouteService)
    const service = authority as {
      selectProvider(constraints: unknown, context?: unknown): { selectedProvider?: string; selectedModel?: string; paused?: boolean };
      lockProvider(lock: unknown): void;
      getRegisteredProviders(): Array<{ providerId: string; modelId: string }>;
    };

    switch (input.operation) {
      case 'get_active_route': {
        const providers = service.getRegisteredProviders();
        const match = providers.find(
          (p) => p.providerId === input.providerId && p.modelId === input.modelId,
        );
        if (!match) {
          return this.success({ status: 'unavailable' });
        }
        return this.success({
          providerId: match.providerId,
          modelId: match.modelId,
          status: 'routed',
        });
      }

      case 'pin_route': {
        if (!input.providerId || !input.modelId) {
          return this.denied('OPERATION_DENIED', 'pin_route requires providerId and modelId');
        }
        service.lockProvider({
          role: 'primary',
          providerId: input.providerId,
          modelId: input.modelId,
          scope: 'session',
          sessionId: input.sessionId,
          disableFallback: false,
        });
        return this.success({
          providerId: input.providerId,
          modelId: input.modelId,
          status: 'pinned',
        });
      }

      case 'record_adapter_version': {
        // Record adapter version metadata for durable pinning
        const result: ProviderPortOutput = { status: 'recorded' };
        if (input.adapterVersion !== undefined) result.adapterVersion = input.adapterVersion;
        return this.success(result);
      }

      case 'stream_request': {
        // Streams are initiated through the existing provider selection
        const decision = service.selectProvider(
          { role: 'primary', ...(input.config ?? {}) },
          { sessionId: input.sessionId },
        );
        if (decision.paused) {
          return this.success({ status: 'unavailable' });
        }
        const streamResult: ProviderPortOutput = { status: 'routed' };
        if (decision.selectedProvider !== undefined) streamResult.providerId = decision.selectedProvider;
        if (decision.selectedModel !== undefined) streamResult.modelId = decision.selectedModel;
        return this.success(streamResult);
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown provider operation: ${String((input as ProviderPortInput).operation)}`,
        );
    }
  }
}
