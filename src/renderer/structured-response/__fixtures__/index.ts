/**
 * Response Gallery Fixtures
 *
 * Comprehensive fixture data for every ResponseBlockV1 kind, lifecycle state,
 * viewport variant, and accessibility mode. Used exclusively by the development
 * gallery and property-based tests.
 *
 * These fixtures require NO live model calls, network requests, or authority access.
 *
 * Requirements: 22.1–22.2, 22.8
 */

export {
  ALL_BLOCK_KINDS,
  ALL_BLOCK_STATUSES,
  ALL_BLOCK_ROLES,
  type GalleryFixture,
  type GalleryFixtureSet,
  type MixedSessionFixture,
  type ThemeVariant,
  type ViewportVariant,
  type AccessibilityVariant,
  type LifecycleVariant,
  type AuthorityStateVariant,
  type SourceStateVariant,
  type FallbackVariant,
} from './types';

export { narrativeFixtures } from './narrative-fixtures';
export { reasoningFixtures } from './reasoning-fixtures';
export { turnStatusFixtures } from './turn-status-fixtures';
export { toolActivityFixtures } from './tool-activity-fixtures';
export { taskProgressFixtures } from './task-progress-fixtures';
export { decisionFixtures } from './decision-fixtures';
export { recommendationFixtures } from './recommendation-fixtures';
export { contextFixtures } from './context-fixtures';
export { codeFixtures } from './code-fixtures';
export { diffFixtures } from './diff-fixtures';
export { structuredDataFixtures } from './structured-data-fixtures';
export { insightFixtures } from './insight-fixtures';
export { attachmentFixtures } from './attachment-fixtures';
export { errorFixtures } from './error-fixtures';
export { followUpActionsFixtures } from './follow-up-actions-fixtures';
export { mixedSessionFixture } from './mixed-session-fixture';
export {
  getAllFixtures,
  getAllIndividualFixtures,
  getFixtureSetForKind,
  getMixedSessionFixture,
  validateFixtureCoverage,
  getFixtureDigestMap,
  getFixtureCount,
  verifyNoLiveModelDependency,
} from './all-fixtures';
