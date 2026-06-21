/**
 * CheckpointService — Serializes and restores full agent state for resumable execution.
 *
 * Provides durable checkpoint persistence with schema migration support,
 * disk quota enforcement, and graceful corruption handling.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.8, 2.9
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CheckpointData {
  schemaVersion: number;
  sessionId: string;
  timestamp: string;
  conversationHistory: unknown[];
  planProgress: { completedSteps: number[]; pendingSteps: number[] };
  fileChangeManifest: string[];
  iterationCount: number;
  customState: Record<string, unknown>;
}

export interface CheckpointConfig {
  directory: string;
  maxDiskUsageMb: number; // default 500
  currentSchemaVersion: number;
}

export class CheckpointService {
  constructor(private config: CheckpointConfig) {}

  /**
   * Serialize agent state after each tool execution cycle.
   * Writes JSON to `{directory}/{sessionId}_{timestamp}.json`.
   * Returns the full path of the written checkpoint file.
   */
  async save(data: CheckpointData): Promise<string> {
    const dir = this.config.directory;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sanitizedTimestamp = data.timestamp.replace(/[:.]/g, '-');
    const filename = `${data.sessionId}_${sanitizedTimestamp}.json`;
    const filePath = path.join(dir, filename);

    const payload: CheckpointData = {
      ...data,
      schemaVersion: this.config.currentSchemaVersion,
    };

    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');

    return filePath;
  }

  /**
   * Restore from checkpoint, handling schema migration.
   * Finds the latest checkpoint for the given session.
   * Returns null if no checkpoint exists, is corrupted, or migration fails.
   */
  async restore(sessionId: string): Promise<CheckpointData | null> {
    const dir = this.config.directory;
    if (!fs.existsSync(dir)) {
      return null;
    }

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      console.warn(`[CheckpointService] Failed to read directory: ${dir}`, err);
      return null;
    }

    // Filter files for this session and sort to find latest
    const sessionFiles = files
      .filter((f) => f.startsWith(`${sessionId}_`) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (sessionFiles.length === 0) {
      return null;
    }

    // Try the latest file first, fall back to older ones if corrupted
    for (const file of sessionFiles) {
      const filePath = path.join(dir, file);
      const result = this.tryReadCheckpoint(filePath);
      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  /**
   * Prune oldest checkpoints when total size exceeds maxDiskUsageMb.
   * Removes files oldest-first until under the quota.
   */
  async enforceQuota(): Promise<void> {
    const dir = this.config.directory;
    if (!fs.existsSync(dir)) {
      return;
    }

    const maxBytes = this.config.maxDiskUsageMb * 1024 * 1024;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    // Get file stats and sort by modification time (oldest first)
    const fileStats = files
      .map((f) => {
        const filePath = path.join(dir, f);
        try {
          const stat = fs.statSync(filePath);
          return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);

    // Remove oldest files until under quota
    let i = 0;
    while (totalSize > maxBytes && i < fileStats.length) {
      try {
        fs.unlinkSync(fileStats[i].path);
        totalSize -= fileStats[i].size;
      } catch (err) {
        console.warn(`[CheckpointService] Failed to delete checkpoint: ${fileStats[i].path}`, err);
      }
      i++;
    }
  }

  /**
   * Attempt schema migration or return null if incompatible.
   * Migrates raw checkpoint data from an older schema version to current.
   */
  private migrate(raw: unknown, fromVersion: number): CheckpointData | null {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }

    const data = raw as Record<string, unknown>;

    // Only migrate forward, not backward
    if (fromVersion > this.config.currentSchemaVersion) {
      console.warn(
        `[CheckpointService] Checkpoint schema version ${fromVersion} is newer than ` +
          `current version ${this.config.currentSchemaVersion}. Cannot downgrade.`,
      );
      return null;
    }

    // Apply migrations sequentially from fromVersion to currentSchemaVersion
    let migrated = { ...data };

    // Migration from v1 to v2: added customState field
    if (fromVersion < 2 && this.config.currentSchemaVersion >= 2) {
      if (!('customState' in migrated)) {
        migrated['customState'] = {};
      }
    }

    // Migration from v2 to v3: added fileChangeManifest field
    if (fromVersion < 3 && this.config.currentSchemaVersion >= 3) {
      if (!('fileChangeManifest' in migrated)) {
        migrated['fileChangeManifest'] = [];
      }
    }

    // Validate required fields after migration
    const required: (keyof CheckpointData)[] = [
      'sessionId',
      'timestamp',
      'conversationHistory',
      'planProgress',
      'fileChangeManifest',
      'iterationCount',
      'customState',
    ];

    for (const field of required) {
      if (!(field in migrated)) {
        console.warn(
          `[CheckpointService] Migration from v${fromVersion} failed: missing required field '${field}'.`,
        );
        return null;
      }
    }

    // Update schema version to current
    migrated['schemaVersion'] = this.config.currentSchemaVersion;

    return migrated as unknown as CheckpointData;
  }

  /**
   * Try to read and parse a single checkpoint file.
   * Returns null and logs a warning if the file is corrupted or unreadable.
   */
  private tryReadCheckpoint(filePath: string): CheckpointData | null {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[CheckpointService] Failed to read checkpoint file: ${filePath}`, err);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.warn(`[CheckpointService] Corrupted checkpoint (invalid JSON): ${filePath}`, err);
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(`[CheckpointService] Corrupted checkpoint (not an object): ${filePath}`);
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    const fileSchemaVersion = typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : 0;

    // If schema version matches, return directly after validation
    if (fileSchemaVersion === this.config.currentSchemaVersion) {
      return this.validateCheckpointData(raw);
    }

    // Schema version mismatch — attempt migration
    return this.migrate(raw, fileSchemaVersion);
  }

  /**
   * Validate that parsed data conforms to CheckpointData interface.
   * Returns null if essential fields are missing or invalid.
   */
  private validateCheckpointData(raw: Record<string, unknown>): CheckpointData | null {
    if (
      typeof raw['sessionId'] !== 'string' ||
      typeof raw['timestamp'] !== 'string' ||
      !Array.isArray(raw['conversationHistory']) ||
      typeof raw['planProgress'] !== 'object' ||
      raw['planProgress'] === null ||
      !Array.isArray(raw['fileChangeManifest']) ||
      typeof raw['iterationCount'] !== 'number' ||
      typeof raw['customState'] !== 'object' ||
      raw['customState'] === null
    ) {
      console.warn('[CheckpointService] Checkpoint data validation failed: missing or invalid fields.');
      return null;
    }

    return raw as unknown as CheckpointData;
  }
}
