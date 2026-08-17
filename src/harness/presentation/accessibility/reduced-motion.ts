/**
 * Reduced Motion — Suppress Nonessential Animation
 *
 * When prefers-reduced-motion is active, removes blinking, smooth
 * scrolling, and nonessential progress animations. State meaning is
 * preserved through text, shape, or icon changes instead.
 *
 * Requirements: 36.9, 46.8
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────

/**
 * Motion preference as resolved from OS/browser media query.
 */
export const MotionPreferenceSchema = z.enum(['no-preference', 'reduce']);
export type MotionPreference = z.infer<typeof MotionPreferenceSchema>;

/**
 * Categories of motion that can be suppressed.
 */
export const MotionCategorySchema = z.enum([
  'cursor_blink',
  'smooth_scroll',
  'progress_animation',
  'transition',
  'loading_spinner',
  'expand_collapse_animation',
  'streaming_cursor',
  'entrance_animation',
]);
export type MotionCategory = z.infer<typeof MotionCategorySchema>;

/**
 * A motion adjustment result: what to do instead of animating.
 */
export const MotionAdjustmentSchema = z.object({
  /** Whether the motion should be suppressed entirely. */
  suppress: z.boolean(),
  /** What to show instead (text/icon/shape change). */
  alternative: z.enum(['static_indicator', 'text_label', 'icon_change', 'none']),
  /** Description of the alternative for assistive tech. */
  alternativeDescription: z.string().optional(),
});
export type MotionAdjustment = z.infer<typeof MotionAdjustmentSchema>;

// ─── Motion Adjustment Rules ────────────────────────────────────

/**
 * Rules mapping each motion category to its reduced-motion behavior.
 * These are the nonessential motions that MUST be removed when
 * prefers-reduced-motion is active.
 */
const REDUCED_MOTION_RULES: Record<MotionCategory, MotionAdjustment> = {
  cursor_blink: {
    suppress: true,
    alternative: 'static_indicator',
    alternativeDescription: 'Static cursor visible without blinking',
  },
  smooth_scroll: {
    suppress: true,
    alternative: 'none',
    alternativeDescription: 'Instant scroll jump to target position',
  },
  progress_animation: {
    suppress: true,
    alternative: 'text_label',
    alternativeDescription: 'Text percentage or state label',
  },
  transition: {
    suppress: true,
    alternative: 'none',
    alternativeDescription: 'Instant state change without transition',
  },
  loading_spinner: {
    suppress: true,
    alternative: 'text_label',
    alternativeDescription: 'Loading text indicator',
  },
  expand_collapse_animation: {
    suppress: true,
    alternative: 'none',
    alternativeDescription: 'Instant expand/collapse without animation',
  },
  streaming_cursor: {
    suppress: true,
    alternative: 'static_indicator',
    alternativeDescription: 'Static streaming indicator without blink',
  },
  entrance_animation: {
    suppress: true,
    alternative: 'none',
    alternativeDescription: 'Content appears instantly without entrance effect',
  },
};

/**
 * When motion is not reduced, all categories are permitted.
 */
const NO_REDUCTION: MotionAdjustment = {
  suppress: false,
  alternative: 'none',
};

// ─── Reduced Motion Manager ─────────────────────────────────────

/**
 * Manages reduced-motion decisions for presentation elements.
 *
 * Usage:
 * ```ts
 * const mgr = new ReducedMotionManager('reduce');
 * const adj = mgr.getAdjustment('cursor_blink');
 * // adj.suppress === true, adj.alternative === 'static_indicator'
 * ```
 */
export class ReducedMotionManager {
  private preference: MotionPreference;

  constructor(preference: MotionPreference = 'no-preference') {
    this.preference = MotionPreferenceSchema.parse(preference);
  }

  /**
   * Updates the motion preference (e.g., when media query changes).
   */
  setPreference(preference: MotionPreference): void {
    this.preference = MotionPreferenceSchema.parse(preference);
  }

  /**
   * Returns the current motion preference.
   */
  getPreference(): MotionPreference {
    return this.preference;
  }

  /**
   * Whether reduced motion is currently active.
   */
  isReduced(): boolean {
    return this.preference === 'reduce';
  }

  /**
   * Gets the motion adjustment for a given category.
   * When reduced motion is active, returns the suppression rule.
   * When not active, permits all motion.
   */
  getAdjustment(category: MotionCategory): MotionAdjustment {
    if (!this.isReduced()) {
      return NO_REDUCTION;
    }
    return REDUCED_MOTION_RULES[category];
  }

  /**
   * Returns all adjustments for all categories at the current preference.
   */
  getAllAdjustments(): Record<MotionCategory, MotionAdjustment> {
    if (!this.isReduced()) {
      const result: Record<string, MotionAdjustment> = {};
      for (const category of MotionCategorySchema.options) {
        result[category] = NO_REDUCTION;
      }
      return result as Record<MotionCategory, MotionAdjustment>;
    }
    return { ...REDUCED_MOTION_RULES };
  }

  /**
   * Determines the scroll behavior based on motion preference.
   * Returns 'auto' for instant scroll when reduced, 'smooth' otherwise.
   *
   * Requirements: 36.9
   */
  getScrollBehavior(): 'auto' | 'smooth' {
    return this.isReduced() ? 'auto' : 'smooth';
  }

  /**
   * Returns the CSS transition duration to apply.
   * 0ms when reduced, the provided value otherwise.
   */
  getTransitionDuration(normalDurationMs: number): number {
    return this.isReduced() ? 0 : normalDurationMs;
  }
}
