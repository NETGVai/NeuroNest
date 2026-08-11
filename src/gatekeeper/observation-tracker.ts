/**
 * Observation Tracker — Records data-flow provenance and enforces access
 * policies on derived outputs.
 *
 * Provides:
 * - Recording of resource observations (reads) by agents/gadgets
 * - Permission verification against all observed resources for a gadget
 * - Data flow lattice enforcement (public < internal < confidential < restricted)
 * - Policy-driven blocking of operations that violate access level constraints
 * - Integration point for Gatekeeper to auto-record observations on reads
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ObservationTracker,
  Observation,
  DataFlowPolicy,
  AccessCheckResult,
  FlowDecision,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';

// ─── Access Level Lattice ───────────────────────────────────────

/**
 * Access level ordering: public < internal < confidential < restricted.
 * Data flows UP in restriction level only, never DOWN.
 */
const ACCESS_LEVEL_ORDER: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Returns the numeric rank of an access level.
 * Unknown levels are treated as maximally restricted to fail-closed.
 */
function accessLevelRank(level: string): number {
  return ACCESS_LEVEL_ORDER[level] ?? 4;
}

/**
 * Determines allowed destination levels for a given source level.
 * Data can flow to equal or more-restricted destinations only.
 */
function getAllowedDestinations(sourceLevel: string): string[] {
  const sourceRank = accessLevelRank(sourceLevel);
  return Object.entries(ACCESS_LEVEL_ORDER)
    .filter(([, rank]) => rank >= sourceRank)
    .map(([level]) => level);
}

// ─── Row Types ──────────────────────────────────────────────────

interface ObservationRow {
  id: string;
  actor_id: string;
  actor_type: string;
  resource_id: string;
  data_scope: string;
  access_level: string;
  capability_id: string;
  timestamp: string;
}

interface DataFlowPolicyRow {
  id: string;
  name: string;
  source_access_level: string;
  allowed_destinations: string;
  blocked_operations: string;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the ObservationTracker.
 */
export interface ObservationTrackerConfig {
  db: Database.Database;
  /**
   * Optional callback to check if a user has permission for a specific resource.
   * Returns true if the user has access, false otherwise.
   */
  checkUserPermission?: (userId: string, resourceId: string) => boolean;
}

// ─── Implementation ─────────────────────────────────────────────

export class ObservationTrackerImpl implements ObservationTracker {
  private db: Database.Database;
  private checkUserPermission: (userId: string, resourceId: string) => boolean;

  // Prepared statements
  private stmtInsertObservation: Database.Statement;
  private stmtGetObservationsByActor: Database.Statement;
  private stmtDeleteObservationsByActor: Database.Statement;
  private stmtGetPoliciesBySourceLevel: Database.Statement;

  constructor(config: ObservationTrackerConfig) {
    this.db = config.db;
    // Default: no permissions (fail-closed)
    this.checkUserPermission = config.checkUserPermission ?? (() => false);

    this.stmtInsertObservation = this.db.prepare(`
      INSERT INTO observations (id, actor_id, actor_type, resource_id, data_scope, access_level, capability_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetObservationsByActor = this.db.prepare(`
      SELECT * FROM observations WHERE actor_id = ? ORDER BY timestamp ASC
    `);

    this.stmtDeleteObservationsByActor = this.db.prepare(`
      DELETE FROM observations WHERE actor_id = ?
    `);

    this.stmtGetPoliciesBySourceLevel = this.db.prepare(`
      SELECT * FROM data_flow_policies WHERE source_access_level = ?
    `);
  }

  // ─── Core Interface Methods ───────────────────────────────────

  /**
   * Record an observation when an agent or gadget reads data through a
   * capability binding.
   *
   * Requirement 5.1: WHEN an agent or Gadget reads data through a Capability_Binding,
   * THE Observation_Tracker SHALL record the observation.
   */
  recordObservation(obs: Omit<Observation, 'id' | 'timestamp'>): Observation {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const observation: Observation = {
      ...obs,
      id,
      timestamp,
    };

    this.stmtInsertObservation.run(
      observation.id,
      observation.actorId,
      observation.actorType,
      observation.resourceId,
      observation.dataScope,
      observation.accessLevel,
      observation.capabilityId,
      observation.timestamp,
    );

    return observation;
  }

  /**
   * Get all observations for a given actor (agent or gadget).
   */
  getObservations(actorId: string): Observation[] {
    const rows = this.stmtGetObservationsByActor.all(actorId) as ObservationRow[];
    return rows.map(this.rowToObservation);
  }

  /**
   * Check if a user has access to a gadget's output by verifying permissions
   * against ALL observed resources.
   *
   * Requirement 5.2: WHEN another user attempts to access a Gadget's output,
   * THE Observation_Tracker SHALL verify that user's access to all resources
   * recorded in the observation log before granting access.
   *
   * Requirement 5.3: IF a user does not have access to one or more observed
   * resources, THEN deny access and inform which permissions are missing.
   * IF the permission check encounters an error, report already-identified
   * missing permissions along with the error indication.
   */
  checkAccess(userId: string, gadgetId: string): AccessCheckResult {
    const observations = this.getObservations(gadgetId);

    if (observations.length === 0) {
      return {
        allowed: true,
        missingPermissions: [],
        observedResources: [],
      };
    }

    const observedResources = [...new Set(observations.map((o) => o.resourceId))];
    const missingPermissions: string[] = [];
    let encounteredError = false;

    for (const resourceId of observedResources) {
      try {
        const hasAccess = this.checkUserPermission(userId, resourceId);
        if (!hasAccess) {
          missingPermissions.push(resourceId);
        }
      } catch {
        // If permission check encounters an error, we still report
        // already-identified missing permissions along with error indication
        encounteredError = true;
      }
    }

    const result: AccessCheckResult = {
      allowed: missingPermissions.length === 0 && !encounteredError,
      missingPermissions,
      observedResources,
    };

    if (encounteredError) {
      result.allowed = false;
      result.error = 'Permission check encountered an error for one or more resources';
    }

    return result;
  }

  /**
   * Evaluate whether a data flow from an actor to a destination is permitted
   * based on the access level lattice.
   *
   * Requirement 5.4: THE Observation_Tracker SHALL enforce data-flow policies
   * that prevent agents from writing observed sensitive data to destinations
   * with weaker access controls than the source.
   *
   * Requirement 5.5: WHEN an agent's observation log indicates access to sensitive
   * resources, THE Observation_Tracker SHALL restrict the agent's ability to share
   * outputs to destinations not covered by the observation policy.
   *
   * Data Flow Rules:
   * - public → can flow anywhere
   * - internal → can flow to internal, confidential, restricted
   * - confidential → can flow to confidential, restricted
   * - restricted → cannot flow to any less-restricted destination
   */
  evaluateDataFlow(actorId: string, destination: string, operation: string): FlowDecision {
    const observations = this.getObservations(actorId);

    if (observations.length === 0) {
      return {
        allowed: true,
        reason: 'No observations recorded; data flow permitted',
      };
    }

    // Determine the highest (most restrictive) access level in the actor's observations
    const highestLevel = this.getHighestAccessLevel(observations);
    const destinationRank = accessLevelRank(destination);
    const sourceRank = accessLevelRank(highestLevel);

    // Check if data can flow from the highest observed level to the destination
    // Data flows UP (to equal or higher restriction) only, never DOWN
    if (destinationRank < sourceRank) {
      // Check explicit policies first
      const policyViolation = this.checkPolicyViolation(highestLevel, destination, operation);
      if (policyViolation) {
        return policyViolation;
      }

      return {
        allowed: false,
        reason: `Data flow denied: source access level "${highestLevel}" cannot flow to less-restricted destination "${destination}". ` +
          `Data may only flow to destinations with equal or higher restriction.`,
      };
    }

    // Check for operation-specific blocking via policies
    const operationBlock = this.checkOperationBlocked(highestLevel, operation);
    if (operationBlock) {
      return operationBlock;
    }

    return {
      allowed: true,
      reason: `Data flow permitted: destination "${destination}" has equal or higher restriction than source "${highestLevel}"`,
    };
  }

  /**
   * Get the list of permissions that a user is missing relative to a set of observations.
   *
   * Requirement 5.3: THE Observation_Tracker SHALL inform the requesting user
   * which specific permissions are missing.
   */
  getMissingPermissions(userId: string, observations: Observation[]): string[] {
    const resourceIds = [...new Set(observations.map((o) => o.resourceId))];
    const missing: string[] = [];

    for (const resourceId of resourceIds) {
      try {
        const hasAccess = this.checkUserPermission(userId, resourceId);
        if (!hasAccess) {
          missing.push(resourceId);
        }
      } catch {
        // On error, include the resource as potentially missing
        missing.push(resourceId);
      }
    }

    return missing;
  }

  /**
   * Clear all observations for an actor.
   * Used when resetting an agent's observation state.
   */
  clearObservations(actorId: string): void {
    this.stmtDeleteObservationsByActor.run(actorId);
  }

  // ─── Policy Management ────────────────────────────────────────

  /**
   * Add a data flow policy to the database.
   * Policies define what destinations are allowed for a given source access level
   * and which operations are blocked.
   */
  addPolicy(policy: Omit<DataFlowPolicy, 'id'>): DataFlowPolicy {
    const id = randomUUID();
    const fullPolicy: DataFlowPolicy = { ...policy, id };

    this.db.prepare(`
      INSERT INTO data_flow_policies (id, name, source_access_level, allowed_destinations, blocked_operations)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      fullPolicy.id,
      fullPolicy.name,
      fullPolicy.sourceAccessLevel,
      JSON.stringify(fullPolicy.allowedDestinations),
      JSON.stringify(fullPolicy.blockedOperations),
    );

    return fullPolicy;
  }

  /**
   * Get all policies for a given source access level.
   */
  getPolicies(sourceAccessLevel: string): DataFlowPolicy[] {
    const rows = this.stmtGetPoliciesBySourceLevel.all(sourceAccessLevel) as DataFlowPolicyRow[];
    return rows.map(this.rowToPolicy);
  }

  /**
   * Remove a policy by ID.
   */
  removePolicy(policyId: string): void {
    this.db.prepare('DELETE FROM data_flow_policies WHERE id = ?').run(policyId);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Determine the highest (most restrictive) access level from a set of observations.
   */
  private getHighestAccessLevel(observations: Observation[]): string {
    let highestRank = -1;
    let highestLevel = 'public';

    for (const obs of observations) {
      const rank = accessLevelRank(obs.accessLevel);
      if (rank > highestRank) {
        highestRank = rank;
        highestLevel = obs.accessLevel;
      }
    }

    return highestLevel;
  }

  /**
   * Check if there's a policy violation for a specific source→destination flow.
   */
  private checkPolicyViolation(
    sourceLevel: string,
    destination: string,
    _operation: string,
  ): FlowDecision | null {
    const policies = this.getPolicies(sourceLevel);

    for (const policy of policies) {
      if (!policy.allowedDestinations.includes(destination)) {
        return {
          allowed: false,
          reason: `Policy "${policy.name}" does not allow flow from "${sourceLevel}" to "${destination}"`,
          violatedPolicyId: policy.id,
        };
      }
    }

    return null;
  }

  /**
   * Check if an operation is blocked by a policy for the given access level.
   */
  private checkOperationBlocked(
    sourceLevel: string,
    operation: string,
  ): FlowDecision | null {
    const policies = this.getPolicies(sourceLevel);

    for (const policy of policies) {
      if (policy.blockedOperations.includes(operation)) {
        return {
          allowed: false,
          reason: `Policy "${policy.name}" blocks operation "${operation}" for access level "${sourceLevel}"`,
          violatedPolicyId: policy.id,
        };
      }
    }

    return null;
  }

  // ─── Row Conversion ───────────────────────────────────────────

  private rowToObservation(row: ObservationRow): Observation {
    return {
      id: row.id,
      actorId: row.actor_id,
      actorType: row.actor_type as 'agent' | 'gadget',
      resourceId: row.resource_id,
      dataScope: row.data_scope,
      accessLevel: row.access_level as 'public' | 'internal' | 'confidential' | 'restricted',
      timestamp: row.timestamp,
      capabilityId: row.capability_id,
    };
  }

  private rowToPolicy(row: DataFlowPolicyRow): DataFlowPolicy {
    return {
      id: row.id,
      name: row.name,
      sourceAccessLevel: row.source_access_level,
      allowedDestinations: JSON.parse(row.allowed_destinations),
      blockedOperations: JSON.parse(row.blocked_operations),
    };
  }

  // ─── Error Helpers ────────────────────────────────────────────

  private createError(
    code: 'OBSERVATION_ACCESS_DENIED' | 'DATA_FLOW_VIOLATION' | 'PERMISSION_CHECK_FAILED',
    message: string,
    options?: { recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    return createSubsystemError('observation_tracker', code, message, {
      recoverable: options?.recoverable ?? false,
      suggestedAction: options?.suggestedAction,
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create an ObservationTracker instance backed by the given database.
 * The database must have the `observations` and `data_flow_policies` tables (migration 068).
 */
export function createObservationTracker(config: ObservationTrackerConfig): ObservationTracker {
  return new ObservationTrackerImpl(config);
}
