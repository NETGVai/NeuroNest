/**
 * ActionButtonRenderer — renders inline action button groups within chat messages.
 *
 * Implements IActionButtonRenderer from the inline action buttons feature.
 * Uses the existing createButton utility for consistent styling and accessibility.
 */

import { createButton, setButtonDisabled } from '../components/button';
import type {
  ActionCallback,
  ButtonGroupInstance,
  DetectionResult,
  IActionButtonRenderer,
} from '../types/action-buttons';

let nextId = 0;

/** Generate a unique button group ID. */
function generateId(): string {
  return `btn-group-${++nextId}`;
}

/**
 * ActionButtonRenderer manages creation and lifecycle of inline action button groups.
 */
export class ActionButtonRenderer implements IActionButtonRenderer {
  private activeInstances: ButtonGroupInstance[] = [];

  /**
   * Process a label string: capitalize first character and truncate if needed.
   * Returns the display label and optional full text for tooltip.
   */
  processLabel(text: string): { displayLabel: string; fullText: string | null } {
    if (text.length === 0) {
      return { displayLabel: '', fullText: null };
    }

    // Capitalize first character, preserve rest
    const capitalized = text.charAt(0).toUpperCase() + text.slice(1);

    if (capitalized.length > 20) {
      return {
        displayLabel: capitalized.slice(0, 20),
        fullText: capitalized,
      };
    }

    return { displayLabel: capitalized, fullText: null };
  }

  /**
   * Render a binary confirm/cancel button group into a message element.
   */
  render(
    messageEl: HTMLElement,
    detection: DetectionResult,
    onAction: ActionCallback
  ): ButtonGroupInstance {
    const id = generateId();

    // Create the container with aria-live for screen reader announcements
    const containerEl = document.createElement('div');
    containerEl.className = 'action-button-group';
    containerEl.setAttribute('role', 'group');
    containerEl.setAttribute('aria-live', 'polite');
    containerEl.setAttribute('aria-label', 'Action buttons');
    Object.assign(containerEl.style, {
      display: 'flex',
      gap: '8px',
      marginTop: '8px',
      padding: '4px 0',
    });

    // Build the instance early so click handlers can reference it
    const instance: ButtonGroupInstance = {
      id,
      containerEl,
      messageEl,
      state: 'active',
      detection,
      onAction,
    };

    // Determine the confirm button display label:
    // Use responseText (processed via processLabel) if available, otherwise use confirmLabel
    let confirmDisplayLabel: string;
    let confirmFullText: string | null = null;
    if (detection.responseText) {
      const processed = this.processLabel(detection.responseText);
      confirmDisplayLabel = processed.displayLabel || 'Confirm';
      confirmFullText = processed.fullText;
    } else {
      confirmDisplayLabel = detection.confirmLabel || 'Confirm';
    }

    // Process cancel label
    const cancelDisplayLabel = detection.cancelLabel || 'Cancel';

    // Create confirm button (primary styling)
    const confirmButton = createButton({
      label: confirmDisplayLabel,
      variant: detection.isDestructive ? 'danger' : 'primary',
      size: 'small',
      ariaLabel: `Confirm: ${confirmDisplayLabel}`,
      onClick: (event: MouseEvent) => {
        event.preventDefault();
        if (instance.state !== 'active') return;
        // Synchronously disable to prevent duplicate clicks
        this.disableButtons(containerEl);
        instance.state = 'resolved-confirm';
        onAction(detection.responseText ?? detection.confirmLabel.toLowerCase(), 'confirm');
      },
    });

    // Set title tooltip if label was truncated
    if (confirmFullText) {
      confirmButton.setAttribute('title', confirmFullText);
    }

    // Create cancel button (secondary styling)
    const cancelButton = createButton({
      label: cancelDisplayLabel,
      variant: 'secondary',
      size: 'small',
      ariaLabel: `Cancel: ${cancelDisplayLabel}`,
      onClick: (event: MouseEvent) => {
        event.preventDefault();
        if (instance.state !== 'active') return;
        // Synchronously disable to prevent duplicate clicks
        this.disableButtons(containerEl);
        instance.state = 'resolved-cancel';
        onAction('cancel', 'cancel');
      },
    });

    containerEl.appendChild(confirmButton);
    containerEl.appendChild(cancelButton);

    // Position below message text content
    messageEl.appendChild(containerEl);

    // Track active instance
    this.activeInstances.push(instance);

    return instance;
  }

  /**
   * Render a multi-choice button group with N option buttons.
   *
   * - If N ≤ 6: renders exactly N buttons, one per option.
   * - If N > 6: renders the first 5 options as buttons + one "More options..." overflow button.
   *   Clicking the overflow button replaces it with buttons for the remaining options (index 5 to N-1).
   *
   * Each option button calls onAction(optionText, 'option') when clicked and disables all buttons.
   */
  renderMultiChoice(
    messageEl: HTMLElement,
    options: string[],
    onAction: ActionCallback
  ): ButtonGroupInstance {
    const id = generateId();
    const containerEl = document.createElement('div');
    containerEl.className = 'action-button-group';
    containerEl.setAttribute('role', 'group');
    containerEl.setAttribute('aria-live', 'polite');
    containerEl.setAttribute('aria-label', 'Option buttons');
    Object.assign(containerEl.style, {
      display: 'flex',
      gap: '8px',
      marginTop: '8px',
      padding: '4px 0',
      flexWrap: 'wrap',
    });

    const detection: DetectionResult = {
      type: 'multi-choice',
      responseText: null,
      confirmLabel: '',
      cancelLabel: 'Cancel',
      options,
      isDestructive: false,
      promptOffset: 0,
    };

    const instance: ButtonGroupInstance = {
      id,
      containerEl,
      messageEl,
      state: 'active',
      detection,
      onAction,
    };

    const MAX_VISIBLE = 6;
    const OVERFLOW_THRESHOLD = 6;
    const needsOverflow = options.length > OVERFLOW_THRESHOLD;
    const visibleOptions = needsOverflow ? options.slice(0, MAX_VISIBLE - 1) : options;

    // Helper to create an option button
    const createOptionButton = (option: string): HTMLButtonElement => {
      return createButton({
        label: option,
        variant: 'secondary',
        size: 'small',
        ariaLabel: `Option: ${option}`,
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          if (instance.state !== 'active') return;
          this.disableButtons(containerEl);
          instance.state = 'resolved-confirm';
          onAction(option, 'option');
        },
      });
    };

    // Render visible option buttons
    for (const option of visibleOptions) {
      containerEl.appendChild(createOptionButton(option));
    }

    // Render overflow button if needed
    if (needsOverflow) {
      const overflowBtn = createButton({
        label: 'More options...',
        variant: 'secondary',
        size: 'small',
        ariaLabel: 'More options...',
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          if (instance.state !== 'active') return;

          // Remove the overflow button
          overflowBtn.remove();

          // Append buttons for the remaining options
          const remainingOptions = options.slice(MAX_VISIBLE - 1);
          for (const option of remainingOptions) {
            containerEl.appendChild(createOptionButton(option));
          }
        },
      });
      containerEl.appendChild(overflowBtn);
    }

    messageEl.appendChild(containerEl);
    this.activeInstances.push(instance);

    return instance;
  }

  /**
   * Disable a button group (e.g., when superseded by a new message or manual input).
   * Sets all buttons to disabled, updates aria attributes, adds visual disabled class.
   */
  disable(instance: ButtonGroupInstance): void {
    if (instance.state !== 'active') return;
    instance.state = 'disabled';
    instance.containerEl.classList.add('action-button-group--disabled');
    this.disableButtons(instance.containerEl);
    this.removeFromActive(instance);
  }

  /**
   * Mark a button group as resolved with the selected action.
   * Highlights the selected button, dims the others, adds an aria announcement.
   */
  resolve(
    instance: ButtonGroupInstance,
    selectedAction: 'confirm' | 'cancel',
    selectedIndex?: number
  ): void {
    if (instance.state !== 'active') return;
    instance.state = selectedAction === 'confirm' ? 'resolved-confirm' : 'resolved-cancel';

    // Disable all buttons
    this.disableButtons(instance.containerEl);

    // Determine which button index was selected
    const buttons = instance.containerEl.querySelectorAll('button');
    const resolvedIndex = selectedIndex ?? (selectedAction === 'confirm' ? 0 : buttons.length - 1);

    // Apply highlight/dim styling
    buttons.forEach((btn, idx) => {
      if (idx === resolvedIndex) {
        btn.classList.add('action-button--selected');
        (btn as HTMLElement).style.opacity = '1';
      } else {
        btn.classList.add('action-button--dimmed');
        (btn as HTMLElement).style.opacity = '0.4';
      }
    });

    // Add an aria-live announcement indicating which option was selected
    const selectedButton = buttons[resolvedIndex] as HTMLButtonElement | undefined;
    const selectedLabel = selectedButton?.textContent ?? selectedAction;
    const announcement = document.createElement('span');
    announcement.className = 'sr-only';
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'assertive');
    announcement.textContent = `Selected: ${selectedLabel}`;
    instance.containerEl.appendChild(announcement);

    this.removeFromActive(instance);
  }

  /**
   * Remove a button group from the DOM entirely (e.g., session termination).
   * Detaches the container element and cleans up event listeners.
   */
  remove(instance: ButtonGroupInstance): void {
    // Remove all click event listeners by replacing buttons with clones
    const buttons = instance.containerEl.querySelectorAll('button');
    buttons.forEach((btn) => {
      const clone = btn.cloneNode(true);
      btn.parentNode?.replaceChild(clone, btn);
    });

    // Detach from DOM
    instance.containerEl.remove();
    this.removeFromActive(instance);
  }

  /**
   * Get all active (non-disabled, non-resolved) button group instances.
   * Only returns instances whose state is 'active'.
   */
  getActiveInstances(): ButtonGroupInstance[] {
    return this.activeInstances.filter((inst) => inst.state === 'active');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Disable all buttons within a container element. */
  private disableButtons(containerEl: HTMLElement): void {
    const buttons = containerEl.querySelectorAll('button');
    buttons.forEach((btn) => {
      setButtonDisabled(btn as HTMLButtonElement, true);
      btn.setAttribute('aria-disabled', 'true');
    });
  }

  /** Remove an instance from the active tracking list. */
  private removeFromActive(instance: ButtonGroupInstance): void {
    const idx = this.activeInstances.indexOf(instance);
    if (idx !== -1) {
      this.activeInstances.splice(idx, 1);
    }
  }
}
