//
// Type definitions for the Tool_Diff_Stream renderer pipeline. These
// types are consumed by `tool-diff-stream.ts` (event-stream attachment
// and frame accumulation) and `diff-renderer.ts` (DOM rendering).
//
// Validates: Requirements 3.1, 3.3, 3.4, 3.9, 3.10, 3.11

/** Tool IDs whose `tool_input_delta` events are intercepted by the
 *  Tool_Diff_Stream pipeline. Anything not in this set falls through
 *  to the default streaming-text rendering (Req 3.1). */
export const DIFF_STREAM_TOOL_IDS: ReadonlyArray<string> = Object.freeze([
  'writeFile',
  'writeSpec',
  'editSpec',     // Phase 1 HeadingEditTool
] as const);

export interface DiffLine {
  /** 'context' lines mirror the original; 'added' / 'removed' are the
   *  deltas. */
  kind:  'context' | 'added' | 'removed';
  text:  string;
}

export interface DiffStreamFrame {
  /** Tool call ID this frame belongs to — events for the same call are
   *  merged in order; events for different calls are independent. */
  toolCallId:    string;
  /** Tool ID — drives renderer chrome (writeFile vs editSpec heading). */
  toolName:      typeof DIFF_STREAM_TOOL_IDS[number];
  /** For editSpec only — the heading path being modified, e.g.
   *  "Architecture > Components and Interfaces". Rendered as a label
   *  above the diff (Req 3.11). Absent for writeFile / writeSpec. */
  headingPath?:  string;
  /** Lines in display order. */
  lines:         ReadonlyArray<DiffLine>;
  /** Running total — number of `added` plus `removed` lines (Req 3.4). */
  linesChanged: number;
  /** Stability flag (Req 3.9). Once set true, additional incoming
   *  events for the same toolCallId do not change the displayed lines. */
  stable:        boolean;
  /** Cancellation flag (Req 3.10). When true, the renderer shows a
   *  cancellation indicator and freezes the partial diff. */
  cancelled:     boolean;
}
