/**
 * Context_Compactor — Reduces projected context pressure while retaining
 * complete durable history.
 *
 * Implements:
 * - Model-free pruning applied FIRST (Requirement 4.1)
 * - Provider_Registry summarization as bounded fallback (Requirement 4.2)
 * - Preservation of required metadata (Requirement 4.3)
 * - Compaction evidence appended to Session_Log (Requirement 4.4)
 * - Original events NEVER replaced — summaries are separate records (Requirement 4.8)
 * - Deterministic replay from original events (Requirement 4.8)
 *
 * Requirements: 4.1–4.8, 37.3–37.4, 37.8–37.9, 42.4
 */

import crypto from 'node:crypto';
import type { SessionEventV1 } from '../contracts/event.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type { SessionLog } from '../session-log/session-log.js';
import type {
  CompactorConfig,
  CompactionPlan,
  CompactionResult,
  CompactionEvidence,
  PruningResult,
  PruningRule,
  PreservationMetadata,
  SummarizationProvider,
} from './compaction-types.js';

// ─── Token Estimator ────────────────────────────────────────────

/**
 * Simple token estimation based on character count.
 * A more accurate implementation would use tiktoken or similar,
 * but this provides a deterministic model-free approximation.
 */
function estimateTokens(text: string): number {
  // ~4 characters per token is a reasonable approximation
  return Math.ceil(text.length / 4);
}

function estimateEventTokens(event: SessionEventV1): number {
  return estimateTokens(JSON.stringify(event.payload));
}

// ─── Metadata Extraction ────────────────────────────────────────

/**
 * Extract preservation metadata from a set of events.
 * Scans payloads for structured references that must survive compaction.
 */
function extractPreservationMetadata(events: SessionEventV1[]): PreservationMetadata {
  const fileReferences = new Set<string>();
  const diagnosticIds = new Set<string>();
  const codeReferences = new Set<string>();
  const decisionIds = new Set<string>();
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const attachmentIds = new Set<string>();

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;

    // Extract file references
    if (payload['fileRef'] && typeof payload['fileRef'] === 'string') {
      fileReferences.add(payload['fileRef']);
    }
    if (Array.isArray(payload['fileReferences'])) {
      for (const ref of payload['fileReferences']) {
        if (typeof ref === 'string') fileReferences.add(ref);
      }
    }

    // Extract diagnostic IDs
    if (payload['diagnosticId'] && typeof payload['diagnosticId'] === 'string') {
      diagnosticIds.add(payload['diagnosticId']);
    }
    if (Array.isArray(payload['diagnosticIds'])) {
      for (const id of payload['diagnosticIds']) {
        if (typeof id === 'string') diagnosticIds.add(id);
      }
    }

    // Extract code references
    if (payload['codeRef'] && typeof payload['codeRef'] === 'string') {
      codeReferences.add(payload['codeRef']);
    }
    if (Array.isArray(payload['codeReferences'])) {
      for (const ref of payload['codeReferences']) {
        if (typeof ref === 'string') codeReferences.add(ref);
      }
    }

    // Extract decision IDs
    if (payload['decisionId'] && typeof payload['decisionId'] === 'string') {
      decisionIds.add(payload['decisionId']);
    }

    // Extract tool call identities
    if (payload['callId'] && typeof payload['callId'] === 'string') {
      toolCallIds.add(payload['callId']);
    }
    if (event.eventType === 'tool.call-planned' || event.eventType === 'tool.attempted') {
      if (payload['callId'] && typeof payload['callId'] === 'string') {
        toolCallIds.add(payload['callId']);
      }
    }

    // Extract tool result identities
    if (event.eventType === 'tool.result-committed') {
      if (payload['resultId'] && typeof payload['resultId'] === 'string') {
        toolResultIds.add(payload['resultId']);
      }
      if (payload['callId'] && typeof payload['callId'] === 'string') {
        toolResultIds.add(payload['callId']);
      }
    }

    // Extract attachment identities
    if (payload['attachmentId'] && typeof payload['attachmentId'] === 'string') {
      attachmentIds.add(payload['attachmentId']);
    }
    if (Array.isArray(payload['attachmentIds'])) {
      for (const id of payload['attachmentIds']) {
        if (typeof id === 'string') attachmentIds.add(id);
      }
    }
  }

  return {
    fileReferences: [...fileReferences],
    diagnosticIds: [...diagnosticIds],
    codeReferences: [...codeReferences],
    decisionIds: [...decisionIds],
    toolCallIds: [...toolCallIds],
    toolResultIds: [...toolResultIds],
    attachmentIds: [...attachmentIds],
  };
}

// ─── Model-Free Pruning Engine ──────────────────────────────────

/**
 * Identifies events that can be excluded from projected context without
 * model interaction. The events remain in the durable Session_Log — only
 * their projection into the next model request is suppressed.
 */
function applyModelFreePruning(
  events: SessionEventV1[],
  targetTokens: number,
): PruningResult {
  const rulesApplied: PruningRule[] = [];
  const excludedSequences: number[] = [];
  let tokensSaved = 0;

  const totalTokens = events.reduce((sum, e) => sum + estimateEventTokens(e), 0);
  const tokensToSave = totalTokens - targetTokens;

  if (tokensToSave <= 0) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 1: Remove completed streaming partial blocks
  // Final blocks supersede all partial blocks
  const streamingPartialSequences = findSupersededStreamingPartials(events);
  if (streamingPartialSequences.length > 0) {
    rulesApplied.push('completed-streaming');
    for (const seq of streamingPartialSequences) {
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  if (tokensSaved >= tokensToSave) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 2: Remove redundant tool results (intermediate results superseded by final)
  const redundantToolResults = findRedundantToolResults(events);
  if (redundantToolResults.length > 0) {
    rulesApplied.push('redundant-tool-results');
    for (const seq of redundantToolResults) {
      if (excludedSequences.includes(seq)) continue;
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  if (tokensSaved >= tokensToSave) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 3: Remove duplicate diagnostics
  const duplicateDiagnostics = findDuplicateDiagnostics(events);
  if (duplicateDiagnostics.length > 0) {
    rulesApplied.push('duplicate-diagnostics');
    for (const seq of duplicateDiagnostics) {
      if (excludedSequences.includes(seq)) continue;
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  if (tokensSaved >= tokensToSave) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 4: Remove superseded context injections
  const supersededContext = findSupersededContextInjections(events);
  if (supersededContext.length > 0) {
    rulesApplied.push('superseded-context');
    for (const seq of supersededContext) {
      if (excludedSequences.includes(seq)) continue;
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  if (tokensSaved >= tokensToSave) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 5: Remove expired collaboration prompts
  const expiredCollaboration = findExpiredCollaborationEvents(events);
  if (expiredCollaboration.length > 0) {
    rulesApplied.push('expired-collaboration');
    for (const seq of expiredCollaboration) {
      if (excludedSequences.includes(seq)) continue;
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  if (tokensSaved >= tokensToSave) {
    return { rulesApplied, excludedSequences, tokensSaved, targetAchieved: true };
  }

  // Rule 6: Remove stale queue entries (delivered/removed)
  const staleQueueEntries = findStaleQueueEntries(events);
  if (staleQueueEntries.length > 0) {
    rulesApplied.push('stale-queue-entries');
    for (const seq of staleQueueEntries) {
      if (excludedSequences.includes(seq)) continue;
      const event = events.find((e) => e.sequence === seq);
      if (event) {
        excludedSequences.push(seq);
        tokensSaved += estimateEventTokens(event);
      }
    }
  }

  return {
    rulesApplied,
    excludedSequences,
    tokensSaved,
    targetAchieved: tokensSaved >= tokensToSave,
  };
}

// ─── Pruning Rule Implementations ───────────────────────────────

function findSupersededStreamingPartials(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  const partialsByTurn = new Map<string, number[]>();

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.eventType === 'assistant.partial-block') {
      const turnId = (payload['turnId'] as string) ?? 'unknown';
      const existing = partialsByTurn.get(turnId) ?? [];
      existing.push(event.sequence);
      partialsByTurn.set(turnId, existing);
    } else if (event.eventType === 'assistant.final-block') {
      const turnId = (payload['turnId'] as string) ?? 'unknown';
      // All partial blocks for this turn are superseded by the final block
      const partials = partialsByTurn.get(turnId);
      if (partials) {
        excluded.push(...partials);
        partialsByTurn.delete(turnId);
      }
    }
  }

  return excluded;
}

function findRedundantToolResults(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  // Track tool calls with multiple result events — keep only the latest
  const resultsByCallId = new Map<string, number[]>();

  for (const event of events) {
    if (event.eventType === 'tool.result-committed') {
      const payload = event.payload as Record<string, unknown>;
      const callId = payload['callId'] as string;
      if (callId) {
        const existing = resultsByCallId.get(callId) ?? [];
        existing.push(event.sequence);
        resultsByCallId.set(callId, existing);
      }
    }
  }

  // For each call with multiple results, exclude all but the last
  for (const sequences of resultsByCallId.values()) {
    if (sequences.length > 1) {
      excluded.push(...sequences.slice(0, -1));
    }
  }

  return excluded;
}

function findDuplicateDiagnostics(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  const seenDigests = new Map<string, number>();

  for (const event of events) {
    if (event.eventType.includes('diagnostic')) {
      const payload = event.payload as Record<string, unknown>;
      // Use a digest of the diagnostic content to detect duplicates
      const content = JSON.stringify({
        message: payload['message'],
        code: payload['code'],
        source: payload['source'],
      });
      const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      const existing = seenDigests.get(digest);
      if (existing !== undefined) {
        // Keep the later one, exclude the earlier
        excluded.push(existing);
        seenDigests.set(digest, event.sequence);
      } else {
        seenDigests.set(digest, event.sequence);
      }
    }
  }

  return excluded;
}

function findSupersededContextInjections(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  // Track context injections by kind — later injections supersede earlier
  const injectionsByKind = new Map<string, number[]>();

  for (const event of events) {
    if (event.eventType === 'context.injected') {
      const payload = event.payload as Record<string, unknown>;
      const kind = (payload['injectionKind'] as string) ?? 'default';
      const existing = injectionsByKind.get(kind) ?? [];
      existing.push(event.sequence);
      injectionsByKind.set(kind, existing);
    }
  }

  // For each kind with multiple injections, exclude all but the last
  for (const sequences of injectionsByKind.values()) {
    if (sequences.length > 1) {
      excluded.push(...sequences.slice(0, -1));
    }
  }

  return excluded;
}

function findExpiredCollaborationEvents(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  const now = Date.now();

  for (const event of events) {
    if (event.eventType.startsWith('collaboration.')) {
      const payload = event.payload as Record<string, unknown>;
      if (payload['status'] === 'expired') {
        excluded.push(event.sequence);
      } else if (payload['expiresAt'] && typeof payload['expiresAt'] === 'string') {
        const expiryTime = new Date(payload['expiresAt']).getTime();
        if (expiryTime < now) {
          excluded.push(event.sequence);
        }
      }
    }
  }

  return excluded;
}

function findStaleQueueEntries(events: SessionEventV1[]): number[] {
  const excluded: number[] = [];
  // Track queue entries that have been delivered or removed
  const deliveredOrRemoved = new Set<string>();

  // First pass: find delivered/removed entry IDs
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.eventType === 'queue.entry-delivered' || event.eventType === 'queue.entry-removed') {
      if (payload['entryId'] && typeof payload['entryId'] === 'string') {
        deliveredOrRemoved.add(payload['entryId']);
      }
    }
  }

  // Second pass: mark add/edit events for delivered/removed entries as stale
  for (const event of events) {
    if (event.eventType === 'queue.entry-added' || event.eventType === 'queue.entry-edited') {
      const payload = event.payload as Record<string, unknown>;
      if (payload['entryId'] && typeof payload['entryId'] === 'string') {
        if (deliveredOrRemoved.has(payload['entryId'])) {
          excluded.push(event.sequence);
        }
      }
    }
  }

  return excluded;
}

// ─── Context_Compactor Service ──────────────────────────────────

/**
 * Context_Compactor — Reduces projected context pressure while retaining
 * complete durable history in the Session_Log.
 *
 * Invariants:
 * - Model-free pruning is always applied before summarization (Req 4.1)
 * - Summaries are separate records, never replace original events (Req 4.8)
 * - All compaction operations append evidence to Session_Log (Req 4.4)
 * - Required metadata is preserved through compaction (Req 4.3)
 */
export class ContextCompactor {
  private readonly sessionLog: SessionLog;
  private readonly config: CompactorConfig;
  private readonly summarizationProvider: SummarizationProvider | undefined;

  constructor(
    sessionLog: SessionLog,
    config: CompactorConfig,
    summarizationProvider?: SummarizationProvider,
  ) {
    this.sessionLog = sessionLog;
    this.config = config;
    this.summarizationProvider = summarizationProvider ?? undefined;
  }

  /**
   * Plan a compaction for the given session context.
   *
   * Evaluates current context pressure and determines the strategy
   * and source range for compaction. Does NOT commit — use commitPlan().
   */
  planCompaction(
    sessionId: string,
    branchId: string,
    currentContextTokens?: number,
  ): CompactionPlan | null {
    const events = this.sessionLog.readRange({ sessionId, branchId });

    if (events.length === 0) {
      return null;
    }

    const contextTokens = currentContextTokens ?? events.reduce(
      (sum, e) => sum + estimateEventTokens(e), 0
    );

    // Check if pressure threshold is reached
    if (contextTokens <= this.config.pressureThresholdTokens) {
      return null;
    }

    // Determine source range — compact from beginning up to a reasonable point
    // leaving recent events untouched for coherence
    const recentEventCount = Math.min(Math.ceil(events.length * 0.2), 50);
    const compactableEvents = events.slice(0, events.length - recentEventCount);

    if (compactableEvents.length === 0) {
      return null;
    }

    const sourceRange = {
      fromSequence: compactableEvents[0]!.sequence,
      toSequence: compactableEvents[compactableEvents.length - 1]!.sequence,
    };

    // Try model-free pruning first
    const pruningResult = applyModelFreePruning(compactableEvents, this.config.targetTokens);
    const preservation = extractPreservationMetadata(compactableEvents);

    if (pruningResult.targetAchieved) {
      return {
        planId: crypto.randomUUID(),
        sessionId,
        branchId,
        sourceRange,
        strategy: 'model-free-pruning',
        preservation,
        estimatedReduction: pruningResult.tokensSaved,
      };
    }

    // If pruning is insufficient and provider summarization is enabled
    if (this.config.enableProviderSummarization && this.summarizationProvider) {
      const remainingReduction = (contextTokens - this.config.targetTokens) - pruningResult.tokensSaved;
      return {
        planId: crypto.randomUUID(),
        sessionId,
        branchId,
        sourceRange,
        strategy: 'provider-summarization',
        preservation,
        estimatedReduction: pruningResult.tokensSaved + remainingReduction,
        summaryRoute: 'provider-registry',
        accountingUncertainty: 'Summarization token costs are estimates based on provider response',
      };
    }

    // Fall back to model-free even if target not fully achieved
    return {
      planId: crypto.randomUUID(),
      sessionId,
      branchId,
      sourceRange,
      strategy: 'model-free-pruning',
      preservation,
      estimatedReduction: pruningResult.tokensSaved,
    };
  }

  /**
   * Commit a compaction plan.
   *
   * Appends a compaction.committed evidence event to the Session_Log.
   * Original events are NEVER modified or removed — the compaction event
   * is used by Projection_Service to exclude pruned events from context.
   */
  async commitPlan(
    plan: CompactionPlan,
    actor: ActorRef,
    scope: ScopeDescriptorV1,
  ): Promise<CompactionResult> {
    const events = this.sessionLog.readRange({
      sessionId: plan.sessionId,
      branchId: plan.branchId,
      fromSequence: plan.sourceRange.fromSequence,
      toSequence: plan.sourceRange.toSequence,
    });

    if (events.length === 0) {
      return {
        committed: false,
        strategy: plan.strategy,
        tokensReduced: 0,
        preservation: plan.preservation,
      };
    }

    // Apply model-free pruning
    const pruningResult = applyModelFreePruning(events, this.config.targetTokens);
    let summaryText: string | undefined;
    let summaryRoute: string | undefined;
    let accountingUncertainty: string | undefined;
    let totalTokensReduced = pruningResult.tokensSaved;

    // If strategy is provider-summarization and pruning was insufficient
    if (
      plan.strategy === 'provider-summarization' &&
      !pruningResult.targetAchieved &&
      this.summarizationProvider
    ) {
      // Compute events not already pruned
      const remainingEvents = events.filter(
        (e) => !pruningResult.excludedSequences.includes(e.sequence)
      );

      const response = await this.summarizationProvider.summarize({
        events: remainingEvents,
        maxTokens: this.config.maxSummarizationTokens,
        requiredPreservation: plan.preservation,
      });

      summaryText = response.summaryText;
      summaryRoute = response.route;
      accountingUncertainty = response.uncertainty ??
        'Summarization token costs are estimates based on provider response';

      // Estimate additional savings from summarization
      const eventsTokens = remainingEvents.reduce((sum, e) => sum + estimateEventTokens(e), 0);
      totalTokensReduced += (eventsTokens - response.summaryTokens);
    }

    // Append compaction evidence to Session_Log (Requirement 4.4)
    const evidence: CompactionEvidence = {
      planId: plan.planId,
      sourceRange: plan.sourceRange,
      strategy: plan.strategy,
      summaryRoute,
      accountingUncertainty,
      preservation: plan.preservation,
      summaryText,
    };

    const receipt = this.sessionLog.append({
      sessionId: plan.sessionId,
      branchId: plan.branchId,
      eventType: 'compaction.committed',
      payload: {
        type: 'compaction.committed',
        ...evidence,
      },
      actor,
      scope,
      idempotencyKey: `compaction:${plan.planId}`,
    });

    return {
      committed: true,
      strategy: plan.strategy,
      newSequence: receipt.sequence,
      compactionEventId: receipt.eventId,
      tokensReduced: totalTokensReduced,
      preservation: plan.preservation,
    };
  }

  /**
   * Get the projected context for a session after applying compaction.
   *
   * Returns only events that should be included in model context,
   * respecting compaction exclusions. Original events remain in the log
   * for deterministic replay (Requirement 4.8).
   */
  getProjectedContext(sessionId: string, branchId: string): SessionEventV1[] {
    const allEvents = this.sessionLog.readRange({ sessionId, branchId });

    // Find all compaction.committed events to determine excluded ranges
    const excludedSequences = new Set<number>();

    for (const event of allEvents) {
      if (event.eventType === 'compaction.committed') {
        const payload = event.payload as Record<string, unknown>;
        const sourceRange = payload['sourceRange'] as { fromSequence: number; toSequence: number } | undefined;
        if (sourceRange) {
          // Apply pruning rules to determine which events in the range are excluded
          const rangeEvents = allEvents.filter(
            (e) => e.sequence >= sourceRange.fromSequence &&
                   e.sequence <= sourceRange.toSequence &&
                   e.eventType !== 'compaction.committed'
          );
          const pruningResult = applyModelFreePruning(rangeEvents, this.config.targetTokens);
          for (const seq of pruningResult.excludedSequences) {
            excludedSequences.add(seq);
          }

          // If summarization was used, exclude all source range events from context
          // (the summary replaces them in projected view, but not in durable log)
          if (payload['strategy'] === 'provider-summarization' && payload['summaryText']) {
            for (const rangeEvent of rangeEvents) {
              excludedSequences.add(rangeEvent.sequence);
            }
          }
        }
      }
    }

    // Return events not excluded by compaction
    return allEvents.filter((e) => !excludedSequences.has(e.sequence));
  }
}

// Export pruning helpers for testing
export {
  applyModelFreePruning,
  extractPreservationMetadata,
  estimateTokens,
  estimateEventTokens,
};
