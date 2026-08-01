/**
 * Step indicator component for numbered plans in chat messages.
 * Renders visual step indicators (checkbox, number badge, progress dot)
 * and allows users to mark individual steps as complete.
 * Uses IPC channel `chat:mark-step-complete` with { messageId, stepIndex }.
 */

/** Represents a single step in a numbered plan. */
export interface PlanStep {
  /** The text content of the step. */
  text: string;
  /** Whether the step has been marked complete by the user. */
  completed: boolean;
}

/** Configuration for a step indicator group. */
export interface StepIndicatorConfig {
  /** Unique message ID that owns this step list. */
  messageId: string;
  /** The steps to render. */
  steps: PlanStep[];
  /** Visual style variant. Default: 'checkbox'. */
  variant?: 'checkbox' | 'number-badge' | 'progress-dot';
}

/** CSS class names scoped to the step indicator. */
const CSS = {
  container: 'nn-step-indicator',
  step: 'nn-step-indicator__step',
  stepCompleted: 'nn-step-indicator__step--completed',
  indicator: 'nn-step-indicator__indicator',
  indicatorCheckbox: 'nn-step-indicator__indicator--checkbox',
  indicatorBadge: 'nn-step-indicator__indicator--badge',
  indicatorDot: 'nn-step-indicator__indicator--dot',
  label: 'nn-step-indicator__label',
  checkmark: 'nn-step-indicator__checkmark',
} as const;

/** Injects scoped styles for the step indicator component. */
function injectStyles(): void {
  if (document.getElementById('nn-step-indicator-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-step-indicator-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 0;
    }
    .${CSS.step} {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.1s ease;
    }
    .${CSS.step}:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .${CSS.stepCompleted} .${CSS.label} {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .${CSS.indicator} {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-top: 1px;
    }

    /* Checkbox variant */
    .${CSS.indicatorCheckbox} {
      width: 16px;
      height: 16px;
      border: 1.5px solid var(--step-indicator-border, #6b6b6b);
      border-radius: 3px;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .${CSS.stepCompleted} .${CSS.indicatorCheckbox} {
      background: var(--step-indicator-active, #4caf50);
      border-color: var(--step-indicator-active, #4caf50);
    }
    .${CSS.checkmark} {
      display: none;
      width: 10px;
      height: 10px;
    }
    .${CSS.stepCompleted} .${CSS.checkmark} {
      display: block;
    }

    /* Number badge variant */
    .${CSS.indicatorBadge} {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--step-badge-bg, #3d3d3d);
      color: var(--step-badge-text, #cccccc);
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
    }
    .${CSS.stepCompleted} .${CSS.indicatorBadge} {
      background: var(--step-indicator-active, #4caf50);
      color: var(--step-badge-active-text, #ffffff);
    }

    /* Progress dot variant */
    .${CSS.indicatorDot} {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--step-dot-inactive, #555555);
      transition: background 0.15s ease, transform 0.15s ease;
    }
    .${CSS.stepCompleted} .${CSS.indicatorDot} {
      background: var(--step-indicator-active, #4caf50);
      transform: scale(1.2);
    }

    .${CSS.label} {
      font-size: 13px;
      line-height: 1.5;
      color: var(--step-label-text, #e0e0e0);
      user-select: none;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
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

/**
 * Creates a step indicator group for a numbered plan in a chat message.
 * Returns the root DOM element that can be appended to the message content.
 */
export function createStepIndicator(config: StepIndicatorConfig): HTMLElement {
  injectStyles();

  const { messageId, steps, variant = 'checkbox' } = config;

  const container = document.createElement('div');
  container.className = CSS.container;
  container.setAttribute('role', 'list');
  container.setAttribute('aria-label', 'Plan steps');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepEl = createStepElement(step, i, variant, messageId);
    container.appendChild(stepEl);
  }

  return container;
}

/**
 * Creates a single step element with the appropriate indicator variant.
 */
function createStepElement(
  step: PlanStep,
  index: number,
  variant: 'checkbox' | 'number-badge' | 'progress-dot',
  messageId: string,
): HTMLElement {
  const stepEl = document.createElement('div');
  stepEl.className = CSS.step;
  stepEl.setAttribute('role', 'listitem');
  stepEl.dataset.stepIndex = String(index);

  if (step.completed) {
    stepEl.classList.add(CSS.stepCompleted);
  }

  // Indicator
  const indicator = document.createElement('div');
  indicator.className = CSS.indicator;

  switch (variant) {
    case 'checkbox': {
      indicator.classList.add(CSS.indicatorCheckbox);
      const checkmark = createCheckmarkSvg();
      checkmark.classList.add(CSS.checkmark);
      indicator.appendChild(checkmark);
      break;
    }
    case 'number-badge': {
      indicator.classList.add(CSS.indicatorBadge);
      indicator.textContent = String(index + 1);
      break;
    }
    case 'progress-dot': {
      indicator.classList.add(CSS.indicatorDot);
      break;
    }
  }

  // Label
  const label = document.createElement('span');
  label.className = CSS.label;
  label.textContent = step.text;

  stepEl.appendChild(indicator);
  stepEl.appendChild(label);

  // Click handler to toggle completion
  stepEl.addEventListener('click', () => {
    const isCompleted = stepEl.classList.toggle(CSS.stepCompleted);
    notifyStepComplete(messageId, index, isCompleted);
  });

  // Keyboard accessibility
  stepEl.setAttribute('tabindex', '0');
  stepEl.setAttribute(
    'aria-label',
    `Step ${index + 1}: ${step.text}${step.completed ? ' (completed)' : ''}`,
  );
  stepEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      stepEl.click();
    }
  });

  return stepEl;
}

/**
 * Creates an SVG checkmark icon element.
 */
function createCheckmarkSvg(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 6l3 3 5-5');
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  svg.appendChild(path);
  return svg;
}

/**
 * Sends an IPC message to the main process indicating a step was toggled.
 */
function notifyStepComplete(messageId: string, stepIndex: number, completed: boolean): void {
  const bridge = getIpcBridge();
  bridge.invoke('chat:mark-step-complete', { messageId, stepIndex, completed });
}

/**
 * Parses a message content string for numbered plan steps.
 * Recognizes patterns like:
 *   1. Step text
 *   2. Another step
 * or:
 *   - [ ] Step text
 *   - [x] Completed step
 *
 * Returns null if no plan steps are detected.
 */
export function parseSteps(content: string): PlanStep[] | null {
  const lines = content.split('\n');
  const steps: PlanStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Match "1. text", "2. text", etc.
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      steps.push({ text: numberedMatch[1], completed: false });
      continue;
    }

    // Match "- [ ] text" (unchecked) or "- [x] text" / "- [X] text" (checked)
    const checkboxMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (checkboxMatch) {
      const isChecked = checkboxMatch[1].toLowerCase() === 'x';
      steps.push({ text: checkboxMatch[2], completed: isChecked });
      continue;
    }
  }

  // Only return steps if we found at least 2 (a single item isn't really a "plan")
  return steps.length >= 2 ? steps : null;
}
