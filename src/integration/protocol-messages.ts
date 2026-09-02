/**
 * Versioned IDE / CLI / external-agent bridge messages
 * (FUT-PKG-08-OPTIONAL/T-002).
 *
 * NN-INTEGRATION-005 requires the VS Code, JetBrains, Xcode, Monaco, CLI, and
 * external-agent bridges to use VERSIONED, ROUND-TRIPPABLE messages with
 * EXPLICIT WORKSPACE IDENTITY and AUTHORITY-ROUTED actions, and requires a
 * disconnect to NOT corrupt session state. NN-EXEC-011 requires headless (CLI/
 * external-agent) requests to carry a request id, cancellation, and typed
 * exit/error states.
 *
 * This module owns the versioned bridge WIRE CONTRACT — the envelope every
 * bridge message is carried in — plus the deterministic canonical
 * serialize/parse that makes a message round-trip LOSSLESSLY:
 *
 *   serialize(msg)  →  bytes  →  parse(bytes)  →  msg' , with msg' ≡ msg.
 *
 * The load-bearing guarantee (V-INTEGRATION-001/ide-cli-round-trip): a message
 * authored at a readable version round-trips through the versioned protocol
 * with NO field loss and NO PROTOCOL TYPE LEAKAGE across versions — a message
 * of one bridge/version never parses as a different bridge/version, and an
 * unknown/newer major is rejected with a typed `INCOMPATIBLE` WITHOUT mutation
 * (D-06.1 read/write matrix), never silently coerced.
 *
 * Workspace identity is EXPLICIT and REQUIRED on every message: a message with
 * no workspace identity is a typed `VALIDATION` (missing identity blocks the
 * action, NN-IDENT-001). Actions are described only — the ACTUAL action routes
 * through the real authorities in `integration-adapters.ts`; nothing here
 * executes an action or grants a permission.
 *
 * This module is pure and side-effect free. It uses the shared canonical
 * serializer from `contract-primitives` so two structurally equal messages
 * serialize identically (digest-stable, NN-DATA-010).
 *
 * Design anchors: D-02, D-03, D-06, D-07, D-16, D-18. Requirements:
 * NN-INTEGRATION-005, NN-EXEC-011, NN-IDENT-001, NN-INV-011, NN-DATA-010.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  canonicalSerialize,
  isOpaqueId,
  OpaqueIdSchema,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';

const PROTOCOL_OWNER = 'authority-integration-protocol';

// ════════════════════════════════════════════════════════════════════════════
// 1. Bridges and protocol version matrix (NN-INTEGRATION-005)
// ════════════════════════════════════════════════════════════════════════════

/** The bridge surfaces that share the versioned message contract. */
export const BRIDGES = Object.freeze([
  'vscode',
  'jetbrains',
  'xcode',
  'monaco',
  'cli',
  'external-agent',
] as const);
export type Bridge = (typeof BRIDGES)[number];

/** Whether a value names a known bridge. */
export function isBridge(value: unknown): value is Bridge {
  return typeof value === 'string' && (BRIDGES as readonly string[]).includes(value);
}

/**
 * The bridge protocol version this module writes, and the readable window. Like
 * the D-07.2 contract matrix this is `[1,1]` write `1`: a message at a different
 * major is INCOMPATIBLE and is preserved unmodified (no coercion, no leakage).
 */
export const PROTOCOL_WRITE_VERSION = 1 as const;
export const PROTOCOL_MIN_READABLE_VERSION = 1 as const;
export const PROTOCOL_MAX_READABLE_VERSION = 1 as const;

/** Classify a protocol version against the readable window (no side effect). */
export function classifyProtocolVersion(
  version: number,
): 'readable' | 'incompatible' {
  if (
    Number.isInteger(version) &&
    version >= PROTOCOL_MIN_READABLE_VERSION &&
    version <= PROTOCOL_MAX_READABLE_VERSION
  ) {
    return 'readable';
  }
  return 'incompatible';
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Explicit workspace identity (NN-IDENT-001, NN-INTEGRATION-005)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The explicit workspace identity every bridge message MUST carry. Identity is
 * a typed reference, not a trusted string: a missing/blank workspace id blocks
 * the action. `repositoryId`/`sessionId` are optional identity anchors.
 */
export const WorkspaceIdentitySchema = z.strictObject({
  workspaceId: OpaqueIdSchema,
  repositoryId: OpaqueIdSchema.optional(),
  sessionId: OpaqueIdSchema.optional(),
});
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

// ════════════════════════════════════════════════════════════════════════════
// 3. The versioned message envelope
// ════════════════════════════════════════════════════════════════════════════

/** The message directions on the bridge wire. */
export const MESSAGE_DIRECTIONS = Object.freeze([
  'request',
  'response',
  'event',
] as const);
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * The versioned bridge message envelope (NN-INTEGRATION-005). Every bridge
 * request/response/event is carried in this shape. `bridge` and
 * `protocolVersion` are IMMUTABLE identity: they are validated on parse so a
 * message never leaks as a different bridge/version. `requestId` and
 * `cancellationTokenId` satisfy the headless request contract (NN-EXEC-011).
 * `action` names the authority-routed action; `payload` is opaque structured
 * data. Nothing here executes the action.
 */
export const BridgeMessageSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  /** The bridge protocol version this message is written at. */
  protocolVersion: z.number().int().positive().finite(),
  /** The bridge surface that authored the message (immutable identity). */
  bridge: z.enum(BRIDGES),
  direction: z.enum(MESSAGE_DIRECTIONS),
  /** Stable message id (present on every direction). */
  messageId: OpaqueIdSchema,
  /** Correlation id threading a request→response→event chain. */
  correlationId: OpaqueIdSchema,
  /** Stable request id for the headless request contract (NN-EXEC-011). */
  requestId: OpaqueIdSchema,
  /** The cancellation token the action runs under (NN-EXEC-011). */
  cancellationTokenId: OpaqueIdSchema,
  /** EXPLICIT workspace identity (NN-IDENT-001); required. */
  workspace: WorkspaceIdentitySchema,
  /** The authority-routed action name (routed elsewhere; not executed here). */
  action: z.string().min(1).max(256),
  /** Opaque structured payload; round-trips losslessly. */
  payload: z.unknown(),
});
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

// ════════════════════════════════════════════════════════════════════════════
// 4. Typed validation / parse (no leakage, no coercion)
// ════════════════════════════════════════════════════════════════════════════

/** A typed protocol result: a value or a typed error. */
export type ProtocolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function protocolError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: PROTOCOL_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'VALIDATION',
    remediation:
      'Bridge messages are versioned and round-trippable with explicit ' +
      'workspace identity; an unknown/newer protocol major is rejected without ' +
      'mutation and never coerced to another bridge/version.',
    redaction: 'internal',
  };
}

/** Summarize zod issues into one safe, secret-free message. */
function summarize(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
    .join('; ');
}

/**
 * Validate an untrusted value as a {@link BridgeMessage}. Precedence:
 *
 *   1. If the value carries a `protocolVersion` outside the readable window,
 *      return a typed `INCOMPATIBLE` WITHOUT mutation (no coercion; D-06.1).
 *   2. Otherwise validate the full shape; any shape error (including a missing
 *      workspace identity) is a typed `VALIDATION`.
 *
 * `expectedBridge` optionally pins the bridge so a message of another bridge is
 * rejected as `VALIDATION` (no cross-bridge type leakage) rather than accepted.
 */
export function validateBridgeMessage(
  value: unknown,
  options: { readonly expectedBridge?: Bridge; readonly correlationId?: string } = {},
): ProtocolResult<BridgeMessage> {
  const correlationId = options.correlationId;
  // (1) Version gate first — an incompatible major is never coerced.
  if (value !== null && typeof value === 'object') {
    const pv = (value as { protocolVersion?: unknown }).protocolVersion;
    if (typeof pv === 'number' && classifyProtocolVersion(pv) === 'incompatible') {
      return {
        ok: false,
        error: protocolError(
          'INCOMPATIBLE',
          `unsupported bridge protocolVersion ${pv}; readable window is [${PROTOCOL_MIN_READABLE_VERSION},${PROTOCOL_MAX_READABLE_VERSION}]`,
          'protocol.parse',
          correlationId,
        ),
      };
    }
  }

  const parsed = BridgeMessageSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: protocolError('VALIDATION', summarize(parsed.error), 'protocol.parse', correlationId),
    };
  }

  // Guard: a readable-shape message whose protocolVersion is still out of the
  // readable window (belt-and-suspenders) is incompatible, not valid.
  if (classifyProtocolVersion(parsed.data.protocolVersion) === 'incompatible') {
    return {
      ok: false,
      error: protocolError(
        'INCOMPATIBLE',
        `unsupported bridge protocolVersion ${parsed.data.protocolVersion}`,
        'protocol.parse',
        correlationId,
      ),
    };
  }

  // (2) No cross-bridge type leakage: a pinned bridge must match exactly.
  if (options.expectedBridge && parsed.data.bridge !== options.expectedBridge) {
    return {
      ok: false,
      error: protocolError(
        'VALIDATION',
        `bridge '${parsed.data.bridge}' does not match the expected bridge '${options.expectedBridge}'`,
        'protocol.parse',
        correlationId,
      ),
    };
  }

  return { ok: true, value: parsed.data };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Lossless canonical round-trip (NN-DATA-010, V-INTEGRATION-001)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Serialize a validated bridge message to canonical bytes. Object keys are
 * sorted so two structurally equal messages serialize identically (NN-DATA-010).
 */
export function serializeBridgeMessage(message: BridgeMessage): string {
  return canonicalSerialize(message);
}

/** Parse canonical bytes back to an untrusted value for re-validation. */
export function deserializeBridgeMessage(bytes: string): unknown {
  return JSON.parse(bytes);
}

/**
 * Round-trip a validated bridge message: serialize then parse+validate. Returns
 * the re-validated message, proving the versioned protocol is LOSSLESS with no
 * type leakage (V-INTEGRATION-001/ide-cli-round-trip). The bridge is pinned to
 * the input's bridge so the round-trip also proves no cross-bridge leakage.
 */
export function roundTripBridgeMessage(
  message: BridgeMessage,
): ProtocolResult<BridgeMessage> {
  const bytes = serializeBridgeMessage(message);
  return validateBridgeMessage(deserializeBridgeMessage(bytes), {
    expectedBridge: message.bridge,
    correlationId: message.correlationId,
  });
}

/**
 * Structural equality of two bridge messages by canonical bytes. Two messages
 * are equal iff their canonical serializations match — the definition of a
 * lossless round-trip.
 */
export function bridgeMessagesEqual(a: BridgeMessage, b: BridgeMessage): boolean {
  return canonicalSerialize(a) === canonicalSerialize(b);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Disconnect-safe session marker (NN-INTEGRATION-005)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute the safe session outcome of a bridge disconnect. A disconnect NEVER
 * corrupts session state (NN-INTEGRATION-005): the last committed session
 * revision is preserved and the session is left READABLE. This is a pure
 * classifier — it emits the marker a caller records; it mutates no store.
 */
export interface DisconnectOutcome {
  readonly bridge: Bridge;
  readonly workspaceId: string;
  /** The last committed session revision, preserved across the disconnect. */
  readonly preservedRevision: number;
  /** Always true: the session remains readable after a disconnect. */
  readonly sessionReadable: true;
  readonly reason: string;
}

/**
 * Produce the disconnect outcome for a bridge/workspace at a committed session
 * revision. The revision is preserved verbatim and the session stays readable;
 * an in-flight message is simply dropped, never a partial/corrupt write.
 */
export function onBridgeDisconnect(input: {
  readonly bridge: Bridge;
  readonly workspaceId: string;
  readonly committedRevision: number;
}): DisconnectOutcome {
  const revision =
    Number.isInteger(input.committedRevision) && input.committedRevision >= 0
      ? input.committedRevision
      : 0;
  return {
    bridge: input.bridge,
    workspaceId: input.workspaceId,
    preservedRevision: revision,
    sessionReadable: true,
    reason:
      'bridge disconnected; last committed session revision preserved and ' +
      'session left readable (no partial/corrupt write)',
  };
}
