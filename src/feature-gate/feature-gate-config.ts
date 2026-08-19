/**
 * Feature Gate Configuration Types
 *
 * Defines all feature flags, dependency declarations, and resolved configuration
 * types for the NeuroNest Superagent Upgrade feature gate system.
 *
 * Requirements: 0.1, 0.5, 0.6, 0.7, 0.8
 */

import { envFlag } from '../main/performance/feature-flags.js';

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

  // ─── Production UX Audit Flags ──────────────────────────────────
  production_ux_iteration_persistence: boolean;
  production_ux_action_first: boolean;
  production_ux_code_quality: boolean;
  production_ux_realtime_activity: boolean;
  production_ux_status_indicators: boolean;
  production_ux_file_tree_updates: boolean;
  production_ux_change_summary: boolean;
  production_ux_visual_diff: boolean;
  production_ux_error_quality: boolean;
  production_ux_loading_states: boolean;
  production_ux_approval_gate: boolean;
  production_ux_tool_robustness: boolean;
  production_ux_progress_panel: boolean;
  production_ux_responsive_ui: boolean;
  production_ux_execution_modes: boolean;
  production_ux_steering: boolean;
  production_ux_hooks: boolean;
  production_ux_spec_workflow: boolean;
  production_ux_powers: boolean;
  production_ux_focus_mode: boolean;
  production_ux_streaming: boolean;
  production_ux_parallel_visibility: boolean;

  // ─── Unified Intent Gate & Efficiency Flags ─────────────────────
  unified_intent_gate: boolean;              // Master gate for intent gate subsystem
  intent_chip_ux: boolean;                   // Intent chip rendering
  spec_interview_engine: boolean;            // Spec interview engine
  spec_review_card: boolean;                 // Spec review card UX
  learning_loop: boolean;                    // Override-based learning
  context_condenser_v2: boolean;             // Enhanced context condenser
  prompt_cache_discipline: boolean;          // Provider cache optimization
  stuck_detector: boolean;                   // Pathological loop detection
  session_shell: boolean;                    // Persistent PTY sessions
  context_scoped_delegation: boolean;        // Envelope-based delegation
  trigger_gated_knowledge: boolean;          // Conditional knowledge injection
  trajectory_recording: boolean;             // Session export/replay
  efficiency_kpi_instrumentation: boolean;   // KPI metrics

  // ─── Platform Hardening Flags ─────────────────────────────────────
  kernel_sandbox: boolean;                   // Kernel-level process confinement (Landlock/Seatbelt)
  fast_worktree: boolean;                    // Native fast worktree creation/pooling (libgit2)

  // ─── GCF Expansion Flags ────────────────────────────────────────
  gcf_expanded_handoffs: boolean;            // Gates GCF on new handoff surfaces

  // ─── Enhanced Orchestration Flags ─────────────────────────────────
  quality_workers: boolean;                  // Background quality workers (testgaps, audit, bloat, etc.)

  // ─── Loop Engine & Harness Flags ────────────────────────────────
  harness_permission_patterns: boolean;      // Permission Pattern Engine for zero-prompt operation
  harness_hooks: boolean;                    // Deterministic pre/post tool-use hooks
  harness_subagents: boolean;                // Fresh-context verifier subagent dispatch
  harness_mcp_scoping: boolean;              // Workspace-scoped MCP configuration
  loops_enabled: boolean;                    // Master gate for loop execution mode
  loops_catalog_import: boolean;             // External catalog import pipeline
  loops_discover: boolean;                   // Loop discovery and suggestion
  loops_scheduler: boolean;                  // Cross-platform scheduled loop runs

  // ─── Knowledge Training Pipeline Flags ────────────────────────────
  neuronest_kb_system: boolean;              // Phase 1: Knowledgebase system
  neuronest_unsloth_bridge: boolean;         // Phase 2: Unsloth Bridge (independent)
  neuronest_training_pipeline: boolean;      // Phase 3: Training pipeline (requires Phase 2)
  neuronest_advanced_training: boolean;      // Phase 4: Advanced training (requires Phase 3)
  neuronest_training_enterprise: boolean;    // Phase 5: Enterprise training (requires Phase 3)

  // ─── Kilo-Inspired Feature Integration Flags ────────────────────
  inline_autocomplete: boolean;              // Ghost-text code completion (Phase 1)
  semantic_index: boolean;                   // Vector embedding codebase search (Phase 1)
  context_mentions: boolean;                 // @-reference system (Phase 1)
  speech_to_text: boolean;                   // Voice input transcription (Phase 1, requires voice_io)
  prompt_enhancement: boolean;               // Pre-pipeline prompt rewriting (Phase 2)
  commit_message_gen: boolean;               // Auto git commit messages (Phase 2)
  subagent_spawning: boolean;                // Dynamic subagent creation (Phase 2)
  worktree_agent_manager: boolean;           // Git worktree isolation (Phase 3, requires worktree_isolation)
  diff_viewer: boolean;                      // Turn-level diff & revert (Phase 3, requires diff_review)
  checkpoint_timeline: boolean;              // Visual checkpoint timeline (Phase 3, requires checkpoint)
  code_review_pipeline: boolean;             // Automated code review (Phase 3)
  network_sandbox: boolean;                  // Network access control (Phase 4)
  cost_controls: boolean;                    // Session budget enforcement (Phase 4, requires cost_tracking)
  background_processes: boolean;             // Persistent process management (Phase 4)
  interactive_terminal: boolean;             // Agent-controlled PTY (Phase 4)
  notebook_integration: boolean;             // Jupyter-compatible notebook (Phase 5)
  plugin_system: boolean;                    // Plugin discovery, loading, and management (Phase 5)
  session_portability: boolean;              // Session export/import/sharing (Phase 5)
  mcp_marketplace: boolean;                  // MCP Marketplace browsing & install (Phase 5)
  headless_cli: boolean;                     // Headless CLI entry point (requires headless_mode)
  adoption_dashboard: boolean;               // Adoption analytics dashboard (Phase 6)
  cloud_agent: boolean;                      // Cloud agent HTTP server & integrations (Phase 6, requires headless_mode)
  i18n_system: boolean;                      // Internationalization locale management (Phase 6)

  // ─── Multi-Repo Agent Integration Flags ─────────────────────────
  agent_catalog_import: boolean;             // Agent import pipeline from external repos
  devops_safety_layer: boolean;              // Policy engine + argv-only execution
  capability_grants: boolean;                // Time-limited grant system for dangerous ops
  audit_chain: boolean;                      // Tamper-evident SHA-256-linked event log
  budget_stop_loss: boolean;                 // Per-run + daily budget stop-loss controls
  scope_sandboxing: boolean;                 // Per-scope agent isolation enforcement
  background_workers: boolean;               // Cron/watch background task execution
  security_posture_config: boolean;          // Configurable security enforcement levels
  ops_dashboard: boolean;                    // Operations monitoring dashboard panel
  file_tree_panel: boolean;                  // File tree sidebar panel
  spec_viewer_panel: boolean;                // Spec document viewer panel
  enhanced_chat_renderer: boolean;           // VS Code-style chat formatting (legacy compatibility flag)
  structured_response_renderer: boolean;     // Typed composition surfaces for structured response rendering
  skill_git_import: boolean;                 // Git repository skill import
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
  provider_registry: true,
  test_planning: false,
  test_generation: false,
  test_drift_detection: false,
  test_health_analytics: false,
  verification_agent: false,
  enhanced_drift_classification: false,
  drift_aware_orchestration: false,

  // ─── Production UX Audit Flags ──────────────────────────────────
  production_ux_iteration_persistence: false,
  production_ux_action_first: true,
  production_ux_code_quality: false,
  production_ux_realtime_activity: false,
  production_ux_status_indicators: false,
  production_ux_file_tree_updates: false,
  production_ux_change_summary: false,
  production_ux_visual_diff: false,
  production_ux_error_quality: false,
  production_ux_loading_states: false,
  production_ux_approval_gate: false,
  production_ux_tool_robustness: false,
  production_ux_progress_panel: false,
  production_ux_responsive_ui: false,
  production_ux_execution_modes: false,
  production_ux_steering: false,
  production_ux_hooks: false,
  production_ux_spec_workflow: false,
  production_ux_powers: false,
  production_ux_focus_mode: false,
  production_ux_streaming: false,
  production_ux_parallel_visibility: false,

  // ─── Unified Intent Gate & Efficiency Flags ─────────────────────
  unified_intent_gate: false,
  intent_chip_ux: false,
  spec_interview_engine: false,
  spec_review_card: false,
  learning_loop: false,
  context_condenser_v2: true,
  prompt_cache_discipline: false,
  stuck_detector: false,
  session_shell: false,
  context_scoped_delegation: false,
  trigger_gated_knowledge: false,
  trajectory_recording: false,
  efficiency_kpi_instrumentation: false,

  // ─── Platform Hardening Flags ─────────────────────────────────────
  kernel_sandbox: false,
  fast_worktree: false,

  // ─── GCF Expansion Flags ────────────────────────────────────────
  gcf_expanded_handoffs: false,

  // ─── Enhanced Orchestration Flags ─────────────────────────────────
  quality_workers: false,

  // ─── Loop Engine & Harness Flags ────────────────────────────────
  harness_permission_patterns: true,
  harness_hooks: true,
  harness_subagents: true,
  harness_mcp_scoping: false,
  loops_enabled: true,
  loops_catalog_import: false,
  loops_discover: false,
  loops_scheduler: false,

  // ─── Knowledge Training Pipeline Flags ────────────────────────────
  neuronest_kb_system: envFlag('NEURONEST_KB_SYSTEM', false),
  neuronest_unsloth_bridge: envFlag('NEURONEST_UNSLOTH_BRIDGE', false),
  neuronest_training_pipeline: envFlag('NEURONEST_TRAINING_PIPELINE', false),
  neuronest_advanced_training: envFlag('NEURONEST_ADVANCED_TRAINING', false),
  neuronest_training_enterprise: envFlag('NEURONEST_TRAINING_ENTERPRISE', false),

  // ─── Kilo-Inspired Feature Integration Flags ────────────────────
  inline_autocomplete: false,
  semantic_index: false,
  context_mentions: false,
  speech_to_text: false,
  prompt_enhancement: false,
  commit_message_gen: false,
  subagent_spawning: false,
  worktree_agent_manager: false,
  diff_viewer: false,
  checkpoint_timeline: false,
  code_review_pipeline: false,
  network_sandbox: false,
  cost_controls: false,
  background_processes: false,
  interactive_terminal: false,
  notebook_integration: false,
  plugin_system: false,
  session_portability: false,
  mcp_marketplace: false,
  headless_cli: false,
  adoption_dashboard: false,
  cloud_agent: false,
  i18n_system: false,

  // ─── Multi-Repo Agent Integration Flags ─────────────────────────
  agent_catalog_import: true,
  devops_safety_layer: false,
  capability_grants: false,
  audit_chain: false,
  budget_stop_loss: false,
  scope_sandboxing: false,
  background_workers: false,
  security_posture_config: false,
  ops_dashboard: false,
  file_tree_panel: false,
  spec_viewer_panel: false,
  enhanced_chat_renderer: false,
  structured_response_renderer: false,
  skill_git_import: false,
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
  {
    feature: 'gcf_expanded_handoffs',
    requires: [],  // No hard FeatureGateFlags prerequisites
    // Note: requires GCF_WIRE_FORMAT in PERF_FLAGS, enforced at runtime
  },
  {
    feature: 'speech_to_text',
    requires: ['voice_io'],
  },
  {
    feature: 'worktree_agent_manager',
    requires: ['worktree_isolation'],
  },
  {
    feature: 'diff_viewer',
    requires: ['diff_review'],
  },
  {
    feature: 'checkpoint_timeline',
    requires: ['checkpoint'],
  },
  {
    feature: 'headless_cli',
    requires: ['headless_mode'],
  },
  {
    feature: 'cloud_agent',
    requires: ['headless_mode'],
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
  {
    feature: 'fast_worktree',
    requires: ['worktree_isolation'],
  },
];

/**
 * Loop Engine feature dependency declarations.
 *
 * - loops_enabled requires harness_permission_patterns AND harness_subagents
 * - loops_catalog_import requires loops_enabled
 * - loops_discover requires loops_enabled
 * - loops_scheduler requires loops_enabled
 *
 * Requirements: 15.1, 15.3
 */
export const LOOP_ENGINE_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'loops_enabled',
    requires: ['harness_permission_patterns', 'harness_subagents'],
  },
  {
    feature: 'loops_catalog_import',
    requires: ['loops_enabled'],
  },
  {
    feature: 'loops_discover',
    requires: ['loops_enabled'],
  },
  {
    feature: 'loops_scheduler',
    requires: ['loops_enabled'],
  },
];

/**
 * Knowledge Training Pipeline feature dependency declarations.
 *
 * - neuronest_unsloth_bridge has no dependencies (Phase 2 is independent)
 * - neuronest_training_pipeline requires neuronest_unsloth_bridge (Phase 3 requires Phase 2)
 * - neuronest_advanced_training requires neuronest_training_pipeline (Phase 4 requires Phase 3)
 * - neuronest_training_enterprise requires neuronest_training_pipeline (Phase 5 requires Phase 3)
 * - neuronest_kb_system has no dependencies (Phase 1 is independent)
 * Note: Phase 3 without Phase 1 = manual dataset mode (user-provided JSONL/CSV)
 *
 * Requirements: 25.1, 25.4
 */
export const KNOWLEDGE_TRAINING_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'neuronest_training_pipeline',
    requires: ['neuronest_unsloth_bridge'],
  },
  {
    feature: 'neuronest_advanced_training',
    requires: ['neuronest_training_pipeline'],
  },
  {
    feature: 'neuronest_training_enterprise',
    requires: ['neuronest_training_pipeline'],
  },
];

/**
 * Structured Response Renderer dependency declarations.
 *
 * - structured_response_renderer is incompatible with enhanced_chat_renderer
 *   because they cannot both select rendering surfaces simultaneously.
 *   enhanced_chat_renderer is retained only as a legacy compatibility flag
 *   and cannot silently activate canonical projection ownership.
 *
 * - enhanced_chat_renderer is incompatible with structured_response_renderer
 *   to prevent hidden ownership changes during rollout.
 *
 * Requirements: 2.4, 21.1, 21.6, 22.9
 */
export const STRUCTURED_RESPONSE_DEPENDENCIES: FeatureDependency[] = [
  {
    feature: 'structured_response_renderer',
    incompatible: ['enhanced_chat_renderer'],
  },
  {
    feature: 'enhanced_chat_renderer',
    incompatible: ['structured_response_renderer'],
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
