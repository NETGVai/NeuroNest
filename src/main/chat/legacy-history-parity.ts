/**
 * Legacy history parity diagnostic.
 *
 * Task 13.1 (enhanced-chat-ui) — runs a structural shadow comparison between
 * the canonical projection derived from imported Session_Log events and the
 * legacy render sequence that would be produced from the raw compatibility
 * rows still living in `messages`/`chat_messages`/`chat_messages_overflow`.
 *
 * The diagnostic is a pure function that returns an in-memory report. Callers
 * (renderer-cutover gate, migration audit dashboards, integration tests) may
 * invoke it before advancing to canonical-only rendering. It never logs to
 * the console and never mutates source rows, canonical events, or import
 * markers.
 *
 * Comparison surface (task requirement):
 *   1. Turn count and role order
 *   2. Text equality on canonical fields
 *   3. Fenced code block count per narrative body
 *   4. Deterministic `deriveCodeIdentity` identity per fence, keyed on the
 *      canonical `responseId` (imported messageId) and
 *      `narrativeBlockStableKey` (derived from the message's source identity)
 *   5. Canonical metadata shape (agent, provider, model, channel, streamed,
 *      isCommand, attachmentIds) after the importer's authorization filter
 *
 * All divergence summaries carry only structural information (kinds, counts,
 * hashed identities, lengths); user-visible content is never echoed into the
 * report, keeping the diagnostic safe for support-export and audit surfaces.
 *
 * Requirements: 9.6, 11.7, 12.6, 13.9, 15.5
 *
 * @module src/main/chat/legacy-history-parity
 */

import { deriveCodeIdentity } from '../../renderer/structured-response/code-identity.js';

import type { SessionLog } from '../../harness/session-log/session-log.js';

import {
  LEGACY_HISTORY_IMPORT_VERSION,
  normalizeLegacyHistoryRecords,
  readImportedCanonicalRecords,
  type ImportedCanonicalRecord,
  type LegacyHistoryImportStore,
  type NormalizedImportRecord,
} from './legacy-history-import.js';

// ─── Public types ───────────────────────────────────────────────

/** Report status: whether the canonical projection matches the legacy render. */
export type LegacyHistoryParityStatus = 'match' | 'mismatch' | 'not-imported';

/** Divergence categories the parity diagnostic distinguishes. */
export type LegacyHistoryParityDivergenceKind =
  | 'not_imported'
  | 'accepted_count_mismatch'
  | 'canonical_missing_message'
  | 'legacy_missing_message'
  | 'role_order_mismatch'
  | 'turn_count_mismatch'
  | 'text_content_mismatch'
  | 'code_fence_count_mismatch'
  | 'code_fence_identity_mismatch'
  | 'metadata_shape_mismatch'
  | 'message_id_mismatch'
  | 'turn_id_mismatch';

/**
 * A single divergence, redacted to structural facts. Content bodies are
 * intentionally omitted; the report exposes hashed identities, kinds, indices,
 * and integer lengths only.
 */
export interface LegacyHistoryParityDivergenceV1 {
  readonly schemaVersion: 1;
  readonly kind: LegacyHistoryParityDivergenceKind;
  readonly sourceIdentityHash?: string;
  readonly messageIndex?: number;
  readonly turnIndex?: number;
  readonly fenceIndex?: number;
  readonly legacySummary?: string;
  readonly canonicalSummary?: string;
}

/** Report emitted by {@link computeLegacyHistoryParity}. */
export interface LegacyHistoryParityReportV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly branchId: string;
  readonly migrationVersion: 1;
  readonly status: LegacyHistoryParityStatus;
  readonly legacyMessageCount: number;
  readonly canonicalMessageCount: number;
  readonly legacyTurnCount: number;
  readonly canonicalTurnCount: number;
  readonly quarantinedLegacyCount: number;
  readonly comparedAt: string;
  readonly divergences: readonly LegacyHistoryParityDivergenceV1[];
}

/** Inputs to {@link computeLegacyHistoryParity}. */
export interface LegacyHistoryParityInputs {
  readonly store: LegacyHistoryImportStore;
  readonly sessionLog: SessionLog;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly clock?: () => Date;
}

// ─── Fence extraction (pure) ────────────────────────────────────

/** A single fenced code block extracted from a narrative body. */
export interface ExtractedFencedBlock {
  readonly language: string;
  readonly body: string;
}

/**
 * Extract fenced code blocks from a Markdown-like content string.
 *
 * Line-based scan pairing consecutive triple-backtick fences (` ``` `). The
 * scanner ignores unmatched closing fences (the legacy renderer likewise
 * treats them as inert text). The result is deterministic and independent
 * of wall-clock time.
 */
export function extractFencedCodeBlocks(content: string): readonly ExtractedFencedBlock[] {
  const blocks: ExtractedFencedBlock[] = [];
  const lines = content.split('\n');
  let inFence = false;
  let currentLanguage = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const fenceStart = /^```(.*)$/.exec(line);
    if (fenceStart !== null) {
      if (inFence) {
        blocks.push({ language: currentLanguage, body: currentBody.join('\n') });
        inFence = false;
        currentLanguage = '';
        currentBody = [];
      } else {
        inFence = true;
        currentLanguage = (fenceStart[1] ?? '').trim();
      }
      continue;
    }
    if (inFence) currentBody.push(line);
  }

  return blocks;
}

/**
 * Deterministic narrative-block stable key for an imported message. Both
 * legacy and canonical sides derive this the same way from the source
 * identity, so any mismatch in derived {@link deriveCodeIdentity} output
 * is caused by a mismatch in fence position, not by different inputs.
 */
export function narrativeBlockStableKeyFor(sourceIdentityHash: string): string {
  return `legacy-import-narrative-${sourceIdentityHash.slice(0, 32)}`;
}

// ─── Comparison core ────────────────────────────────────────────

interface DivergenceCollector {
  readonly divergences: LegacyHistoryParityDivergenceV1[];
  add(divergence: Omit<LegacyHistoryParityDivergenceV1, 'schemaVersion'>): void;
}

function createDivergenceCollector(): DivergenceCollector {
  const divergences: LegacyHistoryParityDivergenceV1[] = [];
  return {
    divergences,
    add(divergence) {
      divergences.push({ schemaVersion: 1, ...divergence });
    },
  };
}

function countTurns(records: readonly { turnId: string }[]): number {
  const seen = new Set<string>();
  for (const record of records) if (record.turnId.length > 0) seen.add(record.turnId);
  return seen.size;
}

function metadataFingerprint(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata).sort();
  const entries = keys.map((key) => {
    const value = metadata[key];
    if (Array.isArray(value)) return `${key}=array[${value.length}]`;
    if (typeof value === 'string') return `${key}=string[${value.length}]`;
    if (typeof value === 'boolean') return `${key}=boolean:${value}`;
    return `${key}=${typeof value}`;
  });
  return entries.join('|');
}

function compareCodeFences(
  index: number,
  accepted: NormalizedImportRecord,
  canonical: ImportedCanonicalRecord,
  divergences: DivergenceCollector,
): void {
  const legacyFences = extractFencedCodeBlocks(accepted.content);
  const canonicalFences = extractFencedCodeBlocks(canonical.content);
  if (legacyFences.length !== canonicalFences.length) {
    divergences.add({
      kind: 'code_fence_count_mismatch',
      sourceIdentityHash: accepted.sourceIdentityHash,
      messageIndex: index,
      legacySummary: `count=${legacyFences.length}`,
      canonicalSummary: `count=${canonicalFences.length}`,
    });
    return;
  }

  const legacyNarrativeKey = narrativeBlockStableKeyFor(accepted.sourceIdentityHash);
  const canonicalNarrativeKey = narrativeBlockStableKeyFor(canonical.sourceIdentityHash);
  const fenceCount = legacyFences.length;
  for (let fenceIndex = 0; fenceIndex < fenceCount; fenceIndex += 1) {
    const legacyIdentity = deriveCodeIdentity({
      responseId: accepted.messageId,
      narrativeBlockStableKey: legacyNarrativeKey,
      fenceIndex,
    });
    const canonicalIdentity = deriveCodeIdentity({
      responseId: canonical.messageId,
      narrativeBlockStableKey: canonicalNarrativeKey,
      fenceIndex,
    });
    if (legacyIdentity !== canonicalIdentity) {
      divergences.add({
        kind: 'code_fence_identity_mismatch',
        sourceIdentityHash: accepted.sourceIdentityHash,
        messageIndex: index,
        fenceIndex,
        legacySummary: legacyIdentity,
        canonicalSummary: canonicalIdentity,
      });
    } else {
      const legacyFence = legacyFences[fenceIndex]!;
      const canonicalFence = canonicalFences[fenceIndex]!;
      if (
        legacyFence.language !== canonicalFence.language ||
        legacyFence.body.length !== canonicalFence.body.length
      ) {
        divergences.add({
          kind: 'code_fence_identity_mismatch',
          sourceIdentityHash: accepted.sourceIdentityHash,
          messageIndex: index,
          fenceIndex,
          legacySummary: `lang=${legacyFence.language},bodyLen=${legacyFence.body.length}`,
          canonicalSummary: `lang=${canonicalFence.language},bodyLen=${canonicalFence.body.length}`,
        });
      }
    }
  }
}

function alignByMessageId(
  accepted: readonly NormalizedImportRecord[],
  canonical: readonly ImportedCanonicalRecord[],
  divergences: DivergenceCollector,
): Array<{ index: number; accepted: NormalizedImportRecord; canonical: ImportedCanonicalRecord } | undefined> {
  const canonicalByMessageId = new Map<string, ImportedCanonicalRecord>();
  for (const record of canonical) canonicalByMessageId.set(record.messageId, record);

  return accepted.map((record, index) => {
    const canonicalMatch = canonicalByMessageId.get(record.messageId);
    if (canonicalMatch === undefined) {
      divergences.add({
        kind: 'canonical_missing_message',
        sourceIdentityHash: record.sourceIdentityHash,
        messageIndex: index,
        legacySummary: `messageId=${record.messageId}`,
      });
      return undefined;
    }
    return { index, accepted: record, canonical: canonicalMatch };
  });
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Compute a structural parity report for one session.
 *
 * The function reads legacy compatibility rows through the supplied store and
 * imported canonical events through the supplied Session_Log. It normalizes
 * both, then compares turn shape, role order, message text, fenced code
 * block identity, and canonical metadata. It does not persist anything.
 *
 * Callers that want to gate a renderer cutover should treat any report whose
 * `status !== 'match'` as blocking. Consult {@link LegacyHistoryParityReportV1.divergences}
 * for the structural detail.
 */
export function computeLegacyHistoryParity(
  inputs: LegacyHistoryParityInputs,
): LegacyHistoryParityReportV1 {
  const branchId = inputs.branchId ?? 'main';
  const clock = inputs.clock ?? (() => new Date());
  const collector = createDivergenceCollector();

  const legacyRows = inputs.store.readCompatibilityRecords(inputs.sessionId);
  const { accepted, quarantined } = normalizeLegacyHistoryRecords(legacyRows, {
    sessionId: inputs.sessionId,
    branchId,
    clock,
  });
  const canonical = readImportedCanonicalRecords(inputs.sessionLog, inputs.sessionId, branchId);

  const legacyMessageCount = accepted.length;
  const canonicalMessageCount = canonical.length;
  const legacyTurnCount = countTurns(accepted);
  const canonicalTurnCount = countTurns(canonical);

  // If the importer has never run for this session, the report signals
  // `not-imported` rather than a mismatch so callers can distinguish
  // "nothing to compare yet" from "import produced a divergent result".
  if (canonicalMessageCount === 0 && legacyMessageCount > 0) {
    collector.add({
      kind: 'not_imported',
      legacySummary: `legacyMessageCount=${legacyMessageCount}`,
      canonicalSummary: 'canonicalMessageCount=0',
    });
    return finalizeReport({
      inputs,
      branchId,
      clock,
      status: 'not-imported',
      legacyMessageCount,
      canonicalMessageCount,
      legacyTurnCount,
      canonicalTurnCount,
      quarantined,
      divergences: collector.divergences,
    });
  }

  if (canonicalMessageCount === 0 && legacyMessageCount === 0) {
    return finalizeReport({
      inputs,
      branchId,
      clock,
      status: 'match',
      legacyMessageCount,
      canonicalMessageCount,
      legacyTurnCount,
      canonicalTurnCount,
      quarantined,
      divergences: collector.divergences,
    });
  }

  if (legacyMessageCount !== canonicalMessageCount) {
    collector.add({
      kind: 'accepted_count_mismatch',
      legacySummary: `count=${legacyMessageCount}`,
      canonicalSummary: `count=${canonicalMessageCount}`,
    });
  }

  if (legacyTurnCount !== canonicalTurnCount) {
    collector.add({
      kind: 'turn_count_mismatch',
      legacySummary: `count=${legacyTurnCount}`,
      canonicalSummary: `count=${canonicalTurnCount}`,
    });
  }

  // Detect canonical rows that never had a corresponding legacy source row.
  // Alignment below is driven by `accepted`; anything extra on the canonical
  // side is surfaced separately so a renderer cutover cannot silently pick up
  // ghost history.
  const acceptedMessageIds = new Set(accepted.map((record) => record.messageId));
  for (let i = 0; i < canonical.length; i += 1) {
    const record = canonical[i]!;
    if (!acceptedMessageIds.has(record.messageId)) {
      collector.add({
        kind: 'legacy_missing_message',
        sourceIdentityHash: record.sourceIdentityHash,
        messageIndex: i,
        canonicalSummary: `messageId=${record.messageId}`,
      });
    }
  }

  const alignedPairs = alignByMessageId(accepted, canonical, collector);

  for (const pair of alignedPairs) {
    if (pair === undefined) continue;
    const { index, accepted: acceptedRecord, canonical: canonicalRecord } = pair;

    if (acceptedRecord.role !== canonicalRecord.role) {
      collector.add({
        kind: 'role_order_mismatch',
        sourceIdentityHash: acceptedRecord.sourceIdentityHash,
        messageIndex: index,
        legacySummary: `role=${acceptedRecord.role}`,
        canonicalSummary: `role=${canonicalRecord.role}`,
      });
    }

    if (acceptedRecord.turnId !== canonicalRecord.turnId) {
      collector.add({
        kind: 'turn_id_mismatch',
        sourceIdentityHash: acceptedRecord.sourceIdentityHash,
        messageIndex: index,
        legacySummary: acceptedRecord.turnId,
        canonicalSummary: canonicalRecord.turnId,
      });
    }

    if (acceptedRecord.sourceIdentityHash !== canonicalRecord.sourceIdentityHash) {
      collector.add({
        kind: 'message_id_mismatch',
        sourceIdentityHash: acceptedRecord.sourceIdentityHash,
        messageIndex: index,
        legacySummary: acceptedRecord.sourceIdentityHash,
        canonicalSummary: canonicalRecord.sourceIdentityHash,
      });
    }

    if (acceptedRecord.content !== canonicalRecord.content) {
      collector.add({
        kind: 'text_content_mismatch',
        sourceIdentityHash: acceptedRecord.sourceIdentityHash,
        messageIndex: index,
        legacySummary: `length=${acceptedRecord.content.length}`,
        canonicalSummary: `length=${canonicalRecord.content.length}`,
      });
      // Skip fence comparison when text already differs — we already know the
      // narrative bodies are not equivalent and further reports would be
      // redundant noise for callers.
      continue;
    }

    compareCodeFences(index, acceptedRecord, canonicalRecord, collector);

    const acceptedFingerprint = metadataFingerprint(acceptedRecord.metadata);
    const canonicalFingerprint = metadataFingerprint(canonicalRecord.metadata);
    if (acceptedFingerprint !== canonicalFingerprint) {
      collector.add({
        kind: 'metadata_shape_mismatch',
        sourceIdentityHash: acceptedRecord.sourceIdentityHash,
        messageIndex: index,
        legacySummary: acceptedFingerprint,
        canonicalSummary: canonicalFingerprint,
      });
    }
  }

  return finalizeReport({
    inputs,
    branchId,
    clock,
    status: collector.divergences.length === 0 ? 'match' : 'mismatch',
    legacyMessageCount,
    canonicalMessageCount,
    legacyTurnCount,
    canonicalTurnCount,
    quarantined,
    divergences: collector.divergences,
  });
}

interface FinalizeInputs {
  readonly inputs: LegacyHistoryParityInputs;
  readonly branchId: string;
  readonly clock: () => Date;
  readonly status: LegacyHistoryParityStatus;
  readonly legacyMessageCount: number;
  readonly canonicalMessageCount: number;
  readonly legacyTurnCount: number;
  readonly canonicalTurnCount: number;
  readonly quarantined: readonly unknown[];
  readonly divergences: readonly LegacyHistoryParityDivergenceV1[];
}

function finalizeReport(finalize: FinalizeInputs): LegacyHistoryParityReportV1 {
  return {
    schemaVersion: 1,
    sessionId: finalize.inputs.sessionId,
    branchId: finalize.branchId,
    migrationVersion: LEGACY_HISTORY_IMPORT_VERSION,
    status: finalize.status,
    legacyMessageCount: finalize.legacyMessageCount,
    canonicalMessageCount: finalize.canonicalMessageCount,
    legacyTurnCount: finalize.legacyTurnCount,
    canonicalTurnCount: finalize.canonicalTurnCount,
    quarantinedLegacyCount: finalize.quarantined.length,
    comparedAt: finalize.clock().toISOString(),
    divergences: finalize.divergences,
  };
}

// ─── Renderer-cutover gate helper ───────────────────────────────

/**
 * Reason a renderer cutover was refused. Returned only when the parity
 * report is not `match`; consumers should render the reason as a
 * non-secret diagnostic tag alongside the underlying report.
 */
export type LegacyHistoryCutoverRefusalReason =
  | 'parity_not_imported'
  | 'parity_mismatch';

/**
 * Result of {@link evaluateLegacyHistoryCutover}. The report is always
 * present so callers can drill into the divergence list even when the
 * gate refuses; consumers must treat `allowed === false` as terminal for
 * this session.
 */
export type LegacyHistoryCutoverGateDecision =
  | { readonly allowed: true; readonly report: LegacyHistoryParityReportV1 }
  | {
      readonly allowed: false;
      readonly reason: LegacyHistoryCutoverRefusalReason;
      readonly report: LegacyHistoryParityReportV1;
    };

/**
 * Renderer-cutover gate: run the parity diagnostic and translate its status
 * into a boolean allow/deny decision. Task 13.2 wires this behind an existing
 * publication/feature-gate check before removing direct legacy subscriptions,
 * ensuring the renderer never falls back to legacy channels once canonical
 * projections diverge from source rows.
 *
 * The function is pure — it does not read or write any feature-gate state.
 * Callers compose it with their gate (for example, guarding it behind the
 * existing structured-chat cutover check) and log only the returned report,
 * which carries no user content.
 */
export function evaluateLegacyHistoryCutover(
  inputs: LegacyHistoryParityInputs,
): LegacyHistoryCutoverGateDecision {
  const report = computeLegacyHistoryParity(inputs);
  if (report.status === 'match') return { allowed: true, report };
  return {
    allowed: false,
    reason: report.status === 'not-imported' ? 'parity_not_imported' : 'parity_mismatch',
    report,
  };
}
