/**
 * Application-level secret store singleton.
 *
 * This module initializes the SecretStore at startup and exports it for use
 * by all main-process modules that require credentials (license manager,
 * API clients, etc.).
 *
 * MUST be initialized by calling `initAppSecrets()` before any module
 * accesses `appSecretStore`. Accessing the store before initialization
 * throws a descriptive error.
 */

import { loadAppSecrets, type SecretStore } from './secret-loader';

let _store: SecretStore | null = null;

/**
 * Initialize the application secret store. Loads all required secrets from
 * environment variables. Throws if any required secret is missing or empty.
 *
 * Call this ONCE at the very beginning of the startup sequence.
 */
export function initAppSecrets(): SecretStore {
  _store = loadAppSecrets();
  return _store;
}

/**
 * Returns the initialized secret store singleton.
 * Throws if `initAppSecrets()` has not been called yet.
 */
export function getAppSecretStore(): SecretStore {
  if (!_store) {
    throw new Error(
      '[AppSecrets] Secret store not initialized. ' +
      'Call initAppSecrets() at the start of the application before accessing secrets.'
    );
  }
  return _store;
}
