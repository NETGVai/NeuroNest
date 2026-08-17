/**
 * IntrospectionService — Secret-free inspection of capabilities, profiles, policies, and health.
 *
 * Exposes metadata about registered capabilities, active profiles, policy states,
 * and component health without revealing secret values, internal implementation
 * details, or private paths.
 *
 * Requirements: 27.1
 */

import type {
  CapabilityInfo,
  ProfileInfo,
  PolicyInfo,
  HealthInfo,
  IntrospectionResult,
} from './schemas';

// ─── Secret Detection ───────────────────────────────────────────

/**
 * Patterns that indicate secret or sensitive data that must not be exposed.
 */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /auth[_-]?header/i,
  /bearer/i,
  /connection[_-]?string/i,
];

/**
 * Returns true if a key name matches any secret pattern.
 */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively redacts any field whose key matches a secret pattern.
 * Returns a new object; does not mutate the input.
 */
export function redactSecrets<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

// ─── IntrospectionService ───────────────────────────────────────

/**
 * Provider interface for registering data sources with IntrospectionService.
 */
export interface IntrospectionDataProvider {
  getCapabilities(): CapabilityInfo[];
  getProfiles(): ProfileInfo[];
  getPolicies(): PolicyInfo[];
  getHealth(): HealthInfo[];
}

/**
 * IntrospectionService provides secret-free inspection of runtime state.
 *
 * All results are filtered through redactSecrets to ensure no secret values
 * leak through the introspection surface.
 */
export class IntrospectionService {
  private readonly provider: IntrospectionDataProvider;

  constructor(provider: IntrospectionDataProvider) {
    this.provider = provider;
  }

  /**
   * Returns loaded capabilities with contract versions, owners, and state.
   * Secret values are never included in the response.
   */
  getCapabilities(): CapabilityInfo[] {
    return redactSecrets(this.provider.getCapabilities());
  }

  /**
   * Returns active profiles without exposing secret configuration values.
   */
  getProfiles(): ProfileInfo[] {
    return redactSecrets(this.provider.getProfiles());
  }

  /**
   * Returns policy class states without internal implementation details.
   */
  getPolicies(): PolicyInfo[] {
    return redactSecrets(this.provider.getPolicies());
  }

  /**
   * Returns component health status without internal details.
   */
  getHealth(): HealthInfo[] {
    return redactSecrets(this.provider.getHealth());
  }

  /**
   * Returns aggregate introspection result — guaranteed secret-free.
   */
  inspect(): IntrospectionResult {
    return redactSecrets({
      capabilities: this.provider.getCapabilities(),
      profiles: this.provider.getProfiles(),
      policies: this.provider.getPolicies(),
      health: this.provider.getHealth(),
      timestamp: new Date().toISOString(),
    });
  }
}
