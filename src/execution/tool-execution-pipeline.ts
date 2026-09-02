/**
 * ToolExecutionPipeline — the ONE governed tool execution choke point
 * (FUT-PKG-06-EXECUTION/T-002).
 *
 * D-11 / NN-EXEC-001 require that EVERY tool path — built-in, skill, plugin,
 * MCP, browser, terminal, LSP, and generated — execute through exactly one
 * typed pipeline, and that no path reach execution by any other route. This
 * module is that pipeline. Its sole public entry, {@link ToolExecutionPipeline.execute},
 * runs the fixed D-11 ordered sequence ({@link PIPELINE_STAGES}) and is the only
 * place the injected {@link ToolExecutor} is ever invoked. A tool that does not
 * traverse this method never runs (the no-bypass guarantee,
 * V-EXEC-001/no-bypass-property).
 *
 * The D-11 ordered sequence (each stage is recorded on the `ToolCall@1` as it
 * runs, so the order is auditable — V-EXEC-001/tool-pipeline-order):
 *
 *   1. `manifest`        — registry lookup + input-schema-digest validation.
 *   2. `preflight`       — ordered SecurityAuthority preflight
 *      (scope/path → agent/tool permission → firewall/command/network →
 *      credential-REFERENCE scope/audience [NO secret resolution] → sandbox
 *      capability preflight [NO execution]) via {@link evaluateOrdered}.
 *   3. `budget`          — {@link reserve} under current pricing/policy revision.
 *   4. `approval`        — required risk approval bound to the EXACT digest.
 *   5. `secret`          — LATE scoped secret resolution at the operation edge
 *      via {@link CredentialService.resolveAtBoundary}; resolved values are
 *      disposed immediately after the tool runs and never persisted.
 *   6. `execution-world` — create the verified sandbox world (no host fallback).
 *   7. `journal`         — commit the OperationJournal `pending`/`applying` row
 *      BEFORE any external effect (D-08.2), for non-`pure` tools.
 *   8. `execute`         — run the tool inside the world, guarded by the
 *      cancellation token so a cancelled token rejects any emission.
 *   9. `output-policy`   — validate/redact the untrusted tool output.
 *   10.`receipt`         — commit the terminal `ToolCall@1` + CommandReceipt +
 *      outbox (and journal terminal) in the durable authority transaction.
 *   11.`present`         — the observer reads the committed terminal receipt.
 *
 * On ANY gate failure (denied / unavailable / stale / cancelled), the pipeline
 * commits a terminal `ToolCall@1` with a typed {@link TerminalFailureClass} and
 * a D-06.2 error, refunds any budget reservation idempotently, and produces NO
 * side effect, NO raw secret exposure, NO host fallback, and NO uncommitted
 * success (V-SEC-001/tool-no-effect-failures). Every outcome — success or any
 * failure — yields exactly one terminal receipt.
 *
 * Late-resolution discipline (D-16.6, NN-INV-004): the pipeline validates the
 * credential REFERENCE (type/audience/scope) during preflight but resolves the
 * raw value only at stage `secret`, immediately before `execute`, through the
 * CredentialService boundary; the resolved value lives only in a
 * {@link ResolvedSecret} that is disposed after the tool returns and is never
 * placed on the `ToolCall@1`, receipt, journal, evidence, or error.
 *
 * The pipeline persists into REAL durable tables: the terminal `ToolCall@1`
 * and its `CommandReceipt@1`/outbox commit through
 * {@link applyAuthorityMutation} (D-08.2 single-writer, idempotent-by-key), and
 * external-effect tools additionally journal through {@link beginJournaledOperation}
 * / {@link commitJournaledOperation}. Budget, approval, sandbox, credential, and
 * cancellation authorities are the SAME ones the rest of the system uses; this
 * pipeline composes them, it does not fork them.
 *
 * Design anchors: D-05, D-07 (`ToolCall@1`), D-11 (governed sequence), D-16
 * (secrets/sandbox/approval), D-17 (isolation), D-18 (retry / false-success).
 * Requirements: NN-EXEC-001/002/003/005/009, NN-SEC-002, NN-APPROVAL-001/002,
 * NN-ORCH-013, NN-INV-001/003/004/011.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  computeScopeKey,
  ensureAuthorityTables,
  type EventIntent,
} from '../storage/authority-transaction';
import {
  beginJournaledOperation,
  commitJournaledOperation,
  ensureOperationJournalTables,
  markApplying,
  type RecoveryStrategy,
} from '../storage/operation-journal';
import {
  commit as budgetCommit,
  ensureBudgetTables,
  reserve as budgetReserve,
  refund as budgetRefund,
} from '../storage/budget-authority';
import { evaluateOrdered, type OrderedCheck } from '../shared/security-authority';
import type { ResolvedSecret } from '../shared/credential-service';
import { computeApprovalDigest, type NormalizedAction } from '../approval/approval-types';
import type { CancellationController } from '../shared/execution-cancellation';
import type { Money } from '../shared/decimal-money';
import {
  FAILURE_CODE,
  isExternalEffect,
  retryClassFor,
  type PipelineStage,
  type SideEffectClass,
  type TerminalFailureClass,
  type ToolCall,
  type ToolManifest,
} from './tool-types';
import type { RegistryResult, ToolManifestRegistry } from './tool-manifest-registry';

const PIPELINE_OWNER = 'authority-tool-execution';

// ─── Injected authority ports ───────────────────────────────────────────────

/**
 * The credential-reference preflight port. Validates a `CredentialRef`'s type,
 * audience, and scope WITHOUT resolving the raw value (D-11 preflight). It
 * returns `allow`/`deny` only; no secret leaves this call.
 */
export interface CredentialPreflightPort {
  /** Whether the credential reference is valid for this actor/scope/audience. */
  validateReference(input: {
    readonly credentialRefId: string;
    readonly audience: string;
    readonly scope: string;
  }): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope };
}

/**
 * The LATE secret-resolution port. Resolves the raw value at the operation edge
 * ONLY, returning a {@link ResolvedSecret} the pipeline disposes after the tool
 * runs. Production wires this to {@link CredentialService.resolveAtBoundary}.
 */
export interface SecretResolutionPort {
  resolveAtBoundary(input: {
    readonly credentialRefId: string;
    readonly actor: string;
    readonly audience: string;
    readonly scope: string;
    readonly expectedRevocationEpoch: number;
    readonly correlationId?: string;
  }):
    | { readonly ok: true; readonly value: ResolvedSecret }
    | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** A created sandbox execution world handle (opaque to the pipeline). */
export interface ExecutionWorld {
  readonly executionWorldId: string;
  /** The confined profile the world runs under (never an unsandboxed spawn). */
  readonly profile: 'strict' | 'standard' | 'degraded-read-only';
}

/**
 * The sandbox execution-world port. Creates a verified world from the preflight
 * capability revision, or returns a typed `UNAVAILABLE` with NO host fallback
 * (D-11, NN-SEC-003). Production wires this to {@link SandboxExecutionManager}.
 */
export interface ExecutionWorldPort {
  create(input: {
    readonly isolation: 'strict' | 'standard' | 'read-only';
    readonly correlationId?: string;
  }):
    | { readonly ok: true; readonly world: ExecutionWorld }
    | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** The concrete tool execution result (success or a typed tool error). */
export type ToolExecutionResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * The injected tool executor — the ONLY thing that performs the real tool
 * effect. The pipeline invokes it exactly once, inside the cancellation guard,
 * after every prior D-11 gate passed. A resolved secret is supplied here and
 * ONLY here (late resolution). The executor never sees budget/approval state.
 */
export interface ToolExecutor {
  execute(input: {
    readonly manifest: ToolManifest;
    readonly world: ExecutionWorld;
    readonly toolInput: unknown;
    /** Resolved secrets, keyed by credentialRefId; disposed by the pipeline. */
    readonly secrets: ReadonlyMap<string, ResolvedSecret>;
    readonly deadlineAt: string;
    readonly cancellationTokenId: string;
  }): ToolExecutionResult;
}

/**
 * The output policy port. Validates/redacts the untrusted tool output before it
 * is persisted or presented (NN-SEC-001, NN-EXEC-009). Rejecting output is a
 * typed `VALIDATION` terminal failure (no partial success).
 */
export interface OutputPolicyPort {
  apply(input: {
    readonly manifest: ToolManifest;
    readonly output: unknown;
  }):
    | { readonly ok: true; readonly outputRef: string; readonly redactedOutput: unknown }
    | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** The approval-check port: whether a bound decision authorizes this digest. */
export interface ApprovalPort {
  /**
   * Whether a current, non-stale `ApprovalDecision@1` approves exactly
   * `actionDigest`. Returns the decision id when approved, else a typed denial.
   */
  checkApproved(input: {
    readonly actionDigest: string;
    readonly correlationId?: string;
  }):
    | { readonly ok: true; readonly decisionId: string }
    | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** Injectable authority ports for the pipeline. */
export interface PipelinePorts {
  readonly registry: ToolManifestRegistry;
  readonly credentialPreflight: CredentialPreflightPort;
  readonly secretResolution: SecretResolutionPort;
  readonly executionWorld: ExecutionWorldPort;
  readonly executor: ToolExecutor;
  readonly outputPolicy: OutputPolicyPort;
  /** Optional; required only when a tool's risk demands approval. */
  readonly approval?: ApprovalPort;
}

// ─── The one tool invocation intent ─────────────────────────────────────────

/** A credential reference the tool needs, with its resolution context. */
export interface RequiredCredential {
  readonly credentialRefId: string;
  readonly audience: string;
  readonly scope: string;
  readonly expectedRevocationEpoch: number;
}

/**
 * The `ToolCall@1` intent an `AgentRun` submits. The pipeline is the ONLY
 * consumer; there is no direct-execution alternative. `additionalChecks` lets a
 * caller inject earlier ordered preflight checks (scope/path, permission,
 * firewall) produced by the SecurityAuthority; the pipeline always appends the
 * credential-scope and sandbox checks in D-11 order.
 */
export interface ToolCallIntent {
  readonly runId: string;
  readonly attempt: number;
  readonly manifestName: string;
  readonly manifestVersion: number;
  readonly scope: ScopeDescriptor;
  /** The actor performing the call (opaque id; used for late resolution). */
  readonly actor: string;
  readonly correlationId: string;
  readonly cancellationTokenId: string;
  /** The structured tool input; its digest is bound, the raw stays out of DB. */
  readonly toolInput: unknown;
  /** Wall-clock deadline for the whole call. */
  readonly deadlineAt: string;
  /** Ordered preflight checks (scope/path, permission, firewall) to run first. */
  readonly preflightChecks: readonly OrderedCheck[];
  /** Credentials to resolve LATE at the edge (never earlier). */
  readonly requiredCredentials?: readonly RequiredCredential[];
  /** The budget to reserve against (cost-bearing tools). */
  readonly budget?: {
    readonly budgetId: string;
    readonly amount: Money;
    readonly pricingVersion: string;
  };
}

// ─── Terminal outcome ────────────────────────────────────────────────────────

/** The pipeline's terminal outcome. Exactly one terminal receipt every time. */
export type PipelineOutcome =
  | {
      readonly kind: 'succeeded';
      readonly toolCall: ToolCall;
      readonly outputRef: string;
      readonly redactedOutput: unknown;
    }
  | {
      readonly kind: 'failed';
      readonly toolCall: ToolCall;
      readonly failureClass: TerminalFailureClass;
      readonly error: ErrorEnvelope;
    };

// ─── The pipeline ─────────────────────────────────────────────────────────────

export interface PipelineOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/**
 * Ensure every durable table the pipeline writes exists. Additive and
 * idempotent; safe at startup and in tests.
 */
export function ensureToolPipelineTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  ensureBudgetTables(db);
  ensureOperationJournalTables(db);
  ensureToolCallTable(db);
}

export class ToolExecutionPipeline {
  private readonly db: Database.Database;
  private readonly ports: PipelinePorts;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(db: Database.Database, ports: PipelinePorts, options: PipelineOptions = {}) {
    this.db = db;
    this.ports = ports;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => cryptoRandomId());
  }

  /**
   * Execute one tool call through the full D-11 pipeline. This is the ONLY
   * public execution path (NN-EXEC-001). It always returns a terminal outcome
   * with exactly one committed terminal receipt; it never throws for a gate
   * failure.
   */
  execute(
    intent: ToolCallIntent,
    cancellation: CancellationController,
  ): PipelineOutcome {
    const nowIso = this.now().toISOString();
    const toolCallId = makeOpaqueId('tc', `${intent.runId}${intent.attempt}${this.createId()}`);
    const scopeKey = computeScopeKey(intent.scope);
    const inputDigest = computeDigest(intent.toolInput ?? null);
    const stagesRun: PipelineStage[] = [];

    // A mutable draft of the ToolCall we will commit terminally.
    const draft = {
      toolCallId,
      attempt: intent.attempt,
      runId: intent.runId,
      scopeKey,
      inputDigest,
      cancellationTokenId: intent.cancellationTokenId,
      deadlineAt: intent.deadlineAt,
      createdAt: nowIso,
    };

    // Helper: a cancellation check at a stage boundary. A cancelled token
    // converges to a terminal `cancelled` receipt with no further stage.
    const cancelledOutcome = (
      manifest: ToolManifest | undefined,
      sideEffect: SideEffectClass,
      reservation?: { budgetId: string; reservationKey: string; pricingVersion: string },
    ): PipelineOutcome | undefined => {
      if (cancellation.isActive(intent.cancellationTokenId)) return undefined;
      if (reservation) this.refundReservation(intent, reservation);
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass: 'cancelled',
        message: 'cancellation converged before tool execution; no effect',
      });
    };

    // ── Stage 1: manifest registry lookup + input validation ───────────────
    stagesRun.push('manifest');
    const lookup: RegistryResult<ToolManifest> = this.ports.registry.lookup(
      intent.manifestName,
      intent.manifestVersion,
      intent.correlationId,
    );
    if (!lookup.ok) {
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest: undefined,
        sideEffect: 'pure',
        stagesRun,
        failureClass: 'manifest-unavailable',
        error: lookup.error,
      });
    }
    const manifest = lookup.value;
    const sideEffect = manifest.sideEffectClass;

    // The declared input schema digest must match the tool's manifest. A tool
    // whose manifest advertises a different input contract cannot run (an inert
    // or mismatched wiring is never a success path, NN-EXEC-003).
    if (typeof (intent.toolInput as { schemaDigest?: unknown })?.schemaDigest === 'string') {
      const declared = (intent.toolInput as { schemaDigest: string }).schemaDigest;
      if (declared !== manifest.inputSchemaDigest) {
        return this.commitTerminalFailure({
          intent,
          draft,
          manifest,
          sideEffect,
          stagesRun,
          failureClass: 'manifest-unavailable',
          message: 'tool input schema digest does not match the admitted manifest',
        });
      }
    }

    let cancelled = cancelledOutcome(manifest, sideEffect);
    if (cancelled) return cancelled;

    // ── Stage 2: ordered preflight (NN-SEC-002 order) ──────────────────────
    // Assemble the ordered checks in D-11 order: the caller's scope/path,
    // permission, and firewall checks, then the credential-REFERENCE scope
    // check, then the sandbox capability preflight. evaluateOrdered enforces
    // the canonical stage order regardless of insertion order.
    stagesRun.push('preflight');
    const checks: OrderedCheck[] = [...intent.preflightChecks];

    // Credential-reference scope/audience (NO secret resolution here).
    checks.push({
      stage: 'credential-scope',
      run: () => {
        for (const cred of intent.requiredCredentials ?? []) {
          const v = this.ports.credentialPreflight.validateReference({
            credentialRefId: cred.credentialRefId,
            audience: cred.audience,
            scope: cred.scope,
          });
          if (!v.ok) {
            return {
              decision: 'deny' as const,
              stage: 'credential-scope' as const,
              reason: 'credential reference invalid',
              error: v.error,
            };
          }
        }
        return {
          decision: 'allow' as const,
          stage: 'credential-scope' as const,
          reason: 'credential references valid',
          value: undefined,
        };
      },
    });

    // Sandbox capability preflight (NO execution here).
    checks.push({
      stage: 'sandbox',
      run: () => {
        const world = this.ports.executionWorld.create({
          isolation: manifest.isolation,
          correlationId: intent.correlationId,
        });
        if (!world.ok) {
          return {
            decision: 'deny' as const,
            stage: 'sandbox' as const,
            reason: 'sandbox capability unavailable',
            error: world.error,
          };
        }
        // Preflight only inspects capability; the real world is created at
        // stage 6. (This probe does not spawn — the port's create is a
        // capability check that returns an unavailable error when isolation is
        // missing; it is re-invoked at stage 6 to obtain the world handle.)
        return {
          decision: 'allow' as const,
          stage: 'sandbox' as const,
          reason: 'sandbox capability available',
          value: undefined,
        };
      },
    });

    const preflight = evaluateOrdered(checks, { correlationId: intent.correlationId });
    if (preflight.decision !== 'allow') {
      // A sandbox-stage denial is a capability-unavailable terminal; every
      // earlier stage denial is a preflight-denied terminal. Either way: no
      // budget reservation, no secret resolution, no execution world, no
      // effect.
      const failureClass: TerminalFailureClass =
        preflight.stage === 'sandbox' ? 'world-unavailable' : 'preflight-denied';
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass,
        error: preflight.error,
        policyDecisionId: makeOpaqueId('pol', `${toolCallId}${preflight.stage}`),
      });
    }
    const policyDecisionId = makeOpaqueId('pol', `${toolCallId}allow`);

    cancelled = cancelledOutcome(manifest, sideEffect);
    if (cancelled) return cancelled;

    // ── Stage 3: budget reservation (NN-ORCH-013) ──────────────────────────
    stagesRun.push('budget');
    let reservation:
      | { budgetId: string; reservationKey: string; pricingVersion: string }
      | undefined;
    if (intent.budget) {
      const reservationKey = `tc-reserve:${toolCallId}`;
      const actionDigest = this.actionDigest(intent, manifest);
      const outcome = budgetReserve(this.db, {
        budgetId: intent.budget.budgetId,
        reservationKey,
        idempotencyKey: `budget-reserve:${toolCallId}`,
        correlationId: intent.correlationId,
        scope: intent.scope,
        amount: intent.budget.amount,
        pricingVersion: intent.budget.pricingVersion,
        actionDigest,
        now: this.now,
      });
      if (outcome.kind === 'error') {
        // At/beyond cap or stale pricing: terminal BUDGET_EXCEEDED. No secret,
        // no world, no effect. (D-11: an approval to extend the budget is a
        // separate re-submission; the pipeline never silently downgrades.)
        return this.commitTerminalFailure({
          intent,
          draft,
          manifest,
          sideEffect,
          stagesRun,
          failureClass: 'budget-exceeded',
          error: outcome.error,
          policyDecisionId,
        });
      }
      reservation = {
        budgetId: intent.budget.budgetId,
        reservationKey,
        pricingVersion: intent.budget.pricingVersion,
      };
    }

    cancelled = cancelledOutcome(manifest, sideEffect, reservation);
    if (cancelled) return cancelled;

    // ── Stage 4: required approval (NN-APPROVAL-001/002) ───────────────────
    stagesRun.push('approval');
    let approvalRequestId: string | undefined;
    if (manifest.risk === 'high') {
      if (!this.ports.approval) {
        if (reservation) this.refundReservation(intent, reservation);
        return this.commitTerminalFailure({
          intent,
          draft,
          manifest,
          sideEffect,
          stagesRun,
          failureClass: 'approval-denied',
          message: 'high-risk tool requires approval but no approval authority is wired',
          policyDecisionId,
        });
      }
      const actionDigest = this.approvalDigest(intent, manifest);
      const decision = this.ports.approval.checkApproved({
        actionDigest,
        correlationId: intent.correlationId,
      });
      if (!decision.ok) {
        if (reservation) this.refundReservation(intent, reservation);
        return this.commitTerminalFailure({
          intent,
          draft,
          manifest,
          sideEffect,
          stagesRun,
          failureClass: 'approval-denied',
          error: decision.error,
          policyDecisionId,
        });
      }
      approvalRequestId = decision.decisionId;
    }

    cancelled = cancelledOutcome(manifest, sideEffect, reservation);
    if (cancelled) return cancelled;

    // ── Stage 5: LATE secret resolution (D-16.6, NN-INV-004) ───────────────
    stagesRun.push('secret');
    const resolved = new Map<string, ResolvedSecret>();
    const disposeSecrets = (): void => {
      for (const s of resolved.values()) s.dispose();
      resolved.clear();
    };
    for (const cred of intent.requiredCredentials ?? []) {
      const r = this.ports.secretResolution.resolveAtBoundary({
        credentialRefId: cred.credentialRefId,
        actor: intent.actor,
        audience: cred.audience,
        scope: cred.scope,
        expectedRevocationEpoch: cred.expectedRevocationEpoch,
        correlationId: intent.correlationId,
      });
      if (!r.ok) {
        disposeSecrets();
        if (reservation) this.refundReservation(intent, reservation);
        return this.commitTerminalFailure({
          intent,
          draft,
          manifest,
          sideEffect,
          stagesRun,
          failureClass: 'secret-unavailable',
          error: r.error,
          policyDecisionId,
          approvalRequestId,
        });
      }
      resolved.set(cred.credentialRefId, r.value);
    }

    // ── Stage 6: execution world (no host fallback, NN-SEC-003) ────────────
    stagesRun.push('execution-world');
    const worldResult = this.ports.executionWorld.create({
      isolation: manifest.isolation,
      correlationId: intent.correlationId,
    });
    if (!worldResult.ok) {
      disposeSecrets();
      if (reservation) this.refundReservation(intent, reservation);
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass: 'world-unavailable',
        error: worldResult.error,
        policyDecisionId,
        approvalRequestId,
      });
    }
    const world = worldResult.world;

    cancelled = cancelledOutcome(manifest, sideEffect, reservation);
    if (cancelled) {
      disposeSecrets();
      return cancelled;
    }

    // ── Stage 7: journal pending/applying before external effect (D-08.2) ──
    stagesRun.push('journal');
    let journalId: string | undefined;
    if (isExternalEffect(sideEffect)) {
      const strategy = this.recoveryStrategy(sideEffect);
      const journal = beginJournaledOperation(this.db, {
        authority: PIPELINE_OWNER,
        operationId: toolCallId,
        idempotencyKey: `tool-journal:${toolCallId}`,
        correlationId: intent.correlationId,
        scope: intent.scope,
        expectedRevision: 0,
        strategy,
        providerIdempotencyKey: `tool-effect:${toolCallId}`,
        now: this.now,
      });
      journalId = journal.journalId;
      // Flip to `applying`/`unknown` the instant before the effect so a crash
      // during execution is never blindly repeated (NN-INV-003).
      markApplying(this.db, journalId, this.now);
    }

    // ── Stage 8: execute inside the world under cancellation guard ─────────
    stagesRun.push('execute');
    const startedAt = this.now().toISOString();
    // The tool effect is produced ONLY through the cancellation guard: a token
    // that has begun cancelling rejects the emission and no effect occurs.
    const guarded = cancellation.emit(intent.cancellationTokenId, () =>
      this.ports.executor.execute({
        manifest,
        world,
        toolInput: intent.toolInput,
        secrets: resolved,
        deadlineAt: intent.deadlineAt,
        cancellationTokenId: intent.cancellationTokenId,
      }),
    );
    // Secrets are no longer needed once the tool has run (or was rejected).
    disposeSecrets();

    if (!guarded.ok) {
      // Cancellation converged at the execution edge: refund, terminal cancel.
      if (reservation) this.refundReservation(intent, reservation);
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass: 'cancelled',
        error: guarded.error,
        policyDecisionId,
        approvalRequestId,
        journalId,
        executionWorldId: world.executionWorldId,
      });
    }
    const execResult = guarded.value;
    if (!execResult.ok) {
      // The tool itself failed. Refund the reservation; commit a terminal
      // tool-error receipt (and terminal journal) — never a success.
      if (reservation) this.refundReservation(intent, reservation);
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass: 'tool-error',
        error: execResult.error,
        policyDecisionId,
        approvalRequestId,
        journalId,
        executionWorldId: world.executionWorldId,
      });
    }

    // ── Stage 9: output policy ─────────────────────────────────────────────
    stagesRun.push('output-policy');
    const policed = this.ports.outputPolicy.apply({ manifest, output: execResult.output });
    if (!policed.ok) {
      if (reservation) this.refundReservation(intent, reservation);
      return this.commitTerminalFailure({
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        failureClass: 'output-rejected',
        error: policed.error,
        policyDecisionId,
        approvalRequestId,
        journalId,
        executionWorldId: world.executionWorldId,
      });
    }

    // ── Stage 10: commit the terminal success receipt (D-08.2) ─────────────
    stagesRun.push('receipt');
    const endedAt = this.now().toISOString();
    const outputRef = policed.outputRef;
    const toolCall: ToolCall = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      toolCallId,
      attempt: intent.attempt,
      runId: intent.runId,
      manifestName: manifest.name,
      manifestVersion: manifest.manifestVersion,
      manifestDigest: manifest.contentDigest,
      trustSource: manifest.trustSource,
      scopeKey,
      inputDigest,
      sideEffectClass: sideEffect,
      stagesRun: [...stagesRun, 'present'],
      policyDecisionId,
      ...(approvalRequestId !== undefined ? { approvalRequestId } : {}),
      ...(reservation ? { budgetReservationId: reservation.reservationKey } : {}),
      executionWorldId: world.executionWorldId,
      ...(journalId !== undefined ? { journalId } : {}),
      deadlineAt: intent.deadlineAt,
      cancellationTokenId: intent.cancellationTokenId,
      status: 'succeeded',
      outputRef,
      createdAt: nowIso,
      startedAt,
      endedAt,
    };

    const committed = this.commitToolCall(intent, toolCall, {
      reservation,
      // Commit the actual cost = reserved amount for a successful cost-bearing
      // tool (over-run would require a separate re-reserve, never here).
      commitBudget: Boolean(reservation),
      journalId,
    });
    if (!committed.ok) {
      // The terminal commit itself failed: the effect status is uncertain. We
      // return INTEGRITY and NEVER success (NN-INV-003, D-18). The journal
      // stays non-terminal for restart reconciliation.
      return this.integrityOutcome(intent, draft, manifest, sideEffect, stagesRun, committed.error);
    }

    // ── Stage 11: present (observer reads the committed terminal receipt) ───
    return {
      kind: 'succeeded',
      toolCall: { ...toolCall, receiptRevision: committed.authorityRevision },
      outputRef,
      redactedOutput: policed.redactedOutput,
    };
  }

  // ── Terminal failure commit ──────────────────────────────────────────────

  /**
   * Commit exactly one terminal `ToolCall@1` failure receipt through the
   * durable authority transaction, with a typed error and failure class. This
   * is the single place a non-success terminal receipt is written; every gate
   * branch routes here. It never runs the tool and never resolves a secret.
   */
  private commitTerminalFailure(params: {
    intent: ToolCallIntent;
    draft: TerminalDraft;
    manifest: ToolManifest | undefined;
    sideEffect: SideEffectClass;
    stagesRun: readonly PipelineStage[];
    failureClass: TerminalFailureClass;
    error?: ErrorEnvelope;
    message?: string;
    policyDecisionId?: string;
    approvalRequestId?: string;
    journalId?: string;
    executionWorldId?: string;
  }): PipelineOutcome {
    const { intent, draft, manifest, sideEffect, stagesRun, failureClass } = params;
    const code = FAILURE_CODE[failureClass];
    const error =
      params.error ??
      this.error(code, params.message ?? `tool call ${failureClass}`, intent.correlationId);
    const endedAt = this.now().toISOString();
    const retryClass = retryClassFor(failureClass, sideEffect);

    const toolCall: ToolCall = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      toolCallId: draft.toolCallId,
      attempt: draft.attempt,
      runId: draft.runId,
      manifestName: manifest?.name ?? intent.manifestName,
      manifestVersion: manifest?.manifestVersion ?? intent.manifestVersion,
      manifestDigest: manifest?.contentDigest ?? 'blocked',
      trustSource: manifest?.trustSource ?? 'built-in',
      scopeKey: draft.scopeKey,
      inputDigest: draft.inputDigest,
      sideEffectClass: sideEffect,
      stagesRun: [...stagesRun],
      ...(params.policyDecisionId !== undefined
        ? { policyDecisionId: params.policyDecisionId }
        : {}),
      ...(params.approvalRequestId !== undefined
        ? { approvalRequestId: params.approvalRequestId }
        : {}),
      ...(params.executionWorldId !== undefined
        ? { executionWorldId: params.executionWorldId }
        : {}),
      ...(params.journalId !== undefined ? { journalId: params.journalId } : {}),
      deadlineAt: draft.deadlineAt,
      cancellationTokenId: draft.cancellationTokenId,
      status: this.failureState(failureClass),
      error,
      failureClass,
      retryClass,
      createdAt: draft.createdAt,
      endedAt,
    };

    const committed = this.commitToolCall(intent, toolCall, {
      // A blocked/failed non-success never commits budget; if a reservation was
      // taken it was already refunded by the caller before reaching here.
      commitBudget: false,
      journalId: params.journalId,
      journalBlocked: params.journalId !== undefined,
    });
    if (!committed.ok) {
      return this.integrityOutcome(
        intent,
        draft,
        manifest,
        sideEffect,
        stagesRun,
        committed.error,
      );
    }
    return {
      kind: 'failed',
      toolCall: { ...toolCall, receiptRevision: committed.authorityRevision },
      failureClass,
      error,
    };
  }

  // ── Durable commit of the ToolCall + receipt + outbox ────────────────────

  private commitToolCall(
    intent: ToolCallIntent,
    toolCall: ToolCall,
    options: {
      reservation?: { budgetId: string; reservationKey: string; pricingVersion: string };
      commitBudget: boolean;
      journalId?: string;
      journalBlocked?: boolean;
    },
  ): { ok: true; authorityRevision: number } | { ok: false; error: ErrorEnvelope } {
    const event: EventIntent = {
      eventType: `tool.${toolCall.status}`,
      aggregateType: 'ToolCall',
      aggregateId: toolCall.toolCallId,
      payloadSchemaName: 'ToolCall',
      payloadSchemaVersion: CONTRACT_WRITE_VERSION,
      payload: {
        toolCallId: toolCall.toolCallId,
        status: toolCall.status,
        failureClass: toolCall.failureClass ?? null,
        manifestName: toolCall.manifestName,
      },
      redaction: 'internal',
    };

    const result = applyAuthorityMutation(this.db, {
      authority: PIPELINE_OWNER,
      commandId: makeOpaqueId('cmd', toolCall.toolCallId),
      idempotencyKey: `toolcall-terminal:${toolCall.toolCallId}`,
      requestDigest: computeDigest({
        toolCallId: toolCall.toolCallId,
        status: toolCall.status,
        inputDigest: toolCall.inputDigest,
      }),
      correlationId: intent.correlationId,
      scope: intent.scope,
      now: this.now,
      mutate: (tx) => {
        tx.prepare(
          `INSERT INTO tool_calls (tool_call_id, run_id, status, failure_class, record_json, committed_at)
           VALUES (@id, @runId, @status, @failureClass, @recordJson, @committedAt)
           ON CONFLICT(tool_call_id) DO NOTHING`,
        ).run({
          id: toolCall.toolCallId,
          runId: toolCall.runId,
          status: toolCall.status,
          failureClass: toolCall.failureClass ?? null,
          recordJson: serializeContract(toolCall, { allowSecret: false }),
          committedAt: toolCall.endedAt ?? toolCall.createdAt,
        });
        return { resultRef: toolCall.outputRef };
      },
      events: [event],
    });

    if (result.kind === 'conflict') {
      return { ok: false, error: result.error };
    }
    if (result.kind === 'replayed') {
      // A prior identical terminal commit exists (idempotent). Treat as
      // committed at the replayed receipt's revision.
      return { ok: true, authorityRevision: result.receipt.authorityRevision };
    }

    const authorityRevision = result.authorityRevision;

    // Commit the budget for a successful cost-bearing tool, in a separate
    // idempotent transaction (budget is its own authority).
    if (options.commitBudget && options.reservation && intent.budget) {
      budgetCommit(this.db, {
        budgetId: options.reservation.budgetId,
        reservationKey: options.reservation.reservationKey,
        idempotencyKey: `budget-commit:${toolCall.toolCallId}`,
        correlationId: intent.correlationId,
        scope: intent.scope,
        actualAmount: intent.budget.amount,
        pricingVersion: options.reservation.pricingVersion,
        now: this.now,
      });
    }

    // Flip the journal to a terminal state matching the outcome.
    if (options.journalId) {
      commitJournaledOperation(this.db, {
        journalId: options.journalId,
        currentRevision: 0,
        finalize: () => ({ resultRef: toolCall.outputRef }),
        now: this.now,
      });
    }

    return { ok: true, authorityRevision };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private refundReservation(
    intent: ToolCallIntent,
    reservation: { budgetId: string; reservationKey: string; pricingVersion: string },
  ): void {
    budgetRefund(this.db, {
      budgetId: reservation.budgetId,
      reservationKey: reservation.reservationKey,
      idempotencyKey: `budget-refund:${reservation.reservationKey}`,
      correlationId: intent.correlationId,
      scope: intent.scope,
      pricingVersion: reservation.pricingVersion,
      now: this.now,
    });
  }

  private integrityOutcome(
    intent: ToolCallIntent,
    draft: TerminalDraft,
    manifest: ToolManifest | undefined,
    sideEffect: SideEffectClass,
    stagesRun: readonly PipelineStage[],
    error: ErrorEnvelope,
  ): PipelineOutcome {
    const toolCall: ToolCall = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      toolCallId: draft.toolCallId,
      attempt: draft.attempt,
      runId: draft.runId,
      manifestName: manifest?.name ?? intent.manifestName,
      manifestVersion: manifest?.manifestVersion ?? intent.manifestVersion,
      manifestDigest: manifest?.contentDigest ?? 'blocked',
      trustSource: manifest?.trustSource ?? 'built-in',
      scopeKey: draft.scopeKey,
      inputDigest: draft.inputDigest,
      sideEffectClass: sideEffect,
      stagesRun: [...stagesRun],
      deadlineAt: draft.deadlineAt,
      cancellationTokenId: draft.cancellationTokenId,
      status: 'failed',
      error,
      failureClass: 'integrity',
      retryClass: retryClassFor('integrity', sideEffect),
      createdAt: draft.createdAt,
      endedAt: this.now().toISOString(),
    };
    return { kind: 'failed', toolCall, failureClass: 'integrity', error };
  }

  private failureState(failureClass: TerminalFailureClass): ToolCall['status'] {
    if (failureClass === 'cancelled') return 'cancelled';
    if (
      failureClass === 'tool-error' ||
      failureClass === 'output-rejected' ||
      failureClass === 'integrity'
    ) {
      return 'failed';
    }
    // Pre-execution gate denials are `blocked`.
    return 'blocked';
  }

  private recoveryStrategy(sideEffect: SideEffectClass): RecoveryStrategy {
    switch (sideEffect) {
      case 'idempotent':
        return 'idempotent';
      case 'receipt-queryable':
        return 'receipt-queryable';
      case 'compensatable':
        return 'compensatable';
      case 'non-retryable':
        return 'non-retryable';
      default:
        return 'pure';
    }
  }

  private actionDigest(intent: ToolCallIntent, manifest: ToolManifest): string {
    return computeDigest({
      action: manifest.name,
      manifestVersion: manifest.manifestVersion,
      inputDigest: intent.toolInput ?? null,
      scopeKey: computeScopeKey(intent.scope),
    });
  }

  private approvalDigest(intent: ToolCallIntent, manifest: ToolManifest): string {
    const action: NormalizedAction = {
      action: manifest.name,
      arguments: this.asArgumentRecord(intent.toolInput),
      scopeKey: computeScopeKey(intent.scope),
      risk: manifest.risk,
      owner: PIPELINE_OWNER,
      planRevision: 0,
      expiresAt: intent.deadlineAt,
    };
    return computeApprovalDigest(action);
  }

  private asArgumentRecord(input: unknown): Record<string, unknown> {
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    return { value: input ?? null };
  }

  private error(code: ErrorCode, message: string, correlationId: string): ErrorEnvelope {
    return {
      schemaVersion: CONTRACT_WRITE_VERSION,
      code,
      message,
      owner: PIPELINE_OWNER,
      operation: 'tool-execute',
      correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
      retryable: code === 'VALIDATION',
      redaction: 'internal',
    };
  }
}

/** The immutable identity of a tool call, carried across all terminal branches. */
interface TerminalDraft {
  readonly toolCallId: string;
  readonly attempt: number;
  readonly runId: string;
  readonly scopeKey: string;
  readonly inputDigest: string;
  readonly cancellationTokenId: string;
  readonly deadlineAt: string;
  readonly createdAt: string;
}

/** DDL for the pipeline's own `tool_calls` ledger (additive, solely owned). */
const TOOL_CALLS_DDL = `
  CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_class TEXT,
    record_json TEXT NOT NULL,
    committed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls (run_id);
`;

/** Create the `tool_calls` ledger table if absent. Additive and idempotent. */
export function ensureToolCallTable(db: Database.Database): void {
  db.exec(TOOL_CALLS_DDL);
}

/** Opaque random id body without a hard crypto dependency at import time. */
function cryptoRandomId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('node:crypto') as { randomUUID: () => string };
  return randomUUID().replace(/-/g, '');
}

/** Read a persisted `ToolCall@1` record by id, or `undefined`. */
export function readToolCall(db: Database.Database, toolCallId: string): ToolCall | undefined {
  const row = db
    .prepare(`SELECT record_json FROM tool_calls WHERE tool_call_id = ?`)
    .get(toolCallId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as ToolCall) : undefined;
}

/** Count persisted tool-call rows for a run (test/audit helper). */
export function countToolCalls(db: Database.Database, runId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?`)
    .get(runId) as { n: number };
  return row.n;
}
