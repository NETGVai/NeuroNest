/**
 * Sandbox Telemetry — Records SandboxDenial events as telemetry
 * without changing drift classification or Loop Engine state semantics.
 *
 * This module:
 *   - Records SandboxDenial events to the session telemetry store
 *   - Does NOT emit drift signals or change drift classification (Req 9.10, 30.3, 30.6)
 *   - Provides helpers for the Loop Engine to detect sandbox-caused verification failures
 *     and map them to BLOCKED instead of STALLED (Req 9.11)
 *   - Provides a filter to exclude sandbox-denied operations from progress hash inputs (Req 30.6)
 *
 * Requirements: 9.10, 9.11, 30.3, 30.6
 */

import type { SandboxProfileName, SandboxTraceMetadata } from './kernel-sandbox';

// ─── Types ──────────────────────────────────────────────────────

/** A recorded sandbox denial event */
export interface SandboxDenialEvent {
  /** When the denial occurred (ISO 8601) */
  timestamp: string;
  /** The session in which the denial occurred */
  sessionId: string;
  /** The agent responsible for the tool call */
  agentId: string;
  /** The tool that was denied */
  toolId: string;
  /** The path that was denied access */
  deniedPath: string;
  /** The sandbox profile active at the time of denial */
  profile: SandboxProfileName;
  /** The action that was denied (read | write | execute | network) */
  action: SandboxDenialAction;
}

/** Types of sandbox denial actions */
export type SandboxDenialAction = 'read' | 'write' | 'execute' | 'network';

/** Input for recording a sandbox denial */
export interface RecordDenialInput {
  sessionId: string;
  agentId: string;
  toolId: string;
  deniedPath: string;
  profile: SandboxProfileName;
  action: SandboxDenialAction;
}

/**
 * Represents a tool execution trace entry with sandbox metadata.
 * Used by the Loop Engine integration to detect sandbox-caused failures.
 */
export interface ToolExecutionTrace {
  toolId: string;
  success: boolean;
  sandboxMetadata?: SandboxTraceMetadata;
  deniedPaths?: string[];
  error?: string;
}

/**
 * Result of analyzing a verification failure for sandbox causation.
 */
export interface SandboxCausationResult {
  /** Whether the verification failure was caused by sandbox denial */
  isSandboxCaused: boolean;
  /** The denied paths that contributed to the failure */
  deniedPaths: string[];
  /** Human-readable reason for the determination */
  reason: string;
}

// ─── Telemetry Store Interface ──────────────────────────────────

/**
 * Interface for the session telemetry store.
 * Matches existing telemetry patterns in the codebase (event-log style).
 */
export interface TelemetryStoreLike {
  record(event: {
    kind: string;
    sessionId: string;
    payload: unknown;
  }): void;
}

// ─── Sandbox Telemetry Service ──────────────────────────────────

/**
 * SandboxTelemetryService records SandboxDenial events to the session
 * telemetry store. It is explicitly designed to NOT emit drift signals
 * or alter drift classification in any way (Req 9.10, 30.3).
 *
 * It also provides:
 * - Detection of sandbox-caused verification failures for BLOCKED mapping (Req 9.11)
 * - Identification of sandbox-denied operations for progress hash exclusion (Req 30.6)
 */
export class SandboxTelemetryService {
  private readonly telemetryStore: TelemetryStoreLike | null;
  private readonly denials: SandboxDenialEvent[] = [];
  private readonly maxInMemoryDenials = 1000;

  constructor(telemetryStore?: TelemetryStoreLike) {
    this.telemetryStore = telemetryStore ?? null;
  }

  // ─── Recording ──────────────────────────────────────────────

  /**
   * Record a SandboxDenial event. This is telemetry-only — it does
   * NOT emit drift signals, change drift classification, or alter
   * Loop Engine state (Req 9.10, 30.3).
   */
  recordDenial(input: RecordDenialInput): SandboxDenialEvent {
    const event: SandboxDenialEvent = {
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolId: input.toolId,
      deniedPath: input.deniedPath,
      profile: input.profile,
      action: input.action,
    };

    // Store in memory (bounded)
    this.denials.push(event);
    if (this.denials.length > this.maxInMemoryDenials) {
      this.denials.shift();
    }

    // Persist to telemetry store if available
    if (this.telemetryStore) {
      this.telemetryStore.record({
        kind: 'sandbox.denial',
        sessionId: input.sessionId,
        payload: {
          agentId: input.agentId,
          toolId: input.toolId,
          deniedPath: input.deniedPath,
          profile: input.profile,
          action: input.action,
          timestamp: event.timestamp,
        },
      });
    }

    return event;
  }

  // ─── Loop Engine Integration: BLOCKED Detection (Req 9.11) ──

  /**
   * Analyze a verification failure to determine if it was caused by
   * sandbox denial. When a verification step fails AND the tool
   * execution trace shows sandbox-denied paths, the Loop Engine should
   * classify the result as BLOCKED, not STALLED.
   *
   * This does NOT alter the state machine — it provides advisory
   * information that the Loop Runner uses to pick the correct terminal state.
   *
   * @param traces - Tool execution traces from the current pass
   * @returns Analysis result indicating if sandbox caused the failure
   */
  analyzeSandboxCausation(traces: ToolExecutionTrace[]): SandboxCausationResult {
    const sandboxDeniedTraces = traces.filter(
      (t) =>
        !t.success &&
        t.sandboxMetadata?.sandbox === 'available' &&
        t.deniedPaths &&
        t.deniedPaths.length > 0,
    );

    if (sandboxDeniedTraces.length === 0) {
      return {
        isSandboxCaused: false,
        deniedPaths: [],
        reason: 'No sandbox-denied operations detected in execution traces',
      };
    }

    const allDeniedPaths = sandboxDeniedTraces.flatMap((t) => t.deniedPaths ?? []);
    const uniqueDeniedPaths = [...new Set(allDeniedPaths)];

    return {
      isSandboxCaused: true,
      deniedPaths: uniqueDeniedPaths,
      reason: `Verification failure caused by sandbox denial on ${uniqueDeniedPaths.length} path(s): ${uniqueDeniedPaths.slice(0, 5).join(', ')}${uniqueDeniedPaths.length > 5 ? '...' : ''}`,
    };
  }

  // ─── Progress Hash Exclusion (Req 30.6) ─────────────────────

  /**
   * Determine which tool call results should be excluded from progress
   * hash computation because they were denied by the sandbox.
   *
   * Failed operations that were denied by sandbox should not count
   * toward progress — they represent environment constraints, not
   * agent stalling.
   *
   * @param traces - Tool execution traces from the current pass
   * @returns Tool IDs whose results should be excluded from progress inputs
   */
  getProgressExcludedToolCalls(traces: ToolExecutionTrace[]): string[] {
    return traces
      .filter(
        (t) =>
          !t.success &&
          t.sandboxMetadata?.sandbox === 'available' &&
          t.deniedPaths &&
          t.deniedPaths.length > 0,
      )
      .map((t) => t.toolId);
  }

  /**
   * Check if a specific tool execution was denied by the sandbox.
   * Used by the progress hash computation to decide whether to include
   * the result of a tool call in the hash.
   */
  isToolCallSandboxDenied(trace: ToolExecutionTrace): boolean {
    return (
      !trace.success &&
      trace.sandboxMetadata?.sandbox === 'available' &&
      (trace.deniedPaths?.length ?? 0) > 0
    );
  }

  // ─── Query API ──────────────────────────────────────────────

  /**
   * Get all recorded denials for a session.
   * Used by Loop Engine receipts and debrief.
   */
  getDenials(sessionId: string): SandboxDenialEvent[] {
    return this.denials.filter((d) => d.sessionId === sessionId);
  }

  /**
   * Get the count of denials in a session.
   */
  getDenialCount(sessionId: string): number {
    return this.denials.filter((d) => d.sessionId === sessionId).length;
  }

  /**
   * Check if there have been any denials in the current session.
   */
  hasDenials(sessionId: string): boolean {
    return this.denials.some((d) => d.sessionId === sessionId);
  }

  /**
   * Clear in-memory denial records for a session (e.g., on session end).
   */
  clearSession(sessionId: string): void {
    for (let i = this.denials.length - 1; i >= 0; i--) {
      const denial = this.denials[i];
      if (denial && denial.sessionId === sessionId) {
        this.denials.splice(i, 1);
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultInstance: SandboxTelemetryService | null = null;

/**
 * Get or create the default SandboxTelemetryService instance.
 */
export function getSandboxTelemetryService(
  telemetryStore?: TelemetryStoreLike,
): SandboxTelemetryService {
  if (!defaultInstance) {
    defaultInstance = new SandboxTelemetryService(telemetryStore);
  }
  return defaultInstance;
}

/**
 * Reset the singleton (for testing purposes only).
 */
export function resetSandboxTelemetryService(): void {
  defaultInstance = null;
}

// ─── Loop Engine Integration Helper ─────────────────────────────

/**
 * Determines the correct terminal state when verification fails,
 * considering sandbox causation.
 *
 * If the verification failure was caused by sandbox denial, returns 'BLOCKED'
 * instead of allowing the normal STALLED classification to apply (Req 9.11).
 *
 * This function is meant to be called by the Loop Runner after a
 * verification failure and before choosing between STALLED and other states.
 *
 * @param traces - Tool execution traces from the current pass
 * @param wouldBeStalled - Whether the normal stall-detection would classify as STALLED
 * @param service - The SandboxTelemetryService instance
 * @returns 'BLOCKED' if sandbox caused the failure, null otherwise (let normal flow decide)
 */
export function resolveVerifyFailureState(
  traces: ToolExecutionTrace[],
  wouldBeStalled: boolean,
  service: SandboxTelemetryService,
): 'BLOCKED' | null {
  if (!wouldBeStalled) {
    // Only intervene when the system would otherwise classify as STALLED
    return null;
  }

  const causation = service.analyzeSandboxCausation(traces);
  if (causation.isSandboxCaused) {
    return 'BLOCKED';
  }

  return null;
}
