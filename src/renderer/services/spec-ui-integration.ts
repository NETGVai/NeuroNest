/**
 * SpecUIController — connects the SpecOrchestrator events to the chat UI
 * and ActionButtonRenderer for rendering spec mode indicators, questions,
 * and document approval buttons.
 *
 * Validates: Requirements 8.2, 8.3, 8.4, 8.5, 9.3, 9.4, 10.3, 10.4, 11.4, 11.5, 12.4, 12.5
 */

import type {
  ActionCallback,
  IActionButtonRenderer,
  IButtonGroupManager,
  ISpecOrchestrator,
  SpecDocumentMessage,
  SpecPhase,
  SpecQuestionMessage,
} from '../types/action-buttons';
import { ipcOn, type IpcUnsubscribe } from './ipc-client';

/** IPC channel constants for spec workflow communication. */
const IPC_CHANNELS = {
  QUESTION: 'spec:question',
  DOCUMENT: 'spec:document',
} as const;

/** Approval button labels for each review phase. */
const PHASE_BUTTONS: Record<
  'spec-review' | 'plan-review' | 'task-review',
  string[]
> = {
  'spec-review': ['Approve Spec', 'Request Changes', 'Cancel'],
  'plan-review': ['Approve Plan', 'Request Changes', 'Cancel'],
  'task-review': ['Approve & Start Implementation', 'Approve & Save Only', 'Request Changes'],
};

/**
 * SpecUIController integrates spec orchestrator events with the chat UI.
 *
 * It listens for IPC events (questions and documents) and renders them
 * in the chat using the ActionButtonRenderer and ButtonGroupManager.
 */
export class SpecUIController {
  private orchestrator: ISpecOrchestrator;
  private renderer: IActionButtonRenderer;
  private manager: IButtonGroupManager;
  private unsubscribers: IpcUnsubscribe[] = [];
  private indicatorEl: HTMLElement | null = null;

  constructor(
    orchestrator: ISpecOrchestrator,
    renderer: IActionButtonRenderer,
    manager: IButtonGroupManager,
  ) {
    this.orchestrator = orchestrator;
    this.renderer = renderer;
    this.manager = manager;
  }

  /**
   * Render a "Spec Mode" indicator badge into the given container.
   * Shows the badge when spec mode is active; hides when idle.
   *
   * Validates: Requirement 8.2
   */
  renderSpecModeIndicator(containerEl: HTMLElement): HTMLElement {
    const badge = document.createElement('div');
    badge.className = 'spec-mode-indicator';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.textContent = 'Spec Mode';
    Object.assign(badge.style, {
      display: 'none',
      padding: '4px 10px',
      borderRadius: '12px',
      fontSize: '12px',
      fontWeight: '600',
      backgroundColor: 'var(--spec-mode-bg, #0e639c)',
      color: 'var(--spec-mode-fg, #ffffff)',
    });

    containerEl.appendChild(badge);
    this.indicatorEl = badge;

    return badge;
  }

  /**
   * Update the spec mode indicator visibility based on current state.
   */
  updateIndicator(): void {
    if (!this.indicatorEl) return;
    const state = this.orchestrator.getState();
    this.indicatorEl.style.display = state.active ? 'inline-block' : 'none';
  }

  /**
   * Render a spec question as an agent message with optional multi-choice buttons.
   *
   * If the question has predefined options, renders multi-choice buttons.
   * If it's a free-form question, renders the text without buttons.
   *
   * Validates: Requirements 8.3, 8.4, 8.5, 12.4
   */
  renderSpecQuestion(
    messageEl: HTMLElement,
    question: { text: string; options?: string[]; index: number },
  ): void {
    // Render the question text as message content
    const textEl = document.createElement('p');
    textEl.className = 'spec-question-text';
    textEl.textContent = question.text;
    messageEl.appendChild(textEl);

    // If question has predefined options, render multi-choice buttons
    if (question.options && question.options.length > 0) {
      const onAction: ActionCallback = (responseText, action) => {
        // Button click sends the selected option to the orchestrator pipeline
        // The parent component handles dispatching this as a user message
        this.manager.disableAll();
      };

      const instance = this.renderer.renderMultiChoice(
        messageEl,
        question.options,
        onAction,
      );
      this.manager.register(instance);
    }
    // Free-form questions: no buttons rendered, user types normally (Requirement 8.5)
  }

  /**
   * Render a spec document in the chat with appropriate approval buttons
   * based on the current review phase.
   *
   * - spec-review: "Approve Spec" / "Request Changes" / "Cancel"
   * - plan-review: "Approve Plan" / "Request Changes" / "Cancel"
   * - task-review: "Approve & Start Implementation" / "Approve & Save Only" / "Request Changes"
   *
   * Validates: Requirements 9.3, 9.4, 10.3, 10.4, 11.4, 11.5
   */
  renderSpecDocument(
    messageEl: HTMLElement,
    phase: 'spec-review' | 'plan-review' | 'task-review',
    content: string,
  ): void {
    // Render the document content
    const contentEl = document.createElement('div');
    contentEl.className = 'spec-document-content';
    contentEl.textContent = content;
    Object.assign(contentEl.style, {
      whiteSpace: 'pre-wrap',
      padding: '8px',
      marginBottom: '8px',
      borderRadius: '4px',
      backgroundColor: 'var(--document-bg, #1e1e1e)',
      border: '1px solid var(--border-color, #555)',
      maxHeight: '400px',
      overflow: 'auto',
    });
    messageEl.appendChild(contentEl);

    // Render approval buttons for this phase
    const buttonLabels = PHASE_BUTTONS[phase];
    const onAction: ActionCallback = (responseText, _action) => {
      this.handleDocumentAction(phase, responseText);
    };

    const instance = this.renderer.renderMultiChoice(
      messageEl,
      buttonLabels,
      onAction,
    );
    this.manager.register(instance);
  }

  /**
   * Start listening for IPC events and render UI accordingly.
   * Call this after construction to wire up event listeners.
   */
  startListening(): void {
    // Listen for incoming questions
    const unsubQuestion = ipcOn<SpecQuestionMessage['payload']>(
      IPC_CHANNELS.QUESTION,
      (data) => {
        const state = this.orchestrator.getState();
        if (!state.active || state.workflowId !== data.workflowId) {
          return;
        }
        this.updateIndicator();
        // Emit a custom event so the chat panel can create a message element
        // and call renderSpecQuestion on it
        const event = new CustomEvent('spec:question-received', { detail: data });
        document.dispatchEvent(event);
      },
    );
    this.unsubscribers.push(unsubQuestion);

    // Listen for incoming documents
    const unsubDocument = ipcOn<SpecDocumentMessage['payload']>(
      IPC_CHANNELS.DOCUMENT,
      (data) => {
        const state = this.orchestrator.getState();
        if (!state.active || state.workflowId !== data.workflowId) {
          return;
        }
        this.updateIndicator();
        // Emit a custom event so the chat panel can create a message element
        // and call renderSpecDocument on it
        const event = new CustomEvent('spec:document-received', { detail: data });
        document.dispatchEvent(event);
      },
    );
    this.unsubscribers.push(unsubDocument);
  }

  /**
   * Clean up IPC listeners. Call when the controller is disposed.
   */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.indicatorEl = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle a document approval button click by calling the appropriate
   * orchestrator method based on the phase and selected button.
   */
  private handleDocumentAction(
    phase: 'spec-review' | 'plan-review' | 'task-review',
    selectedLabel: string,
  ): void {
    switch (selectedLabel) {
      case 'Approve Spec':
      case 'Approve Plan':
        this.orchestrator.approve(phase);
        break;

      case 'Approve & Start Implementation':
        this.orchestrator.approve(phase);
        this.orchestrator.startImplementation();
        break;

      case 'Approve & Save Only':
        this.orchestrator.approve(phase);
        this.orchestrator.saveOnly();
        break;

      case 'Request Changes':
        // Emit a custom event so the chat UI can prompt for feedback
        const event = new CustomEvent('spec:request-changes-prompt', {
          detail: { phase },
        });
        document.dispatchEvent(event);
        break;

      case 'Cancel':
        this.orchestrator.cancel();
        this.updateIndicator();
        break;
    }
  }
}
