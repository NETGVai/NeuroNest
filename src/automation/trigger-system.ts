/**
 * Trigger System — Event-driven pipeline automation.
 *
 * Implements three trigger types for automation pipelines:
 * - on-file-change: Glob pattern matching against modified file paths
 * - on-git-commit: Listens for git commit events
 * - on-schedule: Cron expression evaluation (5-field format)
 *
 * Integrates with EventBus for file-change events and uses setInterval-based
 * scheduling for cron triggers (following CronScheduler patterns).
 *
 * Implements pipeline queuing: if a triggered pipeline is already running,
 * the new execution is queued (status 'pending') and processed after the
 * current run completes. Never two simultaneous 'running' executions per pipeline.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5
 */

import type {
  PipelineTrigger,
  FileChangeTriggerConfig,
  ScheduleTriggerConfig,
  PipelineExecution,
} from '../shared/feature-integration-types';
import type { EventBus } from '../events/event-bus';

// ─── Types ──────────────────────────────────────────────────────

/** Callback invoked when a pipeline should be executed. */
export type PipelineExecuteCallback = (
  pipelineId: string,
  params: Record<string, unknown>,
) => Promise<PipelineExecution>;

/** Information about a git commit that triggered a pipeline. */
export interface CommitInfo {
  hash: string;
  message: string;
}

/** Internal registration for a pipeline's triggers. */
interface PipelineRegistration {
  pipelineId: string;
  triggers: PipelineTrigger[];
}

/** Queued execution waiting for the current run to complete. */
interface QueuedExecution {
  pipelineId: string;
  params: Record<string, unknown>;
}

/** Options for creating the TriggerSystem. */
export interface TriggerSystemOptions {
  /** EventBus instance for subscribing to file-change events. */
  eventBus?: EventBus;
  /** Callback to execute a pipeline when triggered. */
  executeCallback: PipelineExecuteCallback;
  /** Interval in ms for checking cron schedules (default: 60000 = 1 minute). */
  cronCheckIntervalMs?: number;
}

// ─── Glob Matching ──────────────────────────────────────────────

/**
 * Match a file path against a glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of non-separator characters
 * - `**` matches any sequence of characters including separators (recursive)
 * - `?` matches exactly one non-separator character
 * - `{a,b}` matches either 'a' or 'b' (brace expansion, single level)
 * - `[abc]` matches any character in the set
 * - `[!abc]` or `[^abc]` matches any character NOT in the set
 *
 * Path separators are normalized to `/` before matching.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Handle brace expansion (simple single-level)
  if (normalizedPattern.includes('{') && normalizedPattern.includes('}')) {
    const braceMatch = normalizedPattern.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braceMatch) {
      const [, prefix, alternatives, suffix] = braceMatch;
      return alternatives.split(',').some((alt) =>
        matchGlob(`${prefix}${alt.trim()}${suffix}`, normalizedPath),
      );
    }
  }

  const regex = globToRegex(normalizedPattern);
  return regex.test(normalizedPath);
}

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // `**` — matches anything including path separators
        // Skip trailing separator if present
        if (i + 2 < pattern.length && pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // `*` — matches anything except path separator
        regexStr += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if (char === '[') {
      // Character class
      let classStr = '[';
      i++;
      if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) {
        classStr += '^';
        i++;
      }
      while (i < pattern.length && pattern[i] !== ']') {
        classStr += escapeRegexChar(pattern[i]);
        i++;
      }
      classStr += ']';
      regexStr += classStr;
      i++; // skip ']'
    } else {
      regexStr += escapeRegexChar(char);
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/**
 * Escape a character for use in a RegExp (except special glob chars handled above).
 */
function escapeRegexChar(char: string): string {
  if ('.+^${}()|\\'.includes(char)) {
    return `\\${char}`;
  }
  return char;
}

// ─── Cron Expression Utilities ──────────────────────────────────

/**
 * Parse a 5-field cron expression into its component fields.
 *
 * Format: minute hour day-of-month month day-of-week
 *
 * Supports:
 * - Exact values: `5`
 * - Wildcards: `*`
 * - Ranges: `1-5`
 * - Steps: `* /5` (every 5), `1-10/2` (1,3,5,7,9)
 * - Lists: `1,3,5`
 *
 * @returns Array of 5 sets, each containing valid values for that field.
 */
export function parseCronExpression(
  cronExpr: string,
): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${cronExpr}": expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }

  const ranges: [number, number][] = [
    [0, 59],   // minute
    [0, 23],   // hour
    [1, 31],   // day of month
    [1, 12],   // month
    [0, 6],    // day of week (0 = Sunday)
  ];

  const result: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] = [
    new Set(),
    new Set(),
    new Set(),
    new Set(),
    new Set(),
  ];

  for (let fieldIdx = 0; fieldIdx < 5; fieldIdx++) {
    const field = parts[fieldIdx];
    const [min, max] = ranges[fieldIdx];
    const values = parseCronField(field, min, max);
    result[fieldIdx] = values;
  }

  return result;
}

/**
 * Parse a single cron field into a set of valid values.
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  // Handle lists (comma-separated)
  const parts = field.split(',');

  for (const part of parts) {
    // Handle step values (e.g., */5 or 1-10/2)
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);

      let rangeMin = min;
      let rangeMax = max;

      if (rangePart !== '*') {
        const dashMatch = rangePart.match(/^(\d+)-(\d+)$/);
        if (dashMatch) {
          rangeMin = parseInt(dashMatch[1], 10);
          rangeMax = parseInt(dashMatch[2], 10);
        } else {
          rangeMin = parseInt(rangePart, 10);
          rangeMax = max;
        }
      }

      for (let v = rangeMin; v <= rangeMax; v += step) {
        if (v >= min && v <= max) {
          values.add(v);
        }
      }
      continue;
    }

    // Handle wildcard
    if (part === '*') {
      for (let v = min; v <= max; v++) {
        values.add(v);
      }
      continue;
    }

    // Handle ranges (e.g., 1-5)
    const dashMatch = part.match(/^(\d+)-(\d+)$/);
    if (dashMatch) {
      const start = parseInt(dashMatch[1], 10);
      const end = parseInt(dashMatch[2], 10);
      for (let v = start; v <= end; v++) {
        if (v >= min && v <= max) {
          values.add(v);
        }
      }
      continue;
    }

    // Handle exact values
    const val = parseInt(part, 10);
    if (!isNaN(val) && val >= min && val <= max) {
      values.add(val);
    }
  }

  return values;
}

/**
 * Compute the next execution time after `fromDate` for a cron expression.
 *
 * Iterates forward minute-by-minute from `fromDate` + 1 minute until a
 * matching time is found. Returns a Date representing the next run.
 *
 * @param cronExpr - 5-field cron expression string.
 * @param fromDate - Reference date to compute next execution from.
 * @returns The next Date when the cron expression matches.
 */
export function getNextExecution(cronExpr: string, fromDate: Date): Date {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCronExpression(cronExpr);

  // Start from the next minute after fromDate
  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Safety limit: don't search more than 2 years ahead
  const maxIterations = 366 * 24 * 60; // ~1 year in minutes
  let iterations = 0;

  while (iterations < maxIterations) {
    const month = candidate.getMonth() + 1; // 1-based
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay(); // 0 = Sunday
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    if (
      months.has(month) &&
      daysOfMonth.has(dayOfMonth) &&
      daysOfWeek.has(dayOfWeek) &&
      hours.has(hour) &&
      minutes.has(minute)
    ) {
      return candidate;
    }

    // Advance by one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
    iterations++;
  }

  // Fallback: if no match found within limit, return fromDate + 24h
  const fallback = new Date(fromDate);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

/**
 * Check if a given Date matches a cron expression.
 */
export function matchesCron(cronExpr: string, date: Date): boolean {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCronExpression(cronExpr);

  const month = date.getMonth() + 1;
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay();
  const hour = date.getHours();
  const minute = date.getMinutes();

  return (
    months.has(month) &&
    daysOfMonth.has(dayOfMonth) &&
    daysOfWeek.has(dayOfWeek) &&
    hours.has(hour) &&
    minutes.has(minute)
  );
}

// ─── Trigger System ─────────────────────────────────────────────

export class TriggerSystem {
  private readonly registrations = new Map<string, PipelineRegistration>();
  private readonly executeCallback: PipelineExecuteCallback;
  private readonly eventBus?: EventBus;
  private readonly cronCheckIntervalMs: number;

  /** Tracks which pipelines are currently running. */
  private readonly runningPipelines = new Set<string>();

  /** Queue of pending executions per pipeline. */
  private readonly executionQueues = new Map<string, QueuedExecution[]>();

  /** Timer for cron schedule checking. */
  private cronTimer: ReturnType<typeof setInterval> | null = null;

  /** EventBus subscription reference for cleanup. */
  private fileChangeSubscription: { id: string; topic: string } | null = null;

  /** Whether the trigger system is actively running. */
  private running = false;

  constructor(options: TriggerSystemOptions) {
    this.executeCallback = options.executeCallback;
    this.eventBus = options.eventBus;
    this.cronCheckIntervalMs = options.cronCheckIntervalMs ?? 60_000;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Register a pipeline with its triggers.
   * A pipeline can have multiple triggers of different types.
   */
  registerPipeline(pipelineId: string, triggers: PipelineTrigger[]): void {
    this.registrations.set(pipelineId, { pipelineId, triggers });

    // Initialize queue if not exists
    if (!this.executionQueues.has(pipelineId)) {
      this.executionQueues.set(pipelineId, []);
    }
  }

  /**
   * Unregister a pipeline and remove all its triggers.
   */
  unregisterPipeline(pipelineId: string): void {
    this.registrations.delete(pipelineId);
    this.executionQueues.delete(pipelineId);
    this.runningPipelines.delete(pipelineId);
  }

  /**
   * Handle a file change event. Checks all registered pipelines for
   * on-file-change triggers with matching glob patterns.
   *
   * If a matching pipeline is found, enqueues it for execution with
   * the changed file path as input.
   */
  handleFileChange(filePath: string): void {
    for (const [pipelineId, registration] of this.registrations) {
      for (const trigger of registration.triggers) {
        if (trigger.type !== 'on-file-change') continue;

        const config = trigger.config as FileChangeTriggerConfig;
        if (!config.globPatterns || config.globPatterns.length === 0) continue;

        const matches = config.globPatterns.some((pattern) =>
          matchGlob(pattern, filePath),
        );

        if (matches) {
          this.enqueuePipeline(pipelineId, { filePath, trigger: 'file-change' });
          break; // Only trigger once per pipeline per file change
        }
      }
    }
  }

  /**
   * Handle a git commit event. Checks all registered pipelines for
   * on-git-commit triggers and enqueues matching pipelines.
   */
  handleGitCommit(commitInfo: CommitInfo): void {
    for (const [pipelineId, registration] of this.registrations) {
      for (const trigger of registration.triggers) {
        if (trigger.type !== 'on-git-commit') continue;

        this.enqueuePipeline(pipelineId, {
          commitHash: commitInfo.hash,
          commitMessage: commitInfo.message,
          trigger: 'git-commit',
        });
        break; // Only trigger once per pipeline per commit
      }
    }
  }

  /**
   * Start the trigger system. Begins cron schedule evaluation and
   * subscribes to EventBus file-change events.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Start cron timer
    this.cronTimer = setInterval(() => {
      this.evaluateCronTriggers();
    }, this.cronCheckIntervalMs);

    // Subscribe to file-change events on EventBus
    if (this.eventBus) {
      const subscription = this.eventBus.subscribe(
        'file:changed',
        (event) => {
          if (event.data && event.data.filePath) {
            this.handleFileChange(event.data.filePath as string);
          }
        },
        { ordered: false, persistent: false, retryOnFailure: false },
      );
      this.fileChangeSubscription = subscription;
    }
  }

  /**
   * Stop the trigger system. Stops cron evaluation and unsubscribes
   * from EventBus events.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Stop cron timer
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }

    // Unsubscribe from EventBus
    if (this.eventBus && this.fileChangeSubscription) {
      this.eventBus.unsubscribe(this.fileChangeSubscription as any);
      this.fileChangeSubscription = null;
    }
  }

  /**
   * Get the number of pending executions for a pipeline.
   */
  getPendingExecutions(pipelineId: string): number {
    const queue = this.executionQueues.get(pipelineId);
    return queue ? queue.length : 0;
  }

  /**
   * Check if a pipeline is currently running.
   */
  isRunning(pipelineId: string): boolean {
    return this.runningPipelines.has(pipelineId);
  }

  /**
   * Get all registered pipeline IDs.
   */
  getRegisteredPipelines(): string[] {
    return Array.from(this.registrations.keys());
  }

  // ─── Private Methods ──────────────────────────────────────────

  /**
   * Enqueue a pipeline for execution. If the pipeline is already running,
   * the execution is queued. Otherwise, it is executed immediately.
   *
   * Guarantees: never two simultaneous 'running' executions per pipeline.
   */
  private enqueuePipeline(pipelineId: string, params: Record<string, unknown>): void {
    if (this.runningPipelines.has(pipelineId)) {
      // Pipeline is already running — queue the execution
      const queue = this.executionQueues.get(pipelineId) || [];
      queue.push({ pipelineId, params });
      this.executionQueues.set(pipelineId, queue);
      return;
    }

    // Execute immediately
    this.executePipeline(pipelineId, params);
  }

  /**
   * Execute a pipeline and process the queue when done.
   */
  private async executePipeline(
    pipelineId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    this.runningPipelines.add(pipelineId);

    try {
      await this.executeCallback(pipelineId, params);
    } catch {
      // Execution errors are handled by the pipeline engine.
      // The trigger system only manages queuing.
    } finally {
      this.runningPipelines.delete(pipelineId);

      // Process next in queue if any
      this.processNextInQueue(pipelineId);
    }
  }

  /**
   * Process the next queued execution for a pipeline, if any.
   */
  private processNextInQueue(pipelineId: string): void {
    const queue = this.executionQueues.get(pipelineId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    this.executePipeline(next.pipelineId, next.params);
  }

  /**
   * Evaluate all registered cron triggers against the current time.
   * Called periodically by the cron timer.
   */
  private evaluateCronTriggers(): void {
    const now = new Date();
    // Zero out seconds and milliseconds for minute-level matching
    now.setSeconds(0, 0);

    for (const [pipelineId, registration] of this.registrations) {
      for (const trigger of registration.triggers) {
        if (trigger.type !== 'on-schedule') continue;

        const config = trigger.config as ScheduleTriggerConfig;
        if (!config.cron) continue;

        try {
          if (matchesCron(config.cron, now)) {
            this.enqueuePipeline(pipelineId, {
              trigger: 'schedule',
              scheduledAt: now.toISOString(),
              cronExpression: config.cron,
            });
          }
        } catch {
          // Invalid cron expression — skip silently
        }
      }
    }
  }
}
