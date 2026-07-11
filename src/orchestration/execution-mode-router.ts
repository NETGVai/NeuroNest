/**
 * ExecutionModeRouter — Classifies incoming tasks and routes them to
 * the appropriate execution pipeline (fast path for single-file edits,
 * phased path for multi-file/multi-agent/UI-touching tasks).
 *
 * Deterministic: same task + context → same classification result.
 * Gated behind the `phased_execution` feature flag.
 *
 * Requirements: 11.1, 11.7, 25.10
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Execution mode for a task:
 * - 'fast': Single-pass execution (single-file edits, simple refactors)
 * - 'phased': Five-phase pipeline with quality gates (multi-file, multi-agent, UI-touching)
 */
export type ExecutionMode = 'fast' | 'phased';

/**
 * Signals used to determine whether a task requires phased execution.
 */
export interface ClassificationSignals {
  /** Task touches or intends to modify multiple files */
  multiFile: boolean;
  /** Task requires coordination between multiple specialist agents */
  multiAgent: boolean;
  /** Task involves UI/DOM changes that need behavioral verification */
  uiTouching: boolean;
}

/**
 * Result of classifying a task into an execution mode.
 */
export interface TaskClassificationResult {
  /** The determined execution mode */
  mode: ExecutionMode;
  /** Human-readable reason for the classification */
  reason: string;
  /** The signals that contributed to the classification decision */
  signals: ClassificationSignals;
}

/**
 * Description of a task to be classified.
 */
export interface TaskDescription {
  /** Human-readable description of the task */
  description: string;
  /** Files the task is expected to touch (if known) */
  targetFiles?: string[];
  /** Roles/agents required for the task (if known) */
  requiredRoles?: string[];
  /** Tags or labels associated with the task */
  tags?: string[];
}

/**
 * Context about the project that influences classification.
 */
export interface ProjectContext {
  /** Whether UI components are part of the project */
  hasUIComponents: boolean;
  /** File paths that are considered UI-related */
  uiFilePaths?: string[];
  /** Total number of source files in the project */
  sourceFileCount?: number;
}

// ─── Classification Logic ───────────────────────────────────────

/** Keywords indicating multi-file operations */
const MULTI_FILE_KEYWORDS: string[] = [
  'refactor across',
  'rename across',
  'move to',
  'split into',
  'extract module',
  'restructure',
  'reorganize',
  'multiple files',
  'cross-cutting',
  'migrate',
];

/** Keywords indicating multi-agent coordination */
const MULTI_AGENT_KEYWORDS: string[] = [
  'architect',
  'review',
  'design and implement',
  'plan and build',
  'multi-step',
  'coordinate',
  'specialist',
  'collaborate',
  'phased',
  'pipeline',
];

/** Keywords indicating UI-touching tasks */
const UI_KEYWORDS: string[] = [
  'ui',
  'component',
  'render',
  'dom',
  'css',
  'style',
  'layout',
  'button',
  'form',
  'page',
  'view',
  'modal',
  'dialog',
  'template',
  'html',
  'jsx',
  'tsx',
  'frontend',
  'visual',
  'responsive',
];

/** File extensions/patterns considered UI-related */
const UI_FILE_PATTERNS: string[] = [
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.styled.',
];

/**
 * Detect if a task description contains any keywords from a given list.
 * Uses case-insensitive matching.
 */
function containsKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Detect if target files include UI-related files.
 */
function hasUIFiles(targetFiles: string[], uiFilePaths?: string[]): boolean {
  // Check against known UI file patterns
  const matchesPattern = targetFiles.some((file) =>
    UI_FILE_PATTERNS.some((pattern) => file.toLowerCase().includes(pattern)),
  );

  if (matchesPattern) return true;

  // Check against project-specific UI file paths
  if (uiFilePaths && uiFilePaths.length > 0) {
    return targetFiles.some((file) =>
      uiFilePaths.some((uiPath) => file.startsWith(uiPath)),
    );
  }

  return false;
}

// ─── ExecutionModeRouter ────────────────────────────────────────

export class ExecutionModeRouter {
  /**
   * Classify a task as fast-path or phased-path.
   *
   * Classification is deterministic: the same task + projectContext pair
   * always produces the same result.
   *
   * When the `phased_execution` feature flag is disabled, always returns
   * fast-path regardless of signals (no-op behavior).
   *
   * Any signal being true → phased path.
   * All signals false → fast path.
   */
  classify(task: TaskDescription, projectContext: ProjectContext): TaskClassificationResult {
    // Feature flag gate: when disabled, always fast path
    if (!PERF_FLAGS.PHASED_EXECUTION) {
      return {
        mode: 'fast',
        reason: 'phased_execution feature flag is disabled',
        signals: {
          multiFile: false,
          multiAgent: false,
          uiTouching: false,
        },
      };
    }

    const signals = this.computeSignals(task, projectContext);
    const mode = this.determineMode(signals);
    const reason = this.buildReason(signals, mode);

    return { mode, reason, signals };
  }

  /**
   * Compute classification signals from task description and project context.
   * Pure function — deterministic for given inputs.
   */
  private computeSignals(task: TaskDescription, projectContext: ProjectContext): ClassificationSignals {
    const multiFile = this.detectMultiFile(task);
    const multiAgent = this.detectMultiAgent(task);
    const uiTouching = this.detectUITouching(task, projectContext);

    return { multiFile, multiAgent, uiTouching };
  }

  /**
   * Determine execution mode from signals.
   * Any signal true → phased; all false → fast.
   */
  private determineMode(signals: ClassificationSignals): ExecutionMode {
    if (signals.multiFile || signals.multiAgent || signals.uiTouching) {
      return 'phased';
    }
    return 'fast';
  }

  /**
   * Build a human-readable reason string for the classification.
   */
  private buildReason(signals: ClassificationSignals, mode: ExecutionMode): string {
    if (mode === 'fast') {
      return 'Single-file edit with no multi-agent or UI signals detected';
    }

    const activeSignals: string[] = [];
    if (signals.multiFile) activeSignals.push('multi-file changes');
    if (signals.multiAgent) activeSignals.push('multi-agent coordination');
    if (signals.uiTouching) activeSignals.push('UI-touching changes');

    return `Phased execution required: ${activeSignals.join(', ')}`;
  }

  /**
   * Detect multi-file signal from task description and target files.
   */
  private detectMultiFile(task: TaskDescription): boolean {
    // Explicit: more than one target file specified
    if (task.targetFiles && task.targetFiles.length > 1) {
      return true;
    }

    // Keyword-based detection from description
    return containsKeywords(task.description, MULTI_FILE_KEYWORDS);
  }

  /**
   * Detect multi-agent signal from task description and required roles.
   */
  private detectMultiAgent(task: TaskDescription): boolean {
    // Explicit: more than one required role
    if (task.requiredRoles && task.requiredRoles.length > 1) {
      return true;
    }

    // Keyword-based detection from description
    return containsKeywords(task.description, MULTI_AGENT_KEYWORDS);
  }

  /**
   * Detect UI-touching signal from task description, target files, and project context.
   */
  private detectUITouching(task: TaskDescription, projectContext: ProjectContext): boolean {
    // Skip UI detection if the project has no UI components
    if (!projectContext.hasUIComponents) {
      return false;
    }

    // Check target files for UI patterns
    if (task.targetFiles && task.targetFiles.length > 0) {
      if (hasUIFiles(task.targetFiles, projectContext.uiFilePaths)) {
        return true;
      }
    }

    // Check tags for UI-related labels
    if (task.tags && task.tags.some((tag) => UI_KEYWORDS.includes(tag.toLowerCase()))) {
      return true;
    }

    // Keyword-based detection from description
    return containsKeywords(task.description, UI_KEYWORDS);
  }
}
