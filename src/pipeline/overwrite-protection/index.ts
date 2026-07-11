/**
 * Overwrite Protection — multi-layer defense against accidental project destruction.
 *
 * Layers:
 * 1. Project Identity Anchoring — injects project context into system prompts
 * 2. Overwrite Gate — blocks unrelated file overwrites pending confirmation
 * 3. Scope Divergence Detection — detects new-project requests and auto-creates sibling dirs
 * 4. Cross-Project Registry — tracks sibling projects for context sharing
 */

export type {
  ProjectManifest,
  IdentityAnchorResult,
  OverwriteGateConfig,
  RelatednessResult,
  OverwriteDecision,
  ScopeDetectorConfig,
  ScopeDivergenceResult,
  RegisteredProject,
  CrossProjectRegistry,
  OverwriteProtectionSettings,
  ScopeWarningPayload,
  OverwriteConfirmationPayload,
} from './types';

export {
  parseOverwriteProtectionConfig,
  parseProjectIdentityOverride,
} from './config-parser';

export { deriveProjectManifest } from './project-manifest';

export {
  extractStructuralIdentifiers,
  computeRelatedness,
  evaluateOverwrite,
} from './overwrite-gate';

export { computeScopeDivergence } from './scope-detector';

export {
  loadRegistry,
  saveRegistry,
  registerProject,
  formatRegistryForPrompt,
} from './cross-project-registry';

export { buildIdentityAnchor } from './identity-anchor';
