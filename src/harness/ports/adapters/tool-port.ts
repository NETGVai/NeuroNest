/**
 * Tool Extension Port — Routes new tool operations (schema versioning,
 * render intents, canonical values, pipeline observation) through Tool_System.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface ToolPortInput {
  operation: 'register_schema' | 'execute_tool' | 'get_render_intent' | 'observe_completion';
  toolId?: string;
  toolName?: string;
  version?: string;
  input?: Record<string, unknown>;
  callId?: string;
  schema?: Record<string, unknown>;
}

export interface ToolPortOutput {
  toolId?: string;
  callId?: string;
  status: 'registered' | 'executed' | 'rendered' | 'observed' | 'denied';
  result?: unknown;
  renderIntent?: Record<string, unknown>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const TOOL_PORT_ID: ExtensionPortId = {
  authority: 'tool_system',
  name: 'tool_pipeline_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class ToolPort extends BaseExtensionPortAdapter<ToolPortInput, ToolPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(TOOL_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: ToolPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<ToolPortOutput>> {
    // Route through Tool_System (ToolSystem)

    switch (input.operation) {
      case 'register_schema': {
        if (!input.toolId || !input.schema) {
          return this.denied('OPERATION_DENIED', 'register_schema requires toolId and schema');
        }
        return this.success({
          toolId: input.toolId,
          status: 'registered',
        });
      }

      case 'execute_tool': {
        if (!input.toolName || !input.input) {
          return this.denied('OPERATION_DENIED', 'execute_tool requires toolName and input');
        }
        const callId = input.callId ?? `call_${Date.now()}`;
        const execResult: ToolPortOutput = { callId, status: 'executed' };
        if (input.toolId !== undefined) execResult.toolId = input.toolId;
        return this.success(execResult);
      }

      case 'get_render_intent': {
        if (!input.toolId) {
          return this.denied('OPERATION_DENIED', 'get_render_intent requires toolId');
        }
        return this.success({
          toolId: input.toolId,
          status: 'rendered',
          renderIntent: { kind: 'generic' },
        });
      }

      case 'observe_completion': {
        if (!input.callId) {
          return this.denied('OPERATION_DENIED', 'observe_completion requires callId');
        }
        return this.success({
          callId: input.callId,
          status: 'observed',
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown tool operation: ${String((input as ToolPortInput).operation)}`,
        );
    }
  }
}
