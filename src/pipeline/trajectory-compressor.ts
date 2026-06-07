/**
 * Trajectory Compression — Intelligent Context Compaction
 *
 * When conversation history grows too long, uses the LLM to compress it into
 * a structured summary that preserves decisions, file changes, and current state.
 * Keeps the last N messages intact for immediate context.
 */

import type { LLMClient } from './llm-client';
import { sanitizeToolMessages, type ChatMessage } from './tool-message-sanitizer';
import { recordDroppedMessages, type MetricsSink } from './tool-sanitizer-telemetry';

export interface CompressedTrajectory {
  summary: string;
  messagesRemoved: number;
  tokensSaved: number;
}

const COMPRESSION_PROMPT = `You are a conversation compressor. Summarize the following conversation history into a concise structured summary. Preserve:
- Key decisions made
- Files created or modified (with paths)
- Current task/goal the user is working on
- Important context that future messages will need
- Any errors or blockers encountered

Format your summary as:
## Session Summary
**Goal:** [what the user is trying to accomplish]
**Decisions:** [bullet list of key decisions]
**Files Changed:** [bullet list of file paths and what was done]
**Current State:** [where things stand now]
**Key Context:** [anything else important for continuity]

Be concise — aim for 200-400 words maximum. Do NOT include the actual code content, just file paths and descriptions.`;

/**
 * Compress a conversation history into a structured summary.
 * Keeps the last `keepRecent` messages intact.
 */
export async function compressTrajectory(
  messages: Array<{ role: string; content: string }>,
  llmClient: LLMClient,
  keepRecent: number = 4
): Promise<CompressedTrajectory | null> {
  if (messages.length <= keepRecent + 2) return null; // Not enough to compress

  // Split: messages to compress vs messages to keep
  const toCompress = messages.slice(0, messages.length - keepRecent);
  const estimatedTokens = toCompress.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  // Build the conversation text for compression
  const conversationText = toCompress
    .map(m => `[${m.role}]: ${m.content.slice(0, 500)}`)
    .join('\n\n')
    .slice(0, 8000); // Cap input to avoid exceeding context

  try {
    const result = await llmClient.chat([
      { role: 'system', content: COMPRESSION_PROMPT },
      { role: 'user', content: conversationText },
    ], { temperature: 0.2, maxTokens: 500 });

    const summary = (result.content || '').trim();
    if (!summary || summary.length < 50) return null;

    return {
      summary,
      messagesRemoved: toCompress.length,
      tokensSaved: estimatedTokens - Math.ceil(summary.length / 4),
    };
  } catch {
    return null;
  }
}

/**
 * Check if compression is needed based on message count and estimated tokens.
 */
export function shouldCompress(
  messages: Array<{ role: string; content: string }>,
  maxMessages: number = 20,
  maxEstimatedTokens: number = 30000
): boolean {
  if (messages.length > maxMessages) return true;
  const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  return estimatedTokens > maxEstimatedTokens;
}

/**
 * Splice a compressed message array together with the kept-recent tail of the
 * original trajectory, then sanitize the result (Feature 3 integration site).
 *
 * The compressed head (e.g. a summary system message) is placed first, followed
 * by the last `keepRecent` messages of `orig` preserved intact. The combined
 * array is passed through `sanitizeToolMessages` so no invalid tool-call
 * sequence introduced by the splice reaches a provider.
 *
 * Mirrors `compressTrajectory`'s `keepRecent` contract. Never throws: invalid
 * inputs degrade to an empty/partial array via the sanitizer's defensive
 * handling.
 *
 * @param orig The full original trajectory prior to compression.
 * @param compressed The compressed replacement for the head of `orig`.
 * @param keepRecent Number of trailing messages of `orig` to retain intact.
 * @param opts Optional sanitizer-telemetry wiring (Feature 3, Requirement
 *   22.3). When `metricsSink` is supplied and the sanitizer removes one or
 *   more messages, `tool_sanitizer.dropped_messages` is recorded with the
 *   count. Fully fail-soft and backward compatible.
 * @returns The spliced-and-sanitized message array.
 *
 * Requirements: 21, 22.3
 */
export function applyCompressedTrajectory(
  orig: ChatMessage[],
  compressed: ChatMessage[],
  keepRecent: number = 4,
  opts?: { metricsSink?: MetricsSink | null; sessionId?: string | null },
): ChatMessage[] {
  const head = Array.isArray(compressed) ? compressed : [];
  const original = Array.isArray(orig) ? orig : [];

  // Coerce keepRecent to a non-negative integer; non-finite → 0.
  const keep = Number.isFinite(keepRecent) ? Math.max(0, Math.floor(keepRecent)) : 0;
  const recentTail = keep > 0 ? original.slice(original.length - keep) : [];

  const spliced = [...head, ...recentTail];
  const sanitized = sanitizeToolMessages(spliced);

  // F3 telemetry (Requirement 22.3): record the drop count when the sanitizer
  // removed one or more messages. Fail-soft — never affects the return value.
  recordDroppedMessages(
    opts?.metricsSink,
    spliced.length - sanitized.length,
    opts?.sessionId ?? null,
  );

  return sanitized;
}
