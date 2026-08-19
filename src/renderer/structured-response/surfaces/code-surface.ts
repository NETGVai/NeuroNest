/**
 * CodeSurface — Typed code artifact surface with allowlist-only syntax
 * highlighting, copy, wrap, settings-driven height, optional line numbers,
 * viewport-gated deferred highlighting, and authority-routed open actions.
 *
 * Task 10.4 (enhanced-chat-ui) — this surface no longer runs its own
 * keyword tokenizer or hand-rolled classification. Highlighting is
 * delegated to {@link createCodeHighlighter} which enforces:
 *
 *   1. An explicit fixed allowlist of grammars (task 10.4).
 *   2. No auto-detection — unknown/missing language renders as escaped
 *      plain text.
 *   3. No bulk `highlight.js/lib/common` import.
 *
 * Highlighting is also deferred until the block is finalized and the
 * element is near the viewport. When `IntersectionObserver` is available
 * the surface observes the element with a 500 px root margin and triggers
 * highlighting on the first intersection callback. When
 * `IntersectionObserver` is unavailable (Node/jsdom tests) the surface
 * degrades to an immediate render for small blocks and a size-based
 * `setTimeout` defer for large blocks — the existing behaviour before
 * task 10.4.
 *
 * The block's canonical stable identity is produced by
 * {@link deriveCodeIdentity} from `(responseId, narrativeBlockStableKey,
 * fenceIndex)` when the caller supplies those inputs via
 * {@link CodeSurfaceOptions.identity}. There is no counter, timestamp, or
 * random component to the identity.
 *
 * Open-file/open-range actions remain routed exclusively through
 * Filesystem_Authority via the StructuredActionPort. Private paths are
 * redacted in all output channels.
 *
 * Requirements: 10.1–10.3, 10.7, 10.9, 15.6, 15.7, 19.5, 20.3–20.5
 */

import type { CodeBlockV1 } from '../../../harness/contracts/response-composition';
import {
  copyExactSourceToClipboard,
  type ClipboardAdapter,
  type ClipboardCopyFeedback,
} from '../clipboard-copy';
import { redactForOutput } from '../output-redaction-service';
import {
  createCodeHighlighter,
  CODE_HIGHLIGHT_ALLOWLIST,
  type CodeHighlighter,
} from '../code-highlighter';
import { deriveCodeIdentity, type CodeIdentityInputs } from '../code-identity';
import { attachToolbarArrowKeyNavigation } from '../semantic-accessibility';

/** Re-export for backward compatibility — use output-redaction-service directly for new code. */
export const redactPrivatePaths = redactForOutput;

// ─── Constants ──────────────────────────────────────────────────

const CSS_PREFIX = 'nn-code-surface';

/** Default initial max-height (px) when settings do not provide a value. */
const DEFAULT_MAX_HEIGHT = 400;

/** Delay before deferred highlighting fires (ms) when no IntersectionObserver is available. */
const DEFAULT_HIGHLIGHT_DEFER_MS = 150;

/** Minimum code length before deferred highlighting applies when no IntersectionObserver is available. */
const DEFERRED_HIGHLIGHT_THRESHOLD = 500;

/**
 * Root margin passed to {@link IntersectionObserver}. Highlighting fires
 * once the block is within 500 px of the viewport in any axis, giving the
 * grammar work a head start on scroll before the block becomes visible.
 */
const HIGHLIGHT_ROOT_MARGIN = '500px';

/** Language display names from fence identifiers. */
const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  ruby: 'Ruby',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  cpp: 'C++',
  'c++': 'C++',
  c: 'C',
  cs: 'C#',
  csharp: 'C#',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  md: 'Markdown',
  markdown: 'Markdown',
  dockerfile: 'Dockerfile',
  toml: 'TOML',
  graphql: 'GraphQL',
  swift: 'Swift',
  kotlin: 'Kotlin',
  kt: 'Kotlin',
  dart: 'Dart',
  lua: 'Lua',
  php: 'PHP',
  r: 'R',
  scala: 'Scala',
  elixir: 'Elixir',
  haskell: 'Haskell',
  plaintext: 'Plain Text',
  text: 'Plain Text',
  txt: 'Plain Text',
});

// ─── Types ──────────────────────────────────────────────────────

export interface CodeSurfaceOptions {
  /** Initial max-height in pixels from Settings_Service. */
  readonly maxHeight: number;
  /** Whether line numbers are enabled (from settings or block metadata). */
  readonly showLineNumbers: boolean;
  /** Whether wrap is enabled. */
  readonly wrapEnabled: boolean;
  /**
   * Deferred highlight delay in milliseconds used only when no
   * `IntersectionObserver` is available. `0` renders synchronously.
   * Ignored when the surface observes the element for viewport
   * intersection.
   */
  readonly highlightDeferMs: number;
  /** Callback to open a file through Filesystem_Authority. */
  readonly onOpenFile?: (target: CodeOpenTarget) => Promise<CodeActionResult>;
  /** Callback to open a file at a specific range through Filesystem_Authority. */
  readonly onOpenRange?: (target: CodeOpenRangeTarget) => Promise<CodeActionResult>;
  /** Owner document for element creation. */
  readonly ownerDocument?: Document;
  /**
   * Optional abort signal bound to the current projection revision.
   * When aborted, any in-flight deferred highlighting is cancelled and
   * its output is discarded — a newer revision that scheduled its own
   * signal will render instead. Callers refresh this via
   * {@link CodeSurfaceHandle.update} when a newer revision lands.
   *
   * Requirement 15.6, 15.7 — cancellable lazy work.
   */
  readonly signal?: AbortSignal;
  /**
   * Allowlist-only highlighter. When omitted the surface uses a lazily
   * created module singleton with all allowlisted grammars registered.
   * Callers can inject a scoped highlighter for tests or to control the
   * set of registered grammars.
   */
  readonly highlighter?: CodeHighlighter;
  /**
   * Canonical identity inputs for this fenced block. When supplied the
   * surface derives a deterministic DOM identity via
   * {@link deriveCodeIdentity} and exposes it as `data-code-identity`.
   * The block's `stableKey` is always used as the reconciliation key —
   * this option only records the derivation for downstream diagnostics.
   */
  readonly identity?: CodeIdentityInputs;
  /**
   * Accessible live-region feedback channel for copy outcomes (task 10.5).
   * When supplied, copy success announces on the polite `role="status"`
   * region and copy failure announces on the assertive `role="alert"`
   * region — the same channel the response-group router uses. When
   * omitted, the copy action still updates its own visible button label
   * transiently, but no screen-reader announcement is emitted. Callers
   * that mount the surface inside a response-group toolbar should always
   * pass the group's live-region pair so keyboard/screen-reader users get
   * uniform feedback.
   */
  readonly feedbackSurface?: ClipboardCopyFeedback;
  /**
   * Clipboard adapter override (task 10.5). Defaults to the async
   * `navigator.clipboard` API resolved by
   * {@link ./clipboard-copy | defaultClipboardAdapter}. Never falls back
   * to the legacy synchronous copy API. Tests inject a stub to observe
   * copy dispatch without touching the OS clipboard.
   */
  readonly clipboard?: ClipboardAdapter | null;
}

export interface CodeOpenTarget {
  readonly artifactId: string;
  readonly filePath: string;
}

export interface CodeOpenRangeTarget extends CodeOpenTarget {
  readonly startLine: number;
  readonly endLine: number;
}

export interface CodeActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

export type CodeSurfaceActionKind = 'copy' | 'wrap_toggle' | 'open_file' | 'open_range';

export interface CodeSurfaceAction {
  readonly kind: CodeSurfaceActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly execute: () => Promise<CodeActionResult>;
}

export interface CodeSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly isHighlighted: boolean;
  readonly isStreaming: boolean;
  readonly actions: readonly CodeSurfaceAction[];
  update(block: CodeBlockV1, options?: Partial<CodeSurfaceOptions>): void;
  dispose(): void;
}

// ─── Language utilities ─────────────────────────────────────────

export function getLanguageDisplayName(language: string): string {
  if (!language) return 'Code';
  const lower = language.toLowerCase().trim();
  return LANGUAGE_DISPLAY_NAMES[lower] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

// ─── Default highlighter (lazy singleton) ───────────────────────

let _defaultHighlighter: CodeHighlighter | null = null;

/**
 * No-op feedback channel used when the caller does not pass a
 * live-region surface. The copy helper always announces success or
 * failure through some channel; when the surface is rendered outside a
 * response-group toolbar (e.g., a standalone fixture) this stub keeps
 * the helper's contract honest without emitting DOM output. Real usage
 * always injects the response-group's shared live-region pair.
 */
const silentFeedback: ClipboardCopyFeedback = Object.freeze({
  announceStatus(_message: string): void {
    /* no-op */
  },
  announceAlert(_message: string): void {
    /* no-op */
  },
});

function getDefaultHighlighter(): CodeHighlighter {
  if (_defaultHighlighter === null) {
    const created = createCodeHighlighter();
    created.registerLanguages(CODE_HIGHLIGHT_ALLOWLIST);
    _defaultHighlighter = created;
  }
  return _defaultHighlighter;
}

// ─── Line-splitting for highlight.js output ─────────────────────

/**
 * Split `highlight.js` output into per-line HTML fragments. The library
 * emits `<span class="hljs-…">…</span>` tags that routinely cross
 * newlines (multi-line comments and template strings, for example).
 * Naïvely splitting on `\n` would leave open tags in one line and
 * dangling closers in the next.
 *
 * This helper walks the output, tracking a stack of open `class` values,
 * and closes/reopens spans at every `\n` so each returned fragment is a
 * well-formed HTML string with no cross-line tags. Only `<span>` and
 * `</span>` are recognised — highlight.js's output is a well-known
 * subset and never emits other tags.
 */
function splitHighlightedIntoLines(html: string): string[] {
  const lines: string[] = [];
  const openStack: string[] = [];
  const spanOpen = /^<span class="([^"]*)">/;
  const spanClose = /^<\/span>/;
  const n = html.length;

  let current = '';
  let cursor = 0;

  while (cursor < n) {
    const ch = html.charCodeAt(cursor);
    if (ch === 0x3c /* '<' */) {
      const rest = html.slice(cursor);
      const open = rest.match(spanOpen);
      if (open) {
        const classes = open[1] ?? '';
        openStack.push(classes);
        current += open[0];
        cursor += open[0].length;
        continue;
      }
      const close = rest.match(spanClose);
      if (close) {
        if (openStack.length > 0) openStack.pop();
        current += '</span>';
        cursor += close[0].length;
        continue;
      }
      // Non-span '<' — fall through and copy verbatim. highlight.js
      // output should never reach this branch, but the surface stays
      // defensive so a hypothetical future change does not crash it.
    }
    if (ch === 0x0a /* '\n' */) {
      for (let i = openStack.length - 1; i >= 0; i--) current += '</span>';
      lines.push(current);
      current = '';
      for (const cls of openStack) current += `<span class="${cls}">`;
      cursor++;
      continue;
    }
    current += html.charAt(cursor);
    cursor++;
  }

  // Always emit the trailing line (even if empty for a single-line
  // input) so consumers can align with the source line count.
  lines.push(current);
  return lines;
}

// ─── IntersectionObserver access ────────────────────────────────

type IntersectionObserverCtor = typeof IntersectionObserver;

/**
 * Resolve the {@link IntersectionObserver} constructor for the given
 * owner document. Prefers `defaultView.IntersectionObserver` so tests
 * that install a mock on a specific window pick it up, then falls back
 * to `globalThis.IntersectionObserver`. Returns `null` when the API is
 * unavailable (Node without jsdom polyfills).
 */
function getIntersectionObserverCtor(doc: Document): IntersectionObserverCtor | null {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (win && typeof (win as unknown as { IntersectionObserver?: unknown }).IntersectionObserver === 'function') {
    return (win as unknown as { IntersectionObserver: IntersectionObserverCtor }).IntersectionObserver;
  }
  const globalIO = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  if (typeof globalIO === 'function') {
    return globalIO as IntersectionObserverCtor;
  }
  return null;
}

// ─── CodeSurface ────────────────────────────────────────────────

const DEFAULT_OPTIONS: CodeSurfaceOptions = {
  maxHeight: DEFAULT_MAX_HEIGHT,
  showLineNumbers: false,
  wrapEnabled: false,
  highlightDeferMs: DEFAULT_HIGHLIGHT_DEFER_MS,
};

export class CodeSurface {
  private readonly doc: Document;

  constructor(ownerDocument: Document = document) {
    this.doc = ownerDocument;
  }

  render(block: CodeBlockV1, options: Partial<CodeSurfaceOptions> = {}): CodeSurfaceHandle {
    const resolved: CodeSurfaceOptions = { ...DEFAULT_OPTIONS, ...options };
    const doc = resolved.ownerDocument ?? this.doc;
    const highlighter = resolved.highlighter ?? getDefaultHighlighter();
    const identityString = resolved.identity ? deriveCodeIdentity(resolved.identity) : null;

    // State
    let currentBlock = block;
    let currentOptions = resolved;
    let disposed = false;
    let highlighted = false;
    let highlightTimerId: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;
    let wrapEnabled = resolved.wrapEnabled;

    // ─── Root element ───────────────────────────────────────────

    const root = doc.createElement('section');
    root.className = `${CSS_PREFIX}`;
    root.setAttribute('role', 'region');
    root.setAttribute(
      'aria-label',
      `Code: ${getLanguageDisplayName(block.content.language)}`,
    );
    root.dataset.stableKey = block.stableKey;
    root.dataset.semanticAnchor = block.semanticAnchor;
    if (identityString !== null) {
      root.dataset.codeIdentity = identityString;
    }

    // ─── Header ─────────────────────────────────────────────────

    const header = doc.createElement('div');
    header.className = `${CSS_PREFIX}__header`;

    const langBadge = doc.createElement('span');
    langBadge.className = `${CSS_PREFIX}__lang-badge`;
    langBadge.textContent = getLanguageDisplayName(block.content.language);
    header.appendChild(langBadge);

    // Actions container — toolbar semantics with roving tabindex and
    // arrow-key navigation. Requirements 12.5 (code-action toolbars) and
    // 14.4 (every interactive element is keyboard operable).
    const actionsContainer = doc.createElement('div');
    actionsContainer.className = `${CSS_PREFIX}__actions`;
    actionsContainer.setAttribute('role', 'toolbar');
    actionsContainer.setAttribute('aria-label', 'Code block actions');
    actionsContainer.setAttribute('aria-orientation', 'horizontal');

    // Copy button (first non-disabled toolbar item — receives initial focus)
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__copy-btn`;
    copyBtn.setAttribute('aria-label', 'Copy code to clipboard');
    copyBtn.setAttribute('tabindex', '0');
    copyBtn.textContent = 'Copy';
    actionsContainer.appendChild(copyBtn);

    // Wrap toggle button
    const wrapBtn = doc.createElement('button');
    wrapBtn.type = 'button';
    wrapBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__wrap-btn`;
    wrapBtn.setAttribute('aria-label', wrapEnabled ? 'Disable word wrap' : 'Enable word wrap');
    wrapBtn.setAttribute('aria-pressed', String(wrapEnabled));
    wrapBtn.setAttribute('tabindex', '-1');
    wrapBtn.textContent = 'Wrap';
    actionsContainer.appendChild(wrapBtn);

    // Open file button (only if authorized file reference exists)
    let openFileBtn: HTMLButtonElement | null = null;
    if (block.content.displayLabel && resolved.onOpenFile) {
      openFileBtn = doc.createElement('button');
      openFileBtn.type = 'button';
      openFileBtn.className = `${CSS_PREFIX}__action-btn ${CSS_PREFIX}__open-btn`;
      openFileBtn.setAttribute(
        'aria-label',
        `Open file: ${redactPrivatePaths(block.content.displayLabel)}`,
      );
      openFileBtn.setAttribute('tabindex', '-1');
      openFileBtn.textContent = 'Open';
      actionsContainer.appendChild(openFileBtn);
    }

    header.appendChild(actionsContainer);
    root.appendChild(header);

    // Attach arrow-key + Home/End keyboard navigation to the actions
    // toolbar. The listener lives on the container itself so it survives
    // subsequent updates that swap button labels.
    const codeToolbarNav = attachToolbarArrowKeyNavigation(actionsContainer, {
      orientation: 'horizontal',
    });

    // ─── Code container ─────────────────────────────────────────

    const codeContainer = doc.createElement('div');
    codeContainer.className = `${CSS_PREFIX}__code-container`;
    codeContainer.style.maxHeight = `${resolved.maxHeight}px`;
    codeContainer.style.overflow = 'auto';

    const pre = doc.createElement('pre');
    pre.className = `${CSS_PREFIX}__pre`;
    if (wrapEnabled) {
      pre.classList.add(`${CSS_PREFIX}__pre--wrapped`);
    }

    const codeEl = doc.createElement('code');
    codeEl.className = `${CSS_PREFIX}__code`;
    if (block.content.language) {
      codeEl.dataset.language = block.content.language;
    }

    pre.appendChild(codeEl);
    codeContainer.appendChild(pre);
    root.appendChild(codeContainer);

    // ─── Rendering helpers ──────────────────────────────────────

    function shouldShowLineNumbers(): boolean {
      return Boolean(
        currentOptions.showLineNumbers || currentBlock.content.showLineNumbers,
      );
    }

    function appendLineWrapper(
      lineIndex: number,
      populate: (lineContent: HTMLElement) => void,
    ): void {
      const lineEl = doc.createElement('span');
      lineEl.className = `${CSS_PREFIX}__line`;

      if (shouldShowLineNumbers()) {
        const lineNum = doc.createElement('span');
        lineNum.className = `${CSS_PREFIX}__line-number`;
        lineNum.setAttribute('aria-hidden', 'true');
        lineNum.textContent = String(lineIndex + 1);
        lineEl.appendChild(lineNum);
      }

      const lineContent = doc.createElement('span');
      lineContent.className = `${CSS_PREFIX}__line-content`;
      populate(lineContent);
      lineEl.appendChild(lineContent);
      codeEl.appendChild(lineEl);
    }

    function renderPlainText(): void {
      const code = currentBlock.content.code;
      const lines = code.split('\n');
      codeEl.textContent = '';

      for (let i = 0; i < lines.length; i++) {
        appendLineWrapper(i, (lineContent) => {
          lineContent.textContent = lines[i] ?? '';
        });
      }

      highlighted = false;
      root.dataset.highlighted = 'false';
    }

    function renderHighlighted(): void {
      const code = currentBlock.content.code;
      const language = currentBlock.content.language;

      // Enforce the allowlist gate at render time. The highlighter is
      // the single authority on which languages may be highlighted; the
      // surface must not attempt to bypass it.
      if (!highlighter.isKnownLanguage(language)) {
        renderPlainText();
        return;
      }

      const result = highlighter.highlight({ code, language });
      if (result.language === null) {
        // Highlighter refused (registration was rolled back or the
        // grammar failed at parse time). Fall back to escaped plain
        // text — exactly what the highlighter returned in `html`.
        renderPlainText();
        return;
      }

      codeEl.textContent = '';
      const perLine = splitHighlightedIntoLines(result.html);
      for (let i = 0; i < perLine.length; i++) {
        appendLineWrapper(i, (lineContent) => {
          // Highlight.js output is deterministically escaped safeHtml
          // — the allowlist-only highlighter escapes every source
          // character and only emits `<span class="hljs-…">…</span>`
          // tags produced by the pinned library. Parsing through an
          // inert `<template>` restores entity decoding without ever
          // touching a live DOM node.
          const safeHtml = perLine[i] ?? '';
          const template = doc.createElement('template');
          template.innerHTML = safeHtml;
          if (template.content.firstChild) {
            lineContent.appendChild(template.content.cloneNode(true));
          } else {
            lineContent.appendChild(doc.createTextNode('\u00A0'));
          }
        });
      }

      highlighted = true;
      root.dataset.highlighted = 'true';
    }

    function scheduleHighlighting(): void {
      cancelHighlighting();
      cancelObservation();

      const code = currentBlock.content.code;
      const language = currentBlock.content.language;
      const isStreaming = !currentBlock.content.finalized;

      // Cancellation check — a newer revision may have aborted this
      // signal between construction and here. Aborted signals abandon
      // all lazy work; the caller will replace this surface (or call
      // update() with a fresh signal) before we ever render again.
      const signal = currentOptions.signal;
      if (signal?.aborted === true) return;

      // During streaming, always render plain text. Highlighting a
      // partial code fragment produces misleading token classes.
      if (isStreaming) {
        renderPlainText();
        return;
      }

      // Unknown/missing language — no highlighter grammar can produce
      // a meaningful result. Render escaped plain text and stop.
      if (!highlighter.isKnownLanguage(language)) {
        renderPlainText();
        return;
      }

      // Finalized + known language. Render plain text immediately so
      // the reader sees content while highlighting is gated on
      // visibility. Highlighting replaces this DOM once it fires.
      renderPlainText();

      const IntersectionObserverCtorLocal = getIntersectionObserverCtor(doc);
      if (IntersectionObserverCtorLocal) {
        observer = new IntersectionObserverCtorLocal(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                if (!disposed && !isSignalAborted()) renderHighlighted();
                cancelObservation();
                break;
              }
            }
          },
          { rootMargin: HIGHLIGHT_ROOT_MARGIN },
        );
        observer.observe(root);
        // Wire signal-driven cancellation. When the caller aborts (e.g.
        // a newer projection revision has taken over) we tear down the
        // observer so the stale grammar work never runs.
        if (signal !== undefined) {
          const onAbort = (): void => {
            cancelObservation();
            cancelHighlighting();
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
        return;
      }

      // No IntersectionObserver — fall back to the pre-task-10.4
      // behaviour: highlight small blocks synchronously and defer
      // large blocks via `setTimeout`. This keeps the surface useful
      // in Node/jsdom environments where the observer API is absent.
      if (code.length < DEFERRED_HIGHLIGHT_THRESHOLD || currentOptions.highlightDeferMs === 0) {
        if (!isSignalAborted()) renderHighlighted();
        return;
      }
      highlightTimerId = setTimeout(() => {
        if (!disposed && !isSignalAborted()) renderHighlighted();
        highlightTimerId = null;
      }, currentOptions.highlightDeferMs);
      if (signal !== undefined) {
        const onAbort = (): void => {
          cancelHighlighting();
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    }

    function isSignalAborted(): boolean {
      return currentOptions.signal?.aborted === true;
    }

    function cancelHighlighting(): void {
      if (highlightTimerId !== null) {
        clearTimeout(highlightTimerId);
        highlightTimerId = null;
      }
    }

    function cancelObservation(): void {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
    }

    function updateStatus(): void {
      const isStreaming = !currentBlock.content.finalized;
      root.dataset.status = currentBlock.status;
      root.dataset.finalized = String(currentBlock.content.finalized);
      root.dataset.streaming = String(isStreaming);

      if (isStreaming) {
        root.classList.add(`${CSS_PREFIX}--streaming`);
      } else {
        root.classList.remove(`${CSS_PREFIX}--streaming`);
      }
    }

    function getRedactedCode(): string {
      return redactPrivatePaths(currentBlock.content.code);
    }

    // ─── Actions ────────────────────────────────────────────────

    /**
     * Visible transient state on the copy button. Distinct from the
     * live-region announcement so sighted users see the acknowledgment
     * even when no live region is mounted, and screen-reader users hear
     * it even when they cannot see the button. The button retains focus
     * either way — clicking a native `<button>` in DOM does not shift
     * focus by itself, and this handler never blurs it.
     *
     * Requirements 14.4, 14.5.
     */
    const COPY_BUTTON_LABELS = Object.freeze({
      idle: 'Copy',
      success: 'Copied!',
      failure: 'Copy failed',
    });
    const COPY_ARIA_LABELS = Object.freeze({
      idle: 'Copy code to clipboard',
      success: 'Code copied to clipboard',
      failure: 'Copy failed. Try again.',
    });
    let copyResetTimerId: ReturnType<typeof setTimeout> | null = null;

    function setCopyButtonState(state: 'idle' | 'success' | 'failure'): void {
      if (copyResetTimerId !== null) {
        clearTimeout(copyResetTimerId);
        copyResetTimerId = null;
      }
      copyBtn.textContent = COPY_BUTTON_LABELS[state];
      copyBtn.setAttribute('aria-label', COPY_ARIA_LABELS[state]);
      copyBtn.classList.remove(
        `${CSS_PREFIX}__copy-btn--success`,
        `${CSS_PREFIX}__copy-btn--failure`,
      );
      if (state === 'success') {
        copyBtn.classList.add(`${CSS_PREFIX}__copy-btn--success`);
        copyBtn.dataset.copyState = 'success';
      } else if (state === 'failure') {
        copyBtn.classList.add(`${CSS_PREFIX}__copy-btn--failure`);
        copyBtn.dataset.copyState = 'failure';
      } else {
        delete copyBtn.dataset.copyState;
      }
      if (state !== 'idle') {
        copyResetTimerId = setTimeout(() => {
          if (!disposed) setCopyButtonState('idle');
          copyResetTimerId = null;
        }, 2000);
      }
    }

    async function handleCopy(): Promise<CodeActionResult> {
      // The clipboard payload is the exact-source `content.code` retained
      // in the descriptor, run through the shared private-path redactor
      // so `/Users/…`-style absolute paths do not leak. The redactor does
      // not mutate the source string on the descriptor — it produces a
      // new string for the clipboard channel only.
      //
      // Task 10.5: routes through the shared helper so success and
      // failure both announce on the live-region channel supplied by the
      // caller. `writeText(redactedCode)` still fires — inside the
      // helper — but the surface never falls back to
      // `document.execCommand`. Requirement 10.9, 10.10, 14.4–14.6.
      const redactedCode = getRedactedCode();
      const result = await copyExactSourceToClipboard({
        exactSource: redactedCode,
        feedback: currentOptions.feedbackSurface ?? silentFeedback,
        surfaceKind: 'code',
        ...(currentOptions.clipboard !== undefined
          ? { clipboard: currentOptions.clipboard }
          : {}),
      });
      if (result.success) {
        setCopyButtonState('success');
        return { success: true };
      }
      setCopyButtonState('failure');
      return { success: false, failureReason: result.failureReason };
    }

    function handleWrapToggle(): Promise<CodeActionResult> {
      wrapEnabled = !wrapEnabled;
      if (wrapEnabled) {
        pre.classList.add(`${CSS_PREFIX}__pre--wrapped`);
      } else {
        pre.classList.remove(`${CSS_PREFIX}__pre--wrapped`);
      }
      wrapBtn.setAttribute('aria-pressed', String(wrapEnabled));
      wrapBtn.setAttribute('aria-label', wrapEnabled ? 'Disable word wrap' : 'Enable word wrap');
      return Promise.resolve({ success: true });
    }

    async function handleOpenFile(): Promise<CodeActionResult> {
      if (!resolved.onOpenFile || !currentBlock.content.displayLabel) {
        return { success: false, failureReason: 'open_file_unavailable' };
      }
      try {
        return await resolved.onOpenFile({
          artifactId: currentBlock.content.artifactId,
          filePath: currentBlock.content.displayLabel,
        });
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    async function handleOpenRange(): Promise<CodeActionResult> {
      if (!resolved.onOpenRange || !currentBlock.content.displayLabel) {
        return { success: false, failureReason: 'open_range_unavailable' };
      }
      try {
        return await resolved.onOpenRange({
          artifactId: currentBlock.content.artifactId,
          filePath: currentBlock.content.displayLabel,
          startLine: 1,
          endLine: currentBlock.content.code.split('\n').length,
        });
      } catch {
        return { success: false, failureReason: 'authority_error' };
      }
    }

    // Wire event listeners
    copyBtn.addEventListener('click', () => { handleCopy(); });
    wrapBtn.addEventListener('click', () => { handleWrapToggle(); });
    if (openFileBtn && resolved.onOpenFile) {
      openFileBtn.addEventListener('click', () => { handleOpenFile(); });
    }

    // ─── Build actions list ─────────────────────────────────────

    function buildActions(): CodeSurfaceAction[] {
      const actions: CodeSurfaceAction[] = [
        {
          kind: 'copy',
          label: 'Copy code',
          disabled: false,
          execute: handleCopy,
        },
        {
          kind: 'wrap_toggle',
          label: wrapEnabled ? 'Disable word wrap' : 'Enable word wrap',
          disabled: false,
          execute: handleWrapToggle,
        },
      ];

      if (resolved.onOpenFile && currentBlock.content.displayLabel) {
        actions.push({
          kind: 'open_file',
          label: `Open ${redactPrivatePaths(currentBlock.content.displayLabel)}`,
          disabled: false,
          execute: handleOpenFile,
        });
      }

      if (resolved.onOpenRange && currentBlock.content.displayLabel) {
        actions.push({
          kind: 'open_range',
          label: `Open at range`,
          disabled: false,
          execute: handleOpenRange,
        });
      }

      return actions;
    }

    // ─── Initial render ─────────────────────────────────────────

    updateStatus();
    scheduleHighlighting();

    // ─── Handle ─────────────────────────────────────────────────

    const handle: CodeSurfaceHandle = {
      get element() { return root; },
      get stableKey() { return currentBlock.stableKey; },
      get semanticAnchor() { return currentBlock.semanticAnchor; },
      get isHighlighted() { return highlighted; },
      get isStreaming() { return !currentBlock.content.finalized; },
      get actions() { return buildActions(); },

      update(nextBlock: CodeBlockV1, nextOptions?: Partial<CodeSurfaceOptions>): void {
        if (disposed) return;

        const prevCode = currentBlock.content.code;
        const prevFinalized = currentBlock.content.finalized;
        const prevLanguage = currentBlock.content.language;
        const prevShowLineNumbers = currentBlock.content.showLineNumbers;

        currentBlock = nextBlock;
        if (nextOptions) {
          currentOptions = { ...currentOptions, ...nextOptions };
        }

        // Update language badge if changed
        langBadge.textContent = getLanguageDisplayName(nextBlock.content.language);
        root.setAttribute(
          'aria-label',
          `Code: ${getLanguageDisplayName(nextBlock.content.language)}`,
        );

        // Update max height if changed
        if (nextOptions?.maxHeight !== undefined) {
          codeContainer.style.maxHeight = `${nextOptions.maxHeight}px`;
        }

        // Update wrap setting
        if (nextOptions?.wrapEnabled !== undefined) {
          wrapEnabled = nextOptions.wrapEnabled;
          if (wrapEnabled) {
            pre.classList.add(`${CSS_PREFIX}__pre--wrapped`);
          } else {
            pre.classList.remove(`${CSS_PREFIX}__pre--wrapped`);
          }
          wrapBtn.setAttribute('aria-pressed', String(wrapEnabled));
          wrapBtn.setAttribute('aria-label', wrapEnabled ? 'Disable word wrap' : 'Enable word wrap');
        }

        updateStatus();

        // Re-render code if content, finalization, language, or
        // line-number preference changed. Any of these can affect the
        // rendered DOM and needs to flow through the same
        // scheduling gate as the initial render.
        const showLineNumbersChanged =
          nextOptions?.showLineNumbers !== undefined ||
          nextBlock.content.showLineNumbers !== prevShowLineNumbers;
        if (
          prevCode !== nextBlock.content.code ||
          prevFinalized !== nextBlock.content.finalized ||
          prevLanguage !== nextBlock.content.language ||
          showLineNumbersChanged
        ) {
          scheduleHighlighting();
        }
      },

      dispose(): void {
        if (disposed) return;
        disposed = true;
        cancelHighlighting();
        cancelObservation();
        codeToolbarNav.dispose();
        if (copyResetTimerId !== null) {
          clearTimeout(copyResetTimerId);
          copyResetTimerId = null;
        }
        root.remove();
      },
    };

    return handle;
  }
}
