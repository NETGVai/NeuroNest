// ─── Context Budget Enforcer ───────────────────────────────────
// Structurally enforces a configurable token budget on all content
// injected into each loop pass. Prevents context rot from degrading
// task completion rates.
// Requirements: 27.1, 27.2, 27.3, 27.4, 27.5

/**
 * Configuration for per-section token budgets.
 * Total budget is the hard ceiling for all injected context per pass.
 */
export interface ContextBudgetConfig {
  totalBudget: number;       // default 8192 tokens
  neuronestMdMax: number;    // default 4096 tokens
  goalMdMax: number;         // default 1024 tokens
  planMdMax: number;         // default 1024 tokens
  memoryMax: number;         // default 2048 tokens
}

/**
 * Result of assembling budgeted context for a loop pass.
 */
export interface BudgetedContext {
  neuronestMd: string;
  goalMd: string;
  planMd: string;
  memoryContent: string;
  totalTokens: number;
  truncated: boolean;
  truncationLog: string[];
}

/** Default budget configuration (REQ-27.1) */
export const DEFAULT_BUDGET_CONFIG: ContextBudgetConfig = {
  totalBudget: 8192,
  neuronestMdMax: 4096,
  goalMdMax: 1024,
  planMdMax: 1024,
  memoryMax: 2048,
};

/**
 * Estimate token count using chars/4 approximation.
 * This is a standard quick estimation method.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract the Never-touch section from NEURONEST.md content.
 * The Never-touch section has priority and must be preserved during truncation (REQ-27.5).
 */
function extractNeverTouchSection(content: string): { neverTouch: string; rest: string } {
  const lines = content.split('\n');
  let neverTouchStart = -1;
  let neverTouchEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
      neverTouchStart = i;
      continue;
    }
    // End of Never-touch section on next heading of same or higher level
    if (neverTouchStart !== -1 && i > neverTouchStart && /^#{1,3}\s+/.test(trimmed)) {
      neverTouchEnd = i;
      break;
    }
  }

  if (neverTouchStart === -1) {
    return { neverTouch: '', rest: content };
  }

  const neverTouch = lines.slice(neverTouchStart, neverTouchEnd).join('\n');
  const rest = [
    ...lines.slice(0, neverTouchStart),
    ...lines.slice(neverTouchEnd),
  ].join('\n');

  return { neverTouch, rest };
}

/**
 * Truncate NEURONEST.md content while preserving the Never-touch section (REQ-27.5).
 * Truncates from the end of the non-Never-touch content.
 */
function truncateNeuronestMd(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) {
    return content;
  }

  const { neverTouch, rest } = extractNeverTouchSection(content);
  const neverTouchTokens = estimateTokens(neverTouch);

  // If Never-touch alone exceeds budget, still preserve it entirely (it has priority)
  if (neverTouchTokens >= maxTokens) {
    return neverTouch;
  }

  // Truncate the rest to fit within remaining budget
  const remainingBudget = maxTokens - neverTouchTokens;
  const maxChars = remainingBudget * 4;
  const truncatedRest = rest.slice(0, maxChars);

  if (neverTouch) {
    return truncatedRest + '\n' + neverTouch;
  }
  return truncatedRest;
}

/**
 * Truncate PLAN.md history while preserving current step and next step (REQ-27.2).
 * Steps are identified by lines matching patterns like "- [ ]", "- [x]", "- [-]", numbered items, etc.
 */
function truncatePlanMdHistory(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) {
    return content;
  }

  const lines = content.split('\n');

  // Find step boundaries by identifying step-like lines
  const stepIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    // Match common step patterns: "- [ ]", "- [x]", "- [-]", "## Step", numbered "1.", "2.", etc.
    if (/^[-*]\s*\[[ x\-~]\]/.test(trimmed) || /^#{1,4}\s+(step|phase)/i.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      stepIndices.push(i);
    }
  }

  if (stepIndices.length <= 2) {
    // If 2 or fewer steps, just hard-truncate by character
    const maxChars = maxTokens * 4;
    return content.slice(0, maxChars);
  }

  // Find current step (in-progress) and next step
  let currentStepIdx = -1;
  for (let i = 0; i < stepIndices.length; i++) {
    const line = lines[stepIndices[i]!]!.trim();
    if (/\[[-~]\]/.test(line) || /\bin[- ]?progress\b/i.test(line)) {
      currentStepIdx = i;
      break;
    }
  }

  // If no in-progress step found, use the first incomplete step
  if (currentStepIdx === -1) {
    for (let i = 0; i < stepIndices.length; i++) {
      const line = lines[stepIndices[i]!]!.trim();
      if (/\[ \]/.test(line) || /\bpending\b/i.test(line)) {
        currentStepIdx = i;
        break;
      }
    }
  }

  // If still no current step, keep the last two steps
  if (currentStepIdx === -1) {
    currentStepIdx = Math.max(0, stepIndices.length - 2);
  }

  const nextStepIdx = Math.min(currentStepIdx + 1, stepIndices.length - 1);

  // Keep: header (lines before first step), current step block, next step block, and STATUS line
  const headerEnd = stepIndices[0];
  const header = lines.slice(0, headerEnd).join('\n');

  // Extract current step block (from current step line to the line before the next step)
  const currentStart = stepIndices[currentStepIdx];
  const currentEnd = currentStepIdx + 1 < stepIndices.length
    ? stepIndices[currentStepIdx + 1]
    : lines.length;
  const currentBlock = lines.slice(currentStart, currentEnd).join('\n');

  // Extract next step block if different from current
  let nextBlock = '';
  if (nextStepIdx !== currentStepIdx) {
    const nextStart = stepIndices[nextStepIdx];
    const nextEnd = nextStepIdx + 1 < stepIndices.length
      ? stepIndices[nextStepIdx + 1]
      : lines.length;
    nextBlock = lines.slice(nextStart, nextEnd).join('\n');
  }

  // Look for STATUS sentinel line
  const statusLine = lines.find(l => /^STATUS:/i.test(l.trim()));

  const parts = [header, currentBlock, nextBlock, statusLine || ''].filter(Boolean);
  let result = parts.join('\n');

  // Final check: if still over budget, hard-truncate
  if (estimateTokens(result) > maxTokens) {
    const maxChars = maxTokens * 4;
    result = result.slice(0, maxChars);
  }

  return result;
}

/**
 * ContextBudgetEnforcer enforces configurable token budgets on all
 * content injected into each loop pass (REQ-27.1).
 *
 * Truncation order (REQ-27.2):
 *   1. Memory content (first to truncate)
 *   2. PLAN.md history (preserve current step + next step)
 *   3. Never-touch section in NEURONEST.md has priority (never truncated)
 *
 * Logging policy (REQ-27.2):
 *   - Log budget violations ONLY when truncation fails to bring content
 *     within budget (not when truncation succeeds normally).
 *   - If truncation fails, ALWAYS log and continue the pass.
 */
export class ContextBudgetEnforcer {
  private readonly config: ContextBudgetConfig;

  constructor(config?: Partial<ContextBudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * Assemble pass context within budget (REQ-27.1, 27.2, 27.5).
   *
   * Truncation order: memory first, then PLAN.md history (preserving current+next).
   * Never-touch section in NEURONEST.md has priority (preserved on truncation).
   *
   * REQ-27.2 logging policy: Log budget violations ONLY when truncation fails
   * to bring content within budget (not when truncation succeeds normally).
   * If truncation fails, ALWAYS log the violation and continue the pass.
   */
  assembleBudgetedContext(
    neuronestMd: string,
    goalMd: string,
    planMd: string,
    memoryContent: string,
  ): BudgetedContext {
    const truncationLog: string[] = [];
    let truncated = false;

    // Step 1: Enforce per-section budgets (REQ-27.1)
    let budgetedNeuronest = this.enforceNeuronestBudget(neuronestMd);
    let budgetedGoal = this.enforceSimpleBudget(goalMd, this.config.goalMdMax);
    let budgetedPlan = this.enforcePlanBudget(planMd);
    let budgetedMemory = this.enforceSimpleBudget(memoryContent, this.config.memoryMax);

    // Step 2: Check total budget
    let total = this.computeTotal(budgetedNeuronest, budgetedGoal, budgetedPlan, budgetedMemory);

    if (total > this.config.totalBudget) {
      truncated = true;

      // Truncation order 1: Memory first (REQ-27.2)
      const memoryTokensBefore = estimateTokens(budgetedMemory);
      const overBudget = total - this.config.totalBudget;
      const memoryTargetTokens = Math.max(0, memoryTokensBefore - overBudget);
      const memoryMaxChars = memoryTargetTokens * 4;
      budgetedMemory = budgetedMemory.slice(0, memoryMaxChars);

      total = this.computeTotal(budgetedNeuronest, budgetedGoal, budgetedPlan, budgetedMemory);
    }

    if (total > this.config.totalBudget) {
      // Truncation order 2: PLAN.md history (preserve current+next) (REQ-27.2)
      const planTokensBefore = estimateTokens(budgetedPlan);
      const overBudget = total - this.config.totalBudget;
      const planTargetTokens = Math.max(0, planTokensBefore - overBudget);
      budgetedPlan = truncatePlanMdHistory(budgetedPlan, planTargetTokens);

      total = this.computeTotal(budgetedNeuronest, budgetedGoal, budgetedPlan, budgetedMemory);
    }

    // REQ-27.2: Log ONLY when truncation fails to bring within budget
    if (total > this.config.totalBudget) {
      truncationLog.push(
        `[BUDGET VIOLATION] Total context (${total} tokens) exceeds budget (${this.config.totalBudget} tokens) after truncation. ` +
        `Breakdown: NEURONEST.md=${estimateTokens(budgetedNeuronest)}, GOAL.md=${estimateTokens(budgetedGoal)}, ` +
        `PLAN.md=${estimateTokens(budgetedPlan)}, memory=${estimateTokens(budgetedMemory)}. Continuing pass.`
      );
    }

    return {
      neuronestMd: budgetedNeuronest,
      goalMd: budgetedGoal,
      planMd: budgetedPlan,
      memoryContent: budgetedMemory,
      totalTokens: total,
      truncated,
      truncationLog,
    };
  }

  /**
   * Log token count at start of pass for observability (REQ-27.4).
   */
  getTokenBreakdown(context: BudgetedContext): string {
    return (
      `[CONTEXT BUDGET] Total: ${context.totalTokens}/${this.config.totalBudget} tokens | ` +
      `NEURONEST.md: ${estimateTokens(context.neuronestMd)}/${this.config.neuronestMdMax} | ` +
      `GOAL.md: ${estimateTokens(context.goalMd)}/${this.config.goalMdMax} | ` +
      `PLAN.md: ${estimateTokens(context.planMd)}/${this.config.planMdMax} | ` +
      `Memory: ${estimateTokens(context.memoryContent)}/${this.config.memoryMax}`
    );
  }

  /** Get the current configuration */
  getConfig(): Readonly<ContextBudgetConfig> {
    return { ...this.config };
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private enforceNeuronestBudget(content: string): string {
    return truncateNeuronestMd(content, this.config.neuronestMdMax);
  }

  private enforcePlanBudget(content: string): string {
    if (estimateTokens(content) <= this.config.planMdMax) {
      return content;
    }
    return truncatePlanMdHistory(content, this.config.planMdMax);
  }

  private enforceSimpleBudget(content: string, maxTokens: number): string {
    if (estimateTokens(content) <= maxTokens) {
      return content;
    }
    const maxChars = maxTokens * 4;
    return content.slice(0, maxChars);
  }

  private computeTotal(
    neuronestMd: string,
    goalMd: string,
    planMd: string,
    memoryContent: string,
  ): number {
    return (
      estimateTokens(neuronestMd) +
      estimateTokens(goalMd) +
      estimateTokens(planMd) +
      estimateTokens(memoryContent)
    );
  }
}
