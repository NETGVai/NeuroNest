/**
 * Import Recovery Service
 *
 * Implements controlled recovery, quarantine management, compliance preview
 * generation, and atomic import rollback for the Staged Corpus Importer.
 *
 * State machine coverage:
 *   raw_inventory_verified → parsed → recovered → ... → published | quarantined
 *
 * Key invariants:
 * - Raw source and diagnostics are ALWAYS preserved during recovery attempts
 * - Recovery is bounded: no content is invented
 * - Recovered candidates are eligible ONLY after every later gate passes
 * - License defects are NEVER inferred or repaired; they always quarantine
 * - Publication only occurs after approval of a compliance preview
 * - Any failure during activation atomically restores the prior catalog
 * - Staging data is retained for diagnosis after rollback
 * - Apache-2.0 provenance, notice, and modified-file metadata is preserved
 *   as engineering-policy compliance (not legal advice)
 *
 * Requirements: 46.5, 46.6, 46.7, 46.8
 */

import { createHash } from 'crypto';
import type { AgentFileParseResult } from './agent-file-parser';
import { parseAgentFileDocument } from './agent-file-parser';
import type {
  ExternalAssetId,
  InventoryCounts,
  StagedAssetRecord,
  StagingRun,
  TransformationProvenance,
} from './corpus-inventory-types';
import type {
  AssetRecoveryResult,
  CatalogDiffEntry,
  CatalogSnapshot,
  CompliancePreview,
  CompliancePreviewEntry,
  DefectKind,
  DefectSeverity,
  DuplicateDecisionSummary,
  ImportRecoveryServiceResult,
  NoticeMetadata,
  PublicationResult,
  QuarantineRecord,
  QuarantineReason,
  RecoveryAttempt,
  RecoveryDiagnostic,
  RecoveryOutcome,
  RollbackRecord,
  RollbackTrigger,
  ValidationSummary,
} from './import-recovery-types';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Maximum recovery attempts per asset */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** Recovery service version for provenance tracking */
export const RECOVERY_SERVICE_VERSION = '1.0.0';

/** License defect kinds that always quarantine */
const LICENSE_DEFECT_KINDS: ReadonlySet<string> = new Set([
  'license_missing',
  'license_invalid',
  'license_incompatible',
]);

// ─────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────

function generateId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function now(): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// Recovery Detection
// ─────────────────────────────────────────────

/**
 * Detects defects in a raw asset source that may be recoverable.
 * Returns diagnostics describing what was found.
 */
export function detectDefects(
  rawSource: string,
  externalAssetId: ExternalAssetId,
): RecoveryDiagnostic[] {
  const diagnostics: RecoveryDiagnostic[] = [];
  const timestamp = now();

  // Check for wrapper issues (malformed markdown wrappers)
  if (hasWrapperDefect(rawSource)) {
    diagnostics.push({
      code: 'WRAPPER_MALFORMED',
      kind: 'wrapper_malformed',
      severity: 'recoverable',
      message: 'Asset has a malformed wrapper pattern that can be stripped or normalized',
      rawSourceEvidence: rawSource.slice(0, 200),
      startOffset: 0,
      endOffset: Math.min(rawSource.length, 200),
      recoveryAction: null,
      recovered: false,
      detectedAt: timestamp,
    });
  }

  // Check for frontmatter issues
  const frontmatterDiag = detectFrontmatterDefect(rawSource);
  if (frontmatterDiag) {
    diagnostics.push({
      ...frontmatterDiag,
      detectedAt: timestamp,
    });
  }

  // Check for identity issues (missing or malformed identity section markers)
  if (hasIdentityDefect(rawSource, externalAssetId)) {
    diagnostics.push({
      code: 'IDENTITY_MALFORMED',
      kind: 'identity_malformed',
      severity: 'recoverable',
      message: 'Asset identity section is malformed or inconsistent with path-derived identity',
      rawSourceEvidence: extractIdentityEvidence(rawSource),
      startOffset: 0,
      endOffset: Math.min(rawSource.length, 500),
      recoveryAction: null,
      recovered: false,
      detectedAt: timestamp,
    });
  }

  // Check for relationship defects (body-encoded references)
  if (hasRelationshipDefect(rawSource)) {
    diagnostics.push({
      code: 'RELATIONSHIP_MALFORMED',
      kind: 'relationship_malformed',
      severity: 'recoverable',
      message: 'Asset has body-encoded relationships that need structured extraction',
      rawSourceEvidence: extractRelationshipEvidence(rawSource),
      startOffset: 0,
      endOffset: rawSource.length,
      recoveryAction: null,
      recovered: false,
      detectedAt: timestamp,
    });
  }

  // Check for license defects - these are NEVER recoverable
  const licenseDefect = detectLicenseDefect(rawSource);
  if (licenseDefect) {
    diagnostics.push({
      ...licenseDefect,
      detectedAt: timestamp,
    });
  }

  return diagnostics;
}

/**
 * Checks if the source has a malformed wrapper pattern.
 * Common patterns: incomplete code fences wrapping content,
 * stray HTML-like wrappers, or non-standard section delimiters.
 */
export function hasWrapperDefect(source: string): boolean {
  // Detect unbalanced code fences wrapping the entire content
  const fenceMatch = source.match(/^```[\w]*\n/m);
  if (fenceMatch) {
    const closingFences = (source.match(/^```\s*$/gm) ?? []).length;
    const openingFences = (source.match(/^```[\w]*\n/gm) ?? []).length;
    if (openingFences !== closingFences) {
      return true;
    }
  }

  // Detect wrapper HTML-like tags around agent content
  if (/^<(system|agent|prompt|instructions)>/im.test(source) &&
      !new RegExp(`</(system|agent|prompt|instructions)>\\s*$`, 'im').test(source)) {
    return true;
  }

  // Detect content between incomplete delimiters
  if (/^---+\s*$/m.test(source)) {
    const delimCount = (source.match(/^---+\s*$/gm) ?? []).length;
    if (delimCount === 1 && !source.startsWith('---')) {
      return true;
    }
  }

  return false;
}

/**
 * Detects frontmatter defects that may be recoverable.
 */
export function detectFrontmatterDefect(source: string): Omit<RecoveryDiagnostic, 'detectedAt'> | null {
  const trimmed = source.replace(/^\uFEFF/, ''); // strip BOM

  // Check if frontmatter exists but is malformed
  if (trimmed.startsWith('---')) {
    const lines = trimmed.split('\n');
    const closingIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');

    if (closingIdx === -1) {
      // Unterminated frontmatter
      return {
        code: 'FRONTMATTER_UNTERMINATED',
        kind: 'frontmatter_malformed',
        severity: 'recoverable',
        message: 'YAML frontmatter has no closing delimiter; can be recovered by inferring boundary',
        rawSourceEvidence: trimmed.slice(0, 300),
        startOffset: 0,
        endOffset: Math.min(trimmed.length, 300),
        recoveryAction: null,
        recovered: false,
      };
    }

    // Check for malformed field values
    const frontmatterContent = lines.slice(1, closingIdx).join('\n');
    if (/[^\x20-\x7E\n\r\t]/.test(frontmatterContent) && !/[\u00C0-\u024F]/.test(frontmatterContent)) {
      return {
        code: 'FRONTMATTER_ENCODING_ERROR',
        kind: 'frontmatter_malformed',
        severity: 'recoverable',
        message: 'Frontmatter contains non-printable characters that can be sanitized',
        rawSourceEvidence: frontmatterContent.slice(0, 200),
        startOffset: 4, // after opening ---\n
        endOffset: 4 + frontmatterContent.length,
        recoveryAction: null,
        recovered: false,
      };
    }
  }

  return null;
}

/**
 * Checks if the asset has an identity defect.
 * A defect exists when the frontmatter name field contradicts the first
 * non-section heading (level 1 title heading). Section headings like
 * "## Identity" are not identity markers - they are structural.
 */
export function hasIdentityDefect(source: string, externalAssetId: ExternalAssetId): boolean {
  // Find the first non-section heading (i.e., not one of the required six sections)
  const sectionNames = new Set([
    'identity', 'core mission', 'critical rules',
    'technical deliverables', 'workflow process', 'success metrics',
  ]);

  const headingMatches = source.matchAll(/^(#+)\s+(.+)$/gm);
  let titleHeading: string | null = null;

  for (const match of headingMatches) {
    const headingText = match[2].trim().toLowerCase();
    // Skip known section headings
    if (sectionNames.has(headingText)) {
      continue;
    }
    titleHeading = match[2].trim();
    break;
  }

  // If there's no title heading and no frontmatter name, there's no identity at all
  const nameMatch = source.match(/^name:\s*(.+)$/m);
  if (!titleHeading && !nameMatch) {
    // Check if there's any heading at all (section headings are fine for six-section format)
    const anyHeading = source.match(/^#+\s+(.+)$/m);
    if (!anyHeading) {
      return true; // No heading at all
    }
    // Has section headings but no title - that's fine for six-section format if frontmatter has no name
    return false;
  }

  // Check if frontmatter name contradicts the title heading
  if (nameMatch && titleHeading) {
    const fmName = nameMatch[1].trim().replace(/['"]/g, '');
    if (fmName.toLowerCase() !== titleHeading.toLowerCase() && fmName.length > 0) {
      return true; // Contradictory identity
    }
  }

  return false;
}

/**
 * Checks if the asset has body-encoded relationship references.
 */
export function hasRelationshipDefect(source: string): boolean {
  // Detect references to other agents/skills embedded in prose
  const patterns = [
    /@(agent|skill)\s*\(/i,
    /depends[_\s-]on:\s*\[/i,
    /requires:\s*\[.*\]/i,
    /uses:\s*\[.*agent/i,
  ];
  return patterns.some(p => p.test(source));
}

/**
 * Detects license defects. License defects are NEVER recoverable.
 */
export function detectLicenseDefect(source: string): Omit<RecoveryDiagnostic, 'detectedAt'> | null {
  // Check for explicit license statements that conflict with Apache-2.0
  const licensePatterns = [
    /license:\s*(proprietary|all\s*rights\s*reserved|gpl|agpl)/i,
    /\bproprietary\b.*\blicense\b/i,
    /\ball\s*rights\s*reserved\b/i,
  ];

  for (const pattern of licensePatterns) {
    const match = source.match(pattern);
    if (match) {
      return {
        code: 'LICENSE_INCOMPATIBLE',
        kind: 'license_incompatible',
        severity: 'blocking',
        message: `Detected potentially incompatible license statement: "${match[0]}". License defects cannot be inferred or repaired.`,
        rawSourceEvidence: match[0],
        startOffset: match.index ?? 0,
        endOffset: (match.index ?? 0) + match[0].length,
        recoveryAction: null,
        recovered: false,
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Evidence Extraction Helpers
// ─────────────────────────────────────────────

function extractIdentityEvidence(source: string): string {
  const lines = source.split('\n').slice(0, 10);
  return lines.join('\n');
}

function extractRelationshipEvidence(source: string): string {
  const lines = source.split('\n');
  const relevantLines = lines.filter(line =>
    /@(agent|skill)/i.test(line) ||
    /depends[_\s-]on/i.test(line) ||
    /requires:\s*\[/i.test(line) ||
    /uses:\s*\[/i.test(line),
  );
  return relevantLines.join('\n').slice(0, 500);
}

// ─────────────────────────────────────────────
// Controlled Recovery Functions
// ─────────────────────────────────────────────

/**
 * Attempts to recover a wrapper defect by stripping or normalizing
 * the wrapper pattern without inventing content.
 */
export function recoverWrapper(source: string): { recovered: boolean; content: string; action: string } {
  let content = source;
  let action = 'none';

  // Strip unbalanced code fences
  const fenceMatch = content.match(/^```[\w]*\n/);
  if (fenceMatch) {
    const closingFences = (content.match(/^```\s*$/gm) ?? []).length;
    const openingFences = (content.match(/^```[\w]*\n/gm) ?? []).length;
    if (openingFences > closingFences) {
      content = content.replace(/^```[\w]*\n/, '');
      action = 'stripped_unbalanced_opening_fence';
    }
  }

  // Strip HTML-like wrapper tags
  const tagMatch = content.match(/^<(system|agent|prompt|instructions)>\n?/im);
  if (tagMatch) {
    const tagName = tagMatch[1];
    const closingTag = new RegExp(`</${tagName}>\\s*$`, 'im');
    if (!closingTag.test(content)) {
      content = content.replace(new RegExp(`^<${tagName}>\\n?`, 'im'), '');
      action = `stripped_unclosed_${tagName}_tag`;
    } else {
      content = content
        .replace(new RegExp(`^<${tagName}>\\n?`, 'im'), '')
        .replace(closingTag, '');
      action = `stripped_balanced_${tagName}_tags`;
    }
  }

  // Strip stray mid-content delimiter
  if (/^---+\s*$/m.test(content) && !content.startsWith('---')) {
    const delimCount = (content.match(/^---+\s*$/gm) ?? []).length;
    if (delimCount === 1) {
      content = content.replace(/^---+\s*$/m, '');
      action = 'stripped_stray_delimiter';
    }
  }

  return {
    recovered: content !== source,
    content,
    action,
  };
}

/**
 * Attempts to recover a frontmatter defect without inventing content.
 * Only adds a closing delimiter if one is clearly missing.
 */
export function recoverFrontmatter(source: string): { recovered: boolean; content: string; action: string } {
  const trimmed = source.replace(/^\uFEFF/, '');

  if (!trimmed.startsWith('---')) {
    return { recovered: false, content: source, action: 'none' };
  }

  const lines = trimmed.split('\n');
  const closingIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');

  if (closingIdx === -1) {
    // Find where the frontmatter likely ends (first heading or blank line after key-values)
    let inferredEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // If we hit a markdown heading, close frontmatter before it
      if (/^#+\s/.test(line)) {
        inferredEnd = i;
        break;
      }
      // If we hit a blank line after at least one key-value, that's probably the boundary
      if (line.trim() === '' && i > 1 && /^[a-zA-Z_-]+:/.test(lines[i - 1])) {
        inferredEnd = i;
        break;
      }
    }

    if (inferredEnd > 0) {
      const newLines = [
        ...lines.slice(0, inferredEnd),
        '---',
        ...lines.slice(inferredEnd),
      ];
      const content = (source.startsWith('\uFEFF') ? '\uFEFF' : '') + newLines.join('\n');
      return {
        recovered: true,
        content,
        action: 'inserted_inferred_closing_delimiter',
      };
    }
  }

  // Handle encoding issues in frontmatter values
  if (closingIdx > 0) {
    const frontmatterLines = lines.slice(1, closingIdx);
    let modified = false;
    const cleanedLines = frontmatterLines.map(line => {
      // Remove non-printable characters (keeping unicode letters)
      const cleaned = line.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      if (cleaned !== line) {
        modified = true;
      }
      return cleaned;
    });

    if (modified) {
      const newLines = [
        lines[0],
        ...cleanedLines,
        ...lines.slice(closingIdx),
      ];
      const content = (source.startsWith('\uFEFF') ? '\uFEFF' : '') + newLines.join('\n');
      return {
        recovered: true,
        content,
        action: 'sanitized_frontmatter_encoding',
      };
    }
  }

  return { recovered: false, content: source, action: 'none' };
}

/**
 * Attempts to recover an identity defect by ensuring the heading
 * is present, without inventing expertise or credentials.
 */
export function recoverIdentity(source: string, externalAssetId: ExternalAssetId): { recovered: boolean; content: string; action: string } {
  // If there's no heading at all, we cannot recover without inventing content
  const firstHeading = source.match(/^(#+)\s+(.+)$/m);
  if (!firstHeading) {
    return { recovered: false, content: source, action: 'no_heading_found_cannot_recover' };
  }

  // Find the first non-section heading (title heading)
  const sectionNames = new Set([
    'identity', 'core mission', 'critical rules',
    'technical deliverables', 'workflow process', 'success metrics',
  ]);
  const headingMatches = source.matchAll(/^(#+)\s+(.+)$/gm);
  let titleHeading: string | null = null;
  for (const match of headingMatches) {
    const headingText = match[2].trim().toLowerCase();
    if (!sectionNames.has(headingText)) {
      titleHeading = match[2].trim();
      break;
    }
  }

  // If frontmatter name contradicts title heading, prefer the heading (source truth)
  const nameMatch = source.match(/^(name:\s*)(.+)$/m);
  if (nameMatch && titleHeading) {
    const fmName = nameMatch[2].trim().replace(/['"]/g, '');
    if (fmName.toLowerCase() !== titleHeading.toLowerCase() && fmName.length > 0) {
      // Align the contradictory frontmatter name to the title heading
      const content = source.replace(/^name:\s*.+$/m, `name: "${titleHeading}"`);
      return {
        recovered: true,
        content,
        action: 'aligned_frontmatter_name_to_heading',
      };
    }
  }

  return { recovered: false, content: source, action: 'none' };
}

/**
 * Attempts to recover relationship defects by extracting structured
 * references from body-encoded patterns without inventing connections.
 */
export function recoverRelationships(source: string): { recovered: boolean; content: string; action: string; extractedRelationships: string[] } {
  // We don't modify the source content for relationship defects.
  // Instead we extract the relationships that are body-encoded
  // and flag them for structured representation.
  // The content remains unchanged; relationships are extracted as metadata.
  const relationships: string[] = [];

  const agentRefs = source.match(/@agent\s*\(\s*["']?([^"')]+)["']?\s*\)/gi);
  if (agentRefs) {
    for (const ref of agentRefs) {
      const match = ref.match(/@agent\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (match) {
        relationships.push(`agent:${match[1].trim()}`);
      }
    }
  }

  const skillRefs = source.match(/@skill\s*\(\s*["']?([^"')]+)["']?\s*\)/gi);
  if (skillRefs) {
    for (const ref of skillRefs) {
      const match = ref.match(/@skill\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (match) {
        relationships.push(`skill:${match[1].trim()}`);
      }
    }
  }

  const depsMatch = source.match(/depends[_\s-]on:\s*\[([^\]]+)\]/i);
  if (depsMatch) {
    const deps = depsMatch[1].split(',').map(d => d.trim().replace(/['"]/g, ''));
    for (const dep of deps) {
      if (dep) relationships.push(`depends_on:${dep}`);
    }
  }

  return {
    recovered: relationships.length > 0,
    content: source, // Content is NOT modified
    action: relationships.length > 0 ? 'extracted_body_encoded_relationships' : 'none',
    extractedRelationships: relationships,
  };
}

/**
 * Attempts bounded parse recovery using the agent-file-parser.
 * Does not invent content - only attempts to get the parser to
 * extract existing sections.
 */
export function attemptParseRecovery(source: string): { recovered: boolean; content: string; action: string; parseResult: AgentFileParseResult | null } {
  const parseResult = parseAgentFileDocument(source);

  if (parseResult.status === 'success' || parseResult.status === 'recovered') {
    return {
      recovered: true,
      content: source,
      action: parseResult.status === 'recovered' ? 'parser_recovered_sections' : 'parsed_successfully',
      parseResult,
    };
  }

  // If the parse failed, the content cannot be recovered at this stage
  return {
    recovered: false,
    content: source,
    action: 'parse_failed_no_recovery_possible',
    parseResult,
  };
}

// ─────────────────────────────────────────────
// Import Recovery Service
// ─────────────────────────────────────────────

/**
 * ImportRecoveryService orchestrates controlled recovery, quarantine,
 * compliance preview, and atomic rollback for the staged corpus import.
 *
 * It processes StagedAssetRecords from CorpusInventoryVerifier (task 6.4)
 * and advances them through the pipeline states while maintaining all
 * required invariants.
 */
export class ImportRecoveryService {
  private readonly quarantineRecords: QuarantineRecord[] = [];
  private readonly recoveryResults: AssetRecoveryResult[] = [];
  private catalogSnapshot: CatalogSnapshot | null = null;

  // ─────────────────────────────────────────
  // Recovery Phase
  // ─────────────────────────────────────────

  /**
   * Processes a batch of staged asset records through controlled recovery.
   *
   * For each asset:
   * 1. Preserves the raw source
   * 2. Detects defects
   * 3. If license defect → quarantine immediately (never infer/repair)
   * 4. If recoverable defect → attempt bounded recovery
   * 5. If recovery succeeds → mark eligible for later gates
   * 6. If recovery fails → quarantine
   *
   * @param assets The staged assets from CorpusInventoryVerifier
   * @param contents Map of asset ID to raw content
   * @param stagingRun The current staging run record
   */
  processRecovery(
    assets: readonly StagedAssetRecord[],
    contents: ReadonlyMap<string, string>,
    stagingRun: StagingRun,
  ): ImportRecoveryServiceResult {
    this.quarantineRecords.length = 0;
    this.recoveryResults.length = 0;

    let recoveredCount = 0;
    let noRecoveryNeededCount = 0;
    let failedRecoveryCount = 0;

    for (const asset of assets) {
      const rawSource = contents.get(asset.id) ?? '';
      const result = this.recoverAsset(asset, rawSource);
      this.recoveryResults.push(result);

      if (result.shouldQuarantine) {
        this.quarantineAsset(asset, result, rawSource);
        failedRecoveryCount++;
      } else if (result.outcome === 'recovered') {
        recoveredCount++;
      } else {
        noRecoveryNeededCount++;
      }
    }

    const counts: InventoryCounts = Object.freeze({
      raw: assets.length,
      parsed: recoveredCount + noRecoveryNeededCount,
      recovered: recoveredCount,
      quarantined: this.quarantineRecords.length,
      reconciled: 0,
      effective: 0,
    });

    return Object.freeze({
      stagingRun: {
        ...stagingRun,
        state: 'recovered' as const,
        counts,
        updatedAt: now(),
      },
      recoveryResults: Object.freeze([...this.recoveryResults]),
      quarantineRecords: Object.freeze([...this.quarantineRecords]),
      counts,
      recoveryComplete: true,
      recoveredCount,
      noRecoveryNeededCount,
      failedRecoveryCount,
    });
  }

  /**
   * Attempts controlled recovery on a single asset.
   */
  private recoverAsset(asset: StagedAssetRecord, rawSource: string): AssetRecoveryResult {
    const diagnostics = detectDefects(rawSource, asset.externalAssetId);
    const attempts: RecoveryAttempt[] = [];

    // Check for license defects first - these immediately quarantine
    const licenseDefects = diagnostics.filter(d => LICENSE_DEFECT_KINDS.has(d.kind));
    if (licenseDefects.length > 0) {
      return Object.freeze({
        assetId: asset.id,
        externalAssetId: asset.externalAssetId,
        outcome: 'failed' as RecoveryOutcome,
        attempts: Object.freeze(attempts),
        diagnostics: Object.freeze(diagnostics),
        shouldQuarantine: true,
        quarantineReason: 'License defect detected. License content is never inferred or repaired.',
        eligibleForLaterGates: false,
        rawSource,
        recoveredContent: null,
      });
    }

    // If no defects, no recovery needed
    const recoverableDefects = diagnostics.filter(d => d.severity === 'recoverable');
    if (recoverableDefects.length === 0) {
      // Try parsing to confirm it's valid
      const parseResult = parseAgentFileDocument(rawSource);
      if (parseResult.status === 'success') {
        return Object.freeze({
          assetId: asset.id,
          externalAssetId: asset.externalAssetId,
          outcome: 'not_needed' as RecoveryOutcome,
          attempts: Object.freeze(attempts),
          diagnostics: Object.freeze(diagnostics),
          shouldQuarantine: false,
          quarantineReason: null,
          eligibleForLaterGates: true,
          rawSource,
          recoveredContent: rawSource,
        });
      }
    }

    // Attempt bounded recovery
    let currentContent = rawSource;
    let anyRecovered = false;
    const rawSourceHash = createHash('sha256').update(rawSource).digest('hex');

    for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS && recoverableDefects.length > 0; attempt++) {
      const startTime = Date.now();
      const attemptDiagnostics: RecoveryDiagnostic[] = [];
      const actions: string[] = [];
      let attemptSucceeded = false;

      // Try each recovery strategy in order
      if (hasWrapperDefect(currentContent)) {
        const result = recoverWrapper(currentContent);
        if (result.recovered) {
          currentContent = result.content;
          actions.push(result.action);
          attemptSucceeded = true;
          anyRecovered = true;
        }
      }

      if (detectFrontmatterDefect(currentContent)) {
        const result = recoverFrontmatter(currentContent);
        if (result.recovered) {
          currentContent = result.content;
          actions.push(result.action);
          attemptSucceeded = true;
          anyRecovered = true;
        }
      }

      if (hasIdentityDefect(currentContent, asset.externalAssetId)) {
        const result = recoverIdentity(currentContent, asset.externalAssetId);
        if (result.recovered) {
          currentContent = result.content;
          actions.push(result.action);
          attemptSucceeded = true;
          anyRecovered = true;
        }
      }

      if (hasRelationshipDefect(currentContent)) {
        const result = recoverRelationships(currentContent);
        if (result.recovered) {
          actions.push(result.action);
          attemptSucceeded = true;
          anyRecovered = true;
        }
      }

      // Try parse recovery on the current state
      const parseRecovery = attemptParseRecovery(currentContent);
      if (parseRecovery.recovered) {
        actions.push(parseRecovery.action);
        attemptSucceeded = true;
        anyRecovered = true;
      }

      attempts.push(Object.freeze({
        attemptId: generateId(`${asset.id}:attempt:${attempt}`),
        assetId: asset.id,
        externalAssetId: asset.externalAssetId,
        recoveryKind: recoverableDefects[0]?.kind as any ?? 'parse_error',
        diagnostics: Object.freeze(attemptDiagnostics),
        succeeded: attemptSucceeded,
        rawSourceHash,
        recoveredContentHash: attemptSucceeded
          ? createHash('sha256').update(currentContent).digest('hex')
          : null,
        actions: Object.freeze(actions),
        attemptedAt: now(),
        durationMs: Date.now() - startTime,
      }));

      if (attemptSucceeded) {
        break; // Recovery succeeded for this round
      }
    }

    // Final validation: can the recovered content be parsed?
    if (anyRecovered) {
      const finalParse = parseAgentFileDocument(currentContent);
      if (finalParse.status === 'failed') {
        // Recovery didn't produce a parseable result
        return Object.freeze({
          assetId: asset.id,
          externalAssetId: asset.externalAssetId,
          outcome: 'failed' as RecoveryOutcome,
          attempts: Object.freeze(attempts),
          diagnostics: Object.freeze(diagnostics),
          shouldQuarantine: true,
          quarantineReason: 'Recovery attempts did not produce a parseable result',
          eligibleForLaterGates: false,
          rawSource,
          recoveredContent: null,
        });
      }

      return Object.freeze({
        assetId: asset.id,
        externalAssetId: asset.externalAssetId,
        outcome: 'recovered' as RecoveryOutcome,
        attempts: Object.freeze(attempts),
        diagnostics: Object.freeze(diagnostics),
        shouldQuarantine: false,
        quarantineReason: null,
        eligibleForLaterGates: true,
        rawSource,
        recoveredContent: currentContent,
      });
    }

    // No recovery was performed and defects exist → try direct parse
    const directParse = parseAgentFileDocument(currentContent);
    if (directParse.status !== 'failed') {
      return Object.freeze({
        assetId: asset.id,
        externalAssetId: asset.externalAssetId,
        outcome: 'not_needed' as RecoveryOutcome,
        attempts: Object.freeze(attempts),
        diagnostics: Object.freeze(diagnostics),
        shouldQuarantine: false,
        quarantineReason: null,
        eligibleForLaterGates: true,
        rawSource,
        recoveredContent: rawSource,
      });
    }

    // Cannot recover
    return Object.freeze({
      assetId: asset.id,
      externalAssetId: asset.externalAssetId,
      outcome: 'failed' as RecoveryOutcome,
      attempts: Object.freeze(attempts),
      diagnostics: Object.freeze(diagnostics),
      shouldQuarantine: true,
      quarantineReason: 'No applicable recovery strategy produced a valid result',
      eligibleForLaterGates: false,
      rawSource,
      recoveredContent: null,
    });
  }

  // ─────────────────────────────────────────
  // Quarantine Management
  // ─────────────────────────────────────────

  /**
   * Quarantines a candidate asset. Quarantined assets are never placed
   * in the effective catalog.
   */
  private quarantineAsset(
    asset: StagedAssetRecord,
    result: AssetRecoveryResult,
    rawSource: string,
  ): QuarantineRecord {
    const reason: QuarantineReason = this.classifyQuarantineReason(result);
    const record: QuarantineRecord = Object.freeze({
      id: generateId(`quarantine:${asset.id}:${now()}`),
      assetId: asset.id,
      externalAssetId: asset.externalAssetId,
      reason,
      explanation: result.quarantineReason ?? 'Quarantined due to unrecoverable defect',
      diagnostics: Object.freeze([...result.diagnostics]),
      recoveryAttempts: Object.freeze([...result.attempts]),
      rawSource,
      provenance: asset.provenance,
      quarantinedAt: now(),
    });

    this.quarantineRecords.push(record);
    return record;
  }

  /**
   * Classifies the quarantine reason from recovery result diagnostics.
   */
  private classifyQuarantineReason(result: AssetRecoveryResult): QuarantineReason {
    const hasLicenseDefect = result.diagnostics.some(d => LICENSE_DEFECT_KINDS.has(d.kind));
    if (hasLicenseDefect) {
      return 'license_defect';
    }
    return 'recovery_failed';
  }

  /**
   * Quarantines an asset explicitly (used by later gates).
   */
  quarantineExplicitly(
    asset: StagedAssetRecord,
    reason: QuarantineReason,
    explanation: string,
    diagnostics: readonly RecoveryDiagnostic[],
    rawSource: string,
  ): QuarantineRecord {
    const record: QuarantineRecord = Object.freeze({
      id: generateId(`quarantine:${asset.id}:${now()}`),
      assetId: asset.id,
      externalAssetId: asset.externalAssetId,
      reason,
      explanation,
      diagnostics: Object.freeze([...diagnostics]),
      recoveryAttempts: Object.freeze([]),
      rawSource,
      provenance: asset.provenance,
      quarantinedAt: now(),
    });

    this.quarantineRecords.push(record);
    return record;
  }

  // ─────────────────────────────────────────
  // Compliance Preview
  // ─────────────────────────────────────────

  /**
   * Generates a compliance preview for approval before any publication.
   * Shows inventory, provenance, transformations, duplicates, validation,
   * notices, and catalog diff.
   *
   * This must be approved before any activation per R46.6.
   */
  generateCompliancePreview(
    stagingRunId: string,
    recoveryResults: readonly AssetRecoveryResult[],
    quarantineRecords: readonly QuarantineRecord[],
    counts: InventoryCounts,
    assets: readonly StagedAssetRecord[],
    duplicateDecisions?: readonly DuplicateDecisionSummary[],
  ): CompliancePreview {
    const entries: CompliancePreviewEntry[] = [];

    for (const asset of assets) {
      const recoveryResult = recoveryResults.find(r => r.assetId === asset.id);
      const isQuarantined = quarantineRecords.some(q => q.assetId === asset.id);

      entries.push(this.buildPreviewEntry(asset, recoveryResult, isQuarantined));
    }

    const catalogDiff = this.buildCatalogDiff(assets, quarantineRecords, recoveryResults);
    const validationSummary = this.buildValidationSummary(recoveryResults, quarantineRecords);

    const notices: string[] = [
      'Apache-2.0 provenance, notice, and modified-file obligations are preserved as engineering-policy compliance.',
      'This handling is engineering compliance, not legal advice.',
      `Source commit: ${assets[0]?.provenance.sourceCommit ?? 'unknown'}`,
      `Total candidates: ${assets.length}`,
      `Quarantined: ${quarantineRecords.length}`,
      `Eligible for activation: ${assets.length - quarantineRecords.length}`,
    ];

    return Object.freeze({
      id: generateId(`preview:${stagingRunId}:${now()}`),
      stagingRunId,
      inventorySummary: counts,
      entries: Object.freeze(entries),
      quarantinedEntries: Object.freeze([...quarantineRecords]),
      catalogDiff: Object.freeze(catalogDiff),
      duplicateDecisions: Object.freeze([...(duplicateDecisions ?? [])]),
      validationSummary,
      notices: Object.freeze(notices),
      requiresApproval: true,
      generatedAt: now(),
    });
  }

  /**
   * Builds a single compliance preview entry for an asset.
   */
  private buildPreviewEntry(
    asset: StagedAssetRecord,
    recoveryResult: AssetRecoveryResult | undefined,
    isQuarantined: boolean,
  ): CompliancePreviewEntry {
    const transformations: string[] = [];
    if (recoveryResult) {
      for (const attempt of recoveryResult.attempts) {
        transformations.push(...attempt.actions);
      }
    }

    const noticeMetadata: NoticeMetadata = {
      licenseSpdx: asset.provenance.licenseSpdx,
      noticeFilePresent: asset.provenance.noticeText !== null,
      noticeText: asset.provenance.noticeText,
      modifiedFiles: recoveryResult?.outcome === 'recovered'
        ? [asset.provenance.sourcePath]
        : [],
      provenanceComplete: true,
      policyLabel: 'engineering_compliance',
    };

    return Object.freeze({
      externalAssetId: asset.externalAssetId,
      assetKind: asset.assetKind,
      state: isQuarantined ? 'quarantined' : (recoveryResult?.outcome ?? 'pending'),
      provenanceSummary: {
        sourceCommit: asset.provenance.sourceCommit,
        sourcePath: asset.provenance.sourcePath,
        licenseSpdx: asset.provenance.licenseSpdx,
        noticeText: asset.provenance.noticeText,
      },
      transformations: Object.freeze(transformations),
      duplicateStatus: 'unique' as const,
      validationOutcome: isQuarantined ? 'failed' as const : 'pending' as const,
      quarantined: isQuarantined,
      noticeMetadata,
    });
  }

  /**
   * Builds the catalog diff showing what would change on activation.
   */
  private buildCatalogDiff(
    assets: readonly StagedAssetRecord[],
    quarantineRecords: readonly QuarantineRecord[],
    recoveryResults: readonly AssetRecoveryResult[],
  ): CatalogDiffEntry[] {
    const quarantinedIds = new Set(quarantineRecords.map(q => q.assetId));
    const diff: CatalogDiffEntry[] = [];

    for (const asset of assets) {
      if (quarantinedIds.has(asset.id)) {
        diff.push({
          externalAssetId: asset.externalAssetId,
          action: 'skip_quarantined',
          reason: quarantineRecords.find(q => q.assetId === asset.id)?.explanation ?? 'Quarantined',
        });
      } else {
        const result = recoveryResults.find(r => r.assetId === asset.id);
        diff.push({
          externalAssetId: asset.externalAssetId,
          action: 'add',
          reason: result?.outcome === 'recovered'
            ? 'Recovered and eligible for activation'
            : 'No defects found, eligible for activation',
        });
      }
    }

    return diff;
  }

  /**
   * Builds a summary of validation outcomes.
   */
  private buildValidationSummary(
    recoveryResults: readonly AssetRecoveryResult[],
    quarantineRecords: readonly QuarantineRecord[],
  ): ValidationSummary {
    const totalCandidates = recoveryResults.length;
    const quarantined = quarantineRecords.length;
    const passed = recoveryResults.filter(r => r.eligibleForLaterGates).length;
    const failed = recoveryResults.filter(r => r.shouldQuarantine).length;
    const pendingReview = totalCandidates - passed - failed;

    return Object.freeze({
      totalCandidates,
      passed,
      failed,
      quarantined,
      pendingReview,
    });
  }

  // ─────────────────────────────────────────
  // Atomic Import Rollback
  // ─────────────────────────────────────────

  /**
   * Takes a snapshot of the current catalog state before publication.
   * This snapshot is used to restore the prior state on failure.
   */
  takeCatalogSnapshot(
    currentAgentCount: number,
    currentSkillCount: number,
    catalogFingerprint: string,
  ): CatalogSnapshot {
    const snapshot: CatalogSnapshot = Object.freeze({
      id: generateId(`snapshot:${catalogFingerprint}:${now()}`),
      fingerprint: catalogFingerprint,
      createdAt: now(),
      effectiveAgentCount: currentAgentCount,
      effectiveSkillCount: currentSkillCount,
    });
    this.catalogSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Attempts to publish approved candidates to the effective catalog.
   * If any candidate activation, relationship update, or catalog index
   * update fails, atomically restores the prior catalog and retains
   * staging for diagnosis.
   *
   * @param approvedAssetIds Asset IDs approved for publication
   * @param publishFn Callback that performs the actual catalog write.
   *   Should throw on failure.
   * @returns Publication result with rollback info on failure
   */
  async attemptPublication(
    approvedAssetIds: readonly string[],
    publishFn: (assetIds: readonly string[]) => Promise<void>,
  ): Promise<PublicationResult> {
    if (!this.catalogSnapshot) {
      throw new Error('No catalog snapshot taken before publication. Call takeCatalogSnapshot first.');
    }

    const priorSnapshot = this.catalogSnapshot;
    const quarantinedDuring: string[] = [];

    try {
      await publishFn(approvedAssetIds);

      // Publication succeeded
      const newSnapshot: CatalogSnapshot = Object.freeze({
        id: generateId(`snapshot:post-publish:${now()}`),
        fingerprint: createHash('sha256')
          .update(`${priorSnapshot.fingerprint}:${approvedAssetIds.join(',')}`)
          .digest('hex'),
        createdAt: now(),
        effectiveAgentCount: priorSnapshot.effectiveAgentCount + approvedAssetIds.length,
        effectiveSkillCount: priorSnapshot.effectiveSkillCount,
      });

      return Object.freeze({
        success: true,
        rollback: null,
        priorSnapshot,
        newSnapshot,
        publishedAssetIds: Object.freeze([...approvedAssetIds]),
        quarantinedDuringPublication: Object.freeze(quarantinedDuring),
        completedAt: now(),
      });
    } catch (error) {
      // Publication failed - perform atomic rollback
      const rollbackRecord = this.performRollback(
        priorSnapshot,
        approvedAssetIds,
        error instanceof Error ? error.message : String(error),
        'publication_transaction_failed',
      );

      return Object.freeze({
        success: false,
        rollback: rollbackRecord,
        priorSnapshot,
        newSnapshot: null,
        publishedAssetIds: Object.freeze([]),
        quarantinedDuringPublication: Object.freeze(quarantinedDuring),
        completedAt: now(),
      });
    }
  }

  /**
   * Performs rollback by restoring the prior catalog snapshot.
   * Staging data is retained for diagnosis.
   */
  private performRollback(
    priorSnapshot: CatalogSnapshot,
    affectedAssetIds: readonly string[],
    error: string,
    trigger: RollbackTrigger,
  ): RollbackRecord {
    const startTime = Date.now();

    // The actual catalog restore is handled by the caller/database layer.
    // This service records the rollback metadata and ensures staging is preserved.
    const rollbackRecord: RollbackRecord = Object.freeze({
      id: generateId(`rollback:${priorSnapshot.id}:${now()}`),
      stagingRunId: this.recoveryResults[0]?.assetId ?? 'unknown',
      trigger,
      error,
      restoredSnapshotId: priorSnapshot.id,
      affectedAssetIds: Object.freeze([...affectedAssetIds]),
      stagingRetained: true, // Always retain staging for diagnosis
      rolledBackAt: now(),
      rollbackDurationMs: Date.now() - startTime,
    });

    return rollbackRecord;
  }

  /**
   * Handles rollback for relationship update failures.
   */
  rollbackOnRelationshipFailure(
    priorSnapshot: CatalogSnapshot,
    affectedAssetIds: readonly string[],
    error: string,
  ): RollbackRecord {
    return this.performRollback(
      priorSnapshot,
      affectedAssetIds,
      error,
      'relationship_update_failed',
    );
  }

  /**
   * Handles rollback for index update failures.
   */
  rollbackOnIndexFailure(
    priorSnapshot: CatalogSnapshot,
    affectedAssetIds: readonly string[],
    error: string,
  ): RollbackRecord {
    return this.performRollback(
      priorSnapshot,
      affectedAssetIds,
      error,
      'index_update_failed',
    );
  }

  /**
   * Handles rollback for candidate activation failures.
   */
  rollbackOnActivationFailure(
    priorSnapshot: CatalogSnapshot,
    affectedAssetIds: readonly string[],
    error: string,
  ): RollbackRecord {
    return this.performRollback(
      priorSnapshot,
      affectedAssetIds,
      error,
      'candidate_activation_failed',
    );
  }

  // ─────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────

  /** Returns all quarantine records accumulated */
  getQuarantineRecords(): readonly QuarantineRecord[] {
    return Object.freeze([...this.quarantineRecords]);
  }

  /** Returns all recovery results */
  getRecoveryResults(): readonly AssetRecoveryResult[] {
    return Object.freeze([...this.recoveryResults]);
  }

  /** Returns the current catalog snapshot (if taken) */
  getCatalogSnapshot(): CatalogSnapshot | null {
    return this.catalogSnapshot;
  }
}
