/**
 * Wave2AuthorityCheckpoint — Final Wave 2 authority verification.
 *
 * Verifies before dispatch integration begins that:
 * 1. Markdown/SQLite authority separation is consistent
 * 2. Visual_Taskbar projections match authoritative state (parity)
 * 3. No dependency cycles exist in the task graph
 * 4. Repository_Map freshness meets policy
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7, 29.8, 29.9
 */

import type { RepositoryMapService } from './repository-map-service.js';
import type { FreshnessInfo } from './types.js';

// ─── Types ───────────────────────────────────────────────────────

export type CheckpointCheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckpointCheck {
  name: string;
  status: CheckpointCheckStatus;
  details: string;
  timestamp: number;
}

export interface Wave2CheckpointResult {
  passed: boolean;
  checks: CheckpointCheck[];
  timestamp: number;
  workspaceRevision: string;
}

/** Authority verification input — Markdown authority */
export interface MarkdownAuthorityState {
  /** Number of parsed requirement entities */
  requirementCount: number;
  /** Number of parsed design node entities */
  designNodeCount: number;
  /** Whether all entities have stable IDs */
  allHaveStableIds: boolean;
  /** Fingerprint of the authoritative Markdown content */
  contentFingerprint: string;
}

/** Authority verification input — SQLite authority */
export interface SqliteAuthorityState {
  /** Number of Task records */
  taskCount: number;
  /** Number of Agent_Run records */
  runCount: number;
  /** Whether migration schema is current */
  migrationCurrent: boolean;
  /** Schema fingerprint */
  schemaFingerprint: string;
}

/** Taskbar parity input */
export interface TaskbarParityState {
  /** Tasks projected in the taskbar */
  projectedTaskCount: number;
  /** Tasks in SQLite authority */
  authoritativeTaskCount: number;
  /** Whether counts match */
  countsMatch: boolean;
  /** Mismatched entity IDs */
  mismatchedIds: string[];
}

/** Cycle detection input */
export interface CycleDetectionState {
  /** Whether the graph is acyclic */
  isAcyclic: boolean;
  /** Number of detected cycles */
  cycleCount: number;
  /** Cycle paths (if any) */
  cyclePaths: string[][];
}

// ─── Checkpoint ──────────────────────────────────────────────────

export class Wave2AuthorityCheckpoint {
  private repoMap: RepositoryMapService;

  constructor(repoMap: RepositoryMapService) {
    this.repoMap = repoMap;
  }

  /**
   * Run the complete Wave 2 authority checkpoint.
   *
   * All four checks must pass for dispatch integration to proceed.
   */
  run(
    markdownState: MarkdownAuthorityState,
    sqliteState: SqliteAuthorityState,
    taskbarState: TaskbarParityState,
    cycleState: CycleDetectionState,
  ): Wave2CheckpointResult {
    const checks: CheckpointCheck[] = [];
    const timestamp = Date.now();
    const workspaceRevision = this.repoMap.getWorkspaceRevision();

    // 1. Markdown/SQLite authority check
    checks.push(this.checkMarkdownSqliteAuthority(markdownState, sqliteState));

    // 2. Taskbar parity check
    checks.push(this.checkTaskbarParity(taskbarState));

    // 3. Cycle detection check
    checks.push(this.checkCycleDetection(cycleState));

    // 4. Repository freshness check
    checks.push(this.checkRepositoryFreshness());

    const passed = checks.every((c) => c.status === 'pass');

    return {
      passed,
      checks,
      timestamp,
      workspaceRevision,
    };
  }

  // ── Individual Checks ───────────────────────────────────────────

  private checkMarkdownSqliteAuthority(
    markdown: MarkdownAuthorityState,
    sqlite: SqliteAuthorityState,
  ): CheckpointCheck {
    const issues: string[] = [];

    if (markdown.requirementCount === 0 && markdown.designNodeCount === 0) {
      issues.push('No Markdown entities found (requirements or design nodes)');
    }

    if (!markdown.allHaveStableIds) {
      issues.push('Some Markdown entities lack stable embedded IDs');
    }

    if (!sqlite.migrationCurrent) {
      issues.push('SQLite migration schema is not current');
    }

    if (sqlite.taskCount === 0) {
      issues.push('No Task records in SQLite authority');
    }

    if (!markdown.contentFingerprint) {
      issues.push('Markdown content fingerprint is empty');
    }

    if (!sqlite.schemaFingerprint) {
      issues.push('SQLite schema fingerprint is empty');
    }

    const status: CheckpointCheckStatus = issues.length === 0 ? 'pass' : 'fail';
    const details = issues.length === 0
      ? `Markdown authority: ${markdown.requirementCount} requirements, ${markdown.designNodeCount} design nodes. ` +
        `SQLite authority: ${sqlite.taskCount} tasks, ${sqlite.runCount} runs. Both authorities consistent.`
      : `Authority check failed: ${issues.join('; ')}`;

    return {
      name: 'markdown-sqlite-authority',
      status,
      details,
      timestamp: Date.now(),
    };
  }

  private checkTaskbarParity(state: TaskbarParityState): CheckpointCheck {
    const issues: string[] = [];

    if (!state.countsMatch) {
      issues.push(
        `Task count mismatch: taskbar shows ${state.projectedTaskCount}, ` +
        `authority has ${state.authoritativeTaskCount}`,
      );
    }

    if (state.mismatchedIds.length > 0) {
      issues.push(
        `${state.mismatchedIds.length} entity ID(s) disagree between taskbar and authority`,
      );
    }

    const status: CheckpointCheckStatus = issues.length === 0 ? 'pass' : 'fail';
    const details = issues.length === 0
      ? `Taskbar parity verified: ${state.projectedTaskCount} tasks match authoritative state.`
      : `Parity check failed: ${issues.join('; ')}`;

    return {
      name: 'taskbar-parity',
      status,
      details,
      timestamp: Date.now(),
    };
  }

  private checkCycleDetection(state: CycleDetectionState): CheckpointCheck {
    if (!state.isAcyclic) {
      const cycleDetails = state.cyclePaths
        .slice(0, 3)
        .map((path) => path.join(' → '))
        .join('; ');
      return {
        name: 'cycle-detection',
        status: 'fail',
        details: `${state.cycleCount} dependency cycle(s) detected: ${cycleDetails}`,
        timestamp: Date.now(),
      };
    }

    return {
      name: 'cycle-detection',
      status: 'pass',
      details: 'Task dependency graph is acyclic (DAG verified).',
      timestamp: Date.now(),
    };
  }

  private checkRepositoryFreshness(): CheckpointCheck {
    const freshness: FreshnessInfo = this.repoMap.getFreshness();

    if (freshness.status === 'stale') {
      return {
        name: 'repository-freshness',
        status: 'fail',
        details: `Repository map is stale: ${freshness.staleUris.length} URI(s) need refresh. ` +
          `Last refresh: ${new Date(freshness.lastRefresh).toISOString()}`,
        timestamp: Date.now(),
      };
    }

    if (freshness.status === 'unknown') {
      return {
        name: 'repository-freshness',
        status: 'fail',
        details: 'Repository map freshness is unknown — indexing may not have completed.',
        timestamp: Date.now(),
      };
    }

    return {
      name: 'repository-freshness',
      status: 'pass',
      details: `Repository map is current. Revision: ${freshness.mapVersion.revision}. ` +
        `Last refresh: ${new Date(freshness.lastRefresh).toISOString()}`,
      timestamp: Date.now(),
    };
  }
}
