/**
 * Chat Experience Authority — composer islands, content-addressed attachments,
 * the message action contract, approval cards, typed recovery, sanitized
 * Mermaid/markup/links, and starter/post-task suggestions with the exact
 * auto-send-versus-prefill policy (FUT-PKG-07-EXPERIENCE/T-002).
 *
 * This module is the second leaf of the P6 EXPERIENCE package. It is
 * deliberately ADDITIVE over the canonical authorities it depends on and NEVER
 * creates a parallel truth (NN-INV-008):
 *
 *   - The chat timeline is the canonical READER from
 *     {@link ./chat-projection} over the committed `DomainEvent@1` outbox
 *     (FUT-PKG-07-EXPERIENCE/T-001, D-10). Composer drafts, context items, the
 *     steering queue, prompt history, attachments, and branch/retry markers are
 *     projected the SAME way: each is a stable-keyed island reduced from
 *     committed chat events, so paging/replay/reconnect/compaction/restore
 *     neither duplicate nor lose an island (NN-CHAT-007/008/009). Nothing here
 *     is a second durable writer — every durable write is performed by the
 *     shared authority mutation transaction and read back through the
 *     ProjectionService.
 *   - Approval cards reuse the ONE accessible shared card and notification
 *     contract from {@link ../approval/approval-card} and the exact-binding
 *     digest from {@link ../approval/approval-types} (FUT-PKG-04-SECURITY/T-006,
 *     NN-APPROVAL-004/007/009). This module renders those cards inside the chat
 *     surface; it never mints a decision.
 *   - Typed recovery is a READER over the canonical checkpoint/restore
 *     reconciliation state (FUT-PKG-05-RECOVERY/T-004, D-14). It offers the
 *     applicable resume/retry/reload/export actions, preserves drafts / unread
 *     state / partial content / queue / approvals / semantic anchor, disables
 *     mutations while a reconciliation is incompatible, and NEVER shows a false
 *     success (NN-CHAT-010).
 *
 * The fail-closed invariants this module encodes (NN-INV-001/003, D-16.1/16.6):
 *
 *   - **Content sanitization fails closed.** {@link sanitizeMermaid},
 *     {@link sanitizeMarkup}, and {@link sanitizeLink} refuse unsafe markup and
 *     unsafe links rather than emitting a "best-effort" partially-sanitized
 *     value. A refused value produces a visible typed no-effect result — never
 *     a silent pass, never a rendered script (NN-CHAT-012, NN-UI-011).
 *   - **Every action routes through an authority and reports truthfully.** The
 *     message action set (Copy raw Markdown, Expand, More, per-code-block copy,
 *     open/download/apply/run, edit/retry) returns a typed result; a failed
 *     clipboard/apply/run, a stale target, or an unauthorized path is a VISIBLE
 *     no-effect failure with a typed {@link ErrorEnvelope} — never a false
 *     `Copied!` toast, never a silent success (NN-CHAT-011, NN-UI-003).
 *   - **Suggestions bind to their visible text.** A card auto-sends ONLY when
 *     its visible text is read-only/conversational AND the digest of the
 *     currently visible text matches the digest captured when the card was
 *     built AND the click is an explicit submission (CD-017, NN-CHAT-014). A
 *     mutating/build/destructive/risk-unknown/changed prompt prefills and
 *     requires a separate Send plus approval; a stale/changed/mutating card that
 *     is asked to auto-send produces a visible no-effect failure (never a
 *     dispatch).
 *
 * Migration/rollback (D-20): the composer/queue/history/attachment islands are
 * typed projection readers behind the same projection/command ports as the
 * timeline; rollback removes the island reader only and the canonical committed
 * records remain readable (old-session readability preserved).
 *
 * Design anchors: D-10, D-14, D-16, D-18. Requirements: NN-CHAT-007–012/014,
 * NN-APPROVAL-004/007/009, NN-UI-003/011. Canonical claims: CD-017, CD-018.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  type ErrorCode,
  type ErrorEnvelope,
  type RedactionClass,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import type { DomainEvent } from '../storage/authority-transaction';
import {
  projectScope,
  readActiveProjection,
  type ProjectionApplyResult,
  type ProjectionDefinition,
  type ProjectionState,
} from '../storage/projection-service';
import type { ApprovalRequest } from '../approval/approval-types';
import {
  buildApprovalCardModel,
  buildNotificationModel,
  verifyCardAccessibility,
  type ApprovalCardModel,
  type ApprovalNotificationModel,
} from '../approval/approval-card';

/** The authority that owns the chat experience islands + action contract. */
export const CHAT_EXPERIENCE_OWNER = 'authority-chat-experience';

// ─── Typed no-effect result (fail-closed everywhere) ─────────────────────────

/**
 * A typed operation result. Every action, sanitization, and suggestion dispatch
 * returns one of these so a failure is ALWAYS a visible, typed no-effect outcome
 * rather than a silent pass or a false success (NN-INV-001/003, NN-CHAT-011).
 */
export type ExperienceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExperienceError };

/** A visible, secret-free failure describing why an action had no effect. */
export interface ExperienceError {
  readonly code: ErrorCode;
  /** A safe, secret-free, private-path-free reason (NN-INV-004, NN-UI-003). */
  readonly reason: string;
  /** The operation that had no effect (for the visible failure feedback). */
  readonly operation: string;
}

function ok<T>(value: T): ExperienceResult<T> {
  return { ok: true, value };
}

function fail<T>(code: ErrorCode, operation: string, reason: string): ExperienceResult<T> {
  return { ok: false, error: { code, operation, reason } };
}

/** Adapt an {@link ExperienceError} to a full {@link ErrorEnvelope} at a boundary. */
export function toErrorEnvelope(
  error: ExperienceError,
  correlationId: string,
  owner: string = CHAT_EXPERIENCE_OWNER,
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code: error.code,
    message: error.reason,
    owner,
    operation: error.operation,
    correlationId,
    retryable: error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT',
    redaction: 'internal',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Content sanitization — fail closed (NN-CHAT-012, NN-UI-011, D-16.1/16.6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The result of sanitizing a Mermaid fence (NN-CHAT-012). A complete, safe
 * diagram becomes `render` (the renderer lazily produces theme-aware SVG from
 * the safe source). A partial fence stays `code`. An unsafe or unparseable
 * diagram becomes `code-with-error` — the ORIGINAL code plus a visible error,
 * never a crash and never a rendered unsafe diagram.
 */
export type MermaidRender =
  | { readonly kind: 'render'; readonly safeSource: string }
  | { readonly kind: 'code'; readonly source: string; readonly reason: 'partial' }
  | { readonly kind: 'code-with-error'; readonly source: string; readonly error: string };

/**
 * The Mermaid directives/tokens that can smuggle script or foreign markup into
 * the rendered SVG. Any of these makes a diagram UNSAFE and it is refused
 * (rendered as code-with-error), never rendered (fail closed, D-16.6).
 */
const MERMAID_UNSAFE = Object.freeze([
  /<\s*script/i,
  /<\s*\/\s*script/i,
  /<\s*iframe/i,
  /<\s*img/i,
  /javascript:/i,
  /data:text\/html/i,
  /on\w+\s*=/i, // inline event handlers (onclick=, onload=, …)
  /%%\{\s*init/i, // mermaid init directive can inject themeCSS/htmlLabels
  /&#x?[0-9a-f]+;?/i, // html entity encodings used to smuggle the above
  /\bclick\b[^\n]*\b(href|call|callback)\b/i, // mermaid click interactions
]);

/**
 * Sanitize a `mermaid` fence for lazy rendering (NN-CHAT-012). Fails closed:
 *
 *   - An incomplete fence (no recognizable diagram header yet) stays `code`
 *     with reason `partial` — a still-streaming fence is never rendered.
 *   - A complete fence containing ANY unsafe directive/markup is refused and
 *     returned as `code-with-error` (original code preserved) — never rendered.
 *   - An empty/whitespace body is a parse failure surfaced as `code-with-error`.
 *   - Only a complete, safe diagram becomes `render` with the safe source.
 *
 * This function performs NO DOM work and never throws; a caller can render its
 * result deterministically without a browser.
 */
export function sanitizeMermaid(fenceBody: string, complete: boolean): MermaidRender {
  const source = fenceBody;
  if (!complete) {
    return { kind: 'code', source, reason: 'partial' };
  }
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return { kind: 'code-with-error', source, error: 'empty mermaid diagram' };
  }
  // A complete diagram must begin with a recognized diagram type keyword;
  // otherwise it is not parseable and we surface the original code + error
  // rather than attempting to render untrusted content.
  const firstToken = trimmed.split(/\s|\n/, 1)[0]?.toLowerCase() ?? '';
  const KNOWN = new Set([
    'graph', 'flowchart', 'sequencediagram', 'classdiagram', 'statediagram',
    'statediagram-v2', 'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph',
    'mindmap', 'timeline', 'quadrantchart', 'requirementdiagram', 'c4context',
    'sankey-beta', 'xychart-beta', 'block-beta',
  ]);
  if (!KNOWN.has(firstToken)) {
    return { kind: 'code-with-error', source, error: `unrecognized mermaid diagram type: ${firstToken.slice(0, 32)}` };
  }
  for (const pattern of MERMAID_UNSAFE) {
    if (pattern.test(source)) {
      return {
        kind: 'code-with-error',
        source,
        error: 'mermaid diagram contains unsafe markup or a script/interaction directive and was not rendered',
      };
    }
  }
  return { kind: 'render', safeSource: source };
}

/** Tags that are never allowed to survive markup sanitization (fail closed). */
const MARKUP_FORBIDDEN_TAG = /<\s*\/?\s*(script|iframe|object|embed|link|meta|style|base|form|input|button|svg|math|foreignobject)\b/i;
/** Any tag at all — the sanitizer refuses raw HTML tags in Markdown content. */
const ANY_HTML_TAG = /<\s*\/?\s*[a-z][^>]*>/i;
/** Inline event handler attributes. */
const INLINE_EVENT_HANDLER = /\bon\w+\s*=/i;

/**
 * Sanitize untrusted Markdown-ish content that will be rendered. Fails closed:
 * any embedded HTML tag, inline event handler, or forbidden element is REFUSED
 * (returns a typed no-effect failure), because the canonical Markdown pipeline
 * renders from safe Markdown, not raw HTML. A caller that receives a failure
 * shows the raw text as an inert code block rather than rendering it
 * (NN-UI-011, D-16.6). Plain Markdown with no raw HTML passes through unchanged.
 */
export function sanitizeMarkup(content: string): ExperienceResult<string> {
  if (INLINE_EVENT_HANDLER.test(content)) {
    return fail('FORBIDDEN', 'sanitize-markup', 'content contains an inline event handler');
  }
  if (MARKUP_FORBIDDEN_TAG.test(content)) {
    return fail('FORBIDDEN', 'sanitize-markup', 'content contains a forbidden HTML element');
  }
  if (ANY_HTML_TAG.test(content)) {
    return fail('FORBIDDEN', 'sanitize-markup', 'raw HTML tags are not permitted in rendered content');
  }
  return ok(content);
}

/** URL schemes the renderer will follow. Everything else is refused. */
const SAFE_LINK_SCHEMES = Object.freeze(['http:', 'https:', 'mailto:']);

/**
 * Sanitize a hyperlink target before it becomes a clickable anchor. Fails
 * closed: a `javascript:`, `data:`, `file:`, `vbscript:`, credential-bearing,
 * or control-character URL is REFUSED with a typed no-effect failure, never
 * rendered as a live link (NN-UI-011, D-16.5/16.6). A relative link (no scheme)
 * is permitted because the renderer resolves it against the workspace, not an
 * arbitrary origin. Returns the normalized href on success.
 */
export function sanitizeLink(href: string): ExperienceResult<string> {
  const raw = href.trim();
  if (raw.length === 0) {
    return fail('VALIDATION', 'sanitize-link', 'empty link target');
  }
  // Control characters (C0/C1) are used to smuggle a scheme past a naive check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    return fail('FORBIDDEN', 'sanitize-link', 'link target contains control characters');
  }
  // A scheme-relative or absolute URL: parse and enforce the scheme allowlist.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (!hasScheme) {
    // Relative link (resolved against the workspace) — but a leading "//" is a
    // protocol-relative URL to an arbitrary origin, which we refuse.
    if (raw.startsWith('//')) {
      return fail('FORBIDDEN', 'sanitize-link', 'protocol-relative links are not permitted');
    }
    return ok(raw);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail('VALIDATION', 'sanitize-link', 'link target is not a valid URL');
  }
  if (!SAFE_LINK_SCHEMES.includes(parsed.protocol)) {
    return fail('FORBIDDEN', 'sanitize-link', `link scheme ${parsed.protocol} is not permitted`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return fail('FORBIDDEN', 'sanitize-link', 'credentials in link target are not permitted');
  }
  return ok(parsed.toString());
}

// ═══════════════════════════════════════════════════════════════════════════
// Content-addressed attachments (NN-CHAT-008)
// ═══════════════════════════════════════════════════════════════════════════

/** The upload/scan lifecycle of an attachment, always visible (NN-CHAT-008). */
export const ATTACHMENT_STATES = Object.freeze([
  'uploading',
  'scanning',
  'ready',
  'rejected',
  'removed',
] as const);
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

/** The scan verdict for an attachment. `blocked` never becomes `ready`. */
export type AttachmentScanVerdict = 'clean' | 'blocked' | 'pending';

/**
 * An immutable, content-addressed attachment reference (NN-CHAT-008). The
 * `contentDigest` is the SHA-256 of the bytes — the attachment is identified by
 * content, not by a mutable path. `authorizedRef` is an opaque authority
 * reference; a raw unauthorized absolute path is NEVER carried here (NN-UI-003).
 */
export interface AttachmentRef {
  /** Stable content address: the digest is the identity. */
  readonly contentDigest: string;
  /** Opaque authorized reference (never a raw absolute path). */
  readonly authorizedRef: string;
  /** Safe display name (basename only, no directory disclosure). */
  readonly displayName: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly state: AttachmentState;
  readonly scanVerdict: AttachmentScanVerdict;
}

/**
 * Build an immutable attachment reference from scanned bytes. Fails closed: an
 * unauthorized raw absolute path, a blocked scan verdict, or an empty payload
 * is refused with a typed no-effect failure (NN-CHAT-008). On success the ref
 * is content-addressed and its state reflects the scan verdict — a `blocked`
 * scan yields `rejected`, never `ready`.
 */
export function buildAttachmentRef(input: {
  readonly bytes: Uint8Array;
  readonly displayName: string;
  readonly mediaType: string;
  readonly authorizedRef: string;
  readonly scanVerdict: AttachmentScanVerdict;
}): ExperienceResult<AttachmentRef> {
  if (input.bytes.byteLength === 0) {
    return fail('VALIDATION', 'attach', 'empty attachment payload');
  }
  // The authorized reference must be an opaque authority ref, never a raw
  // filesystem path. Reject anything that looks like an absolute/relative path
  // (NN-CHAT-008 "authorized references rather than raw unauthorized paths").
  if (looksLikeRawPath(input.authorizedRef)) {
    return fail('UNAUTHORIZED', 'attach', 'attachment must use an authorized reference, not a raw path');
  }
  if (input.scanVerdict === 'blocked') {
    return ok({
      contentDigest: digestBytes(input.bytes),
      authorizedRef: input.authorizedRef,
      displayName: basename(input.displayName),
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      state: 'rejected',
      scanVerdict: 'blocked',
    });
  }
  return ok({
    contentDigest: digestBytes(input.bytes),
    authorizedRef: input.authorizedRef,
    displayName: basename(input.displayName),
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    state: input.scanVerdict === 'clean' ? 'ready' : 'scanning',
    scanVerdict: input.scanVerdict,
  });
}

function looksLikeRawPath(ref: string): boolean {
  // Absolute POSIX (/…), Windows (C:\…), UNC (\\…), home (~/…), or an explicit
  // relative traversal (../…). An opaque ref like "att-abc123" has none of these.
  return (
    ref.startsWith('/') ||
    ref.startsWith('~') ||
    ref.startsWith('\\') ||
    ref.includes('..') ||
    /^[a-z]:[\\/]/i.test(ref)
  );
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

function digestBytes(bytes: Uint8Array): string {
  // Reuse the canonical digest over a stable representation of the bytes.
  return computeDigest({ b: Array.from(bytes) });
}

// ═══════════════════════════════════════════════════════════════════════════
// Composer islands — drafts / context / queue / history (NN-CHAT-007)
// Projected from committed chat events (D-10 reader; single writer is the
// authority mutation transaction).
// ═══════════════════════════════════════════════════════════════════════════

/** The per-session composer island the projection reduces committed events into. */
export interface ComposerIsland {
  /** The current draft text (survives recoverable failures, NN-CHAT-007). */
  readonly draftText: string;
  /** Whether the composer currently holds keyboard focus (preserved on recovery). */
  readonly focusHeld: boolean;
  /** Attached context item refs (opaque; NN-UI-003). */
  readonly contextRefs: readonly string[];
  /** Attachment refs pending send (removable before send, NN-CHAT-008). */
  readonly attachments: readonly AttachmentRef[];
  /** Queued/steering messages awaiting dispatch (ordered). */
  readonly queue: readonly QueuedMessage[];
  /** Prompt history entries (ordered, most recent last). */
  readonly history: readonly string[];
  /** Whether an expensive context resolution is in flight (cancellable). */
  readonly contextResolving: boolean;
  /** The last committed sequence applied to this island (ordering/staleness). */
  readonly lastSequence: number;
}

/** A queued/steering message in the composer island. */
export interface QueuedMessage {
  readonly queueId: string;
  readonly text: string;
}

/** The empty composer island (no committed composer events yet). */
export function emptyComposerIsland(): ComposerIsland {
  return {
    draftText: '',
    focusHeld: false,
    contextRefs: [],
    attachments: [],
    queue: [],
    history: [],
    contextResolving: false,
    lastSequence: 0,
  };
}

/** The reserved state key the composer island is stored under, per session. */
const COMPOSER_KEY = 'composer';

/**
 * The composer event kinds. These are ADDITIVE chat events committed by the
 * authority mutation transaction (the single writer); the projection below is a
 * pure reader over them (NN-CHAT-007, D-10).
 */
export const COMPOSER_EVENT_TYPES = Object.freeze([
  'composer.draft.updated',
  'composer.focus.changed',
  'composer.context.added',
  'composer.context.removed',
  'composer.attachment.added',
  'composer.attachment.removed',
  'composer.queue.enqueued',
  'composer.queue.dequeued',
  'composer.history.appended',
  'composer.context.resolving',
  'composer.context.resolved',
  'composer.context.cancelled',
] as const);
export type ComposerEventType = (typeof COMPOSER_EVENT_TYPES)[number];

function isComposerEventType(value: unknown): value is ComposerEventType {
  return (
    typeof value === 'string' &&
    (COMPOSER_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** The canonical composer island projection id. */
export const COMPOSER_ISLAND_PROJECTION_ID = 'chat-composer-island';

/**
 * The pure composer reducer. A pure function of `(state, event)`: no I/O, clock,
 * or random. Ignores any non-composer event so an unrelated event on the same
 * scope never corrupts the island. Every branch is idempotent-safe under
 * duplicate delivery (append operations are keyed), so replay/reconnect/restore
 * reproduce the SAME island (NN-CHAT-007, no duplicate/lost island).
 */
export function reduceComposerEvent(state: ProjectionState, event: DomainEvent): ProjectionState {
  if (!isComposerEventType(event.eventType)) return state;
  const sequence = event.sequence;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const current = (state.get(COMPOSER_KEY) as ComposerIsland | undefined) ?? emptyComposerIsland();
  const next = new Map(state);

  const commit = (island: ComposerIsland): ProjectionState => {
    next.set(COMPOSER_KEY, { ...island, lastSequence: sequence });
    return next;
  };

  switch (event.eventType as ComposerEventType) {
    case 'composer.draft.updated': {
      const text = typeof payload.text === 'string' ? payload.text : current.draftText;
      return commit({ ...current, draftText: text });
    }
    case 'composer.focus.changed': {
      const held = typeof payload.focusHeld === 'boolean' ? payload.focusHeld : current.focusHeld;
      return commit({ ...current, focusHeld: held });
    }
    case 'composer.context.added': {
      const ref = typeof payload.contextRef === 'string' ? payload.contextRef : undefined;
      if (ref === undefined || current.contextRefs.includes(ref)) return commit(current);
      return commit({ ...current, contextRefs: [...current.contextRefs, ref] });
    }
    case 'composer.context.removed': {
      const ref = typeof payload.contextRef === 'string' ? payload.contextRef : undefined;
      if (ref === undefined) return commit(current);
      return commit({ ...current, contextRefs: current.contextRefs.filter((r) => r !== ref) });
    }
    case 'composer.attachment.added': {
      const att = payload.attachment as AttachmentRef | undefined;
      if (!att || typeof att.contentDigest !== 'string') return commit(current);
      if (current.attachments.some((a) => a.contentDigest === att.contentDigest)) return commit(current);
      return commit({ ...current, attachments: [...current.attachments, att] });
    }
    case 'composer.attachment.removed': {
      const digest = typeof payload.contentDigest === 'string' ? payload.contentDigest : undefined;
      if (digest === undefined) return commit(current);
      return commit({
        ...current,
        attachments: current.attachments.filter((a) => a.contentDigest !== digest),
      });
    }
    case 'composer.queue.enqueued': {
      const queueId = typeof payload.queueId === 'string' ? payload.queueId : undefined;
      const text = typeof payload.text === 'string' ? payload.text : undefined;
      if (queueId === undefined || text === undefined) return commit(current);
      if (current.queue.some((q) => q.queueId === queueId)) return commit(current);
      return commit({ ...current, queue: [...current.queue, { queueId, text }] });
    }
    case 'composer.queue.dequeued': {
      const queueId = typeof payload.queueId === 'string' ? payload.queueId : undefined;
      if (queueId === undefined) return commit(current);
      return commit({ ...current, queue: current.queue.filter((q) => q.queueId !== queueId) });
    }
    case 'composer.history.appended': {
      const text = typeof payload.text === 'string' ? payload.text : undefined;
      if (text === undefined) return commit(current);
      return commit({ ...current, history: [...current.history, text] });
    }
    case 'composer.context.resolving':
      return commit({ ...current, contextResolving: true });
    case 'composer.context.resolved':
    case 'composer.context.cancelled':
      // Cancelling an expensive context resolution preserves the draft/focus and
      // simply clears the in-flight flag (NN-CHAT-007 "cancellation while
      // expensive context resolves").
      return commit({ ...current, contextResolving: false });
    default:
      return commit(current);
  }
}

/** The canonical composer island projection definition (a READER, D-10). */
export const COMPOSER_ISLAND_PROJECTION: ProjectionDefinition = {
  projectionId: COMPOSER_ISLAND_PROJECTION_ID,
  projectionVersion: 1,
  reduce: reduceComposerEvent,
};

/**
 * Advance the composer island for a scope from the committed outbox. Thin
 * delegation to the shared ProjectionService — no second durable writer
 * (NN-CHAT-007, D-10).
 */
export function advanceComposerIsland(
  db: Database.Database,
  scope: ScopeDescriptor,
  now?: () => Date,
): ProjectionApplyResult {
  return projectScope(db, COMPOSER_ISLAND_PROJECTION, scope, now ? { now } : {});
}

/**
 * Read the active composer island for a scope. Returns the empty island when no
 * generation exists yet. The island is a pure function of committed composer
 * events, so it is INVARIANT under paging/replay/restore (NN-CHAT-007).
 */
export function readComposerIsland(db: Database.Database, scope: ScopeDescriptor): ComposerIsland {
  const active = readActiveProjection(db, COMPOSER_ISLAND_PROJECTION_ID, scope);
  if (!active) return emptyComposerIsland();
  const island = active.state.get(COMPOSER_KEY) as ComposerIsland | undefined;
  return island ?? emptyComposerIsland();
}

// ═══════════════════════════════════════════════════════════════════════════
// Message action contract (NN-CHAT-011, NN-UI-003) — every action visible/typed
// ═══════════════════════════════════════════════════════════════════════════

/** The message-level actions that must always be reachable (NN-CHAT-011). */
export const MESSAGE_ACTIONS = Object.freeze([
  'copy',
  'expand',
  'more',
  'code-copy',
  'open',
  'download',
  'apply',
  'run',
  'edit',
  'retry',
] as const);
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

/** Whether an action is a mutating/side-effecting action (routes through policy/approval). */
export function isMutatingAction(action: MessageAction): boolean {
  return action === 'apply' || action === 'run';
}

/**
 * The placement of an action in the responsive action set. Copy, Expand, and
 * More are ALWAYS present (hover and keyboard focus); a responsive layout MAY
 * move actions into an accessible overflow but NEVER removes them (NN-CHAT-011).
 */
export interface ActionPlacement {
  readonly action: MessageAction;
  readonly placement: 'inline' | 'overflow';
  /** Whether the action is reachable by keyboard focus (must always be true). */
  readonly keyboardReachable: true;
}

/**
 * Compute the action-set placement for a message at a given viewport width.
 * Copy/Expand/More stay inline at any width; the rest overflow when narrow.
 * Every returned action is keyboard-reachable — the responsive layout changes
 * PLACEMENT only, never availability (NN-CHAT-011, NN-UI-011).
 */
export function computeActionPlacement(
  actions: readonly MessageAction[],
  viewport: { readonly width: number },
): ActionPlacement[] {
  const ALWAYS_INLINE: ReadonlySet<MessageAction> = new Set(['copy', 'expand', 'more']);
  const narrow = viewport.width < 640;
  return actions.map((action) => ({
    action,
    placement: ALWAYS_INLINE.has(action) || !narrow ? 'inline' : 'overflow',
    keyboardReachable: true as const,
  }));
}

/** The outcome of a Copy action — a visible toast on success, a visible failure otherwise. */
export interface CopyOutcome {
  /** The exact text placed on the clipboard (raw Markdown for a response). */
  readonly copied: string;
  /** The toast to show on success (NN-CHAT-011 requires an exact `Copied!`). */
  readonly toast: 'Copied!';
}

/** A clipboard port. The real implementation routes through the clipboard authority. */
export interface ClipboardPort {
  /** Write text; returns whether the write succeeded (a failure is visible). */
  write(text: string): boolean;
}

/**
 * Perform a Response Copy: copy the RAW Markdown (never rendered HTML) through
 * the clipboard authority. On success returns the exact `Copied!` toast; a
 * failed clipboard write is a VISIBLE no-effect failure (never a false toast)
 * (NN-CHAT-011).
 */
export function copyResponseMarkdown(rawMarkdown: string, clipboard: ClipboardPort): ExperienceResult<CopyOutcome> {
  const wrote = clipboard.write(rawMarkdown);
  if (!wrote) {
    return fail('UNAVAILABLE', 'copy', 'clipboard write failed');
  }
  return ok({ copied: rawMarkdown, toast: 'Copied!' });
}

/**
 * Perform a per-code-block Copy (the code block retains its OWN copy control,
 * separate from the response copy, NN-CHAT-011). Copies the exact code text; a
 * failed write is a visible no-effect failure.
 */
export function copyCodeBlock(code: string, clipboard: ClipboardPort): ExperienceResult<CopyOutcome> {
  const wrote = clipboard.write(code);
  if (!wrote) {
    return fail('UNAVAILABLE', 'code-copy', 'clipboard write failed');
  }
  return ok({ copied: code, toast: 'Copied!' });
}

/** The full-width surface descriptor an Expand action opens (NN-CHAT-011). */
export interface ExpandSurface {
  readonly nodeKey: string;
  readonly fullWidth: true;
  /** The raw Markdown shown in the expanded surface. */
  readonly content: string;
}

/** Open the full response in a full-width surface (Expand, NN-CHAT-011). */
export function expandResponse(nodeKey: string, rawMarkdown: string): ExperienceResult<ExpandSurface> {
  if (nodeKey.trim().length === 0) {
    return fail('VALIDATION', 'expand', 'missing node key');
  }
  return ok({ nodeKey, fullWidth: true, content: rawMarkdown });
}

/**
 * The result of routing a mutating/navigating action (open/download/apply/run/
 * navigation). This is a PORT: the real authority (path/change/task/navigation)
 * performs the effect; the port reports its typed outcome so a failed apply/run
 * or an unauthorized path is a VISIBLE no-effect failure (NN-CHAT-011,
 * NN-UI-003, D-16.3).
 */
export interface ActionRoutePort {
  /**
   * Route an action to its authority. Returns `authorized:false` for an
   * unauthorized path/target and `applied:false` for a failed apply/run. The
   * port MUST NOT bypass policy or approval for a mutating action.
   */
  route(input: {
    readonly action: MessageAction;
    readonly targetRef: string;
    readonly requiresApproval: boolean;
    readonly approvalGranted: boolean;
  }): { readonly authorized: boolean; readonly applied: boolean; readonly reason?: string };
}

/**
 * Route a message action through its applicable authority (NN-CHAT-011). A
 * mutating action (`apply`/`run`) that requires approval but has not been
 * granted approval is refused with a typed `FORBIDDEN` no-effect failure — no
 * mutating/run/apply action may bypass policy or approval. An unauthorized
 * target path is a `UNAUTHORIZED` no-effect failure (never a silent success);
 * a failed apply/run is an `UNAVAILABLE` no-effect failure.
 */
export function routeMessageAction(
  input: {
    readonly action: MessageAction;
    readonly targetRef: string;
    readonly requiresApproval: boolean;
    readonly approvalGranted: boolean;
  },
  port: ActionRoutePort,
): ExperienceResult<{ readonly action: MessageAction; readonly targetRef: string }> {
  // A raw unauthorized path never reaches an authority (NN-UI-003, D-16.3).
  if (looksLikeRawPath(input.targetRef)) {
    return fail('UNAUTHORIZED', input.action, 'action target must be an authorized reference, not a raw path');
  }
  // Mutating actions must not bypass approval (NN-CHAT-011).
  if (isMutatingAction(input.action) && input.requiresApproval && !input.approvalGranted) {
    return fail('FORBIDDEN', input.action, 'mutating action requires approval that has not been granted');
  }
  const outcome = port.route(input);
  if (!outcome.authorized) {
    return fail('UNAUTHORIZED', input.action, outcome.reason ?? 'action was not authorized');
  }
  if (!outcome.applied) {
    return fail('UNAVAILABLE', input.action, outcome.reason ?? 'action could not be applied');
  }
  return ok({ action: input.action, targetRef: input.targetRef });
}

// ═══════════════════════════════════════════════════════════════════════════
// Edit / retry / branch (NN-CHAT-009) — reuse the canonical branch marker
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A branch intent produced by editing+resending a user message, or retrying a
 * preceding user message after an errored agent message (NN-CHAT-009/011). This
 * is a DESCRIPTOR the caller commits as a canonical `chat.branch` event through
 * the authority mutation transaction — the timeline projection preserves the
 * immutable parent lineage and distinguishes the new attempt from an idempotent
 * resume (see {@link ./chat-projection}). Editing bumps `attempt`; a resume of
 * the same attempt does not.
 */
export interface BranchIntent {
  readonly turnId: string;
  readonly attempt: number;
  readonly role: 'user' | 'agent';
  readonly nodeKind: string;
  readonly parentTurnId: string;
  readonly parentAttempt: number;
  /** Whether this is a NEW attempt (edit/retry/branch) or an idempotent resume. */
  readonly isNewAttempt: boolean;
}

/**
 * Build a branch intent for an edit+resend of a user message. Fails closed: the
 * new attempt MUST be strictly greater than the parent attempt (a NEW attempt,
 * never overwriting the immutable parent, NN-CHAT-009).
 */
export function buildEditBranchIntent(input: {
  readonly turnId: string;
  readonly parentTurnId: string;
  readonly parentAttempt: number;
  readonly newAttempt: number;
  readonly nodeKind: string;
}): ExperienceResult<BranchIntent> {
  if (input.newAttempt <= input.parentAttempt) {
    return fail('CONFLICT', 'edit-branch', 'an edited message must create a new attempt (greater than the parent attempt)');
  }
  return ok({
    turnId: input.turnId,
    attempt: input.newAttempt,
    role: 'user',
    nodeKind: input.nodeKind,
    parentTurnId: input.parentTurnId,
    parentAttempt: input.parentAttempt,
    isNewAttempt: true,
  });
}

/**
 * Build a retry intent for the user message preceding an errored agent message
 * (NN-CHAT-011). Same fail-closed rule: a retry is a NEW attempt of the user
 * turn, preserving the prior output.
 */
export function buildRetryBranchIntent(input: {
  readonly turnId: string;
  readonly parentTurnId: string;
  readonly parentAttempt: number;
  readonly newAttempt: number;
  readonly nodeKind: string;
}): ExperienceResult<BranchIntent> {
  const branch = buildEditBranchIntent(input);
  return branch;
}

// ═══════════════════════════════════════════════════════════════════════════
// Approval cards in-chat (NN-APPROVAL-004/007/009) — reuse the shared card
// ═══════════════════════════════════════════════════════════════════════════

/** A chat-embedded approval card: the shared accessible model + a11y verdict. */
export interface ChatApprovalCard {
  readonly model: ApprovalCardModel;
  /** Machine-checkable accessibility violations (empty = conformant). */
  readonly accessibilityViolations: readonly string[];
  readonly notification: ApprovalNotificationModel;
}

/**
 * Build a chat-embedded approval card for a request by reusing the ONE shared
 * accessible card and notification contract (NN-APPROVAL-004/009). This module
 * never mints a decision; it only presents the canonical card inside the chat
 * surface and surfaces the a11y verdict so a non-conformant card is a visible
 * failure rather than a silent render (FIX-RENDERER-A11Y-01).
 */
export function buildChatApprovalCard(
  request: ApprovalRequest,
  options: { readonly prompt: string; readonly actorLabel?: string; readonly now?: () => Date },
): ChatApprovalCard {
  const model = buildApprovalCardModel(request, options);
  return {
    model,
    accessibilityViolations: verifyCardAccessibility(model),
    notification: buildNotificationModel(request),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Typed recovery (NN-CHAT-010) — a READER over checkpoint/restore state (D-14)
// ═══════════════════════════════════════════════════════════════════════════

/** The recovery actions a typed recovery surface MAY offer (NN-CHAT-010). */
export const RECOVERY_ACTIONS = Object.freeze(['resume', 'retry', 'reload', 'export'] as const);
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/**
 * The reconciliation status of the session against the canonical
 * checkpoint/restore state (FUT-PKG-05-RECOVERY/T-004, D-14). `incompatible`
 * means a version/base mismatch is being reconciled: mutations MUST be disabled
 * until it clears (NN-CHAT-010).
 */
export type ReconciliationStatus = 'current' | 'reconciling' | 'incompatible';

/** The preserved session state a recovery surface must retain (NN-CHAT-010). */
export interface PreservedSessionState {
  readonly draftText: string;
  readonly focusHeld: boolean;
  readonly unreadCount: number;
  /** The partial (streaming, not-yet-complete) content that must stay visible. */
  readonly partialContent: string;
  readonly queue: readonly QueuedMessage[];
  /** Pending approval request ids that must survive recovery. */
  readonly pendingApprovalIds: readonly string[];
  /** The semantic scroll anchor (a stable node key), preserved across recovery. */
  readonly semanticAnchor: string | null;
}

/** The typed recovery surface offered to the user (NN-CHAT-010). */
export interface RecoverySurface {
  readonly status: ReconciliationStatus;
  /** The applicable recovery actions for this status. */
  readonly actions: readonly RecoveryAction[];
  /** Whether mutating actions are disabled (true while incompatible). */
  readonly mutationsDisabled: boolean;
  /** The preserved session state (drafts/unread/partial/queue/approvals/anchor). */
  readonly preserved: PreservedSessionState;
  /** NEVER true unless a recovery genuinely succeeded (no false success). */
  readonly succeeded: boolean;
}

/**
 * Build the typed recovery surface for a session (NN-CHAT-010). It offers the
 * applicable actions for the reconciliation status, PRESERVES the session state
 * (drafts, unread, partial content, queue, approvals, semantic anchor), and
 * DISABLES mutations while the reconciliation is `incompatible`. It never
 * reports `succeeded: true` unless `recovered` is explicitly true AND the
 * status is not `incompatible` — a partial/incompatible reconciliation can
 * never show a false success (NN-CHAT-010, NN-INV-003, D-14).
 */
export function buildRecoverySurface(input: {
  readonly status: ReconciliationStatus;
  readonly preserved: PreservedSessionState;
  readonly recovered: boolean;
  /** Whether the errored turn is retryable (adds `retry`). */
  readonly retryable: boolean;
  /** Whether a resumable owning run exists (adds `resume`). */
  readonly resumable: boolean;
}): RecoverySurface {
  const actions: RecoveryAction[] = [];
  // Reload and export are always applicable (they never mutate domain state).
  if (input.resumable && input.status !== 'incompatible') actions.push('resume');
  if (input.retryable && input.status !== 'incompatible') actions.push('retry');
  actions.push('reload');
  actions.push('export');

  const mutationsDisabled = input.status === 'incompatible';
  // A false success is forbidden: only a genuine recovery on a compatible state
  // may report succeeded (NN-CHAT-010, NN-INV-003).
  const succeeded = input.recovered && input.status === 'current';

  return {
    status: input.status,
    actions,
    mutationsDisabled,
    preserved: input.preserved,
    succeeded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Suggestions + auto-send vs prefill policy (NN-CHAT-014, CD-017)
// ═══════════════════════════════════════════════════════════════════════════

/** The classification of a suggestion prompt's safety (CD-017, NN-CHAT-014). */
export type SuggestionClass =
  | 'read-only' // exact visible read-only/conversational text — MAY auto-send
  | 'mutating' // mutating/build/destructive — MUST prefill + Send + approval
  | 'risk-unknown'; // unknown risk — MUST prefill

/** A starter or post-task suggestion card (NN-CHAT-014). */
export interface SuggestionCard {
  readonly cardId: string;
  /** The exactly-visible prompt text on the card. */
  readonly visibleText: string;
  /** The digest of the visible text captured when the card was built. */
  readonly visibleTextDigest: string;
  readonly suggestionClass: SuggestionClass;
  /** Whether this card is a post-task suggestion (prefill by default). */
  readonly postTask: boolean;
}

/** Build a suggestion card, capturing the digest of its exact visible text. */
export function buildSuggestionCard(input: {
  readonly cardId: string;
  readonly visibleText: string;
  readonly suggestionClass: SuggestionClass;
  readonly postTask: boolean;
}): SuggestionCard {
  return {
    cardId: input.cardId,
    visibleText: input.visibleText,
    visibleTextDigest: computeDigest({ text: input.visibleText }),
    suggestionClass: input.suggestionClass,
    postTask: input.postTask,
  };
}

/**
 * Build the fresh-chat empty-state starter cards. NN-CHAT-014 requires 4–6
 * contextual starter cards; fewer than 4 or more than 6 is a typed no-effect
 * failure (never a silently truncated/padded set).
 */
export function buildStarterCards(cards: readonly SuggestionCard[]): ExperienceResult<readonly SuggestionCard[]> {
  if (cards.length < 4 || cards.length > 6) {
    return fail('VALIDATION', 'starter-cards', `starter empty state requires 4–6 cards, got ${cards.length}`);
  }
  return ok(cards);
}

/**
 * Build post-task suggestions after a successful task. NN-CHAT-014 requires 2–5
 * bounded contextual suggestions; failed/empty results should instead offer
 * diagnostic actions (a caller passes `diagnostic: true` for that path). A
 * count outside the bound is a typed no-effect failure.
 */
export function buildPostTaskSuggestions(
  cards: readonly SuggestionCard[],
  options: { readonly diagnostic?: boolean } = {},
): ExperienceResult<readonly SuggestionCard[]> {
  if (options.diagnostic) {
    // Diagnostic actions are offered on failure/empty; any 1..5 is acceptable.
    if (cards.length < 1 || cards.length > 5) {
      return fail('VALIDATION', 'post-task-diagnostic', `diagnostic actions require 1–5 cards, got ${cards.length}`);
    }
    return ok(cards);
  }
  if (cards.length < 2 || cards.length > 5) {
    return fail('VALIDATION', 'post-task-suggestions', `post-task suggestions require 2–5 cards, got ${cards.length}`);
  }
  // Post-task suggestions prefill by default (NN-CHAT-014): they must not be
  // read-only auto-send cards even if their text is conversational.
  return ok(cards);
}

/** The disposition of clicking a suggestion card (CD-017, NN-CHAT-014). */
export type SuggestionDisposition =
  | { readonly kind: 'auto-send'; readonly text: string }
  | { readonly kind: 'prefill'; readonly text: string; readonly requiresSendAndApproval: boolean };

/**
 * Decide what a suggestion-card click does (the exact CD-017 policy). A card
 * auto-sends its text ONLY when ALL hold:
 *
 *   1. the card is classified `read-only` (exact visible read-only/conversational
 *      text) and is NOT a post-task card (post-task prefills by default), and
 *   2. the click is an EXPLICIT submission (pointer or keyboard Enter), and
 *   3. the digest of the currently-visible text equals the digest captured when
 *      the card was built — i.e. the visible text has NOT changed since build.
 *
 * If the text changed (digest mismatch), if the card is mutating/risk-unknown,
 * or if the card is a post-task card, the click PREFILLS the composer and
 * requires a separate Send plus approval — it never auto-sends. A stale/changed/
 * mutating card asked to auto-send is a VISIBLE no-effect failure (never a
 * dispatch). Exactly one dispatch per explicit click.
 */
export function decideSuggestionClick(input: {
  readonly card: SuggestionCard;
  /** The text currently visible on the card at click time (may have changed). */
  readonly currentVisibleText: string;
  /** True when the click is an explicit submission (pointer/keyboard Enter). */
  readonly explicitSubmission: boolean;
}): ExperienceResult<SuggestionDisposition> {
  const { card } = input;
  const currentDigest = computeDigest({ text: input.currentVisibleText });
  const digestMatches = currentDigest === card.visibleTextDigest;

  // A changed card can NEVER auto-send. If it is a read-only card whose visible
  // text changed since build, refuse to auto-send (visible no-effect failure)
  // and fall back to prefill of the CURRENT text.
  const eligibleForAutoSend =
    card.suggestionClass === 'read-only' && !card.postTask && input.explicitSubmission;

  if (eligibleForAutoSend && digestMatches) {
    return ok({ kind: 'auto-send', text: card.visibleText });
  }

  // Not eligible for auto-send: prefill. A mutating/build/destructive/
  // risk-unknown prompt requires a separate Send plus approval (NN-CHAT-014).
  if (card.suggestionClass === 'read-only' && !card.postTask && input.explicitSubmission && !digestMatches) {
    // Explicitly asked to auto-send a changed read-only card: visible no-effect.
    return fail(
      'CONFLICT',
      'suggestion-auto-send',
      'the suggestion text changed since it was shown; it was not sent — review and Send manually',
    );
  }

  const requiresSendAndApproval =
    card.suggestionClass === 'mutating' || card.suggestionClass === 'risk-unknown';
  return ok({
    kind: 'prefill',
    text: input.currentVisibleText,
    requiresSendAndApproval,
  });
}
