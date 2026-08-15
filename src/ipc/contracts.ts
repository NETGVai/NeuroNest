/**
 * Typed IPC Contract System
 *
 * Provides narrow, schema-validated request/response/cancellation/snapshot/event
 * contracts through dedicated registrars. Replaces the untyped channel-based
 * IPC surface with a fully typed contract layer that maintains backward
 * compatibility with existing preload.ts channels.
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

// ─── Core Types ─────────────────────────────────────────────────────────────

/**
 * IPC contract version for compatibility detection.
 * Bumped on breaking schema changes.
 */
export const IPC_CONTRACT_VERSION = 1;

/**
 * Privilege tiers matching existing preload.ts categorization.
 */
export type IPCPrivilegeTier = 'public' | 'authenticated' | 'admin';

/**
 * Categories of IPC contracts for dedicated registrars.
 */
export type IPCCategory =
  | 'request-response'
  | 'cancellation'
  | 'snapshot'
  | 'ordered-event';

/**
 * Base envelope for all IPC messages with schema identity.
 */
export interface IPCEnvelope<T = unknown> {
  /** Unique message ID for deduplication */
  readonly messageId: string;
  /** IPC contract version for compatibility */
  readonly contractVersion: number;
  /** Timestamp of message creation */
  readonly timestamp: number;
  /** Correlation ID for request-response pairing */
  readonly correlationId?: string;
  /** The typed payload */
  readonly payload: T;
}

// ─── Request/Response Contracts ─────────────────────────────────────────────

/**
 * Schema-validated request envelope.
 */
export interface IPCRequest<TPayload = unknown> extends IPCEnvelope<TPayload> {
  readonly kind: 'request';
  /** Channel name this request is targeting */
  readonly channel: string;
  /** Privilege tier required */
  readonly tier: IPCPrivilegeTier;
  /** Optional cancellation token ID */
  readonly cancellationToken?: string;
  /** Workspace ID scope */
  readonly workspaceId?: string;
}

/**
 * Schema-validated response envelope.
 */
export interface IPCResponse<TPayload = unknown> extends IPCEnvelope<TPayload> {
  readonly kind: 'response';
  /** The request message ID this responds to */
  readonly requestId: string;
  /** Whether this is a success or error response */
  readonly status: 'success' | 'error' | 'cancelled';
  /** Error details when status is 'error' */
  readonly error?: IPCError;
}

/**
 * Structured IPC error.
 */
export interface IPCError {
  readonly code: string;
  readonly message: string;
  readonly category: 'validation' | 'authorization' | 'timeout' | 'cancelled' | 'internal' | 'unavailable';
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

// ─── Cancellation Contracts ─────────────────────────────────────────────────

/**
 * Cancellation token for in-flight requests.
 */
export interface CancellationToken {
  readonly tokenId: string;
  readonly createdAt: number;
  readonly reason?: string;
  cancelled: boolean;
}

/**
 * Cancellation request sent from renderer to main.
 */
export interface IPCCancellationRequest extends IPCEnvelope<{ tokenId: string; reason?: string }> {
  readonly kind: 'cancellation';
}

// ─── Snapshot Contracts ─────────────────────────────────────────────────────

/**
 * State snapshot pushed from main process to renderer.
 * Used for authoritative state synchronization.
 */
export interface IPCSnapshot<TState = unknown> extends IPCEnvelope<TState> {
  readonly kind: 'snapshot';
  /** Domain this snapshot belongs to */
  readonly domain: string;
  /** Monotonically increasing version for ordering */
  readonly version: number;
  /** Hash of the snapshot content for change detection */
  readonly fingerprint: string;
  /** Whether this is a full snapshot or incremental delta */
  readonly mode: 'full' | 'delta';
  /** Previous version when mode is 'delta' */
  readonly baseVersion?: number;
}

// ─── Ordered Event Contracts ────────────────────────────────────────────────

/**
 * Domain events pushed from main to renderer in guaranteed order.
 * Renderer reducers deduplicate by eventId and sequence.
 */
export interface IPCOrderedEvent<TPayload = unknown> extends IPCEnvelope<TPayload> {
  readonly kind: 'ordered-event';
  /** Domain event type */
  readonly eventType: string;
  /** Session-scoped monotonically increasing sequence number */
  readonly sequence: number;
  /** Session ID for event ordering scope */
  readonly sessionId: string;
  /** Source domain that produced this event */
  readonly sourceDomain: string;
}

// ─── Contract Definitions ───────────────────────────────────────────────────

/**
 * Defines the schema for a single IPC contract channel.
 */
export interface IPCContractDefinition<
  TRequest = unknown,
  TResponse = unknown,
> {
  /** Channel name */
  readonly channel: string;
  /** Human-readable description */
  readonly description: string;
  /** Contract category */
  readonly category: IPCCategory;
  /** Required privilege tier */
  readonly tier: IPCPrivilegeTier;
  /** Request payload validator */
  readonly validateRequest: (payload: unknown) => payload is TRequest;
  /** Response payload validator */
  readonly validateResponse: (payload: unknown) => payload is TResponse;
  /** Whether cancellation is supported */
  readonly cancellable: boolean;
  /** Timeout in milliseconds (0 = no timeout) */
  readonly timeoutMs: number;
  /** Contract version for this specific channel */
  readonly version: number;
}

/**
 * Registry of all typed IPC contracts.
 */
export interface IPCContractRegistry {
  readonly version: number;
  readonly contracts: ReadonlyMap<string, IPCContractDefinition>;
}

// ─── Validator Utilities ────────────────────────────────────────────────────

/**
 * Validates that a value matches the IPCEnvelope shape.
 */
export function isValidEnvelope(value: unknown): value is IPCEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.messageId === 'string' &&
    obj.messageId.length > 0 &&
    typeof obj.contractVersion === 'number' &&
    obj.contractVersion >= 1 &&
    typeof obj.timestamp === 'number' &&
    obj.timestamp > 0 &&
    'payload' in obj
  );
}

/**
 * Validates that a value matches the IPCRequest shape.
 */
export function isValidRequest(value: unknown): value is IPCRequest {
  if (!isValidEnvelope(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  return (
    obj.kind === 'request' &&
    typeof obj.channel === 'string' &&
    obj.channel.length > 0 &&
    typeof obj.tier === 'string' &&
    ['public', 'authenticated', 'admin'].includes(obj.tier as string)
  );
}

/**
 * Validates that a value matches the IPCResponse shape.
 */
export function isValidResponse(value: unknown): value is IPCResponse {
  if (!isValidEnvelope(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  return (
    obj.kind === 'response' &&
    typeof obj.requestId === 'string' &&
    typeof obj.status === 'string' &&
    ['success', 'error', 'cancelled'].includes(obj.status as string)
  );
}

/**
 * Validates that a value matches the IPCSnapshot shape.
 */
export function isValidSnapshot(value: unknown): value is IPCSnapshot {
  if (!isValidEnvelope(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  return (
    obj.kind === 'snapshot' &&
    typeof obj.domain === 'string' &&
    obj.domain.length > 0 &&
    typeof obj.version === 'number' &&
    obj.version >= 0 &&
    typeof obj.fingerprint === 'string' &&
    typeof obj.mode === 'string' &&
    ['full', 'delta'].includes(obj.mode as string)
  );
}

/**
 * Validates that a value matches the IPCOrderedEvent shape.
 */
export function isValidOrderedEvent(value: unknown): value is IPCOrderedEvent {
  if (!isValidEnvelope(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  return (
    obj.kind === 'ordered-event' &&
    typeof obj.eventType === 'string' &&
    obj.eventType.length > 0 &&
    typeof obj.sequence === 'number' &&
    obj.sequence >= 0 &&
    typeof obj.sessionId === 'string' &&
    obj.sessionId.length > 0 &&
    typeof obj.sourceDomain === 'string' &&
    obj.sourceDomain.length > 0
  );
}

/**
 * Validates that a value matches the IPCCancellationRequest shape.
 */
export function isValidCancellation(value: unknown): value is IPCCancellationRequest {
  if (!isValidEnvelope(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  if (obj.kind !== 'cancellation') return false;
  const payload = obj.payload as Record<string, unknown> | null;
  return (
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.tokenId === 'string' &&
    payload.tokenId.length > 0
  );
}
