import { z } from 'zod';
import { IdentifierSchema } from '../contracts/primitives';
import {
  AuthorizedPresentationTextSchema,
  DetailKindV1Schema,
  OpaqueDetailLocatorV1Schema,
  OpaqueResponseIdSchema,
  ResponseDigestSchema,
  SourceStateV1Schema,
  type DetailKindV1,
  type OpaqueDetailLocatorV1,
} from '../contracts/response-support';
import { PresentationScalarV1Schema } from '../contracts/response-composition';

const RevisionSchema = z.number().int().nonnegative().finite();
const RetainedOutputStateSchema = z.enum([
  'inline',
  'spilled',
  'truncated',
  'redacted',
  'unavailable',
]);
const DetailAvailabilitySchema = z.enum([
  'available',
  'stale',
  'unavailable',
  'redacted',
  'no_longer_authorized',
]);
const BoundedTextSchema = AuthorizedPresentationTextSchema;
const OptionalTextSchema = BoundedTextSchema.optional();

const ProvenanceItemSchema = z.object({
  identity: OpaqueResponseIdSchema,
  sourceType: z.enum(['web', 'file', 'attachment', 'session', 'artifact', 'tool', 'provider']),
  state: SourceStateV1Schema,
  title: OptionalTextSchema,
  excerpt: OptionalTextSchema,
  retrievedAt: z.string().datetime().optional(),
  digest: ResponseDigestSchema.optional(),
}).strict();

const ToolDetailSchema = z.object({
  kind: z.literal('tool'),
  callIdentity: OpaqueResponseIdSchema,
  attempt: z.number().int().positive().finite(),
  state: z.enum(['planned', 'executing', 'completed', 'failed', 'cancelled', 'awaiting_approval']),
  ownerLabel: BoundedTextSchema,
  riskClass: BoundedTextSchema,
  normalizedArguments: OptionalTextSchema,
  output: OptionalTextSchema,
  durationMs: z.number().nonnegative().finite().optional(),
  provenance: z.array(ProvenanceItemSchema).max(1_000).optional(),
}).strict();

const SourceDetailSchema = z.object({
  kind: z.literal('source'),
  citationIdentity: OpaqueResponseIdSchema,
  sourceType: z.enum(['web', 'file', 'attachment', 'session', 'artifact', 'tool', 'provider']),
  state: SourceStateV1Schema,
  title: OptionalTextSchema,
  relevantExcerpt: OptionalTextSchema,
  retrievedAt: z.string().datetime().optional(),
  digest: ResponseDigestSchema.optional(),
  authorizedReference: z.object({
    kind: z.enum(['web', 'file', 'attachment', 'session']),
    displayLabel: BoundedTextSchema,
    openIdentity: OpaqueResponseIdSchema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.state !== 'available' && (
    value.title !== undefined ||
    value.relevantExcerpt !== undefined ||
    value.authorizedReference !== undefined
  )) {
    context.addIssue({
      code: 'custom',
      message: 'protected source fields require an available source',
    });
  }
});

const DiffChangeSchema = z.object({
  changeIdentity: OpaqueResponseIdSchema,
  label: BoundedTextSchema,
  previousValue: OptionalTextSchema,
  proposedValue: OptionalTextSchema,
}).strict();

const DiffDetailSchema = z.object({
  kind: z.literal('diff'),
  diffIdentity: OpaqueResponseIdSchema,
  diffType: z.enum(['file', 'structured_record']),
  state: z.enum(['proposed', 'staged', 'applied', 'rejected', 'stale', 'conflicted', 'unavailable']),
  summary: BoundedTextSchema,
  additions: z.number().int().nonnegative().finite(),
  deletions: z.number().int().nonnegative().finite(),
  changes: z.array(DiffChangeSchema).max(1_000),
  provenance: z.array(ProvenanceItemSchema).max(1_000).optional(),
}).strict();

const DataDetailSchema = z.object({
  kind: z.literal('data'),
  dataIdentity: OpaqueResponseIdSchema,
  caption: OptionalTextSchema,
  columns: z.array(z.object({
    columnIdentity: OpaqueResponseIdSchema,
    label: BoundedTextSchema,
  }).strict()).min(1).max(100),
  rows: z.array(z.object({
    rowIdentity: OpaqueResponseIdSchema,
    label: BoundedTextSchema,
    values: z.array(PresentationScalarV1Schema).max(100),
  }).strict()).max(1_000),
  provenance: z.array(ProvenanceItemSchema).max(1_000).optional(),
}).strict();

const TrajectoryDetailSchema = z.object({
  kind: z.literal('trajectory'),
  entityIdentity: OpaqueResponseIdSchema,
  entityKind: z.enum(['plan', 'task', 'workflow', 'subagent', 'job', 'check', 'result_injection']),
  state: z.enum(['queued', 'running', 'blocked', 'waiting', 'failed', 'cancelled', 'completed', 'cancelling']),
  ownerLabel: BoundedTextSchema,
  attempt: z.number().int().positive().finite(),
  dependencies: z.array(z.object({
    identity: OpaqueResponseIdSchema,
    state: BoundedTextSchema,
    label: OptionalTextSchema,
  }).strict()).max(1_000),
  logs: z.array(BoundedTextSchema).max(1_000).optional(),
  cancellation: z.object({
    available: z.boolean(),
    unavailableReason: OptionalTextSchema,
  }).strict(),
  provenance: z.array(ProvenanceItemSchema).max(1_000).optional(),
}).strict();

const InsightDetailSchema = z.object({
  kind: z.literal('insight'),
  insightIdentity: OpaqueResponseIdSchema,
  title: BoundedTextSchema,
  metrics: z.array(z.object({
    metricIdentity: OpaqueResponseIdSchema,
    label: BoundedTextSchema,
    value: z.number().finite(),
    unit: BoundedTextSchema,
  }).strict()).max(1_000),
  timeRange: OptionalTextSchema,
  accessibleSummary: BoundedTextSchema,
  provenance: z.array(ProvenanceItemSchema).max(1_000),
}).strict();

const AttachmentDetailSchema = z.object({
  kind: z.literal('attachment'),
  attachmentIdentity: OpaqueResponseIdSchema,
  displayName: BoundedTextSchema,
  mediaType: BoundedTextSchema,
  state: z.enum(['processing', 'ready', 'unavailable', 'failed', 'redacted']),
  alternativeText: OptionalTextSchema,
  artifactIdentity: OpaqueResponseIdSchema.optional(),
  provenance: z.array(ProvenanceItemSchema).max(1_000).optional(),
}).strict();

const ProvenanceDetailSchema = z.object({
  kind: z.literal('provenance'),
  subjectIdentity: OpaqueResponseIdSchema,
  summary: OptionalTextSchema,
  sources: z.array(ProvenanceItemSchema).max(1_000),
  generatedAt: z.string().datetime().optional(),
  digest: ResponseDigestSchema.optional(),
}).strict();

export const AuthorizedDetailPayloadV1Schema = z.discriminatedUnion('kind', [
  ToolDetailSchema,
  SourceDetailSchema,
  DiffDetailSchema,
  DataDetailSchema,
  TrajectoryDetailSchema,
  InsightDetailSchema,
  AttachmentDetailSchema,
  ProvenanceDetailSchema,
]);
export type AuthorizedDetailPayloadV1 = z.infer<typeof AuthorizedDetailPayloadV1Schema>;

export const AuthorizedDetailRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  locatorId: OpaqueResponseIdSchema,
  kind: DetailKindV1Schema,
  sourceRevision: RevisionSchema,
  availability: DetailAvailabilitySchema,
  retainedOutput: RetainedOutputStateSchema,
  detail: AuthorizedDetailPayloadV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.availability === 'available' && value.detail === undefined) {
    context.addIssue({ code: 'custom', path: ['detail'], message: 'available detail requires content' });
  }
  if (value.availability !== 'available' && value.detail !== undefined) {
    context.addIssue({ code: 'custom', path: ['detail'], message: 'unavailable detail cannot expose content' });
  }
  if (value.detail !== undefined && value.detail.kind !== value.kind) {
    context.addIssue({ code: 'custom', path: ['detail', 'kind'], message: 'detail kind must match record kind' });
  }
});
export type AuthorizedDetailRecordV1 = z.infer<typeof AuthorizedDetailRecordV1Schema>;
export type RetainedOutputState = z.infer<typeof RetainedOutputStateSchema>;

const DetailQueryRangeV1Schema = z.object({
  offset: z.number().int().nonnegative().finite(),
  limit: z.number().int().positive().finite(),
}).strict();

export const DetailProjectionQueryV1Schema = z.object({
  schemaVersion: z.literal(1),
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  locator: OpaqueDetailLocatorV1Schema,
  range: DetailQueryRangeV1Schema.optional(),
}).strict();
export type DetailProjectionQueryV1 = z.infer<typeof DetailProjectionQueryV1Schema>;

export interface DetailProjectionSource {
  resolve(
    locator: Pick<OpaqueDetailLocatorV1, 'locatorId' | 'kind' | 'sourceRevision'>,
    signal?: AbortSignal,
  ): Promise<unknown | null> | unknown | null;
}

export interface DetailProjectionBounds {
  maxRangeItems: number;
  maxTextChars: number;
}

export interface DetailProjectionRangeV1 {
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export type DetailProjectionUnavailableReason =
  | 'invalid_query'
  | 'not_found'
  | 'stale'
  | 'unavailable'
  | 'redacted'
  | 'no_longer_authorized'
  | 'kind_mismatch'
  | 'cross_session_denied'
  | 'range_out_of_bounds';

export type DetailProjectionResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly status: 'available';
      readonly identity: string;
      readonly kind: DetailKindV1;
      readonly sourceRevision: number;
      readonly retainedOutput: RetainedOutputState;
      readonly detail: AuthorizedDetailPayloadV1;
      readonly range: DetailProjectionRangeV1;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: 'unavailable';
      readonly identity: string;
      readonly kind: DetailKindV1;
      readonly sourceRevision: number;
      readonly retainedOutput: RetainedOutputState;
      readonly reason: DetailProjectionUnavailableReason;
    };

const PRIMARY_COLLECTION: Partial<Record<DetailKindV1, string>> = {
  tool: 'provenance',
  diff: 'changes',
  data: 'rows',
  trajectory: 'logs',
  insight: 'metrics',
  provenance: 'sources',
};

function unavailable(
  locator: OpaqueDetailLocatorV1,
  reason: DetailProjectionUnavailableReason,
  sourceRevision = locator.sourceRevision,
  retainedOutput: RetainedOutputState = 'unavailable',
): DetailProjectionResultV1 {
  return Object.freeze({
    schemaVersion: 1,
    status: 'unavailable',
    identity: locator.locatorId,
    kind: locator.kind,
    sourceRevision,
    retainedOutput,
    reason,
  });
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DetailProjectionCancelledError();
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

/**
 * Read-only, scope-checked projection for one opaque inspector identity.
 * The injected source resolves authority-issued identities; this service strips
 * all undeclared fields before returning renderer-facing detail.
 */
export class DetailProjectionService {
  private readonly source: DetailProjectionSource;
  private readonly bounds: DetailProjectionBounds;

  constructor(source: DetailProjectionSource, bounds: DetailProjectionBounds) {
    if (!positiveInteger(bounds.maxRangeItems) || bounds.maxRangeItems > 1_000) {
      throw new RangeError('maxRangeItems must be between 1 and 1000');
    }
    if (!positiveInteger(bounds.maxTextChars) || bounds.maxTextChars < 128 || bounds.maxTextChars > 2_048) {
      throw new RangeError('maxTextChars must be between 128 and 2048');
    }
    this.source = source;
    this.bounds = Object.freeze({ ...bounds });
  }

  async query(rawQuery: unknown, signal?: AbortSignal): Promise<DetailProjectionResultV1> {
    checkCancelled(signal);
    const parsedQuery = DetailProjectionQueryV1Schema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      const locator = this.safeLocator(rawQuery);
      return unavailable(locator, 'invalid_query');
    }

    const query = parsedQuery.data;
    if (query.range && query.range.limit > this.bounds.maxRangeItems) {
      return unavailable(query.locator, 'range_out_of_bounds');
    }

    const rawRecord = await this.resolveSource(query.locator, signal);
    checkCancelled(signal);

    if (rawRecord === null || rawRecord === undefined) {
      return unavailable(query.locator, 'not_found');
    }

    const parsedRecord = AuthorizedDetailRecordV1Schema.safeParse(rawRecord);
    if (!parsedRecord.success) {
      return unavailable(query.locator, 'redacted', query.locator.sourceRevision, 'redacted');
    }
    const record = parsedRecord.data;

    if (record.sessionId !== query.sessionId || record.branchId !== query.branchId) {
      return unavailable(query.locator, 'cross_session_denied');
    }
    if (record.locatorId !== query.locator.locatorId) {
      return unavailable(query.locator, 'not_found');
    }
    if (record.kind !== query.locator.kind) {
      return unavailable(query.locator, 'kind_mismatch', record.sourceRevision, record.retainedOutput);
    }
    if (record.sourceRevision !== query.locator.sourceRevision) {
      return unavailable(query.locator, 'stale', record.sourceRevision, record.retainedOutput);
    }
    if (record.availability !== 'available' || record.detail === undefined) {
      const reason = record.availability === 'available'
        ? 'unavailable'
        : record.availability;
      return unavailable(query.locator, reason, record.sourceRevision, record.retainedOutput);
    }

    const ranged = this.applyBounds(record.detail, query.range);
    if (ranged === null) {
      return unavailable(query.locator, 'range_out_of_bounds', record.sourceRevision, record.retainedOutput);
    }

    return Object.freeze({
      schemaVersion: 1,
      status: 'available',
      identity: query.locator.locatorId,
      kind: query.locator.kind,
      sourceRevision: record.sourceRevision,
      retainedOutput: ranged.truncated && record.retainedOutput === 'inline'
        ? 'truncated'
        : record.retainedOutput,
      detail: ranged.detail,
      range: Object.freeze(ranged.range),
    });
  }

  private async resolveSource(
    locator: OpaqueDetailLocatorV1,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    checkCancelled(signal);
    if (signal === undefined) {
      return await this.source.resolve({
        locatorId: locator.locatorId,
        kind: locator.kind,
        sourceRevision: locator.sourceRevision,
      });
    }

    return await new Promise<unknown | null>((resolve, reject) => {
      const onAbort = (): void => reject(new DetailProjectionCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => this.source.resolve({
        locatorId: locator.locatorId,
        kind: locator.kind,
        sourceRevision: locator.sourceRevision,
      }, signal)).then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private safeLocator(rawQuery: unknown): OpaqueDetailLocatorV1 {
    const candidate = typeof rawQuery === 'object' && rawQuery !== null && 'locator' in rawQuery
      ? (rawQuery as { locator?: unknown }).locator
      : undefined;
    const parsed = OpaqueDetailLocatorV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : {
      schemaVersion: 1,
      locatorId: 'invalid-detail-query',
      kind: 'provenance',
      authority: {
        schemaVersion: 1,
        authorityKind: 'projection_service',
        authorityId: 'detail-query-boundary',
      },
      sourceRevision: 0,
    };
  }

  private applyBounds(
    detail: AuthorizedDetailPayloadV1,
    requested?: { offset: number; limit: number },
  ): { detail: AuthorizedDetailPayloadV1; range: DetailProjectionRangeV1; truncated: boolean } | null {
    const collectionKey = PRIMARY_COLLECTION[detail.kind];
    const record = structuredClone(detail) as unknown as Record<string, unknown>;
    const collection = collectionKey === undefined ? undefined : record[collectionKey as string];
    const total = Array.isArray(collection) ? collection.length : 1;
    const offset = requested?.offset ?? 0;
    const limit = requested?.limit ?? this.bounds.maxRangeItems;

    if (offset > total || (collectionKey === undefined && offset !== 0)) return null;

    let truncated = false;
    let returned = 1;
    if (Array.isArray(collection)) {
      const selected = collection.slice(offset, offset + limit);
      record[collectionKey as string] = selected;
      returned = selected.length;
      truncated = offset > 0 || offset + returned < total;
    }

    const boundNested = (value: unknown): unknown => {
      if (typeof value === 'string') {
        if (value.length <= this.bounds.maxTextChars) return value;
        truncated = true;
        return value.slice(0, this.bounds.maxTextChars);
      }
      if (Array.isArray(value)) {
        if (value.length > this.bounds.maxRangeItems) truncated = true;
        return value.slice(0, this.bounds.maxRangeItems).map(boundNested);
      }
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, boundNested(nested)]));
      }
      return value;
    };

    const bounded = AuthorizedDetailPayloadV1Schema.parse(boundNested(record));
    return {
      detail: bounded,
      range: {
        offset,
        limit,
        returned,
        total,
        hasMore: offset + returned < total,
      },
      truncated,
    };
  }
}

export class DetailProjectionCancelledError extends Error {
  constructor() {
    super('Detail projection query cancelled');
    this.name = 'DetailProjectionCancelledError';
  }
}
