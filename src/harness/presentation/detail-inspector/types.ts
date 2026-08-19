/**
 * Detail Inspector Coordinator Types
 *
 * Schemas and types for the adaptive detail inspector. Defines
 * typed selection, layout mode, entity state, focus restoration,
 * and ephemeral per-session persistence.
 *
 * One correlated inspector per session; never duplicates approval
 * controls owned by the Composer_Workbench.
 *
 * Requirements: 7.4–7.7, 8.5, 12.4–12.6, 16.1–16.8, 18.7
 */

import { z } from 'zod';

// ─── Inspector Detail Kind ──────────────────────────────────────

/**
 * The kind of entity being inspected. Closed enumeration; new kinds
 * require a contract version bump.
 */
export const InspectorKindSchema = z.enum([
  'tool',
  'source',
  'diff',
  'data',
  'trajectory',
  'insight',
  'attachment',
  'provenance',
]);
export type InspectorKind = z.infer<typeof InspectorKindSchema>;

// ─── Inspector Entity Status ────────────────────────────────────

/**
 * The presentation-level status of the entity being inspected.
 */
export const InspectorEntityStatusSchema = z.enum([
  'loading',
  'ready',
  'updating',
  'unavailable',
  'removed',
]);
export type InspectorEntityStatus = z.infer<typeof InspectorEntityStatusSchema>;

// ─── Inspector Selection ────────────────────────────────────────

/**
 * A typed selection identifying what the inspector is showing.
 * The identity is exact: it includes the entity ID, source revision,
 * and invoking control context for focus restoration.
 */
export const InspectorSelectionSchema = z.object({
  /** The kind of detail being shown. */
  kind: InspectorKindSchema,

  /** Exact identity of the entity (e.g., callId, citationId, diffId). */
  identity: z.string().min(1),

  /** Source revision from the projection at the time of opening. */
  sourceRevision: z.number().int().nonnegative().finite(),

  /** Stable key of the block that invoked the inspector. */
  invokingStableKey: z.string().min(1),

  /** DOM control ID (or equivalent stable identifier) that opened the inspector. */
  invokingControlId: z.string().min(1),
});
export type InspectorSelection = z.infer<typeof InspectorSelectionSchema>;

// ─── Inspector Entity ───────────────────────────────────────────

/**
 * Represents the current data for the inspected entity.
 * Used for in-place updates when the underlying data changes.
 */
export interface InspectorEntity {
  /** The kind of entity (must match current selection kind). */
  kind: InspectorKind;

  /** Exact identity (must match current selection identity). */
  identity: string;

  /** Current source revision of the entity. */
  sourceRevision: number;

  /** Current entity status. */
  status: InspectorEntityStatus;

  /** Title for the inspector header. */
  title: string;

  /** Whether the entity has been removed (triggers unavailable state). */
  removed?: boolean;

  /** Typed payload — opaque to the coordinator, consumed by the detail renderer. */
  payload?: unknown;
}

// ─── Layout Mode ────────────────────────────────────────────────

/**
 * Layout mode selected by the inspector based on available viewport width.
 *
 * - pane: resizable side pane (when minimum main-column width is preserved)
 * - sheet: focus-contained dialog with bounded independent overflow
 */
export const InspectorLayoutModeSchema = z.enum(['pane', 'sheet']);
export type InspectorLayoutMode = z.infer<typeof InspectorLayoutModeSchema>;

// ─── Close Reason ───────────────────────────────────────────────

/**
 * Reason the inspector was closed.
 */
export type InspectorCloseReason = 'user' | 'entity_removed' | 'session_change';

// ─── Focus Restoration Target ───────────────────────────────────

/**
 * Describes where focus should be restored after inspector closes.
 */
export interface FocusRestorationTarget {
  /** The invoking control ID that originally opened the inspector. */
  controlId: string;

  /** Fallback target when the invoking control no longer exists. */
  fallback: 'nearest_workflow_control' | 'composer';
}

// ─── Inspector State ────────────────────────────────────────────

/**
 * Full ephemeral state of the detail inspector coordinator.
 */
export interface DetailInspectorState {
  /** Whether the inspector is currently open. */
  open: boolean;

  /** Current selection (null if closed). */
  selection: InspectorSelection | null;

  /** Current layout mode. */
  layoutMode: InspectorLayoutMode;

  /** Entity status. */
  entityStatus: InspectorEntityStatus;

  /** Title displayed in the inspector header. */
  title: string;

  /** Source revision of the currently displayed entity. */
  currentSourceRevision: number;

  /** Focus restoration target for close. */
  focusTarget: FocusRestorationTarget | null;

  /** Whether entity data is being loaded. */
  loading: boolean;

  /** Session this inspector state belongs to. */
  sessionId: string;
}

// ─── Inspector View ─────────────────────────────────────────────

/**
 * The presentation view exposed to the rendering layer.
 */
export interface DetailInspectorView {
  /** Whether the inspector is visible. */
  visible: boolean;

  /** Layout mode determining pane vs sheet. */
  layoutMode: InspectorLayoutMode;

  /** Detail kind label for the header. */
  kindLabel: string;

  /** Inspector title. */
  title: string;

  /** Exact identity string for display. */
  identity: string;

  /** Status of the entity being displayed. */
  entityStatus: InspectorEntityStatus;

  /** Source revision for display (when applicable). */
  sourceRevision: number;

  /** Whether a close action is available. */
  closable: boolean;

  /** Whether the pane is resizable (only in pane mode). */
  resizable: boolean;

  /** Current width in DIP (only meaningful in pane mode). */
  widthDip: number;

  /** Accessibility data. */
  accessibility: InspectorAccessibilityData;
}

// ─── Accessibility Data ─────────────────────────────────────────

/**
 * Accessibility data exposed for the inspector surface.
 */
export interface InspectorAccessibilityData {
  /** Accessible label for the inspector region/dialog. */
  ariaLabel: string;

  /** Role: complementary (pane) or dialog (sheet). */
  role: 'complementary' | 'dialog';

  /** Whether aria-modal applies (sheet mode only). */
  modal: boolean;

  /** Description for screen readers. */
  ariaDescription: string;
}

// ─── Ephemeral Preferences ──────────────────────────────────────

/**
 * Ephemeral per-session preferences persisted only in memory.
 * Never written to durable storage; never domain state.
 */
export interface InspectorEphemeralPreferences {
  /** Preferred width for pane mode (in DIP). */
  preferredWidthDip: number;

  /** Last open state per session. */
  lastOpenSelection: InspectorSelection | null;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the detail inspector coordinator.
 * Values derived from SettingsBoundsService.
 */
export interface DetailInspectorConfig {
  /** Maximum inspector pane width in DIP. */
  inspectorMaxWidthDip: number;

  /** Minimum main column width that must be preserved. */
  minimumMainColumnWidthDip: number;

  /** Default inspector pane width in DIP. */
  defaultWidthDip: number;

  /** Minimum inspector pane width in DIP. */
  minimumWidthDip: number;
}

export const DEFAULT_INSPECTOR_CONFIG: DetailInspectorConfig = {
  inspectorMaxWidthDip: 480,
  minimumMainColumnWidthDip: 480,
  defaultWidthDip: 360,
  minimumWidthDip: 240,
};

// ─── Kind Display Labels ────────────────────────────────────────

/**
 * Human-readable labels for each inspector kind.
 */
export const INSPECTOR_KIND_LABELS: Record<InspectorKind, string> = {
  tool: 'Tool Detail',
  source: 'Source Detail',
  diff: 'Diff Detail',
  data: 'Data Detail',
  trajectory: 'Trajectory Detail',
  insight: 'Insight Detail',
  attachment: 'Attachment Detail',
  provenance: 'Provenance Detail',
};
