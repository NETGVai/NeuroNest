/**
 * Accessibility Module — Semantic Keyboard Navigation Across Projected Widgets
 *
 * Provides:
 * - Semantic ARIA widget roles (list/tree/toolbar/form/dialog/status)
 * - Roving tabindex within composite widgets
 * - Projected-order page navigation independent of DOM mount state
 * - Focused-row retention (pinned nodes outside normal window)
 * - Visible focus indicators meeting WCAG focus-visible
 * - Keyboard shortcuts/actions for common operations
 * - Deterministic page requests at window boundaries
 * - Modal focus trapping and restoration
 * - Status region announcements (polite, coalesced)
 *
 * Requirements: 35.10, 37.12, 38.12, 39.7, 41.4, 46.1–46.5, 46.9–46.10, 46.14–46.15
 */

export type {
  SemanticWidgetRole,
  NavigationOrientation,
  CompositeWidgetDescriptor,
  FocusableItem,
  FocusRestorationTarget,
  FocusRestorationResult,
  KeyboardAction,
  NormalizedKeyEvent,
  KeyBinding,
  FocusVisibilityState,
  DeterministicPageRequest,
  StatusAnnouncement,
  ModalTrapConfig,
} from './types';

export {
  RovingTabindexManager,
  type PageBoundaryHandler,
} from './roving-tabindex-manager';

export {
  FocusRetentionController,
  type SurvivingControlCandidate,
  type FocusRetentionConfig,
} from './focus-retention-controller';

export {
  ModalFocusTrap,
  type ActiveTrapState,
  type ModalCloseResult,
} from './modal-focus-trap';

export {
  KeyboardActionDispatcher,
  DEFAULT_KEY_BINDINGS,
  type KeyboardActionHandler,
  type KeyboardActionContext,
} from './keyboard-action-dispatcher';

export {
  StatusRegionAnnouncer,
  validateStatusRegionConfig,
  type StatusRegionConfig,
  type AnnouncementSink,
} from './status-region-announcer';
