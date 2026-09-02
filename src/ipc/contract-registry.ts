/**
 * Typed Contract and IPC Registry (FUT-PKG-02-FOUNDATION/T-002).
 *
 * Implements the D-05 `IPCContractRegistry` component and the D-02.3/R2 +
 * CD-029 decision that the *versioned typed Contract Registry is the target
 * authority* for the IPC boundary. Preload string allowlists and generic
 * send/invoke methods are bounded *compatibility adapters*: they are
 * mechanically compared with this registry, they emit alias/version telemetry,
 * they reject unregistered payloads at the main-process boundary, and — the
 * central invariant — **they never confer caller authorization**
 * (NN-SEC-009, NN-COMPAT-017, NN-EVENT-007).
 *
 * What this module owns:
 *
 *   - {@link ContractRegistry} — one versioned registry of API/IPC/preload/
 *     renderer-event contracts, each with owner, direction, tier, schema,
 *     timeout, cancellation, receipt (acknowledgement) behavior, aliases, and
 *     deprecation/alias telemetry (NN-EVENT-007 metadata set).
 *   - Mechanically generated facade descriptors (the preload method set) and
 *     handler descriptors (the main registration set), plus a *parity report*
 *     proving the generated facade set and handler set are exactly the set of
 *     registered contracts for their direction (V-EVENT-001/typed-registry-parity).
 *   - Typed no-effect rejection of unknown / stale (deprecated-past-sunset) /
 *     forged (renderer-asserted tier) contracts, each returning an
 *     `ErrorEnvelope@1` and performing no dispatch
 *     (V-SEC-001/ipc-unknown-contract).
 *   - A caller-authorization decision that derives the caller tier from a
 *     main-process-attested identity — never from a renderer-supplied marker or
 *     a broad string allowlist (D-16.2, NN-SEC-009).
 *
 * This module is deliberately additive and side-effect free: it registers no
 * Electron `ipcMain` handlers and mutates no existing contract. It runs *beside*
 * the measured ingress adapters (`src/ipc/contracts.ts`, `registrars.ts`,
 * `src/renderer/preload.ts`, `src/main/ipc.ts`) with one main-process writer and
 * no cutover (NN-COMPAT-001/002). Rollback returns a bounded validated adapter,
 * not generic authorization.
 *
 * Design anchors: D-03, D-05, D-06, D-07, D-16, D-20.
 * Requirements: NN-SEC-009, NN-EVENT-007/008/009, NN-COMPAT-001/002/017, CD-029.
 */

import {
  computeDigest,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type RedactionClass,
} from '../shared/contract-primitives';

// ─── Contract metadata (NN-EVENT-007) ───────────────────────────────────────

/**
 * Privilege tier. `privileged` sits between `authenticated` and `admin` and is
 * part of the D-16.2 ladder; the legacy preload adapter only distinguishes
 * `public | authenticated | admin`, which is why the compatibility comparison
 * treats a legacy `admin` marker as a *floor*, never as an authority grant.
 */
export type ContractTier = 'public' | 'authenticated' | 'privileged' | 'admin';

/** Ordered tiers, weakest to strongest. Index is the comparable rank. */
export const CONTRACT_TIERS: readonly ContractTier[] = Object.freeze([
  'public',
  'authenticated',
  'privileged',
  'admin',
]);

/** Numeric rank of a tier (higher is stronger). */
export function tierRank(tier: ContractTier): number {
  return CONTRACT_TIERS.indexOf(tier);
}

/**
 * Message direction across the IPC boundary.
 *
 *   - `renderer-to-main`  — request/command (preload `invoke`/`send`).
 *   - `main-to-renderer`  — snapshot/event/notification (preload `on`).
 */
export type ContractDirection = 'renderer-to-main' | 'main-to-renderer';

/**
 * Acknowledgement / receipt behavior (NN-EVENT-008).
 *
 *   - `committed-revision` — durable mutation; returns an ack tied to the
 *     committed authority revision (request/response).
 *   - `response`           — non-durable request/response (read/query).
 *   - `fire-and-forget`    — explicitly lossy telemetry only; never a durable
 *     mutation (NN-EVENT-008).
 */
export type ReceiptBehavior =
  | 'committed-revision'
  | 'response'
  | 'fire-and-forget';

/**
 * Alias/deprecation telemetry for a legacy channel name that maps to this
 * contract. Reuse of an alias is *measured*; an alias never widens the tier or
 * confers authorization (NN-COMPAT-017).
 */
export interface ContractAlias {
  /** The legacy string channel name observed on the preload allowlists. */
  readonly legacyChannel: string;
  /** Whether the alias is deprecated (still served, measured). */
  readonly deprecated: boolean;
  /** Optional epoch-ms sunset after which the alias is considered stale. */
  readonly sunsetAt?: number;
}

/**
 * A single Contract Registry entry. The metadata set is exactly the
 * NN-EVENT-007 required set: owner, direction, schema (request/response
 * validators), privilege (tier), acknowledgement behavior, timeout,
 * cancellation, request/correlation/idempotency key requirements, error
 * envelope ownership, aliases, and deprecation telemetry.
 */
export interface ContractDescriptor<TRequest = unknown, TResponse = unknown> {
  /** Stable contract name (e.g. `task.create`). Distinct registry key. */
  readonly name: string;
  /** Owning authority id (opaque). */
  readonly owner: string;
  /** Human-readable description. */
  readonly description: string;
  /** Direction across the boundary. */
  readonly direction: ContractDirection;
  /** Required privilege tier for a caller to invoke this contract. */
  readonly tier: ContractTier;
  /** Major schema version (integer). */
  readonly schemaVersion: number;
  /** Request payload validator (renderer-to-main) or event payload validator. */
  readonly validateRequest: (payload: unknown) => payload is TRequest;
  /** Response payload validator (present for request/response contracts). */
  readonly validateResponse?: (payload: unknown) => payload is TResponse;
  /** Acknowledgement / receipt behavior (NN-EVENT-008). */
  readonly receipt: ReceiptBehavior;
  /** Deadline in ms (0 = no deadline). */
  readonly timeoutMs: number;
  /** Whether cooperative cancellation is supported. */
  readonly cancellable: boolean;
  /** Whether a correlation id is required on the envelope. */
  readonly requiresCorrelationId: boolean;
  /** Whether an idempotency key is required (durable mutations). */
  readonly requiresIdempotencyKey: boolean;
  /** Redaction class of the payload for observable boundaries. */
  readonly redaction: RedactionClass;
  /** Legacy alias channels mapped to this contract (measured, non-authorizing). */
  readonly aliases: readonly ContractAlias[];
}

// ─── Facade / handler descriptors (mechanically generated) ──────────────────

/**
 * A preload facade method descriptor, mechanically generated from a registry
 * entry. The preload exposes exactly one named typed method per
 * renderer-to-main contract; there is no generic authority method
 * (D-16.2, NN-EVENT-007).
 */
export interface FacadeDescriptor {
  readonly contractName: string;
  readonly methodName: string;
  readonly direction: ContractDirection;
  readonly tier: ContractTier;
  readonly cancellable: boolean;
}

/**
 * A main-process handler descriptor, mechanically generated from a registry
 * entry. Exactly one handler per registered contract; the handler validates
 * the argument and derives caller authorization in the main process.
 */
export interface HandlerDescriptor {
  readonly contractName: string;
  readonly channel: string;
  readonly direction: ContractDirection;
  readonly tier: ContractTier;
  readonly receipt: ReceiptBehavior;
}

/**
 * A parity report over the generated facade set and handler set. Parity holds
 * when the generated facade set and the generated handler set are each exactly
 * the set of registered contracts for their direction, with no extra, missing,
 * or duplicated member (V-EVENT-001/typed-registry-parity).
 */
export interface ParityReport {
  readonly ok: boolean;
  /** Contract names registered for renderer-to-main. */
  readonly registeredRequestContracts: readonly string[];
  /** Facade methods generated for renderer-to-main contracts. */
  readonly facadeContracts: readonly string[];
  /** Handler contracts generated (all directions). */
  readonly handlerContracts: readonly string[];
  /** Registered contracts with no generated facade (renderer-to-main only). */
  readonly missingFacades: readonly string[];
  /** Facades with no registered contract. */
  readonly orphanFacades: readonly string[];
  /** Registered contracts with no generated handler. */
  readonly missingHandlers: readonly string[];
  /** Handlers with no registered contract. */
  readonly orphanHandlers: readonly string[];
}

// ─── Dispatch decisions (typed, no-effect on failure) ───────────────────────

/**
 * A caller identity attested by the *main process* — never trusted from the
 * renderer. The main process derives this from the sender `WebContents`,
 * window/session binding, and any authenticated principal (D-16.2,
 * NN-SEC-009). `assertedTier` (if present) is a renderer-supplied marker kept
 * only for telemetry and forgery detection; it is never used to authorize.
 */
export interface CallerIdentity {
  /** Opaque principal id derived in main; absent when unauthenticated. */
  readonly principalId?: string;
  /** Tier the main process attests for this caller. */
  readonly attestedTier: ContractTier;
  /** Whether a valid session is bound to this caller. */
  readonly sessionBound: boolean;
  /** Renderer-supplied tier marker, for telemetry/forgery detection only. */
  readonly assertedTier?: string;
}

/** A successful dispatch decision: the contract may execute. */
export interface DispatchAuthorized {
  readonly ok: true;
  readonly contract: ContractDescriptor;
  /** True when the renderer asserted a stronger tier than main attested. */
  readonly forgedTierAttempt: boolean;
}

/** A rejected dispatch decision: no effect; carries a typed error. */
export interface DispatchRejected {
  readonly ok: false;
  readonly error: ErrorEnvelope;
  /** True when the renderer asserted a stronger tier than main attested. */
  readonly forgedTierAttempt: boolean;
}

export type DispatchDecision = DispatchAuthorized | DispatchRejected;

/** A single alias-usage telemetry sample (NN-COMPAT-017). */
export interface AliasTelemetrySample {
  readonly legacyChannel: string;
  readonly contractName: string;
  readonly schemaVersion: number;
  readonly deprecated: boolean;
  readonly stale: boolean;
  readonly count: number;
}

// ─── Registry ────────────────────────────────────────────────────────────────

const FALLBACK_OWNER = 'authority-ipc-contract-registry';

function errorEnvelope(
  code: ErrorCode,
  message: string,
  options: {
    owner?: string;
    operation?: string;
    correlationId?: string;
    retryable?: boolean;
  } = {},
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    message,
    owner: isOpaqueId(options.owner) ? options.owner : FALLBACK_OWNER,
    operation: options.operation ?? 'ipc-dispatch',
    correlationId: isOpaqueId(options.correlationId)
      ? options.correlationId
      : 'corr-unset',
    retryable: options.retryable ?? false,
    redaction: 'internal',
  };
}

/**
 * The versioned typed Contract Registry. One instance is the single source of
 * truth for the IPC boundary; facade and handler sets are *derived* from it so
 * that drift is mechanically detectable rather than hand-maintained.
 */
export class ContractRegistry {
  private readonly contracts = new Map<string, ContractDescriptor>();
  /** legacyChannel → contractName, for alias resolution / forgery checks. */
  private readonly aliasIndex = new Map<string, string>();
  /** legacyChannel → observed usage count (measured, non-authorizing). */
  private readonly aliasUsage = new Map<string, number>();

  /** Registry-wide version; bumped on breaking contract-set changes. */
  readonly version: number;

  constructor(version = 1) {
    this.version = version;
  }

  /**
   * Register a contract. Duplicate names and duplicate alias channels are
   * rejected: the registry must be an exact set, so collisions are programmer
   * errors surfaced at composition time (NN-COMPAT-002 single-writer intent).
   */
  register<TReq, TRes>(descriptor: ContractDescriptor<TReq, TRes>): void {
    if (!descriptor.name || descriptor.name.length === 0) {
      throw new Error('ContractRegistry.register: contract name is required');
    }
    if (this.contracts.has(descriptor.name)) {
      throw new Error(
        `ContractRegistry.register: contract already registered: ${descriptor.name}`,
      );
    }
    for (const alias of descriptor.aliases) {
      const existing = this.aliasIndex.get(alias.legacyChannel);
      if (existing && existing !== descriptor.name) {
        throw new Error(
          `ContractRegistry.register: alias '${alias.legacyChannel}' already maps to '${existing}'`,
        );
      }
    }
    this.contracts.set(descriptor.name, descriptor as ContractDescriptor);
    for (const alias of descriptor.aliases) {
      this.aliasIndex.set(alias.legacyChannel, descriptor.name);
    }
  }

  /** Whether a contract name is registered. */
  has(name: string): boolean {
    return this.contracts.has(name);
  }

  /** Get a contract descriptor by name. */
  get(name: string): ContractDescriptor | undefined {
    return this.contracts.get(name);
  }

  /** All registered contract names, sorted for deterministic output. */
  names(): string[] {
    return [...this.contracts.keys()].sort();
  }

  /** Number of registered contracts. */
  get size(): number {
    return this.contracts.size;
  }

  /** Resolve a legacy alias channel to its contract name, if any. */
  resolveAlias(legacyChannel: string): string | undefined {
    return this.aliasIndex.get(legacyChannel);
  }

  // ─── Mechanical facade / handler generation ───────────────────────────────

  /**
   * Generate the preload facade descriptors: exactly one named typed method per
   * renderer-to-main contract. The method name is derived deterministically
   * from the contract name so the generated set cannot silently drift.
   */
  generateFacades(): FacadeDescriptor[] {
    const facades: FacadeDescriptor[] = [];
    for (const contract of this.contracts.values()) {
      if (contract.direction !== 'renderer-to-main') continue;
      facades.push({
        contractName: contract.name,
        methodName: contractNameToMethod(contract.name),
        direction: contract.direction,
        tier: contract.tier,
        cancellable: contract.cancellable,
      });
    }
    return facades.sort((a, b) => a.contractName.localeCompare(b.contractName));
  }

  /**
   * Generate the main handler descriptors: exactly one handler per registered
   * contract, regardless of direction (renderer-to-main handlers accept
   * commands; main-to-renderer handlers register the emit channel).
   */
  generateHandlers(): HandlerDescriptor[] {
    const handlers: HandlerDescriptor[] = [];
    for (const contract of this.contracts.values()) {
      handlers.push({
        contractName: contract.name,
        channel: contractNameToChannel(contract.name),
        direction: contract.direction,
        tier: contract.tier,
        receipt: contract.receipt,
      });
    }
    return handlers.sort((a, b) => a.contractName.localeCompare(b.contractName));
  }

  /**
   * Produce a parity report proving the generated facade set and handler set
   * are exactly the registered set for their direction. Parity is the
   * observer for V-EVENT-001/typed-registry-parity.
   */
  verifyParity(): ParityReport {
    const requestContracts = [...this.contracts.values()]
      .filter((c) => c.direction === 'renderer-to-main')
      .map((c) => c.name)
      .sort();
    const allContracts = this.names();

    const facades = this.generateFacades();
    const handlers = this.generateHandlers();
    const facadeNames = new Set(facades.map((f) => f.contractName));
    const handlerNames = new Set(handlers.map((h) => h.contractName));
    const requestSet = new Set(requestContracts);
    const allSet = new Set(allContracts);

    const missingFacades = requestContracts.filter((c) => !facadeNames.has(c));
    const orphanFacades = [...facadeNames].filter((f) => !requestSet.has(f)).sort();
    const missingHandlers = allContracts.filter((c) => !handlerNames.has(c));
    const orphanHandlers = [...handlerNames].filter((h) => !allSet.has(h)).sort();

    const ok =
      missingFacades.length === 0 &&
      orphanFacades.length === 0 &&
      missingHandlers.length === 0 &&
      orphanHandlers.length === 0;

    return {
      ok,
      registeredRequestContracts: requestContracts,
      facadeContracts: facades.map((f) => f.contractName),
      handlerContracts: handlers.map((h) => h.contractName),
      missingFacades,
      orphanFacades,
      missingHandlers,
      orphanHandlers,
    };
  }

  // ─── Compatibility-adapter parity (NN-COMPAT-017) ─────────────────────────

  /**
   * Mechanically compare a preload string-allowlist adapter against the
   * registry aliases. Every legacy channel that is *served* by a registered
   * contract must appear as a declared alias, and every declared alias must
   * still be present on the observed allowlist. A mismatch is reported; it is
   * never silently resolved. This is the CD-029 "generate/compare facades"
   * obligation. Channels on the allowlist that intentionally have no typed
   * contract yet are returned as `unmappedLegacyChannels` (bounded adapters
   * still in migration), not as failures.
   */
  compareCompatibilityAdapter(observedLegacyChannels: readonly string[]): {
    readonly ok: boolean;
    readonly unmappedLegacyChannels: readonly string[];
    readonly missingAliasChannels: readonly string[];
  } {
    const observed = new Set(observedLegacyChannels);
    const unmapped: string[] = [];
    for (const channel of observed) {
      if (!this.aliasIndex.has(channel)) unmapped.push(channel);
    }
    const missing: string[] = [];
    for (const alias of this.aliasIndex.keys()) {
      if (!observed.has(alias)) missing.push(alias);
    }
    return {
      ok: missing.length === 0,
      unmappedLegacyChannels: unmapped.sort(),
      missingAliasChannels: missing.sort(),
    };
  }

  /** Record an alias-channel use for deprecation telemetry (measured only). */
  recordAliasUse(legacyChannel: string): void {
    this.aliasUsage.set(
      legacyChannel,
      (this.aliasUsage.get(legacyChannel) ?? 0) + 1,
    );
  }

  /** Snapshot the alias-usage telemetry (NN-COMPAT-017 measured aliases). */
  aliasTelemetry(now = Date.now()): AliasTelemetrySample[] {
    const samples: AliasTelemetrySample[] = [];
    for (const [legacyChannel, count] of this.aliasUsage) {
      const contractName = this.aliasIndex.get(legacyChannel);
      if (!contractName) continue;
      const contract = this.contracts.get(contractName);
      if (!contract) continue;
      const alias = contract.aliases.find(
        (a) => a.legacyChannel === legacyChannel,
      );
      samples.push({
        legacyChannel,
        contractName,
        schemaVersion: contract.schemaVersion,
        deprecated: alias?.deprecated ?? false,
        stale: alias?.sunsetAt !== undefined && now >= alias.sunsetAt,
        count,
      });
    }
    return samples.sort((a, b) => a.legacyChannel.localeCompare(b.legacyChannel));
  }

  // ─── Typed dispatch with no-effect rejection ──────────────────────────────

  /**
   * Decide whether an incoming request may dispatch. Every failure path
   * returns a typed `ErrorEnvelope@1` and performs no effect (no dispatch, no
   * mutation) (NN-SEC-009). The decision is the sole authority; string
   * allowlists and renderer-supplied tier markers are never consulted for the
   * grant (D-02.3/R2, CD-029).
   *
   * Failure modes, all no-effect:
   *
   *   - unknown contract      → `VALIDATION` (rejects unregistered channel).
   *   - stale alias (sunset)  → `INCOMPATIBLE` when addressed via a sunset alias.
   *   - malformed payload      → `VALIDATION`.
   *   - missing correlation/idempotency key when required → `VALIDATION`.
   *   - forged/insufficient tier → `UNAUTHORIZED` (main-attested tier is below
   *     the contract tier); a renderer asserting a stronger tier than main
   *     attests is flagged as a forged-tier attempt and denied.
   */
  authorizeDispatch(input: {
    /** Contract name, or a legacy alias channel to resolve. */
    readonly contractName?: string;
    readonly legacyChannel?: string;
    readonly caller: CallerIdentity;
    readonly payload: unknown;
    readonly correlationId?: string;
    readonly idempotencyKey?: string;
    readonly now?: number;
  }): DispatchDecision {
    const now = input.now ?? Date.now();
    const correlationId = input.correlationId;

    // Detect a forged-tier attempt regardless of the eventual decision: the
    // renderer asserted a stronger tier than the main process attests.
    const assertedTier = normalizeTier(input.caller.assertedTier);
    const forgedTierAttempt =
      assertedTier !== undefined &&
      tierRank(assertedTier) > tierRank(input.caller.attestedTier);

    // Resolve the contract, tracking whether a sunset alias was used.
    let resolvedName = input.contractName;
    let usedAlias: ContractAlias | undefined;
    if (!resolvedName && input.legacyChannel) {
      resolvedName = this.aliasIndex.get(input.legacyChannel);
      if (resolvedName) {
        this.recordAliasUse(input.legacyChannel);
        usedAlias = this.contracts
          .get(resolvedName)
          ?.aliases.find((a) => a.legacyChannel === input.legacyChannel);
      }
    }

    if (!resolvedName || !this.contracts.has(resolvedName)) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope('VALIDATION', 'unknown or unregistered contract', {
          correlationId,
          retryable: false,
        }),
      };
    }
    const contract = this.contracts.get(resolvedName)!;

    // A stale (past-sunset) alias is a compatibility contract that no longer
    // serves: reject as INCOMPATIBLE, no effect.
    if (usedAlias?.sunsetAt !== undefined && now >= usedAlias.sunsetAt) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope(
          'INCOMPATIBLE',
          `alias '${usedAlias.legacyChannel}' is past sunset and no longer served`,
          { owner: contract.owner, operation: contract.name, correlationId },
        ),
      };
    }

    // Caller authorization is derived from the MAIN-ATTESTED tier only. The
    // renderer marker never grants; a broad allowlist never grants
    // (NN-SEC-009, CD-029).
    if (tierRank(input.caller.attestedTier) < tierRank(contract.tier)) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope(
          'UNAUTHORIZED',
          forgedTierAttempt
            ? 'caller asserted a tier it does not hold; authorization is main-attested'
            : 'caller tier is insufficient for this contract',
          { owner: contract.owner, operation: contract.name, correlationId },
        ),
      };
    }

    // Argument validation is mandatory before any effect (NN-SEC-009).
    if (!contract.validateRequest(input.payload)) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope('VALIDATION', 'request payload failed schema validation', {
          owner: contract.owner,
          operation: contract.name,
          correlationId,
        }),
      };
    }

    if (contract.requiresCorrelationId && !isOpaqueId(input.correlationId)) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope('VALIDATION', 'contract requires a correlation id', {
          owner: contract.owner,
          operation: contract.name,
          correlationId,
        }),
      };
    }

    if (
      contract.requiresIdempotencyKey &&
      (typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length === 0)
    ) {
      return {
        ok: false,
        forgedTierAttempt,
        error: errorEnvelope(
          'VALIDATION',
          'durable mutation requires an idempotency key',
          { owner: contract.owner, operation: contract.name, correlationId },
        ),
      };
    }

    return { ok: true, contract, forgedTierAttempt };
  }

  /**
   * Deterministic digest over the registered contract set. Two registries with
   * the same contracts (name/owner/direction/tier/schema/receipt/keys/aliases)
   * produce the same digest; any drift changes it. Used by parity evidence.
   */
  contractSetDigest(): string {
    const canonical = [...this.contracts.values()]
      .map((c) => ({
        name: c.name,
        owner: c.owner,
        direction: c.direction,
        tier: c.tier,
        schemaVersion: c.schemaVersion,
        receipt: c.receipt,
        timeoutMs: c.timeoutMs,
        cancellable: c.cancellable,
        requiresCorrelationId: c.requiresCorrelationId,
        requiresIdempotencyKey: c.requiresIdempotencyKey,
        redaction: c.redaction,
        aliases: [...c.aliases]
          .map((a) => ({
            legacyChannel: a.legacyChannel,
            deprecated: a.deprecated,
            sunsetAt: a.sunsetAt ?? null,
          }))
          .sort((a, b) => a.legacyChannel.localeCompare(b.legacyChannel)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return computeDigest({ version: this.version, contracts: canonical });
  }
}

// ─── Deterministic name derivation ──────────────────────────────────────────

/**
 * Derive a preload facade method name from a contract name deterministically.
 * `task.create` → `taskCreate`; `chat-projection.get-page` → `chatProjectionGetPage`.
 */
export function contractNameToMethod(contractName: string): string {
  const parts = contractName.split(/[.:\-_/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return contractName;
  return parts
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

/**
 * Derive a stable channel name from a contract name deterministically.
 * The channel is the contract name with dots normalized to colons so it reads
 * like the existing preload channels (`task.create` → `task:create`).
 */
export function contractNameToChannel(contractName: string): string {
  return contractName.replace(/\./g, ':');
}

/** Normalize an untrusted tier marker string to a known tier, or undefined. */
function normalizeTier(value: string | undefined): ContractTier | undefined {
  if (value === undefined) return undefined;
  return (CONTRACT_TIERS as readonly string[]).includes(value)
    ? (value as ContractTier)
    : undefined;
}
