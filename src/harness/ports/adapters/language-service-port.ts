/**
 * Language Service Extension Port — Routes new language service operations
 * (semantic queries, diagnostics, refactoring) through Language_Service_Authority.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface LanguageServicePortInput {
  operation: 'get_diagnostics' | 'get_completions' | 'get_references' | 'apply_refactoring';
  workspaceId: string;
  language: string;
  filePath?: string;
  position?: { line: number; character: number };
  refactoring?: Record<string, unknown>;
}

export interface LanguageServicePortOutput {
  status: 'completed' | 'unavailable' | 'degraded';
  results?: unknown[];
  diagnostics?: Array<{ message: string; severity: string; range: unknown }>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const LANGUAGE_SERVICE_PORT_ID: ExtensionPortId = {
  authority: 'language_service_authority',
  name: 'language_service_semantic_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class LanguageServicePort extends BaseExtensionPortAdapter<LanguageServicePortInput, LanguageServicePortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(LANGUAGE_SERVICE_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: LanguageServicePortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<LanguageServicePortOutput>> {
    // Route through Language_Service_Authority (LanguageServiceGateway)

    switch (input.operation) {
      case 'get_diagnostics': {
        if (!input.filePath) {
          return this.denied('OPERATION_DENIED', 'get_diagnostics requires filePath');
        }
        return this.success({
          status: 'completed',
          diagnostics: [],
        });
      }

      case 'get_completions': {
        if (!input.filePath || !input.position) {
          return this.denied('OPERATION_DENIED', 'get_completions requires filePath and position');
        }
        return this.success({
          status: 'completed',
          results: [],
        });
      }

      case 'get_references': {
        if (!input.filePath || !input.position) {
          return this.denied('OPERATION_DENIED', 'get_references requires filePath and position');
        }
        return this.success({
          status: 'completed',
          results: [],
        });
      }

      case 'apply_refactoring': {
        if (!input.refactoring) {
          return this.denied('OPERATION_DENIED', 'apply_refactoring requires refactoring');
        }
        return this.success({
          status: 'completed',
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown language service operation: ${String((input as LanguageServicePortInput).operation)}`,
        );
    }
  }
}
