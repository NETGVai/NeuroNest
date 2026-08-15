/**
 * CanonicalDiffComputer — Computes the canonical final diff from immutable base
 * blobs and final proposed blobs. Designed to run off the main thread (worker-friendly).
 *
 * Produces a deterministic diff output regardless of streaming order. The diff
 * is computed purely from the base content and proposed content — no streaming
 * state is considered.
 *
 * Requirements: 5.5, 5.6, 7.1, 7.2
 */

/**
 * Represents a single diff hunk — a contiguous region of changes.
 */
export interface DiffHunk {
  /** Start line in the base content (0-indexed) */
  readonly baseStart: number;
  /** Number of lines from base content in this hunk */
  readonly baseLength: number;
  /** Start line in the proposed content (0-indexed) */
  readonly proposedStart: number;
  /** Number of lines in the proposed content in this hunk */
  readonly proposedLength: number;
  /** Lines removed from base (prefixed with '-') */
  readonly removals: readonly string[];
  /** Lines added in proposed (prefixed with '+') */
  readonly additions: readonly string[];
  /** Context lines around the change */
  readonly context: readonly string[];
}

/**
 * Represents the canonical diff for a single file operation.
 */
export interface FileDiff {
  /** The target file URI */
  readonly targetUri: string;
  /** The operation kind */
  readonly kind: 'create' | 'modify' | 'delete';
  /** The base content (null for create) */
  readonly baseContent: string | null;
  /** The proposed content (null for delete) */
  readonly proposedContent: string | null;
  /** Array of diff hunks */
  readonly hunks: readonly DiffHunk[];
  /** Total lines added */
  readonly additions: number;
  /** Total lines removed */
  readonly removals: number;
  /** Content hash of the base blob */
  readonly baseHash: string;
  /** Content hash of the proposed blob */
  readonly proposedHash: string;
}

/**
 * Input for computing a canonical diff for a file.
 */
export interface DiffInput {
  /** The target file URI */
  readonly targetUri: string;
  /** The operation kind */
  readonly kind: 'create' | 'modify' | 'delete';
  /** The immutable base blob content (null for create) */
  readonly baseBlob: string | null;
  /** The final proposed blob content (null for delete) */
  readonly proposedBlob: string | null;
}

/**
 * Result from a canonical diff computation.
 */
export interface CanonicalDiffResult {
  /** Computed file diffs, one per file */
  readonly fileDiffs: readonly FileDiff[];
  /** Whether the computation completed successfully */
  readonly success: boolean;
  /** Total computation time in milliseconds */
  readonly computeTimeMs: number;
  /** A deterministic fingerprint of the entire diff result */
  readonly fingerprint: string;
}

/**
 * Computes a simple content hash (for worker-friendly environments).
 * In production this would use crypto.subtle or a WASM hasher.
 */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Splits content into lines, preserving empty final line state.
 */
function splitLines(content: string): string[] {
  if (content === '') return [''];
  return content.split('\n');
}

/**
 * Computes the Longest Common Subsequence (LCS) length table for two arrays of lines.
 * This is the core of the Myers-style diff algorithm simplified for clarity.
 */
function computeLCSTable(baseLines: string[], proposedLines: string[]): number[][] {
  const m = baseLines.length;
  const n = proposedLines.length;
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseLines[i - 1] === proposedLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

/**
 * Backtrack from LCS table to produce diff operations.
 */
interface DiffOp {
  kind: 'equal' | 'add' | 'remove';
  baseLine?: number;
  proposedLine?: number;
  content: string;
}

function backtrackDiff(
  table: number[][],
  baseLines: string[],
  proposedLines: string[]
): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = baseLines.length;
  let j = proposedLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === proposedLines[j - 1]) {
      ops.unshift({
        kind: 'equal',
        baseLine: i - 1,
        proposedLine: j - 1,
        content: baseLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.unshift({
        kind: 'add',
        proposedLine: j - 1,
        content: proposedLines[j - 1],
      });
      j--;
    } else {
      ops.unshift({
        kind: 'remove',
        baseLine: i - 1,
        content: baseLines[i - 1],
      });
      i--;
    }
  }

  return ops;
}

/**
 * Groups diff operations into hunks with context lines.
 */
function groupIntoHunks(ops: DiffOp[], contextLines: number = 3): DiffHunk[] {
  if (ops.length === 0) return [];

  // Find change regions (non-equal ops)
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== 'equal') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group nearby changes into hunks
  const hunks: DiffHunk[] = [];
  let hunkStart = Math.max(0, changeIndices[0] - contextLines);
  let hunkEnd = Math.min(ops.length - 1, changeIndices[0] + contextLines);

  for (let ci = 1; ci < changeIndices.length; ci++) {
    const nextStart = Math.max(0, changeIndices[ci] - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndices[ci] + contextLines);

    if (nextStart <= hunkEnd + 1) {
      // Merge with current hunk
      hunkEnd = nextEnd;
    } else {
      // Emit current hunk and start new one
      hunks.push(buildHunk(ops, hunkStart, hunkEnd));
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }

  // Emit final hunk
  hunks.push(buildHunk(ops, hunkStart, hunkEnd));

  return hunks;
}

function buildHunk(ops: DiffOp[], start: number, end: number): DiffHunk {
  const removals: string[] = [];
  const additions: string[] = [];
  const context: string[] = [];

  let baseStart = Infinity;
  let proposedStart = Infinity;
  let baseCount = 0;
  let proposedCount = 0;

  for (let i = start; i <= end; i++) {
    const op = ops[i];
    switch (op.kind) {
      case 'equal':
        context.push(` ${op.content}`);
        if (op.baseLine !== undefined && op.baseLine < baseStart) baseStart = op.baseLine;
        if (op.proposedLine !== undefined && op.proposedLine < proposedStart)
          proposedStart = op.proposedLine;
        baseCount++;
        proposedCount++;
        break;
      case 'remove':
        removals.push(`-${op.content}`);
        if (op.baseLine !== undefined && op.baseLine < baseStart) baseStart = op.baseLine;
        baseCount++;
        break;
      case 'add':
        additions.push(`+${op.content}`);
        if (op.proposedLine !== undefined && op.proposedLine < proposedStart)
          proposedStart = op.proposedLine;
        proposedCount++;
        break;
    }
  }

  return {
    baseStart: baseStart === Infinity ? 0 : baseStart,
    baseLength: baseCount,
    proposedStart: proposedStart === Infinity ? 0 : proposedStart,
    proposedLength: proposedCount,
    removals: Object.freeze(removals),
    additions: Object.freeze(additions),
    context: Object.freeze(context),
  };
}

/**
 * CanonicalDiffComputer computes deterministic diffs from immutable base and
 * proposed blobs. Designed to run in a worker thread.
 */
export class CanonicalDiffComputer {
  /**
   * Computes a single file diff from base and proposed content.
   * Deterministic: same inputs always produce the same output.
   */
  computeFileDiff(input: DiffInput): FileDiff {
    const baseContent = input.baseBlob;
    const proposedContent = input.proposedBlob;
    const baseHash = baseContent !== null ? simpleHash(baseContent) : '';
    const proposedHash = proposedContent !== null ? simpleHash(proposedContent) : '';

    // Handle create (no base)
    if (input.kind === 'create' || baseContent === null) {
      const proposedLines = splitLines(proposedContent ?? '');
      const hunks: DiffHunk[] = [
        {
          baseStart: 0,
          baseLength: 0,
          proposedStart: 0,
          proposedLength: proposedLines.length,
          removals: [],
          additions: Object.freeze(proposedLines.map((l) => `+${l}`)),
          context: [],
        },
      ];

      return {
        targetUri: input.targetUri,
        kind: 'create',
        baseContent: null,
        proposedContent,
        hunks: Object.freeze(hunks),
        additions: proposedLines.length,
        removals: 0,
        baseHash: '',
        proposedHash,
      };
    }

    // Handle delete (no proposed)
    if (input.kind === 'delete' || proposedContent === null) {
      const baseLines = splitLines(baseContent);
      const hunks: DiffHunk[] = [
        {
          baseStart: 0,
          baseLength: baseLines.length,
          proposedStart: 0,
          proposedLength: 0,
          removals: Object.freeze(baseLines.map((l) => `-${l}`)),
          additions: [],
          context: [],
        },
      ];

      return {
        targetUri: input.targetUri,
        kind: 'delete',
        baseContent,
        proposedContent: null,
        hunks: Object.freeze(hunks),
        additions: 0,
        removals: baseLines.length,
        baseHash,
        proposedHash: '',
      };
    }

    // Handle modify — compute actual diff
    const baseLines = splitLines(baseContent);
    const proposedLines = splitLines(proposedContent);

    const lcsTable = computeLCSTable(baseLines, proposedLines);
    const diffOps = backtrackDiff(lcsTable, baseLines, proposedLines);
    const hunks = groupIntoHunks(diffOps);

    const totalAdditions = diffOps.filter((op) => op.kind === 'add').length;
    const totalRemovals = diffOps.filter((op) => op.kind === 'remove').length;

    return {
      targetUri: input.targetUri,
      kind: 'modify',
      baseContent,
      proposedContent,
      hunks: Object.freeze(hunks),
      additions: totalAdditions,
      removals: totalRemovals,
      baseHash,
      proposedHash,
    };
  }

  /**
   * Computes canonical diffs for multiple files.
   * Produces a deterministic result regardless of input order (sorted by URI).
   */
  compute(inputs: readonly DiffInput[]): CanonicalDiffResult {
    const startTime = performance.now();

    // Sort inputs by targetUri for determinism
    const sorted = [...inputs].sort((a, b) => a.targetUri.localeCompare(b.targetUri));

    const fileDiffs: FileDiff[] = sorted.map((input) => this.computeFileDiff(input));

    const computeTimeMs = performance.now() - startTime;

    // Compute deterministic fingerprint from all file diffs
    const fingerprintSource = fileDiffs
      .map((fd) => `${fd.targetUri}:${fd.baseHash}:${fd.proposedHash}`)
      .join('|');
    const fingerprint = simpleHash(fingerprintSource);

    return {
      fileDiffs: Object.freeze(fileDiffs),
      success: true,
      computeTimeMs,
      fingerprint,
    };
  }
}
