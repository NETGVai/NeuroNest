/**
 * CoverageDerivation — Derives requirement coverage from trace links and entity status.
 *
 * - Derives requirement coverage state from trace links and entity status
 * - Coverage states: uncovered, partially_covered, fully_covered, verified
 * - Never uses editable colors or duplicated UI state
 * - Recomputes from authoritative inputs (links + status)
 *
 * Requirements: 11.6
 */

import type { TaskStatus } from './types.js';
import type { TraceLink, TraceLinkRelationship } from './trace-link-service.js';

/**
 * Coverage states derived from links and authoritative status.
 *
 * Matches Requirement 11.6:
 * - uncovered: no links exist from this requirement to implementation entities
 * - partially_covered: some implementing tasks exist but are not all completed
 * - fully_covered: all implementing tasks are completed with evidence
 * - verified: all implementing tasks have passing verification evidence
 */
export type CoverageState = 'uncovered' | 'partially_covered' | 'fully_covered' | 'verified';

/** Status provider interface — resolves entity status from authoritative source */
export interface StatusProvider {
  getTaskStatus(taskId: string): TaskStatus | null;
  hasPassingEvidence(entityId: string): boolean;
}

/** Coverage result for a single requirement */
export interface CoverageResult {
  entityId: string;
  state: CoverageState;
  totalTasks: number;
  completedTasks: number;
  verifiedTasks: number;
  linkedTaskIds: string[];
}

/**
 * CoverageDerivation computes requirement coverage from trace links and authoritative status.
 *
 * It never stores or uses editable colors or duplicated UI state.
 * Coverage is always recomputed from the authoritative inputs.
 */
export class CoverageDerivation {
  private statusProvider: StatusProvider;

  constructor(statusProvider: StatusProvider) {
    this.statusProvider = statusProvider;
  }

  /**
   * Derives the coverage state for a single requirement entity.
   *
   * The derivation logic:
   * 1. Find all trace links where the requirement is the target of a
   *    'satisfies' or 'implements' relationship (tasks implementing this req)
   * 2. Check the authoritative status of each linked task
   * 3. Derive the coverage state from the task statuses and evidence
   */
  deriveCoverage(requirementId: string, links: TraceLink[]): CoverageResult {
    // Find tasks that implement/satisfy this requirement
    const implementingLinks = links.filter(
      (l) =>
        !l.isTombstone &&
        l.targetEntityId === requirementId &&
        (l.relationship === 'satisfies' || l.relationship === 'implements')
    );

    // Also find tasks that are verified_by evidence
    const verificationLinks = links.filter(
      (l) =>
        !l.isTombstone &&
        l.sourceEntityId === requirementId &&
        l.relationship === 'verified_by'
    );

    const linkedTaskIds = [
      ...new Set(implementingLinks.map((l) => l.sourceEntityId)),
    ];

    if (linkedTaskIds.length === 0 && verificationLinks.length === 0) {
      return {
        entityId: requirementId,
        state: 'uncovered',
        totalTasks: 0,
        completedTasks: 0,
        verifiedTasks: 0,
        linkedTaskIds: [],
      };
    }

    let completedCount = 0;
    let verifiedCount = 0;

    for (const taskId of linkedTaskIds) {
      const status = this.statusProvider.getTaskStatus(taskId);
      if (status === 'completed') {
        completedCount++;
        if (this.statusProvider.hasPassingEvidence(taskId)) {
          verifiedCount++;
        }
      }
    }

    // If there are direct verification links, check those too
    const hasDirectVerification = verificationLinks.length > 0 &&
      verificationLinks.every((l) => this.statusProvider.hasPassingEvidence(l.targetEntityId));

    const state = this.computeState(
      linkedTaskIds.length,
      completedCount,
      verifiedCount,
      hasDirectVerification
    );

    return {
      entityId: requirementId,
      state,
      totalTasks: linkedTaskIds.length,
      completedTasks: completedCount,
      verifiedTasks: verifiedCount,
      linkedTaskIds,
    };
  }

  /**
   * Derives coverage for multiple requirements at once.
   */
  deriveCoverageForAll(
    requirementIds: string[],
    links: TraceLink[]
  ): Map<string, CoverageResult> {
    const results = new Map<string, CoverageResult>();
    for (const reqId of requirementIds) {
      results.set(reqId, this.deriveCoverage(reqId, links));
    }
    return results;
  }

  private computeState(
    totalTasks: number,
    completedTasks: number,
    verifiedTasks: number,
    hasDirectVerification: boolean
  ): CoverageState {
    if (totalTasks === 0) {
      // Only direct verification links exist
      return hasDirectVerification ? 'verified' : 'uncovered';
    }

    if (completedTasks === 0) {
      return totalTasks > 0 ? 'partially_covered' : 'uncovered';
    }

    if (verifiedTasks === totalTasks || (completedTasks === totalTasks && hasDirectVerification)) {
      return 'verified';
    }

    if (completedTasks === totalTasks) {
      return 'fully_covered';
    }

    return 'partially_covered';
  }
}
