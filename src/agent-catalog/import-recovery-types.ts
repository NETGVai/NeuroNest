/**
 * Import Recovery Types
 *
 * Types for the ImportRecoveryService covering:
 * - Controlled recovery of wrapper, frontmatter, identity, relationship, and parse defects
 * - Quarantine management for unrecoverable and license-defective candidates
 * - Compliance preview generation for approval before publication
 * - Atomic import rollback on candidate, relationship, or index failure
 *
 * These types extend corpus-inventory-types.ts for the state machine transitions:
 *   raw_inventory_verified → parsed → recovered → normalized →
 *   duplicate_reviewed → validated → approval_pending → published | quarantined
 *
 * Requirements: 46.5, 46.6, 46.7, 46.8
 */

import type {
  ExternalAssetId,
  InventoryCounts,
  StagedAssetRecord,
  StagingRun,
  TransformationProvenance,
} from './corpus-inventory-types';

// ─────────────────────────────────────────────
// Recovery Defect Classification
// ─────────────────────────────────────────────

/** Categories of recoverable defects per R46.5 */
export type RecoverableDefectKind =
  | 'wrapper_malformed'
  | 'frontmatter_malformed'
  | 'identity_malformed'
  | 'relationship_malformed'
  | 'parse_error';

/** License defect kind - never inferred or repaired, always quarantines */
export type LicenseDefectKind = 'license_missing' | 'license_invalid' | 'license_incompatible';

/** All defect kinds */
export type DefectKind = RecoverableDefectKind | LicenseDefectKind;

/** Whether a defect is recoverable or blocking */
export type DefectSeverity = 'recoverable' | 'blocking';

// ─────────────────────────────────────────────
// Recovery Diagnostic
// ─────────────────────────────────────────────

/**
 * A single diagnostic recorded during recovery attempt.
 * Preserves raw source evidence and the action taken.
 */
export interface RecoveryDiagnostic {
  /** Unique diagnostic code */
  readonly code: string;
  /** Defect classification */
  readonly kind: DefectKind;
  /** Whether this defect is recoverable or blocking */
  readonly severity: DefectSeverity;
  /** Human-readable description */
  readonly message: string;
  /** The raw source bytes/text at the defect location */
  readonly rawSourceEvidence: string;
  /** Byte offset range in the original source */
  readonly startOffset: number;
  readonly endOffset: number;
  /** Recovery action taken (if any) */
  readonly recoveryAction: string | null;
  /** Whether recovery succeeded for this specific defect */
  readonly recovered: boolean;
  /** Timestamp of detection */
  readonly detectedAt: string;
}

// ─────────────────────────────────────────────
// Recovery Attempt
// ─────────────────────────────────────────────

/**
 * Records a single recovery attempt on a candidate asset.
 * Recovery is bounded: it preserves raw source, does not invent content,
 * and is limited by round/time/token constraints.
 */
export interface RecoveryAttempt {
  /** Unique attempt ID */
  readonly attemptId: string;
  /** The asset being recovered */
  readonly assetId: string;
  /** External asset identity */
  readonly externalAssetId: ExternalAssetId;
  /** What type of recovery was attempted */
  readonly recoveryKind: RecoverableDefectKind;
  /** Diagnostics found during this attempt */
  readonly diagnostics: readonly RecoveryDiagnostic[];
  /** Whether this specific attempt succeeded */
  readonly succeeded: boolean;
  /** Raw source bytes preserved before recovery (SHA-256) */
  readonly rawSourceHash: string;
  /** Recovered content hash (null if failed) */
  readonly recoveredContentHash: string | null;
  /** Actions taken during recovery */
  readonly actions: readonly string[];
  /** Timestamp of attempt */
  readonly attemptedAt: string;
  /** Duration in milliseconds */
  readonly durationMs: number;
}

// ─────────────────────────────────────────────
// Recovery Result per Asset
// ─────────────────────────────────────────────

export type RecoveryOutcome = 'recovered' | 'failed' | 'not_needed';

/**
 * Complete recovery result for a single staged asset.
 */
export interface AssetRecoveryResult {
  /** The asset ID */
  readonly assetId: string;
  /** External asset identity */
  readonly externalAssetId: ExternalAssetId;
  /** Overall recovery outcome */
  readonly outcome: RecoveryOutcome;
  /** All recovery attempts for this asset */
  readonly attempts: readonly RecoveryAttempt[];
  /** All diagnostics across attempts */
  readonly diagnostics: readonly RecoveryDiagnostic[];
  /** Whether the asset should be quarantined */
  readonly shouldQuarantine: boolean;
  /** Reason for quarantine (if applicable) */
  readonly quarantineReason: string | null;
  /** Whether the asset remains eligible for later gates */
  readonly eligibleForLaterGates: boolean;
  /** The preserved raw source content */
  readonly rawSource: string;
  /** The recovered content (null if recovery failed) */
  readonly recoveredContent: string | null;
}

// ─────────────────────────────────────────────
// Quarantine Record
// ─────────────────────────────────────────────

/** Reasons a candidate is quarantined */
export type QuarantineReason =
  | 'recovery_failed'
  | 'license_defect'
  | 'validation_failed'
  | 'quality_below_threshold'
  | 'authenticity_failed'
  | 'structure_invalid'
  | 'relationship_unresolved';

/**
 * A quarantined candidate record.
 * Quarantined assets are never placed in the effective catalog.
 */
export interface QuarantineRecord {
  /** Unique quarantine record ID */
  readonly id: string;
  /** The asset ID being quarantined */
  readonly assetId: string;
  /** External asset identity */
  readonly externalAssetId: ExternalAssetId;
  /** Why this asset was quarantined */
  readonly reason: QuarantineReason;
  /** Detailed explanation */
  readonly explanation: string;
  /** All diagnostics that contributed to quarantine */
  readonly diagnostics: readonly RecoveryDiagnostic[];
  /** Recovery attempts made before quarantine */
  readonly recoveryAttempts: readonly RecoveryAttempt[];
  /** The preserved raw source for diagnosis */
  readonly rawSource: string;
  /** Provenance record */
  readonly provenance: TransformationProvenance;
  /** Timestamp of quarantine */
  readonly quarantinedAt: string;
}

// ─────────────────────────────────────────────
// Compliance Preview
// ─────────────────────────────────────────────

/**
 * A single entry in the compliance preview showing what happened to an asset.
 */
export interface CompliancePreviewEntry {
  /** External asset identity */
  readonly externalAssetId: ExternalAssetId;
  /** Asset kind */
  readonly assetKind: string;
  /** Current state in the pipeline */
  readonly state: string;
  /** Provenance summary */
  readonly provenanceSummary: {
    readonly sourceCommit: string;
    readonly sourcePath: string;
    readonly licenseSpdx: string;
    readonly noticeText: string | null;
  };
  /** Transformations applied */
  readonly transformations: readonly string[];
  /** Whether duplicates were found */
  readonly duplicateStatus: 'unique' | 'duplicate_resolved' | 'duplicate_pending';
  /** Validation outcome */
  readonly validationOutcome: 'passed' | 'failed' | 'pending';
  /** Whether this asset is quarantined */
  readonly quarantined: boolean;
  /** Engineering-policy notice metadata (Apache-2.0 obligations) */
  readonly noticeMetadata: NoticeMetadata;
}

/**
 * Apache-2.0 engineering-policy notice metadata.
 * This is engineering compliance, not legal advice.
 */
export interface NoticeMetadata {
  /** SPDX license identifier */
  readonly licenseSpdx: string;
  /** Whether a NOTICE file was found */
  readonly noticeFilePresent: boolean;
  /** Notice text content (if found) */
  readonly noticeText: string | null;
  /** Modified files recorded */
  readonly modifiedFiles: readonly string[];
  /** Whether provenance is complete */
  readonly provenanceComplete: boolean;
  /** Engineering-policy label */
  readonly policyLabel: 'engineering_compliance';
}

/**
 * A catalog diff showing what would change if the import is approved.
 */
export interface CatalogDiffEntry {
  /** External asset identity */
  readonly externalAssetId: ExternalAssetId;
  /** What would happen */
  readonly action: 'add' | 'update' | 'skip_quarantined';
  /** Reason for the action */
  readonly reason: string;
}

/**
 * The complete compliance preview generated before any publication.
 * Must be approved before activation per R46.6.
 */
export interface CompliancePreview {
  /** Unique preview ID */
  readonly id: string;
  /** Staging run this preview is for */
  readonly stagingRunId: string;
  /** Overall inventory summary */
  readonly inventorySummary: InventoryCounts;
  /** Per-asset entries */
  readonly entries: readonly CompliancePreviewEntry[];
  /** Quarantined assets */
  readonly quarantinedEntries: readonly QuarantineRecord[];
  /** Catalog diff (what would change) */
  readonly catalogDiff: readonly CatalogDiffEntry[];
  /** Duplicate decisions made */
  readonly duplicateDecisions: readonly DuplicateDecisionSummary[];
  /** Validation outcomes by category */
  readonly validationSummary: ValidationSummary;
  /** Engineering-policy notices */
  readonly notices: readonly string[];
  /** Whether approval is required */
  readonly requiresApproval: boolean;
  /** Generated timestamp */
  readonly generatedAt: string;
}

/**
 * Summary of a duplicate decision for the compliance preview.
 */
export interface DuplicateDecisionSummary {
  readonly assetId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly decision: 'unique' | 'duplicate' | 'pending_review';
  readonly matchedWith: string | null;
  readonly reason: string;
}

/**
 * Summary of validation outcomes across all candidates.
 */
export interface ValidationSummary {
  readonly totalCandidates: number;
  readonly passed: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly pendingReview: number;
}

// ─────────────────────────────────────────────
// Atomic Rollback
// ─────────────────────────────────────────────

/** Types of failures that trigger rollback */
export type RollbackTrigger =
  | 'candidate_activation_failed'
  | 'relationship_update_failed'
  | 'index_update_failed'
  | 'publication_transaction_failed';

/**
 * A rollback record documenting what was rolled back and why.
 */
export interface RollbackRecord {
  /** Unique rollback ID */
  readonly id: string;
  /** Staging run that was rolled back */
  readonly stagingRunId: string;
  /** What triggered the rollback */
  readonly trigger: RollbackTrigger;
  /** The error that caused the rollback */
  readonly error: string;
  /** The prior catalog snapshot ID that was restored */
  readonly restoredSnapshotId: string;
  /** Assets that were being activated when failure occurred */
  readonly affectedAssetIds: readonly string[];
  /** Whether staging data was retained for diagnosis */
  readonly stagingRetained: boolean;
  /** Timestamp of rollback */
  readonly rolledBackAt: string;
  /** Duration of rollback operation in milliseconds */
  readonly rollbackDurationMs: number;
}

/**
 * A catalog snapshot representing the state before import.
 * Used to restore prior state on failure.
 */
export interface CatalogSnapshot {
  /** Unique snapshot ID */
  readonly id: string;
  /** Snapshot fingerprint (hash of catalog state) */
  readonly fingerprint: string;
  /** Timestamp when snapshot was taken */
  readonly createdAt: string;
  /** Number of effective agents in this snapshot */
  readonly effectiveAgentCount: number;
  /** Number of effective skills in this snapshot */
  readonly effectiveSkillCount: number;
}

// ─────────────────────────────────────────────
// Import Recovery Service Result
// ─────────────────────────────────────────────

/**
 * Complete result from the ImportRecoveryService after processing
 * raw inventory entries through recovery, quarantine, preview, and
 * publication/rollback.
 */
export interface ImportRecoveryServiceResult {
  /** The staging run */
  readonly stagingRun: StagingRun;
  /** Recovery results per asset */
  readonly recoveryResults: readonly AssetRecoveryResult[];
  /** Quarantined assets */
  readonly quarantineRecords: readonly QuarantineRecord[];
  /** Updated inventory counts */
  readonly counts: InventoryCounts;
  /** Whether recovery is complete (all assets processed) */
  readonly recoveryComplete: boolean;
  /** How many assets were successfully recovered */
  readonly recoveredCount: number;
  /** How many assets needed no recovery */
  readonly noRecoveryNeededCount: number;
  /** How many assets failed recovery */
  readonly failedRecoveryCount: number;
}

/**
 * Result from attempting to publish recovered and validated candidates.
 */
export interface PublicationResult {
  /** Whether publication succeeded */
  readonly success: boolean;
  /** Rollback record if publication failed */
  readonly rollback: RollbackRecord | null;
  /** The catalog snapshot taken before publication */
  readonly priorSnapshot: CatalogSnapshot;
  /** The new snapshot after successful publication (null on failure) */
  readonly newSnapshot: CatalogSnapshot | null;
  /** Assets that were successfully published */
  readonly publishedAssetIds: readonly string[];
  /** Assets that were quarantined during publication */
  readonly quarantinedDuringPublication: readonly string[];
  /** Timestamp */
  readonly completedAt: string;
}
