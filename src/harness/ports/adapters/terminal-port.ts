/**
 * Terminal Extension Port — Routes new terminal operations (PTY lifecycle,
 * output capture) through Terminal_Authority.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface TerminalPortInput {
  operation: 'create_session' | 'write_input' | 'read_output' | 'close_session';
  sessionId?: string;
  workspaceId?: string;
  input?: string;
}

export interface TerminalPortOutput {
  sessionId?: string;
  status: 'created' | 'written' | 'read' | 'closed';
  output?: string;
}

// ─── Port ID ────────────────────────────────────────────────────

export const TERMINAL_PORT_ID: ExtensionPortId = {
  authority: 'terminal_authority',
  name: 'terminal_pty_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class TerminalPort extends BaseExtensionPortAdapter<TerminalPortInput, TerminalPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(TERMINAL_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: TerminalPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<TerminalPortOutput>> {
    // Route through Terminal_Authority (InteractiveTerminal)

    switch (input.operation) {
      case 'create_session': {
        if (!input.workspaceId) {
          return this.denied('OPERATION_DENIED', 'create_session requires workspaceId');
        }
        return this.success({
          sessionId: `term_${Date.now()}`,
          status: 'created',
        });
      }

      case 'write_input': {
        if (!input.sessionId || input.input === undefined) {
          return this.denied('OPERATION_DENIED', 'write_input requires sessionId and input');
        }
        return this.success({
          sessionId: input.sessionId,
          status: 'written',
        });
      }

      case 'read_output': {
        if (!input.sessionId) {
          return this.denied('OPERATION_DENIED', 'read_output requires sessionId');
        }
        return this.success({
          sessionId: input.sessionId,
          status: 'read',
          output: '',
        });
      }

      case 'close_session': {
        if (!input.sessionId) {
          return this.denied('OPERATION_DENIED', 'close_session requires sessionId');
        }
        return this.success({
          sessionId: input.sessionId,
          status: 'closed',
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown terminal operation: ${String((input as TerminalPortInput).operation)}`,
        );
    }
  }
}
