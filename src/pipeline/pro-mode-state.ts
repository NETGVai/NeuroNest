// Pro-mode state cache for the main process.
//
// The renderer holds the source of truth for `professionalMode`,
// `proxyAuthToken` (the user's licenseKey), and `proxyEndpoint` in
// localStorage. The main process can't read renderer localStorage directly,
// so the renderer hydrates and updates this cache via two IPC channels:
//
//   pro-mode:hydrate   — fired on `DOMContentLoaded` boot, sends current state
//   pro-mode:set-state — fired on every `setProfessionalMode` /
//                        `setProxyAuthToken` (no-op now) /
//                        `setProxyEndpoint` change
//
// Every call site that constructs an LLMClient uses
// `createLLMClientWithProMode(provider)` instead of `createLLMClient(provider)`.
// The helper reads this cache and forwards a `proxyConfig` to the underlying
// factory so the LLMClient knows to route via `llm.neuronest.cc/v1` with the
// licenseKey as bearer token.
//
// ── Task 6.5: closed cloud egress ────────────────────────────────
//
// Cloud providers MUST NEVER be constructed as direct-provider clients. If
// the pro-mode auth token is missing when a cloud provider is requested,
// the helper returns `null` (fail closed) instead of falling back to
// `baseCreateLLMClient(providerConfig)`. The legacy fallback would have
// sent inference to a public Cloud_Provider endpoint using a stored
// Provider_API_Key, which Requirement 5.7 forbids. Local providers
// (ollama / llamacpp / openmythos) continue to work with their configured
// local endpoint per Requirement 5.9.

import { createLLMClient as baseCreateLLMClient } from './llm-client';
import { getProviderCatalogEntry } from './provider-catalog.js';

/** Provider types that always run locally regardless of pro-mode state. */
const LOCAL_PROVIDER_TYPES = new Set(['ollama', 'llamacpp', 'openmythos']);

interface ProModeState {
  enabled: boolean;
  authToken: string;        // user's licenseKey, or '' if community/not yet hydrated
  endpoint: string;         // base URL (no trailing /chat/completions); defaults to https://llm.neuronest.cc/v1
}

// Default state matches a freshly booted community user — proxy disabled,
// no token, sensible endpoint default. Until the renderer fires `hydrate`,
// `createLLMClientWithProMode` falls back to direct-provider mode.
const DEFAULT_ENDPOINT = 'https://llm.neuronest.cc/v1';

let _state: ProModeState = {
  enabled: false,
  authToken: '',
  endpoint: DEFAULT_ENDPOINT,
};

export function getProModeState(): ProModeState {
  return { ..._state };
}

export function setProModeState(next: Partial<ProModeState>): void {
  if (typeof next.enabled === 'boolean') _state.enabled = next.enabled;
  if (typeof next.authToken === 'string') _state.authToken = next.authToken;
  if (typeof next.endpoint === 'string' && next.endpoint.length > 0) {
    _state.endpoint = next.endpoint;
  }
}

/**
 * For tests only: reset the cache to its default state. Production code
 * mutates state via `setProModeState`, which the IPC handlers call.
 */
export function _resetProModeStateForTest(): void {
  _state = { enabled: false, authToken: '', endpoint: DEFAULT_ENDPOINT };
}

/**
 * Best-effort detection of whether a raw provider config points at a local
 * runtime. Uses the provider catalog first (source of truth for locality
 * declared by the shipped provider registry), falls back to the closed
 * `LOCAL_PROVIDER_TYPES` set, and finally treats an explicit `localhost`/
 * `127.0.0.1` base URL as local. Anything else is treated as cloud.
 */
function isLocalProviderConfig(providerConfig: any): boolean {
  if (!providerConfig || typeof providerConfig !== 'object') return false;
  const rawType =
    typeof providerConfig.type === 'string'
      ? providerConfig.type.toLowerCase()
      : '';
  if (rawType) {
    const catalog = getProviderCatalogEntry(rawType);
    if (catalog?.isLocal === true) return true;
    if (LOCAL_PROVIDER_TYPES.has(rawType)) return true;
  }
  const rawBase =
    typeof providerConfig.baseUrl === 'string'
      ? providerConfig.baseUrl.toLowerCase()
      : '';
  if (
    rawBase.includes('://localhost') ||
    rawBase.includes('://127.0.0.1') ||
    rawBase.includes('://[::1]')
  ) {
    return true;
  }
  return false;
}

/**
 * Drop-in replacement for `createLLMClient` that attaches the cached
 * pro-mode proxy config for cloud providers when pro mode is on.
 *
 * Behavior (Requirements 5.1, 5.7, 5.9):
 *  - Local providers (ollama / llamacpp / openmythos or a config with a
 *    localhost base URL) always resolve to their configured local
 *    endpoint. Pro-mode state does not affect their construction.
 *  - Cloud providers, when pro mode is enabled AND the auth token has been
 *    hydrated, receive the pro-mode proxy config so `createLLMClient`
 *    routes through `llm.neuronest.cc`.
 *  - Cloud providers, when pro mode is disabled OR the auth token is
 *    missing, FAIL CLOSED and return `null`. Callers must handle this by
 *    surfacing a proxy authentication error rather than proceeding with
 *    direct-provider network I/O.
 */
export function createLLMClientWithProMode(providerConfig: any) {
  const local = isLocalProviderConfig(providerConfig);
  if (local) {
    // Local providers ignore pro-mode entirely. Preserve the pre-fix path.
    return baseCreateLLMClient(providerConfig);
  }

  if (!_state.enabled || !_state.authToken || _state.authToken.length === 0) {
    // Requirement 5.7: cloud inference cannot fall back to a direct provider
    // endpoint. Return null so callers surface a proxy-authentication or
    // entitlement error via the coordinated inference path.
    return null;
  }

  return baseCreateLLMClient(providerConfig, {
    enabled: true,
    endpoint: _state.endpoint,
    authToken: _state.authToken,
  });
}
