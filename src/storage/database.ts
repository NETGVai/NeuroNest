import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import * as initialSchema from './migrations/001-initial-schema.js';
import * as skillsSchema from './migrations/002-skills-schema.js';
import * as multicaIntegration from './migrations/003-multica-integration.js';
import * as agentSkillsIntegration from './migrations/004-agent-skills-integration.js';
import * as costRecords from './migrations/005-cost-records.js';
import * as securityScans from './migrations/006-security-scans.js';
import * as longTermMemory from './migrations/007-long-term-memory.js';
import * as sandboxSessions from './migrations/008-sandbox-sessions.js';
import * as mcpServers from './migrations/009-mcp-servers.js';
import * as memoryFts from './migrations/010-memory-fts.js';
import * as diffReview from './migrations/011-diff-review.js';
import * as multiSession from './migrations/012-multi-session.js';
import * as extensions from './migrations/013-extensions.js';
import * as newFeatures from './migrations/014-new-features.js';
import * as plandexFeatures from './migrations/015-plandex-features.js';
import * as advancedFeatures from './migrations/016-advanced-features.js';
import * as remainingFeatures from './migrations/017-remaining-features.js';
import * as gooseFeatures from './migrations/018-goose-features.js';
import * as sentruxFeatures from './migrations/019-sentrux-features.js';
import * as sreFeatures from './migrations/020-sre-features.js';
import * as helmorFeatures from './migrations/021-helmor-features.js';
import * as factoryFeatures from './migrations/022-factory-features.js';
import * as coderFeatures from './migrations/023-coder-features.js';
import * as groundingAudit from './migrations/024-grounding-audit.js';
import * as incrementalIndexing from './migrations/025-incremental-indexing.js';
import * as chatMessagesOverflow from './migrations/026-chat-messages-overflow.js';
import * as runtimeSandboxGuardrails from './migrations/027-runtime-sandbox-guardrails.js';
import * as errorSizeSamples from './migrations/028-error-size-samples.js';
import * as pipelineEvents from './migrations/029-pipeline-events.js';
import * as metricSamples from './migrations/030-metric-samples.js';
import * as errorSizeSamplesBackfill from './migrations/031-error-size-samples-backfill.js';
import * as specMessageMode from './migrations/032-spec-message-mode.js';
import * as secretsV2 from './migrations/033-secrets-v2.js';
import * as multiChatSessions from './migrations/034-multi-chat-sessions.js';
import * as agentLoopMetrics from './migrations/035-agent-loop-metrics.js';
import * as featureIntegration from './migrations/036-feature-integration.js';
import * as traceProvenanceColumns from './migrations/037-trace-provenance-columns.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [initialSchema, skillsSchema, multicaIntegration, agentSkillsIntegration, costRecords, securityScans, longTermMemory, sandboxSessions, mcpServers, memoryFts, diffReview, multiSession, extensions, newFeatures, plandexFeatures, advancedFeatures, remainingFeatures, gooseFeatures, sentruxFeatures, sreFeatures, helmorFeatures, factoryFeatures, coderFeatures, groundingAudit, incrementalIndexing, chatMessagesOverflow, runtimeSandboxGuardrails, errorSizeSamples, pipelineEvents, metricSamples, errorSizeSamplesBackfill, specMessageMode, secretsV2, multiChatSessions, agentLoopMetrics, featureIntegration, traceProvenanceColumns];

/**
 * Returns the default database path: ~/.ai-superagent/data.db
 */
export function getDefaultDbPath(): string {
  const dir = path.join(os.homedir(), '.ai-superagent');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'data.db');
}

/**
 * Initialize a SQLite database with WAL mode, foreign keys, and run pending migrations.
 * Pass a file path for persistent storage, or ':memory:' for tests.
 */
export function initDatabase(dbPath: string = getDefaultDbPath()): Database.Database {
  const db = new Database(dbPath);

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');    // Safe with WAL, much faster than FULL
  db.pragma('cache_size = -16000');     // 16 MB page cache (negative = KB)
  db.pragma('mmap_size = 268435456');   // 256 MB memory-mapped I/O
  db.pragma('temp_store = MEMORY');     // Keep temp tables in memory
  db.pragma('busy_timeout = 5000');     // 5s busy timeout instead of immediate fail

  // Migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  runMigrations(db);
  return db;
}

/**
 * Run all pending migrations inside a transaction.
 */
function runMigrations(db: Database.Database): void {
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(
        migration.version,
        migration.description,
      );
    })();
  }
}

/**
 * List all tables in the database (excluding internal sqlite tables).
 */
export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
