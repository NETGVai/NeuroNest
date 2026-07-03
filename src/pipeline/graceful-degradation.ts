/**
 * Graceful Degradation — Fallback wrappers for efficiency mechanisms.
 *
 * Each efficiency mechanism (ContextCondenser v2, StuckDetector, SessionShell)
 * is gated behind its own feature flag (defaulting to disabled). When a
 * mechanism fails at runtime, the system continues operating with well-defined
 * fallback behavior:
 *
 *   - ContextCondenser failure → un-condensed prompt with truncation warning
 *   - StuckDetector failure → continue without interruption
 *   - SessionShell failure → per-command spawn transparently
 *
 * All migrations are additive only; the app boots on a pre-migration DB.
 * Efficiency mechanisms do not modify firewall or security layer behavior.
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { PipelineEvent } from './event-log.js';
import type { PromptBlock } from './prompt-cache-discipline.js';
import type { CondensedPrompt, ContextCondenserV2, SummarizeFn } from './context-condenser-v2.js';
import type { StuckDetectorInterface, StuckDetectionResult } from './stuck-detector.js';
import type { SessionShell, CommandResult, ShellState } from './session-shell.js';
import { logger } from '../utils/logger.js';

// ─── Degradation Warning Types ──────────────────────────────────────────────

export interface DegradationWarning {
  mechanism: 'context_condenser_v2' | 'stuck_detector' | 'session_shell';
  reason: string;
  timestamp: number;
  fallbackUsed: string;
}

export type DegradationListener = (warning: DegradationWarning) => void;

// ─── Graceful Condenser Wrapper ─────────────────────────────────────────────

/**
 * Wraps the ContextCondenserV2 with feature-gate checking and graceful fallback.
 *
 * When the flag is OFF: returns un-condensed prompt (identical to pre-mechanism baseline).
 * When the condenser throws: returns un-condensed prompt with a truncation warning
 * emitted to the listener.
 *
 * Requirement 25.1: Gated behind own flag, flag-off = identical to baseline.
 * Requirement 25.2: On failure, falls back to un-condensed prompt with warning.
 */
export class GracefulCondenser implements ContextCondenserV2 {
  private readonly inner: ContextCondenserV2;
  private readonly featureGate: FeatureGateSystem;
  private readonly listener: DegradationListener | null;

  constructor(
    inner: ContextCondenserV2,
    featureGate: FeatureGateSystem,
    listener?: DegradationListener,
  ) {
    this.inner = inner;
    this.featureGate = featureGate;
    this.listener = listener ?? null;
  }

  async assemble(
    stableBlocks: PromptBlock,
    events: PipelineEvent[],
    currentTask: string,
    modelContextWindow: number,
    modeBudget: number,
  ): Promise<CondensedPrompt> {
    // Feature gate check — when disabled, bypass entirely (Requirement 25.1)
    if (!this.featureGate.isEnabled('context_condenser_v2')) {
      return this.buildBaselinePrompt(stableBlocks, events, currentTask);
    }

    try {
      return await this.inner.assemble(
        stableBlocks,
        events,
        currentTask,
        modelContextWindow,
        modeBudget,
      );
    } catch (err) {
      // Requirement 25.2: fallback to un-condensed prompt with truncation warning
      const reason = err instanceof Error ? err.message : String(err);

      logger.warn('GracefulCondenser: condensation failed, using un-condensed prompt', {
        error: reason,
      });

      this.emitWarning({
        mechanism: 'context_condenser_v2',
        reason,
        timestamp: Date.now(),
        fallbackUsed: 'un-condensed prompt with all events verbatim',
      });

      return this.buildBaselinePrompt(stableBlocks, events, currentTask, reason);
    }
  }

  /**
   * Build a baseline (un-condensed) prompt — identical to pre-mechanism behavior.
   * Optionally includes a truncation warning when used as a fallback.
   */
  private buildBaselinePrompt(
    stableBlocks: PromptBlock,
    events: PipelineEvent[],
    currentTask: string,
    truncationReason?: string,
  ): CondensedPrompt {
    const allEventsContent = events
      .map(evt => `[${evt.kind}] ${typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload ?? null)}`)
      .join('\n');

    const warningPrefix = truncationReason
      ? `[TRUNCATION WARNING: Context condensation failed (${truncationReason}). Showing all events un-condensed.]\n\n`
      : '';

    const currentTaskBlock: PromptBlock = { label: 'current_task', content: currentTask };
    const recentEventsBlock: PromptBlock = { label: 'recent_events', content: warningPrefix + allEventsContent };
    const emptySummaryBlock: PromptBlock = { label: 'condensed_summary', content: '' };

    const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

    const totalTokens =
      estimateTokens(typeof stableBlocks.content === 'string' ? stableBlocks.content : JSON.stringify(stableBlocks.content)) +
      estimateTokens(warningPrefix + allEventsContent) +
      estimateTokens(currentTask);

    return {
      stablePrefix: stableBlocks,
      condensedSummary: emptySummaryBlock,
      recentEvents: recentEventsBlock,
      currentTask: currentTaskBlock,
      totalTokens,
      wasCondensed: false,
    };
  }

  private emitWarning(warning: DegradationWarning): void {
    if (this.listener) {
      try {
        this.listener(warning);
      } catch {
        // Never let listener errors propagate
      }
    }
  }
}

// ─── Graceful StuckDetector Wrapper ─────────────────────────────────────────

/**
 * Wraps the StuckDetector with feature-gate checking and graceful fallback.
 *
 * When the flag is OFF: returns null for every event (no detection, no interruption).
 * When the detector throws: returns null (continue without interruption).
 *
 * Requirement 25.1: Gated behind own flag, flag-off = identical to baseline.
 * Requirement 25.3: On failure, allows execution to continue without interruption.
 */
export class GracefulStuckDetector implements StuckDetectorInterface {
  private readonly inner: StuckDetectorInterface;
  private readonly featureGate: FeatureGateSystem;
  private readonly listener: DegradationListener | null;

  constructor(
    inner: StuckDetectorInterface,
    featureGate: FeatureGateSystem,
    listener?: DegradationListener,
  ) {
    this.inner = inner;
    this.featureGate = featureGate;
    this.listener = listener ?? null;
  }

  onEvent(event: PipelineEvent): StuckDetectionResult | null {
    // Feature gate check — when disabled, no detection (Requirement 25.1)
    if (!this.featureGate.isEnabled('stuck_detector')) {
      return null;
    }

    try {
      return this.inner.onEvent(event);
    } catch (err) {
      // Requirement 25.3: continue without interruption on failure
      const reason = err instanceof Error ? err.message : String(err);

      logger.warn('GracefulStuckDetector: detection failed, continuing without interruption', {
        error: reason,
        eventKind: event.kind,
      });

      this.emitWarning({
        mechanism: 'stuck_detector',
        reason,
        timestamp: Date.now(),
        fallbackUsed: 'continue without interruption',
      });

      return null;
    }
  }

  reset(taskId: string): void {
    try {
      this.inner.reset(taskId);
    } catch {
      // Non-critical, silently continue
    }
  }

  getStuckCount(taskId: string): number {
    try {
      return this.inner.getStuckCount(taskId);
    } catch {
      return 0;
    }
  }

  private emitWarning(warning: DegradationWarning): void {
    if (this.listener) {
      try {
        this.listener(warning);
      } catch {
        // Never let listener errors propagate
      }
    }
  }
}

// ─── Graceful SessionShell Wrapper ──────────────────────────────────────────

/**
 * Fallback shell that spawns each command independently (pre-mechanism baseline).
 * Used when the persistent SessionShell fails to initialize or crashes.
 */
export interface FallbackSpawnFn {
  (command: string, timeoutMs?: number): Promise<CommandResult>;
}

/**
 * Wraps the SessionShell with feature-gate checking and graceful fallback.
 *
 * When the flag is OFF: uses per-command spawn (identical to pre-mechanism baseline).
 * When the persistent shell fails: falls back to per-command spawn transparently.
 *
 * Requirement 25.1: Gated behind own flag, flag-off = identical to baseline.
 * Requirement 25.4: On failure, falls back to per-command spawn transparently.
 */
export class GracefulSessionShell implements SessionShell {
  private readonly inner: SessionShell;
  private readonly featureGate: FeatureGateSystem;
  private readonly fallbackSpawn: FallbackSpawnFn;
  private readonly listener: DegradationListener | null;
  private inFallbackMode = false;

  constructor(
    inner: SessionShell,
    featureGate: FeatureGateSystem,
    fallbackSpawn: FallbackSpawnFn,
    listener?: DegradationListener,
  ) {
    this.inner = inner;
    this.featureGate = featureGate;
    this.fallbackSpawn = fallbackSpawn;
    this.listener = listener ?? null;
  }

  async run(command: string, timeoutMs?: number): Promise<CommandResult> {
    // Feature gate check — when disabled, use per-command spawn (Requirement 25.1)
    if (!this.featureGate.isEnabled('session_shell')) {
      return this.fallbackSpawn(command, timeoutMs);
    }

    // If already in fallback mode from prior failure, use spawn
    if (this.inFallbackMode) {
      return this.fallbackSpawn(command, timeoutMs);
    }

    try {
      return await this.inner.run(command, timeoutMs);
    } catch (err) {
      // Requirement 25.4: fall back to per-command spawn transparently
      const reason = err instanceof Error ? err.message : String(err);

      logger.warn('GracefulSessionShell: persistent shell failed, falling back to spawn', {
        error: reason,
        command: command.slice(0, 100),
      });

      this.inFallbackMode = true;

      this.emitWarning({
        mechanism: 'session_shell',
        reason,
        timestamp: Date.now(),
        fallbackUsed: 'per-command spawn',
      });

      return this.fallbackSpawn(command, timeoutMs);
    }
  }

  async spawn(command: string, timeoutMs?: number): Promise<CommandResult> {
    // spawn is always isolated — feature gate doesn't affect it
    if (!this.featureGate.isEnabled('session_shell')) {
      return this.fallbackSpawn(command, timeoutMs);
    }

    try {
      return await this.inner.spawn(command, timeoutMs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      logger.warn('GracefulSessionShell: spawn failed, using fallback spawn', {
        error: reason,
      });

      return this.fallbackSpawn(command, timeoutMs);
    }
  }

  getState(): ShellState {
    if (!this.featureGate.isEnabled('session_shell') || this.inFallbackMode) {
      // Return a "not active" state when in fallback mode
      return {
        cwd: process.cwd(),
        envVarNames: [],
        pid: -1,
        alive: false,
      };
    }

    try {
      return this.inner.getState();
    } catch {
      return {
        cwd: process.cwd(),
        envVarNames: [],
        pid: -1,
        alive: false,
      };
    }
  }

  kill(): void {
    try {
      this.inner.kill();
    } catch {
      // Kill failures are non-critical in degradation mode
    }
  }

  /** Check if this shell has degraded to fallback mode. */
  isInFallbackMode(): boolean {
    return this.inFallbackMode;
  }

  private emitWarning(warning: DegradationWarning): void {
    if (this.listener) {
      try {
        this.listener(warning);
      } catch {
        // Never let listener errors propagate
      }
    }
  }
}

// ─── Degradation Monitor ────────────────────────────────────────────────────

/**
 * Central monitor that collects degradation warnings from all mechanisms.
 * Provides a unified view of which mechanisms have degraded and why.
 *
 * Requirement 25.6: Efficiency mechanisms do not modify firewall or security behavior.
 * This is enforced by design — the wrappers only affect efficiency mechanisms,
 * never touching firewall or security layers.
 */
export class DegradationMonitor {
  private warnings: DegradationWarning[] = [];
  private readonly maxWarnings: number;

  constructor(maxWarnings = 100) {
    this.maxWarnings = maxWarnings;
  }

  /** Listener callback to pass to GracefulX constructors. */
  readonly onWarning: DegradationListener = (warning) => {
    this.warnings.push(warning);
    if (this.warnings.length > this.maxWarnings) {
      this.warnings.shift();
    }
  };

  /** Get all recorded degradation warnings. */
  getWarnings(): readonly DegradationWarning[] {
    return this.warnings;
  }

  /** Get warnings for a specific mechanism. */
  getWarningsFor(mechanism: DegradationWarning['mechanism']): DegradationWarning[] {
    return this.warnings.filter(w => w.mechanism === mechanism);
  }

  /** Check if a specific mechanism has degraded (has any warnings). */
  isDegraded(mechanism: DegradationWarning['mechanism']): boolean {
    return this.warnings.some(w => w.mechanism === mechanism);
  }

  /** Clear all warnings. */
  clear(): void {
    this.warnings = [];
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface GracefulMechanismsOptions {
  condenser: ContextCondenserV2;
  stuckDetector: StuckDetectorInterface;
  sessionShell: SessionShell;
  featureGate: FeatureGateSystem;
  fallbackSpawn: FallbackSpawnFn;
  listener?: DegradationListener;
}

export interface GracefulMechanisms {
  condenser: GracefulCondenser;
  stuckDetector: GracefulStuckDetector;
  sessionShell: GracefulSessionShell;
  monitor: DegradationMonitor;
}

/**
 * Create graceful wrappers for all efficiency mechanisms with a shared
 * degradation monitor.
 *
 * Usage:
 * ```typescript
 * const { condenser, stuckDetector, sessionShell, monitor } = createGracefulMechanisms({
 *   condenser: rawCondenser,
 *   stuckDetector: rawDetector,
 *   sessionShell: rawShell,
 *   featureGate: gates,
 *   fallbackSpawn: (cmd, timeout) => shellSpawnOneShot(cmd, timeout),
 * });
 *
 * // Use wrappers — they degrade transparently on failure
 * const prompt = await condenser.assemble(stable, events, task, 200000, 80000);
 * const stuck = stuckDetector.onEvent(event);
 * const result = await sessionShell.run('npm test');
 *
 * // Check degradation status
 * if (monitor.isDegraded('session_shell')) { ... }
 * ```
 */
export function createGracefulMechanisms(options: GracefulMechanismsOptions): GracefulMechanisms {
  const monitor = new DegradationMonitor();
  const listener = options.listener ?? monitor.onWarning;

  return {
    condenser: new GracefulCondenser(options.condenser, options.featureGate, listener),
    stuckDetector: new GracefulStuckDetector(options.stuckDetector, options.featureGate, listener),
    sessionShell: new GracefulSessionShell(options.sessionShell, options.featureGate, options.fallbackSpawn, listener),
    monitor,
  };
}
