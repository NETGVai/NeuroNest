/**
 * SQL Table Name Allowlist
 *
 * Validates table names against a known set before interpolation into SQL queries.
 * Prevents SQL injection via dynamic table names in the agent-skills module.
 *
 * Requirements: 14.2
 */

/**
 * Custom error thrown when an invalid table name is used.
 */
export class InvalidTableNameError extends Error {
  public readonly tableName: string;

  constructor(tableName: string) {
    super(`Invalid table name: "${tableName}" is not in the allowed tables list`);
    this.name = 'InvalidTableNameError';
    this.tableName = tableName;
  }
}

/**
 * Complete set of known table names from the NeuroNest database schema.
 * Derived from all migration files (001–058) plus the schema_migrations table.
 */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  // Schema management
  'schema_migrations',

  // 001 - Initial schema
  'sessions',
  'messages',
  'agent_templates',
  'session_agents',
  'performance_records',
  'improvement_records',
  'execution_history',
  'token_usage',
  'permission_audit',
  'plugins',
  'config',
  'budget_alerts',
  'prompt_history',
  'flows',

  // 002 - Skills schema
  'skills',
  'skill_executions',
  'skill_routing_prefs',
  'catalog_skills',

  // 003 - Multica integration
  'agent_runtimes',
  'agent_tasks',
  'task_comments',
  'task_blockers',
  'agent_skill_assignments',
  'skill_learning_history',
  'runtime_health_logs',
  'agent_performance_analytics',
  'task_dependencies',
  'agent_workload',

  // 004 - Agent skills integration
  'skill_events',
  'agent_skills_config',
  'cache_entries',

  // 005 - Cost records
  'cost_records',

  // 006 - Security scans
  'scan_results',
  'scan_findings',
  'scan_exceptions',

  // 007 - Long term memory
  'long_term_memory',

  // 008 - Sandbox sessions
  'sandbox_sessions',

  // 009 - MCP servers
  'mcp_servers',

  // 010 - Memory FTS
  // (FTS virtual table extensions on long_term_memory)

  // 011 - Diff review
  'diff_reviews',
  'diff_annotations',
  'review_comments',

  // 012 - Multi session
  'chat_sessions',
  'chat_messages',
  'parallel_sessions',
  'parallel_messages',

  // 013 - Extensions
  'extensions',

  // 014 - New features
  'ai_readiness_scores',
  'session_telemetry',
  'kanban_columns',
  'kanban_cards',
  'shared_sessions',

  // 015 - Plandex features
  'model_packs',
  'autonomy_config',
  'plan_versions',
  'plan_branches',
  'context_selections',

  // 016 - Advanced features
  'context_items',
  'archived_plans',
  'decision_log',
  'completion_history',
  'quality_gates',

  // 017 - Remaining features
  'spec_config',
  'specifications',
  'steering_files',
  'tool_permissions',
  'runtime_config',
  'runtime_backends',
  'notification_config',
  'app_preferences',
  'onboarding_progress',

  // 018 - Goose features
  'recipes',
  'recipe_runs',
  'recipe_deeplinks',
  'exec_config',
  'exec_runs',

  // 019 - Sentrux features
  'ai_review_config',
  'ai_review_runs',
  'generated_tests',
  'test_drift_classifications',

  // 020 - SRE features
  'runbooks',
  'investigation_reports',
  'predictive_alerts',
  'session_alerts',

  // 021 - Helmor features
  'dangerous_commands',
  'command_policy_audit',
  'approval_decisions',
  'gateway_config',
  'gateway_audit_log',

  // 022 - Factory features
  'missions',
  'mission_workers',
  'trajectories',
  'artifacts',
  'artifact_checkpoints',

  // 023 - Coder features
  'races',
  'race_participants',
  'best_of_n_config',
  'best_of_n_runs',
  'lint_test_config',
  'lint_test_runs',

  // 024 - Grounding audit
  'grounding_audit',
  'evidence_citations',
  'interview_transcripts',

  // 025 - Incremental indexing
  'embeddings',
  'chunks',
  'search_index',
  'semantic_chunks',
  'call_graph_nodes',
  'call_graph_edges',
  'file_provenance',

  // 026 - Chat messages overflow
  'chat_messages_overflow',

  // 027 - Runtime sandbox guardrails
  'session_budget_limits',
  'session_cost_records',
  'turn_limits',

  // 028 - Error size samples
  'error_size_samples',

  // 029 - Pipeline events
  'pipeline_events',
  'pipeline_traces',
  'pipeline_spans',

  // 030 - Metric samples
  'metric_samples',

  // 031 - Error size samples backfill
  // (ALTER TABLE only, no new tables)

  // 032 - Spec message mode
  'message_mode_config',
  'message_mode_config_new',
  'message_queue',
  'message_queue_new',

  // 033 - Secrets v2
  'secrets_v2',
  'encrypted_shares',

  // 034 - Multi chat sessions
  'session_status',
  'file_session_links',

  // 035 - Agent loop metrics
  'loop_runs',
  'loop_passes',
  'loop_specs',
  'stuck_events',

  // 036 - Feature integration
  'execution_traces',
  'test_plans',
  'test_executions',
  'test_gaps',

  // 037 - Trace provenance columns
  'trace_entries',

  // 038 - NeuroNest enhanced
  'lineage',
  'rewind_checkpoints',
  'workspace_snapshots',
  'workspace_forks',
  'sharing_config',
  'provider_usage',
  'prompt_cache',
  'compression_stats',
  'condensation_log',
  'context_compactions',
  'subagent_tasks',
  'task_executions',

  // 039 - Production UX audit
  'config_profiles',
  'session_exports',
  'benchmark_runs',
  'benchmark_results',
  'change_tracking',

  // 040 - Unified intent gate
  'intent_decisions',
  'response_schemas',

  // 041 - Loop storage
  'learned_patterns',
  'transformation_cache',

  // 042 - Accessibility friction
  'accessibility_friction',

  // 043 - Semantic index
  // (virtual FTS tables and extensions)

  // 044 - Worktree sessions
  'worktree_sessions',
  'worktree_snapshots',
  'git_worktrees',

  // 045 - Code reviews
  'code_reviews',

  // 046 - Background processes
  'background_processes',
  'browser_tabs',

  // 047 - Network policy log
  'network_requests',

  // 048 - Session exports
  // (already covered in 039)

  // 049 - Plugin system
  'integration_validations',

  // 050 - Adoption metrics
  'adoption_metrics',
  'efficiency_kpis',
  'wiki_pages',
  'wiki_generations',
  'wiki_config',
  'qa_config',
  'qa_runs',

  // 051 - MCP marketplace
  'mcp_catalog',
  'mcp_catalog_meta',
  'mcp_installations',
  'mcp_oauth_tokens',

  // 052 - Diff turns
  'diff_turns',
  'diff_turn_files',

  // 053 - Feature gate store
  'feature_gate_config',
  'feature_gate_audit',

  // 054 - Remembered grants
  'remembered_grants',

  // 055 - Hook definitions v2
  'hook_definitions_v2',
  'hook_executions_v2',
  'hook_executions',

  // 056 - Cross session memory
  'cross_session_memory',

  // 057 - Dispatch source
  // (ALTER TABLE only, adds column to pipeline_events)

  // 058 - GCF context
  'gcf_context_entries',
  'gcf_symbols',
  'gcf_embeddings',
  'gcf_code_edges',
  'gcf_dependency_map',
  'gcf_edit_history',
  'gcf_drift_events',

  // 059 - Knowledge Base system
  'kb_sources',
  'kb_chunk_metadata',
  'kb_freshness',
  'kb_embedding_config',

  // 060 - Training pipeline
  'training_jobs',
  'training_checkpoints',
  'training_metrics',

  // 061 - Model export and GRPO
  'training_models',
  'grpo_preferences',
  'training_datasets',

  // 062 - Enterprise training
  'training_schedules',
  'training_effectiveness',
  'training_cloud_jobs',

  // Additional tables from other migrations
  'adversary_reviews',
  'arch_evolution',
  'arch_quality_scores',
  'arch_rules',
  'ci_check_runs',
  'ci_checks',
  'drift_recovery_attempts',
  'personas',
]);

/**
 * Validates whether a table name is in the allowed set.
 *
 * @param name - The table name to validate
 * @returns true if the table name is allowed, false otherwise
 */
export function validateTableName(name: string): boolean {
  return ALLOWED_TABLES.has(name);
}

/**
 * Validates a table name and returns it if valid, otherwise throws.
 * Use this before interpolating a dynamic table name into a SQL query.
 *
 * @param name - The table name to sanitize
 * @returns The validated table name (unchanged)
 * @throws InvalidTableNameError if the name is not in the allowlist
 */
export function sanitizeTableName(name: string): string {
  if (!ALLOWED_TABLES.has(name)) {
    throw new InvalidTableNameError(name);
  }
  return name;
}
