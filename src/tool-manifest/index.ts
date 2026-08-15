/**
 * Tool Manifest module — Governs built-in, plugin, and MCP tools through one manifest contract.
 *
 * Requirements: 36.1, 36.2, 36.3, 36.5, 36.6, 36.7, 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9, 37.10
 */

export type {
  ToolManifest,
  ToolRiskLevel,
  NetworkPolicy,
  ToolSource,
  ToolPolicy,
  PolicyStack,
  ResolvedPolicy,
  ManifestRegistrationResult,
  ToolInvocationRequest,
  ToolInvocationResult,
} from './types.js';

export { ToolManifestService } from './tool-manifest-service.js';
export { PolicyResolver } from './policy-resolver.js';
export { LegacyCutoverGate } from './legacy-cutover-gate.js';
export type { CutoverGateState, ToolExecutionHandler } from './legacy-cutover-gate.js';

export { ToolGovernanceService } from './tool-governance-service.js';
export type {
  TrustLevel,
  CompatibilityStatus,
  RuntimeAvailability,
  ToolDisclosure,
  GovernedToolManifest,
  ToolSideEffect,
  EnablementDecision,
  FailureCategory,
  TypedToolFailure,
  ToolEvidenceEnvelope,
} from './tool-governance-service.js';
