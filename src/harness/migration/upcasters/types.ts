/**
 * Legacy Data Upcasters — Type definitions for version-to-version upcasting
 * and explicit downcast compatibility views.
 *
 * Key principles:
 * - Upcasters are pure functions (no side effects, no mutations)
 * - Version-to-version: each upcaster transforms from exactly one version to the next
 * - Source payloads are NEVER overwritten — upcasters produce new derived objects
 * - Downcast views are explicit and read-only projections
 *
 * Requirements: 3.3, 28.4–28.9, 31.9, 32.4, 44.13
 */

import type { SessionEventV1 } from '../../contracts/event.js';

// ─── Legacy Data Formats ────────────────────────────────────────

/**
 * Legacy TimelineRecord format as stored in `session_timeline_records` table.
 * This is the pre-canonical format used before the harness integration.
 */
export interface LegacyTimelineRecord {
  id: string;
  sessionId: string;
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown>;
  linkedChangeSetIds: string[];
  linkedToolEventIds: string[];
  createdAt: string;
}

/**
 * Legacy message format from the session exporter/parallel sessions.
 */
export interface LegacyMessage {
  id: string;
  role: string;
  content: string;
  agent?: string;
  toolCalls?: unknown;
  createdAt: string;
}

/**
 * Legacy branch record from the session-branch-service.
 */
export interface LegacyBranchRecord {
  id: string;
  sessionId: string;
  parentBranchId?: string;
  parentSequence?: number;
  name?: string;
  createdAt: string;
  events: LegacyBranchEvent[];
}

/**
 * Legacy branch event from session_branch_events table.
 */
export interface LegacyBranchEvent {
  id: string;
  sequenceNumber: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Legacy session metadata (pre-canonical).
 */
export interface LegacySessionMetadata {
  id: string;
  projectId: string;
  title: string;
  activeTaskId: string | null;
  agentId: string | null;
  selectedModelRoles: Record<string, string>;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'quarantined';
  lastSequenceNumber: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Upcast Result ──────────────────────────────────────────────

/**
 * Result of an upcast operation. Contains the derived canonical event
 * plus provenance metadata linking back to the source record.
 */
export interface UpcastResult {
  /** The derived canonical event (a new object, never modifying source) */
  event: SessionEventV1;
  /** The source format version that was upcast from */
  sourceVersion: string;
  /** The target canonical version */
  targetVersion: number;
  /** The original record identity for provenance tracking */
  sourceId: string;
  /** Whether any data was lost or approximated during upcast */
  lossy: boolean;
  /** Human-readable notes about lossy fields if applicable */
  lossNotes?: string[];
}

// ─── Downcast View ──────────────────────────────────────────────

/**
 * A read-only downcast view that presents canonical data in a legacy format.
 * Never overwrites the source canonical event — always produces a new derived view.
 */
export interface DowncastView<T> {
  /** The derived legacy representation (a new object) */
  view: T;
  /** The canonical event identity this was derived from */
  sourceEventId: string;
  /** The canonical schema version of the source */
  sourceSchemaVersion: number;
  /** Whether any canonical data was omitted in the legacy view */
  truncated: boolean;
  /** Fields that were omitted from the legacy view */
  omittedFields?: string[];
}

// ─── Upcaster Function Types ────────────────────────────────────

/**
 * Pure function that transforms a LegacyTimelineRecord to a canonical SessionEventV1.
 * Must not mutate the input. Must produce a completely new object.
 */
export type TimelineRecordUpcaster = (
  record: LegacyTimelineRecord,
  sessionMetadata: { sessionId: string; branchId?: string },
) => UpcastResult;

/**
 * Pure function that transforms a LegacyMessage to a canonical SessionEventV1.
 * Must not mutate the input. Must produce a completely new object.
 */
export type MessageUpcaster = (
  message: LegacyMessage,
  context: { sessionId: string; branchId: string; sequence: number },
) => UpcastResult;

/**
 * Pure function that transforms a LegacyBranchEvent to a canonical SessionEventV1.
 * Must not mutate the input. Must produce a completely new object.
 */
export type BranchEventUpcaster = (
  event: LegacyBranchEvent,
  context: { sessionId: string; branchId: string; parentBranchId?: string },
) => UpcastResult;

// ─── Downcast Function Types ────────────────────────────────────

/**
 * Pure function that produces a legacy TimelineRecord view from a canonical event.
 * Must not mutate the input. Must produce a completely new object.
 */
export type TimelineRecordDowncaster = (
  event: SessionEventV1,
) => DowncastView<LegacyTimelineRecord>;

/**
 * Pure function that produces a legacy Message view from a canonical event.
 * Must not mutate the input. Returns null if the event is not representable as a message.
 */
export type MessageDowncaster = (
  event: SessionEventV1,
) => DowncastView<LegacyMessage> | null;

/**
 * Pure function that produces a legacy BranchEvent view from a canonical event.
 * Must not mutate the input.
 */
export type BranchEventDowncaster = (
  event: SessionEventV1,
) => DowncastView<LegacyBranchEvent>;

// ─── Registry ───────────────────────────────────────────────────

/**
 * Registry for legacy data upcasters and downcast view producers.
 * Supports version-to-version registration and chain resolution.
 */
export interface LegacyDataUpcasterRegistry {
  /** Upcast a legacy timeline record to a canonical event */
  upcastTimelineRecord(
    record: LegacyTimelineRecord,
    sessionMetadata: { sessionId: string; branchId?: string },
  ): UpcastResult;

  /** Upcast a legacy message to a canonical event */
  upcastMessage(
    message: LegacyMessage,
    context: { sessionId: string; branchId: string; sequence: number },
  ): UpcastResult;

  /** Upcast a legacy branch event to a canonical event */
  upcastBranchEvent(
    event: LegacyBranchEvent,
    context: { sessionId: string; branchId: string; parentBranchId?: string },
  ): UpcastResult;

  /** Downcast a canonical event to a legacy timeline record view */
  downcastToTimelineRecord(event: SessionEventV1): DowncastView<LegacyTimelineRecord>;

  /** Downcast a canonical event to a legacy message view (returns null if not representable) */
  downcastToMessage(event: SessionEventV1): DowncastView<LegacyMessage> | null;

  /** Downcast a canonical event to a legacy branch event view */
  downcastToBranchEvent(event: SessionEventV1): DowncastView<LegacyBranchEvent>;
}
