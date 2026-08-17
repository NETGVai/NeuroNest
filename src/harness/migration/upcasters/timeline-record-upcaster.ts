/**
 * Timeline Record Upcaster — Transforms legacy TimelineRecord to canonical SessionEventV1.
 *
 * Pure function: does not mutate input, always produces a new derived object.
 * Preserves complete source payload as-is (requirement 44.13: never overwrites source payloads).
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */

import crypto from 'node:crypto';
import type { SessionEventV1 } from '../../contracts/event.js';
import type {
  LegacyTimelineRecord,
  UpcastResult,
} from './types.js';

/**
 * Map legacy timeline event types to canonical event types.
 * Unknown types are preserved as-is with a 'legacy.' prefix.
 */
const LEGACY_EVENT_TYPE_MAP: Record<string, string> = {
  message: 'message.user',
  tool_event: 'tool.call',
  approval: 'collaboration.wait',
  artifact: 'context.injection',
  change_set: 'tool.result-committed',
  evidence: 'context.injection',
  run_transition: 'turn.tail',
  error: 'error',
};

/**
 * Infer the message event type from the payload role.
 */
function inferMessageEventType(payload: Record<string, unknown>): string {
  const role = payload['role'] as string | undefined;
  switch (role) {
    case 'user':
      return 'message.user';
    case 'assistant':
      return 'message.assistant';
    case 'system':
      return 'message.system';
    default:
      return 'message.user';
  }
}

/**
 * Compute a deterministic event ID from legacy record identity.
 * Uses a stable hash to ensure the same legacy record always produces the same event ID.
 */
function deriveEventId(record: LegacyTimelineRecord): string {
  const input = `legacy-timeline:${record.sessionId}:${record.id}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Compute an integrity hash for the upcast event.
 * This differs from the canonical chain hash since legacy events have no chain.
 */
function computeUpcastIntegrityHash(
  eventId: string,
  sessionId: string,
  branchId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  const hashInput = JSON.stringify({
    eventId,
    sessionId,
    branchId,
    sequence,
    eventType,
    payload,
  });
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Upcast a legacy TimelineRecord to a canonical SessionEventV1.
 *
 * This is a pure function that:
 * - Never mutates the input record
 * - Always produces a completely new SessionEventV1 object
 * - Preserves the original payload structure within the canonical wrapper
 * - Reports any lossy transformations through UpcastResult metadata
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */
export function upcastTimelineRecord(
  record: LegacyTimelineRecord,
  sessionMetadata: { sessionId: string; branchId?: string },
): UpcastResult {
  const branchId = sessionMetadata.branchId ?? 'main';
  const lossy = false;
  const lossNotes: string[] = [];

  // Determine the canonical event type
  let eventType: string;
  if (record.eventType === 'message') {
    eventType = inferMessageEventType(record.payload);
  } else {
    eventType = LEGACY_EVENT_TYPE_MAP[record.eventType] ?? `legacy.${record.eventType}`;
    if (!LEGACY_EVENT_TYPE_MAP[record.eventType]) {
      lossNotes.push(`Unknown legacy event type "${record.eventType}" preserved with "legacy." prefix`);
    }
  }

  // Build canonical payload preserving all original fields
  const canonicalPayload: Record<string, unknown> = {
    type: eventType,
    // Preserve the complete original payload as a nested field for provenance
    _legacyPayload: { ...record.payload },
    // Map known fields to canonical positions
    ...mapPayloadFields(record.eventType, record.payload),
  };

  // Add linked metadata if present
  if (record.linkedChangeSetIds.length > 0) {
    canonicalPayload['linkedChangeSetIds'] = [...record.linkedChangeSetIds];
  }
  if (record.linkedToolEventIds.length > 0) {
    canonicalPayload['linkedToolEventIds'] = [...record.linkedToolEventIds];
  }

  const eventId = deriveEventId(record);
  const integrityHash = computeUpcastIntegrityHash(
    eventId,
    sessionMetadata.sessionId,
    branchId,
    record.sequenceNumber,
    eventType,
    canonicalPayload,
  );

  const event: SessionEventV1 = {
    eventId,
    sessionId: sessionMetadata.sessionId,
    branchId,
    sequence: record.sequenceNumber,
    schemaVersion: 1,
    eventType,
    payload: canonicalPayload as Record<string, unknown> & { type: string },
    occurredAt: record.createdAt,
    actor: { kind: 'system' as const, id: 'legacy-upcaster', schemaVersion: 1 as const },
    scope: {
      schemaVersion: 1 as const,
      userId: 'unknown',
      workspaceId: 'unknown',
      sessionId: sessionMetadata.sessionId,
    },
    previousIntegrityHash: null,
    integrityHash,
  };

  return {
    event,
    sourceVersion: 'timeline-record-v1',
    targetVersion: 1,
    sourceId: record.id,
    lossy: lossNotes.length > 0,
    lossNotes: lossNotes.length > 0 ? lossNotes : undefined,
  };
}

/**
 * Map legacy payload fields to their canonical positions.
 * Each event type has different expected payload structures.
 */
function mapPayloadFields(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventType) {
    case 'message':
      return {
        messageId: payload['id'] as string | undefined,
        text: payload['content'] as string ?? payload['text'] as string ?? '',
        role: payload['role'] as string ?? 'user',
        agent: payload['agent'] as string | undefined,
      };

    case 'tool_event':
      return {
        callId: payload['callId'] as string ?? payload['id'] as string | undefined,
        toolName: payload['toolName'] as string ?? payload['tool'] as string ?? 'unknown',
        state: payload['state'] as string ?? (payload['result'] !== undefined ? 'completed' : 'planned'),
        modelOrderIndex: payload['modelOrderIndex'] as number ?? 0,
      };

    case 'approval':
      return {
        collaborationId: payload['id'] as string ?? payload['approvalId'] as string | undefined,
        collaborationKind: 'approval',
        status: payload['status'] as string ?? 'pending',
      };

    case 'change_set':
      return {
        callId: payload['callId'] as string | undefined,
        resultId: payload['id'] as string ?? payload['changeSetId'] as string | undefined,
      };

    case 'artifact':
      return {
        injectionId: payload['id'] as string ?? payload['artifactId'] as string | undefined,
        injectionKind: 'artifact',
        label: payload['name'] as string ?? payload['label'] as string | undefined,
      };

    case 'evidence':
      return {
        injectionId: payload['id'] as string ?? payload['evidenceId'] as string | undefined,
        injectionKind: 'evidence',
        label: payload['label'] as string | undefined,
      };

    case 'run_transition':
      return {
        turnId: payload['runId'] as string ?? payload['turnId'] as string | undefined,
        outcome: payload['toState'] as string ?? payload['outcome'] as string ?? 'completed',
      };

    case 'error':
      return {
        errorId: payload['id'] as string ?? payload['errorId'] as string | undefined,
        errorClass: payload['class'] as string ?? payload['errorClass'] as string ?? 'unknown',
        message: payload['message'] as string ?? '',
        redacted: payload['redacted'] as boolean ?? false,
      };

    default:
      return {};
  }
}
