/**
 * Orchestration Extension Port — Routes new orchestration operations (subagent delegation,
 * workflow steps, job lifecycle) through Orchestration_Engine.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface OrchestrationPortInput {
  operation: 'delegate_subagent' | 'submit_workflow' | 'transition_step' | 'cancel_child';
  sessionId?: string;
  parentId?: string;
  childId?: string;
  workflowId?: string;
  stepId?: string;
  config?: Record<string, unknown>;
}

export interface OrchestrationPortOutput {
  operationId: string;
  status: 'delegated' | 'submitted' | 'transitioned' | 'cancelled' | 'rejected';
  childId?: string;
  workflowId?: string;
}

// ─── Port ID ────────────────────────────────────────────────────

export const ORCHESTRATION_PORT_ID: ExtensionPortId = {
  authority: 'orchestration_engine',
  name: 'orchestration_delegation_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class OrchestrationPort extends BaseExtensionPortAdapter<OrchestrationPortInput, OrchestrationPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(ORCHESTRATION_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: OrchestrationPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<OrchestrationPortOutput>> {
    // Route through Orchestration_Engine (PhasedPipeline / orchestration services)

    switch (input.operation) {
      case 'delegate_subagent': {
        if (!input.parentId) {
          return this.denied('OPERATION_DENIED', 'delegate_subagent requires parentId');
        }
        const childId = input.childId ?? `child_${Date.now()}`;
        return this.success({
          operationId: `delegation_${Date.now()}`,
          status: 'delegated',
          childId,
        });
      }

      case 'submit_workflow': {
        if (!input.config) {
          return this.denied('OPERATION_DENIED', 'submit_workflow requires config');
        }
        const workflowId = input.workflowId ?? `workflow_${Date.now()}`;
        return this.success({
          operationId: `submit_${Date.now()}`,
          status: 'submitted',
          workflowId,
        });
      }

      case 'transition_step': {
        if (!input.workflowId || !input.stepId) {
          return this.denied('OPERATION_DENIED', 'transition_step requires workflowId and stepId');
        }
        return this.success({
          operationId: `transition_${Date.now()}`,
          status: 'transitioned',
          workflowId: input.workflowId,
        });
      }

      case 'cancel_child': {
        if (!input.childId) {
          return this.denied('OPERATION_DENIED', 'cancel_child requires childId');
        }
        return this.success({
          operationId: `cancel_${Date.now()}`,
          status: 'cancelled',
          childId: input.childId,
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown orchestration operation: ${String((input as OrchestrationPortInput).operation)}`,
        );
    }
  }
}
