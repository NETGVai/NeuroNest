/**
 * Context Privacy module — Enforces context, path, secret, and provider privacy policy.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 25.1, 25.2, 25.3, 25.5, 25.6, 25.11
 */

export { ContextPrivacyService } from './context-privacy-service.js';
export {
  type ContextItem,
  type ContextItemType,
  type PrivacyPolicyConfig,
  type PrivacyValidationResult,
  type ItemValidationResult,
  type RejectionReason,
  type VersionRegistry,
  type ProviderConfig,
  type ProviderTrustLevel,
  type DurationGrant,
  type ProviderScopeDisclosure,
  type CanonicalPathResult,
  type PathOperationType,
  TRUST_LEVEL_ORDER,
} from './types.js';
