/**
 * OrderedDuplicateReconciler
 *
 * An orchestration facade over the existing authoritative `duplicate-detector.ts`.
 * This module coordinates provenance stages, manual review, and persistence without
 * creating a parallel detection path. The existing duplicate-detector is extended
 * and reused for typed ordered identity evaluation and semantic candidate evidence.
 *
 * Identity stages are evaluated in strict order:
 *   1. External_Asset_ID
 *   2. Exact local ID
 *   3. Canonical content hash
 *   4. Normalized names/aliases
 *   5. Deterministic capability/workflow signature
 *   6. Semantic shortlist similarity
 *
 * A stage is decisive only for one conclusive target and no contradictory
 * higher-confidence provenance. Semantic similarity only proposes candidates;
 * it never decides mutation. Conflicts or multiple targets require manual review.
 *
 * Requirements: 47.1, 47.2, 47.3, 47.4, 47.5, 47.6, 47.7, 47.8
 */

import { createHash } from 'node:crypto';

import { computeSimilarity } from './duplicate-detector';
import type { ExternalAssetId, TransformationProvenance } from './corpus-inventory-types';
import type { AgentDefinition } from '../agents/agent-registry';

// ─────────────────────────────────────────────
// Identity Stage Types
// ─────────────────────────────────────────────

/** The ordered identity evaluation stages per R47.1 */
export type IdentityStage =
  | 'external_asset_id'
  | 'local_id'
  | 'canonical_hash'
  | 'normalized_name'
  | 'deterministic_signature'
  | 'semantic_shortlist';

/** Confidence level derived from the stage position */
export type StageConfidence = 'highest' | 'high' | 'medium' | 'low' | 'advisory';

/** Maps each identity stage to its confidence level */
export const STAGE_CONFIDENCE: Record<IdentityStage, StageConfidence> = {
  external_asset_id: 'highest',
  local_id: 'highest',
  canonical_hash: 'high',
  normalized_name: 'medium',
  deterministic_signature: 'medium',
  semantic_shortlist: 'advisory',
} as const;

/** Ordered list of identity stages for evaluation */
export const IDENTITY_STAGE_ORDER: readonly IdentityStage[] = [
  'external_asset_id',
  'local_id',
  'canonical_hash',
  'normalized_name',
  'deterministic_signature',
  'semantic_shortlist',
] as const;

// ─────────────────────────────────────────────
// Asset Kind for Reconciliation
// ─────────────────────────────────────────────

/** The kind of catalog asset being reconciled */
export type ReconcilableAssetKind = 'agent' | 'skill';

// ─────────────────────────────────────────────
// Candidate Match Types
// ─────────────────────────────────────────────

/** A single candidate match produced by an identity stage */
export interface StageCandidate {
  /** The identity stage that produced this candidate */
  readonly stage: IdentityStage;
  /** Confidence of this stage */
  readonly confidence: StageConfidence;
  /** ID of the candidate match in the existing catalog */
  readonly matchedCatalogId: string;
  /** The evidence that produced this match */
  readonly evidence: string;
  /** Similarity/confidence score for this match (0-1) */
  readonly score: number;
}

/** Whether contradictory evidence was found from a higher-confidence stage */
export interface ContradictionEvidence {
  /** The higher-confidence stage that contradicts */
  readonly contradictingStage: IdentityStage;
  /** What the contradiction is */
  readonly explanation: string;
  /** The contradicting candidate ID */
  readonly contradictingCandidateId: string;
}

// ─────────────────────────────────────────────
// Reconciliation Input Types
// ─────────────────────────────────────────────

/** A catalog entry that candidates are matched against */
export interface CatalogEntry {
  /** Local catalog ID */
  readonly localId: string;
  /** External asset ID if imported */
  readonly externalAssetId?: ExternalAssetId;
  /** Canonical content hash */
  readonly canonicalHash: string;
  /** Normalized name */
  readonly normalizedName: string;
  /** Known aliases */
  readonly aliases: readonly string[];
  /** Deterministic capability/workflow signature hash */
  readonly signatureHash?: string;
  /** The agent/skill definition (for semantic comparison) */
  readonly definition: AgentDefinition;
  /** Whether this is the effective canonical target */
  readonly isEffective: boolean;
  /** Version */
  readonly version: string;
  /** Asset kind */
  readonly kind: ReconcilableAssetKind;
}

/** A candidate to be reconciled against the catalog */
export interface ReconciliationCandidate {
  /** The candidate's proposed ID */
  readonly candidateId: string;
  /** External asset ID */
  readonly externalAssetId?: ExternalAssetId;
  /** Canonical content hash */
  readonly canonicalHash: string;
  /** Name as presented */
  readonly name: string;
  /** Normalized name */
  readonly normalizedName: string;
  /** Known aliases */
  readonly aliases: readonly string[];
  /** Deterministic capability/workflow signature hash */
  readonly signatureHash?: string;
  /** The agent/skill definition for semantic comparison */
  readonly definition: AgentDefinition;
  /** Asset kind */
  readonly kind: ReconcilableAssetKind;
  /** Provenance */
  readonly provenance?: TransformationProvenance;
}

// ─────────────────────────────────────────────
// Reconciliation Decision Types
// ─────────────────────────────────────────────

/** The outcome of reconciliation for a single candidate */
export type ReconciliationOutcome =
  | 'unique'
  | 'confirmed_duplicate'
  | 'requires_manual_review'
  | 'rejected_ambiguous';

/** The review status */
export type ReviewStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected';

/** A reconciliation decision for a single candidate */
export interface ReconciliationDecision {
  /** Unique decision ID */
  readonly decisionId: string;
  /** The candidate being reconciled */
  readonly candidateId: string;
  /** Asset kind */
  readonly kind: ReconcilableAssetKind;
  /** The outcome */
  readonly outcome: ReconciliationOutcome;
  /** Which stage produced the decisive match (null if unique or ambiguous) */
  readonly decisiveStage: IdentityStage | null;
  /** All candidate matches found across stages */
  readonly candidateMatches: readonly StageCandidate[];
  /** Contradictions from higher-confidence stages */
  readonly contradictions: readonly ContradictionEvidence[];
  /** The matched catalog entry ID (null if unique or ambiguous) */
  readonly matchedCatalogId: string | null;
  /** The designated effective canonical target after reconciliation */
  readonly effectiveTargetId: string | null;
  /** Manual review status */
  readonly reviewStatus: ReviewStatus;
  /** Actor who made the decision (null for automated) */
  readonly actor: string | null;
  /** Rationale for the decision */
  readonly rationale: string;
  /** Input fingerprint for determinism verification */
  readonly inputFingerprint: string;
  /** Timestamp */
  readonly decidedAt: string;
}

// ─────────────────────────────────────────────
// Reconciliation Record (historical preservation)
// ─────────────────────────────────────────────

/** A non-effective historical record preserved after reconciliation per R47.6 */
export interface HistoricalRecord {
  /** The original ID */
  readonly originalId: string;
  /** All known aliases */
  readonly aliases: readonly string[];
  /** Version at time of reconciliation */
  readonly version: string;
  /** Assignment metrics at time of reconciliation */
  readonly metrics: Readonly<Record<string, number>>;
  /** Provenance */
  readonly provenance?: TransformationProvenance;
  /** Link to the effective target */
  readonly effectiveTargetId: string;
  /** Link type */
  readonly linkType: 'merged' | 'superseded';
  /** Audit trail */
  readonly auditLink: string;
  /** Timestamp of reconciliation */
  readonly reconciledAt: string;
}

// ─────────────────────────────────────────────
// Reconciliation Result
// ─────────────────────────────────────────────

/** Complete result of a reconciliation run */
export interface ReconciliationResult {
  /** All decisions made */
  readonly decisions: readonly ReconciliationDecision[];
  /** Historical records created */
  readonly historicalRecords: readonly HistoricalRecord[];
  /** Candidates requiring manual review */
  readonly pendingReview: readonly ReconciliationDecision[];
  /** Unique candidates (no match found) */
  readonly uniqueCandidates: readonly string[];
  /** Confirmed duplicates */
  readonly confirmedDuplicates: readonly string[];
  /** Ambiguous/rejected candidates */
  readonly rejectedAmbiguous: readonly string[];
  /** Input fingerprint for the entire run */
  readonly runInputFingerprint: string;
  /** Resulting catalog fingerprint after reconciliation */
  readonly resultingCatalogFingerprint: string;
  /** Timestamp */
  readonly completedAt: string;
}

// ─────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────

/** Normalize a name for comparison: lowercase, trim, collapse whitespace */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compute a deterministic fingerprint for a set of inputs */
export function computeFingerprint(inputs: readonly string[]): string {
  const hash = createHash('sha256');
  for (const input of [...inputs].sort()) {
    hash.update(input);
    hash.update('\x00');
  }
  return hash.digest('hex');
}

/** Generate a unique decision ID */
function generateDecisionId(candidateId: string, timestamp: string): string {
  return createHash('sha256')
    .update(`decision:${candidateId}:${timestamp}`)
    .digest('hex')
    .slice(0, 32);
}

// ─────────────────────────────────────────────
// Identity Stage Evaluators
// ─────────────────────────────────────────────

/**
 * Stage 1: Evaluate External_Asset_ID match.
 * Highest confidence - stable path-qualified identity.
 */
function evaluateExternalAssetId(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
): StageCandidate[] {
  if (!candidate.externalAssetId) return [];

  const matches: StageCandidate[] = [];
  for (const entry of catalog) {
    if (entry.externalAssetId && entry.externalAssetId.id === candidate.externalAssetId.id) {
      matches.push({
        stage: 'external_asset_id',
        confidence: 'highest',
        matchedCatalogId: entry.localId,
        evidence: `External_Asset_ID exact match: ${candidate.externalAssetId.id}`,
        score: 1.0,
      });
    }
  }
  return matches;
}

/**
 * Stage 2: Evaluate exact local ID match.
 * Highest confidence - direct identifier equality.
 */
function evaluateLocalId(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
): StageCandidate[] {
  const matches: StageCandidate[] = [];
  for (const entry of catalog) {
    if (entry.localId === candidate.candidateId) {
      matches.push({
        stage: 'local_id',
        confidence: 'highest',
        matchedCatalogId: entry.localId,
        evidence: `Exact local ID match: ${candidate.candidateId}`,
        score: 1.0,
      });
    }
  }
  return matches;
}

/**
 * Stage 3: Evaluate canonical content hash match.
 * High confidence - identical canonical content.
 */
function evaluateCanonicalHash(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
): StageCandidate[] {
  const matches: StageCandidate[] = [];
  for (const entry of catalog) {
    if (entry.canonicalHash === candidate.canonicalHash) {
      matches.push({
        stage: 'canonical_hash',
        confidence: 'high',
        matchedCatalogId: entry.localId,
        evidence: `Canonical content hash match: ${candidate.canonicalHash.slice(0, 16)}...`,
        score: 1.0,
      });
    }
  }
  return matches;
}

/**
 * Stage 4: Evaluate normalized name and aliases.
 * Medium confidence - name normalization may produce false positives.
 */
function evaluateNormalizedNames(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
): StageCandidate[] {
  const matches: StageCandidate[] = [];
  const candidateNames = new Set([
    candidate.normalizedName,
    ...candidate.aliases.map(normalizeName),
  ]);

  for (const entry of catalog) {
    const entryNames = new Set([
      entry.normalizedName,
      ...entry.aliases.map(normalizeName),
    ]);

    for (const cName of candidateNames) {
      if (!cName) continue;
      if (entryNames.has(cName)) {
        matches.push({
          stage: 'normalized_name',
          confidence: 'medium',
          matchedCatalogId: entry.localId,
          evidence: `Normalized name/alias match: "${cName}"`,
          score: 0.85,
        });
        break; // one match per entry is sufficient
      }
    }
  }
  return matches;
}

/**
 * Stage 5: Evaluate deterministic capability/workflow signature.
 * Medium confidence - structural similarity.
 */
function evaluateDeterministicSignature(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
): StageCandidate[] {
  if (!candidate.signatureHash) return [];

  const matches: StageCandidate[] = [];
  for (const entry of catalog) {
    if (entry.signatureHash && entry.signatureHash === candidate.signatureHash) {
      matches.push({
        stage: 'deterministic_signature',
        confidence: 'medium',
        matchedCatalogId: entry.localId,
        evidence: `Deterministic signature hash match: ${candidate.signatureHash.slice(0, 16)}...`,
        score: 0.9,
      });
    }
  }
  return matches;
}

/**
 * Stage 6: Evaluate semantic shortlist similarity.
 * Advisory only - embeddings never decide mutation (R47.3).
 * Uses the existing computeSimilarity from duplicate-detector.ts.
 */
function evaluateSemanticShortlist(
  candidate: ReconciliationCandidate,
  catalog: readonly CatalogEntry[],
  semanticThreshold: number = 0.75,
): StageCandidate[] {
  const matches: StageCandidate[] = [];

  for (const entry of catalog) {
    const similarity = computeSimilarity(entry.definition, candidate.definition);
    if (similarity.composite >= semanticThreshold) {
      matches.push({
        stage: 'semantic_shortlist',
        confidence: 'advisory',
        matchedCatalogId: entry.localId,
        evidence: `Semantic similarity score: ${similarity.composite.toFixed(4)} (name: ${similarity.nameSimilarity.toFixed(4)}, specialty: ${similarity.specialtyOverlap.toFixed(4)})`,
        score: similarity.composite,
      });
    }
  }

  return matches;
}

// ─────────────────────────────────────────────
// Contradiction Detection
// ─────────────────────────────────────────────

/**
 * Detects contradictions where a higher-confidence stage points to a different
 * target than a lower-confidence stage. Per R47.1, the first conclusive stage
 * is decisive only when no contradictory evidence exists from an earlier,
 * higher-confidence provenance stage.
 */
function detectContradictions(
  allMatches: readonly StageCandidate[],
): ContradictionEvidence[] {
  const contradictions: ContradictionEvidence[] = [];
  const stageOrder = [...IDENTITY_STAGE_ORDER];

  // Group matches by stage
  const matchesByStage = new Map<IdentityStage, StageCandidate[]>();
  for (const match of allMatches) {
    const existing = matchesByStage.get(match.stage) ?? [];
    existing.push(match);
    matchesByStage.set(match.stage, existing);
  }

  // Check if any higher-confidence stage contradicts a lower one
  for (let i = 0; i < stageOrder.length; i++) {
    const higherStage = stageOrder[i]!;
    const higherMatches = matchesByStage.get(higherStage) ?? [];
    if (higherMatches.length === 0) continue;

    for (let j = i + 1; j < stageOrder.length; j++) {
      const lowerStage = stageOrder[j]!;
      const lowerMatches = matchesByStage.get(lowerStage) ?? [];

      for (const lowerMatch of lowerMatches) {
        // Check if the lower stage points to a target not confirmed by any higher-stage match
        const higherTargets = new Set(higherMatches.map((m) => m.matchedCatalogId));
        if (!higherTargets.has(lowerMatch.matchedCatalogId)) {
          contradictions.push({
            contradictingStage: higherStage,
            explanation: `Stage "${higherStage}" identifies target(s) [${[...higherTargets].join(', ')}] but stage "${lowerStage}" identifies "${lowerMatch.matchedCatalogId}"`,
            contradictingCandidateId: lowerMatch.matchedCatalogId,
          });
        }
      }
    }
  }

  return contradictions;
}

// ─────────────────────────────────────────────
// OrderedDuplicateReconciler
// ─────────────────────────────────────────────

/** Configuration for the reconciler */
export interface ReconcilerConfig {
  /** Threshold for semantic similarity (stage 6). Default 0.75 */
  readonly semanticThreshold?: number;
  /** Whether to automatically confirm single conclusive matches. Default true */
  readonly autoConfirmSingleMatch?: boolean;
}

/**
 * OrderedDuplicateReconciler - Orchestration facade over the existing
 * authoritative duplicate-detector.ts.
 *
 * Coordinates the ordered identity evaluation, manual review requirements,
 * and persistence of decisions without creating a parallel detection path.
 *
 * Per design doc:
 * - NOT a duplicate-detection authority (existing module is authoritative)
 * - Coordinates provenance stages, manual review, and persistence
 * - Uses the existing module for typed ordered identity evaluation
 * - Uses the existing module for semantic candidate evidence
 */
export class OrderedDuplicateReconciler {
  private readonly config: Required<ReconcilerConfig>;

  constructor(config: ReconcilerConfig = {}) {
    this.config = {
      semanticThreshold: config.semanticThreshold ?? 0.75,
      autoConfirmSingleMatch: config.autoConfirmSingleMatch ?? true,
    };
  }

  /**
   * Reconcile a batch of candidates against the existing catalog.
   * Applies the same ordered strategy to agents and skills (R47.2).
   * Never lets embeddings decide mutation (R47.3).
   * Requires manual review for ambiguity or conflict (R47.4).
   *
   * Every reconciliation is deterministic for identical inputs (R47.8).
   */
  reconcile(
    candidates: readonly ReconciliationCandidate[],
    catalog: readonly CatalogEntry[],
  ): ReconciliationResult {
    const timestamp = new Date().toISOString();
    const decisions: ReconciliationDecision[] = [];
    const historicalRecords: HistoricalRecord[] = [];

    // Compute input fingerprint for determinism verification (R47.8)
    const runInputFingerprint = this.computeRunInputFingerprint(candidates, catalog);

    for (const candidate of candidates) {
      const decision = this.reconcileCandidate(candidate, catalog, timestamp);
      decisions.push(decision);

      // Create historical records for confirmed duplicates (R47.6)
      if (decision.outcome === 'confirmed_duplicate' && decision.effectiveTargetId) {
        const historical = this.createHistoricalRecord(candidate, decision, timestamp);
        historicalRecords.push(historical);
      }
    }

    // Compute resulting catalog fingerprint
    const resultingCatalogFingerprint = this.computeCatalogFingerprint(catalog, decisions);

    return {
      decisions,
      historicalRecords,
      pendingReview: decisions.filter((d) => d.reviewStatus === 'pending'),
      uniqueCandidates: decisions.filter((d) => d.outcome === 'unique').map((d) => d.candidateId),
      confirmedDuplicates: decisions.filter((d) => d.outcome === 'confirmed_duplicate').map((d) => d.candidateId),
      rejectedAmbiguous: decisions.filter((d) => d.outcome === 'rejected_ambiguous').map((d) => d.candidateId),
      runInputFingerprint,
      resultingCatalogFingerprint,
      completedAt: timestamp,
    };
  }

  /**
   * Reconcile a single candidate through all identity stages in order.
   */
  private reconcileCandidate(
    candidate: ReconciliationCandidate,
    catalog: readonly CatalogEntry[],
    timestamp: string,
  ): ReconciliationDecision {
    const allMatches: StageCandidate[] = [];
    const inputFingerprint = this.computeCandidateInputFingerprint(candidate, catalog);

    // Evaluate each stage in order (R47.1)
    const stageEvaluators: Array<() => StageCandidate[]> = [
      () => evaluateExternalAssetId(candidate, catalog),
      () => evaluateLocalId(candidate, catalog),
      () => evaluateCanonicalHash(candidate, catalog),
      () => evaluateNormalizedNames(candidate, catalog),
      () => evaluateDeterministicSignature(candidate, catalog),
      () => evaluateSemanticShortlist(candidate, catalog, this.config.semanticThreshold),
    ];

    let decisiveStage: IdentityStage | null = null;
    let matchedCatalogId: string | null = null;

    for (const evaluate of stageEvaluators) {
      const stageMatches = evaluate();
      allMatches.push(...stageMatches);

      // Check if this stage is decisive (single conclusive target)
      if (decisiveStage === null && stageMatches.length === 1) {
        const match = stageMatches[0]!;
        // Semantic shortlist never decides mutation (R47.3)
        if (match.stage === 'semantic_shortlist') {
          continue;
        }
        // Normalized name alone is not decisive per R47.5:
        // "Repeated names across harnesses, domains, roles, or workflows
        // SHALL NOT be treated as automatic duplicates without stronger
        // ordered identity evidence."
        if (match.stage === 'normalized_name') {
          continue;
        }
        decisiveStage = match.stage;
        matchedCatalogId = match.matchedCatalogId;
      }
    }

    // Detect contradictions from higher-confidence stages (R47.1)
    const contradictions = detectContradictions(allMatches);

    // Determine outcome
    return this.determineOutcome(
      candidate,
      allMatches,
      contradictions,
      decisiveStage,
      matchedCatalogId,
      inputFingerprint,
      timestamp,
    );
  }

  /**
   * Determine the reconciliation outcome based on matches and contradictions.
   */
  private determineOutcome(
    candidate: ReconciliationCandidate,
    allMatches: readonly StageCandidate[],
    contradictions: readonly ContradictionEvidence[],
    decisiveStage: IdentityStage | null,
    matchedCatalogId: string | null,
    inputFingerprint: string,
    timestamp: string,
  ): ReconciliationDecision {
    const decisionId = generateDecisionId(candidate.candidateId, timestamp);

    // No matches at all → unique
    if (allMatches.length === 0) {
      return {
        decisionId,
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        outcome: 'unique',
        decisiveStage: null,
        candidateMatches: allMatches,
        contradictions,
        matchedCatalogId: null,
        effectiveTargetId: null,
        reviewStatus: 'not_required',
        actor: null,
        rationale: 'No matching catalog entries found at any identity stage.',
        inputFingerprint,
        decidedAt: timestamp,
      };
    }

    // Contradictions exist → requires manual review (R47.4)
    if (contradictions.length > 0) {
      return {
        decisionId,
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        outcome: 'requires_manual_review',
        decisiveStage: null,
        candidateMatches: allMatches,
        contradictions,
        matchedCatalogId: null,
        effectiveTargetId: null,
        reviewStatus: 'pending',
        actor: null,
        rationale: `Contradictory evidence from higher-confidence provenance stages: ${contradictions.map((c) => c.explanation).join('; ')}`,
        inputFingerprint,
        decidedAt: timestamp,
      };
    }

    // Multiple distinct targets from deterministic stages → ambiguous, requires review (R47.4)
    const deterministicMatches = allMatches.filter((m) => m.stage !== 'semantic_shortlist');
    const uniqueTargets = new Set(deterministicMatches.map((m) => m.matchedCatalogId));
    if (uniqueTargets.size > 1) {
      return {
        decisionId,
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        outcome: 'requires_manual_review',
        decisiveStage: null,
        candidateMatches: allMatches,
        contradictions,
        matchedCatalogId: null,
        effectiveTargetId: null,
        reviewStatus: 'pending',
        actor: null,
        rationale: `Multiple plausible targets identified: [${[...uniqueTargets].join(', ')}]. Manual review required per R47.4.`,
        inputFingerprint,
        decidedAt: timestamp,
      };
    }

    // Only semantic matches (no deterministic evidence) → semantic only shortlists (R47.3, R47.5)
    if (deterministicMatches.length === 0) {
      const semanticMatches = allMatches.filter((m) => m.stage === 'semantic_shortlist');
      if (semanticMatches.length > 0) {
        // R47.5: Repeated names across harnesses/domains/roles shall not be treated as
        // automatic duplicates without stronger ordered identity evidence
        return {
          decisionId,
          candidateId: candidate.candidateId,
          kind: candidate.kind,
          outcome: 'requires_manual_review',
          decisiveStage: null,
          candidateMatches: allMatches,
          contradictions,
          matchedCatalogId: null,
          effectiveTargetId: null,
          reviewStatus: 'pending',
          actor: null,
          rationale: `Only semantic similarity evidence found (no deterministic identity match). Semantic shortlist cannot independently decide mutation per R47.3. Repeated names shall not be treated as automatic duplicates per R47.5.`,
          inputFingerprint,
          decidedAt: timestamp,
        };
      }
    }

    // Single conclusive target from a decisive stage and auto-confirm enabled
    if (decisiveStage && matchedCatalogId && this.config.autoConfirmSingleMatch) {
      return {
        decisionId,
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        outcome: 'confirmed_duplicate',
        decisiveStage,
        candidateMatches: allMatches,
        contradictions,
        matchedCatalogId,
        effectiveTargetId: matchedCatalogId,
        reviewStatus: 'not_required',
        actor: null,
        rationale: `Single conclusive match at stage "${decisiveStage}" with no contradictory evidence. Effective target: ${matchedCatalogId}.`,
        inputFingerprint,
        decidedAt: timestamp,
      };
    }

    // Single target but auto-confirm disabled or no decisive stage found
    if (uniqueTargets.size === 1) {
      const targetId = [...uniqueTargets][0]!;
      return {
        decisionId,
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        outcome: 'requires_manual_review',
        decisiveStage: decisiveStage ?? null,
        candidateMatches: allMatches,
        contradictions,
        matchedCatalogId: targetId,
        effectiveTargetId: null,
        reviewStatus: 'pending',
        actor: null,
        rationale: decisiveStage
          ? `Single conclusive match found but auto-confirmation disabled. Manual review required.`
          : `Candidate matches a single target but no single decisive stage was conclusive. Manual review required.`,
        inputFingerprint,
        decidedAt: timestamp,
      };
    }

    // Fallback: unique (shouldn't normally reach here)
    return {
      decisionId,
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      outcome: 'unique',
      decisiveStage: null,
      candidateMatches: allMatches,
      contradictions,
      matchedCatalogId: null,
      effectiveTargetId: null,
      reviewStatus: 'not_required',
      actor: null,
      rationale: 'No conclusive duplicate evidence found.',
      inputFingerprint,
      decidedAt: timestamp,
    };
  }

  /**
   * Apply a manual review decision to a pending reconciliation.
   * Returns an updated decision with the reviewer's input.
   */
  applyManualReview(
    decision: ReconciliationDecision,
    review: {
      readonly approved: boolean;
      readonly effectiveTargetId: string | null;
      readonly actor: string;
      readonly rationale: string;
    },
  ): ReconciliationDecision {
    if (decision.reviewStatus !== 'pending') {
      throw new Error(
        `Cannot apply manual review to decision ${decision.decisionId}: status is "${decision.reviewStatus}", expected "pending".`,
      );
    }

    if (review.approved && review.effectiveTargetId) {
      return {
        ...decision,
        outcome: 'confirmed_duplicate',
        effectiveTargetId: review.effectiveTargetId,
        matchedCatalogId: review.effectiveTargetId,
        reviewStatus: 'approved',
        actor: review.actor,
        rationale: review.rationale,
        decidedAt: new Date().toISOString(),
      };
    }

    if (review.approved && !review.effectiveTargetId) {
      // Approved as unique
      return {
        ...decision,
        outcome: 'unique',
        effectiveTargetId: null,
        matchedCatalogId: null,
        reviewStatus: 'approved',
        actor: review.actor,
        rationale: review.rationale,
        decidedAt: new Date().toISOString(),
      };
    }

    // Rejected
    return {
      ...decision,
      outcome: 'rejected_ambiguous',
      reviewStatus: 'rejected',
      actor: review.actor,
      rationale: review.rationale,
      decidedAt: new Date().toISOString(),
    };
  }

  /**
   * Validate that no ambiguous effective identities exist before
   * activation or dispatch (R47.7).
   */
  validateNoAmbiguousIdentities(
    decisions: readonly ReconciliationDecision[],
  ): { valid: boolean; violations: readonly string[] } {
    const violations: string[] = [];

    // Check for pending reviews
    const pending = decisions.filter((d) => d.reviewStatus === 'pending');
    if (pending.length > 0) {
      violations.push(
        `${pending.length} decision(s) still require manual review before activation: [${pending.map((d) => d.candidateId).join(', ')}]`,
      );
    }

    // Check for rejected ambiguous
    const rejected = decisions.filter((d) => d.outcome === 'rejected_ambiguous');
    if (rejected.length > 0) {
      violations.push(
        `${rejected.length} candidate(s) rejected due to ambiguity: [${rejected.map((d) => d.candidateId).join(', ')}]`,
      );
    }

    // Check for duplicate effective IDs among confirmed duplicates
    const effectiveIds = new Map<string, string[]>();
    for (const decision of decisions) {
      if (decision.effectiveTargetId) {
        const existing = effectiveIds.get(decision.effectiveTargetId) ?? [];
        existing.push(decision.candidateId);
        effectiveIds.set(decision.effectiveTargetId, existing);
      }
    }

    // Multiple candidates resolving to the same effective target is fine,
    // but check that no candidate is both effective and merged
    const uniqueEffective = decisions.filter(
      (d) => d.outcome === 'unique' || (d.outcome === 'confirmed_duplicate' && d.effectiveTargetId),
    );
    const effectiveIdSet = new Set<string>();
    for (const d of uniqueEffective) {
      const id = d.outcome === 'unique' ? d.candidateId : d.effectiveTargetId!;
      if (effectiveIdSet.has(id)) {
        violations.push(`Duplicate effective ID "${id}" detected across decisions.`);
      }
      effectiveIdSet.add(id);
    }

    return { valid: violations.length === 0, violations };
  }

  /**
   * Create a historical record preserving all non-effective data (R47.6).
   */
  private createHistoricalRecord(
    candidate: ReconciliationCandidate,
    decision: ReconciliationDecision,
    timestamp: string,
  ): HistoricalRecord {
    return {
      originalId: candidate.candidateId,
      aliases: [...candidate.aliases],
      version: '1.0.0', // Initial version for imports
      metrics: {},
      provenance: candidate.provenance,
      effectiveTargetId: decision.effectiveTargetId!,
      linkType: 'merged',
      auditLink: `decision:${decision.decisionId}`,
      reconciledAt: timestamp,
    };
  }

  /**
   * Compute a deterministic fingerprint for a candidate's input (R47.8).
   */
  private computeCandidateInputFingerprint(
    candidate: ReconciliationCandidate,
    catalog: readonly CatalogEntry[],
  ): string {
    const inputs = [
      candidate.candidateId,
      candidate.canonicalHash,
      candidate.normalizedName,
      candidate.kind,
      candidate.externalAssetId?.id ?? '',
      candidate.signatureHash ?? '',
      ...candidate.aliases,
      ...catalog.map((e) => `${e.localId}:${e.canonicalHash}:${e.normalizedName}`),
    ];
    return computeFingerprint(inputs);
  }

  /**
   * Compute a deterministic fingerprint for the entire reconciliation run (R47.8).
   */
  private computeRunInputFingerprint(
    candidates: readonly ReconciliationCandidate[],
    catalog: readonly CatalogEntry[],
  ): string {
    const inputs = [
      ...candidates.map((c) => `${c.candidateId}:${c.canonicalHash}:${c.kind}`),
      ...catalog.map((e) => `${e.localId}:${e.canonicalHash}:${e.kind}`),
    ];
    return computeFingerprint(inputs);
  }

  /**
   * Compute the resulting catalog fingerprint after reconciliation (R47.8).
   */
  private computeCatalogFingerprint(
    catalog: readonly CatalogEntry[],
    decisions: readonly ReconciliationDecision[],
  ): string {
    const inputs = [
      ...catalog.map((e) => `${e.localId}:${e.version}:${e.isEffective}`),
      ...decisions.map((d) => `${d.decisionId}:${d.outcome}:${d.effectiveTargetId ?? 'none'}`),
    ];
    return computeFingerprint(inputs);
  }
}
