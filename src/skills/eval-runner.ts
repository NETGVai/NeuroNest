//
// Skill_Eval_Runner — executes a Skill_Pack's `eval/questions.jsonl` against the
// currently-active LLM provider and reports a per-question pass/fail plus an
// aggregate accuracy score. Packs that declare no `eval` field are skipped.
//
// Requirements: 61

import path from 'node:path';
import fs from 'node:fs';

import {
  SKILL_PACK_CACHE_ROOT,
  PACK_MANIFEST_FILENAME,
  type PackManifest,
} from './pack-loader.js';

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * A single eval question parsed from a pack's `eval/questions.jsonl`.
 *
 * Scoring precedence: `keywords` (all must appear in the response) is checked
 * first; otherwise `expectedAnswer` is fuzzily compared. A question with neither
 * criterion cannot be verified and is recorded as a failure.
 */
export interface EvalQuestion {
  /** Optional identifier (or originating skill id) for the question. */
  id?: string;
  /** The prompt sent to the active LLM provider. */
  question: string;
  /** Optional reference answer for fuzzy comparison. */
  expectedAnswer?: string;
  /** Optional keywords; all must appear (case-insensitive) in the response. */
  keywords?: string[];
}

/**
 * Result of running a pack's eval suite.
 *
 * When the pack declares no eval (or cannot be evaluated), `skipped` is `true`
 * and `reason` explains why; the scoring fields are then omitted. Otherwise the
 * scoring fields (`total`, `passed`, `accuracy`, `results`) are populated.
 */
export interface EvalReport {
  packId: string;
  skipped?: boolean;
  reason?: string;
  /** Number of eval questions executed. */
  total?: number;
  /** Number of questions whose response passed scoring. */
  passed?: number;
  /** Aggregate accuracy as a percentage in [0, 100]. */
  accuracy?: number;
  /** Per-question pass/fail outcomes. */
  results?: Array<{ question: string; passed: boolean }>;
}

// ─── runEval (Requirement 61) ──────────────────────────────────────────────────

/**
 * runEval — execute a Skill_Pack's eval suite against the active LLM provider.
 *
 * Behavior (Requirement 61):
 *   - Resolves the pack's on-disk cache dir from `packId`.
 *   - Reads `pack.json`; when no `eval` field is declared, returns
 *     `{ packId, skipped: true, reason: 'no eval declared' }` (Requirement 61.4).
 *   - Parses `eval/questions.jsonl` (one JSON object per line; blank and
 *     malformed lines are skipped).
 *   - Runs each question through `llmCall` (the active provider, injected by the
 *     caller — never a hardcoded model, Requirement 61.3) and scores the
 *     response by keyword match or fuzzy answer compare.
 *   - Computes `passed`/`total`/`accuracy` (0–100%) plus per-question results
 *     (Requirement 61.2).
 *
 * Never throws: any failure (pack not found, unreadable manifest, eval file
 * missing, individual LLM call error) is wrapped and surfaced as a skip or a
 * failed question rather than propagating.
 *
 * @param packId  Pack identity (`<owner>/<repo>`, `<host>/<owner>/<repo>`, the
 *                pack's manifest `name`, or its cache directory basename).
 * @param llmCall Adapter to the currently-active LLM provider.
 */
export async function runEval(
  packId: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<EvalReport> {
  try {
    if (typeof packId !== 'string' || packId.trim() === '') {
      return { packId: String(packId), skipped: true, reason: 'invalid packId' };
    }

    const packDir = resolvePackDir(packId);
    if (!packDir) {
      return { packId, skipped: true, reason: `pack not found: ${packId}` };
    }

    let manifest: PackManifest;
    try {
      manifest = readManifest(packDir);
    } catch (err) {
      return { packId, skipped: true, reason: `unreadable manifest: ${(err as Error).message}` };
    }

    // No eval declared → skip (Requirement 61.4).
    if (typeof manifest.eval !== 'string' || manifest.eval.trim() === '') {
      return { packId, skipped: true, reason: 'no eval declared' };
    }

    const evalPath = path.join(packDir, manifest.eval);
    if (!fileExists(evalPath)) {
      return { packId, skipped: true, reason: `eval file not found: ${manifest.eval}` };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(evalPath, 'utf-8');
    } catch (err) {
      return { packId, skipped: true, reason: `failed to read eval file: ${(err as Error).message}` };
    }

    const questions = parseQuestions(raw);
    if (questions.length === 0) {
      return { packId, skipped: true, reason: 'no eval questions' };
    }

    const results: Array<{ question: string; passed: boolean }> = [];
    let passed = 0;

    for (const q of questions) {
      let response = '';
      try {
        response = await llmCall(q.question);
      } catch {
        // A failed LLM call counts as a failed question rather than aborting
        // the whole eval run.
        response = '';
      }

      const ok = scoreQuestion(response, q);
      if (ok) passed += 1;
      results.push({ question: q.question, passed: ok });
    }

    const total = questions.length;
    const accuracy = total > 0 ? round2((passed / total) * 100) : 0;

    return { packId, total, passed, accuracy, results };
  } catch (err) {
    // Defensive catch-all: never throw on the eval path.
    return {
      packId: typeof packId === 'string' ? packId : String(packId),
      skipped: true,
      reason: `eval failed: ${(err as Error).message}`,
    };
  }
}

// ─── Pack directory resolution ──────────────────────────────────────────────

/**
 * Resolve a `packId` to an installed pack's cache directory, or `null` when no
 * matching pack is found. Matches, in order:
 *   1. A direct path join under the cache root (`<owner>/<repo>` or
 *      `<host>/<owner>/<repo>`).
 *   2. A pack whose cache-relative path equals or ends with `packId`.
 *   3. A pack whose directory basename equals `packId`.
 *   4. A pack whose manifest `name` equals `packId`.
 */
function resolvePackDir(packId: string): string | null {
  const normalizedId = packId.trim().replace(/^\/+|\/+$/g, '');

  // 1. Direct path join (handles "<owner>/<repo>" and "<host>/<owner>/<repo>").
  const direct = path.join(SKILL_PACK_CACHE_ROOT, normalizedId);
  if (isPackDir(direct)) return direct;

  if (!fs.existsSync(SKILL_PACK_CACHE_ROOT)) return null;

  const candidates: string[] = [];
  collectPackDirs(SKILL_PACK_CACHE_ROOT, 5, candidates);

  // 2 & 3: match by cache-relative path / basename.
  for (const dir of candidates) {
    const rel = path.relative(SKILL_PACK_CACHE_ROOT, dir).split(path.sep).join('/');
    if (rel === normalizedId || rel.endsWith(`/${normalizedId}`)) return dir;
    if (path.basename(dir) === normalizedId) return dir;
  }

  // 4: match by manifest name.
  for (const dir of candidates) {
    const m = tryReadManifest(dir);
    if (m && m.name === normalizedId) return dir;
  }

  return null;
}

/** True when `dir` contains a `pack.json` manifest file. */
function isPackDir(dir: string): boolean {
  try {
    const manifestPath = path.join(dir, PACK_MANIFEST_FILENAME);
    return fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively collect pack directories (those containing a `pack.json`) under
 * `root`, bounded by `depth`. Symlinked pack directories (local installs) are
 * detected via `fs.statSync`, which follows symlinks.
 */
function collectPackDirs(root: string, depth: number, acc: string[]): void {
  if (depth < 0) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (isPackDir(full)) {
      acc.push(full);
      continue;
    }

    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) collectPackDirs(full, depth - 1, acc);
  }
}

/** Read + parse a pack's `pack.json`. Throws on missing/malformed manifest. */
function readManifest(packDir: string): PackManifest {
  const manifestPath = path.join(packDir, PACK_MANIFEST_FILENAME);
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`expected a JSON object in ${PACK_MANIFEST_FILENAME}`);
  }
  return parsed as PackManifest;
}

/** Best-effort manifest read; returns `null` instead of throwing. */
function tryReadManifest(packDir: string): PackManifest | null {
  try {
    return readManifest(packDir);
  } catch {
    return null;
  }
}

/** True when `p` exists and is a regular file. */
function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ─── Question parsing (JSONL) ──────────────────────────────────────────────────

/**
 * Parse `eval/questions.jsonl`: one JSON object per line. Blank lines and lines
 * that fail to parse (or lack a `question` string) are skipped so a single
 * malformed entry never aborts the whole eval run.
 *
 * Accepts both this module's field names (`keywords`, `id`) and the design's
 * aliases (`expectedKeywords`, `skillId`) for forward/backward compatibility.
 */
function parseQuestions(raw: string): EvalQuestion[] {
  const out: EvalQuestion[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (typeof obj !== 'object' || obj === null) continue;

    const rec = obj as Record<string, unknown>;
    const question = typeof rec.question === 'string' ? rec.question : undefined;
    if (!question) continue;

    const keywordsRaw = Array.isArray(rec.keywords)
      ? rec.keywords
      : Array.isArray(rec.expectedKeywords)
        ? rec.expectedKeywords
        : undefined;
    const keywords = keywordsRaw
      ? keywordsRaw.filter((k): k is string => typeof k === 'string')
      : undefined;

    const expectedAnswer = typeof rec.expectedAnswer === 'string' ? rec.expectedAnswer : undefined;
    const id =
      typeof rec.id === 'string'
        ? rec.id
        : typeof rec.skillId === 'string'
          ? rec.skillId
          : undefined;

    out.push({
      ...(id ? { id } : {}),
      question,
      ...(expectedAnswer ? { expectedAnswer } : {}),
      ...(keywords && keywords.length > 0 ? { keywords } : {}),
    });
  }

  return out;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Score a response against a question. Keyword match takes precedence: all
 * keywords must appear (case-insensitive) in the response. Otherwise the
 * response is fuzzily compared to `expectedAnswer`. A question with neither
 * criterion cannot be verified and fails.
 */
function scoreQuestion(response: string, q: EvalQuestion): boolean {
  const resp = typeof response === 'string' ? response : String(response ?? '');

  if (q.keywords && q.keywords.length > 0) {
    const hay = resp.toLowerCase();
    return q.keywords.every((k) => hay.includes(k.toLowerCase()));
  }

  if (typeof q.expectedAnswer === 'string' && q.expectedAnswer.trim() !== '') {
    return fuzzyMatch(resp, q.expectedAnswer);
  }

  return false;
}

/** Lowercase, collapse internal whitespace, and trim. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fuzzy string comparison: an exact normalized match or substring containment
 * passes immediately; otherwise a normalized Levenshtein similarity ratio is
 * compared against `threshold`. Levenshtein is skipped for very long strings to
 * keep scoring cheap, falling back to the containment check alone.
 */
function fuzzyMatch(response: string, expected: string, threshold = 0.7): boolean {
  const r = normalize(response);
  const e = normalize(expected);

  if (e === '') return false;
  if (r === e) return true;
  if (r.includes(e)) return true;

  // Guard against pathological O(n*m) Levenshtein on large LLM responses.
  if (r.length > 2000 || e.length > 2000) return false;

  return similarity(r, e) >= threshold;
}

/** Normalized similarity in [0, 1] derived from Levenshtein edit distance. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Standard iterative Levenshtein edit distance with a single rolling row. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
