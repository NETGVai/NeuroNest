/**
 * Spec Viewer Action Bar — Renders workflow action buttons at the top of the
 * Spec Viewer Panel and triggers corresponding spec workflow commands via IPC.
 *
 * Action buttons:
 *   - "Analyze Requirements" → triggers 'analyze' workflow
 *   - "Generate Design" → triggers 'design' workflow
 *   - "Generate Tasks" → triggers 'tasks' workflow
 *   - "Run All Tasks" → triggers 'run-all' workflow
 *
 * Requirements: 23.10
 */

// ─── Types ──────────────────────────────────────────────────────

/** Workflow actions available from the action bar. */
export type WorkflowAction = 'analyze' | 'design' | 'tasks' | 'run-all';

/** Configuration for a single action button. */
interface ActionButtonConfig {
  action: WorkflowAction;
  label: string;
  icon: string;
  description: string;
}

/** State of an action button during workflow execution. */
type ActionButtonState = 'idle' | 'loading' | 'success' | 'error';

// ─── Constants ──────────────────────────────────────────────────

const ACTION_BUTTONS: ActionButtonConfig[] = [
  {
    action: 'analyze',
    label: 'Analyze Requirements',
    icon: '\uD83D\uDD0D', // Magnifying glass
    description: 'Analyze and validate requirements document',
  },
  {
    action: 'design',
    label: 'Generate Design',
    icon: '\uD83D\uDCD0', // Triangular ruler
    description: 'Generate design document from requirements',
  },
  {
    action: 'tasks',
    label: 'Generate Tasks',
    icon: '\uD83D\uDCCB', // Clipboard
    description: 'Generate implementation tasks from design',
  },
  {
    action: 'run-all',
    label: 'Run All Tasks',
    icon: '\u25B6\uFE0F', // Play button
    description: 'Execute all pending tasks in sequence',
  },
];

// ─── CSS Classes ────────────────────────────────────────────────

const CLS = {
  actionBar: 'nn-spec-viewer__action-bar',
  actionButton: 'nn-spec-viewer__action-btn',
  actionButtonLoading: 'nn-spec-viewer__action-btn--loading',
  actionButtonSuccess: 'nn-spec-viewer__action-btn--success',
  actionButtonError: 'nn-spec-viewer__action-btn--error',
  actionIcon: 'nn-spec-viewer__action-icon',
  actionLabel: 'nn-spec-viewer__action-label',
  spinner: 'nn-spec-viewer__spinner',
} as const;

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for the action bar. */
export function injectActionBarStyles(): void {
  if (document.getElementById('nn-spec-viewer-action-bar-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-spec-viewer-action-bar-styles';
  style.textContent = `
    .${CLS.actionBar} {
      display: flex;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border, #334155);
      background: var(--bg-secondary, #1e293b);
      flex-wrap: wrap;
      align-items: center;
      flex-shrink: 0;
    }
    .${CLS.actionButton} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--border, #475569);
      border-radius: 6px;
      background: var(--bg-primary, #0f172a);
      color: var(--text-primary, #e2e8f0);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, opacity 0.15s;
      white-space: nowrap;
    }
    .${CLS.actionButton}:hover {
      background: var(--bg-hover, #334155);
      border-color: var(--accent, #6366f1);
    }
    .${CLS.actionButton}:active {
      transform: scale(0.97);
    }
    .${CLS.actionButton}:focus-visible {
      outline: 2px solid var(--accent, #6366f1);
      outline-offset: 2px;
    }
    .${CLS.actionButtonLoading} {
      opacity: 0.7;
      pointer-events: none;
    }
    .${CLS.actionButtonSuccess} {
      border-color: var(--green, #10b981);
      background: rgba(16, 185, 129, 0.1);
    }
    .${CLS.actionButtonError} {
      border-color: var(--red, #ef4444);
      background: rgba(239, 68, 68, 0.1);
    }
    .${CLS.actionIcon} {
      font-size: 14px;
      line-height: 1;
    }
    .${CLS.actionLabel} {
      line-height: 1.2;
    }
    .${CLS.spinner} {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--border, #475569);
      border-top-color: var(--accent, #6366f1);
      border-radius: 50%;
      animation: nn-spec-spin 0.6s linear infinite;
    }
    @keyframes nn-spec-spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

// ─── IPC Bridge ─────────────────────────────────────────────────

/** Typed wrapper around the preload-exposed IPC bridge. */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const win = window as unknown as Record<string, unknown>;
  const bridge = win['electronAPI'] as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

// ─── Component ──────────────────────────────────────────────────

/**
 * Render the action bar with workflow action buttons.
 *
 * Each button triggers the corresponding spec workflow command via IPC
 * when clicked.
 *
 * @returns The action bar DOM element.
 */
export function renderActionBar(): HTMLElement {
  injectActionBarStyles();

  const bar = document.createElement('div');
  bar.className = CLS.actionBar;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Spec workflow actions');

  for (const config of ACTION_BUTTONS) {
    const button = createActionButton(config);
    bar.appendChild(button);
  }

  return bar;
}

/**
 * Create a single action button element with click handler.
 */
function createActionButton(config: ActionButtonConfig): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = CLS.actionButton;
  button.setAttribute('type', 'button');
  button.setAttribute('aria-label', config.description);
  button.setAttribute('title', config.description);
  button.dataset.action = config.action;

  // Icon
  const icon = document.createElement('span');
  icon.className = CLS.actionIcon;
  icon.textContent = config.icon;
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  // Label
  const label = document.createElement('span');
  label.className = CLS.actionLabel;
  label.textContent = config.label;
  button.appendChild(label);

  // Click handler — triggers workflow via IPC
  button.addEventListener('click', () => {
    handleActionClick(button, config.action);
  });

  return button;
}

/**
 * Handle an action button click: show loading state, invoke IPC, then
 * show success or error state briefly.
 */
async function handleActionClick(
  button: HTMLButtonElement,
  action: WorkflowAction,
): Promise<void> {
  // Prevent double-clicks while loading
  if (button.classList.contains(CLS.actionButtonLoading)) {
    return;
  }

  setButtonState(button, 'loading');

  try {
    const bridge = getIpcBridge();
    const response = await bridge.invoke('spec:run-workflow', { action }) as
      | { success: boolean; error?: { message: string } }
      | undefined;

    if (response?.success) {
      setButtonState(button, 'success');
    } else {
      setButtonState(button, 'error');
      console.warn(
        `[SpecViewer] Workflow "${action}" failed:`,
        response?.error?.message ?? 'Unknown error',
      );
    }
  } catch (err) {
    setButtonState(button, 'error');
    console.error(`[SpecViewer] Workflow "${action}" error:`, err);
  }

  // Reset to idle after a brief delay
  setTimeout(() => {
    setButtonState(button, 'idle');
  }, 2000);
}

/**
 * Update the visual state of an action button.
 */
function setButtonState(button: HTMLButtonElement, state: ActionButtonState): void {
  // Remove all state classes
  button.classList.remove(
    CLS.actionButtonLoading,
    CLS.actionButtonSuccess,
    CLS.actionButtonError,
  );

  // Remove existing spinner if present
  const existingSpinner = button.querySelector(`.${CLS.spinner}`);
  if (existingSpinner) {
    existingSpinner.remove();
  }

  switch (state) {
    case 'loading':
      button.classList.add(CLS.actionButtonLoading);
      // Add spinner before the label
      const spinner = document.createElement('span');
      spinner.className = CLS.spinner;
      spinner.setAttribute('aria-hidden', 'true');
      const iconEl = button.querySelector(`.${CLS.actionIcon}`);
      if (iconEl) {
        iconEl.replaceWith(spinner);
      }
      break;
    case 'success':
      button.classList.add(CLS.actionButtonSuccess);
      restoreIcon(button);
      break;
    case 'error':
      button.classList.add(CLS.actionButtonError);
      restoreIcon(button);
      break;
    case 'idle':
    default:
      restoreIcon(button);
      break;
  }
}

/**
 * Restore the icon element if it was replaced by a spinner.
 */
function restoreIcon(button: HTMLButtonElement): void {
  const action = button.dataset.action as WorkflowAction | undefined;
  if (!action) return;

  const config = ACTION_BUTTONS.find((cfg) => cfg.action === action);
  if (!config) return;

  const existingIcon = button.querySelector(`.${CLS.actionIcon}`);
  if (!existingIcon) {
    // Icon was replaced by spinner — restore it
    const icon = document.createElement('span');
    icon.className = CLS.actionIcon;
    icon.textContent = config.icon;
    icon.setAttribute('aria-hidden', 'true');
    // Insert before label (first child position)
    const spinner = button.querySelector(`.${CLS.spinner}`);
    if (spinner) {
      spinner.replaceWith(icon);
    } else {
      button.insertBefore(icon, button.firstChild);
    }
  }
}

export default renderActionBar;
