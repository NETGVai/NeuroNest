/**
 * Branch Event Upcaster — Transforms legacy BranchEvent to canonical SessionEventV1.
 *
 * Pure function: does not mutate input, always produces a new derived object.
 * Preserves complete branch lineage and event data in the canonical representation.
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */

import crypto from 'node:crypto';
import type { SessionEventV1 } from '../../contracts/event.js';
import type { LegacyBranchEvent, UpcastResult } from './types.js';

/**
 * Map legacy branch event types to canonical event types.
 */
const BRANCH_EVENT_TYPE_MAP: Record<string, string> = {
  message: 'message.user',
  tool_event: 'tool.call',
  tool_result: 'tool.result-committed',
  approval: 'collaboration.wait',
  error: 'error',
  state_change: 'turn.tail',
};

/**
 * Derive a deterministic event ID from the legacy branch event identity.
 */
function deriveEventId(event: LegacyBranchEvent, sessionId: string, branchId: string): string {
  const input = `legacy-branch-event:${sessionId}:${branchId}:${event.id}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Compute an integrity hash for the upcast event.
 */
function computeIntegrityHash(
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
 * Infer the canonical event type from a legacy branch event.
 */
function inferEventType(event: LegacyBranchEvent): string {
  // Check the event type mapping first
  if (BRANCH_EVENT_TYPE_MAP[event.type]) {
    // For message type, check payload for role
    if (event.type === 'message') {
      const role = event.payload['role'] as string | undefined;
      switch (role) {
        case 'assistant':
          return 'message.assistant';
        case 'system':
          return 'message.system';
        default:
          return 'message.user';
      }
    }
    return BRANCH_EVENT_TYPE_MAP[event.type];
  }
  return `legacy.branch.${event.type}`;
}

/**
 * Upcast a legacy BranchEvent to a canonical SessionEventV1.
 *
 * This is a pure function that:
 * - Never mutates the input event
 * - Always produces a completely new SessionEventV1 object
 * - Preserves the original branch event data in the canonical payload
 * - Records branch lineage (parentBranchId) in the payload for provenance
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */
export function upcastBranchEvent(
  event: LegacyBranchEvent,
  context: { sessionId: string; branchId: string; parentBranchId?: string },
): UpcastResult {
  const lossNotes: string[] = [];
  const eventType = inferEventType(event);

  if (!BRANCH_EVENT_TYPE_MAP[event.type]) {
    lossNotes.push(`Unknown legacy branch event type "${event.type}" preserved with "legacy.branch." prefix`);
  }

  const eventId = deriveEventId(event, context.sessionId, context.branchId);

  // Build canonical payload preserving all original fields
  const canonicalPayload: Record<string, unknown> = {
    type: eventType,
    // Preserve the entire original branch event as provenance
    _legacyBranchEvent: {
      id: event.id,
      sequenceNumber: event.sequenceNumber,
      type: event.type,
      payload: { ...event.payload },
      createdAt: event.createdAt,
    },
    // Map known payload fields
    ...event.payload,
  };

  // Record branch lineage for provenance tracking
  if (context.parentBranchId) {
    canonicalPayload['_branchLineage'] = {
      parentBranchId: context.parentBranchId,
      branchId: context.branchId,
    };
  }

  const integrityHash = computeIntegrityHash(
    eventId,
    context.sessionId,
    context.branchId,
    event.sequenceNumber,
    eventType,
    canonicalPayload,
  );

  const canonicalEvent: SessionEventV1 = {
    eventId,
    sessionId: context.sessionId,
    branchId: context.branchId,
    sequence: event.sequenceNumber,
    schemaVersion: 1,
    eventType,
    payload: canonicalPayload as Record<string, unknown> & { type: string },
    occurredAt: event.createdAt,
    actor: { kind: 'system' as const, id: 'legacy-upcaster', schemaVersion: 1 as const },
    scope: {
      userId: 'unknown',
      workspaceId: 'unknown',
      sessionId: context.sessionId,
      schemaVersion: 1 as const,
    },
    previousIntegrityHash: null,
    integrityHash,
  };

  return {
    event: canonicalEvent,
    sourceVersion: 'branch-event-v1',
    targetVersion: 1,
    sourceId: event.id,
    lossy: lossNotes.length > 0,
    lossNotes: lossNotes.length > 0 ? lossNotes : undefined,
  };
}
