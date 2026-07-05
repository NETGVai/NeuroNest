/**
 * Types for the Harness Health Diagnostic Widget.
 *
 * Shows presence/absence of 7 harness components with degradation
 * messages and recommended scaffolding order.
 *
 * Validates: Requirements 30.1, 30.2, 30.3, 30.4
 */

// ─── Component Identifiers ──────────────────────────────────────

/**
 * The 7 harness components tracked by the health widget.
 */
export type HarnessComponentId =
  | 'permission-pattern-engine'
  | 'standing-context'
  | 'memory-vault'
  | 'hooks'
  | 'verifier-subagent'
  | 'mcp-scoping'
  | 'progress-hash';

// ─── Component Status ───────────────────────────────────────────

/** Status of a single harness component. */
export type ComponentStatus = 'present' | 'absent';

/** Full status record for a single harness component. */
export interface HarnessComponentStatus {
  id: HarnessComponentId;
  label: string;
  status: ComponentStatus;
  /** What file/config establishes this component's presence. */
  filePath: string;
  /** Degradation message shown when the component is absent. */
  degradationMessage: string;
  /** Order in the recommended scaffolding sequence (1 = first). */
  scaffoldOrder: number;
}

// ─── Widget State ───────────────────────────────────────────────

/** State of the Harness Health Widget. */
export interface HarnessHealthState {
  components: HarnessComponentStatus[];
  /** Count of present components. */
  presentCount: number;
  /** Count of absent components. */
  absentCount: number;
  /** Whether a scaffold operation is in progress. */
  isScaffolding: boolean;
}

// ─── Widget Config ──────────────────────────────────────────────

/** Configuration for the Harness Health Widget. */
export interface HarnessHealthConfig {
  /** Callback when a scaffold action is triggered for a component. */
  onScaffold?: (componentId: HarnessComponentId) => void;

  /** Callback when the widget detects file changes and updates. */
  onStatusChange?: (state: HarnessHealthState) => void;
}

// ─── Scaffold Info ──────────────────────────────────────────────

/** Information needed to scaffold a missing component. */
export interface ScaffoldAction {
  componentId: HarnessComponentId;
  label: string;
  description: string;
}
