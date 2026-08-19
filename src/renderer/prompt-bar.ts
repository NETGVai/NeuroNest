/**
 * Prompt Bar — Persistent prompt entry for the enhanced chat UI.
 *
 * The Prompt Bar is the sole entry point for user-authored prompts in the
 * canonical chat surface. It renders a persistent slot at the bottom of the
 * chat shell that:
 *
 * 1. Accepts a text draft with debounced persistence into a
 *    {@link DraftTransactionStore} so navigation, reload, and scope switches
 *    preserve in-progress work.
 * 2. Exposes send/stop controls. Send delegates to `structuredActionPort
 *    .submitPrompt` via an `onSubmit(text)` callback owned by the caller.
 *    Stop delegates to `structuredActionPort.cancel` via `onStop()`.
 * 3. Displays the selected provider and model chip. Values come from the
 *    entitlement-filtered catalog and are passed in as options — the Prompt
 *    Bar itself is a passive display so provider/model resolution stays
 *    main-authoritative.
 * 4. Reflects processing state — the textarea is disabled and the Send
 *    button is replaced by a Stop button while an in-flight response is
 *    active.
 * 5. Enforces validation before send — an empty draft cannot be sent, and
 *    an over-limit draft is flagged (limit clamped to
 *    {@link InsertPromptPayloadV1}'s 32_768-character maximum by default).
 * 6. Preserves focus continuity — focus returns to the textarea after send
 *    and stop, and the textarea is the initial focus target when the bar
 *    is mounted with `autoFocus: true`.
 *
 * Requirements: 9.1, 9.4–9.7, 10.1, 10.5, 10.10
 *
 * @vitest-environment jsdom
 */

import type { DraftTransactionStore } from '../harness/presentation/composer/draft-transaction-store';

// ─── CSS classes ────────────────────────────────────────────────

export const PROMPT_BAR_CSS_CLASS = 'nn-prompt-bar';
export const PROMPT_BAR_INPUT_CSS_CLASS = 'nn-prompt-bar__input';
export const PROMPT_BAR_CONTROLS_CSS_CLASS = 'nn-prompt-bar__controls';
export const PROMPT_BAR_SEND_CSS_CLASS = 'nn-prompt-bar__send';
export const PROMPT_BAR_STOP_CSS_CLASS = 'nn-prompt-bar__stop';
export const PROMPT_BAR_MODEL_CHIP_CSS_CLASS = 'nn-prompt-bar__model-chip';
export const PROMPT_BAR_VALIDATION_CSS_CLASS = 'nn-prompt-bar__validation';
export const PROMPT_BAR_CHAR_COUNT_CSS_CLASS = 'nn-prompt-bar__char-count';
export const PROMPT_BAR_STATUS_CSS_CLASS = 'nn-prompt-bar__status';

// ─── Constants ──────────────────────────────────────────────────

/**
 * Upper bound on prompt text length. Matches
 * `InsertPromptPayloadV1Schema.text.max(32_768)` so a valid draft always fits
 * the authority command envelope produced downstream.
 */
export const DEFAULT_MAX_PROMPT_LENGTH = 32_768;

/**
 * Debounce interval before a draft change is persisted into the transactional
 * store. Applied per-keystroke so typing does not fan out into thousands of
 * store revisions.
 */
export const DEFAULT_DRAFT_PERSIST_DEBOUNCE_MS = 150;

// ─── Types ──────────────────────────────────────────────────────

/**
 * Snapshot of the currently selected provider and model shown in the chip.
 * These come from the entitlement-filtered catalog resolved elsewhere;
 * the Prompt Bar is passive display.
 */
export interface PromptBarProviderModel {
  readonly provider: string;
  readonly model: string;
}

export type PromptBarSubmitReason = 'ok' | 'empty' | 'over_limit' | 'processing';

/**
 * Result of an internal validation pass. Exposed for tests so a caller can
 * verify why a submit was blocked without inspecting the DOM.
 */
export interface PromptBarValidationResult {
  readonly canSubmit: boolean;
  readonly reason: PromptBarSubmitReason;
  readonly length: number;
  readonly maxLength: number;
}

export interface PromptBarOptions {
  /** Transactional draft store owned by the chat session. */
  readonly draftStore: DraftTransactionStore;
  /**
   * Called when the user activates Send. The Prompt Bar has already validated
   * the draft (non-empty, within limit) and is not currently processing.
   * The callback is expected to route the draft through
   * `structuredActionPort.submitPrompt`.
   */
  readonly onSubmit: (text: string) => Promise<void> | void;
  /**
   * Called when the user activates Stop. The Prompt Bar has already ensured
   * a response is in-flight. The callback is expected to route through
   * `structuredActionPort.cancel`.
   */
  readonly onStop?: () => Promise<void> | void;
  /** Initial provider/model chip content. Defaults to a placeholder. */
  readonly providerModel?: PromptBarProviderModel;
  /** Placeholder text for the textarea. Defaults to a benign prompt. */
  readonly placeholder?: string;
  /**
   * Maximum length in characters. Clamped internally to
   * {@link DEFAULT_MAX_PROMPT_LENGTH} so the resulting draft always fits the
   * authority command envelope.
   */
  readonly maxLength?: number;
  /** Focus the textarea automatically after mount. Defaults to `true`. */
  readonly autoFocus?: boolean;
  /** Debounce for draft persistence. Defaults to
   *  {@link DEFAULT_DRAFT_PERSIST_DEBOUNCE_MS}. Set `0` for immediate flush
   *  (helpful for deterministic tests). */
  readonly persistDebounceMs?: number;
  /** Document ownership override for tests running in a custom jsdom scope. */
  readonly ownerDocument?: Document;
}

export interface PromptBarHandle {
  /** Root element to attach into the shell's composer slot. */
  readonly element: HTMLElement;
  /** Direct handle on the textarea so callers can bind additional events. */
  readonly inputElement: HTMLTextAreaElement;
  /** Direct handle on the Send button. */
  readonly sendButton: HTMLButtonElement;
  /** Direct handle on the Stop button. Present regardless of processing state
   *  so tests can inspect and callers can style it. */
  readonly stopButton: HTMLButtonElement;
  /** Return the current draft text. Reads through the draft store. */
  getDraft(): string;
  /** Replace the draft text. Used for tests and for programmatic prompt
   *  insertion (e.g. suggestions). */
  setDraft(text: string): void;
  /** Set the currently-selected provider/model chip. */
  setProviderModel(providerModel: PromptBarProviderModel): void;
  /** Get the current provider/model. */
  currentProviderModel(): PromptBarProviderModel | null;
  /** Toggle the processing (in-flight response) state. When `true`, Send is
   *  hidden, Stop is shown, and the textarea is read-only. */
  setProcessing(processing: boolean): void;
  /** Whether processing is currently active. */
  isProcessing(): boolean;
  /** Run the current validation pass. */
  validate(): PromptBarValidationResult;
  /** Move focus to the textarea. */
  focus(): void;
  /** Flush any pending draft persistence timer synchronously. */
  flushDraftPersistence(): void;
  /** Tear down listeners and remove the element from its parent. */
  dispose(): void;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Create a Prompt Bar handle. Call `.element` to obtain the DOM to append
 * into the chat shell's composer slot.
 */
export function createPromptBar(options: PromptBarOptions): PromptBarHandle {
  const doc = options.ownerDocument ?? document;
  const maxLength = clampMaxLength(options.maxLength);
  const persistDebounceMs = options.persistDebounceMs ?? DEFAULT_DRAFT_PERSIST_DEBOUNCE_MS;
  const autoFocus = options.autoFocus ?? true;

  const root = doc.createElement('div');
  root.className = PROMPT_BAR_CSS_CLASS;
  root.setAttribute('role', 'form');
  root.setAttribute('aria-label', 'Prompt bar');

  // 1. Textarea for prompt entry.
  const textarea = doc.createElement('textarea');
  textarea.className = PROMPT_BAR_INPUT_CSS_CLASS;
  textarea.setAttribute('aria-label', 'Message prompt');
  textarea.setAttribute('rows', '1');
  textarea.placeholder = options.placeholder ?? 'Ask NeuroNest anything…';
  textarea.maxLength = maxLength;
  textarea.spellcheck = true;
  root.appendChild(textarea);

  // 2. Controls row (provider chip, char count, send/stop).
  const controls = doc.createElement('div');
  controls.className = PROMPT_BAR_CONTROLS_CSS_CLASS;
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Prompt controls');
  root.appendChild(controls);

  // Provider/model chip.
  const modelChip = doc.createElement('span');
  modelChip.className = PROMPT_BAR_MODEL_CHIP_CSS_CLASS;
  modelChip.setAttribute('role', 'note');
  modelChip.setAttribute('aria-label', 'Selected provider and model');
  controls.appendChild(modelChip);

  // Character count for validation feedback.
  const charCount = doc.createElement('span');
  charCount.className = PROMPT_BAR_CHAR_COUNT_CSS_CLASS;
  charCount.setAttribute('aria-live', 'off');
  controls.appendChild(charCount);

  // Send button.
  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = PROMPT_BAR_SEND_CSS_CLASS;
  sendBtn.textContent = 'Send';
  sendBtn.setAttribute('aria-label', 'Send prompt');
  controls.appendChild(sendBtn);

  // Stop button — hidden by default; revealed while processing.
  const stopBtn = doc.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = PROMPT_BAR_STOP_CSS_CLASS;
  stopBtn.textContent = 'Stop';
  stopBtn.setAttribute('aria-label', 'Stop generation');
  stopBtn.hidden = true;
  controls.appendChild(stopBtn);

  // 3. Validation-message region for empty/over-limit feedback. Rendered as
  //    a polite live region so a screen reader announces the reason without
  //    interrupting typing.
  const validationEl = doc.createElement('span');
  validationEl.className = PROMPT_BAR_VALIDATION_CSS_CLASS;
  validationEl.setAttribute('role', 'status');
  validationEl.setAttribute('aria-live', 'polite');
  validationEl.hidden = true;
  root.appendChild(validationEl);

  // ─── State ────────────────────────────────────────────────────

  let processing = false;
  let disposed = false;
  let providerModel: PromptBarProviderModel | null = options.providerModel ?? null;
  let pendingPersistHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingPersistText: string | null = null;

  // Hydrate initial draft from the store so a page reload restores the
  // latest in-progress text.
  const initialDraft = options.draftStore.getCurrentRevision();
  if (initialDraft.text.length > 0) {
    textarea.value = initialDraft.text;
  }

  renderModelChip();
  updateCharCount();
  updateSendEnabled();

  // ─── Event wiring ─────────────────────────────────────────────

  const handleInput = (): void => {
    if (disposed) return;
    // Live UI updates on every keystroke.
    autoResize();
    updateCharCount();
    updateSendEnabled();
    updateValidationMessage();
    scheduleDraftPersistence(textarea.value);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (disposed) return;
    // Enter submits; Shift+Enter inserts a newline. IME composition is
    // preserved because `event.isComposing` guards against premature submit.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void invokeSubmit();
    }
  };

  const handleSendClick = (): void => {
    void invokeSubmit();
  };

  const handleStopClick = (): void => {
    void invokeStop();
  };

  textarea.addEventListener('input', handleInput);
  textarea.addEventListener('keydown', handleKeyDown);
  sendBtn.addEventListener('click', handleSendClick);
  stopBtn.addEventListener('click', handleStopClick);

  if (autoFocus) {
    // Deferred to allow the caller to attach the element to the DOM before
    // focus is applied. In jsdom `focus()` works even on detached nodes but
    // deferring keeps behaviour predictable across environments.
    queueMicrotask(() => {
      if (!disposed) textarea.focus();
    });
  }

  // ─── Internal helpers ─────────────────────────────────────────

  function currentDraftText(): string {
    return textarea.value;
  }

  function validateInternal(): PromptBarValidationResult {
    const text = currentDraftText();
    const trimmed = text.trim();
    const length = text.length;
    if (processing) {
      return { canSubmit: false, reason: 'processing', length, maxLength };
    }
    if (trimmed.length === 0) {
      return { canSubmit: false, reason: 'empty', length, maxLength };
    }
    if (length > maxLength) {
      return { canSubmit: false, reason: 'over_limit', length, maxLength };
    }
    return { canSubmit: true, reason: 'ok', length, maxLength };
  }

  function updateSendEnabled(): void {
    const result = validateInternal();
    sendBtn.disabled = !result.canSubmit;
    sendBtn.setAttribute('data-validation', result.reason);
  }

  function updateCharCount(): void {
    const length = textarea.value.length;
    charCount.textContent = `${length} / ${maxLength}`;
    charCount.dataset['warning'] = length > maxLength * 0.9 ? 'true' : 'false';
    if (length > maxLength) {
      charCount.dataset['overLimit'] = 'true';
    } else {
      delete charCount.dataset['overLimit'];
    }
  }

  function updateValidationMessage(): void {
    const result = validateInternal();
    if (result.reason === 'over_limit') {
      validationEl.hidden = false;
      validationEl.textContent = `Prompt exceeds ${maxLength}-character limit.`;
      validationEl.dataset['reason'] = 'over_limit';
      return;
    }
    validationEl.hidden = true;
    validationEl.textContent = '';
    delete validationEl.dataset['reason'];
  }

  function renderModelChip(): void {
    if (providerModel === null) {
      modelChip.textContent = 'No model selected';
      modelChip.dataset['state'] = 'empty';
      return;
    }
    modelChip.textContent = `${providerModel.provider} / ${providerModel.model}`;
    modelChip.dataset['state'] = 'ready';
    modelChip.dataset['provider'] = providerModel.provider;
    modelChip.dataset['model'] = providerModel.model;
  }

  function autoResize(): void {
    // Grow textarea vertically to fit content, with a modest ceiling so the
    // Prompt Bar remains persistent and does not push the timeline offscreen.
    textarea.style.height = 'auto';
    const target = Math.min(textarea.scrollHeight, 240);
    textarea.style.height = `${target}px`;
  }

  function scheduleDraftPersistence(text: string): void {
    pendingPersistText = text;
    if (pendingPersistHandle !== null) {
      clearTimeout(pendingPersistHandle);
    }
    if (persistDebounceMs <= 0) {
      flushDraftPersistenceInternal();
      return;
    }
    pendingPersistHandle = setTimeout(flushDraftPersistenceInternal, persistDebounceMs);
  }

  function flushDraftPersistenceInternal(): void {
    if (pendingPersistHandle !== null) {
      clearTimeout(pendingPersistHandle);
      pendingPersistHandle = null;
    }
    if (pendingPersistText === null) return;
    const text = pendingPersistText;
    pendingPersistText = null;
    const current = options.draftStore.getCurrentRevision();
    if (current.text === text) return; // no-op
    options.draftStore.applyChange({
      text,
      selection: {
        start: textarea.selectionStart ?? text.length,
        end: textarea.selectionEnd ?? text.length,
        direction: 'none',
      },
    });
  }

  async function invokeSubmit(): Promise<void> {
    if (disposed) return;
    const result = validateInternal();
    if (!result.canSubmit) {
      // Reflect the reason visually and keep focus on the textarea so the
      // user can correct without losing keyboard context.
      updateValidationMessage();
      textarea.focus();
      return;
    }
    // Persist the draft immediately so a downstream port that reads from
    // the store observes the exact text being submitted.
    pendingPersistText = textarea.value;
    flushDraftPersistenceInternal();

    const text = textarea.value;
    try {
      await options.onSubmit(text);
      // Clear the draft on successful send so the store no longer holds the
      // just-submitted text. Callers can override by re-populating via
      // `setDraft` if they need to preserve for retry.
      textarea.value = '';
      options.draftStore.applyChange({
        text: '',
        selection: { start: 0, end: 0, direction: 'none' },
      });
      updateCharCount();
      updateSendEnabled();
      updateValidationMessage();
      autoResize();
    } catch {
      // Preserve draft on failure so the user does not lose their input.
    } finally {
      // Focus continuity — return focus to the textarea after send.
      if (!disposed) textarea.focus();
    }
  }

  async function invokeStop(): Promise<void> {
    if (disposed) return;
    if (!processing) {
      // Stop is only meaningful while processing; ignore stray activations.
      return;
    }
    try {
      await (options.onStop?.() ?? Promise.resolve());
    } finally {
      // Focus continuity — if the caller has already cleared processing
      // by the time the cancel round-trip resolves, the textarea is
      // focusable and we return focus. Otherwise focus stays on Stop until
      // the projection's terminal event triggers setProcessing(false),
      // which itself returns focus to the input.
      if (!disposed && !processing) {
        textarea.focus();
      }
    }
  }

  // ─── Public handle ────────────────────────────────────────────

  const handle: PromptBarHandle = {
    element: root,
    inputElement: textarea,
    sendButton: sendBtn,
    stopButton: stopBtn,
    getDraft(): string {
      return textarea.value;
    },
    setDraft(text: string): void {
      if (disposed) return;
      textarea.value = text;
      updateCharCount();
      updateSendEnabled();
      updateValidationMessage();
      autoResize();
      scheduleDraftPersistence(text);
    },
    setProviderModel(next: PromptBarProviderModel): void {
      if (disposed) return;
      providerModel = { provider: next.provider, model: next.model };
      renderModelChip();
    },
    currentProviderModel(): PromptBarProviderModel | null {
      return providerModel === null
        ? null
        : { provider: providerModel.provider, model: providerModel.model };
    },
    setProcessing(next: boolean): void {
      if (disposed) return;
      if (processing === next) return;
      processing = next;
      // Disable input while a response is in-flight so accidental keystrokes
      // do not race a queued submission.
      textarea.disabled = processing;
      sendBtn.hidden = processing;
      stopBtn.hidden = !processing;
      root.dataset['processing'] = processing ? 'true' : 'false';
      updateSendEnabled();
      // Keep focus available for the user — Stop remains keyboard-reachable.
      if (processing) {
        // Move focus to Stop so keyboard users can immediately cancel.
        stopBtn.focus();
      } else {
        // Return focus to input when processing ends.
        textarea.focus();
      }
    },
    isProcessing(): boolean {
      return processing;
    },
    validate(): PromptBarValidationResult {
      return validateInternal();
    },
    focus(): void {
      if (disposed) return;
      textarea.focus();
    },
    flushDraftPersistence(): void {
      flushDraftPersistenceInternal();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pendingPersistHandle !== null) {
        clearTimeout(pendingPersistHandle);
        pendingPersistHandle = null;
      }
      textarea.removeEventListener('input', handleInput);
      textarea.removeEventListener('keydown', handleKeyDown);
      sendBtn.removeEventListener('click', handleSendClick);
      stopBtn.removeEventListener('click', handleStopClick);
      root.remove();
      root.replaceChildren();
    },
  };

  return handle;
}

// ─── Shell integration helper ───────────────────────────────────

/**
 * Mount a Prompt Bar into a chat shell's composer slot. Returns the handle so
 * the caller can control processing state, provider/model, and disposal.
 */
export function mountPromptBarIntoSlot(
  slot: HTMLElement,
  options: PromptBarOptions,
): PromptBarHandle {
  const handle = createPromptBar(options);
  // Ensure the slot has appropriate structure for the persistent bar.
  slot.setAttribute('role', 'region');
  slot.setAttribute('aria-label', 'Message composer');
  slot.appendChild(handle.element);
  return handle;
}

// ─── Utilities ──────────────────────────────────────────────────

function clampMaxLength(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_MAX_PROMPT_LENGTH;
  }
  return Math.min(Math.floor(input), DEFAULT_MAX_PROMPT_LENGTH);
}
