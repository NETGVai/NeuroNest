/**
 * Best-of-N Ranker — generates multiple candidate solutions and selects the best
 * one based on verification score, line count, and generation order.
 *
 * Selection logic:
 * 1. Highest verification score wins
 * 2. Ties: fewest lines changed wins
 * 3. Still tied: first generated (lowest index) wins
 */

// ─── Types ──────────────────────────────────────────────────────

export interface AgentEdit {
  filePath: string;
  content: string;
  description?: string;
}

export interface VerificationResult {
  totalScore: number;
  maxScore: number;
  stages: Array<{
    name: string;
    passed: boolean;
    diagnostics: string[];
    durationMs: number;
  }>;
  accepted: boolean;
  failedAt?: string;
}

export interface BestOfNConfig {
  /** Number of candidates to generate (default: 3) */
  n: number;
  /** Strategy for selecting the best candidate */
  selectionStrategy: 'highest-score' | 'highest-score-fewest-lines';
}

export interface CandidateResult {
  /** Zero-based generation index */
  index: number;
  /** The agent-generated edit */
  edit: AgentEdit;
  /** Verification pipeline result */
  verificationResult: VerificationResult;
  /** Total lines changed by this candidate */
  linesChanged: number;
}

export interface RankingSummary {
  /** The selected best candidate */
  selected: CandidateResult;
  /** All candidates with their scores, for transparency */
  allCandidates: Array<{
    index: number;
    score: number;
    maxScore: number;
    linesChanged: number;
    accepted: boolean;
  }>;
  /** Total number of candidates evaluated */
  totalCandidates: number;
}

// ─── Default Config ─────────────────────────────────────────────

export const DEFAULT_BEST_OF_N_CONFIG: BestOfNConfig = {
  n: 3,
  selectionStrategy: 'highest-score-fewest-lines',
};

// ─── Selection Logic ────────────────────────────────────────────

/**
 * Selects the best candidate from a list based on the configured strategy.
 *
 * Selection rules:
 * 1. Highest verification score wins
 * 2. Ties broken by fewest lines changed (when strategy is 'highest-score-fewest-lines')
 * 3. Still tied: first generated (lowest index) wins
 *
 * @throws Error if candidates array is empty
 */
export function selectBest(candidates: CandidateResult[], config: BestOfNConfig): CandidateResult {
  if (candidates.length === 0) {
    throw new Error('Cannot select from empty candidate list');
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  let best = candidates[0];

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const comparison = compareCandidates(best, candidate, config);
    if (comparison > 0) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Compares two candidates and returns:
 * - negative if `a` is better
 * - positive if `b` is better
 * - zero if equal (shouldn't happen with index tiebreaker)
 */
function compareCandidates(a: CandidateResult, b: CandidateResult, config: BestOfNConfig): number {
  // 1. Highest verification score wins
  const scoreDiff = b.verificationResult.totalScore - a.verificationResult.totalScore;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  // 2. Fewest lines changed wins (only for 'highest-score-fewest-lines' strategy)
  if (config.selectionStrategy === 'highest-score-fewest-lines') {
    const linesDiff = a.linesChanged - b.linesChanged;
    if (linesDiff !== 0) {
      return linesDiff;
    }
  }

  // 3. First generated (lowest index) wins
  return a.index - b.index;
}

// ─── Ranking Summary ────────────────────────────────────────────

/**
 * Generates a complete ranking summary for all candidates, selecting
 * the best and reporting all scores for transparency.
 */
export function rankCandidates(candidates: CandidateResult[], config: BestOfNConfig): RankingSummary {
  const selected = selectBest(candidates, config);

  const allCandidates = candidates.map((c) => ({
    index: c.index,
    score: c.verificationResult.totalScore,
    maxScore: c.verificationResult.maxScore,
    linesChanged: c.linesChanged,
    accepted: c.verificationResult.accepted,
  }));

  return {
    selected,
    allCandidates,
    totalCandidates: candidates.length,
  };
}

// ─── Candidate Generation Orchestrator ──────────────────────────

export type CandidateGenerator = (index: number) => Promise<CandidateResult>;

/**
 * Generates N candidates using the provided generator function and selects the best.
 * Reports all candidate scores in the returned summary.
 *
 * @param generator - Async function that produces a CandidateResult for a given index
 * @param config - Best-of-N configuration (n, selectionStrategy)
 * @returns A ranking summary with the selected best candidate and all scores
 */
export async function generateAndRank(
  generator: CandidateGenerator,
  config: BestOfNConfig = DEFAULT_BEST_OF_N_CONFIG,
): Promise<RankingSummary> {
  const candidates: CandidateResult[] = [];

  for (let i = 0; i < config.n; i++) {
    const candidate = await generator(i);
    candidates.push(candidate);
  }

  return rankCandidates(candidates, config);
}
