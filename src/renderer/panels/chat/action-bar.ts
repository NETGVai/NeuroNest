/**
 * Contextual action bar component for the chat panel.
 * Appears on hover over message blocks and provides quick actions:
 * Copy, Regenerate, Edit, Insert at Cursor, Apply Diff.
 * Each button triggers appropriate IPC or clipboard action.
 *
 * Requirements: 23.5
 */

/** CSS class names scoped to the action bar. */
const CSS = {
  bar: 'nn-action-bar',
  barVisible: 'nn-action-bar--visible',
  button: 'nn-action-bar__btn',
  buttonIcon: 'nn-action-bar__btn-icon',
  buttonLabel: 'nn-action-bar__btn-label',
  separator: 'nn-action-bar__separator',
} as const;

/** IPC channels used by action bar buttons. */
const IPC_CHANNELS = {
  APPLY_CODE: 'chat:apply-code',
  REGENERATE: 'chat:regenerate-message',
  EDIT_MESSAGE: 'chat:edit-message',
  INSERT_AT_CURSOR: 'chat:insert-at-cursor',
  APPLY_DIFF: 'chat:apply-diff',
} as const;

/** Defines a single action button in the action bar. */
export interface ActionBarButton {
  id: string;
  icon: string;
  label: string;
  /** Tooltip text (shown on hover). */
  tooltip: string;
  /** Whether this action is only visible for certain message types. */
  condition?: ActionCondition;
  /** Handler invoked when the button is clicked. */
  handler: (context: ActionContext) => void;
}

/** Condition determining when a button should be visible. */
export type ActionCondition = 'user-message' | 'assistant-message' | 'has-diff' | 'has-code' | 'always';

/** Context passed to action button handlers. */
export interface ActionContext {
  /** The message ID this action bar is attached to. */
  messageId: string;
  /** The raw text content of the message. */
  content: string;
  /** The sender of the message ('user' | 'assistant' | 'system'). */
  sender: string;
  /** Optional code block content if the action targets a specific code block. */
  codeBlock?: string;
  /** Optional diff content if the message contains a diff. */
  diffContent?: string;
  /** Reasoning/thinking content from the LLM, if available. */
  reasoning?: string;
}

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Injects scoped styles for the action bar. */
function injectStyles(): void {
  if (document.getElementById('nn-action-bar-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-action-bar-styles';
  style.textContent = `
    .${CSS.bar} {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px 6px;
      border-radius: 6px;
      background: var(--action-bar-bg, #1e1e1e);
      border: 1px solid var(--action-bar-border, #3d3d3d);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s ease, visibility 0.15s ease;
      position: absolute;
      top: -4px;
      right: 8px;
      transform: translateY(-100%);
      z-index: 10;
      pointer-events: none;
    }
    .${CSS.barVisible} {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    .${CSS.button} {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--action-bar-text, #cccccc);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s ease, color 0.12s ease;
      line-height: 1;
    }
    .${CSS.button}:hover {
      background: var(--action-bar-btn-hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--action-bar-btn-hover-text, #ffffff);
    }
    .${CSS.button}:focus-visible {
      outline: 2px solid var(--focus-ring, #569cd6);
      outline-offset: -1px;
    }
    .${CSS.button}:active {
      background: var(--action-bar-btn-active-bg, rgba(255, 255, 255, 0.12));
    }
    .${CSS.buttonIcon} {
      font-size: 13px;
      flex-shrink: 0;
    }
    .${CSS.buttonLabel} {
      font-size: 11px;
      font-weight: 500;
    }
    .${CSS.separator} {
      width: 1px;
      height: 16px;
      background: var(--action-bar-separator, #3d3d3d);
      margin: 0 2px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Copy text to clipboard using the Clipboard API.
 * Falls back to execCommand for older environments.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy method
  }

  // Legacy fallback
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}

/** Default action buttons available on message hover. */
function getDefaultActions(): ActionBarButton[] {
  return [
    {
      id: 'copy',
      icon: '📋',
      label: 'Copy',
      tooltip: 'Copy message content to clipboard',
      condition: 'user-message',
      handler: (ctx: ActionContext) => {
        const textToCopy = ctx.codeBlock || ctx.content;
        copyToClipboard(textToCopy);
      },
    },
    {
      id: 'regenerate',
      icon: '🔄',
      label: 'Regenerate',
      tooltip: 'Regenerate this response',
      condition: 'assistant-message',
      handler: (ctx: ActionContext) => {
        const bridge = getIpcBridge();
        bridge.invoke(IPC_CHANNELS.REGENERATE, { messageId: ctx.messageId });
      },
    },
    {
      id: 'edit',
      icon: '✏️',
      label: 'Edit',
      tooltip: 'Edit this message',
      condition: 'user-message',
      handler: (ctx: ActionContext) => {
        const bridge = getIpcBridge();
        bridge.invoke(IPC_CHANNELS.EDIT_MESSAGE, { messageId: ctx.messageId, content: ctx.content });
      },
    },
    {
      id: 'insert-at-cursor',
      icon: '⎀',
      label: 'Insert at Cursor',
      tooltip: 'Insert content at the current cursor position in the editor',
      condition: 'assistant-message',
      handler: (ctx: ActionContext) => {
        const bridge = getIpcBridge();
        const content = ctx.codeBlock || ctx.content;
        bridge.invoke(IPC_CHANNELS.INSERT_AT_CURSOR, { content });
      },
    },
    {
      id: 'apply-diff',
      icon: '🔀',
      label: 'Apply Diff',
      tooltip: 'Apply the diff to the target file',
      condition: 'has-diff',
      handler: (ctx: ActionContext) => {
        const bridge = getIpcBridge();
        bridge.invoke(IPC_CHANNELS.APPLY_DIFF, { messageId: ctx.messageId, diff: ctx.diffContent });
      },
    },
    // Note: the "Expand full-screen overlay" button was retired by task 13.3
    // when its dependency (`window.renderExpandOverlay` from the legacy
    // `chat-message-actions.ts`) was removed. Full-content viewing now
    // happens via the canonical response-group and structured-response
    // surfaces mounted by `createProjectionChatIntegration`.
  ];
}

/**
 * Evaluate whether a button's condition is met given the action context.
 */
function evaluateCondition(condition: ActionCondition | undefined, context: ActionContext): boolean {
  if (!condition || condition === 'always') return true;

  switch (condition) {
    case 'user-message':
      return context.sender === 'user';
    case 'assistant-message':
      return context.sender === 'assistant';
    case 'has-diff':
      return !!context.diffContent;
    case 'has-code':
      return !!context.codeBlock;
    default:
      return true;
  }
}

/**
 * ActionBar class — manages a contextual toolbar that appears on hover over message blocks.
 * Attaches to a message container element and shows/hides based on mouse events.
 */
export class ActionBar {
  private barElement: HTMLElement | null = null;
  private parentElement: HTMLElement | null = null;
  private context: ActionContext;
  private actions: ActionBarButton[];
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(context: ActionContext, actions?: ActionBarButton[]) {
    this.context = context;
    this.actions = actions || getDefaultActions();
  }

  /**
   * Attach the action bar to a message container element.
   * The action bar will appear on hover and disappear when the mouse leaves.
   */
  attach(messageElement: HTMLElement): void {
    injectStyles();

    this.parentElement = messageElement;

    // Ensure the parent has relative positioning for the absolute action bar
    const computedPosition = window.getComputedStyle(messageElement).position;
    if (computedPosition === 'static') {
      messageElement.style.position = 'relative';
    }

    // Create the action bar element
    this.barElement = this.createBarElement();
    messageElement.appendChild(this.barElement);

    // Attach hover listeners
    messageElement.addEventListener('mouseenter', this.handleMouseEnter);
    messageElement.addEventListener('mouseleave', this.handleMouseLeave);
  }

  /** Detach the action bar and remove event listeners. */
  detach(): void {
    if (this.parentElement) {
      this.parentElement.removeEventListener('mouseenter', this.handleMouseEnter);
      this.parentElement.removeEventListener('mouseleave', this.handleMouseLeave);
    }

    if (this.barElement && this.barElement.parentElement) {
      this.barElement.parentElement.removeChild(this.barElement);
    }

    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    this.barElement = null;
    this.parentElement = null;
  }

  /** Update the action context (e.g. when message content changes via streaming). */
  updateContext(context: Partial<ActionContext>): void {
    this.context = { ...this.context, ...context };
  }

  /** Show the action bar. */
  show(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.barElement) {
      this.barElement.classList.add(CSS.barVisible);
    }
  }

  /** Hide the action bar. */
  hide(): void {
    if (this.barElement) {
      this.barElement.classList.remove(CSS.barVisible);
    }
  }

  /** Build the action bar DOM element with buttons. */
  private createBarElement(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = CSS.bar;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Message actions');

    // Filter actions based on context conditions
    const visibleActions = this.actions.filter((action) =>
      evaluateCondition(action.condition, this.context)
    );

    for (let i = 0; i < visibleActions.length; i++) {
      const action = visibleActions[i];

      // Add separator between groups (after Copy, before the rest)
      if (i === 1 && visibleActions.length > 1) {
        const sep = document.createElement('div');
        sep.className = CSS.separator;
        sep.setAttribute('aria-hidden', 'true');
        bar.appendChild(sep);
      }

      const button = this.createButton(action);
      bar.appendChild(button);
    }

    return bar;
  }

  /** Create a single action button element. */
  private createButton(action: ActionBarButton): HTMLElement {
    const btn = document.createElement('button');
    btn.className = CSS.button;
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', action.tooltip);
    btn.title = action.tooltip;

    const icon = document.createElement('span');
    icon.className = CSS.buttonIcon;
    icon.textContent = action.icon;
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);

    const label = document.createElement('span');
    label.className = CSS.buttonLabel;
    label.textContent = action.label;
    btn.appendChild(label);

    btn.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      action.handler(this.context);
    });

    return btn;
  }

  /** Handle mouse entering the parent message element. */
  private handleMouseEnter = (): void => {
    this.show();
  };

  /** Handle mouse leaving the parent message element. */
  private handleMouseLeave = (): void => {
    // Small delay to allow moving to the action bar itself
    this.hideTimeout = setTimeout(() => {
      this.hide();
    }, 200);
  };
}

/**
 * Factory function to create and attach an action bar to a message element.
 * Convenience function for typical usage in the chat list.
 *
 * @param messageElement - The message DOM element to attach the action bar to.
 * @param context - The action context describing the message.
 * @param actions - Optional custom actions (defaults to standard set).
 * @returns The created ActionBar instance for later detachment/update.
 */
export function attachActionBar(
  messageElement: HTMLElement,
  context: ActionContext,
  actions?: ActionBarButton[]
): ActionBar {
  const actionBar = new ActionBar(context, actions);
  actionBar.attach(messageElement);
  return actionBar;
}
