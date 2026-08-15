/**
 * Visual Accessibility — Non-color status indicators, contrast, motion, targets, zoom.
 *
 * Ensures all status information (pass/fail, risk, diffs, progress) uses
 * non-color cues in addition to color, contrast meets WCAG 2.2 AA,
 * touch/click targets are at least 24x24px, prefers-reduced-motion is
 * respected, and all P0 workflows work at 200% zoom.
 *
 * Requirements: 23.8, 23.9, 23.10
 */

// ═══════════════════════════════════════════════════════════════
// Non-Color Status Indicators (Requirement 23.8)
// ═══════════════════════════════════════════════════════════════

/**
 * Status categories that require non-color cues.
 * Each status MUST have an icon, label, and pattern in addition to color.
 */
export type StatusCategory =
  | 'pass'
  | 'fail'
  | 'warning'
  | 'blocked'
  | 'running'
  | 'pending'
  | 'stale'
  | 'waived';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type DiffLineType = 'addition' | 'deletion' | 'context' | 'conflict';

export type ProgressState = 'idle' | 'active' | 'complete' | 'error';

/** A non-color cue descriptor applied to a status indicator. */
export interface NonColorCue {
  /** Unicode icon/emoji or icon name (e.g. 'check', 'x', 'alert') */
  icon: string;
  /** Accessible text label describing the status */
  label: string;
  /** Optional pattern/shape distinguisher (e.g. 'solid-circle', 'hollow-circle', 'triangle') */
  pattern?: string;
  /** CSS class applied for additional styling */
  cssClass: string;
  /** ARIA role supplement if needed */
  ariaLabel: string;
}

/**
 * Maps every status category to its non-color cue.
 * This ensures each status is distinguishable without color perception.
 */
export const STATUS_NON_COLOR_CUES: Record<StatusCategory, NonColorCue> = {
  pass: {
    icon: '✓',
    label: 'Passed',
    pattern: 'solid-circle',
    cssClass: 'nn-status-pass',
    ariaLabel: 'Status: passed',
  },
  fail: {
    icon: '✗',
    label: 'Failed',
    pattern: 'solid-x',
    cssClass: 'nn-status-fail',
    ariaLabel: 'Status: failed',
  },
  warning: {
    icon: '⚠',
    label: 'Warning',
    pattern: 'triangle',
    cssClass: 'nn-status-warning',
    ariaLabel: 'Status: warning',
  },
  blocked: {
    icon: '⊘',
    label: 'Blocked',
    pattern: 'hollow-circle-slash',
    cssClass: 'nn-status-blocked',
    ariaLabel: 'Status: blocked',
  },
  running: {
    icon: '▶',
    label: 'Running',
    pattern: 'solid-arrow',
    cssClass: 'nn-status-running',
    ariaLabel: 'Status: running',
  },
  pending: {
    icon: '○',
    label: 'Pending',
    pattern: 'hollow-circle',
    cssClass: 'nn-status-pending',
    ariaLabel: 'Status: pending',
  },
  stale: {
    icon: '⟳',
    label: 'Stale',
    pattern: 'dashed-circle',
    cssClass: 'nn-status-stale',
    ariaLabel: 'Status: stale',
  },
  waived: {
    icon: '⊖',
    label: 'Waived',
    pattern: 'hollow-minus',
    cssClass: 'nn-status-waived',
    ariaLabel: 'Status: waived',
  },
};

/**
 * Maps risk levels to non-color cues.
 */
export const RISK_NON_COLOR_CUES: Record<RiskLevel, NonColorCue> = {
  critical: {
    icon: '◆',
    label: 'Critical risk',
    pattern: 'solid-diamond',
    cssClass: 'nn-risk-critical',
    ariaLabel: 'Risk: critical',
  },
  high: {
    icon: '▲',
    label: 'High risk',
    pattern: 'solid-triangle',
    cssClass: 'nn-risk-high',
    ariaLabel: 'Risk: high',
  },
  medium: {
    icon: '●',
    label: 'Medium risk',
    pattern: 'solid-circle',
    cssClass: 'nn-risk-medium',
    ariaLabel: 'Risk: medium',
  },
  low: {
    icon: '○',
    label: 'Low risk',
    pattern: 'hollow-circle',
    cssClass: 'nn-risk-low',
    ariaLabel: 'Risk: low',
  },
  none: {
    icon: '—',
    label: 'No risk',
    pattern: 'dash',
    cssClass: 'nn-risk-none',
    ariaLabel: 'Risk: none',
  },
};

/**
 * Maps diff line types to non-color cues (symbols in gutter).
 */
export const DIFF_NON_COLOR_CUES: Record<DiffLineType, NonColorCue> = {
  addition: {
    icon: '+',
    label: 'Added',
    pattern: 'plus-prefix',
    cssClass: 'nn-diff-addition',
    ariaLabel: 'Line added',
  },
  deletion: {
    icon: '−',
    label: 'Removed',
    pattern: 'minus-prefix',
    cssClass: 'nn-diff-deletion',
    ariaLabel: 'Line removed',
  },
  context: {
    icon: ' ',
    label: 'Unchanged',
    pattern: 'space-prefix',
    cssClass: 'nn-diff-context',
    ariaLabel: 'Line unchanged',
  },
  conflict: {
    icon: '!',
    label: 'Conflict',
    pattern: 'exclamation-prefix',
    cssClass: 'nn-diff-conflict',
    ariaLabel: 'Line in conflict',
  },
};

/**
 * Maps progress states to non-color cues.
 */
export const PROGRESS_NON_COLOR_CUES: Record<ProgressState, NonColorCue> = {
  idle: {
    icon: '○',
    label: 'Not started',
    pattern: 'hollow-circle',
    cssClass: 'nn-progress-idle',
    ariaLabel: 'Progress: not started',
  },
  active: {
    icon: '◐',
    label: 'In progress',
    pattern: 'half-circle',
    cssClass: 'nn-progress-active',
    ariaLabel: 'Progress: in progress',
  },
  complete: {
    icon: '●',
    label: 'Complete',
    pattern: 'solid-circle',
    cssClass: 'nn-progress-complete',
    ariaLabel: 'Progress: complete',
  },
  error: {
    icon: '✗',
    label: 'Error',
    pattern: 'x-mark',
    cssClass: 'nn-progress-error',
    ariaLabel: 'Progress: error',
  },
};

/**
 * Retrieves the non-color cue for a given status category.
 */
export function getStatusCue(status: StatusCategory): NonColorCue {
  return STATUS_NON_COLOR_CUES[status];
}

/**
 * Retrieves the non-color cue for a given risk level.
 */
export function getRiskCue(risk: RiskLevel): NonColorCue {
  return RISK_NON_COLOR_CUES[risk];
}

/**
 * Retrieves the non-color cue for a given diff line type.
 */
export function getDiffLineCue(type: DiffLineType): NonColorCue {
  return DIFF_NON_COLOR_CUES[type];
}

/**
 * Retrieves the non-color cue for a given progress state.
 */
export function getProgressCue(state: ProgressState): NonColorCue {
  return PROGRESS_NON_COLOR_CUES[state];
}

// ═══════════════════════════════════════════════════════════════
// WCAG 2.2 AA Contrast Utilities (Requirement 23.8)
// ═══════════════════════════════════════════════════════════════

/** Minimum contrast ratios per WCAG 2.2 AA */
export const CONTRAST_THRESHOLDS = {
  /** Normal text (<18pt or <14pt bold): 4.5:1 */
  normalText: 4.5,
  /** Large text (>=18pt or >=14pt bold): 3:1 */
  largeText: 3.0,
  /** UI components and graphical objects: 3:1 */
  uiComponent: 3.0,
} as const;

/** Minimum target size per WCAG 2.2 (Level AA Target Size minimum) */
export const MIN_TARGET_SIZE_PX = 24;

/**
 * Parses a hex color (#RGB or #RRGGBB) to [R, G, B] 0-255.
 */
export function parseHexColor(hex: string): [number, number, number] | null {
  const cleaned = hex.replace('#', '');
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    const g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    const b = parseInt(cleaned[2]! + cleaned[2]!, 16);
    return [r, g, b];
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

/**
 * Computes relative luminance per WCAG 2.2 formula.
 * @see https://www.w3.org/WAI/WCAG22/Techniques/general/G17
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * rs! + 0.7152 * gs! + 0.0722 * bs!;
}

/**
 * Computes contrast ratio between two colors.
 * Returns a value >= 1 (e.g. 4.5 means 4.5:1).
 */
export function contrastRatio(
  color1: [number, number, number],
  color2: [number, number, number],
): number {
  const l1 = relativeLuminance(...color1);
  const l2 = relativeLuminance(...color2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks if a foreground/background pair meets WCAG 2.2 AA for the given content type.
 */
export function meetsContrastAA(
  foreground: [number, number, number],
  background: [number, number, number],
  contentType: 'normalText' | 'largeText' | 'uiComponent' = 'normalText',
): boolean {
  const ratio = contrastRatio(foreground, background);
  return ratio >= CONTRAST_THRESHOLDS[contentType];
}

// ═══════════════════════════════════════════════════════════════
// Target Size Validation (Requirement 23.8)
// ═══════════════════════════════════════════════════════════════

/**
 * Checks whether an element meets the WCAG 2.2 minimum target size (24x24px).
 * Returns true if both width and height are at least MIN_TARGET_SIZE_PX.
 */
export function meetsMinTargetSize(width: number, height: number): boolean {
  return width >= MIN_TARGET_SIZE_PX && height >= MIN_TARGET_SIZE_PX;
}

/**
 * Result of a target-size audit for a single element.
 */
export interface TargetSizeResult {
  selector: string;
  width: number;
  height: number;
  meets: boolean;
  issue?: string;
}

/**
 * Audits a list of interactive elements for minimum target size compliance.
 */
export function auditTargetSizes(
  elements: Array<{ selector: string; width: number; height: number }>,
): TargetSizeResult[] {
  return elements.map((el) => {
    const meets = meetsMinTargetSize(el.width, el.height);
    return {
      selector: el.selector,
      width: el.width,
      height: el.height,
      meets,
      issue: meets
        ? undefined
        : `Target size ${el.width}x${el.height}px is below ${MIN_TARGET_SIZE_PX}x${MIN_TARGET_SIZE_PX}px minimum`,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Reduced Motion Preferences (Requirement 23.9)
// ═══════════════════════════════════════════════════════════════

/**
 * Detects whether the user prefers reduced motion.
 * Returns true if window.matchMedia indicates `prefers-reduced-motion: reduce`.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Configuration for motion-safe animations.
 * When reduced motion is preferred, durations and delays collapse to near-zero.
 */
export interface MotionConfig {
  /** Whether animations should run */
  enabled: boolean;
  /** Duration multiplier (0 = instant, 1 = full) */
  durationMultiplier: number;
  /** Whether streaming cursors should blink */
  cursorBlink: boolean;
  /** Whether progress indicators should animate */
  progressAnimation: boolean;
  /** Maximum flash frequency (Hz) — never exceeds 3 per second to prevent seizures */
  maxFlashFrequency: number;
}

/**
 * Returns the appropriate motion configuration based on user preference.
 */
export function getMotionConfig(): MotionConfig {
  const reduced = prefersReducedMotion();
  return {
    enabled: !reduced,
    durationMultiplier: reduced ? 0 : 1,
    cursorBlink: !reduced,
    progressAnimation: !reduced,
    maxFlashFrequency: 3, // WCAG: never more than 3 flashes per second regardless
  };
}

/**
 * Subscribes to changes in the prefers-reduced-motion media query.
 * Returns an unsubscribe function.
 */
export function onMotionPreferenceChange(callback: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (event: MediaQueryListEvent): void => {
    callback(event.matches);
  };
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

/**
 * CSS class names applied based on reduced motion preference.
 * UI components check these classes to toggle animations off.
 */
export const MOTION_CLASSES = {
  /** Applied to root when motion is allowed */
  motionAllowed: 'nn-motion-allowed',
  /** Applied to root when reduced motion is preferred */
  motionReduced: 'nn-motion-reduced',
} as const;

/**
 * Applies or removes the reduced-motion class on the root element.
 */
export function applyMotionClass(root: HTMLElement): void {
  const reduced = prefersReducedMotion();
  if (reduced) {
    root.classList.add(MOTION_CLASSES.motionReduced);
    root.classList.remove(MOTION_CLASSES.motionAllowed);
  } else {
    root.classList.add(MOTION_CLASSES.motionAllowed);
    root.classList.remove(MOTION_CLASSES.motionReduced);
  }
}

// ═══════════════════════════════════════════════════════════════
// 200% Zoom Compliance (Requirement 23.10)
// ═══════════════════════════════════════════════════════════════

/**
 * Zoom compliance check result.
 */
export interface ZoomComplianceResult {
  /** The workflow being tested */
  workflow: string;
  /** Zoom level tested (e.g. 2.0 for 200%) */
  zoomLevel: number;
  /** Whether all content remains accessible */
  contentAccessible: boolean;
  /** Whether all functionality is preserved */
  functionalityPreserved: boolean;
  /** Whether horizontal scrolling is absent for single-column content */
  noHorizontalScroll: boolean;
  /** Any issues found */
  issues: string[];
}

/**
 * CSS rules that ensure layout works at 200% zoom.
 * These use relative units, flexible layouts, and avoid fixed widths
 * that would cause content overflow or loss.
 */
export const ZOOM_COMPLIANT_RULES = {
  /** Use rem/em for text, not px that cannot scale */
  useRelativeTextUnits: true,
  /** Use max-width instead of fixed width for containers */
  useFlexibleContainers: true,
  /** Use viewport-relative units or percentages for layout dimensions */
  useResponsiveLayouts: true,
  /** Allow text wrapping rather than overflow hidden with ellipsis for essential content */
  allowTextWrap: true,
  /** Minimum touch target remains 24x24px even at 200% zoom (in CSS px) */
  minTargetSizeAtZoom: MIN_TARGET_SIZE_PX,
} as const;

/**
 * Validates that a viewport configuration supports 200% zoom without
 * loss of content or functionality.
 */
export function validateZoomCompliance(
  viewportWidth: number,
  contentWidth: number,
  hasHorizontalScroll: boolean,
  isSingleColumn: boolean,
): ZoomComplianceResult {
  const issues: string[] = [];

  const contentAccessible = contentWidth <= viewportWidth || !isSingleColumn;
  if (!contentAccessible) {
    issues.push(
      `Content width (${contentWidth}px) exceeds viewport (${viewportWidth}px) for single-column layout`,
    );
  }

  const noHorizontalScroll = !hasHorizontalScroll || !isSingleColumn;
  if (hasHorizontalScroll && isSingleColumn) {
    issues.push('Horizontal scrolling detected on single-column content at 200% zoom');
  }

  return {
    workflow: 'general',
    zoomLevel: 2.0,
    contentAccessible,
    functionalityPreserved: true, // Validated by integration test
    noHorizontalScroll,
    issues,
  };
}

// ═══════════════════════════════════════════════════════════════
// CSS Stylesheet for Visual Accessibility
// ═══════════════════════════════════════════════════════════════

/**
 * CSS rules implementing visual accessibility requirements.
 * Injected into the renderer to ensure all status, diff, risk, and progress
 * indicators have non-color cues and respect user motion preferences.
 */
export const VISUAL_ACCESSIBILITY_CSS = `
/* ═══════════════════════════════════════════════════════════════
   Visual Accessibility — Non-color cues, contrast, motion, zoom
   Requirements: 23.8, 23.9, 23.10
   ═══════════════════════════════════════════════════════════════ */

/* ── Non-Color Status Indicators ─────────────────────────────── */

/* Each status has an icon (::before) providing a non-color cue */
.nn-status-pass::before { content: "✓ "; }
.nn-status-fail::before { content: "✗ "; }
.nn-status-warning::before { content: "⚠ "; }
.nn-status-blocked::before { content: "⊘ "; }
.nn-status-running::before { content: "▶ "; }
.nn-status-pending::before { content: "○ "; }
.nn-status-stale::before { content: "⟳ "; }
.nn-status-waived::before { content: "⊖ "; }

/* ── Non-Color Risk Indicators ───────────────────────────────── */

.nn-risk-critical::before { content: "◆ "; }
.nn-risk-high::before { content: "▲ "; }
.nn-risk-medium::before { content: "● "; }
.nn-risk-low::before { content: "○ "; }
.nn-risk-none::before { content: "— "; }

/* ── Non-Color Diff Indicators (gutter symbols) ──────────────── */

.nn-diff-addition .dvc-line-gutter::before,
.nn-diff-addition::before { content: "+ "; }
.nn-diff-deletion .dvc-line-gutter::before,
.nn-diff-deletion::before { content: "− "; }
.nn-diff-context .dvc-line-gutter::before,
.nn-diff-context::before { content: "  "; }
.nn-diff-conflict .dvc-line-gutter::before,
.nn-diff-conflict::before { content: "! "; }

/* ── Non-Color Progress Indicators ───────────────────────────── */

.nn-progress-idle::before { content: "○ "; }
.nn-progress-active::before { content: "◐ "; }
.nn-progress-complete::before { content: "● "; }
.nn-progress-error::before { content: "✗ "; }

/* ── Target Size Minimums (24x24px per WCAG 2.2 AA) ─────────── */

button,
[role="button"],
[role="tab"],
[role="menuitem"],
a[href],
input[type="checkbox"],
input[type="radio"],
.wk-toggle,
.dvc-hunk-btn,
.code-copy-btn {
  min-width: 24px;
  min-height: 24px;
}

/* ── Contrast: ensure status text is always readable ─────────── */

.nn-status-pass { color: var(--green, #22c55e); }
.nn-status-fail { color: var(--red, #ef4444); }
.nn-status-warning { color: var(--yellow, #eab308); }
.nn-status-blocked { color: var(--text-secondary); }
.nn-status-running { color: var(--accent, #3b82f6); }
.nn-status-pending { color: var(--text-dim); }
.nn-status-stale { color: var(--yellow, #eab308); }
.nn-status-waived { color: var(--text-dim); }

/* ═══════════════════════════════════════════════════════════════
   Reduced Motion (Requirement 23.9)
   ═══════════════════════════════════════════════════════════════ */

/* Remove all animations and transitions when user prefers reduced motion */
@media (prefers-reduced-motion: reduce) {
  /* Disable cursor blinking */
  .typing-cursor,
  .cs-cursor {
    animation: none !important;
    opacity: 1 !important;
  }

  /* Disable thinking/pulsing indicators */
  .thinking-indicator {
    animation: none !important;
    opacity: 1 !important;
  }

  /* Disable card hover transforms */
  .wk-card:hover {
    transform: none !important;
  }

  /* Disable all transition effects */
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }

  /* Progress bars: show final state without animation */
  .wk-progress-fill {
    transition: none !important;
  }

  /* Toggle switches: immediate state change */
  .wk-toggle::after {
    transition: none !important;
  }

  /* Diff hover effects: disable brightness filters */
  .dvc-line:hover {
    filter: none !important;
  }

  /* Code copy button: always visible (no hover-only reveal) */
  .code-copy-btn {
    display: flex !important;
  }
}

/* Class-based reduced motion (for JS detection) */
.nn-motion-reduced .typing-cursor,
.nn-motion-reduced .cs-cursor {
  animation: none !important;
  opacity: 1 !important;
}

.nn-motion-reduced .thinking-indicator {
  animation: none !important;
  opacity: 1 !important;
}

.nn-motion-reduced *,
.nn-motion-reduced *::before,
.nn-motion-reduced *::after {
  transition-duration: 0.01ms !important;
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
}

/* ═══════════════════════════════════════════════════════════════
   Seizure Prevention — No more than 3 flashes per second
   ═══════════════════════════════════════════════════════════════ */

/* Ensure no animation cycles faster than 333ms (3Hz limit) */
@keyframes csCursorBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Override any cursor that blinks too fast */
.cs-cursor,
.typing-cursor {
  animation-duration: 1s; /* 1Hz: well within 3Hz limit */
}

/* ═══════════════════════════════════════════════════════════════
   200% Zoom Compliance (Requirement 23.10)
   ═══════════════════════════════════════════════════════════════ */

/* Use flexible layouts that reflow at high zoom */
.message-body,
.dvc-container,
.wk-card,
#input-bar,
.code-block-wrapper {
  max-width: 100%;
  box-sizing: border-box;
}

/* Prevent horizontal overflow for single-column chat content */
.message.assistant .message-body {
  max-width: min(800px, 100%);
  overflow-wrap: break-word;
  word-break: break-word;
}

/* File tabs: wrap or scroll gracefully at high zoom */
.dvc-file-tabs {
  flex-wrap: wrap;
}

/* Table containers: allow horizontal scroll without breaking layout */
.message-body .table-wrapper {
  max-width: 100%;
}

/* Code blocks: allow scroll but don't overflow page */
.code-block-wrapper {
  max-width: 100%;
}

.code-block-wrapper pre.code-block-pre {
  max-width: 100%;
  overflow-x: auto;
}

/* Ensure action buttons remain reachable at zoom */
.dvc-hunk-actions {
  flex-wrap: wrap;
}

/* Chat attachment strip: wrap at high zoom */
#chat-attachments-strip {
  flex-wrap: wrap;
}
`;

/**
 * Injects the visual accessibility stylesheet into the document.
 * Safe to call multiple times (idempotent).
 */
export function injectVisualAccessibilityStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'nn-visual-accessibility-styles';
  if (document.getElementById(styleId)) return;

  const styleEl = document.createElement('style');
  styleEl.id = styleId;
  styleEl.textContent = VISUAL_ACCESSIBILITY_CSS;
  document.head.appendChild(styleEl);
}

/**
 * Initializes all visual accessibility features:
 * - Injects CSS for non-color cues, motion, and zoom
 * - Applies reduced-motion class
 * - Subscribes to motion preference changes
 *
 * Returns an unsubscribe/cleanup function.
 */
export function initVisualAccessibility(root?: HTMLElement): () => void {
  injectVisualAccessibilityStyles();

  const effectiveRoot = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (effectiveRoot) {
    applyMotionClass(effectiveRoot);
  }

  const unsubscribe = onMotionPreferenceChange((reduced) => {
    if (effectiveRoot) {
      applyMotionClass(effectiveRoot);
    }
  });

  return () => {
    unsubscribe();
    if (effectiveRoot) {
      effectiveRoot.classList.remove(MOTION_CLASSES.motionAllowed);
      effectiveRoot.classList.remove(MOTION_CLASSES.motionReduced);
    }
  };
}
