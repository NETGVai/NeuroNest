/**
 * Accessibility contract for required experience surfaces
 * (FUT-PKG-07-EXPERIENCE/T-007, FIX-RENDERER-A11Y-01).
 *
 * NN-INV-013 requires that every required workflow is keyboard-operable,
 * semantically labeled, focus-safe, non-color-dependent, reduced-motion-aware,
 * localized, and functional at 200% scaling. NN-UI-011 makes those concrete:
 * contrast 4.5:1 for normal text and 3:1 for large text/controls, semantic
 * roles/names, deterministic focus restore/fallback, modal containment,
 * keyboard parity, reduced motion, non-color cues, localization, and 200%
 * scaling — and a CRITICAL failure BLOCKS release (NN-VERIFY-005 "focus loss in
 * required workflows"; NN-UI-011 "critical failures block release").
 *
 * This module is a headless, DOM-free ACCESSIBILITY CONTRACT — the same shape
 * as the shared approval-card contract (src/approval/approval-card.ts). It
 * computes/verifies the accessible model (roles, names, status, focus order,
 * focus containment/restore, contrast, non-color signaling, reduced motion,
 * 200% scaling) so the renderer builds a correct surface and the contract is
 * unit-/property-testable WITHOUT a browser. It does NOT replace manual
 * assistive-technology testing: full WCAG conformance still requires a screen
 * reader / AT sweep and expert review — the checks here are the machine-checkable
 * FLOOR that must pass before release, never the whole of WCAG.
 *
 * A verification that reports any problem is a FAILING check: `verifySurface`
 * returns the list of violations and `hasCriticalFinding`/`assertAccessible`
 * make a critical finding a hard, visible failure that a P6 gate can block on.
 *
 * Design anchors: D-10 (chat projection), D-12 (workbench/editor), D-13 (file
 * tree / task surfaces), D-14 (renderer islands), D-16 (approvals/notifications),
 * D-22 (verification). Requirements: NN-INV-013, NN-UI-002/011/012/015,
 * NN-VERIFY-005.
 */

// ─── Severity ─────────────────────────────────────────────────────────────

/**
 * Every accessibility finding carries a severity. A `critical` finding is a
 * release blocker (NN-UI-011 "critical failures block release", NN-VERIFY-005):
 * broken keyboard operation, focus loss, a missing semantic role/name, a
 * contrast ratio below the required floor, or a color-only signal. An `advisory`
 * finding is a non-blocking recommendation.
 */
export type FindingSeverity = 'critical' | 'advisory';

/** One machine-checkable accessibility finding on a surface. */
export interface AccessibilityFinding {
  /** Stable code so a gate can classify/aggregate findings. */
  readonly code: string;
  readonly severity: FindingSeverity;
  /** A short, secret-free human-readable description of the problem. */
  readonly message: string;
  /** The element/region the finding is about (for navigation), if known. */
  readonly target?: string;
}

// ─── Contrast (NN-UI-011: 4.5:1 normal, 3:1 large text/controls) ────────────

/**
 * WCAG 2.x minimum contrast ratios (NN-UI-011). Normal text must reach 4.5:1;
 * large text and non-text UI components (controls, focus indicators) must reach
 * 3:1. These are the exact floors the automated check enforces.
 */
export const CONTRAST_FLOORS = Object.freeze({
  normalText: 4.5,
  largeTextOrControl: 3.0,
});

/** An sRGB color as 0..255 channels (DOM-free — the renderer maps to CSS). */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function channelToLinear(c8: number): number {
  const c = Math.min(255, Math.max(0, c8)) / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance of an sRGB color per WCAG 2.x (0 = black … 1 = white).
 */
export function relativeLuminance(rgb: Rgb): number {
  const r = channelToLinear(rgb.r);
  const g = channelToLinear(rgb.g);
  const b = channelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two sRGB colors per WCAG 2.x. The result is in the
 * closed range [1, 21] and is SYMMETRIC in its arguments — order does not matter
 * (property: contrastRatio(a,b) === contrastRatio(b,a)).
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * True when `foreground` on `background` meets the required floor. `large` is
 * true for large text (≥ 18.66px bold or ≥ 24px) and non-text UI components,
 * which use the 3:1 floor; normal text uses 4.5:1 (NN-UI-011).
 */
export function meetsContrast(foreground: Rgb, background: Rgb, large: boolean): boolean {
  const floor = large ? CONTRAST_FLOORS.largeTextOrControl : CONTRAST_FLOORS.normalText;
  // Round to two decimals so a value like 4.4999 does not spuriously pass; a
  // ratio must genuinely reach the floor.
  return Math.round(contrastRatio(foreground, background) * 100) / 100 >= floor;
}

// ─── Surface accessibility model ────────────────────────────────────────────

/** A focusable element within a surface (control, link, field, tab, etc.). */
export interface FocusableModel {
  readonly id: string;
  /** Semantic ARIA role. Must be present and non-empty (NN-UI-011). */
  readonly role: string;
  /** Accessible name announced by AT. Must be present and non-empty. */
  readonly accessibleName: string;
  /** 0-based keyboard focus order. Must form a gap-free 0..n-1 sequence. */
  readonly focusOrder: number;
  /** Whether the element is reachable/operable by keyboard (NN-UI-011). */
  readonly keyboardOperable: boolean;
  /** Foreground/background colors for the contrast check, if this paints text. */
  readonly foreground?: Rgb;
  readonly background?: Rgb;
  /** Whether this element uses large text / is a non-text control (3:1 floor). */
  readonly largeOrControl?: boolean;
}

/**
 * A status/notification region on the surface. Status must be conveyed
 * semantically (a live region + text), never by color alone (NN-UI-011
 * "non-color cues") and never assertively when polite suffices.
 */
export interface StatusRegionModel {
  readonly id: string;
  readonly role: 'status' | 'alert' | 'log';
  /** Live-region politeness. `alert` is assertive; status/log are polite. */
  readonly politeness: 'polite' | 'assertive';
  /**
   * Whether the state is signaled by something OTHER than color (icon, text,
   * shape, pattern). When false, the state is color-only — a critical finding.
   */
  readonly hasNonColorSignal: boolean;
  /** Accessible text for the status (localized upstream). */
  readonly text: string;
}

/**
 * Modal/focus containment description for the surface. When `isModal` is true
 * the focus trap must be present and a deterministic restore target must be
 * declared so focus returns predictably on close (NN-UI-011 "deterministic
 * focus restore/fallback, modal containment"; NN-VERIFY-005 "focus loss").
 */
export interface FocusContainmentModel {
  readonly isModal: boolean;
  /** Whether keyboard focus is trapped within the modal while open. */
  readonly focusTrapped: boolean;
  /** The element that receives focus when the modal opens (must be inside). */
  readonly initialFocusId: string | null;
  /** The element focus deterministically restores to on close. */
  readonly restoreFocusId: string | null;
  /**
   * A guaranteed fallback focus target (e.g. the surface root) used when the
   * prior focus owner is gone (NN-UI-011 "restore/fallback"). Must be non-null.
   */
  readonly fallbackFocusId: string | null;
}

/**
 * Motion behavior. When the user prefers reduced motion, non-essential
 * animation MUST be disabled (NN-UI-011 "reduced motion"). `respectsReducedMotion`
 * records whether the surface honors the preference for a given setting.
 */
export interface MotionModel {
  readonly prefersReducedMotion: boolean;
  /** Whether non-essential animation is disabled given the preference. */
  readonly nonEssentialAnimationDisabled: boolean;
}

/**
 * Responsive/scaling behavior at a viewport. At 200% scale the surface must
 * remain operable with a single scroll axis (no unnecessary two-dimensional
 * scrolling) and must not clip/hide required controls (NN-UI-002, NN-UI-011).
 */
export interface ScalingModel {
  readonly scalePercent: number;
  /** True when content reflows to a single scroll axis at this scale. */
  readonly singleAxisScroll: boolean;
  /** True when every required control remains reachable (not clipped/hidden). */
  readonly allControlsReachable: boolean;
}

/** The full accessible model for one required surface. */
export interface SurfaceAccessibilityModel {
  /** Stable surface id (e.g. `chat`, `workbench`, `file-tree`, `dashboard`). */
  readonly surfaceId: string;
  /** The surface container role (e.g. `region`, `main`, `dialog`). */
  readonly role: string;
  /** The surface's accessible name. Must be present and non-empty. */
  readonly accessibleName: string;
  readonly focusables: readonly FocusableModel[];
  readonly statusRegions: readonly StatusRegionModel[];
  readonly containment: FocusContainmentModel;
  readonly motion: MotionModel;
  readonly scaling: ScalingModel;
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Verify a surface satisfies the machine-checkable accessibility floor and
 * return every finding (empty = the surface passes the floor). This is the
 * automated form of FIX-RENDERER-A11Y-01. It never mutates the model and never
 * surfaces a secret. A caller decides pass/fail via {@link hasCriticalFinding}.
 *
 * Checks (each maps to NN-UI-011 / NN-INV-013):
 *   - the surface has a semantic role and a non-empty accessible name;
 *   - every focusable has a role, an accessible name, and is keyboard-operable;
 *   - focus order is a gap-free 0..n-1 sequence (deterministic keyboard nav);
 *   - painted text/controls meet the required contrast floor;
 *   - status regions carry a non-color signal and are not needlessly assertive;
 *   - a modal traps focus and declares initial + deterministic restore +
 *     guaranteed fallback focus targets (no focus loss);
 *   - reduced-motion preference disables non-essential animation;
 *   - at 200% scale the surface keeps a single scroll axis and all controls
 *     stay reachable.
 */
export function verifySurface(model: SurfaceAccessibilityModel): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  const push = (
    code: string,
    severity: FindingSeverity,
    message: string,
    target?: string,
  ): void => {
    findings.push(target === undefined ? { code, severity, message } : { code, severity, message, target });
  };

  // Surface-level semantics.
  if (model.role.trim().length === 0) {
    push('surface-missing-role', 'critical', `surface ${model.surfaceId} must declare a semantic role`, model.surfaceId);
  }
  if (model.accessibleName.trim().length === 0) {
    push('surface-missing-name', 'critical', `surface ${model.surfaceId} must have a non-empty accessible name`, model.surfaceId);
  }

  // Focusables: role, name, keyboard operability.
  for (const f of model.focusables) {
    if (f.role.trim().length === 0) {
      push('focusable-missing-role', 'critical', `focusable ${f.id} missing a semantic role`, f.id);
    }
    if (f.accessibleName.trim().length === 0) {
      push('focusable-missing-name', 'critical', `focusable ${f.id} missing an accessible name`, f.id);
    }
    if (!f.keyboardOperable) {
      push('focusable-not-keyboard-operable', 'critical', `focusable ${f.id} is not keyboard-operable`, f.id);
    }
    // Contrast, only when the element paints text/controls with declared colors.
    if (f.foreground && f.background) {
      if (!meetsContrast(f.foreground, f.background, f.largeOrControl === true)) {
        const ratio = Math.round(contrastRatio(f.foreground, f.background) * 100) / 100;
        const floor = f.largeOrControl ? CONTRAST_FLOORS.largeTextOrControl : CONTRAST_FLOORS.normalText;
        push('insufficient-contrast', 'critical', `focusable ${f.id} contrast ${ratio}:1 is below the ${floor}:1 floor`, f.id);
      }
    }
  }

  // Deterministic keyboard order: gap-free 0..n-1.
  findings.push(...verifyFocusOrder(model.focusables));

  // Status regions: non-color signaling + politeness discipline.
  for (const s of model.statusRegions) {
    if (!s.hasNonColorSignal) {
      push('color-only-status', 'critical', `status region ${s.id} conveys state by color alone`, s.id);
    }
    if (s.text.trim().length === 0) {
      push('empty-status-text', 'critical', `status region ${s.id} has no accessible text`, s.id);
    }
    // A non-alert region should be polite so it never steals focus abruptly.
    if (s.role !== 'alert' && s.politeness === 'assertive') {
      push('overly-assertive-status', 'advisory', `status region ${s.id} is assertive but is not an alert`, s.id);
    }
  }

  // Modal focus containment / deterministic restore / fallback.
  const c = model.containment;
  if (c.isModal) {
    if (!c.focusTrapped) {
      push('modal-focus-not-trapped', 'critical', `modal surface ${model.surfaceId} does not trap focus`, model.surfaceId);
    }
    if (c.initialFocusId === null) {
      push('modal-no-initial-focus', 'critical', `modal surface ${model.surfaceId} declares no initial focus target`, model.surfaceId);
    } else if (!model.focusables.some((f) => f.id === c.initialFocusId)) {
      push('modal-initial-focus-outside', 'critical', `modal initial focus ${c.initialFocusId} is not inside the surface`, c.initialFocusId);
    }
    if (c.restoreFocusId === null) {
      push('modal-no-restore-focus', 'critical', `modal surface ${model.surfaceId} declares no deterministic restore focus`, model.surfaceId);
    }
  }
  // A guaranteed fallback focus target is required for EVERY surface so focus is
  // never lost when the prior owner is gone (NN-VERIFY-005 focus loss).
  if (c.fallbackFocusId === null) {
    push('no-fallback-focus', 'critical', `surface ${model.surfaceId} declares no fallback focus target`, model.surfaceId);
  }

  // Reduced motion.
  if (model.motion.prefersReducedMotion && !model.motion.nonEssentialAnimationDisabled) {
    push('reduced-motion-ignored', 'critical', `surface ${model.surfaceId} animates despite a reduced-motion preference`, model.surfaceId);
  }

  // 200% scaling.
  if (model.scaling.scalePercent >= 200) {
    if (!model.scaling.singleAxisScroll) {
      push('two-axis-scroll-at-scale', 'critical', `surface ${model.surfaceId} forces two-dimensional scrolling at ${model.scaling.scalePercent}% scale`, model.surfaceId);
    }
    if (!model.scaling.allControlsReachable) {
      push('controls-unreachable-at-scale', 'critical', `surface ${model.surfaceId} clips/hides required controls at ${model.scaling.scalePercent}% scale`, model.surfaceId);
    }
  }

  return findings;
}

/**
 * Verify a set of focusables forms a gap-free 0..n-1 keyboard focus order.
 * Returns findings (empty = deterministic). Mirrors the approval-card
 * `verifyFocusOrder` contract so keyboard navigation is deterministic across
 * every surface (NN-UI-011 keyboard parity).
 */
export function verifyFocusOrder(focusables: readonly FocusableModel[]): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  const orders = focusables.map((f) => f.focusOrder).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      findings.push({
        code: 'focus-order-gap',
        severity: 'critical',
        message: `focus order gap or duplicate at index ${i} (got ${orders[i]})`,
      });
      break;
    }
  }
  return findings;
}

/** True when any finding is a release-blocking critical finding. */
export function hasCriticalFinding(findings: readonly AccessibilityFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

/**
 * Assert a surface is accessible at the machine-checkable floor. Throws a
 * visible error listing the critical findings when the floor is not met, so a
 * critical contrast/focus/keyboard/semantic finding BLOCKS a P6 gate rather
 * than being silently passed (NN-UI-011, NN-VERIFY-005). Advisory findings do
 * not throw.
 */
export function assertAccessible(model: SurfaceAccessibilityModel): void {
  const findings = verifySurface(model);
  const critical = findings.filter((f) => f.severity === 'critical');
  if (critical.length > 0) {
    const detail = critical.map((f) => `${f.code}: ${f.message}`).join('; ');
    throw new Error(`Accessibility floor not met for surface ${model.surfaceId}: ${detail}`);
  }
}

/**
 * The required experience surfaces that MUST each pass the accessibility floor
 * for P6 exit (chat, workbench/editor, file tree, index/search, and the
 * authority dashboards). A missing surface is itself a critical gap so a whole
 * inaccessible surface cannot silently pass (NN-INV-013, NN-UI-011).
 */
export const REQUIRED_ACCESSIBLE_SURFACES = Object.freeze([
  'chat',
  'workbench',
  'file-tree',
  'index-search',
  'dashboard',
] as const);

export type RequiredSurfaceId = (typeof REQUIRED_ACCESSIBLE_SURFACES)[number];

/**
 * Verify the full accessibility matrix: every required surface must be present
 * and must pass the floor. Returns findings keyed by surface plus a `matrix`
 * finding for any required surface that is missing entirely. This is the
 * machine-checkable core of V-UI-001/accessibility-matrix.
 */
export function verifyAccessibilityMatrix(
  surfaces: readonly SurfaceAccessibilityModel[],
): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  const present = new Set(surfaces.map((s) => s.surfaceId));
  for (const required of REQUIRED_ACCESSIBLE_SURFACES) {
    if (!present.has(required)) {
      findings.push({
        code: 'required-surface-missing',
        severity: 'critical',
        message: `required accessible surface ${required} is missing from the matrix`,
        target: required,
      });
    }
  }
  for (const s of surfaces) {
    for (const f of verifySurface(s)) {
      findings.push({ ...f, target: f.target ?? s.surfaceId });
    }
  }
  return findings;
}
