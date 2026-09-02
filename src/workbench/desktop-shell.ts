/**
 * DesktopShell — the pure layout authority for the Theia-like desktop shell
 * (FUT-PKG-07-EXPERIENCE/T-003, NN-UI-001/002).
 *
 * The shell provides the activity bar, status bar, editor groups, resizable
 * side/panel areas, terminal/checks panel, command palette, and persistent
 * workspace layouts WITHOUT replacing the trusted Electron authority boundaries
 * (NN-UI-001). This module is a pure VIEW derivation: {@link deriveShell}
 * projects a persisted {@link WorkspaceLayout} + viewport into a render-ready
 * {@link ShellViewModel}, and the layout mutators return a NEW layout (islands
 * migrate independently; layouts persist compatibly).
 *
 * Responsiveness (NN-UI-002): the legacy dimension targets are fixed (activity
 * bar 48px, status bar 24px, panel ≥150px, ≤4 panes). At a narrow viewport the
 * side bar collapses and the panel docks to the bottom; at a wide viewport the
 * panel may dock to the right. At 200% scale the shell keeps a single scroll
 * axis (no unnecessary two-dimensional scrolling) and preserves the focused
 * area/pane deterministically.
 *
 * Design anchors: D-03 (renderer/authority boundary), D-05. Requirements:
 * NN-UI-001/002.
 */

import {
  SHELL_DIMENSIONS,
  type EditorPane,
  type PanelPosition,
  type ShellArea,
  type ShellViewModel,
  type ViewportClass,
  type WorkspaceLayout,
} from './workbench-types.js';

/** The current layout schema version this shell reads/writes. */
export const WORKSPACE_LAYOUT_VERSION = 1 as const;

/** The viewport-width threshold (px) separating narrow from wide (NN-UI-002). */
export const NARROW_MAX_WIDTH_PX = 900;

/** Classify a viewport width into a responsive class (NN-UI-002). */
export function classifyViewport(widthPx: number): ViewportClass {
  return widthPx <= NARROW_MAX_WIDTH_PX ? 'narrow' : 'wide';
}

/** The default, empty single-pane layout (NN-UI-001 persistent layout seed). */
export function defaultLayout(): WorkspaceLayout {
  return {
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    sideBarVisible: true,
    sideBarWidthPx: 240,
    panelVisible: false,
    panelPosition: 'bottom',
    panelSizePx: SHELL_DIMENSIONS.panelMinPx,
    panes: [{ paneId: 'pane-1', activeModelUri: null, tabs: [], weight: 1 }],
    focusedArea: 'editorGroups',
    focusedPaneId: 'pane-1',
  };
}

/**
 * Derive the render-ready shell model for a viewport. Pure and deterministic:
 * the same layout + viewport always produces the same model. Clamps to the
 * legacy dimension targets, adapts narrow/wide + 200% scale, preserves the
 * focused area/pane, caps panes at four, and reports whether the layout keeps a
 * single scroll axis (NN-UI-002).
 */
export function deriveShell(
  layout: WorkspaceLayout,
  viewport: { readonly widthPx: number; readonly scalePercent?: number },
): ShellViewModel {
  const scalePercent = viewport.scalePercent ?? 100;
  const viewportClass = classifyViewport(viewport.widthPx);

  // At a narrow viewport, the side bar collapses to reclaim horizontal room and
  // the panel always docks to the bottom so the layout stays single-axis.
  const sideBarVisible = viewportClass === 'narrow' ? false : layout.sideBarVisible;
  const panelPosition: PanelPosition =
    viewportClass === 'narrow' ? 'bottom' : layout.panelPosition;

  // Panes are capped at the legacy maximum of four; the focused pane is kept.
  const panes = clampPanes(layout.panes, layout.focusedPaneId);
  const focusedPaneId = resolveFocusedPane(panes, layout.focusedPaneId);

  // The side bar width is clamped to the panel minimum so it never shrinks
  // below a usable size, and never exceeds a third of the viewport (avoids the
  // editor area collapsing and forcing a second scroll axis).
  const sideBarWidthPx = sideBarVisible
    ? clamp(layout.sideBarWidthPx, SHELL_DIMENSIONS.panelMinPx, Math.floor(viewport.widthPx / 3))
    : 0;

  const panelSizePx = layout.panelVisible
    ? Math.max(layout.panelSizePx, SHELL_DIMENSIONS.panelMinPx)
    : 0;

  // Single-axis scroll (NN-UI-002 "avoid unnecessary two-dimensional scrolling
  // at 200% scale"): a right-docked panel at a narrow/scaled viewport competes
  // for horizontal room with the side bar and editor, forcing two axes. When
  // the panel is bottom-docked (or hidden) at effective width, one axis holds.
  const effectiveWidth = viewport.widthPx / (scalePercent / 100);
  const rightPanelCrowds =
    layout.panelVisible && panelPosition === 'right' && effectiveWidth < NARROW_MAX_WIDTH_PX;
  const singleAxisScroll = !rightPanelCrowds;

  return {
    viewport: viewportClass,
    scalePercent,
    activityBarWidthPx: SHELL_DIMENSIONS.activityBarWidthPx,
    statusBarHeightPx: SHELL_DIMENSIONS.statusBarHeightPx,
    sideBarVisible,
    sideBarWidthPx,
    panelVisible: layout.panelVisible,
    panelPosition,
    panelSizePx,
    panes,
    focusedArea: layout.focusedArea,
    focusedPaneId,
    singleAxisScroll,
  };
}

// ─── Layout mutators (return a NEW layout; islands migrate independently) ────

/** Open a workspace-relative model URI as a tab in a pane, focusing it. */
export function openInPane(
  layout: WorkspaceLayout,
  paneId: string,
  modelUri: string,
): WorkspaceLayout {
  const panes = layout.panes.map((pane) =>
    pane.paneId === paneId
      ? {
          ...pane,
          tabs: pane.tabs.includes(modelUri) ? pane.tabs : [...pane.tabs, modelUri],
          activeModelUri: modelUri,
        }
      : pane,
  );
  return { ...layout, panes, focusedArea: 'editorGroups', focusedPaneId: paneId };
}

/**
 * Split the editor area by adding a new pane (up to the four-pane maximum).
 * A request beyond the maximum returns the layout unchanged so the shell never
 * exceeds the legacy pane cap (NN-UI-002).
 */
export function splitPane(layout: WorkspaceLayout, newPaneId: string): WorkspaceLayout {
  if (layout.panes.length >= SHELL_DIMENSIONS.maxPanes) return layout;
  if (layout.panes.some((p) => p.paneId === newPaneId)) return layout;
  const pane: EditorPane = { paneId: newPaneId, activeModelUri: null, tabs: [], weight: 1 };
  return { ...layout, panes: [...layout.panes, pane], focusedPaneId: newPaneId, focusedArea: 'editorGroups' };
}

/** Toggle the auxiliary panel (terminal/checks) and dock position. */
export function setPanel(
  layout: WorkspaceLayout,
  input: { readonly visible: boolean; readonly position?: PanelPosition; readonly sizePx?: number },
): WorkspaceLayout {
  return {
    ...layout,
    panelVisible: input.visible,
    panelPosition: input.position ?? layout.panelPosition,
    panelSizePx: Math.max(input.sizePx ?? layout.panelSizePx, SHELL_DIMENSIONS.panelMinPx),
  };
}

/** Move keyboard focus to a shell area (and pane), preserving the rest. */
export function focusArea(
  layout: WorkspaceLayout,
  area: ShellArea,
  paneId?: string,
): WorkspaceLayout {
  return {
    ...layout,
    focusedArea: area,
    focusedPaneId: paneId ?? layout.focusedPaneId,
  };
}

/**
 * Migrate a persisted layout forward compatibly (NN-UI-001 persistent layouts;
 * islands migrate independently). An older/blank layout is filled with defaults
 * without discarding recognized fields; an unknown future version is read
 * best-effort by clamping to the known shape rather than dropping the layout.
 */
export function migrateLayout(raw: Partial<WorkspaceLayout> | null | undefined): WorkspaceLayout {
  const base = defaultLayout();
  if (!raw || typeof raw !== 'object') return base;
  const panes =
    Array.isArray(raw.panes) && raw.panes.length > 0
      ? clampPanes(raw.panes as EditorPane[], raw.focusedPaneId ?? null)
      : base.panes;
  return {
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    sideBarVisible: raw.sideBarVisible ?? base.sideBarVisible,
    sideBarWidthPx: raw.sideBarWidthPx ?? base.sideBarWidthPx,
    panelVisible: raw.panelVisible ?? base.panelVisible,
    panelPosition: raw.panelPosition === 'right' ? 'right' : 'bottom',
    panelSizePx: Math.max(raw.panelSizePx ?? base.panelSizePx, SHELL_DIMENSIONS.panelMinPx),
    panes,
    focusedArea: raw.focusedArea ?? base.focusedArea,
    focusedPaneId: resolveFocusedPane(panes, raw.focusedPaneId ?? null),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function clampPanes(panes: readonly EditorPane[], focusedPaneId: string | null): readonly EditorPane[] {
  if (panes.length <= SHELL_DIMENSIONS.maxPanes) return panes;
  // Keep the focused pane and the first (maxPanes-1) others so focus survives.
  const kept: EditorPane[] = [];
  const focused = panes.find((p) => p.paneId === focusedPaneId);
  if (focused) kept.push(focused);
  for (const pane of panes) {
    if (kept.length >= SHELL_DIMENSIONS.maxPanes) break;
    if (pane.paneId !== focused?.paneId) kept.push(pane);
  }
  return kept;
}

function resolveFocusedPane(panes: readonly EditorPane[], focusedPaneId: string | null): string | null {
  if (focusedPaneId && panes.some((p) => p.paneId === focusedPaneId)) return focusedPaneId;
  return panes.length > 0 ? panes[0]!.paneId : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.max(value, 0)));
}
