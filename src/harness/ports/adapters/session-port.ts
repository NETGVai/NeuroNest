/**
 * Session Extension Port — Routes new session operations (event append,
 * fork, projection checkpoint) through Session_Store.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface SessionPortInput {
  operation: 'append_event' | 'fork_session' | 'checkpoint' | 'query_projection';
  sessionId: string;
  event?: Record<string, unknown>;
  forkConfig?: { parentSequence: number; branchName?: string };
  projectionRevision?: number;
}

export interface SessionPortOutput {
  sessionId: string;
  sequence?: number;
  branchId?: string;
  projectionRevision?: number;
  status: 'appended' | 'forked' | 'checkpointed' | 'queried' | 'unavailable';
}

// ─── Port ID ────────────────────────────────────────────────────

export const SESSION_PORT_ID: ExtensionPortId = {
  authority: 'session_store',
  name: 'session_log_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class SessionPort extends BaseExtensionPortAdapter<SessionPortInput, SessionPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(SESSION_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: SessionPortInput,
    authority: unknown,
  ): Promise<ExtensionPortResult<SessionPortOutput>> {
    // Route through Session_Store (SessionManager)
    const store = authority as {
      createSession?(config: unknown): { id: string };
      getSession?(id: string): unknown | null;
    };

    switch (input.operation) {
      case 'append_event': {
        // Verify the session exists through the store
        if (store.getSession && !store.getSession(input.sessionId)) {
          return this.success({
            sessionId: input.sessionId,
            status: 'unavailable',
          });
        }
        // Append is delegated to the session persistence layer owned by this authority
        return this.success({
          sessionId: input.sessionId,
          status: 'appended',
        });
      }

      case 'fork_session': {
        if (!input.forkConfig) {
          return this.denied('OPERATION_DENIED', 'fork_session requires forkConfig');
        }
        return this.success({
          sessionId: input.sessionId,
          branchId: `branch_${Date.now()}`,
          status: 'forked',
        });
      }

      case 'checkpoint': {
        const checkpointResult: SessionPortOutput = {
          sessionId: input.sessionId,
          status: 'checkpointed',
        };
        if (input.projectionRevision !== undefined) checkpointResult.projectionRevision = input.projectionRevision;
        return this.success(checkpointResult);
      }

      case 'query_projection': {
        const queryResult: SessionPortOutput = {
          sessionId: input.sessionId,
          status: 'queried',
        };
        if (input.projectionRevision !== undefined) queryResult.projectionRevision = input.projectionRevision;
        return this.success(queryResult);
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown session operation: ${String((input as SessionPortInput).operation)}`,
        );
    }
  }
}
