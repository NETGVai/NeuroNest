/**
 * Tool Activity Surface — compact lineage-aware rows/chips with state,
 * owner, risk, duration, retention state, and inspector integration.
 *
 * Groups projected tool calls by parent-child lineage in model order.
 * Does NOT infer tool semantics from tool names, emoji, prose, or filenames.
 * Refines inspector detail only through compatible RenderIntentV1 kinds.
 *
 * Each Tool Chip is keyed by its `callId` so state transitions update the
 * existing row in place rather than remounting it. Optional expandable
 * details reveal the sanitized argument/result summary and any permitted
 * value preview supplied by the projection.
 *
 * Requirements: 7.1–7.9, 13.1–13.4, 13.7–13.9, 18.4, 20.3, 22.1–22.2
 */

import type {
  ResponseCompositionV1,
  ToolActivityBlockV1,
} from '../../../harness/contracts/response-composition';
import type { RenderIntentV1 } from '../../../harness/contracts/render-intent';
import { stripHtmlTags } from '../../../main/security/html-sanitizer';

// ─── Public types ───────────────────────────────────────────────

export type ToolCallState =
  | 'planned'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval';

export type RetainedOutputState =
  | 'inline'
  | 'spilled'
  | 'truncated'
  | 'redacted'
  | 'unavailable';

export interface ToolActivityLineageNode {
  readonly block: ToolActivityBlockV1;
  readonly children: readonly ToolActivityLineageNode[];
  readonly depth: number;
}

export interface ToolActivitySurfaceHandle {
  readonly element: HTMLElement;
  readonly roots: readonly ToolActivityLineageNode[];
  readonly selectedCallId: string | undefined;
  /** Update the surface in place. Preserves DOM identity of rows whose
   *  `callId` is present in both the previous and next block set. */
  update(blocks: readonly ToolActivityBlockV1[]): void;
  dispose(): void;
}

export interface ToolActivityInspectorRequest {
  readonly callId: string;
  readonly attemptIdentity: string;
  readonly refinementKind?: RenderIntentV1['kind'];
}

export interface ToolActivitySurfaceOptions {
  readonly onInspect?: (request: ToolActivityInspectorRequest) => void;
}

// ─── Constants ──────────────────────────────────────────────────

const STATE_LABELS: Readonly<Record<ToolCallState, string>> = Object.freeze({
  planned: 'Planned',
  executing: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_approval: 'Awaiting Approval',
});

const STATE_ICONS: Readonly<Record<ToolCallState, string>> = Object.freeze({
  planned: '○',
  executing: '◐',
  completed: '●',
  failed: '✗',
  cancelled: '⊘',
  awaiting_approval: '⏳',
});

const RETAINED_OUTPUT_LABELS: Readonly<Record<RetainedOutputState, string>> = Object.freeze({
  inline: 'Output available',
  spilled: 'Output spilled',
  truncated: 'Output truncated',
  redacted: 'Output redacted',
  unavailable: 'Output unavailable',
});

const ACTIVE_STATES = new Set<ToolCallState>(['planned', 'executing', 'awaiting_approval']);
const PENDING_STATES = new Set<ToolCallState>(['planned', 'awaiting_approval']);
const TERMINAL_STATES = new Set<ToolCallState>(['completed', 'failed', 'cancelled']);

const INLINE_SUMMARY_LIMIT = 256;
const DETAILS_TEXT_LIMIT = 4_096;

const COMPATIBLE_INTENT_KINDS: ReadonlySet<string> = new Set<string>([
  'generic', 'read', 'search', 'diff', 'terminal', 'web', 'image', 'table', 'tree', 'artifact',
]);

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Strip markup-like content from text used in aria-label attributes.
 * This prevents raw HTML/URL patterns from appearing in accessibility output.
 */
function sanitizeForAriaLabel(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '[link]');
}

/**
 * Bound inline presentation text. `textContent` provides the XSS
 * boundary; we only clamp length so long summaries never bloat the DOM.
 */
function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Sanitize expandable-details content: strip HTML tag remnants before
 * insertion via `textContent`. This is the defense-in-depth surface
 * required by the task specification for the details section.
 */
function sanitizeDetail(text: string, limit: number): string {
  const stripped = stripHtmlTags(text);
  if (stripped.length <= limit) return stripped;
  return `${stripped.slice(0, Math.max(0, limit - 1))}…`;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^\w-]/g, '\\$&');
}

function findRowByCallId(root: HTMLElement, callId: string): HTMLElement | null {
  return root.querySelector(`[data-call-id="${cssEscape(callId)}"]`);
}

// ─── Lineage tree construction ──────────────────────────────────

/**
 * Build a lineage forest from a flat list of ToolActivityBlockV1 items.
 * Preserves modelOrderIndex ordering. Parent-child relationships are
 * determined solely by `parentCallId`. Blocks with unknown parents are
 * treated as roots (malformed lineage fallback).
 */
export function buildLineageTree(blocks: readonly ToolActivityBlockV1[]): readonly ToolActivityLineageNode[] {
  if (blocks.length === 0) {
    return [];
  }

  // Sort by modelOrderIndex for stable ordering
  const sorted = [...blocks].sort(
    (a, b) => a.content.modelOrderIndex - b.content.modelOrderIndex,
  );

  const callIdToBlock = new Map<string, ToolActivityBlockV1>();
  for (const block of sorted) {
    callIdToBlock.set(block.content.callId, block);
  }

  const childrenMap = new Map<string, ToolActivityBlockV1[]>();
  const roots: ToolActivityBlockV1[] = [];

  for (const block of sorted) {
    const parentId = block.content.parentCallId;
    if (parentId === undefined || !callIdToBlock.has(parentId)) {
      // No parent or parent not in this set => root
      roots.push(block);
    } else {
      const existing = childrenMap.get(parentId);
      if (existing) {
        existing.push(block);
      } else {
        childrenMap.set(parentId, [block]);
      }
    }
  }

  function buildNode(block: ToolActivityBlockV1, depth: number): ToolActivityLineageNode {
    const childBlocks = childrenMap.get(block.content.callId) ?? [];
    const children = childBlocks.map((child) => buildNode(child, depth + 1));
    return Object.freeze({ block, children: Object.freeze(children), depth });
  }

  return Object.freeze(roots.map((root) => buildNode(root, 0)));
}

/**
 * Filter a response composition down to its `tool_activity` blocks in
 * projection order. Returns an empty array when the composition contains
 * no tool activity — callers must treat that as absence, never fabricate.
 */
export function findToolActivityBlocks(
  composition: ResponseCompositionV1,
): readonly ToolActivityBlockV1[] {
  return composition.blocks.filter(
    (block): block is ToolActivityBlockV1 => block.kind === 'tool_activity',
  );
}

// ─── Row DOM construction / mutation ────────────────────────────

function resolveRefinementKind(block: ToolActivityBlockV1): RenderIntentV1['kind'] | undefined {
  if (!block.renderIntent || typeof block.renderIntent !== 'object') {
    return undefined;
  }
  const raw = block.renderIntent as Record<string, unknown>;
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    return undefined;
  }
  return COMPATIBLE_INTENT_KINDS.has(kind) ? (kind as RenderIntentV1['kind']) : undefined;
}

function buildInspectorRequest(block: ToolActivityBlockV1): ToolActivityInspectorRequest {
  const refinementKind = resolveRefinementKind(block);
  const request: ToolActivityInspectorRequest = {
    callId: block.content.callId,
    attemptIdentity: block.sourceIdentity.entityId,
  };
  if (refinementKind !== undefined) {
    return { ...request, refinementKind };
  }
  return request;
}

function computeAriaLabel(block: ToolActivityBlockV1): string {
  const safeSummary = sanitizeForAriaLabel(block.permittedSummary ?? 'tool call');
  return [
    STATE_LABELS[block.content.state],
    safeSummary,
    `Owner: ${block.content.owner}`,
    `Risk: ${block.content.riskClass}`,
    RETAINED_OUTPUT_LABELS[block.content.retainedOutput],
  ].join('. ');
}

function detailsForBlock(block: ToolActivityBlockV1): {
  hasContent: boolean;
  summaryFull: string | undefined;
  preview: string | undefined;
  mediaType: string | undefined;
} {
  const inlineSummary = block.permittedSummary ?? '';
  const summaryLong = inlineSummary.length > INLINE_SUMMARY_LIMIT ? inlineSummary : undefined;
  const preview = block.content.value?.permittedPreview;
  const mediaType = block.content.value?.mediaType;
  const hasContent = Boolean(summaryLong || preview || mediaType);
  return {
    hasContent,
    summaryFull: summaryLong,
    preview,
    mediaType,
  };
}

function createDetailField(labelText: string, valueText: string): HTMLElement {
  const field = document.createElement('div');
  field.className = 'nn-tool-activity__details-field';

  const label = document.createElement('span');
  label.className = 'nn-tool-activity__details-label';
  label.textContent = labelText;
  field.appendChild(label);

  const value = document.createElement('span');
  value.className = 'nn-tool-activity__details-value';
  value.textContent = sanitizeDetail(valueText, DETAILS_TEXT_LIMIT);
  field.appendChild(value);

  return field;
}

function buildDetailsElement(block: ToolActivityBlockV1): HTMLDetailsElement | null {
  const info = detailsForBlock(block);
  if (!info.hasContent) return null;

  const details = document.createElement('details');
  details.className = 'nn-tool-activity__details';

  const summary = document.createElement('summary');
  summary.className = 'nn-tool-activity__details-toggle';
  summary.textContent = 'Details';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'nn-tool-activity__details-body';

  if (info.summaryFull) {
    body.appendChild(createDetailField('Result', info.summaryFull));
  }
  if (info.preview) {
    body.appendChild(createDetailField('Preview', info.preview));
  }
  if (info.mediaType) {
    body.appendChild(createDetailField('Media type', info.mediaType));
  }

  details.appendChild(body);

  // Prevent the summary toggle from bubbling to the row's click handler
  summary.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  summary.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  });

  return details;
}

function applyRowContent(row: HTMLElement, block: ToolActivityBlockV1, depth: number): void {
  const state = block.content.state;
  row.dataset.callId = block.content.callId;
  row.dataset.state = state;
  row.dataset.depth = String(depth);
  row.dataset.entityId = block.sourceIdentity.entityId;
  row.dataset.contentRevision = String(block.contentRevision);

  // Mark pending vs terminal via non-color data hooks. The state class already
  // carries the discriminator, but the additional lifecycle attribute makes
  // restoration inspection deterministic in tests and for authored CSS.
  row.dataset.lifecycle = TERMINAL_STATES.has(state)
    ? 'terminal'
    : PENDING_STATES.has(state)
      ? 'pending'
      : 'active';

  if (ACTIVE_STATES.has(state)) {
    row.setAttribute('aria-busy', 'true');
  } else {
    row.removeAttribute('aria-busy');
  }

  row.setAttribute('aria-level', String(depth + 1));
  row.style.paddingInlineStart = depth > 0 ? `${depth * 1.25}rem` : '';

  row.setAttribute('aria-label', computeAriaLabel(block));

  // Rebuild inline children (icon/state/summary/owner/risk/retention).
  const iconSpan = row.querySelector('.nn-tool-activity__state-icon') as HTMLSpanElement | null
    ?? row.appendChild(createSpan('nn-tool-activity__state-icon'));
  iconSpan.textContent = STATE_ICONS[state];
  iconSpan.setAttribute('aria-hidden', 'true');

  const stateSpan = row.querySelector('.nn-tool-activity__state') as HTMLSpanElement | null
    ?? row.appendChild(createSpan('nn-tool-activity__state'));
  stateSpan.className = `nn-tool-activity__state nn-tool-activity__state--${state}`;
  stateSpan.textContent = STATE_LABELS[state];

  const summaryText = block.permittedSummary ?? '';
  const summarySpan = row.querySelector('.nn-tool-activity__summary') as HTMLSpanElement | null;
  if (summaryText.length > 0) {
    const el = summarySpan ?? row.appendChild(createSpan('nn-tool-activity__summary'));
    el.textContent = boundText(summaryText, INLINE_SUMMARY_LIMIT);
  } else if (summarySpan) {
    summarySpan.remove();
  }

  const ownerSpan = row.querySelector('.nn-tool-activity__owner') as HTMLSpanElement | null
    ?? row.appendChild(createSpan('nn-tool-activity__owner'));
  ownerSpan.textContent = block.content.owner;

  const riskSpan = row.querySelector('.nn-tool-activity__risk') as HTMLSpanElement | null
    ?? row.appendChild(createSpan('nn-tool-activity__risk'));
  riskSpan.className = `nn-tool-activity__risk nn-tool-activity__risk--${block.content.riskClass}`;
  riskSpan.textContent = block.content.riskClass;

  const retentionSpan = row.querySelector('.nn-tool-activity__retention') as HTMLSpanElement | null
    ?? row.appendChild(createSpan('nn-tool-activity__retention'));
  retentionSpan.className = `nn-tool-activity__retention nn-tool-activity__retention--${block.content.retainedOutput}`;
  retentionSpan.textContent = RETAINED_OUTPUT_LABELS[block.content.retainedOutput];

  // Ensure ordering: icon, state, summary?, owner, risk, retention, details?
  const orderedInline: HTMLElement[] = [iconSpan, stateSpan];
  const summaryEl = row.querySelector('.nn-tool-activity__summary') as HTMLElement | null;
  if (summaryEl) orderedInline.push(summaryEl);
  orderedInline.push(ownerSpan, riskSpan, retentionSpan);
  for (const el of orderedInline) row.appendChild(el);

  // Details section (rebuilt because its content depends on the block state).
  const previousDetails = row.querySelector('.nn-tool-activity__details') as HTMLDetailsElement | null;
  const wasOpen = previousDetails?.open ?? false;
  const nextDetails = buildDetailsElement(block);
  if (previousDetails) previousDetails.remove();
  if (nextDetails) {
    if (wasOpen) nextDetails.open = true;
    row.appendChild(nextDetails);
  }
}

function createSpan(className: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  return el;
}

function createRowSkeleton(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nn-tool-activity__row';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('tabindex', '0');
  return row;
}

function attachRowInteractionHandlers(
  row: HTMLElement,
  getBlock: () => ToolActivityBlockV1 | undefined,
  markSelected: (callId: string) => void,
  onInspect: ToolActivitySurfaceOptions['onInspect'],
): void {
  const activate = (): void => {
    const block = getBlock();
    if (!block) return;
    markSelected(block.content.callId);
    row.setAttribute('aria-selected', 'true');
    onInspect?.(buildInspectorRequest(block));
  };

  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
}

// ─── Surface state and rendering ────────────────────────────────

interface ToolActivityInternalState {
  root: HTMLElement;
  /** callId → row element */
  rows: Map<string, HTMLElement>;
  /** callId → child-group container element (created lazily) */
  groups: Map<string, HTMLElement>;
  /** callId → current block snapshot */
  blocks: Map<string, ToolActivityBlockV1>;
  selectedCallId: string | undefined;
  disposed: boolean;
  currentRoots: readonly ToolActivityLineageNode[];
  options: ToolActivitySurfaceOptions;
}

function reconcileTree(state: ToolActivityInternalState, blocks: readonly ToolActivityBlockV1[]): void {
  const newRoots = buildLineageTree(blocks);
  const newCallIds = new Set<string>();
  for (const block of blocks) {
    newCallIds.add(block.content.callId);
  }

  // Remove rows and groups for callIds that no longer exist.
  for (const [callId, row] of state.rows) {
    if (!newCallIds.has(callId)) {
      row.remove();
      state.rows.delete(callId);
      state.blocks.delete(callId);
      const group = state.groups.get(callId);
      if (group) {
        group.remove();
        state.groups.delete(callId);
      }
    }
  }

  // Walk the new lineage in order, reusing existing DOM nodes.
  function reconcileSubtree(node: ToolActivityLineageNode, parentContainer: HTMLElement): void {
    let row = state.rows.get(node.block.content.callId);
    if (!row) {
      row = createRowSkeleton();
      state.rows.set(node.block.content.callId, row);
      attachRowInteractionHandlers(
        row,
        () => state.blocks.get(node.block.content.callId),
        (callId) => {
          state.selectedCallId = callId;
        },
        state.options.onInspect,
      );
    }
    state.blocks.set(node.block.content.callId, node.block);
    applyRowContent(row, node.block, node.depth);
    // Preserve selection marker across updates.
    if (state.selectedCallId === node.block.content.callId) {
      row.setAttribute('aria-selected', 'true');
    } else {
      row.removeAttribute('aria-selected');
    }
    parentContainer.appendChild(row);

    if (node.children.length > 0) {
      let group = state.groups.get(node.block.content.callId);
      if (!group) {
        group = document.createElement('div');
        group.className = 'nn-tool-activity__group';
        group.setAttribute('role', 'group');
        state.groups.set(node.block.content.callId, group);
      }
      group.setAttribute(
        'aria-label',
        `Child calls of ${sanitizeForAriaLabel(node.block.permittedSummary ?? 'tool call')}`,
      );
      parentContainer.appendChild(group);
      for (const child of node.children) {
        reconcileSubtree(child, group);
      }
    } else {
      const existingGroup = state.groups.get(node.block.content.callId);
      if (existingGroup) {
        existingGroup.remove();
        state.groups.delete(node.block.content.callId);
      }
    }
  }

  for (const rootNode of newRoots) {
    reconcileSubtree(rootNode, state.root);
  }

  state.currentRoots = newRoots;

  // Restore aria-selected marker if the selected call still exists.
  if (state.selectedCallId !== undefined) {
    const still = state.rows.get(state.selectedCallId);
    if (!still) {
      state.selectedCallId = undefined;
    } else {
      still.setAttribute('aria-selected', 'true');
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Render a ToolActivitySurface from an array of tool_activity blocks
 * belonging to a single composition.
 */
export function renderToolActivitySurface(
  blocks: readonly ToolActivityBlockV1[],
  options: ToolActivitySurfaceOptions = {},
): ToolActivitySurfaceHandle {
  const root = document.createElement('div');
  root.className = 'nn-tool-activity';
  root.setAttribute('role', 'tree');
  root.setAttribute('aria-label', 'Tool activity');

  const state: ToolActivityInternalState = {
    root,
    rows: new Map(),
    groups: new Map(),
    blocks: new Map(),
    selectedCallId: undefined,
    disposed: false,
    currentRoots: [],
    options,
  };

  reconcileTree(state, blocks);

  return Object.freeze({
    element: root,
    get roots() {
      return state.currentRoots;
    },
    get selectedCallId() {
      return state.selectedCallId;
    },
    update(nextBlocks: readonly ToolActivityBlockV1[]) {
      if (state.disposed) return;
      reconcileTree(state, nextBlocks);
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.rows.clear();
      state.groups.clear();
      state.blocks.clear();
      root.remove();
      root.replaceChildren();
    },
  });
}

/**
 * Update an existing surface handle with new blocks. Preserves DOM
 * identity of rows whose `callId` appears in both the previous and next
 * block set, and preserves the selected callId when it persists.
 */
export function updateToolActivitySurface(
  handle: ToolActivitySurfaceHandle,
  blocks: readonly ToolActivityBlockV1[],
  _options: ToolActivitySurfaceOptions = {},
): ToolActivitySurfaceHandle {
  handle.update(blocks);
  return handle;
}

/**
 * Render or update a tool-activity surface directly from a canonical
 * response composition. Returns `null` when the composition contains no
 * tool activity blocks. This is the canonical entry point for projection-
 * driven rendering — callers must never fabricate tool activity when the
 * projection has none.
 */
export function renderToolActivityFromComposition(
  composition: ResponseCompositionV1,
  options: ToolActivitySurfaceOptions = {},
): ToolActivitySurfaceHandle | null {
  const blocks = findToolActivityBlocks(composition);
  if (blocks.length === 0) return null;
  return renderToolActivitySurface(blocks, options);
}

/**
 * Surface adapter conforming to the ResponseSurfaceRegistry pattern.
 * Accepts a single ToolActivityBlockV1 or extracts multiple from context.
 */
export const ToolActivitySurface = Object.freeze({
  kind: 'tool_activity' as const,

  render(
    block: ToolActivityBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): ToolActivitySurfaceHandle {
    // Context may provide grouped blocks for the same composition
    const groupedBlocks = extractGroupedBlocks(context, block);
    return renderToolActivitySurface(groupedBlocks, {
      onInspect: context['onInspect'] as ToolActivitySurfaceOptions['onInspect'],
    });
  },

  update(
    handle: object,
    _previous: ToolActivityBlockV1,
    next: ToolActivityBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): void {
    const surfaceHandle = handle as ToolActivitySurfaceHandle;
    const groupedBlocks = extractGroupedBlocks(context, next);
    surfaceHandle.update(groupedBlocks);
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as ToolActivitySurfaceHandle;
    surfaceHandle.dispose();
  },
});

/** Convenience alias matching the design's `ToolChipSurface` name. */
export const ToolChipSurface = ToolActivitySurface;

/**
 * Extract grouped tool activity blocks from context or fall back to a
 * single-block array. This supports the registry invoking with one block
 * while allowing multi-block tree rendering from context.
 */
function extractGroupedBlocks(
  context: Record<string, unknown>,
  fallbackBlock: ToolActivityBlockV1,
): readonly ToolActivityBlockV1[] {
  const grouped = context['toolActivityBlocks'];
  if (Array.isArray(grouped) && grouped.length > 0) {
    // Only include validated tool_activity blocks
    return grouped.filter(
      (b): b is ToolActivityBlockV1 =>
        typeof b === 'object' &&
        b !== null &&
        (b as Record<string, unknown>)['kind'] === 'tool_activity',
    );
  }
  return [fallbackBlock];
}

// Retained for potential external usage; not exported.
export { findRowByCallId as __findRowByCallIdForTests };
