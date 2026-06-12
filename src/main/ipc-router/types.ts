/**
 * IPC Router Type Definitions
 *
 * Defines the handler definition interface and error structures for the
 * typed IPC router with Zod schema validation.
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

// ─── Handler Definition ─────────────────────────────────────────

/**
 * Defines a single IPC handler with typed request/response schemas.
 * Both request and response schemas are required before registration.
 */
export interface IPCHandlerDef<Req, Res> {
  /** The IPC channel name (e.g., 'chat:send-message') */
  channel: string;
  /** Zod schema for validating incoming request payloads */
  requestSchema: z.ZodType<Req>;
  /** Zod schema for validating outgoing response payloads */
  responseSchema: z.ZodType<Res>;
  /** The handler function invoked after successful validation */
  handler: (event: IpcMainInvokeEvent, req: Req) => Promise<Res>;
}

// ─── Validation Error ───────────────────────────────────────────

/**
 * Structured error returned when an IPC message fails Zod validation.
 * Contains enough information for the renderer to display specific field errors.
 */
export interface IPCValidationError {
  /** The IPC channel where validation failed */
  channel: string;
  /** Dot-notation path to the failing field (e.g., 'messages[0].content') */
  fieldPath: string;
  /** Expected type or constraint description */
  expected: string;
  /** Received value description */
  received: string;
}

/**
 * Standard IPC response envelope.
 * All IPC responses are wrapped in this structure.
 */
export type IPCResponse<T> =
  | { success: true; data: T }
  | { success: false; error: IPCValidationError };

// ─── Validation Result ──────────────────────────────────────────

/**
 * Result of validating a registered handler definition.
 * Used by `validateAll()` to report registration issues.
 */
export interface ValidationResult {
  channel: string;
  valid: boolean;
  issues: string[];
}
