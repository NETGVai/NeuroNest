/**
 * SpecOrchestrator — drives the spec-driven development workflow in the renderer.
 *
 * Manages state machine transitions through the spec phases:
 *   idle → interviewing → spec-review → plan-review → task-review → executing
 *
 * Communicates with the main process via IPC for document generation,
 * approval, and execution lifecycle events.
 *
 * Validates: Requirements 8.1, 8.6, 9.1, 9.4, 9.5, 9.6, 10.1, 10.4, 10.5, 10.6,
 *            11.1, 11.4, 11.5, 11.6, 11.7, 11.8
 */

import type {
  ISpecOrchestrator,
  SpecModeState,
  SpecPhase,
  SpecDocumentMessage,
  SpecQuestionMessage,
} from '../types/action-buttons';
import { ipcInvoke, ipcOn, type IpcUnsubscribe } from './ipc-client';
import { persistSpecDocuments } from './spec-persistence';

/** IPC channel constants for spec workflow communication. */
const IPC_CHANNELS = {
  ACTIVATE: 'spec:activate',
  APPROVE: 'spec:approve',
  REQUEST_CHANGES: 'spec:request-changes',
  START_IMPLEMENTATION: 'spec:start-implementation',
  SAVE: 'spec:save',
  QUESTION: 'spec:question',
  DOCUMENT: 'spec:document',
} as const;

/** Generate a unique workflow ID. */
function generateWorkflowId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Map from IPC document phase to the next SpecPhase after approval. */
const PHASE_ADVANCE_MAP: Record<'spec-review' | 'plan-review' | 'task-review', SpecPhase> = {
  'spec-review': 'plan-review',
  'plan-review': 'task-review',
  'task-review': 'executing',
};

/** Map from document message phase to internal state phase. */
const DOCUMENT_PHASE_MAP: Record<'spec' | 'plan' | 'tasks', SpecPhase> = {
  spec: 'spec-review',
  plan: 'plan-review',
  tasks: 'task-review',
};

/** Map from approval phase to the IPC payload phase label. */
const APPROVAL_PHASE_MAP: Record<'spec-review' | 'plan-review' | 'task-review', 'spec' | 'plan' | 'tasks'> = {
  'spec-review': 'spec',
  'plan-review': 'plan',
  'task-review': 'tasks',
};

/**
 * Creates the default idle state.
 */
function createIdleState(): SpecModeState {
  return {
    active: false,
    phase: 'idle',
    workflowId: null,
    specDocument: null,
    implementationPlan: null,
    taskList: null,
  };
}

/**
 * SpecOrchestrator implementation.
 *
 * Maintains a state machine for the spec-driven development workflow and
 * communicates with the main process via IPC channels.
 */
export class SpecOrchestrator implements ISpecOrchestrator {
  private state: SpecModeState;
  private unsubscribers: IpcUnsubscribe[] = [];

  constructor() {
    this.state = createIdleState();
    this.setupIpcListeners();
  }

  /**
   * Activate spec mode for a build request.
   * Generates a workflowId, sends activation message via IPC,
   * and transitions to the 'interviewing' phase.
   */
  async activate(userMessage: string): Promise<void> {
    if (this.state.active) {
      return;
    }

    const workflowId = generateWorkflowId();

    this.state = {
      active: true,
      phase: 'interviewing',
      workflowId,
      specDocument: null,
      implementationPlan: null,
      taskList: null,
    };

    await ipcInvoke(IPC_CHANNELS.ACTIVATE, {
      type: IPC_CHANNELS.ACTIVATE,
      payload: { userMessage, sessionId: workflowId },
    });
  }

  /**
   * Get current spec mode state (immutable snapshot).
   */
  getState(): SpecModeState {
    return { ...this.state };
  }

  /**
   * Handle user approval of a document.
   * Sends approval message via IPC and advances to the next phase.
   * When approving 'task-review', persists all accumulated documents.
   */
  async approve(phase: 'spec-review' | 'plan-review' | 'task-review'): Promise<void> {
    if (!this.state.active || this.state.phase !== phase) {
      return;
    }

    await ipcInvoke(IPC_CHANNELS.APPROVE, {
      type: IPC_CHANNELS.APPROVE,
      payload: {
        workflowId: this.state.workflowId,
        phase: APPROVAL_PHASE_MAP[phase],
      },
    });

    // Persist documents when approving the final task-review phase
    if (phase === 'task-review' && this.state.workflowId) {
      await persistSpecDocuments(this.state.workflowId, {
        specDocument: this.state.specDocument,
        implementationPlan: this.state.implementationPlan,
        taskList: this.state.taskList,
      });
    }

    this.state.phase = PHASE_ADVANCE_MAP[phase];
  }

  /**
   * Handle user request for changes to a document.
   * Sends change request via IPC. Stays in current phase for re-generation.
   */
  async requestChanges(
    phase: 'spec-review' | 'plan-review' | 'task-review',
    feedback: string,
  ): Promise<void> {
    if (!this.state.active || this.state.phase !== phase) {
      return;
    }

    await ipcInvoke(IPC_CHANNELS.REQUEST_CHANGES, {
      type: IPC_CHANNELS.REQUEST_CHANGES,
      payload: {
        workflowId: this.state.workflowId,
        phase: APPROVAL_PHASE_MAP[phase],
        feedback,
      },
    });

    // Stay in current phase — a new document will arrive via IPC
  }

  /**
   * Cancel spec mode. Resets state to idle and cleans up.
   */
  cancel(): void {
    this.state = createIdleState();
  }

  /**
   * Start implementation after task approval.
   * Transitions to 'executing' and sends execution start via IPC.
   */
  async startImplementation(): Promise<void> {
    if (!this.state.active || this.state.phase !== 'task-review') {
      return;
    }

    this.state.phase = 'executing';

    await ipcInvoke(IPC_CHANNELS.START_IMPLEMENTATION, {
      workflowId: this.state.workflowId,
    });
  }

  /**
   * Save documents without starting implementation.
   * Persists documents to the spec directory and transitions to idle.
   */
  async saveOnly(): Promise<void> {
    if (!this.state.active || this.state.phase !== 'task-review') {
      return;
    }

    // Persist documents to the file system via IPC
    if (this.state.workflowId) {
      await persistSpecDocuments(this.state.workflowId, {
        specDocument: this.state.specDocument,
        implementationPlan: this.state.implementationPlan,
        taskList: this.state.taskList,
      });
    }

    await ipcInvoke(IPC_CHANNELS.SAVE, {
      workflowId: this.state.workflowId,
      specDocument: this.state.specDocument,
      implementationPlan: this.state.implementationPlan,
      taskList: this.state.taskList,
    });

    this.state = createIdleState();
  }

  /**
   * Clean up IPC listeners. Call when the orchestrator is disposed.
   */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.state = createIdleState();
  }

  /**
   * Set up IPC event listeners for incoming messages from the main process.
   */
  private setupIpcListeners(): void {
    // Listen for incoming questions during interview phase
    const unsubQuestion = ipcOn<SpecQuestionMessage['payload']>(
      IPC_CHANNELS.QUESTION,
      (data) => {
        if (!this.state.active || this.state.workflowId !== data.workflowId) {
          return;
        }
        // Questions keep us in the 'interviewing' phase
        // The actual rendering is handled by higher-level components
      },
    );
    this.unsubscribers.push(unsubQuestion);

    // Listen for generated documents arriving from the main process
    const unsubDocument = ipcOn<SpecDocumentMessage['payload']>(
      IPC_CHANNELS.DOCUMENT,
      (data) => {
        if (!this.state.active || this.state.workflowId !== data.workflowId) {
          return;
        }
        this.handleDocumentReceived(data);
      },
    );
    this.unsubscribers.push(unsubDocument);
  }

  /**
   * Handle a document message received from the main process.
   * Updates the internal state with the document content and transitions phase.
   */
  private handleDocumentReceived(data: SpecDocumentMessage['payload']): void {
    const { phase, content } = data;

    switch (phase) {
      case 'spec':
        this.state.specDocument = content;
        break;
      case 'plan':
        this.state.implementationPlan = content;
        break;
      case 'tasks':
        this.state.taskList = content;
        break;
    }

    // Transition to the corresponding review phase
    this.state.phase = DOCUMENT_PHASE_MAP[phase];
  }
}
