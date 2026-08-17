/**
 * Downcast Views — Explicit read-only projections of canonical SessionEventV1
 * back to legacy formats for backward compatibility.
 *
 * Key principles:
 * - These are VIEWS, not mutations — they never overwrite the source canonical event
 * - Each downcast produces a completely new derived object
 * - Data that cannot be represented in the legacy format is declared as omitted
 * - Export integrity is preserved by tracking what was included/omitted
 *
 * Requirements: 3.3, 28.4–28.9, 31.9, 32.4, 44.13
 */

import type { SessionEventV1 } from '../../contracts/event.js';
import type {
  LegacyTimelineRecord,
  LegacyMessage,
  LegacyBranchEvent,
  DowncastView,
} from './types.js';

// ─── Canonical event type → legacy timeline event type mapping ──

const CANONICAL_TO_LEGACY_TYPE: Record<string, string> = {
  'message.user': 'message',
  'message.assistant': 'message',
  'message.system': 'message',
  'tool.call': 'tool_event',
  'tool.call-planned': 'tool_event',
  'tool.result-committed': 'change_set',
  'collaboration.wait': 'approval',
  'context.injection': 'artifact',
  'context.injected': 'artifact',
  'turn.tail': 'run_transition',
  'error': 'error',
};

/**
 * Canonical fields that are NOT representable in the legacy TimelineRecord format.
 * These are declared as omitted in the downcast view metadata.
 */
const TIMELINE_RECORD_OMITTED_FIELDS = [
  'schemaVersion',
  'integrityHash',
  'previousIntegrityHash',
  'actor',
  'scope',
  'idempotencyKey',
];

/**
 * Downcast a canonical SessionEventV1 to a legacy TimelineRecord view.
 *
 * This is a pure function that:
 * - Never mutates the input event
 * - Always produces a completely new LegacyTimelineRecord
 * - Declares which canonical fields were omitted
 * - Preserves as much data as the legacy format allows
 *
 * Requirements: 28.4–28.9, 44.13
 */
export function downcastToTimelineRecord(
  event: SessionEventV1,
): DowncastView<LegacyTimelineRecord> {
  const payload = event.payload as Record<string, unknown>;
  const omittedFields = [...TIMELINE_RECORD_OMITTED_FIELDS];

  // Determine the legacy event type
  const legacyEventType = CANONICAL_TO_LEGACY_TYPE[event.eventType]
    ?? extractLegacyType(event.eventType);

  // Build legacy payload from the canonical payload
  // Remove internal provenance fields that don't belong in legacy format
  const legacyPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // Skip provenance/internal fields
    if (key.startsWith('_legacy') || key === '_branchLineage' || key === 'type') {
      continue;
    }
    legacyPayload[key] = value;
  }

  // Extract linked IDs from canonical payload
  const linkedChangeSetIds: string[] =
    (payload['linkedChangeSetIds'] as string[]) ?? [];
  const linkedToolEventIds: string[] =
    (payload['linkedToolEventIds'] as string[]) ?? [];

  // If there are canonical-only fields in the payload, declare them as truncated
  const canonicalOnlyFields = Object.keys(payload).filter(
    (k) => k.startsWith('_legacy') || k === '_branchLineage',
  );
  if (canonicalOnlyFields.length > 0) {
    omittedFields.push(...canonicalOnlyFields);
  }

  const view: LegacyTimelineRecord = {
    id: event.eventId,
    sessionId: event.sessionId,
    sequenceNumber: event.sequence,
    eventType: legacyEventType,
    payload: legacyPayload,
    linkedChangeSetIds: [...linkedChangeSetIds],
    linkedToolEventIds: [...linkedToolEventIds],
    createdAt: event.occurredAt,
  };

  return {
    view,
    sourceEventId: event.eventId,
    sourceSchemaVersion: event.schemaVersion,
    truncated: omittedFields.length > TIMELINE_RECORD_OMITTED_FIELDS.length,
    omittedFields,
  };
}

/**
 * Downcast a canonical SessionEventV1 to a legacy Message view.
 *
 * Returns null if the event is not representable as a message
 * (i.e., it's not a message-type event).
 *
 * This is a pure function that:
 * - Never mutates the input event
 * - Returns null for non-message events (not all events are messages)
 * - Produces a completely new LegacyMessage when applicable
 *
 * Requirements: 28.4–28.9, 44.13
 */
export function downcastToMessage(
  event: SessionEventV1,
): DowncastView<LegacyMessage> | null {
  // Only message events can be downcast to legacy messages
  if (
    event.eventType !== 'message.user' &&
    event.eventType !== 'message.assistant' &&
    event.eventType !== 'message.system'
  ) {
    return null;
  }

  const payload = event.payload as Record<string, unknown>;
  const omittedFields: string[] = [];

  // Determine role from event type
  const role = event.eventType === 'message.user'
    ? 'user'
    : event.eventType === 'message.assistant'
      ? 'assistant'
      : 'system';

  // Extract text content
  const content = (payload['text'] as string)
    ?? (payload['content'] as string)
    ?? '';

  // Extract agent if present
  const agent = payload['agent'] as string | undefined;

  // Extract tool calls reference if present
  const toolCalls = payload['toolCallsRef'] as unknown | undefined;

  // Track canonical fields not representable in legacy message format
  const canonicalFields = [
    'integrityHash', 'previousIntegrityHash', 'schemaVersion',
    'scope', 'actor', 'idempotencyKey', 'sequence', 'branchId',
  ];
  omittedFields.push(...canonicalFields);

  // If there are payload fields beyond text/role/agent/toolCalls, note them
  const knownMessageFields = new Set([
    'type', 'messageId', 'text', 'content', 'role', 'agent', 'toolCallsRef',
    'attachmentIds', '_legacyMessage', '_legacyPayload',
  ]);
  for (const key of Object.keys(payload)) {
    if (!knownMessageFields.has(key)) {
      omittedFields.push(`payload.${key}`);
    }
  }

  const view: LegacyMessage = {
    id: (payload['messageId'] as string) ?? event.eventId,
    role,
    content,
    agent,
    toolCalls,
    createdAt: event.occurredAt,
  };

  return {
    view,
    sourceEventId: event.eventId,
    sourceSchemaVersion: event.schemaVersion,
    truncated: omittedFields.length > canonicalFields.length,
    omittedFields,
  };
}

/**
 * Downcast a canonical SessionEventV1 to a legacy BranchEvent view.
 *
 * This is a pure function that:
 * - Never mutates the input event
 * - Always produces a completely new LegacyBranchEvent
 * - Maps canonical event types back to legacy branch event types
 *
 * Requirements: 28.4–28.9, 44.13
 */
export function downcastToBranchEvent(
  event: SessionEventV1,
): DowncastView<LegacyBranchEvent> {
  const payload = event.payload as Record<string, unknown>;
  const omittedFields: string[] = [
    'schemaVersion',
    'integrityHash',
    'previousIntegrityHash',
    'actor',
    'scope',
    'idempotencyKey',
    'branchId',
  ];

  // Map canonical type to legacy branch event type
  const legacyType = mapCanonicalToBranchType(event.eventType);

  // Build legacy payload, excluding provenance/internal fields
  const legacyPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('_legacy') || key === '_branchLineage' || key === 'type') {
      continue;
    }
    legacyPayload[key] = value;
  }

  const view: LegacyBranchEvent = {
    id: event.eventId,
    sequenceNumber: event.sequence,
    type: legacyType,
    payload: legacyPayload,
    createdAt: event.occurredAt,
  };

  return {
    view,
    sourceEventId: event.eventId,
    sourceSchemaVersion: event.schemaVersion,
    truncated: false,
    omittedFields,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Extract a legacy-compatible type from a canonical event type.
 * For types with no direct mapping, returns 'evidence' as a generic container.
 */
function extractLegacyType(canonicalType: string): string {
  // Strip 'legacy.' prefix if present
  if (canonicalType.startsWith('legacy.')) {
    return canonicalType.slice(7);
  }
  // For any unrecognized canonical type, use 'evidence' as generic
  return 'evidence';
}

/**
 * Map canonical event type to legacy branch event type.
 */
function mapCanonicalToBranchType(canonicalType: string): string {
  switch (canonicalType) {
    case 'message.user':
    case 'message.assistant':
    case 'message.system':
      return 'message';
    case 'tool.call':
    case 'tool.call-planned':
      return 'tool_event';
    case 'tool.result-committed':
      return 'tool_result';
    case 'collaboration.wait':
      return 'approval';
    case 'error':
      return 'error';
    case 'turn.tail':
    case 'assistant.state':
      return 'state_change';
    default:
      if (canonicalType.startsWith('legacy.branch.')) {
        return canonicalType.slice(14);
      }
      return canonicalType;
  }
}
