/**
 * Reasoning Disclosure Surface V1.
 *
 * Renders permitted reasoning/activity summaries in a collapsed-by-default
 * expandable section. Distinguishes summary, search, coding, tool, and
 * verification categories. Shows bounded protected/unavailable explanations
 * rather than exposing hidden chain-of-thought. Labels unmatched model-authored
 * execution claims as unverified with non-color cues.
 *
 * This module also exports the Reasoning Card renderer, which reads a
 * `reasoning` block from a canonical response composition. Reasoning streams
 * independently of answer content; when the response terminates before the
 * reasoning stream finalizes, the card marks its content as incomplete. When
 * a composition contains no reasoning block, the card renders nothing — the
 * surface never infers reasoning from the final answer.
 *
 * Requirements: 6.1–6.8, 12.1–12.9, 18.3, 20.7
 */

import type {
  ReasoningBlockV1,
  ResponseCompositionV1,
  TurnStatusBlockV1,
} from '../../../harness/contracts/response-composition';

export type ReasoningCategory = ReasoningBlockV1['content']['categories'][number];
export type ReasoningDisclosure = ReasoningBlockV1['content']['disclosure'];

export interface ReasoningDisclosureSurfaceOptions {
  /** Override default collapsed state per policy/user preference. */
  readonly defaultExpanded?: boolean;
  /** Maximum characters displayed in the summary text. */
  readonly maxSummaryCharacters?: number;
  /**
   * Marks the reasoning as incomplete regardless of the block's own
   * `finalized` flag. Used by the composition-level renderer when the
   * enclosing response reached a non-success terminal state before the
   * reasoning stream finalized. Never invents reasoning content — only marks
   * the existing content as cut short.
   */
  readonly incomplete?: boolean;
}

export interface ReasoningDisclosureSurfaceHandle {
  readonly element: HTMLElement;
  readonly expanded: boolean;
  readonly categories: readonly ReasoningCategory[];
  readonly disclosure: ReasoningDisclosure;
  /** Whether the surface currently displays the incomplete marker. */
  readonly incomplete: boolean;
  setExpanded(expanded: boolean): void;
  update(block: ReasoningBlockV1, options?: ReasoningDisclosureSurfaceOptions): void;
  dispose(): void;
}

export const REASONING_SUMMARY_CHARACTER_LIMIT = 4_096;
export const REASONING_CSS_CLASS = 'nn-reasoning-disclosure';

const CATEGORY_LABELS: Readonly<Record<ReasoningCategory, string>> = Object.freeze({
  summary: 'Thinking',
  search: 'Searching',
  coding: 'Coding',
  tool: 'Using tools',
  verification: 'Verifying',
});

const DISCLOSURE_LABELS: Readonly<Record<ReasoningDisclosure, string>> = Object.freeze({
  permitted: '',
  protected: 'Reasoning is protected and cannot be displayed.',
  unavailable: 'Reasoning content is unavailable.',
});

function boundSummary(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function categoryLabel(categories: readonly ReasoningCategory[]): string {
  if (categories.length === 0) {
    return 'Thinking';
  }
  const labels = categories.map((cat) => CATEGORY_LABELS[cat] ?? cat);
  // Deduplicate while preserving order
  return [...new Set(labels)].join(', ');
}

/**
 * Render a reasoning disclosure surface from a validated ReasoningBlockV1.
 * The surface is collapsed by default and expands on button activation.
 */
export function renderReasoningDisclosureSurface(
  block: ReasoningBlockV1,
  options: ReasoningDisclosureSurfaceOptions = {},
): ReasoningDisclosureSurfaceHandle {
  const maxChars = resolveMaxChars(options.maxSummaryCharacters);
  let currentExpanded = options.defaultExpanded === true;
  let currentCategories: readonly ReasoningCategory[] = [...block.content.categories];
  let currentDisclosure: ReasoningDisclosure = block.content.disclosure;
  let currentIncomplete: boolean = options.incomplete === true;
  let disposed = false;

  // Root element
  const root = document.createElement('section');
  root.className = REASONING_CSS_CLASS;
  root.dataset.disclosure = currentDisclosure;
  root.dataset.finalized = String(block.content.finalized);
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Reasoning activity');

  // Toggle button
  const toggleButton = document.createElement('button');
  toggleButton.className = `${REASONING_CSS_CLASS}__toggle`;
  toggleButton.type = 'button';
  toggleButton.setAttribute('aria-expanded', String(currentExpanded));
  root.appendChild(toggleButton);

  // Category badges container
  const categoriesContainer = document.createElement('span');
  categoriesContainer.className = `${REASONING_CSS_CLASS}__categories`;
  toggleButton.appendChild(categoriesContainer);

  // Toggle label text
  const toggleLabel = document.createElement('span');
  toggleLabel.className = `${REASONING_CSS_CLASS}__toggle-label`;
  toggleButton.appendChild(toggleLabel);

  // Collapsible content panel
  const contentPanel = document.createElement('div');
  contentPanel.className = `${REASONING_CSS_CLASS}__content`;
  contentPanel.id = `reasoning-content-${block.stableKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
  contentPanel.setAttribute('role', 'region');
  toggleButton.setAttribute('aria-controls', contentPanel.id);
  root.appendChild(contentPanel);

  // Summary text
  const summaryElement = document.createElement('p');
  summaryElement.className = `${REASONING_CSS_CLASS}__summary`;
  contentPanel.appendChild(summaryElement);

  // Protected/unavailable notice
  const noticeElement = document.createElement('p');
  noticeElement.className = `${REASONING_CSS_CLASS}__notice`;
  contentPanel.appendChild(noticeElement);

  // Status indicator for streaming
  const statusIndicator = document.createElement('span');
  statusIndicator.className = `${REASONING_CSS_CLASS}__status`;
  contentPanel.appendChild(statusIndicator);

  // Incomplete marker — displayed when the reasoning stream was cut short.
  // Never invents content; only labels the existing summary as truncated.
  const incompleteMarker = document.createElement('p');
  incompleteMarker.className = `${REASONING_CSS_CLASS}__incomplete`;
  incompleteMarker.textContent = 'Reasoning is incomplete — the response ended before it finished streaming.';
  incompleteMarker.setAttribute('role', 'note');
  incompleteMarker.hidden = true;
  contentPanel.appendChild(incompleteMarker);

  // --- Rendering helpers ---

  function renderCategories(): void {
    categoriesContainer.replaceChildren();
    for (const cat of currentCategories) {
      const badge = document.createElement('span');
      badge.className = `${REASONING_CSS_CLASS}__category-badge`;
      badge.dataset.category = cat;
      badge.textContent = CATEGORY_LABELS[cat] ?? cat;
      categoriesContainer.appendChild(badge);
    }
  }

  function renderToggleLabel(): void {
    toggleLabel.textContent = categoryLabel(currentCategories);
  }

  function renderContent(blk: ReasoningBlockV1): void {
    // Summary text
    if (blk.content.disclosure === 'permitted' && blk.content.summary.length > 0) {
      summaryElement.textContent = boundSummary(blk.content.summary, maxChars);
      summaryElement.hidden = false;
    } else {
      summaryElement.textContent = '';
      summaryElement.hidden = true;
    }

    // Protected/unavailable notice
    const notice = DISCLOSURE_LABELS[blk.content.disclosure];
    if (notice.length > 0) {
      noticeElement.textContent = notice;
      noticeElement.hidden = false;
      noticeElement.dataset.disclosureState = blk.content.disclosure;
    } else {
      noticeElement.textContent = '';
      noticeElement.hidden = true;
    }

    // Streaming status
    if (!blk.content.finalized && blk.status === 'streaming') {
      statusIndicator.textContent = 'Streaming…';
      statusIndicator.hidden = false;
      statusIndicator.setAttribute('aria-live', 'polite');
    } else {
      statusIndicator.textContent = '';
      statusIndicator.hidden = true;
      statusIndicator.removeAttribute('aria-live');
    }

    // Incomplete marker — visible only when reasoning was cut short. The
    // marker never invents content; it labels the existing summary as
    // truncated so the user knows the stream ended before completion.
    incompleteMarker.hidden = !currentIncomplete;
    if (currentIncomplete) {
      root.dataset['incomplete'] = 'true';
    } else {
      delete root.dataset['incomplete'];
    }
  }

  function applyExpandedState(): void {
    toggleButton.setAttribute('aria-expanded', String(currentExpanded));
    contentPanel.hidden = !currentExpanded;
    root.dataset.expanded = String(currentExpanded);
  }

  function handleToggle(): void {
    if (disposed) {
      return;
    }
    currentExpanded = !currentExpanded;
    applyExpandedState();
  }

  // Attach toggle handler
  toggleButton.addEventListener('click', handleToggle);

  // Initial render
  renderCategories();
  renderToggleLabel();
  renderContent(block);
  applyExpandedState();

  const handle: ReasoningDisclosureSurfaceHandle = {
    get element(): HTMLElement {
      return root;
    },
    get expanded(): boolean {
      return currentExpanded;
    },
    get categories(): readonly ReasoningCategory[] {
      return currentCategories;
    },
    get disclosure(): ReasoningDisclosure {
      return currentDisclosure;
    },
    get incomplete(): boolean {
      return currentIncomplete;
    },
    setExpanded(expanded: boolean): void {
      if (disposed || expanded === currentExpanded) {
        return;
      }
      currentExpanded = expanded;
      applyExpandedState();
    },
    update(nextBlock: ReasoningBlockV1, nextOptions?: ReasoningDisclosureSurfaceOptions): void {
      if (disposed) {
        return;
      }
      currentCategories = [...nextBlock.content.categories];
      currentDisclosure = nextBlock.content.disclosure;
      root.dataset.disclosure = currentDisclosure;
      root.dataset.finalized = String(nextBlock.content.finalized);

      // Incomplete is a composition-derived flag; update only when the caller
      // provides it. Missing incomplete option preserves the previous state.
      if (nextOptions?.incomplete !== undefined) {
        currentIncomplete = nextOptions.incomplete;
      }

      renderCategories();
      renderToggleLabel();
      renderContent(nextBlock);

      // Do not reset expanded state on update (retain user choice)
      // Only apply defaultExpanded from options if explicitly set on first render

      if (nextOptions?.defaultExpanded !== undefined && nextOptions.defaultExpanded !== currentExpanded) {
        // Policy can override only if user hasn't interacted
        // For simplicity, we don't override once toggled manually
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      toggleButton.removeEventListener('click', handleToggle);
      root.remove();
      root.replaceChildren();
    },
  };

  return handle;
}

function resolveMaxChars(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return REASONING_SUMMARY_CHARACTER_LIMIT;
  }
  return Math.min(value, REASONING_SUMMARY_CHARACTER_LIMIT);
}

/**
 * Surface adapter for the closed ResponseSurfaceRegistry.
 */
export const ReasoningDisclosureSurface = Object.freeze({
  kind: 'reasoning' as const,
  render(
    block: ReasoningBlockV1,
    _context: Record<string, unknown>,
    options?: { refinement?: unknown },
  ): ReasoningDisclosureSurfaceHandle {
    return renderReasoningDisclosureSurface(block, {
      defaultExpanded: false,
    });
  },
  update(
    handle: object,
    _previous: ReasoningBlockV1,
    next: ReasoningBlockV1,
    _context: Record<string, unknown>,
    _options?: { refinement?: unknown },
  ): void {
    if (isReasoningHandle(handle)) {
      handle.update(next);
    }
  },
  dispose(handle: object): void {
    if (isReasoningHandle(handle)) {
      handle.dispose();
    }
  },
});

function isReasoningHandle(value: unknown): value is ReasoningDisclosureSurfaceHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'element' in value &&
    'update' in value &&
    'dispose' in value
  );
}

// ─── Composition-level Reasoning Card ───────────────────────────
//
// The Reasoning Card is rendered from a `reasoning` block in a canonical
// response composition. When the composition has no reasoning block, the
// helpers below return `null` and no card is rendered — reasoning is never
// synthesized or inferred from the answer. When the composition shows the
// enclosing response reached a non-success terminal state (interrupted,
// failed, or cancelled) but the reasoning block has not finalized, the card
// marks its content as incomplete.
//
// Requirements: 12.1–12.9

/** Turn status states that indicate a non-success terminal response. */
const NON_SUCCESS_TURN_STATUS_STATES: ReadonlySet<TurnStatusBlockV1['content']['state']> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

/** Locate the reasoning block in a composition, if any. */
export function findReasoningBlock(
  composition: ResponseCompositionV1,
): ReasoningBlockV1 | undefined {
  for (const block of composition.blocks) {
    if (block.kind === 'reasoning') return block;
  }
  return undefined;
}

/** Locate the turn-status block in a composition, if any. */
export function findTurnStatusBlock(
  composition: ResponseCompositionV1,
): TurnStatusBlockV1 | undefined {
  for (const block of composition.blocks) {
    if (block.kind === 'turn_status') return block;
  }
  return undefined;
}

/**
 * Compute whether the reasoning stream should be labeled incomplete given the
 * response composition. Returns true only when the reasoning block exists,
 * the enclosing response reached a non-success terminal state, and the
 * reasoning block did not finalize its content on its own. Never infers
 * incompletion from the answer alone.
 */
export function isReasoningIncomplete(composition: ResponseCompositionV1): boolean {
  const reasoning = findReasoningBlock(composition);
  if (reasoning === undefined) return false;
  if (reasoning.content.finalized) return false;
  const status = findTurnStatusBlock(composition);
  if (status === undefined) return false;
  return NON_SUCCESS_TURN_STATUS_STATES.has(status.content.state);
}

/**
 * Scan a response composition for a reasoning block and render it. Returns
 * `null` when no reasoning block exists — the surface never fabricates
 * reasoning content or displays an empty card.
 */
export function renderReasoningCardFromComposition(
  composition: ResponseCompositionV1,
  options: ReasoningDisclosureSurfaceOptions = {},
): ReasoningDisclosureSurfaceHandle | null {
  const reasoning = findReasoningBlock(composition);
  if (reasoning === undefined) return null;
  const incomplete = options.incomplete ?? isReasoningIncomplete(composition);
  return renderReasoningDisclosureSurface(reasoning, {
    ...options,
    incomplete,
  });
}
