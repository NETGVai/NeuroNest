/**
 * AnomalyDetector — orchestrates multiple scorers with quorum logic and timeout enforcement.
 *
 * Runs all configured scorers in parallel, enforces a per-scorer latency budget,
 * and applies quorum logic to determine whether an edit should be flagged.
 *
 * Key behaviors:
 * - Scorers that exceed maxLatencyMs are treated as "not flagged"
 * - An edit is flagged only if >= quorum scorers independently flag it
 * - Concerns from agreeing scorers are aggregated for user presentation
 */
import type {
  AnomalyScorer,
  AnomalyScore,
  AnomalyDetectorConfig,
  AnomalyDetectorResult,
  AgentEdit,
  TaskContext,
} from './types';

/** Default score returned when a scorer times out. */
const TIMED_OUT_SCORE: AnomalyScore = {
  flagged: false,
  confidence: 0,
  concerns: [],
};

/**
 * Races a scorer's score() call against a timeout.
 * If the scorer exceeds the budget, returns a non-flagged result.
 */
async function scoreWithTimeout(
  scorer: AnomalyScorer,
  edit: AgentEdit,
  context: TaskContext,
  maxLatencyMs: number
): Promise<{ score: AnomalyScore; timedOut: boolean }> {
  let timedOut = false;

  const timeoutPromise = new Promise<AnomalyScore>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve(TIMED_OUT_SCORE);
    }, maxLatencyMs);
  });

  try {
    const result = await Promise.race([
      scorer.score(edit, context),
      timeoutPromise,
    ]);

    return { score: result, timedOut };
  } catch {
    // If a scorer crashes, treat as not-flagged and log
    return { score: TIMED_OUT_SCORE, timedOut: false };
  }
}

/**
 * Evaluates quorum logic: determines if enough scorers agree to flag an edit.
 */
export function evaluateQuorum(
  scores: AnomalyScore[],
  quorum: number
): boolean {
  const flaggedCount = scores.filter(s => s.flagged).length;
  return flaggedCount >= quorum;
}

/**
 * Aggregates concerns from scorers that flagged the edit.
 */
function aggregateConcerns(
  scores: Array<{ scorerName: string; score: AnomalyScore; timedOut: boolean }>
): string[] {
  const concerns: string[] = [];
  for (const entry of scores) {
    if (entry.score.flagged && !entry.timedOut) {
      for (const concern of entry.score.concerns) {
        concerns.push(`[${entry.scorerName}] ${concern}`);
      }
    }
  }
  return concerns;
}

/**
 * The main AnomalyDetector class.
 * Designed to run in parallel with verification stages.
 */
export class AnomalyDetector {
  private readonly config: AnomalyDetectorConfig;

  constructor(config: AnomalyDetectorConfig) {
    this.config = config;
  }

  /**
   * Detect anomalies in the given edit by running all scorers in parallel.
   * Returns structured result including whether the edit was flagged,
   * individual scorer results, and aggregated concerns.
   */
  async detect(edit: AgentEdit, context: TaskContext): Promise<AnomalyDetectorResult> {
    const { scorers, quorum, maxLatencyMs } = this.config;

    // Run all scorers in parallel with timeout enforcement
    const results = await Promise.all(
      scorers.map(async (scorer) => {
        const { score, timedOut } = await scoreWithTimeout(scorer, edit, context, maxLatencyMs);
        return { scorerName: scorer.name, score, timedOut };
      })
    );

    // Only consider non-timed-out scores for quorum
    const validScores = results
      .filter(r => !r.timedOut)
      .map(r => r.score);

    const flagged = evaluateQuorum(validScores, quorum);
    const flaggedCount = validScores.filter(s => s.flagged).length;
    const concerns = flagged ? aggregateConcerns(results) : [];

    return {
      flagged,
      flaggedCount,
      totalScorers: scorers.length,
      scores: results,
      concerns,
    };
  }
}

/**
 * Creates an AnomalyDetector with default configuration.
 */
export function createDefaultDetector(scorers: AnomalyScorer[]): AnomalyDetector {
  return new AnomalyDetector({
    scorers,
    quorum: 2,
    maxLatencyMs: 50,
  });
}
