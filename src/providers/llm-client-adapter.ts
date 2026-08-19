/**
 * LLM Client Adapter — Bridges existing createLLMClient providers to the
 * formal LLMProviderAdapter interface used by ProviderRegistry.
 *
 * This adapter is retained for local-provider configs and legacy paths
 * that construct provider clients directly from a saved JSON config
 * (type, baseUrl, apiKey, model). Cloud providers MUST NOT be constructed
 * this way in production — the coordinated inference client
 * (`src/provider-routing/coordinated-inference-client.ts`) is the canonical
 * entry point, and it routes cloud through `LLMProxyTransport`.
 *
 * Behavior (Requirements 2.7, 5.1, 5.7, 5.9):
 *  - Local providers (`ollama` / `llamacpp` / `openmythos` or configs with a
 *    localhost base URL) yield a canonical local adapter (see
 *    `createLocalProviderAdapter`). The adapter streams from the configured
 *    local endpoint via `LocalProviderTransport`, never resolves a Proxy
 *    Credential, and emits canonical wire events that share ONE
 *    downstream projection contract with cloud responses.
 *  - The legacy `createLLMClientWithProMode` path is retained as an
 *    `isAvailable` probe so tests and pre-canonical callers that only
 *    check adapter validity keep working.
 *  - Cloud providers (everything else) result in a fail-closed adapter:
 *    `chatCompletion` and `streamCompletion` throw
 *    `DirectCloudConstructionNotAllowedError`, and `isAvailable` returns
 *    `false`. Callers that want cloud inference must obtain an adapter
 *    through `CoordinatedInferenceClient.resolveClient()` so preflight
 *    and proxy routing are enforced.
 */

import { randomUUID } from 'node:crypto';
import { createLLMClientWithProMode } from '../pipeline/pro-mode-state';
import { getProviderCatalogEntry } from '../pipeline/provider-catalog.js';
import type {
  LLMProviderAdapter,
  CompletionResult,
  CompletionChunk,
} from './provider-registry';
import {
  createLocalProviderAdapter,
  type LocalProviderAdapter,
} from './local-provider-adapter.js';
import { DEFAULT_LOCAL_PROVIDER_URLS } from './local-provider-transport.js';

/**
 * Shape of a provider config record from the user's saved providers JSON.
 */
export interface ProviderConfig {
  id?: string;
  name?: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  nLoops?: number;
  [key: string]: unknown;
}

/**
 * Thrown when a caller tries to construct a cloud provider adapter via the
 * legacy config path. Cloud inference MUST go through
 * `CoordinatedInferenceClient` so preflight, entitlement, and proxy
 * routing are enforced.
 */
export class DirectCloudConstructionNotAllowedError extends Error {
  readonly providerId: string;
  readonly providerType: string;

  constructor(providerId: string, providerType: string) {
    super(
      `Direct cloud construction is not allowed for provider '${providerId}' ` +
        `(type '${providerType}'). Use CoordinatedInferenceClient to obtain a ` +
        'proxy-backed adapter.',
    );
    this.name = 'DirectCloudConstructionNotAllowedError';
    this.providerId = providerId;
    this.providerType = providerType;
  }
}

/** Provider types that always run locally regardless of catalog metadata. */
const LOCAL_PROVIDER_TYPES = new Set(['ollama', 'llamacpp', 'openmythos']);

function isLocalConfig(config: ProviderConfig): boolean {
  const type =
    typeof config.type === 'string' ? config.type.toLowerCase() : '';
  if (type) {
    const catalog = getProviderCatalogEntry(type);
    if (catalog?.isLocal === true) return true;
    if (LOCAL_PROVIDER_TYPES.has(type)) return true;
  }
  const base =
    typeof config.baseUrl === 'string' ? config.baseUrl.toLowerCase() : '';
  return (
    base.includes('://localhost') ||
    base.includes('://127.0.0.1') ||
    base.includes('://[::1]')
  );
}

/**
 * Wraps an existing provider config into an LLMProviderAdapter.
 *
 * For local providers this delegates to `createLocalProviderAdapter` so the
 * canonical event contract (`response.started` → answer/reasoning deltas →
 * `usage.reported` → `response.completed`) is shared with cloud responses.
 * The legacy `createLLMClientWithProMode` construction is preserved only as
 * an `isAvailable()` probe so pre-canonical callers keep observing the
 * same "adapter constructs" signal without touching the network.
 *
 * For cloud providers this returns a fail-closed adapter that refuses
 * inference and directs the caller at the coordinated inference client.
 */
export function createProviderAdapter(config: ProviderConfig): LLMProviderAdapter {
  const id = config.id || config.name || config.type || 'unknown';
  const name = config.name || config.type || id;
  const providerType = typeof config.type === 'string' ? config.type : 'unknown';

  if (!isLocalConfig(config)) {
    // Requirement 5.7: cloud provider adapters MUST NOT be constructed
    // directly from a saved provider config. The adapter is materialized
    // so ProviderRegistry.register can still validate the interface shape,
    // but every operation refuses at the boundary.
    return createFailClosedCloudAdapter(id, name, providerType);
  }

  return createLocalProviderAdapterFromConfig(config, id, name);
}

/**
 * Convenience factory that turns a saved provider config into a canonical
 * local adapter. Exposed as a distinct helper so the coordinated inference
 * client's `localAdapterFactory` can call it directly for a route that
 * classifies as `local-provider` without going back through
 * `createProviderAdapter`'s cloud/local branch.
 */
export function createLocalProviderAdapterFromConfig(
  config: ProviderConfig,
  adapterId?: string,
  adapterName?: string,
): LocalProviderAdapter {
  const id = adapterId ?? config.id ?? config.name ?? config.type ?? 'local';
  const name = adapterName ?? config.name ?? config.type ?? id;
  const providerType =
    typeof config.type === 'string' && config.type.length > 0 ? config.type : 'ollama';
  const modelId =
    typeof config.model === 'string' && config.model.length > 0 ? config.model : 'default';

  const baseUrl = resolveLocalBaseUrl(config, providerType);
  const extraHeaders = collectLocalExtraHeaders(config);

  return createLocalProviderAdapter({
    provider: providerType,
    model: modelId,
    baseUrl,
    id,
    name,
    ...(extraHeaders === undefined ? {} : { extraHeaders }),
    requestContext: () => ({
      // The legacy config path does not carry a request id, so we mint a
      // fresh one per invocation. Coordinated callers that want stable
      // ids should use `createLocalProviderAdapter` directly with their
      // own `requestContext` supplier.
      requestId: `local-${randomUUID()}`,
    }),
    isAvailable: () => {
      try {
        // Preserve the legacy signal: if `createLLMClientWithProMode`
        // rejects a local config (which it won't per its documented
        // contract), we surface that as unavailable rather than trying
        // the endpoint. This keeps behavior parity with the pre-6.6
        // adapter.
        return createLLMClientWithProMode(config) !== null;
      } catch {
        return false;
      }
    },
  });
}

function resolveLocalBaseUrl(config: ProviderConfig, providerType: string): string {
  const raw = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
  if (raw && raw.length > 0) {
    // Preserve the caller's chosen path unless it lacks the `/v1` suffix
    // — mirrors the behavior in `pipeline/llm-client.ts::createLLMClient`.
    if (raw.includes('/v1')) return raw.replace(/\/+$/, '');
    return raw.replace(/\/+$/, '') + '/v1';
  }
  const key = providerType.toLowerCase();
  const fallback = DEFAULT_LOCAL_PROVIDER_URLS[key];
  if (!fallback) {
    // Should never happen — `isLocalConfig` only returns true for known
    // local types or configs with a localhost base URL — but be explicit.
    return DEFAULT_LOCAL_PROVIDER_URLS.ollama ?? 'http://localhost:11434/v1';
  }
  return fallback;
}

function collectLocalExtraHeaders(
  _config: ProviderConfig,
): Readonly<Record<string, string>> | undefined {
  // Requirement 5.9 invariant: local requests carry NO Authorization
  // bearer by default. Ollama, llama.cpp, and OpenMythos do not require
  // one. Self-hosted deployments that require a custom header must
  // configure it explicitly through the direct `createLocalProviderAdapter`
  // API — never through a saved provider config whose `apiKey` field is
  // also the storage slot for the (now-deprecated) direct-cloud key.
  // Silently forwarding `apiKey` here would violate the "no bearer on
  // local paths" invariant enforced by the canonical-output tests.
  return undefined;
}

function createFailClosedCloudAdapter(
  id: string,
  name: string,
  providerType: string,
): LLMProviderAdapter {
  const refuse = (): never => {
    throw new DirectCloudConstructionNotAllowedError(id, providerType);
  };
  return {
    id,
    name,

    async chatCompletion(): Promise<CompletionResult> {
      return refuse();
    },

    async *streamCompletion(): AsyncIterable<CompletionChunk> {
      refuse();
      // eslint-disable-next-line @typescript-eslint/no-unreachable, no-unreachable
      yield { content: '', done: true };
    },

    countTokens(text: string): number {
      // Token counting is metadata-only; return a heuristic estimate so
      // callers that compute budgets before requesting inference (and
      // therefore before discovering the refusal) still receive a sane
      // number. The value cannot leak credentials or route decisions.
      return Math.ceil(text.length / 4);
    },

    async isAvailable(): Promise<boolean> {
      return false;
    },
  };
}

/**
 * Convert an array of provider configs into LLMProviderAdapter instances
 * with priority based on their position in the array (first = highest priority).
 */
export function createAdaptersFromConfigs(
  configs: ProviderConfig[],
): Array<{ adapter: LLMProviderAdapter; priority: number }> {
  return configs.map((config, index) => ({
    adapter: createProviderAdapter(config),
    priority: index + 1,
  }));
}
