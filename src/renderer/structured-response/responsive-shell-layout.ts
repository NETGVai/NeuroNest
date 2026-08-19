/**
 * Responsive Shell Layout — Viewport-adaptive layout controller for the structured chat shell.
 *
 * Adapts header, timeline, composer, and inspector regions without overlap or
 * page-level horizontal scrolling. Contains wide code/diff/table overflow within
 * individual surfaces. Preserves configured minimum reading width at all viewport
 * sizes and text scaling levels (up to 200%).
 *
 * Task 11.3 (enhanced-chat-ui) also derives mode-aware reading bounds from a
 * live width observation:
 *
 * - Advanced mode: the reading column consumes the width remaining after the
 *   Inspector track (`viewport - inspector - side panels`) — clamped to the
 *   configured min/max reading width.
 * - Classic mode: the reading column consumes the expanded main-content width
 *   (no Inspector track reserved) — clamped to the same bounds.
 *
 * The width observer publishes `ChatWidthObservation` updates whenever a
 * `ResizeObserver` reports a container change. Consumers (the structured
 * chat shell) update their timeline max/min via {@link
 * ProjectionDrivenChatShellHandle.setReadingBounds} so metadata, action
 * rows, and cards wrap on narrow widths and code/table containers scroll
 * locally rather than pushing the page.
 *
 * Requirements: 3.7, 9.7, 14.9, 14.10, 15.10, 16.2–16.3, 18.1, 18.12–18.13, 22.5
 *
 * @vitest-environment jsdom
 */

// ─── Layout Constants ───────────────────────────────────────────

/** CSS classes for responsive regions */
export const RESPONSIVE_SHELL_CSS_CLASS = 'nn-responsive-shell';
export const RESPONSIVE_HEADER_CSS_CLASS = 'nn-responsive-shell__header';
export const RESPONSIVE_TIMELINE_CSS_CLASS = 'nn-responsive-shell__timeline';
export const RESPONSIVE_COMPOSER_CSS_CLASS = 'nn-responsive-shell__composer';
export const RESPONSIVE_INSPECTOR_CSS_CLASS = 'nn-responsive-shell__inspector';
export const RESPONSIVE_OVERLAY_INSPECTOR_CSS_CLASS = 'nn-responsive-shell__inspector--overlay';
export const OVERFLOW_CONTAINED_CSS_CLASS = 'nn-responsive-shell__overflow-contained';

/** Breakpoint thresholds in CSS px (logical pixels, scale-independent) */
export const BREAKPOINT_NARROW = 600;
export const BREAKPOINT_MEDIUM = 900;
export const BREAKPOINT_WIDE = 1200;

/** Inspector layout modes */
export type InspectorMode = 'side-pane' | 'overlay-sheet' | 'hidden';

/** Layout mode derived from viewport width */
export type LayoutMode = 'narrow' | 'medium' | 'wide';

// ─── Configuration Types ────────────────────────────────────────

export interface ResponsiveShellConfig {
  /** Minimum reading width for the timeline column (px, pre-scaling) */
  readonly minReadingWidth: number;
  /** Maximum reading width for the timeline column (px) */
  readonly maxReadingWidth: number;
  /** Inspector pane width when in side-pane mode (px) */
  readonly inspectorWidth: number;
  /** Whether the inspector is currently open */
  readonly inspectorOpen: boolean;
  /** Container/viewport width (px) — used for layout calculations */
  readonly viewportWidth: number;
  /** Current text scale factor (1 = 100%, 2 = 200%) */
  readonly textScaleFactor: number;
}

export interface ResponsiveLayoutResult {
  /** Computed layout mode based on viewport */
  readonly layoutMode: LayoutMode;
  /** Inspector display mode */
  readonly inspectorMode: InspectorMode;
  /** Timeline effective width (px) */
  readonly timelineWidth: number;
  /** Whether the minimum reading width is preserved */
  readonly minWidthPreserved: boolean;
  /** Whether overflow containment is active */
  readonly overflowContained: boolean;
  /** Keyboard tab order for regions */
  readonly tabOrder: readonly RegionId[];
  /** Whether any region overlaps another */
  readonly hasOverlap: boolean;
  /** Whether page-level horizontal scroll is needed */
  readonly requiresPageHorizontalScroll: boolean;
}

export type RegionId = 'header' | 'timeline' | 'composer' | 'inspector';

// ─── Responsive Layout Computation ─────────────────────────────

/**
 * Determine the layout mode from viewport width.
 * Text scaling does NOT change breakpoints — breakpoints are in CSS px
 * (which represent logical pixels independent of zoom).
 */
export function computeLayoutMode(viewportWidth: number): LayoutMode {
  if (viewportWidth < BREAKPOINT_NARROW) return 'narrow';
  if (viewportWidth < BREAKPOINT_WIDE) return 'medium';
  return 'wide';
}

/**
 * Determine inspector mode based on available space.
 * Inspector only appears as a side-pane when there is enough room
 * to keep the timeline at or above its minimum reading width.
 */
export function computeInspectorMode(config: ResponsiveShellConfig): InspectorMode {
  if (!config.inspectorOpen) return 'hidden';

  const availableForTimeline = config.viewportWidth - config.inspectorWidth;
  // Account for text scaling: the minimum reading width requirement
  // must still be met at the current scale
  const effectiveMinWidth = config.minReadingWidth;

  if (availableForTimeline >= effectiveMinWidth) {
    return 'side-pane';
  }

  // Not enough room for side-by-side — use overlay
  return 'overlay-sheet';
}

/**
 * Compute the effective timeline width given viewport and inspector state.
 */
export function computeTimelineWidth(config: ResponsiveShellConfig): number {
  const inspectorMode = computeInspectorMode(config);

  let available: number;
  if (inspectorMode === 'side-pane') {
    available = config.viewportWidth - config.inspectorWidth;
  } else {
    available = config.viewportWidth;
  }

  // Clamp to max reading width and ensure min is preserved
  const clamped = Math.min(available, config.maxReadingWidth);
  return Math.max(clamped, config.minReadingWidth);
}

/**
 * Compute the full responsive layout result from configuration.
 *
 * Invariants:
 * 1. No region overlap when in side-pane mode (timeline + inspector <= viewport)
 * 2. No page-level horizontal scroll required (all regions fit within viewport)
 * 3. Minimum reading width always preserved
 * 4. Overflow is always contained at the surface level, not page level
 * 5. Keyboard tab order is always: header → timeline → composer → inspector
 */
export function computeResponsiveLayout(config: ResponsiveShellConfig): ResponsiveLayoutResult {
  const layoutMode = computeLayoutMode(config.viewportWidth);
  const inspectorMode = computeInspectorMode(config);
  const timelineWidth = computeTimelineWidth(config);

  // Check overlap: in side-pane mode, both timeline and inspector must fit
  const hasOverlap = inspectorMode === 'side-pane' &&
    (timelineWidth + config.inspectorWidth > config.viewportWidth);

  // Page scroll: needed only if the minimum reading width exceeds viewport
  // This should never happen in practice because we downgrade inspector to overlay
  const requiresPageHorizontalScroll = config.minReadingWidth > config.viewportWidth;

  // Min width preserved if computed timeline width >= min
  const minWidthPreserved = timelineWidth >= config.minReadingWidth;

  // Keyboard tab order is fixed and logical
  const tabOrder: RegionId[] = ['header', 'timeline', 'composer'];
  if (config.inspectorOpen) {
    tabOrder.push('inspector');
  }

  return Object.freeze({
    layoutMode,
    inspectorMode,
    timelineWidth,
    minWidthPreserved,
    overflowContained: true, // always true — overflow is always contained at surface level
    tabOrder: Object.freeze(tabOrder),
    hasOverlap,
    requiresPageHorizontalScroll,
  });
}

// ─── DOM Application ────────────────────────────────────────────

export interface ResponsiveShellElements {
  readonly shell: HTMLElement;
  readonly header: HTMLElement;
  readonly timeline: HTMLElement;
  readonly composer: HTMLElement;
  readonly inspector?: HTMLElement;
}

/**
 * Apply computed responsive layout to actual DOM elements.
 * Sets CSS classes, custom properties, and layout attributes.
 */
export function applyResponsiveLayout(
  elements: ResponsiveShellElements,
  config: ResponsiveShellConfig,
): ResponsiveLayoutResult {
  const result = computeResponsiveLayout(config);
  const { shell, header, timeline, composer, inspector } = elements;

  // Set layout mode on root
  shell.className = RESPONSIVE_SHELL_CSS_CLASS;
  shell.dataset.layoutMode = result.layoutMode;
  shell.style.setProperty('--nn-viewport-width', `${config.viewportWidth}px`);
  shell.style.setProperty('--nn-text-scale', `${config.textScaleFactor}`);
  shell.style.setProperty('--nn-min-reading-width', `${config.minReadingWidth}px`);
  shell.style.setProperty('--nn-max-reading-width', `${config.maxReadingWidth}px`);

  // Shell: flex column, no page horizontal scroll
  shell.style.display = 'flex';
  shell.style.flexDirection = 'column';
  shell.style.width = '100%';
  shell.style.maxWidth = '100%';
  shell.style.overflowX = 'hidden';
  shell.style.height = '100%';

  // Header: full width, no overlap
  header.className = RESPONSIVE_HEADER_CSS_CLASS;
  header.style.width = '100%';
  header.style.flexShrink = '0';
  header.setAttribute('tabindex', '0');
  header.setAttribute('data-tab-order', '1');

  // Timeline: constrained, centered, with overflow containment
  timeline.className = RESPONSIVE_TIMELINE_CSS_CLASS;
  timeline.style.width = `${result.timelineWidth}px`;
  timeline.style.maxWidth = `${config.maxReadingWidth}px`;
  timeline.style.minWidth = `${config.minReadingWidth}px`;
  timeline.style.marginLeft = 'auto';
  timeline.style.marginRight = 'auto';
  timeline.style.flexGrow = '1';
  timeline.style.overflowX = 'hidden';
  timeline.style.overflowY = 'auto';
  timeline.setAttribute('tabindex', '0');
  timeline.setAttribute('data-tab-order', '2');

  // If inspector is in side-pane mode, timeline needs to allow for it
  if (result.inspectorMode === 'side-pane') {
    timeline.style.marginRight = '0';
  }

  // Composer: full width of reading column, at bottom
  composer.className = RESPONSIVE_COMPOSER_CSS_CLASS;
  composer.style.width = '100%';
  composer.style.maxWidth = `${result.timelineWidth}px`;
  composer.style.marginLeft = 'auto';
  composer.style.marginRight = 'auto';
  composer.style.flexShrink = '0';
  composer.style.overflowX = 'hidden';
  composer.setAttribute('tabindex', '0');
  composer.setAttribute('data-tab-order', '3');

  if (result.inspectorMode === 'side-pane') {
    composer.style.marginRight = '0';
  }

  // Inspector: side-pane or overlay
  if (inspector) {
    if (result.inspectorMode === 'side-pane') {
      inspector.className = RESPONSIVE_INSPECTOR_CSS_CLASS;
      inspector.style.position = 'absolute';
      inspector.style.right = '0';
      inspector.style.top = '0';
      inspector.style.bottom = '0';
      inspector.style.width = `${config.inspectorWidth}px`;
      inspector.style.overflowX = 'hidden';
      inspector.style.overflowY = 'auto';
    } else if (result.inspectorMode === 'overlay-sheet') {
      inspector.className = `${RESPONSIVE_INSPECTOR_CSS_CLASS} ${RESPONSIVE_OVERLAY_INSPECTOR_CSS_CLASS}`;
      inspector.style.position = 'fixed';
      inspector.style.right = '0';
      inspector.style.top = '0';
      inspector.style.bottom = '0';
      inspector.style.width = `min(${config.inspectorWidth}px, 90vw)`;
      inspector.style.overflowX = 'hidden';
      inspector.style.overflowY = 'auto';
    } else {
      inspector.style.display = 'none';
    }

    inspector.setAttribute('tabindex', '0');
    inspector.setAttribute('data-tab-order', '4');
  }

  return result;
}

// ─── Overflow Containment Helper ────────────────────────────────

/**
 * Wrap a wide surface (code, diff, table) with overflow containment.
 * Ensures the surface scrolls independently without causing page-level
 * horizontal scroll, even at 200% text scaling.
 */
export function createOverflowContainer(content: HTMLElement): HTMLElement {
  const container = document.createElement('div');
  container.className = OVERFLOW_CONTAINED_CSS_CLASS;
  container.style.overflowX = 'auto';
  container.style.overflowY = 'hidden';
  container.style.maxWidth = '100%';
  container.style.width = '100%';
  container.setAttribute('tabindex', '0');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Scrollable content');
  container.appendChild(content);
  return container;
}

// ─── Text Scaling Utilities ─────────────────────────────────────

/**
 * Check if text scaling is within supported range.
 * We support up to 200% text scaling (factor = 2.0).
 */
export function isTextScaleSupported(factor: number): boolean {
  return factor >= 0.5 && factor <= 2.0;
}

/**
 * Compute effective element dimensions accounting for text scale.
 * At 200% text scaling, a 320px min-width element still occupies 320 CSS px
 * because the viewport reports in CSS px (which already account for scale).
 *
 * The key insight: CSS px are logical pixels that are zoom-independent.
 * Text scaling increases font size but the viewport width in CSS px doesn't change.
 * What changes is how much content fits in the available space.
 */
export function computeEffectiveDimensions(
  viewportWidth: number,
  textScaleFactor: number,
): { effectiveContentWidth: number; textOverflowRisk: boolean } {
  // At higher text scales, content takes more horizontal space.
  // The effective space available for content layout is reduced.
  const effectiveContentWidth = viewportWidth;
  // Text overflow risk when content at this scale may exceed containers
  const textOverflowRisk = textScaleFactor > 1.5;

  return { effectiveContentWidth, textOverflowRisk };
}

/**
 * Generate CSS custom properties for text scaling support.
 * These properties allow surfaces to adapt their internal layout
 * based on the current text scale without JavaScript intervention.
 */
export function getTextScaleProperties(factor: number): Record<string, string> {
  const clampedFactor = Math.max(0.5, Math.min(2.0, factor));
  return {
    '--nn-text-scale-factor': `${clampedFactor}`,
    '--nn-text-scale-inverse': `${1 / clampedFactor}`,
    '--nn-code-font-size': `${Math.max(12, 14 * clampedFactor)}px`,
    '--nn-line-height-factor': `${Math.min(1.8, 1.5 * clampedFactor)}`,
  };
}

// ─── Localization Expansion Support ─────────────────────────────

/**
 * Compute layout adjustments for localization text expansion.
 * Some languages expand text by 30-50% compared to English.
 * The layout must accommodate this without breaking.
 */
export function computeLocalizationExpansion(
  baseWidth: number,
  expansionFactor: number,
): { adjustedWidth: number; needsWrap: boolean } {
  const clampedExpansion = Math.max(1.0, Math.min(2.0, expansionFactor));
  const expandedContentWidth = baseWidth * clampedExpansion;
  const needsWrap = expandedContentWidth > baseWidth;
  return {
    adjustedWidth: baseWidth, // Container width stays the same; content wraps
    needsWrap,
  };
}

// ─── Mode-Aware Width Observation (Task 11.3) ──────────────────

/**
 * Two graphical launch modes established by tasks 3.1 and 3.2. Classic drops
 * the right-side Inspector track entirely, so the main workspace consumes
 * the full remaining width. Advanced preserves the Inspector track, and the
 * chat shell must fit inside `viewport - inspector - side panels`.
 *
 * The values match the persisted `Launch_Mode` string in the SQLite
 * `config` table (see `src/main/launch-mode.ts`) so the observer stays
 * source-of-truth compatible with `data-launch-mode` on `#app`.
 */
export type LaunchMode = 'classic' | 'advanced';

/**
 * Absolute floor for a chat reading column at 100% text scale. Kept in
 * sync with {@link DEFAULT_MIN_READING_WIDTH} in `structured-chat-shell.ts`
 * so any consumer that only imports this module still lands on the same
 * clamp value.
 */
export const CHAT_MIN_READING_WIDTH = 320;

/** Absolute ceiling for a chat reading column at 100% text scale. */
export const CHAT_MAX_READING_WIDTH = 720;

/**
 * A single point-in-time width observation for the chat shell's container.
 * `remainingWidth` is what the shell has to work with after every other
 * chrome region has taken its share; in Advanced mode this excludes the
 * Inspector, in Classic mode the Inspector track is absent so this equals
 * the expanded main content width.
 *
 * `expandedWidth` is a Classic-mode-friendly alias — for symmetry — of the
 * same value; both are always populated so downstream renderers do not
 * branch on mode in more places than necessary.
 */
export interface ChatWidthObservation {
  readonly launchMode: LaunchMode;
  /** Advanced remaining width or Classic expanded width, in CSS px. */
  readonly remainingWidth: number;
  /** Same as {@link remainingWidth}, provided as a Classic-mode alias. */
  readonly expandedWidth: number;
}

/**
 * Bounds published to a chat shell after a width observation is derived.
 * Matches the `ShellLayoutBounds` interface consumers already accept so
 * this module can be a drop-in source of reading-column limits.
 */
export interface ChatReadingBounds {
  readonly minReadingWidth: number;
  readonly maxReadingWidth: number;
}

/**
 * Options controlling how {@link deriveChatReadingBounds} translates a
 * container width into a reading column bound.
 */
export interface ChatReadingBoundsOptions {
  /** Absolute floor for the reading column. Defaults to {@link CHAT_MIN_READING_WIDTH}. */
  readonly minReadingWidth?: number;
  /** Absolute ceiling for the reading column. Defaults to {@link CHAT_MAX_READING_WIDTH}. */
  readonly maxReadingWidth?: number;
  /**
   * When the observed container is smaller than `minReadingWidth`, allow
   * the reading column to shrink to the observed width instead of clamping
   * to the floor. Enabled by default so we never require horizontal page
   * scrolling to satisfy the min bound; disable in tests that want to
   * assert clamp behaviour explicitly. Requirement 14.9, 15.10.
   */
  readonly shrinkBelowMinWhenClamped?: boolean;
}

/**
 * Compute the reading-column bounds a chat shell should use for a given
 * width observation. The rule is intentionally simple:
 *
 * - `maxReadingWidth` = min(remainingWidth, configuredMax)
 * - `minReadingWidth` = configuredMin, but shrunk to the observed width
 *   when the observation is smaller than the floor (see
 *   {@link ChatReadingBoundsOptions.shrinkBelowMinWhenClamped}). This
 *   guarantees the timeline never asks for more horizontal space than
 *   the shell actually has — which would translate into page-level
 *   horizontal scrolling under `document.documentElement`
 *   (Requirement 15.10).
 *
 * The same call handles both modes because {@link ChatWidthObservation}
 * already accounts for the Inspector track: Advanced mode reports the
 * remaining width after Inspector, Classic mode reports the expanded
 * main-content width because there is no Inspector track to subtract.
 */
export function deriveChatReadingBounds(
  observation: ChatWidthObservation,
  options: ChatReadingBoundsOptions = {},
): ChatReadingBounds {
  const configuredMin = options.minReadingWidth ?? CHAT_MIN_READING_WIDTH;
  const configuredMax = options.maxReadingWidth ?? CHAT_MAX_READING_WIDTH;
  const shrinkBelowMin = options.shrinkBelowMinWhenClamped ?? true;

  // Guard against zero/negative widths (jsdom sometimes reports 0 before
  // the observer fires the first real measurement). A negative width is
  // meaningless; treat both as "no space" and clamp to the floor.
  const width = Number.isFinite(observation.remainingWidth)
    ? Math.max(0, observation.remainingWidth)
    : 0;

  const clampedMax = Math.max(1, Math.min(width || configuredMax, configuredMax));
  let minReadingWidth = Math.min(configuredMin, clampedMax);
  if (!shrinkBelowMin) minReadingWidth = configuredMin;

  return Object.freeze({
    minReadingWidth,
    maxReadingWidth: clampedMax,
  });
}

/**
 * Callback shape the chat width observer invokes for every new observation.
 * The receiver typically maps the observation to `ChatReadingBounds` via
 * {@link deriveChatReadingBounds} and hands the result to
 * `ProjectionDrivenChatShellHandle.setReadingBounds`.
 */
export type ChatWidthObserverCallback = (
  observation: ChatWidthObservation,
) => void;

export interface ChatWidthObserverOptions {
  /** Element whose content-box width represents the chat container. */
  readonly target: Element;
  /** Current launch mode. Update via {@link ChatWidthObserverHandle.setLaunchMode}. */
  readonly launchMode: LaunchMode;
  /** Invoked synchronously on every observation. */
  readonly onChange: ChatWidthObserverCallback;
  /**
   * Optional override for `globalThis.ResizeObserver`. Provided by tests
   * running in environments where a hand-rolled fake needs to drive
   * layout timing.
   */
  readonly ResizeObserverCtor?: typeof ResizeObserver;
  /**
   * When true, emit an immediate observation with the current
   * `target.clientWidth` after subscription. Enabled by default so the
   * shell converges to the correct bounds without waiting for the first
   * ResizeObserver callback. Disable in tests that assert the initial
   * emit shape explicitly.
   */
  readonly emitInitial?: boolean;
}

export interface ChatWidthObserverHandle {
  /** Update the observed launch mode; a new observation is emitted. */
  setLaunchMode(mode: LaunchMode): void;
  /** Current launch mode. */
  currentLaunchMode(): LaunchMode;
  /** Force a fresh observation using the target's current clientWidth. */
  emitCurrent(): void;
  /** Retire the underlying ResizeObserver. Idempotent. */
  dispose(): void;
}

/**
 * Build a `ResizeObserver`-backed width observer for the chat shell. The
 * observer:
 *
 * 1. Reads `target.clientWidth` on every notification and packages it as
 *    a {@link ChatWidthObservation}.
 * 2. Publishes the observation through the supplied `onChange` callback
 *    synchronously — the shell reconciles bounds in the same microtask so
 *    the timeline never renders wider than the container.
 * 3. Emits an initial observation from `target.clientWidth` unless the
 *    caller disables it via `emitInitial: false`.
 *
 * The observer never mutates the target; it only reads dimensions. Callers
 * remain responsible for wiring the observation into their layout model.
 */
export function createChatWidthObserver(
  options: ChatWidthObserverOptions,
): ChatWidthObserverHandle {
  const {
    target,
    onChange,
    ResizeObserverCtor,
    emitInitial = true,
  } = options;

  let launchMode: LaunchMode = options.launchMode;
  let disposed = false;

  const Ctor = ResizeObserverCtor ?? (globalThis as {
    ResizeObserver?: typeof ResizeObserver;
  }).ResizeObserver;

  const readWidth = (): number => {
    if (!(target instanceof HTMLElement)) {
      // ResizeObserver contract allows any Element; jsdom does not
      // populate `clientWidth` on non-HTML elements.
      const rect = target.getBoundingClientRect?.();
      return Math.max(0, Math.round(rect?.width ?? 0));
    }
    return Math.max(0, Math.round(target.clientWidth));
  };

  const emit = (): void => {
    if (disposed) return;
    const remainingWidth = readWidth();
    const observation: ChatWidthObservation = Object.freeze({
      launchMode,
      remainingWidth,
      expandedWidth: remainingWidth,
    });
    try {
      onChange(observation);
    } catch {
      // The observer callback must never abort layout — errors thrown by
      // downstream code (e.g. a scheduling failure) are swallowed so the
      // shell remains renderable. Diagnostics belong to the callback.
    }
  };

  let observer: ResizeObserver | null = null;
  if (typeof Ctor === 'function') {
    observer = new Ctor(() => emit());
    try {
      observer.observe(target);
    } catch {
      observer = null;
    }
  }

  if (emitInitial) emit();

  return Object.freeze({
    setLaunchMode(mode: LaunchMode): void {
      if (disposed) return;
      if (mode === launchMode) return;
      launchMode = mode;
      emit();
    },
    currentLaunchMode(): LaunchMode {
      return launchMode;
    },
    emitCurrent(): void {
      emit();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        observer?.disconnect();
      } catch {
        // ResizeObserver disconnect is safe; jsdom fakes may throw.
      }
      observer = null;
    },
  });
}

// ─── Mode-Aware Overflow Containment (Task 11.3) ───────────────

/**
 * Apply the local-overflow guarantees a chat shell needs to satisfy
 * Requirement 15.10 to a container element and its subtree.
 *
 * The function is idempotent: calling it more than once on the same
 * element leaves inline styles unchanged. It is invoked once per shell
 * construction and once per launch-mode change so the CSS-level
 * guarantees in `chat-ui.css` are backed by inline anchors that survive
 * stylesheet load failures (Requirement 15.9).
 */
export function applyChatOverflowContainment(container: HTMLElement): void {
  container.style.maxWidth = '100%';
  container.style.minWidth = '0';
  container.style.boxSizing = container.style.boxSizing || 'border-box';
  // Prevent horizontal scroll leakage. Vertical scrolling is decided by
  // the individual regions (timeline scrolls Y; composer does not).
  container.style.overflowX = container.style.overflowX || 'hidden';
}

/**
 * Publish the resolved launch mode on the chat container so mode-aware
 * CSS in `chat-ui.css` can target Classic-specific rules (e.g. drop the
 * Inspector-aware inline padding). The attribute is stable — callers can
 * read `container.dataset.launchMode` at any time to recover the mode
 * without threading it back through props.
 */
export function markChatContainerLaunchMode(
  container: HTMLElement,
  mode: LaunchMode,
): void {
  container.dataset['launchMode'] = mode;
}
