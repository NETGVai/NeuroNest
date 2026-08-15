/**
 * BoundedLoopService — Bounded loops, partial reruns, boundary QA, and drift detection.
 *
 * Provides:
 * 1. BoundedLoopController: Tracks round/time/token/cost/repeated-finding counters
 *    for producer-reviewer and supervisor loops with hard limits. Escalates when any limit is reached.
 * 2. PartialRerunEngine: Given stage fingerprints and invalidation markers, determines which
 *    stages to rerun (only invalidated + downstream dependents). Preserves valid upstream artifacts.
 * 3. BoundaryQARunner: Executes incremental QA checks at each producer-consumer handoff.
 * 4. DriftDetector: Before dispatch and rerun, detects drift in plan, artifact, dependency,
 *    agent, skill, and repository fingerprints. Reports drift diagnostics.
 *
 * Requirements: 45.5, 45.6, 45.7, 45.8
 */

// ─── Loop Bounds Configuration ──────────────────────────────────────────────

/**
 * Hard limits for a bounded loop (producer-reviewer or supervisor).
 */
export interface LoopBounds {
  /** Maximum number of loop rounds */
  readonly maxRounds: number;
  /** Maximum elapsed time in milliseconds */
  readonly maxTimeMs: number;
  /** Maximum total tokens consumed */
  readonly maxTokens: number;
  /** Maximum total cost (abstract units) */
  readonly maxCost: number;
  /** Maximum repeated findings before escalation */
  readonly maxRepeatedFindings: number;
}

/**
 * Default bounds applied when no explicit configuration is given.
 */
export const DEFAULT_LOOP_BOUNDS: LoopBounds = {
  maxRounds: 5,
  maxTimeMs: 300_000, // 5 minutes
  maxTokens: 100_000,
  maxCost: 50,
  maxRepeatedFindings: 3,
};

/**
 * A loop type distinguishes producer-reviewer from supervisor patterns.
 */
export type LoopType = 'producer-reviewer' | 'supervisor';

/**
 * Escalation reason when a bound is exceeded.
 */
export type EscalationReason =
  | 'max_rounds_exceeded'
  | 'max_time_exceeded'
  | 'max_tokens_exceeded'
  | 'max_cost_exceeded'
  | 'max_repeated_findings_exceeded';

/**
 * An escalation event when a bounded loop exceeds its configured limits.
 */
export interface LoopEscalation {
  readonly loopId: string;
  readonly loopType: LoopType;
  readonly reason: EscalationReason;
  readonly currentValue: number;
  readonly limit: number;
  readonly timestamp: string;
}

/**
 * Current counters for a bounded loop.
 */
export interface LoopCounters {
  readonly rounds: number;
  readonly elapsedMs: number;
  readonly tokens: number;
  readonly cost: number;
  readonly repeatedFindings: number;
}

/**
 * The state of a bounded loop.
 */
export type LoopStatus = 'active' | 'completed' | 'escalated';

/**
 * Internal mutable loop record.
 */
interface LoopRecord {
  id: string;
  type: LoopType;
  bounds: LoopBounds;
  rounds: number;
  startedAt: number;
  tokens: number;
  cost: number;
  repeatedFindings: number;
  findings: string[];
  status: LoopStatus;
  escalation: LoopEscalation | null;
}

// ─── BoundedLoopController ──────────────────────────────────────────────────

/**
 * BoundedLoopController — Tracks and enforces hard limits on iterative loops.
 */
export class BoundedLoopController {
  private readonly loops = new Map<string, LoopRecord>();

  /**
   * Create and start a new bounded loop.
   */
  startLoop(loopId: string, type: LoopType, bounds: LoopBounds = DEFAULT_LOOP_BOUNDS): void {
    if (this.loops.has(loopId)) {
      throw new Error(`Loop '${loopId}' already exists`);
    }
    this.loops.set(loopId, {
      id: loopId,
      type,
      bounds,
      rounds: 0,
      startedAt: Date.now(),
      tokens: 0,
      cost: 0,
      repeatedFindings: 0,
      findings: [],
      status: 'active',
      escalation: null,
    });
  }

  /**
   * Record that a round has been completed. Returns escalation if a bound was exceeded.
   */
  recordRound(loopId: string, tokensUsed: number, costIncurred: number, findings: string[]): LoopEscalation | null {
    const loop = this.getLoopOrThrow(loopId);
    if (loop.status !== 'active') {
      throw new Error(`Loop '${loopId}' is not active (status: ${loop.status})`);
    }

    loop.rounds += 1;
    loop.tokens += tokensUsed;
    loop.cost += costIncurred;

    // Count repeated findings
    for (const finding of findings) {
      if (loop.findings.includes(finding)) {
        loop.repeatedFindings += 1;
      }
      if (!loop.findings.includes(finding)) {
        loop.findings.push(finding);
      }
    }

    // Check bounds
    const escalation = this.checkBounds(loop);
    if (escalation) {
      loop.status = 'escalated';
      loop.escalation = escalation;
    }

    return escalation;
  }

  /**
   * Mark a loop as completed (successfully).
   */
  completeLoop(loopId: string): void {
    const loop = this.getLoopOrThrow(loopId);
    if (loop.status !== 'active') {
      throw new Error(`Loop '${loopId}' is not active (status: ${loop.status})`);
    }
    loop.status = 'completed';
  }

  /**
   * Get the current counters for a loop.
   */
  getCounters(loopId: string): LoopCounters {
    const loop = this.getLoopOrThrow(loopId);
    return {
      rounds: loop.rounds,
      elapsedMs: Date.now() - loop.startedAt,
      tokens: loop.tokens,
      cost: loop.cost,
      repeatedFindings: loop.repeatedFindings,
    };
  }

  /**
   * Get the current status of a loop.
   */
  getStatus(loopId: string): LoopStatus {
    return this.getLoopOrThrow(loopId).status;
  }

  /**
   * Get the escalation info for a loop, if any.
   */
  getEscalation(loopId: string): LoopEscalation | null {
    return this.getLoopOrThrow(loopId).escalation;
  }

  private getLoopOrThrow(loopId: string): LoopRecord {
    const loop = this.loops.get(loopId);
    if (!loop) {
      throw new Error(`Loop '${loopId}' not found`);
    }
    return loop;
  }

  private checkBounds(loop: LoopRecord): LoopEscalation | null {
    const now = new Date().toISOString();

    if (loop.rounds > loop.bounds.maxRounds) {
      return { loopId: loop.id, loopType: loop.type, reason: 'max_rounds_exceeded', currentValue: loop.rounds, limit: loop.bounds.maxRounds, timestamp: now };
    }

    const elapsed = Date.now() - loop.startedAt;
    if (elapsed > loop.bounds.maxTimeMs) {
      return { loopId: loop.id, loopType: loop.type, reason: 'max_time_exceeded', currentValue: elapsed, limit: loop.bounds.maxTimeMs, timestamp: now };
    }

    if (loop.tokens > loop.bounds.maxTokens) {
      return { loopId: loop.id, loopType: loop.type, reason: 'max_tokens_exceeded', currentValue: loop.tokens, limit: loop.bounds.maxTokens, timestamp: now };
    }

    if (loop.cost > loop.bounds.maxCost) {
      return { loopId: loop.id, loopType: loop.type, reason: 'max_cost_exceeded', currentValue: loop.cost, limit: loop.bounds.maxCost, timestamp: now };
    }

    if (loop.repeatedFindings > loop.bounds.maxRepeatedFindings) {
      return { loopId: loop.id, loopType: loop.type, reason: 'max_repeated_findings_exceeded', currentValue: loop.repeatedFindings, limit: loop.bounds.maxRepeatedFindings, timestamp: now };
    }

    return null;
  }
}

// ─── Stage Fingerprints and Partial Reruns ──────────────────────────────────

/**
 * A stage within an orchestration plan, tracked for invalidation.
 */
export interface StageDescriptor {
  readonly stageId: string;
  /** Fingerprint of the stage's inputs and configuration */
  readonly fingerprint: string;
  /** Stage IDs that this stage depends on (upstream) */
  readonly dependsOn: readonly string[];
  /** Whether this stage's artifact is still valid */
  readonly valid: boolean;
}

/**
 * Result of a partial rerun analysis.
 */
export interface RerunPlan {
  /** Stages that need to be rerun */
  readonly stagesToRerun: readonly string[];
  /** Stages whose artifacts are preserved (not rerun) */
  readonly preservedStages: readonly string[];
  /** The invalidation chain: why each stage needs a rerun */
  readonly invalidationChain: ReadonlyMap<string, string>;
}

/**
 * PartialRerunEngine — Determines which stages require rerun based on
 * fingerprint invalidation and dependency topology.
 */
export class PartialRerunEngine {
  /**
   * Given a set of stages with fingerprints and validity markers,
   * compute the minimal set to rerun (invalidated + downstream dependents).
   */
  computeRerunPlan(stages: readonly StageDescriptor[]): RerunPlan {
    const stageMap = new Map<string, StageDescriptor>();
    for (const stage of stages) {
      stageMap.set(stage.stageId, stage);
    }

    // Build forward dependency graph (downstream dependents)
    const downstreamMap = new Map<string, string[]>();
    for (const stage of stages) {
      for (const dep of stage.dependsOn) {
        const existing = downstreamMap.get(dep) ?? [];
        existing.push(stage.stageId);
        downstreamMap.set(dep, existing);
      }
    }

    // Find directly invalidated stages
    const invalidated = new Set<string>();
    const invalidationChain = new Map<string, string>();

    for (const stage of stages) {
      if (!stage.valid) {
        invalidated.add(stage.stageId);
        invalidationChain.set(stage.stageId, 'directly_invalidated');
      }
    }

    // Propagate invalidation downstream (BFS)
    const queue = [...invalidated];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = downstreamMap.get(current) ?? [];
      for (const dependent of dependents) {
        if (!invalidated.has(dependent)) {
          invalidated.add(dependent);
          invalidationChain.set(dependent, `downstream_of:${current}`);
          queue.push(dependent);
        }
      }
    }

    // Determine preserved stages
    const allStageIds = stages.map((s) => s.stageId);
    const preservedStages = allStageIds.filter((id) => !invalidated.has(id));

    // Topologically sort stages to rerun
    const stagesToRerun = this.topologicalSort(
      [...invalidated],
      stageMap,
    );

    return {
      stagesToRerun,
      preservedStages,
      invalidationChain,
    };
  }

  /**
   * Mark a specific stage as invalidated and compute the cascading effect.
   */
  invalidateStage(stages: readonly StageDescriptor[], stageId: string): readonly StageDescriptor[] {
    return stages.map((s) => {
      if (s.stageId === stageId) {
        return { ...s, valid: false };
      }
      return s;
    });
  }

  private topologicalSort(
    stageIds: string[],
    stageMap: Map<string, StageDescriptor>,
  ): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const stageSet = new Set(stageIds);

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const stage = stageMap.get(id);
      if (stage) {
        for (const dep of stage.dependsOn) {
          if (stageSet.has(dep)) {
            visit(dep);
          }
        }
      }
      result.push(id);
    };

    for (const id of stageIds) {
      visit(id);
    }

    return result;
  }
}

// ─── Boundary QA ────────────────────────────────────────────────────────────

/**
 * Type of QA check performed at a stage boundary.
 */
export type BoundaryCheckType =
  | 'schema_validation'
  | 'content_assertion'
  | 'quality_gate'
  | 'completeness_check'
  | 'format_check';

/**
 * Definition of a QA check at a producer-consumer boundary.
 */
export interface BoundaryCheck {
  readonly checkId: string;
  readonly type: BoundaryCheckType;
  readonly description: string;
  /** The validator function — returns true if the check passes */
  readonly validate: (artifact: unknown) => boolean;
}

/**
 * Result of a single boundary QA check.
 */
export interface BoundaryCheckResult {
  readonly checkId: string;
  readonly type: BoundaryCheckType;
  readonly passed: boolean;
  readonly description: string;
  readonly timestamp: string;
}

/**
 * Aggregated result of all boundary QA checks for a single handoff.
 */
export interface BoundaryQAResult {
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly artifactId: string;
  readonly results: readonly BoundaryCheckResult[];
  readonly allPassed: boolean;
  readonly timestamp: string;
}

/**
 * BoundaryQARunner — Executes incremental QA checks at each producer-consumer handoff.
 */
export class BoundaryQARunner {
  private readonly checkRegistry = new Map<string, BoundaryCheck[]>();

  /**
   * Register boundary checks for a specific stage handoff (keyed by artifactId).
   */
  registerChecks(artifactId: string, checks: BoundaryCheck[]): void {
    this.checkRegistry.set(artifactId, checks);
  }

  /**
   * Execute all registered boundary QA checks for a handoff.
   */
  executeChecks(
    fromStageId: string,
    toStageId: string,
    artifactId: string,
    artifact: unknown,
  ): BoundaryQAResult {
    const checks = this.checkRegistry.get(artifactId) ?? [];
    const now = new Date().toISOString();

    const results: BoundaryCheckResult[] = checks.map((check) => ({
      checkId: check.checkId,
      type: check.type,
      passed: check.validate(artifact),
      description: check.description,
      timestamp: now,
    }));

    return {
      fromStageId,
      toStageId,
      artifactId,
      results,
      allPassed: results.every((r) => r.passed),
      timestamp: now,
    };
  }

  /**
   * Get registered checks for an artifact.
   */
  getChecks(artifactId: string): readonly BoundaryCheck[] {
    return this.checkRegistry.get(artifactId) ?? [];
  }
}

// ─── Drift Detection ────────────────────────────────────────────────────────

/**
 * Category of drift detected.
 */
export type DriftCategory =
  | 'plan'
  | 'artifact'
  | 'dependency'
  | 'agent'
  | 'skill'
  | 'repository';

/**
 * Severity of detected drift.
 */
export type DriftSeverity = 'info' | 'warning' | 'blocking';

/**
 * A single drift diagnostic.
 */
export interface DriftDiagnostic {
  readonly category: DriftCategory;
  readonly severity: DriftSeverity;
  readonly description: string;
  readonly previousFingerprint: string;
  readonly currentFingerprint: string;
  readonly timestamp: string;
}

/**
 * A complete snapshot of fingerprints for drift comparison.
 */
export interface DriftSnapshot {
  readonly planFingerprint: string;
  readonly artifactFingerprints: ReadonlyMap<string, string>;
  readonly dependencyFingerprint: string;
  readonly agentFingerprint: string;
  readonly skillFingerprint: string;
  readonly repositoryFingerprint: string;
}

/**
 * Result of a drift detection check.
 */
export interface DriftReport {
  readonly diagnostics: readonly DriftDiagnostic[];
  readonly hasDrift: boolean;
  readonly hasBlockingDrift: boolean;
  readonly timestamp: string;
}

/**
 * DriftDetector — Detects drift in plan, artifact, dependency, agent, skill,
 * and repository fingerprints before dispatch and rerun.
 */
export class DriftDetector {
  private baseline: DriftSnapshot | null = null;

  /**
   * Set the baseline snapshot against which drift will be compared.
   */
  setBaseline(snapshot: DriftSnapshot): void {
    this.baseline = snapshot;
  }

  /**
   * Get the current baseline snapshot.
   */
  getBaseline(): DriftSnapshot | null {
    return this.baseline;
  }

  /**
   * Detect drift between the baseline and a current snapshot.
   * Returns a report with all diagnostics.
   */
  detectDrift(current: DriftSnapshot): DriftReport {
    if (!this.baseline) {
      throw new Error('No baseline snapshot set. Call setBaseline() first.');
    }

    const diagnostics: DriftDiagnostic[] = [];
    const now = new Date().toISOString();

    // Plan drift
    if (this.baseline.planFingerprint !== current.planFingerprint) {
      diagnostics.push({
        category: 'plan',
        severity: 'blocking',
        description: 'Execution plan fingerprint has changed since baseline',
        previousFingerprint: this.baseline.planFingerprint,
        currentFingerprint: current.planFingerprint,
        timestamp: now,
      });
    }

    // Artifact drift
    for (const [artifactId, currentFp] of current.artifactFingerprints) {
      const baselineFp = this.baseline.artifactFingerprints.get(artifactId);
      if (baselineFp && baselineFp !== currentFp) {
        diagnostics.push({
          category: 'artifact',
          severity: 'warning',
          description: `Artifact '${artifactId}' fingerprint has changed`,
          previousFingerprint: baselineFp,
          currentFingerprint: currentFp,
          timestamp: now,
        });
      }
    }

    // Dependency drift
    if (this.baseline.dependencyFingerprint !== current.dependencyFingerprint) {
      diagnostics.push({
        category: 'dependency',
        severity: 'blocking',
        description: 'Dependency fingerprint has changed since baseline',
        previousFingerprint: this.baseline.dependencyFingerprint,
        currentFingerprint: current.dependencyFingerprint,
        timestamp: now,
      });
    }

    // Agent drift
    if (this.baseline.agentFingerprint !== current.agentFingerprint) {
      diagnostics.push({
        category: 'agent',
        severity: 'warning',
        description: 'Agent configuration fingerprint has changed since baseline',
        previousFingerprint: this.baseline.agentFingerprint,
        currentFingerprint: current.agentFingerprint,
        timestamp: now,
      });
    }

    // Skill drift
    if (this.baseline.skillFingerprint !== current.skillFingerprint) {
      diagnostics.push({
        category: 'skill',
        severity: 'warning',
        description: 'Skill bundle fingerprint has changed since baseline',
        previousFingerprint: this.baseline.skillFingerprint,
        currentFingerprint: current.skillFingerprint,
        timestamp: now,
      });
    }

    // Repository drift
    if (this.baseline.repositoryFingerprint !== current.repositoryFingerprint) {
      diagnostics.push({
        category: 'repository',
        severity: 'blocking',
        description: 'Repository workspace revision has changed since baseline',
        previousFingerprint: this.baseline.repositoryFingerprint,
        currentFingerprint: current.repositoryFingerprint,
        timestamp: now,
      });
    }

    return {
      diagnostics,
      hasDrift: diagnostics.length > 0,
      hasBlockingDrift: diagnostics.some((d) => d.severity === 'blocking'),
      timestamp: now,
    };
  }

  /**
   * Check if dispatch or rerun should proceed given the drift report.
   * Returns true if safe to proceed (no blocking drift).
   */
  canProceed(report: DriftReport): boolean {
    return !report.hasBlockingDrift;
  }
}
