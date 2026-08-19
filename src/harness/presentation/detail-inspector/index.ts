/**
 * Detail Inspector module.
 *
 * One correlated inspector per application. Typed selection for
 * tool/source/diff/data/trajectory/insight/attachment/provenance
 * with adaptive pane/sheet layout and focus restoration.
 *
 * Requirements: 7.4–7.7, 8.5, 12.4–12.6, 16.1–16.8, 18.7
 */

export {
  DetailInspectorCoordinator,
  type ViewportWidthProvider,
  type FocusRestorationPort,
} from './detail-inspector-coordinator';

export type {
  InspectorKind,
  InspectorSelection,
  InspectorEntity,
  InspectorEntityStatus,
  InspectorLayoutMode,
  InspectorCloseReason,
  FocusRestorationTarget,
  DetailInspectorState,
  DetailInspectorView,
  InspectorAccessibilityData,
  InspectorEphemeralPreferences,
  DetailInspectorConfig,
} from './types';

export {
  InspectorKindSchema,
  InspectorEntityStatusSchema,
  InspectorSelectionSchema,
  InspectorLayoutModeSchema,
  INSPECTOR_KIND_LABELS,
  DEFAULT_INSPECTOR_CONFIG,
} from './types';
