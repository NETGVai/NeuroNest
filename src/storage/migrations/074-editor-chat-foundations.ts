/**
 * Editor Chat Enhancement Foundations: Versioned schemas, stable identities,
 * fingerprints, and transactional outbox for planning, runs, changes, timeline,
 * evidence, catalog lifecycle, disclosure, and release records.
 *
 * This migration is idempotent (uses IF NOT EXISTS) and does not replace
 * existing stores. All tables include:
 * - Stable entity IDs (TEXT UUIDs)
 * - Canonical serialization fingerprints
 * - Optimistic version fields
 * - Tombstone support where applicable
 * - Audit fields (created_at, updated_at, created_by, updated_by)
 *
 * The domain_events table implements a transactional outbox pattern with
 * replay-safe event IDs and recovery for partially written session records.
 *
 * Requirements: 11.1, 11.3, 11.8, 11.9, 11.10, 15.7, 22.1, 22.2, 22.6, 27.1, 28.5
 */
import type Database from 'better-sqlite3';

export const version = 74;
export const description = 'Editor chat enhancement foundations: versioned schemas, stable identities, fingerprints, and transactional outbox';

export function up(db: Database.Database): void {
  // ═══════════════════════════════════════════════════════════════
  // Planning and Execution Tables
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('requirement', 'design', 'task_list')),
      source_hash TEXT NOT NULL,
      parse_version INTEGER NOT NULL DEFAULT 1,
      indexed_revision TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS planning_entities (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES planning_sources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('requirement', 'design_node', 'acceptance_criterion', 'section')),
      title TEXT,
      source_range_start INTEGER,
      source_range_end INTEGER,
      source_fingerprint TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS planning_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      entity_id TEXT REFERENCES planning_entities(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready', 'queued', 'running', 'completed', 'failed', 'blocked', 'needs_review', 'cancelled')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
      risk TEXT DEFAULT 'medium' CHECK(risk IN ('high', 'medium', 'low')),
      objective TEXT,
      acceptance_criteria TEXT,
      scope_boundaries TEXT,
      dependencies TEXT,
      validation_strategy TEXT,
      readiness_fingerprint TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS trace_links (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relationship TEXT NOT NULL CHECK(relationship IN ('satisfies', 'implements', 'depends_on', 'produced_by', 'verified_by', 'traces_to', 'derived_from')),
      cardinality TEXT DEFAULT 'many_to_many' CHECK(cardinality IN ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT REFERENCES planning_tasks(id) ON DELETE SET NULL,
      parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      agent_id TEXT NOT NULL,
      model_route TEXT,
      workspace_path TEXT,
      worktree_path TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'preparing', 'running', 'awaiting_approval', 'validating', 'review_required', 'completed', 'blocked', 'failed', 'cancelled', 'paused')),
      started_at TEXT,
      finished_at TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_loops (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      current_stage TEXT NOT NULL DEFAULT 'planning' CHECK(current_stage IN ('planning', 'context_collection', 'implementation', 'targeted_validation', 'diagnosis', 'remediation', 'broader_validation', 'review', 'completion')),
      plan_fingerprint TEXT,
      input_fingerprint TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      recovery_status TEXT DEFAULT 'none' CHECK(recovery_status IN ('none', 'pending', 'recovering', 'recovered', 'failed')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS orchestration_stages (
      id TEXT PRIMARY KEY,
      delivery_loop_id TEXT NOT NULL REFERENCES delivery_loops(id) ON DELETE CASCADE,
      stage_name TEXT NOT NULL,
      stage_order INTEGER NOT NULL,
      topology TEXT CHECK(topology IN ('pipeline', 'fan_out_fan_in', 'expert_pool', 'producer_reviewer', 'supervisor', 'hierarchical_delegation')),
      dependency_ids TEXT,
      stage_fingerprint TEXT,
      qa_state TEXT DEFAULT 'pending' CHECK(qa_state IN ('pending', 'passing', 'failing', 'skipped')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS artifact_contracts (
      id TEXT PRIMARY KEY,
      stage_id TEXT NOT NULL REFERENCES orchestration_stages(id) ON DELETE CASCADE,
      owner_agent_id TEXT NOT NULL,
      schema_ref TEXT,
      artifact_version TEXT,
      acceptance_checks TEXT,
      destination TEXT,
      failure_handling TEXT DEFAULT 'block' CHECK(failure_handling IN ('block', 'retry', 'skip', 'escalate')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Changes, Timeline, and Evidence Tables
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_sets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT REFERENCES planning_tasks(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      chat_event_id TEXT,
      base_revision TEXT,
      state TEXT NOT NULL DEFAULT 'streaming' CHECK(state IN ('streaming', 'incomplete', 'ready', 'reviewing', 'accepted', 'applying', 'applied', 'rejected', 'conflicted', 'failed')),
      operations_json TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS change_operations (
      id TEXT PRIMARY KEY,
      change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create', 'modify', 'rename', 'move', 'delete')),
      target_uri TEXT NOT NULL,
      source_uri TEXT,
      base_hash TEXT,
      base_version INTEGER,
      proposed_blob_ref TEXT,
      operation_order INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS change_hunks (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES change_operations(id) ON DELETE CASCADE,
      hunk_order INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_ref TEXT,
      review_state TEXT DEFAULT 'pending' CHECK(review_state IN ('pending', 'accepted', 'rejected')),
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_decisions (
      id TEXT PRIMARY KEY,
      change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('hunk', 'file', 'change_set')),
      target_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accept', 'reject')),
      reviewer TEXT,
      rationale TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS change_transaction_journals (
      id TEXT PRIMARY KEY,
      change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'applying', 'committed', 'rolling_back', 'rolled_back', 'failed')),
      pre_fingerprint TEXT NOT NULL,
      post_fingerprint TEXT,
      inverse_payload_ref TEXT,
      workspace_lease_id TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Timeline Events
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES planning_tasks(id) ON DELETE SET NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_ref TEXT,
      correlation_id TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Evidence and Release Tables
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      workspace_revision TEXT,
      task_id TEXT REFERENCES planning_tasks(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
      producer_kind TEXT NOT NULL CHECK(producer_kind IN ('tool', 'user', 'service')),
      producer_id TEXT NOT NULL,
      producer_version TEXT,
      environment_fingerprint TEXT,
      started_at TEXT,
      finished_at TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass', 'fail', 'blocked', 'cancelled', 'stale', 'waived')),
      summary TEXT,
      payload_ref TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS release_candidates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft', 'evaluating', 'ready', 'blocked', 'released', 'abandoned')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS readiness_gates (
      id TEXT PRIMARY KEY,
      release_candidate_id TEXT NOT NULL REFERENCES release_candidates(id) ON DELETE CASCADE,
      gate_kind TEXT NOT NULL,
      evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'pass', 'fail', 'waived', 'stale', 'not_applicable')),
      required INTEGER NOT NULL DEFAULT 1,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS waivers (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL REFERENCES readiness_gates(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      scope TEXT,
      review_date TEXT,
      expiry_date TEXT,
      compensating_control TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_leases (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      worktree_path TEXT,
      owner_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      write_scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Catalog Lifecycle Tables
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('local', 'remote', 'generated', 'imported')),
      uri TEXT NOT NULL,
      revision TEXT,
      last_checked_at TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS catalog_staging_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      raw_count INTEGER,
      parsed_count INTEGER,
      recovered_count INTEGER,
      quarantined_count INTEGER,
      reconciled_count INTEGER,
      effective_count INTEGER,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS import_candidates (
      id TEXT PRIMARY KEY,
      staging_run_id TEXT NOT NULL REFERENCES catalog_staging_runs(id) ON DELETE CASCADE,
      external_asset_id TEXT,
      asset_kind TEXT NOT NULL CHECK(asset_kind IN ('agent', 'orchestrator_skill', 'extension_skill', 'domain_skill')),
      raw_blob_ref TEXT,
      state TEXT NOT NULL DEFAULT 'raw' CHECK(state IN ('raw', 'parsed', 'recovered', 'normalized', 'duplicate_reviewed', 'validated', 'approval_pending', 'published', 'quarantined')),
      quarantine_reason TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS transformation_attempts (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES import_candidates(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      transform_version TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      output_fingerprint TEXT,
      actions_json TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      diagnostics TEXT,
      tokens_used INTEGER,
      cost_cents INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS external_asset_identities (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES import_candidates(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      source_commit TEXT,
      source_path TEXT,
      blob_hash TEXT,
      byte_hash TEXT,
      canonical_hash TEXT,
      license_spdx TEXT,
      notice_text TEXT,
      parser_version TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS duplicate_candidates (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES import_candidates(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL,
      match_stage TEXT NOT NULL CHECK(match_stage IN ('external_asset_id', 'local_id', 'canonical_hash', 'normalized_name', 'deterministic_signature', 'semantic_shortlist')),
      confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
      evidence_json TEXT,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reconciliation_decisions (
      id TEXT PRIMARY KEY,
      duplicate_candidate_id TEXT NOT NULL REFERENCES duplicate_candidates(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('merge', 'keep_separate', 'manual_review', 'reject')),
      effective_target_id TEXT,
      actor TEXT NOT NULL,
      rationale TEXT,
      input_fingerprint TEXT NOT NULL,
      result_fingerprint TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Skill Manifests, Assets, Evaluations, Snapshots, Tombstones
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_manifests (
      id TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      skill_type TEXT NOT NULL CHECK(skill_type IN ('orchestrator', 'extension', 'domain')),
      triggers_json TEXT,
      exclusions_json TEXT,
      capabilities_json TEXT,
      tools_json TEXT,
      permissions_json TEXT,
      compatibility_json TEXT,
      provenance_json TEXT,
      catalog_snapshot_id TEXT,
      state TEXT NOT NULL DEFAULT 'inactive' CHECK(state IN ('inactive', 'active', 'deprecated', 'quarantined')),
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      is_tombstone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT,
      UNIQUE(canonical_id, version)
    );

    CREATE TABLE IF NOT EXISTS skill_assets (
      id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL REFERENCES skill_manifests(id) ON DELETE CASCADE,
      asset_level INTEGER NOT NULL CHECK(asset_level IN (2, 3)),
      asset_kind TEXT NOT NULL CHECK(asset_kind IN ('body', 'reference', 'script', 'template', 'example')),
      content_ref TEXT NOT NULL,
      declared_fingerprint TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_evaluations (
      id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL REFERENCES skill_manifests(id) ON DELETE CASCADE,
      evaluation_version TEXT NOT NULL,
      fixtures_fingerprint TEXT NOT NULL,
      environment_fingerprint TEXT NOT NULL,
      precision_score REAL,
      recall_score REAL,
      false_activation_rate REAL,
      latency_ms INTEGER,
      tokens_used INTEGER,
      cost_cents INTEGER,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass', 'fail', 'blocked')),
      details_ref TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS catalog_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_version INTEGER NOT NULL,
      effective INTEGER NOT NULL DEFAULT 0,
      manifest_ids_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS catalog_tombstones (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('skill', 'agent', 'source', 'candidate')),
      entity_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      predecessor_snapshot_id TEXT REFERENCES catalog_snapshots(id) ON DELETE SET NULL,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_by TEXT
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Disclosure Events and Prompt Manifests
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS disclosure_events (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      manifest_id TEXT REFERENCES skill_manifests(id) ON DELETE SET NULL,
      disclosure_level INTEGER NOT NULL CHECK(disclosure_level IN (1, 2, 3)),
      action TEXT NOT NULL CHECK(action IN ('load', 'unload', 'block', 'pin', 'exclude')),
      reason TEXT,
      token_count INTEGER,
      provenance_ref TEXT,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prompt_manifests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      task_fingerprint TEXT NOT NULL,
      catalog_fingerprint TEXT NOT NULL,
      bundle_fingerprint TEXT NOT NULL,
      content_order_json TEXT NOT NULL,
      omissions_json TEXT,
      total_tokens INTEGER,
      fingerprint TEXT NOT NULL,
      optimistic_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Transactional Outbox: Domain Events
  // ═══════════════════════════════════════════════════════════════
  // The domain_events table implements the transactional outbox pattern.
  // Events are written atomically with their source state transition.
  // A publisher reads unpublished events in order and marks them published.
  // Replay-safe event IDs prevent duplicate processing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      session_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(aggregate_type, aggregate_id, sequence)
    );
  `);

  // ═══════════════════════════════════════════════════════════════
  // Indexes
  // ═══════════════════════════════════════════════════════════════
  db.exec(`
    -- Planning indexes
    CREATE INDEX IF NOT EXISTS idx_planning_sources_workspace ON planning_sources(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_planning_entities_source ON planning_entities(source_id);
    CREATE INDEX IF NOT EXISTS idx_planning_entities_workspace ON planning_entities(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_planning_tasks_workspace ON planning_tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_planning_tasks_status ON planning_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_trace_links_source ON trace_links(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_trace_links_target ON trace_links(target_entity_id);

    -- Run indexes
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_state ON agent_runs(state);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_loops_run ON delivery_loops(run_id);

    -- Change indexes
    CREATE INDEX IF NOT EXISTS idx_change_sets_workspace ON change_sets(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_change_sets_run ON change_sets(run_id);
    CREATE INDEX IF NOT EXISTS idx_change_sets_state ON change_sets(state);
    CREATE INDEX IF NOT EXISTS idx_change_operations_set ON change_operations(change_set_id);
    CREATE INDEX IF NOT EXISTS idx_change_hunks_operation ON change_hunks(operation_id);

    -- Timeline indexes
    CREATE INDEX IF NOT EXISTS idx_timeline_events_session_seq ON timeline_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_run ON timeline_events(run_id);

    -- Evidence indexes
    CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence(workspace_id);

    -- Release indexes
    CREATE INDEX IF NOT EXISTS idx_readiness_gates_rc ON readiness_gates(release_candidate_id);

    -- Catalog indexes
    CREATE INDEX IF NOT EXISTS idx_import_candidates_staging ON import_candidates(staging_run_id);
    CREATE INDEX IF NOT EXISTS idx_import_candidates_state ON import_candidates(state);
    CREATE INDEX IF NOT EXISTS idx_external_asset_identities_candidate ON external_asset_identities(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_external_asset_identities_ext_id ON external_asset_identities(external_id);
    CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_candidate ON duplicate_candidates(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_skill_manifests_canonical ON skill_manifests(canonical_id);
    CREATE INDEX IF NOT EXISTS idx_skill_assets_manifest ON skill_assets(manifest_id);
    CREATE INDEX IF NOT EXISTS idx_skill_evaluations_manifest ON skill_evaluations(manifest_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_tombstones_entity ON catalog_tombstones(entity_type, entity_id);

    -- Disclosure indexes
    CREATE INDEX IF NOT EXISTS idx_disclosure_events_run ON disclosure_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_prompt_manifests_run ON prompt_manifests(run_id);

    -- Domain events outbox indexes
    CREATE INDEX IF NOT EXISTS idx_domain_events_unpublished ON domain_events(published, created_at) WHERE published = 0;
    CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate ON domain_events(aggregate_type, aggregate_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_domain_events_correlation ON domain_events(correlation_id);
  `);
}

/**
 * Reverse migration: drops all tables and indexes added by this migration.
 */
export function down(db: Database.Database): void {
  db.exec(`
    -- Drop indexes
    DROP INDEX IF EXISTS idx_planning_sources_workspace;
    DROP INDEX IF EXISTS idx_planning_entities_source;
    DROP INDEX IF EXISTS idx_planning_entities_workspace;
    DROP INDEX IF EXISTS idx_planning_tasks_workspace;
    DROP INDEX IF EXISTS idx_planning_tasks_status;
    DROP INDEX IF EXISTS idx_trace_links_source;
    DROP INDEX IF EXISTS idx_trace_links_target;
    DROP INDEX IF EXISTS idx_agent_runs_task;
    DROP INDEX IF EXISTS idx_agent_runs_state;
    DROP INDEX IF EXISTS idx_agent_runs_workspace;
    DROP INDEX IF EXISTS idx_delivery_loops_run;
    DROP INDEX IF EXISTS idx_change_sets_workspace;
    DROP INDEX IF EXISTS idx_change_sets_run;
    DROP INDEX IF EXISTS idx_change_sets_state;
    DROP INDEX IF EXISTS idx_change_operations_set;
    DROP INDEX IF EXISTS idx_change_hunks_operation;
    DROP INDEX IF EXISTS idx_timeline_events_session_seq;
    DROP INDEX IF EXISTS idx_timeline_events_run;
    DROP INDEX IF EXISTS idx_evidence_task;
    DROP INDEX IF EXISTS idx_evidence_run;
    DROP INDEX IF EXISTS idx_evidence_workspace;
    DROP INDEX IF EXISTS idx_readiness_gates_rc;
    DROP INDEX IF EXISTS idx_import_candidates_staging;
    DROP INDEX IF EXISTS idx_import_candidates_state;
    DROP INDEX IF EXISTS idx_external_asset_identities_candidate;
    DROP INDEX IF EXISTS idx_external_asset_identities_ext_id;
    DROP INDEX IF EXISTS idx_duplicate_candidates_candidate;
    DROP INDEX IF EXISTS idx_skill_manifests_canonical;
    DROP INDEX IF EXISTS idx_skill_assets_manifest;
    DROP INDEX IF EXISTS idx_skill_evaluations_manifest;
    DROP INDEX IF EXISTS idx_catalog_tombstones_entity;
    DROP INDEX IF EXISTS idx_disclosure_events_run;
    DROP INDEX IF EXISTS idx_prompt_manifests_run;
    DROP INDEX IF EXISTS idx_domain_events_unpublished;
    DROP INDEX IF EXISTS idx_domain_events_aggregate;
    DROP INDEX IF EXISTS idx_domain_events_correlation;

    -- Drop tables in reverse dependency order
    DROP TABLE IF EXISTS domain_events;
    DROP TABLE IF EXISTS prompt_manifests;
    DROP TABLE IF EXISTS disclosure_events;
    DROP TABLE IF EXISTS catalog_tombstones;
    DROP TABLE IF EXISTS catalog_snapshots;
    DROP TABLE IF EXISTS skill_evaluations;
    DROP TABLE IF EXISTS skill_assets;
    DROP TABLE IF EXISTS skill_manifests;
    DROP TABLE IF EXISTS reconciliation_decisions;
    DROP TABLE IF EXISTS duplicate_candidates;
    DROP TABLE IF EXISTS external_asset_identities;
    DROP TABLE IF EXISTS transformation_attempts;
    DROP TABLE IF EXISTS import_candidates;
    DROP TABLE IF EXISTS catalog_staging_runs;
    DROP TABLE IF EXISTS catalog_sources;
    DROP TABLE IF EXISTS workspace_leases;
    DROP TABLE IF EXISTS waivers;
    DROP TABLE IF EXISTS readiness_gates;
    DROP TABLE IF EXISTS release_candidates;
    DROP TABLE IF EXISTS evidence;
    DROP TABLE IF EXISTS timeline_events;
    DROP TABLE IF EXISTS change_transaction_journals;
    DROP TABLE IF EXISTS review_decisions;
    DROP TABLE IF EXISTS change_hunks;
    DROP TABLE IF EXISTS change_operations;
    DROP TABLE IF EXISTS change_sets;
    DROP TABLE IF EXISTS artifact_contracts;
    DROP TABLE IF EXISTS orchestration_stages;
    DROP TABLE IF EXISTS delivery_loops;
    DROP TABLE IF EXISTS agent_runs;
    DROP TABLE IF EXISTS trace_links;
    DROP TABLE IF EXISTS planning_tasks;
    DROP TABLE IF EXISTS planning_entities;
    DROP TABLE IF EXISTS planning_sources;
  `);
}
