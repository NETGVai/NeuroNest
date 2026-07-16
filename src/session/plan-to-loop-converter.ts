/**
 * Plan-to-Loop Converter — converts an approved plan file into a Loop Engine goal spec.
 *
 * When the user exits Plan Mode with the `send-to-loop` action, this module:
 * 1. Reads the plan file (markdown)
 * 2. Extracts goal, verification criteria, constraints, and steps
 * 3. Converts them into a LoopSpec
 * 4. Writes the on-disk goal spec via GoalPlanManager
 *
 * Requirements: 11.7
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LoopSpec, VerifyCheck, StopConditions, ScopeConstraints } from '../loop-engine/index.js';
import { GoalPlanManager } from '../loop-engine/harness/goal-plan-manager.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Parsed content from a plan markdown file.
 */
export interface ParsedPlan {
  /** The extracted goal description */
  goal: string;
  /** Steps / tasks extracted from the plan */
  steps: string[];
  /** Verification criteria extracted from the plan */
  verificationChecks: ParsedVerifyCheck[];
  /** Protected paths that should not be modified */
  neverTouch: string[];
  /** Conditions under which the loop should abort */
  stopConditions: string[];
}

/**
 * A verification check parsed from the plan's verification section.
 */
export interface ParsedVerifyCheck {
  type: 'command' | 'file' | 'assertion';
  /** The raw text of the check (command string, file path, or assertion text) */
  value: string;
  /** Expected exit code for command checks (defaults to 0) */
  expectedExitCode?: number;
}

/**
 * Options for the plan-to-loop conversion process.
 */
export interface PlanToLoopOptions {
  /** Workspace root path (used to initialize GoalPlanManager) */
  workspacePath: string;
  /** Optional spec name (defaults to derived from goal) */
  specName?: string;
  /** Optional override for stop conditions */
  stopOverrides?: Partial<StopConditions>;
  /** Optional override for scope constraints */
  scopeOverrides?: Partial<ScopeConstraints>;
}

/**
 * Result of a successful plan-to-loop conversion.
 */
export interface ConversionResult {
  /** The generated LoopSpec */
  spec: LoopSpec;
  /** Path to the GOAL.md file written on disk */
  goalMdPath: string;
  /** Path to the PLAN.md file written on disk */
  planMdPath: string;
}

// ─── Default Stop Conditions ────────────────────────────────────

const DEFAULT_STOP_CONDITIONS: StopConditions = {
  maxPasses: 15,
  maxCostUsd: 10.0,
  maxWallClockMin: 60,
  noProgressPasses: 3,
  approvalBoundaries: [5, 10],
};

const DEFAULT_SCOPE: ScopeConstraints = {
  allowedPaths: ['**/*'],
  allowedTools: ['Read', 'Write', 'Bash', 'Search', 'Grep'],
  securityPolicy: 'standard',
};

// ─── Plan Parser ────────────────────────────────────────────────

/**
 * Parse a plan markdown file into structured content.
 *
 * Expected plan format (flexible section heading detection):
 * ```markdown
 * # Goal / Objective / Plan
 * Description of what to accomplish
 *
 * ## Steps / Tasks / Plan
 * - Step 1
 * - Step 2
 *
 * ## Verification / Checks / Done-when
 * - `npm test` exits 0
 * - File dist/index.js exists
 * - All type errors resolved
 *
 * ## Constraints / Never-touch / Protected
 * - node_modules/**
 * - .env
 *
 * ## Stop-if / Abort conditions
 * - Max 10 passes
 * ```
 */
export function parsePlanFile(content: string): ParsedPlan {
  const lines = content.split('\n');
  let goal = '';
  const steps: string[] = [];
  const verificationChecks: ParsedVerifyCheck[] = [];
  const neverTouch: string[] = [];
  const stopConditions: string[] = [];

  type Section = 'goal' | 'steps' | 'verification' | 'never-touch' | 'stop-if' | null;
  let currentSection: Section = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headings
    if (isGoalHeading(trimmed)) {
      currentSection = 'goal';
      continue;
    }
    if (isStepsHeading(trimmed)) {
      currentSection = 'steps';
      continue;
    }
    if (isVerificationHeading(trimmed)) {
      currentSection = 'verification';
      continue;
    }
    if (isNeverTouchHeading(trimmed)) {
      currentSection = 'never-touch';
      continue;
    }
    if (isStopIfHeading(trimmed)) {
      currentSection = 'stop-if';
      continue;
    }

    // Skip empty lines (don't accumulate them into the goal)
    if (trimmed === '') continue;

    // Skip generic heading lines that don't match known sections
    if (/^#{1,6}\s+/.test(trimmed) && currentSection !== null) {
      // Unrecognized subheading within a section; treat as end of current section
      currentSection = null;
      continue;
    }

    // Parse content based on current section
    switch (currentSection) {
      case 'goal': {
        // Accumulate non-list content as the goal description
        // If it starts with a list marker, treat as steps instead
        if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
          // Looks like steps got included in goal section
          const stepText = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
          if (stepText) steps.push(stepText);
        } else {
          goal = goal ? goal + ' ' + trimmed : trimmed;
        }
        break;
      }

      case 'steps': {
        const stepText = extractListItem(trimmed);
        if (stepText) {
          steps.push(stepText);
        }
        break;
      }

      case 'verification': {
        const check = parseVerificationLine(trimmed);
        if (check) {
          verificationChecks.push(check);
        }
        break;
      }

      case 'never-touch': {
        const item = extractListItem(trimmed);
        if (item) {
          neverTouch.push(item);
        }
        break;
      }

      case 'stop-if': {
        const item = extractListItem(trimmed);
        if (item) {
          stopConditions.push(item);
        }
        break;
      }

      default: {
        // Before any recognized section, treat content as goal if we haven't found one yet
        if (!goal && !isHeading(trimmed)) {
          goal = trimmed;
          currentSection = 'goal';
        }
        break;
      }
    }
  }

  return { goal, steps, verificationChecks, neverTouch, stopConditions };
}

// ─── Conversion Logic ───────────────────────────────────────────

/**
 * Convert parsed plan content into a LoopSpec.
 */
export function convertParsedPlanToLoopSpec(
  parsed: ParsedPlan,
  options: PlanToLoopOptions,
): LoopSpec {
  const specId = randomUUID();
  const specName = options.specName || deriveSpecName(parsed.goal);

  // Build verify checks from the parsed verification criteria
  const verify: VerifyCheck[] = parsed.verificationChecks.map(check =>
    convertVerifyCheck(check),
  );

  // Build scope constraints with never-touch paths as negative patterns
  const scope: ScopeConstraints = {
    ...DEFAULT_SCOPE,
    ...options.scopeOverrides,
    allowedPaths: buildAllowedPaths(
      options.scopeOverrides?.allowedPaths || DEFAULT_SCOPE.allowedPaths,
      parsed.neverTouch,
    ),
  };

  // Build stop conditions
  const stop: StopConditions = {
    ...DEFAULT_STOP_CONDITIONS,
    ...options.stopOverrides,
  };

  // Build passAction from the steps
  const passAction = buildPassAction(parsed.steps, parsed.goal);

  return {
    id: specId,
    version: '1.0.0',
    name: specName,
    useWhen: 'plan-to-loop conversion',
    goal: parsed.goal,
    passAction,
    verify,
    feedback: 'Review verification failures and fix issues. Prioritize the first failing check.',
    stop,
    scope,
    source: 'plan-mode',
    notes: `Converted from Plan Mode. Steps: ${parsed.steps.length}`,
  };
}

/**
 * Full pipeline: read plan file, parse, convert to LoopSpec, write on-disk goal spec.
 *
 * This is the primary entry point called when the user selects "approve-send-to-loop"
 * from the Plan Mode exit actions.
 */
export async function convertPlanToLoopSpec(
  planFilePath: string,
  options: PlanToLoopOptions,
): Promise<ConversionResult> {
  // Read the plan file
  const content = await fs.readFile(planFilePath, 'utf-8');

  // Parse the plan markdown
  const parsed = parsePlanFile(content);

  if (!parsed.goal) {
    throw new Error(
      'Plan file does not contain a recognizable goal. Expected a "# Goal" heading or leading content.',
    );
  }

  // Convert to LoopSpec
  const spec = convertParsedPlanToLoopSpec(parsed, options);

  // Write on-disk goal spec via GoalPlanManager
  const goalPlanManager = new GoalPlanManager(options.workspacePath);
  await goalPlanManager.initialize(spec);

  // Return paths and spec
  const goalMdPath = path.join(options.workspacePath, '.neuronest', 'GOAL.md');
  const planMdPath = path.join(options.workspacePath, '.neuronest', 'PLAN.md');

  return { spec, goalMdPath, planMdPath };
}

// ─── Private Helpers ────────────────────────────────────────────

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function isGoalHeading(line: string): boolean {
  return /^#{1,3}\s+(goal|objective|plan\s*$)/i.test(line);
}

function isStepsHeading(line: string): boolean {
  return /^#{1,3}\s+(steps|tasks|implementation|plan\s+steps|action\s+items)/i.test(line);
}

function isVerificationHeading(line: string): boolean {
  return /^#{1,3}\s+(verification|verify|checks|done[- ]?when|acceptance[- ]?criteria|assertions)/i.test(line);
}

function isNeverTouchHeading(line: string): boolean {
  return /^#{1,3}\s+(never[- ]?touch|protected|constraints|do[- ]?not[- ]?modify|excluded)/i.test(line);
}

function isStopIfHeading(line: string): boolean {
  return /^#{1,3}\s+(stop[- ]?if|abort|limits|stop[- ]?conditions)/i.test(line);
}

/**
 * Extract a list item's text content, stripping the list marker.
 * Handles: - item, * item, + item, 1. item, - [x] item (checkbox)
 */
function extractListItem(line: string): string | null {
  // Checkbox list items: - [x] text or - [ ] text
  const checkboxMatch = line.match(/^[-*+]\s+\[[x ]\]\s+(.*)/i);
  if (checkboxMatch?.[1]) {
    return checkboxMatch[1].trim();
  }

  // Standard list items
  const listMatch = line.match(/^[-*+]\s+(.*)/);
  if (listMatch?.[1]) {
    return listMatch[1].trim();
  }

  // Numbered list items
  const numMatch = line.match(/^\d+\.\s+(.*)/);
  if (numMatch?.[1]) {
    return numMatch[1].trim();
  }

  return null;
}

/**
 * Parse a verification line into a structured check.
 *
 * Supported formats:
 * - `command` exits N        → command check
 * - `command`                → command check (exit 0)
 * - Run: command             → command check (exit 0)
 * - File path exists         → file check
 * - Anything else            → assertion text (converted to llmJudge)
 */
function parseVerificationLine(line: string): ParsedVerifyCheck | null {
  const text = extractListItem(line) || line;
  if (!text) return null;

  // Pattern: `command` exits N
  const cmdExitMatch = text.match(/^`([^`]+)`\s+exits\s+(\d+)/);
  if (cmdExitMatch?.[1]) {
    return {
      type: 'command',
      value: cmdExitMatch[1],
      expectedExitCode: parseInt(cmdExitMatch[2] || '0', 10),
    };
  }

  // Pattern: `command` (no exit code specified, defaults to 0)
  const cmdOnlyMatch = text.match(/^`([^`]+)`\s*$/);
  if (cmdOnlyMatch?.[1]) {
    return {
      type: 'command',
      value: cmdOnlyMatch[1],
      expectedExitCode: 0,
    };
  }

  // Pattern: Run: command or run `command`
  const runMatch = text.match(/^[Rr]un:?\s+`?([^`]+)`?\s*(?:exits?\s+(\d+))?/);
  if (runMatch?.[1]) {
    return {
      type: 'command',
      value: runMatch[1].trim(),
      expectedExitCode: runMatch[2] ? parseInt(runMatch[2], 10) : 0,
    };
  }

  // Pattern: File X exists / X should exist
  const fileExistsMatch = text.match(/^(?:File\s+)?(.+?)\s+(?:exists|should\s+exist|must\s+exist)/i);
  if (fileExistsMatch?.[1]) {
    return {
      type: 'file',
      value: fileExistsMatch[1].replace(/^`|`$/g, '').trim(),
    };
  }

  // Everything else is an assertion (will map to llmJudge)
  return {
    type: 'assertion',
    value: text,
  };
}

/**
 * Convert a ParsedVerifyCheck into the Loop Engine's VerifyCheck type.
 */
function convertVerifyCheck(check: ParsedVerifyCheck): VerifyCheck {
  switch (check.type) {
    case 'command':
      return {
        type: 'command',
        command: check.value,
        expectedExitCode: check.expectedExitCode ?? 0,
      };
    case 'file':
      return {
        type: 'file',
        filePath: check.value,
        assertion: 'exists',
      };
    case 'assertion':
      return {
        type: 'llmJudge',
        rubric: check.value,
        threshold: 0.8,
      };
  }
}

/**
 * Build allowedPaths with never-touch entries as negative patterns.
 */
function buildAllowedPaths(basePaths: string[], neverTouch: string[]): string[] {
  const paths = [...basePaths];
  for (const nt of neverTouch) {
    const trimmed = nt.trim();
    if (trimmed && !trimmed.startsWith('!')) {
      paths.push(`!${trimmed}`);
    } else if (trimmed) {
      paths.push(trimmed);
    }
  }
  return paths;
}

/**
 * Build the passAction string from steps, used as the action the Loop Engine
 * takes on each pass.
 */
function buildPassAction(steps: string[], goal: string): string {
  if (steps.length === 0) {
    return `Work toward: ${goal}`;
  }
  if (steps.length === 1) {
    return steps[0]!;
  }
  // Combine steps into a concise action description
  return `Execute plan steps: ${steps.slice(0, 5).join('; ')}${steps.length > 5 ? ` (and ${steps.length - 5} more)` : ''}`;
}

/**
 * Derive a spec name from the goal text.
 */
function deriveSpecName(goal: string): string {
  // Take first 50 chars, trim to last complete word
  const truncated = goal.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  const name = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  return name || 'Plan-to-Loop Spec';
}
