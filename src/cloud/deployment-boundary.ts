/**
 * Cloud deployment boundary — environment-separated declarative deploy/rollback,
 * remote-agent kill controls, and website/admin non-regression
 * (FUT-PKG-08-OPTIONAL/T-004).
 *
 * NN-CLOUD-006 requires wrangler/build/deployment configuration to pin
 * dependencies, validate bundle limits / bindings / secrets, maintain
 * environment separation, and provide rollback — and REQUIRES explicit
 * authorization for a PRODUCTION deployment. NN-CLOUD-005 requires an always-on
 * remote/cloud agent to run isolated, enforce plan entitlement / cost / network
 * policy, and expose IMMEDIATE kill controls. NN-CLOUD-007 requires that adding
 * proxy/license/voice/certificate features NOT modify or break existing website
 * assets, service routes, middleware, admin pages, or owned KV shapes except
 * through explicit ADDITIVE versioned contracts.
 *
 * This module is DECLARATIVE and CONFIG-DRIVEN. It plans and authorizes
 * deployments and rollbacks; it performs NO actual deploy (it invokes no
 * wrangler, opens no network connection, mutates no live resource). A plan for
 * the `production` environment ALWAYS requires an explicit, matching
 * authorization token and FAILS CLOSED without one — an ordinary task
 * completion never deploys to production. It provides:
 *
 *   1. {@link planDeployment}: validate a {@link DeploymentPlan} against
 *      NN-CLOUD-006 (pinned deps, bundle limit, declared bindings/secrets,
 *      environment separation) and require production authorization. Returns a
 *      typed authorized plan or a typed fail-closed refusal.
 *   2. {@link planRollback}: a rollback targets an IMMUTABLE prior worker
 *      artifact/config and preserves the owner data contract; a rollback to an
 *      artifact that changes the owned data contract is refused.
 *   3. {@link RemoteAgentController}: immediate kill controls for an always-on
 *      remote agent (NN-CLOUD-005) — a kill is idempotent and, once killed, the
 *      agent admits no further action.
 *   4. {@link assertWebsiteAdminNonRegression}: adding a feature must be an
 *      ADDITIVE versioned change; modifying/removing an existing website asset,
 *      route, middleware, admin page, or owned KV shape is a typed regression
 *      refusal (NN-CLOUD-007).
 *
 * Design anchors: D-05, D-16, D-18, D-23, D-24.
 * Requirements: NN-CLOUD-005, NN-CLOUD-006, NN-CLOUD-007, NN-INV-001.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';
import { WORKER_IDS, type WorkerId, isWorkerId } from './worker-boundary.js';

const DEPLOY_OWNER = 'authority-cloud-deployment';

// ════════════════════════════════════════════════════════════════════════════
// 1. Environments and plan contract (NN-CLOUD-006)
// ════════════════════════════════════════════════════════════════════════════

/** The separated deployment environments (NN-CLOUD-006). */
export const ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production'] as const);
export type Environment = (typeof ENVIRONMENTS)[number];

/** Whether a value names a known environment. */
export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}

/** A pinned dependency (name + exact version). */
export interface PinnedDependency {
  readonly name: string;
  /** Exact pinned version — a range/`latest` is rejected. */
  readonly version: string;
}

/** A declarative deployment plan for a single worker + environment. */
export interface DeploymentPlan {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly worker: WorkerId;
  readonly environment: Environment;
  /** The immutable artifact identity to deploy (content-addressed/versioned). */
  readonly artifactId: string;
  /** Declared dependencies; all must be exact-pinned. */
  readonly dependencies: readonly PinnedDependency[];
  /** Bundle size in bytes; must be within the worker limit. */
  readonly bundleBytes: number;
  /** Declared binding names present in the deployment config. */
  readonly declaredBindings: readonly string[];
  /** Declared secret NAMES (never values). */
  readonly declaredSecretNames: readonly string[];
  readonly correlationId?: string;
}

/** The Cloudflare Worker bundle hard limit (post-compression), bytes. */
export const MAX_BUNDLE_BYTES = 1_000_000; // 1 MB (Workers free-tier ceiling)

/** An explicit production deployment authorization (NN-CLOUD-006). */
export interface ProductionAuthorization {
  /** Must match the plan's worker + environment + artifact exactly. */
  readonly worker: WorkerId;
  readonly environment: 'production';
  readonly artifactId: string;
  /** The authorizing operator principal (audited, masked). */
  readonly authorizedBy: string;
}

/** The outcome of planning a deployment. */
export type DeploymentDecision =
  | { readonly authorized: true; readonly plan: DeploymentPlan; readonly requiresAuthorization: boolean }
  | { readonly authorized: false; readonly error: ErrorEnvelope };

// ════════════════════════════════════════════════════════════════════════════
// 2. Typed errors
// ════════════════════════════════════════════════════════════════════════════

function deployError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: DEPLOY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Deployment planning (NN-CLOUD-006) — NEVER performs a deploy
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate and authorize a declarative deployment plan (NN-CLOUD-006). This
 * NEVER performs a deployment; it produces a typed decision. Checks, all fail
 * closed:
 *
 *   - real worker, current contract major, non-empty immutable artifact id;
 *   - every dependency is EXACT-pinned (a range/`latest`/empty version fails);
 *   - the bundle is within {@link MAX_BUNDLE_BYTES};
 *   - at least one binding is declared and no secret VALUE is present (only
 *     names) — a declared secret name that looks like a value is refused;
 *   - environment separation: a `production` plan REQUIRES a matching
 *     {@link ProductionAuthorization}; without one it is refused `UNAUTHORIZED`
 *     (an ordinary task never deploys to production, NN-CLOUD-006).
 *
 * A `dev`/`staging` plan does not require authorization but is still validated.
 */
export function planDeployment(
  value: unknown,
  authorization?: ProductionAuthorization,
): DeploymentDecision {
  const op = 'cloud.deployment.plan';
  const corr = (value as Partial<DeploymentPlan> | null)?.correlationId;

  if (value === null || typeof value !== 'object') {
    return { authorized: false, error: deployError('VALIDATION', 'deployment plan is not an object', op, corr) };
  }
  const plan = value as Partial<DeploymentPlan>;

  if (plan.schemaVersion !== CONTRACT_WRITE_VERSION) {
    return { authorized: false, error: deployError('INCOMPATIBLE', 'plan schema version is not the current major', op, corr) };
  }
  if (!isWorkerId(plan.worker)) {
    return { authorized: false, error: deployError('VALIDATION', 'plan names an unknown worker', op, corr) };
  }
  if (!isEnvironment(plan.environment)) {
    return { authorized: false, error: deployError('VALIDATION', 'plan names an unknown environment', op, corr) };
  }
  if (typeof plan.artifactId !== 'string' || plan.artifactId.trim() === '') {
    return { authorized: false, error: deployError('VALIDATION', 'plan is missing an immutable artifact id', op, corr) };
  }
  if (!Array.isArray(plan.dependencies)) {
    return { authorized: false, error: deployError('VALIDATION', 'plan dependencies must be an array', op, corr) };
  }
  for (const dep of plan.dependencies) {
    if (!dep || typeof dep.name !== 'string' || dep.name.trim() === '' || typeof dep.version !== 'string' || !isExactPinnedVersion(dep.version)) {
      return { authorized: false, error: deployError('VALIDATION', `dependency '${dep?.name ?? '?'}' is not exact-pinned`, op, corr) };
    }
  }
  if (typeof plan.bundleBytes !== 'number' || !Number.isInteger(plan.bundleBytes) || plan.bundleBytes <= 0) {
    return { authorized: false, error: deployError('VALIDATION', 'plan bundle size is invalid', op, corr) };
  }
  if (plan.bundleBytes > MAX_BUNDLE_BYTES) {
    return { authorized: false, error: deployError('VALIDATION', `bundle ${plan.bundleBytes} exceeds limit ${MAX_BUNDLE_BYTES}`, op, corr) };
  }
  if (!Array.isArray(plan.declaredBindings) || plan.declaredBindings.length === 0) {
    return { authorized: false, error: deployError('VALIDATION', 'plan declares no bindings', op, corr) };
  }
  if (!Array.isArray(plan.declaredSecretNames)) {
    return { authorized: false, error: deployError('VALIDATION', 'plan secret names must be an array', op, corr) };
  }
  for (const name of plan.declaredSecretNames) {
    if (typeof name !== 'string' || name.trim() === '' || looksLikeSecretValue(name)) {
      return { authorized: false, error: deployError('FORBIDDEN', 'a secret VALUE must never appear in a deployment plan; declare names only', op, corr) };
    }
  }

  const requiresAuthorization = plan.environment === 'production';
  if (requiresAuthorization) {
    if (
      !authorization ||
      authorization.environment !== 'production' ||
      authorization.worker !== plan.worker ||
      authorization.artifactId !== plan.artifactId ||
      typeof authorization.authorizedBy !== 'string' ||
      authorization.authorizedBy.trim() === ''
    ) {
      return {
        authorized: false,
        error: deployError('UNAUTHORIZED', 'production deployment requires an explicit matching authorization; refused', op, corr),
      };
    }
  }

  return { authorized: true, plan: value as DeploymentPlan, requiresAuthorization };
}

/** Whether a version string is an exact pin (no range operators / `latest`). */
export function isExactPinnedVersion(version: string): boolean {
  if (version.trim() === '' || version === 'latest' || version === '*') return false;
  // Reject range operators; require a concrete x.y.z-ish exact version.
  if (/[\^~><|]|\s|x|\*/i.test(version)) return false;
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

/** Heuristic: a "secret name" that actually carries a value-shaped token. */
function looksLikeSecretValue(name: string): boolean {
  // A real secret name is short and identifier-shaped. A value-shaped token is
  // long or contains non-identifier bytes.
  if (name.length > 64) return true;
  return !/^[A-Za-z0-9_.-]+$/.test(name);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Rollback planning (NN-CLOUD-006) — immutable artifact, owner data contract
// ════════════════════════════════════════════════════════════════════════════

/** A request to roll back to a prior immutable artifact/config. */
export interface RollbackPlanRequest {
  readonly worker: WorkerId;
  readonly environment: Environment;
  /** The immutable prior artifact to roll back to. */
  readonly targetArtifactId: string;
  /** The owner data-contract version currently live. */
  readonly currentDataContractVersion: number;
  /** The owner data-contract version the target artifact expects. */
  readonly targetDataContractVersion: number;
  readonly correlationId?: string;
}

/** The outcome of planning a rollback. */
export type RollbackDecision =
  | { readonly ok: true; readonly worker: WorkerId; readonly environment: Environment; readonly targetArtifactId: string }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * Plan a rollback to an immutable prior worker artifact/config (NN-CLOUD-006).
 * A rollback is refused if the target artifact would CHANGE the owner data
 * contract (a lower or higher contract version than the live one), because
 * rollback must preserve owner data contracts. A valid rollback targets the
 * SAME data-contract version and an immutable artifact id. Declarative only —
 * performs no deploy.
 */
export function planRollback(request: RollbackPlanRequest): RollbackDecision {
  const op = 'cloud.deployment.rollback';
  if (!isWorkerId(request.worker) || !isEnvironment(request.environment)) {
    return { ok: false, error: deployError('VALIDATION', 'rollback names an unknown worker/environment', op, request.correlationId) };
  }
  if (typeof request.targetArtifactId !== 'string' || request.targetArtifactId.trim() === '') {
    return { ok: false, error: deployError('VALIDATION', 'rollback target artifact id is missing', op, request.correlationId) };
  }
  if (request.targetDataContractVersion !== request.currentDataContractVersion) {
    return {
      ok: false,
      error: deployError(
        'CONFLICT',
        'rollback target changes the owner data contract; refused to preserve owner data contracts',
        op,
        request.correlationId,
      ),
    };
  }
  return { ok: true, worker: request.worker, environment: request.environment, targetArtifactId: request.targetArtifactId };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Remote-agent kill controls (NN-CLOUD-005)
// ════════════════════════════════════════════════════════════════════════════

/** An owned remote agent handle with an injected immediate-stop primitive. */
export interface OwnedRemoteAgent {
  readonly agentId: string;
  /** Immediate stop; returns true iff the agent is confirmed stopped. */
  readonly kill: () => boolean;
}

/** The result of a kill operation. */
export interface KillResult {
  readonly agentId: string;
  /** True iff the agent is confirmed stopped (now or already). */
  readonly killed: boolean;
  /** True iff this call performed the stop (false on an idempotent repeat). */
  readonly performed: boolean;
  readonly error?: ErrorEnvelope;
}

/**
 * Controller for always-on remote agents with IMMEDIATE kill controls
 * (NN-CLOUD-005). A killed agent admits no further action; kill is idempotent.
 * The controller owns every agent it registers.
 */
export class RemoteAgentController {
  private readonly agents = new Map<string, OwnedRemoteAgent>();
  private readonly killed = new Set<string>();

  /** Register an owned remote agent. */
  register(agent: OwnedRemoteAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  /** Whether an agent is currently registered and not killed. */
  isAlive(agentId: string): boolean {
    return this.agents.has(agentId) && !this.killed.has(agentId);
  }

  /**
   * Immediately kill an agent (NN-CLOUD-005). Idempotent: a repeat kill on an
   * already-killed agent reports `killed: true, performed: false`. A kill whose
   * injected stop returns false is a truthful `killed: false` with a typed
   * error (no false success). An unknown agent is a typed `VALIDATION`.
   */
  kill(agentId: string, correlationId?: string): KillResult {
    if (this.killed.has(agentId)) {
      return { agentId, killed: true, performed: false };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { agentId, killed: false, performed: false, error: deployError('VALIDATION', 'unknown remote agent', 'cloud.remote-agent.kill', correlationId) };
    }
    const stopped = agent.kill();
    if (!stopped) {
      return {
        agentId,
        killed: false,
        performed: false,
        error: deployError('UNAVAILABLE', 'remote agent did not confirm stop', 'cloud.remote-agent.kill', correlationId),
      };
    }
    this.killed.add(agentId);
    return { agentId, killed: true, performed: true };
  }

  /** Kill every owned agent; returns a truthful per-agent result set. */
  killAll(correlationId?: string): readonly KillResult[] {
    return [...this.agents.keys()].sort().map((id) => this.kill(id, correlationId));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Website/admin non-regression (NN-CLOUD-007)
// ════════════════════════════════════════════════════════════════════════════

/** The classes of existing website/admin asset protected by NN-CLOUD-007. */
export const WEBSITE_ASSET_KINDS = Object.freeze([
  'website-asset',
  'service-route',
  'middleware',
  'admin-page',
  'owned-kv-shape',
] as const);
export type WebsiteAssetKind = (typeof WEBSITE_ASSET_KINDS)[number];

/** A proposed change to an existing website/admin surface. */
export interface WebsiteChange {
  readonly kind: WebsiteAssetKind;
  /** The asset identity (route path, page id, KV namespace/shape id). */
  readonly assetId: string;
  /** The change operation. */
  readonly operation: 'add' | 'modify' | 'remove';
  /** For an `add`, whether it is an explicit ADDITIVE versioned contract. */
  readonly additiveVersioned?: boolean;
}

/** The verdict of a non-regression audit. */
export interface NonRegressionVerdict {
  readonly verdict: 'pass' | 'block';
  readonly violations: readonly WebsiteChange[];
  readonly error?: ErrorEnvelope;
}

/**
 * Audit proposed website/admin changes for non-regression (NN-CLOUD-007).
 * Adding a proxy/license/voice/certificate feature must NOT modify or remove an
 * existing website asset, service route, middleware, admin page, or owned KV
 * shape; only an explicit ADDITIVE versioned `add` is permitted. A `modify`/
 * `remove`, or an `add` that is not additive-versioned, is a typed regression
 * refusal (`CONFLICT`). Pure and read-only.
 */
export function assertWebsiteAdminNonRegression(
  changes: readonly WebsiteChange[],
  correlationId?: string,
): NonRegressionVerdict {
  const violations = changes.filter(
    (c) => c.operation !== 'add' || c.additiveVersioned !== true,
  );
  if (violations.length === 0) return { verdict: 'pass', violations: [] };
  return {
    verdict: 'block',
    violations,
    error: deployError(
      'CONFLICT',
      'website/admin non-regression violated: ' +
        violations.map((v) => `${v.operation} ${v.kind} ${v.assetId}`).join('; '),
      'cloud.website.non-regression',
      correlationId,
    ),
  };
}

/** The canonical set of workers, re-exported for deployment convenience. */
export { WORKER_IDS };
