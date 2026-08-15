/**
 * LiveRegionManager — Manages ARIA live regions for dynamic content announcements.
 *
 * Provides polite and assertive live regions for different types of state changes.
 * Ensures screen readers receive appropriate updates without overwhelming users.
 *
 * Requirements: 23.1, 23.3
 */

/** Priority level for live-region announcements */
export type LiveRegionPriority = 'polite' | 'assertive';

/** A registered live region */
interface LiveRegion {
  readonly id: string;
  readonly element: HTMLElement;
  readonly priority: LiveRegionPriority;
}

/**
 * LiveRegionManager creates and manages hidden ARIA live regions
 * that screen readers monitor for dynamic content updates.
 *
 * Multiple named regions can coexist with different priorities:
 * - 'assertive' for urgent interruptions (approvals, failures)
 * - 'polite' for non-urgent updates (progress, status changes)
 */
export class LiveRegionManager {
  private readonly regions = new Map<string, LiveRegion>();
  private readonly announcementTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Create a live region attached to the given container.
   * The region is visually hidden but accessible to screen readers.
   */
  createRegion(container: HTMLElement, id: string, priority: LiveRegionPriority): HTMLElement {
    // Remove existing region with this ID if present
    this.removeRegion(id);

    const element = document.createElement('div');
    element.id = `a11y-live-${id}`;
    element.setAttribute('aria-live', priority);
    element.setAttribute('aria-atomic', 'true');
    element.setAttribute('role', priority === 'assertive' ? 'alert' : 'status');
    element.style.cssText =
      'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;' +
      'clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:0;';

    container.appendChild(element);
    this.regions.set(id, { id, element, priority });
    return element;
  }

  /**
   * Announce a message through the specified live region.
   * Clears and re-sets text to force re-announcement by screen readers.
   */
  announce(regionId: string, message: string): void {
    const region = this.regions.get(regionId);
    if (!region) return;

    // Clear any pending timer for this region
    const existingTimer = this.announcementTimers.get(regionId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    // Clear content first to force re-announcement
    region.element.textContent = '';

    // Set new content after a brief delay for screen reader to detect the change
    const timer = setTimeout(() => {
      region.element.textContent = message;
      this.announcementTimers.delete(regionId);
    }, 50);

    this.announcementTimers.set(regionId, timer);
  }

  /**
   * Get the priority of a registered region.
   */
  getRegionPriority(regionId: string): LiveRegionPriority | null {
    return this.regions.get(regionId)?.priority ?? null;
  }

  /**
   * Check if a region exists.
   */
  hasRegion(regionId: string): boolean {
    return this.regions.has(regionId);
  }

  /**
   * Get the current text content of a region.
   */
  getRegionContent(regionId: string): string | null {
    return this.regions.get(regionId)?.element.textContent ?? null;
  }

  /**
   * Remove a specific region and clean up.
   */
  removeRegion(id: string): void {
    const region = this.regions.get(id);
    if (region) {
      const timer = this.announcementTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.announcementTimers.delete(id);
      }
      region.element.remove();
      this.regions.delete(id);
    }
  }

  /**
   * Remove all regions and clean up all timers.
   */
  destroy(): void {
    for (const [id] of this.regions) {
      this.removeRegion(id);
    }
  }
}
