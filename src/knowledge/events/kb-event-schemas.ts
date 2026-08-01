/**
 * KB Event Zod Schemas — structured event definitions for the Knowledge Base subsystem.
 *
 * Defines Zod-validated schemas for all KB event kinds:
 *   - kb.ingest.start / kb.ingest.complete / kb.ingest.error
 *   - kb.retrieve.complete
 *   - kb.freshness.stale / kb.freshness.reindex
 *
 * Source identifiers registered with EventLogRateLimiter:
 *   - `kb-ingest`   — all ingest-related events
 *   - `kb-freshness` — all freshness-tracking events
 *
 * Requirements: 26.1, 26.3, 26.4, 2.5, 2.6
 */

import { z } from 'zod';
import type { EventLog, EventKind } from '../../pipeline/event-log';

// ─── Source Identifiers ────────────────────────────────────────

/**
 * Source identifiers used for EventLogRateLimiter per-source sliding-window
 * enforcement (100 events/second per source).
 */
export const KB_SOURCE_IDENTIFIERS = {
  INGEST: 'kb-ingest',
  FRESHNESS: 'kb-freshness',
} as const;

// ─── KB Event Kinds ────────────────────────────────────────────

/**
 * All event kinds emitted by the KB subsystem.
 * These extend the base EventKind union at runtime registration.
 */
export const KB_EVENT_KINDS = {
  INGEST_START: 'kb.ingest.start' as EventKind,
  INGEST_COMPLETE: 'kb.ingest.complete' as EventKind,
  INGEST_ERROR: 'kb.ingest.error' as EventKind,
  RETRIEVE_COMPLETE: 'kb.retrieve.complete' as EventKind,
  FRESHNESS_STALE: 'kb.freshness.stale' as EventKind,
  FRESHNESS_REINDEX: 'kb.freshness.reindex' as EventKind,
} as const;

// ─── Ingest Event Schemas ──────────────────────────────────────

/**
 * Emitted when ingestion of a knowledge source begins.
 * Source identifier: `kb-ingest`
 */
export const KBIngestStartSchema = z.object({
  sourceUri: z.string().min(1),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
});
export type KBIngestStartPayload = z.infer<typeof KBIngestStartSchema>;

/**
 * Emitted when ingestion of a knowledge source completes successfully.
 * Source identifier: `kb-ingest`
 */
export const KBIngestCompleteSchema = z.object({
  sourceUri: z.string().min(1),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  chunkCount: z.number().int().nonnegative(),
  embedCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type KBIngestCompletePayload = z.infer<typeof KBIngestCompleteSchema>;

/**
 * Emitted when ingestion encounters an error (per-document or per-source).
 * Source identifier: `kb-ingest`
 */
export const KBIngestErrorSchema = z.object({
  sourceUri: z.string().min(1),
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  error: z.string().min(1),
  phase: z.enum(['fetch', 'chunk', 'embed', 'index', 'validate']),
});
export type KBIngestErrorPayload = z.infer<typeof KBIngestErrorSchema>;

// ─── Retrieve Event Schemas ────────────────────────────────────

/**
 * Emitted when a KB retrieval query completes.
 * Source identifier: `kb-ingest` (retrieval events share the ingest source limiter)
 */
export const KBRetrieveCompleteSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().max(200),
  chunkCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  queryTimeMs: z.number().nonnegative(),
});
export type KBRetrieveCompletePayload = z.infer<typeof KBRetrieveCompleteSchema>;

// ─── Freshness Event Schemas ───────────────────────────────────

/**
 * Emitted when a knowledge source is detected as stale (content has changed).
 * Source identifier: `kb-freshness`
 */
export const KBFreshnessStaleSchema = z.object({
  sourceUri: z.string().min(1),
  sourceId: z.string().min(1),
  detectionMethod: z.enum(['mtime', 'commit-hash', 'etag', 'last-modified']),
  previousHash: z.string(),
  currentHash: z.string(),
});
export type KBFreshnessStalePayload = z.infer<typeof KBFreshnessStaleSchema>;

/**
 * Emitted when a stale source begins re-indexing.
 * Source identifier: `kb-freshness`
 */
export const KBFreshnessReindexSchema = z.object({
  sourceUri: z.string().min(1),
  sourceId: z.string().min(1),
  trigger: z.enum(['scheduled', 'manual', 'on-change']),
});
export type KBFreshnessReindexPayload = z.infer<typeof KBFreshnessReindexSchema>;

// ─── Schema Registry Map ───────────────────────────────────────

/**
 * Maps each KB event kind to its corresponding Zod schema.
 * Used by `registerKBEventSchemas()` to register all schemas with the EventLog.
 */
export const KB_EVENT_SCHEMA_MAP: ReadonlyMap<EventKind, z.ZodType> = new Map<EventKind, z.ZodType>([
  [KB_EVENT_KINDS.INGEST_START, KBIngestStartSchema as z.ZodType],
  [KB_EVENT_KINDS.INGEST_COMPLETE, KBIngestCompleteSchema as z.ZodType],
  [KB_EVENT_KINDS.INGEST_ERROR, KBIngestErrorSchema as z.ZodType],
  [KB_EVENT_KINDS.RETRIEVE_COMPLETE, KBRetrieveCompleteSchema as z.ZodType],
  [KB_EVENT_KINDS.FRESHNESS_STALE, KBFreshnessStaleSchema as z.ZodType],
  [KB_EVENT_KINDS.FRESHNESS_REINDEX, KBFreshnessReindexSchema as z.ZodType],
]);

// ─── Registration Helper ───────────────────────────────────────

/**
 * Register all KB event Zod schemas with an EventLog instance.
 * Call this during KB subsystem initialization (gated behind NEURONEST_KB_SYSTEM).
 *
 * This ensures that:
 *   - All emitted KB events are validated against their Zod schema before persistence
 *   - Invalid payloads are rejected (not dispatched) per Requirement 26.3
 *   - Events are rate-limited via the appropriate source identifier per Requirement 26.4
 */
export function registerKBEventSchemas(eventLog: EventLog): void {
  for (const [kind, schema] of KB_EVENT_SCHEMA_MAP) {
    eventLog.registerSchema(kind, schema);
  }
}
