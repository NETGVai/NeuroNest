/**
 * MCP Process Extension Port — Routes new MCP process operations (stdio supervision,
 * per-process readiness, harness process lifecycle) through MCP_Server_Manager.
 *
 * Requirements: 1.1, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface McpProcessInput {
  operation: 'supervise_stdio' | 'check_readiness' | 'restart_process' | 'stop_process';
  processId: string;
  config?: Record<string, unknown>;
}

export interface McpProcessOutput {
  processId: string;
  status: 'running' | 'ready' | 'stopped' | 'error';
  details?: Record<string, unknown>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const MCP_PROCESS_PORT_ID: ExtensionPortId = {
  authority: 'mcp_server_manager',
  name: 'mcp_process_supervision',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class McpProcessPort extends BaseExtensionPortAdapter<McpProcessInput, McpProcessOutput> {
  constructor(registry: AuthorityRegistry) {
    super(MCP_PROCESS_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: McpProcessInput,
    authority: unknown,
  ): Promise<ExtensionPortResult<McpProcessOutput>> {
    // The authority is the MCPServerManager instance.
    // Route all process operations through its lifecycle methods.
    const manager = authority as {
      connect(serverId: string): Promise<unknown[]>;
      removeServer(serverId: string): void;
      listServers(): Array<{ id: string; status: string }>;
    };

    switch (input.operation) {
      case 'check_readiness': {
        const servers = manager.listServers();
        const target = servers.find((s) => s.id === input.processId);
        if (!target) {
          return this.success({
            processId: input.processId,
            status: 'error',
            details: { reason: 'Process not found in MCP_Server_Manager registry' },
          });
        }
        return this.success({
          processId: input.processId,
          status: target.status === 'connected' ? 'ready' : 'stopped',
        });
      }

      case 'supervise_stdio': {
        try {
          await manager.connect(input.processId);
          return this.success({ processId: input.processId, status: 'running' });
        } catch {
          return this.success({
            processId: input.processId,
            status: 'error',
            details: { reason: 'Failed to establish stdio supervision' },
          });
        }
      }

      case 'stop_process': {
        manager.removeServer(input.processId);
        return this.success({ processId: input.processId, status: 'stopped' });
      }

      case 'restart_process': {
        manager.removeServer(input.processId);
        try {
          await manager.connect(input.processId);
          return this.success({ processId: input.processId, status: 'running' });
        } catch {
          return this.success({
            processId: input.processId,
            status: 'error',
            details: { reason: 'Restart failed during reconnection' },
          });
        }
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown MCP process operation: ${String((input as McpProcessInput).operation)}`,
        );
    }
  }
}
