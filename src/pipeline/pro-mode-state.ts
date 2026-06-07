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

import { createLLMClient as baseCreateLLMClient } from './llm-client';

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
 * Drop-in replacement for `createLLMClient` that automatically attaches the
 * cached pro-mode proxy config when pro mode is on AND the provider is a
 * cloud provider (local providers — ollama / llamacpp / openmythos — are
 * automatically excluded by `createLLMClient` itself).
 *
 * When pro mode is off OR the auth token isn't yet hydrated, the helper
 * forwards to `createLLMClient` with no proxy config, preserving the exact
 * pre-fix behavior.
 */
export function createLLMClientWithProMode(providerConfig: any) {
  if (!_state.enabled || !_state.authToken || _state.authToken.length === 0) {
    return baseCreateLLMClient(providerConfig);
  }

  return baseCreateLLMClient(providerConfig, {
    enabled: true,
    endpoint: _state.endpoint,
    authToken: _state.authToken,
  });
}
