import { randomUUID } from 'node:crypto';
import type {
  AgentLoopMetricsStore,
  AgentRunSnapshotInput,
} from '../metrics/agent-loop-metrics.js';
import type { DriftDashboardState } from '../shared/feature-integration-types.js';

export function advanceEnhancedPhaseCount(
  currentCount: number,
  eventPhase: number | undefined,
): number {
  return Math.max(currentCount, eventPhase === undefined ? currentCount + 1 : eventPhase + 1);
}

export type EnhancedTaskTerminalState = 'completed' | 'failed' | 'blocked';

const ENHANCED_TASK_STATE_PRIORITY: Record<EnhancedTaskTerminalState, number> = {
  completed: 0,
  failed: 1,
  blocked: 2,
};

/** Preserve the strongest terminal outcome when renderer completion follows an error. */
export function mergeEnhancedTaskState(
  states: Map<string, EnhancedTaskTerminalState>,
  agentId: string | undefined,
  status: EnhancedTaskTerminalState,
): boolean {
  if (!agentId) return false;
  const current = states.get(agentId);
  if (current && ENHANCED_TASK_STATE_PRIORITY[current] > ENHANCED_TASK_STATE_PRIORITY[status]) {
    return false;
  }
  states.set(agentId, status);
  return true;
}

export type SwarmRunSnapshotContext = Omit<
  AgentRunSnapshotInput,
  'toolSuccessCount' | 'toolFailureCount' | 'completedAt' | 'driftState'
>;

type SnapshotWriter = Pick<AgentLoopMetricsStore, 'recordRunSnapshot'>;

export interface SwarmRunSnapshotRecorderOptions {
  writer: SnapshotWriter | null;
  finalizeDrift: () => DriftDashboardState | null;
  now?: () => Date;
  onPersisted?: (projectId: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * Request-scoped state machine for swarm run evidence. Persistence is
 * idempotent after success and remains retryable after a failed write.
 */
export class SwarmRunSnapshotRecorder {
  private context: SwarmRunSnapshotContext | null = null;
  private toolSuccessCount = 0;
  private toolFailureCount = 0;
  private persisted = false;
  private readonly snapshotId = randomUUID();

  constructor(private readonly options: SwarmRunSnapshotRecorderOptions) {}

  initialize(context: SwarmRunSnapshotContext): void {
    this.context = { ...context };
  }

  observeTool(success: boolean): void {
    if (success) this.toolSuccessCount += 1;
    else this.toolFailureCount += 1;
  }

  update(patch: Partial<SwarmRunSnapshotContext>): void {
    if (!this.context || this.persisted) return;
    Object.assign(this.context, patch);
  }

  markExceptional(aborted: boolean): void {
    this.update({ status: aborted ? 'incomplete' : 'failed' });
  }

  persist(): boolean {
    if (this.persisted || !this.context || !this.options.writer) return this.persisted;

    try {
      const context = this.context;
      this.options.writer.recordRunSnapshot({
        ...context,
        toolSuccessCount: this.toolSuccessCount,
        toolFailureCount: this.toolFailureCount,
        completedAt: this.options.now?.() ?? new Date(),
        driftState: this.options.finalizeDrift(),
      }, this.snapshotId);
      this.persisted = true;
      this.options.onPersisted?.(context.projectId);
      return true;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }
}
