/**
 * InferenceRouteCoordinator — Mandatory transport classification after
 * capability-aware logical provider selection.
 *
 * The coordinator composes three main-process authorities:
 *
 * 1. `ProviderRouteService` — capability/trust/locality/user-lock-aware
 *    logical selection of `(provider, model)` for a `ModelRole`.
 * 2. `EntitlementService` — request-time gate that revalidates the selected
 *    `(provider, model)` against the active edition's signed catalog.
 * 3. `ProxyCredentialService` (or a compatible status reader) — checks that
 *    the NeuroNest Proxy Credential is `available` before any cloud call.
 *
 * Behavior contract:
 *
 * - Logical selection is delegated. The coordinator never rewrites the
 *   capability/trust decision, and it never invents a provider or model.
 * - Transport classification is TOTAL over the closed
 *   `ProviderLocality` union and comes AFTER logical selection, keyed on
 *   the selected provider's registered locality:
 *     - `cloud`      → `neuronest-cloud-proxy`
 *     - `self-hosted`→ `local-provider`
 *     - `local`      → `local-provider`
 * - For a cloud transport, the coordinator ALWAYS runs entitlement preflight
 *   and confirms the Proxy Credential is available before returning a
 *   resolved route. Any auth, entitlement, quota, network, or proxy failure
 *   fails closed. A cloud request can never be answered by a direct-provider
 *   endpoint.
 * - Cloud fallback (`RoutingDecision.isFallback === true`) may change the
 *   logical provider/model but the resulting transport class is derived
 *   from the newly selected provider's locality, not from the fallback
 *   flag. Because the locality/transport mapping is closed and cloud
 *   always maps to `neuronest-cloud-proxy`, a cloud fallback cannot
 *   silently reach a direct-provider endpoint. Any transport class other
 *   than `neuronest-cloud-proxy` after the local-provider branch is
 *   rejected as a `cloud-fallback-transport-mismatch` — defense in depth
 *   against a future locality that has not yet been mapped, a new
 *   `TransportClass` variant, or a mocked route service.
 * - Local (or self-hosted) selections skip the proxy credential and
 *   entitlement gate. They retain their configured local adapter — a
 *   cloud request that falls back to a local provider stays local per
 *   Requirement 5.9.
 *
 * Requirements: 4.5, 5.1, 5.4, 5.7, 5.8, 6.5, 6.6, 6.7
 */

import type {
  AppEdition,
} from '../shared/app-bootstrap-contracts.js';
import type {
  EntitlementPreflightResult,
  EntitlementRejectionCode,
} from '../main/entitlement-service.js';
import type { ProxyCredentialStatusV1 } from '../shared/app-bootstrap-ipc-contracts.js';
import type { ProviderRouteService } from './provider-route-service.js';
import {
  TRANSPORT_CLASS_BY_PROVIDER_LOCALITY,
  type InferenceInvocationSource,
  type InferenceRoute,
  type ModelRole,
  type ProviderCapabilities,
  type ProviderLocality,
  type RoutingConstraints,
  type RoutingDecision,
  type TransportClass,
} from './types.js';

// ─── Coordinator inputs ─────────────────────────────────────────

/**
 * Everything the coordinator needs to classify a route.
 *
 * `constraints` reuses the existing `RoutingConstraints` shape so callers
 * do not need a parallel type. `constraints.role` is authoritative for the
 * model role; passing a distinct `modelRole` field would only invite drift.
 */
export interface InferenceRouteRequest {
  /** Capability/trust/locality inputs for logical provider selection. */
  readonly constraints: RoutingConstraints;
  /** Independent invocation category. Present for every request. */
  readonly invocationSource: InferenceInvocationSource;
  /** Whether the response is requested incrementally. */
  readonly streaming: boolean;
  /** Active commercial edition used for entitlement checks. */
  readonly edition: AppEdition;
  /** Optional caller correlation context; used to resolve user locks. */
  readonly context?: {
    readonly taskId?: string;
    readonly sessionId?: string;
  };
}

// ─── Failure classification ─────────────────────────────────────

/**
 * Reasons the coordinator can fail closed. Values are stable, allowlisted,
 * and free of private content so they can appear in typed diagnostics and
 * renderer-facing error messages.
 *
 * The union is intentionally exhaustive: every predictable coordinator
 * failure has a stable string identifier. Adding a new failure path must
 * add a value here so callers and error-mapping tables can enumerate it.
 */
export type InferenceRouteFailureCode =
  | 'no-provider-available'
  | 'proxy-credential-unavailable'
  | 'entitlement-rejected'
  | 'unregistered-provider'
  | 'cloud-fallback-transport-mismatch';

export interface InferenceRouteFailedClosed {
  readonly kind: 'failed-closed';
  readonly failureCode: InferenceRouteFailureCode;
  readonly explanation: string;
  readonly role: ModelRole;
  readonly invocationSource: InferenceInvocationSource;
  readonly edition: AppEdition;
  /**
   * The logical routing decision that led here, when one exists. Absent when
   * routing itself paused before choosing anything.
   */
  readonly decision?: RoutingDecision;
  /**
   * When the coordinator ran an entitlement preflight, its rejection code is
   * echoed here so callers can differentiate quota/entitlement conditions
   * without inspecting the entitlement snapshot directly.
   */
  readonly entitlementRejection?: EntitlementRejectionCode;
  /** Non-secret proxy credential status when a cloud request failed closed. */
  readonly proxyCredentialStatus?: ProxyCredentialStatusV1['status'];
}

export interface InferenceRouteResolved {
  readonly kind: 'resolved';
  readonly route: InferenceRoute;
  readonly decision: RoutingDecision;
  readonly selectedLocality: ProviderLocality;
}

export type InferenceRouteResolution =
  | InferenceRouteResolved
  | InferenceRouteFailedClosed;

// ─── Coordinator dependencies ───────────────────────────────────

/**
 * Narrow subset of `EntitlementService` used by the coordinator. Keeping the
 * dependency to a function preserves the entitlement service's revision and
 * catalog invariants; the coordinator does not read the raw snapshot.
 */
export interface EntitlementPreflightFn {
  (input: {
    edition: AppEdition;
    providerId: string;
    modelId: string;
  }): EntitlementPreflightResult;
}

/**
 * Narrow subset of `ProxyCredentialService`. The coordinator only observes
 * non-secret status. It never receives the credential value.
 */
export interface ProxyCredentialStatusReader {
  (): ProxyCredentialStatusV1 | undefined;
}

export interface InferenceRouteCoordinatorDependencies {
  readonly routeService: ProviderRouteService;
  readonly entitlementPreflight: EntitlementPreflightFn;
  readonly readProxyCredentialStatus: ProxyCredentialStatusReader;
  /**
   * Deterministic route-id factory. Only referenced when a route resolves.
   * Coordinator callers use the id for correlation and event routing; it is
   * not stored by the coordinator itself.
   */
  readonly createRouteId?: () => string;
}

// ─── Coordinator implementation ─────────────────────────────────

/**
 * A single coordinator instance for the main process. State is intentionally
 * minimal (just a monotonic counter for the default id factory); the
 * authoritative state lives in the composed services.
 */
export class InferenceRouteCoordinator {
  private readonly routeService: ProviderRouteService;
  private readonly entitlementPreflight: EntitlementPreflightFn;
  private readonly readProxyCredentialStatus: ProxyCredentialStatusReader;
  private readonly createRouteId: () => string;
  private routeCounter = 0;

  constructor(dependencies: InferenceRouteCoordinatorDependencies) {
    this.routeService = dependencies.routeService;
    this.entitlementPreflight = dependencies.entitlementPreflight;
    this.readProxyCredentialStatus = dependencies.readProxyCredentialStatus;
    this.createRouteId = dependencies.createRouteId ?? (() => this.defaultRouteId());
  }

  /**
   * Resolve a fully classified route.
   *
   * The method NEVER throws for auth, entitlement, quota, network, or proxy
   * conditions. Every predictable failure returns a `failed-closed` result
   * that upstream code must handle explicitly.
   */
  resolveRoute(request: InferenceRouteRequest): InferenceRouteResolution {
    const {
      constraints,
      invocationSource,
      streaming,
      edition,
      context,
    } = request;

    // 1. Delegate logical provider/model selection to the capability-aware
    //    ProviderRouteService. It applies user locks, health, cost, latency,
    //    trust, locality constraints, and pre-approved fallback chains.
    const decision = this.routeService.selectProvider(constraints, context);

    if (decision.paused) {
      return {
        kind: 'failed-closed',
        failureCode: 'no-provider-available',
        explanation:
          decision.pauseReason ??
          `No provider available for role '${constraints.role}'`,
        role: constraints.role,
        invocationSource,
        edition,
        decision,
      };
    }

    // 2. Resolve the selected provider's registered locality. The registry
    //    (not the RoutingDecision alone) is the source of truth for locality
    //    because logical selection is capability-scored, not locality-typed.
    const selectedProvider = this.findRegisteredProvider(
      decision.providerId,
      decision.modelId,
    );
    if (!selectedProvider) {
      return {
        kind: 'failed-closed',
        failureCode: 'unregistered-provider',
        explanation:
          `Routing selected provider '${decision.providerId}/${decision.modelId}' ` +
          'which is not registered; cannot classify transport.',
        role: constraints.role,
        invocationSource,
        edition,
        decision,
      };
    }

    const selectedLocality = selectedProvider.locality;
    const transportClass = classifyTransport(selectedLocality);

    // 3. Local and self-hosted providers use their configured local adapter.
    //    No proxy credential, no entitlement catalog check.
    if (transportClass === 'local-provider') {
      return this.resolved({
        transportClass,
        selectedProvider,
        decision,
        constraints,
        invocationSource,
        streaming,
        edition,
        selectedLocality,
        entitlementRevision: 0,
      });
    }

    // 4. Everything past the local-provider branch must be the cloud
    //    proxy transport. The closed `ProviderLocality`/`TransportClass`
    //    mapping guarantees this today, so this guard is defense in depth
    //    against three failure modes:
    //      - a future `ProviderLocality` value that is not yet routed by
    //        `TRANSPORT_CLASS_BY_PROVIDER_LOCALITY` (map lookup returns
    //        `undefined` at runtime even though the type says otherwise),
    //      - a future `TransportClass` variant introduced without being
    //        wired here, and
    //      - a hostile or mocked `ProviderRouteService` that returns a
    //        capability row with an unrecognized locality.
    //    In every case a cloud request MUST refuse rather than route
    //    traffic through an unclassified transport. This also enforces
    //    Requirement 5.7: cloud fallback may change the logical
    //    provider/model but cannot switch away from proxy transport, and
    //    Requirement 4.5: no auth/entitlement/quota/network/proxy
    //    condition can cause direct-provider transport selection.
    if (transportClass !== 'neuronest-cloud-proxy') {
      return {
        kind: 'failed-closed',
        failureCode: 'cloud-fallback-transport-mismatch',
        explanation:
          `Selected provider '${decision.providerId}/${decision.modelId}' ` +
          'produced an unrecognized transport class; refusing to route a ' +
          'cloud request without a validated NeuroNest proxy transport.',
        role: constraints.role,
        invocationSource,
        edition,
        decision,
      };
    }

    // 5. Entitlement preflight. The entitlement service revalidates the
    //    (provider, model) pair against the active edition's catalog. It
    //    also checks proxy credential status when configured so we surface
    //    an accurate rejection code.
    const preflight = this.entitlementPreflight({
      edition,
      providerId: decision.providerId,
      modelId: decision.modelId,
    });

    if (!preflight.allowed) {
      const failedClosed: InferenceRouteFailedClosed = {
        kind: 'failed-closed',
        failureCode:
          preflight.code === 'proxy_credential_unavailable'
            ? 'proxy-credential-unavailable'
            : 'entitlement-rejected',
        explanation: preflight.explanation,
        role: constraints.role,
        invocationSource,
        edition,
        decision,
        entitlementRejection: preflight.code,
      };
      // Attach proxy status when relevant so diagnostics can distinguish
      // "credential missing" from "catalog stale".
      const proxyStatus = this.readProxyCredentialStatus()?.status;
      if (proxyStatus !== undefined) {
        return { ...failedClosed, proxyCredentialStatus: proxyStatus };
      }
      return failedClosed;
    }

    // 6. Even when preflight passed (which may not have observed credential
    //    state) the coordinator MUST confirm the proxy credential itself is
    //    available before returning. This is defense in depth: entitlement
    //    services and credential services can advance independently, and a
    //    cloud request must never begin without a usable credential.
    const proxyStatus = this.readProxyCredentialStatus();
    if (!proxyStatus || proxyStatus.status !== 'available') {
      return {
        kind: 'failed-closed',
        failureCode: 'proxy-credential-unavailable',
        explanation:
          'NeuroNest cloud access is unavailable. Restore authentication and try again.',
        role: constraints.role,
        invocationSource,
        edition,
        decision,
        proxyCredentialStatus: proxyStatus?.status,
      };
    }

    return this.resolved({
      transportClass,
      selectedProvider,
      decision,
      constraints,
      invocationSource,
      streaming,
      edition,
      selectedLocality,
      entitlementRevision: preflight.entitlementRevision,
    });
  }

  // ─── internals ────────────────────────────────────────────────

  private resolved(input: {
    transportClass: TransportClass;
    selectedProvider: ProviderCapabilities;
    decision: RoutingDecision;
    constraints: RoutingConstraints;
    invocationSource: InferenceInvocationSource;
    streaming: boolean;
    edition: AppEdition;
    selectedLocality: ProviderLocality;
    entitlementRevision: number;
  }): InferenceRouteResolved {
    const route: InferenceRoute = {
      routeId: this.createRouteId(),
      transportClass: input.transportClass,
      selectedProvider: input.selectedProvider.providerId,
      selectedModel: input.selectedProvider.modelId,
      modelRole: input.constraints.role,
      invocationSource: input.invocationSource,
      streaming: input.streaming,
      edition: input.edition,
      entitlementRevision: input.entitlementRevision,
    };
    return {
      kind: 'resolved',
      route,
      decision: input.decision,
      selectedLocality: input.selectedLocality,
    };
  }

  private findRegisteredProvider(
    providerId: string,
    modelId: string,
  ): ProviderCapabilities | undefined {
    for (const provider of this.routeService.getRegisteredProviders()) {
      if (provider.providerId === providerId && provider.modelId === modelId) {
        return provider;
      }
    }
    return undefined;
  }

  private defaultRouteId(): string {
    this.routeCounter += 1;
    return `route-${Date.now().toString(36)}-${this.routeCounter}`;
  }
}

/**
 * Total classifier over the closed `ProviderLocality` union. Exported for
 * tests that verify totality and for callers that already know the locality.
 */
export function classifyTransport(locality: ProviderLocality): TransportClass {
  return TRANSPORT_CLASS_BY_PROVIDER_LOCALITY[locality];
}
