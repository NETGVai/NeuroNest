/**
 * Retirement Manifest
 *
 * Catalogs each legacy code path targeted for removal along with its
 * canonical replacement. Each entry maps a legacy pattern (global window
 * state, inline event handlers, DOM-wide querySelector calls, inferred
 * error/success detection, tool-name-based rendering branching, and
 * renderer-owned durable mutations) to the new architecture path that
 * replaces it.
 *
 * The manifest is consumed by the retirement gate (RetirementGate) to
 * determine which legacy paths are eligible for removal once their
 * respective gate conditions are satisfied.
 *
 * Requirements: 1.1–1.6, 13.8, 35.12–35.13, 45.15, 47.13, 47.19
 */

// ─── Legacy Path Categories ─────────────────────────────────────

/**
 * Identifies the category of legacy code path being retired.
 */
export type LegacyPathCategory =
  | 'global_window_state'
  | 'inline_event_handlers'
  | 'dom_wide_queries'
  | 'inferred_error_detection'
  | 'inferred_success_detection'
  | 'tool_name_parsing'
  | 'renderer_owned_durable_mutations';

/**
 * A single entry in the retirement manifest describing a legacy path,
 * its replacement, and which gate conditions must pass for retirement.
 */
export interface RetirementManifestEntry {
  /** Unique identifier for this legacy path */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category of legacy pattern */
  category: LegacyPathCategory;
  /** Description of the legacy behavior being retired */
  legacyDescription: string;
  /** The canonical replacement architecture */
  replacement: string;
  /** Source file(s) containing the legacy code (for traceability) */
  legacySourceHints: string[];
  /** Which gate conditions must pass before this path can be removed */
  requiredGates: GateConditionKind[];
  /** Relevant requirements from the spec */
  requirements: string[];
}

/**
 * The kinds of gate conditions that must pass before a legacy path
 * is eligible for removal.
 */
export type GateConditionKind =
  | 'parity'
  | 'accessibility'
  | 'performance'
  | 'compatibility';

// ─── Retirement Manifest ────────────────────────────────────────

/**
 * The complete retirement manifest. Each entry documents one legacy
 * path, its replacement, and required gate conditions.
 */
export const RETIREMENT_MANIFEST: readonly RetirementManifestEntry[] = [
  // ── Global Window State ──────────────────────────────────────
  {
    id: 'gws-chat-state',
    name: 'Global window.chatState',
    category: 'global_window_state',
    legacyDescription:
      'Mutable global window.chatState object holding session, messages, streaming flags, and turn tracking accessible from any renderer module.',
    replacement:
      'Per-session ChatProjectionEnvelope consumed from Projection_Service via typed command/query ports. Ephemeral UI state (focus, disclosure) held in component-local stores.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts', 'src/renderer/chat-streaming.ts'],
    requiredGates: ['parity', 'accessibility', 'performance', 'compatibility'],
    requirements: ['1.1', '1.3', '35.12', '35.13'],
  },
  {
    id: 'gws-composer-globals',
    name: 'Global composer mutable state',
    category: 'global_window_state',
    legacyDescription:
      'Mutable module-level variables for attached files, slash state, processing flag, selection, and history used across composer modules.',
    replacement:
      'DraftTransactionStore with per-session transactions behind ComposerGlobalsShim (task 11.4). No renderer-owned durable state.',
    legacySourceHints: ['src/renderer/chat-input-enhanced.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['1.3', '35.13'],
  },
  {
    id: 'gws-streaming-buffer',
    name: 'Global streaming buffer state',
    category: 'global_window_state',
    legacyDescription:
      'Module-level mutable buffer holding partial streaming tokens, pending tool results, and streaming status flags.',
    replacement:
      'Durable partial-output projections from StreamingStateAdapter (task 11.6). Transient cache is keyed by node revision and discarded after commit.',
    legacySourceHints: ['src/renderer/chat-streaming.ts'],
    requiredGates: ['parity', 'performance'],
    requirements: ['35.13', '45.15'],
  },

  // ── Inline Event Handlers ────────────────────────────────────
  {
    id: 'ieh-onclick-attributes',
    name: 'Inline onclick/onkeydown attributes',
    category: 'inline_event_handlers',
    legacyDescription:
      'HTML-inlined onclick, onkeydown, onchange, and onsubmit attributes on dynamically generated chat elements.',
    replacement:
      'Declarative event bindings in typed row components with delegated listeners attached to stable container elements.',
    legacySourceHints: ['src/renderer/chat-message-actions.ts', 'src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'accessibility'],
    requirements: ['1.4', '35.12'],
  },
  {
    id: 'ieh-inline-handlers',
    name: 'Inline handler strings in innerHTML',
    category: 'inline_event_handlers',
    legacyDescription:
      'Event handler code embedded in innerHTML template strings for tool cards and action buttons.',
    replacement:
      'Typed Render_Intent components that bind events through the component lifecycle, not through HTML string evaluation.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'accessibility', 'performance'],
    requirements: ['1.4', '13.8', '35.12'],
  },

  // ── DOM-Wide Queries ─────────────────────────────────────────
  {
    id: 'dwq-document-selectors',
    name: 'document.querySelector/querySelectorAll for chat elements',
    category: 'dom_wide_queries',
    legacyDescription:
      'Unscoped document.querySelector and document.querySelectorAll calls to find chat messages, tool cards, scroll containers, and action bars.',
    replacement:
      'Keyed row lifecycle through WindowedTimelineEngine. Elements are identified by stable Chat_Node keys, not by DOM traversal.',
    legacySourceHints: [
      'src/renderer/chat-enhancements.ts',
      'src/renderer/chat-scroll-controller.ts',
      'src/renderer/chat-message-actions.ts',
    ],
    requiredGates: ['parity', 'accessibility', 'performance', 'compatibility'],
    requirements: ['1.4', '35.12', '47.13'],
  },
  {
    id: 'dwq-mutation-observers',
    name: 'MutationObserver-based DOM watching',
    category: 'dom_wide_queries',
    legacyDescription:
      'MutationObserver instances watching for added/removed child nodes to trigger action bar attachment, unread counting, and scroll behavior.',
    replacement:
      'Projection-driven keyed windowing (KeyedWindowingAdapter). Lifecycle events fire from projected state changes, not from DOM mutations.',
    legacySourceHints: ['src/renderer/chat-scroll-controller.ts'],
    requiredGates: ['parity', 'performance'],
    requirements: ['35.12', '47.13', '47.19'],
  },

  // ── Inferred Error/Success Detection ─────────────────────────
  {
    id: 'ied-error-inference',
    name: 'Inferred error detection from content patterns',
    category: 'inferred_error_detection',
    legacyDescription:
      'Heuristic detection of errors by scanning assistant message content for keywords like "error", "failed", "exception", or red-highlighted spans.',
    replacement:
      'Typed error events in Session_Log with structured error classification. Chat_Nodes carry explicit error state from projections.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['1.5', '13.8'],
  },
  {
    id: 'isd-success-inference',
    name: 'Inferred success detection from content patterns',
    category: 'inferred_success_detection',
    legacyDescription:
      'Heuristic detection of success by scanning tool results for keywords like "success", "completed", or checking for non-error exit codes inferred from text.',
    replacement:
      'Typed Canonical_Tool_Value with explicit outcome status. Render_Intent communicates success/failure through structured data, not content scanning.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['1.5', '13.8'],
  },

  // ── Tool-Name Parsing ────────────────────────────────────────
  {
    id: 'tnp-render-branching',
    name: 'Tool-name-based rendering branching',
    category: 'tool_name_parsing',
    legacyDescription:
      'Switch/if-else chains that select rendering templates based on tool name strings (e.g., "read_file" → file viewer, "execute_bash" → terminal view).',
    replacement:
      'Pure Render_Intent function owned by Tool_Registry. The renderer selects presentation from Render_Intent kind without evaluating tool names (Requirement 13.8).',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'accessibility', 'compatibility'],
    requirements: ['13.8', '35.12'],
  },
  {
    id: 'tnp-status-parsing',
    name: 'Tool-name-based status inference',
    category: 'tool_name_parsing',
    legacyDescription:
      'Inferring tool execution status (running, completed, failed) by parsing tool name and matching against known patterns rather than reading typed status.',
    replacement:
      'Turn_Activity_State and typed tool lifecycle events in the projection. Status is a projected field, never inferred from names.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['13.8'],
  },

  // ── Renderer-Owned Durable Mutations ─────────────────────────
  {
    id: 'rdm-session-writes',
    name: 'Renderer-owned session state writes',
    category: 'renderer_owned_durable_mutations',
    legacyDescription:
      'Renderer modules directly writing to session storage (message edits, branch creation, retry state) without routing through owning authority.',
    replacement:
      'All durable mutations routed through Session_Log via owning authorities (Session_Store, Turn_Controller). Renderer issues typed commands with idempotency keys.',
    legacySourceHints: ['src/renderer/chat-message-actions.ts'],
    requiredGates: ['parity', 'accessibility', 'performance', 'compatibility'],
    requirements: ['1.1', '1.4', '35.13'],
  },
  {
    id: 'rdm-tool-state',
    name: 'Renderer-owned tool result mutations',
    category: 'renderer_owned_durable_mutations',
    legacyDescription:
      'Renderer modules creating or mutating tool result records directly (e.g., marking tool calls as expanded, pinning results) in a way that becomes a competing source of truth.',
    replacement:
      'Canonical_Tool_Value is immutable once committed. Presentation preferences (expand/collapse, pin) are ephemeral UI state in component-local stores.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['1.4', '13.8', '35.13'],
  },
  {
    id: 'rdm-queue-mutations',
    name: 'Renderer-owned queue/inbox mutations',
    category: 'renderer_owned_durable_mutations',
    legacyDescription:
      'Renderer directly modifying turn queue or inbox state without authority routing.',
    replacement:
      'Queue_Dock projection consumed read-only. Queue mutations are authority-routed commands through Turn_Controller.',
    legacySourceHints: ['src/renderer/chat-enhancements.ts'],
    requiredGates: ['parity', 'compatibility'],
    requirements: ['1.4', '35.13'],
  },
] as const;

// ─── Manifest Query Helpers ─────────────────────────────────────

/**
 * Get all manifest entries for a specific category.
 */
export function getEntriesByCategory(category: LegacyPathCategory): RetirementManifestEntry[] {
  return RETIREMENT_MANIFEST.filter(e => e.category === category);
}

/**
 * Get all manifest entries that require a specific gate condition.
 */
export function getEntriesByGate(gate: GateConditionKind): RetirementManifestEntry[] {
  return RETIREMENT_MANIFEST.filter(e => e.requiredGates.includes(gate));
}

/**
 * Get a specific manifest entry by ID.
 */
export function getEntryById(id: string): RetirementManifestEntry | undefined {
  return RETIREMENT_MANIFEST.find(e => e.id === id);
}

/**
 * Get all unique categories present in the manifest.
 */
export function getAllCategories(): LegacyPathCategory[] {
  return [...new Set(RETIREMENT_MANIFEST.map(e => e.category))];
}

/**
 * Get all legacy path IDs.
 */
export function getAllEntryIds(): string[] {
  return RETIREMENT_MANIFEST.map(e => e.id);
}
