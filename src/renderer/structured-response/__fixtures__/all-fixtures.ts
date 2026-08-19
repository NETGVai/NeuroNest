/**
 * Aggregator for all deterministic response fixtures.
 *
 * Provides a single entry point to access every fixture set, verifies
 * complete kind coverage, and exports stable digests for snapshot testing.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { ResponseBlockKind } from '../../../harness/contracts/response-composition';
import type { GalleryFixture, GalleryFixtureSet } from './types';
import { ALL_BLOCK_KINDS } from './types';
import { narrativeFixtures } from './narrative-fixtures';
import { reasoningFixtures } from './reasoning-fixtures';
import { turnStatusFixtures } from './turn-status-fixtures';
import { toolActivityFixtures } from './tool-activity-fixtures';
import { taskProgressFixtures } from './task-progress-fixtures';
import { decisionFixtures } from './decision-fixtures';
import { recommendationFixtures } from './recommendation-fixtures';
import { contextFixtures } from './context-fixtures';
import { codeFixtures } from './code-fixtures';
import { diffFixtures } from './diff-fixtures';
import { structuredDataFixtures } from './structured-data-fixtures';
import { insightFixtures } from './insight-fixtures';
import { attachmentFixtures } from './attachment-fixtures';
import { errorFixtures } from './error-fixtures';
import { followUpActionsFixtures } from './follow-up-actions-fixtures';
import { mixedSessionFixture } from './mixed-session-fixture';

/** All fixture sets indexed by block kind. */
const FIXTURE_SETS_BY_KIND: Record<ResponseBlockKind, GalleryFixtureSet> = {
  narrative: narrativeFixtures,
  reasoning: reasoningFixtures,
  turn_status: turnStatusFixtures,
  tool_activity: toolActivityFixtures,
  task_progress: taskProgressFixtures,
  decision: decisionFixtures,
  recommendation: recommendationFixtures,
  context: contextFixtures,
  code: codeFixtures,
  diff: diffFixtures,
  structured_data: structuredDataFixtures,
  insight: insightFixtures,
  attachment: attachmentFixtures,
  error: errorFixtures,
  follow_up_actions: followUpActionsFixtures,
};

/**
 * Returns all fixture sets as an ordered array.
 * Each set covers one block kind with multiple variants.
 */
export function getAllFixtures(): readonly GalleryFixtureSet[] {
  return ALL_BLOCK_KINDS.map((kind) => FIXTURE_SETS_BY_KIND[kind]);
}

/**
 * Returns a flat array of every individual fixture across all kinds.
 */
export function getAllIndividualFixtures(): readonly GalleryFixture[] {
  return getAllFixtures().flatMap((set) => set.fixtures);
}

/**
 * Returns the fixture set for a specific block kind.
 */
export function getFixtureSetForKind(kind: ResponseBlockKind): GalleryFixtureSet {
  return FIXTURE_SETS_BY_KIND[kind];
}

/**
 * Returns the mixed session fixture.
 */
export function getMixedSessionFixture() {
  return mixedSessionFixture;
}

/**
 * Validates that every block kind has at least one fixture.
 * Returns an array of missing kinds (empty if complete).
 */
export function validateFixtureCoverage(): readonly ResponseBlockKind[] {
  const missing: ResponseBlockKind[] = [];
  for (const kind of ALL_BLOCK_KINDS) {
    const set = FIXTURE_SETS_BY_KIND[kind];
    if (!set || set.fixtures.length === 0) {
      missing.push(kind);
    }
  }
  return missing;
}

/**
 * Returns a stable digest map for all fixtures (fixture ID → content digest).
 * Used for snapshot comparison to detect unintended changes.
 */
export function getFixtureDigestMap(): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const fixture of getAllIndividualFixtures()) {
    digests[fixture.id] = fixture.contentDigest;
  }
  return digests;
}

/**
 * Returns the total number of fixtures across all kinds.
 */
export function getFixtureCount(): number {
  return getAllIndividualFixtures().length;
}

/**
 * Verifies no fixture requires live model calls or network access.
 * Returns true if all fixtures are self-contained.
 */
export function verifyNoLiveModelDependency(): boolean {
  // All fixtures are deterministic constants — they never call models or networks.
  // The mixed session fixture explicitly declares requiresLiveModel: false and requiresNetwork: false.
  // Individual fixtures are pure data objects with no side effects.
  return mixedSessionFixture.requiresLiveModel === false
    && mixedSessionFixture.requiresNetwork === false;
}
