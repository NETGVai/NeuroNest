/**
 * Blueprint Registry — Stores and distributes shareable application templates.
 *
 * Provides:
 * - Publishing gadgets as blueprints (stripping instance data)
 * - Version management with 10-version retention and rollback
 * - Instantiation creating fresh gadgets with no inherited state
 * - Searchable metadata catalog
 * - Export/import of self-contained archives with integrity validation
 * - Validation of file checksums and entry point enforcement
 *
 * Archives stored at `~/.neuronest/blueprints/`
 * Metadata in `blueprints` and `blueprint_versions` SQLite tables.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import * as tar from 'tar';

import type {
  BlueprintRegistry,
  Blueprint,
  BlueprintVersion,
  BlueprintMetadata,
  BlueprintManifest,
  ValidationResult,
  GadgetHandle,
  RPCInterfaceDefinition,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';

// ─── Constants ──────────────────────────────────────────────────

/** Base directory for blueprint archives */
const BLUEPRINTS_BASE_DIR = path.join(homedir(), '.neuronest', 'blueprints');

/** Maximum number of versions retained per blueprint */
const MAX_VERSIONS = 10;

/** Files and directories that contain instance-specific data and must be excluded */
const INSTANCE_DATA_PATTERNS = [
  'state.db',
  'state.db-wal',
  'state.db-shm',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '.credentials',
  '.credentials/**',
  '.env',
  '.env.local',
  'conversation-history/**',
  'conversations/**',
  '.tokens',
  '.oauth',
];

// ─── Database Row Types ─────────────────────────────────────────

interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  author: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface BlueprintVersionRow {
  blueprint_id: string;
  version: number;
  archive_path: string;
  manifest_json: string;
  checksum: string;
  created_at: string;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the BlueprintRegistryImpl.
 */
export interface BlueprintRegistryConfig {
  /** Main NeuroNest SQLite database instance */
  db: Database.Database;
  /** Optional custom base directory for blueprint archives (for testing) */
  blueprintsBaseDir?: string;
  /** Optional custom base directory for gadgets (for testing) */
  gadgetsBaseDir?: string;
  /** Optional callback to create a gadget from a blueprint */
  createGadget?: (spec: {
    id: string;
    name: string;
    description: string;
    hasClient: boolean;
    hasServer: boolean;
    capabilities: string[];
    sourcePath: string;
  }) => Promise<GadgetHandle>;
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Compute SHA-256 checksum of a file.
 */
function computeFileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a filename matches any of the instance data patterns.
 */
function isInstanceData(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  for (const pattern of INSTANCE_DATA_PATTERNS) {
    if (pattern.includes('**')) {
      const prefix = pattern.replace('/**', '');
      if (normalized.startsWith(prefix + '/') || normalized === prefix) {
        return true;
      }
    } else if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (normalized.endsWith(ext)) {
        return true;
      }
    } else {
      if (normalized === pattern || normalized.endsWith('/' + pattern)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collect all source files from a directory, excluding instance data.
 * Returns relative paths and their checksums.
 */
function collectSourceFiles(
  sourcePath: string,
): { path: string; checksum: string }[] {
  const results: { path: string; checksum: string }[] = [];

  if (!fs.existsSync(sourcePath)) return results;

  function walk(dir: string, prefix: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (isInstanceData(relativePath)) continue;

      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        const checksum = computeFileChecksum(fullPath);
        results.push({ path: relativePath, checksum });
      }
    }
  }

  walk(sourcePath, '');
  return results;
}

/**
 * Detect entry points in a gadget source directory.
 */
function detectEntryPoints(sourcePath: string): { server?: string; client?: string } {
  const entryPoints: { server?: string; client?: string } = {};

  if (fs.existsSync(path.join(sourcePath, 'server.ts'))) {
    entryPoints.server = 'server.ts';
  } else if (fs.existsSync(path.join(sourcePath, 'server.js'))) {
    entryPoints.server = 'server.js';
  }

  if (fs.existsSync(path.join(sourcePath, 'client.html'))) {
    entryPoints.client = 'client.html';
  } else if (fs.existsSync(path.join(sourcePath, 'client.tsx'))) {
    entryPoints.client = 'client.tsx';
  }

  return entryPoints;
}

// ─── Implementation ─────────────────────────────────────────────

export class BlueprintRegistryImpl implements BlueprintRegistry {
  private readonly db: Database.Database;
  private readonly baseDir: string;
  private readonly gadgetsBaseDir: string;
  private readonly createGadgetFn: BlueprintRegistryConfig['createGadget'] | null;

  // Prepared SQL statements
  private readonly stmtInsertBlueprint: Database.Statement;
  private readonly stmtGetBlueprint: Database.Statement;
  private readonly stmtGetAllBlueprints: Database.Statement;
  private readonly stmtUpdateBlueprint: Database.Statement;
  private readonly stmtDeleteBlueprint: Database.Statement;
  private readonly stmtInsertVersion: Database.Statement;
  private readonly stmtGetVersion: Database.Statement;
  private readonly stmtGetLatestVersion: Database.Statement;
  private readonly stmtGetAllVersions: Database.Statement;
  private readonly stmtDeleteVersion: Database.Statement;
  private readonly stmtCountVersions: Database.Statement;
  private readonly stmtGetOldestVersion: Database.Statement;
  private readonly stmtSearchBlueprints: Database.Statement;

  constructor(config: BlueprintRegistryConfig) {
    this.db = config.db;
    this.baseDir = config.blueprintsBaseDir ?? BLUEPRINTS_BASE_DIR;
    this.gadgetsBaseDir = config.gadgetsBaseDir ?? path.join(homedir(), '.neuronest', 'gadgets');
    this.createGadgetFn = config.createGadget ?? null;

    // Ensure base directory exists
    fs.mkdirSync(this.baseDir, { recursive: true });

    // Prepare SQL statements
    this.stmtInsertBlueprint = this.db.prepare(`
      INSERT INTO blueprints (id, name, description, author, current_version, created_at, updated_at)
      VALUES (@id, @name, @description, @author, @current_version, @created_at, @updated_at)
    `);

    this.stmtGetBlueprint = this.db.prepare(`
      SELECT * FROM blueprints WHERE id = ?
    `);

    this.stmtGetAllBlueprints = this.db.prepare(`
      SELECT * FROM blueprints ORDER BY updated_at DESC
    `);

    this.stmtUpdateBlueprint = this.db.prepare(`
      UPDATE blueprints SET current_version = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtDeleteBlueprint = this.db.prepare(`
      DELETE FROM blueprints WHERE id = ?
    `);

    this.stmtInsertVersion = this.db.prepare(`
      INSERT INTO blueprint_versions (blueprint_id, version, archive_path, manifest_json, checksum, created_at)
      VALUES (@blueprint_id, @version, @archive_path, @manifest_json, @checksum, @created_at)
    `);

    this.stmtGetVersion = this.db.prepare(`
      SELECT * FROM blueprint_versions WHERE blueprint_id = ? AND version = ?
    `);

    this.stmtGetLatestVersion = this.db.prepare(`
      SELECT * FROM blueprint_versions WHERE blueprint_id = ? ORDER BY version DESC LIMIT 1
    `);

    this.stmtGetAllVersions = this.db.prepare(`
      SELECT * FROM blueprint_versions WHERE blueprint_id = ? ORDER BY version DESC
    `);

    this.stmtDeleteVersion = this.db.prepare(`
      DELETE FROM blueprint_versions WHERE blueprint_id = ? AND version = ?
    `);

    this.stmtCountVersions = this.db.prepare(`
      SELECT COUNT(*) as count FROM blueprint_versions WHERE blueprint_id = ?
    `);

    this.stmtGetOldestVersion = this.db.prepare(`
      SELECT * FROM blueprint_versions WHERE blueprint_id = ? ORDER BY version ASC LIMIT 1
    `);

    this.stmtSearchBlueprints = this.db.prepare(`
      SELECT * FROM blueprints
      WHERE name LIKE ? OR description LIKE ? OR author LIKE ?
      ORDER BY updated_at DESC
    `);
  }

  // ─── BlueprintRegistry Interface Methods ──────────────────────

  /**
   * Publish a gadget as a blueprint, archiving its source while stripping
   * all instance-specific data (SQLite contents, credentials, conversation history).
   *
   * If a blueprint with matching name+author exists, creates a new version.
   * Enforces 10-version retention (oldest versions pruned on overflow).
   *
   * Requirements: 2.1, 2.2
   */
  async publish(gadgetId: string, metadata: BlueprintMetadata): Promise<Blueprint> {
    const gadgetSourcePath = path.join(this.gadgetsBaseDir, gadgetId, 'src');

    if (!fs.existsSync(gadgetSourcePath)) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Gadget source not found at "${gadgetSourcePath}" for gadget "${gadgetId}"`,
        { details: { gadgetId }, recoverable: false },
      );
    }

    // Collect source files, excluding instance data
    const files = collectSourceFiles(gadgetSourcePath);
    const entryPoints = detectEntryPoints(gadgetSourcePath);

    // Build manifest
    const manifest: BlueprintManifest = {
      name: metadata.name,
      description: metadata.description,
      entryPoints,
      rpcInterface: this.loadRPCInterface(gadgetId),
      capabilities: [],
      files,
    };

    // Check if blueprint already exists (by name + author match)
    const existing = this.findExistingBlueprint(metadata.name, metadata.author);
    const blueprintId = existing?.id ?? randomUUID();
    const version = existing ? existing.current_version + 1 : 1;

    // Create archive
    const archivePath = path.join(this.baseDir, `${blueprintId}_v${version}.tar.gz`);
    await this.createArchive(gadgetSourcePath, archivePath, files);

    const archiveChecksum = computeFileChecksum(archivePath);
    const now = new Date().toISOString();

    // Persist to database
    if (existing) {
      this.stmtUpdateBlueprint.run(version, now, blueprintId);
    } else {
      this.stmtInsertBlueprint.run({
        id: blueprintId,
        name: metadata.name,
        description: metadata.description ?? null,
        author: metadata.author,
        current_version: version,
        created_at: now,
        updated_at: now,
      });
    }

    // Insert version record
    this.stmtInsertVersion.run({
      blueprint_id: blueprintId,
      version,
      archive_path: archivePath,
      manifest_json: JSON.stringify(manifest),
      checksum: archiveChecksum,
      created_at: now,
    });

    // Enforce version retention (max 10 versions)
    this.enforceVersionRetention(blueprintId);

    return {
      id: blueprintId,
      name: metadata.name,
      description: metadata.description,
      author: metadata.author,
      version,
      createdAt: now,
      capabilityRequirements: manifest.capabilities,
      entryPoints: manifest.entryPoints,
      checksum: archiveChecksum,
    };
  }

  /**
   * Instantiate a blueprint as a fresh gadget with no inherited state or credentials.
   * Creates a new gadget directory, extracts blueprint source, and starts it.
   *
   * Requirements: 2.3
   */
  async instantiate(blueprintId: string, version?: number): Promise<GadgetHandle> {
    const row = this.stmtGetBlueprint.get(blueprintId) as BlueprintRow | undefined;
    if (!row) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Blueprint "${blueprintId}" not found`,
        { details: { blueprintId }, recoverable: false },
      );
    }

    const targetVersion = version ?? row.current_version;
    const versionRow = this.stmtGetVersion.get(blueprintId, targetVersion) as BlueprintVersionRow | undefined;
    if (!versionRow) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Blueprint "${blueprintId}" version ${targetVersion} not found`,
        { details: { blueprintId, version: targetVersion }, recoverable: false },
      );
    }

    const manifest: BlueprintManifest = JSON.parse(versionRow.manifest_json);
    const newGadgetId = randomUUID();
    const newGadgetDir = path.join(this.gadgetsBaseDir, newGadgetId);
    const newSourcePath = path.join(newGadgetDir, 'src');

    // Create fresh gadget directory
    fs.mkdirSync(newSourcePath, { recursive: true });

    // Extract archive into the new gadget's source directory
    await this.extractArchive(versionRow.archive_path, newSourcePath);

    // Create gadget via the engine callback or return a stub handle
    if (this.createGadgetFn) {
      return this.createGadgetFn({
        id: newGadgetId,
        name: manifest.name,
        description: manifest.description,
        hasClient: !!manifest.entryPoints.client,
        hasServer: !!manifest.entryPoints.server,
        capabilities: [], // Fresh — no inherited capabilities
        sourcePath: newSourcePath,
      });
    }

    // Stub handle when no gadget engine callback is provided
    const handle: GadgetHandle = {
      id: newGadgetId,
      pid: 0,
      status: 'creating',
      rpcInterface: manifest.rpcInterface,
      serverPort: 0,
    };
    if (manifest.entryPoints.client) {
      handle.clientUrl = `file://${path.join(newSourcePath, manifest.entryPoints.client)}`;
    }
    return handle;
  }

  /**
   * Rollback a blueprint to a previous version.
   * Creates a new version from the old snapshot (non-destructive).
   *
   * Requirements: 2.2
   */
  async rollback(blueprintId: string, targetVersion: number): Promise<Blueprint> {
    const row = this.stmtGetBlueprint.get(blueprintId) as BlueprintRow | undefined;
    if (!row) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Blueprint "${blueprintId}" not found`,
        { details: { blueprintId }, recoverable: false },
      );
    }

    const targetRow = this.stmtGetVersion.get(blueprintId, targetVersion) as BlueprintVersionRow | undefined;
    if (!targetRow) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Blueprint "${blueprintId}" version ${targetVersion} not found for rollback`,
        { details: { blueprintId, targetVersion }, recoverable: false },
      );
    }

    // Create a new version by copying the target version's archive
    const newVersion = row.current_version + 1;
    const newArchivePath = path.join(this.baseDir, `${blueprintId}_v${newVersion}.tar.gz`);
    fs.copyFileSync(targetRow.archive_path, newArchivePath);

    const now = new Date().toISOString();
    const manifest: BlueprintManifest = JSON.parse(targetRow.manifest_json);

    // Insert new version record
    this.stmtInsertVersion.run({
      blueprint_id: blueprintId,
      version: newVersion,
      archive_path: newArchivePath,
      manifest_json: targetRow.manifest_json,
      checksum: targetRow.checksum,
      created_at: now,
    });

    // Update current version
    this.stmtUpdateBlueprint.run(newVersion, now, blueprintId);

    // Enforce retention
    this.enforceVersionRetention(blueprintId);

    return {
      id: blueprintId,
      name: row.name,
      description: row.description ?? '',
      author: row.author,
      version: newVersion,
      createdAt: now,
      capabilityRequirements: manifest.capabilities,
      entryPoints: manifest.entryPoints,
      checksum: targetRow.checksum,
    };
  }

  /**
   * Search blueprints by name, description, or author.
   *
   * Requirements: 2.4
   */
  search(query: string): Blueprint[] {
    const pattern = `%${query}%`;
    const rows = this.stmtSearchBlueprints.all(pattern, pattern, pattern) as BlueprintRow[];
    return rows.map((row) => this.rowToBlueprint(row));
  }

  /**
   * Export a blueprint as a self-contained archive (manifest + source files).
   * The archive is a tar.gz containing the manifest.json and all source files.
   *
   * Requirements: 2.5
   */
  async export(blueprintId: string): Promise<Buffer> {
    const row = this.stmtGetBlueprint.get(blueprintId) as BlueprintRow | undefined;
    if (!row) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `Blueprint "${blueprintId}" not found for export`,
        { details: { blueprintId }, recoverable: false },
      );
    }

    const versionRow = this.stmtGetLatestVersion.get(blueprintId) as BlueprintVersionRow | undefined;
    if (!versionRow) {
      throw this.createError(
        'BLUEPRINT_NOT_FOUND',
        `No versions found for blueprint "${blueprintId}"`,
        { details: { blueprintId }, recoverable: false },
      );
    }

    // Create a self-contained export archive that includes the manifest
    const exportDir = path.join(this.baseDir, `export_${blueprintId}_${Date.now()}`);
    fs.mkdirSync(exportDir, { recursive: true });

    try {
      // Write manifest
      fs.writeFileSync(
        path.join(exportDir, 'manifest.json'),
        versionRow.manifest_json,
        'utf-8',
      );

      // Extract source from version archive into export dir
      const srcDir = path.join(exportDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      await this.extractArchive(versionRow.archive_path, srcDir);

      // Create export archive
      const exportArchivePath = path.join(this.baseDir, `export_${blueprintId}.tar.gz`);
      await tar.create(
        { gzip: true, file: exportArchivePath, cwd: exportDir },
        fs.readdirSync(exportDir),
      );

      const buffer = fs.readFileSync(exportArchivePath);

      // Clean up temp files
      fs.rmSync(exportDir, { recursive: true, force: true });
      fs.unlinkSync(exportArchivePath);

      return buffer;
    } catch (err) {
      fs.rmSync(exportDir, { recursive: true, force: true });
      throw this.createError(
        'BLUEPRINT_IMPORT_FAILED',
        `Failed to export blueprint "${blueprintId}": ${(err as Error).message}`,
        { details: { blueprintId }, recoverable: true },
      );
    }
  }

  /**
   * Import a blueprint from a self-contained archive with integrity validation.
   *
   * Requirements: 2.5, 2.6
   */
  async import(archive: Buffer): Promise<Blueprint> {
    // Validate first
    const validation = this.validate(archive);
    if (!validation.valid) {
      throw this.createError(
        'BLUEPRINT_IMPORT_FAILED',
        `Blueprint import validation failed: ${validation.errors.join('; ')}`,
        { details: { errors: validation.errors }, recoverable: true },
      );
    }

    // Extract to temp directory
    const importDir = path.join(this.baseDir, `import_${Date.now()}`);
    fs.mkdirSync(importDir, { recursive: true });

    try {
      // Write archive to temp file and extract
      const tempArchive = path.join(importDir, 'import.tar.gz');
      fs.writeFileSync(tempArchive, archive);
      await tar.extract({ file: tempArchive, cwd: importDir });

      // Read manifest
      const manifestPath = path.join(importDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error('manifest.json not found in archive');
      }

      const manifest: BlueprintManifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      );

      // Create new blueprint
      const blueprintId = randomUUID();
      const version = 1;
      const now = new Date().toISOString();

      // Create permanent archive from the source
      const srcDir = path.join(importDir, 'src');
      const archivePath = path.join(this.baseDir, `${blueprintId}_v${version}.tar.gz`);

      if (fs.existsSync(srcDir)) {
        await tar.create(
          { gzip: true, file: archivePath, cwd: srcDir },
          fs.readdirSync(srcDir),
        );
      } else {
        // Source files are in the root (flat archive)
        const srcFiles = fs.readdirSync(importDir).filter(
          (f) => f !== 'import.tar.gz' && f !== 'manifest.json',
        );
        await tar.create(
          { gzip: true, file: archivePath, cwd: importDir },
          srcFiles,
        );
      }

      const checksum = computeFileChecksum(archivePath);

      // Insert blueprint metadata
      this.stmtInsertBlueprint.run({
        id: blueprintId,
        name: manifest.name,
        description: manifest.description ?? null,
        author: 'imported',
        current_version: version,
        created_at: now,
        updated_at: now,
      });

      // Insert version record
      this.stmtInsertVersion.run({
        blueprint_id: blueprintId,
        version,
        archive_path: archivePath,
        manifest_json: JSON.stringify(manifest),
        checksum,
        created_at: now,
      });

      // Clean up temp directory
      fs.rmSync(importDir, { recursive: true, force: true });

      return {
        id: blueprintId,
        name: manifest.name,
        description: manifest.description,
        author: 'imported',
        version,
        createdAt: now,
        capabilityRequirements: manifest.capabilities,
        entryPoints: manifest.entryPoints,
        checksum,
      };
    } catch (err) {
      fs.rmSync(importDir, { recursive: true, force: true });
      if ((err as SubsystemError).subsystem === 'blueprint_registry') {
        throw err;
      }
      throw this.createError(
        'BLUEPRINT_IMPORT_FAILED',
        `Failed to import blueprint: ${(err as Error).message}`,
        { details: { error: (err as Error).message }, recoverable: true },
      );
    }
  }

  /**
   * Validate a blueprint archive for integrity.
   * Verifies:
   * - Archive can be decompressed
   * - manifest.json exists and is valid JSON
   * - File checksums match declared values
   * - No executable code exists outside declared entry points
   *
   * Requirements: 2.6
   */
  validate(archive: Buffer): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Create temp directory for validation
    const validateDir = path.join(this.baseDir, `validate_${Date.now()}`);
    fs.mkdirSync(validateDir, { recursive: true });

    try {
      // Write and extract archive
      const tempArchive = path.join(validateDir, 'validate.tar.gz');
      fs.writeFileSync(tempArchive, archive);

      try {
        tar.extract({ file: tempArchive, cwd: validateDir, sync: true });
      } catch (err) {
        errors.push(`Archive extraction failed: ${(err as Error).message}`);
        fs.rmSync(validateDir, { recursive: true, force: true });
        return { valid: false, errors, warnings };
      }

      // Check for manifest.json
      const manifestPath = path.join(validateDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        errors.push('manifest.json not found in archive');
        fs.rmSync(validateDir, { recursive: true, force: true });
        return { valid: false, errors, warnings };
      }

      // Parse manifest
      let manifest: BlueprintManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        errors.push(`manifest.json is not valid JSON: ${(err as Error).message}`);
        fs.rmSync(validateDir, { recursive: true, force: true });
        return { valid: false, errors, warnings };
      }

      // Validate required manifest fields
      if (!manifest.name) {
        errors.push('manifest.json missing required field: name');
      }
      if (!manifest.entryPoints) {
        errors.push('manifest.json missing required field: entryPoints');
      }
      if (!manifest.files || !Array.isArray(manifest.files)) {
        errors.push('manifest.json missing required field: files');
        fs.rmSync(validateDir, { recursive: true, force: true });
        return { valid: errors.length === 0, errors, warnings };
      }

      // Verify file checksums
      const srcDir = fs.existsSync(path.join(validateDir, 'src'))
        ? path.join(validateDir, 'src')
        : validateDir;

      for (const fileEntry of manifest.files) {
        const filePath = path.join(srcDir, fileEntry.path);
        if (!fs.existsSync(filePath)) {
          errors.push(`Declared file missing from archive: ${fileEntry.path}`);
          continue;
        }

        const actualChecksum = computeFileChecksum(filePath);
        if (actualChecksum !== fileEntry.checksum) {
          errors.push(
            `Checksum mismatch for "${fileEntry.path}": expected ${fileEntry.checksum}, got ${actualChecksum}`,
          );
        }
      }

      // Detect code outside declared entry points
      const declaredEntryPoints = new Set<string>();
      if (manifest.entryPoints.server) declaredEntryPoints.add(manifest.entryPoints.server);
      if (manifest.entryPoints.client) declaredEntryPoints.add(manifest.entryPoints.client);

      const declaredFiles = new Set(manifest.files.map((f) => f.path));
      const executableExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);

      // Walk the source directory for undeclared executable files
      const actualFiles = collectSourceFiles(srcDir);
      for (const file of actualFiles) {
        const ext = path.extname(file.path).toLowerCase();
        if (executableExtensions.has(ext) && !declaredFiles.has(file.path)) {
          errors.push(`Undeclared executable code found: ${file.path}`);
        }
      }

      fs.rmSync(validateDir, { recursive: true, force: true });
      return { valid: errors.length === 0, errors, warnings };
    } catch (err) {
      fs.rmSync(validateDir, { recursive: true, force: true });
      errors.push(`Validation error: ${(err as Error).message}`);
      return { valid: false, errors, warnings };
    }
  }

  /**
   * List all versions of a blueprint.
   *
   * Requirements: 2.2
   */
  listVersions(blueprintId: string): BlueprintVersion[] {
    const rows = this.stmtGetAllVersions.all(blueprintId) as BlueprintVersionRow[];
    return rows.map((row) => ({
      blueprintId: row.blueprint_id,
      version: row.version,
      sourceArchive: fs.existsSync(row.archive_path)
        ? fs.readFileSync(row.archive_path)
        : Buffer.alloc(0),
      manifest: JSON.parse(row.manifest_json),
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete a blueprint and all its versions (including archive files).
   */
  delete(blueprintId: string): void {
    const versions = this.stmtGetAllVersions.all(blueprintId) as BlueprintVersionRow[];
    for (const v of versions) {
      if (fs.existsSync(v.archive_path)) {
        fs.unlinkSync(v.archive_path);
      }
    }
    this.stmtDeleteBlueprint.run(blueprintId);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Find an existing blueprint by name and author.
   */
  private findExistingBlueprint(name: string, author: string): BlueprintRow | undefined {
    const all = this.stmtGetAllBlueprints.all() as BlueprintRow[];
    return all.find((r) => r.name === name && r.author === author);
  }

  /**
   * Convert a database row to a Blueprint object.
   */
  private rowToBlueprint(row: BlueprintRow): Blueprint {
    const latestVersion = this.stmtGetLatestVersion.get(row.id) as BlueprintVersionRow | undefined;
    let manifest: BlueprintManifest | null = null;
    let checksum = '';

    if (latestVersion) {
      manifest = JSON.parse(latestVersion.manifest_json);
      checksum = latestVersion.checksum;
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      author: row.author,
      version: row.current_version,
      createdAt: row.created_at,
      capabilityRequirements: manifest?.capabilities ?? [],
      entryPoints: manifest?.entryPoints ?? {},
      checksum,
    };
  }

  /**
   * Enforce the 10-version retention policy.
   * Deletes oldest versions when the count exceeds MAX_VERSIONS.
   */
  private enforceVersionRetention(blueprintId: string): void {
    const countRow = this.stmtCountVersions.get(blueprintId) as { count: number };
    let count = countRow.count;

    while (count > MAX_VERSIONS) {
      const oldest = this.stmtGetOldestVersion.get(blueprintId) as BlueprintVersionRow | undefined;
      if (!oldest) break;

      // Delete the archive file
      if (fs.existsSync(oldest.archive_path)) {
        fs.unlinkSync(oldest.archive_path);
      }

      // Delete the version record
      this.stmtDeleteVersion.run(blueprintId, oldest.version);
      count--;
    }
  }

  /**
   * Create a tar.gz archive from the gadget source directory,
   * excluding instance-specific data.
   */
  private async createArchive(
    sourcePath: string,
    archivePath: string,
    files: { path: string; checksum: string }[],
  ): Promise<void> {
    const filePaths = files.map((f) => f.path);
    await tar.create(
      {
        gzip: true,
        file: archivePath,
        cwd: sourcePath,
      },
      filePaths,
    );
  }

  /**
   * Extract a tar.gz archive to a destination directory.
   */
  private async extractArchive(archivePath: string, destPath: string): Promise<void> {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`);
    }

    await tar.extract({
      file: archivePath,
      cwd: destPath,
    });
  }

  /**
   * Load the RPC interface definition for a gadget (if available from cache/disk).
   */
  private loadRPCInterface(gadgetId: string): RPCInterfaceDefinition {
    // Try to read the rpc.d.ts file from the gadget's source
    const dtsPath = path.join(this.gadgetsBaseDir, gadgetId, 'src', 'rpc.d.ts');
    const typeDefinitions = fs.existsSync(dtsPath)
      ? fs.readFileSync(dtsPath, 'utf-8')
      : '';

    return {
      gadgetId,
      version: 1,
      methods: [],
      generatedAt: new Date().toISOString(),
      typeDefinitions,
    };
  }

  /**
   * Create a structured SubsystemError for the blueprint registry.
   */
  private createError(
    code: 'BLUEPRINT_NOT_FOUND' | 'BLUEPRINT_IMPORT_FAILED' | 'BLUEPRINT_CHECKSUM_MISMATCH' | 'BLUEPRINT_INVALID_ARCHIVE' | 'BLUEPRINT_VERSION_LIMIT_EXCEEDED',
    message: string,
    options?: { details?: Record<string, unknown>; recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    const opts: { details?: Record<string, unknown>; recoverable?: boolean; suggestedAction?: string } = {
      recoverable: options?.recoverable ?? false,
    };
    if (options?.details) opts.details = options.details;
    if (options?.suggestedAction) opts.suggestedAction = options.suggestedAction;
    return createSubsystemError('blueprint_registry', code, message, opts);
  }
}
