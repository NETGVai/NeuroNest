/**
 * Legacy Canonical Ingestion
 *
 * Task 8.4 target module: wires the compatibility path
 *
 *   (renderer-shipped legacy channel)
 *     → LegacyResponseAdapter.parseEnvelope
 *     → LegacyResponseDuplicateLedgers.accept
 *     → LegacyResponseLifecycleNormalizer.normalize
 *
 * into one boundary that produces deterministic canonical identities,
 * deterministic idempotency keys, and normalized SessionLog-ready facts. The
 * five legacy renderer channels are `chat-response`, `chat:stream`,
 * `chat:done`, `chat:error`, and `chat:stream-chunk`.
 *
 * Every ingestion result is explicitly labelled `renderVisibility: 'projection-only'`.
 * Renderers must not read a compatibility delivery directly; the only supported
 * rendering path is the versioned projection subscription (task 8.2). The
 * ingestion result exposes the durable normalized facts so that callers can
 * append them to SessionLog through `appendNormalizedChatEvents` — the same
 * transactional idempotent boundary used by the canonical stream from task 7.4.
 *
 * Requirements: 9.6, 10.1–10.7, 12.3, 15.3–15.5
 */

import {
  LegacyResponseAdapter,
  type LegacyEnvelopeParseResult,
  type LegacyEventChannel,
  type LegacyIngressContextV1,
  type LegacyResponseAdapterOptions,
} from './legacy-response-adapter.js';
import {
  LegacyResponseDuplicateLedgers,
  computeLegacyLogicalEventId,
  computeLegacyLogicalSlotId,
  type LegacyDeduplicationInputV1,
  type LegacyDuplicateDecisionV1,
  type LegacyDuplicateLedgerOptions,
  type LegacyDuplicateLedgerSnapshotV1,
} from './legacy-response-deduplication.js';
import {
  LegacyResponseLifecycleNormalizer,
  type LegacyLifecycleEnvelopeV1,
  type LifecycleNormalizationResultV1,
  type NormalizedChatEventV1,
} from './legacy-response-lifecycle.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Compatibility deliveries have exactly one supported rendering path: the
 * versioned projection subscription (`chat-projection:delta-v1` /
 * `chat-projection:invalidated-v1`). Every ingestion result exposes this label
 * so callers can enforce the prohibition on direct DOM rendering at their
 * boundary without depending on control flow.
 */
export const LEGACY_CANONICAL_RENDER_VISIBILITY = 'projection-only' as const;
export type LegacyCanonicalRenderVisibility = typeof LEGACY_CANONICAL_RENDER_VISIBILITY;

export interface LegacyCanonicalIngestionOptions {
  readonly adapter?: LegacyResponseAdapter;
  readonly adapterOptions?: LegacyResponseAdapterOptions;
  readonly deduplication?: LegacyResponseDuplicateLedgers;
  readonly deduplicationOptions?: LegacyDuplicateLedgerOptions;
  readonly lifecycle?: LegacyResponseLifecycleNormalizer;
}

export type LegacyCanonicalIngestionRejectionCode =
  | 'INVALID_CONTRACT'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_REQUIRED_FIELD'
  | 'UNSUPPORTED_FAMILY_CHANNEL'
  | 'TRANSPORT_DUPLICATE'
  | 'SEMANTIC_DUPLICATE'
  | 'ORDINAL_PAYLOAD_CONFLICT'
  | 'TERMINAL_CONFLICT';

/**
 * A canonical ingestion outcome for one legacy delivery.
 *
 * `renderVisibility` is always `projection-only`. The renderer must not read
 * this record directly; the only supported rendering path is the versioned
 * projection subscription (see design § "Canonical Chat Cutover"). Callers
 * that want to persist the delivery for downstream projection append
 * `normalizedFacts` to SessionLog through `appendNormalizedChatEvents` from
 * `src/harness/session-log`.
 */
export type LegacyCanonicalIngestionResultV1 =
  | {
      readonly accepted: true;
      readonly renderVisibility: LegacyCanonicalRenderVisibility;
      readonly channel: LegacyEventChannel;
      readonly canonicalEventId: string;
      readonly canonicalIdempotencyKey: string;
      readonly canonicalLogicalSlotId: string;
      readonly payloadDigest: string;
      readonly reconciled: boolean;
      readonly duplicateDecision: Extract<LegacyDuplicateDecisionV1, { accepted: true }>;
      readonly envelope: LegacyLifecycleEnvelopeV1;
      readonly normalizedFacts: readonly NormalizedChatEventV1[];
      readonly terminalConflict: false;
    }
  | {
      readonly accepted: false;
      readonly renderVisibility: LegacyCanonicalRenderVisibility;
      readonly channel?: LegacyEventChannel;
      readonly reasonCode: LegacyCanonicalIngestionRejectionCode;
      readonly canonicalEventId?: string;
      readonly canonicalIdempotencyKey?: string;
      readonly canonicalLogicalSlotId?: string;
      readonly duplicateDecision?: LegacyDuplicateDecisionV1;
      readonly lifecycle?: LifecycleNormalizationResultV1;
      readonly envelope?: LegacyLifecycleEnvelopeV1;
      readonly diagnostic?: Extract<
        LegacyEnvelopeParseResult,
        { accepted: false }
      >['diagnostic'];
    };

export interface LegacyCanonicalIngestionSnapshotV1 {
  readonly deduplication: LegacyDuplicateLedgerSnapshotV1;
}

// ─── Implementation ─────────────────────────────────────────────────────────

const REJECTION_MAP: Readonly<Record<string, LegacyCanonicalIngestionRejectionCode>> = {
  INVALID_CONTRACT: 'INVALID_CONTRACT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  UNSUPPORTED_FAMILY_CHANNEL: 'UNSUPPORTED_FAMILY_CHANNEL',
};

function normalizeInto(
  envelope: LegacyLifecycleEnvelopeV1,
  lifecycle: LegacyResponseLifecycleNormalizer,
): LifecycleNormalizationResultV1 {
  return lifecycle.normalize(envelope);
}

/**
 * Combined main-process boundary for every legacy renderer channel.
 *
 * The ingestion pipeline is intentionally single-pass and side-effect free
 * beyond its own dedup/lifecycle stores: it does not append to SessionLog and
 * does not touch renderer state. Callers integrate it with SessionLog and the
 * projection publisher explicitly, keeping this module usable from tests and
 * from IPC handlers without introducing a hidden global.
 */
export class LegacyCanonicalIngestion {
  private readonly adapter: LegacyResponseAdapter;
  private readonly deduplication: LegacyResponseDuplicateLedgers;
  private readonly lifecycle: LegacyResponseLifecycleNormalizer;

  constructor(options: LegacyCanonicalIngestionOptions = {}) {
    this.adapter = options.adapter ?? new LegacyResponseAdapter(options.adapterOptions);
    this.deduplication =
      options.deduplication ?? new LegacyResponseDuplicateLedgers(options.deduplicationOptions);
    this.lifecycle = options.lifecycle ?? new LegacyResponseLifecycleNormalizer();
  }

  /**
   * Ingest one legacy delivery.
   *
   * `raw` is the untrusted envelope-or-payload received on the legacy IPC
   * channel. `channel` names the legacy channel it arrived on. `context`
   * supplies scope hints (session, branch, active turn, message, attempt) so
   * the adapter can assign missing identities deterministically.
   *
   * The returned record is always addressed by `renderVisibility === 'projection-only'`
   * regardless of outcome; the renderer must not consume it directly.
   */
  ingest(
    raw: unknown,
    channel: string,
    context: LegacyIngressContextV1 = {},
  ): LegacyCanonicalIngestionResultV1 {
    const parseResult = this.adapter.accept(raw, channel, context);
    if (!parseResult.accepted) {
      const rejection = REJECTION_MAP[parseResult.diagnostic.reasonCode];
      return {
        accepted: false,
        renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
        reasonCode: rejection,
        channel: parseResult.diagnostic.channel,
        diagnostic: parseResult.diagnostic,
      };
    }

    const envelope = parseResult.envelope as LegacyLifecycleEnvelopeV1;
    const dedupInput: LegacyDeduplicationInputV1 = {
      deliveryId: envelope.deliveryId,
      channel: envelope.channel,
      family: envelope.family,
      sessionId: envelope.sessionId,
      branchId: envelope.branchId,
      turnId: envelope.turnId,
      messageId: envelope.messageId,
      attempt: envelope.attempt,
      ordinal: envelope.ordinal,
      payload: envelope.payload,
    };
    const canonicalEventId = computeLegacyLogicalEventId(dedupInput);
    const canonicalLogicalSlotId = computeLegacyLogicalSlotId(dedupInput);
    const decision = this.deduplication.accept(dedupInput);

    switch (decision.kind) {
      case 'transport_duplicate':
        return {
          accepted: false,
          renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
          channel: envelope.channel,
          reasonCode: 'TRANSPORT_DUPLICATE',
          canonicalEventId,
          canonicalLogicalSlotId,
          duplicateDecision: decision,
          envelope,
        };
      case 'semantic_duplicate':
        return {
          accepted: false,
          renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
          channel: envelope.channel,
          reasonCode: 'SEMANTIC_DUPLICATE',
          canonicalEventId: decision.eventId ?? canonicalEventId,
          canonicalLogicalSlotId,
          duplicateDecision: decision,
          envelope,
        };
      case 'ordinal_conflict':
        return {
          accepted: false,
          renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
          channel: envelope.channel,
          reasonCode: 'ORDINAL_PAYLOAD_CONFLICT',
          canonicalEventId: decision.eventId,
          canonicalLogicalSlotId,
          duplicateDecision: decision,
          envelope,
        };
      case 'accepted': {
        const lifecycle = normalizeInto(envelope, this.lifecycle);
        if (lifecycle.terminalConflict) {
          return {
            accepted: false,
            renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
            channel: envelope.channel,
            reasonCode: 'TERMINAL_CONFLICT',
            canonicalEventId: decision.eventId,
            canonicalLogicalSlotId,
            canonicalIdempotencyKey: `legacy-ingress:${decision.eventId}`,
            duplicateDecision: decision,
            lifecycle,
            envelope,
          };
        }
        return {
          accepted: true,
          renderVisibility: LEGACY_CANONICAL_RENDER_VISIBILITY,
          channel: envelope.channel,
          canonicalEventId: decision.eventId,
          // The idempotency key mirrors the canonical event id so SessionLog's
          // atomic-and-idempotent boundary uses the same deterministic key on
          // reruns; it is prefixed to keep it distinct from other Session Log
          // ingress paths.
          canonicalIdempotencyKey: `legacy-ingress:${decision.eventId}`,
          canonicalLogicalSlotId,
          payloadDigest: decision.payloadDigest,
          reconciled: decision.reconciled,
          duplicateDecision: decision,
          envelope,
          normalizedFacts: lifecycle.events,
          terminalConflict: false,
        };
      }
    }
  }

  /**
   * Bounded diagnostic snapshot for tests, health checks, and observability.
   * The snapshot is limited to dedup counters and ledger sizes; no legacy
   * payload content is exposed.
   */
  snapshot(): LegacyCanonicalIngestionSnapshotV1 {
    return { deduplication: this.deduplication.snapshot() };
  }
}
