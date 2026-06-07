/**
 * Plan-Code-Verify Workflow — Structured execution loop.
 *
 * Plan: Decompose goal into steps
 * Code: Execute each step with agents
 * Verify: Run tests/checks, loop back if failed
 *
 * This is the core workflow that makes agents reliable.
 */

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
