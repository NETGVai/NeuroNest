/**
 * Independent inert-DOM structural sanitizer.
 *
 * Task 10.2 (enhanced-chat-ui) — this module owns the security boundary
 * between rendered HTML (from `markdown-it` in task 10.3, or any other
 * pre-existing producer) and the Response Card DOM. It parses HTML into an
 * inert `DocumentFragment`, walks the tree, and enforces explicit
 * allowlists for tags, attributes, and URL schemes. Everything else is
 * stripped or replaced with escaped plain text.
 *
 * The design in `.kiro/specs/enhanced-chat-ui/design.md` is explicit:
 * `markdown-it` is a parser and escaper, not a sanitizer. Security depends
 * on this independent DOM-walk allowlist. Task 10.3 wires this sanitizer
 * into the canonical Markdown pipeline; the audit test suite already forbids
 * unsafe patterns from reappearing on the canonical path.
 *
 * This module does not reach into any legacy renderer. It creates its own
 * inert host (`<template>` element preferred, `DOMParser` fallback for
 * environments without `HTMLTemplateElement.content`) so no dangerous side
 * effect can fire during parsing — remote images do not preload, scripts do
 * not execute, `srcdoc` payloads do not run.
 *
 * Requirements: 10.8, 15.1, 15.2, 15.8, 15.9
 *
 * @module src/renderer/structured-response/html-sanitizer
 */

// ─── Allowlist definitions ──────────────────────────────────────────────────

/**
 * Tag names that survive sanitization. Every other element is removed and
 * its children are promoted to the parent (so `<div><script>x</script>y</div>`
 * keeps the text `y` under the `<div>` after the `<script>` is dropped).
 *
 * A very short list — this is a rendering allowlist for chat responses, not a
 * general document sanitizer.
 */
const DEFAULT_ALLOWED_TAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'em',
    'strong',
    'b',
    'i',
    'u',
    's',
    'del',
    'ins',
    'sub',
    'sup',
    'span',
    'div',
    'a',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'img',
    'figure',
    'figcaption',
  ]),
);

/**
 * Tag names whose entire subtree is dropped — the element AND its descendants
 * are removed even if some descendants would otherwise be allowlisted.
 *
 * These are elements whose presence alone constitutes a security or capability
 * risk: script execution, remote fetches with side effects, iframe hosting,
 * plugin instantiation, `<base>` URL retargeting, and `<svg>` / `<math>`
 * foreign-namespace mutation vectors.
 */
const DEFAULT_DANGEROUS_TAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'base',
    'svg',
    'math',
    'applet',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'template',
    'slot',
    'portal',
    'noscript',
  ]),
);

/**
 * Attributes permitted per-tag. `'*'` applies to every allowlisted element
 * (currently empty — no attribute is universally allowed). Callers who
 * override this map must keep the same shape.
 */
const DEFAULT_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '*': Object.freeze([]),
  a: Object.freeze(['href', 'title', 'rel']),
  img: Object.freeze(['src', 'alt', 'title', 'width', 'height']),
  code: Object.freeze(['class']),
  pre: Object.freeze(['class']),
  span: Object.freeze(['class']),
  div: Object.freeze(['class']),
  th: Object.freeze(['scope', 'colspan', 'rowspan']),
  td: Object.freeze(['colspan', 'rowspan']),
  ol: Object.freeze(['start']),
  table: Object.freeze(['class']),
});

/**
 * URL schemes accepted on `href` (a-tag) attributes.
 */
const DEFAULT_HREF_SCHEMES: ReadonlySet<string> = Object.freeze(
  new Set(['https:', 'http:', 'mailto:']),
);

/**
 * URL schemes accepted on `src` (img-tag) attributes. `data:` is permitted
 * only for `image/*` MIME types below a configurable size cap so pasted
 * inline images survive but arbitrary data-URI payloads (particularly
 * `data:text/html`) are rejected.
 */
const DEFAULT_SRC_SCHEMES: ReadonlySet<string> = Object.freeze(
  new Set(['https:', 'http:', 'data:']),
);

/**
 * Attribute-name patterns that are always stripped, regardless of the
 * per-tag allowlist. Every `on*` handler, inline `style`, `srcdoc`, form
 * overrides, and any XML namespace declaration or attribute is rejected.
 * These are stripped even from allowlisted tags.
 */
const FORBIDDEN_ATTRIBUTE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^on/i,
  /^style$/i,
  /^srcdoc$/i,
  /^formaction$/i,
  /^form$/i,
  /^xmlns/i,
  /^xml:/i,
  /^data-bind/i,
  /^ng-/i,
  /^v-/i,
  /^x-on:/i,
  /^dynsrc$/i,
  /^lowsrc$/i,
  /^background$/i,
  /^is$/i,
]);

/**
 * Maximum size in bytes for a permitted `data:image/*` payload. Larger
 * payloads are rejected outright. 256 KB is a defensible upper bound for a
 * chat inline preview; upstream Markdown processing can enforce tighter
 * limits when appropriate.
 */
const DEFAULT_MAX_DATA_URL_BYTES = 256 * 1024;

/**
 * Maximum HTML length in characters accepted for parsing. Anything larger is
 * treated as a parse failure and the caller receives the redacted plain-text
 * fallback. This prevents a runaway payload from consuming render time.
 */
const DEFAULT_MAX_HTML_LENGTH = 512 * 1024;

// ─── Public options and result shape ────────────────────────────────────────

/**
 * Options accepted by {@link sanitizeHtmlToInertFragment}. All fields are
 * optional; the frozen defaults are used when a caller does not override.
 */
export interface SanitizeOptions {
  /** Document used to build the inert fragment. Defaults to `globalThis.document`. */
  readonly ownerDocument?: Document;
  /** Allowed tag names (lowercased). Overrides the default set. */
  readonly allowedTags?: ReadonlySet<string>;
  /** Elements dropped entirely with their subtree. Overrides the default set. */
  readonly dangerousTags?: ReadonlySet<string>;
  /** Per-tag attribute allowlist. Merged with defaults if not provided. */
  readonly allowedAttributes?: Readonly<Record<string, readonly string[]>>;
  /** URL schemes allowed on `href` attributes. */
  readonly allowedHrefSchemes?: ReadonlySet<string>;
  /** URL schemes allowed on `src` attributes. */
  readonly allowedSrcSchemes?: ReadonlySet<string>;
  /** Maximum size in bytes for a `data:image/*` payload. */
  readonly maxDataUrlBytes?: number;
  /** Maximum HTML character length accepted. */
  readonly maxHtmlLength?: number;
  /**
   * If `true`, `http:` links are rewritten to `https:` before validation.
   * Defaults to `true` — chat responses should not encourage plaintext links.
   */
  readonly upgradeHttpToHttps?: boolean;
}

/** Frozen default option constants exposed for tests and integration. */
export const DEFAULT_SANITIZE_OPTIONS = Object.freeze({
  allowedTags: DEFAULT_ALLOWED_TAGS,
  dangerousTags: DEFAULT_DANGEROUS_TAGS,
  allowedAttributes: DEFAULT_ALLOWED_ATTRIBUTES,
  allowedHrefSchemes: DEFAULT_HREF_SCHEMES,
  allowedSrcSchemes: DEFAULT_SRC_SCHEMES,
  maxDataUrlBytes: DEFAULT_MAX_DATA_URL_BYTES,
  maxHtmlLength: DEFAULT_MAX_HTML_LENGTH,
  upgradeHttpToHttps: true,
}) satisfies Required<Omit<SanitizeOptions, 'ownerDocument'>>;

/**
 * Result of a sanitize call.
 *
 * - `ok: true` — the fragment contains the sanitized DOM (only allowlisted
 *   tags/attributes/URLs) suitable for insertion into a live document.
 * - `ok: false` — sanitization could not complete cleanly (parse failure,
 *   pathologically deep structure, or environment without an HTML parser).
 *   The fragment contains a single text node with `redactedPlaintext`;
 *   `redactedPlaintext` is safe to insert as `textContent` if the caller
 *   prefers to build its own placeholder DOM.
 */
export type SanitizeResult =
  | {
      readonly ok: true;
      readonly fragment: DocumentFragment;
      readonly redactedPlaintext?: undefined;
    }
  | {
      readonly ok: false;
      readonly fragment: DocumentFragment;
      readonly redactedPlaintext: string;
    };

// ─── Sanitization entry point ───────────────────────────────────────────────

/**
 * Parse `html` into an inert `DocumentFragment` and enforce the structural
 * allowlist. Returns an `ok: true` result on success or an `ok: false`
 * result with a safe redacted plaintext fallback on any parse failure or
 * unrecoverable structural violation.
 *
 * The returned fragment is always safe to insert into the live document
 * with `Node.appendChild` or `Element.replaceChildren` — sanitization runs
 * on an inert host, so no side effect (image preload, script execution,
 * srcdoc mount) fires during parsing.
 *
 * @param html — Untrusted HTML string.
 * @param options — Optional overrides for the default allowlists.
 * @returns A {@link SanitizeResult} describing the sanitized DOM.
 */
export function sanitizeHtmlToInertFragment(
  html: unknown,
  options: SanitizeOptions = {},
): SanitizeResult {
  const doc = resolveOwnerDocument(options.ownerDocument);
  const opts = resolveOptions(options);

  if (typeof html !== 'string') {
    return buildPlaintextFallback(doc, '');
  }

  if (html.length === 0) {
    return { ok: true, fragment: doc.createDocumentFragment() };
  }

  if (html.length > opts.maxHtmlLength) {
    return buildPlaintextFallback(doc, redactToPlaintext(html));
  }

  let inertRoot: ParentNode;
  try {
    inertRoot = parseHtmlToInertRoot(html, doc);
  } catch {
    return buildPlaintextFallback(doc, redactToPlaintext(html));
  }

  const fragment = doc.createDocumentFragment();
  try {
    walkAndSanitize(inertRoot, fragment, doc, opts, 0);
  } catch {
    return buildPlaintextFallback(doc, redactToPlaintext(html));
  }

  return { ok: true, fragment };
}

// ─── Option resolution ──────────────────────────────────────────────────────

interface ResolvedOptions {
  readonly allowedTags: ReadonlySet<string>;
  readonly dangerousTags: ReadonlySet<string>;
  readonly allowedAttributes: Readonly<Record<string, readonly string[]>>;
  readonly allowedHrefSchemes: ReadonlySet<string>;
  readonly allowedSrcSchemes: ReadonlySet<string>;
  readonly maxDataUrlBytes: number;
  readonly maxHtmlLength: number;
  readonly upgradeHttpToHttps: boolean;
}

function resolveOptions(options: SanitizeOptions): ResolvedOptions {
  return {
    allowedTags: options.allowedTags ?? DEFAULT_SANITIZE_OPTIONS.allowedTags,
    dangerousTags: options.dangerousTags ?? DEFAULT_SANITIZE_OPTIONS.dangerousTags,
    allowedAttributes:
      options.allowedAttributes ?? DEFAULT_SANITIZE_OPTIONS.allowedAttributes,
    allowedHrefSchemes:
      options.allowedHrefSchemes ?? DEFAULT_SANITIZE_OPTIONS.allowedHrefSchemes,
    allowedSrcSchemes:
      options.allowedSrcSchemes ?? DEFAULT_SANITIZE_OPTIONS.allowedSrcSchemes,
    maxDataUrlBytes:
      options.maxDataUrlBytes ?? DEFAULT_SANITIZE_OPTIONS.maxDataUrlBytes,
    maxHtmlLength: options.maxHtmlLength ?? DEFAULT_SANITIZE_OPTIONS.maxHtmlLength,
    upgradeHttpToHttps:
      options.upgradeHttpToHttps ?? DEFAULT_SANITIZE_OPTIONS.upgradeHttpToHttps,
  };
}

function resolveOwnerDocument(ownerDocument?: Document): Document {
  if (ownerDocument) return ownerDocument;
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      'html-sanitizer: no Document available. Pass options.ownerDocument when running outside a browser or jsdom environment.',
    );
  }
  return doc;
}

// ─── Inert parsing ──────────────────────────────────────────────────────────

/**
 * Parse an untrusted HTML string into an inert node subtree. Two paths:
 *
 * 1. `<template>` element — `template.content` is a DocumentFragment
 *    associated with an inert template contents document; script tags do
 *    not execute, image/iframe resources do not load. This is the preferred
 *    path in browsers and jsdom.
 * 2. `DOMParser` with `text/html` — used only when `<template>` is
 *    unavailable in the runtime. `DOMParser` builds an inert `Document`;
 *    scripts and remote resources are also inert there.
 *
 * If neither is available, the caller receives a redacted plaintext
 * fallback via the outer function's catch clause.
 */
function parseHtmlToInertRoot(html: string, doc: Document): ParentNode {
  const HTMLTemplateElementCtor = (
    globalThis as { HTMLTemplateElement?: typeof HTMLTemplateElement }
  ).HTMLTemplateElement;

  if (typeof doc.createElement === 'function' && HTMLTemplateElementCtor) {
    const template = doc.createElement('template') as HTMLTemplateElement;
    // `template.content` is a DocumentFragment associated with an inert
    // template contents document — no side effects fire on assignment.
    template.innerHTML = html;
    return template.content;
  }

  const DomParserCtor = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (typeof DomParserCtor === 'function') {
    const parser = new DomParserCtor();
    const parsed = parser.parseFromString(html, 'text/html');
    return parsed.body ?? parsed.documentElement;
  }

  throw new Error('html-sanitizer: no inert HTML parser available');
}

// ─── Tree walk ──────────────────────────────────────────────────────────────

/**
 * Bound on parse-tree depth. HTML rarely nests more than a few dozen levels
 * legitimately; nested attack payloads that reach this depth are treated as
 * a structural violation and the caller receives the plaintext fallback.
 */
const MAX_STRUCTURAL_DEPTH = 128;

/**
 * Total-node bound. Independent of depth, this caps the amount of work the
 * walker will do on a single payload. Beyond this, the caller receives the
 * plaintext fallback.
 */
const MAX_TOTAL_NODES = 20_000;

function walkAndSanitize(
  input: ParentNode,
  output: ParentNode,
  doc: Document,
  opts: ResolvedOptions,
  depth: number,
): void {
  if (depth > MAX_STRUCTURAL_DEPTH) {
    throw new Error('html-sanitizer: maximum structural depth exceeded');
  }

  // NodeList is live on children mutation — we snapshot to an array so the
  // walk stays stable if a caller-side mutation ever slipped in.
  const children = Array.from(input.childNodes);
  for (const child of children) {
    if (isTextNode(child)) {
      const text = child.nodeValue ?? '';
      if (text.length > 0) {
        output.appendChild(doc.createTextNode(text));
      }
      continue;
    }

    if (isElement(child)) {
      const tagName = (child.tagName || '').toLowerCase();

      if (opts.dangerousTags.has(tagName)) {
        // Drop the element AND its subtree. Do NOT promote children.
        continue;
      }

      if (!opts.allowedTags.has(tagName)) {
        // Element is not on the allowlist. Promote its children — this is
        // the "unwrap unknown tags" behaviour that keeps user text visible
        // when the model emits an unknown wrapping element (e.g. `<article>`).
        walkAndSanitize(child, output, doc, opts, depth + 1);
        continue;
      }

      const sanitizedEl = createSanitizedElement(child, tagName, doc, opts);
      if (!sanitizedEl) {
        // Element itself was invalid (e.g. img with no valid src, a with
        // rejected href) — degrade to promoting children so any inner text
        // remains visible.
        walkAndSanitize(child, output, doc, opts, depth + 1);
        continue;
      }

      output.appendChild(sanitizedEl);
      // Void elements have no children — img, br, hr all reach here.
      if (!isVoidTag(tagName)) {
        walkAndSanitize(child, sanitizedEl, doc, opts, depth + 1);
      }
      continue;
    }

    // Comments, processing instructions, and CDATA are dropped silently.
  }

  // Total-node bound. `output` accumulates across recursive calls; a global
  // check post-walk keeps the cost of the check bounded to one traversal.
  if (countDescendantNodes(output) > MAX_TOTAL_NODES) {
    throw new Error('html-sanitizer: node count exceeded');
  }
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === 3; // Node.TEXT_NODE
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1; // Node.ELEMENT_NODE
}

function isVoidTag(tag: string): boolean {
  switch (tag) {
    case 'br':
    case 'hr':
    case 'img':
      return true;
    default:
      return false;
  }
}

function countDescendantNodes(node: ParentNode): number {
  let count = 0;
  const stack: Node[] = Array.from(node.childNodes);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    count += 1;
    if (count > MAX_TOTAL_NODES) return count;
    if (isElement(current)) {
      stack.push(...Array.from(current.childNodes));
    }
  }
  return count;
}

// ─── Element construction ───────────────────────────────────────────────────

function createSanitizedElement(
  source: Element,
  tagName: string,
  doc: Document,
  opts: ResolvedOptions,
): Element | null {
  const clone = doc.createElement(tagName);

  const perTagAllowed = new Set<string>([
    ...(opts.allowedAttributes['*'] ?? []),
    ...(opts.allowedAttributes[tagName] ?? []),
  ]);

  const attributeNames = source.getAttributeNames();
  let elementInvalid = false;

  for (const rawName of attributeNames) {
    const name = rawName.toLowerCase();

    if (isAttributeAlwaysForbidden(name)) {
      continue;
    }

    if (!perTagAllowed.has(name)) {
      continue;
    }

    const rawValue = source.getAttribute(rawName);
    if (rawValue === null) continue;

    // Reject values containing control characters unconditionally — even on
    // "safe" attributes. Control chars in `alt`, `title`, or `class` are a
    // strong signal of an attempted mutation-XSS payload.
    if (hasControlCharacters(rawValue)) {
      continue;
    }

    if (name === 'href' && tagName === 'a') {
      const normalized = normalizeHref(rawValue, opts);
      if (normalized === null) {
        elementInvalid = true;
        break;
      }
      clone.setAttribute('href', normalized);
      continue;
    }

    if (name === 'src' && tagName === 'img') {
      const normalized = normalizeSrc(rawValue, opts);
      if (normalized === null) {
        elementInvalid = true;
        break;
      }
      clone.setAttribute('src', normalized);
      continue;
    }

    // For every other allowlisted attribute, take the caller-supplied value
    // verbatim after control-character screening. `class`, `title`, `alt`,
    // `rel`, `width`, `height`, `scope`, `colspan`, `rowspan`, `start` all
    // reach here.
    clone.setAttribute(name, rawValue);
  }

  if (elementInvalid) {
    return null;
  }

  // Anchor tags always get `rel="noopener noreferrer"` regardless of the
  // model's original value. Task 10.6 supplies the external-link IPC that
  // consumers use; the anchor itself must not open a top-level navigation.
  if (tagName === 'a') {
    clone.setAttribute('rel', 'noopener noreferrer');
    // Explicitly prevent target="_blank" — the audit-unsafe-behavior tests
    // already forbid it on canonical surfaces; the sanitizer refuses to
    // emit it here even if a caller allowlists `target` in a future option.
    clone.removeAttribute('target');
  }

  return clone;
}

function isAttributeAlwaysForbidden(name: string): boolean {
  for (const pattern of FORBIDDEN_ATTRIBUTE_PATTERNS) {
    if (pattern.test(name)) return true;
  }
  return false;
}

function hasControlCharacters(value: string): boolean {
  // Match ASCII control chars (0x00-0x1F, 0x7F), Unicode line/paragraph
  // separators, BOM, and the Unicode replacement character — anything that
  // could smuggle a URL past the normalizer. The HTML parser normalizes
  // literal U+0000 to U+FFFD during tokenization, so U+FFFD in an attribute
  // value is a signal that a null byte was present in the source and the
  // value should not be trusted.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u2028\u2029\uFEFF\uFFFD]/.test(value);
}

// ─── URL normalization ──────────────────────────────────────────────────────

function normalizeHref(raw: string, opts: ResolvedOptions): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject inputs whose scheme is dangerous BEFORE URL parsing. `new URL`
  // is not permissive enough on its own — javascript: parses successfully
  // in browsers.
  if (hasDangerousScheme(trimmed)) return null;

  // Fragment-only and same-origin relative links pass through unchanged
  // (still stripped of control chars). Absolute URLs go through the URL
  // parser with a placeholder base so validators for credentials and host
  // shape run consistently.
  if (trimmed.startsWith('#')) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://placeholder.invalid/');
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) return null;

  if (parsed.protocol === 'mailto:') {
    // mailto: does not use a host; validate address shape via the pathname.
    if (!/^[^\s<>]+@[^\s<>]+$/.test(parsed.pathname)) return null;
    return `mailto:${parsed.pathname}`;
  }

  if (parsed.protocol === 'http:' && opts.upgradeHttpToHttps) {
    parsed.protocol = 'https:';
  }

  if (!opts.allowedHrefSchemes.has(parsed.protocol)) {
    return null;
  }

  if (!parsed.hostname) return null;
  if (!isHostShapeValid(parsed.hostname)) return null;

  return parsed.toString();
}

function normalizeSrc(raw: string, opts: ResolvedOptions): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (hasDangerousScheme(trimmed)) return null;

  // `data:image/*` — permitted up to the configured byte cap.
  if (/^data:/i.test(trimmed)) {
    return normalizeDataUrl(trimmed, opts);
  }

  // Reject relative image references. In a chat renderer there is no base
  // URL context — a bare `img src="x"` cannot resolve to anything the caller
  // controls. Require an explicit scheme.
  if (!hasExplicitScheme(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://placeholder.invalid/');
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) return null;

  if (parsed.protocol === 'http:' && opts.upgradeHttpToHttps) {
    parsed.protocol = 'https:';
  }

  if (!opts.allowedSrcSchemes.has(parsed.protocol)) {
    return null;
  }
  if (parsed.protocol === 'data:') {
    // `data:` reached here without matching the earlier regex — treat as
    // rejected. The `data:` branch above owns the accepted path.
    return null;
  }

  if (!parsed.hostname) return null;
  if (!isHostShapeValid(parsed.hostname)) return null;
  // Guard against a relative URL that slipped past the earlier scheme
  // check — its parsed host would be the placeholder itself.
  if (parsed.hostname === 'placeholder.invalid') return null;

  return parsed.toString();
}

function hasExplicitScheme(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw);
}

function normalizeDataUrl(raw: string, opts: ResolvedOptions): string | null {
  // Structure: `data:[<mediatype>][;base64],<data>`
  const match = raw.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mediaType = (match[1] ?? '').toLowerCase();
  const isBase64 = !!match[2];
  const payload = match[3] ?? '';

  if (!mediaType.startsWith('image/')) return null;
  // Reject `data:image/svg+xml` — SVG payloads can carry `<script>` and
  // event handlers even inside a `data:` URL.
  if (mediaType === 'image/svg+xml' || mediaType === 'image/svg') return null;

  const approximateBytes = isBase64
    ? Math.floor((payload.length * 3) / 4)
    : payload.length;
  if (approximateBytes > opts.maxDataUrlBytes) return null;

  return raw;
}

function hasDangerousScheme(raw: string): boolean {
  const stripped = raw.replace(/[\s\t\r\n]+/g, '').toLowerCase();
  return (
    stripped.startsWith('javascript:') ||
    stripped.startsWith('vbscript:') ||
    stripped.startsWith('livescript:') ||
    stripped.startsWith('mocha:') ||
    stripped.startsWith('file:') ||
    stripped.startsWith('about:') ||
    stripped.startsWith('chrome:') ||
    stripped.startsWith('chrome-extension:') ||
    stripped.startsWith('blob:') ||
    stripped.startsWith('filesystem:') ||
    // `data:text/html` and `data:application/*` — only image data URLs are
    // handled in the accepted branch of normalizeSrc.
    /^data:(?:text\/|application\/)/i.test(stripped)
  );
}

function isHostShapeValid(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.length > 253) return false;
  // Reject percent-encoded hosts (`xn--` idn is fine).
  if (/%/.test(hostname)) return false;
  // Reject hosts containing whitespace or explicit control chars.
  if (/\s/.test(hostname)) return false;
  return true;
}

// ─── Failure fallback ───────────────────────────────────────────────────────

/**
 * Build a redacted plain-text fragment. Callers can either append this
 * fragment as-is or read `redactedPlaintext` and construct their own
 * placeholder DOM. The text is bounded and free of markup so
 * `element.textContent = redactedPlaintext` is always safe.
 */
function buildPlaintextFallback(doc: Document, redactedPlaintext: string): SanitizeResult {
  const fragment = doc.createDocumentFragment();
  if (redactedPlaintext.length > 0) {
    fragment.appendChild(doc.createTextNode(redactedPlaintext));
  }
  return { ok: false, fragment, redactedPlaintext };
}

/**
 * Convert an untrusted HTML string to plaintext for the failure fallback.
 *
 * Rules:
 * - Strip every `<...>` tag (angle-bracket sequences).
 * - Decode named and numeric character entities into their literal chars,
 *   because a caller inserting via `textContent` still wants the human
 *   text visible.
 * - Collapse runs of whitespace to keep the fallback readable.
 * - Cap the resulting string at 4 KB so a runaway payload cannot make the
 *   fallback expensive to render.
 */
function redactToPlaintext(html: string): string {
  const withoutTags = html.replace(/<[^>]*>?/g, ' ');
  const decoded = decodeBasicEntities(withoutTags);
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  const CAP = 4 * 1024;
  return collapsed.length > CAP ? collapsed.slice(0, CAP) : collapsed;
}

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const code = parseInt(hex as string, 16);
      return safeFromCharCode(code);
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = parseInt(dec as string, 10);
      return safeFromCharCode(code);
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeFromCharCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
