/**
 * Error_Compactor — deterministic stack-trace digester for Tool_Retry_Sites.
 *
 * Reduces a raw `Error` (or structured shape) to a model-readable digest before
 * re-feeding it to the LLM at any Tool_Retry_Site (`tool-call-recovery.ts`,
 * `fallback-chain.ts`). This is task 17 of the 12-factor-agent-improvements
 * spec; it implements the algorithm described in design.md §"Error_Compactor".
 *
 * Contract:
 *   - Input: `Error` instance OR `StructuredError` shape `{ name, message,
 *     stack, code, output }`. `output` is combined stdout+stderr from a
 *     child-process tool failure; for LLM-provider errors it is omitted.
 *   - Output: a stable, deterministic string capped at `maxTokens`
 *     (`errors.compaction.maxTokens`, default 800) measured by the canonical
 *     `Token_Estimator` from `src/session/context-compressor.ts`.
 *   - Pure / no side effects: no DB, no network, no `Date.now()`,
 *     no `Math.random()`. Same input → same output.
 *
 * The default `sourceRoots` is `[process.cwd()]`. Callers that have an active
 * project path resolved via `Workspace_Manager` SHOULD pass it via
 * `opts.sourceRoots` so frames inside the workspace are retained even when the
 * process was launched from a different cwd. We keep this an explicit opts
 * argument rather than reaching into singletons to preserve the "plain
 * function, deterministic" contract.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import { estimateTokens } from '../session/context-compressor.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Structured error shape. Mirrors what the Tool_Retry_Sites observe today:
 *   - `name`     — error type/class (`TypeError`, `RateLimitError`, …).
 *   - `message`  — human-readable summary line.
 *   - `stack`    — full v8-style stack trace (multi-line).
 *   - `code`     — process exit code or provider-specific error code.
 *   - `output`   — combined stdout+stderr from a child-process tool failure;
 *                  omitted for LLM-provider errors. (Per Requirement 3.1,
 *                  `stderr` is not separate.)
 */
export interface StructuredError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string | number;
  output?: string;
}

export interface CompactErrorOptions {
  /**
   * Source roots used by Agent_Frame_Filter to decide whether a frame is
   * "ours" (kept) or "vendor / build artefact" (dropped). Frames whose path
   * starts with any of these prefixes are retained; frames matching
   * `/node_modules/`, `/dist/`, or `/build/` are always dropped regardless.
   *
   * Defaults to `[process.cwd()]` — callers with an active project path
   * resolved via `Workspace_Manager` SHOULD pass it explicitly.
   */
  sourceRoots?: string[];

  /**
   * Token cap for the compacted output. Defaults to 800
   * (`errors.compaction.maxTokens`).
   */
  maxTokens?: number;
}

interface ParsedFrame {
  /** Function / method name (best-effort; may be `<anonymous>`). */
  fn: string;
  /** Absolute or relative path. */
  path: string;
  /** Line number, or 0 if not parseable. */
  line: number;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Default token budget for compacted error output. Sourced from
 * `errors.compaction.maxTokens` in settings; a hard-coded fallback is used
 * when the settings layer is unavailable (e.g. in pure unit tests).
 *
 * Task 0 telemetry rationale: the design specifies that this default SHALL be
 * raised if Phase-0 observations show the median raw-error token count > 600.
 * No production data has been collected yet, so we default to 800 per the
 * Requirement 3.4 baseline. If the gate script (`scripts/error-size-stats.mjs`)
 * later reports median > 600, raise this constant in a follow-up PR.
 */
export const DEFAULT_MAX_TOKENS = 800;

/**
 * Hard cap on retained application frames before the token-budget loop runs
 * (Requirement 3.2). The loop may further trim frames to fit the budget.
 */
const MAX_RETAINED_FRAMES = 5;

/**
 * Last-bytes window appended from `output` (Requirement 3.2). 256 instead of
 * 200 to avoid colliding with the 200ms cold-reduce SLO.
 */
const OUTPUT_TAIL_BYTES = 256;

/**
 * Path fragments that mark a frame as vendor/build-artefact (Requirement 3.3).
 * Cross-platform: matched against forward-slash-normalised paths.
 */
const VENDOR_FRAGMENTS = ['/node_modules/', '/dist/', '/build/'];

/**
 * ANSI escape sequence regex (CSI / SGR forms). Stripped from `message`,
 * `stack`, and `output` prior to any further processing (Requirement 3.3).
 *
 * Pattern accepts optional intermediate bytes; covers the common SGR colour
 * codes (`\x1b[31m`) and bracketed control sequences emitted by chalk, ora,
 * and most child-process tooling.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * V8 stack-frame regex. Captures three shapes encountered in real Node.js
 * stacks:
 *
 *   1.  `    at fn (path:line:col)`
 *   2.  `    at path:line:col`             (no function name)
 *   3.  `    at async fn (path:line:col)`  (async marker is in the fn label)
 *
 * Column is captured for the de-dupe step but is not emitted in the digest
 * (the digest format only shows `path:line` per Requirement 3.2).
 */
const FRAME_REGEX_NAMED = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const FRAME_REGEX_BARE = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/;

// ─── Public API ────────────────────────────────────────────────

/**
 * Compact a raw error into a deterministic, budget-bounded digest suitable for
 * re-feeding to the LLM at a Tool_Retry_Site.
 *
 * The function is pure: no I/O, no mutation of `input`, no non-deterministic
 * sources. Calling `compactError(e, o)` twice with the same arguments returns
 * deep-equal strings.
 *
 * @param input  Raw `Error` or `StructuredError` shape.
 * @param opts   Optional `sourceRoots` and `maxTokens` overrides.
 * @returns      The compacted digest string.
 */
export function compactError(
  input: Error | StructuredError,
  opts?: CompactErrorOptions,
): string {
  const sourceRoots = normaliseSourceRoots(opts?.sourceRoots);
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 1. Normalise input to a stable shape.
  const norm = normalise(input);

  // 2. Strip ANSI from every text-bearing field.
  norm.message = stripAnsi(norm.message);
  norm.stack = stripAnsi(norm.stack);
  norm.output = stripAnsi(norm.output);

  // 3. Parse stack into frames.
  const allFrames = parseFrames(norm.stack);

  // 4. Apply Agent_Frame_Filter.
  const filtered = filterFrames(allFrames, sourceRoots);

  // 5. Deduplicate adjacent identical frames.
  const deduped = dedupeAdjacent(filtered);

  // 6. Truncate to top MAX_RETAINED_FRAMES.
  const dropped = Math.max(0, deduped.length - MAX_RETAINED_FRAMES);
  let retained = deduped.slice(0, MAX_RETAINED_FRAMES);

  // 7. Append last OUTPUT_TAIL_BYTES of `output` if present.
  const outputTail = takeLastBytes(norm.output, OUTPUT_TAIL_BYTES);

  // 8. Token-budget loop: if over budget, drop one frame from the bottom.
  let result = format(norm, retained, dropped, outputTail);
  let droppedExtra = 0;
  while (estimateTokens(result) > maxTokens && retained.length > 0) {
    retained = retained.slice(0, -1);
    droppedExtra++;
    result = format(norm, retained, dropped + droppedExtra, outputTail);
  }

  // If even with zero frames we are over budget, truncate the message.
  if (estimateTokens(result) > maxTokens) {
    result = truncateToBudget(result, maxTokens);
  }

  return result;
}

// ─── Normalisation ─────────────────────────────────────────────

interface NormalisedError {
  name: string;
  message: string;
  stack: string;
  code: string | number | undefined;
  output: string;
}

/**
 * Convert any accepted input shape into a stable `NormalisedError`. Missing
 * fields become empty strings (or `undefined` for `code`) so downstream steps
 * can be branch-free.
 */
function normalise(input: Error | StructuredError): NormalisedError {
  if (input instanceof Error) {
    const anyErr = input as Error & { code?: string | number; output?: string };
    return {
      name: input.name || 'Error',
      message: input.message || '',
      stack: input.stack || '',
      code: anyErr.code,
      output: typeof anyErr.output === 'string' ? anyErr.output : '',
    };
  }
  return {
    name: input.name || 'Error',
    message: input.message || '',
    stack: input.stack || '',
    code: input.code,
    output: typeof input.output === 'string' ? input.output : '',
  };
}

/**
 * Resolve the effective source-root list. Defaults to `[process.cwd()]` when
 * no roots are provided (Requirement 3.3 design note: "process.cwd() plus
 * active project path resolved via Workspace_Manager"). Callers that have a
 * resolved workspace path pass it explicitly to keep the function pure.
 *
 * Paths are normalised to forward-slash form for cross-platform matching.
 */
function normaliseSourceRoots(roots: string[] | undefined): string[] {
  const list = roots && roots.length > 0 ? roots : [process.cwd()];
  return list.map(toForwardSlash).filter((p) => p.length > 0);
}

// ─── ANSI / Bytes helpers ──────────────────────────────────────

function stripAnsi(s: string): string {
  if (!s) return '';
  return s.replace(ANSI_REGEX, '');
}

/**
 * Return the last `n` bytes of `s` as a UTF-8 string. If the cut falls inside
 * a multi-byte sequence we trim from the front of the slice until the buffer
 * decodes cleanly — keeps the result printable.
 */
function takeLastBytes(s: string, n: number): string {
  if (!s) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= n) return s;
  // Trim leading partial UTF-8 continuation bytes (10xxxxxx).
  let start = buf.length - n;
  while (start < buf.length) {
    const b = buf[start] ?? 0;
    if ((b & 0b1100_0000) !== 0b1000_0000) break;
    start++;
  }
  return buf.slice(start).toString('utf8');
}

// ─── Stack frame parsing ───────────────────────────────────────

function parseFrames(stack: string): ParsedFrame[] {
  if (!stack) return [];
  const out: ParsedFrame[] = [];
  for (const line of stack.split('\n')) {
    const named = FRAME_REGEX_NAMED.exec(line);
    if (named && named[1] && named[2] && named[3]) {
      out.push({
        fn: named[1].trim(),
        path: toForwardSlash(named[2]),
        line: parseInt(named[3], 10) || 0,
      });
      continue;
    }
    const bare = FRAME_REGEX_BARE.exec(line);
    if (bare && bare[1] && bare[2]) {
      out.push({
        fn: '<anonymous>',
        path: toForwardSlash(bare[1]),
        line: parseInt(bare[2], 10) || 0,
      });
    }
    // Lines that match neither (e.g. the `Error: ...` header) are skipped.
  }
  return out;
}

/**
 * Apply the Agent_Frame_Filter:
 *   - Drop frames whose path contains any vendor/build fragment.
 *   - Keep frames whose path starts with any source root.
 *   - Frames that match neither are dropped (better to hide ambiguous frames
 *     than waste budget on them).
 */
function filterFrames(frames: ParsedFrame[], sourceRoots: string[]): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  for (const f of frames) {
    if (isVendor(f.path)) continue;
    if (isInSourceRoot(f.path, sourceRoots)) {
      out.push(f);
    }
  }
  return out;
}

function isVendor(path: string): boolean {
  for (const fragment of VENDOR_FRAGMENTS) {
    if (path.indexOf(fragment) !== -1) return true;
  }
  return false;
}

function isInSourceRoot(path: string, sourceRoots: string[]): boolean {
  for (const root of sourceRoots) {
    if (path.indexOf(root) === 0) return true;
  }
  return false;
}

/**
 * Collapse runs of identical adjacent frames into `at fn (path:line) (×N)`.
 * Preserves order; only adjacent matches are collapsed (matches the v8
 * "recursive call" pattern users typically want to see).
 */
function dedupeAdjacent(frames: ParsedFrame[]): ParsedFrame[] {
  if (frames.length === 0) return [];
  const out: Array<ParsedFrame & { repeat: number }> = [];
  for (const f of frames) {
    const prev = out[out.length - 1];
    if (prev && prev.fn === f.fn && prev.path === f.path && prev.line === f.line) {
      prev.repeat += 1;
      continue;
    }
    out.push({ ...f, repeat: 1 });
  }
  return out as ParsedFrame[];
}

// ─── Output formatting ─────────────────────────────────────────

/**
 * Render the final digest. Format is fixed and deterministic — see
 * design.md §"Error_Compactor" for the canonical example.
 */
function format(
  norm: NormalisedError,
  frames: ParsedFrame[],
  dropped: number,
  outputTail: string,
): string {
  const lines: string[] = [];
  lines.push(`[ERROR ${norm.name}] ${norm.message}`);
  if (norm.code !== undefined) {
    lines.push(`Exit code: ${norm.code}`);
  }
  for (const f of frames) {
    const repeat = (f as ParsedFrame & { repeat?: number }).repeat;
    const suffix = repeat && repeat > 1 ? ` (×${repeat})` : '';
    lines.push(`  at ${f.fn} (${f.path}:${f.line})${suffix}`);
  }
  if (dropped > 0) {
    lines.push(`  (... ${dropped} more frames omitted)`);
  }
  if (outputTail) {
    lines.push('');
    lines.push(`Last output (${OUTPUT_TAIL_BYTES} bytes):`);
    lines.push(outputTail);
  }
  return lines.join('\n');
}

/**
 * Last-resort budget enforcer: when even a frameless digest would overflow
 * the cap (e.g. a multi-KB error message), trim from the tail until the
 * estimate fits. We append `…` so it is obvious the output was truncated.
 */
function truncateToBudget(s: string, maxTokens: number): string {
  // estimateTokens uses ~4 chars per token. Aim for `maxTokens * 4` chars and
  // shrink by 8-char steps until the actual estimate is under the cap. This
  // converges in O(log n) for any realistic input.
  let target = maxTokens * 4;
  let cut = s.slice(0, target) + '…';
  while (estimateTokens(cut) > maxTokens && target > 8) {
    target -= 8;
    cut = s.slice(0, target) + '…';
  }
  return cut;
}

// ─── Path helpers ──────────────────────────────────────────────

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}
