/**
 * Canonical Markdown rendering pipeline.
 *
 * Task 10.3 (enhanced-chat-ui) — this module owns the single, canonical
 * Markdown-to-DOM path for structured chat surfaces. The pipeline:
 *
 *   1. Parses source Markdown with `markdown-it` configured with raw HTML
 *      *disabled* (`html: false`). No `<script>`, `<iframe>`, or arbitrary
 *      HTML tag in the source ever reaches the renderer as markup — the
 *      parser escapes it to text at tokenization time.
 *   2. Applies typed token/renderer transformations so links carry only
 *      `href`, `title`, and `rel="noopener noreferrer"`; fenced code blocks
 *      render as `<pre><code class="language-...">…escaped code…</code></pre>`
 *      with the raw language identifier preserved for task 10.4's highlighter;
 *      images are stripped to their `alt` text so no remote fetch happens.
 *   3. Renders the token stream to an HTML string.
 *   4. Passes that HTML through {@link sanitizeHtmlToInertFragment} — the
 *      independent structural allowlist sanitizer from task 10.2 — which
 *      parses inside an inert template, walks the DOM, and enforces
 *      tag/attribute/URL allowlists. Sanitizer rejections (a fully
 *      rejected parse or a redacted fallback) are captured as warnings
 *      so callers can decide whether to surface a diagnostic.
 *
 * The pipeline is intentionally minimal. It does not highlight code (task
 * 10.4), does not resolve external navigation (task 10.6), and does not
 * decorate anchors beyond the sanitizer's forced `rel` attribute. Callers
 * receive an inert `DocumentFragment` that they insert with
 * `element.replaceChildren(fragment)` — never `innerHTML`.
 *
 * Requirements: 10.2, 10.7, 10.8, 15.1, 15.2
 *
 * @module src/renderer/structured-response/markdown-pipeline
 */

import MarkdownIt from 'markdown-it';

import {
  sanitizeHtmlToInertFragment,
  type SanitizeOptions,
} from './html-sanitizer';

// Local type aliases derived from the runtime shape of `MarkdownIt`. Deriving
// from `InstanceType<typeof MarkdownIt>` keeps this module portable across
// both `moduleResolution: "node"` (main tsconfig — uses the CJS .d.ts where
// the namespace form applies) and `moduleResolution: "bundler"` (renderer
// tsconfig — uses the ESM .d.mts where types are named module exports).
// Neither the namespace access `MarkdownIt.Options` nor the ESM-only
// `markdown-it/lib/…` subpath imports resolve in both modes; the runtime
// property lookups below do.
type MarkdownItInstance = InstanceType<typeof MarkdownIt>;
type MarkdownItOptions = MarkdownItInstance['options'];
type Renderer = MarkdownItInstance['renderer'];
type RenderRuleRecord = Renderer['rules'];
type RenderRule = NonNullable<RenderRuleRecord[string]>;
type Token = Parameters<RenderRule>[0][number];

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Warning surfaced by {@link MarkdownPipeline.renderToInertFragment}.
 *
 * - `sanitizer_fallback` — the sanitizer could not clean the rendered HTML
 *   and returned the redacted plain-text fallback. Callers should treat
 *   this as a rendering failure: the fragment contains only escaped text,
 *   not structured markup. `redactedPlaintext` mirrors the sanitizer's
 *   own field so callers can log or display it without re-parsing.
 * - `aborted` — the caller supplied an {@link AbortSignal} that was
 *   already aborted or became aborted before the sanitized DOM could
 *   be committed. The returned fragment is empty; the caller must
 *   discard it and rely on the newer revision's render to replace it.
 */
export type MarkdownPipelineWarning =
  | {
      readonly kind: 'sanitizer_fallback';
      readonly redactedPlaintext: string;
    }
  | {
      readonly kind: 'aborted';
      readonly reason?: string;
    };

/**
 * Result of one Markdown → inert-DOM render.
 *
 * `fragment` is always a `DocumentFragment` — never `null`, never a live
 * element. On success the fragment contains sanitized structured DOM. On
 * sanitizer failure the fragment contains a single text node with the
 * redacted plain-text fallback and `warnings` includes a
 * `sanitizer_fallback` entry.
 */
export interface RenderToInertFragmentResult {
  readonly fragment: DocumentFragment;
  readonly warnings: readonly MarkdownPipelineWarning[];
}

/**
 * Per-call overrides for {@link MarkdownPipeline.renderToInertFragment}.
 */
export interface RenderToInertFragmentOptions {
  /** Document used to construct the inert fragment. Defaults to `globalThis.document`. */
  readonly ownerDocument?: Document;
  /**
   * Sanitizer overrides applied on top of the pipeline's own defaults.
   * The `ownerDocument` field, if set, is forwarded to the sanitizer.
   */
  readonly sanitizeOptions?: SanitizeOptions;
  /**
   * Cancellation signal. When aborted before rendering starts the
   * pipeline returns an empty fragment with an `aborted` warning; when
   * aborted between parse and sanitization the sanitized DOM is
   * discarded and the same aborted-fragment result is returned. Callers
   * bind the signal to the projection revision that scheduled the
   * render — if a newer revision arrives, the previous signal is
   * aborted and its output is discarded before it ever reaches the DOM.
   *
   * Requirement 15.6, 15.7 — cancellable lazy work.
   */
  readonly signal?: AbortSignal;
}

/**
 * Configuration accepted by {@link createMarkdownPipeline}. All fields are
 * optional; the pipeline ships defensible defaults for chat rendering.
 */
export interface CreateMarkdownPipelineOptions {
  /**
   * Extra `markdown-it` options merged onto the fixed base configuration.
   * Callers cannot override `html: false` — raw HTML is always disabled.
   * Callers cannot override `langPrefix` — task 10.4 relies on
   * `language-…` class names for highlighting.
   */
  readonly markdownItOptions?: Omit<MarkdownItOptions, 'html' | 'langPrefix'>;
  /** Sanitizer options applied to every rendered HTML string. */
  readonly sanitizeOptions?: SanitizeOptions;
}

/**
 * Public factory return type. Callers keep one pipeline instance per
 * surface family — instantiating a new `MarkdownIt` on every render is
 * measurable overhead.
 */
export interface MarkdownPipeline {
  /**
   * Render `markdown` to an inert {@link DocumentFragment}.
   *
   * Steps:
   *   1. Trivially empty input returns an empty fragment with no warnings.
   *   2. Non-string input is coerced to the empty string, returning an
   *      empty fragment. The pipeline never throws on unexpected input.
   *   3. Otherwise, the input is parsed and rendered by `markdown-it`
   *      (raw HTML disabled) and the resulting HTML string is passed
   *      through {@link sanitizeHtmlToInertFragment}.
   *   4. Sanitizer failure produces a `sanitizer_fallback` warning and
   *      returns the sanitizer's redacted plain-text fragment.
   */
  renderToInertFragment(
    markdown: string,
    options?: RenderToInertFragmentOptions,
  ): RenderToInertFragmentResult;

  /**
   * Render `markdown` to the intermediate HTML string produced by
   * `markdown-it` before sanitization. Provided for tests and diagnostics
   * that need to inspect the raw parser output — production surfaces
   * should always use {@link renderToInertFragment}.
   */
  renderToHtml(markdown: string): string;
}

// ─── Fixed configuration ────────────────────────────────────────────────────

/**
 * Fixed `markdown-it` options. Callers cannot override these keys — they
 * are the security posture of the pipeline.
 *
 * - `html: false` — raw HTML in the Markdown source is escaped to text
 *   during tokenization. Nothing the model writes as `<script>` or any
 *   other tag reaches the renderer as markup.
 * - `linkify: true` — bare URLs in text are converted to link tokens so
 *   they still route through the custom link renderer (rel-forced).
 * - `breaks: false` — single newlines are not converted to `<br>`. Chat
 *   answers use hard paragraphs; converting soft breaks produces noisy
 *   markup and interacts poorly with streaming plain-text rendering.
 * - `typographer: false` — quote/dash "smart" replacements would corrupt
 *   verbatim text (paths, quoted strings) that model answers routinely
 *   include verbatim.
 * - `langPrefix: 'language-'` — required by task 10.4's highlighter,
 *   which reads the `language-…` class from the emitted `<code>` element.
 * - `xhtmlOut: false` — HTML5 self-closing tags (`<br>` not `<br />`) —
 *   the sanitizer normalizes either form; a smaller output is preferred.
 */
const FIXED_MARKDOWN_IT_OPTIONS: MarkdownItOptions = Object.freeze({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  langPrefix: 'language-',
  xhtmlOut: false,
});

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a {@link MarkdownPipeline}. The returned object is safe to share
 * across surfaces on the same thread — `markdown-it` instances are not
 * stateful across `render` calls.
 */
export function createMarkdownPipeline(
  options: CreateMarkdownPipelineOptions = {},
): MarkdownPipeline {
  const md = new MarkdownIt({
    ...(options.markdownItOptions ?? {}),
    // Fixed keys applied last so callers cannot loosen the security posture.
    ...FIXED_MARKDOWN_IT_OPTIONS,
  });

  installFenceRenderer(md);
  installLinkRenderer(md);
  installImageRenderer(md);

  const factorySanitizeOptions = options.sanitizeOptions;

  return {
    renderToHtml(markdown: string): string {
      if (typeof markdown !== 'string' || markdown.length === 0) return '';
      return md.render(markdown);
    },

    renderToInertFragment(
      markdown: string,
      renderOptions?: RenderToInertFragmentOptions,
    ): RenderToInertFragmentResult {
      const doc = resolveOwnerDocument(renderOptions?.ownerDocument);

      const signal = renderOptions?.signal;

      // Fast path: signal already aborted before we do any work.
      if (signalIsAborted(signal)) {
        return abortedResult(doc, signal?.reason);
      }

      const source =
        typeof markdown === 'string' && markdown.length > 0 ? markdown : '';
      if (source.length === 0) {
        return {
          fragment: doc.createDocumentFragment(),
          warnings: EMPTY_WARNINGS,
        };
      }

      const html = md.render(source);

      // Check the signal a second time — parsing can be non-trivial for
      // large inputs and a newer revision may have landed while we were
      // busy. If so, discard the parsed HTML and return an empty
      // fragment; the newer revision will render its own.
      if (signalIsAborted(signal)) {
        return abortedResult(doc, signal?.reason);
      }

      const sanitizeOptions = mergeSanitizeOptions(
        factorySanitizeOptions,
        renderOptions?.sanitizeOptions,
        doc,
      );

      const result = sanitizeHtmlToInertFragment(html, sanitizeOptions);

      // Final abort check before the caller inserts the fragment into
      // the live DOM. If the signal fired between sanitization and
      // return, drop the sanitized DOM on the floor.
      if (signalIsAborted(signal)) {
        return abortedResult(doc, signal?.reason);
      }

      if (!result.ok) {
        const warnings: MarkdownPipelineWarning[] = [
          {
            kind: 'sanitizer_fallback',
            redactedPlaintext: result.redactedPlaintext,
          },
        ];
        return { fragment: result.fragment, warnings: Object.freeze(warnings) };
      }

      return { fragment: result.fragment, warnings: EMPTY_WARNINGS };
    },
  };
}

/**
 * Signal-abort probe that defeats the TypeScript flow analysis for
 * repeated `signal.aborted` reads. Without this wrapper, TS narrows
 * `signal.aborted` to `false | undefined` after the first check even
 * though the value can flip to `true` between calls (an AbortController
 * fires asynchronously).
 */
function signalIsAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  return signal.aborted;
}

/**
 * Build an aborted-result envelope. The fragment is empty (never null),
 * the warnings list carries one `aborted` entry. Callers must discard
 * the fragment and rely on a newer render to replace it.
 */
function abortedResult(
  doc: Document,
  reason: unknown,
): RenderToInertFragmentResult {
  const reasonString =
    reason === undefined || reason === null
      ? undefined
      : typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : String(reason);
  const warning: MarkdownPipelineWarning =
    reasonString === undefined
      ? { kind: 'aborted' }
      : { kind: 'aborted', reason: reasonString };
  return {
    fragment: doc.createDocumentFragment(),
    warnings: Object.freeze([warning]),
  };
}

const EMPTY_WARNINGS: readonly MarkdownPipelineWarning[] = Object.freeze([]);

// ─── Renderer installers ────────────────────────────────────────────────────

/**
 * Install the custom fence renderer. Emits
 * `<pre><code class="language-{lang}">{escaped code}</code></pre>` for every
 * fenced block. When the info string is empty the language class is omitted.
 *
 * The renderer does *not* call any syntax highlighter — task 10.4 owns
 * highlighting, which runs after sanitization and near-viewport gating.
 * Emitting escaped plain text here keeps the sanitizer's job trivial and
 * the pipeline deterministic for property tests.
 */
function installFenceRenderer(md: MarkdownIt): void {
  md.renderer.rules['fence'] = (
    tokens: Token[],
    idx: number,
  ): string => {
    const token = tokens[idx];
    if (!token) return '';

    const rawInfo = typeof token.info === 'string' ? token.info : '';
    // Fence info: "typescript title=foo" → take the first whitespace-
    // delimited word as the language identifier. Anything after is
    // discarded; the pipeline does not surface fence attributes.
    const languageId = rawInfo.trim().split(/\s+/, 1)[0] ?? '';

    const escapedCode = md.utils.escapeHtml(token.content ?? '');

    if (languageId.length > 0) {
      // Escape the language id so an adversarial info string cannot inject
      // HTML into the class attribute. The sanitizer would strip it anyway,
      // but the pipeline's own output should be well-formed.
      const escapedLang = md.utils.escapeHtml(languageId);
      return `<pre><code class="language-${escapedLang}">${escapedCode}</code></pre>\n`;
    }
    return `<pre><code>${escapedCode}</code></pre>\n`;
  };
}

/**
 * Install the custom `link_open` renderer.
 *
 * Task requirement: emit only `href`, `title`, and `rel="noopener noreferrer"`.
 * NO `target` attribute — external navigation is delegated to task 10.6.
 *
 * `markdown-it` normalizes and validates the `href` before this rule runs
 * (see `md.validateLink` / `md.normalizeLink`), so obviously unsafe schemes
 * like `javascript:` never produce a link token in the first place. The
 * sanitizer applies a second, independent URL check downstream, so this
 * rule can focus entirely on attribute shape.
 */
function installLinkRenderer(md: MarkdownIt): void {
  md.renderer.rules['link_open'] = (
    tokens: Token[],
    idx: number,
    optionsArg: MarkdownItOptions,
    _env: unknown,
    self: Renderer,
  ): string => {
    const token = tokens[idx];
    if (!token) return '';

    // Force-set rel. `attrSet` overrides any prior value, so if the input
    // Markdown or a plugin injected a different `rel` it is replaced here.
    token.attrSet('rel', 'noopener noreferrer');

    // Strip any `target` attribute. `linkify` in some versions attaches
    // `target="_blank"` to auto-detected URLs; the audit forbids that on
    // canonical surfaces. Same for any other transport-layer redirect.
    removeAttribute(token, 'target');

    // Drop everything except href, title, rel. Anything else that survived
    // through plugins or future markdown-it changes is discarded here so
    // downstream sanitization has less to do and the pipeline is
    // predictable for tests.
    if (token.attrs) {
      token.attrs = token.attrs.filter(([name]) => {
        const lower = String(name).toLowerCase();
        return lower === 'href' || lower === 'title' || lower === 'rel';
      });
    }

    return self.renderToken(tokens, idx, optionsArg);
  };
}

/**
 * Install the image renderer.
 *
 * The task-required supported set is: headings, lists, tables, links,
 * blockquotes, inline code, and fenced code blocks. Images are
 * intentionally excluded — a remote `<img src="...">` triggers an
 * out-of-band fetch and can leak referrer or timing information. This
 * renderer emits the escaped `alt` text as inline text so the reader still
 * sees "here was an image labelled X" without any network side effect.
 */
function installImageRenderer(md: MarkdownIt): void {
  md.renderer.rules['image'] = (tokens: Token[], idx: number): string => {
    const token = tokens[idx];
    if (!token) return '';
    // `markdown-it` stores the alt-text as `token.content`. It also stores
    // the child text tokens in `token.children`; using `content` avoids
    // re-rendering the inline stream and matches the CommonMark alt-text
    // conformance rule.
    const alt = typeof token.content === 'string' ? token.content : '';
    return md.utils.escapeHtml(alt);
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function removeAttribute(token: Token, name: string): void {
  if (!token.attrs) return;
  const target = name.toLowerCase();
  token.attrs = token.attrs.filter(
    ([attrName]) => String(attrName).toLowerCase() !== target,
  );
}

function resolveOwnerDocument(ownerDocument?: Document): Document {
  if (ownerDocument) return ownerDocument;
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      'markdown-pipeline: no Document available. Pass options.ownerDocument when running outside a browser or jsdom environment.',
    );
  }
  return doc;
}

function mergeSanitizeOptions(
  factory: SanitizeOptions | undefined,
  perCall: SanitizeOptions | undefined,
  doc: Document,
): SanitizeOptions {
  return {
    ...(factory ?? {}),
    ...(perCall ?? {}),
    // Always route the sanitizer at the resolved owner document so an
    // ownerDocument override on the pipeline call reaches the inert parser.
    ownerDocument: perCall?.ownerDocument ?? factory?.ownerDocument ?? doc,
  };
}
