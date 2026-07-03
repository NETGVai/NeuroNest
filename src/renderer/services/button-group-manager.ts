/**
 * ButtonGroupManager — manages the lifecycle of all active button groups.
 *
 * Handles invalidation when new messages arrive, manual user input is detected,
 * or sessions are terminated.
 *
 * Implements IButtonGroupManager from the inline action buttons feature.
 * Validates: Requirements 3.3, 4.2, 7.2, 7.3
 */

import { setButtonDisabled } from '../components/button';
import type { ButtonGroupInstance, IButtonGroupManager } from '../types/action-buttons';

/**
 * ButtonGroupManager tracks all registered ButtonGroupInstance objects and
 * provides lifecycle operations: disable, remove, and per-message targeting.
 */
export class ButtonGroupManager implements IButtonGroupManager {
  private instances: ButtonGroupInstance[] = [];

  /**
   * Register a new active button group for lifecycle tracking.
   */
  register(instance: ButtonGroupInstance): void {
    this.instances.push(instance);
  }

  /**
   * Disable all active button groups.
   * Called when a new agent message arrives (Requirement 7.2).
   */
  disableAll(): void {
    for (const instance of this.instances) {
      if (instance.state === 'active') {
        this.disableInstance(instance);
      }
    }
  }

  /**
   * Remove all button groups from the DOM and clear the tracking array.
   * Called on session termination (Requirement 7.3).
   */
  removeAll(): void {
    for (const instance of this.instances) {
      instance.containerEl.remove();
    }
    this.instances = [];
  }

  /**
   * Disable button groups belonging to a specific message element.
   */
  disableForMessage(messageEl: HTMLElement): void {
    for (const instance of this.instances) {
      if (instance.messageEl === messageEl && instance.state === 'active') {
        this.disableInstance(instance);
      }
    }
  }

  /**
   * Handle manual user input — disables all active groups (Requirement 4.2).
   * Same behavior as disableAll() since any manual typing supersedes button actions.
   */
  onManualInput(): void {
    this.disableAll();
  }

  /**
   * Get the count of currently active (non-disabled, non-resolved) button groups.
   */
  activeCount(): number {
    return this.instances.filter((instance) => instance.state === 'active').length;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Disable a single button group instance: set state to 'disabled' and
   * disable all buttons within its container.
   */
  private disableInstance(instance: ButtonGroupInstance): void {
    instance.state = 'disabled';
    const buttons = instance.containerEl.querySelectorAll('button');
    buttons.forEach((btn) => {
      setButtonDisabled(btn as HTMLButtonElement, true);
      btn.setAttribute('aria-disabled', 'true');
    });
  }
}

/**
 * Shared singleton instance of ButtonGroupManager.
 * Used by the chat panel submit handler and stream renderer integration
 * to coordinate button group lifecycle across the renderer process.
 */
export const buttonGroupManager = new ButtonGroupManager();
