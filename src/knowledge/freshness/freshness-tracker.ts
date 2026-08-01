// ─── Freshness Tracker ──────────────────────────────────────────
// Monitors knowledgebase sources for content changes using source-type-appropriate
// detection methods: mtime (local files), commit-hash (git), etag/last-modified (URLs).
//
// When changes are detected, sources are marked as stale and queued for re-indexing.
// Structured freshness events are emitted to the EventLog with `kb-freshness` source identifier.
//
// Requirements: 5.1, 5.2, 5.3, 5.5, 5.6

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { stat } from 'fs/promises';

import type { EventLog, EventKind } from '../../pipeline/event-log';
import { KB_EVENT_KINDS, KB_SOURCE_IDENTIFIERS } from '../events/kb-event-schemas';
import type { ConnectorFramework } from '../connectors/connector-framework';
import type { ConnectorType } from '../connectors/types';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Possible states for a tracked source's freshness.
 */
export type FreshnessState = 'fresh' | 'stale' | 're-indexing';

/**
 * Detection method used to determine if a source has changed.
 */
export type DetectionMethod = 'mtime' | 'commit-hash' | 'etag' | 'last-modified';

/**
 * Record describing the freshness state of a single knowledge source.
 */
export interface FreshnessRecord {
  /** URI identifying the source. */
  sourceUri: string;
  /** Source ID in the kb_sources table. */
  sourceId: string;
  /** Current freshness state. */
  state: FreshnessState;
  /** Unix timestamp (ms) of the last freshness check. */
  lastChecked: number;
  /** Unix timestamp (ms) of the last detected change. */
  lastChanged: number;
  /** Detection method used for this source. */
  detectionMethod: DetectionMethod;
  /** Hash/fingerprint from the previous check. */
  previousHash: string;
  /** Hash/fingerprint from the current check. */
  currentHash: string;
}

/**
 * Row shape returned from the kb_freshness + kb_sources joined query.
 */
interface FreshnessRow {
  source_id: string;
  state: string;
  detection_method: string;
  previous_hash: string | null;
  current_hash: string | null;
  last_checked_at: number;
  last_changed_at: number | null;
}

/**
 * Row shape for source info from kb_sources.
 */
interface SourceRow {
  id: string;
  uri: string;
  type: string;
  project_id: string;
}

// ─── Freshness Tracker ──────────────────────────────────────────

/**
 * FreshnessTracker — monitors KB sources for content changes and triggers
 * re-indexing when staleness is detected.
 *
 * Detection strategies:
 * - `mtime`: For local-files, pdf-document, docx-document, csv-file, json-file, markdown-wiki.
 *   Checks file modification time and compares against stored fingerprint.
 * - `commit-hash`: For git-repository sources. Checks the latest commit hash
 *   of the tracked branch.
 * - `etag` / `last-modified`: For url-website sources. Uses HTTP HEAD request
 *   to detect content changes via ETag or Last-Modified headers.
 *
 * When staleness is detected:
 * 1. Updates the kb_freshness table state to 'stale'
 * 2. Emits a `kb.freshness.stale` event to the EventLog
 * 3. The scheduler (separate component) picks up stale sources for re-indexing
 */
export class FreshnessTracker {
  constructor(
    private readonly db: Database.Database,
    private readonly eventLog: EventLog,
    private readonly connectorFramework: ConnectorFramework,
  ) {}

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Check a single source for freshness. Detects changes using the
   * appropriate detection method and updates state accordingly.
   *
   * @param sourceId - The source ID to check (references kb_sources.id)
   * @returns The updated FreshnessRecord
   */
  async checkSource(sourceId: string): Promise<FreshnessRecord> {
    const source = this.getSource(sourceId);
    if (!source) {
      throw new Error(`Source "${sourceId}" not found in kb_sources`);
    }

    const detectionMethod = this.resolveDetectionMethod(source.type as ConnectorType);
    const currentHash = await this.computeCurrentHash(source.uri, source.type as ConnectorType);
    const existingRecord = this.getExistingRecord(sourceId);

    const now = Date.now();
    const previousHash = existingRecord?.previous_hash ?? '';
    const storedHash = existingRecord?.current_hash ?? '';

    // Determine if the source has changed
    const isChanged = storedHash !== '' && currentHash !== storedHash;

    if (isChanged) {
      // Mark as stale
      this.upsertFreshnessRecord(sourceId, {
        state: 'stale',
        detectionMethod,
        previousHash: storedHash,
        currentHash,
        lastCheckedAt: now,
        lastChangedAt: now,
      });

      // Emit stale event
      await this.emitStaleEvent(sourceId, source.uri, detectionMethod, storedHash, currentHash);

      return {
        sourceUri: source.uri,
        sourceId,
        state: 'stale',
        lastChecked: now,
        lastChanged: now,
        detectionMethod,
        previousHash: storedHash,
        currentHash,
      };
    }

    // Source is fresh — update check timestamp
    this.upsertFreshnessRecord(sourceId, {
      state: existingRecord?.state === 're-indexing' ? 're-indexing' : 'fresh',
      detectionMethod,
      previousHash: previousHash,
      currentHash: currentHash,
      lastCheckedAt: now,
      lastChangedAt: existingRecord?.last_changed_at ?? now,
    });

    return {
      sourceUri: source.uri,
      sourceId,
      state: (existingRecord?.state as FreshnessState) ?? 'fresh',
      lastChecked: now,
      lastChanged: existingRecord?.last_changed_at ?? now,
      detectionMethod,
      previousHash,
      currentHash,
    };
  }

  /**
   * Check all registered sources for freshness changes.
   *
   * @returns Array of FreshnessRecords for all sources
   */
  async checkAll(): Promise<FreshnessRecord[]> {
    const sources = this.getAllSources();
    const results: FreshnessRecord[] = [];

    for (const source of sources) {
      try {
        const record = await this.checkSource(source.id);
        results.push(record);
      } catch (error) {
        // If a single source check fails, continue with others
        // but include an error-state record
        results.push({
          sourceUri: source.uri,
          sourceId: source.id,
          state: 'stale',
          lastChecked: Date.now(),
          lastChanged: Date.now(),
          detectionMethod: this.resolveDetectionMethod(source.type as ConnectorType),
          previousHash: '',
          currentHash: '',
        });
      }
    }

    return results;
  }

  /**
   * Mark a source as currently being re-indexed.
   * Emits a `kb.freshness.reindex` event.
   *
   * @param sourceId - The source ID to mark as re-indexing
   */
  async markReindexing(sourceId: string): Promise<void> {
    const source = this.getSource(sourceId);
    if (!source) {
      throw new Error(`Source "${sourceId}" not found in kb_sources`);
    }

    const existingRecord = this.getExistingRecord(sourceId);
    const detectionMethod = this.resolveDetectionMethod(source.type as ConnectorType);
    const now = Date.now();

    this.upsertFreshnessRecord(sourceId, {
      state: 're-indexing',
      detectionMethod,
      previousHash: existingRecord?.previous_hash ?? '',
      currentHash: existingRecord?.current_hash ?? '',
      lastCheckedAt: now,
      lastChangedAt: existingRecord?.last_changed_at ?? now,
    });

    // Emit reindex event
    await this.emitReindexEvent(sourceId, source.uri);
  }

  /**
   * Mark a source as fresh after successful re-indexing.
   * Updates the stored hash to the new value.
   *
   * @param sourceId - The source ID to mark as fresh
   * @param newHash - The new content hash after re-indexing
   */
  async markFresh(sourceId: string, newHash: string): Promise<void> {
    const source = this.getSource(sourceId);
    if (!source) {
      throw new Error(`Source "${sourceId}" not found in kb_sources`);
    }

    const existingRecord = this.getExistingRecord(sourceId);
    const detectionMethod = this.resolveDetectionMethod(source.type as ConnectorType);
    const now = Date.now();

    this.upsertFreshnessRecord(sourceId, {
      state: 'fresh',
      detectionMethod,
      previousHash: existingRecord?.current_hash ?? '',
      currentHash: newHash,
      lastCheckedAt: now,
      lastChangedAt: existingRecord?.last_changed_at ?? now,
    });
  }

  // ─── Detection Methods (Private) ───────────────────────────

  /**
   * Resolve the appropriate detection method based on connector type.
   */
  private resolveDetectionMethod(connectorType: ConnectorType): DetectionMethod {
    switch (connectorType) {
      case 'git-repository':
        return 'commit-hash';
      case 'url-website':
        return 'etag';
      case 'local-files':
      case 'pdf-document':
      case 'docx-document':
      case 'csv-file':
      case 'json-file':
      case 'markdown-wiki':
      default:
        return 'mtime';
    }
  }

  /**
   * Compute the current content hash/fingerprint for a source.
   * Uses the appropriate detection mechanism based on connector type.
   */
  private async computeCurrentHash(uri: string, connectorType: ConnectorType): Promise<string> {
    switch (connectorType) {
      case 'local-files':
      case 'pdf-document':
      case 'docx-document':
      case 'csv-file':
      case 'json-file':
      case 'markdown-wiki':
        return this.computeMtimeHash(uri);

      case 'git-repository':
        return this.computeCommitHash(uri);

      case 'url-website':
        return this.computeEtagHash(uri);

      default:
        return this.computeMtimeHash(uri);
    }
  }

  /**
   * Compute a hash based on file modification time.
   * For file-based sources, the mtime serves as the change indicator.
   */
  private async computeMtimeHash(filePath: string): Promise<string> {
    try {
      const stats = await stat(filePath);
      const fingerprint = `${stats.mtimeMs}:${stats.size}`;
      return createHash('sha256').update(fingerprint).digest('hex');
    } catch {
      // If file doesn't exist or is inaccessible, return empty hash
      // This will trigger a stale detection if there was a previous hash
      return '';
    }
  }

  /**
   * Compute a hash based on the latest git commit.
   * Uses the repository HEAD commit hash as the change indicator.
   */
  private async computeCommitHash(repoUri: string): Promise<string> {
    try {
      // For git repositories, we use the commit hash from the source entry
      // The actual git operations are handled by the connector framework
      // Here we compute a fingerprint based on what we can detect
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Try to get the latest commit hash using git ls-remote
      // This works for both local and remote repositories
      const { stdout } = await execFileAsync('git', ['ls-remote', repoUri, 'HEAD'], {
        timeout: 10_000,
      });

      const commitHash = stdout.trim().split(/\s+/)[0] ?? '';
      return commitHash || createHash('sha256').update(repoUri + Date.now()).digest('hex');
    } catch {
      // If git operation fails, try local repo path
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          timeout: 5_000,
          cwd: repoUri,
        });
        return stdout.trim();
      } catch {
        return '';
      }
    }
  }

  /**
   * Compute a hash based on HTTP ETag or Last-Modified header.
   * Uses a HEAD request to check for content changes without downloading.
   */
  private async computeEtagHash(url: string): Promise<string> {
    try {
      // Use native fetch (available in Node 18+) for HEAD request
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
      });

      // Prefer ETag, fall back to Last-Modified
      const etag = response.headers.get('etag');
      if (etag) {
        return createHash('sha256').update(`etag:${etag}`).digest('hex');
      }

      const lastModified = response.headers.get('last-modified');
      if (lastModified) {
        return createHash('sha256').update(`last-modified:${lastModified}`).digest('hex');
      }

      // If neither header is present, use content-length + status as rough indicator
      const contentLength = response.headers.get('content-length') ?? '0';
      return createHash('sha256').update(`cl:${contentLength}:${response.status}`).digest('hex');
    } catch {
      return '';
    }
  }

  // ─── Database Operations (Private) ─────────────────────────

  /**
   * Get source info from kb_sources table.
   */
  private getSource(sourceId: string): SourceRow | undefined {
    const stmt = this.db.prepare(
      'SELECT id, uri, type, project_id FROM kb_sources WHERE id = ?',
    );
    return stmt.get(sourceId) as SourceRow | undefined;
  }

  /**
   * Get all sources from kb_sources table.
   */
  private getAllSources(): SourceRow[] {
    const stmt = this.db.prepare('SELECT id, uri, type, project_id FROM kb_sources');
    return stmt.all() as SourceRow[];
  }

  /**
   * Get existing freshness record from kb_freshness table.
   */
  private getExistingRecord(sourceId: string): FreshnessRow | undefined {
    const stmt = this.db.prepare(
      'SELECT source_id, state, detection_method, previous_hash, current_hash, last_checked_at, last_changed_at FROM kb_freshness WHERE source_id = ?',
    );
    return stmt.get(sourceId) as FreshnessRow | undefined;
  }

  /**
   * Insert or update a freshness record in the kb_freshness table.
   */
  private upsertFreshnessRecord(
    sourceId: string,
    data: {
      state: FreshnessState;
      detectionMethod: DetectionMethod;
      previousHash: string;
      currentHash: string;
      lastCheckedAt: number;
      lastChangedAt: number;
    },
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO kb_freshness (source_id, state, detection_method, previous_hash, current_hash, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        state = excluded.state,
        detection_method = excluded.detection_method,
        previous_hash = excluded.previous_hash,
        current_hash = excluded.current_hash,
        last_checked_at = excluded.last_checked_at,
        last_changed_at = excluded.last_changed_at
    `);

    stmt.run(
      sourceId,
      data.state,
      data.detectionMethod,
      data.previousHash,
      data.currentHash,
      data.lastCheckedAt,
      data.lastChangedAt,
    );
  }

  // ─── Event Emission (Private) ──────────────────────────────

  /**
   * Emit a `kb.freshness.stale` event to the EventLog.
   */
  private async emitStaleEvent(
    sourceId: string,
    sourceUri: string,
    detectionMethod: DetectionMethod,
    previousHash: string,
    currentHash: string,
  ): Promise<void> {
    await this.eventLog.emit({
      sessionId: KB_SOURCE_IDENTIFIERS.FRESHNESS,
      kind: KB_EVENT_KINDS.FRESHNESS_STALE as EventKind,
      payload: {
        sourceUri,
        sourceId,
        detectionMethod,
        previousHash,
        currentHash,
      },
    });
  }

  /**
   * Emit a `kb.freshness.reindex` event to the EventLog.
   */
  private async emitReindexEvent(sourceId: string, sourceUri: string): Promise<void> {
    await this.eventLog.emit({
      sessionId: KB_SOURCE_IDENTIFIERS.FRESHNESS,
      kind: KB_EVENT_KINDS.FRESHNESS_REINDEX as EventKind,
      payload: {
        sourceUri,
        sourceId,
        trigger: 'on-change' as const,
      },
    });
  }
}
