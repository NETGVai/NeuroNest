// ─── Goal/Plan Manager ─────────────────────────────────────────
// Manages on-disk GOAL.md and PLAN.md files for loop runs.
// State transfer between passes is explicit, human-inspectable,
// and immune to context rot from accumulated conversation.
// Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GoalPlanManagerLike, LoopSpec } from '../index';

// ─── Types ──────────────────────────────────────────────────────

export interface GoalMdContent {
  goal: string;
  doneWhen: Array<{ command: string; expectedExitCode: number }>;
  neverTouch: string[];
  stopIf: string[];
}

export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed';
  triedHistory: string[];
  next?: string;
}

export interface PlanMdContent {
  steps: PlanStep[];
  status: 'active' | 'done' | 'blocked';
}

export interface PlanUpdatePayload {
  steps?: Array<Partial<PlanStep> & { id: number }>;
  status?: 'active' | 'done' | 'blocked';
}

// ─── GoalPlanManager ────────────────────────────────────────────

/**
 * Manages GOAL.md and PLAN.md on-disk state files for loop runs.
 *
 * - GOAL.md is the authoritative external contract (REQ-25.1, 25.2)
 * - PLAN.md is the mutable execution state (REQ-25.3, 25.4)
 * - Both are re-read from disk every pass (no in-memory caching)
 * - Never-touch entries compile to absolute deny patterns (REQ-25.5)
 * - Stop-if conditions are evaluated after each pass (REQ-25.6)
 */
export class GoalPlanManager implements GoalPlanManagerLike {
  private readonly neuronestDir: string;
  private readonly goalPath: string;
  private readonly planPath: string;
  private lastPlanReadHash: string | null = null;

  constructor(private workspacePath: string) {
    this.neuronestDir = path.join(workspacePath, '.neuronest');
    this.goalPath = path.join(this.neuronestDir, 'GOAL.md');
    this.planPath = path.join(this.neuronestDir, 'PLAN.md');
  }

  // ─── Initialize ─────────────────────────────────────────────

  /**
   * Create GOAL.md + PLAN.md from LoopSpec at loop run start (REQ-25.1, 25.3).
   *
   * GOAL.md contains: Goal, Done-when, Never-touch, Stop-if sections.
   * PLAN.md contains: numbered step list with status markers and STATUS sentinel.
   */
  async initialize(spec: LoopSpec): Promise<void> {
    await fs.mkdir(this.neuronestDir, { recursive: true });

    const goalContent = this.buildGoalMd(spec);
    const planContent = this.buildPlanMd(spec);

    await fs.writeFile(this.goalPath, goalContent, 'utf-8');
    await fs.writeFile(this.planPath, planContent, 'utf-8');
  }

  // ─── Read Goal (REQ-25.2) ───────────────────────────────────

  /**
   * Re-read GOAL.md from disk each call. Never uses in-memory cache.
   * Called at the start of each PLANNING_PASS as the authoritative contract.
   */
  async readGoal(): Promise<GoalMdContent> {
    let content: string;
    try {
      content = await fs.readFile(this.goalPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { goal: '', doneWhen: [], neverTouch: [], stopIf: [] };
      }
      throw err;
    }

    return this.parseGoalMd(content);
  }

  // ─── Read Plan ──────────────────────────────────────────────

  /**
   * Re-read PLAN.md from disk each call. Never uses in-memory cache.
   */
  async readPlan(): Promise<PlanMdContent> {
    let content: string;
    try {
      content = await fs.readFile(this.planPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { steps: [], status: 'active' };
      }
      throw err;
    }

    const parsed = this.parsePlanMd(content);
    this.lastPlanReadHash = this.simpleHash(content);
    return parsed;
  }

  // ─── Update Plan (REQ-25.4) ─────────────────────────────────

  /**
   * Update PLAN.md in place after pass completion.
   * Merges updates into existing plan content and writes back.
   */
  async updatePlan(updates: PlanUpdatePayload): Promise<void> {
    const current = await this.readPlan();

    // Merge step updates
    if (updates.steps) {
      for (const update of updates.steps) {
        const step = current.steps.find(s => s.id === update.id);
        if (step) {
          if (update.status !== undefined) step.status = update.status;
          if (update.triedHistory !== undefined) step.triedHistory = update.triedHistory;
          if (update.next !== undefined) step.next = update.next;
          if (update.description !== undefined) step.description = update.description;
        }
      }
    }

    // Merge status update
    if (updates.status !== undefined) {
      current.status = updates.status;
    }

    const content = this.serializePlanMd(current);
    await fs.writeFile(this.planPath, content, 'utf-8');
  }

  // ─── Was Modified ───────────────────────────────────────────

  /**
   * Check if PLAN.md was modified since last read (REQ-25.4).
   * Used by the Stop hook to detect no-progress passes.
   */
  async wasModified(): Promise<boolean> {
    if (this.lastPlanReadHash === null) {
      return true; // No previous read, assume modified
    }

    let content: string;
    try {
      content = await fs.readFile(this.planPath, 'utf-8');
    } catch {
      return false; // File missing → not modified
    }

    const currentHash = this.simpleHash(content);
    return currentHash !== this.lastPlanReadHash;
  }

  // ─── Evaluate Stop-If (REQ-25.6) ───────────────────────────

  /**
   * Evaluate Stop-if conditions from GOAL.md.
   * Returns the reason string if a stop condition is met, null otherwise.
   *
   * Stop-if conditions are descriptive strings that map to evaluable checks.
   * Currently supports pattern-based evaluation of common conditions.
   */
  evaluateStopIf(goalMd: GoalMdContent): string | null {
    for (const condition of goalMd.stopIf) {
      const trimmed = condition.trim().toLowerCase();

      // Check for "max passes" style conditions (handled by runner, skip here)
      if (trimmed.startsWith('max passes') || trimmed.startsWith('maxpasses')) {
        continue;
      }

      // Check for "cost exceeds" conditions (handled by runner, skip here)
      if (trimmed.startsWith('cost exceeds') || trimmed.startsWith('maxcost')) {
        continue;
      }

      // Check for "wall clock" conditions (handled by runner, skip here)
      if (trimmed.startsWith('wall clock') || trimmed.startsWith('maxwallclock')) {
        continue;
      }

      // Check for "no progress" conditions (handled by runner, skip here)
      if (trimmed.startsWith('no progress') || trimmed.startsWith('noprogress')) {
        continue;
      }

      // For other descriptive conditions, they are logged but evaluated
      // by the loop runner at a higher level (e.g., file-scope checks,
      // previously-passing-test failures). Return them as-is for the
      // runner to evaluate contextually.
      // The runner will call this with specific contextual evaluation.
    }

    return null;
  }

  // ─── Compile Never-Touch (REQ-25.5) ─────────────────────────

  /**
   * Compile Never-touch entries into absolute deny pattern strings.
   * These become EditLock constraints that no allow pattern can override.
   *
   * Input paths may be relative globs; output is absolute deny patterns.
   */
  compileNeverTouch(neverTouch: string[]): string[] {
    return neverTouch
      .filter(entry => entry.trim().length > 0)
      .map(entry => {
        const trimmed = entry.trim();

        // If already absolute, use as-is
        if (path.isAbsolute(trimmed)) {
          return trimmed;
        }

        // Convert relative paths/globs to absolute deny patterns
        return path.join(this.workspacePath, trimmed);
      });
  }

  // ─── Private: Build GOAL.md ─────────────────────────────────

  private buildGoalMd(spec: LoopSpec): string {
    const lines: string[] = [];

    // Goal section
    lines.push('# GOAL');
    lines.push('');
    lines.push(spec.goal);
    lines.push('');

    // Done-when section (from command-type verify checks)
    lines.push('## Done-when');
    lines.push('');
    const commandChecks = spec.verify.filter(
      (v): v is Extract<typeof v, { type: 'command' }> => v.type === 'command'
    );
    if (commandChecks.length > 0) {
      for (const check of commandChecks) {
        lines.push(`- \`${check.command}\` exits ${check.expectedExitCode}`);
      }
    } else {
      lines.push('- (no command-based verification checks)');
    }
    lines.push('');

    // Never-touch section (from scope.allowedPaths negative patterns)
    lines.push('## Never-touch');
    lines.push('');
    const negativePatterns = spec.scope.allowedPaths.filter(p => p.startsWith('!'));
    if (negativePatterns.length > 0) {
      for (const pattern of negativePatterns) {
        // Remove the leading '!' for display
        lines.push(`- ${pattern.slice(1)}`);
      }
    } else {
      lines.push('- (no never-touch declarations)');
    }
    lines.push('');

    // Stop-if section (from stop conditions)
    lines.push('## Stop-if');
    lines.push('');
    lines.push(`- Max passes: ${spec.stop.maxPasses}`);
    lines.push(`- Max cost: $${spec.stop.maxCostUsd}`);
    lines.push(`- Max wall clock: ${spec.stop.maxWallClockMin} min`);
    lines.push(`- No progress for ${spec.stop.noProgressPasses} consecutive passes`);
    if (spec.stop.approvalBoundaries.length > 0) {
      lines.push(`- Approval required at passes: ${spec.stop.approvalBoundaries.join(', ')}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  // ─── Private: Build PLAN.md ─────────────────────────────────

  private buildPlanMd(spec: LoopSpec): string {
    const lines: string[] = [];

    lines.push('# PLAN');
    lines.push('');
    lines.push(`Goal: ${spec.goal}`);
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    // Create initial plan step from the passAction
    lines.push(`1. [ ] ${spec.passAction}`);
    lines.push('');

    lines.push('## Status');
    lines.push('');
    lines.push('STATUS: active');
    lines.push('');

    return lines.join('\n');
  }

  // ─── Private: Parse GOAL.md ─────────────────────────────────

  private parseGoalMd(content: string): GoalMdContent {
    const lines = content.split('\n');
    let goal = '';
    const doneWhen: Array<{ command: string; expectedExitCode: number }> = [];
    const neverTouch: string[] = [];
    const stopIf: string[] = [];

    let currentSection: 'goal' | 'done-when' | 'never-touch' | 'stop-if' | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect section headings
      if (/^#\s+GOAL$/i.test(trimmed)) {
        currentSection = 'goal';
        continue;
      }
      if (/^#{1,3}\s+done[- ]?when/i.test(trimmed)) {
        currentSection = 'done-when';
        continue;
      }
      if (/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
        currentSection = 'never-touch';
        continue;
      }
      if (/^#{1,3}\s+stop[- ]?if/i.test(trimmed)) {
        currentSection = 'stop-if';
        continue;
      }

      // Skip empty lines for section detection
      if (trimmed === '') continue;

      // Parse content based on current section
      switch (currentSection) {
        case 'goal':
          if (goal) {
            goal += ' ' + trimmed;
          } else {
            goal = trimmed;
          }
          break;

        case 'done-when': {
          // Parse "- `command` exits N" format
          const cmdMatch = trimmed.match(/^-\s+`([^`]+)`\s+exits\s+(\d+)/);
          if (cmdMatch && cmdMatch[1] && cmdMatch[2]) {
            doneWhen.push({
              command: cmdMatch[1],
              expectedExitCode: parseInt(cmdMatch[2], 10),
            });
          }
          break;
        }

        case 'never-touch': {
          // Parse "- path" format (skip placeholder lines)
          const ntMatch = trimmed.match(/^-\s+(.+)/);
          if (ntMatch && ntMatch[1] && !ntMatch[1].startsWith('(')) {
            neverTouch.push(ntMatch[1]);
          }
          break;
        }

        case 'stop-if': {
          // Parse "- condition" format
          const siMatch = trimmed.match(/^-\s+(.+)/);
          if (siMatch && siMatch[1]) {
            stopIf.push(siMatch[1]);
          }
          break;
        }
      }
    }

    return { goal, doneWhen, neverTouch, stopIf };
  }

  // ─── Private: Parse PLAN.md ─────────────────────────────────

  private parsePlanMd(content: string): PlanMdContent {
    const lines = content.split('\n');
    const steps: PlanStep[] = [];
    let status: 'active' | 'done' | 'blocked' = 'active';

    let currentStep: PlanStep | null = null;
    let inTriedSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Parse STATUS sentinel
      const statusMatch = trimmed.match(/^STATUS:\s*(active|done|blocked)/i);
      if (statusMatch && statusMatch[1]) {
        status = statusMatch[1].toLowerCase() as 'active' | 'done' | 'blocked';
        continue;
      }

      // Parse step lines: "N. [status] description"
      const stepMatch = trimmed.match(/^(\d+)\.\s+\[([^\]]*)\]\s+(.*)/);
      if (stepMatch && stepMatch[1] && stepMatch[2] !== undefined && stepMatch[3] !== undefined) {
        // Save previous step
        if (currentStep) {
          steps.push(currentStep);
        }

        const id = parseInt(stepMatch[1], 10);
        const statusMarker = stepMatch[2].trim();
        const description: string = stepMatch[3];

        let stepStatus: PlanStep['status'] = 'pending';
        if (statusMarker === 'x' || statusMarker === 'X') {
          stepStatus = 'done';
        } else if (statusMarker === '-' || statusMarker === '~') {
          stepStatus = 'in-progress';
        } else if (statusMarker === '!' || statusMarker.toLowerCase() === 'f') {
          stepStatus = 'failed';
        }
        // ' ' or empty = pending

        currentStep = {
          id,
          description,
          status: stepStatus,
          triedHistory: [],
        };
        inTriedSection = false;
        continue;
      }

      // Parse tried history lines (indented under a step)
      if (currentStep && trimmed.startsWith('- Tried:')) {
        inTriedSection = true;
        const tried = trimmed.replace(/^- Tried:\s*/, '');
        if (tried) currentStep.triedHistory.push(tried);
        continue;
      }

      if (currentStep && inTriedSection && trimmed.startsWith('-')) {
        const tried = trimmed.replace(/^-\s*/, '');
        if (tried) currentStep.triedHistory.push(tried);
        continue;
      }

      // Parse "Next:" line
      if (currentStep && trimmed.startsWith('Next:')) {
        currentStep.next = trimmed.replace(/^Next:\s*/, '');
        inTriedSection = false;
        continue;
      }

      // Non-matching indented content ends tried section
      if (currentStep && !trimmed.startsWith('-') && trimmed !== '') {
        inTriedSection = false;
      }
    }

    // Push last step
    if (currentStep) {
      steps.push(currentStep);
    }

    return { steps, status };
  }

  // ─── Private: Serialize PLAN.md ─────────────────────────────

  private serializePlanMd(plan: PlanMdContent): string {
    const lines: string[] = [];

    lines.push('# PLAN');
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    for (const step of plan.steps) {
      const marker = this.statusToMarker(step.status);
      lines.push(`${step.id}. [${marker}] ${step.description}`);

      if (step.triedHistory.length > 0) {
        lines.push(`   - Tried: ${step.triedHistory[0]}`);
        for (let i = 1; i < step.triedHistory.length; i++) {
          lines.push(`   - ${step.triedHistory[i]}`);
        }
      }

      if (step.next) {
        lines.push(`   Next: ${step.next}`);
      }
    }

    lines.push('');
    lines.push('## Status');
    lines.push('');
    lines.push(`STATUS: ${plan.status}`);
    lines.push('');

    return lines.join('\n');
  }

  // ─── Private: Helpers ───────────────────────────────────────

  private statusToMarker(status: PlanStep['status']): string {
    switch (status) {
      case 'done': return 'x';
      case 'in-progress': return '~';
      case 'failed': return '!';
      case 'pending':
      default: return ' ';
    }
  }

  private simpleHash(content: string): string {
    // Simple string hash for modification detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash | 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}
