/**
 * SecretLoader — centralized secret management module.
 *
 * Loads all required secrets from environment variables at startup.
 * No fallback values are provided — missing keys cause a fast failure
 * with a descriptive error listing every missing key.
 *
 * Design Decision: A separate module (rather than inline `process.env` reads)
 * enables testability, ensures no scattered fallback values, and provides a
 * single audit point for credential access.
 */

export interface SecretLoaderOptions {
  requiredKeys: string[];
  optionalKeys?: string[];
}

export interface SecretStore {
  /** Returns the value for a required key. Throws if the key was not loaded. */
  get(key: string): string;
  /** Returns the value for an optional key, or undefined if not set. */
  getOptional(key: string): string | undefined;
  /** Returns true if the key exists in the store (required or optional). */
  has(key: string): boolean;
}

/**
 * Loads secrets from `process.env` based on the provided options.
 *
 * @throws {Error} when one or more required keys are absent or empty.
 *   The error message lists all missing keys for fast diagnosis.
 */
export function loadSecrets(options: SecretLoaderOptions): SecretStore {
  const { requiredKeys, optionalKeys = [] } = options;

  const secrets = new Map<string, string>();
  const missingKeys: string[] = [];

  for (const key of requiredKeys) {
    const value = process.env[key];
    if (value === undefined || value === '') {
      missingKeys.push(key);
    } else {
      secrets.set(key, value);
    }
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `[SecretLoader] Missing required environment variables: ${missingKeys.join(', ')}. ` +
      `The application cannot start without these secrets. ` +
      `Set them in your environment or .env file before launching.`
    );
  }

  // Load optional keys (no error if absent)
  for (const key of optionalKeys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      secrets.set(key, value);
    }
  }

  return {
    get(key: string): string {
      const value = secrets.get(key);
      if (value === undefined) {
        throw new Error(
          `[SecretStore] Key "${key}" not found in secret store. ` +
          `Only keys declared in requiredKeys or optionalKeys are available.`
        );
      }
      return value;
    },

    getOptional(key: string): string | undefined {
      return secrets.get(key);
    },

    has(key: string): boolean {
      return secrets.has(key);
    },
  };
}

/**
 * Secrets the NeuroNest desktop client MAY use, all treated as OPTIONAL.
 *
 * The shipped Electron client must boot on an end-user machine that has no
 * server infrastructure, so NONE of these can be a hard startup requirement:
 *   - BEARER_TOKEN — used lazily by optional license/referral API calls; those
 *     features surface a typed error when it is absent rather than crashing.
 *   - DATABASE_URL / TIMESCALE_URL / RABBITMQ_URL / JWT_SECRET — backend/server
 *     concerns with no runtime consumer in the desktop client.
 *
 * Making all of them optional lets initAppSecrets() succeed (the GUI opens);
 * a feature that genuinely needs one reads it via getOptional() and degrades
 * gracefully. In a server/dev deployment the same keys can still be provided
 * via the environment and are picked up here.
 */
export const OPTIONAL_SECRET_KEYS = [
  'BEARER_TOKEN',
  'DATABASE_URL',
  'TIMESCALE_URL',
  'RABBITMQ_URL',
  'JWT_SECRET',
] as const;

/**
 * The desktop client hard-requires no secrets at startup. Retained (empty) so
 * a server build can override the required set without changing call sites.
 */
export const REQUIRED_SECRET_KEYS = [] as const;

/**
 * Convenience function: loads the application's secrets. All known keys are
 * optional so a missing secret never prevents the client from starting.
 */
export function loadAppSecrets(): SecretStore {
  return loadSecrets({
    requiredKeys: [...REQUIRED_SECRET_KEYS],
    optionalKeys: [...OPTIONAL_SECRET_KEYS],
  });
}
