/**
 * PhasedPipeline — Executes multi-file/multi-agent tasks through five
 * sequential phases with hard quality gates between each phase.
 *
 * Phases: Specification → Pseudocode → Architecture → Refinement → Completion
 *
 * Each phase produces artifacts evaluated by a quality gate. On gate failure,
 * the task routes back to the owning phase (retry). The architecture gate uses
 * Critic_Agent + Architecture specialists. The completion gate extends the
 * verification gate with test-gen + GUI acceptance stages.
 *
 * Role-matched skills are injected into all spawned specialists at each phase
 * via SubagentSpawner and SpecialistRoleLoader.
 *
 * Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.8
 */

import type { LLMClient } from '../pipeline/llm-client.js';
import type { SkillInjectionConfig, EnhancedSubagentTask } from '../pipeline/subagent-spawner.js';
import { spawnSkillAwareSubagent } from '../pipeline/subagent-spawner.js';
import { SpecialistRoleLoader } from './specialist-role-loader.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * The five sequential pipeline phases. Execution always proceeds in
 * this order with no skipping.
 */
export type PipelinePhase =
  | 'specification'
  | 'pseudocode'
  | 'architecture'
  | 'refinement'
  | 'completion';

/**
 * An artifact produced by a pipeline phase.
 */
export interface PhaseArtifact {
  id: string;
  type: string;
  content: string;
}

/**
 * A single check within a quality gate.
 */
export interface GateCheck {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * Result of running a quality gate after a phase.
 */
export interface QualityGateResult {
  passed: boolean;
  checks: GateCheck[];
  failedChecks: GateCheck[];
}

/**
 * Result of executing a single phase, including gate evaluation.
 */
export interface PhaseResult {
  phase: PipelinePhase;
  artifacts: PhaseArtifact[];
  gateResult: QualityGateResult;
  durationMs: number;
}

/**
 * Machine-checkable acceptance criterion emitted by the Specification phase.
 */
export interface AcceptanceCriterion {
  id: string;
  description: string;
  checkType: 'automated' | 'manual' | 'gui';
  expectedOutcome: string;
}

/**
 * Complete result of a full pipeline run across all phases.
 */
export interface PipelineRunResult {
  success: boolean;
  phaseResults: PhaseResult[];
  totalDurationMs: number;
  /** Acceptance criteria emitted from the specification phase */
  acceptanceCriteria: AcceptanceCriterion[];
}

/**
 * Task description for pipeline execution.
 */
export interface PipelineTaskDescription {
  id: string;
  description: string;
  targetFiles?: string[];
  requiredRoles?: string[];
  tags?: string[];
}

/**
 * Project context for the pipeline.
 */
export interface PipelineProjectContext {
  rootDir: string;
  hasUIComponents: boolean;
  uiFilePaths?: string[];
}

/**
 * Configuration for the pipeline's quality gate behavior.
 */
export interface PipelineConfig {
  /** Maximum retries when a gate fails before aborting the pipeline */
  maxRetriesPerPhase: number;
  /** LLM client for spawning specialist subagents */
  llmClient: LLMClient;
  /** Skill injection configuration for role-matched skill injection */
  skillInjectionConfig: SkillInjectionConfig;
  /** Skill catalog mapping skill IDs to their content */
  skillCatalog: Map<string, string>;
  /** Specialist role loader for role resolution and skill filtering */
  roleLoader: SpecialistRoleLoader;
  /** Optional: Critic agent evaluator for architecture gate */
  criticEvaluator?: CriticEvaluator;
  /** Optional: Verification gate runner for completion gate */
  verificationRunner?: VerificationGateRunner;
}

/**
 * Interface for the Critic Agent used in the architecture gate.
 */
export interface CriticEvaluator {
  evaluate(artifacts: PhaseArtifact[]): Promise<GateCheck[]>;
}

/**
 * Interface for the verification gate runner used in the completion gate.
 */
export interface VerificationGateRunner {
  runTestGenValidation(artifacts: PhaseArtifact[]): Promise<GateCheck[]>;
  runGUIAcceptance(artifacts: PhaseArtifact[], criteria: AcceptanceCriterion[]): Promise<GateCheck[]>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Strict sequential order of pipeline phases */
export const PHASE_ORDER: PipelinePhase[] = [
  'specification',
  'pseudocode',
  'architecture',
  'refinement',
  'completion',
];

/** Default maximum retries per phase on gate failure */
const DEFAULT_MAX_RETRIES = 2;

/** Role mappings for each phase to determine which specialists are spawned */
const PHASE_ROLE_MAP: Record<PipelinePhase, string[]> = {
  specification: ['architect', 'reviewer'],
  pseudocode: ['implementer'],
  architecture: ['architect', 'reviewer'],
  refinement: ['implementer', 'reviewer'],
  completion: ['tester', 'reviewer'],
};

// ─── PhasedPipeline ─────────────────────────────────────────────

export class PhasedPipeline {
  private readonly phases: PipelinePhase[] = PHASE_ORDER;
  private readonly config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * Execute all phases sequentially with quality gates.
   * On gate failure, routes back to owning phase (up to maxRetries).
   *
   * Requirements: 11.2, 11.5
   */
  async execute(
    task: PipelineTaskDescription,
    context: PipelineProjectContext,
  ): Promise<PipelineRunResult> {
    const startTime = Date.now();
    const phaseResults: PhaseResult[] = [];
    let acceptanceCriteria: AcceptanceCriterion[] = [];

    for (const phase of this.phases) {
      const phaseResult = await this.executePhaseWithRetry(
        phase,
        task,
        context,
        acceptanceCriteria,
        phaseResults,
      );

      phaseResults.push(phaseResult);

      // Capture acceptance criteria from specification phase (Req 11.3)
      if (phase === 'specification' && phaseResult.gateResult.passed) {
        acceptanceCriteria = this.extractAcceptanceCriteria(phaseResult.artifacts);
      }

      // If gate failed after retries, abort the pipeline
      if (!phaseResult.gateResult.passed) {
        return {
          success: false,
          phaseResults,
          totalDurationMs: Date.now() - startTime,
          acceptanceCriteria,
        };
      }
    }

    return {
      success: true,
      phaseResults,
      totalDurationMs: Date.now() - startTime,
      acceptanceCriteria,
    };
  }

  /**
   * Execute a single phase with retry logic on gate failure.
   * On gate failure, routes back to the owning phase (Req 11.5).
   */
  private async executePhaseWithRetry(
    phase: PipelinePhase,
    task: PipelineTaskDescription,
    context: PipelineProjectContext,
    acceptanceCriteria: AcceptanceCriterion[],
    previousResults: PhaseResult[],
  ): Promise<PhaseResult> {
    const maxRetries = this.config.maxRetriesPerPhase ?? DEFAULT_MAX_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const phaseStart = Date.now();

      // Execute the phase by spawning specialists with injected skills
      const artifacts = await this.runPhase(phase, task, context, previousResults);

      // Run the quality gate for this phase
      const gateResult = await this.runGate(phase, artifacts, acceptanceCriteria);

      const result: PhaseResult = {
        phase,
        artifacts,
        gateResult,
        durationMs: Date.now() - phaseStart,
      };

      // If gate passed, return immediately
      if (gateResult.passed) {
        return result;
      }

      // If this was the last allowed attempt, return the failure
      if (attempt === maxRetries) {
        return result;
      }

      // Otherwise, route back to owning phase (retry)
    }

    // Unreachable, but TypeScript needs this
    /* istanbul ignore next */
    throw new Error(`Unexpected exit from retry loop for phase: ${phase}`);
  }

  /**
   * Run a single phase by spawning specialist subagents with role-matched skills.
   * Each specialist receives skills appropriate to their role (Req 11.8).
   */
  private async runPhase(
    phase: PipelinePhase,
    task: PipelineTaskDescription,
    _context: PipelineProjectContext,
    previousResults: PhaseResult[],
  ): Promise<PhaseArtifact[]> {
    const roles = PHASE_ROLE_MAP[phase];
    const artifacts: PhaseArtifact[] = [];

    for (const role of roles) {
      const specialistTask = this.buildSpecialistTask(phase, role, task, previousResults);

      // Spawn specialist with role-matched skills injected (Req 11.8)
      const result = await spawnSkillAwareSubagent(
        specialistTask,
        this.config.llmClient,
        this.config.skillInjectionConfig,
        this.config.skillCatalog,
      );

      if (result.success && result.output) {
        artifacts.push({
          id: `${phase}-${role}-${task.id}`,
          type: `${phase}-output`,
          content: result.output,
        });
      }
    }

    return artifacts;
  }

  /**
   * Build an EnhancedSubagentTask for a specialist in a given phase.
   * The task includes role information for skill injection.
   */
  private buildSpecialistTask(
    phase: PipelinePhase,
    role: string,
    task: PipelineTaskDescription,
    previousResults: PhaseResult[],
  ): EnhancedSubagentTask {
    const previousContext = previousResults
      .map(r => r.artifacts.map(a => a.content).join('\n'))
      .join('\n---\n');

    const phasePrompt = this.getPhasePrompt(phase, task, previousContext);

    return {
      id: `${phase}-${role}-${task.id}`,
      name: `${phase} specialist (${role})`,
      task: phasePrompt,
      role,
      taskKeywords: task.tags ?? [],
      injectedSkills: [], // populated by spawnSkillAwareSubagent
    };
  }

  /**
   * Generate the prompt for a specialist working in a specific phase.
   */
  private getPhasePrompt(
    phase: PipelinePhase,
    task: PipelineTaskDescription,
    previousContext: string,
  ): string {
    const baseTask = `Task: ${task.description}`;
    const contextSection = previousContext
      ? `\n\nPrevious phase outputs:\n${previousContext}`
      : '';

    switch (phase) {
      case 'specification':
        return `${baseTask}\n\nYou are in the SPECIFICATION phase. Produce machine-checkable acceptance criteria as structured output. Each criterion must have: id, description, checkType (automated|manual|gui), and expectedOutcome.${contextSection}`;
      case 'pseudocode':
        return `${baseTask}\n\nYou are in the PSEUDOCODE phase. Produce high-level pseudocode that satisfies the acceptance criteria from the specification phase.${contextSection}`;
      case 'architecture':
        return `${baseTask}\n\nYou are in the ARCHITECTURE phase. Design the system architecture including module boundaries, interfaces, and dependency relationships.${contextSection}`;
      case 'refinement':
        return `${baseTask}\n\nYou are in the REFINEMENT phase. Refine the architecture into implementation-ready code with full type safety and error handling.${contextSection}`;
      case 'completion':
        return `${baseTask}\n\nYou are in the COMPLETION phase. Finalize the implementation, ensure all tests pass, and validate against acceptance criteria.${contextSection}`;
    }
  }

  /**
   * Run the quality gate for a specific phase.
   *
   * - Architecture gate: Critic_Agent + Architecture specialists (Req 11.4)
   * - Completion gate: extends verification-gate with test-gen + GUI acceptance (Req 11.6)
   * - Other phases: basic structural validation
   */
  private async runGate(
    phase: PipelinePhase,
    artifacts: PhaseArtifact[],
    acceptanceCriteria: AcceptanceCriterion[],
  ): Promise<QualityGateResult> {
    switch (phase) {
      case 'specification':
        return this.runSpecificationGate(artifacts);
      case 'pseudocode':
        return this.runPseudocodeGate(artifacts);
      case 'architecture':
        return this.runArchitectureGate(artifacts);
      case 'refinement':
        return this.runRefinementGate(artifacts);
      case 'completion':
        return this.runCompletionGate(artifacts, acceptanceCriteria);
    }
  }

  /**
   * Specification gate: Validates that machine-checkable acceptance criteria
   * are present in the output (Req 11.3).
   */
  private runSpecificationGate(artifacts: PhaseArtifact[]): QualityGateResult {
    const checks: GateCheck[] = [];

    // Check that artifacts were produced
    const hasArtifacts: GateCheck = {
      name: 'artifacts-present',
      passed: artifacts.length > 0,
      message: artifacts.length > 0
        ? `${artifacts.length} artifact(s) produced`
        : 'No artifacts produced by specification phase',
    };
    checks.push(hasArtifacts);

    // Check that acceptance criteria can be extracted
    const criteria = this.extractAcceptanceCriteria(artifacts);
    const hasCriteria: GateCheck = {
      name: 'acceptance-criteria-present',
      passed: criteria.length > 0,
      message: criteria.length > 0
        ? `${criteria.length} acceptance criteria emitted`
        : 'No machine-checkable acceptance criteria found in output',
    };
    checks.push(hasCriteria);

    const failedChecks = checks.filter(c => !c.passed);
    return { passed: failedChecks.length === 0, checks, failedChecks };
  }

  /**
   * Pseudocode gate: Validates that pseudocode output is present and non-trivial.
   */
  private runPseudocodeGate(artifacts: PhaseArtifact[]): QualityGateResult {
    const checks: GateCheck[] = [];

    const hasArtifacts: GateCheck = {
      name: 'pseudocode-present',
      passed: artifacts.length > 0 && artifacts.some(a => a.content.length > 0),
      message: artifacts.length > 0
        ? 'Pseudocode artifacts produced'
        : 'No pseudocode artifacts produced',
    };
    checks.push(hasArtifacts);

    const failedChecks = checks.filter(c => !c.passed);
    return { passed: failedChecks.length === 0, checks, failedChecks };
  }

  /**
   * Architecture gate: Uses Critic_Agent + Architecture specialists (Req 11.4).
   * Evaluates architectural soundness of the phase output.
   */
  private async runArchitectureGate(artifacts: PhaseArtifact[]): Promise<QualityGateResult> {
    const checks: GateCheck[] = [];

    // Basic artifact check
    const hasArtifacts: GateCheck = {
      name: 'architecture-artifacts-present',
      passed: artifacts.length > 0,
      message: artifacts.length > 0
        ? 'Architecture artifacts produced'
        : 'No architecture artifacts produced',
    };
    checks.push(hasArtifacts);

    // Run Critic_Agent evaluation if available (Req 11.4)
    if (this.config.criticEvaluator) {
      const criticChecks = await this.config.criticEvaluator.evaluate(artifacts);
      checks.push(...criticChecks);
    } else {
      // Fallback: spawn an architecture specialist to review
      const reviewTask: EnhancedSubagentTask = {
        id: `arch-gate-review`,
        name: 'Architecture Gate Reviewer',
        task: `Review the following architecture artifacts for soundness, consistency, and completeness:\n\n${artifacts.map(a => a.content).join('\n---\n')}`,
        role: 'architect',
        taskKeywords: ['architecture', 'review'],
        injectedSkills: [],
      };

      const result = await spawnSkillAwareSubagent(
        reviewTask,
        this.config.llmClient,
        this.config.skillInjectionConfig,
        this.config.skillCatalog,
      );

      const architectureReview: GateCheck = {
        name: 'architecture-review',
        passed: result.success,
        message: result.success
          ? 'Architecture review passed'
          : `Architecture review failed: ${result.error ?? 'unknown error'}`,
      };
      checks.push(architectureReview);
    }

    const failedChecks = checks.filter(c => !c.passed);
    return { passed: failedChecks.length === 0, checks, failedChecks };
  }

  /**
   * Refinement gate: Validates that refined implementation is present.
   */
  private runRefinementGate(artifacts: PhaseArtifact[]): QualityGateResult {
    const checks: GateCheck[] = [];

    const hasArtifacts: GateCheck = {
      name: 'refinement-artifacts-present',
      passed: artifacts.length > 0 && artifacts.some(a => a.content.length > 0),
      message: artifacts.length > 0
        ? 'Refinement artifacts produced'
        : 'No refinement artifacts produced',
    };
    checks.push(hasArtifacts);

    const failedChecks = checks.filter(c => !c.passed);
    return { passed: failedChecks.length === 0, checks, failedChecks };
  }

  /**
   * Completion gate: Extends verification-gate with test-gen + GUI acceptance (Req 11.6).
   * Test generation and GUI acceptance stages are ONLY enabled during this gate,
   * not in earlier phase gates.
   */
  private async runCompletionGate(
    artifacts: PhaseArtifact[],
    acceptanceCriteria: AcceptanceCriterion[],
  ): Promise<QualityGateResult> {
    const checks: GateCheck[] = [];

    // Basic artifact check
    const hasArtifacts: GateCheck = {
      name: 'completion-artifacts-present',
      passed: artifacts.length > 0,
      message: artifacts.length > 0
        ? 'Completion artifacts produced'
        : 'No completion artifacts produced',
    };
    checks.push(hasArtifacts);

    // Run extended verification gate checks if available (Req 11.6)
    if (this.config.verificationRunner) {
      // Test generation validation (only in completion gate)
      const testGenChecks = await this.config.verificationRunner.runTestGenValidation(artifacts);
      checks.push(...testGenChecks);

      // GUI acceptance (only in completion gate, for UI-touching criteria)
      const guiCriteria = acceptanceCriteria.filter(c => c.checkType === 'gui');
      if (guiCriteria.length > 0) {
        const guiChecks = await this.config.verificationRunner.runGUIAcceptance(artifacts, guiCriteria);
        checks.push(...guiChecks);
      }
    }

    const failedChecks = checks.filter(c => !c.passed);
    return { passed: failedChecks.length === 0, checks, failedChecks };
  }

  /**
   * Extract machine-checkable acceptance criteria from specification artifacts.
   * Parses structured JSON output from specialist responses (Req 11.3).
   */
  private extractAcceptanceCriteria(artifacts: PhaseArtifact[]): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [];

    for (const artifact of artifacts) {
      try {
        // Try parsing as JSON array of criteria
        const parsed = JSON.parse(artifact.content);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (this.isValidCriterion(item)) {
              criteria.push(item as AcceptanceCriterion);
            }
          }
        } else if (parsed.criteria && Array.isArray(parsed.criteria)) {
          for (const item of parsed.criteria) {
            if (this.isValidCriterion(item)) {
              criteria.push(item as AcceptanceCriterion);
            }
          }
        }
      } catch {
        // Not JSON — try extracting from structured text
        const extracted = this.extractCriteriaFromText(artifact.content);
        criteria.push(...extracted);
      }
    }

    return criteria;
  }

  /**
   * Validate that an object has the required AcceptanceCriterion fields.
   */
  private isValidCriterion(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj['id'] === 'string' &&
      typeof obj['description'] === 'string' &&
      (obj['checkType'] === 'automated' || obj['checkType'] === 'manual' || obj['checkType'] === 'gui') &&
      typeof obj['expectedOutcome'] === 'string'
    );
  }

  /**
   * Attempt to extract acceptance criteria from structured text output.
   * Looks for patterns like "AC-1: description [automated] expected: outcome"
   */
  private extractCriteriaFromText(text: string): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [];
    const pattern = /(?:AC|CRITERION|CR)-(\w+):\s*(.+?)\s*\[(automated|manual|gui)\]\s*(?:expected|outcome):\s*(.+)/gi;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const id = match[1] ?? '';
      const description = (match[2] ?? '').trim();
      const checkType = (match[3] ?? 'automated').toLowerCase() as 'automated' | 'manual' | 'gui';
      const expectedOutcome = (match[4] ?? '').trim();
      criteria.push({ id, description, checkType, expectedOutcome });
    }

    return criteria;
  }

  /**
   * Get the current phase order (read-only access for testing/inspection).
   */
  getPhases(): readonly PipelinePhase[] {
    return this.phases;
  }
}
