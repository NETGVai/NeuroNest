/**
 * Exact Collaboration Takeover Surfaces
 *
 * Manages the takeover of the Composer_Workbench by exactly one unanswered
 * question, approval, or plan review. Suppresses duplicate timeline cards,
 * preserves the draft transaction, validates answers against the exact
 * projected schema, and commits at most one decision through
 * Collaboration_Service.
 *
 * Requirements: 38.1–38.16
 */

// Types and schemas
export {
  TakeoverKindSchema,
  TakeoverStatusSchema,
  DecisionActionSchema,
  ProjectedTakeoverContractSchema,
  TakeoverDecisionSubmissionSchema,
  TakeoverConfigSchema,
  DEFAULT_TAKEOVER_CONFIG,
  type TakeoverKind,
  type TakeoverStatus,
  type DecisionAction,
  type ProjectedTakeoverContract,
  type AccessibilityDecisionData,
  type TakeoverDecisionSubmission,
  type CollaborationTakeoverState,
  type PreservedDraft,
  type TakeoverConfig,
  type TakeoverProjectionUpdate,
  type CollaborationTakeoverView,
} from './types';

// Store and helpers
export {
  CollaborationTakeoverStore,
  validateAnswer,
  deriveTimelineKey,
  buildAccessibilityData,
} from './collaboration-takeover-store';
