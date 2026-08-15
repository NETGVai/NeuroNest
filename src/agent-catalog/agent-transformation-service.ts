/**
 * Agent Transformation Service
 *
 * Orchestrates imported-agent transformation through the existing exact authorities:
 * - `agent-file-parser.ts` for the six-section structural contract
 * - `quality-scorer.ts` for four-dimensional 25-point scoring (100/100 total)
 * - `authenticity-validator.ts` for authenticity checks
 *
 * Implements bounded repair with configurable round, time, token, and cost limits.
 * Quarantines and prohibits assignment for any structure, authenticity, or score failure.
 * Persists section, score, authenticity, fingerprint, repair, and reviewer Evidence.
 *
 * Requirements: 48.1, 48.2, 48.3, 48.4, 48.5, 48.6, 48.7, 48.8
 */

import { createHash } from 'crypto';
import type {
  AgentFileParseResult,
  AgentSectionName,
  StructuralValidation,
} from './agent-file-parser';
import { parseAgentFileDocument, REQUIRED_AGENT_SECTION_NAMES } from './agent-file-parser';
import type { AuthenticityValidation } from './authenticity-validator';
import { validateAgentAuthenticity } from './authenticity-validator';
import type { ExternalAssetId, TransformationProvenance } from './corpus-inventory-types';
import type { QuarantineReason } from './import-recovery-types';
import type { QualityAnalysis, QualityDimensionId } from './quality-scorer';
import { analyzeAgent, QUALITY_SCORER_DEFINITION } from './quality-scorer';
import type { QualityBreakdown } from './types';

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

/** Bounded repair configuration per R48.6 */
export interface RepairBoundsConfig {
  /** Maximum number of repair rounds */
  readonly maxRounds: number;
  /** Maximum elapsed time in milliseconds */
  readonly maxTimeMs: number;
  /** Maximum tokens consumed across attempts */
  readonly maxTokens: number;
  /** Maximum cost in arbitrary cost units */
  readonly maxCost: number;
}

/** Default repair bounds */
export const DEFAULT_REPAIR_BOUNDS: RepairBoundsConfig = Object.freeze({
  maxRounds: 3,
  maxTimeMs: 30_000,
  maxTokens: 50_000,
  maxCost: 100,
});

/** The exact required score per dimension for activation */
export const REQUIRED_DIMENSION_SCORE = 25;

/** The exact required total score for activation */
export const REQUIRED_TOTAL_SCORE = 100;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Result of structural validation via agent-file-parser */
export interface StructuralEvidence {
  readonly valid: boolean;
  readonly parseResult: AgentFileParseResult;
  readonly structural: StructuralValidation;
  readonly extractionComplete: boolean;
  readonly sectionContents: Readonly<Record<AgentSectionName, string | null>>;
}

/** Result of quality scoring via quality-scorer */
export interface ScoreEvidence {
  readonly valid: boolean;
  readonly analysis: QualityAnalysis;
  readonly breakdown: QualityBreakdown;
  readonly dimensionsPassing: Readonly<Record<QualityDimensionId, boolean>>;
  readonly allDimensionsPassing: boolean;
  readonly totalPassing: boolean;
}

/** Result of authenticity validation via authenticity-validator */
export interface AuthenticityEvidence {
  readonly valid: boolean;
  readonly validation: AuthenticityValidation;
  readonly findingCount: number;
}

/** A single repair attempt record */
export interface TransformationAttempt {
  readonly attemptId: string;
  readonly round: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly content: string;
  readonly structuralEvidence: StructuralEvidence;
  readonly scoreEvidence: ScoreEvidence;
  readonly authenticityEvidence: AuthenticityEvidence;
  readonly passed: boolean;
  readonly failureReasons: readonly string[];
}

/** The overall transformation result for a single agent candidate */
export interface TransformationResult {
  readonly candidateId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly outcome: 'passed' | 'quarantined';
  readonly attempts: readonly TransformationAttempt[];
  readonly finalAttempt: TransformationAttempt | null;
  readonly repairBoundsExhausted: boolean;
  readonly quarantineReason: QuarantineReason | null;
  readonly quarantineExplanation: string | null;
  readonly sourceFingerprint: string;
  readonly transformedFingerprint: string | null;
  readonly evidence: TransformationEvidence | null;
  readonly completedAt: string;
}

/** Evidence persisted for passing agents per R48.8 */
export interface TransformationEvidence {
  readonly candidateId: string;
  readonly externalAssetId: ExternalAssetId;
  readonly sectionEvidence: Readonly<Record<AgentSectionName, string>>;
  readonly scoreEvidence: QualityBreakdown;
  readonly authenticityEvidence: {
    readonly valid: boolean;
    readonly criteriaCount: number;
    readonly passedCount: number;
    readonly findingCount: number;
  };
  readonly sourceFingerprint: string;
  readonly transformedFingerprint: string;
  readonly repairHistory: {
    readonly totalAttempts: number;
    readonly totalDurationMs: number;
    readonly totalTokens: number;
    readonly totalCost: number;
  };
  readonly reviewerDecision: 'approved' | 'pending';
  readonly recordedAt: string;
}

/** Input to the transformation service for a single candidate */
export interface TransformationCandidate {
  readonly id: string;
  readonly externalAssetId: ExternalAssetId;
  readonly rawContent: string;
  readonly recoveredContent: string;
  readonly specialty: string;
  readonly provenance: TransformationProvenance;
}

/** A repair function that receives validator findings and source evidence and returns improved content */
export type RepairFunction = (
  content: string,
  findings: RepairFindings,
  sourceEvidence: string,
) => Promise<RepairOutput>;

/** Findings passed to the repair function */
export interface RepairFindings {
  readonly structuralFindings: readonly string[];
  readonly authenticityFindings: readonly string[];
  readonly scoreFindings: readonly string[];
  readonly specialty: string;
}

/** Output of the repair function */
export interface RepairOutput {
  readonly content: string;
  readonly tokensUsed: number;
  readonly costUsed: number;
}

// ─────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────

function generateId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────
// Validation Helpers
// ─────────────────────────────────────────────

/**
 * Validates structural compliance using the authoritative agent-file-parser.
 * Checks for exactly six ordered non-empty sections.
 */
export function validateStructure(content: string): StructuralEvidence {
  const parseResult = parseAgentFileDocument(content);
  const extractionComplete = parseResult.extractionComplete;
  const structural = parseResult.structural;
  const strictValid = structural.strictValid && extractionComplete;

  return Object.freeze({
    valid: strictValid,
    parseResult,
    structural,
    extractionComplete,
    sectionContents: parseResult.sectionContents,
  });
}

/**
 * Validates quality score using the authoritative quality-scorer.
 * Requires earned 25/25 in every dimension and 100/100 total.
 */
export function validateScore(content: string, specialty: string): ScoreEvidence {
  // The quality-scorer works on AgentDefinition objects
  const agentDef = {
    id: 'transformation-candidate',
    name: 'Transformation Candidate',
    emoji: '',
    department: '',
    specialty,
    systemPrompt: content,
  };

  const analysis = analyzeAgent(agentDef);
  const breakdown = analysis.breakdown;

  const dimensionsPassing: Record<QualityDimensionId, boolean> = {
    promptSpecificity: breakdown.promptSpecificity === REQUIRED_DIMENSION_SCORE,
    deliverableStructure: breakdown.deliverableStructure === REQUIRED_DIMENSION_SCORE,
    workflowCompleteness: breakdown.workflowCompleteness === REQUIRED_DIMENSION_SCORE,
    domainDepth: breakdown.domainDepth === REQUIRED_DIMENSION_SCORE,
  };

  const allDimensionsPassing = Object.values(dimensionsPassing).every(Boolean);
  const totalPassing = breakdown.total === REQUIRED_TOTAL_SCORE;

  return Object.freeze({
    valid: allDimensionsPassing && totalPassing,
    analysis,
    breakdown,
    dimensionsPassing: Object.freeze(dimensionsPassing),
    allDimensionsPassing,
    totalPassing,
  });
}

/**
 * Validates authenticity using the authoritative authenticity-validator.
 * Rejects fabricated credentials, unsupported expertise, copied persona claims,
 * keyword stuffing, and incoherent transformations.
 */
export function validateAuthenticity(
  content: string,
  specialty: string,
  sourcePath: string,
): AuthenticityEvidence {
  const parseResult = parseAgentFileDocument(content);
  const validation = validateAgentAuthenticity({
    sourcePath,
    specialty,
    parseResult,
  });

  return Object.freeze({
    valid: validation.valid,
    validation,
    findingCount: validation.findings.length,
  });
}

// ─────────────────────────────────────────────
// Agent Transformation Service
// ─────────────────────────────────────────────

/**
 * AgentTransformationService orchestrates the transformation of imported agents
 * through existing exact authorities. It reuses (not replaces) the parser, scorer,
 * and authenticity validator.
 *
 * Pipeline per candidate:
 * 1. Controlled source-preserving recovery (from import-recovery-service)
 * 2. Exact parser contract: Identity, Core Mission, Critical Rules,
 *    Technical Deliverables, Workflow Process, Success Metrics
 * 3. Authenticity validation
 * 4. Authoritative scoring with earned 25/25 in all four dimensions and 100/100 total
 * 5. Bounded repair loop if initial validation fails
 * 6. Quarantine on failure; evidence persistence on success
 */
export class AgentTransformationService {
  private readonly repairBounds: RepairBoundsConfig;
  private readonly results: TransformationResult[] = [];

  constructor(bounds: RepairBoundsConfig = DEFAULT_REPAIR_BOUNDS) {
    this.repairBounds = bounds;
  }

  /**
   * Transforms a single agent candidate through all three validation authorities.
   * Implements bounded repair per R48.6.
   *
   * @param candidate The agent candidate to transform
   * @param repairFn Optional repair function for bounded repair loop
   * @returns The transformation result (passed or quarantined)
   */
  async transformCandidate(
    candidate: TransformationCandidate,
    repairFn?: RepairFunction,
  ): Promise<TransformationResult> {
    const sourceFingerprint = fingerprint(candidate.rawContent);
    const startTime = Date.now();
    const attempts: TransformationAttempt[] = [];
    let currentContent = candidate.recoveredContent;
    let totalTokens = 0;
    let totalCost = 0;
    let passed = false;
    let finalAttempt: TransformationAttempt | null = null;
    let boundsExhausted = false;

    for (let round = 0; round <= this.repairBounds.maxRounds; round++) {
      const attemptStart = Date.now();
      const elapsed = attemptStart - startTime;

      // Check time bounds
      if (elapsed > this.repairBounds.maxTimeMs) {
        boundsExhausted = true;
        break;
      }

      // Check token/cost bounds
      if (totalTokens > this.repairBounds.maxTokens) {
        boundsExhausted = true;
        break;
      }
      if (totalCost > this.repairBounds.maxCost) {
        boundsExhausted = true;
        break;
      }

      // Validate through all three authorities
      const structuralEvidence = validateStructure(currentContent);
      const scoreEvidence = validateScore(currentContent, candidate.specialty);
      const authenticityEvidence = validateAuthenticity(
        currentContent,
        candidate.specialty,
        candidate.provenance.sourcePath,
      );

      const failureReasons: string[] = [];
      if (!structuralEvidence.valid) {
        failureReasons.push(
          `Structure: ${structuralEvidence.structural.findings.map(f => f.message).join('; ')}`,
        );
      }
      if (!authenticityEvidence.valid) {
        failureReasons.push(
          `Authenticity: ${authenticityEvidence.validation.findings.length} findings`,
        );
      }
      if (!scoreEvidence.valid) {
        const dims = Object.entries(scoreEvidence.dimensionsPassing)
          .filter(([, v]) => !v)
          .map(([k]) => k);
        failureReasons.push(
          `Score: ${scoreEvidence.breakdown.total}/100 (failing dimensions: ${dims.join(', ')})`,
        );
      }

      const attemptPassed = structuralEvidence.valid
        && authenticityEvidence.valid
        && scoreEvidence.valid;

      const attemptFinished = now();
      const attempt: TransformationAttempt = Object.freeze({
        attemptId: generateId(`${candidate.id}:attempt:${round}`),
        round,
        startedAt: new Date(attemptStart).toISOString(),
        finishedAt: attemptFinished,
        durationMs: Date.now() - attemptStart,
        tokensUsed: 0,
        costUsed: 0,
        content: currentContent,
        structuralEvidence,
        scoreEvidence,
        authenticityEvidence,
        passed: attemptPassed,
        failureReasons: Object.freeze(failureReasons),
      });

      attempts.push(attempt);
      finalAttempt = attempt;

      if (attemptPassed) {
        passed = true;
        break;
      }

      // If this is the last allowed round or no repair function, stop
      if (round >= this.repairBounds.maxRounds || !repairFn) {
        break;
      }

      // Attempt repair using only validator findings and source evidence
      const repairFindings: RepairFindings = {
        structuralFindings: structuralEvidence.structural.findings.map(f => f.message),
        authenticityFindings: authenticityEvidence.validation.findings.map(f => f.message),
        scoreFindings: this.buildScoreFindings(scoreEvidence),
        specialty: candidate.specialty,
      };

      try {
        const repairOutput = await repairFn(
          currentContent,
          repairFindings,
          candidate.rawContent,
        );
        currentContent = repairOutput.content;
        totalTokens += repairOutput.tokensUsed;
        totalCost += repairOutput.costUsed;
      } catch {
        // Repair function failure - stop repair loop
        break;
      }
    }

    const transformedFingerprint = passed ? fingerprint(currentContent) : null;
    let evidence: TransformationEvidence | null = null;

    if (passed && finalAttempt) {
      evidence = this.buildEvidence(
        candidate,
        finalAttempt,
        sourceFingerprint,
        transformedFingerprint!,
        attempts,
        totalTokens,
        totalCost,
      );
    }

    const result: TransformationResult = Object.freeze({
      candidateId: candidate.id,
      externalAssetId: candidate.externalAssetId,
      outcome: passed ? 'passed' : 'quarantined',
      attempts: Object.freeze(attempts),
      finalAttempt,
      repairBoundsExhausted: boundsExhausted,
      quarantineReason: passed ? null : this.classifyQuarantineReason(finalAttempt),
      quarantineExplanation: passed ? null : this.buildQuarantineExplanation(finalAttempt, boundsExhausted),
      sourceFingerprint,
      transformedFingerprint,
      evidence,
      completedAt: now(),
    });

    this.results.push(result);
    return result;
  }

  /**
   * Transforms a batch of candidates. Each is processed independently.
   */
  async transformBatch(
    candidates: readonly TransformationCandidate[],
    repairFn?: RepairFunction,
  ): Promise<readonly TransformationResult[]> {
    const results: TransformationResult[] = [];
    for (const candidate of candidates) {
      const result = await this.transformCandidate(candidate, repairFn);
      results.push(result);
    }
    return Object.freeze(results);
  }

  /**
   * Returns all accumulated transformation results.
   */
  getResults(): readonly TransformationResult[] {
    return Object.freeze([...this.results]);
  }

  /**
   * Returns results classified by outcome.
   */
  getSummary(): {
    total: number;
    passed: number;
    quarantined: number;
    boundsExhausted: number;
  } {
    return {
      total: this.results.length,
      passed: this.results.filter(r => r.outcome === 'passed').length,
      quarantined: this.results.filter(r => r.outcome === 'quarantined').length,
      boundsExhausted: this.results.filter(r => r.repairBoundsExhausted).length,
    };
  }

  // ─────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────

  private buildScoreFindings(scoreEvidence: ScoreEvidence): readonly string[] {
    const findings: string[] = [];
    const { breakdown, dimensionsPassing } = scoreEvidence;

    for (const dim of QUALITY_SCORER_DEFINITION.dimensions) {
      const score = breakdown[dim.dimension as keyof QualityBreakdown] as number;
      if (!dimensionsPassing[dim.dimension]) {
        findings.push(
          `${dim.dimension}: ${score}/${dim.maximumScore} (needs ${dim.maximumScore})`,
        );
      }
    }

    return Object.freeze(findings);
  }

  private classifyQuarantineReason(
    finalAttempt: TransformationAttempt | null,
  ): QuarantineReason {
    if (!finalAttempt) return 'validation_failed';

    if (!finalAttempt.structuralEvidence.valid) return 'structure_invalid';
    if (!finalAttempt.authenticityEvidence.valid) return 'authenticity_failed';
    if (!finalAttempt.scoreEvidence.valid) return 'quality_below_threshold';
    return 'validation_failed';
  }

  private buildQuarantineExplanation(
    finalAttempt: TransformationAttempt | null,
    boundsExhausted: boolean,
  ): string {
    const parts: string[] = [];

    if (boundsExhausted) {
      parts.push('Repair bounds exhausted.');
    }

    if (finalAttempt) {
      if (!finalAttempt.structuralEvidence.valid) {
        parts.push(
          `Structure invalid: does not satisfy the exact six-section contract.`,
        );
      }
      if (!finalAttempt.authenticityEvidence.valid) {
        parts.push(
          `Authenticity failed: ${finalAttempt.authenticityEvidence.findingCount} blocking finding(s).`,
        );
      }
      if (!finalAttempt.scoreEvidence.valid) {
        const { breakdown } = finalAttempt.scoreEvidence;
        parts.push(
          `Quality score ${breakdown.total}/100 does not meet the required 100/100.`,
        );
      }
    } else {
      parts.push('No validation attempt could be performed.');
    }

    return parts.join(' ');
  }

  private buildEvidence(
    candidate: TransformationCandidate,
    finalAttempt: TransformationAttempt,
    sourceFingerprint: string,
    transformedFingerprint: string,
    attempts: readonly TransformationAttempt[],
    totalTokens: number,
    totalCost: number,
  ): TransformationEvidence {
    const sectionEvidence = {} as Record<AgentSectionName, string>;
    for (const name of REQUIRED_AGENT_SECTION_NAMES) {
      sectionEvidence[name] = finalAttempt.structuralEvidence.sectionContents[name] ?? '';
    }

    const totalDurationMs = attempts.reduce((sum, a) => sum + a.durationMs, 0);
    const { validation } = finalAttempt.authenticityEvidence;
    const criteriaEntries = Object.values(validation.criteria);
    const passedCount = criteriaEntries.filter(c => c.passed).length;

    return Object.freeze({
      candidateId: candidate.id,
      externalAssetId: candidate.externalAssetId,
      sectionEvidence: Object.freeze(sectionEvidence),
      scoreEvidence: finalAttempt.scoreEvidence.breakdown,
      authenticityEvidence: Object.freeze({
        valid: true,
        criteriaCount: criteriaEntries.length,
        passedCount,
        findingCount: validation.findings.length,
      }),
      sourceFingerprint,
      transformedFingerprint,
      repairHistory: Object.freeze({
        totalAttempts: attempts.length,
        totalDurationMs,
        totalTokens,
        totalCost,
      }),
      reviewerDecision: 'pending' as const,
      recordedAt: now(),
    });
  }
}
