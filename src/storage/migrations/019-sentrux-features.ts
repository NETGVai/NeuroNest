import type Database from 'better-sqlite3';

export const version = 19;
export const description = 'Architectural quality score, quality gate, rules engine, DSM, evolution tracking, test gaps, root-cause metrics';

export function up(db: Database.Database): void {
  db.exec(`
    -- Architectural Quality Scores: continuous quality signal per project
    CREATE TABLE IF NOT EXISTS arch_quality_scores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      overall_score INTEGER NOT NULL DEFAULT 0,
      modularity INTEGER NOT NULL DEFAULT 0,
      acyclicity INTEGER NOT NULL DEFAULT 0,
      depth_score INTEGER NOT NULL DEFAULT 0,
      equality INTEGER NOT NULL DEFAULT 0,
      redundancy INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      dependency_count INTEGER NOT NULL DEFAULT 0,
      cycle_count INTEGER NOT NULL DEFAULT 0,
      god_files TEXT DEFAULT '[]',
      coupling_grade TEXT DEFAULT 'A',
      details TEXT DEFAULT '{}',
      scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_arch_quality_project ON arch_quality_scores(project_id);

    -- Quality Gate: before/after session comparison
    CREATE TABLE IF NOT EXISTS quality_gates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      baseline_score INTEGER NOT NULL,
      baseline_snapshot TEXT NOT NULL DEFAULT '{}',
      final_score INTEGER,
      final_snapshot TEXT,
      passed INTEGER,
      degradation_summary TEXT,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_quality_gate_project ON quality_gates(project_id);

    -- Architectural Rules: per-project constraint definitions
    CREATE TABLE IF NOT EXISTS arch_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('max_cycles', 'max_coupling', 'max_complexity', 'no_god_files', 'layer_order', 'boundary', 'max_depth', 'min_modularity')),
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_arch_rules_project ON arch_rules(project_id);

    -- Architecture Evolution: quality signal over time
    CREATE TABLE IF NOT EXISTS arch_evolution (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      modularity INTEGER NOT NULL DEFAULT 0,
      acyclicity INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_arch_evolution_project ON arch_evolution(project_id);

    -- Test Gaps: files lacking test coverage
    CREATE TABLE IF NOT EXISTS test_gaps (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      has_tests INTEGER NOT NULL DEFAULT 0,
      test_file TEXT,
      gap_reason TEXT,
      scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_test_gaps_project ON test_gaps(project_id);
  `);
}
