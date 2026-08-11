/**
 * Authoritative Skill Reader
 *
 * Single entry point for runtime consumers that need to read an agent's
 * reconciled persisted skill bundle. During transition, the old in-memory
 * assignment path (agent-skill-bundle.ts) is retained as a non-authoritative
 * compatibility fallback but is explicitly prohibited from completion decisions.
 *
 * Consumers MUST use this module's APIs for:
 *  - routing decisions
 *  - task capability checks
 *  - completion gate inputs
 *  - skill coverage equality verification
 *
 * The in-memory path remains read-only compatibility for:
 *  - legacy UI displays during transition
 *  - template path lookups (getTemplatePath)
 *  - backward-compatible import side-effects
 *
 * Requirements: 10.3, 10.11–10.15, 10.20–10.22
 */

import { getAgentSkillsService } from './main-process-integration.js';
import type { AgentSkillAssignment, AgentSkillsService } from './agent-skills-service.js';
import { getAgentSkills as getInMemoryAgentSkills } from './agent-skill-bundle.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * The authoritative resolved skill bundle for one agent.
 *
 * `source` indicates which path produced the data:
 *  - 'persisted': authoritative reconciled bundle from the Assignment_Store
 *  - 'in-memory-fallback': non-authoritative legacy data (cannot be used for completion)
 *  - 'unavailable': neither path could produce results
 */
export interface AuthoritativeSkillRead {
  readonly agentId: string;
  readonly skillIds: readonly string[];
  readonly source: 'persisted' | 'in-memory-fallback' | 'unavailable';
  readonly assignments: readonly AgentSkillAssignment[];
  /** True when the persisted path was used or no data was needed. */
  readonly authoritative: boolean;
}

/**
 * Parity check result between the persisted and in-memory paths.
 * Used as a rollback guard before retiring the in-memory authority.
 */
export interface SkillParityCheck {
  readonly agentId: string;
  readonly persisted: readonly string[];
  readonly inMemory: readonly string[];
  readonly match: boolean;
  readonly missingFromPersisted: readonly string[];
  readonly extraInPersisted: readonly string[];
}

/**
 * Rollback guard result for a batch of agents.
 */
export interface RollbackGuardResult {
  readonly totalChecked: number;
  readonly totalMatch: number;
  readonly totalMismatch: number;
  readonly mismatches: readonly SkillParityCheck[];
  readonly canRetireInMemory: boolean;
}

// ─────────────────────────────────────────────
// Authoritative Read API
// ─────────────────────────────────────────────

/**
 * Reads the authoritative reconciled persisted skill bundle for an agent.
 *
 * If the persisted service is available and returns assignments, those are
 * authoritative. If unavailable, falls back to the in-memory path as
 * non-authoritative compatibility data.
 *
 * Completion decisions MUST only use results where `authoritative === true`.
 *
 * Requirements: 10.3, 10.11, 10.14, 10.15
 */
export async function readAuthoritativeSkillBundle(
  agentId: string,
): Promise<AuthoritativeSkillRead> {
  const service = getAgentSkillsService();

  if (service) {
    try {
      const assignments = await service.getAgentSkills(agentId);
      const skillIds = assignments.map(a => a.skill_id).sort();

      return {
        agentId,
        skillIds: Object.freeze(skillIds),
        source: 'persisted',
        assignments: Object.freeze(assignments),
        authoritative: true,
      };
    } catch (error) {
      logger.warn('Failed to read persisted skill bundle — falling back to in-memory', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Non-authoritative fallback — prohibited from completion decisions
  const inMemoryResult = getInMemoryAgentSkills(agentId);
  const skillIds = [...inMemoryResult.skillIds].sort();

  return {
    agentId,
    skillIds: Object.freeze(skillIds),
    source: 'in-memory-fallback',
    assignments: Object.freeze([]),
    authoritative: false,
  };
}

/**
 * Synchronous read from the persisted service for contexts that already
 * have a service reference. Returns null if the service is unavailable.
 *
 * Requirements: 10.3, 10.11
 */
export async function readAuthoritativeSkillBundleFromService(
  service: AgentSkillsService,
  agentId: string,
): Promise<AuthoritativeSkillRead> {
  try {
    const assignments = await service.getAgentSkills(agentId);
    const skillIds = assignments.map(a => a.skill_id).sort();

    return {
      agentId,
      skillIds: Object.freeze(skillIds),
      source: 'persisted',
      assignments: Object.freeze(assignments),
      authoritative: true,
    };
  } catch (error) {
    logger.warn('Failed to read persisted skill bundle from service', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      agentId,
      skillIds: Object.freeze([]),
      source: 'unavailable',
      assignments: Object.freeze([]),
      authoritative: false,
    };
  }
}

// ─────────────────────────────────────────────
// Completion Gate Guard
// ─────────────────────────────────────────────

/**
 * Asserts that a skill read is authoritative before allowing it to
 * participate in completion decisions.
 *
 * Throws if the source is non-authoritative. This prevents the in-memory
 * path from influencing the completion gate.
 *
 * Requirements: 10.20–10.22
 */
export function assertAuthoritativeForCompletion(
  read: AuthoritativeSkillRead,
): asserts read is AuthoritativeSkillRead & { authoritative: true; source: 'persisted' } {
  if (!read.authoritative || read.source !== 'persisted') {
    throw new NonAuthoritativeSkillError(
      `Skill read for agent '${read.agentId}' is non-authoritative (source: ${read.source}). ` +
      `Completion decisions require the persisted authoritative service path.`
    );
  }
}

/**
 * Returns true only if the read came from the authoritative persisted path.
 * Use this for conditional logic that must not proceed with in-memory data.
 *
 * Requirements: 10.20–10.22
 */
export function isAuthoritative(read: AuthoritativeSkillRead): boolean {
  return read.authoritative && read.source === 'persisted';
}

// ─────────────────────────────────────────────
// Parity and Rollback Guards
// ─────────────────────────────────────────────

/**
 * Checks parity between the persisted and in-memory skill assignments for one
 * agent. Used to verify that the persisted path contains the expected data
 * before retiring the in-memory authority.
 *
 * Requirements: 10.11, 10.13–10.15
 */
export async function checkSkillParity(
  agentId: string,
): Promise<SkillParityCheck> {
  const service = getAgentSkillsService();
  let persisted: string[] = [];

  if (service) {
    try {
      const assignments = await service.getAgentSkills(agentId);
      persisted = assignments.map(a => a.skill_id).sort();
    } catch {
      // If service fails, persisted remains empty
    }
  }

  const inMemoryResult = getInMemoryAgentSkills(agentId);
  const inMemory = [...inMemoryResult.skillIds].sort();

  const persistedSet = new Set(persisted);
  const inMemorySet = new Set(inMemory);

  const missingFromPersisted = inMemory.filter(id => !persistedSet.has(id));
  const extraInPersisted = persisted.filter(id => !inMemorySet.has(id));

  return {
    agentId,
    persisted: Object.freeze(persisted),
    inMemory: Object.freeze(inMemory),
    match: missingFromPersisted.length === 0 && extraInPersisted.length === 0,
    missingFromPersisted: Object.freeze(missingFromPersisted),
    extraInPersisted: Object.freeze(extraInPersisted),
  };
}

/**
 * Runs a batch parity check across all agents that have in-memory assignments.
 * Returns a rollback guard result indicating whether it is safe to retire the
 * in-memory authority.
 *
 * The `canRetireInMemory` flag is true only when ALL agents show parity.
 * Any mismatch indicates the persisted path has not been fully reconciled,
 * and the in-memory path should be retained as compatibility.
 *
 * Requirements: 10.11, 10.13–10.15
 */
export async function runRollbackGuard(
  agentIds: readonly string[],
): Promise<RollbackGuardResult> {
  const results: SkillParityCheck[] = [];
  let totalMatch = 0;
  let totalMismatch = 0;

  for (const agentId of agentIds) {
    const check = await checkSkillParity(agentId);
    results.push(check);
    if (check.match) {
      totalMatch++;
    } else {
      totalMismatch++;
    }
  }

  const mismatches = results.filter(r => !r.match);

  return {
    totalChecked: agentIds.length,
    totalMatch,
    totalMismatch,
    mismatches: Object.freeze(mismatches),
    canRetireInMemory: totalMismatch === 0 && agentIds.length > 0,
  };
}

/**
 * Checks whether the persisted service is healthy and can serve as the
 * sole authority. This guard must pass before any code path retires
 * the in-memory assignment maps.
 *
 * Requirements: 10.14, 10.15
 */
export async function checkPersistedServiceHealth(): Promise<{
  healthy: boolean;
  snapshotAvailable: boolean;
  message: string;
}> {
  const service = getAgentSkillsService();

  if (!service) {
    return {
      healthy: false,
      snapshotAvailable: false,
      message: 'AgentSkillsService not initialized',
    };
  }

  try {
    const health = await service.checkHealth();
    let snapshotAvailable = false;

    try {
      const snapshot = await service.getAuthoritativeCatalogSnapshot();
      snapshotAvailable = snapshot.entries.length > 0;
    } catch {
      snapshotAvailable = false;
    }

    return {
      healthy: health.healthy,
      snapshotAvailable,
      message: health.message,
    };
  } catch (error) {
    return {
      healthy: false,
      snapshotAvailable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────

/**
 * Error thrown when a non-authoritative skill read is used in a context
 * that requires authoritative data (e.g., completion decisions).
 */
export class NonAuthoritativeSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonAuthoritativeSkillError';
  }
}
