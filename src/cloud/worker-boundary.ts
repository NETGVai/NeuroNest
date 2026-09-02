/**
 * Cloud worker service boundaries — independently deployable workers with
 * explicit routes/bindings/owners/auth/limits/compatibility and typed
 * least-privilege storage (FUT-PKG-08-OPTIONAL/T-004).
 *
 * The Cloud Service Authority owns the DECLARATIVE truth about the four
 * independently deployable Cloudflare workers — the LLM proxy, the
 * website/admin surface, the Stripe payment worker, and the certificate worker
 * (NN-CLOUD-001, NN-PROXY-015). This module is the boundary registry and its
 * verifiers; it is pure and side-effect free (it opens no socket, spawns no
 * process, reads no secret). It has three jobs:
 *
 *   1. Boundary declaration ({@link WorkerBoundaryManifest},
 *      {@link validateWorkerBoundary}): every worker SHALL declare its routes,
 *      storage/service bindings, data ownership, authentication mode, resource
 *      limits, a stable deployment identity, and a compatibility version
 *      (NN-CLOUD-001). A manifest missing any of these, or declaring a route it
 *      does not own, is a typed `VALIDATION` failure — it is never registered.
 *
 *   2. No cross-source import / no binding escalation
 *      ({@link assertNoCrossSourceImport}, {@link resolveBindingAccess}):
 *      worker source trees SHALL NOT import each other (NN-CLOUD-001,
 *      NN-PROXY-015); a declared cross-worker binding is ADDITIVE and READ-ONLY
 *      unless the owning worker explicitly delegates a write contract
 *      (NN-CLOUD-002). A request to write a binding the owner has not delegated
 *      a write to is a typed `FORBIDDEN` escalation and is refused. A source
 *      import edge that crosses a worker boundary is a typed `FORBIDDEN`
 *      architecture violation.
 *
 *   3. Least-privilege storage access ({@link StorageBinding},
 *      {@link resolveBindingAccess}): KV/D1/R2/Queue bindings are accessed
 *      through typed owner-defined descriptors with an explicit access mode;
 *      access is granted only for a capability the binding's grant permits, and
 *      the default is the narrowest (read) grant (NN-CLOUD-002).
 *
 * The workers themselves deploy independently (each has its own manifest and
 * deployment identity); this registry proves the ISOLATION properties the
 * deployment relies on without coupling the workers' source. Runtime workflow
 * behavior (idempotency/retry/dead-letter/cancel) lives in
 * {@link ./cloud-workflows}; deployment/rollback lives in
 * {@link ./deployment-boundary}.
 *
 * Design anchors: D-03 (trust boundaries / canonical ownership), D-05
 * (component responsibilities), D-16 (security), D-18 (integration boundary),
 * D-23 (packaging), D-24 (dual-writer / ownership risk).
 * Requirements: NN-CLOUD-001, NN-CLOUD-002, NN-CLOUD-007, NN-PROXY-015,
 * NN-SEC-011, NN-INV-008.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. Worker identities and owners
// ════════════════════════════════════════════════════════════════════════════

/**
 * The four independently deployable workers (NN-PROXY-015). Each is a separate
 * source tree, deployment identity, and owner; none imports another's source.
 */
export const WORKER_IDS = Object.freeze([
  'proxy-worker',
  'website-admin-worker',
  'payment-worker',
  'certificate-worker',
] as const);
export type WorkerId = (typeof WORKER_IDS)[number];

/** Whether a value names one of the four canonical workers. */
export function isWorkerId(value: unknown): value is WorkerId {
  return typeof value === 'string' && (WORKER_IDS as readonly string[]).includes(value);
}

/** The authentication mode a worker route enforces (NN-CLOUD-001). */
export const AUTH_MODES = Object.freeze([
  'session-jwt', // authenticated session principal (auth.neuronest.cc)
  'proxy-credential', // NN_-shaped proxy bearer principal
  'stripe-signature', // verified Stripe webhook signature
  'admin-least-privilege', // authenticated least-privilege operator API
  'public-readonly', // unauthenticated read-only (e.g. health, static asset)
] as const);
export type AuthMode = (typeof AUTH_MODES)[number];

/** The storage binding kinds a worker may declare (NN-CLOUD-002). */
export const STORAGE_KINDS = Object.freeze(['kv', 'd1', 'r2', 'queue'] as const);
export type StorageKind = (typeof STORAGE_KINDS)[number];

/** The least-privilege access mode of a storage binding (NN-CLOUD-002). */
export const ACCESS_MODES = Object.freeze(['read', 'read-write'] as const);
export type AccessMode = (typeof ACCESS_MODES)[number];

const AUTHORITY_OWNER = 'authority-cloud-service';

// ════════════════════════════════════════════════════════════════════════════
// 2. Declarative manifests (NN-CLOUD-001, NN-CLOUD-002)
// ════════════════════════════════════════════════════════════════════════════

/** A declared route the worker owns and serves. */
export interface WorkerRoute {
  /** The route pattern (e.g. `/v1/chat/completions`). Owned by this worker. */
  readonly pattern: string;
  /** The authentication mode enforced at this route. */
  readonly auth: AuthMode;
  /** Whether this route performs a mutating/side-effecting operation. */
  readonly mutating: boolean;
}

/**
 * A typed least-privilege storage binding (NN-CLOUD-002). The `ownerWorker` is
 * the single durable writer of the class (NN-INV-008). A binding accessed by a
 * DIFFERENT worker is additive and read-only unless `writeDelegatedTo` names
 * that worker — the owner's explicit write delegation.
 */
export interface StorageBinding {
  /** Binding name as referenced in the worker (e.g. `PROXY_USAGE_KV`). */
  readonly name: string;
  readonly kind: StorageKind;
  /** The durable state class this binding owns (single-writer key). */
  readonly stateClass: string;
  /** The worker that owns (and is the sole writer of) this class. */
  readonly ownerWorker: WorkerId;
  /** The access this binding grants to its OWNER worker. */
  readonly ownerAccess: AccessMode;
  /**
   * Workers (other than the owner) to whom the owner explicitly delegates a
   * WRITE contract. Absent/empty means every non-owner is read-only additive.
   */
  readonly writeDelegatedTo?: readonly WorkerId[];
}

/** Declared resource limits for a worker (NN-CLOUD-001). */
export interface WorkerLimits {
  /** Max request body bytes accepted. */
  readonly maxRequestBytes: number;
  /** Max CPU milliseconds per request. */
  readonly maxCpuMs: number;
  /** Max concurrent subrequests. */
  readonly maxSubrequests: number;
}

/**
 * A worker's full declarative boundary (NN-CLOUD-001): routes, bindings, data
 * ownership, auth, limits, a stable deployment identity, and a compatibility
 * version. This is the ONLY truth the deployment and isolation checks consult.
 */
export interface WorkerBoundaryManifest {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly worker: WorkerId;
  /** Stable deployment identity (immutable artifact/service name). */
  readonly deploymentIdentity: string;
  /** Monotonic compatibility version for the worker's public contract. */
  readonly compatibilityVersion: number;
  readonly routes: readonly WorkerRoute[];
  readonly bindings: readonly StorageBinding[];
  readonly limits: WorkerLimits;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Typed errors
// ════════════════════════════════════════════════════════════════════════════

function boundaryError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    redaction: 'internal',
  };
}

/** The outcome of validating an untrusted worker manifest. */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: WorkerBoundaryManifest }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ════════════════════════════════════════════════════════════════════════════
// 4. Manifest validation (NN-CLOUD-001)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a worker boundary manifest against NN-CLOUD-001: it must name a real
 * worker, carry the current contract major, declare a non-empty deployment
 * identity, a non-negative compatibility version, at least one owned route with
 * a recognized auth mode, coherent least-privilege bindings (a binding owned by
 * this worker grants it the declared access; a write delegation only to real
 * workers), and positive resource limits. Any gap is a deterministic typed
 * `VALIDATION`/`INCOMPATIBLE` rejection with NO registration and no side effect
 * (NN-INV-011). Fail closed.
 */
export function validateWorkerBoundary(
  value: unknown,
  correlationId?: string,
): ManifestValidation {
  const op = 'cloud.worker-boundary.validate';
  if (value === null || typeof value !== 'object') {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest is not an object', op, correlationId) };
  }
  const m = value as Partial<WorkerBoundaryManifest>;

  if (m.schemaVersion !== CONTRACT_WRITE_VERSION) {
    return {
      ok: false,
      error: boundaryError('INCOMPATIBLE', 'manifest schema version is not the current major', op, correlationId),
    };
  }
  if (!isWorkerId(m.worker)) {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest names an unknown worker', op, correlationId) };
  }
  if (typeof m.deploymentIdentity !== 'string' || m.deploymentIdentity.trim() === '') {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest is missing a deployment identity', op, correlationId) };
  }
  if (
    typeof m.compatibilityVersion !== 'number' ||
    !Number.isInteger(m.compatibilityVersion) ||
    m.compatibilityVersion < 1
  ) {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest compatibility version must be a positive integer', op, correlationId) };
  }
  if (!Array.isArray(m.routes) || m.routes.length === 0) {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest declares no owned routes', op, correlationId) };
  }
  for (const r of m.routes) {
    if (
      !r ||
      typeof r.pattern !== 'string' ||
      r.pattern.trim() === '' ||
      !(AUTH_MODES as readonly string[]).includes(r.auth) ||
      typeof r.mutating !== 'boolean'
    ) {
      return { ok: false, error: boundaryError('VALIDATION', 'manifest declares a malformed route', op, correlationId) };
    }
  }
  if (!Array.isArray(m.bindings)) {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest bindings must be an array', op, correlationId) };
  }
  for (const b of m.bindings) {
    if (
      !b ||
      typeof b.name !== 'string' ||
      b.name.trim() === '' ||
      !(STORAGE_KINDS as readonly string[]).includes(b.kind) ||
      typeof b.stateClass !== 'string' ||
      b.stateClass.trim() === '' ||
      !isWorkerId(b.ownerWorker) ||
      !(ACCESS_MODES as readonly string[]).includes(b.ownerAccess)
    ) {
      return { ok: false, error: boundaryError('VALIDATION', 'manifest declares a malformed storage binding', op, correlationId) };
    }
    if (b.writeDelegatedTo !== undefined) {
      if (!Array.isArray(b.writeDelegatedTo) || b.writeDelegatedTo.some((w: unknown) => !isWorkerId(w))) {
        return { ok: false, error: boundaryError('VALIDATION', 'manifest write delegation names an unknown worker', op, correlationId) };
      }
    }
  }
  const limits = m.limits;
  if (
    !limits ||
    !Number.isInteger(limits.maxRequestBytes) ||
    limits.maxRequestBytes <= 0 ||
    !Number.isInteger(limits.maxCpuMs) ||
    limits.maxCpuMs <= 0 ||
    !Number.isInteger(limits.maxSubrequests) ||
    limits.maxSubrequests < 0
  ) {
    return { ok: false, error: boundaryError('VALIDATION', 'manifest declares invalid resource limits', op, correlationId) };
  }

  return { ok: true, manifest: value as WorkerBoundaryManifest };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. No cross-source import (NN-CLOUD-001, NN-PROXY-015)
// ════════════════════════════════════════════════════════════════════════════

/** A source import edge: `fromWorker` imports a module owned by `toWorker`. */
export interface SourceImportEdge {
  readonly fromWorker: WorkerId;
  /** The worker whose source tree the imported module belongs to. */
  readonly toWorker: WorkerId;
  /** The imported module reference (for the error message; non-secret). */
  readonly moduleRef: string;
}

/** The verdict of a cross-source import audit. */
export interface ImportAuditVerdict {
  readonly verdict: 'pass' | 'block';
  /** The offending cross-boundary edges (empty on pass). */
  readonly violations: readonly SourceImportEdge[];
  readonly error?: ErrorEnvelope;
}

/**
 * Audit source import edges and refuse any edge that crosses a worker boundary
 * (NN-CLOUD-001, NN-PROXY-015: worker source trees SHALL NOT import each
 * other). An intra-worker edge (`fromWorker === toWorker`) is allowed; any edge
 * where a worker imports another worker's source is a typed `FORBIDDEN`
 * architecture violation forcing `block`. Pure and read-only.
 */
export function assertNoCrossSourceImport(
  edges: readonly SourceImportEdge[],
  correlationId?: string,
): ImportAuditVerdict {
  const violations = edges.filter((e) => e.fromWorker !== e.toWorker);
  if (violations.length === 0) return { verdict: 'pass', violations: [] };
  return {
    verdict: 'block',
    violations,
    error: boundaryError(
      'FORBIDDEN',
      'cross-worker source import(s) detected: ' +
        violations.map((v) => `${v.fromWorker} -> ${v.toWorker} (${v.moduleRef})`).join('; '),
      'cloud.worker-boundary.no-cross-source-import',
      correlationId,
    ),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Least-privilege binding access (NN-CLOUD-002)
// ════════════════════════════════════════════════════════════════════════════

/** A request by a worker to access a storage binding at a given capability. */
export interface BindingAccessRequest {
  /** The binding whose access is requested (from the OWNER's manifest). */
  readonly binding: StorageBinding;
  /** The worker requesting access. */
  readonly requester: WorkerId;
  /** The capability requested. */
  readonly capability: AccessMode;
  readonly correlationId?: string;
}

/** The outcome of a binding-access decision. */
export type BindingAccessDecision =
  | { readonly granted: true; readonly effectiveAccess: AccessMode }
  | { readonly granted: false; readonly error: ErrorEnvelope };

/**
 * Decide a least-privilege binding access request (NN-CLOUD-002). Rules, all
 * fail closed:
 *
 *   - The OWNER worker gets exactly its declared `ownerAccess` (never more): a
 *     read-only owner requesting write is refused `FORBIDDEN`.
 *   - A NON-owner worker gets `read` by default (additive read-only). A
 *     non-owner requesting `read-write` is granted ONLY if the owner explicitly
 *     delegated a write to it via `writeDelegatedTo`; otherwise it is a typed
 *     `FORBIDDEN` binding escalation.
 *
 * No cross-source import or binding escalation ever grants more than the owner
 * declared. Pure and side-effect free.
 */
export function resolveBindingAccess(request: BindingAccessRequest): BindingAccessDecision {
  const { binding, requester, capability, correlationId } = request;
  const op = 'cloud.worker-boundary.binding-access';

  if (requester === binding.ownerWorker) {
    // Owner: capped at declared owner access.
    if (capability === 'read-write' && binding.ownerAccess !== 'read-write') {
      return {
        granted: false,
        error: boundaryError('FORBIDDEN', 'owner binding grants read-only; write is not permitted', op, correlationId),
      };
    }
    return { granted: true, effectiveAccess: capability };
  }

  // Non-owner: additive read-only unless a write is explicitly delegated.
  if (capability === 'read') {
    return { granted: true, effectiveAccess: 'read' };
  }
  const delegated = binding.writeDelegatedTo ?? [];
  if (delegated.includes(requester)) {
    return { granted: true, effectiveAccess: 'read-write' };
  }
  return {
    granted: false,
    error: boundaryError(
      'FORBIDDEN',
      `worker '${requester}' is not delegated write access to '${binding.stateClass}' owned by '${binding.ownerWorker}'`,
      op,
      correlationId,
    ),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Boundary registry
// ════════════════════════════════════════════════════════════════════════════

/**
 * The Cloud Service Authority's boundary registry. It holds only VALIDATED
 * manifests and proves the single-writer invariant across every registered
 * binding (NN-INV-008): two workers cannot both own (write) the same state
 * class. Registration is additive; the registry holds no durable business
 * state (rollback-safe).
 */
export class WorkerBoundaryRegistry {
  private readonly manifests = new Map<WorkerId, WorkerBoundaryManifest>();

  /**
   * Register a validated manifest. An invalid manifest, or one that introduces
   * a second writer for a state class already owned by a different worker, is
   * refused (typed error) with no registration.
   */
  register(value: unknown, correlationId?: string): ManifestValidation {
    const validation = validateWorkerBoundary(value, correlationId);
    if (!validation.ok) return validation;
    const manifest = validation.manifest;

    // Single-writer invariant across all registered bindings (NN-INV-008).
    for (const binding of manifest.bindings) {
      const existing = this.ownerOfClass(binding.stateClass);
      if (existing !== undefined && existing !== binding.ownerWorker) {
        return {
          ok: false,
          error: boundaryError(
            'CONFLICT',
            `state class '${binding.stateClass}' is already owned by '${existing}'; a second owner is refused`,
            'cloud.worker-boundary.register',
            correlationId,
          ),
        };
      }
    }

    this.manifests.set(manifest.worker, manifest);
    return { ok: true, manifest };
  }

  /** The registered manifest for a worker, if any. */
  get(worker: WorkerId): WorkerBoundaryManifest | undefined {
    return this.manifests.get(worker);
  }

  /** All registered workers (sorted, deterministic). */
  workers(): WorkerId[] {
    return [...this.manifests.keys()].sort();
  }

  /** The worker that owns (writes) a state class across registered manifests. */
  ownerOfClass(stateClass: string): WorkerId | undefined {
    for (const manifest of this.manifests.values()) {
      for (const binding of manifest.bindings) {
        if (binding.stateClass === stateClass && binding.ownerWorker === manifest.worker) {
          return manifest.worker;
        }
      }
    }
    return undefined;
  }
}
