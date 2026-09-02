/**
 * Canonical block-renderer adapter for the projection-driven chat shell.
 *
 * Task 10.1 introduced this seam. It is the single entry point through which
 * `createProjectionDrivenChatShell` reaches the canonical surfaces. All
 * behaviour retained from the audit lives on the other side of this call —
 * legacy duplicate renderers under `src/renderer/panels/chat/*` and the
 * legacy top-level helpers (`chat-streaming.ts`, `chat-message-actions.ts`,
 * `chat-enhancements.ts`, `chat-empty-state.ts`, `chat-scroll-controller.ts`)
 * have all been retired by task 13.3. The format engine inside
 * `src/renderer/index.ts` is never reached from here.
 *
 * Task 10.2 (independent sanitizer), 10.3 (canonical Markdown pipeline),
 * 10.4 (deterministic code identity and gated highlighting), 10.5
 * (exact-source clipboard), and 10.6 (external-link IPC) attach further
 * safety to the surfaces this adapter dispatches to. This module owns the
 * dispatch — it does not implement those replacements.
 *
 * Requirements: 9.1, 10.2, 10.7–10.10, 15.1, 15.2, 15.9
 */

import {
  ResponseBlockV1Schema,
  type AttachmentBlockV1,
  CodeBlockV1,
  ContextBlockV1,
  DecisionBlockV1,
  DiffBlockV1,
  ErrorBlockV1,
  FollowUpActionsBlockV1,
  InsightBlockV1,
  NarrativeBlockV1,
  ReasoningBlockV1,
  RecommendationBlockV1,
  ResponseBlockV1,
  StructuredDataBlockV1,
  TaskProgressBlockV1,
  ToolActivityBlockV1,
  TurnStatusBlockV1,
} from '../../harness/contracts/response-composition';
import { CodeSurface, type CodeSurfaceOptions } from './surfaces/code-surface';
import { DataSurface } from './surfaces/data-surface';
import { renderDecisionSurface } from './surfaces/decision-surface';
import { DiffSurface } from './surfaces/diff-surface';
import { renderFollowUpActionSurface } from './surfaces/follow-up-action-surface';
import { renderInsightSurface } from './surfaces/insight-surface';
import { NarrativeSurface, type NarrativeSurfaceOptions } from './surfaces/narrative-surface';
import { renderReasoningDisclosureSurface } from './surfaces/reasoning-disclosure-surface';
import { renderRecommendationSurface } from './surfaces/recommendation-surface';
import { renderSafeGenericSurface } from './surfaces/safe-generic-surface';
import { renderTaskProgressSurface } from './surfaces/task-progress-surface';
import { renderToolActivitySurface } from './surfaces/tool-activity-surface';
import { renderTurnStatusSurface } from './surfaces/turn-status-surface';

// ─── Options ────────────────────────────────────────────────────

/** Narrative surface configuration forwarded on every render. */
export type CanonicalNarrativeOptions = Omit<
  NarrativeSurfaceOptions,
  'ownerDocument'
>;

/** Code surface configuration forwarded on every render. */
export type CanonicalCodeOptions = Omit<CodeSurfaceOptions, 'ownerDocument'>;

export interface CanonicalBlockRendererOptions {
  /** Document used to construct new nodes. Defaults to `globalThis.document`. */
  readonly ownerDocument?: Document;
  /** Optional narrative surface options; only exposed defaults are honoured. */
  readonly narrative?: Partial<CanonicalNarrativeOptions>;
  /** Optional code surface options; only exposed defaults are honoured. */
  readonly code?: Partial<CanonicalCodeOptions>;
}

/**
 * Reasonable defaults for the canonical narrative surface. These are exposed
 * so tests can assert the canonical seam applies them.
 */
export const DEFAULT_CANONICAL_NARRATIVE_OPTIONS: CanonicalNarrativeOptions = Object.freeze({
  collapseThreshold: 2_000,
});

/**
 * Reasonable defaults for the canonical code surface. Task 10.4 will tighten
 * `highlightDeferMs` to a projection-derived value; the seam remains stable.
 */
export const DEFAULT_CANONICAL_CODE_OPTIONS: CanonicalCodeOptions = Object.freeze({
  maxHeight: 400,
  showLineNumbers: false,
  wrapEnabled: false,
  highlightDeferMs: 150,
});

// ─── Renderer factory ───────────────────────────────────────────

/**
 * Build the canonical `renderBlock` function consumed by
 * `createProjectionDrivenChatShell`. The returned function is pure with
 * respect to its input — it constructs a fresh surface handle on every call
 * because the shell's current reconciler rebuilds inner content per revision.
 * Task 10.4 will teach the shell to keep surface handles across revisions;
 * this seam stays the same.
 */
export function createCanonicalBlockRenderer(
  options: CanonicalBlockRendererOptions = {},
): (block: ResponseBlockV1) => HTMLElement {
  const doc = options.ownerDocument ?? getDefaultDocument();
  const narrativeOptions: CanonicalNarrativeOptions = {
    ...DEFAULT_CANONICAL_NARRATIVE_OPTIONS,
    ...(options.narrative ?? {}),
  };
  const codeOptions: CanonicalCodeOptions = {
    ...DEFAULT_CANONICAL_CODE_OPTIONS,
    ...(options.code ?? {}),
  };

  const narrativeSurface = new NarrativeSurface(doc);
  const codeSurface = new CodeSurface(doc);
  const diffSurface = new DiffSurface(doc);
  const dataSurface = new DataSurface(doc);

  return function renderCanonicalBlock(rawBlock: ResponseBlockV1): HTMLElement {
    let block: ResponseBlockV1;
    try {
      const parsed = ResponseBlockV1Schema.safeParse(rawBlock);
      if (!parsed.success) {
        return renderSafeGenericSurface({
          scope: 'block',
          status: 'unavailable',
          correlationId: 'unavailable',
        }).element;
      }
      block = parsed.data;
    } catch {
      // Runtime inputs can contain hostile proxies/getters. Never inspect or
      // reflect malformed payload data in the fallback surface.
      return renderSafeGenericSurface({
        scope: 'block',
        status: 'unavailable',
        correlationId: 'unavailable',
      }).element;
    }

    switch (block.kind) {
      case 'narrative': {
        const handle = narrativeSurface.render(block as NarrativeBlockV1, {
          ...narrativeOptions,
          ownerDocument: doc,
        });
        return handle.element;
      }
      case 'code': {
        const handle = codeSurface.render(block as CodeBlockV1, {
          ...codeOptions,
          ownerDocument: doc,
        });
        return handle.element;
      }
      case 'reasoning': {
        const handle = renderReasoningDisclosureSurface(
          block as ReasoningBlockV1,
        );
        return handle.element;
      }
      case 'turn_status': {
        const handle = renderTurnStatusSurface(
          block as TurnStatusBlockV1,
          { elapsedTimeEnabled: true },
        );
        return handle.element;
      }
      case 'tool_activity': {
        const handle = renderToolActivitySurface(
          [block as ToolActivityBlockV1],
        );
        return handle.element;
      }
      case 'task_progress': {
        const handle = renderTaskProgressSurface(
          block as TaskProgressBlockV1,
        );
        return handle.element;
      }
      case 'decision': {
        const handle = renderDecisionSurface(
          block as DecisionBlockV1,
        );
        return handle.element;
      }
      case 'recommendation': {
        const handle = renderRecommendationSurface(
          block as RecommendationBlockV1,
        );
        return handle.element;
      }
      case 'diff': {
        const handle = diffSurface.render(
          block as DiffBlockV1,
        );
        return handle.element;
      }
      case 'structured_data': {
        const handle = dataSurface.render(
          block as StructuredDataBlockV1,
        );
        return handle.element;
      }
      case 'insight': {
        const handle = renderInsightSurface(
          block as InsightBlockV1,
        );
        return handle.element;
      }
      case 'follow_up_actions': {
        const handle = renderFollowUpActionSurface(
          block as FollowUpActionsBlockV1,
        );
        return handle.element;
      }
      case 'error': {
        // Render error blocks using a styled narrative-like presentation
        const errorBlock = block as ErrorBlockV1;
        const root = doc.createElement('div');
        root.className = 'nn-error-block';
        root.setAttribute('role', 'alert');
        root.setAttribute('aria-label', 'Error: ' + errorBlock.content.summary);

        const header = doc.createElement('div');
        header.className = 'nn-error-block__header';
        header.textContent = '\u26A0\uFE0F ' + errorBlock.content.summary;
        root.appendChild(header);

        if (errorBlock.content.partialContent) {
          const body = doc.createElement('div');
          body.className = 'nn-error-block__body';
          body.textContent = errorBlock.content.partialContent;
          root.appendChild(body);
        }

        const footer = doc.createElement('div');
        footer.className = 'nn-error-block__footer';
        footer.textContent = 'State: ' + errorBlock.content.recoveryState;
        root.appendChild(footer);

        return root;
      }
      case 'context': {
        // Context blocks display source references — render as a compact list
        const contextBlock = block as ContextBlockV1;
        const root = doc.createElement('div');
        root.className = 'nn-context-block';
        root.setAttribute('role', 'list');
        root.setAttribute('aria-label', 'Context sources');

        const sources = contextBlock.content?.sources ?? [];
        for (const source of sources) {
          const item = doc.createElement('div');
          item.className = 'nn-context-block__source';
          item.setAttribute('role', 'listitem');
          item.textContent = '\uD83D\uDCC4 ' + (source.permittedTitle || source.citationId || 'Source');
          root.appendChild(item);
        }

        if (sources.length === 0) {
          const empty = doc.createElement('div');
          empty.className = 'nn-context-block__empty';
          empty.textContent = 'No context sources';
          root.appendChild(empty);
        }

        return root;
      }
      case 'attachment': {
        // Render attachment blocks as a compact list of attached items
        const attachBlock = block as AttachmentBlockV1;
        const root = doc.createElement('div');
        root.className = 'nn-attachment-block';
        root.setAttribute('role', 'list');
        root.setAttribute('aria-label', 'Attachments');

        const attachments = attachBlock.content?.attachments ?? [];
        for (const attachment of attachments) {
          const item = doc.createElement('div');
          item.className = 'nn-attachment-block__item';
          item.setAttribute('role', 'listitem');
          const stateIcon = attachment.state === 'ready' ? '\u2705' :
            attachment.state === 'processing' ? '\u23F3' :
            attachment.state === 'failed' ? '\u274C' : '\uD83D\uDCCE';
          item.textContent = stateIcon + ' ' + (attachment.displayName || 'Attachment') +
            ' (' + attachment.mediaType + ')';
          root.appendChild(item);
        }

        return root;
      }
      // Fallback for any future block kinds not yet handled
      default: {
        const exhaustiveBlock = block as ResponseBlockV1;
        const handle = renderSafeGenericSurface({
          scope: 'block',
          status: exhaustiveBlock.status,
          correlationId: exhaustiveBlock.stableKey,
        });
        return handle.element;
      }
    }
  };
}

// ─── Internal ───────────────────────────────────────────────────

function getDefaultDocument(): Document {
  if (typeof globalThis !== 'undefined') {
    const win = (globalThis as { document?: Document }).document;
    if (win) return win;
  }
  throw new Error(
    'canonical-block-renderer requires an available Document. Pass `ownerDocument` explicitly when running outside a browser or jsdom environment.',
  );
}
