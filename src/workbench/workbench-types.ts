/**
 * Renderer Workbench Authority — shared types for the desktop shell, canonical
 * workspace-relative editor models, deep links, ChangeSet review, and the
 * production loading/error state machine (FUT-PKG-07-EXPERIENCE/T-003).
 *
 * These are pure, dependency-light types shared by the workbench modules. They
 * carry NO absolute host paths: every file identity that crosses a workbench
 * boundary is a workspace-relative POSIX path (NN-UI-003 avoids absolute-path
 * disclosure by default; NN-INV-004). The shell is a VIEW authority: it owns
 * layout/focus/model lifecycle but NEVER a durable file writer — every file
 * mutation routes through the canonical ChangeService (NN-INV-008, D-04/D-12).
 *
 * Design anchors: D-03 (renderer/authority boundary), D-05, D-12 (ChangeSet
 * apply), D-13, D-14 (recovery). Requirements: NN-UI-001–006/013,
 * NN-WORKSPACE-011, NN-OPS-002, NN-INV-004/008.
 */

// ─── Desktop shell dimensions (NN-UI-001/002) ───────────────────────────────

/**
 * Legacy shell dimension targets that remain fixed regardless of viewport
 * (NN-UI-002): the activity bar is 48px wide, the status bar is 24px tall, a
 * panel is at least 150px, and at most four editor panes are shown at once.
 */
export const SHELL_DIMENSIONS = Object.freeze({
  activityBarWidthPx: 48,
  statusBarHeightPx: 24,
  panelMinPx: 150,
  maxPanes: 4,
} as const);

/** A responsive breakpoint class derived purely from viewport width. */
export type ViewportClass = 'narrow' | 'wide';

/** The set of dockable areas the shell can arrange. */
export const SHELL_AREAS = Object.freeze([
  'activityBar',
  'sideBar',
  'editorGroups',
  'panel',
  'statusBar',
] as const);
export type ShellArea = (typeof SHELL_AREAS)[number];

/** Where the auxiliary panel (terminal/checks) may dock. */
export type PanelPosition = 'bottom' | 'right';

/** A single editor pane inside the editor-group area. */
export interface EditorPane {
  /** Stable pane id (workspace layout persists these). */
  readonly paneId: string;
  /** The workspace-relative model URI currently focused in this pane, if any. */
  readonly activeModelUri: string | null;
  /** Ordered workspace-relative model URIs open as tabs in this pane. */
  readonly tabs: readonly string[];
  /** Fractional width weight (panes split the editor area proportionally). */
  readonly weight: number;
}

/**
 * A persisted, resolvable workspace layout (NN-UI-001 "persistent workspace
 * layouts"). It records the shell chrome, panes, side/panel sizes, and the
 * focused area so a restart restores the same arrangement (islands migrate
 * independently; layouts persist compatibly).
 */
export interface WorkspaceLayout {
  readonly layoutVersion: number;
  readonly sideBarVisible: boolean;
  readonly sideBarWidthPx: number;
  readonly panelVisible: boolean;
  readonly panelPosition: PanelPosition;
  readonly panelSizePx: number;
  readonly panes: readonly EditorPane[];
  /** The shell area that holds keyboard focus (deterministic restore). */
  readonly focusedArea: ShellArea;
  /** The pane id that holds focus within the editor-group area. */
  readonly focusedPaneId: string | null;
}

/**
 * The computed, render-ready shell model for a given viewport. Derived purely
 * from a {@link WorkspaceLayout} + viewport; adapts narrow/wide and 200% scale,
 * clamps to the legacy dimension targets, preserves controls/focus, and avoids
 * unnecessary two-dimensional scrolling (NN-UI-002).
 */
export interface ShellViewModel {
  readonly viewport: ViewportClass;
  readonly scalePercent: number;
  readonly activityBarWidthPx: number;
  readonly statusBarHeightPx: number;
  readonly sideBarVisible: boolean;
  readonly sideBarWidthPx: number;
  readonly panelVisible: boolean;
  readonly panelPosition: PanelPosition;
  readonly panelSizePx: number;
  /** Panes clamped to at most {@link SHELL_DIMENSIONS.maxPanes}. */
  readonly panes: readonly EditorPane[];
  readonly focusedArea: ShellArea;
  readonly focusedPaneId: string | null;
  /** True when the layout avoids horizontal+vertical scroll at this viewport. */
  readonly singleAxisScroll: boolean;
}

// ─── Deep links (NN-UI-003) ─────────────────────────────────────────────────

/** The kinds of target a workspace-relative deep link can address. */
export const DEEP_LINK_KINDS = Object.freeze([
  'file',
  'range',
  'diff',
  'chatNode',
  'toolEvent',
  'terminalEvidence',
  'checkpoint',
  'artifact',
  'requirement',
  'task',
] as const);
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number];

/** An inclusive 1-based line/column range within a file (NN-UI-003). */
export interface LinkRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * A stable, workspace-relative deep link. It NEVER carries an absolute host
 * path: `relativePath` is a workspace-relative POSIX path and every other
 * anchor is an opaque stable identity (NN-UI-003, NN-INV-004).
 */
export interface DeepLink {
  readonly kind: DeepLinkKind;
  /** Workspace-relative POSIX path for file/range/diff targets, else null. */
  readonly relativePath: string | null;
  readonly range: LinkRange | null;
  /** Opaque stable id for a chat node / tool event / checkpoint / artifact. */
  readonly anchorId: string | null;
}

// ─── Production loading / error state machine (NN-UI-013) ────────────────────

/**
 * A production surface state (NN-UI-013): a loading state transitions to data,
 * a valid empty state, or an actionable error — never a silent stall.
 */
export type SurfacePhase = 'loading' | 'data' | 'empty' | 'error';

/** The render-ready surface state with progressive status for long operations. */
export interface SurfaceState {
  readonly phase: SurfacePhase;
  /** Progress in [0,1] while loading; null when indeterminate/terminal. */
  readonly progress: number | null;
  /** A short progressive status message for long operations. */
  readonly statusMessage: string | null;
  /** Whether interactive controls remain responsive in this phase. */
  readonly controlsResponsive: boolean;
  /** For the error phase: a typed, actionable recovery action id. */
  readonly recoveryActionId: string | null;
}
