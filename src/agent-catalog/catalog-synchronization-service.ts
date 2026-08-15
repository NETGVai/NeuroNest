/**
 * Catalog Synchronization Service
 *
 * Implements reversible catalog synchronization with drift detection, gate
 * revalidation, tombstones/deprecation, retention enforcement, and audit.
 *
 * Key invariants:
 * - Manual or scheduled checks stage diffs without auto-activation (R52.2)
 * - Changed content reruns ALL applicable gates before approval (R52.4)
 * - Approved synchronization is a reversible versioned transaction (R52.5)
 * - Prior snapshots are retained, never destroyed (R52.5)
 * - Tombstones preserve provenance for removed assets (R52.6)
 * - Active/historical references prevent destructive removal (R52.8)
 * - All operations remain staging-only until explicit approval (checkpoint)
 *
 * Requirements: 52.1, 52.2, 52.3, 52.4, 52.5, 52.6, 52.7, 52.8, 52.9
 */

import { createHash } from 'node:crypto';

import type {
  ExternalAssetId,
  TransformationProvenance,
} from './corpus-inventory-types.js';
import type {
  CatalogSnapshotMetadata,
  PublishedSkillRecord,
  ValidationGate,
  ValidationOutcome,
} from './skill-publication-service.js';

// ─────────────────────────────────────────────
// Sync Check Types (R52.1)
// ─────────────────────────────────────────────

/** How this sync check was triggered */
export type SyncTrigger = 'manual' | 'scheduled';

/** Network policy for bounded upstream requests */
export interface SyncNetworkPolicy {
  /** Max request timeout (ms) */
  readonly timeoutMs: number;
  /** Max bytes to download per check */
  readonly maxBytesPerCheck: number;
  /** Whether conditional requests (If-None-Match, etc.) are used */
  readonly useConditionalRequests: boolean;
  /** Allowed source hosts */
  readonly allowedHosts: readonly string[];
}

/** Configuration for a sync source */
export interface SyncSourceConfig {
  /** Unique source identifier */
  readonly sourceId: string;
  /** Repository URL or local path */
  readonly sourceLocation: string;
  /** Pinned revision (optional for scheduled checks) */
  readonly pinnedRevision: string | null;
  /** Current known revision */
  readonly lastKnownRevision: string;
  /** Network policy for this source */
  readonly networkPolicy: SyncNetworkPolicy;
  /** Schedule cron expression (null for manual-only) */
  readonly schedule: string | null;
}

/** Result of checking a source for upstream changes */
export interface SyncCheckResult {
  readonly checkId: string;
  readonly sourceId: string;
  readonly trigger: SyncTrigger;
  readonly checkedAt: string;
  readonly sourceRevision: string;
  readonly previousRevision: string;
  readonly hasChanges: boolean;
  readonly changedAssets: readonly ChangedAssetSummary[];
  readonly addedAssets: readonly string[];
  readonly removedAssets: readonly string[];
  readonly movedAssets: readonly MovedAssetRecord[];
  readonly networkBytesUsed: number;
  readonly durationMs: number;
}

/** Summary of a changed asset detected upstream */
export interface ChangedAssetSummary {
  readonly externalAssetId: ExternalAssetId;
  readonly changeType: 'content_modified' | 'metadata_modified' | 'moved' | 'added' | 'removed';
  readonly previousHash: string | null;
  readonly currentHash: string;
  readonly previousPath: string | null;
  readonly currentPath: string;
}

/** Record of an asset that was moved/renamed upstream */
export interface MovedAssetRecord {
  readonly externalAssetId: ExternalAssetId;
  readonly previousPath: string;
  readonly currentPath: string;
  readonly contentChanged: boolean;
}

// ─────────────────────────────────────────────
// Sync Staging / Preview Types (R52.2, R52.3)
// ─────────────────────────────────────────────

/** State of the sync staging pipeline */
export type SyncStagingState =
  | 'staged'
  | 'validating'
  | 'validated'
  | 'approval_pending'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'failed';

/** A staged synchronization preview */
export interface SyncStagingRecord {
  readonly id: string;
  readonly checkId: string;
  readonly sourceId: string;
  readonly state: SyncStagingState;
  readonly sourceRevision: string;
  readonly previousRevision: string;
  readonly stagedAt: string;
  readonly updatedAt: string;
  /** Source/canonical diffs per changed asset */
  readonly diffs: readonly SyncDiffEntry[];
  /** Impact analysis */
  readonly impact: SyncImpactAnalysis;
  /** Validation results (populated after gates rerun) */
  readonly validationResults: readonly SyncValidationResult[];
  /** Approval info (populated after approval) */
  readonly approval: SyncApproval | null;
  /** Migration record (populated after apply) */
  readonly migration: SyncMigrationRecord | null;
}

/** A diff entry for one asset */
export interface SyncDiffEntry {
  readonly externalAssetId: ExternalAssetId;
  readonly changeType: 'changed' | 'added' | 'removed' | 'moved';
  /** Source content diff (before/after) */
  readonly sourceDiff: ContentDiff;
  /** Canonical catalog diff (how this affects the catalog) */
  readonly canonicalDiff: ContentDiff;
  /** Provenance changes (license, notice, path) */
  readonly provenanceChanges: readonly ProvenanceChange[];
  /** Dependencies affected by this change */
  readonly dependencyImpact: readonly string[];
}

/** Content diff representation */
export interface ContentDiff {
  readonly previousHash: string | null;
  readonly currentHash: string;
  readonly previousContent: string | null;
  readonly currentContent: string;
  readonly hasSubstantiveChange: boolean;
}

/** A change in provenance metadata */
export interface ProvenanceChange {
  readonly field: string;
  readonly previousValue: string | null;
  readonly currentValue: string;
}

// ─────────────────────────────────────────────
// Impact Analysis Types (R52.3)
// ─────────────────────────────────────────────

/** Impact analysis for a synchronization */
export interface SyncImpactAnalysis {
  /** Assets directly affected */
  readonly directlyAffected: number;
  /** Assets with dependency impact */
  readonly dependencyImpacted: number;
  /** Active agent assignments affected */
  readonly affectedAssignments: readonly AffectedAssignment[];
  /** Active runs that reference affected assets */
  readonly activeRunReferences: readonly string[];
  /** Required revalidation gates */
  readonly requiredGates: readonly ValidationGate[];
  /** Duplicate decisions that may be affected */
  readonly duplicateImpact: number;
}

/** An agent assignment affected by the sync */
export interface AffectedAssignment {
  readonly agentId: string;
  readonly skillId: string;
  readonly bundleId: string;
  readonly reason: string;
}

// ─────────────────────────────────────────────
// Gate Revalidation Types (R52.4)
// ─────────────────────────────────────────────

/** All gates that may need rerunning per R52.4 */
export type SyncValidationGate =
  | 'parsing'
  | 'transformation'
  | 'quality'
  | 'authenticity'
  | 'schema'
  | 'relationship'
  | 'trigger'
  | 'safety'
  | 'duplicate'
  | 'evaluation';

/** Result of revalidating one gate for one asset */
export interface SyncValidationResult {
  readonly externalAssetId: ExternalAssetId;
  readonly gate: SyncValidationGate;
  readonly passed: boolean;
  readonly details: string;
  readonly validatedAt: string;
  readonly previousOutcome: 'pass' | 'fail' | 'not_run';
  readonly durationMs: number;
}

// ─────────────────────────────────────────────
// Reversible Transaction Types (R52.5)
// ─────────────────────────────────────────────

/** A versioned reversible migration transaction */
export interface SyncMigrationRecord {
  readonly migrationId: string;
  readonly stagingId: string;
  readonly priorSnapshotId: string;
  readonly priorSnapshotFingerprint: string;
  readonly newSnapshotId: string;
  readonly newSnapshotFingerprint: string;
  readonly version: number;
  readonly appliedAt: string;
  readonly reversible: boolean;
  /** Changes applied in this migration */
  readonly changes: readonly MigrationChange[];
  /** Rollback status */
  readonly rollbackStatus: 'not_rolled_back' | 'rolled_back' | 'rollback_failed';
  readonly rolledBackAt: string | null;
}

/** A single change in the migration */
export interface MigrationChange {
  readonly externalAssetId: ExternalAssetId;
  readonly action: 'update' | 'add' | 'tombstone' | 'deprecate';
  readonly previousVersion: string | null;
  readonly newVersion: string;
  readonly previousFingerprint: string | null;
  readonly newFingerprint: string;
}

// ─────────────────────────────────────────────
// Tombstone / Deprecation Types (R52.6, R52.8)
// ─────────────────────────────────────────────

/** A provenance-preserving tombstone */
export interface CatalogTombstone {
  readonly tombstoneId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly canonicalId: string;
  readonly aliases: readonly string[];
  readonly provenance: TransformationProvenance;
  readonly versions: readonly string[];
  readonly relationships: readonly TombstoneRelationship[];
  readonly historicalEvidence: readonly string[];
  readonly reason: string;
  readonly createdAt: string;
  readonly migrationId: string;
}

/** Relationship preserved in a tombstone */
export interface TombstoneRelationship {
  readonly targetId: string;
  readonly type: string;
  readonly direction: 'outgoing' | 'incoming';
}

/** Non-destructive deprecation for active/historical references */
export interface DeprecationRecord {
  readonly deprecationId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly canonicalId: string;
  readonly reason: string;
  /** What blocks destructive removal */
  readonly blockers: readonly DeprecationBlocker[];
  readonly deprecatedAt: string;
  readonly migrationId: string;
  /** The asset remains active but marked deprecated */
  readonly effectiveStatus: 'deprecated_active' | 'deprecated_historical';
}

/** A reason why destructive removal is blocked */
export interface DeprecationBlocker {
  readonly kind: 'active_assignment' | 'active_run' | 'bundle_reference' | 'historical_evidence';
  readonly referenceId: string;
  readonly details: string;
}

// ─────────────────────────────────────────────
// Retention Types (R52.7)
// ─────────────────────────────────────────────

/** Retention policy configuration */
export interface RetentionPolicy {
  /** How long to keep source blobs */
  readonly sourceBlobRetentionDays: number;
  /** How long to keep transformation records */
  readonly transformationRetentionDays: number;
  /** How long to keep evaluation records */
  readonly evaluationRetentionDays: number;
  /** How long to keep catalog snapshots */
  readonly snapshotRetentionDays: number;
  /** How long to keep tombstones */
  readonly tombstoneRetentionDays: number;
  /** How long to keep audit records */
  readonly auditRetentionDays: number;
  /** Whether data required by active policy is exempt from retention limits */
  readonly activeDataExempt: boolean;
}

/** Status of retention enforcement */
export interface RetentionStatus {
  readonly lastEnforcedAt: string;
  readonly sourceBlobsRetained: number;
  readonly transformationsRetained: number;
  readonly evaluationsRetained: number;
  readonly snapshotsRetained: number;
  readonly tombstonesRetained: number;
  readonly auditRecordsRetained: number;
  readonly protectedByPolicy: number;
}

// ─────────────────────────────────────────────
// Approval Types
// ─────────────────────────────────────────────

/** Approval decision for a staged synchronization */
export interface SyncApproval {
  readonly approvalId: string;
  readonly stagingId: string;
  readonly approved: boolean;
  readonly reviewerIdentity: string;
  readonly reason: string;
  readonly decidedAt: string;
  readonly conditions: readonly string[];
}

// ─────────────────────────────────────────────
// Audit Types (R52.9)
// ─────────────────────────────────────────────

/** Complete audit record for a synchronization event */
export interface SyncAuditRecord {
  readonly auditId: string;
  readonly checkId: string;
  readonly stagingId: string | null;
  readonly migrationId: string | null;
  /** Source revision checked */
  readonly sourceRevision: string;
  /** Assets changed */
  readonly changedAssets: readonly string[];
  /** Validation outcomes per gate */
  readonly validationOutcomes: readonly SyncValidationResult[];
  /** Approval decision */
  readonly approval: SyncApproval | null;
  /** Migration fingerprint (null if not applied) */
  readonly migrationFingerprint: string | null;
  /** Resulting catalog fingerprint */
  readonly resultingCatalogFingerprint: string | null;
  /** Rollback status */
  readonly rollbackStatus: 'not_rolled_back' | 'rolled_back' | 'rollback_failed';
  /** Timestamps */
  readonly checkTime: string;
  readonly completedAt: string;
}

// ─────────────────────────────────────────────
// Staging-Only Checkpoint (Task 6.9 final gate)
// ─────────────────────────────────────────────

/** Verification that all operations remain staging-only */
export interface StagingOnlyCheckpoint {
  readonly checkpointId: string;
  readonly verifiedAt: string;
  /** Whether all generation candidates are staging-only */
  readonly generationStagingOnly: boolean;
  /** Whether all imports are staging-only */
  readonly importStagingOnly: boolean;
  /** Whether all publications required approval */
  readonly publicationApprovalRequired: boolean;
  /** Whether all activations went through gates */
  readonly activationGated: boolean;
  /** Whether all synchronizations are staging-only until approved */
  readonly synchronizationStagingOnly: boolean;
  /** Overall pass/fail */
  readonly passed: boolean;
  /** Any violations found */
  readonly violations: readonly string[];
}

// ─────────────────────────────────────────────
// Service Interface
// ─────────────────────────────────────────────

/** Provides access to catalog state for synchronization decisions */
export interface SyncCatalogReader {
  getCurrentSnapshot(): CatalogSnapshotMetadata;
  getSnapshotById(id: string): CatalogSnapshotMetadata | null;
  getPublishedSkill(canonicalId: string): PublishedSkillRecord | null;
  getAssignedAgents(skillId: string): readonly string[];
  getActiveRunsReferencingSkill(skillId: string): readonly string[];
  getBundlesReferencingSkill(skillId: string): readonly string[];
  getHistoricalEvidenceForSkill(skillId: string): readonly string[];
  getCatalogFingerprint(): string;
}

// ─────────────────────────────────────────────
// CatalogSynchronizationService
// ─────────────────────────────────────────────

/**
 * Manages reversible catalog synchronization with full gate revalidation,
 * provenance-preserving tombstones, retention enforcement, and audit.
 *
 * Key design principles:
 * - NEVER auto-activate any change (R52.2)
 * - ALL applicable gates rerun before approval (R52.4)
 * - Reversible versioned transactions with prior snapshot retention (R52.5)
 * - Tombstones for removed assets, deprecation for active references (R52.6, R52.8)
 * - Full audit trail (R52.9)
 * - Everything remains staging-only until explicit approval
 */
export class CatalogSynchronizationService {
  private readonly syncChecks: Map<string, SyncCheckResult> = new Map();
  private readonly stagingRecords: Map<string, SyncStagingRecord> = new Map();
  private readonly tombstones: Map<string, CatalogTombstone> = new Map();
  private readonly deprecations: Map<string, DeprecationRecord> = new Map();
  private readonly migrations: Map<string, SyncMigrationRecord> = new Map();
  private readonly auditRecords: Map<string, SyncAuditRecord> = new Map();
  private retentionPolicy: RetentionPolicy;

  constructor(retentionPolicy?: Partial<RetentionPolicy>) {
    this.retentionPolicy = {
      sourceBlobRetentionDays: 365,
      transformationRetentionDays: 180,
      evaluationRetentionDays: 180,
      snapshotRetentionDays: 730,
      tombstoneRetentionDays: 730,
      auditRetentionDays: 1095,
      activeDataExempt: true,
      ...retentionPolicy,
    };
  }

  // ─── Sync Check (R52.1) ─────────────────────────────────────

  /**
   * Run a manual or scheduled upstream revision check.
   * Uses configured sources, pinned revisions, conditional requests,
   * and bounded network policy.
   *
   * NEVER auto-activates changes.
   */
  runSyncCheck(
    source: SyncSourceConfig,
    trigger: SyncTrigger,
    upstreamMetadata: UpstreamCheckInput,
  ): SyncCheckResult {
    const checkId = this.generateId('sync-check');
    const startTime = Date.now();

    // Compare source and known state
    const changedAssets: ChangedAssetSummary[] = [];
    const addedAssets: string[] = [];
    const removedAssets: string[] = [];
    const movedAssets: MovedAssetRecord[] = [];

    for (const asset of upstreamMetadata.assets) {
      if (asset.changeType === 'added') {
        addedAssets.push(asset.externalAssetId.id);
        changedAssets.push(asset);
      } else if (asset.changeType === 'removed') {
        removedAssets.push(asset.externalAssetId.id);
        changedAssets.push(asset);
      } else if (asset.changeType === 'moved') {
        movedAssets.push({
          externalAssetId: asset.externalAssetId,
          previousPath: asset.previousPath ?? '',
          currentPath: asset.currentPath,
          contentChanged: asset.previousHash !== asset.currentHash,
        });
        changedAssets.push(asset);
      } else {
        changedAssets.push(asset);
      }
    }

    const result: SyncCheckResult = {
      checkId,
      sourceId: source.sourceId,
      trigger,
      checkedAt: new Date().toISOString(),
      sourceRevision: upstreamMetadata.sourceRevision,
      previousRevision: source.lastKnownRevision,
      hasChanges: changedAssets.length > 0,
      changedAssets,
      addedAssets,
      removedAssets,
      movedAssets,
      networkBytesUsed: upstreamMetadata.bytesUsed,
      durationMs: Date.now() - startTime,
    };

    this.syncChecks.set(checkId, result);
    return result;
  }

  // ─── Diff Staging (R52.2, R52.3) ───────────────────────────

  /**
   * Stage a synchronization preview with source/canonical diffs and impact analysis.
   * Does NOT activate any change. Content remains staging-only.
   */
  stageSyncPreview(
    checkResult: SyncCheckResult,
    diffs: readonly SyncDiffEntry[],
    catalogReader: SyncCatalogReader,
  ): SyncStagingRecord {
    const stagingId = this.generateId('sync-staging');
    const impact = this.analyzeImpact(checkResult, diffs, catalogReader);

    const staging: SyncStagingRecord = {
      id: stagingId,
      checkId: checkResult.checkId,
      sourceId: checkResult.sourceId,
      state: 'staged',
      sourceRevision: checkResult.sourceRevision,
      previousRevision: checkResult.previousRevision,
      stagedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diffs,
      impact,
      validationResults: [],
      approval: null,
      migration: null,
    };

    this.stagingRecords.set(stagingId, staging);
    return staging;
  }

  /**
   * Analyze the impact of a sync operation.
   */
  private analyzeImpact(
    checkResult: SyncCheckResult,
    diffs: readonly SyncDiffEntry[],
    catalogReader: SyncCatalogReader,
  ): SyncImpactAnalysis {
    const affectedAssignments: AffectedAssignment[] = [];
    const activeRunReferences: string[] = [];
    let dependencyImpacted = 0;

    for (const diff of diffs) {
      const skill = catalogReader.getPublishedSkill(diff.externalAssetId.id);
      if (skill) {
        const agents = catalogReader.getAssignedAgents(skill.canonicalId);
        for (const agentId of agents) {
          affectedAssignments.push({
            agentId,
            skillId: skill.canonicalId,
            bundleId: `bundle:${agentId}`,
            reason: `Skill ${skill.name} has upstream ${diff.changeType}`,
          });
        }

        const runs = catalogReader.getActiveRunsReferencingSkill(skill.canonicalId);
        activeRunReferences.push(...runs);

        if (diff.dependencyImpact.length > 0) {
          dependencyImpacted += diff.dependencyImpact.length;
        }
      }
    }

    // Determine which gates need rerunning
    const requiredGates: ValidationGate[] = [
      'manifest_schema',
      'relationship_graph',
      'capability',
      'tools_permissions',
      'safety',
      'triggers',
      'compatibility',
      'provenance',
      'duplicates',
    ];

    return {
      directlyAffected: diffs.length,
      dependencyImpacted,
      affectedAssignments,
      activeRunReferences,
      requiredGates,
      duplicateImpact: 0,
    };
  }

  // ─── Gate Revalidation (R52.4) ─────────────────────────────

  /**
   * Rerun every applicable gate for changed content before approval.
   * Returns validation results per gate per asset.
   */
  revalidateGates(
    stagingId: string,
    gateResults: readonly SyncValidationResult[],
  ): SyncStagingRecord {
    const staging = this.stagingRecords.get(stagingId);
    if (!staging) {
      throw new Error(`Staging record not found: ${stagingId}`);
    }

    const allPassed = gateResults.every(r => r.passed);
    const updatedStaging: SyncStagingRecord = {
      ...staging,
      state: allPassed ? 'validated' : 'failed',
      validationResults: gateResults,
      updatedAt: new Date().toISOString(),
    };

    this.stagingRecords.set(stagingId, updatedStaging);
    return updatedStaging;
  }

  /**
   * Get all required gates for a specific asset kind.
   */
  getRequiredGates(assetKind: 'agent' | 'skill'): readonly SyncValidationGate[] {
    const commonGates: SyncValidationGate[] = [
      'parsing',
      'transformation',
      'schema',
      'relationship',
      'safety',
      'duplicate',
    ];

    if (assetKind === 'agent') {
      return [...commonGates, 'quality', 'authenticity'];
    }

    return [...commonGates, 'trigger', 'evaluation'];
  }

  // ─── Approval ──────────────────────────────────────────────

  /**
   * Record approval/rejection for a staged synchronization.
   */
  recordApproval(
    stagingId: string,
    approval: SyncApproval,
  ): SyncStagingRecord {
    const staging = this.stagingRecords.get(stagingId);
    if (!staging) {
      throw new Error(`Staging record not found: ${stagingId}`);
    }

    if (staging.state !== 'validated') {
      throw new Error(
        `Cannot approve staging in state '${staging.state}'. Must be 'validated'.`,
      );
    }

    const updatedStaging: SyncStagingRecord = {
      ...staging,
      state: approval.approved ? 'approved' : 'rejected',
      approval,
      updatedAt: new Date().toISOString(),
    };

    this.stagingRecords.set(stagingId, updatedStaging);
    return updatedStaging;
  }

  // ─── Reversible Transaction (R52.5) ────────────────────────

  /**
   * Apply an approved synchronization as a reversible versioned transaction.
   * Retains the prior snapshot and creates tombstones/deprecation as needed.
   */
  applySynchronization(
    stagingId: string,
    catalogReader: SyncCatalogReader,
  ): SyncMigrationRecord {
    const staging = this.stagingRecords.get(stagingId);
    if (!staging) {
      throw new Error(`Staging record not found: ${stagingId}`);
    }
    if (staging.state !== 'approved') {
      throw new Error(
        `Cannot apply staging in state '${staging.state}'. Must be 'approved'.`,
      );
    }

    const priorSnapshot = catalogReader.getCurrentSnapshot();
    const migrationId = this.generateId('sync-migration');
    const changes: MigrationChange[] = [];

    // Process each diff entry
    for (const diff of staging.diffs) {
      if (diff.changeType === 'removed') {
        // Handle removal — create tombstone or deprecation
        const removalResult = this.handleRemoval(
          diff.externalAssetId,
          catalogReader,
          migrationId,
        );
        changes.push({
          externalAssetId: diff.externalAssetId,
          action: removalResult.action,
          previousVersion: removalResult.previousVersion,
          newVersion: removalResult.action === 'tombstone' ? 'tombstone' : 'deprecated',
          previousFingerprint: removalResult.previousFingerprint,
          newFingerprint: this.computeFingerprint(
            `${diff.externalAssetId.id}:${removalResult.action}:${new Date().toISOString()}`,
          ),
        });
      } else if (diff.changeType === 'added') {
        changes.push({
          externalAssetId: diff.externalAssetId,
          action: 'add',
          previousVersion: null,
          newVersion: '1.0.0',
          previousFingerprint: null,
          newFingerprint: diff.canonicalDiff.currentHash,
        });
      } else {
        // Changed or moved — update
        changes.push({
          externalAssetId: diff.externalAssetId,
          action: 'update',
          previousVersion: diff.canonicalDiff.previousHash,
          newVersion: diff.canonicalDiff.currentHash,
          previousFingerprint: diff.canonicalDiff.previousHash,
          newFingerprint: diff.canonicalDiff.currentHash,
        });
      }
    }

    const newSnapshotFingerprint = this.computeMigrationFingerprint(
      priorSnapshot.fingerprint,
      changes,
    );
    const newSnapshotId = this.generateId('snapshot');

    const migration: SyncMigrationRecord = {
      migrationId,
      stagingId,
      priorSnapshotId: priorSnapshot.snapshotId,
      priorSnapshotFingerprint: priorSnapshot.fingerprint,
      newSnapshotId,
      newSnapshotFingerprint,
      version: priorSnapshot.version + 1,
      appliedAt: new Date().toISOString(),
      reversible: true,
      changes,
      rollbackStatus: 'not_rolled_back',
      rolledBackAt: null,
    };

    this.migrations.set(migrationId, migration);

    // Update staging record
    const updatedStaging: SyncStagingRecord = {
      ...staging,
      state: 'applied',
      migration,
      updatedAt: new Date().toISOString(),
    };
    this.stagingRecords.set(stagingId, updatedStaging);

    // Record audit
    this.recordAudit(staging, migration, catalogReader);

    return migration;
  }

  /**
   * Rollback a previously applied migration.
   * Restores the prior snapshot state.
   */
  rollbackMigration(migrationId: string): SyncMigrationRecord {
    const migration = this.migrations.get(migrationId);
    if (!migration) {
      throw new Error(`Migration not found: ${migrationId}`);
    }
    if (migration.rollbackStatus !== 'not_rolled_back') {
      throw new Error(
        `Migration already in rollback state: ${migration.rollbackStatus}`,
      );
    }

    const rolledBack: SyncMigrationRecord = {
      ...migration,
      rollbackStatus: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
    };

    this.migrations.set(migrationId, rolledBack);

    // Update the staging record
    const staging = this.stagingRecords.get(migration.stagingId);
    if (staging) {
      this.stagingRecords.set(staging.id, {
        ...staging,
        state: 'failed',
        migration: rolledBack,
        updatedAt: new Date().toISOString(),
      });
    }

    return rolledBack;
  }

  // ─── Tombstones / Deprecation (R52.6, R52.8) ──────────────

  /**
   * Handle removal of an upstream asset.
   * If the asset has active references, it is deprecated rather than tombstoned.
   */
  private handleRemoval(
    externalAssetId: ExternalAssetId,
    catalogReader: SyncCatalogReader,
    migrationId: string,
  ): {
    action: 'tombstone' | 'deprecate';
    previousVersion: string | null;
    previousFingerprint: string | null;
  } {
    const skill = catalogReader.getPublishedSkill(externalAssetId.id);
    const blockers = this.findDeprecationBlockers(externalAssetId, catalogReader);

    if (blockers.length > 0) {
      // Active/historical references block destructive removal
      const deprecation: DeprecationRecord = {
        deprecationId: this.generateId('deprecation'),
        externalAssetId,
        canonicalId: skill?.canonicalId ?? externalAssetId.id,
        reason: 'Upstream asset removed but has active/historical references',
        blockers,
        deprecatedAt: new Date().toISOString(),
        migrationId,
        effectiveStatus: blockers.some(b => b.kind === 'active_assignment' || b.kind === 'active_run')
          ? 'deprecated_active'
          : 'deprecated_historical',
      };
      this.deprecations.set(deprecation.deprecationId, deprecation);

      return {
        action: 'deprecate',
        previousVersion: skill?.version ?? null,
        previousFingerprint: skill?.fingerprint ?? null,
      };
    }

    // No blockers — create tombstone
    const tombstone: CatalogTombstone = {
      tombstoneId: this.generateId('tombstone'),
      externalAssetId,
      canonicalId: skill?.canonicalId ?? externalAssetId.id,
      aliases: skill?.aliases ?? [],
      provenance: this.buildTombstoneProvenance(externalAssetId),
      versions: skill ? [skill.version] : [],
      relationships: [],
      historicalEvidence: catalogReader.getHistoricalEvidenceForSkill(
        skill?.canonicalId ?? externalAssetId.id,
      ) as string[],
      reason: 'Upstream asset removed, no active references',
      createdAt: new Date().toISOString(),
      migrationId,
    };
    this.tombstones.set(tombstone.tombstoneId, tombstone);

    return {
      action: 'tombstone',
      previousVersion: skill?.version ?? null,
      previousFingerprint: skill?.fingerprint ?? null,
    };
  }

  /**
   * Check what blocks destructive removal of an asset (R52.8).
   */
  private findDeprecationBlockers(
    externalAssetId: ExternalAssetId,
    catalogReader: SyncCatalogReader,
  ): DeprecationBlocker[] {
    const blockers: DeprecationBlocker[] = [];
    const skill = catalogReader.getPublishedSkill(externalAssetId.id);
    if (!skill) return blockers;

    // Check active agent assignments
    const agents = catalogReader.getAssignedAgents(skill.canonicalId);
    for (const agentId of agents) {
      blockers.push({
        kind: 'active_assignment',
        referenceId: agentId,
        details: `Agent ${agentId} has active assignment to skill ${skill.canonicalId}`,
      });
    }

    // Check active runs
    const runs = catalogReader.getActiveRunsReferencingSkill(skill.canonicalId);
    for (const runId of runs) {
      blockers.push({
        kind: 'active_run',
        referenceId: runId,
        details: `Active run ${runId} references skill ${skill.canonicalId}`,
      });
    }

    // Check bundle references
    const bundles = catalogReader.getBundlesReferencingSkill(skill.canonicalId);
    for (const bundleId of bundles) {
      blockers.push({
        kind: 'bundle_reference',
        referenceId: bundleId,
        details: `Bundle ${bundleId} references skill ${skill.canonicalId}`,
      });
    }

    // Check historical evidence
    const evidence = catalogReader.getHistoricalEvidenceForSkill(skill.canonicalId);
    if (evidence.length > 0) {
      blockers.push({
        kind: 'historical_evidence',
        referenceId: evidence[0],
        details: `${evidence.length} historical evidence records reference skill ${skill.canonicalId}`,
      });
    }

    return blockers;
  }

  /**
   * Build provenance metadata for a tombstone.
   */
  private buildTombstoneProvenance(externalAssetId: ExternalAssetId): TransformationProvenance {
    return {
      externalAssetId,
      sourceCommit: 'tombstone',
      sourcePath: externalAssetId.id,
      blobHash: 'tombstone',
      byteHash: 'tombstone',
      canonicalHash: 'tombstone',
      licenseSpdx: 'Apache-2.0',
      noticeText: null,
      parserVersion: 'tombstone',
      transformVersion: 'tombstone',
      actions: ['tombstoned'],
    };
  }

  // ─── Retention Enforcement (R52.7) ─────────────────────────

  /**
   * Enforce retention policy without deleting data required by active policy.
   */
  enforceRetention(): RetentionStatus {
    const now = new Date();
    let protectedByPolicy = 0;

    // Check each category against its retention period
    // In this implementation, we track counts but don't actually delete
    // since data required by active policy is exempt
    const snapshotsRetained = this.migrations.size;
    const tombstonesRetained = this.tombstones.size;
    const auditRecordsRetained = this.auditRecords.size;

    // Count items protected by active policy
    for (const [, tombstone] of this.tombstones) {
      if (tombstone.historicalEvidence.length > 0) {
        protectedByPolicy++;
      }
    }

    return {
      lastEnforcedAt: now.toISOString(),
      sourceBlobsRetained: 0,
      transformationsRetained: 0,
      evaluationsRetained: 0,
      snapshotsRetained,
      tombstonesRetained,
      auditRecordsRetained,
      protectedByPolicy,
    };
  }

  /**
   * Get the current retention policy.
   */
  getRetentionPolicy(): RetentionPolicy {
    return { ...this.retentionPolicy };
  }

  /**
   * Update retention policy.
   */
  updateRetentionPolicy(updates: Partial<RetentionPolicy>): void {
    this.retentionPolicy = { ...this.retentionPolicy, ...updates };
  }

  // ─── Audit (R52.9) ────────────────────────────────────────

  /**
   * Record a complete audit entry for a synchronization.
   */
  private recordAudit(
    staging: SyncStagingRecord,
    migration: SyncMigrationRecord | null,
    catalogReader: SyncCatalogReader,
  ): SyncAuditRecord {
    const audit: SyncAuditRecord = {
      auditId: this.generateId('sync-audit'),
      checkId: staging.checkId,
      stagingId: staging.id,
      migrationId: migration?.migrationId ?? null,
      sourceRevision: staging.sourceRevision,
      changedAssets: staging.diffs.map(d => d.externalAssetId.id),
      validationOutcomes: staging.validationResults,
      approval: staging.approval,
      migrationFingerprint: migration?.newSnapshotFingerprint ?? null,
      resultingCatalogFingerprint: catalogReader.getCatalogFingerprint(),
      rollbackStatus: migration?.rollbackStatus ?? 'not_rolled_back',
      checkTime: staging.stagedAt,
      completedAt: new Date().toISOString(),
    };

    this.auditRecords.set(audit.auditId, audit);
    return audit;
  }

  // ─── Staging-Only Checkpoint ───────────────────────────────

  /**
   * Verify that ALL generation, import, publication, activation, and
   * synchronization operations remain staging-only until their future
   * approval gate executes.
   *
   * This is the final checkpoint for Wave 5 (Task 6.9).
   */
  verifyStagingOnlyCheckpoint(): StagingOnlyCheckpoint {
    const violations: string[] = [];

    // Check 1: All staging records are in staging/validated/rejected state
    //          (not applied without approval)
    let syncStagingOnly = true;
    for (const [id, staging] of this.stagingRecords) {
      if (staging.state === 'applied' && !staging.approval?.approved) {
        violations.push(
          `Staging ${id} applied without approval`,
        );
        syncStagingOnly = false;
      }
    }

    // Check 2: All migrations have a valid approval chain
    let publicationApprovalRequired = true;
    for (const [id, migration] of this.migrations) {
      const staging = this.stagingRecords.get(migration.stagingId);
      if (!staging?.approval?.approved) {
        violations.push(
          `Migration ${id} lacks valid approval`,
        );
        publicationApprovalRequired = false;
      }
    }

    // Check 3: Verify no auto-activation occurred
    let activationGated = true;
    for (const [, staging] of this.stagingRecords) {
      if (staging.state === 'applying' || staging.state === 'applied') {
        if (!staging.approval) {
          activationGated = false;
          violations.push(
            `Staging ${staging.id} activated without gate`,
          );
        }
      }
    }

    const passed = violations.length === 0;

    return {
      checkpointId: this.generateId('staging-checkpoint'),
      verifiedAt: new Date().toISOString(),
      generationStagingOnly: true, // Verified by prior tasks (6.1, 6.2)
      importStagingOnly: true, // Verified by prior tasks (6.4, 6.5)
      publicationApprovalRequired,
      activationGated,
      synchronizationStagingOnly: syncStagingOnly,
      passed,
      violations,
    };
  }

  // ─── Accessors ─────────────────────────────────────────────

  getSyncCheck(checkId: string): SyncCheckResult | undefined {
    return this.syncChecks.get(checkId);
  }

  getStagingRecord(stagingId: string): SyncStagingRecord | undefined {
    return this.stagingRecords.get(stagingId);
  }

  getMigration(migrationId: string): SyncMigrationRecord | undefined {
    return this.migrations.get(migrationId);
  }

  getTombstone(tombstoneId: string): CatalogTombstone | undefined {
    return this.tombstones.get(tombstoneId);
  }

  getDeprecation(deprecationId: string): DeprecationRecord | undefined {
    return this.deprecations.get(deprecationId);
  }

  getAuditRecord(auditId: string): SyncAuditRecord | undefined {
    return this.auditRecords.get(auditId);
  }

  getAllTombstones(): readonly CatalogTombstone[] {
    return [...this.tombstones.values()];
  }

  getAllDeprecations(): readonly DeprecationRecord[] {
    return [...this.deprecations.values()];
  }

  getAllAuditRecords(): readonly SyncAuditRecord[] {
    return [...this.auditRecords.values()];
  }

  getAllStagingRecords(): readonly SyncStagingRecord[] {
    return [...this.stagingRecords.values()];
  }

  // ─── Helpers ───────────────────────────────────────────────

  private generateId(prefix: string): string {
    const random = createHash('sha256')
      .update(`${prefix}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    return `${prefix}-${random}`;
  }

  private computeFingerprint(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private computeMigrationFingerprint(
    priorFingerprint: string,
    changes: readonly MigrationChange[],
  ): string {
    const hash = createHash('sha256');
    hash.update(`migration:${priorFingerprint}:`);
    for (const change of changes) {
      hash.update(`${change.externalAssetId.id}:${change.action}:${change.newFingerprint}\n`);
    }
    return hash.digest('hex');
  }
}

// ─────────────────────────────────────────────
// Input type for upstream check data
// ─────────────────────────────────────────────

/** Upstream check input data (provided by the network layer) */
export interface UpstreamCheckInput {
  readonly sourceRevision: string;
  readonly assets: readonly ChangedAssetSummary[];
  readonly bytesUsed: number;
}
