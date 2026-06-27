/**
 * Feature Gate Configuration Types
 *
 * Defines all feature flags, dependency declarations, and resolved configuration
 * types for the NeuroNest Superagent Upgrade feature gate system.
 *
 * Requirements: 0.1, 0.5, 0.6, 0.7, 0.8
 */

// ─── Feature Flags ──────────────────────────────────────────────

/** All feature flags with their default (disabled) state */
export interface FeatureGateFlags {
  cost_tracking: boolean;
  checkpoint: boolean;
  vulnerability_blocking: boolean;
  dependency_grounding: boolean;
  memory_persistence: boolean;
  lsp_intelligence: boolean;
  worktree_isolation: boolean;
  ast_locking: boolean;
  credential_vault: boolean;
  model_routing: boolean;
  self_improvement: boolean;
  trace_visualization: boolean;
  parallel_agents: boolean;
  supply_chain_detection: boolean;
  specialist_roles: boolean;
  completion_council: boolean;
  provider_failover: boolean;
  sandbox: boolean;
  headless_mode: boolean;
  provenance_tracking: boolean;
  skill_creation: boolean;
  scheduled_tasks: boolean;
  remote_access: boolean;
  voice_io: boolean;
  kanban_board: boolean;
  repo_readiness: boolean;
  compliance_gates: boolean;
  wasm_sandbox: boolean;
  browser_automation: boolean;
  backpropagation: boolean;
  runtimesecurity_hackability_scoring: boolean;
  runtimesecurity_threat_modeling: boolean;
  runtimesecurity_realtime_analysis: boolean;
  runtimesecurity_attack_path_mapping: boolean;
  runtimesecurity_evidence_store: boolean;
  runtimesecurity_ai_security_rules: boolean;
  agent_racing: boolean;
  session_forking: boolean;
  worktree_checkpoints: boolean;
  agent_status_feed: boolean;
  diff_review: boolean;
  provider_registry: boolean;
  test_planning: boolean;
  test_generation: boolean;
  test_drift_detection: boolean;
  test_health_analytics: boolean;
  verification_agent: boolean;
  enhanced_drift_classification: boolean;
  drift_aware_orchestration: boolean;
}

/** Default flags — all disabled */
export const DEFAULT_FEATURE_FLAGS: FeatureGateFlags = {
  cost_tracking: false,
  checkpoint: false,
  vulnerability_blocking: false,
  dependency_grounding: false,
  memory_persistence: false,
  lsp_intelligence: false,
  worktree_isolation: false,
  ast_locking: false,
  credential_vault: false,
  model_routing: false,
  self_improvement: false,
  trace_visualization: false,
  parallel_agents: false,
  supply_chain_detection: false,
  specialist_roles: false,
  completion_council: false,
  provider_failover: false,
  sandbox: false,
  headless_mode: false,
  provenance_tracking: false,
  skill_creation: false,
  scheduled_tasks: false,
  remote_access: false,
  voice_io: false,
  kanban_board: false,
  repo_readiness: false,
  compliance_gates: false,
  wasm_sandbox: false,
  browser_automation: false,
  backpropagation: false,
  runtimesecurity_hackability_scoring: false,
  runtimesecurity_threat_modeling: false,
  runtimesecurity_realtime_analysis: false,
  runtimesecurity_attack_path_mapping: false,
  runtimesecurity_evidence_store: false,
  runtimesecurity_ai_security_rules: false,
  agent_racing: false,
  session_forking: false,
  worktree_checkpoints: false,
  agent_status_feed: false,
  diff_review: false,
  provider_registry: false,
  test_planning: false,
  test_generation: false,
  test_drift_detection: false,
  test_health_analytics: false,
  verification_agent: false,
  enhanced_drift_classification: false,
  drift_aware_orchestration: false,
};

// ─── Dependency Declarations ────────────────────────────────────

/** Dependency declaration for feature prerequisites */
export interface FeatureDependency {
  feature: keyof FeatureGateFlags;
  requires?: (keyof FeatureGateFlags)[];       // hard prerequisites
  requiresAny?: (keyof FeatureGateFlags)[];    // one-of prerequisites
  incompatible?: (keyof FeatureGateFlags)[];   // mutual exclusions
}

/**
 * All feature dependency declarations.
 *
 * - parallel_agents requires worktree_isolation
 * - ast_locking requires parallel_agents OR worktree_isolation
 * - scheduled_tasks requires headless_mode
 * - wasm_sandbox is incompatible with sandbox
 */
export const FEATURE_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'parallel_agents',
    requires: ['worktree_isolation'],
  },
  {
    feature: 'ast_locking',
    requiresAny: ['parallel_agents', 'worktree_isolation'],
  },
  {
    feature: 'scheduled_tasks',
    requires: ['headless_mode'],
  },
  {
    feature: 'wasm_sandbox',
    incompatible: ['sandbox'],
  },
  {
    feature: 'sandbox',
    incompatible: ['wasm_sandbox'],
  },
];

/**
 * Runtime security feature dependency declarations.
 *
 * attack_path_mapping requires hackability_scoring because attack paths
 * are correlated from hackability scoring findings.
 *
 * Requirements: 1.10
 */
export const RUNTIME_SECURITY_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'runtimesecurity_attack_path_mapping',
    requires: ['runtimesecurity_hackability_scoring'],
  },
];

/**
 * Enhanced feature dependency declarations.
 *
 * - agent_racing requires worktree_isolation and parallel_agents
 * - session_forking requires parallel_agents
 * - worktree_checkpoints requires checkpoint and worktree_isolation
 * - drift_aware_orchestration requires enhanced_drift_classification, session_forking, and worktree_checkpoints
 * - test_drift_detection requires test_health_analytics
 *
 * Requirements: 1.9, 2.9, 3.9, 5.8, 6.6, 7.7, 8.7, 9.7, 10.8, 11.7, 12.8, 13.7, 14.10
 */
export const ENHANCED_FEATURE_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'agent_racing',
    requires: ['worktree_isolation', 'parallel_agents'],
  },
  {
    feature: 'session_forking',
    requires: ['parallel_agents'],
  },
  {
    feature: 'worktree_checkpoints',
    requires: ['checkpoint', 'worktree_isolation'],
  },
  {
    feature: 'drift_aware_orchestration',
    requires: ['enhanced_drift_classification', 'session_forking', 'worktree_checkpoints'],
  },
  {
    feature: 'test_drift_detection',
    requires: ['test_health_analytics'],
  },
];

// ─── Resolved Configuration ─────────────────────────────────────

/** Validated, resolved configuration after dependency checking */
export interface ResolvedFeatureConfig {
  flags: FeatureGateFlags;
  resolved: boolean;
  autoEnabled: (keyof FeatureGateFlags)[];  // prerequisites auto-enabled
  warnings: string[];
}
