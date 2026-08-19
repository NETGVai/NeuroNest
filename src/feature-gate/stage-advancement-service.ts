/**
 * Stage Advancement Service
 *
 * Automates rollout stage advancement for the structured response renderer
 * by linking all required evidence categories to one projection/release revision
 * and refusing advancement when any evidence is stale, missing, or unresolved.
 *
 * Evidence categories:
 * - adapter: Legacy Response Adapter normalization/correlation evidence
 * - ipc: Production IPC handler, preload, unsubscribe, and cleanup evidence
 * - accessibility: Keyboard, screen-reader, semantic, and scaling evidence
 * - security: Sanitization, redaction, and authority enforcement evidence
 * - performance: Configured budget and profile evidence
 * - parity: Shadow structural comparison evidence
 * - capability_preservation: Existing shipped-chat behavior regression evidence
 * - manual_review: Human acceptance review evidence
 * - soak: Production soak period metrics evidence
 *
 * Requirements: 18.15, 21.10–21.11, 22.9–22.11
 */

import type { StructuredResponseGateId } from './structured-response-gates.js';

// ─── Evidence Categories ────────────────────────────────────────

/**
 * All required evidence categories that must pass at one revision before
 * stage advancement is permitted.
 */
export type EvidenceCategory =
  | 'adapter'
  | 'ipc'
  | 'accessibility'
  | 'security'
  | 'performance'
  | 'parity'
  | 'capability_preservation'
  | 'manual_review'
  | 'soak';

export const ALL_EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = [
  'adapter',
  'ipc',
  'accessibility',
  'security',
  'performance',
  'parity',
  'capability_preservation',
  'manual_review',
  'soak',
] as const;

// ─── Evidence Record ────────────────────────────────────────────

/**
 * Outcome of an evidence evaluation run.
 */
export type EvidenceOutcome = 'pass' | 'fail' | 'blocked' | 'stale' | 'running';

/**
 * A single evidence record tied to a specific revision and run.
 */
export interface EvidenceRecord {
  readonly id: string;
  readonly category: EvidenceCategory;
  readonly outcome: EvidenceOutcome;
  /** The projection/release revision this evidence was produced against */
  readonly revision: string;
  /** ISO 8601 timestamp when this evidence was produced */
  readonly producedAt: string;
  /** ISO 8601 timestamp when this evidence expires (if applicable) */
  readonly expiresAt: string | null;
  /** Run identifier for deduplication and reruns */
  readonly runId: string;
  /** Fingerprint of the environment and inputs used to produce this evidence */
  readonly fingerprint: string;
  /** Human-readable summary of the evidence result */
  readonly summary: string;
  /** If the outcome is 'fail' or 'blocked', the specific reason */
  readonly reason: string | null;
}

// ─── Divergence Record ──────────────────────────────────────────

/**
 * Tracks unresolved divergences from shadow comparison.
 */
export interface DivergenceRecord {
  readonly id: string;
  /** The revision where divergence was detected */
  readonly revision: string;
  /** Description of the divergence */
  readonly description: string;
  /** Whether this divergence is resolved */
  readonly resolved: boolean;
  /** The resolution revision, if resolved */
  readonly resolvedAtRevision: string | null;
}

// ─── Gate Decision ──────────────────────────────────────────────

/**
 * The decision outcome of a stage advancement request.
 */
export type AdvancementDecision = 'permitted' | 'blocked';

/**
 * A specific reason why advancement is blocked.
 */
export interface GateBlockReason {
  readonly category: EvidenceCategory | 'divergence' | 'revision_mismatch';
  readonly code: BlockReasonCode;
  readonly description: string;
  /** The evidence record ID relevant to this block, if applicable */
  readonly evidenceId: string | null;
}

export type BlockReasonCode =
  | 'missing'
  | 'stale'
  | 'expired'
  | 'failed'
  | 'running'
  | 'revision_mismatch'
  | 'unresolved_divergence';

/**
 * The full result of an advancement gate evaluation.
 */
export interface AdvancementGateResult {
  readonly decision: AdvancementDecision;
  /** The target revision being evaluated */
  readonly targetRevision: string;
  /** All blocking reasons (empty when decision is 'permitted') */
  readonly blockReasons: readonly GateBlockReason[];
  /** Evidence summary per category */
  readonly evidenceSummary: readonly EvidenceCategorySummary[];
  /** ISO 8601 timestamp of this evaluation */
  readonly evaluatedAt: string;
  /** Whether all evidence is at the same revision */
  readonly revisionConsistent: boolean;
}

/**
 * Summary of evidence status for one category.
 */
export interface EvidenceCategorySummary {
  readonly category: EvidenceCategory;
  readonly present: boolean;
  readonly outcome: EvidenceOutcome | null;
  readonly revision: string | null;
  readonly expired: boolean;
  readonly matchesTarget: boolean;
}

// ─── Diagnostics ────────────────────────────────────────────────

/**
 * Diagnostic snapshot of the stage advancement system, suitable for
 * renderer and release gates.
 */
export interface AdvancementDiagnostics {
  /** Current gate decision */
  readonly currentDecision: AdvancementDecision;
  /** The revision all evidence must match */
  readonly targetRevision: string;
  /** Per-category status */
  readonly categories: readonly EvidenceCategorySummary[];
  /** Unresolved divergence count */
  readonly unresolvedDivergenceCount: number;
  /** All blocking reasons */
  readonly blockReasons: readonly GateBlockReason[];
  /** ISO 8601 timestamp of diagnostic generation */
  readonly generatedAt: string;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the stage advancement service.
 */
export interface StageAdvancementConfig {
  /** Maximum age in milliseconds before evidence is considered expired */
  readonly evidenceMaxAgeMs: number;
  /** Whether to require all evidence at the same revision */
  readonly requireRevisionConsistency: boolean;
  /** Categories that can be waived (manual_review can be waived for dev environments) */
  readonly waivableCategories: readonly EvidenceCategory[];
}

export const DEFAULT_STAGE_ADVANCEMENT_CONFIG: StageAdvancementConfig = {
  evidenceMaxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  requireRevisionConsistency: true,
  waivableCategories: [],
};

// ─── Service ────────────────────────────────────────────────────

/**
 * Automates stage advancement decisions by collecting evidence records,
 * checking revision consistency, staleness, and divergences, and producing
 * deterministic gate decisions.
 *
 * The service is stateless in the sense that it evaluates the current state
 * of provided evidence on each call. Evidence storage is external.
 */
export class StageAdvancementService {
  private evidence: Map<EvidenceCategory, EvidenceRecord> = new Map();
  private divergences: DivergenceRecord[] = [];
  private targetRevision: string;
  private config: StageAdvancementConfig;
  private waivedCategories: Set<EvidenceCategory> = new Set();

  constructor(targetRevision: string, config: Partial<StageAdvancementConfig> = {}) {
    this.targetRevision = targetRevision;
    this.config = { ...DEFAULT_STAGE_ADVANCEMENT_CONFIG, ...config };
  }

  // ─── Evidence Management ────────────────────────────────────────

  /**
   * Record evidence for a category. Replaces any existing evidence for that category.
   * This enables reruns: recording new evidence overwrites prior results.
   */
  recordEvidence(record: EvidenceRecord): void {
    if (!ALL_EVIDENCE_CATEGORIES.includes(record.category)) {
      throw new Error(`Unknown evidence category: '${record.category}'`);
    }
    this.evidence.set(record.category, record);
  }

  /**
   * Get the current evidence for a category, or null if not recorded.
   */
  getEvidence(category: EvidenceCategory): EvidenceRecord | null {
    return this.evidence.get(category) ?? null;
  }

  /**
   * Get all recorded evidence.
   */
  getAllEvidence(): readonly EvidenceRecord[] {
    return Array.from(this.evidence.values());
  }

  /**
   * Clear evidence for a specific category (useful for invalidation).
   */
  clearEvidence(category: EvidenceCategory): void {
    this.evidence.delete(category);
  }

  // ─── Divergence Management ──────────────────────────────────────

  /**
   * Record a divergence from shadow comparison.
   */
  recordDivergence(divergence: DivergenceRecord): void {
    const existing = this.divergences.findIndex((d) => d.id === divergence.id);
    if (existing >= 0) {
      this.divergences[existing] = divergence;
    } else {
      this.divergences.push(divergence);
    }
  }

  /**
   * Resolve a divergence.
   */
  resolveDivergence(divergenceId: string, resolvedAtRevision: string): boolean {
    const index = this.divergences.findIndex((d) => d.id === divergenceId);
    if (index < 0) return false;
    this.divergences[index] = {
      ...this.divergences[index],
      resolved: true,
      resolvedAtRevision,
    };
    return true;
  }

  /**
   * Get all unresolved divergences.
   */
  getUnresolvedDivergences(): readonly DivergenceRecord[] {
    return this.divergences.filter((d) => !d.resolved);
  }

  // ─── Waiver Management ──────────────────────────────────────────

  /**
   * Waive a category from the advancement gate. Only categories declared
   * in `waivableCategories` config can be waived.
   */
  waiveCategory(category: EvidenceCategory): boolean {
    if (!this.config.waivableCategories.includes(category)) {
      return false;
    }
    this.waivedCategories.add(category);
    return true;
  }

  /**
   * Remove a waiver.
   */
  removeWaiver(category: EvidenceCategory): void {
    this.waivedCategories.delete(category);
  }

  // ─── Target Revision ────────────────────────────────────────────

  /**
   * Update the target revision. This may invalidate existing evidence.
   */
  setTargetRevision(revision: string): void {
    this.targetRevision = revision;
  }

  /**
   * Get the current target revision.
   */
  getTargetRevision(): string {
    return this.targetRevision;
  }

  // ─── Gate Evaluation ────────────────────────────────────────────

  /**
   * Evaluate whether stage advancement is permitted.
   * This is a deterministic, pure evaluation of the current state.
   *
   * Advancement is blocked when:
   * - Any required evidence category is missing (and not waived)
   * - Any evidence has a different revision than the target
   * - Any evidence has expired
   * - Any evidence has a failed or running outcome
   * - Unresolved divergences exist
   */
  evaluate(now?: Date): AdvancementGateResult {
    const evaluationTime = now ?? new Date();
    const blockReasons: GateBlockReason[] = [];
    const evidenceSummary: EvidenceCategorySummary[] = [];

    for (const category of ALL_EVIDENCE_CATEGORIES) {
      // Skip waived categories
      if (this.waivedCategories.has(category)) {
        evidenceSummary.push({
          category,
          present: true,
          outcome: 'pass',
          revision: this.targetRevision,
          expired: false,
          matchesTarget: true,
        });
        continue;
      }

      const record = this.evidence.get(category);

      if (!record) {
        // Missing evidence
        blockReasons.push({
          category,
          code: 'missing',
          description: `Evidence for '${category}' is missing`,
          evidenceId: null,
        });
        evidenceSummary.push({
          category,
          present: false,
          outcome: null,
          revision: null,
          expired: false,
          matchesTarget: false,
        });
        continue;
      }

      // Check revision match
      const matchesTarget = record.revision === this.targetRevision;
      if (this.config.requireRevisionConsistency && !matchesTarget) {
        blockReasons.push({
          category,
          code: 'revision_mismatch',
          description: `Evidence for '${category}' was produced at revision '${record.revision}' but target is '${this.targetRevision}'`,
          evidenceId: record.id,
        });
      }

      // Check expiry
      const expired = this.isExpired(record, evaluationTime);
      if (expired) {
        blockReasons.push({
          category,
          code: 'expired',
          description: `Evidence for '${category}' has expired (produced at ${record.producedAt})`,
          evidenceId: record.id,
        });
      }

      // Check outcome
      if (record.outcome === 'fail') {
        blockReasons.push({
          category,
          code: 'failed',
          description: `Evidence for '${category}' failed: ${record.reason ?? 'no reason provided'}`,
          evidenceId: record.id,
        });
      } else if (record.outcome === 'running') {
        blockReasons.push({
          category,
          code: 'running',
          description: `Evidence for '${category}' is still running`,
          evidenceId: record.id,
        });
      } else if (record.outcome === 'stale') {
        blockReasons.push({
          category,
          code: 'stale',
          description: `Evidence for '${category}' is marked as stale`,
          evidenceId: record.id,
        });
      } else if (record.outcome === 'blocked') {
        blockReasons.push({
          category,
          code: 'failed',
          description: `Evidence for '${category}' is blocked: ${record.reason ?? 'no reason provided'}`,
          evidenceId: record.id,
        });
      }

      evidenceSummary.push({
        category,
        present: true,
        outcome: record.outcome,
        revision: record.revision,
        expired,
        matchesTarget,
      });
    }

    // Check unresolved divergences
    const unresolvedDivergences = this.getUnresolvedDivergences();
    for (const div of unresolvedDivergences) {
      blockReasons.push({
        category: 'divergence',
        code: 'unresolved_divergence',
        description: `Unresolved divergence: ${div.description}`,
        evidenceId: null,
      });
    }

    // Determine revision consistency
    const recordedRevisions = Array.from(this.evidence.values()).map((e) => e.revision);
    const revisionConsistent =
      recordedRevisions.length > 0 &&
      recordedRevisions.every((r) => r === this.targetRevision);

    const decision: AdvancementDecision = blockReasons.length === 0 ? 'permitted' : 'blocked';

    return {
      decision,
      targetRevision: this.targetRevision,
      blockReasons,
      evidenceSummary,
      evaluatedAt: evaluationTime.toISOString(),
      revisionConsistent,
    };
  }

  // ─── Diagnostics ────────────────────────────────────────────────

  /**
   * Get a diagnostic snapshot of the current state suitable for
   * renderer display or release gate inspection.
   */
  getDiagnostics(now?: Date): AdvancementDiagnostics {
    const result = this.evaluate(now);
    return {
      currentDecision: result.decision,
      targetRevision: this.targetRevision,
      categories: result.evidenceSummary,
      unresolvedDivergenceCount: this.getUnresolvedDivergences().length,
      blockReasons: result.blockReasons,
      generatedAt: result.evaluatedAt,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Determine if an evidence record is expired based on:
   * 1. Explicit expiresAt field
   * 2. Configured maximum age
   */
  private isExpired(record: EvidenceRecord, now: Date): boolean {
    // Check explicit expiry
    if (record.expiresAt) {
      const expiresAt = new Date(record.expiresAt);
      if (now >= expiresAt) return true;
    }

    // Check max age
    const producedAt = new Date(record.producedAt);
    const age = now.getTime() - producedAt.getTime();
    return age > this.config.evidenceMaxAgeMs;
  }
}
