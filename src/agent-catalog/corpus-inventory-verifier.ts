/**
 * Corpus Inventory Verifier
 *
 * A pure verification/staging service for the Harness 100 English Corpus
 * at pinned commit `8e8d35c`. This service:
 *
 * 1. Verifies the pinned revision before any parsing
 * 2. Reconciles the raw filesystem inventory to exactly:
 *    - 100 harness directories
 *    - 489 agent files
 *    - 315 skill files (100 orchestrator + 215 extension/domain)
 * 3. Assigns path-qualified External_Asset_ID values
 * 4. Records provenance (blob, byte, canonical, path, commit, license,
 *    parser, transformation, action)
 * 5. Reports raw, parsed, recovered, quarantined, reconciled, and effective
 *    counts separately
 *
 * This service does NOT access the network or activate anything.
 * The corpus staging only proceeds when explicitly executed under network
 * and approval policy.
 *
 * Requirements: 46.1, 46.2, 46.3, 46.4
 */

import { createHash } from 'crypto';
import {
  type AssetKind,
  CORPUS_LOCALE,
  CORPUS_REPOSITORY,
  type CorpusVerificationReport,
  EXPECTED_INVENTORY,
  type ExternalAssetId,
  type InventoryCounts,
  type InventoryDiscrepancy,
  type InventoryVerificationResult,
  PINNED_COMMIT,
  type RawInventoryBreakdown,
  type RawInventoryEntry,
  type SkillClassification,
  type StagedAssetRecord,
  type StagingRun,
  type TransformationProvenance,
} from './corpus-inventory-types';

/** Current parser version for inventory classification */
export const PARSER_VERSION = '1.0.0';

/** Current transformation pipeline version */
export const TRANSFORM_VERSION = '1.0.0';

// ─────────────────────────────────────────────
// External_Asset_ID Construction
// ─────────────────────────────────────────────

/**
 * Derives a slug from a filename by removing the extension and
 * converting to lowercase kebab-case.
 */
export function deriveSlug(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  return withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Constructs an External_Asset_ID from its components.
 * Format: `harness100:en:<harness>:<kind>:<slug>`
 */
export function buildExternalAssetId(
  harness: string,
  kind: AssetKind,
  slug: string,
): ExternalAssetId {
  const id = `${CORPUS_REPOSITORY}:${CORPUS_LOCALE}:${harness}:${kind}:${slug}`;
  return Object.freeze({
    id,
    repository: CORPUS_REPOSITORY,
    locale: CORPUS_LOCALE,
    harness,
    kind,
    slug,
  });
}

// ─────────────────────────────────────────────
// Hash Computation
// ─────────────────────────────────────────────

/**
 * Computes SHA-256 hash of content.
 */
export function computeSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Computes the canonical hash by normalizing whitespace and line endings.
 */
export function computeCanonicalHash(content: string): string {
  const normalized = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  return computeSha256(normalized);
}

// ─────────────────────────────────────────────
// File Classification
// ─────────────────────────────────────────────

/**
 * Classifies a file path as agent or skill based on its location within
 * the harness directory structure.
 *
 * Agent files are in: `<harness>/.claude/agents/`
 * Skill files are in: `<harness>/.claude/skills/`
 */
export function classifyFilePath(relativePath: string): { fileType: 'agent' | 'skill'; skillClassification?: SkillClassification } | null {
  // Normalize path separators
  const normalized = relativePath.replace(/\\/g, '/');

  // Agent file pattern: en/<harness>/.claude/agents/<name>.md
  if (/\/\.claude\/agents\/[^/]+\.md$/.test(normalized)) {
    return { fileType: 'agent' };
  }

  // Skill file pattern: en/<harness>/.claude/skills/<skill-name>/skill.md
  // or en/<harness>/.claude/skills/<skill-name>/<name>.md
  if (/\/\.claude\/skills\/[^/]+\/[^/]+\.md$/.test(normalized) ||
      /\/\.claude\/skills\/[^/]+\/skill\.md$/.test(normalized)) {
    return { fileType: 'skill' };
  }

  return null;
}

/**
 * Classifies a skill as orchestrator or extension/domain based on path patterns.
 * Orchestrator skills typically share the harness project name or are named "skill.md"
 * directly under the skills directory. The classification uses the skill path to determine
 * whether it is the primary orchestrator skill for the harness.
 */
export function classifySkill(
  relativePath: string,
  harnessDir: string,
): SkillClassification {
  const normalized = relativePath.replace(/\\/g, '/');
  // Extract the skill directory name from the path
  const skillDirMatch = normalized.match(/\/\.claude\/skills\/([^/]+)\//);
  if (!skillDirMatch) {
    return 'extension_domain';
  }

  const skillDirName = skillDirMatch[1];
  // Strip numeric prefix from harness directory for comparison
  const harnessSlug = harnessDir.replace(/^\d+-/, '');

  // A skill is orchestrator if its directory name matches the harness slug
  if (skillDirName === harnessSlug || skillDirName === harnessDir) {
    return 'orchestrator';
  }

  return 'extension_domain';
}

/**
 * Extracts the harness directory name from a relative path.
 * Paths are expected to be: `en/<harness-dir>/...`
 */
export function extractHarnessDirectory(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/');
  // Remove leading locale prefix if present
  const withoutLocale = normalized.replace(/^en\//, '');
  const parts = withoutLocale.split('/');
  if (parts.length < 2) {
    return null;
  }
  return parts[0];
}

/**
 * Extracts the filename (without directory) from a path.
 */
export function extractFilename(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

// ─────────────────────────────────────────────
// Inventory Construction
// ─────────────────────────────────────────────

/**
 * Input data for a single file in the corpus.
 */
export interface CorpusFileInput {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
}

/**
 * Builds raw inventory entries from discovered corpus files.
 * Returns classified entries or null for files that don't match
 * the expected agent/skill patterns.
 */
export function buildRawInventoryEntry(file: CorpusFileInput): RawInventoryEntry | null {
  const harnessDir = extractHarnessDirectory(file.relativePath);
  if (!harnessDir) {
    return null;
  }

  const classification = classifyFilePath(file.relativePath);
  if (!classification) {
    return null;
  }

  const entry: RawInventoryEntry = {
    relativePath: file.relativePath,
    harnessDirectory: harnessDir,
    fileType: classification.fileType,
    sizeBytes: file.sizeBytes,
  };

  if (classification.fileType === 'skill') {
    const skillClass = classifySkill(file.relativePath, harnessDir);
    return { ...entry, skillClassification: skillClass };
  }

  return entry;
}

// ─────────────────────────────────────────────
// Inventory Breakdown Computation
// ─────────────────────────────────────────────

/**
 * Computes the raw inventory breakdown from classified entries.
 */
export function computeRawBreakdown(entries: readonly RawInventoryEntry[]): RawInventoryBreakdown {
  const directories = new Set<string>();
  let agentFiles = 0;
  let skillFiles = 0;
  let orchestratorSkills = 0;
  let extensionDomainSkills = 0;

  for (const entry of entries) {
    directories.add(entry.harnessDirectory);

    if (entry.fileType === 'agent') {
      agentFiles++;
    } else if (entry.fileType === 'skill') {
      skillFiles++;
      if (entry.skillClassification === 'orchestrator') {
        orchestratorSkills++;
      } else {
        extensionDomainSkills++;
      }
    }
  }

  return Object.freeze({
    directories: directories.size,
    agentFiles,
    skillFiles,
    orchestratorSkills,
    extensionDomainSkills,
  });
}

// ─────────────────────────────────────────────
// Inventory Verification
// ─────────────────────────────────────────────

/**
 * Verifies that the raw inventory breakdown matches expected counts exactly.
 * Returns a detailed verification result with any discrepancies.
 */
export function verifyInventoryBreakdown(actual: RawInventoryBreakdown): InventoryVerificationResult {
  const discrepancies: InventoryDiscrepancy[] = [];
  const expected = EXPECTED_INVENTORY;

  const checks: Array<{ field: keyof RawInventoryBreakdown; expected: number; actual: number }> = [
    { field: 'directories', expected: expected.directories, actual: actual.directories },
    { field: 'agentFiles', expected: expected.agentFiles, actual: actual.agentFiles },
    { field: 'skillFiles', expected: expected.skillFiles, actual: actual.skillFiles },
    { field: 'orchestratorSkills', expected: expected.orchestratorSkills, actual: actual.orchestratorSkills },
    { field: 'extensionDomainSkills', expected: expected.extensionDomainSkills, actual: actual.extensionDomainSkills },
  ];

  for (const check of checks) {
    if (check.expected !== check.actual) {
      discrepancies.push({
        field: check.field,
        expected: check.expected,
        actual: check.actual,
        message: `Expected ${check.expected} ${check.field}, found ${check.actual}`,
      });
    }
  }

  return Object.freeze({
    status: discrepancies.length === 0 ? 'passed' : 'failed',
    expected: Object.freeze({
      directories: expected.directories,
      agentFiles: expected.agentFiles,
      skillFiles: expected.skillFiles,
      orchestratorSkills: expected.orchestratorSkills,
      extensionDomainSkills: expected.extensionDomainSkills,
    }),
    actual,
    discrepancies: Object.freeze(discrepancies),
    verifiedAt: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// Provenance Recording
// ─────────────────────────────────────────────

/**
 * Determines the asset kind for a raw inventory entry.
 */
export function determineAssetKind(entry: RawInventoryEntry): AssetKind {
  if (entry.fileType === 'agent') {
    return 'agent';
  }
  if (entry.skillClassification === 'orchestrator') {
    return 'orchestrator_skill';
  }
  // Both extension and domain skills map to their respective kinds
  return 'extension_skill';
}

/**
 * Builds transformation provenance for a single asset.
 */
export function buildProvenance(
  entry: RawInventoryEntry,
  content: string,
  externalAssetId: ExternalAssetId,
  licenseSpdx: string = 'Apache-2.0',
  noticeText: string | null = null,
): TransformationProvenance {
  const blobHash = computeSha256(content);
  const byteHash = computeSha256(Buffer.from(content, 'utf-8'));
  const canonicalHash = computeCanonicalHash(content);

  return Object.freeze({
    externalAssetId,
    sourceCommit: PINNED_COMMIT,
    sourcePath: entry.relativePath,
    blobHash,
    byteHash,
    canonicalHash,
    licenseSpdx,
    noticeText,
    parserVersion: PARSER_VERSION,
    transformVersion: TRANSFORM_VERSION,
    actions: Object.freeze(['classified', 'path_resolved', 'hashes_computed', 'license_detected', 'provenance_recorded']),
  });
}

// ─────────────────────────────────────────────
// Staged Asset Record Construction
// ─────────────────────────────────────────────

/**
 * Creates a staged asset record from a raw inventory entry.
 */
export function createStagedAssetRecord(
  stagingRunId: string,
  entry: RawInventoryEntry,
  content: string,
  licenseSpdx: string = 'Apache-2.0',
  noticeText: string | null = null,
): StagedAssetRecord {
  const assetKind = determineAssetKind(entry);
  const slug = deriveSlug(extractFilename(entry.relativePath));
  const externalAssetId = buildExternalAssetId(entry.harnessDirectory, assetKind, slug);
  const provenance = buildProvenance(entry, content, externalAssetId, licenseSpdx, noticeText);

  const id = computeSha256(`${stagingRunId}:${entry.relativePath}`).slice(0, 32);

  return Object.freeze({
    id,
    stagingRunId,
    externalAssetId,
    provenance,
    assetKind,
    state: 'raw' as const,
    inventoryEntry: entry,
  });
}

// ─────────────────────────────────────────────
// Count Initialization
// ─────────────────────────────────────────────

/**
 * Creates initial inventory counts with only raw populated.
 * All downstream counts start at zero until their respective
 * pipeline stages execute.
 */
export function createInitialCounts(rawCount: number): InventoryCounts {
  return Object.freeze({
    raw: rawCount,
    parsed: 0,
    recovered: 0,
    quarantined: 0,
    reconciled: 0,
    effective: 0,
  });
}

// ─────────────────────────────────────────────
// Revision Verification
// ─────────────────────────────────────────────

/**
 * Verifies that the provided commit matches the pinned commit.
 * This is a precondition before any parsing can proceed.
 */
export function verifyRevision(commit: string): boolean {
  return commit.toLowerCase() === PINNED_COMMIT.toLowerCase();
}

// ─────────────────────────────────────────────
// Main Verifier Service
// ─────────────────────────────────────────────

/**
 * CorpusInventoryVerifier - Pure verification/staging service.
 *
 * This service performs the pre-parsing inventory verification for the
 * Harness 100 English Corpus. It does NOT access the network or activate
 * anything. The corpus staging only proceeds when explicitly executed
 * under network and approval policy.
 *
 * The importer state machine flow this covers:
 *   revision_verified → raw_inventory_verified
 */
export class CorpusInventoryVerifier {
  private readonly licenseSpdx: string;
  private readonly noticeText: string | null;

  constructor(
    licenseSpdx: string = 'Apache-2.0',
    noticeText: string | null = null,
  ) {
    this.licenseSpdx = licenseSpdx;
    this.noticeText = noticeText;
  }

  /**
   * Verifies the source commit matches the pinned revision.
   * Must pass before any inventory operations proceed.
   */
  verifyRevision(commit: string): boolean {
    return verifyRevision(commit);
  }

  /**
   * Processes raw corpus files and produces a complete verification report.
   *
   * Steps:
   * 1. Verify revision
   * 2. Classify all files into raw inventory entries
   * 3. Compute raw inventory breakdown
   * 4. Verify breakdown matches expected counts
   * 5. Assign External_Asset_IDs
   * 6. Record provenance for each asset
   * 7. Report all counts separately
   *
   * @param sourceCommit The commit hash to verify
   * @param files The corpus files to process
   * @returns A complete verification report
   * @throws If the revision does not match the pinned commit
   */
  verifyAndStage(
    sourceCommit: string,
    files: readonly CorpusFileInput[],
  ): CorpusVerificationReport {
    // Step 1: Verify revision
    if (!this.verifyRevision(sourceCommit)) {
      throw new Error(
        `Revision mismatch: expected ${PINNED_COMMIT}, got ${sourceCommit}. ` +
        'Import blocked: the corpus must be at the pinned commit before parsing.',
      );
    }

    // Step 2: Classify files into raw inventory entries
    const entries: RawInventoryEntry[] = [];
    for (const file of files) {
      const entry = buildRawInventoryEntry(file);
      if (entry) {
        entries.push(entry);
      }
    }

    // Step 3: Compute raw inventory breakdown
    const rawBreakdown = computeRawBreakdown(entries);

    // Step 4: Verify breakdown matches expected counts
    const verificationResult = verifyInventoryBreakdown(rawBreakdown);

    // Generate staging run ID
    const stagingRunId = computeSha256(
      `${sourceCommit}:${new Date().toISOString()}:${entries.length}`,
    ).slice(0, 32);

    // Step 5 & 6: Assign External_Asset_IDs and record provenance
    const assets: StagedAssetRecord[] = [];
    const fileContentMap = new Map<string, string>();
    for (const file of files) {
      fileContentMap.set(file.relativePath, file.content);
    }

    for (const entry of entries) {
      const content = fileContentMap.get(entry.relativePath) ?? '';
      const record = createStagedAssetRecord(
        stagingRunId,
        entry,
        content,
        this.licenseSpdx,
        this.noticeText,
      );
      assets.push(record);
    }

    // Step 7: Report counts separately
    const counts = createInitialCounts(entries.length);

    // Construct staging run
    const stagingRun: StagingRun = Object.freeze({
      id: stagingRunId,
      sourceCommit,
      state: verificationResult.status === 'passed' ? 'raw_inventory_verified' as const : 'revision_verified' as const,
      counts,
      rawBreakdown,
      verificationResult,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return Object.freeze({
      stagingRun,
      verificationResult,
      assets: Object.freeze(assets),
      counts,
      publicationBlocked: verificationResult.status === 'failed',
    });
  }

  /**
   * Returns the expected inventory breakdown for reference.
   */
  getExpectedInventory(): RawInventoryBreakdown {
    return Object.freeze({
      directories: EXPECTED_INVENTORY.directories,
      agentFiles: EXPECTED_INVENTORY.agentFiles,
      skillFiles: EXPECTED_INVENTORY.skillFiles,
      orchestratorSkills: EXPECTED_INVENTORY.orchestratorSkills,
      extensionDomainSkills: EXPECTED_INVENTORY.extensionDomainSkills,
    });
  }
}
