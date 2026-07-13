/**
 * UserInputBridge — Renderer-side bridge that receives User_Input_Requests from
 * the main process via IPC, renders discrete choices through
 * ActionButtonRenderer.renderMultiChoice, and routes clicked text back through
 * IPC to UserInputService.answer.
 *
 * Behavior:
 * - Discrete choices: rendered via ActionButtonRenderer.renderMultiChoice
 *   (≤6 inline; >6 shows first 5 + overflow control)
 * - Routes clicked exact text back through UserInputService.answer
 * - Resumes the agent exactly once; disables the group on selection so rapid
 *   repeat clicks record no extra answer
 * - Free-form requests: renders a text input that rejects empty/whitespace
 * - Falls back to free-form if buttons can't render, then fail-closed unanswered
 *   if that also fails
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7
 */

import type {
  ActionCallback,
  IActionButtonRenderer,
  IButtonGroupManager,
} from '../types/action-buttons';
import { ipcInvoke, ipcOn, type IpcUnsubscribe } from './ipc-client';

// ─── IPC Channel Constants ─────────────────────────────────────────────────────

const IPC_CHANNELS = {
  /** Main → Renderer: present a user-input request */
  USER_INPUT_PRESENT: 'user-input:present',
  /** Main → Renderer: dismiss a currently-presented request */
  USER_INPUT_DISMISS: 'user-input:dismiss',
  /** Renderer → Main: record the user's answer */
  USER_INPUT_ANSWER: 'user-input:answer',
  /** Renderer → Main: acknowledge successful presentation */
  USER_INPUT_PRESENTED: 'user-input:presented',
  /** Renderer → Main: report presentation failure */
  USER_INPUT_PRESENT_FAILED: 'user-input:present-failed',
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Shape of a user-input request received from the main process. */
export interface RendererUserInputRequest {
  id: string;
  agentId: string;
  prompt: string;
  choices?: string[];
}

/** Tracks the state of a currently-rendered user-input request in the renderer. */
interface ActiveInputState {
  requestId: string;
  answered: boolean;
}

// ─── Bridge Implementation ─────────────────────────────────────────────────────

/**
 * UserInputBridge connects the main-process UserInputService to the renderer's
 * ActionButtonRenderer and free-form input for user-input requests.
 */
export class UserInputBridge {
  private renderer: IActionButtonRenderer;
  private manager: IButtonGroupManager;
  private unsubscribers: IpcUnsubscribe[] = [];
  private activeInput: ActiveInputState | null = null;
  private containerProvider: () => HTMLElement | null;

  /**
   * @param renderer - ActionButtonRenderer instance for rendering choice buttons
   * @param manager - ButtonGroupManager for lifecycle tracking
   * @param containerProvider - Function that returns the DOM container to render into
   */
  constructor(
    renderer: IActionButtonRenderer,
    manager: IButtonGroupManager,
    containerProvider: () => HTMLElement | null,
  ) {
    this.renderer = renderer;
    this.manager = manager;
    this.containerProvider = containerProvider;
  }

  /**
   * Start listening for user-input IPC events from the main process.
   * Call after construction to wire up the bridge.
   */
  startListening(): void {
    // Listen for incoming user-input requests
    const unsubPresent = ipcOn<RendererUserInputRequest>(
      IPC_CHANNELS.USER_INPUT_PRESENT,
      (request) => {
        this.handlePresentRequest(request);
      },
    );
    this.unsubscribers.push(unsubPresent);

    // Listen for dismiss signals (timeout/abort from main process)
    const unsubDismiss = ipcOn<{ requestId: string }>(
      IPC_CHANNELS.USER_INPUT_DISMISS,
      (data) => {
        this.handleDismiss(data.requestId);
      },
    );
    this.unsubscribers.push(unsubDismiss);
  }

  /**
   * Clean up IPC listeners. Call when the bridge is disposed.
   */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.activeInput = null;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Handle an incoming user-input request from the main process.
   * Renders choices as buttons or shows a free-form input, with fallback chain.
   */
  private handlePresentRequest(request: RendererUserInputRequest): void {
    const container = this.containerProvider();
    if (!container) {
      // Cannot render anything — report present-failure (R18.7)
      this.reportPresentFailed(request.id);
      return;
    }

    // Create a message element for this request
    const messageEl = document.createElement('div');
    messageEl.className = 'user-input-request';
    messageEl.setAttribute('data-request-id', request.id);

    // Render the prompt text
    const promptEl = document.createElement('p');
    promptEl.className = 'user-input-prompt';
    promptEl.textContent = request.prompt;
    messageEl.appendChild(promptEl);

    // Track this as the active input
    this.activeInput = { requestId: request.id, answered: false };

    if (request.choices && request.choices.length > 0) {
      // Attempt to render discrete choices as buttons (R18.1, R18.6)
      const rendered = this.tryRenderChoiceButtons(messageEl, request);
      if (!rendered) {
        // Fall back to free-form input (R18.7)
        const freeFormRendered = this.tryRenderFreeFormInput(messageEl, request);
        if (!freeFormRendered) {
          // Both failed — fail-closed unanswered (R18.7)
          this.reportPresentFailed(request.id);
          this.activeInput = null;
          return;
        }
      }
    } else {
      // Free-form request (R18.3)
      const freeFormRendered = this.tryRenderFreeFormInput(messageEl, request);
      if (!freeFormRendered) {
        // Cannot render — fail-closed unanswered (R18.7)
        this.reportPresentFailed(request.id);
        this.activeInput = null;
        return;
      }
    }

    // Append to container and report success
    container.appendChild(messageEl);
    this.reportPresented(request.id);
  }

  /**
   * Attempt to render discrete choices via ActionButtonRenderer.renderMultiChoice.
   * Returns true if rendering succeeded, false otherwise.
   *
   * The renderer handles ≤6 inline and >6 with first 5 + overflow (R18.6).
   * Buttons are keyboard-focusable with group role + live-region (R18.4).
   */
  private tryRenderChoiceButtons(
    messageEl: HTMLElement,
    request: RendererUserInputRequest,
  ): boolean {
    try {
      const onAction: ActionCallback = (responseText, _action) => {
        // Exactly-once guard: if already answered, do nothing (R18.5)
        if (!this.activeInput || this.activeInput.requestId !== request.id) return;
        if (this.activeInput.answered) return;

        // Mark as answered immediately to prevent duplicate answers from
        // rapid clicks before the disabled state fully applies (R18.5)
        this.activeInput.answered = true;

        // Route the exact clicked text back to UserInputService.answer (R18.2)
        this.sendAnswer(request.id, responseText);
      };

      // renderMultiChoice handles ≤6 inline, >6 shows first 5 + overflow (R18.1, R18.6)
      // Buttons get role="group" + aria-live="polite" from the renderer (R18.4)
      const instance = this.renderer.renderMultiChoice(
        messageEl,
        request.choices!,
        onAction,
      );

      // Register for lifecycle management (disableAll on new messages, etc.)
      this.manager.register(instance);

      return true;
    } catch {
      // Rendering failed — caller will attempt free-form fallback
      return false;
    }
  }

  /**
   * Attempt to render a free-form text input for the user.
   * Rejects empty/whitespace-only submissions (R18.3).
   * Returns true if rendering succeeded, false otherwise.
   */
  private tryRenderFreeFormInput(
    messageEl: HTMLElement,
    request: RendererUserInputRequest,
  ): boolean {
    try {
      const inputContainer = document.createElement('div');
      inputContainer.className = 'user-input-freeform';
      Object.assign(inputContainer.style, {
        display: 'flex',
        gap: '8px',
        marginTop: '8px',
        padding: '4px 0',
      });

      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'user-input-freeform__input';
      textInput.placeholder = 'Type your response...';
      textInput.setAttribute('aria-label', 'Free-form response');
      Object.assign(textInput.style, {
        flex: '1',
        padding: '6px 10px',
        borderRadius: '4px',
        border: '1px solid var(--border-color, #555)',
        backgroundColor: 'var(--input-bg, #1e1e1e)',
        color: 'var(--input-fg, #ffffff)',
      });

      const submitButton = document.createElement('button');
      submitButton.type = 'button';
      submitButton.className = 'user-input-freeform__submit';
      submitButton.textContent = 'Submit';
      submitButton.setAttribute('aria-label', 'Submit response');
      Object.assign(submitButton.style, {
        padding: '6px 12px',
        borderRadius: '4px',
        border: 'none',
        backgroundColor: 'var(--button-primary-bg, #0e639c)',
        color: 'var(--button-primary-fg, #ffffff)',
        cursor: 'pointer',
      });

      const errorEl = document.createElement('span');
      errorEl.className = 'user-input-freeform__error';
      errorEl.setAttribute('role', 'alert');
      errorEl.setAttribute('aria-live', 'assertive');
      Object.assign(errorEl.style, {
        display: 'none',
        color: 'var(--error-fg, #f48771)',
        fontSize: '12px',
        marginTop: '4px',
      });

      /** Submit handler: validates and sends the free-form response. */
      const handleSubmit = (): void => {
        // Exactly-once guard (R18.5 applied to free-form)
        if (!this.activeInput || this.activeInput.requestId !== request.id) return;
        if (this.activeInput.answered) return;

        const value = textInput.value;

        // Reject empty or whitespace-only (R18.3)
        if (!value || value.trim().length === 0) {
          errorEl.textContent = 'Response cannot be empty or whitespace only.';
          errorEl.style.display = 'block';
          return;
        }

        // Mark as answered
        this.activeInput.answered = true;

        // Disable input and button
        textInput.disabled = true;
        submitButton.disabled = true;
        submitButton.setAttribute('aria-disabled', 'true');
        errorEl.style.display = 'none';

        // Route the trimmed text to UserInputService.answer (R18.2)
        this.sendAnswer(request.id, value.trim());
      };

      submitButton.addEventListener('click', handleSubmit);
      textInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          handleSubmit();
        }
      });

      inputContainer.appendChild(textInput);
      inputContainer.appendChild(submitButton);
      messageEl.appendChild(inputContainer);
      messageEl.appendChild(errorEl);

      return true;
    } catch {
      // Free-form rendering failed
      return false;
    }
  }

  /**
   * Handle a dismiss signal from the main process (timeout/abort).
   * Removes the currently active request UI.
   */
  private handleDismiss(requestId: string): void {
    if (this.activeInput && this.activeInput.requestId === requestId) {
      this.activeInput = null;
    }

    // Remove the request element from the DOM
    const el = document.querySelector(`[data-request-id="${requestId}"]`);
    if (el) {
      el.remove();
    }
  }

  /**
   * Send the user's answer back to the main process via IPC.
   * Routes to UserInputService.answer(id, answer) on the main side.
   */
  private sendAnswer(requestId: string, answer: string): void {
    ipcInvoke(IPC_CHANNELS.USER_INPUT_ANSWER, { requestId, answer }).catch(() => {
      // IPC failure is non-fatal from the renderer's perspective;
      // the main process timeout will eventually fail-close.
    });
  }

  /**
   * Report to the main process that the request was successfully presented.
   */
  private reportPresented(requestId: string): void {
    ipcInvoke(IPC_CHANNELS.USER_INPUT_PRESENTED, { requestId }).catch(() => {
      // Best-effort notification
    });
  }

  /**
   * Report to the main process that presentation failed.
   * The main process will apply the fail-closed unanswered outcome (R18.7).
   */
  private reportPresentFailed(requestId: string): void {
    ipcInvoke(IPC_CHANNELS.USER_INPUT_PRESENT_FAILED, { requestId }).catch(() => {
      // Best-effort notification
    });
  }
}
