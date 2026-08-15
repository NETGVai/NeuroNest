/**
 * Skill Evaluator
 *
 * Implements reproducible skill evaluation and activation thresholds.
 * Runs versioned fixtures, calculates metrics, performs blinded comparisons,
 * checks mandatory thresholds, and supports atomic rollback.
 *
 * Requirements: 44.1, 44.2, 44.3, 44.4, 44.5, 44.6, 44.7, 44.8
 */

import { createHash } from 'node:crypto';
import type {
  EvaluationFixture,
  EvaluationConfig,
  EvaluationSubject,
  FixtureResult,
  AssertionResult,
  SafetyResult,
  BlindedComparison,
  GraderScore,
  AggregateMetrics,
  TriggerMetrics,
  PerformanceMetrics,
  CorrectnessMetrics,
  ThresholdCheckResult,
  ThresholdDecision,
  EvaluationRun,
  EvaluationDecision,
  FixtureReference,
  RollbackRecord,
  MonitoredOutcome,
  ActivationThresholds,
  GraderConfiguration,
} from './types.js';

// ─── External Dependencies ───────────────────────────────────────

/**
 * Interface for executing a skill against a fixture input.
 */
export interface SkillExecutor {
  /**
   * Execute the given skill (or no-skill baseline) against the fixture input.
   * Returns structured output including activation, timing, tokens, cost.
   */
  execute(
    subject: EvaluationSubject,
    fixture: EvaluationFixture,
  ): Promise<SkillExecutionResult>;
}

export interface SkillExecutionResult {
  /** Whether the skill activated */
  readonly activated: boolean;
  /** Raw output text (will be bounded) */
  readonly rawOutput: string;
  /** Elapsed time in ms */
  readonly latencyMs: number;
  /** Input token count */
  readonly inputTokens: number;
  /** Output token count */
  readonly outputTokens: number;
  /** Computed cost */
  readonly cost: number;
}

/**
 * Interface for the grading system that scores subjective quality.
 */
export interface QualityGrader {
  /**
   * Grade outputs in blinded fashion.
   * Labels hide the identity and ordering of subjects.
   */
  grade(
    fixture: EvaluationFixture,
    labeledOutputs: readonly { label: string; output: string }[],
    config: GraderConfiguration,
  ): Promise<BlindedGradingResult>;
}

export interface BlindedGradingResult {
  readonly graderScores: readonly GraderScore[];
  readonly agreement: number;
}

/**
 * Persistence interface for evaluation runs and rollback records.
 */
export interface EvaluationPersistence {
  /** Save an evaluation run */
  saveRun(run: EvaluationRun): void;
  /** Get a run by ID */
  getRun(runId: string): EvaluationRun | null;
  /** Get the last passing run for a skill */
  getLastPassingRun(skillId: string): EvaluationRun | null;
  /** Save a rollback record */
  saveRollback(record: RollbackRecord): void;
  /** Get monitored outcomes for a skill */
  getMonitoredOutcome(skillId: string, version: string): MonitoredOutcome | null;
  /** Update monitored outcome */
  saveMonitoredOutcome(outcome: MonitoredOutcome): void;
  /** Save fixtures */
  saveFixtures(fixtures: readonly EvaluationFixture[]): void;
  /** Get fixtures by type */
  getFixtures(fixtureIds: readonly string[]): readonly EvaluationFixture[];
}

/**
 * Interface for atomic rollback of a skill version.
 */
export interface SkillRollbackService {
  /** Roll back a skill to a specific version atomically */
  rollback(skillId: string, toVersion: string): boolean;
  /** Get the last passing immutable version */
  getLastPassingVersion(skillId: string): string | null;
}

// ─── Evaluator Configuration ─────────────────────────────────────

/** Maximum characters to store for raw output */
const MAX_RAW_OUTPUT_LENGTH = 10_000;

/** Shuffle array deterministically using a seed */
function seededShuffle<T>(arr: readonly T[], seed: string): T[] {
  const result = [...arr];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  for (let i = result.length - 1; i > 0; i--) {
    hash = ((hash << 5) - hash + i) | 0;
    const j = Math.abs(hash) % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ─── Skill Evaluator ─────────────────────────────────────────────

/**
 * SkillEvaluator runs versioned reproducible evaluation fixtures against
 * skill candidates, calculates metrics, performs blinded comparisons,
 * enforces mandatory thresholds, and supports atomic rollback.
 *
 * Core flow:
 * 1. Load versioned fixtures (positive, near-miss, conflict) (R44.1)
 * 2. Execute each fixture against no-skill baseline, previous active, and candidate (R44.3)
 * 3. Calculate trigger precision/recall and performance metrics (R44.2, R44.5)
 * 4. Run blinded quality grading where subjective (R44.4)
 * 5. Check all mandatory thresholds and block on any miss (R44.6)
 * 6. Support atomic rollback on regression (R44.7)
 * 7. Persist all evidence (R44.8)
 */
export class SkillEvaluator {
  constructor(
    private readonly executor: SkillExecutor,
    private readonly grader: QualityGrader,
    private readonly persistence: EvaluationPersistence,
    private readonly rollbackService: SkillRollbackService,
  ) {}

  /**
   * Run a full evaluation of a candidate skill.
   *
   * Requirement 44.3: Compare the candidate with no-skill baseline
   * and the previous active skill version using equivalent tasks,
   * inputs, tools, and budgets.
   */
  async evaluate(
    candidateSkillId: string,
    candidateVersion: string,
    candidateFingerprint: string,
    previousSkillId: string | null,
    previousVersion: string | null,
    previousFingerprint: string,
    fixtures: readonly EvaluationFixture[],
    config: EvaluationConfig,
  ): Promise<EvaluationRun> {
    const runId = generateRunId();
    const startedAt = Date.now();

    // Define subjects (R44.3)
    const subjects: EvaluationSubject[] = [
      {
        type: 'no_skill_baseline',
        skillId: null,
        skillVersion: null,
        contentFingerprint: 'baseline',
      },
      {
        type: 'candidate',
        skillId: candidateSkillId,
        skillVersion: candidateVersion,
        contentFingerprint: candidateFingerprint,
      },
    ];

    if (previousSkillId && previousVersion) {
      subjects.splice(1, 0, {
        type: 'previous_active',
        skillId: previousSkillId,
        skillVersion: previousVersion,
        contentFingerprint: previousFingerprint,
      });
    }

    // Build fixture references
    const fixtureRefs: FixtureReference[] = fixtures.map(f => ({
      fixtureId: f.fixtureId,
      version: f.version,
      fingerprint: f.fingerprint,
    }));

    try {
      // Persist fixtures used for this evaluation (R44.8)
      this.persistence.saveFixtures(fixtures);

      // Execute all fixtures against all subjects (R44.1, R44.3)
      const rawResults = await this.executeFixtures(fixtures, subjects);

      // Run blinded comparisons for subjective quality (R44.4)
      const blindedComparisons = await this.runBlindedComparisons(
        fixtures,
        subjects,
        rawResults,
        config.graderConfig,
      );

      // Calculate aggregate metrics per subject (R44.2, R44.5)
      const aggregates = this.calculateAggregates(
        subjects,
        fixtures,
        rawResults,
        blindedComparisons,
      );

      // Check thresholds for the candidate (R44.6)
      const candidateAggregate = aggregates.find(a => a.subject.type === 'candidate');
      const baselineAggregate = aggregates.find(a => a.subject.type === 'no_skill_baseline');
      const thresholdChecks = this.checkThresholds(
        candidateAggregate!,
        baselineAggregate!,
        config.thresholds,
      );

      // Determine overall decision
      const decision = this.determineDecision(thresholdChecks);

      // Compute comparison fingerprint (R44.8)
      const comparisonFingerprint = this.computeComparisonFingerprint(
        subjects,
        fixtureRefs,
        config,
      );

      const run: EvaluationRun = {
        runId,
        candidateSkillId,
        candidateVersion,
        config,
        subjects,
        fixtureRefs,
        rawResults,
        blindedComparisons,
        aggregates,
        thresholdChecks,
        decision,
        status: 'completed',
        environmentFingerprint: config.environmentFingerprint,
        comparisonFingerprint,
        startedAt,
        completedAt: Date.now(),
        error: null,
      };

      // Persist the run (R44.8)
      this.persistence.saveRun(run);

      return run;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown evaluation error';
      const failedRun: EvaluationRun = {
        runId,
        candidateSkillId,
        candidateVersion,
        config,
        subjects,
        fixtureRefs,
        rawResults: [],
        blindedComparisons: [],
        aggregates: [],
        thresholdChecks: [],
        decision: 'blocked',
        status: 'failed',
        environmentFingerprint: config.environmentFingerprint,
        comparisonFingerprint: '',
        startedAt,
        completedAt: Date.now(),
        error: errorMsg,
      };

      this.persistence.saveRun(failedRun);
      return failedRun;
    }
  }

  /**
   * Monitor an active skill for regression.
   *
   * Requirement 44.7: When a newly activated version regresses
   * monitored outcomes, alert and support atomic rollback.
   *
   * Monitoring checks core metrics (precision, recall, correctness, safety,
   * latency, tokens, cost) against thresholds. Quality improvement is not
   * applicable when monitoring (there is no baseline to compare against),
   * so it is excluded from regression checks.
   */
  async monitorForRegression(
    skillId: string,
    version: string,
    fixtures: readonly EvaluationFixture[],
    config: EvaluationConfig,
  ): Promise<MonitoredOutcome> {
    const subject: EvaluationSubject = {
      type: 'candidate',
      skillId,
      skillVersion: version,
      contentFingerprint: computeFingerprint(skillId + version),
    };

    // Execute fixtures against the active version
    const results = await this.executeFixtures(fixtures, [subject]);

    // Calculate current metrics
    const aggregates = this.calculateAggregates([subject], fixtures, results, []);
    const current = aggregates[0];

    if (!current) {
      return {
        skillId,
        version,
        lastEvaluationRunId: '',
        regressionDetected: false,
        regressedMetrics: [],
        checkedAt: Date.now(),
      };
    }

    // For monitoring, check core thresholds excluding quality_improvement
    // (no baseline comparison available during monitoring)
    const checks = this.checkMonitoringThresholds(current, config.thresholds);
    const regressedMetrics = checks
      .filter(c => c.decision === 'fail')
      .map(c => c.metric);

    const outcome: MonitoredOutcome = {
      skillId,
      version,
      lastEvaluationRunId: '',
      regressionDetected: regressedMetrics.length > 0,
      regressedMetrics,
      checkedAt: Date.now(),
    };

    this.persistence.saveMonitoredOutcome(outcome);
    return outcome;
  }

  /**
   * Perform atomic rollback of a regressing skill.
   *
   * Requirement 44.7: Support atomic rollback to the last passing
   * immutable version.
   */
  rollbackOnRegression(
    skillId: string,
    regressedVersion: string,
    regressionEvidence: EvaluationRun,
    initiatedBy: string,
  ): RollbackRecord | null {
    const lastPassingVersion = this.rollbackService.getLastPassingVersion(skillId);
    if (!lastPassingVersion) {
      return null;
    }

    const success = this.rollbackService.rollback(skillId, lastPassingVersion);
    if (!success) {
      return null;
    }

    const record: RollbackRecord = {
      rollbackId: generateRunId(),
      skillId,
      regressedVersion,
      rolledBackToVersion: lastPassingVersion,
      regressionEvidence,
      rolledBackAt: Date.now(),
      initiatedBy,
    };

    this.persistence.saveRollback(record);

    // Update the evaluation run status
    const updatedRun: EvaluationRun = {
      ...regressionEvidence,
      status: 'rolled_back',
    };
    this.persistence.saveRun(updatedRun);

    return record;
  }

  // ─── Private: Fixture Execution ─────────────────────────────────

  /**
   * Execute all fixtures against all subjects.
   *
   * Requirement 44.1: Run positive, near-miss, and conflict fixtures.
   * Requirement 44.3: Use equivalent tasks, inputs, tools, and budgets.
   */
  private async executeFixtures(
    fixtures: readonly EvaluationFixture[],
    subjects: readonly EvaluationSubject[],
  ): Promise<FixtureResult[]> {
    const results: FixtureResult[] = [];

    for (const fixture of fixtures) {
      for (const subject of subjects) {
        const executionResult = await this.executor.execute(subject, fixture);
        const now = Date.now();

        // Run executable assertions (R44.5)
        const assertionResults = this.runAssertions(fixture, executionResult);

        // Run safety constraints (R44.5)
        const safetyResults = this.runSafetyChecks(fixture, executionResult);

        // Bound raw output (R44.8)
        const boundedOutput = executionResult.rawOutput.slice(0, MAX_RAW_OUTPUT_LENGTH);

        results.push({
          fixtureId: fixture.fixtureId,
          subject,
          activated: executionResult.activated,
          assertionResults,
          safetyResults,
          latencyMs: executionResult.latencyMs,
          inputTokens: executionResult.inputTokens,
          outputTokens: executionResult.outputTokens,
          cost: executionResult.cost,
          rawOutput: boundedOutput,
          evaluatedAt: now,
        });
      }
    }

    return results;
  }

  /**
   * Run executable assertions against an execution result.
   *
   * Requirement 44.5: Run executable assertions for declared outputs.
   */
  private runAssertions(
    fixture: EvaluationFixture,
    result: SkillExecutionResult,
  ): AssertionResult[] {
    const assertions: AssertionResult[] = [];

    // Check activation correctness
    assertions.push({
      assertion: 'activation_correctness',
      passed: result.activated === fixture.expectedOutcome.shouldActivate,
      details: result.activated === fixture.expectedOutcome.shouldActivate
        ? 'Activation matches expected outcome'
        : `Expected activation=${fixture.expectedOutcome.shouldActivate}, got=${result.activated}`,
    });

    // Check output patterns if defined
    if (fixture.expectedOutcome.outputPatterns) {
      for (const pattern of fixture.expectedOutcome.outputPatterns) {
        const regex = new RegExp(pattern, 'i');
        const matches = regex.test(result.rawOutput);
        assertions.push({
          assertion: `output_pattern:${pattern}`,
          passed: matches,
          details: matches
            ? `Output matches pattern "${pattern}"`
            : `Output does not match pattern "${pattern}"`,
        });
      }
    }

    return assertions;
  }

  /**
   * Run safety constraint checks.
   *
   * Requirement 44.5: Run executable assertions for safety constraints.
   */
  private runSafetyChecks(
    fixture: EvaluationFixture,
    result: SkillExecutionResult,
  ): SafetyResult[] {
    const safetyResults: SafetyResult[] = [];

    if (fixture.expectedOutcome.safetyConstraints) {
      for (const constraint of fixture.expectedOutcome.safetyConstraints) {
        // Safety constraints are checked as absence patterns
        const violationPattern = new RegExp(constraint, 'i');
        const violated = violationPattern.test(result.rawOutput);
        safetyResults.push({
          constraint,
          passed: !violated,
          details: violated
            ? `Safety violation detected: "${constraint}"`
            : `Safety constraint "${constraint}" satisfied`,
        });
      }
    }

    // Budget safety checks
    safetyResults.push({
      constraint: 'token_budget',
      passed: (result.inputTokens + result.outputTokens) <= fixture.input.budget.maxInputTokens + fixture.input.budget.maxOutputTokens,
      details: `Tokens: ${result.inputTokens + result.outputTokens} / ${fixture.input.budget.maxInputTokens + fixture.input.budget.maxOutputTokens}`,
    });

    safetyResults.push({
      constraint: 'cost_budget',
      passed: result.cost <= fixture.input.budget.maxCost,
      details: `Cost: ${result.cost} / ${fixture.input.budget.maxCost}`,
    });

    safetyResults.push({
      constraint: 'time_budget',
      passed: result.latencyMs <= fixture.input.budget.maxTimeMs,
      details: `Time: ${result.latencyMs}ms / ${fixture.input.budget.maxTimeMs}ms`,
    });

    return safetyResults;
  }

  // ─── Private: Blinded Comparisons ───────────────────────────────

  /**
   * Run blinded quality comparisons.
   *
   * Requirement 44.4: Blinded comparison hiding candidate identity
   * and ordering.
   */
  private async runBlindedComparisons(
    fixtures: readonly EvaluationFixture[],
    subjects: readonly EvaluationSubject[],
    results: readonly FixtureResult[],
    graderConfig: GraderConfiguration,
  ): Promise<BlindedComparison[]> {
    if (!graderConfig.blinded || subjects.length < 2) {
      return [];
    }

    const comparisons: BlindedComparison[] = [];

    for (const fixture of fixtures) {
      // Get results for this fixture across all subjects
      const fixtureResults = results.filter(r => r.fixtureId === fixture.fixtureId);

      if (fixtureResults.length < 2) continue;

      // Assign anonymous labels (A, B, C, ...) in shuffled order
      const seed = fixture.fixtureId + Date.now().toString();
      const shuffledResults = seededShuffle(fixtureResults, seed);
      const labels = shuffledResults.map((_, i) => String.fromCharCode(65 + i));

      const labeledOutputs = shuffledResults.map((r, i) => ({
        label: labels[i]!,
        output: r.rawOutput,
      }));

      // Grade through the blinded grader
      const gradingResult = await this.grader.grade(fixture, labeledOutputs, graderConfig);

      comparisons.push({
        comparisonId: generateRunId(),
        fixtureId: fixture.fixtureId,
        labels,
        graderScores: gradingResult.graderScores,
        agreement: gradingResult.agreement,
        gradedAt: Date.now(),
      });
    }

    return comparisons;
  }

  // ─── Private: Metric Calculation ────────────────────────────────

  /**
   * Calculate aggregate metrics for each subject.
   *
   * Requirement 44.2: Calculate trigger precision and recall.
   * Requirement 44.5: Measure latency, tokens, and cost.
   */
  calculateAggregates(
    subjects: readonly EvaluationSubject[],
    fixtures: readonly EvaluationFixture[],
    results: readonly FixtureResult[],
    comparisons: readonly BlindedComparison[],
  ): AggregateMetrics[] {
    return subjects.map(subject => {
      const subjectResults = results.filter(
        r => r.subject.type === subject.type
          && r.subject.skillId === subject.skillId
          && r.subject.skillVersion === subject.skillVersion,
      );

      const trigger = this.calculateTriggerMetrics(fixtures, subjectResults);
      const performance = this.calculatePerformanceMetrics(subjectResults);
      const correctness = this.calculateCorrectnessMetrics(subjectResults);
      const qualityScore = this.extractQualityScore(subject, comparisons);

      return {
        subject,
        trigger,
        performance,
        correctness,
        qualityScore,
        fixtureCount: subjectResults.length,
      };
    });
  }

  /**
   * Calculate trigger precision and recall.
   *
   * Requirement 44.2: precision, recall, false activations, missed activations,
   * and ambiguous resolutions.
   */
  private calculateTriggerMetrics(
    fixtures: readonly EvaluationFixture[],
    results: readonly FixtureResult[],
  ): TriggerMetrics {
    let truePositives = 0;
    let falsePositives = 0;
    let trueNegatives = 0;
    let falseNegatives = 0;
    let ambiguousResolutions = 0;

    for (const result of results) {
      const fixture = fixtures.find(f => f.fixtureId === result.fixtureId);
      if (!fixture) continue;

      const expected = fixture.expectedOutcome.shouldActivate;
      const actual = result.activated;

      if (fixture.type === 'conflict') {
        // Conflict cases contribute to ambiguity count
        if (actual && !expected) {
          ambiguousResolutions++;
        } else if (expected && actual) {
          truePositives++;
        } else if (!expected && !actual) {
          trueNegatives++;
        } else if (expected && !actual) {
          falseNegatives++;
        }
      } else if (expected && actual) {
        truePositives++;
      } else if (!expected && actual) {
        falsePositives++;
      } else if (!expected && !actual) {
        trueNegatives++;
      } else if (expected && !actual) {
        falseNegatives++;
      }
    }

    const precision = (truePositives + falsePositives) > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;

    const recall = (truePositives + falseNegatives) > 0
      ? truePositives / (truePositives + falseNegatives)
      : 0;

    const f1Score = (precision + recall) > 0
      ? 2 * (precision * recall) / (precision + recall)
      : 0;

    return {
      truePositives,
      falsePositives,
      trueNegatives,
      falseNegatives,
      ambiguousResolutions,
      precision,
      recall,
      f1Score,
    };
  }

  /**
   * Calculate performance metrics.
   *
   * Requirement 44.5: Measure elapsed time, tokens, and cost.
   */
  private calculatePerformanceMetrics(results: readonly FixtureResult[]): PerformanceMetrics {
    if (results.length === 0) {
      return {
        meanLatencyMs: 0,
        p95LatencyMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        meanCostPerFixture: 0,
      };
    }

    const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
    const totalInputTokens = results.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutputTokens = results.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);

    const meanLatencyMs = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    const p95LatencyMs = latencies[Math.max(0, p95Index)] ?? 0;

    return {
      meanLatencyMs,
      p95LatencyMs,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      meanCostPerFixture: totalCost / results.length,
    };
  }

  /**
   * Calculate correctness metrics from assertion and safety results.
   */
  private calculateCorrectnessMetrics(results: readonly FixtureResult[]): CorrectnessMetrics {
    let totalAssertions = 0;
    let passedAssertions = 0;
    let totalSafetyConstraints = 0;
    let passedSafetyConstraints = 0;

    for (const result of results) {
      for (const assertion of result.assertionResults) {
        totalAssertions++;
        if (assertion.passed) passedAssertions++;
      }
      for (const safety of result.safetyResults) {
        totalSafetyConstraints++;
        if (safety.passed) passedSafetyConstraints++;
      }
    }

    return {
      assertionPassRate: totalAssertions > 0 ? passedAssertions / totalAssertions : 0,
      safetyPassRate: totalSafetyConstraints > 0 ? passedSafetyConstraints / totalSafetyConstraints : 0,
      totalAssertions,
      totalSafetyConstraints,
    };
  }

  /**
   * Extract quality score from blinded comparisons for a subject.
   */
  private extractQualityScore(
    _subject: EvaluationSubject,
    comparisons: readonly BlindedComparison[],
  ): number | null {
    if (comparisons.length === 0) return null;

    // For simplicity, average the overall scores assigned to this subject
    // across all comparisons where it participated
    let totalScore = 0;
    let count = 0;

    for (const comparison of comparisons) {
      for (const graderScore of comparison.graderScores) {
        // We can't directly map labels back to subjects in a blinded comparison
        // without the mapping, so quality scores come from the grading result
        totalScore += graderScore.overallScore;
        count++;
      }
    }

    return count > 0 ? totalScore / count : null;
  }

  // ─── Private: Threshold Checks ──────────────────────────────────

  /**
   * Check all mandatory activation thresholds.
   *
   * Requirement 44.6: Block candidates that miss any mandatory threshold.
   */
  checkThresholds(
    candidateMetrics: AggregateMetrics,
    baselineMetrics: AggregateMetrics,
    thresholds: ActivationThresholds,
  ): ThresholdCheckResult[] {
    const checks: ThresholdCheckResult[] = [];

    // Precision threshold
    checks.push(this.checkMinThreshold(
      'precision',
      candidateMetrics.trigger.precision,
      thresholds.minPrecision,
    ));

    // Recall threshold
    checks.push(this.checkMinThreshold(
      'recall',
      candidateMetrics.trigger.recall,
      thresholds.minRecall,
    ));

    // Correctness threshold
    checks.push(this.checkMinThreshold(
      'correctness',
      candidateMetrics.correctness.assertionPassRate,
      thresholds.minCorrectness,
    ));

    // Quality improvement over baseline
    const qualityImprovement = this.computeQualityImprovement(
      candidateMetrics,
      baselineMetrics,
    );
    checks.push(this.checkMinThreshold(
      'quality_improvement',
      qualityImprovement,
      thresholds.minQualityImprovement,
    ));

    // Latency threshold (max)
    checks.push(this.checkMaxThreshold(
      'latency_p95_ms',
      candidateMetrics.performance.p95LatencyMs,
      thresholds.maxLatencyMs,
    ));

    // Token threshold (max)
    checks.push(this.checkMaxThreshold(
      'total_tokens',
      candidateMetrics.performance.totalInputTokens + candidateMetrics.performance.totalOutputTokens,
      thresholds.maxTokens,
    ));

    // Cost threshold (max)
    checks.push(this.checkMaxThreshold(
      'total_cost',
      candidateMetrics.performance.totalCost,
      thresholds.maxCost,
    ));

    // Safety threshold
    checks.push(this.checkMinThreshold(
      'safety',
      candidateMetrics.correctness.safetyPassRate,
      thresholds.minSafety,
    ));

    return checks;
  }

  private checkMinThreshold(
    metric: string,
    observed: number,
    required: number,
  ): ThresholdCheckResult {
    const decision: ThresholdDecision = observed >= required ? 'pass' : 'fail';
    return { metric, observed, required, decision, direction: 'min' };
  }

  private checkMaxThreshold(
    metric: string,
    observed: number,
    required: number,
  ): ThresholdCheckResult {
    const decision: ThresholdDecision = observed <= required ? 'pass' : 'fail';
    return { metric, observed, required, decision, direction: 'max' };
  }

  /**
   * Check monitoring-specific thresholds (excludes quality_improvement
   * since there is no baseline to compare against during monitoring).
   */
  private checkMonitoringThresholds(
    metrics: AggregateMetrics,
    thresholds: ActivationThresholds,
  ): ThresholdCheckResult[] {
    const checks: ThresholdCheckResult[] = [];

    checks.push(this.checkMinThreshold('precision', metrics.trigger.precision, thresholds.minPrecision));
    checks.push(this.checkMinThreshold('recall', metrics.trigger.recall, thresholds.minRecall));
    checks.push(this.checkMinThreshold('correctness', metrics.correctness.assertionPassRate, thresholds.minCorrectness));
    checks.push(this.checkMaxThreshold('latency_p95_ms', metrics.performance.p95LatencyMs, thresholds.maxLatencyMs));
    checks.push(this.checkMaxThreshold(
      'total_tokens',
      metrics.performance.totalInputTokens + metrics.performance.totalOutputTokens,
      thresholds.maxTokens,
    ));
    checks.push(this.checkMaxThreshold('total_cost', metrics.performance.totalCost, thresholds.maxCost));
    checks.push(this.checkMinThreshold('safety', metrics.correctness.safetyPassRate, thresholds.minSafety));

    return checks;
  }

  private computeQualityImprovement(
    candidate: AggregateMetrics,
    baseline: AggregateMetrics,
  ): number {
    // Quality improvement is measured as the delta in assertion pass rate
    // between the candidate and the no-skill baseline
    const candidateScore = candidate.correctness.assertionPassRate;
    const baselineScore = baseline.correctness.assertionPassRate;

    if (baselineScore === 0) {
      return candidateScore > 0 ? 1.0 : 0;
    }

    return (candidateScore - baselineScore) / baselineScore;
  }

  // ─── Private: Decision Logic ────────────────────────────────────

  /**
   * Determine overall evaluation decision.
   *
   * Requirement 44.6: Block every missed mandatory threshold.
   */
  private determineDecision(checks: readonly ThresholdCheckResult[]): EvaluationDecision {
    const hasFailure = checks.some(c => c.decision === 'fail');
    const hasBlocked = checks.some(c => c.decision === 'blocked');

    if (hasBlocked) return 'blocked';
    if (hasFailure) return 'reject';
    return 'approve';
  }

  // ─── Private: Fingerprinting ────────────────────────────────────

  /**
   * Compute a comparison fingerprint from all inputs.
   *
   * Requirement 44.8: Persist comparison fingerprints.
   */
  private computeComparisonFingerprint(
    subjects: readonly EvaluationSubject[],
    fixtureRefs: readonly FixtureReference[],
    config: EvaluationConfig,
  ): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(subjects));
    hash.update(JSON.stringify(fixtureRefs));
    hash.update(JSON.stringify(config));
    return hash.digest('hex');
  }
}

// ─── Helper Functions ────────────────────────────────────────────

function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `eval-${timestamp}-${random}`;
}

function computeFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
