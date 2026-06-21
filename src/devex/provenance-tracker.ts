/**
 * ProvenanceTracker — AI code attribution and line-level provenance tracking.
 *
 * Records which agent (role, session, model) wrote or modified each line of code,
 * storing provenance data in `.provenance.json` sidecar files alongside source files.
 * Supports querying attribution for any file/line-range, distinguishes human-written
 * from AI-generated code, and handles line-number drift after merge/rebase via
 * git diff hunk remapping.
 *
 * Key behaviors:
 * - Sidecar files stored as `.provenance.json` alongside each tracked source file
 * - recordChanges() logs agent role, session ID, model, and timestamp per line range
 * - query() returns full attribution chain for a file or line range
 * - remapAfterDiff() adjusts line numbers based on git diff hunks
 * - Human-written code is marked with origin='human' when file changes occur outside agent sessions
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

/** A single provenance entry representing attribution for a contiguous line range */
export interface ProvenanceEntry {
  /** Start line (1-based inclusive) */
  startLine: number;
  /** End line (1-based inclusive) */
  endLine: number;
  /** Origin of the code: 'ai' for agent-generated, 'human' for human-written */
  origin: 'ai' | 'human';
  /** Agent role that made the change (e.g., 'implementer', 'architect') — null for human origin */
  agentRole: string | null;
  /** Session ID during which the change was made — null for human origin */
  sessionId: string | null;
  /** Model used by the agent (e.g., 'claude-sonnet-4-20250514') — null for human origin */
  model: string | null;
  /** ISO 8601 timestamp of when the change was recorded */
  timestamp: string;
}

/** The provenance file schema stored as .provenance.json sidecar */
export interface ProvenanceFile {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** Relative path to the source file this provenance tracks */
  sourceFile: string;
  /** Ordered list of provenance entries (sorted by startLine) */
  entries: ProvenanceEntry[];
  /** ISO 8601 timestamp of last update to this provenance file */
  lastUpdated: string;
}

/** Parameters for recording a change */
export interface RecordChangesParams {
  /** Absolute path to the modified source file */
  filePath: string;
  /** Start line of the modification (1-based inclusive) */
  startLine: number;
  /** End line of the modification (1-based inclusive) */
  endLine: number;
  /** Origin of the change */
  origin: 'ai' | 'human';
  /** Agent role (required when origin is 'ai') */
  agentRole?: string;
  /** Session ID (required when origin is 'ai') */
  sessionId?: string;
  /** Model identifier (required when origin is 'ai') */
  model?: string;
}

/** A single hunk from a git diff used for line remapping */
export interface DiffHunk {
  /** Original start line in the old file (1-based) */
  oldStart: number;
  /** Number of lines in the old range */
  oldCount: number;
  /** New start line in the new file (1-based) */
  newStart: number;
  /** Number of lines in the new range */
  newCount: number;
}

/** Result of a provenance query */
export interface ProvenanceQueryResult {
  /** The source file path */
  filePath: string;
  /** Entries matching the queried line range */
  entries: ProvenanceEntry[];
}

// ─── Constants ──────────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 1;
const SIDECAR_SUFFIX = '.provenance.json';

// ─── ProvenanceTracker Class ────────────────────────────────────

export class ProvenanceTracker {
  constructor() {}

  /**
   * Record code changes with provenance attribution.
   *
   * Creates or updates the `.provenance.json` sidecar file for the given source file,
   * merging the new entry into the existing provenance data. Overlapping entries are
   * split or replaced as needed.
   *
   * Requirements: 20.1, 20.4
   */
  recordChanges(params: RecordChangesParams): void {
    const { filePath, startLine, endLine, origin, agentRole, sessionId, model } = params;

    if (startLine < 1 || endLine < startLine) {
      throw new Error(`Invalid line range: startLine=${startLine}, endLine=${endLine}`);
    }

    const entry: ProvenanceEntry = {
      startLine,
      endLine,
      origin,
      agentRole: origin === 'ai' ? (agentRole ?? null) : null,
      sessionId: origin === 'ai' ? (sessionId ?? null) : null,
      model: origin === 'ai' ? (model ?? null) : null,
      timestamp: new Date().toISOString(),
    };

    const sidecarPath = this.getSidecarPath(filePath);
    const provenanceFile = this.loadProvenanceFile(sidecarPath, filePath);

    // Merge new entry into existing entries, handling overlaps
    provenanceFile.entries = this.mergeEntry(provenanceFile.entries, entry);
    provenanceFile.lastUpdated = new Date().toISOString();

    this.saveProvenanceFile(sidecarPath, provenanceFile);
  }

  /**
   * Query provenance for a file or line range.
   *
   * Returns all provenance entries that overlap with the requested line range.
   * If no line range is specified, returns all entries for the file.
   *
   * Requirements: 20.3
   */
  query(filePath: string, startLine?: number, endLine?: number): ProvenanceQueryResult {
    const sidecarPath = this.getSidecarPath(filePath);

    if (!fs.existsSync(sidecarPath)) {
      return { filePath, entries: [] };
    }

    const provenanceFile = this.loadProvenanceFile(sidecarPath, filePath);

    let entries = provenanceFile.entries;

    if (startLine !== undefined && endLine !== undefined) {
      entries = entries.filter(
        (e) => e.endLine >= startLine && e.startLine <= endLine,
      );
    } else if (startLine !== undefined) {
      entries = entries.filter((e) => e.endLine >= startLine);
    }

    return { filePath, entries };
  }

  /**
   * Remap provenance entries after line-number drift caused by merge/rebase.
   *
   * Applies diff hunks to adjust line numbers in the provenance file. Entries
   * that fall entirely within a deleted hunk range are removed (invalidated).
   * Entries that partially overlap a hunk boundary are split or trimmed.
   *
   * Requirements: 20.5
   */
  remapAfterDiff(filePath: string, hunks: DiffHunk[]): void {
    const sidecarPath = this.getSidecarPath(filePath);

    if (!fs.existsSync(sidecarPath)) {
      return; // No provenance to remap
    }

    const provenanceFile = this.loadProvenanceFile(sidecarPath, filePath);

    if (provenanceFile.entries.length === 0 || hunks.length === 0) {
      return;
    }

    // Sort hunks by oldStart in ascending order for sequential processing
    const sortedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

    const remappedEntries: ProvenanceEntry[] = [];

    for (const entry of provenanceFile.entries) {
      const remapped = this.remapEntry(entry, sortedHunks);
      if (remapped) {
        remappedEntries.push(remapped);
      }
      // Entry is dropped (invalidated) if remapEntry returns null
    }

    provenanceFile.entries = this.normalizeEntries(remappedEntries);
    provenanceFile.lastUpdated = new Date().toISOString();

    this.saveProvenanceFile(sidecarPath, provenanceFile);
  }

  /**
   * Check if a provenance sidecar file exists for the given source file.
   */
  hasSidecar(filePath: string): boolean {
    return fs.existsSync(this.getSidecarPath(filePath));
  }

  /**
   * Get the sidecar file path for a given source file.
   */
  getSidecarPath(filePath: string): string {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return path.join(dir, base + SIDECAR_SUFFIX);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Merge a new provenance entry into existing entries, handling overlaps.
   *
   * The new entry takes precedence over existing entries in the overlapping range:
   * - Existing entries entirely covered by new entry are removed
   * - Existing entries partially overlapping are trimmed
   * - Non-overlapping entries are preserved unchanged
   */
  private mergeEntry(existing: ProvenanceEntry[], newEntry: ProvenanceEntry): ProvenanceEntry[] {
    const result: ProvenanceEntry[] = [];

    for (const entry of existing) {
      // No overlap — entry is entirely before or after the new entry
      if (entry.endLine < newEntry.startLine || entry.startLine > newEntry.endLine) {
        result.push(entry);
        continue;
      }

      // Entry is entirely covered by new entry — remove it
      if (entry.startLine >= newEntry.startLine && entry.endLine <= newEntry.endLine) {
        continue;
      }

      // Partial overlap — trim the existing entry
      if (entry.startLine < newEntry.startLine) {
        // Keep the portion before the new entry
        result.push({ ...entry, endLine: newEntry.startLine - 1 });
      }
      if (entry.endLine > newEntry.endLine) {
        // Keep the portion after the new entry
        result.push({ ...entry, startLine: newEntry.endLine + 1 });
      }
    }

    // Insert the new entry
    result.push(newEntry);

    return this.normalizeEntries(result);
  }

  /**
   * Sort entries by startLine and merge adjacent entries with identical attribution.
   */
  private normalizeEntries(entries: ProvenanceEntry[]): ProvenanceEntry[] {
    if (entries.length === 0) return [];

    // Sort by startLine
    const sorted = [...entries].sort((a, b) => a.startLine - b.startLine);

    // Merge adjacent entries with identical attribution
    const merged: ProvenanceEntry[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sorted[i];

      if (
        prev.endLine + 1 === curr.startLine &&
        prev.origin === curr.origin &&
        prev.agentRole === curr.agentRole &&
        prev.sessionId === curr.sessionId &&
        prev.model === curr.model
      ) {
        // Merge adjacent entries with same attribution
        prev.endLine = curr.endLine;
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  /**
   * Remap a single entry's line numbers based on diff hunks.
   * Returns null if the entry is entirely invalidated (deleted by hunks).
   */
  private remapEntry(entry: ProvenanceEntry, hunks: DiffHunk[]): ProvenanceEntry | null {
    let { startLine, endLine } = entry;
    let offset = 0;

    for (const hunk of hunks) {
      const hunkOldEnd = hunk.oldStart + hunk.oldCount - 1;
      const lineDelta = hunk.newCount - hunk.oldCount;

      // Entry is entirely before this hunk — no further adjustment needed from this hunk
      if (endLine < hunk.oldStart) {
        break;
      }

      // Entry is entirely after this hunk — accumulate offset
      if (startLine > hunkOldEnd) {
        offset += lineDelta;
        continue;
      }

      // Entry is entirely within the deleted portion of this hunk
      if (startLine >= hunk.oldStart && endLine <= hunkOldEnd && hunk.newCount === 0) {
        return null; // Entry invalidated
      }

      // Entry overlaps hunk — apply partial invalidation/trimming
      if (startLine >= hunk.oldStart && endLine <= hunkOldEnd) {
        // Entry is entirely within the hunk range
        // If the hunk has replacement lines, remap to new range
        if (hunk.newCount > 0) {
          startLine = hunk.newStart + offset;
          endLine = hunk.newStart + hunk.newCount - 1 + offset;
        } else {
          return null; // Entire entry deleted
        }
        offset += lineDelta;
        continue;
      }

      // Entry starts before hunk and extends into or beyond it
      if (startLine < hunk.oldStart && endLine >= hunk.oldStart) {
        // Trim end to before the hunk if hunk deletes lines
        if (hunk.newCount < hunk.oldCount) {
          // Adjust: the portion in the hunk may be partially preserved
          endLine = Math.min(endLine + lineDelta, endLine);
        }
        offset += lineDelta;
        continue;
      }

      // Entry starts within hunk and extends beyond it
      if (startLine >= hunk.oldStart && startLine <= hunkOldEnd && endLine > hunkOldEnd) {
        // Adjust start to after the hunk's new range
        startLine = hunk.newStart + hunk.newCount + offset;
        offset += lineDelta;
        continue;
      }

      offset += lineDelta;
    }

    // Apply accumulated offset
    startLine += offset;
    endLine += offset;

    // Validate remapped range
    if (startLine < 1) startLine = 1;
    if (endLine < startLine) return null;

    return { ...entry, startLine, endLine };
  }

  /**
   * Load a provenance sidecar file. Returns a fresh ProvenanceFile if not found or invalid.
   */
  private loadProvenanceFile(sidecarPath: string, sourceFilePath: string): ProvenanceFile {
    if (!fs.existsSync(sidecarPath)) {
      return this.createEmptyProvenanceFile(sourceFilePath);
    }

    try {
      const raw = fs.readFileSync(sidecarPath, 'utf-8');
      const parsed = JSON.parse(raw) as ProvenanceFile;

      // Basic schema validation
      if (
        typeof parsed.schemaVersion !== 'number' ||
        !Array.isArray(parsed.entries)
      ) {
        return this.createEmptyProvenanceFile(sourceFilePath);
      }

      return parsed;
    } catch {
      // Corrupted or unreadable — start fresh
      return this.createEmptyProvenanceFile(sourceFilePath);
    }
  }

  /**
   * Save a provenance file to disk, creating directories if needed.
   */
  private saveProvenanceFile(sidecarPath: string, data: ProvenanceFile): void {
    const dir = path.dirname(sidecarPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Create an empty ProvenanceFile structure for a new source file.
   */
  private createEmptyProvenanceFile(sourceFilePath: string): ProvenanceFile {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sourceFile: path.basename(sourceFilePath),
      entries: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}
