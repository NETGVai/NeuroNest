import type Database from 'better-sqlite3';

export const version = 22;
export const description = 'Missions, Specification Mode, Wiki Generation, Headless Exec, QA/Demo/Verify automation';

export function up(db: Database.Database): void {
  db.exec(`
    -- Missions: multi-feature orchestration with milestones
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','approved','running','paused','completed','failed','cancelled')),
      features TEXT NOT NULL DEFAULT '[]',
      milestones TEXT NOT NULL DEFAULT '[]',
      current_milestone INTEGER NOT NULL DEFAULT 0,
      total_features INTEGER NOT NULL DEFAULT 0,
      completed_features INTEGER NOT NULL DEFAULT 0,
      estimated_cost TEXT,
      config TEXT DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id);

    CREATE TABLE IF NOT EXISTS mission_workers (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      feature_index INTEGER NOT NULL DEFAULT 0,
      worker_type TEXT NOT NULL DEFAULT 'feature' CHECK(worker_type IN ('feature','validator','fix')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
      agent_name TEXT,
      output TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_workers_mission ON mission_workers(mission_id);

    -- Specification Mode: read-only planning before execution
    CREATE TABLE IF NOT EXISTS specifications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      input_description TEXT NOT NULL,
      spec_content TEXT,
      implementation_plan TEXT,
      acceptance_criteria TEXT DEFAULT '[]',
      files_to_change TEXT DEFAULT '[]',
      testing_strategy TEXT,
      status TEXT NOT NULL DEFAULT 'drafting' CHECK(status IN ('drafting','reviewing','approved','implementing','completed','rejected')),
      spec_model TEXT,
      exec_model TEXT,
      save_as_markdown INTEGER NOT NULL DEFAULT 0,
      markdown_path TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_specs_project ON specifications(project_id);

    CREATE TABLE IF NOT EXISTS spec_config (
      project_id TEXT PRIMARY KEY,
      auto_spec_mode INTEGER NOT NULL DEFAULT 0,
      spec_model TEXT,
      exec_model TEXT,
      save_markdown INTEGER NOT NULL DEFAULT 0,
      markdown_dir TEXT DEFAULT '.neuronest/specs',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Wiki Generation: auto-generated codebase documentation
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      wiki_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      page_type TEXT NOT NULL DEFAULT 'module' CHECK(page_type IN ('overview','architecture','module','api','guide','changelog')),
      parent_slug TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_project ON wiki_pages(project_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_id ON wiki_pages(wiki_id);

    CREATE TABLE IF NOT EXISTS wiki_generations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      pages_generated INTEGER NOT NULL DEFAULT 0,
      model_used TEXT,
      duration_ms INTEGER DEFAULT 0,
      auto_refresh INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wikigen_project ON wiki_generations(project_id);

    CREATE TABLE IF NOT EXISTS wiki_config (
      project_id TEXT PRIMARY KEY,
      auto_refresh INTEGER NOT NULL DEFAULT 0,
      output_dir TEXT DEFAULT '.neuronest/wiki',
      sync_github INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Headless Exec: CI/CD non-interactive execution mode
    CREATE TABLE IF NOT EXISTS exec_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      prompt TEXT NOT NULL,
      autonomy_level TEXT NOT NULL DEFAULT 'readonly' CHECK(autonomy_level IN ('readonly','low','medium','high')),
      output_format TEXT NOT NULL DEFAULT 'text' CHECK(output_format IN ('text','json','stream-json')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
      result TEXT,
      model_used TEXT,
      duration_ms INTEGER DEFAULT 0,
      exit_code INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      session_id TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_exec_project ON exec_runs(project_id);

    CREATE TABLE IF NOT EXISTS exec_config (
      project_id TEXT PRIMARY KEY,
      default_autonomy TEXT NOT NULL DEFAULT 'readonly',
      default_model TEXT,
      default_output TEXT NOT NULL DEFAULT 'text',
      max_turns INTEGER NOT NULL DEFAULT 50,
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- QA/Demo/Verify automation
    CREATE TABLE IF NOT EXISTS qa_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_type TEXT NOT NULL DEFAULT 'qa' CHECK(run_type IN ('qa','demo','verify')),
      target TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'web' CHECK(target_type IN ('web','cli','electron','api')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('planning','running','completed','failed','cancelled')),
      test_plan TEXT DEFAULT '[]',
      results TEXT DEFAULT '[]',
      evidence TEXT DEFAULT '[]',
      conclusion TEXT,
      verdict TEXT CHECK(verdict IN ('pass','fail','confirmed','refuted','inconclusive')),
      steps_total INTEGER NOT NULL DEFAULT 0,
      steps_passed INTEGER NOT NULL DEFAULT 0,
      steps_failed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_qa_project ON qa_runs(project_id);

    CREATE TABLE IF NOT EXISTS qa_config (
      project_id TEXT PRIMARY KEY,
      default_target_type TEXT NOT NULL DEFAULT 'web',
      auto_screenshot INTEGER NOT NULL DEFAULT 1,
      browser_url TEXT DEFAULT 'http://localhost:3000',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
