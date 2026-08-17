/**
 * Responsive Layout — Narrow/Wide Breakpoints and Scaling Support
 *
 * Provides layout mode determination with narrow/wide breakpoints,
 * preserving accessibility at 200% scaling/zoom. Intrinsically 2D content
 * (code, diff, table, diagram, terminal, image) scrolls in its own
 * labeled region rather than forcing page-level 2D scrolling.
 *
 * Requirements: 43.7–43.8, 46.1, 46.7, 46.15
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────

/**
 * Layout mode for responsive surfaces.
 */
export const LayoutModeSchema = z.enum(['narrow', 'wide']);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

/**
 * Content scroll behavior: whether a content region scrolls
 * independently (for intrinsically 2D content) or participates
 * in normal flow.
 */
export const ScrollBehaviorSchema = z.enum([
  'flow',
  'own_region',
]);
export type ScrollBehavior = z.infer<typeof ScrollBehaviorSchema>;

/**
 * Configuration for responsive layout breakpoints.
 * Values are in CSS logical pixels (device-independent).
 */
export const ResponsiveLayoutConfigSchema = z.object({
  /** Narrow layout breakpoint (px). Below this → narrow. */
  narrowBreakpoint: z.number().positive().finite(),
  /** Wide layout breakpoint (px). At or above this → wide. */
  wideBreakpoint: z.number().positive().finite(),
  /** Maximum scale factor the layout must support without breaking. */
  maxSupportedScale: z.number().min(1).max(4).finite(),
}).refine(
  (cfg) => cfg.narrowBreakpoint <= cfg.wideBreakpoint,
  { message: 'narrowBreakpoint must be <= wideBreakpoint' },
);

export type ResponsiveLayoutConfig = z.infer<typeof ResponsiveLayoutConfigSchema>;

/**
 * Priority classification for content placement at different widths.
 * Primary items remain visible at narrow widths.
 * Secondary items move to a disclosure or second row.
 */
export const ContentPrioritySchema = z.enum(['primary', 'secondary']);
export type ContentPriority = z.infer<typeof ContentPrioritySchema>;

/**
 * Intrinsically 2D content types that get their own scroll region.
 * Requirements: 46.7
 */
export const TwoDimensionalContentKindSchema = z.enum([
  'code',
  'diff',
  'table',
  'diagram',
  'terminal',
  'image',
]);
export type TwoDimensionalContentKind = z.infer<typeof TwoDimensionalContentKindSchema>;

/**
 * Describes how a particular content element should be laid out
 * given the current layout mode and scaling state.
 */
export interface LayoutDecision {
  /** The resolved layout mode. */
  mode: LayoutMode;
  /** Whether this content scrolls in its own region. */
  scrollBehavior: ScrollBehavior;
  /** Whether the content is visible in the primary area or disclosure. */
  placement: ContentPriority;
  /** Whether 200% zoom is active. */
  scaledUp: boolean;
  /** Accessible label for any scroll region created. */
  scrollRegionLabel?: string;
}

// ─── Default Configuration ──────────────────────────────────────

export const DEFAULT_RESPONSIVE_LAYOUT_CONFIG: ResponsiveLayoutConfig = {
  narrowBreakpoint: 600,
  wideBreakpoint: 600,
  maxSupportedScale: 2,
};

// ─── Intrinsically 2D content set ───────────────────────────────

const INTRINSIC_2D_KINDS = new Set<string>(
  TwoDimensionalContentKindSchema.options,
);

// ─── Layout Resolver ────────────────────────────────────────────

/**
 * Resolves the current layout mode from available width.
 */
export function resolveLayoutMode(
  availableWidth: number,
  config: ResponsiveLayoutConfig = DEFAULT_RESPONSIVE_LAYOUT_CONFIG,
): LayoutMode {
  return availableWidth < config.narrowBreakpoint ? 'narrow' : 'wide';
}

/**
 * Determines whether a content region at 200% zoom causes page-level
 * 2D scrolling. If so, it must be placed in its own scroll region.
 *
 * Requirements: 46.7
 */
export function requiresOwnScrollRegion(
  contentKind: string,
  scalePercent: number,
): boolean {
  // At 200%+ scaling, intrinsically 2D content scrolls in its own region
  if (scalePercent >= 200 && INTRINSIC_2D_KINDS.has(contentKind)) {
    return true;
  }
  // Even at lower scaling, 2D content gets its own scroll region
  return INTRINSIC_2D_KINDS.has(contentKind);
}

/**
 * Makes a full layout decision for a content element.
 *
 * @param availableWidth - Available viewport width in CSS logical px
 * @param contentKind - The kind of content being laid out
 * @param priority - Whether this content is primary or secondary
 * @param scalePercent - Current browser/OS text scale in percent (100 = normal)
 * @param config - Responsive breakpoint configuration
 */
export function makeLayoutDecision(
  availableWidth: number,
  contentKind: string,
  priority: ContentPriority,
  scalePercent: number = 100,
  config: ResponsiveLayoutConfig = DEFAULT_RESPONSIVE_LAYOUT_CONFIG,
): LayoutDecision {
  const mode = resolveLayoutMode(availableWidth, config);
  const scaledUp = scalePercent >= 200;
  const needsOwnScroll = requiresOwnScrollRegion(contentKind, scalePercent);

  // In narrow mode, secondary items go to disclosure
  const placement: ContentPriority =
    mode === 'narrow' && priority === 'secondary' ? 'secondary' : priority;

  return {
    mode,
    scrollBehavior: needsOwnScroll ? 'own_region' : 'flow',
    placement,
    scaledUp,
    ...(needsOwnScroll ? { scrollRegionLabel: `Scrollable ${contentKind} region` } : {}),
  };
}

/**
 * Validates that at the given scale, all controls remain accessible.
 * Returns a list of issues if any operations would be inaccessible.
 *
 * Requirements: 46.7, 46.15
 */
export function validateScaledAccessibility(
  availableWidth: number,
  scalePercent: number,
  controlCount: number,
  config: ResponsiveLayoutConfig = DEFAULT_RESPONSIVE_LAYOUT_CONFIG,
): { accessible: boolean; issues: string[] } {
  const issues: string[] = [];

  // Effective width at scale (CSS logical px remain the same, but
  // content occupies more of the viewport)
  const effectiveWidth = availableWidth / (scalePercent / 100);

  if (effectiveWidth < 320) {
    issues.push(
      'Effective viewport width below 320px; some controls may be clipped',
    );
  }

  if (scalePercent > config.maxSupportedScale * 100) {
    issues.push(
      `Scale ${scalePercent}% exceeds maximum supported scale of ${config.maxSupportedScale * 100}%`,
    );
  }

  // At narrow widths with many controls, verify they can stack vertically
  const mode = resolveLayoutMode(availableWidth, config);
  if (mode === 'narrow' && controlCount > 20) {
    issues.push(
      'High control count in narrow mode; ensure vertical stacking is navigable',
    );
  }

  return {
    accessible: issues.length === 0,
    issues,
  };
}
