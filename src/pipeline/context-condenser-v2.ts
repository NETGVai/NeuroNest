/**
 * Context Condenser v2 — Enhanced four-block prompt assembly with LLM-based
 * condensation of older events.
 *
 * Prompt structure:
 *   1. Stable prefix (system + agent def + skills)
 *   2. Condensed summary (≤ 600 tokens)
 *   3. Recent events (last K verbatim)
 *   4. Current task
 *
 * Triggers condensation when prompt exceeds 60% of the model context window
 * OR the per-mode token budget (whichever is smaller).
 *
 * Condensation uses the cheapest model via tier-router ('fast' tier).
 * Each condensation is recorded in the `condensation_log` table for audit.
 *
 * In swarm mode, each worker condenses independently; the coordinator
 * consumes only summaries from ResultEnvelopes.
 *
 * Gated behind `context_condenser_v2` feature flag; on failure falls back
 * to an un-condensed prompt (all events verbatim).
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 25.2
 */

import type { PipelineEvent } from './event-log.js';
import type { PromptBlock } from './prompt-cache-discipline.js';
import type Database from 'better-sqlite3';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface CondenserV2Config {
  /** Trigger condensation at this fraction of model context window (default 0.6). */
  budgetRatio: number;
  /** Maximum tokens for the condensed summary block (default 600). */
  summaryMaxTokens: number;
  /** Model tier used for condensation — always cheapest via tier-router. */
  condensationModel: 'fast';
  /** Master enable/disable for v2 condenser. */
  enabled: boolean;
}

export const DEFAULT_CONDENSER_V2_CONFIG: CondenserV2Config = {
  budgetRatio: 0.6,
  summaryMaxTokens: 600,
  condensationModel: 'fast',
  enabled: true,
};

// ─── Output Interfaces ──────────────────────────────────────────────────────

export interface CondensedPrompt {
  /** System + agent definition + skills — byte-stable cacheable prefix. */
  stablePrefix: PromptBlock;
  /** Summarized older events (≤ 600 tokens). */
  condensedSummary: PromptBlock;
  /** Last K events kept verbatim. */
  recentEvents: PromptBlock;
  /** Active task description. */
  currentTask: PromptBlock;
  /** Estimated total tokens across all four blocks. */
  totalTokens: number;
  /** Whether condensation was actually performed (vs. all events fit in budget). */
  wasCondensed: boolean;
}

// ─── Condensation Summarizer Callback ───────────────────────────────────────

/**
 * Signature for the LLM summarization function used during condensation.
 * Callers inject a function that calls the cheapest model via tier-router.
 */
export type SummarizeFn = (prompt: string) => Promise<string>;

// ─── Condensation Log Store ─────────────────────────────────────────────────

export interface CondensationLogEntry {
  sessionId: string;
  eventsCondensed: number;
  inputTokens: number;
  outputTokens: number;
  summaryTokens: number;
}

export interface CondensationLogStore {
  record(entry: CondensationLogEntry): void;
}

/**
 * SQLite-backed condensation log that writes to the `condensation_log` table
 * created by migration 040.
 */
export class SqliteCondensationLogStore implements CondensationLogStore {
  private readonly stmt: Database.Statement;

  constructor(db: Database.Database) {
    this.stmt = db.prepare(
      `INSERT INTO condensation_log (session_id, events_condensed, input_tokens, output_tokens, summary_tokens)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  record(entry: CondensationLogEntry): void {
    try {
      this.stmt.run(
        entry.sessionId,
        entry.eventsCondensed,
        entry.inputTokens,
        entry.outputTokens,
        entry.summaryTokens,
      );
    } catch (err) {
      // Fail-soft: never crash the pipeline on audit logging failure.
      console.warn('[context-condenser-v2] Failed to write condensation log:', (err as Error)?.message);
    }
  }
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/** Rough token estimate: ~4 characters per token (matches existing pipeline heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateBlockTokens(block: PromptBlock): number {
  if (typeof block.content === 'string') return estimateTokens(block.content);
  return estimateTokens(JSON.stringify(block.content));
}

function estimateEventsTokens(events: PipelineEvent[]): number {
  let chars = 0;
  for (const evt of events) {
    chars += JSON.stringify(evt.payload ?? '').length + (evt.kind?.length ?? 0) + 20;
  }
  return Math.ceil(chars / 4);
}

// ─── Condensation Prompt ────────────────────────────────────────────────────

const CONDENSATION_SYSTEM_PROMPT = `You are a concise summarizer for an AI coding assistant's event history.
Produce a summary of 600 tokens or fewer containing exactly these four sections:
1. **Decisions made** — key choices, approaches selected, tradeoffs accepted
2. **Files touched** — file paths created, edited, or deleted
3. **Errors seen** — error messages, failures, and their resolution status
4. **Open questions** — unresolved issues, pending user input, blockers

Output plain text with section headers. Omit any section that has no entries.
Do NOT include code blocks or verbose explanations.`;

function buildCondensationPrompt(events: PipelineEvent[]): string {
  const lines: string[] = [];
  for (const evt of events) {
    const payloadStr = typeof evt.payload === 'string'
      ? evt.payload.slice(0, 500)
      : JSON.stringify(evt.payload ?? null).slice(0, 500);
    lines.push(`[${evt.kind}] ${payloadStr}`);
  }
  return `${CONDENSATION_SYSTEM_PROMPT}\n\n---\nEvents to summarize (${events.length} total):\n${lines.join('\n')}`;
}

// ─── Extractive Fallback ────────────────────────────────────────────────────

/**
 * Extractive fallback when the LLM call fails or is unavailable.
 * Produces a deterministic summary without an LLM call.
 */
function extractiveFallbackSummary(events: PipelineEvent[]): string {
  const decisions: string[] = [];
  const files = new Set<string>();
  const errors: string[] = [];
  const openQuestions: string[] = [];

  for (const evt of events) {
    const payloadStr = typeof evt.payload === 'string'
      ? evt.payload
      : JSON.stringify(evt.payload ?? '');

    // Extract file paths
    const filePaths = payloadStr.match(
      /(?:[\w./\\-]+\.(?:ts|js|py|json|md|css|html|tsx|jsx|go|rs|java|rb|cpp|c|h|yaml|yml|toml))/g,
    );
    if (filePaths) filePaths.forEach(f => files.add(f));

    // Errors
    if (evt.kind === 'tool.failure' || evt.kind === 'error.captured') {
      const snippet = payloadStr.slice(0, 200);
      if (snippet) errors.push(snippet);
    }

    // Decisions (from assistant messages containing decision-like language)
    if (evt.kind === 'chat.assistant') {
      const sentences = payloadStr.split(/[.!?]+/).filter(s => s.length > 15 && s.length < 200);
      for (const s of sentences) {
        if (/\b(decided|chose|will|should|using|selecting|picking)\b/i.test(s)) {
          decisions.push(s.trim());
          if (decisions.length >= 5) break;
        }
      }
    }

    // Open questions (from user messages containing question marks)
    if (evt.kind === 'chat.user' && payloadStr.includes('?')) {
      openQuestions.push(payloadStr.slice(0, 150));
    }
  }

  const parts: string[] = [];
  if (decisions.length > 0) parts.push('**Decisions made**\n' + decisions.slice(0, 5).map(d => `- ${d}`).join('\n'));
  if (files.size > 0) parts.push('**Files touched**\n' + Array.from(files).slice(0, 15).map(f => `- ${f}`).join('\n'));
  if (errors.length > 0) parts.push('**Errors seen**\n' + errors.slice(0, 5).map(e => `- ${e}`).join('\n'));
  if (openQuestions.length > 0) parts.push('**Open questions**\n' + openQuestions.slice(0, 3).map(q => `- ${q}`).join('\n'));

  return parts.join('\n\n') || 'No significant events to summarize.';
}

// ─── Context Condenser V2 ───────────────────────────────────────────────────

export interface ContextCondenserV2 {
  assemble(
    stableBlocks: PromptBlock,
    events: PipelineEvent[],
    currentTask: string,
    modelContextWindow: number,
    modeBudget: number,
  ): Promise<CondensedPrompt>;
}

export interface ContextCondenserV2Options {
  config?: Partial<CondenserV2Config>;
  /** LLM summarization function (cheapest model via tier-router). */
  summarize?: SummarizeFn;
  /** Condensation audit log store. */
  logStore?: CondensationLogStore;
  /** Session ID for audit logging. */
  sessionId?: string;
}

/**
 * Create a ContextCondenserV2 instance.
 *
 * Usage:
 * ```ts
 * const condenser = createContextCondenserV2({
 *   summarize: (prompt) => fastModelClient.chat([{ role: 'user', content: prompt }]),
 *   logStore: new SqliteCondensationLogStore(db),
 *   sessionId: currentSession.id,
 * });
 * const assembled = await condenser.assemble(stableBlock, events, task, 200000, 80000);
 * ```
 */
export function createContextCondenserV2(
  options: ContextCondenserV2Options = {},
): ContextCondenserV2 {
  const config: CondenserV2Config = { ...DEFAULT_CONDENSER_V2_CONFIG, ...options.config };

  return {
    async assemble(
      stableBlocks: PromptBlock,
      events: PipelineEvent[],
      currentTask: string,
      modelContextWindow: number,
      modeBudget: number,
    ): Promise<CondensedPrompt> {
      // If disabled, return un-condensed prompt immediately.
      if (!config.enabled) {
        return buildUnCondensedPrompt(stableBlocks, events, currentTask);
      }

      try {
        return await assembleInternal(
          config,
          stableBlocks,
          events,
          currentTask,
          modelContextWindow,
          modeBudget,
          options.summarize ?? null,
          options.logStore ?? null,
          options.sessionId ?? 'unknown',
        );
      } catch (err) {
        // Requirement 25.2: graceful fallback on failure — return un-condensed prompt.
        console.warn('[context-condenser-v2] Assembly failed, falling back:', (err as Error)?.message);
        return buildUnCondensedPrompt(stableBlocks, events, currentTask);
      }
    },
  };
}

// ─── Internal Assembly Logic ────────────────────────────────────────────────

async function assembleInternal(
  config: CondenserV2Config,
  stableBlocks: PromptBlock,
  events: PipelineEvent[],
  currentTask: string,
  modelContextWindow: number,
  modeBudget: number,
  summarize: SummarizeFn | null,
  logStore: CondensationLogStore | null,
  sessionId: string,
): Promise<CondensedPrompt> {
  const stablePrefixTokens = estimateBlockTokens(stableBlocks);
  const currentTaskBlock: PromptBlock = { label: 'current_task', content: currentTask };
  const currentTaskTokens = estimateTokens(currentTask);
  const allEventsTokens = estimateEventsTokens(events);

  // Total if we keep everything un-condensed
  const totalRawTokens = stablePrefixTokens + allEventsTokens + currentTaskTokens;

  // Determine the effective budget: min of (context window × budgetRatio, modeBudget)
  const contextBudget = Math.floor(modelContextWindow * config.budgetRatio);
  const effectiveBudget = Math.min(contextBudget, modeBudget);

  // If we're within budget, no condensation needed
  if (totalRawTokens <= effectiveBudget) {
    return buildUnCondensedPrompt(stableBlocks, events, currentTask);
  }

  // Condensation needed — determine how many recent events to keep verbatim.
  // Reserve space: stablePrefix + currentTask + summaryMaxTokens + some headroom.
  const reservedTokens = stablePrefixTokens + currentTaskTokens + config.summaryMaxTokens + 50;
  const tokensForRecentEvents = Math.max(0, effectiveBudget - reservedTokens);

  // Walk backward from the end of events to find how many fit in tokensForRecentEvents.
  let recentCount = 0;
  let recentTokenAccum = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const evtTokens = estimateEventsTokens([events[i]]);
    if (recentTokenAccum + evtTokens > tokensForRecentEvents) break;
    recentTokenAccum += evtTokens;
    recentCount++;
  }

  // Ensure at least 1 recent event is kept if possible
  if (recentCount === 0 && events.length > 0) recentCount = 1;

  const splitIdx = events.length - recentCount;
  const eventsToCondense = events.slice(0, splitIdx);
  const recentEvents = events.slice(splitIdx);

  // Build the condensed summary
  let summaryText: string;
  const inputTokens = estimateEventsTokens(eventsToCondense);

  if (summarize && eventsToCondense.length > 0) {
    try {
      const condensationPrompt = buildCondensationPrompt(eventsToCondense);
      summaryText = await summarize(condensationPrompt);

      // Enforce 600-token cap: truncate if the LLM returned more
      const summaryTokenCount = estimateTokens(summaryText);
      if (summaryTokenCount > config.summaryMaxTokens) {
        // Truncate at approximate character boundary
        const maxChars = config.summaryMaxTokens * 4;
        summaryText = summaryText.slice(0, maxChars) + '\n[...truncated to 600 token limit]';
      }
    } catch (err) {
      // LLM call failed — use extractive fallback (Requirement 25.2)
      console.warn('[context-condenser-v2] LLM condensation failed, using extractive fallback:', (err as Error)?.message);
      summaryText = extractiveFallbackSummary(eventsToCondense);
    }
  } else {
    summaryText = extractiveFallbackSummary(eventsToCondense);
  }

  const summaryTokens = estimateTokens(summaryText);

  // Audit: write to condensation_log (Requirement 17.4)
  if (logStore) {
    logStore.record({
      sessionId,
      eventsCondensed: eventsToCondense.length,
      inputTokens,
      outputTokens: summaryTokens,
      summaryTokens,
    });
  }

  // Assemble the four-block prompt
  const condensedSummaryBlock: PromptBlock = {
    label: 'condensed_summary',
    content: `[Condensed Summary — ${eventsToCondense.length} events summarized]\n${summaryText}`,
  };

  const recentEventsContent = recentEvents
    .map(evt => `[${evt.kind}] ${typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload ?? null)}`)
    .join('\n');

  const recentEventsBlock: PromptBlock = {
    label: 'recent_events',
    content: recentEventsContent,
  };

  const totalTokens =
    stablePrefixTokens +
    estimateBlockTokens(condensedSummaryBlock) +
    estimateTokens(recentEventsContent) +
    currentTaskTokens;

  return {
    stablePrefix: stableBlocks,
    condensedSummary: condensedSummaryBlock,
    recentEvents: recentEventsBlock,
    currentTask: currentTaskBlock,
    totalTokens,
    wasCondensed: true,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build an un-condensed prompt (all events verbatim, no summary block).
 * Used when condensation is unnecessary or as a fallback on failure.
 */
function buildUnCondensedPrompt(
  stableBlocks: PromptBlock,
  events: PipelineEvent[],
  currentTask: string,
): CondensedPrompt {
  const allEventsContent = events
    .map(evt => `[${evt.kind}] ${typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload ?? null)}`)
    .join('\n');

  const currentTaskBlock: PromptBlock = { label: 'current_task', content: currentTask };
  const recentEventsBlock: PromptBlock = { label: 'recent_events', content: allEventsContent };
  const emptySummaryBlock: PromptBlock = { label: 'condensed_summary', content: '' };

  const totalTokens =
    estimateBlockTokens(stableBlocks) +
    estimateTokens(allEventsContent) +
    estimateTokens(currentTask);

  return {
    stablePrefix: stableBlocks,
    condensedSummary: emptySummaryBlock,
    recentEvents: recentEventsBlock,
    currentTask: currentTaskBlock,
    totalTokens,
    wasCondensed: false,
  };
}
