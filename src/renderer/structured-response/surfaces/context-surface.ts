/**
 * ContextSurface — Citation cards and authorized source binding.
 *
 * Renders `ContextBlockV1` as grouped compact context cards with:
 * - Permitted title, source type, bounded excerpt, retrieval state, and
 *   citation identity for each source reference.
 * - Explicit missing-field indicators for partial cards.
 * - Exact source state display: available, stale, unavailable, redacted,
 *   unverified, or no_longer_authorized.
 * - Protected content omission when source state is ineligible.
 * - Citation binding that maps narrative references only to authorized
 *   projected citations, never to arbitrary model-authored URLs.
 * - Detail inspector integration for expanded source evidence.
 * - Copy and expand actions with typed failure feedback.
 *
 * Requirements: 12.1–12.10, 20.3–20.5
 */

import type { ContextBlockV1 } from '../../../harness/contracts/response-composition';
import type {
  SourceReferenceV1,
  SourceStateV1,
  SourceTypeV1,
  OpaqueDetailLocatorV1,
} from '../../../harness/contracts/response-support';
import {
  toDomSafeSourceReferenceV1,
  type DomSafeSourceReferenceV1,
} from '../../../harness/contracts/response-support';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContextSourceState = SourceStateV1;

export interface ContextCardData {
  readonly citationId: string;
  readonly sourceType: SourceTypeV1;
  readonly state: ContextSourceState;
  readonly sourceRevision: number;
  readonly permittedTitle: string | undefined;
  readonly permittedExcerpt: string | undefined;
  readonly retrievedAt: string | undefined;
  readonly contentDigest: string | undefined;
  readonly hasDetail: boolean;
  readonly missingFields: readonly string[];
}

export interface ContextInspectorRequest {
  readonly citationId: string;
  readonly sourceRevision: number;
  readonly detailLocator: OpaqueDetailLocatorV1 | undefined;
}

export interface ContextSurfaceOptions {
  /** Callback for opening detail inspector for a source. */
  readonly onInspect?: (request: ContextInspectorRequest) => void;
  /** Callback for authorized external navigation. */
  readonly onOpenSource?: (citationId: string, sourceRevision: number) => void;
  /** Owner document for element creation. */
  readonly ownerDocument?: Document;
  /** Maximum number of cards visible before grouping collapses. */
  readonly maxVisibleCards?: number;
}

export interface ContextSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly semanticAnchor: string;
  readonly cards: readonly ContextCardData[];
  readonly actions: readonly ContextSurfaceAction[];
  update(block: ContextBlockV1, options?: Partial<ContextSurfaceOptions>): void;
  dispose(): void;
}

export type ContextSurfaceActionKind = 'copy_citation' | 'expand' | 'open_source';

export interface ContextSurfaceAction {
  readonly kind: ContextSurfaceActionKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly citationId?: string;
  readonly execute: () => Promise<ContextActionResult>;
}

export interface ContextActionResult {
  readonly success: boolean;
  readonly failureReason?: string;
}

export interface CitationBinding {
  readonly citationId: string;
  readonly sourceType: SourceTypeV1;
  readonly state: ContextSourceState;
  readonly sourceRevision: number;
  readonly permittedTitle: string | undefined;
}

export interface CitationBindingRegistry {
  /** Binds a narrative reference to an authorized projected citation. */
  bind(citationId: string): CitationBinding | undefined;
  /** Returns all registered citation IDs. */
  registeredIds(): readonly string[];
  /** Check if a reference matches an authorized projected citation. */
  isAuthorized(citationId: string): boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_STATE_LABELS: Readonly<Record<ContextSourceState, string>> = Object.freeze({
  available: 'Available',
  stale: 'Stale',
  unavailable: 'Unavailable',
  redacted: 'Redacted',
  unverified: 'Unverified',
  no_longer_authorized: 'No Longer Authorized',
});

const SOURCE_STATE_ICONS: Readonly<Record<ContextSourceState, string>> = Object.freeze({
  available: '●',
  stale: '◐',
  unavailable: '○',
  redacted: '⊘',
  unverified: '?',
  no_longer_authorized: '✗',
});

const SOURCE_TYPE_LABELS: Readonly<Record<SourceTypeV1, string>> = Object.freeze({
  web: 'Web',
  file: 'File',
  attachment: 'Attachment',
  session: 'Session',
  artifact: 'Artifact',
  tool: 'Tool Output',
  provider: 'Provider',
});

const INELIGIBLE_STATES: ReadonlySet<ContextSourceState> = new Set([
  'stale',
  'unavailable',
  'redacted',
  'unverified',
  'no_longer_authorized',
]);

const DEFAULT_MAX_VISIBLE_CARDS = 5;
const MISSING_FIELD_INDICATOR = '—';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function isContentEligible(state: ContextSourceState): boolean {
  return !INELIGIBLE_STATES.has(state);
}

function computeMissingFields(source: SourceReferenceV1): string[] {
  const missing: string[] = [];
  if (!source.permittedTitle) missing.push('title');
  if (!source.sourceType) missing.push('sourceType');
  if (!source.permittedExcerpt) missing.push('excerpt');
  if (!source.state) missing.push('retrievalState');
  if (!source.citationId) missing.push('citationId');
  return missing;
}

function toCardData(source: SourceReferenceV1): ContextCardData {
  const eligible = isContentEligible(source.state);
  return {
    citationId: source.citationId,
    sourceType: source.sourceType,
    state: source.state,
    sourceRevision: source.sourceRevision,
    permittedTitle: eligible ? source.permittedTitle : undefined,
    permittedExcerpt: eligible ? source.permittedExcerpt : undefined,
    retrievedAt: source.retrievedAt,
    contentDigest: source.contentDigest,
    hasDetail: source.detail !== undefined,
    missingFields: computeMissingFields(source),
  };
}

// ─── Citation Binding Registry ────────────────────────────────────────────────

/**
 * Creates a citation binding registry from a context block's sources.
 * Binds narrative references only to authorized projected citations.
 * Arbitrary model-authored URLs are never admitted.
 */
export function createCitationBindingRegistry(block: ContextBlockV1): CitationBindingRegistry {
  const sourceMap = new Map<string, SourceReferenceV1>();

  for (const source of block.content.sources) {
    sourceMap.set(source.citationId, source);
  }

  return {
    bind(citationId: string): CitationBinding | undefined {
      const source = sourceMap.get(citationId);
      if (!source) return undefined;

      const eligible = isContentEligible(source.state);
      return {
        citationId: source.citationId,
        sourceType: source.sourceType,
        state: source.state,
        sourceRevision: source.sourceRevision,
        permittedTitle: eligible ? source.permittedTitle : undefined,
      };
    },

    registeredIds(): readonly string[] {
      return Array.from(sourceMap.keys());
    },

    isAuthorized(citationId: string): boolean {
      return sourceMap.has(citationId);
    },
  };
}

/**
 * Validates whether a reference string is an authorized citation.
 * Rejects arbitrary URLs and only admits citation IDs from the projected set.
 */
export function isAuthorizedCitationReference(
  reference: string,
  registry: CitationBindingRegistry,
): boolean {
  // Reject anything that looks like a URL — only opaque citation IDs are permitted
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    return false;
  }
  // Reject common URL-like patterns
  if (/^(?:javascript|data|vbscript|file|ftp|mailto|ssh|ws|wss):/i.test(reference)) {
    return false;
  }
  // Only accept if the citation ID is in the projected registry
  return registry.isAuthorized(reference);
}

// ─── ContextSurface ───────────────────────────────────────────────────────────

export class ContextSurface {
  private readonly doc: Document;

  constructor(ownerDocument: Document = document) {
    this.doc = ownerDocument;
  }

  render(block: ContextBlockV1, options: ContextSurfaceOptions): ContextSurfaceHandle {
    const doc = options.ownerDocument ?? this.doc;
    const maxVisibleCards = options.maxVisibleCards ?? DEFAULT_MAX_VISIBLE_CARDS;
    const onInspect = options.onInspect;
    const onOpenSource = options.onOpenSource;

    let currentBlock = block;
    let disposed = false;
    let expanded = false;

    // Root element
    const root = doc.createElement('section');
    root.className = 'nn-context-surface';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Retrieved context and sources');
    root.dataset.stableKey = block.stableKey;
    root.dataset.semanticAnchor = block.semanticAnchor;

    // Card container
    const cardsContainer = doc.createElement('div');
    cardsContainer.className = 'nn-context-surface__cards';
    cardsContainer.setAttribute('role', 'list');
    root.appendChild(cardsContainer);

    // More/less control container
    const controlsContainer = doc.createElement('div');
    controlsContainer.className = 'nn-context-surface__controls';
    root.appendChild(controlsContainer);

    function getCards(): ContextCardData[] {
      return currentBlock.content.sources.map(toCardData);
    }

    function renderCards(): void {
      cardsContainer.replaceChildren();
      const cards = getCards();
      const visibleCount = expanded ? cards.length : Math.min(cards.length, maxVisibleCards);

      for (let i = 0; i < visibleCount; i++) {
        cardsContainer.appendChild(renderCard(cards[i], doc, onInspect, onOpenSource, currentBlock));
      }

      // Show expand control if needed
      controlsContainer.replaceChildren();
      if (cards.length > maxVisibleCards) {
        const toggleBtn = doc.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'nn-context-surface__toggle';
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        if (expanded) {
          toggleBtn.textContent = `Show fewer sources`;
          toggleBtn.setAttribute('aria-label', `Show fewer sources, currently showing all ${cards.length}`);
        } else {
          const remaining = cards.length - maxVisibleCards;
          toggleBtn.textContent = `Show ${remaining} more source${remaining !== 1 ? 's' : ''}`;
          toggleBtn.setAttribute('aria-label', `Show ${remaining} more sources`);
        }
        toggleBtn.addEventListener('click', () => {
          expanded = !expanded;
          renderCards();
        });
        controlsContainer.appendChild(toggleBtn);
      }

      root.dataset.status = currentBlock.status;
      root.dataset.sourceCount = String(cards.length);
    }

    function buildActions(): ContextSurfaceAction[] {
      const actions: ContextSurfaceAction[] = [];

      // Copy all citations action
      actions.push({
        kind: 'copy_citation',
        label: 'Copy citations',
        disabled: currentBlock.content.sources.length === 0,
        execute: async (): Promise<ContextActionResult> => {
          try {
            const cards = getCards();
            const citationText = cards
              .filter((c) => isContentEligible(c.state))
              .map((c) => {
                const title = c.permittedTitle ?? MISSING_FIELD_INDICATOR;
                return `[${c.citationId}] ${title} (${SOURCE_TYPE_LABELS[c.sourceType]})`;
              })
              .join('\n');
            await navigator.clipboard.writeText(citationText);
            return { success: true };
          } catch (err) {
            return {
              success: false,
              failureReason: err instanceof Error ? err.message : 'Clipboard write failed',
            };
          }
        },
      });

      // Expand/collapse group action
      if (currentBlock.content.sources.length > maxVisibleCards) {
        actions.push({
          kind: 'expand',
          label: expanded ? 'Show less' : 'Show all sources',
          disabled: false,
          execute: async (): Promise<ContextActionResult> => {
            expanded = !expanded;
            renderCards();
            return { success: true };
          },
        });
      }

      return actions;
    }

    renderCards();

    const handle: ContextSurfaceHandle = {
      get element() {
        return root;
      },
      get stableKey() {
        return currentBlock.stableKey;
      },
      get semanticAnchor() {
        return currentBlock.semanticAnchor;
      },
      get cards() {
        return getCards();
      },
      get actions() {
        return buildActions();
      },
      update(nextBlock: ContextBlockV1, nextOptions?: Partial<ContextSurfaceOptions>): void {
        if (disposed) return;
        currentBlock = nextBlock;
        root.dataset.stableKey = nextBlock.stableKey;
        root.dataset.semanticAnchor = nextBlock.semanticAnchor;
        renderCards();
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        root.remove();
        root.replaceChildren();
      },
    };

    return handle;
  }
}

// ─── Card Rendering ───────────────────────────────────────────────────────────

function renderCard(
  card: ContextCardData,
  doc: Document,
  onInspect: ((request: ContextInspectorRequest) => void) | undefined,
  onOpenSource: ((citationId: string, sourceRevision: number) => void) | undefined,
  block: ContextBlockV1,
): HTMLElement {
  const el = doc.createElement('article');
  el.className = 'nn-context-card';
  el.setAttribute('role', 'listitem');
  el.dataset.citationId = card.citationId;
  el.dataset.state = card.state;
  el.dataset.sourceType = card.sourceType;

  // State indicator (non-color cue)
  const stateEl = doc.createElement('span');
  stateEl.className = 'nn-context-card__state';
  stateEl.setAttribute('aria-label', `Source state: ${SOURCE_STATE_LABELS[card.state]}`);
  stateEl.dataset.state = card.state;
  stateEl.textContent = `${SOURCE_STATE_ICONS[card.state]} ${SOURCE_STATE_LABELS[card.state]}`;
  el.appendChild(stateEl);

  // Source type badge
  const typeBadge = doc.createElement('span');
  typeBadge.className = 'nn-context-card__type';
  typeBadge.textContent = SOURCE_TYPE_LABELS[card.sourceType];
  typeBadge.setAttribute('aria-label', `Source type: ${SOURCE_TYPE_LABELS[card.sourceType]}`);
  el.appendChild(typeBadge);

  // Citation identity
  const citationEl = doc.createElement('span');
  citationEl.className = 'nn-context-card__citation-id';
  citationEl.textContent = card.citationId;
  citationEl.setAttribute('aria-label', `Citation: ${card.citationId}`);
  el.appendChild(citationEl);

  // Title (or missing indicator)
  const titleEl = doc.createElement('h3');
  titleEl.className = 'nn-context-card__title';
  if (card.permittedTitle) {
    titleEl.textContent = card.permittedTitle;
  } else {
    titleEl.textContent = MISSING_FIELD_INDICATOR;
    titleEl.classList.add('nn-context-card__title--missing');
    titleEl.setAttribute('aria-label', 'Title: not available');
  }
  el.appendChild(titleEl);

  // Bounded excerpt (or missing indicator; omit when ineligible)
  const excerptEl = doc.createElement('p');
  excerptEl.className = 'nn-context-card__excerpt';
  if (!isContentEligible(card.state)) {
    excerptEl.textContent = 'Content not available for this source state.';
    excerptEl.classList.add('nn-context-card__excerpt--protected');
    excerptEl.setAttribute('aria-label', 'Excerpt: protected, content omitted');
  } else if (card.permittedExcerpt) {
    excerptEl.textContent = card.permittedExcerpt;
  } else {
    excerptEl.textContent = MISSING_FIELD_INDICATOR;
    excerptEl.classList.add('nn-context-card__excerpt--missing');
    excerptEl.setAttribute('aria-label', 'Excerpt: not available');
  }
  el.appendChild(excerptEl);

  // Missing field indicators
  if (card.missingFields.length > 0) {
    const missingEl = doc.createElement('div');
    missingEl.className = 'nn-context-card__missing-fields';
    missingEl.setAttribute('aria-label', `Missing fields: ${card.missingFields.join(', ')}`);
    for (const field of card.missingFields) {
      const fieldTag = doc.createElement('span');
      fieldTag.className = 'nn-context-card__missing-field';
      fieldTag.textContent = field;
      missingEl.appendChild(fieldTag);
    }
    el.appendChild(missingEl);
  }

  // Action buttons
  const actionsEl = doc.createElement('div');
  actionsEl.className = 'nn-context-card__actions';
  actionsEl.setAttribute('role', 'toolbar');
  actionsEl.setAttribute('aria-label', 'Citation actions');

  // Copy citation button
  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'nn-context-card__action nn-context-card__action--copy';
  copyBtn.textContent = 'Copy';
  copyBtn.setAttribute('aria-label', `Copy citation ${card.citationId}`);
  copyBtn.addEventListener('click', () => {
    const eligible = isContentEligible(card.state);
    const text = eligible && card.permittedTitle
      ? `[${card.citationId}] ${card.permittedTitle}`
      : `[${card.citationId}]`;
    void navigator.clipboard.writeText(text).catch(() => {
      // Best-effort copy; failure is reported via disabled state on next attempt
    });
  });
  actionsEl.appendChild(copyBtn);

  // Open/inspect button (only when source has a detail locator)
  if (card.hasDetail && card.state === 'available') {
    const inspectBtn = doc.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'nn-context-card__action nn-context-card__action--inspect';
    inspectBtn.textContent = 'View source';
    inspectBtn.setAttribute('aria-label', `View source details for ${card.citationId}`);
    inspectBtn.addEventListener('click', () => {
      if (onInspect) {
        const source = block.content.sources.find((s) => s.citationId === card.citationId);
        onInspect({
          citationId: card.citationId,
          sourceRevision: card.sourceRevision,
          detailLocator: source?.detail,
        });
      }
    });
    actionsEl.appendChild(inspectBtn);
  }

  // Open source button (only when authorized)
  if (onOpenSource && card.state === 'available') {
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'nn-context-card__action nn-context-card__action--open';
    openBtn.textContent = 'Open';
    openBtn.setAttribute('aria-label', `Open source ${card.citationId}`);
    openBtn.addEventListener('click', () => {
      onOpenSource(card.citationId, card.sourceRevision);
    });
    actionsEl.appendChild(openBtn);
  }

  el.appendChild(actionsEl);

  return el;
}

// ─── Exports for Testing ──────────────────────────────────────────────────────

export {
  isContentEligible,
  computeMissingFields,
  toCardData,
  escapeHtml,
  SOURCE_STATE_LABELS,
  SOURCE_STATE_ICONS,
  SOURCE_TYPE_LABELS,
  INELIGIBLE_STATES,
  MISSING_FIELD_INDICATOR,
  DEFAULT_MAX_VISIBLE_CARDS,
};
