/**
 * Duplicate Detector
 *
 * Identifies overlapping agents between existing registry and imports using
 * multi-dimensional similarity scoring. Resolves duplicates using quality scoring
 * and generates human-readable reports.
 *
 * Requirements: 2.1, 2.2, 2.6, 2.7
 */

import type { AgentDefinition } from '../agents/agent-registry';
import type {
  DuplicatePair,
  DuplicateReport,
  ImportedAgent,
  QualityBreakdown,
  ResolutionDecision,
  SimilarityScore,
} from './types';

// ─────────────────────────────────────────────
// QualityScorer interface (consumed by resolve)
// ─────────────────────────────────────────────

export interface QualityScorer {
  score(agent: AgentDefinition): QualityBreakdown;
}

// ─────────────────────────────────────────────
// Levenshtein Distance
// ─────────────────────────────────────────────

/**
 * Computes the Levenshtein edit distance between two strings.
 * Uses the iterative matrix approach with O(min(a,b)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;

  // Use two rows instead of full matrix
  let prevRow = new Array<number>(aLen + 1);
  let currRow = new Array<number>(aLen + 1);

  // Initialize first row
  for (let i = 0; i <= aLen; i++) {
    prevRow[i] = i;
  }

  for (let j = 1; j <= bLen; j++) {
    currRow[0] = j;

    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        (currRow[i - 1] ?? 0) + 1,       // insertion
        (prevRow[i] ?? 0) + 1,           // deletion
        (prevRow[i - 1] ?? 0) + cost,    // substitution
      );
    }

    // Swap rows
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[aLen] ?? 0;
}

// ─────────────────────────────────────────────
// Jaccard Coefficient
// ─────────────────────────────────────────────

/**
 * Splits a specialty string into a set of normalized keywords.
 * Splits on spaces, commas, and common punctuation.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[\s,;.:/|&]+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ''))
    .filter((w) => w.length > 0);
  return new Set(words);
}

/**
 * Computes the Jaccard coefficient (intersection / union) of two sets.
 * Returns 0 when both sets are empty.
 */
export function jaccardCoefficient(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

// ─────────────────────────────────────────────
// Similarity Computation
// ─────────────────────────────────────────────

/** Default threshold for flagging duplicates. */
const DEFAULT_THRESHOLD = 0.7;

/** Weights for composite score calculation. */
const WEIGHTS = {
  idMatch: 0.3,
  nameSimilarity: 0.3,
  specialtyOverlap: 0.2,
  departmentMatch: 0.2,
};

/**
 * Computes the multi-dimensional similarity score between two agent definitions.
 *
 * Components:
 * - idMatch: 1 if ids are identical, 0 otherwise
 * - nameSimilarity: 1 - (levenshteinDistance / max(a.name.length, b.name.length))
 * - specialtyOverlap: Jaccard coefficient of specialty keywords
 * - departmentMatch: 1 if departments are identical, 0 otherwise
 * - composite: weighted average (idMatch*0.3 + nameSimilarity*0.3 + specialtyOverlap*0.2 + departmentMatch*0.2)
 */
export function computeSimilarity(a: AgentDefinition, b: AgentDefinition): SimilarityScore {
  // ID match: exact equality
  const idMatch = a.id === b.id ? 1 : 0;

  // Name similarity: normalized Levenshtein
  let nameSimilarity: number;
  const maxNameLen = Math.max(a.name.length, b.name.length);
  if (maxNameLen === 0) {
    nameSimilarity = 1; // Both empty names are considered identical
  } else {
    const distance = levenshteinDistance(a.name, b.name);
    nameSimilarity = 1 - distance / maxNameLen;
  }

  // Specialty keyword overlap: Jaccard coefficient
  const keywordsA = extractKeywords(a.specialty);
  const keywordsB = extractKeywords(b.specialty);
  const specialtyOverlap = jaccardCoefficient(keywordsA, keywordsB);

  // Department match: exact equality
  const departmentMatch = a.department === b.department ? 1 : 0;

  // Composite: weighted average
  const composite =
    WEIGHTS.idMatch * idMatch +
    WEIGHTS.nameSimilarity * nameSimilarity +
    WEIGHTS.specialtyOverlap * specialtyOverlap +
    WEIGHTS.departmentMatch * departmentMatch;

  return {
    idMatch,
    nameSimilarity,
    specialtyOverlap,
    departmentMatch,
    composite,
  };
}

// ─────────────────────────────────────────────
// Duplicate Detection
// ─────────────────────────────────────────────

/**
 * Detects potential duplicates between existing agents and imported agents.
 * Flags pairs whose composite similarity score exceeds the threshold.
 *
 * @param existing - Array of existing agent definitions
 * @param imported - Array of imported agent definitions
 * @param threshold - Minimum composite score to flag as duplicate (default 0.7)
 * @returns Array of duplicate pairs above the threshold
 */
export function detectDuplicates(
  existing: AgentDefinition[],
  imported: ImportedAgent[],
  threshold: number = DEFAULT_THRESHOLD,
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (const importedAgent of imported) {
    for (const existingAgent of existing) {
      const similarity = computeSimilarity(existingAgent, importedAgent.definition);

      if (similarity.composite > threshold) {
        pairs.push({
          existing: existingAgent,
          imported: importedAgent,
          similarity,
        });
      }
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────

/**
 * Resolves a duplicate pair using quality scoring.
 *
 * Resolution rule:
 * - If imported score exceeds existing score by >= 10 → 'replace'
 *   (update systemPrompt and specialty fields)
 * - Otherwise → 'retain' (keep existing agent unchanged)
 *
 * Logs the resolution decision with both scores, winning source, and fields updated.
 */
export function resolve(pair: DuplicatePair, scorer: QualityScorer): ResolutionDecision {
  const existingBreakdown = scorer.score(pair.existing);
  const importedBreakdown = scorer.score(pair.imported.definition);

  const existingScore = existingBreakdown.total;
  const importedScore = importedBreakdown.total;

  const scoreDifference = importedScore - existingScore;

  let action: 'replace' | 'retain';
  let fieldsUpdated: string[];

  if (scoreDifference >= 10) {
    action = 'replace';
    fieldsUpdated = ['systemPrompt', 'specialty'];
  } else {
    action = 'retain';
    fieldsUpdated = [];
  }

  const decision: ResolutionDecision = {
    pair,
    existingScore,
    importedScore,
    action,
    fieldsUpdated,
  };

  // Log the resolution decision
  console.log(
    `[DuplicateDetector] Resolution: ${pair.existing.id} vs ${pair.imported.definition.id} | ` +
      `Existing: ${existingScore}, Imported: ${importedScore} | ` +
      `Action: ${action} | ` +
      `Winner: ${action === 'replace' ? 'imported' : 'existing'} | ` +
      `Fields updated: ${fieldsUpdated.length > 0 ? fieldsUpdated.join(', ') : 'none'}`,
  );

  return decision;
}

// ─────────────────────────────────────────────
// Report Generation
// ─────────────────────────────────────────────

/**
 * Generates a human-readable report listing all detected duplicates,
 * their scores, and the resolution decision for each.
 *
 * @param decisions - Array of resolution decisions to include in the report
 * @returns A DuplicateReport with timestamp, pairs, and decisions
 */
export function generateReport(decisions: ResolutionDecision[]): DuplicateReport {
  const pairs = decisions.map((d) => d.pair);
  const timestamp = new Date().toISOString();

  return {
    pairs,
    decisions,
    timestamp,
  };
}

/**
 * Formats a DuplicateReport as a human-readable string for display/logging.
 */
export function formatReport(report: DuplicateReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                   DUPLICATE DETECTION REPORT                 ');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Total duplicates found: ${report.pairs.length}`);
  lines.push('');

  if (report.decisions.length === 0) {
    lines.push('No duplicates detected.');
    return lines.join('\n');
  }

  for (let i = 0; i < report.decisions.length; i++) {
    const decision = report.decisions[i]!;
    const { pair, existingScore, importedScore, action, fieldsUpdated } = decision;
    const { similarity } = pair;

    lines.push(`─── Pair ${i + 1} ───────────────────────────────────────────────`);
    lines.push(`  Existing: ${pair.existing.name} (${pair.existing.id})`);
    lines.push(`  Imported: ${pair.imported.definition.name} (${pair.imported.definition.id})`);
    lines.push(`  Source:   ${pair.imported.sourceFile}`);
    lines.push('');
    lines.push('  Similarity Scores:');
    lines.push(`    ID Match:          ${similarity.idMatch.toFixed(2)}`);
    lines.push(`    Name Similarity:   ${similarity.nameSimilarity.toFixed(4)}`);
    lines.push(`    Specialty Overlap:  ${similarity.specialtyOverlap.toFixed(4)}`);
    lines.push(`    Department Match:   ${similarity.departmentMatch.toFixed(2)}`);
    lines.push(`    Composite:         ${similarity.composite.toFixed(4)}`);
    lines.push('');
    lines.push('  Quality Scores:');
    lines.push(`    Existing: ${existingScore}/100`);
    lines.push(`    Imported: ${importedScore}/100`);
    lines.push(`    Difference: ${importedScore - existingScore} (imported - existing)`);
    lines.push('');
    lines.push(`  Decision: ${action.toUpperCase()}`);
    lines.push(`    Winner: ${action === 'replace' ? 'Imported' : 'Existing'}`);
    lines.push(`    Fields Updated: ${fieldsUpdated.length > 0 ? fieldsUpdated.join(', ') : 'none'}`);
    lines.push('');
  }

  // Summary
  const replaced = report.decisions.filter((d) => d.action === 'replace').length;
  const retained = report.decisions.filter((d) => d.action === 'retain').length;
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  SUMMARY');
  lines.push(`    Replaced: ${replaced}`);
  lines.push(`    Retained: ${retained}`);
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
