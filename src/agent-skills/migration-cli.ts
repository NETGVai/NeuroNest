/**
 * Migration CLI Tool for Agent Skills SQLite Integration
 *
 * Provides a command-line interface to the MigrationEngine for integrating
 * Agent Skills microservice data into the existing NeuroNest database.
 *
 * Requirements: 1.4, 1.5, 1.6, 9.4
 */

import fs from 'node:fs';
import { MigrationEngine, type AgentSkillsData, type MigrationProgress, type MigrationResult } from './migration-engine.js';
import { DatabaseRecoveryManager } from './database-recovery.js';
import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

export interface CLIOptions {
  command: 'migrate' | 'validate' | 'rollback' | 'help';
  sourcePath?: string;
  dryRun: boolean;
  verbose: boolean;
  backupDir?: string;
}

export interface CLIResult {
  exitCode: number;
  message: string;
  details?: MigrationResult;
}

export type LogFn = (message: string) => void;

export interface CLIDeps {
  db: Database.Database;
  log: LogFn;
  errorLog: LogFn;
}

// ─── Argument Parsing ───────────────────────────────────────────

export function parseArgs(argv: string[]): CLIOptions {
  // Strip node + script path
  const args = argv.slice(2);

  const options: CLIOptions = {
    command: 'help',
    dryRun: false,
    verbose: false,
  };

  if (args.length === 0) {
    return options;
  }

  const first = args[0];
  if (first === 'migrate' || first === 'validate' || first === 'rollback' || first === 'help') {
    options.command = first;
  } else {
    // Unknown command falls back to help
    return options;
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--source' && i + 1 < args.length) {
      i++;
      options.sourcePath = args[i];
    } else if (arg === '--backup-dir' && i + 1 < args.length) {
      i++;
      options.backupDir = args[i];
    }
  }

  return options;
}

// ─── Data Loading ───────────────────────────────────────────────

export function loadSourceData(sourcePath: string): AgentSkillsData {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  const raw = fs.readFileSync(sourcePath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse source file as JSON: ${sourcePath}`);
  }

  // Convert date strings to Date objects
  return {
    skills: (parsed.skills ?? []).map((s: any) => ({
      ...s,
      created_at: new Date(s.created_at),
      updated_at: new Date(s.updated_at),
    })),
    agents: (parsed.agents ?? []).map((a: any) => ({
      ...a,
      created_at: new Date(a.created_at),
      updated_at: new Date(a.updated_at),
    })),
    assignments: (parsed.assignments ?? []).map((a: any) => ({
      ...a,
      assigned_at: new Date(a.assigned_at),
      last_used: a.last_used ? new Date(a.last_used) : undefined,
    })),
    events: (parsed.events ?? []).map((e: any) => ({
      ...e,
      timestamp: new Date(e.timestamp),
    })),
    config: parsed.config ?? {},
  };
}

// ─── Help Text ──────────────────────────────────────────────────

const HELP_TEXT = `
Agent Skills Migration CLI

Usage:
  migration-cli <command> [options]

Commands:
  migrate    Integrate Agent Skills data into NeuroNest database
  validate   Validate source data without making changes
  rollback   Restore database from latest backup
  help       Show this help message

Options:
  --source <path>      Path to Agent Skills JSON data file
  --dry-run            Test integration without making changes
  --verbose            Show detailed progress output
  --backup-dir <path>  Directory for database backups
`.trim();

// ─── CLI Runner ─────────────────────────────────────────────────

export async function runCLI(options: CLIOptions, deps: CLIDeps): Promise<CLIResult> {
  const { db, log, errorLog } = deps;

  if (options.command === 'help') {
    log(HELP_TEXT);
    return { exitCode: 0, message: 'Help displayed' };
  }

  if (options.command === 'validate') {
    return runValidate(options, deps);
  }

  if (options.command === 'rollback') {
    return runRollback(options, deps);
  }

  // migrate
  return runMigrate(options, deps);
}

async function runValidate(options: CLIOptions, deps: CLIDeps): Promise<CLIResult> {
  const { db, log, errorLog } = deps;

  if (!options.sourcePath) {
    errorLog('Error: --source <path> is required for validate command');
    return { exitCode: 1, message: 'Missing --source argument' };
  }

  let data: AgentSkillsData;
  try {
    data = loadSourceData(options.sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorLog(`Error loading source data: ${msg}`);
    return { exitCode: 1, message: msg };
  }

  const engine = new MigrationEngine(db);

  if (options.verbose) {
    engine.on('progress', (p: MigrationProgress) => {
      log(`[${p.phase}] ${p.current}/${p.total} - ${p.message}`);
    });
  }

  try {
    const result = await engine.migrate(data, { validateOnly: true });
    log('Validation passed. Source data is valid for migration.');
    return { exitCode: 0, message: 'Validation passed', details: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorLog(`Validation failed: ${msg}`);
    return { exitCode: 1, message: `Validation failed: ${msg}` };
  }
}

async function runMigrate(options: CLIOptions, deps: CLIDeps): Promise<CLIResult> {
  const { db, log, errorLog } = deps;

  if (!options.sourcePath) {
    errorLog('Error: --source <path> is required for migrate command');
    return { exitCode: 1, message: 'Missing --source argument' };
  }

  let data: AgentSkillsData;
  try {
    data = loadSourceData(options.sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorLog(`Error loading source data: ${msg}`);
    return { exitCode: 1, message: msg };
  }

  // Create backup before migration
  const backupDir = options.backupDir ?? './backups';
  const recovery = new DatabaseRecoveryManager(db, backupDir);

  if (!options.dryRun) {
    log('Creating pre-migration backup...');
    const backupResult = await recovery.createBackup('pre-migration');
    if (!backupResult.success) {
      errorLog(`Backup failed: ${backupResult.message}`);
      recovery.shutdown();
      return { exitCode: 1, message: `Backup failed: ${backupResult.message}` };
    }
    log(`Backup created: ${backupResult.backupPath ?? 'unknown'}`);
  }

  const engine = new MigrationEngine(db);

  if (options.verbose) {
    engine.on('progress', (p: MigrationProgress) => {
      log(`[${p.phase}] ${p.current}/${p.total} - ${p.message}`);
    });
  }

  const modeLabel = options.dryRun ? 'dry-run' : 'live';
  log(`Starting migration (${modeLabel})...`);

  try {
    const result = await engine.migrate(data, {
      dryRun: options.dryRun,
      preserveExisting: true,
    });

    recovery.shutdown();

    if (result.success) {
      log(`Migration completed successfully.`);
      log(`  Skills: ${result.migratedSkills}, Agents: ${result.migratedAgents}, Assignments: ${result.migratedAssignments}, Events: ${result.migratedEvents}`);
      if (result.warnings.length > 0) {
        log(`  Warnings: ${result.warnings.length}`);
        if (options.verbose) {
          for (const w of result.warnings) {
            log(`    - ${w}`);
          }
        }
      }
      return { exitCode: 0, message: 'Migration completed successfully', details: result };
    }

    errorLog('Migration completed with errors:');
    for (const e of result.errors) {
      errorLog(`  - ${e}`);
    }
    return { exitCode: 1, message: 'Migration completed with errors', details: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorLog(`Migration failed: ${msg}`);
    recovery.shutdown();
    return { exitCode: 1, message: `Migration failed: ${msg}` };
  }
}

async function runRollback(options: CLIOptions, deps: CLIDeps): Promise<CLIResult> {
  const { db, log, errorLog } = deps;

  const backupDir = options.backupDir ?? './backups';
  const recovery = new DatabaseRecoveryManager(db, backupDir);

  const latestBackup = recovery.getLatestBackupPath();
  if (!latestBackup) {
    errorLog('No backup found to rollback to.');
    recovery.shutdown();
    return { exitCode: 1, message: 'No backup available' };
  }

  log(`Rolling back to backup: ${latestBackup}`);
  const result = recovery.restoreFromBackup(latestBackup);
  recovery.shutdown();

  if (result.success) {
    log('Rollback completed successfully.');
    return { exitCode: 0, message: 'Rollback completed successfully' };
  }

  errorLog(`Rollback failed: ${result.message}`);
  return { exitCode: 1, message: `Rollback failed: ${result.message}` };
}
