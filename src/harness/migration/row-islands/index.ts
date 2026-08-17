/**
 * Row Islands — Typed Presentation Adapters for Strangler Migration
 *
 * Provides typed row island adapters that route existing rendering helpers
 * (Markdown, code, diff, diagram, image) through pure typed contracts.
 * Replaces tool cards, turn status rows, collaboration takeovers, queue entries,
 * and attachment items with typed dispatchers that operate on structured
 * projection data.
 *
 * Key design invariants:
 * - Tool rendering dispatches on intent.kind, never tool names
 * - Turn status renders from projected Turn_Activity_State exclusively
 * - Collaboration renders from projected takeover contracts
 * - Queue dock renders from projected Turn_Controller inbox entries
 * - Attachment renders from projected Attachment_Service states
 * - All mutations route through owning authority command ports
 * - Unsupported or invalid inputs produce the safe generic fallback
 * - All output is sanitized and accessibility-labeled
 * - Existing visible capabilities are retained through typed contracts
 *
 * Requirements: 13.8, 35.3–35.6, 35.11, 36.1–36.17, 37.1–37.17, 38.1–38.16, 39.1–39.18, 41.1–41.15
 */

// Types
export type {
  RowIslandKind,
  RowIslandOutput,
  RowIsland,
  ToolRowIslandInput,
  TurnStatusRowIslandInput,
  CollaborationRowIslandInput,
  QueueDockRowIslandInput,
  AttachmentRowIslandInput,
  LegacyToolCardData,
  LegacyTurnStatusData,
  LegacyCollaborationData,
  LegacyQueueEntryData,
  LegacyAttachmentData,
} from './types';

// Tool Row Island
export {
  ToolRowIslandAdapter,
  toolRowIsland,
} from './tool-row-island';

// Turn Status Row Island
export {
  TurnStatusRowIslandAdapter,
  turnStatusRowIsland,
} from './turn-status-row-island';

// Collaboration Row Island
export {
  CollaborationRowIslandAdapter,
  collaborationRowIsland,
} from './collaboration-row-island';

// Queue Dock Row Island
export {
  QueueDockRowIslandAdapter,
  queueDockRowIsland,
} from './queue-dock-row-island';

// Attachment Row Island
export {
  AttachmentRowIslandAdapter,
  attachmentRowIsland,
} from './attachment-row-island';

// Registry and Coordinator
export {
  RowIslandRegistry,
  rowIslandRegistry,
  type RowIslandDispatchInput,
} from './row-island-registry';
