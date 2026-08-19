/**
 * Reduced Motion Integration — Structured Response Renderer
 *
 * Integrates the harness ReducedMotionManager with the structured chat shell and
 * response surfaces. When prefers-reduced-motion is active:
 * - Removes shimmer, animated gradients, smooth scrolling, blinking cursors,
 *   pulsing, and nonessential transforms
 * - Preserves equivalent state text and icons
 * - Ensures immediate control access without animation delay
 *
 * Requirements: 4.9, 17.5–17.7, 18.1, 22.5
 *
 * @vitest-environment jsdom
 */

import {
  ReducedMotionManager,
  type MotionPreference,
  type MotionCategory,
  type MotionAdjustment,
} from '../../harness/presentation/accessibility/reduced-motion';

// ─── CSS Class Constants ────────────────────────────────────────

export const REDUCED_MOTION_CLASS = 'nn-reduced-motion';
export const MOTION_SHIMMER_CLASS = 'nn-motion-shimmer';
export const MOTION_PULSE_CLASS = 'nn-motion-pulse';
export const MOTION_GRADIENT_CLASS = 'nn-motion-gradient';
export const MOTION_CURSOR_BLINK_CLASS = 'nn-motion-cursor-blink';
export const MOTION_SMOOTH_SCROLL_CLASS = 'nn-motion-smooth-scroll';
export const MOTION_TRANSFORM_CLASS = 'nn-motion-transform';
export const MOTION_ENTRANCE_CLASS = 'nn-motion-entrance';
export const STATIC_INDICATOR_CLASS = 'nn-static-indicator';
export const TEXT_STATE_CLASS = 'nn-text-state';

/**
 * CSS classes that represent motion categories that must be
 * suppressed under reduced motion.
 */
export const MOTION_CLASSES: ReadonlyArray<string> = [
  MOTION_SHIMMER_CLASS,
  MOTION_PULSE_CLASS,
  MOTION_GRADIENT_CLASS,
  MOTION_CURSOR_BLINK_CLASS,
  MOTION_SMOOTH_SCROLL_CLASS,
  MOTION_TRANSFORM_CLASS,
  MOTION_ENTRANCE_CLASS,
];

// ─── Motion CSS category mapping ────────────────────────────────

/**
 * Maps CSS class names to MotionCategory values for adjustment lookup.
 */
export const CLASS_TO_CATEGORY: ReadonlyMap<string, MotionCategory> = new Map([
  [MOTION_SHIMMER_CLASS, 'loading_spinner'],
  [MOTION_PULSE_CLASS, 'progress_animation'],
  [MOTION_GRADIENT_CLASS, 'transition'],
  [MOTION_CURSOR_BLINK_CLASS, 'cursor_blink'],
  [MOTION_SMOOTH_SCROLL_CLASS, 'smooth_scroll'],
  [MOTION_TRANSFORM_CLASS, 'transition'],
  [MOTION_ENTRANCE_CLASS, 'entrance_animation'],
]);

// ─── Types ──────────────────────────────────────────────────────

export interface ReducedMotionIntegrationOptions {
  /** The root element to apply reduced-motion class to */
  readonly rootElement: HTMLElement;
  /** Initial motion preference, defaults to OS/browser preference */
  readonly initialPreference?: MotionPreference;
  /** Optional callback when preference changes */
  readonly onPreferenceChange?: (preference: MotionPreference) => void;
}

export interface ReducedMotionIntegrationHandle {
  /** The underlying ReducedMotionManager instance */
  readonly manager: ReducedMotionManager;
  /** Whether reduced motion is currently active */
  readonly isReduced: boolean;
  /** Apply motion suppression to a specific element */
  applyToElement(element: HTMLElement): void;
  /** Get scroll behavior based on current preference */
  getScrollBehavior(): ScrollBehavior;
  /** Get transition duration (0 if reduced) */
  getTransitionDuration(normalMs: number): number;
  /** Update preference programmatically (e.g., from settings change) */
  setPreference(preference: MotionPreference): void;
  /** Remove all motion suppression and cleanup listeners */
  dispose(): void;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Detects the OS/browser motion preference via media query.
 */
export function detectMotionPreference(): MotionPreference {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'no-preference';
  }
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  return mql.matches ? 'reduce' : 'no-preference';
}

/**
 * Applies or removes the reduced-motion root class and inline style overrides
 * on a root element.
 */
function applyRootMotionState(root: HTMLElement, reduced: boolean): void {
  if (reduced) {
    root.classList.add(REDUCED_MOTION_CLASS);
    // Override CSS custom properties for motion suppression
    root.style.setProperty('--nn-transition-duration', '0ms');
    root.style.setProperty('--nn-animation-duration', '0ms');
    root.style.setProperty('--nn-scroll-behavior', 'auto');
  } else {
    root.classList.remove(REDUCED_MOTION_CLASS);
    root.style.removeProperty('--nn-transition-duration');
    root.style.removeProperty('--nn-animation-duration');
    root.style.removeProperty('--nn-scroll-behavior');
  }
}

/**
 * Suppresses motion on a single element by replacing motion classes
 * with static alternatives when reduced motion is active.
 */
function suppressElementMotion(element: HTMLElement, manager: ReducedMotionManager): void {
  if (!manager.isReduced()) return;

  for (const motionClass of MOTION_CLASSES) {
    if (element.classList.contains(motionClass)) {
      const category = CLASS_TO_CATEGORY.get(motionClass);
      if (!category) continue;

      const adjustment = manager.getAdjustment(category);
      if (adjustment.suppress) {
        element.classList.remove(motionClass);

        // Apply appropriate alternative
        switch (adjustment.alternative) {
          case 'static_indicator':
            element.classList.add(STATIC_INDICATOR_CLASS);
            break;
          case 'text_label':
            element.classList.add(TEXT_STATE_CLASS);
            break;
          case 'icon_change':
            element.classList.add(STATIC_INDICATOR_CLASS);
            break;
          case 'none':
            // No visual replacement needed — content appears instantly
            break;
        }

        // Set aria description for the alternative if provided
        if (adjustment.alternativeDescription) {
          element.setAttribute('aria-label', adjustment.alternativeDescription);
        }
      }
    }
  }

  // Remove inline animation/transition styles
  element.style.removeProperty('animation');
  element.style.removeProperty('transition');
  element.style.setProperty('animation-duration', '0ms');
  element.style.setProperty('transition-duration', '0ms');
}

/**
 * Creates the reduced-motion integration for the structured response renderer.
 *
 * Listens for OS preference changes and applies motion suppression to the
 * shell root element and any elements passed through `applyToElement`.
 */
export function createReducedMotionIntegration(
  options: ReducedMotionIntegrationOptions,
): ReducedMotionIntegrationHandle {
  const { rootElement, onPreferenceChange } = options;
  const initialPref = options.initialPreference ?? detectMotionPreference();
  const manager = new ReducedMotionManager(initialPref);

  // Apply initial state
  applyRootMotionState(rootElement, manager.isReduced());

  // Listen for OS media query changes
  let mediaQueryList: MediaQueryList | null = null;
  let mediaQueryHandler: ((e: MediaQueryListEvent) => void) | null = null;

  if (typeof window !== 'undefined' && window.matchMedia) {
    mediaQueryList = window.matchMedia('(prefers-reduced-motion: reduce)');
    mediaQueryHandler = (e: MediaQueryListEvent) => {
      const newPref: MotionPreference = e.matches ? 'reduce' : 'no-preference';
      manager.setPreference(newPref);
      applyRootMotionState(rootElement, manager.isReduced());
      onPreferenceChange?.(newPref);
    };
    mediaQueryList.addEventListener('change', mediaQueryHandler);
  }

  let disposed = false;

  return Object.freeze({
    get manager() {
      return manager;
    },
    get isReduced() {
      return manager.isReduced();
    },
    applyToElement(element: HTMLElement) {
      if (disposed) return;
      suppressElementMotion(element, manager);
    },
    getScrollBehavior(): ScrollBehavior {
      return manager.getScrollBehavior();
    },
    getTransitionDuration(normalMs: number): number {
      return manager.getTransitionDuration(normalMs);
    },
    setPreference(preference: MotionPreference) {
      if (disposed) return;
      manager.setPreference(preference);
      applyRootMotionState(rootElement, manager.isReduced());
      onPreferenceChange?.(preference);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (mediaQueryList && mediaQueryHandler) {
        mediaQueryList.removeEventListener('change', mediaQueryHandler);
      }
      // Clean up root state
      rootElement.classList.remove(REDUCED_MOTION_CLASS);
      rootElement.style.removeProperty('--nn-transition-duration');
      rootElement.style.removeProperty('--nn-animation-duration');
      rootElement.style.removeProperty('--nn-scroll-behavior');
    },
  });
}
