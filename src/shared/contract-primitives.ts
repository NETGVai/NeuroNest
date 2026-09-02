/**
 * Common identities and D-07 contract primitives.
 *
 * Implements the shared identity and command-plane contracts that D-06 and
 * D-07 of the NeuroNest canonical spec require:
 *
 *   - {@link ScopeDescriptor} — `ScopeDescriptor@1`
 *   - {@link CommandEnvelope} — `CommandEnvelope@1`
 *   - {@link CommandReceipt} — `CommandReceipt@1`
 *   - {@link ErrorEnvelope} — `ErrorEnvelope@1`
 *
 * Alongside the four contracts this module provides the primitive building
 * blocks they share: opaque type-prefixed IDs, monotonic revisions, lowercase
 * SHA-256 digests, the redaction class ladder, the typed error taxonomy, a
 * deterministic canonical serializer, and the `[1,1]` read/write contract
 * registry matrix from D-07.2.
 *
 * The task is deliberately additive (FUT-PKG-02-FOUNDATION/T-001): these are
 * new types/adapters with no writer cutover. Nothing here mutates existing IPC
 * contracts in `src/ipc/contracts.ts`; adapters translate only at boundaries.
 *
 * Design anchors: D-03, D-04, D-06, D-07.
 * Requirements: NN-INV-007/009/011, NN-DATA-004/010, NN-EVENT-007/008,
 * NN-IDENT-001/006.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

// ─── Version matrix (D-07.2) ────────────────────────────────────────────────

/**
 * The single write version for every `@1` contract in this module. A contract
 * registry entry declares `[minReadable, maxReadable]` and one `writeVersion`
 * (D-06.1). For `TARGET-DESKTOP@2.1` the identity/command-plane group is pinned
 * to `[1,1]` write `1` (D-07.2).
 */
export const CONTRACT_WRITE_VERSION = 1 as const;

/** Minimum readable major version for the `@1` contracts. */
export const CONTRACT_MIN_READABLE_VERSION = 1 as const;

/** Maximum readable major version for the `@1` contracts. */
export const CONTRACT_MAX_READABLE_VERSION = 1 as const;

/**
 * A Contract Registry compatibility entry: the readable window and the single
 * write version for one contract name (D-06.1, D-07.2).
 */
export interface ContractVersionMatrixEntry {
  readonly contractName: ContractName;
  readonly minReadable: number;
  readonly maxReadable: number;
  readonly writeVersion: number;
}

/** The contract names owned by this module. */
export type ContractName =
  | 'ScopeDescriptor'
  | 'CommandEnvelope'
  | 'CommandReceipt'
  | 'ErrorEnvelope';

/** Every contract name this module owns, in declaration order. */
export const CONTRACT_NAMES: readonly ContractName[] = Object.freeze([
  'ScopeDescriptor',
  'CommandEnvelope',
  'CommandReceipt',
  'ErrorEnvelope',
]);

/**
 * The explicit `[1,1]` read/write matrix (D-07.2). Every entry has
 * `minReadable = maxReadable = writeVersion = 1`; grouping does not merge
 * contracts, so each name is a distinct registry entry.
 */
export const CONTRACT_VERSION_MATRIX: readonly ContractVersionMatrixEntry[] =
  Object.freeze(
    CONTRACT_NAMES.map((contractName) =>
      Object.freeze({
        contractName,
        minReadable: CONTRACT_MIN_READABLE_VERSION,
        maxReadable: CONTRACT_MAX_READABLE_VERSION,
        writeVersion: CONTRACT_WRITE_VERSION,
      }),
    ),
  );

/** Lookup a contract's compatibility entry by name. */
export function contractVersionEntry(
  contractName: ContractName,
): ContractVersionMatrixEntry | undefined {
  return CONTRACT_VERSION_MATRIX.find(
    (entry) => entry.contractName === contractName,
  );
}

/**
 * Classify a `schemaVersion` against a contract's readable window.
 *
 *   - `readable`     — version is inside `[minReadable, maxReadable]`.
 *   - `incompatible` — version is a different (typically newer) major; the
 *     reader must return `INCOMPATIBLE` without mutation and preserve the
 *     original bytes/record (D-06.1, D-07.2).
 *   - `unknown`      — the contract name is not registered by this module.
 */
export function classifyReadableVersion(
  contractName: ContractName,
  schemaVersion: number,
): 'readable' | 'incompatible' | 'unknown' {
  const entry = contractVersionEntry(contractName);
  if (!entry) return 'unknown';
  if (!Number.isInteger(schemaVersion)) return 'incompatible';
  if (schemaVersion >= entry.minReadable && schemaVersion <= entry.maxReadable) {
    return 'readable';
  }
  return 'incompatible';
}

/** Whether `schemaVersion` is readable for `contractName`. */
export function isReadableVersion(
  contractName: ContractName,
  schemaVersion: number,
): boolean {
  return classifyReadableVersion(contractName, schemaVersion) === 'readable';
}

// ─── Redaction ladder (D-06.1) ──────────────────────────────────────────────

/**
 * Redaction class ladder. `secret` payloads are never serialized to renderer,
 * logs, telemetry, events, or evidence (D-06.1). Ordered from least to most
 * sensitive.
 */
export const REDACTION_CLASSES = Object.freeze([
  'public',
  'internal',
  'sensitive',
  'secret',
] as const);

export type RedactionClass = (typeof REDACTION_CLASSES)[number];

export const RedactionClassSchema = z.enum(REDACTION_CLASSES);

/** Whether a value is a valid redaction class. */
export function isRedactionClass(value: unknown): value is RedactionClass {
  return (
    typeof value === 'string' &&
    (REDACTION_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Whether a record at redaction class `cls` may cross an observable boundary
 * (renderer, log, telemetry, event, evidence). `secret` never may (D-06.1).
 */
export function isSerializableToObservable(cls: RedactionClass): boolean {
  return cls !== 'secret';
}

// ─── Opaque identifiers, revisions, and digests (D-06.1) ────────────────────

/**
 * IDs are opaque lower-case type-prefixed UUID/ULID-compatible strings; no
 * ordering depends on an ID timestamp (D-06.1). The registry accepts any
 * non-empty lowercase token so callers may mint UUIDv7/ULID bodies without
 * coupling ordering to the ID.
 */
const OPAQUE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;

/** Whether a string is a well-formed opaque type-prefixed ID. */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    OPAQUE_ID_PATTERN.test(value)
  );
}

/**
 * Compose an opaque, lower-case, type-prefixed ID from a type prefix and body.
 * The body is lower-cased; ordering never depends on any embedded timestamp.
 */
export function makeOpaqueId(typePrefix: string, body: string): string {
  const prefix = typePrefix.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tail = body.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (prefix.length === 0) {
    throw new Error('makeOpaqueId: type prefix must contain [a-z0-9]');
  }
  if (tail.length === 0) {
    throw new Error('makeOpaqueId: body must contain [a-z0-9]');
  }
  return `${prefix}-${tail}`;
}

/** Zod schema for an opaque ID. */
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(OPAQUE_ID_PATTERN, 'expected an opaque lower-case type-prefixed id');

/**
 * A monotonic revision. Every mutable authority record carries one and every
 * mutation supplies `expectedRevision` unless creating (D-06.1). Non-negative
 * integer.
 */
export const RevisionSchema = z.number().int().nonnegative().finite();

/** Whether a value is a valid monotonic revision. */
export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Lowercase SHA-256 hex digest pattern (64 hex chars). */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Whether a string is a lowercase SHA-256 hex digest. */
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/** Zod schema for a lowercase SHA-256 hex digest. */
export const DigestSchema = z
  .string()
  .regex(SHA256_HEX_PATTERN, 'expected a lowercase sha-256 hex digest');

/**
 * Compute the lowercase SHA-256 hex digest of a canonically serialized value.
 * Used for `payloadDigest` and `requestDigest`. Two structurally equal payloads
 * always produce the same digest regardless of key order; a changed payload
 * yields a different digest, which the command plane treats as a `CONFLICT`
 * when reused with the same idempotency key (D-06.1, D-07 CommandEnvelope@1).
 */
export function computeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

/** RFC 3339 / ISO-8601 UTC timestamp string for exchange (D-06.1). */
export const TimestampSchema = z.string().datetime();

/** Whether a string is a parseable RFC 3339 UTC timestamp. */
export function isTimestamp(value: unknown): value is string {
  return TimestampSchema.safeParse(value).success;
}

// ─── Canonical serialization (D-06 / NN-DATA-010) ───────────────────────────

/**
 * Deterministically serialize a JSON value with object keys sorted, so that
 * two structurally equal values always serialize to identical bytes. This
 * underpins digest stability and parse/serialize round-trip equivalence
 * (NN-DATA-010). `undefined` object properties are omitted (matching JSON);
 * `undefined` inside arrays becomes `null`, as `JSON.stringify` does.
 */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    out[key] = canonicalize(entry);
  }
  return out;
}

// ─── Typed error taxonomy (D-06.2) ──────────────────────────────────────────

/**
 * The D-06.2 typed error codes. Every externally visible failure returns one
 * of these (NN-INV-011). `INCOMPATIBLE` is returned for unknown/newer major
 * versions without mutation (D-06.1).
 */
export const ERROR_CODES = Object.freeze([
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'STALE_REVISION',
  'UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'INCOMPATIBLE',
  'INTEGRITY',
  'INTERNAL',
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Whether a value is a recognized typed error code. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
  );
}

// ─── ScopeDescriptor@1 (D-07) ───────────────────────────────────────────────

/**
 * A typed reference to a filesystem root or destination. Paths and
 * destinations are typed references, not trusted strings (D-07 ScopeDescriptor
 * invariant). The Security Authority normalizes the concrete reference; here we
 * only require a non-empty opaque reference id and its kind.
 */
export const ScopeReferenceSchema = z.strictObject({
  refId: OpaqueIdSchema,
  kind: z.enum(['root', 'destination']),
});
export type ScopeReference = z.infer<typeof ScopeReferenceSchema>;

/**
 * `ScopeDescriptor@1`. Security Authority normalizes it. Mutation-specific
 * required IDs cannot be omitted; a child scope is a subset of its parent
 * (D-07). `userId` and `owner` are always required; the rest are optional
 * identity anchors that a mutation may require.
 */
export const ScopeDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  userId: OpaqueIdSchema,
  projectId: OpaqueIdSchema.optional(),
  workspaceId: OpaqueIdSchema.optional(),
  repositoryId: OpaqueIdSchema.optional(),
  sessionId: OpaqueIdSchema.optional(),
  worktreeId: OpaqueIdSchema.optional(),
  turnId: OpaqueIdSchema.optional(),
  taskId: OpaqueIdSchema.optional(),
  agentId: OpaqueIdSchema.optional(),
  owner: OpaqueIdSchema,
  allowedRoots: z.array(ScopeReferenceSchema),
  allowedDestinations: z.array(ScopeReferenceSchema),
});
export type ScopeDescriptor = z.infer<typeof ScopeDescriptorSchema>;

/**
 * The scope identity fields that a specific mutation may declare as required.
 * `NN-IDENT-001`: missing scope blocks mutation.
 */
export type ScopeRequiredField =
  | 'projectId'
  | 'workspaceId'
  | 'repositoryId'
  | 'sessionId'
  | 'worktreeId'
  | 'turnId'
  | 'taskId'
  | 'agentId';

/**
 * Report which required scope IDs are missing for a mutation. An empty result
 * means the scope is sufficient. Missing mutation scope must cause no effect
 * (NN-IDENT-001).
 */
export function missingScopeFields(
  scope: ScopeDescriptor,
  required: readonly ScopeRequiredField[],
): ScopeRequiredField[] {
  return required.filter((field) => {
    const value = scope[field];
    return value === undefined || value === null || value === '';
  });
}

/**
 * Whether `child` is a subset of `parent`: every populated identity anchor on
 * the child equals the parent's, and the child's allowed roots/destinations are
 * a subset of the parent's (D-07 child-scope invariant).
 */
export function isChildScopeOf(
  child: ScopeDescriptor,
  parent: ScopeDescriptor,
): boolean {
  const anchors: readonly (keyof ScopeDescriptor)[] = [
    'userId',
    'owner',
    'projectId',
    'workspaceId',
    'repositoryId',
    'sessionId',
    'worktreeId',
    'turnId',
    'taskId',
    'agentId',
  ];
  for (const anchor of anchors) {
    const parentValue = parent[anchor];
    const childValue = child[anchor];
    if (parentValue !== undefined && childValue !== undefined) {
      if (parentValue !== childValue) return false;
    }
  }
  const parentRoots = new Set(parent.allowedRoots.map((r) => r.refId));
  for (const root of child.allowedRoots) {
    if (!parentRoots.has(root.refId)) return false;
  }
  const parentDests = new Set(parent.allowedDestinations.map((d) => d.refId));
  for (const dest of child.allowedDestinations) {
    if (!parentDests.has(dest.refId)) return false;
  }
  return true;
}

// ─── CommandEnvelope@1 (D-07) ───────────────────────────────────────────────

/**
 * `CommandEnvelope@1`. Contract Registry owns the shape; the target Domain
 * Service owns the effect. Same idempotency key plus digest returns the prior
 * receipt; a changed digest conflicts. Contract name/version and trace context
 * are immutable (D-07). `payloadDigest` must equal `computeDigest(payload)`.
 */
export const CommandEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  commandId: OpaqueIdSchema,
  commandType: z.string().min(1).max(256),
  contractName: z.string().min(1).max(256),
  contractVersion: z.number().int().positive().finite(),
  requestId: OpaqueIdSchema,
  correlationId: OpaqueIdSchema,
  causationId: OpaqueIdSchema.optional(),
  traceId: OpaqueIdSchema,
  spanId: OpaqueIdSchema.optional(),
  idempotencyKey: z.string().min(1).max(512),
  actor: OpaqueIdSchema,
  scope: ScopeDescriptorSchema,
  expectedRevision: RevisionSchema.optional(),
  deadlineAt: TimestampSchema.optional(),
  cancellationTokenId: OpaqueIdSchema,
  payload: z.unknown(),
  payloadDigest: DigestSchema,
  redaction: RedactionClassSchema,
  createdAt: TimestampSchema,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

// ─── CommandReceipt@1 (D-07) ────────────────────────────────────────────────

/**
 * `CommandReceipt@1`. The command owner persists the receipt in the same
 * transaction as every durable authority mutation and its outbox records; no
 * terminal commit means no success receipt (D-07, D-07.1). Exactly one of
 * `resultRef` or `error` is meaningful for a terminal receipt: a success
 * receipt carries no `error`, and an error receipt carries an `ErrorEnvelope`.
 */
export const CommandReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
    receiptId: OpaqueIdSchema,
    commandId: OpaqueIdSchema,
    idempotencyKey: z.string().min(1).max(512),
    requestDigest: DigestSchema,
    authority: OpaqueIdSchema,
    authorityRevision: RevisionSchema,
    outboxEventIds: z.array(OpaqueIdSchema),
    resultRef: OpaqueIdSchema.optional(),
    error: z.lazy(() => ErrorEnvelopeSchema).optional(),
    committedAt: TimestampSchema,
  })
  .refine((r) => !(r.resultRef !== undefined && r.error !== undefined), {
    message: 'CommandReceipt cannot carry both resultRef and error',
    path: ['error'],
  });
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

// ─── ErrorEnvelope@1 (D-06.2) ───────────────────────────────────────────────

/**
 * `ErrorEnvelope@1`. The producing authority owns classification. `INTERNAL`
 * never leaks a raw cause; a `TIMEOUT` records whether the final effect is
 * known via `effectKnown`. Safe messages never include secrets or private
 * absolute paths (D-06.2, NN-INV-011). This module owns only the shape; the
 * caller is responsible for pre-redacting `message`/`remediation`.
 */
export const ErrorEnvelopeSchema: z.ZodType<ErrorEnvelope> = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  code: ErrorCodeSchema,
  message: z.string().min(1).max(4096),
  owner: OpaqueIdSchema,
  operation: z.string().min(1).max(256),
  correlationId: OpaqueIdSchema,
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().finite().optional(),
  remediation: z.string().max(4096).optional(),
  detailsRef: OpaqueIdSchema.optional(),
  redaction: RedactionClassSchema,
  causeCode: ErrorCodeSchema.optional(),
  effectKnown: z.boolean().optional(),
});

export interface ErrorEnvelope {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly code: ErrorCode;
  readonly message: string;
  readonly owner: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly remediation?: string;
  readonly detailsRef?: string;
  readonly redaction: RedactionClass;
  readonly causeCode?: ErrorCode;
  readonly effectKnown?: boolean;
}

// ─── Validation results and errors ──────────────────────────────────────────

/**
 * The outcome of validating an untrusted value against a contract: either a
 * typed value or a typed `ErrorEnvelope`. This models "deterministic typed
 * rejection" — the same invalid input always yields the same typed failure
 * with no side effect (NN-INV-011).
 */
export type ContractValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

interface ValidateOptions {
  /** Authority id to stamp on any produced ErrorEnvelope. */
  readonly owner?: string;
  /** Operation label for the ErrorEnvelope. */
  readonly operation?: string;
  /** Correlation id to thread through the ErrorEnvelope. */
  readonly correlationId?: string;
}

const FALLBACK_OWNER = 'authority-contract-registry';

function validationError(
  code: ErrorCode,
  message: string,
  options: ValidateOptions,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: isOpaqueId(options.owner) ? options.owner : FALLBACK_OWNER,
    operation: options.operation ?? 'validate',
    correlationId: isOpaqueId(options.correlationId)
      ? options.correlationId
      : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction: 'internal',
  };
}

/** Summarize a zod error into a single safe, secret-free message. */
function summarizeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
  return parts.join('; ');
}

// ─── Parse / validate for each contract ─────────────────────────────────────

function parseWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: ValidateOptions,
): ContractValidation<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: validationError('VALIDATION', summarizeIssues(result.error), options),
  };
}

/**
 * Validate an untrusted value as a `ScopeDescriptor@1`. Rejects an unknown
 * major version with `INCOMPATIBLE` and any other shape error with
 * `VALIDATION`, deterministically and with no side effect.
 */
export function validateScopeDescriptor(
  value: unknown,
  options: ValidateOptions = {},
): ContractValidation<ScopeDescriptor> {
  const versionCheck = checkMajorVersion('ScopeDescriptor', value, options);
  if (versionCheck) return { ok: false, error: versionCheck };
  return parseWith(ScopeDescriptorSchema, value, options);
}

/**
 * Validate an untrusted value as a `CommandEnvelope@1`. Beyond shape, this
 * enforces `payloadDigest === computeDigest(payload)`; a mismatch is a
 * `CONFLICT` (idempotency digest integrity, D-06.1 / D-07).
 */
export function validateCommandEnvelope(
  value: unknown,
  options: ValidateOptions = {},
): ContractValidation<CommandEnvelope> {
  const versionCheck = checkMajorVersion('CommandEnvelope', value, options);
  if (versionCheck) return { ok: false, error: versionCheck };
  const parsed = parseWith(CommandEnvelopeSchema, value, options);
  if (!parsed.ok) return parsed;
  const expectedDigest = computeDigest(parsed.value.payload);
  if (parsed.value.payloadDigest !== expectedDigest) {
    return {
      ok: false,
      error: validationError(
        'CONFLICT',
        'payloadDigest does not match the canonical digest of payload',
        options,
      ),
    };
  }
  return parsed;
}

/** Validate an untrusted value as a `CommandReceipt@1`. */
export function validateCommandReceipt(
  value: unknown,
  options: ValidateOptions = {},
): ContractValidation<CommandReceipt> {
  const versionCheck = checkMajorVersion('CommandReceipt', value, options);
  if (versionCheck) return { ok: false, error: versionCheck };
  return parseWith(CommandReceiptSchema, value, options);
}

/** Validate an untrusted value as an `ErrorEnvelope@1`. */
export function validateErrorEnvelope(
  value: unknown,
  options: ValidateOptions = {},
): ContractValidation<ErrorEnvelope> {
  const versionCheck = checkMajorVersion('ErrorEnvelope', value, options);
  if (versionCheck) return { ok: false, error: versionCheck };
  return parseWith(ErrorEnvelopeSchema, value, options);
}

/**
 * If `value` carries a `schemaVersion` that is a different major than the
 * contract's readable window, produce an `INCOMPATIBLE` error without mutation
 * (D-06.1). Returns `undefined` when the version is readable or absent (absent
 * is left for the shape validator to flag as `VALIDATION`).
 */
function checkMajorVersion(
  contractName: ContractName,
  value: unknown,
  options: ValidateOptions,
): ErrorEnvelope | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion !== 'number') return undefined;
  if (classifyReadableVersion(contractName, schemaVersion) === 'incompatible') {
    return validationError(
      'INCOMPATIBLE',
      `unsupported ${contractName} schemaVersion ${schemaVersion}; readable window is [${CONTRACT_MIN_READABLE_VERSION},${CONTRACT_MAX_READABLE_VERSION}]`,
      options,
    );
  }
  return undefined;
}

// ─── Serialization / round-trip ─────────────────────────────────────────────

/**
 * Serialize a validated contract to canonical bytes. `secret`-classed records
 * are never serialized to an observable target (D-06.1); callers that must
 * serialize a `secret` record to durable storage should pass
 * `{ allowSecret: true }` to acknowledge the record stays inside the owning
 * authority.
 */
export function serializeContract(
  contract: object,
  options: { readonly allowSecret?: boolean } = {},
): string {
  const redaction = (contract as { redaction?: unknown }).redaction;
  if (redaction === 'secret' && options.allowSecret !== true) {
    throw new Error(
      'serializeContract: refusing to serialize a secret-classed record to an observable target',
    );
  }
  return canonicalSerialize(contract);
}

/** Parse canonical bytes back to an untrusted value for re-validation. */
export function deserializeContract(bytes: string): unknown {
  return JSON.parse(bytes);
}

/**
 * Round-trip a validated `ScopeDescriptor`: serialize then re-parse+validate.
 * Returns the re-validated value, proving parse/serialize equivalence
 * (NN-DATA-010).
 */
export function roundTripScopeDescriptor(
  scope: ScopeDescriptor,
): ContractValidation<ScopeDescriptor> {
  return validateScopeDescriptor(
    deserializeContract(serializeContract(scope)),
  );
}

/** Round-trip a validated `CommandEnvelope` (NN-DATA-010). */
export function roundTripCommandEnvelope(
  envelope: CommandEnvelope,
): ContractValidation<CommandEnvelope> {
  return validateCommandEnvelope(
    deserializeContract(serializeContract(envelope)),
  );
}

/** Round-trip a validated `CommandReceipt` (NN-DATA-010). */
export function roundTripCommandReceipt(
  receipt: CommandReceipt,
): ContractValidation<CommandReceipt> {
  return validateCommandReceipt(
    deserializeContract(serializeContract(receipt)),
  );
}

/** Round-trip a validated `ErrorEnvelope` (NN-DATA-010). */
export function roundTripErrorEnvelope(
  envelope: ErrorEnvelope,
): ContractValidation<ErrorEnvelope> {
  return validateErrorEnvelope(
    deserializeContract(serializeContract(envelope)),
  );
}

// ─── Idempotency / digest conflict (D-06.1, NN-INV-007) ─────────────────────

/**
 * The outcome of applying a command under an idempotency key already bound to
 * a prior receipt (D-06.1 / D-07):
 *
 *   - `replay`   — same idempotency key and same request digest: return the
 *     prior receipt with no new business effect.
 *   - `conflict` — same idempotency key but a different request digest: a
 *     `CONFLICT` with no effect; last-writer-wins is forbidden.
 */
export type IdempotencyOutcome =
  | { readonly kind: 'replay'; readonly receipt: CommandReceipt }
  | { readonly kind: 'conflict'; readonly error: ErrorEnvelope };

/**
 * Reconcile an incoming request digest against the prior receipt bound to the
 * same idempotency key. Equal digests replay the prior receipt; a changed
 * digest conflicts with no effect (NN-INV-007, D-06.1).
 */
export function reconcileIdempotency(
  priorReceipt: CommandReceipt,
  incomingRequestDigest: string,
  options: ValidateOptions = {},
): IdempotencyOutcome {
  if (priorReceipt.requestDigest === incomingRequestDigest) {
    return { kind: 'replay', receipt: priorReceipt };
  }
  return {
    kind: 'conflict',
    error: validationError(
      'CONFLICT',
      `idempotency key ${priorReceipt.idempotencyKey} reused with a different request digest`,
      { ...options, owner: options.owner ?? priorReceipt.authority },
    ),
  };
}
