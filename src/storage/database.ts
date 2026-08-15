import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDirectory } from './data-directory.js';
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
import * as neuronestEnhanced from './migrations/038-neuronest-enhanced.js';
import * as productionUxAudit from './migrations/039-production-ux-audit.js';
import * as unifiedIntentGate from './migrations/040-unified-intent-gate.js';
import * as loopStorage from './migrations/041-loop-storage.js';
import * as accessibilityFriction from './migrations/042-accessibility-friction.js';
import * as semanticIndex from './migrations/043-semantic-index.js';
import * as worktreeSessions from './migrations/044-worktree-sessions.js';
import * as codeReviews from './migrations/045-code-reviews.js';
import * as backgroundProcesses from './migrations/046-background-processes.js';
import * as networkPolicyLog from './migrations/047-network-policy-log.js';
import * as sessionExports from './migrations/048-session-exports.js';
import * as pluginSystem from './migrations/049-plugin-system.js';
import * as adoptionMetrics from './migrations/050-adoption-metrics.js';
import * as mcpMarketplace from './migrations/051-mcp-marketplace.js';
import * as diffTurns from './migrations/052-diff-turns.js';
import * as featureGateStore from './migrations/053-feature-gate-store.js';
import * as rememberedGrants from './migrations/054-remembered-grants.js';
import * as hookDefinitionsV2 from './migrations/055-hook-definitions-v2.js';
import * as crossSessionMemory from './migrations/056-cross-session-memory.js';
import * as dispatchSource from './migrations/057-dispatch-source.js';
import * as gcfContext from './migrations/058-gcf-context.js';
import * as kbTables from './migrations/059-kb-tables.js';
import * as trainingPipeline from './migrations/060-training-pipeline.js';
import * as modelExportGrpo from './migrations/061-model-export-grpo-tables.js';
import * as enterpriseTraining from './migrations/062-enterprise-training-tables.js';
import * as multiRepoAgentIntegration from './migrations/063-multi-repo-agent-integration.js';
import * as gadgets from './migrations/064-gadgets.js';
import * as blueprints from './migrations/065-blueprints.js';
import * as gatekeeper from './migrations/066-gatekeeper.js';
import * as simulatedApproval from './migrations/067-simulated-approval.js';
import * as observations from './migrations/068-observations.js';
import * as contextLibrary from './migrations/069-context-library.js';
import * as workflows from './migrations/070-workflows.js';
import * as costBudgets from './migrations/071-cost-budgets.js';
import * as codeMode from './migrations/072-code-mode.js';
import * as agentSkillBundleEvidence from './migrations/073-agent-skill-bundle-evidence.js';
import * as editorChatFoundations from './migrations/074-editor-chat-foundations.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [initialSchema, skillsSchema, multicaIntegration, agentSkillsIntegration, costRecords, securityScans, longTermMemory, sandboxSessions, mcpServers, memoryFts, diffReview, multiSession, extensions, newFeatures, plandexFeatures, advancedFeatures, remainingFeatures, gooseFeatures, sentruxFeatures, sreFeatures, helmorFeatures, factoryFeatures, coderFeatures, groundingAudit, incrementalIndexing, chatMessagesOverflow, runtimeSandboxGuardrails, errorSizeSamples, pipelineEvents, metricSamples, errorSizeSamplesBackfill, specMessageMode, secretsV2, multiChatSessions, agentLoopMetrics, featureIntegration, traceProvenanceColumns, neuronestEnhanced, productionUxAudit, unifiedIntentGate, loopStorage, accessibilityFriction, semanticIndex, worktreeSessions, codeReviews, backgroundProcesses, networkPolicyLog, sessionExports, pluginSystem, adoptionMetrics, mcpMarketplace, diffTurns, featureGateStore, rememberedGrants, hookDefinitionsV2, crossSessionMemory, dispatchSource, gcfContext, kbTables, trainingPipeline, modelExportGrpo, enterpriseTraining, multiRepoAgentIntegration, gadgets, blueprints, gatekeeper, simulatedApproval, observations, contextLibrary, workflows, costBudgets, codeMode, agentSkillBundleEvidence, editorChatFoundations];

/**
 * Validates the migration registry is contiguous (versions 1..N) and the
 * registered count matches the number of migration files in the migrations directory.
 *
 * Throws an error identifying the drift if:
 * - Registered versions are not a contiguous sequence from 1 to N
 * - The registered count does not equal the migration file count
 *
 * Requirements: 21.3, 21.4
 */
export function validateMigrationRegistry(
  migrationsDir?: string
): void {
  const resolvedDir = migrationsDir ?? path.join(__dirname, 'migrations');

  // Validate contiguity: versions must be exactly 1, 2, 3, ..., N
  const registeredVersions = migrations.map((m) => m.version).sort((a, b) => a - b);
  const expectedCount = registeredVersions.length;

  for (let i = 0; i < expectedCount; i++) {
    const expected = i + 1;
    const actual = registeredVersions[i];
    if (actual !== expected) {
      const missing: number[] = [];
      const expectedSet = new Set(Array.from({ length: expectedCount }, (_, idx) => idx + 1));
      for (const v of expectedSet) {
        if (!registeredVersions.includes(v)) missing.push(v);
      }
      const extra = registeredVersions.filter((v) => v > expectedCount || v < 1);
      throw new Error(
        `Migration registry drift: versions are not contiguous 1..${expectedCount}. ` +
        `Missing versions: [${missing.join(', ')}]. ` +
        `Unexpected versions: [${extra.join(', ')}]. ` +
        `Registered: [${registeredVersions.join(', ')}]`
      );
    }
  }

  // Validate file count matches registered count
  if (fs.existsSync(resolvedDir)) {
    const migrationFiles = fs.readdirSync(resolvedDir).filter(
      (f) => /^\d{3}-.*\.ts$/.test(f)
    );
    const fileCount = migrationFiles.length;

    if (fileCount !== expectedCount) {
      const registeredSet = new Set(registeredVersions);
      const fileVersions = migrationFiles
        .map((f) => parseInt(f.slice(0, 3), 10))
        .filter((v) => !isNaN(v));
      const unregistered = fileVersions.filter((v) => !registeredSet.has(v));

      throw new Error(
        `Migration registry drift: registered ${expectedCount} migrations but found ${fileCount} migration files in ${resolvedDir}. ` +
        `Unregistered file versions: [${unregistered.join(', ')}]`
      );
    }
  }
}

/**
 * Returns the default database path: ~/.neuronest/data.db
 *
 * Uses the Data_Directory_Accessor as the single source of truth for the
 * data directory path.
 *
 * @see Requirements 21.5, 21.6, 21.7
 */
export function getDefaultDbPath(): string {
  const dir = getDataDirectory();
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
