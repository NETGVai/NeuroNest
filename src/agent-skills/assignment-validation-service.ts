/**
 * Assignment Validation Service
 *
 * Performs pre-dispatch validation of runtime skill assignments, blocks on any
 * unsafe condition, requires manual identity resolution for ambiguity, rechecks
 * catalog/task fingerprints immediately before dispatch, and rejects stale
 * reconciliation evidence.
 *
 * This service is the final gate before an Agent_Run can be dispatched. It
 * enforces fail-closed semantics: no completeness or safety waiver is permitted.
 *
 * Requirements: 50.3, 50.6, 50.7
 */

import type { AgentSkillsService, AuthoritativeSkillCatalogSnapshot } from './agent-skills-service.js';
import type { BundleSelectionSuccess } from './bundle-selection-service.js';

// ─── Blocking Condition Types ────────────────────────────────────

/**
 * Reasons why assignment or dispatch is blocked.
 * Each reason maps to a specific condition in Requirement 50.6.
 */
export type AssignmentBlockReason =
  | 'uncovered_capability'
  | 'disabled_skill'
  | 'uninstalled_skill'
  | 'incompatible_skill'
  | 'unsafe_skill'
  | 'stale_catalog_snapshot'
  | 'stale_task_fingerprint'
  | 'stale_reconciliation_evidence'
  | 'unresolved_skill'
  | 'multiply_resolved_skill'
  | 'ambiguous_identity'
  | 'no_bundle_state'
  | 'bundle_fingerprint_mismatch'
  | 'manual_resolution_required';

/**
 * A single blocking condition detected during validation.
 */
export interface BlockingCondition {
  /** The specific reason for blocking */
  readonly reason: AssignmentBlockReason;
  /** Human-readable description of the condition */
  readonly description: string;
  /** Affected skill IDs (if applicable) */
  readonly affectedSkillIds: readonly string[];
  /** Affected capability keys (if applicable) */
  readonly affectedCapabilities: readonly string[];
  /** Whether manual resolution is required */
  readonly requiresManualResolution: boolean;
}

// ─── Validation Result Types ─────────────────────────────────────

/**
 * Result of pre-dispatch assignment validation.
 *
 * When `valid` is false, dispatch MUST be blocked. No waiver is permitted.
 *
 * Requirement 50.6: IF any required capability is uncovered or any skill is
 * disabled, uninstalled, incompatible, unsafe, stale, unresolved, or multiply
 * resolved, THEN THE system SHALL block assignment and dispatch until the
 * condition is resolved.
 */
export type AssignmentValidationResult =
  | AssignmentValidationPassed
  | AssignmentValidationBlocked;

export interface AssignmentValidationPassed {
  readonly valid: true;
  /** The validated catalog fingerprint */
  readonly catalogFingerprint: string;
  /** The validated task fingerprint */
  readonly taskFingerprint: string;
  /** The validated bundle fingerprint */
  readonly bundleFingerprint: string;
  /** Timestamp of validation */
  readonly validatedAt: string;
}

export interface AssignmentValidationBlocked {
  readonly valid: false;
  /** All blocking conditions detected */
  readonly blockingConditions: readonly BlockingCondition[];
  /** Summary of why dispatch is blocked */
  readonly summary: string;
  /** Whether any condition requires manual identity resolution */
  readonly requiresManualResolution: boolean;
  /** Timestamp of validation */
  readonly validatedAt: string;
}

// ─── Manual Resolution Types ─────────────────────────────────────

/**
 * Input for manual identity resolution.
 * After manual resolution, complete revalidation is required against
 * the same catalog snapshot and task fingerprint.
 *
 * Requirement 50.6: IDENTITY ambiguity SHALL require manual resolution
 * followed by complete bundle revalidation against the authoritative
 * catalog snapshot and task fingerprint; THE system SHALL NOT permit a
 * waiver of bundle completeness, compatibility, or safety.
 */
export interface ManualResolutionInput {
  /** The agent being resolved */
  readonly agentId: string;
  /** Task for which the resolution applies */
  readonly taskId: string;
  /** Resolved skill IDs after manual disambiguation */
  readonly resolvedSkillIds: readonly string[];
  /** Actor performing the resolution */
  readonly resolvedBy: string;
  /** Reason for the specific resolution chosen */
  readonly resolutionRationale: string;
  /** Catalog fingerprint the resolution was made against */
  readonly catalogFingerprint: string;
  /** Task fingerprint the resolution was made against */
  readonly taskFingerprint: string;
}

/**
 * Record of a manual resolution event.
 */
export interface ManualResolutionRecord {
  readonly resolutionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly resolvedSkillIds: readonly string[];
  readonly resolvedBy: string;
  readonly resolutionRationale: string;
  readonly catalogFingerprint: string;
  readonly taskFingerprint: string;
  readonly resolvedAt: string;
  /** Whether subsequent revalidation passed */
  readonly revalidationPassed: boolean;
}

// ─── Dispatch Pre-Check Types ────────────────────────────────────

/**
 * Input for the immediate pre-dispatch fingerprint recheck.
 *
 * Requirement 50.7: DISPATCH SHALL remain blocked until the
 * Runtime_Skill_Bundle validates against the same catalog snapshot
 * and task fingerprint used to produce its assignment evidence.
 */
export interface DispatchPreCheckInput {
  /** Agent being dispatched */
  readonly agentId: string;
  /** Task being dispatched */
  readonly taskId: string;
  /** Bundle fingerprint from reconciliation */
  readonly expectedBundleFingerprint: string;
  /** Catalog fingerprint from reconciliation */
  readonly expectedCatalogFingerprint: string;
  /** Task fingerprint from reconciliation */
  readonly expectedTaskFingerprint: string;
}

// ─── Persistence Interface ───────────────────────────────────────

/**
 * Persistence interface for manual resolution records.
 */
export interface ResolutionPersistence {
  saveResolution(record: ManualResolutionRecord): void;
  getResolution(agentId: string, taskId: string): ManualResolutionRecord | null;
}

// ─── Compatibility Check Providers ───────────────────────────────

/**
 * Provider for checking skill compatibility with task requirements.
 */
export interface CompatibilityProvider {
  /** Check if a skill is compatible with the task's requirements */
  isCompatible(skillId: string, taskId: string): boolean;
  /** Check if a skill has been marked unsafe */
  isUnsafe(skillId: string): boolean;
}

// ─── Service ─────────────────────────────────────────────────────

/**
 * AssignmentValidationService is the fail-closed gate for runtime
 * skill assignment and dispatch.
 *
 * It enforces:
 * 1. No uncovered capabilities in the bundle
 * 2. No disabled, uninstalled, incompatible, or unsafe skills
 * 3. No unresolved or multiply resolved skill identities
 * 4. No stale catalog snapshots or task fingerprints
 * 5. No stale reconciliation evidence at dispatch time
 * 6. Manual identity resolution when ambiguity is detected
 * 7. Complete revalidation after manual resolution
 *
 * No completeness or safety waiver is permitted. The system MUST fail closed.
 *
 * Requirements: 50.3, 50.6, 50.7
 */
export class AssignmentValidationService {
  constructor(
    private readonly agentSkillsService: AgentSkillsService,
    private readonly compatibilityProvider: CompatibilityProvider,
    private readonly resolutionPersistence: ResolutionPersistence,
  ) {}

  /**
   * Validates a bundle selection result before assignment/reconciliation.
   *
   * Checks all blocking conditions defined in Requirement 50.6.
   * Returns blocked if any condition is detected, with no waiver path.
   *
   * @param agentId - The agent being assigned
   * @param taskId - The task requiring the bundle
   * @param bundleSelection - The resolved bundle from BundleSelectionService
   * @param catalogSnapshot - The current authoritative catalog snapshot
   * @param taskFingerprint - The current task fingerprint
   */
  validateAssignment(
    _agentId: string,
    taskId: string,
    bundleSelection: BundleSelectionSuccess,
    catalogSnapshot: AuthoritativeSkillCatalogSnapshot,
    taskFingerprint: string,
  ): AssignmentValidationResult {
    const conditions: BlockingCondition[] = [];

    // Check 1: Catalog snapshot staleness
    if (bundleSelection.catalogFingerprint !== catalogSnapshot.fingerprint) {
      conditions.push({
        reason: 'stale_catalog_snapshot',
        description: `Catalog snapshot has changed since bundle selection. Expected fingerprint '${bundleSelection.catalogFingerprint}', current is '${catalogSnapshot.fingerprint}'. Bundle must be recomputed against the current catalog.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: false,
      });
    }

    // Check 2: Task fingerprint staleness
    if (bundleSelection.taskFingerprint !== taskFingerprint) {
      conditions.push({
        reason: 'stale_task_fingerprint',
        description: `Task fingerprint has changed since bundle selection. Expected '${bundleSelection.taskFingerprint}', current is '${taskFingerprint}'. Bundle must be recomputed for the current task state.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: false,
      });
    }

    // Check 3: Verify every skill in the bundle is still valid in the catalog
    for (const candidate of bundleSelection.bundle) {
      const catalogEntries = catalogSnapshot.byId.get(candidate.skillId);

      // Check for unresolved skills
      if (!catalogEntries || catalogEntries.length === 0) {
        conditions.push({
          reason: 'unresolved_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) cannot be resolved in the authoritative catalog. It may have been removed or its ID changed.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: true,
        });
        continue;
      }

      // Check for multiply resolved skills
      if (catalogEntries.length > 1) {
        conditions.push({
          reason: 'multiply_resolved_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) resolves to ${catalogEntries.length} entries in the catalog. Identity ambiguity must be resolved manually.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: true,
        });
        continue;
      }

      const entry = catalogEntries[0]!;

      // Check for disabled skills
      if (!entry.enabled) {
        conditions.push({
          reason: 'disabled_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) is disabled in the authoritative catalog.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: false,
        });
      }

      // Check for uninstalled skills
      if (!entry.installed) {
        conditions.push({
          reason: 'uninstalled_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) is not installed.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: false,
        });
      }

      // Check for incompatible skills
      if (!this.compatibilityProvider.isCompatible(candidate.skillId, taskId)) {
        conditions.push({
          reason: 'incompatible_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) is incompatible with task '${taskId}'.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: false,
        });
      }

      // Check for unsafe skills
      if (this.compatibilityProvider.isUnsafe(candidate.skillId)) {
        conditions.push({
          reason: 'unsafe_skill',
          description: `Skill '${candidate.name}' (${candidate.skillId}) has been marked as unsafe and cannot be assigned.`,
          affectedSkillIds: [candidate.skillId],
          affectedCapabilities: candidate.coveredCapabilities,
          requiresManualResolution: false,
        });
      }
    }

    // Check 4: Verify all derived capabilities are covered
    if (bundleSelection.coverageMap.size > 0) {
      for (const [capKey, coveringSkills] of bundleSelection.coverageMap) {
        if (coveringSkills.length === 0) {
          conditions.push({
            reason: 'uncovered_capability',
            description: `Required capability '${capKey}' is not covered by any skill in the bundle.`,
            affectedSkillIds: [],
            affectedCapabilities: [capKey],
            requiresManualResolution: false,
          });
        }
      }
    }

    // Build result
    if (conditions.length > 0) {
      const requiresManualResolution = conditions.some(c => c.requiresManualResolution);
      return {
        valid: false,
        blockingConditions: Object.freeze(conditions),
        summary: this.buildBlockingSummary(conditions),
        requiresManualResolution,
        validatedAt: new Date().toISOString(),
      };
    }

    return {
      valid: true,
      catalogFingerprint: catalogSnapshot.fingerprint,
      taskFingerprint,
      bundleFingerprint: bundleSelection.bundleFingerprint,
      validatedAt: new Date().toISOString(),
    };
  }

  /**
   * Performs an immediate pre-dispatch fingerprint recheck.
   *
   * This MUST be called immediately before dispatching an Agent_Run.
   * It rechecks catalog and task fingerprints against the stored bundle state
   * and rejects stale reconciliation evidence.
   *
   * Requirement 50.7: DISPATCH SHALL remain blocked until the
   * Runtime_Skill_Bundle validates against the same catalog snapshot and
   * task fingerprint used to produce its assignment evidence.
   *
   * @param input - Dispatch pre-check input with expected fingerprints
   * @param currentCatalogSnapshot - Fresh catalog snapshot at dispatch time
   * @param currentTaskFingerprint - Fresh task fingerprint at dispatch time
   */
  async validatePreDispatch(
    input: DispatchPreCheckInput,
    currentCatalogSnapshot: AuthoritativeSkillCatalogSnapshot,
    currentTaskFingerprint: string,
  ): Promise<AssignmentValidationResult> {
    const conditions: BlockingCondition[] = [];

    // Recheck 1: Catalog snapshot fingerprint must match what was used during reconciliation
    if (input.expectedCatalogFingerprint !== currentCatalogSnapshot.fingerprint) {
      conditions.push({
        reason: 'stale_catalog_snapshot',
        description: `Catalog has changed since reconciliation. Reconciliation used fingerprint '${input.expectedCatalogFingerprint}', current catalog fingerprint is '${currentCatalogSnapshot.fingerprint}'. Reconciliation evidence is stale.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: false,
      });
    }

    // Recheck 2: Task fingerprint must match what was used during reconciliation
    if (input.expectedTaskFingerprint !== currentTaskFingerprint) {
      conditions.push({
        reason: 'stale_task_fingerprint',
        description: `Task has changed since reconciliation. Reconciliation used fingerprint '${input.expectedTaskFingerprint}', current task fingerprint is '${currentTaskFingerprint}'. Bundle must be reselected.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: false,
      });
    }

    // Recheck 3: Bundle state must still exist and match
    const storedState = await this.agentSkillsService.getStoredBundleState(input.agentId);

    if (!storedState) {
      conditions.push({
        reason: 'no_bundle_state',
        description: `No bundle state found for agent '${input.agentId}'. The bundle must be reconciled before dispatch.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: false,
      });
    } else {
      // Verify the stored bundle fingerprint matches what we expect
      if (storedState.bundleFingerprint !== input.expectedBundleFingerprint) {
        conditions.push({
          reason: 'bundle_fingerprint_mismatch',
          description: `Stored bundle fingerprint '${storedState.bundleFingerprint}' does not match expected '${input.expectedBundleFingerprint}'. Reconciliation evidence is stale.`,
          affectedSkillIds: [],
          affectedCapabilities: [],
          requiresManualResolution: false,
        });
      }

      // Verify the stored catalog fingerprint hasn't drifted
      if (storedState.catalogFingerprint !== currentCatalogSnapshot.fingerprint) {
        conditions.push({
          reason: 'stale_reconciliation_evidence',
          description: `Bundle state was reconciled against catalog fingerprint '${storedState.catalogFingerprint}', but current catalog fingerprint is '${currentCatalogSnapshot.fingerprint}'. Evidence is stale.`,
          affectedSkillIds: [],
          affectedCapabilities: [],
          requiresManualResolution: false,
        });
      }

      // Verify every skill in the stored bundle is still valid
      const storedSkillIds = JSON.parse(storedState.skillIdsJson) as string[];
      for (const skillId of storedSkillIds) {
        const entries = currentCatalogSnapshot.byId.get(skillId);

        if (!entries || entries.length === 0) {
          conditions.push({
            reason: 'unresolved_skill',
            description: `Assigned skill '${skillId}' is no longer in the catalog at dispatch time.`,
            affectedSkillIds: [skillId],
            affectedCapabilities: [],
            requiresManualResolution: true,
          });
        } else if (entries.length > 1) {
          conditions.push({
            reason: 'multiply_resolved_skill',
            description: `Assigned skill '${skillId}' now resolves to ${entries.length} catalog entries at dispatch time. Identity ambiguity requires manual resolution.`,
            affectedSkillIds: [skillId],
            affectedCapabilities: [],
            requiresManualResolution: true,
          });
        } else {
          const entry = entries[0]!;
          if (!entry.enabled) {
            conditions.push({
              reason: 'disabled_skill',
              description: `Assigned skill '${skillId}' has been disabled since reconciliation.`,
              affectedSkillIds: [skillId],
              affectedCapabilities: [],
              requiresManualResolution: false,
            });
          }
          if (!entry.installed) {
            conditions.push({
              reason: 'uninstalled_skill',
              description: `Assigned skill '${skillId}' has been uninstalled since reconciliation.`,
              affectedSkillIds: [skillId],
              affectedCapabilities: [],
              requiresManualResolution: false,
            });
          }
          if (this.compatibilityProvider.isUnsafe(skillId)) {
            conditions.push({
              reason: 'unsafe_skill',
              description: `Assigned skill '${skillId}' has been marked unsafe since reconciliation.`,
              affectedSkillIds: [skillId],
              affectedCapabilities: [],
              requiresManualResolution: false,
            });
          }
          if (!this.compatibilityProvider.isCompatible(skillId, input.taskId)) {
            conditions.push({
              reason: 'incompatible_skill',
              description: `Assigned skill '${skillId}' is now incompatible with task '${input.taskId}'.`,
              affectedSkillIds: [skillId],
              affectedCapabilities: [],
              requiresManualResolution: false,
            });
          }
        }
      }
    }

    // Build result
    if (conditions.length > 0) {
      const requiresManualResolution = conditions.some(c => c.requiresManualResolution);
      return {
        valid: false,
        blockingConditions: Object.freeze(conditions),
        summary: this.buildBlockingSummary(conditions),
        requiresManualResolution,
        validatedAt: new Date().toISOString(),
      };
    }

    return {
      valid: true,
      catalogFingerprint: currentCatalogSnapshot.fingerprint,
      taskFingerprint: currentTaskFingerprint,
      bundleFingerprint: input.expectedBundleFingerprint,
      validatedAt: new Date().toISOString(),
    };
  }

  /**
   * Records a manual identity resolution and triggers complete revalidation.
   *
   * Requirement 50.6: IDENTITY ambiguity SHALL require manual resolution
   * followed by complete bundle revalidation against the authoritative
   * catalog snapshot and task fingerprint.
   *
   * After resolution, the caller MUST rerun bundle selection and reconciliation
   * against the same catalog snapshot and task fingerprint. This method
   * validates that the resolution itself is internally consistent.
   *
   * @param resolution - The manual resolution input
   * @param currentCatalogSnapshot - The catalog snapshot at resolution time
   * @param currentTaskFingerprint - The task fingerprint at resolution time
   * @returns The validation result after checking the resolution
   */
  recordManualResolution(
    resolution: ManualResolutionInput,
    currentCatalogSnapshot: AuthoritativeSkillCatalogSnapshot,
    currentTaskFingerprint: string,
  ): AssignmentValidationResult {
    const conditions: BlockingCondition[] = [];

    // Verify resolution was made against current state
    if (resolution.catalogFingerprint !== currentCatalogSnapshot.fingerprint) {
      conditions.push({
        reason: 'stale_catalog_snapshot',
        description: `Manual resolution was made against catalog fingerprint '${resolution.catalogFingerprint}', but current catalog fingerprint is '${currentCatalogSnapshot.fingerprint}'. Resolution must be repeated against the current catalog.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: true,
      });
    }

    if (resolution.taskFingerprint !== currentTaskFingerprint) {
      conditions.push({
        reason: 'stale_task_fingerprint',
        description: `Manual resolution was made against task fingerprint '${resolution.taskFingerprint}', but current task fingerprint is '${currentTaskFingerprint}'. Resolution must be repeated against the current task.`,
        affectedSkillIds: [],
        affectedCapabilities: [],
        requiresManualResolution: true,
      });
    }

    // Validate resolved skill IDs exist and are eligible in the catalog
    for (const skillId of resolution.resolvedSkillIds) {
      const entries = currentCatalogSnapshot.byId.get(skillId);

      if (!entries || entries.length === 0) {
        conditions.push({
          reason: 'unresolved_skill',
          description: `Resolved skill '${skillId}' cannot be found in the authoritative catalog.`,
          affectedSkillIds: [skillId],
          affectedCapabilities: [],
          requiresManualResolution: true,
        });
      } else if (entries.length > 1) {
        conditions.push({
          reason: 'multiply_resolved_skill',
          description: `Resolved skill '${skillId}' still has ${entries.length} entries. Resolution did not disambiguate.`,
          affectedSkillIds: [skillId],
          affectedCapabilities: [],
          requiresManualResolution: true,
        });
      } else {
        const entry = entries[0]!;
        if (!entry.enabled) {
          conditions.push({
            reason: 'disabled_skill',
            description: `Resolved skill '${skillId}' is disabled in the catalog.`,
            affectedSkillIds: [skillId],
            affectedCapabilities: [],
            requiresManualResolution: false,
          });
        }
        if (!entry.installed) {
          conditions.push({
            reason: 'uninstalled_skill',
            description: `Resolved skill '${skillId}' is not installed.`,
            affectedSkillIds: [skillId],
            affectedCapabilities: [],
            requiresManualResolution: false,
          });
        }
        if (this.compatibilityProvider.isUnsafe(skillId)) {
          conditions.push({
            reason: 'unsafe_skill',
            description: `Resolved skill '${skillId}' is marked as unsafe.`,
            affectedSkillIds: [skillId],
            affectedCapabilities: [],
            requiresManualResolution: false,
          });
        }
      }
    }

    // If all checks pass, persist the resolution record
    if (conditions.length === 0) {
      const record: ManualResolutionRecord = {
        resolutionId: generateResolutionId(),
        agentId: resolution.agentId,
        taskId: resolution.taskId,
        resolvedSkillIds: [...resolution.resolvedSkillIds],
        resolvedBy: resolution.resolvedBy,
        resolutionRationale: resolution.resolutionRationale,
        catalogFingerprint: resolution.catalogFingerprint,
        taskFingerprint: resolution.taskFingerprint,
        resolvedAt: new Date().toISOString(),
        revalidationPassed: false, // Will be updated after complete revalidation
      };
      this.resolutionPersistence.saveResolution(record);

      return {
        valid: true,
        catalogFingerprint: currentCatalogSnapshot.fingerprint,
        taskFingerprint: currentTaskFingerprint,
        bundleFingerprint: '', // Must be filled by subsequent bundle recomputation
        validatedAt: new Date().toISOString(),
      };
    }

    return {
      valid: false,
      blockingConditions: Object.freeze(conditions),
      summary: this.buildBlockingSummary(conditions),
      requiresManualResolution: conditions.some(c => c.requiresManualResolution),
      validatedAt: new Date().toISOString(),
    };
  }

  /**
   * Builds a human-readable summary from blocking conditions.
   */
  private buildBlockingSummary(conditions: readonly BlockingCondition[]): string {
    const uniqueReasons = [...new Set(conditions.map(c => c.reason))];
    const parts: string[] = [];

    if (uniqueReasons.includes('stale_catalog_snapshot') || uniqueReasons.includes('stale_reconciliation_evidence')) {
      parts.push('catalog snapshot is stale');
    }
    if (uniqueReasons.includes('stale_task_fingerprint')) {
      parts.push('task fingerprint is stale');
    }
    if (uniqueReasons.includes('uncovered_capability')) {
      const uncovered = conditions
        .filter(c => c.reason === 'uncovered_capability')
        .flatMap(c => c.affectedCapabilities);
      parts.push(`${uncovered.length} uncovered capability(ies)`);
    }
    if (uniqueReasons.includes('disabled_skill')) {
      parts.push('disabled skill(s) in bundle');
    }
    if (uniqueReasons.includes('uninstalled_skill')) {
      parts.push('uninstalled skill(s) in bundle');
    }
    if (uniqueReasons.includes('incompatible_skill')) {
      parts.push('incompatible skill(s) in bundle');
    }
    if (uniqueReasons.includes('unsafe_skill')) {
      parts.push('unsafe skill(s) in bundle');
    }
    if (uniqueReasons.includes('unresolved_skill')) {
      parts.push('unresolved skill identity(ies)');
    }
    if (uniqueReasons.includes('multiply_resolved_skill')) {
      parts.push('ambiguous skill identity(ies)');
    }
    if (uniqueReasons.includes('no_bundle_state')) {
      parts.push('no reconciled bundle state');
    }
    if (uniqueReasons.includes('bundle_fingerprint_mismatch')) {
      parts.push('bundle fingerprint mismatch');
    }

    const reasonText = parts.length > 0 ? parts.join('; ') : 'unknown condition(s)';
    return `Assignment and dispatch blocked: ${reasonText}. No completeness or safety waiver permitted.`;
  }
}

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Generate a unique resolution record ID.
 */
function generateResolutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `res-${timestamp}-${random}`;
}
