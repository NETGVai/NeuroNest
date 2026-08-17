/**
 * Publication Gates
 *
 * Server, schema, and UI publication gate system that blocks affected
 * artifacts when critical quality evidence fails. Gates are scoped so
 * each independently versioned MCP artifact can be evaluated without
 * starting the other.
 *
 * Gate categories:
 * - MCP conformance (protocol, schema, lifecycle)
 * - Migration compatibility (forward, mixed-version, rollback)
 * - Invariant reconstruction (diagnostics, hash chains)
 * - Platform security (sandbox, confinement, web retrieval)
 * - Critical accessibility (keyboard, focus, roles, contrast)
 * - Rendering correctness (keys, anchors, equivalence, mounts)
 * - Configured performance (budgets from Settings_Service)
 * - Protocol & contract snapshots
 * - Requirement/property traceability
 *
 * Requirements: 33.4–33.9, 46.13, 46.17, 47.13, 47.19
 */

export type {
  PublishableArtifact,
  GateCategory,
  GateCategoryConfig,
  ArtifactGateConfig,
  GateEvaluationResult,
  ArtifactPublicationDecision,
  PublicationGateReport,
} from './types.js';

export {
  GATE_CATEGORIES,
  ARTIFACT_GATES,
  getArtifactGateConfig,
  getGateCategoryConfig,
  getAllArtifacts,
  getAllGateCategories,
  getRequiredGatesForArtifacts,
  getTestPatternsForGate,
} from './gate-config.js';

export type {
  TestRunner,
  TestRunResult,
} from './gate-evaluator.js';

export {
  evaluateGateCategory,
  evaluateArtifactGates,
  evaluatePublicationGates,
  formatPublicationGateReport,
  formatGitHubSummary,
} from './gate-evaluator.js';
