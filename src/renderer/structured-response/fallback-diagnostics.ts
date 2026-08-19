import { z } from 'zod';
import {
  DiagnosticEntityKindV1Schema,
  DiagnosticScopeV1Schema,
  OpaqueResponseIdSchema,
  RedactedDiagnosticReasonCodeV1Schema,
  RedactedDiagnosticV1Schema,
  ResponseDigestSchema,
  toTelemetrySafeDiagnosticV1,
  type DiagnosticScopeV1,
  type RedactedDiagnosticReasonCodeV1,
  type RedactedDiagnosticV1,
} from '../../harness/contracts/response-support';
import { ResponseBlockKindSchema } from '../../harness/contracts/response-composition';

/**
 * Source-free fallback diagnostics for the structured response renderer.
 *
 * Records contain only bounded versions, sizes, salted hashes, reason codes,
 * projection identity, and an opaque correlation alias. Raw summaries,
 * content, arguments, paths, prompts, URLs, locators, errors, and stacks are
 * never retained by this service or included in exports.
 *
 * Requirements: 2.4, 20.7-20.8, 22.6, 22.10
 */

const MAX_VERSION = 1_000_000;
const MAX_OBSERVED_SIZE = 10_000_000;
const FINGERPRINT_CHARACTER_LIMIT = 65_536;
const FINGERPRINT_DEPTH_LIMIT = 6;
const FINGERPRINT_ENTRY_LIMIT = 256;

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** Browser-safe SHA-256 used only for source-free diagnostic fingerprints. */
function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  return Array.from(state, (part) => part.toString(16).padStart(8, '0')).join('');
}

interface FingerprintSource {
  readonly serialized: string;
  readonly observedSize: number;
}

/**
 * Build a deterministic bounded fingerprint source without invoking accessors
 * or retaining the result. The returned source is immediately hashed.
 */
function fingerprintSource(value: unknown): FingerprintSource {
  const chunks: string[] = [];
  const visited = new Set<object>();
  let remaining = FINGERPRINT_CHARACTER_LIMIT;
  let observedSize = 0;

  const append = (text: string): void => {
    observedSize = Math.min(MAX_OBSERVED_SIZE, observedSize + text.length);
    if (remaining <= 0) return;
    const bounded = text.slice(0, remaining);
    chunks.push(bounded);
    remaining -= bounded.length;
  };

  const visit = (candidate: unknown, depth: number): void => {
    if (depth > FINGERPRINT_DEPTH_LIMIT) {
      append('[depth]');
      return;
    }
    if (candidate === null) {
      append('null');
      return;
    }
    switch (typeof candidate) {
      case 'string':
        append(`string:${candidate.length}:`);
        append(candidate);
        return;
      case 'number':
        append(`number:${Number.isFinite(candidate) ? candidate : 'non-finite'}`);
        return;
      case 'boolean':
        append(`boolean:${candidate}`);
        return;
      case 'bigint':
        append(`bigint:${candidate.toString()}`);
        return;
      case 'undefined':
        append('undefined');
        return;
      case 'symbol':
        append('symbol');
        return;
      case 'function':
        append('function');
        return;
      case 'object':
        break;
    }

    const object = candidate as object;
    if (visited.has(object)) {
      append('[circular]');
      return;
    }
    visited.add(object);

    if (Array.isArray(object)) {
      append(`array:${object.length}:[`);
      for (let index = 0; index < Math.min(object.length, FINGERPRINT_ENTRY_LIMIT); index += 1) {
        let item: unknown;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          item = descriptor && 'value' in descriptor ? descriptor.value : '[accessor]';
        } catch {
          item = '[uninspectable]';
        }
        visit(item, depth + 1);
      }
      append(']');
      return;
    }

    let keys: string[];
    try {
      keys = Object.keys(object).sort().slice(0, FINGERPRINT_ENTRY_LIMIT);
    } catch {
      append('[uninspectable]');
      return;
    }
    append(`object:${keys.length}:{`);
    for (const key of keys) {
      append(`key:${key.length}:${key}`);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        visit(descriptor && 'value' in descriptor ? descriptor.value : '[accessor]', depth + 1);
      } catch {
        append('[uninspectable]');
      }
    }
    append('}');
  };

  visit(value, 0);
  return { serialized: chunks.join(''), observedSize };
}

export const FallbackDiagnosticV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    diagnosticId: OpaqueResponseIdSchema,
    correlationId: OpaqueResponseIdSchema,
    reasonCode: RedactedDiagnosticReasonCodeV1Schema,
    scope: DiagnosticScopeV1Schema,
    severity: z.enum(['info', 'warning', 'error']),
    projectionRevision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().nonnegative().optional(),
    compositionVersion: z.number().int().nonnegative().max(MAX_VERSION).optional(),
    blockVersion: z.number().int().nonnegative().max(MAX_VERSION).optional(),
    intentVersion: z.number().int().nonnegative().max(MAX_VERSION).optional(),
    entityKind: DiagnosticEntityKindV1Schema.optional(),
    observedSize: z.number().int().nonnegative().max(MAX_OBSERVED_SIZE),
    contentDigest: ResponseDigestSchema,
    occurrences: z.number().int().positive().max(1_000_000),
  })
  .strict();

export type FallbackDiagnosticV1 = z.infer<typeof FallbackDiagnosticV1Schema>;

export const FallbackDiagnosticExportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(FallbackDiagnosticV1Schema),
    droppedRecordCount: z.number().int().nonnegative(),
    suppressedOccurrenceCount: z.number().int().nonnegative(),
    suppressedEmissionCount: z.number().int().nonnegative(),
    sinkFailureCount: z.number().int().nonnegative(),
  })
  .strict();

export type FallbackDiagnosticExportV1 = z.infer<typeof FallbackDiagnosticExportV1Schema>;

export interface FallbackDiagnosticInputV1 {
  readonly correlationId?: unknown;
  readonly reasonCode?: unknown;
  readonly scope?: unknown;
  readonly severity?: unknown;
  readonly projectionRevision?: unknown;
  readonly sourceRevision?: unknown;
  readonly compositionVersion?: unknown;
  readonly blockVersion?: unknown;
  readonly intentVersion?: unknown;
  readonly blockKind?: unknown;
  /** Arbitrary failed input used transiently for size and salted hash only. */
  readonly observed?: unknown;
}

export interface FallbackDiagnosticReceiptV1 {
  readonly diagnosticId: string;
  /** Pass this exact opaque alias to SafeGenericSurface or MinimalErrorSurface. */
  readonly correlationId: string;
  readonly projectionRevision: number;
  readonly occurrence: number;
  readonly emitted: boolean;
}

export interface FallbackDiagnosticSink {
  record(diagnostic: FallbackDiagnosticV1): void;
}

export interface FallbackDiagnosticsServiceOptions {
  readonly maxRecords?: number;
  readonly maxEmissionsPerProjectionRevision?: number;
  readonly maxTrackedProjectionRevisions?: number;
  readonly hashSalt?: string;
  readonly sink?: FallbackDiagnosticSink;
}

const DEFAULT_MAX_RECORDS = 64;
const DEFAULT_MAX_EMISSIONS_PER_REVISION = 8;
const DEFAULT_MAX_TRACKED_REVISIONS = 32;

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function boundedNonnegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_VERSION)
    : fallback;
}

function optionalVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_VERSION
    ? value
    : undefined;
}

function ownValue(value: unknown, key: keyof FallbackDiagnosticInputV1): unknown {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function resolveReasonCode(value: unknown): RedactedDiagnosticReasonCodeV1 {
  const parsed = RedactedDiagnosticReasonCodeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : 'RENDERER_FAILURE';
}

function resolveScope(value: unknown): DiagnosticScopeV1 {
  const parsed = DiagnosticScopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : 'renderer';
}

function resolveSeverity(value: unknown): 'info' | 'warning' | 'error' {
  return value === 'info' || value === 'warning' || value === 'error' ? value : 'error';
}

function defaultSalt(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `renderer-${Date.now()}-${Math.random()}`;
  }
}

/** Map closed registry failure reasons to the canonical redacted reason codes. */
export function fallbackReasonCode(reason: unknown): RedactedDiagnosticReasonCodeV1 {
  switch (reason) {
    case 'unsupported_contract_version':
      return 'UNSUPPORTED_VERSION';
    case 'invalid_block_kind':
      return 'UNSUPPORTED_KIND';
    case 'absent_mapping':
    case 'conflicting_mapping':
    case 'invalid_render_intent':
    case 'surface_kind_mismatch':
      return 'INCOMPATIBLE_RENDER_INTENT';
    case 'parse_failure':
    case 'invalid_block':
      return 'INVALID_CONTRACT';
    case 'render_failure':
    case 'update_failure':
    default:
      return 'RENDERER_FAILURE';
  }
}

/**
 * Bounded in-memory diagnostic collector. Exact repeats update one record and
 * never re-emit. Unique floods are capped per projection revision and globally.
 */
export class FallbackDiagnosticsService {
  private readonly maxRecords: number;
  private readonly maxEmissionsPerProjectionRevision: number;
  private readonly maxTrackedProjectionRevisions: number;
  private readonly salt: string;
  private readonly sink?: FallbackDiagnosticSink;
  private readonly records = new Map<string, FallbackDiagnosticV1>();
  private readonly emissionCounts = new Map<number, number>();
  private droppedRecordCount = 0;
  private suppressedOccurrenceCount = 0;
  private suppressedEmissionCount = 0;
  private sinkFailureCount = 0;

  constructor(options: FallbackDiagnosticsServiceOptions = {}) {
    this.maxRecords = boundedPositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 1_000);
    this.maxEmissionsPerProjectionRevision = boundedPositiveInteger(
      options.maxEmissionsPerProjectionRevision,
      DEFAULT_MAX_EMISSIONS_PER_REVISION,
      1_000,
    );
    this.maxTrackedProjectionRevisions = boundedPositiveInteger(
      options.maxTrackedProjectionRevisions,
      DEFAULT_MAX_TRACKED_REVISIONS,
      1_000,
    );
    this.salt = typeof options.hashSalt === 'string' && options.hashSalt.length > 0
      ? options.hashSalt.slice(0, 256)
      : defaultSalt();
    this.sink = options.sink;
  }

  /** Accept the existing renderer-boundary diagnostic sink contract safely. */
  record(diagnostic: RedactedDiagnosticV1): FallbackDiagnosticReceiptV1 {
    const safe = toTelemetrySafeDiagnosticV1(diagnostic);
    return this.recordFallback({
      correlationId: safe.correlationId,
      reasonCode: safe.reasonCode,
      scope: safe.scope,
      severity: safe.severity,
      projectionRevision: safe.sourceRevision ?? 0,
      sourceRevision: safe.sourceRevision,
      compositionVersion: safe.contractVersion,
      blockKind: safe.entityKind,
      observed: safe,
    });
  }

  recordFallback(input: FallbackDiagnosticInputV1): FallbackDiagnosticReceiptV1 {
    const correlationSource = ownValue(input, 'correlationId');
    const rawCorrelation = typeof correlationSource === 'string' ? correlationSource : 'unavailable';
    const correlationId = `fallback-correlation-${sha256(`${this.salt}\u0000${rawCorrelation}`).slice(0, 24)}`;
    const projectionRevision = boundedNonnegativeInteger(ownValue(input, 'projectionRevision'));
    const reasonCode = resolveReasonCode(ownValue(input, 'reasonCode'));
    const scope = resolveScope(ownValue(input, 'scope'));
    const severity = resolveSeverity(ownValue(input, 'severity'));
    const sourceRevision = optionalVersion(ownValue(input, 'sourceRevision'));
    const compositionVersion = optionalVersion(ownValue(input, 'compositionVersion'));
    const blockVersion = optionalVersion(ownValue(input, 'blockVersion'));
    const intentVersion = optionalVersion(ownValue(input, 'intentVersion'));
    const parsedKind = ResponseBlockKindSchema.safeParse(ownValue(input, 'blockKind'));
    const observed = fingerprintSource(ownValue(input, 'observed'));
    const contentDigest = `sha256:${sha256(`${this.salt}\u0000fallback-observed-v1\u0000${observed.serialized}`)}`;

    const identity = JSON.stringify([
      correlationId,
      projectionRevision,
      sourceRevision ?? null,
      reasonCode,
      scope,
      compositionVersion ?? null,
      blockVersion ?? null,
      intentVersion ?? null,
      parsedKind.success ? parsedKind.data : null,
      observed.observedSize,
      contentDigest,
    ]);
    const key = sha256(`fallback-diagnostic-key-v1\u0000${identity}`);
    const existing = this.records.get(key);
    if (existing) {
      const occurrence = Math.min(existing.occurrences + 1, 1_000_000);
      this.records.set(key, Object.freeze({ ...existing, occurrences: occurrence }));
      this.suppressedOccurrenceCount += 1;
      return Object.freeze({
        diagnosticId: existing.diagnosticId,
        correlationId,
        projectionRevision,
        occurrence,
        emitted: false,
      });
    }

    const diagnostic = FallbackDiagnosticV1Schema.parse({
      schemaVersion: 1,
      diagnosticId: `fallback-diagnostic-${sha256(`${this.salt}\u0000${key}`).slice(0, 24)}`,
      correlationId,
      reasonCode,
      scope,
      severity,
      projectionRevision,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(compositionVersion === undefined ? {} : { compositionVersion }),
      ...(blockVersion === undefined ? {} : { blockVersion }),
      ...(intentVersion === undefined ? {} : { intentVersion }),
      ...(parsedKind.success ? { entityKind: parsedKind.data } : {}),
      observedSize: observed.observedSize,
      contentDigest,
      occurrences: 1,
    });

    if (this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest !== undefined) this.records.delete(oldest);
      this.droppedRecordCount += 1;
    }
    this.records.set(key, Object.freeze(diagnostic));

    const emitted = this.reserveEmission(projectionRevision);
    if (emitted && this.sink) {
      try {
        this.sink.record(diagnostic);
      } catch {
        this.sinkFailureCount += 1;
      }
    }

    return Object.freeze({
      diagnosticId: diagnostic.diagnosticId,
      correlationId,
      projectionRevision,
      occurrence: 1,
      emitted,
    });
  }

  export(): FallbackDiagnosticExportV1 {
    return FallbackDiagnosticExportV1Schema.parse({
      schemaVersion: 1,
      records: Array.from(this.records.values(), (record) => ({ ...record })),
      droppedRecordCount: this.droppedRecordCount,
      suppressedOccurrenceCount: this.suppressedOccurrenceCount,
      suppressedEmissionCount: this.suppressedEmissionCount,
      sinkFailureCount: this.sinkFailureCount,
    });
  }

  private reserveEmission(projectionRevision: number): boolean {
    const count = this.emissionCounts.get(projectionRevision) ?? 0;
    if (count >= this.maxEmissionsPerProjectionRevision) {
      this.suppressedEmissionCount += 1;
      return false;
    }
    if (!this.emissionCounts.has(projectionRevision) && this.emissionCounts.size >= this.maxTrackedProjectionRevisions) {
      const oldest = this.emissionCounts.keys().next().value as number | undefined;
      if (oldest !== undefined) this.emissionCounts.delete(oldest);
    }
    this.emissionCounts.set(projectionRevision, count + 1);
    return true;
  }
}

/** Compile-time compatibility with the containment boundary diagnostic sink. */
const _rendererDiagnosticSinkCompatibility: { record(diagnostic: RedactedDiagnosticV1): void } =
  new FallbackDiagnosticsService({ hashSalt: 'compile-time-compatibility' });
void _rendererDiagnosticSinkCompatibility;
void RedactedDiagnosticV1Schema;
