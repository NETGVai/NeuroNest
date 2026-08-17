/**
 * Publication Gate Types
 *
 * Defines the artifact scoping, gate categories, and result structures
 * for the server/schema/UI publication gate system.
 *
 * Each independently versioned artifact (session-mcp, runtime-mcp, schema, ui)
 * declares which gate categories must pass before it can be published.
 * Gates are scoped so one MCP artifact can be evaluated without starting
 * the other.
 *
 * Requirements: 33.4–33.9, 46.13, 46.17, 47.13, 47.19
 */

/**
 * Independently publishable artifact identifiers.
 *
 * - session-mcp: The neuronest-session-mcp executable and its surfaces.
 * - runtime-mcp: The neuronest-runtime-mcp executable and its surfaces.
 * - schema: The Shared_Database schema migrations and contracts.
 * - ui: The Chat_Interface rendering and presentation layer.
 */
export type PublishableArtifact =
  | 'session-mcp'
  | 'runtime-mcp'
  | 'schema'
  | 'ui';

/**
 * Gate categories that must pass before an artifact can be published.
 * Each category corresponds to a specific class of evidence from the test suite.
 */
export type GateCategory =
  | 'mcp-conformance'
  | 'migration-compatibility'
  | 'invariant-reconstruction'
  | 'platform-security'
  | 'accessibility'
  | 'rendering-correctness'
  | 'performance'
  | 'snapshots'
  | 'traceability';

/**
 * Configuration for a single gate category.
 */
export interface GateCategoryConfig {
  /** Unique category identifier */
  category: GateCategory;
  /** Human-readable label for display */
  label: string;
  /** Vitest include patterns to run for this gate */
  testPatterns: string[];
  /** Whether this gate blocks publication (vs. advisory-only) */
  blocking: boolean;
  /** Optional timeout override (ms) */
  timeout?: number;
}

/**
 * Artifact publication gate configuration — maps each artifact to its required gates.
 */
export interface ArtifactGateConfig {
  /** Artifact being gated */
  artifact: PublishableArtifact;
  /** Human-readable artifact label */
  label: string;
  /** Which gate categories must pass for this artifact */
  requiredGates: GateCategory[];
  /** Whether this artifact can be evaluated independently of others */
  independent: boolean;
}

/**
 * Result of evaluating a single gate category.
 */
export interface GateEvaluationResult {
  /** Which gate was evaluated */
  category: GateCategory;
  /** Whether the gate passed */
  passed: boolean;
  /** Number of tests that passed */
  testsPassed: number;
  /** Number of tests that failed */
  testsFailed: number;
  /** Number of tests skipped */
  testsSkipped: number;
  /** Duration of the gate evaluation (ms) */
  durationMs: number;
  /** Summary message */
  summary: string;
  /** Failure details (only when not passed) */
  failures?: string[];
}

/**
 * Result of evaluating all gates for an artifact.
 */
export interface ArtifactPublicationDecision {
  /** Which artifact was evaluated */
  artifact: PublishableArtifact;
  /** Whether publication is allowed */
  publishable: boolean;
  /** Which gates are blocking publication */
  blockingGates: GateCategory[];
  /** Full results for all evaluated gates */
  gateResults: GateEvaluationResult[];
  /** Evaluation timestamp */
  evaluatedAt: string;
  /** Total duration of all gate evaluations (ms) */
  totalDurationMs: number;
}

/**
 * Complete publication gate evaluation across all requested artifacts.
 */
export interface PublicationGateReport {
  /** All artifact decisions */
  decisions: ArtifactPublicationDecision[];
  /** Whether all artifacts are publishable */
  allPublishable: boolean;
  /** Total blocked artifact count */
  blockedCount: number;
  /** Report timestamp */
  generatedAt: string;
}
