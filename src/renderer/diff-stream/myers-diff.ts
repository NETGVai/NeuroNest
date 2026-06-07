//
// Pure, dependency-free implementation of the Myers O(ND) line-diff
// algorithm. Consumed by the Tool_Diff_Stream pipeline (`tool-diff-
// stream.ts`) to compute the progressive diff displayed in the chat UI
// for write-tool calls.
//
// Validates: Requirements 3.7

import type { DiffLine } from './types';

/**
 * Pure line-oriented Myers diff. Splits both inputs on `'\n'` and emits
 * `DiffLine[]` in display order: at every diff boundary, `removed`
 * lines are emitted before the corresponding `added` lines, with
 * `context` lines surrounding unchanged regions.
 *
 * Pure function of `(preImage, postImage)`:
 *   - No IPC, no `fetch`, no file I/O, no network access.
 *   - No reads from `process`, `globalThis`, `document`, or any
 *     module-scope mutable state.
 *   - Same inputs → byte-identical outputs (deterministic).
 *
 * Time complexity: `O((N + M) · D)` where `D` is the size of the
 * shortest edit script. For typical write-tool payloads (≤ 5000 lines,
 * mostly unchanged context) `D` is small and the runtime is dominated
 * by the snake walk through equal lines.
 *
 * @param preImage  The pre-edit text (e.g. existing file contents).
 * @param postImage The post-edit text (e.g. accumulated tool args).
 * @returns         An array of `DiffLine` records in display order.
 */
export function diffLines(preImage: string, postImage: string): DiffLine[] {
  const a = preImage.split('\n');
  const b = postImage.split('\n');

  // Fast path for identical inputs — every line is context. The general
  // algorithm produces the same output, but skipping it saves the
  // O(N + M) trace allocation in the common "no edits this delta" case.
  if (preImage === postImage) {
    const out: DiffLine[] = [];
    for (let i = 0; i < a.length; i++) {
      out.push({ kind: 'context', text: a[i] as string });
    }
    return out;
  }

  const ops = shortestEditScript(a, b);
  return materialize(a, b, ops);
}

/** Internal edit-graph operation. `eq` means a snake/diagonal step,
 *  `add` means an insertion from `b`, `del` means a deletion from `a`. */
type EditOp =
  | { readonly kind: 'eq';  readonly aIdx: number; readonly bIdx: number }
  | { readonly kind: 'add'; readonly bIdx: number }
  | { readonly kind: 'del'; readonly aIdx: number };

/**
 * Computes the shortest edit script using Myers' O(ND) algorithm and
 * back-traces through per-iteration `V` snapshots to recover the edit
 * sequence from `(0, 0)` to `(N, M)`.
 */
function shortestEditScript(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;

  // `V[offset + k]` holds the greatest `x` value reached on diagonal
  // `k` after the current iteration. The mathematical `V` is indexed
  // by `k ∈ [-max, max]`; we shift by `offset` for array access.
  const V = new Int32Array(size);

  // Snapshot of `V` taken at the start of each `d` iteration. Used by
  // the back-trace to recover the predecessor `(x, y)` coordinate at
  // each edit-distance level.
  const trace: Int32Array[] = [];

  let dEnd = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(V));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const down = V[offset + k + 1] as number;
      const right = V[offset + k - 1] as number;
      if (k === -d || (k !== d && down > right)) {
        // "Down" move — insertion from `b`.
        x = down;
      } else {
        // "Right" move — deletion from `a`.
        x = right + 1;
      }
      let y = x - k;
      // Follow the snake of equal lines.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      V[offset + k] = x;
      if (x >= n && y >= m) {
        dEnd = d;
        break outer;
      }
    }
  }

  // Should always terminate within `max` iterations for finite inputs.
  if (dEnd < 0) return [];

  // Back-trace from (n, m) to (0, 0). At each `d`, the snapshot
  // `trace[d]` is the state of `V` *before* iteration `d` ran, i.e.
  // exactly the values iteration `d` consulted when computing the
  // current frontier.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const Vd = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    const downPrev = Vd[offset + k + 1] as number;
    const rightPrev = Vd[offset + k - 1] as number;
    if (k === -d || (k !== d && downPrev > rightPrev)) {
      prevK = k + 1; // predecessor reached via a "down" move
    } else {
      prevK = k - 1; // predecessor reached via a "right" move
    }
    const prevX = Vd[offset + prevK] as number;
    const prevY = prevX - prevK;

    // Walk the snake of equal lines back to the predecessor coordinate.
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq', aIdx: x - 1, bIdx: y - 1 });
      x--;
      y--;
    }
    // Then emit the single non-snake edge that joined `prev` to `cur`.
    if (x === prevX) {
      ops.push({ kind: 'add', bIdx: prevY });
    } else {
      ops.push({ kind: 'del', aIdx: prevX });
    }
    x = prevX;
    y = prevY;
  }
  // Drain the leading snake at edit-distance 0.
  while (x > 0 && y > 0) {
    ops.push({ kind: 'eq', aIdx: x - 1, bIdx: y - 1 });
    x--;
    y--;
  }
  // If one input is a strict prefix of the other, drain the residual
  // leading deletions or insertions. (Defensive — under a correct
  // edit-graph traversal this is reached only when the empty-prefix
  // axis is non-zero.)
  while (x > 0) {
    ops.push({ kind: 'del', aIdx: x - 1 });
    x--;
  }
  while (y > 0) {
    ops.push({ kind: 'add', bIdx: y - 1 });
    y--;
  }
  ops.reverse();
  return ops;
}

/**
 * Walks the edit script and emits `DiffLine` records. Contiguous
 * `del`/`add` runs at a single diff boundary are emitted as
 * `removed` lines first, then `added` lines, so the renderer can
 * display the original-line block above the new-line block (the
 * standard unified-diff display order).
 */
function materialize(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  ops: ReadonlyArray<EditOp>,
): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i] as EditOp;
    if (op.kind === 'eq') {
      out.push({ kind: 'context', text: a[op.aIdx] as string });
      i++;
      continue;
    }
    // Group the contiguous run of del/add ops at this diff boundary.
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ops.length) {
      const cur = ops[i] as EditOp;
      if (cur.kind === 'del') {
        removed.push(a[cur.aIdx] as string);
        i++;
      } else if (cur.kind === 'add') {
        added.push(b[cur.bIdx] as string);
        i++;
      } else {
        break;
      }
    }
    for (const text of removed) out.push({ kind: 'removed', text });
    for (const text of added) out.push({ kind: 'added', text });
  }
  return out;
}
