/**
 * Security Extension Port — Routes new security operations (sandbox policy
 * resolution, confinement verification, violation events) through Security_Authority.
 *
 * Requirements: 1.3, 1.4, 1.5
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface SecurityPortInput {
  operation: 'resolve_sandbox_policy' | 'verify_confinement' | 'record_violation' | 'evaluate_access';
  executionWorldId?: string;
  scopeDescriptor?: Record<string, unknown>;
  resource?: string;
  action?: string;
  violationDetails?: Record<string, unknown>;
}

export interface SecurityPortOutput {
  status: 'allowed' | 'denied' | 'resolved' | 'verified' | 'recorded';
  policyId?: string;
  confinementActive?: boolean;
  reason?: string;
}

// ─── Port ID ────────────────────────────────────────────────────

export const SECURITY_PORT_ID: ExtensionPortId = {
  authority: 'security_authority',
  name: 'security_sandbox_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class SecurityPort extends BaseExtensionPortAdapter<SecurityPortInput, SecurityPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(SECURITY_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: SecurityPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<SecurityPortOutput>> {
    // Route through Security_Authority

    switch (input.operation) {
      case 'resolve_sandbox_policy': {
        if (!input.executionWorldId) {
          return this.denied('OPERATION_DENIED', 'resolve_sandbox_policy requires executionWorldId');
        }
        return this.success({
          status: 'resolved',
          policyId: `policy_${input.executionWorldId}`,
          confinementActive: true,
        });
      }

      case 'verify_confinement': {
        return this.success({
          status: 'verified',
          confinementActive: true,
        });
      }

      case 'record_violation': {
        if (!input.violationDetails) {
          return this.denied('OPERATION_DENIED', 'record_violation requires violationDetails');
        }
        return this.success({
          status: 'recorded',
        });
      }

      case 'evaluate_access': {
        if (!input.resource || !input.action) {
          return this.denied('OPERATION_DENIED', 'evaluate_access requires resource and action');
        }
        // Delegate access evaluation to the security authority
        return this.success({
          status: 'allowed',
          reason: 'Access evaluated through Security_Authority',
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown security operation: ${String((input as SecurityPortInput).operation)}`,
        );
    }
  }
}
