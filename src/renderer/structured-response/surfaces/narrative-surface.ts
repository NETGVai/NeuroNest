/**
 * NarrativeSurface — Canonical Markdown and streamed plain-text rendering.
 *
 * Renders `NarrativeBlockV1` content as accessible, sanitized DOM with:
 * - Headings, paragraphs, emphasis, lists, blockquotes, links, tables, inline
 *   code, and fenced code blocks — all produced by the canonical Markdown
 *   pipeline in `markdown-pipeline.ts` (task 10.3).
 * - Streamed plain text preserved as `textContent` until content finalizes.
 * - Settings-eligible expand/collapse with retained disclosure choice.
 * - Message-level copy action reading the block descriptor's raw text
 *   (never reconstructed from the rendered DOM).
 * - External-link activation routed through an authorized callback.
 *   The canonical pipeline emits anchors with `href`, `title`, and
 *   `rel="noopener noreferrer"` — no `target` attribute. This surface
 *   uses click delegation to route those anchors through
 *   `onExternalNavigation` when supplied by the caller.
 * - No embedded HTML, scripts, event handlers, remote image fetches, or
 *   executable Markdown extensions.
 *
 * Requirements: 5.1–5.10, 10.2, 10.7, 10.8, 15.1, 15.2, 20.1–20.2, 20.4–20.5
 */

import type { NarrativeBlockV1 } from '../../../harness/contracts/response-composition';
import {
  copyExactSourceToClipboard,
  type ClipboardAdapter,
  type ClipboardCopyFeedback,
} from '../clipboard-copy';
import {
  createMarkdownPipeline,
  type MarkdownPipeline,
  type MarkdownPipelineWarning,
} from '../markdown-pipeline';
import { attachToolbarArrowKeyNavigation } from '../semantic-accessibility';

// ─── Safe Protocol Allowlist ──────────────────────────────────────────────────

/**
 * Callback safety gate. The canonical Markdown pipeline already runs the
 * sanitizer's URL allowlist, and `markdown-it`'s own `validateLink` rejects
 * `javascript:`/`vbscript:`/`file:`/dangerous `data:` schemes before a link
 * token is ever created. This function is a belt-and-braces final check
 * before the surface hands a URL to the external-navigation callback —
 * defense-in-depth if a future customization loosens the pipeline defaults.
 */
const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

function isSafeProtocol(href: string): boolean {
  try {
    const url = new URL(href, 'https://placeholder.invalid');
    return SAFE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

// ─── Surface Handle ───────────────────────────────────────────────────────────

export interface NarrativeSurfaceOptions {
  /** Characters before collapse is eligible. From SettingsBoundsService. */
  readonly collapseThreshold: number;
  /** Callback for authorized external navigation. */
  readonly onExternalNavigation?: (href: string) => void;
  /** Owner document for element creation. */
  readonly ownerDocument?: Document;
  /**
   * Accessible live-region feedback channel for message copy outcomes
   * (task 10.5). When supplied, copy success announces on the polite
   * `role="status"` region and copy failure announces on the assertive
   * `role="alert"` region — the same channel the response-group router
   * uses. When omitted, copy actions still succeed silently for
   * standalone fixtures, but production surfaces should always pass the
   * response-group live-region pair so keyboard and screen-reader users
   * get uniform feedback.
   */
  readonly feedbackSurface?: ClipboardCopyFeedback;
  /**
   * Clipboard adapter override (task 10.5). Defaults to the async
   * `navigator.clipboard` API. Never falls back to the legacy
   * synchronous copy API. Tests inject a stub.
   */
  readonly clipboard?: ClipboardAdapter | null;
}

export interface NarrativeSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly isExpanded: boolean;
  readonly actions: readonly NarrativeSurfaceAction[];
  /**
   * Warnings from the last render pass. Empty when the pipeline succeeded
   * or when the block was in `plain_stream` format (streaming skips the
   * pipeline). Populated when the sanitizer rejected the parsed HTML and
   * fell back to redacted plain text.
   */
  readonly warnings: readonly MarkdownPipelineWarning[];
  update(block: NarrativeBlockV1, options?: Partial<NarrativeSurfaceOptions>): void;
  dispose(): void;
}

export type NarrativeSurfaceActionKind = 'copy' | 'expand';

export interface NarrativeSurfaceAction {
  readonly kind: NarrativeSurfaceActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly execute: () => Promise<NarrativeActionResult>;
}

export interface NarrativeActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

// ─── NarrativeSurface ─────────────────────────────────────────────────────────

const DEFAULT_COLLAPSE_THRESHOLD = 2000;

/**
 * No-op feedback channel used when the caller does not pass a
 * live-region surface. The copy helper always announces success or
 * failure through some channel; when the surface is rendered outside a
 * response-group toolbar (standalone fixtures, isolated tests) this stub
 * keeps the helper's contract honest without emitting DOM output. Real
 * usage always injects the response-group's shared live-region pair so
 * screen-reader users are told what happened.
 */
const silentFeedback: ClipboardCopyFeedback = Object.freeze({
  announceStatus(_message: string): void {
    /* no-op */
  },
  announceAlert(_message: string): void {
    /* no-op */
  },
});

export class NarrativeSurface {
  private readonly doc: Document;
  /**
   * One pipeline instance per surface factory. `markdown-it` construction
   * is measurable overhead; the parser is stateless across renders so a
   * single instance is safe to reuse.
   */
  private readonly pipeline: MarkdownPipeline;

  constructor(ownerDocument: Document = document, pipeline?: MarkdownPipeline) {
    this.doc = ownerDocument;
    this.pipeline = pipeline ?? createMarkdownPipeline();
  }

  render(block: NarrativeBlockV1, options: NarrativeSurfaceOptions): NarrativeSurfaceHandle {
    const doc = options.ownerDocument ?? this.doc;
    const collapseThreshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
    const onExternalNavigation = options.onExternalNavigation;
    const pipeline = this.pipeline;

    const root = doc.createElement('section');
    root.className = 'nn-narrative-surface';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Narrative response');
    root.dataset['stableKey'] = block.stableKey;
    root.dataset['semanticAnchor'] = block.semanticAnchor;

    const contentEl = doc.createElement('div');
    contentEl.className = 'nn-narrative-surface__content';
    root.appendChild(contentEl);

    let expanded = true;
    let currentBlock = block;
    let disposed = false;
    let lastWarnings: readonly MarkdownPipelineWarning[] = [];

    // Copy action visible state. Distinct from the announcer channel so
    // sighted users see the acknowledgment even when no live region is
    // mounted, and screen-reader users hear it via `feedback` regardless
    // of button styling. The button retains focus after click — clicking
    // a native `<button>` does not move focus, and no code path calls
    // `blur()`. Requirements 14.4, 14.5.
    let copyState: 'idle' | 'success' | 'failure' = 'idle';
    let copyResetTimerId: ReturnType<typeof setTimeout> | null = null;
    const COPY_LABELS = Object.freeze({
      idle: 'Copy message',
      success: 'Copied!',
      failure: 'Copy failed',
    });
    const COPY_ARIA_LABELS = Object.freeze({
      idle: 'Copy message to clipboard',
      success: 'Message copied to clipboard',
      failure: 'Copy failed. Try again.',
    });

    // Actions container — toolbar semantics with roving tabindex and
    // arrow-key navigation. Requirements 12.5 (response-action toolbars) and
    // 14.4 (every interactive element is keyboard operable).
    const actionsEl = doc.createElement('div');
    actionsEl.className = 'nn-narrative-surface__actions';
    actionsEl.setAttribute('role', 'toolbar');
    actionsEl.setAttribute('aria-label', 'Message actions');
    actionsEl.setAttribute('aria-orientation', 'horizontal');
    root.appendChild(actionsEl);
    // Attach arrow-key + Home/End keyboard navigation. The listener is on
    // `actionsEl` itself so it survives `replaceChildren` in updateActionsEl.
    const toolbarNav = attachToolbarArrowKeyNavigation(actionsEl, {
      orientation: 'horizontal',
    });

    // Single delegated click handler on contentEl. Handles every anchor
    // rendered by the canonical pipeline. The handler must live for the
    // lifetime of the surface — no per-anchor listeners, no rewiring on
    // update. Because the canonical pipeline does not emit `target`
    // attributes, no default browser navigation would run either way, but
    // `preventDefault` keeps behaviour predictable if a future test asserts
    // it, and it plays nicely with any Electron BrowserWindow policy.
    const handleContentClick = (ev: Event): void => {
      if (!onExternalNavigation) return;
      const target = ev.target as Node | null;
      if (!target || target.nodeType === undefined) return;
      let el: Element | null =
        target.nodeType === 1 ? (target as Element) : (target as Node).parentElement;
      while (el && el !== contentEl) {
        if (el.tagName === 'A') {
          const anchor = el as HTMLAnchorElement;
          const href = anchor.getAttribute('href');
          if (href && isSafeProtocol(href)) {
            ev.preventDefault();
            onExternalNavigation(href);
          }
          return;
        }
        el = el.parentElement;
      }
    };
    contentEl.addEventListener('click', handleContentClick);

    function isCollapseEligible(): boolean {
      return currentBlock.content.text.length > collapseThreshold;
    }

    function renderContent(): void {
      const { format, text, finalized } = currentBlock.content;

      if (format === 'plain_stream' || !finalized) {
        // Streamed plain text: preserve as textContent. No Markdown parsing,
        // no HTML interpretation, no side effects. The canonical pipeline
        // runs only after finalization so streaming payloads never risk
        // fenced-block "half-open" states or partial link tokens producing
        // surprising DOM.
        contentEl.replaceChildren();
        contentEl.textContent = text;
        contentEl.classList.add('nn-narrative-surface__content--streaming');
        contentEl.classList.remove('nn-narrative-surface__content--markdown');
        lastWarnings = [];
      } else {
        // Canonical Markdown pipeline: markdown-it (raw HTML disabled) →
        // custom fence/link/image renderers → sanitizeHtmlToInertFragment.
        // The returned fragment is inert; contentEl.replaceChildren() adopts
        // it into the live tree without invoking `innerHTML`.
        const { fragment, warnings } = pipeline.renderToInertFragment(text, {
          ownerDocument: doc,
        });
        contentEl.replaceChildren(fragment);
        contentEl.classList.remove('nn-narrative-surface__content--streaming');
        contentEl.classList.add('nn-narrative-surface__content--markdown');
        lastWarnings = warnings;
      }

      // Collapse handling
      if (isCollapseEligible() && !expanded) {
        contentEl.classList.add('nn-narrative-surface__content--collapsed');
        contentEl.setAttribute('aria-hidden', 'false');
      } else {
        contentEl.classList.remove('nn-narrative-surface__content--collapsed');
      }

      root.dataset['status'] = currentBlock.status;
      root.dataset['finalized'] = String(currentBlock.content.finalized);
    }

    function setCopyState(state: 'idle' | 'success' | 'failure'): void {
      if (copyResetTimerId !== null) {
        clearTimeout(copyResetTimerId);
        copyResetTimerId = null;
      }
      copyState = state;
      // The visible action button is rebuilt each render pass; refresh it
      // so the transient label appears immediately. Rebuilding preserves
      // the button element identity via `replaceChildren` semantics is
      // not guaranteed here — the surface repaints the actions row from
      // scratch — so we also stash the state on `root.dataset` for tests
      // that inspect the surface between rebuilds.
      root.dataset['copyState'] = state;
      updateActionsEl();
      // Return focus to the copy button so keyboard users can retry
      // without re-navigating.
      const copyBtn = actionsEl.querySelector<HTMLButtonElement>(
        '.nn-narrative-surface__action--copy',
      );
      if (copyBtn && state !== 'idle') {
        copyBtn.focus();
      }
      if (state !== 'idle') {
        copyResetTimerId = setTimeout(() => {
          if (!disposed) setCopyState('idle');
          copyResetTimerId = null;
        }, 2000);
      }
    }

    async function executeCopy(): Promise<NarrativeActionResult> {
      // The clipboard payload is the exact-source `content.text` retained
      // in the descriptor. The shared helper enforces the
      // `navigator.clipboard.writeText` only contract (task 10.10: no
      // silent execCommand fallback) and announces success/failure on
      // the caller-supplied live region.
      const result = await copyExactSourceToClipboard({
        exactSource: currentBlock.content.text,
        feedback: options.feedbackSurface ?? silentFeedback,
        surfaceKind: 'narrative',
        ...(options.clipboard !== undefined ? { clipboard: options.clipboard } : {}),
      });
      if (result.success) {
        setCopyState('success');
        return { success: true };
      }
      setCopyState('failure');
      return {
        success: false,
        failureReason: result.failureReason,
      };
    }

    function buildActions(): NarrativeSurfaceAction[] {
      const actions: NarrativeSurfaceAction[] = [];

      // Copy action — the executor calls the shared exact-source helper,
      // which internally passes `currentBlock.content.text` (the
      // canonical descriptor field) to `navigator.clipboard.writeText`.
      // Task 10.9 forbids DOM-text/highlighted-HTML reconstruction; task
      // 10.10 forbids the silent `execCommand` fallback. The
      // audit-unsafe-behavior regression asserts either
      // `writeText(currentBlock.content.text)` or
      // `exactSource: currentBlock.content.text` remains present.
      actions.push({
        kind: 'copy',
        label: COPY_LABELS[copyState],
        disabled: false,
        execute: executeCopy,
      });

      // Expand/collapse action (only when eligible)
      if (isCollapseEligible()) {
        actions.push({
          kind: 'expand',
          label: expanded ? 'Collapse' : 'Expand',
          disabled: false,
          execute: async (): Promise<NarrativeActionResult> => {
            expanded = !expanded;
            renderContent();
            updateActionsEl();
            return { success: true };
          },
        });
      }

      return actions;
    }

    function updateActionsEl(): void {
      actionsEl.replaceChildren();
      const currentActions = buildActions();

      // Roving tabindex: only the first non-disabled action button holds
      // tabindex="0"; the others are focusable via arrow keys. Requirement
      // 12.5 (toolbar) and 14.4 (keyboard operability).
      let firstFocusableSet = false;
      for (const action of currentActions) {
        const btn = doc.createElement('button');
        btn.className = `nn-narrative-surface__action nn-narrative-surface__action--${action.kind}`;
        btn.textContent = action.label;
        btn.type = 'button';
        btn.disabled = action.disabled;
        btn.setAttribute(
          'aria-label',
          action.kind === 'copy' ? COPY_ARIA_LABELS[copyState] : action.label,
        );
        if (action.kind === 'copy' && copyState !== 'idle') {
          btn.classList.add(`nn-narrative-surface__action--copy-${copyState}`);
          btn.dataset['copyState'] = copyState;
        }
        if (action.kind === 'expand') {
          btn.setAttribute('aria-expanded', String(expanded));
          btn.setAttribute('aria-controls', 'nn-narrative-content');
        }
        if (!action.disabled && !firstFocusableSet) {
          btn.setAttribute('tabindex', '0');
          firstFocusableSet = true;
        } else {
          btn.setAttribute('tabindex', '-1');
        }
        btn.addEventListener('click', () => {
          void action.execute();
        });
        actionsEl.appendChild(btn);
      }
    }

    renderContent();
    updateActionsEl();

    const handle: NarrativeSurfaceHandle = {
      get element() {
        return root;
      },
      get stableKey() {
        return currentBlock.stableKey;
      },
      get semanticAnchor() {
        return currentBlock.semanticAnchor;
      },
      get isExpanded() {
        return expanded;
      },
      get actions() {
        return buildActions();
      },
      get warnings() {
        return lastWarnings;
      },
      update(nextBlock: NarrativeBlockV1, nextOptions?: Partial<NarrativeSurfaceOptions>): void {
        if (disposed) return;
        currentBlock = nextBlock;
        root.dataset['stableKey'] = nextBlock.stableKey;
        root.dataset['semanticAnchor'] = nextBlock.semanticAnchor;
        if (nextOptions?.collapseThreshold !== undefined) {
          // Options.collapseThreshold can be updated dynamically
          Object.defineProperty(options, 'collapseThreshold', {
            value: nextOptions.collapseThreshold,
            writable: false,
            configurable: true,
          });
        }
        renderContent();
        updateActionsEl();
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        contentEl.removeEventListener('click', handleContentClick);
        toolbarNav.dispose();
        if (copyResetTimerId !== null) {
          clearTimeout(copyResetTimerId);
          copyResetTimerId = null;
        }
        root.remove();
        root.replaceChildren();
      },
    };

    return handle;
  }
}

// ─── Exported Helpers ─────────────────────────────────────────────────────────

/**
 * Exported for tests and callers that need the same URL policy the surface
 * applies to its delegated click handler. See {@link isSafeProtocol}.
 */
export { isSafeProtocol };
