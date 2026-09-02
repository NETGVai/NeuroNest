/**
 * Tool execution contracts — `ToolManifest@1`, `ToolCall@1`, the D-11 ordered
 * pipeline stage vocabulary, and the typed terminal-failure taxonomy
 * (FUT-PKG-06-EXECUTION/T-002).
 *
 * D-11 defines the ONE governed tool execution and approval sequence that every
 * built-in / skill / plugin / MCP / browser / terminal / LSP / generated tool
 * MUST pass through (NN-EXEC-001 tool choke point). This module owns the two
 * schema-versioned records and the fixed stage/terminal-failure vocabularies
 * the pipeline (see {@link ./tool-execution-pipeline}) and manifest registry
 * (see {@link ./tool-manifest-registry}) bind to:
 *
 *   - {@link ToolManifest} — `ToolManifest@1` (NN-EXEC-002): a tool's stable
 *     name/version, input schema digest, side-effect class, risk, permissions,
 *     path/network/secret scopes, timeout, concurrency, cancellation support,
 *     render intent, trust source, and owner. A duplicate effective identity or
 *     an incompatible manifest blocks activation (NN-EXEC-002/003) — the
 *     registry never registers an inert tool as an executable success path.
 *   - {@link ToolCall} — `ToolCall@1` (D-07): the durable record of one tool
 *     invocation. Execution starts ONLY after every ordered gate receipt; raw
 *     secrets are absent; retry follows the manifest idempotency class; and a
 *     durable success requires an authoritative terminal receipt.
 *   - {@link PIPELINE_STAGES} — the fixed D-11 ordered sequence the pipeline
 *     runs. The order is authoritative: a caller cannot reorder it, and a
 *     denial at any stage short-circuits every later stage with no effect.
 *   - {@link TerminalFailureClass} — the typed terminal failures a gate/effect
 *     branch commits. Every non-success outcome maps to exactly one class and a
 *     `D-06.2` {@link ErrorCode}.
 *
 * This module is additive over {@link ../shared/contract-primitives} and reuses
 * its canonical serializer / `computeDigest` so the manifest digest and input
 * digest share the same key-order-independent, structurally-stable definition
 * as every other contract digest (D-07).
 *
 * Design anchors: D-05 (ToolExecutionPipeline responsibility), D-07
 * (`ToolCall@1`), D-11 (governed sequence), D-16 (secrets/sandbox/approval),
 * D-17 (isolation matrix), D-18 (retry / false-success prevention).
 * Requirements: NN-EXEC-001/002/003/005/009, NN-SEC-002, NN-APPROVAL-001/002,
 * NN-ORCH-013, NN-INV-001/003/004/011.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  computeDigest,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import { ISOLATION_REQUIREMENTS } from '../shared/platform-sandbox';
import { APPROVAL_RISKS } from '../approval/approval-types';

// ─── The D-11 ordered pipeline stages (NN-EXEC-001, NN-SEC-002) ─────────────

/**
 * The fixed, authoritative D-11 pipeline stage sequence, in execution order.
 * The pipeline runs these stages in exactly this order and the pipeline-order
 * property proves it (V-EXEC-001/tool-pipeline-order):
 *
 *   1. `manifest`        — manifest registry lookup + input-schema validation.
 *   2. `preflight`       — ordered SecurityAuthority preflight: scope/path →
 *                          agent/tool permission → firewall/command/network →
 *                          credential-REFERENCE scope/audience (no resolution) →
 *                          sandbox capability preflight (no execution).
 *   3. `budget`          — budget reservation under current pricing/policy.
 *   4. `approval`        — required risk approval bound to the exact digest.
 *   5. `secret`          — LATE scoped secret resolution at the operation edge.
 *   6. `execution-world` — create the verified sandbox execution world.
 *   7. `journal`         — commit the OperationJournal pending/applying row.
 *   8. `execute`         — run the tool inside the world under deadline/cancel.
 *   9. `output-policy`   — validate/redact the tool output as untrusted.
 *   10.`receipt`         — commit the terminal ToolCall + receipt + evidence.
 *   11.`present`         — the observer surface reads the committed receipt.
 *
 * Cancellation is checked at every stage boundary; retry class and typed
 * terminal failures are properties of the terminal receipt.
 */
export const PIPELINE_STAGES = Object.freeze([
  'manifest',
  'preflight',
  'budget',
  'approval',
  'secret',
  'execution-world',
  'journal',
  'execute',
  'output-policy',
  'receipt',
  'present',
] as const);
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The canonical 0-based index of a stage in the D-11 order. */
export const STAGE_INDEX: Readonly<Record<PipelineStage, number>> = Object.freeze(
  PIPELINE_STAGES.reduce(
    (acc, stage, i) => {
      acc[stage] = i;
      return acc;
    },
    {} as Record<PipelineStage, number>,
  ),
);

// ─── Side-effect and trust-source vocabularies (NN-EXEC-002) ────────────────

/**
 * The tool side-effect class. This selects the retry taxonomy (D-18) and
 * whether the effect must be journaled before it runs:
 *
 *   - `pure`             — reads/computes only; no external/filesystem effect.
 *   - `idempotent`       — a repeatable effect keyed by an idempotency key.
 *   - `receipt-queryable`— an external effect whose receipt can be queried.
 *   - `compensatable`    — an effect that can be reversed on failure.
 *   - `non-retryable`    — an effect that must not be blindly repeated.
 */
export const SIDE_EFFECT_CLASSES = Object.freeze([
  'pure',
  'idempotent',
  'receipt-queryable',
  'compensatable',
  'non-retryable',
] as const);
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];
export const SideEffectClassSchema = z.enum(SIDE_EFFECT_CLASSES);

/**
 * Whether a side-effect class denotes an external/filesystem effect that MUST
 * be journaled (D-08.2 / D-18) before it runs. `pure` tools never touch an
 * external system, so they carry no journal obligation.
 */
export function isExternalEffect(cls: SideEffectClass): boolean {
  return cls !== 'pure';
}

/**
 * The trust source of the tool path. Every tool path enumerated by NN-EXEC-001
 * is represented so the no-bypass property can prove EVERY class routes through
 * the one pipeline.
 */
export const TOOL_TRUST_SOURCES = Object.freeze([
  'built-in',
  'skill',
  'plugin',
  'mcp',
  'browser',
  'terminal',
  'lsp',
  'generated',
] as const);
export type ToolTrustSource = (typeof TOOL_TRUST_SOURCES)[number];
export const ToolTrustSourceSchema = z.enum(TOOL_TRUST_SOURCES);

/** How the pipeline should present the tool result to an observer surface. */
export const RENDER_INTENTS = Object.freeze([
  'inline',
  'diff',
  'terminal',
  'browser',
  'silent',
] as const);
export type RenderIntent = (typeof RENDER_INTENTS)[number];
export const RenderIntentSchema = z.enum(RENDER_INTENTS);

// ─── ToolManifest@1 (NN-EXEC-002) ───────────────────────────────────────────

const ScopeGlobSchema = z.string().min(1).max(512);

/**
 * `ToolManifest@1` (NN-EXEC-002). Each tool declares a stable identity, its
 * input schema digest, side-effect class, risk, permissions, path/network/
 * secret scopes, timeout, concurrency, cancellation support, render intent,
 * trust source, and owner. The registry rejects a duplicate effective identity
 * or an incompatible/inert manifest (NN-EXEC-002/003). `contentDigest` binds
 * the whole manifest so a tampered manifest cannot masquerade as a known tool.
 */
export const ToolManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  /** Stable tool name, e.g. `fs.write`, `browser.navigate`. */
  name: z.string().min(1).max(256),
  /** Major manifest version; a differing major is INCOMPATIBLE. */
  manifestVersion: RevisionSchema,
  /** Trust source (built-in/skill/plugin/mcp/browser/terminal/lsp/generated). */
  trustSource: ToolTrustSourceSchema,
  /** Owning authority id (e.g. `authority-tool-execution`). */
  owner: OpaqueIdSchema,
  /** Digest of the tool's declared input JSON schema (NN-EXEC-002 schemas). */
  inputSchemaDigest: DigestSchema,
  sideEffectClass: SideEffectClassSchema,
  risk: z.enum(APPROVAL_RISKS),
  /** The isolation requirement this tool needs (D-17). */
  isolation: z.enum(ISOLATION_REQUIREMENTS),
  /** Whether the tool honors cooperative cancellation (NN-EXEC-014). */
  cancellable: z.boolean(),
  /** Wall-clock timeout in ms (> 0). */
  timeoutMs: z.number().int().positive().finite(),
  /** Max concurrent invocations (>= 1). */
  maxConcurrency: z.number().int().positive().finite(),
  renderIntent: RenderIntentSchema,
  /** Declared permission scopes (opaque capability tokens). */
  permissions: z.array(z.string().min(1).max(256)),
  /** Allowed path scopes (globs); empty means the tool touches no path. */
  pathScopes: z.array(ScopeGlobSchema),
  /** Allowed network destination scopes; empty means no network. */
  networkScopes: z.array(ScopeGlobSchema),
  /** Credential-reference ids the tool may resolve at the edge (never raw). */
  secretScopes: z.array(OpaqueIdSchema),
  /**
   * Whether the tool has real production wiring. A manifest declared inert
   * (`false`) is catalog-only metadata and the registry refuses to admit it as
   * an executable success path (NN-EXEC-003).
   */
  implemented: z.boolean(),
  /** Digest binding the whole manifest content (set by the registry). */
  contentDigest: DigestSchema,
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/**
 * The bound identity fields that define a manifest's content digest. Two
 * manifests with equal bound fields produce the same digest; any change yields
 * a different digest. The `contentDigest` field itself is excluded.
 */
export function computeManifestDigest(
  manifest: Omit<ToolManifest, 'contentDigest'>,
): string {
  return computeDigest({
    name: manifest.name,
    manifestVersion: manifest.manifestVersion,
    trustSource: manifest.trustSource,
    owner: manifest.owner,
    inputSchemaDigest: manifest.inputSchemaDigest,
    sideEffectClass: manifest.sideEffectClass,
    risk: manifest.risk,
    isolation: manifest.isolation,
    cancellable: manifest.cancellable,
    timeoutMs: manifest.timeoutMs,
    maxConcurrency: manifest.maxConcurrency,
    renderIntent: manifest.renderIntent,
    permissions: [...manifest.permissions].sort(),
    pathScopes: [...manifest.pathScopes].sort(),
    networkScopes: [...manifest.networkScopes].sort(),
    secretScopes: [...manifest.secretScopes].sort(),
    implemented: manifest.implemented,
  });
}

/** The effective identity key of a manifest: name + major version. */
export function manifestIdentity(name: string, manifestVersion: number): string {
  return `${name}@${manifestVersion}`;
}

// ─── ToolCall@1 status ladder (D-07) ────────────────────────────────────────

/**
 * `ToolCall@1` status ladder. `applying` is the single non-terminal executing
 * state; every other state is terminal. Only `succeeded` reports success, and
 * only once an authoritative terminal receipt commits (NN-INV-003).
 */
export const TOOL_CALL_STATES = Object.freeze([
  'applying',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
] as const);
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

/** Whether a tool-call state is terminal. */
export function isTerminalToolCallState(state: ToolCallState): boolean {
  return state !== 'applying';
}

// ─── Typed terminal failure taxonomy (D-06.2 / D-11) ────────────────────────

/**
 * The typed terminal failure classes a gate or effect branch commits. Every
 * non-success terminal outcome maps to exactly one of these plus a D-06.2
 * {@link ErrorCode}. The class names the D-11 branch that stopped so audit can
 * show WHERE without leaking the input.
 */
export const TERMINAL_FAILURE_CLASSES = Object.freeze([
  'manifest-unavailable', // unknown/inert/incompatible manifest or bad input
  'preflight-denied', // scope/permission/firewall/credential-ref/sandbox denied
  'budget-exceeded', // reservation denied at/beyond cap with no extension
  'approval-denied', // required approval rejected, expired, stale, or missing
  'secret-unavailable', // late credential resolution failed (missing/revoked)
  'world-unavailable', // execution world could not be created (no host fallback)
  'cancelled', // cooperative cancellation converged before/at execution
  'tool-error', // the tool itself returned a typed error
  'output-rejected', // the tool output failed the output policy
  'integrity', // terminal commit failed; effect status uncertain
] as const);
export type TerminalFailureClass = (typeof TERMINAL_FAILURE_CLASSES)[number];

/** The D-06.2 error code each terminal failure class maps to. */
export const FAILURE_CODE: Readonly<Record<TerminalFailureClass, ErrorCode>> =
  Object.freeze({
    'manifest-unavailable': 'UNAVAILABLE',
    'preflight-denied': 'FORBIDDEN',
    'budget-exceeded': 'BUDGET_EXCEEDED',
    'approval-denied': 'FORBIDDEN',
    'secret-unavailable': 'UNAUTHORIZED',
    'world-unavailable': 'UNAVAILABLE',
    cancelled: 'CANCELLED',
    'tool-error': 'INTERNAL',
    'output-rejected': 'VALIDATION',
    integrity: 'INTEGRITY',
  });

/**
 * The retry class of a terminal outcome, derived from the D-18 taxonomy. The
 * pipeline records this on the terminal receipt so a caller knows whether a
 * retry is permitted and under what discipline.
 */
export const RETRY_CLASSES = Object.freeze([
  'no-retry', // terminal; retry only after the named cause changes
  'retry-after-input-change', // VALIDATION: retry only with changed input
  'retry-if-capability-changes', // UNAVAILABLE: retry only if health changes
  'retry-with-idempotency-key', // idempotent effect: safe to retry keyed
  'requires-receipt-query', // effect status unknown: query receipt first
] as const);
export type RetryClass = (typeof RETRY_CLASSES)[number];

/**
 * Derive the retry class for a terminal failure, honoring the tool's side
 * effect class. An `integrity` outcome on an external effect requires a receipt
 * query before any retry (D-18); a `tool-error` on an idempotent tool may be
 * retried under its idempotency key; everything else follows the error code.
 */
export function retryClassFor(
  failure: TerminalFailureClass,
  sideEffect: SideEffectClass,
): RetryClass {
  if (failure === 'integrity') {
    return isExternalEffect(sideEffect) ? 'requires-receipt-query' : 'no-retry';
  }
  if (failure === 'output-rejected') return 'retry-after-input-change';
  if (failure === 'manifest-unavailable') return 'retry-after-input-change';
  if (failure === 'world-unavailable' || failure === 'secret-unavailable') {
    return 'retry-if-capability-changes';
  }
  if (failure === 'tool-error') {
    switch (sideEffect) {
      case 'idempotent':
        return 'retry-with-idempotency-key';
      case 'receipt-queryable':
        return 'requires-receipt-query';
      default:
        return 'no-retry';
    }
  }
  // preflight-denied / budget-exceeded / approval-denied / cancelled.
  return 'no-retry';
}

// ─── ToolCall@1 (D-07) ──────────────────────────────────────────────────────

/**
 * `ToolCall@1` (D-07). The Tool Pipeline owns it. Execution starts only after
 * all ordered gate receipts; raw secrets are absent; retry follows the manifest
 * idempotency class; and a durable success requires an authoritative receipt.
 * A terminal record carries either a `resultRef` (success) or an `error` +
 * `failureClass` (non-success), never both.
 */
export interface ToolCall {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly toolCallId: string;
  readonly attempt: number;
  readonly runId: string;
  readonly manifestName: string;
  readonly manifestVersion: number;
  readonly manifestDigest: string;
  readonly trustSource: ToolTrustSource;
  /** Digest of the scope identity anchors. */
  readonly scopeKey: string;
  /** Digest of the structured tool input (never the raw input). */
  readonly inputDigest: string;
  readonly sideEffectClass: SideEffectClass;
  /** The stages that ran, in the order they ran (audit of D-11 order). */
  readonly stagesRun: readonly PipelineStage[];
  readonly policyDecisionId?: string;
  readonly approvalRequestId?: string;
  readonly budgetReservationId?: string;
  readonly executionWorldId?: string;
  readonly journalId?: string;
  readonly deadlineAt: string;
  readonly cancellationTokenId: string;
  readonly status: ToolCallState;
  readonly outputRef?: string;
  readonly error?: ErrorEnvelope;
  readonly failureClass?: TerminalFailureClass;
  readonly retryClass?: RetryClass;
  readonly receiptRevision?: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/** The Zod schema for a persisted `ToolCall@1` (validated on read). */
export const ToolCallSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  toolCallId: OpaqueIdSchema,
  attempt: z.number().int().nonnegative(),
  runId: OpaqueIdSchema,
  manifestName: z.string().min(1).max(256),
  manifestVersion: RevisionSchema,
  manifestDigest: DigestSchema,
  trustSource: ToolTrustSourceSchema,
  scopeKey: DigestSchema,
  inputDigest: DigestSchema,
  sideEffectClass: SideEffectClassSchema,
  stagesRun: z.array(z.enum(PIPELINE_STAGES)),
  policyDecisionId: OpaqueIdSchema.optional(),
  approvalRequestId: OpaqueIdSchema.optional(),
  budgetReservationId: z.string().min(1).max(256).optional(),
  executionWorldId: OpaqueIdSchema.optional(),
  journalId: OpaqueIdSchema.optional(),
  deadlineAt: TimestampSchema,
  cancellationTokenId: OpaqueIdSchema,
  status: z.enum(TOOL_CALL_STATES),
  outputRef: OpaqueIdSchema.optional(),
  error: z.unknown().optional(),
  failureClass: z.enum(TERMINAL_FAILURE_CLASSES).optional(),
  retryClass: z.enum(RETRY_CLASSES).optional(),
  receiptRevision: RevisionSchema.optional(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  endedAt: TimestampSchema.optional(),
});
