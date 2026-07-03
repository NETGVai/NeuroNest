/**
 * Stuck Detector — deterministic event-stream monitor for pathological agent patterns.
 *
 * Subscribes to the pipeline event stream and detects four stuck patterns:
 *   (a) Same action hash repeated 3 consecutive times
 *   (b) Action-then-same-error pairs repeated 3 times
 *   (c) A/B action alternation repeated 4 times
 *   (d) Zero file-system effect across 5 consecutive actions
 *
 * On first detection: injects a synthetic observation instructing the agent to
 * state the blocker and change strategy.
 * On second detection (same task): halts the worker, marks the task as 'stuck',
 * and surfaces the transcript tail.
 *
 * All detection is deterministic (no LLM calls) and completes within 1ms per event.
 * Gated behind the `stuck_detector` feature flag.
 * Falls back to uninterrupted execution on any internal failure (Requirement 25.3).
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 25.3
 */

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { PipelineEvent } from './event-log.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

export type StuckPattern =
  | 'repeated_action'      // same hash 3x
  | 'error_loop'           // action+error 3x
  | 'alternation'          // A/B 4x
  | 'no_effect'            // 5 actions, no FS change
;

export interface StuckEvent {
  pattern: StuckPattern;
  actionHashes: string[];
  interventionCount: number; // 0 = first (synthetic observation), 1 = halt
  taskId: string;
  timestamp: number;
}

/**
 * Intervention result returned by the detector indicating what action
 * the caller should take.
 */
export type InterventionAction =
  | { type: 'observe'; message: string }   // First detection: inject synthetic observation
  | { type: 'halt'; transcriptTail: PipelineEvent[] } // Second detection: halt worker
;

export interface StuckDetectionResult {
  event: StuckEvent;
  action: InterventionAction;
}

// ─── Internal state per task ────────────────────────────────────

interface TaskState {
  /** Rolling window of recent action hashes (max 10 retained) */
  actionHashes: string[];
  /** Rolling window of recent (action hash, error hash) pairs for error_loop */
  errorPairs: Array<{ actionHash: string; errorHash: string }>;
  /** Recent events for transcript tail surfacing */
  recentEvents: PipelineEvent[];
  /** Track which actions produced FS effects */
  fsEffectActions: boolean[];
  /** How many times stuck was detected on this task */
  interventionCount: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Max recent events retained per task for transcript tail */
const MAX_RECENT_EVENTS = 20;

/** Max action hashes window */
const MAX_ACTION_WINDOW = 10;

/** Synthetic observation message injected on first stuck detection */
const SYNTHETIC_OBSERVATION_TEMPLATE =
  'SYSTEM OBSERVATION: The agent appears stuck in a %PATTERN% pattern. ' +
  'You have repeated the same approach multiple times without progress. ' +
  'Please state the specific blocker preventing progress, then try a fundamentally different strategy. ' +
  'Do NOT retry the same action.';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Compute a fast hash for an event payload. Uses a truncated SHA-256
 * for deterministic comparison. The hash is based on the event kind
 * and a JSON-stable representation of the payload.
 */
export function computeActionHash(event: PipelineEvent): string {
  const data = `${event.kind}:${stableStringify(event.payload)}`;
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Deterministic JSON serialization (sorted keys) for hash stability.
 * Handles null/undefined gracefully.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value, Object.keys(value as object).sort());
  } catch {
    return String(value);
  }
}

/**
 * Determines if an event represents an action (tool execution, command, etc.)
 * as opposed to a passive event like chat messages.
 */
function isActionEvent(event: PipelineEvent): boolean {
  return (
    event.kind === 'tool.start' ||
    event.kind === 'tool.success' ||
    event.kind === 'tool.failure'
  );
}

/**
 * Determines if an event indicates an error/failure.
 */
function isErrorEvent(event: PipelineEvent): boolean {
  return event.kind === 'tool.failure' || event.kind === 'error.captured';
}

/**
 * Determines if an event indicates a file-system effect.
 * Looks at the payload for common FS tool indicators.
 */
function hasFileSystemEffect(event: PipelineEvent): boolean {
  if (event.kind !== 'tool.success') return false;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return false;

  // Check for common FS-related tool names
  const toolName = (payload.tool ?? payload.toolName ?? payload.name ?? '') as string;
  const fsTools = [
    'write_file', 'create_file', 'delete_file', 'rename_file',
    'move_file', 'copy_file', 'mkdir', 'rmdir', 'fs_write',
    'fs_append', 'str_replace', 'patch', 'apply_diff',
  ];
  if (fsTools.some(t => toolName.toLowerCase().includes(t))) return true;

  // Check for file path in result that indicates modification
  const result = payload.result as Record<string, unknown> | undefined;
  if (result && (result.filesModified || result.filesCreated || result.path)) {
    return true;
  }

  return false;
}

/**
 * Extract a task ID from an event payload. Falls back to session ID if
 * no task ID is available.
 */
function extractTaskId(event: PipelineEvent): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload && typeof payload.taskId === 'string') return payload.taskId;
  return event.sessionId;
}

// ─── StuckDetector Implementation ───────────────────────────────

export interface StuckDetectorInterface {
  onEvent(event: PipelineEvent): StuckDetectionResult | null;
  reset(taskId: string): void;
  getStuckCount(taskId: string): number;
}

export class StuckDetector implements StuckDetectorInterface {
  private readonly db: Database.Database | null;
  private readonly featureGate: FeatureGateSystem | null;
  private readonly taskStates: Map<string, TaskState> = new Map();

  // Prepared statement for logging stuck events (lazy-initialized)
  private stmtInsert: Database.Statement | null = null;

  constructor(
    db: Database.Database | null = null,
    featureGate: FeatureGateSystem | null = null,
  ) {
    this.db = db;
    this.featureGate = featureGate;

    if (db) {
      try {
        this.stmtInsert = db.prepare(
          `INSERT INTO stuck_events (task_id, session_id, pattern, action_hashes, intervention_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
      } catch {
        // Table may not exist yet; fail gracefully
        this.stmtInsert = null;
      }
    }
  }

  // ─── Feature gate guard ─────────────────────────────────────

  /** Returns true if the stuck detector is enabled */
  isEnabled(): boolean {
    if (!this.featureGate) return true; // No gate = always enabled (for testing)
    return this.featureGate.isEnabled('stuck_detector');
  }

  // ─── Main event handler ─────────────────────────────────────

  /**
   * Process a pipeline event and return a StuckDetectionResult if a stuck
   * pattern is detected. Returns null if no pattern matches or the feature
   * is disabled.
   *
   * Guaranteed to complete within 1ms per event. No LLM calls.
   */
  onEvent(event: PipelineEvent): StuckDetectionResult | null {
    // Feature gate check
    if (!this.isEnabled()) return null;

    try {
      return this.processEvent(event);
    } catch {
      // Requirement 25.3: fall back to uninterrupted execution on failure
      return null;
    }
  }

  /**
   * Reset state for a task (e.g., when task completes or is reassigned).
   */
  reset(taskId: string): void {
    this.taskStates.delete(taskId);
  }

  /**
   * Get the number of times stuck was detected for a task.
   */
  getStuckCount(taskId: string): number {
    const state = this.taskStates.get(taskId);
    return state?.interventionCount ?? 0;
  }

  // ─── Internal detection logic ───────────────────────────────

  private processEvent(event: PipelineEvent): StuckDetectionResult | null {
    // Only process action events
    if (!isActionEvent(event)) return null;

    const taskId = extractTaskId(event);
    const state = this.getOrCreateState(taskId);

    // Track recent events for transcript tail
    state.recentEvents.push(event);
    if (state.recentEvents.length > MAX_RECENT_EVENTS) {
      state.recentEvents.shift();
    }

    const actionHash = computeActionHash(event);

    // Track action hashes
    state.actionHashes.push(actionHash);
    if (state.actionHashes.length > MAX_ACTION_WINDOW) {
      state.actionHashes.shift();
    }

    // Track error pairs: when we see a failure, pair it with the preceding action
    if (isErrorEvent(event) && state.actionHashes.length >= 2) {
      const prevActionHash = state.actionHashes[state.actionHashes.length - 2];
      const errorHash = actionHash;
      state.errorPairs.push({ actionHash: prevActionHash, errorHash });
      if (state.errorPairs.length > MAX_ACTION_WINDOW) {
        state.errorPairs.shift();
      }
    }

    // Track FS effects — only tool.success can produce an FS effect
    if (event.kind === 'tool.success') {
      const hasFsEffect = hasFileSystemEffect(event);
      state.fsEffectActions.push(hasFsEffect);
      if (state.fsEffectActions.length > MAX_ACTION_WINDOW) {
        state.fsEffectActions.shift();
      }
    }

    // Check patterns in order of specificity
    const pattern = this.detectPattern(state);
    if (!pattern) return null;

    // Pattern detected — determine intervention level
    const interventionCount = state.interventionCount;
    state.interventionCount++;

    // Clear the detection window after firing to prevent immediate re-triggering
    // on the very next event. The pattern must build up again from scratch.
    state.actionHashes = [];
    state.errorPairs = [];
    state.fsEffectActions = [];

    const stuckEvent: StuckEvent = {
      pattern,
      actionHashes: [...state.actionHashes],
      interventionCount,
      taskId,
      timestamp: Date.now(),
    };

    // Log to database
    this.logStuckEvent(stuckEvent, event.sessionId);

    // Determine action based on intervention count
    const action: InterventionAction = interventionCount === 0
      ? {
          type: 'observe',
          message: SYNTHETIC_OBSERVATION_TEMPLATE.replace('%PATTERN%', this.patternDescription(pattern)),
        }
      : {
          type: 'halt',
          transcriptTail: [...state.recentEvents],
        };

    return { event: stuckEvent, action };
  }

  /**
   * Detect which stuck pattern (if any) matches the current task state.
   * Returns the first matching pattern, or null if none match.
   */
  private detectPattern(state: TaskState): StuckPattern | null {
    // (a) Same action hash 3x consecutive
    if (this.detectRepeatedAction(state)) return 'repeated_action';

    // (b) Action+error pairs 3x
    if (this.detectErrorLoop(state)) return 'error_loop';

    // (c) A/B alternation 4x
    if (this.detectAlternation(state)) return 'alternation';

    // (d) No FS effect across 5 actions
    if (this.detectNoEffect(state)) return 'no_effect';

    return null;
  }

  /**
   * Pattern (a): Same action hash repeated 3 consecutive times.
   */
  private detectRepeatedAction(state: TaskState): boolean {
    const hashes = state.actionHashes;
    if (hashes.length < 3) return false;

    const last = hashes[hashes.length - 1];
    const secondLast = hashes[hashes.length - 2];
    const thirdLast = hashes[hashes.length - 3];

    return last === secondLast && secondLast === thirdLast;
  }

  /**
   * Pattern (b): Action-then-same-error pairs repeated 3 times.
   * Detects when the same (action, error) combination occurs 3 times.
   */
  private detectErrorLoop(state: TaskState): boolean {
    const pairs = state.errorPairs;
    if (pairs.length < 3) return false;

    const last = pairs[pairs.length - 1];
    let count = 0;
    for (let i = pairs.length - 1; i >= 0 && i >= pairs.length - 3; i--) {
      if (
        pairs[i].actionHash === last.actionHash &&
        pairs[i].errorHash === last.errorHash
      ) {
        count++;
      }
    }

    return count >= 3;
  }

  /**
   * Pattern (c): A/B action alternation repeated 4 times (8 events: ABABABAB).
   */
  private detectAlternation(state: TaskState): boolean {
    const hashes = state.actionHashes;
    if (hashes.length < 8) return false;

    // Check the last 8 entries for ABABABAB pattern
    const tail = hashes.slice(-8);
    const a = tail[0];
    const b = tail[1];

    // Must be two different actions
    if (a === b) return false;

    for (let i = 0; i < 8; i++) {
      const expected = i % 2 === 0 ? a : b;
      if (tail[i] !== expected) return false;
    }

    return true;
  }

  /**
   * Pattern (d): Zero file-system effect across 5 consecutive actions.
   * Only triggers if there are at least 5 action events with no FS changes.
   */
  private detectNoEffect(state: TaskState): boolean {
    const effects = state.fsEffectActions;
    if (effects.length < 5) return false;

    // Check last 5 actions for any FS effect
    const last5 = effects.slice(-5);
    return last5.every(e => e === false);
  }

  // ─── Helpers ────────────────────────────────────────────────

  private getOrCreateState(taskId: string): TaskState {
    let state = this.taskStates.get(taskId);
    if (!state) {
      state = {
        actionHashes: [],
        errorPairs: [],
        recentEvents: [],
        fsEffectActions: [],
        interventionCount: 0,
      };
      this.taskStates.set(taskId, state);
    }
    return state;
  }

  private logStuckEvent(stuckEvent: StuckEvent, sessionId: string): void {
    if (!this.stmtInsert) return;
    try {
      this.stmtInsert.run(
        stuckEvent.taskId,
        sessionId,
        stuckEvent.pattern,
        JSON.stringify(stuckEvent.actionHashes),
        stuckEvent.interventionCount,
        stuckEvent.timestamp,
      );
    } catch {
      // Non-critical: continue without logging on DB failure
    }
  }

  private patternDescription(pattern: StuckPattern): string {
    switch (pattern) {
      case 'repeated_action': return 'repeated-action (same action 3 times)';
      case 'error_loop': return 'error-loop (same action+error 3 times)';
      case 'alternation': return 'alternation (A/B switching 4 times)';
      case 'no_effect': return 'no-effect (5 actions with no file changes)';
    }
  }
}
