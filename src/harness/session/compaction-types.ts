/**
 * Context Compaction and Tool Spill Types
 *
 * Defines contracts for model-free pruning, Provider_Registry summarization
 * fallback, compaction evidence, spill storage, and authorized range retrieval.
 *
 * Requirements: 4.1–4.8, 37.3–37.4, 37.8–37.9, 42.4
 */

import { z } from 'zod';
import type { SessionEventV1 } from '../contracts/event.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';

// ─── Compaction Strategy ────────────────────────────────────────

/**
 * Strategy hierarchy applied in order.
 * Model-free pruning is always attempted first (Requirement 4.1).
 */
export type CompactionStrategy = 'model-free-pruning' | 'provider-summarization';

/**
 * Metadata preserved through compaction (Requirement 4.3).
 */
export interface PreservationMetadata {
  /** File references that must survive compaction */
  fileReferences: string[];
  /** Diagnostic identifiers preserved */
  diagnosticIds: string[];
  /** Code reference identifiers preserved */
  codeReferences: string[];
  /** Decision identifiers preserved */
  decisionIds: string[];
  /** Tool call identities preserved */
  toolCallIds: string[];
  /** Tool result identities preserved */
  toolResultIds: string[];
  /** Attachment identities preserved */
  attachmentIds: string[];
}

/**
 * Compaction plan — describes what will be compacted and how.
 */
export interface CompactionPlan {
  /** Unique plan identifier */
  planId: string;
  /** Session being compacted */
  sessionId: string;
  /** Branch being compacted */
  branchId: string;
  /** Source event range for compaction */
  sourceRange: {
    fromSequence: number;
    toSequence: number;
  };
  /** Strategy selected */
  strategy: CompactionStrategy;
  /** Metadata that will be preserved */
  preservation: PreservationMetadata;
  /** Estimated token reduction */
  estimatedReduction: number;
  /** Summary route used (if provider-summarization) */
  summaryRoute?: string | undefined;
  /** Accounting uncertainty note */
  accountingUncertainty?: string | undefined;
}

/**
 * Compaction evidence appended to Session_Log (Requirement 4.4).
 */
export interface CompactionEvidence {
  /** Plan this evidence records */
  planId: string;
  /** Source range that was compacted */
  sourceRange: {
    fromSequence: number;
    toSequence: number;
  };
  /** Strategy applied */
  strategy: CompactionStrategy;
  /** Route used for summarization (if any) */
  summaryRoute?: string | undefined;
  /** Accounting uncertainty annotation */
  accountingUncertainty?: string | undefined;
  /** Preserved structured metadata */
  preservation: PreservationMetadata;
  /** Summary text produced (kept as separate record, not replacement) */
  summaryText?: string | undefined;
}

/**
 * Configuration for the Context_Compactor, derived from operational bounds.
 */
export interface CompactorConfig {
  /** Token threshold triggering compaction consideration */
  pressureThresholdTokens: number;
  /** Target token count after compaction */
  targetTokens: number;
  /** Maximum tokens for provider-based summarization request */
  maxSummarizationTokens: number;
  /** Whether to use provider summarization as fallback */
  enableProviderSummarization: boolean;
}

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** Whether compaction was committed */
  committed: boolean;
  /** Strategy that was applied */
  strategy: CompactionStrategy;
  /** New event sequence (the compaction.committed event) */
  newSequence?: number | undefined;
  /** Compaction event ID */
  compactionEventId?: string | undefined;
  /** Token reduction achieved */
  tokensReduced: number;
  /** Metadata preserved */
  preservation: PreservationMetadata;
}

// ─── Pruning Rules ──────────────────────────────────────────────

/**
 * Model-free pruning rule identifiers.
 * These rules remove redundant events without requiring model interaction.
 */
export type PruningRule =
  | 'redundant-tool-results'   // Remove intermediate results superseded by final
  | 'duplicate-diagnostics'    // Remove repeated identical diagnostics
  | 'superseded-context'       // Remove context injections superseded by later ones
  | 'completed-streaming'      // Collapse streaming partial blocks into final
  | 'expired-collaboration'    // Remove expired collaboration prompts
  | 'stale-queue-entries';     // Remove delivered/removed queue entries

/**
 * Result of model-free pruning pass.
 */
export interface PruningResult {
  /** Rules that were applied */
  rulesApplied: PruningRule[];
  /** Events excluded from projected context (still in log) */
  excludedSequences: number[];
  /** Estimated token savings */
  tokensSaved: number;
  /** Whether pruning achieved target */
  targetAchieved: boolean;
}

// ─── Provider Summarization ─────────────────────────────────────

/**
 * Interface for Provider_Registry summarization capability.
 * The actual implementation routes through Provider_Registry;
 * this type allows dependency injection for testing.
 */
export interface SummarizationProvider {
  /**
   * Summarize a set of events into a bounded text summary.
   * The summary is a SEPARATE record, never replaces original events.
   */
  summarize(request: SummarizationRequest): Promise<SummarizationResponse>;
}

export interface SummarizationRequest {
  /** Events to summarize (ordered by sequence) */
  events: SessionEventV1[];
  /** Maximum tokens for the summary */
  maxTokens: number;
  /** Metadata that must be preserved in summary */
  requiredPreservation: PreservationMetadata;
}

export interface SummarizationResponse {
  /** The summary text */
  summaryText: string;
  /** Estimated token count of summary */
  summaryTokens: number;
  /** Route used for summarization */
  route: string;
  /** Accounting uncertainty */
  uncertainty?: string;
}

// ─── Tool Spill Types ───────────────────────────────────────────

/**
 * Spill record stored for an oversized Canonical_Tool_Value (Requirement 4.5).
 */
export interface SpillRecord {
  /** Unique spill identifier */
  spillId: string;
  /** Tool call ID this spill belongs to */
  callId: string;
  /** Session ID owning this spill */
  sessionId: string;
  /** Branch ID */
  branchId: string;
  /** Authorized locator for retrieval */
  locator: string;
  /** Media type of the spilled content */
  mediaType: string;
  /** Total byte size of the spilled content */
  totalBytes: number;
  /** Scope descriptor for access control */
  scope: ScopeDescriptorV1;
  /** Expiry timestamp (ISO 8601) */
  expiresAt?: string | undefined;
  /** Content digest for integrity */
  contentDigest: string;
  /** Created timestamp */
  createdAt: string;
}

/**
 * A bounded preview returned in place of the full content (Requirement 4.5).
 */
export interface SpillPreview {
  /** Locator for retrieving the full content */
  locator: string;
  /** Media type of the content */
  mediaType: string;
  /** Preview text/data (bounded by configured limit) */
  previewData: string;
  /** Total size of the complete content */
  totalBytes: number;
  /** Preview size returned */
  previewBytes: number;
  /** Whether full content is available via range retrieval */
  rangeRetrievalAvailable: boolean;
}

/**
 * Range retrieval request for spilled content (Requirement 4.6).
 */
export interface SpillRangeRequest {
  /** Locator for the spilled content */
  locator: string;
  /** Byte offset to start reading from */
  byteOffset: number;
  /** Number of bytes to read */
  byteLength: number;
  /** Scope of the requesting caller */
  callerScope: ScopeDescriptorV1;
}

/**
 * Range retrieval result (Requirement 4.6).
 */
export interface SpillRangeResult {
  /** Retrieved data segment */
  data: string;
  /** Media type */
  mediaType: string;
  /** Total bytes of the complete spilled content */
  totalBytes: number;
  /** Actual bytes returned (may be less than requested) */
  returnedBytes: number;
}

/**
 * Structured error for spill retrieval failures (Requirement 4.7).
 */
export type SpillError =
  | { code: 'invalid_locator'; message: string }
  | { code: 'expired_locator'; message: string; expiredAt: string }
  | { code: 'scope_mismatch'; message: string }
  | { code: 'range_exceeded'; message: string; maxBytes: number }
  | { code: 'not_found'; message: string };

/**
 * Configuration for Tool_Spill_Service, derived from operational bounds.
 */
export interface SpillConfig {
  /** Byte threshold above which a tool value is spilled */
  spillThresholdBytes: number;
  /** Maximum preview size returned in context */
  previewSizeLimitBytes: number;
  /** Maximum bytes returned per range retrieval */
  retrievalLimitBytes: number;
  /** Default expiry duration in milliseconds (0 = no expiry) */
  defaultExpiryMs: number;
}

// ─── Zod Schemas for Validation ─────────────────────────────────

export const CompactionEvidenceSchema = z.object({
  type: z.literal('compaction.committed'),
  planId: z.string().min(1),
  sourceRange: z.object({
    fromSequence: z.number().int().nonnegative(),
    toSequence: z.number().int().nonnegative(),
  }),
  strategy: z.enum(['model-free-pruning', 'provider-summarization']),
  summaryRoute: z.string().optional(),
  accountingUncertainty: z.string().optional(),
  preservation: z.object({
    fileReferences: z.array(z.string()),
    diagnosticIds: z.array(z.string()),
    codeReferences: z.array(z.string()),
    decisionIds: z.array(z.string()),
    toolCallIds: z.array(z.string()),
    toolResultIds: z.array(z.string()),
    attachmentIds: z.array(z.string()),
  }),
  summaryText: z.string().optional(),
});

export const SpillRecordSchema = z.object({
  spillId: z.string().min(1),
  callId: z.string().min(1),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  locator: z.string().min(1),
  mediaType: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  scope: z.object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    ownerId: z.string().optional(),
    schemaVersion: z.literal(1),
  }).passthrough(),
  expiresAt: z.string().datetime().optional(),
  contentDigest: z.string().min(1),
  createdAt: z.string().datetime(),
});
