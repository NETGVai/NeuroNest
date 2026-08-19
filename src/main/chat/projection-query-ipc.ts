import { z } from 'zod';
import {
  ResponseCompositionV1Schema,
  type ResponseCompositionV1,
} from '../../harness/contracts/response-composition.js';
import type {
  ProjectionDiagnosticSnapshotV1,
  StructuredChatProjectionService,
  StructuredCompositionQuery,
  StructuredProjectionQueryResult,
  StructuredProjectionUnavailableReason,
  StructuredTimelinePageQuery,
  TimelinePageV1,
} from '../../harness/projections/index.js';
import type {
  ProjectionQueryIPCUnavailableReasonV1,
  ProjectionQueryIPCUnavailableV1,
  RenderStatusResultV1,
} from '../../shared/chat-projection-ipc-contracts.js';

export type {
  ProjectionQueryIPCUnavailableV1,
  RenderStatusResultV1,
} from '../../shared/chat-projection-ipc-contracts.js';

export const PROJECTION_QUERY_CHANNELS = [
  'chat-projection:get-page-v1',
  'chat-projection:get-composition-v1',
  'chat-diagnostics:get-render-status-v1',
] as const;

export type ProjectionQueryChannel = typeof PROJECTION_QUERY_CHANNELS[number];

/** @deprecated Use {@link ProjectionQueryIPCUnavailableReasonV1} from `src/shared`. Kept for compatibility with existing consumers. */
export type ProjectionQueryIPCUnavailableReason = ProjectionQueryIPCUnavailableReasonV1;

export interface ProjectionQueryServicePort {
  getPage(query: StructuredTimelinePageQuery): StructuredProjectionQueryResult<TimelinePageV1>;
  getComposition(query: StructuredCompositionQuery): StructuredProjectionQueryResult<ResponseCompositionV1>;
  getProjectionRevision(): number;
  getSourceRevision(): number;
}

export interface ProjectionDiagnosticsPort {
  getSnapshot(): ProjectionDiagnosticSnapshotV1;
}

interface IpcSenderLike {
  isDestroyed?: () => boolean;
  once?: (event: 'destroyed', listener: () => void) => unknown;
  removeListener?: (event: 'destroyed', listener: () => void) => unknown;
}

export interface ProjectionQueryInvokeEvent {
  readonly sender?: IpcSenderLike;
}

export interface ProjectionQueryIPCMain {
  handle(
    channel: string,
    handler: (event: ProjectionQueryInvokeEvent, request: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ProjectionQueryIPCDependencies {
  readonly ipcMain: ProjectionQueryIPCMain;
  readonly resolveProjectionService: (
    sessionId: string,
    branchId: string,
    event: ProjectionQueryInvokeEvent,
  ) => ProjectionQueryServicePort | StructuredChatProjectionService | undefined;
  readonly resolveDiagnosticsService: (
    sessionId: string,
    branchId: string,
    event: ProjectionQueryInvokeEvent,
  ) => ProjectionDiagnosticsPort | undefined;
}

export interface ProjectionQueryIPCRegistration {
  readonly channels: readonly ProjectionQueryChannel[];
  dispose(): void;
}

const IdentifierSchema = z.string().trim().min(1).max(256);
const RevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SourceRevisionSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
const CommonRequestShape = {
  schemaVersion: z.literal(1),
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  expectedProjectionRevision: RevisionSchema.optional(),
  expectedSourceRevision: SourceRevisionSchema.optional(),
};

const PageRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...CommonRequestShape,
    kind: z.literal('initial'),
    position: z.enum(['oldest', 'latest']),
    pageSize: z.number().int().min(1).max(10_000).optional(),
  }),
  z.strictObject({
    ...CommonRequestShape,
    kind: z.literal('cursor'),
    cursor: z.string().min(1).max(16_384),
    pageSize: z.number().int().min(1).max(10_000).optional(),
  }),
]);

const CompositionRequestSchema = z.strictObject({
  ...CommonRequestShape,
  chatNodeStableKey: z.string().regex(/^[a-f0-9]{32}$/),
});

const RenderStatusRequestSchema = z.strictObject(CommonRequestShape);

const CanonicalUnavailableReasons = new Set<StructuredProjectionUnavailableReason>([
  'cross_session',
  'stale_revision',
  'stale_source_revision',
  'unsupported_schema_version',
  'bound_exceeded',
  'invalid_identity',
  'duplicate_event_id',
  'malformed_cursor',
  'stale_cursor',
  'cancelled',
  'invalid_checkpoint',
]);

const registrations = new WeakMap<object, ProjectionQueryIPCRegistration>();

function revisions(service?: ProjectionQueryServicePort): {
  projectionRevision: number;
  sourceRevision: number;
} {
  if (!service) return { projectionRevision: -1, sourceRevision: -1 };
  try {
    return {
      projectionRevision: service.getProjectionRevision(),
      sourceRevision: service.getSourceRevision(),
    };
  } catch {
    return { projectionRevision: -1, sourceRevision: -1 };
  }
}

function unavailable(
  reasonCode: ProjectionQueryIPCUnavailableReason,
  service?: ProjectionQueryServicePort,
): ProjectionQueryIPCUnavailableV1 {
  return {
    ok: false,
    unavailable: true,
    reasonCode,
    ...revisions(service),
    schemaVersion: 1,
  };
}

function requestFailure(raw: unknown): ProjectionQueryIPCUnavailableReason {
  if (
    raw !== null
    && typeof raw === 'object'
    && 'schemaVersion' in raw
    && (raw as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return 'unsupported_schema_version';
  }
  return 'malformed_request';
}

function isSafeRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum;
}

function validateUnavailableResponse(raw: unknown): raw is StructuredProjectionQueryResult<never> {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.ok === false
    && value.unavailable === true
    && value.schemaVersion === 1
    && typeof value.reasonCode === 'string'
    && CanonicalUnavailableReasons.has(value.reasonCode as StructuredProjectionUnavailableReason)
    && isSafeRevision(value.projectionRevision, 0)
    && isSafeRevision(value.sourceRevision, -1);
}

function validateSuccessEnvelope(
  raw: unknown,
  sessionId: string,
  branchId: string,
): raw is StructuredProjectionQueryResult<unknown> & { ok: true } {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.ok === true
    && value.schemaVersion === 1
    && value.sessionId === sessionId
    && value.branchId === branchId
    && isSafeRevision(value.projectionRevision, 0)
    && isSafeRevision(value.sourceRevision, -1)
    && value.envelope !== null
    && typeof value.envelope === 'object'
    && 'value' in value;
}

function validatePageResponse(raw: unknown, sessionId: string, branchId: string): boolean {
  if (validateUnavailableResponse(raw)) return true;
  if (!validateSuccessEnvelope(raw, sessionId, branchId)) return false;
  const page = raw.value;
  if (!page || typeof page !== 'object') return false;
  const value = page as Record<string, unknown>;
  return value.schemaVersion === 1
    && Array.isArray(value.nodes)
    && isSafeRevision(value.totalNodeCount, 0)
    && (value.beforeCursor === null || typeof value.beforeCursor === 'string')
    && (value.afterCursor === null || typeof value.afterCursor === 'string');
}

function validateCompositionResponse(raw: unknown, sessionId: string, branchId: string): boolean {
  if (validateUnavailableResponse(raw)) return true;
  if (!validateSuccessEnvelope(raw, sessionId, branchId)) return false;
  return ResponseCompositionV1Schema.safeParse(raw.value).success;
}

function validateDiagnosticSnapshot(raw: unknown): raw is ProjectionDiagnosticSnapshotV1 {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  const projection = value.projection;
  const counts = value.counts;
  const bounds = value.bounds;
  return value.schemaVersion === 1
    && ['ready', 'degraded', 'blocked', 'cancelled', 'unavailable'].includes(String(value.status))
    && isSafeRevision(value.observationCount, 0)
    && !!projection && typeof projection === 'object'
    && isSafeRevision((projection as Record<string, unknown>).projectionRevision, 0)
    && isSafeRevision((projection as Record<string, unknown>).sourceRevision, -1)
    && !!counts && typeof counts === 'object'
    && !!bounds && typeof bounds === 'object'
    && Array.isArray(value.failures);
}

async function withCancellation<T>(
  event: ProjectionQueryInvokeEvent,
  activeControllers: Set<AbortController>,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T | { cancelled: true }> {
  const controller = new AbortController();
  const onDestroyed = (): void => controller.abort();
  activeControllers.add(controller);
  if (event.sender?.isDestroyed?.()) controller.abort();
  else event.sender?.once?.('destroyed', onDestroyed);
  try {
    if (controller.signal.aborted) return { cancelled: true };
    const result = await operation(controller.signal);
    if (controller.signal.aborted) return { cancelled: true };
    return result;
  } finally {
    activeControllers.delete(controller);
    event.sender?.removeListener?.('destroyed', onDestroyed);
  }
}

/**
 * Register the read-only V1 projection query boundary. Re-registering replaces
 * the previous registration atomically, and disposal aborts all in-flight reads.
 */
export function registerProjectionQueryIPC(
  dependencies: ProjectionQueryIPCDependencies,
): ProjectionQueryIPCRegistration {
  registrations.get(dependencies.ipcMain as object)?.dispose();

  const activeControllers = new Set<AbortController>();
  let disposed = false;
  let registration: ProjectionQueryIPCRegistration;

  const install = (
    channel: ProjectionQueryChannel,
    handler: (event: ProjectionQueryInvokeEvent, request: unknown) => Promise<unknown>,
  ): void => {
    try { dependencies.ipcMain.removeHandler(channel); } catch {}
    dependencies.ipcMain.handle(channel, handler);
  };

  install('chat-projection:get-page-v1', async (event, raw) => {
    const parsed = PageRequestSchema.safeParse(raw);
    if (!parsed.success) return unavailable(requestFailure(raw));
    const request = parsed.data;
    const service = dependencies.resolveProjectionService(request.sessionId, request.branchId, event);
    if (!service) return unavailable('no_projection');
    if (disposed) return unavailable('cancelled', service);

    try {
      const result = await withCancellation(event, activeControllers, (signal) => service.getPage({
        ...request,
        signal,
      } as StructuredTimelinePageQuery));
      if ('cancelled' in result) return unavailable('cancelled', service);
      if (!validatePageResponse(result, request.sessionId, request.branchId)) {
        return unavailable('invalid_response', service);
      }
      return result;
    } catch {
      return unavailable('query_failed', service);
    }
  });

  install('chat-projection:get-composition-v1', async (event, raw) => {
    const parsed = CompositionRequestSchema.safeParse(raw);
    if (!parsed.success) return unavailable(requestFailure(raw));
    const request = parsed.data;
    const service = dependencies.resolveProjectionService(request.sessionId, request.branchId, event);
    if (!service) return unavailable('no_projection');
    if (disposed) return unavailable('cancelled', service);

    try {
      const result = await withCancellation(event, activeControllers, (signal) => service.getComposition({
        ...request,
        signal,
      }));
      if ('cancelled' in result) return unavailable('cancelled', service);
      if (!validateCompositionResponse(result, request.sessionId, request.branchId)) {
        return unavailable('invalid_response', service);
      }
      return result;
    } catch {
      return unavailable('query_failed', service);
    }
  });

  install('chat-diagnostics:get-render-status-v1', async (event, raw) => {
    const parsed = RenderStatusRequestSchema.safeParse(raw);
    if (!parsed.success) return unavailable(requestFailure(raw));
    const request = parsed.data;
    const service = dependencies.resolveProjectionService(request.sessionId, request.branchId, event);
    if (!service) return unavailable('no_projection');
    const diagnosticService = dependencies.resolveDiagnosticsService(
      request.sessionId,
      request.branchId,
      event,
    );
    if (!diagnosticService) return unavailable('no_projection', service);
    if (disposed) return unavailable('cancelled', service);

    try {
      const result = await withCancellation(event, activeControllers, () => diagnosticService.getSnapshot());
      if ('cancelled' in result) return unavailable('cancelled', service);
      if (!validateDiagnosticSnapshot(result)) return unavailable('invalid_response', service);
      if (
        request.expectedProjectionRevision !== undefined
        && result.projection.projectionRevision !== request.expectedProjectionRevision
      ) {
        return unavailable('stale_revision', service);
      }
      if (
        request.expectedSourceRevision !== undefined
        && result.projection.sourceRevision !== request.expectedSourceRevision
      ) {
        return unavailable('stale_source_revision', service);
      }
      return {
        ok: true,
        schemaVersion: 1,
        sessionId: request.sessionId,
        branchId: request.branchId,
        projectionRevision: result.projection.projectionRevision,
        sourceRevision: result.projection.sourceRevision,
        value: result,
      } satisfies RenderStatusResultV1;
    } catch {
      return unavailable('query_failed', service);
    }
  });

  registration = {
    channels: PROJECTION_QUERY_CHANNELS,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      if (registrations.get(dependencies.ipcMain as object) !== registration) return;
      for (const channel of PROJECTION_QUERY_CHANNELS) {
        try { dependencies.ipcMain.removeHandler(channel); } catch {}
      }
      registrations.delete(dependencies.ipcMain as object);
    },
  };
  registrations.set(dependencies.ipcMain as object, registration);
  return registration;
}
