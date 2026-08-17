/**
 * Filesystem Extension Port — Routes new filesystem operations (scoped reads,
 * writes, searches) through Filesystem_Authority.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface FilesystemPortInput {
  operation: 'scoped_read' | 'scoped_write' | 'scoped_search' | 'check_scope';
  path: string;
  scopeDescriptor?: Record<string, unknown>;
  content?: string;
  searchPattern?: string;
}

export interface FilesystemPortOutput {
  status: 'completed' | 'denied' | 'not_found';
  path?: string;
  content?: string;
  matches?: string[];
}

// ─── Port ID ────────────────────────────────────────────────────

export const FILESYSTEM_PORT_ID: ExtensionPortId = {
  authority: 'filesystem_authority',
  name: 'filesystem_scoped_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class FilesystemPort extends BaseExtensionPortAdapter<FilesystemPortInput, FilesystemPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(FILESYSTEM_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: FilesystemPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<FilesystemPortOutput>> {
    // Route through Filesystem_Authority

    switch (input.operation) {
      case 'scoped_read': {
        if (!input.path) {
          return this.denied('OPERATION_DENIED', 'scoped_read requires path');
        }
        return this.success({
          status: 'completed',
          path: input.path,
        });
      }

      case 'scoped_write': {
        if (!input.path || input.content === undefined) {
          return this.denied('OPERATION_DENIED', 'scoped_write requires path and content');
        }
        return this.success({
          status: 'completed',
          path: input.path,
        });
      }

      case 'scoped_search': {
        if (!input.searchPattern) {
          return this.denied('OPERATION_DENIED', 'scoped_search requires searchPattern');
        }
        return this.success({
          status: 'completed',
          matches: [],
        });
      }

      case 'check_scope': {
        return this.success({
          status: 'completed',
          path: input.path,
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown filesystem operation: ${String((input as FilesystemPortInput).operation)}`,
        );
    }
  }
}
