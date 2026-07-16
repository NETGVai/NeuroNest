/**
 * Rewind Service — Content-addressed blob store for pre-mutation file snapshots.
 *
 * Stores file content before writes as SHA-256 blobs in `.neuronest/blobs/`.
 * Supports snapshot, rewind, and cleanup operations with content deduplication.
 *
 * Blob path layout: `.neuronest/blobs/<first-2-chars>/<rest-of-sha256>`
 * Multiple tool calls writing the same file content reference the same blob.
 *
 * Validates: Requirements 14.4, 14.5, 14.6
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

/** A mapping entry recording (file, callId) → blobHash. */
export interface SnapshotEntry {
  /** Absolute file path that was snapshotted. */
  file: string;
  /** Tool call ID associated with this snapshot. */
  toolCallId: string;
  /** SHA-256 hash of the file content (blob identifier). */
  blobHash: string;
  /** ISO-8601 timestamp of when the snapshot was taken. */
  timestamp: string;
  /** Size in bytes of the snapshotted content. */
  size: number;
}

/** Result of a rewind operation. */
export interface RewindResult {
  /** Files successfully restored. */
  restored: string[];
  /** Files that could not be restored (blob missing, etc.). */
  failed: Array<{ file: string; reason: string }>;
}

/** Options for the RewindService constructor. */
export interface RewindServiceOptions {
  /** Base directory for the blob store (default: `.neuronest/blobs`). */
  blobDir: string;
  /** Per-file size cap in bytes. Files larger than this are skipped. */
  maxFileSize?: number;
}

// ─── RewindService Implementation ───────────────────────────────

/**
 * Content-addressed blob store that captures pre-mutation file snapshots
 * and restores them on rewind.
 */
export class RewindService {
  /** Base directory for blob storage. */
  private readonly blobDir: string;

  /** Per-file size cap (default: 10 MB). */
  private readonly maxFileSize: number;

  /**
   * Mapping table: key = `${file}\0${toolCallId}` → SnapshotEntry.
   * This tracks which files were snapshotted for which tool calls.
   */
  private readonly snapshots: Map<string, SnapshotEntry> = new Map();

  /** Index: toolCallId → list of snapshot keys for fast rewind lookup. */
  private readonly byToolCallId: Map<string, string[]> = new Map();

  /** Track which blob hashes exist (for deduplication). */
  private readonly knownBlobs: Set<string> = new Set();

  constructor(options: RewindServiceOptions) {
    this.blobDir = options.blobDir;
    this.maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10 MB default
  }

  /**
   * Snapshot a file's content before a write operation.
   * Computes SHA-256 of the file content, stores as a content-addressed blob,
   * and records the mapping (file, toolCallId) → blobHash.
   *
   * If the blob already exists (same content snapshotted before), it is not
   * written again — content deduplication.
   *
   * Validates: Requirement 14.4 — content-addressed pre-images, deduplication.
   * Validates: Requirement 14.5 — snapshot before writes.
   *
   * @returns The blob hash, or null if the file was skipped (too large, unreadable).
   */
  async snapshot(file: string, toolCallId: string): Promise<string | null> {
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      // File doesn't exist or is unreadable — nothing to snapshot
      return null;
    }

    // Enforce per-file size cap
    if (content.length > this.maxFileSize) {
      // Log skipped oversized snapshot (Req 14.5)
      // eslint-disable-next-line no-console
      console.warn(
        `[rewind-service] Skipping oversized file (${content.length} bytes > ${this.maxFileSize}): ${file}`,
      );
      return null;
    }

    const hash = createHash('sha256').update(content).digest('hex');
    const blobPath = this.getBlobPath(hash);

    // Write blob only if not already stored (deduplication)
    if (!this.knownBlobs.has(hash)) {
      await mkdir(dirname(blobPath), { recursive: true });
      await writeFile(blobPath, content);
      this.knownBlobs.add(hash);
    }

    // Record the mapping
    const key = this.makeKey(file, toolCallId);
    const entry: SnapshotEntry = {
      file,
      toolCallId,
      blobHash: hash,
      timestamp: new Date().toISOString(),
      size: content.length,
    };

    this.snapshots.set(key, entry);

    // Index by toolCallId
    const callKeys = this.byToolCallId.get(toolCallId) ?? [];
    callKeys.push(key);
    this.byToolCallId.set(toolCallId, callKeys);

    return hash;
  }

  /**
   * Rewind all files affected by a given tool call to their pre-mutation state.
   *
   * Validates: Requirement 14.6 — restore all affected files from pre-images.
   */
  async rewind(callId: string): Promise<RewindResult> {
    const keys = this.byToolCallId.get(callId);
    if (!keys || keys.length === 0) {
      return { restored: [], failed: [] };
    }

    const restored: string[] = [];
    const failed: Array<{ file: string; reason: string }> = [];

    for (const key of keys) {
      const entry = this.snapshots.get(key);
      if (!entry) {
        failed.push({ file: key, reason: 'Snapshot entry not found' });
        continue;
      }

      const blobPath = this.getBlobPath(entry.blobHash);
      try {
        const content = await readFile(blobPath);
        await mkdir(dirname(entry.file), { recursive: true });
        await writeFile(entry.file, content);
        restored.push(entry.file);
      } catch (err) {
        failed.push({
          file: entry.file,
          reason: `Failed to restore: ${(err as Error).message}`,
        });
      }
    }

    return { restored, failed };
  }

  /**
   * Restore a single file from its snapshot for a specific tool call.
   *
   * @returns true if restored, false if snapshot not found or restore failed.
   */
  async rewindFile(file: string, callId: string): Promise<boolean> {
    const key = this.makeKey(file, callId);
    const entry = this.snapshots.get(key);
    if (!entry) return false;

    const blobPath = this.getBlobPath(entry.blobHash);
    try {
      const content = await readFile(blobPath);
      await mkdir(dirname(entry.file), { recursive: true });
      await writeFile(entry.file, content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a snapshot exists for a given file and tool call.
   */
  hasSnapshot(file: string, callId: string): boolean {
    return this.snapshots.has(this.makeKey(file, callId));
  }

  /**
   * Get all snapshot entries for a given tool call.
   */
  getSnapshotsForCall(callId: string): SnapshotEntry[] {
    const keys = this.byToolCallId.get(callId);
    if (!keys) return [];
    return keys
      .map((k) => this.snapshots.get(k))
      .filter((e): e is SnapshotEntry => e !== undefined);
  }

  /**
   * Get all snapshot entries across all tool calls.
   */
  getAllSnapshots(): SnapshotEntry[] {
    return Array.from(this.snapshots.values());
  }

  /**
   * Remove orphaned blobs that are no longer referenced by any snapshot entry.
   * Optionally filter to blobs older than a given age.
   *
   * @param olderThanMs If provided, only remove blobs whose snapshot timestamp
   *   is older than this many milliseconds.
   * @returns Number of blobs removed.
   */
  async cleanup(olderThanMs?: number): Promise<number> {
    // Determine which blobs are still referenced
    const referencedHashes = new Set<string>();
    const now = Date.now();
    const entriesToRemove: string[] = [];

    for (const [key, entry] of this.snapshots) {
      if (olderThanMs !== undefined) {
        const age = now - new Date(entry.timestamp).getTime();
        if (age >= olderThanMs) {
          entriesToRemove.push(key);
        } else {
          referencedHashes.add(entry.blobHash);
        }
      } else {
        // Without age filter, all entries are "orphaned" candidates — skip
        referencedHashes.add(entry.blobHash);
      }
    }

    // Remove old entries from the mapping
    for (const key of entriesToRemove) {
      const entry = this.snapshots.get(key);
      if (entry) {
        // Remove from byToolCallId index
        const callKeys = this.byToolCallId.get(entry.toolCallId);
        if (callKeys) {
          const idx = callKeys.indexOf(key);
          if (idx !== -1) callKeys.splice(idx, 1);
          if (callKeys.length === 0) this.byToolCallId.delete(entry.toolCallId);
        }
      }
      this.snapshots.delete(key);
    }

    // Recompute referenced hashes after removal
    const stillReferenced = new Set<string>();
    for (const entry of this.snapshots.values()) {
      stillReferenced.add(entry.blobHash);
    }

    // Collect unreferenced blob hashes
    const toDelete: string[] = [];
    for (const hash of this.knownBlobs) {
      if (!stillReferenced.has(hash)) {
        toDelete.push(hash);
      }
    }

    // Delete unreferenced blobs from disk
    let removed = 0;
    for (const hash of toDelete) {
      const blobPath = this.getBlobPath(hash);
      try {
        await unlink(blobPath);
        removed++;
      } catch {
        // Blob may already be deleted, ignore
      }
      this.knownBlobs.delete(hash);
    }

    return removed;
  }

  /**
   * Scan the blob directory and populate the knownBlobs set.
   * Useful when constructing a RewindService against an existing blob store.
   */
  async loadExistingBlobs(): Promise<void> {
    if (!existsSync(this.blobDir)) return;

    try {
      const prefixes = await readdir(this.blobDir);
      for (const prefix of prefixes) {
        const prefixPath = join(this.blobDir, prefix);
        const prefixStat = await stat(prefixPath);
        if (!prefixStat.isDirectory()) continue;

        const files = await readdir(prefixPath);
        for (const file of files) {
          const hash = prefix + file;
          this.knownBlobs.add(hash);
        }
      }
    } catch {
      // Directory may not exist yet, that's fine
    }
  }

  /**
   * Get the total number of snapshot entries.
   */
  size(): number {
    return this.snapshots.size;
  }

  /**
   * Get the number of unique blobs stored.
   */
  blobCount(): number {
    return this.knownBlobs.size;
  }

  /**
   * Clear all in-memory state (for testing or session reset).
   */
  clear(): void {
    this.snapshots.clear();
    this.byToolCallId.clear();
    this.knownBlobs.clear();
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Compute the on-disk path for a blob given its SHA-256 hash.
   * Layout: `<blobDir>/<first-2-chars>/<rest-of-hash>`
   */
  private getBlobPath(hash: string): string {
    const prefix = hash.substring(0, 2);
    const rest = hash.substring(2);
    return join(this.blobDir, prefix, rest);
  }

  /**
   * Create a composite map key from file path and tool call ID.
   */
  private makeKey(file: string, toolCallId: string): string {
    return `${file}\0${toolCallId}`;
  }
}
