/**
 * Typing/Thinking Indicator for the chat panel.
 * Displays an animated indicator with the active agent's name and emoji
 * while waiting for a response. Transitions smoothly to the rendered
 * response when streaming completes.
 *
 * Requirements: 23.18
 */

/** Configuration for the typing indicator. */
export interface TypingIndicatorConfig {
  /** Agent display name. */
  agentName: string;
  /** Agent emoji (e.g., "\uD83E\uDD16"). */
  agentEmoji: string;
  /** Optional label override (default: "is thinking..."). */
  label?: string;
}

/** CSS class names scoped to the typing indicator. */
const CSS = {
  container: 'nn-typing-indicator',
  containerHidden: 'nn-typing-indicator--hidden',
  agentInfo: 'nn-typing-indicator__agent-info',
  emoji: 'nn-typing-indicator__emoji',
  name: 'nn-typing-indicator__name',
  label: 'nn-typing-indicator__label',
  dots: 'nn-typing-indicator__dots',
  dot: 'nn-typing-indicator__dot',
} as const;

/** Injects scoped styles for the typing indicator. */
function injectStyles(): void {
  if (document.getElementById('nn-typing-indicator-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-typing-indicator-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      margin: 4px 0;
      border-radius: 8px;
      background: var(--typing-indicator-bg, #1e1e1e);
      border: 1px solid var(--typing-indicator-border, #2d2d2d);
      opacity: 1;
      transform: translateY(0);
      transition: opacity 0.3s ease, transform 0.3s ease, max-height 0.3s ease;
      max-height: 60px;
      overflow: hidden;
    }
    .${CSS.containerHidden} {
      opacity: 0;
      transform: translateY(-4px);
      max-height: 0;
      padding: 0 16px;
      margin: 0;
      border-color: transparent;
    }
    .${CSS.agentInfo} {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .${CSS.emoji} {
      font-size: 16px;
      line-height: 1;
    }
    .${CSS.name} {
      font-size: 13px;
      font-weight: 600;
      color: var(--typing-indicator-name, #e0e0e0);
    }
    .${CSS.label} {
      font-size: 13px;
      color: var(--typing-indicator-label, #888888);
    }
    .${CSS.dots} {
      display: flex;
      align-items: center;
      gap: 3px;
      margin-left: 4px;
    }
    .${CSS.dot} {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--typing-indicator-dot, #888888);
      animation: nn-typing-bounce 1.4s infinite ease-in-out both;
    }
    .${CSS.dot}:nth-child(1) {
      animation-delay: 0s;
    }
    .${CSS.dot}:nth-child(2) {
      animation-delay: 0.2s;
    }
    .${CSS.dot}:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes nn-typing-bounce {
      0%, 80%, 100% {
        transform: scale(0.6);
        opacity: 0.4;
      }
      40% {
        transform: scale(1);
        opacity: 1;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Creates a typing/thinking indicator element.
 * Shows the active agent's name and emoji with an animated dot indicator.
 *
 * @param config - Configuration containing agent name, emoji, and optional label
 * @returns The typing indicator DOM element
 */
export function createTypingIndicator(config: TypingIndicatorConfig): HTMLElement {
  injectStyles();

  const container = document.createElement('div');
  container.className = CSS.container;
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-label', `${config.agentName} is thinking`);

  // Agent info (emoji + name)
  const agentInfo = document.createElement('div');
  agentInfo.className = CSS.agentInfo;

  const emojiEl = document.createElement('span');
  emojiEl.className = CSS.emoji;
  emojiEl.textContent = config.agentEmoji;
  emojiEl.setAttribute('aria-hidden', 'true');
  agentInfo.appendChild(emojiEl);

  const nameEl = document.createElement('span');
  nameEl.className = CSS.name;
  nameEl.textContent = config.agentName;
  agentInfo.appendChild(nameEl);

  container.appendChild(agentInfo);

  // Label text
  const labelEl = document.createElement('span');
  labelEl.className = CSS.label;
  labelEl.textContent = config.label ?? 'is thinking...';
  container.appendChild(labelEl);

  // Animated dots
  const dots = document.createElement('div');
  dots.className = CSS.dots;
  dots.setAttribute('aria-hidden', 'true');

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = CSS.dot;
    dots.appendChild(dot);
  }

  container.appendChild(dots);

  return container;
}

/**
 * Hides the typing indicator with a smooth fade-out transition.
 * After the transition completes, the element is removed from the DOM.
 *
 * @param indicator - The typing indicator element to hide
 * @param onComplete - Optional callback invoked after the element is removed
 */
export function hideTypingIndicator(
  indicator: HTMLElement,
  onComplete?: () => void
): void {
  indicator.classList.add(CSS.containerHidden);
  indicator.setAttribute('aria-hidden', 'true');

  const handleTransitionEnd = (): void => {
    indicator.removeEventListener('transitionend', handleTransitionEnd);
    indicator.remove();
    onComplete?.();
  };

  indicator.addEventListener('transitionend', handleTransitionEnd);

  // Fallback: if transitionend doesn't fire (e.g., display:none parent),
  // remove after the animation duration + buffer
  setTimeout(() => {
    if (indicator.parentNode) {
      indicator.removeEventListener('transitionend', handleTransitionEnd);
      indicator.remove();
      onComplete?.();
    }
  }, 400);
}

/**
 * Replaces the typing indicator with rendered content, applying a smooth
 * transition. The indicator fades out while the content fades in.
 *
 * @param indicator - The typing indicator element to replace
 * @param content - The rendered response element to show
 */
export function transitionToContent(
  indicator: HTMLElement,
  content: HTMLElement
): void {
  const parent = indicator.parentNode;
  if (!parent) return;

  // Prepare content element for fade-in
  content.style.opacity = '0';
  content.style.transform = 'translateY(4px)';
  content.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

  // Insert content after indicator
  if (indicator.nextSibling) {
    parent.insertBefore(content, indicator.nextSibling);
  } else {
    parent.appendChild(content);
  }

  // Hide indicator
  hideTypingIndicator(indicator);

  // Fade in content after a brief delay
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      content.style.opacity = '1';
      content.style.transform = 'translateY(0)';
    });
  });

  // Clean up inline transition styles after animation
  const cleanup = (): void => {
    content.removeEventListener('transitionend', cleanup);
    content.style.transition = '';
    content.style.opacity = '';
    content.style.transform = '';
  };
  content.addEventListener('transitionend', cleanup);

  // Fallback cleanup
  setTimeout(() => {
    content.style.transition = '';
    content.style.opacity = '';
    content.style.transform = '';
  }, 400);
}

/**
 * TypingIndicatorManager - Manages the lifecycle of typing indicators
 * within a chat container. Ensures only one indicator is active at a time.
 */
export class TypingIndicatorManager {
  private container: HTMLElement;
  private currentIndicator: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Show a typing indicator for the given agent.
   * If an indicator is already showing, it is replaced.
   */
  show(config: TypingIndicatorConfig): HTMLElement {
    // Remove existing indicator if present
    if (this.currentIndicator) {
      this.currentIndicator.remove();
    }

    const indicator = createTypingIndicator(config);
    this.container.appendChild(indicator);
    this.currentIndicator = indicator;
    return indicator;
  }

  /**
   * Hide the current typing indicator with a smooth transition.
   */
  hide(onComplete?: () => void): void {
    if (!this.currentIndicator) {
      onComplete?.();
      return;
    }

    hideTypingIndicator(this.currentIndicator, () => {
      this.currentIndicator = null;
      onComplete?.();
    });
  }

  /**
   * Replace the current typing indicator with rendered content.
   */
  replaceWithContent(content: HTMLElement): void {
    if (!this.currentIndicator) {
      this.container.appendChild(content);
      return;
    }

    transitionToContent(this.currentIndicator, content);
    this.currentIndicator = null;
  }

  /**
   * Check if a typing indicator is currently visible.
   */
  isActive(): boolean {
    return this.currentIndicator !== null && this.currentIndicator.parentNode !== null;
  }
}
