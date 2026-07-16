/**
 * Feature Gate Metadata — per-flag descriptions, stability levels, and groups.
 *
 * Provides the human-readable metadata surfaced by the `feature-gate:get-all`
 * IPC channel for the Feature Management UI panel.
 *
 * Requirements: 2.1, 2.2, 2.3
 */

import type { FeatureGateFlags } from './feature-gate-config.js';

export type FlagStability = 'stable' | 'beta' | 'experimental' | 'deprecated';
export type FlagGroup =
  | 'execution'
  | 'automation'
  | 'intelligence'
  | 'quality'
  | 'security'
  | 'extensions'
  | 'runtime'
  | 'experimental';

export interface FlagMetadata {
  description: string;
  stability: FlagStability;
  group: FlagGroup;
}

/**
 * Metadata for every feature flag. Keys must match FeatureGateFlags.
 */
export const FEATURE_FLAG_METADATA: Record<keyof FeatureGateFlags, FlagMetadata> = {
  // ─── Execution ────────────────────────────────────────────────
  cost_tracking: { description: 'Track token usage and costs per project/provider', stability: 'stable', group: 'execution' },
  checkpoint: { description: 'Workspace snapshot and restore points', stability: 'stable', group: 'execution' },
  worktree_isolation: { description: 'Git worktree-based process isolation', stability: 'stable', group: 'execution' },
  ast_locking: { description: 'AST-level file locking for concurrent edits', stability: 'beta', group: 'execution' },
  parallel_agents: { description: 'Multi-agent parallel execution', stability: 'beta', group: 'execution' },
  headless_mode: { description: 'CLI-only operation without GUI', stability: 'stable', group: 'execution' },
  headless_cli: { description: 'Headless CLI entry point', stability: 'beta', group: 'execution' },
  background_processes: { description: 'Persistent background process management', stability: 'beta', group: 'execution' },
  interactive_terminal: { description: 'Agent-controlled PTY terminal', stability: 'beta', group: 'execution' },

  // ─── Automation ───────────────────────────────────────────────
  scheduled_tasks: { description: 'Cron-style scheduled task execution', stability: 'stable', group: 'automation' },
  loops_enabled: { description: 'Loop Engine execution mode', stability: 'stable', group: 'automation' },
  loops_catalog_import: { description: 'External loop catalog import', stability: 'beta', group: 'automation' },
  loops_discover: { description: 'Loop discovery and suggestion', stability: 'experimental', group: 'automation' },
  loops_scheduler: { description: 'Cross-platform scheduled loop runs', stability: 'experimental', group: 'automation' },
  harness_permission_patterns: { description: 'Permission pattern engine for zero-prompt operation', stability: 'beta', group: 'automation' },
  harness_hooks: { description: 'Deterministic pre/post tool-use hooks', stability: 'beta', group: 'automation' },
  harness_subagents: { description: 'Fresh-context verifier subagent dispatch', stability: 'beta', group: 'automation' },
  harness_mcp_scoping: { description: 'Workspace-scoped MCP configuration', stability: 'beta', group: 'automation' },
  quality_workers: { description: 'Background quality workers (testgaps, audit, bloat)', stability: 'experimental', group: 'automation' },

  // ─── Intelligence ─────────────────────────────────────────────
  model_routing: { description: 'Smart model selection and routing', stability: 'stable', group: 'intelligence' },
  provider_failover: { description: 'Automatic provider failover on errors', stability: 'stable', group: 'intelligence' },
  provider_registry: { description: 'Formal provider registry with adapters', stability: 'stable', group: 'intelligence' },
  dependency_grounding: { description: 'Graph-grounded responses to reduce hallucination', stability: 'beta', group: 'intelligence' },
  memory_persistence: { description: 'Cross-session memory recall', stability: 'beta', group: 'intelligence' },
  lsp_intelligence: { description: 'LSP-backed code intelligence', stability: 'beta', group: 'intelligence' },
  completion_council: { description: 'Multi-agent completion consensus', stability: 'beta', group: 'intelligence' },
  self_improvement: { description: 'Skill learning from execution traces', stability: 'experimental', group: 'intelligence' },
  backpropagation: { description: 'Self-improvement via feedback propagation', stability: 'experimental', group: 'intelligence' },
  inline_autocomplete: { description: 'Ghost-text inline code completion', stability: 'beta', group: 'intelligence' },
  semantic_index: { description: 'Vector embedding codebase search', stability: 'beta', group: 'intelligence' },
  context_mentions: { description: '@-reference context system', stability: 'beta', group: 'intelligence' },
  prompt_enhancement: { description: 'Pre-pipeline prompt rewriting', stability: 'beta', group: 'intelligence' },
  commit_message_gen: { description: 'AI-generated git commit messages', stability: 'stable', group: 'intelligence' },
  context_condenser_v2: { description: 'Enhanced four-block context condensation', stability: 'stable', group: 'intelligence' },

  // ─── Quality ──────────────────────────────────────────────────
  trace_visualization: { description: 'Pipeline trace inspector', stability: 'stable', group: 'quality' },
  diff_review: { description: 'Visual diff review system', stability: 'beta', group: 'quality' },
  diff_viewer: { description: 'Turn-level diff and revert', stability: 'beta', group: 'quality' },
  checkpoint_timeline: { description: 'Visual checkpoint timeline', stability: 'beta', group: 'quality' },
  code_review_pipeline: { description: 'Automated code review pipeline', stability: 'beta', group: 'quality' },
  test_planning: { description: 'AI-assisted test planning', stability: 'experimental', group: 'quality' },
  test_generation: { description: 'Automated test generation', stability: 'experimental', group: 'quality' },
  test_drift_detection: { description: 'Test coverage drift detection', stability: 'experimental', group: 'quality' },
  test_health_analytics: { description: 'Test health monitoring and analytics', stability: 'experimental', group: 'quality' },
  verification_agent: { description: 'Dedicated verification agent flow', stability: 'experimental', group: 'quality' },
  enhanced_drift_classification: { description: 'Enhanced drift signal classification', stability: 'experimental', group: 'quality' },
  drift_aware_orchestration: { description: 'Drift-aware orchestration with recovery', stability: 'experimental', group: 'quality' },
  repo_readiness: { description: 'AI readiness score for repositories', stability: 'stable', group: 'quality' },
  compliance_gates: { description: 'Architecture compliance gate checks', stability: 'beta', group: 'quality' },

  // ─── Security ─────────────────────────────────────────────────
  vulnerability_blocking: { description: 'Block known vulnerable patterns', stability: 'stable', group: 'security' },
  credential_vault: { description: 'Secure credential storage via OS keychain', stability: 'stable', group: 'security' },
  supply_chain_detection: { description: 'Dependency supply-chain attack detection', stability: 'beta', group: 'security' },
  sandbox: { description: 'Kernel-level process confinement', stability: 'beta', group: 'security' },
  wasm_sandbox: { description: 'WASM-based process confinement', stability: 'experimental', group: 'security' },
  network_sandbox: { description: 'Network access control policies', stability: 'beta', group: 'security' },
  runtimesecurity_hackability_scoring: { description: 'Runtime hackability scoring', stability: 'experimental', group: 'security' },
  runtimesecurity_threat_modeling: { description: 'Automated threat modeling', stability: 'experimental', group: 'security' },
  runtimesecurity_realtime_analysis: { description: 'Real-time security analysis', stability: 'experimental', group: 'security' },
  runtimesecurity_attack_path_mapping: { description: 'Attack path mapping from findings', stability: 'experimental', group: 'security' },
  runtimesecurity_evidence_store: { description: 'Security evidence collection and storage', stability: 'experimental', group: 'security' },
  runtimesecurity_ai_security_rules: { description: 'AI-powered security rule generation', stability: 'experimental', group: 'security' },

  // ─── Extensions ───────────────────────────────────────────────
  skill_creation: { description: 'Create and publish agent skills', stability: 'stable', group: 'extensions' },
  specialist_roles: { description: 'Specialist agent roles and personas', stability: 'stable', group: 'extensions' },
  plugin_system: { description: 'Plugin discovery, loading, and management', stability: 'beta', group: 'extensions' },
  mcp_marketplace: { description: 'MCP server marketplace browsing and install', stability: 'beta', group: 'extensions' },
  subagent_spawning: { description: 'Dynamic subagent creation', stability: 'beta', group: 'extensions' },
  notebook_integration: { description: 'Jupyter-compatible notebook execution', stability: 'experimental', group: 'extensions' },

  // ─── Runtime ──────────────────────────────────────────────────
  remote_access: { description: 'Remote API access for external tools', stability: 'beta', group: 'runtime' },
  voice_io: { description: 'Voice input and text-to-speech output', stability: 'beta', group: 'runtime' },
  speech_to_text: { description: 'Voice input transcription', stability: 'beta', group: 'runtime' },
  kanban_board: { description: 'Visual kanban project board', stability: 'stable', group: 'runtime' },
  browser_automation: { description: 'Headless browser automation', stability: 'experimental', group: 'runtime' },
  provenance_tracking: { description: 'File change provenance tracking', stability: 'beta', group: 'runtime' },
  session_portability: { description: 'Session export/import/sharing', stability: 'experimental', group: 'runtime' },
  cost_controls: { description: 'Session-level budget enforcement', stability: 'beta', group: 'runtime' },
  worktree_agent_manager: { description: 'Git worktree agent manager', stability: 'experimental', group: 'runtime' },
  cloud_agent: { description: 'Cloud agent HTTP server and integrations', stability: 'experimental', group: 'runtime' },
  i18n_system: { description: 'Internationalization locale management', stability: 'experimental', group: 'runtime' },
  adoption_dashboard: { description: 'Adoption analytics dashboard', stability: 'experimental', group: 'runtime' },

  // ─── Experimental ─────────────────────────────────────────────
  agent_racing: { description: 'Agent racing for best-of-N selection', stability: 'experimental', group: 'experimental' },
  session_forking: { description: 'Fork sessions into parallel branches', stability: 'experimental', group: 'experimental' },
  worktree_checkpoints: { description: 'Worktree-integrated checkpoint management', stability: 'experimental', group: 'experimental' },
  agent_status_feed: { description: 'Real-time agent status feed', stability: 'beta', group: 'experimental' },

  // ─── Production UX Flags ──────────────────────────────────────
  production_ux_iteration_persistence: { description: 'Persist iteration state across sessions', stability: 'beta', group: 'runtime' },
  production_ux_action_first: { description: 'Action-first UI pattern', stability: 'stable', group: 'runtime' },
  production_ux_code_quality: { description: 'Code quality indicators in UI', stability: 'beta', group: 'quality' },
  production_ux_realtime_activity: { description: 'Real-time activity indicators', stability: 'beta', group: 'runtime' },
  production_ux_status_indicators: { description: 'Agent status indicators', stability: 'beta', group: 'runtime' },
  production_ux_file_tree_updates: { description: 'Live file tree update notifications', stability: 'stable', group: 'runtime' },
  production_ux_change_summary: { description: 'Change summary after operations', stability: 'beta', group: 'runtime' },
  production_ux_visual_diff: { description: 'Visual diff display in UI', stability: 'beta', group: 'quality' },
  production_ux_error_quality: { description: 'High-quality error messages', stability: 'stable', group: 'runtime' },
  production_ux_loading_states: { description: 'Proper loading state indicators', stability: 'stable', group: 'runtime' },
  production_ux_approval_gate: { description: 'User approval gate for destructive ops', stability: 'stable', group: 'security' },
  production_ux_tool_robustness: { description: 'Robust tool error handling', stability: 'stable', group: 'execution' },
  production_ux_progress_panel: { description: 'Detailed progress panel during execution', stability: 'beta', group: 'runtime' },
  production_ux_responsive_ui: { description: 'Responsive UI layout adaptations', stability: 'stable', group: 'runtime' },
  production_ux_execution_modes: { description: 'Execution mode selection UI', stability: 'beta', group: 'execution' },
  production_ux_steering: { description: 'Steering file management UI', stability: 'beta', group: 'runtime' },
  production_ux_hooks: { description: 'Hooks management UI', stability: 'beta', group: 'automation' },
  production_ux_spec_workflow: { description: 'Specification workflow UI', stability: 'beta', group: 'runtime' },
  production_ux_powers: { description: 'Powers management UI', stability: 'beta', group: 'extensions' },
  production_ux_focus_mode: { description: 'Distraction-free focus mode', stability: 'beta', group: 'runtime' },
  production_ux_streaming: { description: 'Token streaming display', stability: 'stable', group: 'runtime' },
  production_ux_parallel_visibility: { description: 'Parallel agent visibility in UI', stability: 'beta', group: 'execution' },

  // ─── Unified Intent Gate & Efficiency ─────────────────────────
  unified_intent_gate: { description: 'Unified intent classification gate', stability: 'beta', group: 'intelligence' },
  intent_chip_ux: { description: 'Intent chip UI rendering', stability: 'beta', group: 'intelligence' },
  spec_interview_engine: { description: 'Specification interview engine', stability: 'beta', group: 'intelligence' },
  spec_review_card: { description: 'Spec review card UX', stability: 'beta', group: 'intelligence' },
  learning_loop: { description: 'Override-based learning from user corrections', stability: 'experimental', group: 'intelligence' },
  prompt_cache_discipline: { description: 'Provider prompt cache optimization', stability: 'beta', group: 'intelligence' },
  stuck_detector: { description: 'Pathological loop detection', stability: 'beta', group: 'automation' },
  session_shell: { description: 'Persistent PTY sessions', stability: 'experimental', group: 'execution' },
  context_scoped_delegation: { description: 'Envelope-based context delegation', stability: 'experimental', group: 'intelligence' },
  trigger_gated_knowledge: { description: 'Conditional knowledge injection', stability: 'experimental', group: 'intelligence' },
  trajectory_recording: { description: 'Session export and replay recording', stability: 'experimental', group: 'quality' },
  efficiency_kpi_instrumentation: { description: 'KPI metric instrumentation', stability: 'experimental', group: 'quality' },

  // ─── GCF Expansion ────────────────────────────────────────────
  gcf_expanded_handoffs: { description: 'GCF on new handoff surfaces', stability: 'experimental', group: 'intelligence' },

  // ─── Native Modules (Platform Hardening) ──────────────────────
  kernel_sandbox: { description: 'OS-level process confinement (Landlock/Seatbelt)', stability: 'experimental', group: 'security' },
  fast_worktree: { description: 'Native CoW worktree creation and pooling', stability: 'experimental', group: 'execution' },
};
