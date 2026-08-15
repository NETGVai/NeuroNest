/**
 * Corpus Inventory Types
 *
 * Types for the Staged Corpus Importer's raw inventory verification
 * and transformation provenance recording. The importer is a state machine:
 *
 *   revision_verified → raw_inventory_verified → parsed → recovered
 *   → normalized → duplicate_reviewed → validated → approval_pending
 *   → published | quarantined
 *
 * This module covers the first two states: revision_verified and
 * raw_inventory_verified. It defines the structure for External_Asset_IDs,
 * provenance records, and inventory count reporting per Requirements 46.1–46.4.
 */

// ─────────────────────────────────────────────
// Pinned Corpus Configuration
// ─────────────────────────────────────────────

/** The pinned source commit for Harness 100 English corpus. */
export const PINNED_COMMIT = '8e8d35c6a19166614d1af1df85512266d51121ae';

/** Expected inventory counts per Requirements 46.2. */
export const EXPECTED_INVENTORY = {
  directories: 100,
  agentFiles: 489,
  skillFiles: 315,
  orchestratorSkills: 100,
  extensionDomainSkills: 215,
} as const;

/** The repository identifier used in External_Asset_ID construction. */
export const CORPUS_REPOSITORY = 'harness100';

/** The locale segment for External_Asset_IDs. */
export const CORPUS_LOCALE = 'en';

// ─────────────────────────────────────────────
// Asset Kind Classification
// ─────────────────────────────────────────────

export type AssetKind = 'agent' | 'orchestrator_skill' | 'extension_skill' | 'domain_skill';

export type SkillClassification = 'orchestrator' | 'extension_domain';

// ─────────────────────────────────────────────
// External_Asset_ID
// ─────────────────────────────────────────────

/**
 * A stable path-qualified identity for an imported asset.
 * Format: `harness100:en:<harness>:<kind>:<slug>`
 *
 * This is composed from source repository, locale, harness directory name,
 * kind (agent/orchestrator_skill/extension_skill/domain_skill), and slug
 * derived from the filename.
 */
export interface ExternalAssetId {
  /** The full External_Asset_ID string: `harness100:en:<harness>:<kind>:<slug>` */
  readonly id: string;
  /** Source repository identifier */
  readonly repository: string;
  /** Locale segment */
  readonly locale: string;
  /** Harness directory name (e.g., "16-fullstack-webapp") */
  readonly harness: string;
  /** Asset kind */
  readonly kind: AssetKind;
  /** Slug derived from filename */
  readonly slug: string;
}

// ─────────────────────────────────────────────
// Transformation Provenance
// ─────────────────────────────────────────────

/**
 * Records provenance for a single corpus asset before parsing.
 * Captures source commit/path, original blob/raw/canonical hashes,
 * license and notice data, parser/recovery/transform versions,
 * actions, reviewer decisions, and output fingerprints.
 */
export interface TransformationProvenance {
  /** The External_Asset_ID for this asset */
  readonly externalAssetId: ExternalAssetId;
  /** Source commit hash (pinned) */
  readonly sourceCommit: string;
  /** Relative path within the corpus */
  readonly sourcePath: string;
  /** SHA-256 of the raw blob content */
  readonly blobHash: string;
  /** SHA-256 of raw byte content (may differ from blob if encoding normalization occurs) */
  readonly byteHash: string;
  /** SHA-256 of canonical content after whitespace/encoding normalization */
  readonly canonicalHash: string;
  /** Detected license SPDX identifier */
  readonly licenseSpdx: string;
  /** License notice text (if found) */
  readonly noticeText: string | null;
  /** Parser version used for initial classification */
  readonly parserVersion: string;
  /** Transformation pipeline version */
  readonly transformVersion: string;
  /** Actions taken during initial staging (classification, path resolution, etc.) */
  readonly actions: readonly string[];
}

// ─────────────────────────────────────────────
// Raw Inventory File Entry
// ─────────────────────────────────────────────

/**
 * Represents a single file discovered during raw filesystem inventory,
 * before any parsing or transformation.
 */
export interface RawInventoryEntry {
  /** Relative path from the corpus root (e.g., "en/16-fullstack-webapp/.claude/agents/architect.md") */
  readonly relativePath: string;
  /** The harness directory name this file belongs to */
  readonly harnessDirectory: string;
  /** Classification: agent file or skill file */
  readonly fileType: 'agent' | 'skill';
  /** For skill files, the skill classification */
  readonly skillClassification?: SkillClassification;
  /** Raw file size in bytes */
  readonly sizeBytes: number;
}

// ─────────────────────────────────────────────
// Inventory Counts
// ─────────────────────────────────────────────

/**
 * The six separate count categories that must be reported independently
 * per Requirements 46.2. Raw counts are verified before parsing;
 * others are tracked through downstream pipeline states.
 */
export interface InventoryCounts {
  /** Raw filesystem inventory count (before parsing) */
  readonly raw: number;
  /** Successfully parsed */
  readonly parsed: number;
  /** Required recovery during parsing */
  readonly recovered: number;
  /** Quarantined (failed validation, license issues, etc.) */
  readonly quarantined: number;
  /** Passed duplicate reconciliation */
  readonly reconciled: number;
  /** Published to effective catalog */
  readonly effective: number;
}

/**
 * Pre-parsing raw inventory breakdown that must match expected counts exactly.
 */
export interface RawInventoryBreakdown {
  /** Number of harness directories discovered */
  readonly directories: number;
  /** Number of agent files discovered */
  readonly agentFiles: number;
  /** Number of skill files discovered */
  readonly skillFiles: number;
  /** Orchestrator skills (subset of skillFiles) */
  readonly orchestratorSkills: number;
  /** Extension/domain skills (subset of skillFiles) */
  readonly extensionDomainSkills: number;
}

// ─────────────────────────────────────────────
// Inventory Verification Result
// ─────────────────────────────────────────────

export type InventoryVerificationStatus = 'passed' | 'failed';

/**
 * Result of verifying the raw inventory against expected counts.
 */
export interface InventoryVerificationResult {
  /** Whether the verification passed or failed */
  readonly status: InventoryVerificationStatus;
  /** The expected breakdown */
  readonly expected: RawInventoryBreakdown;
  /** The actual breakdown discovered */
  readonly actual: RawInventoryBreakdown;
  /** Specific discrepancies found (empty if passed) */
  readonly discrepancies: readonly InventoryDiscrepancy[];
  /** Timestamp of verification */
  readonly verifiedAt: string;
}

/**
 * A single discrepancy between expected and actual inventory.
 */
export interface InventoryDiscrepancy {
  readonly field: keyof RawInventoryBreakdown;
  readonly expected: number;
  readonly actual: number;
  readonly message: string;
}

// ─────────────────────────────────────────────
// Staging Run State
// ─────────────────────────────────────────────

export type StagingRunState =
  | 'revision_verified'
  | 'raw_inventory_verified'
  | 'parsed'
  | 'recovered'
  | 'normalized'
  | 'duplicate_reviewed'
  | 'validated'
  | 'approval_pending'
  | 'published'
  | 'quarantined';

/**
 * A staging run record capturing the overall import progress.
 */
export interface StagingRun {
  readonly id: string;
  readonly sourceCommit: string;
  readonly state: StagingRunState;
  readonly counts: InventoryCounts;
  readonly rawBreakdown: RawInventoryBreakdown;
  readonly verificationResult: InventoryVerificationResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─────────────────────────────────────────────
// Staged Asset Record
// ─────────────────────────────────────────────

/**
 * A single staged asset with its External_Asset_ID and provenance,
 * created during raw inventory verification. This record remains inactive
 * and is never activated without explicit approval.
 */
export interface StagedAssetRecord {
  readonly id: string;
  readonly stagingRunId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly provenance: TransformationProvenance;
  readonly assetKind: AssetKind;
  readonly state: 'raw' | 'parsed' | 'recovered' | 'normalized' | 'duplicate_reviewed' | 'validated' | 'approval_pending' | 'published' | 'quarantined';
  readonly inventoryEntry: RawInventoryEntry;
}

// ─────────────────────────────────────────────
// Verification Report
// ─────────────────────────────────────────────

/**
 * Complete report returned by the CorpusInventoryVerifier after
 * staging and verifying the raw inventory.
 */
export interface CorpusVerificationReport {
  readonly stagingRun: StagingRun;
  readonly verificationResult: InventoryVerificationResult;
  readonly assets: readonly StagedAssetRecord[];
  readonly counts: InventoryCounts;
  /** Whether publication is blocked due to inventory discrepancy */
  readonly publicationBlocked: boolean;
}
