/**
 * ChatHeaderService — Derives authoritative chat header state from runtime data.
 *
 * The chat header displays: project, session, agent or orchestrator, model,
 * autonomy mode, context usage, cost/budget, and connection status.
 * All fields are read-only and sourced from owning services (provider registry,
 * session, run coordinator, context service, cost service).
 *
 * Requirements: 15.10, 16.1, 16.6
 */

import type {
  HeaderViewModel,
  HeaderField,
  HeaderRuntimeData,
  SourceAttribution,
} from './types';

export class ChatHeaderService {
  /**
   * Derives a read-only HeaderViewModel from runtime data.
   * None of the returned fields are independently editable —
   * they are decorated with their authoritative source.
   */
  deriveHeader(data: HeaderRuntimeData): HeaderViewModel {
    return {
      project: this.createField(data.projectName ?? '', {
        source: 'workspace',
        label: `workspace ${data.workspaceId ?? 'default'}`,
      }),
      provider: this.createField(data.providerName, {
        source: 'provider-registry',
        label: `from provider registry (${data.providerId})`,
      }),
      modelRole: this.createField(data.modelRole, {
        source: 'model-config',
        label: 'from model configuration',
      }),
      autonomyMode: this.createField(data.autonomyMode ?? 'supervised', {
        source: 'session',
        label: 'from session autonomy policy',
      }),
      contextTokenCount: this.createNumericField(data.contextTokenCount, {
        source: 'context-service',
        label: 'from context service',
      }),
      contextLimit: this.createNumericField(data.contextLimit ?? 0, {
        source: 'model-config',
        label: 'from model context window',
      }),
      costUsage: this.createNumericField(data.costUsage ?? 0, {
        source: 'cost-service',
        label: 'cost since session start',
      }),
      costBudget: data.costBudget != null
        ? this.createNumericField(data.costBudget, {
            source: 'cost-service',
            label: 'session budget limit',
          })
        : null,
      connectionStatus: this.createField(data.connectionStatus ?? 'connected', {
        source: 'provider-registry',
        label: 'transport state',
      }),
      sessionLink: this.createField(data.sessionTitle, {
        source: 'session',
        label: `session ${data.sessionId}`,
      }),
      agentOrOrchestrator: data.agentName
        ? this.createField(data.agentName, {
            source: 'run-coordinator',
            label: data.orchestratorId
              ? `orchestrator ${data.orchestratorId}`
              : `agent ${data.agentId ?? 'unknown'}`,
          })
        : null,
      taskAssociation: data.taskId
        ? this.createField(data.taskTitle ?? data.taskId, {
            source: 'run-coordinator',
            label: `task ${data.taskId}`,
          })
        : null,
      runAssociation: data.runId
        ? this.createField(`${data.runId} (${data.runStatus ?? 'unknown'})`, {
            source: 'run-coordinator',
            label: `run ${data.runId}`,
          })
        : null,
    };
  }

  /**
   * Checks if a given field is derived (read-only).
   * All header fields are derived from runtime — none are editable.
   */
  isFieldDerived(field: HeaderField): boolean {
    return field.readOnly;
  }

  private createField(value: string, attribution: SourceAttribution): HeaderField<string> {
    return Object.freeze({
      value,
      readOnly: true,
      attribution: Object.freeze(attribution),
    });
  }

  private createNumericField(value: number, attribution: SourceAttribution): HeaderField<number> {
    return Object.freeze({
      value,
      readOnly: true,
      attribution: Object.freeze(attribution),
    });
  }
}
