/**
 * Tool_Message_Sanitizer (Feature 3 of efficiency-improvements).
 *
 * Removes structurally invalid tool-call sequences from a compressed message
 * array before it is submitted to a provider API:
 *   - Orphan tool messages (a `role: 'tool'` message with no matching preceding
 *     assistant `tool_calls` entry, by id or positional fallback).
 *   - Dangling assistant messages (an assistant whose every `tool_calls` entry
 *     went unanswered after orphan removal).
 *
 * Design: a pure, deterministic two-pass algorithm. It never mutates its input,
 * never throws, and returns a new array whose retained elements are
 * reference-equal (`===`) to the corresponding input elements (an
 * order-preserving subsequence of the input).
 *
 * Requirements: 14, 15, 16, 17, 18, 19
 */

import type { ExtendedLLMMessage } from './tool-call-recovery.js';

/**
 * ChatMessage is the message envelope this sanitizer operates over. It is an
 * alias of `ExtendedLLMMessage` (which carries the optional `tool_calls`,
 * `tool_call_id`, and `function_call` tool-call fields) re-exported here so
 * integration sites depend only on this module.
 */
export type ChatMessage = ExtendedLLMMessage;

/** An element of an assistant message's `tool_calls` array. */
export interface ToolCallEntry {
  id: string;
  function: { name: string };
}

/**
 * Loose structural view used for defensive, runtime-safe field access. The
 * static type guarantees these fields where present, but the sanitizer must
 * tolerate malformed history (missing `role`, non-array `tool_calls`, etc.)
 * without throwing.
 */
interface RawMessage {
  role?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

function asRaw(msg: ChatMessage): RawMessage | null {
  if (msg == null || typeof msg !== 'object') {
    return null;
  }
  return msg as unknown as RawMessage;
}

/**
 * Extracts the declared tool-call ids from an assistant message's `tool_calls`
 * array. A non-array `tool_calls` is treated as absent (Requirement: the
 * sanitizer does not paper over schema violations). Only string ids count.
 */
function declaredIdsOf(raw: RawMessage): string[] {
  const calls = raw.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of calls) {
    if (entry != null && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Sanitize a complete (non-streaming) message array by removing orphan tool
 * messages and dangling assistant tool-calls.
 *
 * @param messages The compressed message array to sanitize.
 * @returns A new array; an order-preserving subsequence of `messages` whose
 *   retained elements are reference-equal to the inputs. Returns `[]` for
 *   `null`/`undefined`/non-array input. Never mutates input. Never throws.
 */
export function sanitizeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  // Defensive: null/undefined or non-array input → [] (Req 14.4).
  if (!Array.isArray(messages)) {
    return [];
  }

  // ─── Pass 1 — Orphan tool removal (Req 15, 17.1, 18) ───
  const declaredIds = new Set<string>();
  const answeredIds = new Set<string>();
  let pendingPositional: string[] = [];
  const pass1: ChatMessage[] = [];

  for (const msg of messages) {
    const raw = asRaw(msg);

    // Elements with no `role` field (or non-object elements) are treated as
    // non-tool, non-assistant and retained unconditionally.
    const role = raw?.role;

    if (role === 'assistant') {
      const ids = declaredIdsOf(raw!);
      if (ids.length > 0) {
        // Reset the positional queue to this assistant's entries, and add the
        // ids to the declared set and the positional queue.
        pendingPositional = ids.slice();
        for (const id of ids) {
          declaredIds.add(id);
        }
      }
      pass1.push(msg);
      continue;
    }

    if (role === 'tool') {
      const toolCallId = raw!.tool_call_id;
      if (typeof toolCallId === 'string') {
        // Id-tagged: keep iff it matches a preceding declared entry (Req 18.1).
        if (declaredIds.has(toolCallId)) {
          answeredIds.add(toolCallId);
          pass1.push(msg);
        }
        // else: orphan — drop (Req 15.1).
      } else {
        // Positional fallback against the most recent assistant (Req 18.2).
        if (pendingPositional.length > 0) {
          const id = pendingPositional.shift()!;
          answeredIds.add(id);
          pass1.push(msg);
        }
        // else: positional fallback exhausted — orphan, drop (Req 15.2, 18.3).
      }
      continue;
    }

    // Non-tool, non-assistant message: retain (Req 14.5).
    pass1.push(msg);
  }

  // ─── Pass 2 — Dangling assistant removal (Req 16, 17.2) ───
  const result: ChatMessage[] = [];

  for (const msg of pass1) {
    const raw = asRaw(msg);
    if (raw?.role === 'assistant') {
      const ids = declaredIdsOf(raw);
      if (ids.length > 0) {
        // Drop iff every declared entry went unanswered after Pass 1.
        const anyAnswered = ids.some((id) => answeredIds.has(id));
        if (anyAnswered) {
          result.push(msg);
        }
        // else: dangling — drop (Req 16.1).
        continue;
      }
      // Assistant with no/empty tool_calls: retain unconditionally (Req 16.3).
    }
    result.push(msg);
  }

  return result;
}
