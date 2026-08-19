/**
 * Deterministic, allowlist-only syntax highlighter for fenced code blocks.
 *
 * Task 10.4 (enhanced-chat-ui) — this module wraps `highlight.js` with
 * three invariants:
 *
 *   1. **Explicit allowlist.** Only the fixed set of languages listed in
 *      {@link CODE_HIGHLIGHT_ALLOWLIST} may be highlighted. Anything else
 *      is rendered as escaped plain text.
 *   2. **No auto-detection.** The API never calls `highlight.js`'s
 *      `highlightAuto` — an unknown or missing language never triggers a
 *      guess. This eliminates the "language: X was actually Y" class of
 *      misleading badges and makes the output deterministic.
 *   3. **No bulk import.** The bundle only pulls the grammars we
 *      explicitly register (16 modules). We never import
 *      `highlight.js/lib/common`, which would pull ~35 grammars and
 *      inflate the renderer bundle without any policy control.
 *
 * The public factory is {@link createCodeHighlighter}. It returns a
 * scoped highlighter (its own hljs instance) with three methods:
 *
 *   - `registerLanguages(ids)` — register the specified subset of
 *     allowlisted grammars. Non-allowlisted ids are silently skipped.
 *   - `isKnownLanguage(id)` — returns `true` iff `id` is on the
 *     allowlist **and** its grammar has been registered.
 *   - `highlight({ code, language })` — highlight only when
 *     `isKnownLanguage(language)` is `true`. Otherwise returns the
 *     escaped source and a `null` language marker.
 *
 * Requirements: 10.7, 10.9, 15.6, 15.7
 *
 * @module src/renderer/structured-response/code-highlighter
 */

import hljs from 'highlight.js/lib/core';
import type { HLJSApi, LanguageFn } from 'highlight.js';

// ─── Grammar imports (explicit, allowlist-only) ─────────────────────────────
//
// One import per allowlisted grammar. No `highlight.js/lib/common` import;
// that would pull ~35 grammars and defeat the allowlist. `xml` doubles as
// the grammar for HTML (highlight.js registers `html` as an alias when
// the `xml` grammar is installed).

import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';

// ─── Fixed allowlist ────────────────────────────────────────────────────────

/**
 * Immutable list of language identifiers the highlighter will accept.
 * The set is intentionally small and covers the languages a NeuroNest
 * agent is likely to emit. Adding a language requires (a) an entry here
 * and (b) an explicit `hljs.registerLanguage` module import above.
 */
export const CODE_HIGHLIGHT_ALLOWLIST: readonly string[] = Object.freeze([
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'csharp',
  'cpp',
  'html',
  'css',
  'json',
  'yaml',
  'bash',
  'sql',
  'markdown',
  'xml',
]);

/**
 * Union of allowlisted language identifiers.
 */
export type CodeHighlightLanguage = (typeof CODE_HIGHLIGHT_ALLOWLIST)[number];

// Allowlist lookup — a `Set` beats `Array.includes` on repeated calls.
const ALLOWLIST_SET: ReadonlySet<string> = new Set(CODE_HIGHLIGHT_ALLOWLIST);

/**
 * Map from an allowlisted language identifier to the grammar module used
 * to register it. `html` maps to the xml module because
 * `highlight.js/lib/languages/xml` is the grammar that also handles HTML
 * (registering it makes `hljs.getLanguage('html')` resolve via its
 * built-in aliases).
 */
const GRAMMARS: Readonly<Record<string, LanguageFn>> = Object.freeze({
  typescript,
  javascript,
  python,
  rust,
  go,
  java,
  csharp,
  cpp,
  html: xml,
  css,
  json,
  yaml,
  bash,
  sql,
  markdown,
  xml,
});

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Result of a single highlight call.
 *
 * - `html` — HTML string suitable for insertion into a `<code>` element.
 *   When `language` is not `null`, this contains `<span class="hljs-…">`
 *   tokens produced by `highlight.js`. When `language` is `null`, this is
 *   the escaped source with no tokens.
 * - `language` — the canonical allowlist identifier the source was
 *   highlighted with, or `null` when the source was rendered as escaped
 *   plain text (unknown, missing, or empty language).
 */
export interface CodeHighlightResult {
  readonly html: string;
  readonly language: string | null;
}

/**
 * Input shape for {@link CodeHighlighter.highlight}.
 */
export interface CodeHighlightInput {
  /** Raw source code to highlight. */
  readonly code: string;
  /** Language identifier from the fence info string. May be missing. */
  readonly language: string | undefined | null;
}

/**
 * The three-method interface returned by {@link createCodeHighlighter}.
 */
export interface CodeHighlighter {
  /**
   * Register the subset of allowlisted grammars specified by `ids`.
   *
   * - Identifiers not on {@link CODE_HIGHLIGHT_ALLOWLIST} are silently
   *   skipped. This is deliberate: the highlighter is the single source
   *   of truth for what may be highlighted, and non-allowlisted ids
   *   should never leak grammar into the runtime.
   * - Re-registering an already-registered grammar is a no-op.
   * - Non-string entries are ignored.
   */
  registerLanguages(ids: readonly string[]): void;

  /**
   * Return `true` only when `id` is on the allowlist **and** its grammar
   * has been registered via {@link registerLanguages}. Case-insensitive.
   * Missing or non-string `id` returns `false`.
   */
  isKnownLanguage(id: string | undefined | null): boolean;

  /**
   * Highlight `code` with the grammar for `language`, or return escaped
   * plain text when the language is unknown, missing, or not registered.
   *
   * Never calls `highlight.js`'s `highlightAuto` — auto-detection is
   * disallowed by the design (10.4). Never throws — internal
   * `highlight.js` errors are caught and coerced to the plain-text
   * fallback shape.
   */
  highlight(input: CodeHighlightInput): CodeHighlightResult;
}

/**
 * Optional factory configuration.
 *
 * `hljsInstance` lets tests inject a mock hljs implementation without
 * mutating the global instance. When absent, the factory creates a fresh
 * isolated instance via `hljs.newInstance()`.
 */
export interface CreateCodeHighlighterOptions {
  readonly hljsInstance?: HLJSApi;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a scoped {@link CodeHighlighter}. Each call returns a highlighter
 * backed by its own hljs instance (unless `hljsInstance` overrides), so
 * language registrations do not leak between callers.
 */
export function createCodeHighlighter(
  options: CreateCodeHighlighterOptions = {},
): CodeHighlighter {
  const instance: HLJSApi = options.hljsInstance ?? hljs.newInstance();

  function normalize(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const trimmed = id.trim().toLowerCase();
    if (trimmed.length === 0) return null;
    return trimmed;
  }

  function registerLanguages(ids: readonly string[]): void {
    if (!Array.isArray(ids)) return;
    for (const raw of ids) {
      const id = normalize(raw);
      if (id === null) continue;
      if (!ALLOWLIST_SET.has(id)) continue;
      // Skip when already registered under this canonical name.
      if (instance.getLanguage(id)) continue;
      const grammar = GRAMMARS[id];
      if (!grammar) continue;
      instance.registerLanguage(id, grammar);
    }
  }

  function isKnownLanguage(id: string | undefined | null): boolean {
    const normalized = normalize(id);
    if (normalized === null) return false;
    if (!ALLOWLIST_SET.has(normalized)) return false;
    return instance.getLanguage(normalized) !== undefined;
  }

  function highlight(input: CodeHighlightInput): CodeHighlightResult {
    const rawCode = typeof input?.code === 'string' ? input.code : '';
    const escaped = escapeHtml(rawCode);

    const normalized = normalize(input?.language);
    if (normalized === null) {
      return { html: escaped, language: null };
    }
    if (!ALLOWLIST_SET.has(normalized)) {
      return { html: escaped, language: null };
    }
    if (!instance.getLanguage(normalized)) {
      // Allowlisted but not registered — behave as unknown so the
      // caller sees the deterministic plain-text fallback.
      return { html: escaped, language: null };
    }

    try {
      // `ignoreIllegals: true` matches the design intent: an illegal
      // sequence for one grammar (a stray `{` in a python block, for
      // instance) should not throw. The output falls back to unclassified
      // spans inside the same block.
      const result = instance.highlight(rawCode, {
        language: normalized,
        ignoreIllegals: true,
      });
      return { html: result.value, language: normalized };
    } catch {
      // Defensive fallback. `highlight.js` should not throw when
      // `ignoreIllegals: true` is set, but we never let an internal
      // exception bubble into the render path.
      return { html: escaped, language: null };
    }
  }

  return { registerLanguages, isKnownLanguage, highlight };
}

// ─── HTML escaping ──────────────────────────────────────────────────────────

/**
 * Minimal HTML escaper used for the plain-text fallback path. Matches the
 * character set handled by `markdown-it`'s own escapeHtml and the code
 * surface's escape helper so the pipeline and the highlighter agree on
 * what the string form of untrusted code looks like.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
