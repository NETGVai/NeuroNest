/**
 * CoordinatedInferenceClient — the single canonical entry point for every
 * production inference caller.
 *
 * Callers (chat, agent, tool-assisted, background, retry, autocomplete,
 * planning, code editing, change application, embedding, reranking, review,
 * and summarization) invoke `resolveClient()` and receive a fully wired
 * `LLMProviderAdapter` (existing provider-registry shape) plus route
 * metadata for logical provider/model attribution and diagnostics.
 *
 * The client composes:
 *
 *   1. `InferenceRouteCoordinator` — capability/trust logical selection and
 *      exhaustive transport classification (cloud → `neuronest-cloud-proxy`,
 *      self-hosted/local → `local-provider`). Also fails closed on auth,
 *      entitlement, quota, and credential preflight issues.
 *   2. `LLMProxyTransport` + `createLLMProxyAdapter` — the sole cloud-capable
 *      HTTP transport for NeuroNest inference. Constructed on demand for a
 *      resolved cloud route; direct-provider clients are never constructed.
 *   3. A caller-supplied `LocalAdapterFactory` — returns the existing local
 *      adapter (Ollama / llama.cpp / OpenMythos) with its configured local
 *      endpoint. The coordinated client never rewrites those endpoints.
 *
 * Design invariants (Requirements 4.5, 5.1, 5.2, 5.4, 5.7, 5.8, 8.8, 15.10):
 *
 *  - A cloud selection ALWAYS produces a proxy-backed adapter. There is no
 *    code path that returns a direct-cloud client. Preflight failures
 *    surface as typed `CoordinatedInferenceFailure` values.
 *  - A local selection ALWAYS produces the caller's registered local
 *    adapter. No Proxy Credential is resolved or attached.
 *  - The client never carries or logs credential values. The proxy
 *    credential is resolved by `LLMProxyTransport` immediately before each
 *    HTTP operation via the provided `ProxyCredentialBoundary`.
 *  - Logical provider/model attribution is preserved through the returned
 *    `InferenceRoute` object even when a cloud fallback rewrites the
 *    selection. The transport class is authoritative for routing; the
 *    logical fields drive UI attribution and diagnostics.
 *  - Adding a new `ModelRole` or `InferenceInvocationSource` is a compile-
 *    time change (the closed unions on the coordinator inputs). This client
 *    is total over both.
 *
 * Requirements: 4.5, 5.1, 5.2, 5.4, 5.7, 8.8, 15.10
 */

import type { LLMProviderAdapter } from '../providers/provider-registry.js';
import {
  createLLMProxyAdapter,
  type LLMProxyAdapterRequestContext,
} from '../providers/llm-proxy-adapter.js';
import type {
  LLMProxyTransport,
  ProxyCredentialBoundary,
} from '../providers/llm-proxy-transport.js';
import { LLMProxyTransport as LLMProxyTransportCtor } from '../providers/llm-proxy-transport.js';
import {
  classifyCoordinatorFailure,
  type ClassifiedProxyError,
  type ProxyErrorRequestContext,
} from '../providers/proxy-error-classifier.js';
import type { ProxyCapabilityMetadataV1 } from './proxy-contracts.js';
import type {
  InferenceRouteCoordinator,
  InferenceRouteFailedClosed,
  InferenceRouteRequest,
  InferenceRouteResolved,
} from './inference-route-coordinator.js';
import type {
  InferenceRoute,
  ProviderLocality,
  RoutingDecision,
  TransportClass,
} from './types.js';

// ─── Local-adapter factory contract ────────────────────────────

/**
 * A caller supplies a factory that returns the registered local adapter for
 * a resolved local/self-hosted provider. Keeping the factory injectable
 * lets the coordinated client stay independent of any specific local
 * provider registry (Ollama manager, llama.cpp manager, OpenMythos manager,
 * or a test double).
 *
 * Returning `null` is treated as a failed-closed situation: local providers
 * that appear in the route service's capability catalog must have a working
 * adapter, and the client will not silently fall back to another transport.
 */
export interface LocalAdapterFactoryInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly locality: Extract<ProviderLocality, 'local' | 'self-hosted'>;
  readonly modelRole: InferenceRoute['modelRole'];
  readonly invocationSource: InferenceRoute['invocationSource'];
}

export type LocalAdapterFactory = (
  input: LocalAdapterFactoryInput,
) => LLMProviderAdapter | null;

// ─── Cloud transport binding ───────────────────────────────────

/**
 * The coordinated client always reaches cloud through a `LLMProxyTransport`.
 * A caller may either supply a shared transport instance (recommended for
 * production so credential caching and stream decoder state live once per
 * process) or a `ProxyCredentialBoundary` and this client will construct one
 * lazily on the first cloud route.
 */
export type CloudTransportBinding =
  | { readonly kind: 'transport'; readonly transport: LLMProxyTransport }
  | {
      readonly kind: 'credential-boundary';
      readonly credentialBoundary: ProxyCredentialBoundary;
    };

// ─── Caller-supplied per-request context ───────────────────────

/**
 * Everything the proxy needs beyond the resolved route. Callers derive these
 * from the same identity they use to append canonical stream events
 * (`requestId`, `conversationId`, `turnId`, `attempt`).
 */
export interface CoordinatedRequestContext {
  readonly requestId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly applicationVersion: string;
  readonly capabilities?: ProxyCapabilityMetadataV1;
}

// ─── Outcome types ─────────────────────────────────────────────

export interface CoordinatedInferenceClientResolved {
  readonly kind: 'resolved';
  readonly transportClass: TransportClass;
  readonly route: InferenceRoute;
  readonly decision: RoutingDecision;
  readonly selectedLocality: ProviderLocality;
  readonly adapter: LLMProviderAdapter;
}

export type CoordinatedInferenceFailureCode =
  | 'route-coordinator-failed-closed'
  | 'local-adapter-unavailable';

export interface CoordinatedInferenceFailure {
  readonly kind: 'failed-closed';
  readonly failureCode: CoordinatedInferenceFailureCode;
  readonly explanation: string;
  /**
   * Preserved only when the coordinator itself failed closed. Absent when
   * the coordinator resolved but a local adapter could not be constructed.
   */
  readonly coordinator?: InferenceRouteFailedClosed;
  /**
   * Present when the failure originated from a resolved route (typically
   * a local-adapter miss). Provides truthful logical provider/model
   * attribution for diagnostics even though no request was issued.
   */
  readonly attemptedRoute?: InferenceRoute;
  /**
   * Typed proxy error classification with redacted metadata. Attached for
   * every coordinator-level failure whose logical selection identified a
   * cloud provider, so callers can emit the same diagnostic shape they use
   * for transport-level failures without inspecting the failure code.
   *
   * Absent when the failure originated from a local-provider selection
   * (there is no proxy classification for a local adapter miss) or when
   * the coordinator could not identify enough context to attribute a
   * provider/model.
   */
  readonly classified?: ClassifiedProxyError;
}

export type CoordinatedInferenceOutcome =
  | CoordinatedInferenceClientResolved
  | CoordinatedInferenceFailure;

// ─── Dependencies ──────────────────────────────────────────────

export interface CoordinatedInferenceClientDependencies {
  readonly coordinator: InferenceRouteCoordinator;
  readonly cloudTransport: CloudTransportBinding;
  readonly localAdapterFactory: LocalAdapterFactory;
}

// ─── Implementation ────────────────────────────────────────────

/**
 * Single instance per main-process; instances are cheap so re-creating one
 * for a test is fine. State is intentionally limited to the lazily
 * constructed cloud transport when a `credential-boundary` binding is used.
 */
export class CoordinatedInferenceClient {
  private readonly coordinator: InferenceRouteCoordinator;
  private readonly cloudTransport: CloudTransportBinding;
  private readonly localAdapterFactory: LocalAdapterFactory;
  private lazyCloudTransport: LLMProxyTransport | undefined;

  constructor(dependencies: CoordinatedInferenceClientDependencies) {
    this.coordinator = dependencies.coordinator;
    this.cloudTransport = dependencies.cloudTransport;
    this.localAdapterFactory = dependencies.localAdapterFactory;
    if (dependencies.cloudTransport.kind === 'transport') {
      this.lazyCloudTransport = dependencies.cloudTransport.transport;
    }
  }

  /**
   * Resolve a fully wired client for the given inference request.
   *
   * This is the single production surface that adapts an inference caller
   * to the route coordinator. Callers MUST NOT bypass this method to
   * construct provider clients directly.
   *
   * The method NEVER throws for auth, entitlement, quota, credential,
   * network, or transport-classification conditions. Failures return a
   * typed `CoordinatedInferenceFailure` result that upstream code must
   * handle explicitly.
   */
  resolveClient(input: {
    readonly routing: InferenceRouteRequest;
    readonly context: CoordinatedRequestContext;
  }): CoordinatedInferenceOutcome {
    const resolution = this.coordinator.resolveRoute(input.routing);

    if (resolution.kind === 'failed-closed') {
      // Attribute the failure to the same logical provider/model the
      // coordinator considered. When the coordinator paused before any
      // selection existed, fall back to `unavailable` — matching the
      // preflight placeholder — so the classified error still carries a
      // truthful non-empty attribution.
      const classifierContext = buildClassifierContextFromRouting(
        input.routing,
        input.context,
        resolution.decision,
      );
      const classified = classifyCoordinatorFailure(
        resolution.failureCode,
        classifierContext,
      );
      return {
        kind: 'failed-closed',
        failureCode: 'route-coordinator-failed-closed',
        explanation: resolution.explanation,
        coordinator: resolution,
        classified,
      };
    }

    switch (resolution.route.transportClass) {
      case 'neuronest-cloud-proxy':
        return this.buildCloudResolved(resolution, input.context);
      case 'local-provider':
        return this.buildLocalResolved(resolution);
      default: {
        // Defense in depth. `TransportClass` is a closed union today. If a
        // future variant is added without wiring here, we refuse to route
        // rather than default to any transport.
        const exhaustiveCheck: never = resolution.route.transportClass;
        return {
          kind: 'failed-closed',
          failureCode: 'route-coordinator-failed-closed',
          explanation:
            `Unknown transport class '${String(exhaustiveCheck)}' for ` +
            `route ${resolution.route.routeId}`,
          attemptedRoute: resolution.route,
        };
      }
    }
  }

  // ─── internals ────────────────────────────────────────────────

  private buildCloudResolved(
    resolution: InferenceRouteResolved,
    context: CoordinatedRequestContext,
  ): CoordinatedInferenceClientResolved {
    const transport = this.getCloudTransport();
    const adapter = createLLMProxyAdapter({
      transport,
      provider: resolution.route.selectedProvider,
      model: resolution.route.selectedModel,
      id: `coordinated:${resolution.route.routeId}`,
      name:
        `${resolution.route.selectedProvider} ${resolution.route.selectedModel} ` +
        'via NeuroNest',
      requestContext: (): LLMProxyAdapterRequestContext => ({
        requestId: context.requestId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        attempt: context.attempt,
        modelRole: resolution.route.modelRole,
        invocationSource: resolution.route.invocationSource,
        ...(context.capabilities === undefined
          ? {}
          : { capabilities: context.capabilities }),
        clientContext: {
          edition: resolution.route.edition,
          entitlementRevision: resolution.route.entitlementRevision,
          applicationVersion: context.applicationVersion,
        },
      }),
    });
    return {
      kind: 'resolved',
      transportClass: 'neuronest-cloud-proxy',
      route: resolution.route,
      decision: resolution.decision,
      selectedLocality: resolution.selectedLocality,
      adapter,
    };
  }

  private buildLocalResolved(
    resolution: InferenceRouteResolved,
  ): CoordinatedInferenceClientResolved | CoordinatedInferenceFailure {
    const locality = resolution.selectedLocality;
    if (locality !== 'local' && locality !== 'self-hosted') {
      // Should never happen — `local-provider` transport is only produced
      // for local/self-hosted localities today — but guard against a
      // future locality that maps to local-provider without a
      // corresponding local adapter.
      return {
        kind: 'failed-closed',
        failureCode: 'local-adapter-unavailable',
        explanation:
          `Route ${resolution.route.routeId} classifies as local-provider ` +
          `but the selected locality '${locality}' has no local adapter contract.`,
        attemptedRoute: resolution.route,
      };
    }

    const adapter = this.localAdapterFactory({
      providerId: resolution.route.selectedProvider,
      modelId: resolution.route.selectedModel,
      locality,
      modelRole: resolution.route.modelRole,
      invocationSource: resolution.route.invocationSource,
    });
    if (!adapter) {
      return {
        kind: 'failed-closed',
        failureCode: 'local-adapter-unavailable',
        explanation:
          `No local adapter is registered for ${resolution.route.selectedProvider}/` +
          `${resolution.route.selectedModel}.`,
        attemptedRoute: resolution.route,
      };
    }
    return {
      kind: 'resolved',
      transportClass: 'local-provider',
      route: resolution.route,
      decision: resolution.decision,
      selectedLocality: locality,
      adapter,
    };
  }

  private getCloudTransport(): LLMProxyTransport {
    if (this.lazyCloudTransport) return this.lazyCloudTransport;
    // Constructed lazily so a purely-local session never allocates a proxy
    // transport or a fetch capability.
    if (this.cloudTransport.kind !== 'credential-boundary') {
      // We already primed `lazyCloudTransport` for the `transport` binding
      // in the constructor, so reaching here means the union has drifted.
      throw new Error(
        'CoordinatedInferenceClient: cloud transport binding is not initialized.',
      );
    }
    this.lazyCloudTransport = new LLMProxyTransportCtor({
      credentialBoundary: this.cloudTransport.credentialBoundary,
    });
    return this.lazyCloudTransport;
  }
}

/**
 * Build a classifier context from routing input plus (optionally) the
 * logical decision the coordinator reached before failing. Prefers the
 * decision's provider/model when a selection existed; falls back to
 * "unavailable" placeholders that mirror the preflight event route
 * metadata so downstream diagnostics still carry a truthful non-empty
 * attribution.
 */
function buildClassifierContextFromRouting(
  routing: InferenceRouteRequest,
  context: CoordinatedRequestContext,
  decision: RoutingDecision | undefined,
): ProxyErrorRequestContext {
  const hasSelection =
    decision !== undefined &&
    decision.paused === false &&
    decision.providerId.length > 0 &&
    decision.modelId.length > 0;
  return {
    provider: hasSelection && decision !== undefined ? decision.providerId : 'unavailable',
    model: hasSelection && decision !== undefined ? decision.modelId : 'unavailable',
    edition: routing.edition,
    invocationSource: routing.invocationSource,
    requestType: routing.streaming ? 'streaming' : 'non-streaming',
    fallbackCorrelationId: context.requestId,
  };
}
