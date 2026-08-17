/**
 * Focus Trap and Deterministic Focus Restoration
 *
 * Implements modal focus containment and deterministic restoration logic:
 * - Trap focus within modal dialogs, lightboxes, and inspectors
 * - On close, restore focus to invoker -> nearest logical fallback -> primary composer
 * - Escape key closes when policy permits dismissal
 *
 * Requirements: 36.9–36.11, 41.5, 46.1, 46.3–46.4, 46.14
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────

/**
 * Types of surfaces that trap focus.
 */
export const FocusTrapSurfaceKindSchema = z.enum([
  'modal_dialog',
  'lightbox',
  'inspector',
  'takeover',
  'inline_editor',
  'disclosure',
]);

export type FocusTrapSurfaceKind = z.infer<typeof FocusTrapSurfaceKindSchema>;

/**
 * Policy controlling escape/close behavior for a trapped surface.
 */
export const DismissalPolicySchema = z.enum([
  'escape_permitted',
  'escape_blocked',
  'confirm_required',
]);

export type DismissalPolicy = z.infer<typeof DismissalPolicySchema>;

/**
 * Represents a focusable control within the surface hierarchy.
 */
export const FocusTargetSchema = z.object({
  /** Stable identity of the target element. */
  id: z.string().min(1),
  /** Semantic role for determining logical fallback ordering. */
  role: z.enum([
    'button',
    'input',
    'link',
    'listitem',
    'treeitem',
    'menuitem',
    'tab',
    'toolbar_action',
    'composer_input',
  ]),
  /** Whether this target is currently present in the DOM/surface. */
  alive: z.boolean(),
  /** The workflow group this target belongs to (for fallback ordering). */
  workflowGroup: z.string().optional(),
  /** Numeric ordering within the workflow group for deterministic fallback. */
  orderInGroup: z.number().int().nonnegative().optional(),
});

export type FocusTarget = z.infer<typeof FocusTargetSchema>;

/**
 * Descriptor for an active focus trap session.
 */
export const FocusTrapSessionSchema = z.object({
  /** Unique identity for this trap session. */
  trapId: z.string().min(1),
  /** The surface kind being trapped. */
  surfaceKind: FocusTrapSurfaceKindSchema,
  /** Dismissal policy for this trap. */
  dismissalPolicy: DismissalPolicySchema,
  /** The invoking control that opened the surface. */
  invokerId: z.string().min(1),
  /** Focusable elements within the trapped surface, in tab order. */
  trappedElements: z.array(z.string().min(1)).min(1),
  /** The primary composer input ID (final fallback). */
  primaryComposerId: z.string().min(1),
});

export type FocusTrapSession = z.infer<typeof FocusTrapSessionSchema>;

// ─── Focus Restoration Result ───────────────────────────────────

export type FocusRestorationTarget =
  | { kind: 'invoker'; targetId: string }
  | { kind: 'logical_fallback'; targetId: string; reason: string }
  | { kind: 'primary_composer'; targetId: string };

// ─── Focus Trap Manager ─────────────────────────────────────────

/**
 * Manages modal focus containment and deterministic restoration.
 *
 * Focus restoration order:
 * 1. Invoking control (if still alive)
 * 2. Nearest surviving logical control in the same workflow group
 * 3. Primary composer input (final fallback)
 *
 * Requirements: 46.3, 46.4, 46.14
 */
export class FocusTrapManager {
  private activeTrap: FocusTrapSession | null = null;
  private currentFocusIndex = 0;

  /**
   * Activates a focus trap on the given surface.
   * Focus moves to the first element in the trapped set.
   */
  activate(session: FocusTrapSession): { firstFocusTarget: string } {
    const parsed = FocusTrapSessionSchema.parse(session);
    this.activeTrap = parsed;
    this.currentFocusIndex = 0;
    return { firstFocusTarget: parsed.trappedElements[0]! };
  }

  /**
   * Returns the currently active trap session, or null.
   */
  getActiveTrap(): FocusTrapSession | null {
    return this.activeTrap;
  }

  /**
   * Whether focus is currently trapped.
   */
  isTrapped(): boolean {
    return this.activeTrap !== null;
  }

  /**
   * Handles a forward tab within the trap. Wraps at the end.
   * Returns the ID of the element that should receive focus.
   */
  tabForward(): string | null {
    if (!this.activeTrap) return null;
    const elements = this.activeTrap.trappedElements;
    this.currentFocusIndex = (this.currentFocusIndex + 1) % elements.length;
    return elements[this.currentFocusIndex] ?? null;
  }

  /**
   * Handles a backward tab within the trap. Wraps at the start.
   * Returns the ID of the element that should receive focus.
   */
  tabBackward(): string | null {
    if (!this.activeTrap) return null;
    const elements = this.activeTrap.trappedElements;
    this.currentFocusIndex = (this.currentFocusIndex - 1 + elements.length) % elements.length;
    return elements[this.currentFocusIndex] ?? null;
  }

  /**
   * Attempts to dismiss the trap via Escape.
   * Returns whether dismissal was permitted.
   */
  attemptEscapeDismiss(): { permitted: boolean; policy: DismissalPolicy } {
    if (!this.activeTrap) {
      return { permitted: false, policy: 'escape_blocked' };
    }
    const policy = this.activeTrap.dismissalPolicy;
    const permitted = policy === 'escape_permitted';
    return { permitted, policy };
  }

  /**
   * Deactivates the current focus trap and determines the restoration target.
   *
   * Restoration priority:
   * 1. Invoking control if alive
   * 2. Nearest surviving logical control in same workflow group
   * 3. Primary composer input
   *
   * Requirements: 46.3, 46.4, 46.14
   */
  deactivate(survivingTargets: FocusTarget[]): FocusRestorationTarget {
    if (!this.activeTrap) {
      return {
        kind: 'primary_composer',
        targetId: '',
      };
    }

    const trap = this.activeTrap;
    this.activeTrap = null;
    this.currentFocusIndex = 0;

    // 1. Try invoker
    const invoker = survivingTargets.find(
      (t) => t.id === trap.invokerId && t.alive,
    );
    if (invoker) {
      return { kind: 'invoker', targetId: invoker.id };
    }

    // 2. Try nearest logical fallback in same workflow group
    const invokerTarget = survivingTargets.find((t) => t.id === trap.invokerId);
    const workflowGroup = invokerTarget?.workflowGroup;

    if (workflowGroup) {
      const candidates = survivingTargets
        .filter((t) => t.alive && t.workflowGroup === workflowGroup && t.id !== trap.invokerId)
        .sort((a, b) => (a.orderInGroup ?? Infinity) - (b.orderInGroup ?? Infinity));

      if (candidates.length > 0) {
        return {
          kind: 'logical_fallback',
          targetId: candidates[0]!.id,
          reason: `invoker '${trap.invokerId}' removed; fell back to nearest control in workflow '${workflowGroup}'`,
        };
      }
    }

    // Also try any alive control that's not the invoker
    const anyAlive = survivingTargets
      .filter((t) => t.alive && t.id !== trap.invokerId)
      .sort((a, b) => (a.orderInGroup ?? Infinity) - (b.orderInGroup ?? Infinity));

    if (anyAlive.length > 0 && !workflowGroup) {
      return {
        kind: 'logical_fallback',
        targetId: anyAlive[0]!.id,
        reason: `invoker '${trap.invokerId}' removed; fell back to nearest surviving control`,
      };
    }

    // 3. Primary composer fallback
    return {
      kind: 'primary_composer',
      targetId: trap.primaryComposerId,
    };
  }
}
