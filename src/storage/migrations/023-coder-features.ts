import type Database from 'better-sqlite3';

export const version = 23;
export const description = 'Best-of-N evaluation, Workspace Forking, Runtime Backends, AI Gateway, E2E Encrypted Sharing';

export function up(db: Database.Database): void {
  db.exec(`
    -- Best-of-N: parallel evaluation runs
    CREATE TABLE IF NOT EXISTS best_of_n_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','synthesizing','completed','failed')),
      candidates TEXT NOT NULL DEFAULT '[]',
      winner_index INTEGER,
      synthesized_result TEXT,
      model_used TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bon_project ON best_of_n_runs(project_id);

    CREATE TABLE IF NOT EXISTS best_of_n_config (
      project_id TEXT PRIMARY KEY,
      default_n INTEGER NOT NULL DEFAULT 3,
      auto_best_of_n INTEGER NOT NULL DEFAULT 0,
      synthesis_strategy TEXT NOT NULL DEFAULT 'best' CHECK(synthesis_strategy IN ('best','merge','vote')),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Workspace Forking: clone sessions with conversation history
    CREATE TABLE IF NOT EXISTS workspace_forks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      forked_session_id TEXT NOT NULL,
      fork_name TEXT NOT NULL,
      fork_branch TEXT,
      messages_copied INTEGER NOT NULL DEFAULT 0,
      model_selection TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_forks_project ON workspace_forks(project_id);

    -- Runtime Backends: Docker, SSH, DevContainer, Local, Worktree
    CREATE TABLE IF NOT EXISTS runtime_backends (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      backend_type TEXT NOT NULL DEFAULT 'local' CHECK(backend_type IN ('local','docker','ssh','devcontainer','worktree')),
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','starting','running','stopped','error')),
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_backends_project ON runtime_backends(project_id);

    CREATE TABLE IF NOT EXISTS runtime_config (
      project_id TEXT PRIMARY KEY,
      default_backend TEXT NOT NULL DEFAULT 'local',
      docker_image TEXT DEFAULT 'node:20',
      ssh_host TEXT,
      ssh_user TEXT DEFAULT 'root',
      ssh_port INTEGER DEFAULT 22,
      devcontainer_path TEXT DEFAULT '.devcontainer/devcontainer.json',
      share_credentials INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- AI Gateway: centralized LLM proxy with audit logging
    CREATE TABLE IF NOT EXISTS gateway_audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','error','blocked','rate_limited')),
      blocked_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_project ON gateway_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_gateway_created ON gateway_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS gateway_config (
      id TEXT PRIMARY KEY DEFAULT 'global',
      enabled INTEGER NOT NULL DEFAULT 0,
      centralized_keys INTEGER NOT NULL DEFAULT 0,
      audit_all_requests INTEGER NOT NULL DEFAULT 1,
      allowed_providers TEXT DEFAULT '[]',
      allowed_models TEXT DEFAULT '[]',
      rate_limit_rpm INTEGER DEFAULT 60,
      max_tokens_per_request INTEGER DEFAULT 0,
      block_on_policy_violation INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- E2E Encrypted Message Sharing
    CREATE TABLE IF NOT EXISTS encrypted_shares (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      content_hash TEXT NOT NULL,
      encryption_algo TEXT NOT NULL DEFAULT 'aes-256-gcm',
      signing_algo TEXT,
      signer_identity TEXT,
      expires_at DATETIME,
      access_count INTEGER NOT NULL DEFAULT 0,
      max_access INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shares_project ON encrypted_shares(project_id);

    CREATE TABLE IF NOT EXISTS sharing_config (
      project_id TEXT PRIMARY KEY,
      default_expiry TEXT NOT NULL DEFAULT '24h' CHECK(default_expiry IN ('1h','24h','7d','30d','never')),
      auto_sign INTEGER NOT NULL DEFAULT 1,
      signing_key_path TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
