/**
 * Projection-driven chat panel integration.
 *
 * This module is the canonical bridge between the renderer chat panel and the
 * versioned chat projection preload API. It:
 *
 * 1. Subscribes to `chatProjection` (page + delta + invalidation) on scope
 *    open and manages a single `createProjectionDrivenChatShell` instance.
 * 2. Handles `invalidate` and `source-revision-change` deltas by re-fetching
 *    the page from `chatProjection.getPage()`.
 * 3. Renders nothing until the first projection page arrives; the projection
 *    availability status (`unavailable` reasons) is surfaced through the
 *    existing status region.
 * 4. Unsubscribes on scope switch, panel unmount, and window destruction —
 *    keeping the projection publisher clean.
 *
 * The module does not subscribe to `chat-response`, `chat:stream`,
 * `chat:done`, `chat:error`, or `chat:stream-chunk`. Those legacy channels
 * flow into the main-process SessionLog compatibility adapters; task 13.2
 * handles the direct-channel cutover.
 *
 * Requirements: 9.1–9.7, 10.1–10.7, 13.8, 13.9, 15.3–15.7
 */

import {
  createCanonicalBlockRenderer,
  type CanonicalBlockRendererOptions,
} from '../../structured-response/canonical-block-renderer';
import type { ClipboardCopyFeedback } from '../../structured-response/clipboard-copy';
import {
  createResponseActionFeedbackSurface,
  createResponseActionRouter,
  type ClipboardAdapter,
  type ResponseActionFeedbackSurface,
  type ResponseActionOutcome,
} from '../../structured-response/response-action-router';
import {
  createProjectionDrivenChatShell,
  DEFAULT_MAX_READING_WIDTH,
  DEFAULT_MIN_READING_WIDTH,
  type ChatProjectionBinding,
  type ProjectionDisposeReason,
  type ProjectionDrivenChatShellHandle,
  type ProjectionRenderStatus,
  type ResponseActionInvocation,
  type ShellLayoutBounds,
} from '../../structured-response/structured-chat-shell';
import type { StructuredActionPort } from '../../structured-response/structured-action-port';
import type { ResponseBlockV1 } from '../../../harness/contracts/response-composition';
import type {
  ChatProjectionCompositionQueryV1,
  ChatProjectionCompositionResultV1,
  ChatProjectionInvalidatedV1,
  ChatProjectionPageQueryV1,
  ChatProjectionPageResultV1,
  ChatProjectionScopeV1,
  ChatProjectionUnsubscribe,
  ScopedChatProjectionDeltaV1,
} from '../../types/structured-chat-preload';

// ─── Bridge Surface ─────────────────────────────────────────────

/**
 * Minimal surface of the preload bridge consumed by this integration. Kept
 * narrow so tests can inject a fake bridge without dragging in the full
 * `ElectronPreloadBridge` type.
 */
export interface ChatProjectionPreloadSurface {
  getChatProjectionPage(
    query: ChatProjectionPageQueryV1,
  ): Promise<ChatProjectionPageResultV1>;
  getChatProjectionComposition(
    query: ChatProjectionCompositionQueryV1,
  ): Promise<ChatProjectionCompositionResultV1>;
  onChatProjectionDelta(
    scope: ChatProjectionScopeV1,
    callback: (delta: ScopedChatProjectionDeltaV1) => void,
  ): ChatProjectionUnsubscribe;
  onChatProjectionInvalidated(
    scope: ChatProjectionScopeV1,
    callback: (event: ChatProjectionInvalidatedV1) => void,
  ): ChatProjectionUnsubscribe;
}

// ─── Options / Handle ───────────────────────────────────────────

export interface ProjectionChatIntegrationOptions {
  /** Preload bridge exposing the fixed chat-projection methods. */
  readonly preload: ChatProjectionPreloadSurface;
  /** Container element the integration mounts its shell into. */
  readonly container: HTMLElement;
  /** Initial subscription scope. */
  readonly scope: ChatProjectionScopeV1;
  /** Reading-column bounds. Defaults to the shell's built-in defaults. */
  readonly bounds?: ShellLayoutBounds;
  /** Optional projection page size (default: 50). */
  readonly pageSize?: number;
  /** Optional status listener; receives every render status update. */
  readonly onStatusChange?: (status: ProjectionRenderStatus) => void;
  /** Optional lifecycle target; defaults to `globalThis.window`. */
  readonly windowLifecycleTarget?: EventTarget | null;
  /**
   * Optional override for the canonical block renderer. When omitted, the
   * integration installs {@link createCanonicalBlockRenderer} as the default
   * so every projected block flows through a canonical surface — never
   * through a legacy renderer. Task 10.1 wired this default.
   */
  readonly renderBlock?: (block: ResponseBlockV1) => HTMLElement;
  /**
   * Optional canonical-renderer configuration used only when `renderBlock`
   * is omitted. Task 10.2–10.6 will extend these options; the seam stays
   * stable.
   */
  readonly canonicalRenderer?: CanonicalBlockRendererOptions;
  /**
   * Structured action port used to route post-content actions (task 9.5).
   * When provided, the integration wires the shell's `onResponseAction`
   * callback through a router that copies narrative text to the clipboard,
   * dispatches retries via {@link StructuredActionPort.retryResponse}, and
   * dispatches feedback via {@link StructuredActionPort.feedback} with
   * optimistic pending state.
   *
   * When omitted, response actions render but do not dispatch — callers
   * that only need read-only rendering (fixtures, empty scopes) can omit
   * this option safely.
   */
  readonly actionPort?: StructuredActionPort;
  /**
   * Optional clipboard adapter override for the copy action. Defaults to
   * `navigator.clipboard`. Tests inject a fake adapter to observe copy
   * dispatch without touching the OS clipboard.
   */
  readonly clipboard?: ClipboardAdapter | null;
  /**
   * Optional observer for response-action outcomes (copy success/failure,
   * retry delivered/rejected, feedback delivered/rejected). Used by tests
   * and telemetry surfaces to observe reconciliation without inspecting
   * DOM state.
   */
  readonly onResponseActionOutcome?: (outcome: ResponseActionOutcome) => void;
  /**
   * Optional override for the `onResponseAction` callback. When supplied,
   * takes precedence over the default router (task 9.5). Prefer omitting
   * this option so the canonical router handles copy/retry/feedback.
   */
  readonly onResponseAction?: (invocation: ResponseActionInvocation) => void;
}

export interface ProjectionChatIntegrationHandle {
  /** The current subscription scope (frozen). */
  currentScope(): ChatProjectionScopeV1;
  /** Latest projection render status. */
  currentStatus(): ProjectionRenderStatus;
  /** Switch the subscription scope. Unsubscribes cleanly first. */
  switchScope(scope: ChatProjectionScopeV1): Promise<void>;
  /** Force a page re-fetch. */
  refresh(): Promise<void>;
  /** Retire the integration; unsubscribes and detaches the shell element. */
  dispose(reason?: ProjectionDisposeReason): void;
}

// ─── Bridge Adapter ─────────────────────────────────────────────

function toBinding(preload: ChatProjectionPreloadSurface): ChatProjectionBinding {
  return {
    getPage(query) {
      return preload.getChatProjectionPage(query);
    },
    getComposition(query) {
      return preload.getChatProjectionComposition(query);
    },
    subscribeDeltas(scope, callback) {
      return preload.onChatProjectionDelta(scope, callback);
    },
    subscribeInvalidations(scope, callback) {
      return preload.onChatProjectionInvalidated(scope, callback);
    },
  };
}

// ─── Integration Constructor ───────────────────────────────────

/**
 * Mount the projection-driven chat shell into the supplied container.
 *
 * The returned handle owns exactly one shell instance. Its lifecycle events
 * cascade the projection subscription:
 *
 * - `switchScope(next)` — unsubscribe the previous scope and open the next.
 * - `dispose()` — unsubscribe and remove the shell element.
 * - `beforeunload`/`pagehide` on the lifecycle target — dispose automatically.
 *
 * Callers may forward `active-project` or session-switch events into
 * `switchScope` to keep the shell scoped to the visible conversation.
 */
/** CSS class of the accessible response-action feedback container mounted
 *  by the integration. Exposed for test selection. */
export const RESPONSE_ACTION_FEEDBACK_CONTAINER_CSS_CLASS =
  'nn-projection-chat__response-action-feedback';

export function createProjectionChatIntegration(
  options: ProjectionChatIntegrationOptions,
): ProjectionChatIntegrationHandle {
  const bounds: ShellLayoutBounds = options.bounds ?? {
    maxReadingWidth: DEFAULT_MAX_READING_WIDTH,
    minReadingWidth: DEFAULT_MIN_READING_WIDTH,
  };

  const binding = toBinding(options.preload);

  // Response-action feedback surface (task 9.5, refined in task 10.5). Copy
  // success/failure and feedback delivery outcomes announce through this
  // pair of live regions. Requirement 14.6 mandates coalesced polite
  // announcements plus an assertive alert channel for failures.
  //
  // Task 10.5 refinement: the same surface is now also handed to the
  // canonical narrative and code surfaces so their per-block copy buttons
  // announce through the SAME channel as the response-group toolbar. That
  // way keyboard/screen-reader users hear one uniform message regardless
  // of which copy affordance they used.
  const feedbackContainer = document.createElement('div');
  feedbackContainer.className = RESPONSE_ACTION_FEEDBACK_CONTAINER_CSS_CLASS;
  feedbackContainer.dataset['role'] = 'response-action-feedback';
  const feedbackSurface: ResponseActionFeedbackSurface =
    createResponseActionFeedbackSurface(feedbackContainer);

  // Every projected block reaches the DOM through the canonical seam. The
  // caller may override for tests; production callers accept the default so
  // legacy renderers are never reachable from the projection path.
  //
  // Task 10.6 wires narrative anchors through the fixed
  // `shell:open-external-v1` preload method. The main process reparses and
  // allowlists the URL before calling `shell.openExternal`. Callers may
  // override the canonical renderer entirely, or supply their own
  // `onExternalNavigation` on `canonicalRenderer.narrative`; when omitted,
  // the default installs the `electronAPI.openExternalLink` router.
  //
  // Task 10.5: the caller's canonical-renderer options are extended with
  // the response-group feedback surface (so per-block copy buttons announce
  // on the same live regions) and the caller-supplied clipboard adapter
  // (so tests can observe copy dispatch without touching the OS clipboard).
  // Explicit caller-provided overrides on the surface options win.
  const canonicalRendererOptions = withDefaultCopyFeedback(
    withDefaultExternalNavigationRouter(options.canonicalRenderer),
    feedbackSurface,
    options.clipboard,
  );
  const renderBlock: (block: ResponseBlockV1) => HTMLElement =
    options.renderBlock ?? createCanonicalBlockRenderer(canonicalRendererOptions);

  // Wire the shell's onResponseAction callback through the router so copy /
  // retry / feedback are all handled uniformly. Callers may override with
  // their own callback (task-specific harnesses, fixtures) but the default
  // routes through the structured action port.
  let onResponseAction: ((invocation: ResponseActionInvocation) => void) | undefined =
    options.onResponseAction;
  if (onResponseAction === undefined && options.actionPort !== undefined) {
    onResponseAction = createResponseActionRouter({
      port: options.actionPort,
      feedbackSurface,
      ...(options.clipboard !== undefined ? { clipboard: options.clipboard } : {}),
      ...(options.onResponseActionOutcome !== undefined
        ? { onOutcome: options.onResponseActionOutcome }
        : {}),
    });
  }

  const shellOptions = {
    bounds,
    projection: binding,
    scope: options.scope,
    renderBlock,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.onStatusChange !== undefined
      ? { onStatusChange: options.onStatusChange }
      : {}),
    ...(options.windowLifecycleTarget !== undefined
      ? { windowLifecycleTarget: options.windowLifecycleTarget }
      : {}),
    ...(onResponseAction !== undefined ? { onResponseAction } : {}),
  };

  const shell: ProjectionDrivenChatShellHandle = createProjectionDrivenChatShell(
    shellOptions,
  );

  options.container.appendChild(shell.element);
  options.container.appendChild(feedbackContainer);

  let disposed = false;

  return {
    currentScope: () => shell.currentScope(),
    currentStatus: () => shell.currentStatus(),
    switchScope: (scope) => shell.switchScope(scope),
    refresh: () => shell.refresh(),
    dispose(reason: ProjectionDisposeReason = 'manual'): void {
      if (disposed) return;
      disposed = true;
      shell.dispose(reason);
      feedbackContainer.remove();
      feedbackContainer.replaceChildren();
    },
  };
}

// ─── External navigation default ───────────────────────────────

/**
 * Installs the default `onExternalNavigation` handler on the narrative
 * surface options when the caller has not supplied one. The handler
 * dispatches through the fixed `electronAPI.openExternalLink` preload
 * method exposed by task 10.6, which forwards to the main-process
 * `shell:open-external-v1` handler for reparse + allowlist + validated
 * `shell.openExternal`.
 *
 * When no `electronAPI.openExternalLink` accessor is present (e.g., unit
 * tests running without the preload bridge), the handler resolves to a
 * no-op — never falls back to `window.open` or `target="_blank"`. Callers
 * that need real navigation in a test override the option explicitly.
 */
export function withDefaultExternalNavigationRouter(
  canonicalRenderer: CanonicalBlockRendererOptions | undefined,
): CanonicalBlockRendererOptions {
  const existing = canonicalRenderer ?? {};
  const narrative = existing.narrative ?? {};
  if (narrative.onExternalNavigation !== undefined) return existing;

  return {
    ...existing,
    narrative: {
      ...narrative,
      onExternalNavigation: defaultExternalNavigationRouter,
    },
  };
}

function defaultExternalNavigationRouter(href: string): void {
  const bridge = getPreloadBridgeSafely();
  if (!bridge) return;
  // Fire-and-forget: the surface has no visible receipt UI for the shell
  // request itself. Failures are surfaced through the redacted rejection
  // codes returned by `openExternalLink` and can be routed to the
  // response-action feedback surface if a caller subscribes.
  void bridge.openExternalLink({ schemaVersion: 1, href }).catch(() => {
    // Never propagate — a rejected shell request must not surface an
    // unhandled promise on the renderer.
  });
}

// ─── Copy-feedback default (task 10.5) ─────────────────────────

/**
 * Installs the integration's response-group live-region pair as the
 * default `feedbackSurface` on the canonical narrative and code surface
 * options, and the caller's clipboard adapter as the default `clipboard`.
 * This makes every per-block copy button announce on the SAME live regions
 * the response-group toolbar uses, satisfying requirement 14.6's "polite
 * status + assertive alert" contract uniformly across the response tree.
 *
 * Existing per-surface overrides (test fixtures, harnesses) are left
 * untouched — the helper only fills in missing options.
 */
export function withDefaultCopyFeedback(
  canonicalRenderer: CanonicalBlockRendererOptions | undefined,
  feedbackSurface: ClipboardCopyFeedback,
  clipboard: ClipboardAdapter | null | undefined,
): CanonicalBlockRendererOptions {
  const existing = canonicalRenderer ?? {};
  const narrative = existing.narrative ?? {};
  const code = existing.code ?? {};

  const narrativeNext: typeof narrative = {
    ...narrative,
    ...(narrative.feedbackSurface === undefined ? { feedbackSurface } : {}),
    ...(narrative.clipboard === undefined && clipboard !== undefined
      ? { clipboard }
      : {}),
  };
  const codeNext: typeof code = {
    ...code,
    ...(code.feedbackSurface === undefined ? { feedbackSurface } : {}),
    ...(code.clipboard === undefined && clipboard !== undefined
      ? { clipboard }
      : {}),
  };

  return {
    ...existing,
    narrative: narrativeNext,
    code: codeNext,
  };
}

function getPreloadBridgeSafely(): {
  openExternalLink: (
    request: { schemaVersion: 1; href: string },
  ) => Promise<{ status: 'opened' | 'rejected'; rejectionCode?: string }>;
} | null {
  if (typeof globalThis === 'undefined') return null;
  const api = (globalThis as { electronAPI?: unknown }).electronAPI as
    | { openExternalLink?: unknown }
    | undefined;
  if (!api || typeof api.openExternalLink !== 'function') return null;
  return api as unknown as {
    openExternalLink: (
      request: { schemaVersion: 1; href: string },
    ) => Promise<{ status: 'opened' | 'rejected'; rejectionCode?: string }>;
  };
}
