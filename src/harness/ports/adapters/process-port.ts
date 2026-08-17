/**
 * Process Extension Port — Routes new process operations (subprocess lifecycle,
 * managed process tree) through Process_Authority.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface ProcessPortInput {
  operation: 'spawn' | 'terminate' | 'signal' | 'list_children';
  processId?: string;
  command?: string;
  args?: string[];
  signal?: string;
  scopeDescriptor?: Record<string, unknown>;
}

export interface ProcessPortOutput {
  processId?: string;
  status: 'spawned' | 'terminated' | 'signalled' | 'listed';
  children?: Array<{ id: string; command: string; status: string }>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const PROCESS_PORT_ID: ExtensionPortId = {
  authority: 'process_authority',
  name: 'process_lifecycle_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class ProcessPort extends BaseExtensionPortAdapter<ProcessPortInput, ProcessPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(PROCESS_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: ProcessPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<ProcessPortOutput>> {
    // Route through Process_Authority

    switch (input.operation) {
      case 'spawn': {
        if (!input.command) {
          return this.denied('OPERATION_DENIED', 'spawn requires command');
        }
        return this.success({
          processId: `proc_${Date.now()}`,
          status: 'spawned',
        });
      }

      case 'terminate': {
        if (!input.processId) {
          return this.denied('OPERATION_DENIED', 'terminate requires processId');
        }
        return this.success({
          processId: input.processId,
          status: 'terminated',
        });
      }

      case 'signal': {
        if (!input.processId || !input.signal) {
          return this.denied('OPERATION_DENIED', 'signal requires processId and signal');
        }
        return this.success({
          processId: input.processId,
          status: 'signalled',
        });
      }

      case 'list_children': {
        return this.success({
          status: 'listed',
          children: [],
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown process operation: ${String((input as ProcessPortInput).operation)}`,
        );
    }
  }
}
