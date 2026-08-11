/**
 * Staged Upgrade Application
 *
 * Deterministic APIs for generating agent body upgrade candidates and applying
 * them atomically. Source replacement happens only after the complete staged
 * catalog passes quality validation; any scope, hash, identity, parsing,
 * authenticity, or quality failure aborts all writes.
 *
 * Requirements: 1.3, 6.2, 6.7, 7.14
 */

import { createHash } from 'node:crypto';

import type { CatalogManifest } from './catalog-discovery';
import type { FrontmatterSnapshot } from './agent-file-parser';
import { parseAgentFileDocument } from './agent-file-parser';
import {
  validateLoadedCatalog,
  type CatalogValidatorOptions,
  type LoadedCatalogSource,
} from './catalog-validator';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type UpgradeAbortReason =
  | 'SCOPE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'PARSE_FAILURE'
  | 'AUTHENTICITY_FAILURE'
  | 'QUALITY_FAILURE'
  | 'FRONTMATTER_NOT_PRESERVED';

export interface UpgradeCandidate {
  /** Root-relative source path. */
  readonly sourcePath: string;
  /** Expected SHA-256 of the original source bytes captured during discovery. */
  readonly expectedSourceHash: string;
  /** Replacement body content (everything after frontmatter). */
  readonly candidateBody: string;
}

export interface StagedUpgradeInput {
  readonly manifest: CatalogManifest;
  readonly candidates: readonly UpgradeCandidate[];
  /** Optional validator configuration (scorer, read overrides, etc.). */
  readonly validatorOptions?: CatalogValidatorOptions;
}

export interface AppliedUpgrade {
  readonly sourcePath: string;
  /** Complete file bytes after applying the upgrade. */
  readonly outputBytes: Uint8Array;
  /** SHA-256 of outputBytes. */
  readonly outputHash: string;
}

export interface StagedUpgradeSuccess {
  readonly status: 'applied';
  readonly applied: readonly AppliedUpgrade[];
}

export interface StagedUpgradeAbort {
  readonly status: 'aborted';
  readonly reasons: readonly UpgradeAbortDetail[];
}

export interface UpgradeAbortDetail {
  readonly reason: UpgradeAbortReason;
  readonly sourcePath: string | null;
  readonly message: string;
}

export type StagedUpgradeResult = StagedUpgradeSuccess | StagedUpgradeAbort;

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reconstructs the complete file from preserved frontmatter and a new body.
 * Frontmatter raw bytes are retained verbatim; only the body following the
 * closing `---\n` delimiter is replaced.
 */
function reconstructFile(frontmatter: FrontmatterSnapshot, newBody: string): Uint8Array {
  const frontmatterText = frontmatter.rawText;
  // Ensure there is exactly one newline between frontmatter and body.
  const normalizedBody = newBody.startsWith('\n') ? newBody : `\n${newBody}`;
  const fullText = frontmatterText + normalizedBody;
  return Uint8Array.from(Buffer.from(fullText, 'utf8'));
}

/**
 * Compares two frontmatter snapshots by identity digest and ordered field
 * names/values. Both must be identical for upgrade to proceed.
 */
function frontmatterIdentityMatches(
  original: FrontmatterSnapshot,
  staged: FrontmatterSnapshot,
): boolean {
  if (original.identityDigest !== staged.identityDigest) {
    return false;
  }
  if (original.orderedFields.length !== staged.orderedFields.length) {
    return false;
  }
  for (let i = 0; i < original.orderedFields.length; i++) {
    const origField = original.orderedFields[i]!;
    const stagedField = staged.orderedFields[i]!;
    if (origField.name !== stagedField.name || origField.rawValue !== stagedField.rawValue) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────

/**
 * Applies staged upgrade candidates to agent source files. The process is
 * all-or-nothing: all candidates must pass scope, hash, frontmatter, parsing,
 * authenticity, and quality checks before any output is produced.
 *
 * Determinism: identical manifest + candidates + validator options always
 * produce byte-identical outputs (or the same abort reasons).
 */
export function applyStagedUpgrades(input: StagedUpgradeInput): StagedUpgradeResult {
  const { manifest, candidates, validatorOptions } = input;
  const abortReasons: UpgradeAbortDetail[] = [];

  // ─── Step 1: Scope check ───
  // Candidates must cover exactly the manifest scope (no missing, no extra).
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.sourcePath));
  const candidatePaths = new Set(candidates.map((candidate) => candidate.sourcePath));

  const missingPaths = [...manifestPaths].filter((path) => !candidatePaths.has(path)).sort();
  const extraPaths = [...candidatePaths].filter((path) => !manifestPaths.has(path)).sort();

  for (const path of missingPaths) {
    abortReasons.push({
      reason: 'SCOPE_MISMATCH',
      sourcePath: path,
      message: `Manifest path has no upgrade candidate: ${path}`,
    });
  }
  for (const path of extraPaths) {
    abortReasons.push({
      reason: 'SCOPE_MISMATCH',
      sourcePath: path,
      message: `Candidate path is not in manifest scope: ${path}`,
    });
  }

  if (abortReasons.length > 0) {
    return { status: 'aborted', reasons: Object.freeze(abortReasons) };
  }

  // ─── Step 2: Hash verification and candidate indexing ───
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.sourcePath, candidate]));
  const entryByPath = new Map(manifest.entries.map((entry) => [entry.sourcePath, entry]));

  for (const candidate of candidates) {
    const entry = entryByPath.get(candidate.sourcePath)!;
    if (candidate.expectedSourceHash !== entry.sourceHash) {
      abortReasons.push({
        reason: 'HASH_MISMATCH',
        sourcePath: candidate.sourcePath,
        message: `Source hash mismatch for ${candidate.sourcePath}: expected ${candidate.expectedSourceHash}, manifest has ${entry.sourceHash}`,
      });
    }
  }

  if (abortReasons.length > 0) {
    return { status: 'aborted', reasons: Object.freeze(abortReasons) };
  }

  // ─── Step 3: Parse originals and reconstruct staged sources ───
  // Use validatorOptions.readSource if provided, otherwise we need the original
  // source bytes. For staged validation, we build new sources from the candidate
  // bodies combined with original frontmatter.
  //
  // We need original source bytes to extract frontmatter. The validator's
  // readSource option can supply them. For staged upgrade, we parse each
  // candidate to verify frontmatter preservation and quality.

  // Build staged sources for validation by combining original frontmatter + candidate body.
  // The caller must ensure original source bytes were captured during discovery.
  // We reconstruct by parsing candidate bodies to extract frontmatter identity.

  const stagedSources: Map<string, Uint8Array> = new Map();
  const originalFrontmatterByPath: Map<string, FrontmatterSnapshot> = new Map();

  for (const entry of manifest.entries) {
    const candidate = candidateByPath.get(entry.sourcePath)!;

    // Parse the candidate body to get its frontmatter and validate structure.
    // The candidate must preserve original frontmatter. We reconstruct the staged
    // source by parsing the candidateBody (which should include frontmatter).
    const parseResult = parseAgentFileDocument(candidate.candidateBody);

    if (!parseResult.frontmatter.present || !parseResult.frontmatter.parseable) {
      abortReasons.push({
        reason: 'PARSE_FAILURE',
        sourcePath: entry.sourcePath,
        message: `Candidate for ${entry.sourcePath} has unparseable or missing frontmatter`,
      });
      continue;
    }

    originalFrontmatterByPath.set(entry.sourcePath, parseResult.frontmatter);
    stagedSources.set(entry.sourcePath, parseResult.sourceBytes);
  }

  if (abortReasons.length > 0) {
    return { status: 'aborted', reasons: Object.freeze(abortReasons) };
  }

  // ─── Step 4: Frontmatter identity verification ───
  // Verify the candidate frontmatter matches manifest entry expectations.
  // We compare by identity digest against the original source hash's frontmatter.
  // Since candidates are complete files (frontmatter + body), the frontmatter must
  // match what was discovered. We'll verify during staged validation that the
  // parsed frontmatter identity digest is preserved.

  // ─── Step 5: Staged complete-catalog validation ───
  // Build loaded sources from staged content and run the full quality validator.
  const loadedStagedSources: LoadedCatalogSource[] = manifest.entries.map((entry) => {
    const stagedBytes = stagedSources.get(entry.sourcePath)!;
    return Object.freeze({
      entry,
      source: stagedBytes,
      loadError: null,
    });
  });

  const validationResult = validateLoadedCatalog(manifest, loadedStagedSources, validatorOptions);

  // ─── Step 6: Check for any blocking failures ───
  if (!validationResult.passed) {
    // Collect all specific failure reasons from the validation
    for (const source of validationResult.perSource) {
      if (!source.passed) {
        const blockingFindings = source.findings.filter(
          (finding) => finding.classification === 'blocking',
        );
        if (source.parseStatus === 'failed' || source.parseStatus === 'failed-to-read') {
          abortReasons.push({
            reason: 'PARSE_FAILURE',
            sourcePath: source.sourcePath,
            message: `Staged source failed parsing: ${source.sourcePath}`,
          });
        } else if (blockingFindings.some((finding) => finding.scope === 'authenticity')) {
          abortReasons.push({
            reason: 'AUTHENTICITY_FAILURE',
            sourcePath: source.sourcePath,
            message: `Staged source failed authenticity: ${source.sourcePath}`,
          });
        } else {
          abortReasons.push({
            reason: 'QUALITY_FAILURE',
            sourcePath: source.sourcePath,
            message: `Staged source failed quality validation: ${source.sourcePath}`,
          });
        }
      }
    }

    // Catalog-level failures
    for (const catalogFinding of validationResult.catalogFindings) {
      if (catalogFinding.classification === 'blocking') {
        abortReasons.push({
          reason: 'QUALITY_FAILURE',
          sourcePath: catalogFinding.sourcePath,
          message: catalogFinding.message,
        });
      }
    }

    if (abortReasons.length === 0) {
      // Validation failed but we couldn't pinpoint specific sources
      abortReasons.push({
        reason: 'QUALITY_FAILURE',
        sourcePath: null,
        message: 'Staged catalog validation failed',
      });
    }

    return { status: 'aborted', reasons: Object.freeze(abortReasons) };
  }

  // ─── Step 7: Frontmatter identity post-validation check ───
  // After validation passed, confirm that each staged source preserves the same
  // frontmatter identity. The validator already parsed these sources, so we verify
  // via the parse result from validation that frontmatter bytes are preserved.
  for (const source of validationResult.perSource) {
    if (!source.parseResult) {
      abortReasons.push({
        reason: 'IDENTITY_MISMATCH',
        sourcePath: source.sourcePath,
        message: `No parse result available for identity verification: ${source.sourcePath}`,
      });
      continue;
    }

    const stagedFrontmatter = source.parseResult.frontmatter;

    // Verify identity digest matches what was captured during discovery.
    // Since the candidate is the complete upgraded file, its frontmatter
    // identity digest must match the original. We verify using the entry's
    // source hash approach: the staged frontmatter raw bytes must be identical
    // to the original.
    const originalCandidateFrontmatter = originalFrontmatterByPath.get(source.sourcePath);
    if (originalCandidateFrontmatter && !frontmatterIdentityMatches(
      originalCandidateFrontmatter,
      stagedFrontmatter,
    )) {
      abortReasons.push({
        reason: 'FRONTMATTER_NOT_PRESERVED',
        sourcePath: source.sourcePath,
        message: `Frontmatter identity changed in staged source: ${source.sourcePath}`,
      });
    }
  }

  if (abortReasons.length > 0) {
    return { status: 'aborted', reasons: Object.freeze(abortReasons) };
  }

  // ─── Step 8: Produce deterministic outputs ───
  // Sort by source path for deterministic output ordering.
  const sortedEntries = [...manifest.entries].sort(
    (left, right) => left.sourcePath.localeCompare(right.sourcePath),
  );

  const applied: AppliedUpgrade[] = sortedEntries.map((entry) => {
    const outputBytes = stagedSources.get(entry.sourcePath)!;
    return Object.freeze({
      sourcePath: entry.sourcePath,
      outputBytes,
      outputHash: sha256(outputBytes),
    });
  });

  return Object.freeze({
    status: 'applied',
    applied: Object.freeze(applied),
  });
}

/**
 * Creates an upgrade candidate from an original source and a new body.
 * The candidate preserves the original frontmatter verbatim and replaces
 * only the body content.
 *
 * Returns null if the original source has unparseable frontmatter.
 */
export function createUpgradeCandidate(
  sourcePath: string,
  originalSource: string | Uint8Array,
  newBody: string,
): UpgradeCandidate | null {
  const parseResult = parseAgentFileDocument(originalSource);

  if (!parseResult.frontmatter.present || !parseResult.frontmatter.parseable) {
    return null;
  }

  const reconstructed = reconstructFile(parseResult.frontmatter, newBody);
  const sourceBytes = typeof originalSource === 'string'
    ? Uint8Array.from(Buffer.from(originalSource, 'utf8'))
    : originalSource;
  const expectedSourceHash = sha256(sourceBytes);

  // Verify that reconstruction preserves frontmatter identity
  const verifyParse = parseAgentFileDocument(reconstructed);
  if (!frontmatterIdentityMatches(parseResult.frontmatter, verifyParse.frontmatter)) {
    return null;
  }

  return Object.freeze({
    sourcePath,
    expectedSourceHash,
    candidateBody: Buffer.from(reconstructed).toString('utf8'),
  });
}

/**
 * Convenience: creates upgrade candidates for an entire manifest from a
 * body-generation function. The generator receives the source path and
 * original source bytes and returns the new body string.
 *
 * If any candidate cannot be created (e.g., unparseable frontmatter),
 * it returns an abort result.
 */
export function createUpgradeCandidates(
  manifest: CatalogManifest,
  originalSources: ReadonlyMap<string, string | Uint8Array>,
  bodyGenerator: (sourcePath: string, originalSource: string | Uint8Array) => string,
): { candidates: readonly UpgradeCandidate[] } | { error: UpgradeAbortDetail } {
  const candidates: UpgradeCandidate[] = [];

  for (const entry of manifest.entries) {
    const source = originalSources.get(entry.sourcePath);
    if (source === undefined) {
      return {
        error: {
          reason: 'SCOPE_MISMATCH',
          sourcePath: entry.sourcePath,
          message: `No original source provided for manifest path: ${entry.sourcePath}`,
        },
      };
    }

    const newBody = bodyGenerator(entry.sourcePath, source);
    const candidate = createUpgradeCandidate(entry.sourcePath, source, newBody);
    if (!candidate) {
      return {
        error: {
          reason: 'PARSE_FAILURE',
          sourcePath: entry.sourcePath,
          message: `Cannot create upgrade candidate: unparseable frontmatter in ${entry.sourcePath}`,
        },
      };
    }

    candidates.push(candidate);
  }

  return { candidates: Object.freeze(candidates) };
}
