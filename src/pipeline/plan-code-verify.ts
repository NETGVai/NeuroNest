/**
 * Plan-Code-Verify Workflow — Structured execution loop.
 *
 * Plan: Decompose goal into steps
 * Code: Execute each step with agents
 * Verify: Run tests/checks, loop back if failed
 *
 * This is the core workflow that makes agents reliable.
 *
 * Integrates ProductionReadinessGate (Requirement 16.1, 16.2, 16.4):
 * Before any task is marked as completed, the gate verifies all production
 * readiness conditions are met. On failure, routes to self-healing loop.
 */

import type { ProductionReadinessGate, ProductionReadinessResult } from './production-readiness-gate';
import type { AgentEdit, ProjectContext } from './verification-gate/types';
import type { RepairAgent, VerificationRunner, SelfHealingResult } from './self-healing-loop';

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  verifyCommand?: string;
  output?: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
}

export interface ExecutionPlan {
  id: string;
  projectId: string;
  goal: string;
  steps: PlanStep[];
  status: 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';
  currentStep: number;
  createdAt: number;
  completedAt?: number;
}

/**
 * Context required for production readiness gate integration.
 * When provided to completeStepWithGate, the gate runs before task completion.
 */
export interface GateContext {
  /** The production readiness gate instance */
  gate: ProductionReadinessGate;
  /** The agent edit associated with the current step */
  edit: AgentEdit;
  /** Project context for verification */
  projectContext: ProjectContext;
  /** Session ID for querying security findings */
  sessionId: string;
  /** Repair agent for self-healing loop (required for auto-remediation) */
  repairAgent: RepairAgent;
  /** Verification runner for self-healing loop */
  verifier: VerificationRunner;
}

/**
 * Result of attempting task completion with production readiness gate.
 */
export interface GatedCompletionResult {
  /** The updated execution plan */
  plan: ExecutionPlan;
  /** Whether the gate passed (task marked as done) */
  gatePassed: boolean;
  /** The gate check result details */
  gateResult?: ProductionReadinessResult | undefined;
  /** Self-healing loop result if remediation was attempted */
  repairResult?: SelfHealingResult | undefined;
}

export class PlanCodeVerify {
  private plans: Map<string, ExecutionPlan> = new Map();

  /**
   * Create a new execution plan from a goal.
   */
  createPlan(projectId: string, goal: string, steps: Array<{ title: string; description: string; verifyCommand?: string }>): ExecutionPlan {
    const plan: ExecutionPlan = {
      id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, goal,
      steps: steps.map((s, i) => ({
        id: `step_${i}`,
        title: s.title,
        description: s.description,
        status: 'pending' as const,
        verifyCommand: s.verifyCommand,
        attempts: 0,
        maxAttempts: 3,
      })),
      status: 'planning',
      currentStep: 0,
      createdAt: Date.now(),
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * Start executing the plan.
   */
  startExecution(planId: string): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    plan.status = 'executing';
    plan.currentStep = 0;
    if (plan.steps.length > 0) plan.steps[0].status = 'in_progress';
    return plan;
  }

  /**
   * Mark current step as completed and advance.
   */
  completeStep(planId: string, output?: string): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps[plan.currentStep];
    if (step) {
      step.status = 'done';
      step.output = output;
    }

    // Advance to next step
    plan.currentStep++;
    if (plan.currentStep >= plan.steps.length) {
      plan.status = 'completed';
      plan.completedAt = Date.now();
    } else {
      plan.steps[plan.currentStep].status = 'in_progress';
    }

    return plan;
  }

  /**
   * Mark current step as completed with production readiness gate check.
   *
   * Before marking the task as done, runs ProductionReadinessGate.checkAndRemediate().
   * If the gate fails after self-healing remediation, the step is marked as failed
   * instead of done, with the failure summary as the error.
   *
   * This gate is non-bypassable — no configuration can skip it (Requirement 16.3).
   * Integrates with existing readiness/SRE services via the gate's dependency
   * scanner, coverage checker, and verification pipeline (Requirement 16.4).
   *
   * Requirements: 16.1, 16.2, 16.4
   */
  async completeStepWithGate(
    planId: string,
    gateContext: GateContext,
    output?: string,
  ): Promise<GatedCompletionResult | null> {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps[plan.currentStep];
    if (!step) return null;

    // Run production readiness gate with auto-remediation (Requirement 16.1, 16.2)
    const { gate, edit, projectContext, sessionId, repairAgent, verifier } = gateContext;

    const { gateResult, repairResult } = await gate.checkAndRemediate(
      step.id,
      edit,
      projectContext,
      sessionId,
      repairAgent,
      verifier,
    );

    if (gateResult.passed) {
      // Gate passed — mark step as done and advance
      step.status = 'done';
      if (output !== undefined) {
        step.output = output;
      }

      plan.currentStep++;
      if (plan.currentStep >= plan.steps.length) {
        plan.status = 'completed';
        plan.completedAt = Date.now();
      } else {
        const nextStep = plan.steps[plan.currentStep];
        if (nextStep) nextStep.status = 'in_progress';
      }

      return { plan, gatePassed: true, gateResult, repairResult };
    }

    // Gate failed even after remediation — block completion (Requirement 16.2, 16.5)
    step.attempts++;
    step.error = gateResult.failureSummary
      || 'Production readiness gate failed. Resolve all conditions before marking task complete.';

    if (step.attempts < step.maxAttempts) {
      // Allow retry — keep step in_progress
      step.status = 'in_progress';
    } else {
      // Max attempts reached — mark as failed
      step.status = 'failed';
      plan.status = 'failed';
    }

    return { plan, gatePassed: false, gateResult, repairResult };
  }

  /**
   * Mark current step as failed and optionally retry.
   */
  failStep(planId: string, error: string): { plan: ExecutionPlan; shouldRetry: boolean } | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps[plan.currentStep];
    if (!step) return null;

    step.attempts++;
    step.error = error;

    if (step.attempts < step.maxAttempts) {
      // Retry
      step.status = 'in_progress';
      return { plan, shouldRetry: true };
    }

    // Max attempts reached
    step.status = 'failed';
    plan.status = 'failed';
    return { plan, shouldRetry: false };
  }

  /**
   * Skip the current step.
   */
  skipStep(planId: string): ExecutionPlan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps[plan.currentStep];
    if (step) step.status = 'skipped';

    plan.currentStep++;
    if (plan.currentStep >= plan.steps.length) {
      plan.status = 'completed';
      plan.completedAt = Date.now();
    } else {
      plan.steps[plan.currentStep].status = 'in_progress';
    }

    return plan;
  }

  /**
   * Get a plan by ID.
   */
  getPlan(planId: string): ExecutionPlan | null {
    return this.plans.get(planId) || null;
  }

  /**
   * Get all plans for a project.
   */
  getPlans(projectId: string): ExecutionPlan[] {
    return Array.from(this.plans.values()).filter(p => p.projectId === projectId);
  }

  /**
   * Get the current step's prompt for the agent.
   */
  getCurrentStepPrompt(planId: string): string | null {
    const plan = this.plans.get(planId);
    if (!plan || plan.currentStep >= plan.steps.length) return null;

    const step = plan.steps[plan.currentStep];
    let prompt = `## Task ${plan.currentStep + 1}/${plan.steps.length}: ${step.title}\n\n${step.description}`;

    if (step.attempts > 0 && step.error) {
      prompt += `\n\n⚠️ Previous attempt failed (attempt ${step.attempts}/${step.maxAttempts}):\n${step.error}\n\nPlease fix the issue and try again.`;
    }

    if (step.verifyCommand) {
      prompt += `\n\nVerification: Run \`${step.verifyCommand}\` to verify this step.`;
    }

    return prompt;
  }

  /**
   * Get plan progress summary.
   */
  getProgress(planId: string): { total: number; done: number; failed: number; remaining: number; percent: number } | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const done = plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const failed = plan.steps.filter(s => s.status === 'failed').length;
    const total = plan.steps.length;

    return { total, done, failed, remaining: total - done - failed, percent: total > 0 ? Math.round(done / total * 100) : 0 };
  }
}
