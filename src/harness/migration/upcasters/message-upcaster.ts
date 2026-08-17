/**
 * Message Upcaster — Transforms legacy Message format to canonical SessionEventV1.
 *
 * Pure function: does not mutate input, always produces a new derived object.
 * Preserves the complete legacy message content in the canonical payload.
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */

import crypto from 'node:crypto';
import type { SessionEventV1 } from '../../contracts/event.js';
import type { LegacyMessage, UpcastResult } from './types.js';

/**
 * Derive a deterministic event ID from the legacy message identity.
 */
function deriveEventId(message: LegacyMessage, sessionId: string): string {
  const input = `legacy-message:${sessionId}:${message.id}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Map a legacy message role to the canonical event type.
 */
function roleToEventType(role: string): string {
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
 * Upcast a legacy Message to a canonical SessionEventV1.
 *
 * This is a pure function that:
 * - Never mutates the input message
 * - Always produces a completely new SessionEventV1 object
 * - Preserves complete original message content
 * - Includes provenance metadata linking to the source message
 *
 * Requirements: 3.3, 28.4–28.6, 44.13
 */
export function upcastMessage(
  message: LegacyMessage,
  context: { sessionId: string; branchId: string; sequence: number },
): UpcastResult {
  const lossNotes: string[] = [];
  const eventType = roleToEventType(message.role);
  const eventId = deriveEventId(message, context.sessionId);

  // Build canonical payload preserving all original content
  const canonicalPayload: Record<string, unknown> = {
    type: eventType,
    messageId: message.id,
    text: message.content,
    role: message.role,
    // Preserve the entire original message as provenance (never overwrite source)
    _legacyMessage: {
      id: message.id,
      role: message.role,
      content: message.content,
      agent: message.agent,
      toolCalls: message.toolCalls,
      createdAt: message.createdAt,
    },
  };

  // Preserve agent attribution if present
  if (message.agent) {
    canonicalPayload['agent'] = message.agent;
  }

  // Preserve tool calls reference if present
  if (message.toolCalls !== undefined) {
    canonicalPayload['toolCallsRef'] = message.toolCalls;
    lossNotes.push(
      'Tool calls stored as opaque reference; structured tool call data requires separate upcast'
    );
  }

  const integrityHash = computeIntegrityHash(
    eventId,
    context.sessionId,
    context.branchId,
    context.sequence,
    eventType,
    canonicalPayload,
  );

  const event: SessionEventV1 = {
    eventId,
    sessionId: context.sessionId,
    branchId: context.branchId,
    sequence: context.sequence,
    schemaVersion: 1,
    eventType,
    payload: canonicalPayload as Record<string, unknown> & { type: string },
    occurredAt: message.createdAt,
    actor: { kind: 'system' as const, id: 'legacy-upcaster', schemaVersion: 1 as const },
    scope: {
      schemaVersion: 1 as const,
      userId: 'unknown',
      workspaceId: 'unknown',
      sessionId: context.sessionId,
    },
    previousIntegrityHash: null,
    integrityHash,
  };

  return {
    event,
    sourceVersion: 'message-v1',
    targetVersion: 1,
    sourceId: message.id,
    lossy: lossNotes.length > 0,
    lossNotes: lossNotes.length > 0 ? lossNotes : undefined,
  };
}
