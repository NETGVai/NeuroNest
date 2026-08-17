/**
 * Turn Activity Surface — Public API
 *
 * Exports the stable turn-activity surface types, reducer, helpers,
 * and configuration schemas.
 *
 * Requirements: 36.1–36.17
 */

export {
  // Schemas
  ElapsedTimeThresholdSchema,
  TurnActivitySurfaceConfigSchema,
  RemediationActionSchema,
  StopControlSchema,
  CancellationDetailSchema,
  ReconnectionDetailSchema,
  StatusAnnouncementSchema,
  StreamingIndicatorSchema,
  TurnActivitySurfaceSchema,

  // Types
  type TurnActivitySurfaceConfig,
  type RemediationAction,
  type StopControl,
  type CancellationDetail,
  type ReconnectionDetail,
  type StatusAnnouncement,
  type StreamingIndicator,
  type TurnActivitySurface,
  type StatusLabelProvider,
  type TurnActivityProjection,
  type MotionAdjustedPresentation,

  // Constants
  DEFAULT_TURN_ACTIVITY_SURFACE_CONFIG,
  DEFAULT_STATUS_LABELS,
  DEFAULT_TERMINAL_OUTCOMES,

  // Functions
  deriveTurnActivitySurface,
  shouldEmitAnnouncement,
  getMotionAdjustedPresentation,
  retainPartialOutput,
} from './turn-activity-surface';
