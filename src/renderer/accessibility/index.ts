/**
 * Accessibility infrastructure for the editor-chat-enhancement feature.
 *
 * Exports: LiveRegionManager, StreamingAnnouncementBatcher,
 * FocusRestorationService, KeyboardReviewScope, GraphTextualNavigator,
 * ComboboxAccessibility, TransitionAnnouncer, and VisualAccessibility.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10
 */

export { LiveRegionManager, type LiveRegionPriority } from './live-region-manager';
export { StreamingAnnouncementBatcher, type BatchConfig } from './streaming-announcement-batcher';
export { FocusRestorationService, type FocusRestorationEntry } from './focus-restoration-service';
export { KeyboardReviewScope, type ReviewScopeState } from './keyboard-review-scope';
export { GraphTextualNavigator, type TextualGraphNode, type TextualGraphEdge } from './graph-textual-navigator';
export { ComboboxAccessibility, type ComboboxState } from './combobox-accessibility';
export { TransitionAnnouncer, type TransitionKind } from './transition-announcer';
export {
  // Non-color cues
  STATUS_NON_COLOR_CUES,
  RISK_NON_COLOR_CUES,
  DIFF_NON_COLOR_CUES,
  PROGRESS_NON_COLOR_CUES,
  getStatusCue,
  getRiskCue,
  getDiffLineCue,
  getProgressCue,
  // Contrast utilities
  CONTRAST_THRESHOLDS,
  MIN_TARGET_SIZE_PX,
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  meetsContrastAA,
  // Target size
  meetsMinTargetSize,
  auditTargetSizes,
  // Motion preferences
  prefersReducedMotion,
  getMotionConfig,
  onMotionPreferenceChange,
  MOTION_CLASSES,
  applyMotionClass,
  // Zoom compliance
  ZOOM_COMPLIANT_RULES,
  validateZoomCompliance,
  // Initialization
  VISUAL_ACCESSIBILITY_CSS,
  injectVisualAccessibilityStyles,
  initVisualAccessibility,
  // Types
  type StatusCategory,
  type RiskLevel,
  type DiffLineType,
  type ProgressState,
  type NonColorCue,
  type MotionConfig,
  type TargetSizeResult,
  type ZoomComplianceResult,
} from './visual-accessibility';
