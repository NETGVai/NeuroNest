import { IDEMessageSchema } from '../shared/schemas.js';
import type { IDEMessage } from '../shared/types.js';

/**
 * Serializes an IDEMessage to a JSON string.
 * Validates: Requirement 18.10
 */
export function serializeIDEMessage(message: IDEMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a JSON string into a validated IDEMessage.
 * Throws on invalid input.
 * Validates: Requirement 18.10, 18.11
 */
export function parseIDEMessage(json: string): IDEMessage {
  const raw = JSON.parse(json);
  return IDEMessageSchema.parse(raw);
}
