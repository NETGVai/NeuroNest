/**
 * Types for the Context Privacy Service.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 25.1, 25.2, 25.3, 25.5, 25.6, 25.11
 *
 * Defines typed references, provider trust levels, privacy policy,
 * and validation results for context items before provider transmission.
 * Includes path canonicalization, provider scope disclosure, home path redaction,
 * and duration-based out-of-workspace grants.
 */

// ---------------------------------------------------------------------------
// Provider Trust Levels
// ---------------------------------------------------------------------------

/**
 * Provider trust classification.
 * local: On-device processing only.
 * trusted: Contracted cloud provider with data agreements.
 * external: Third-party provider without specific agreements.
 *
 * Trust ordering: local > trusted > external.
 * A fallback cannot weaken trust (e.g., trusted -> external is forbidden).
 */
export type ProviderTrustLevel = 'local' | 'trusted' | 'external';

/**
 * Numeric ordering for trust levels to enable comparison.
 */
export const TRUST_LEVEL_ORDER: Record<ProviderTrustLevel, number> = {
  local: 3,
  trusted: 2,
  external: 1,
};

// ---------------------------------------------------------------------------
// Context Item
// ---------------------------------------------------------------------------

/**
 * A typed context reference with source identity and version.
 * Display labels are stored but never reparsed as authority.
 */
export interface ContextItem {
  /** Stable identifier for this context item */
  id: string;
  /** Source URI (canonical workspace-relative path or resource identifier) */
  sourceUri: string;
  /** Content version at time of attachment */
  version: number;
  /** Current content (may be null if not yet resolved) */
  content: string | null;
  /** Content hash for staleness detection */
  contentHash: string;
  /** Display label for UI (never reparsed as authority) */
  displayLabel: string;
  /** Type of context item */
  type: ContextItemType;
  /** Minimum trust level required for this item */
  approvedTrustLevel: ProviderTrustLevel;
  /** Whether this item has an explicit out-of-workspace grant */
  hasExplicitGrant: boolean;
  /** Timestamp when the item was attached */
  attachedAt: number;
  /** Estimated token count */
  estimatedTokens: number;
}

export type ContextItemType =
  | 'file'
  | 'folder'
  | 'selection'
  | 'symbol'
  | 'diagnostic'
  | 'terminal'
  | 'git-diff'
  | 'specification'
  | 'design-node'
  | 'task'
  | 'agent-run'
  | 'artifact'
  | 'image'
  | 'url';

// ---------------------------------------------------------------------------
// Duration Grant
// ---------------------------------------------------------------------------

/**
 * An explicit out-of-workspace grant with a path scope and duration.
 * Requirements: 25.3 — OUT-OF-WORKSPACE access SHALL require a separate explicit
 * capability grant naming the target path and duration.
 */
export interface DurationGrant {
  /** Unique grant identifier */
  id: string;
  /** The canonical path being granted access to */
  targetPath: string;
  /** Actor who issued the grant */
  grantedBy: string;
  /** Unix timestamp when the grant was created */
  grantedAt: number;
  /** Duration in milliseconds from grantedAt */
  durationMs: number;
  /** The workspace that this grant is associated with */
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Provider Scope Disclosure
// ---------------------------------------------------------------------------

/**
 * Disclosure of provider and data scope shown to the user before context leaves the device.
 * Requirements: 25.5, 25.6
 */
export interface ProviderScopeDisclosure {
  /** Provider identifier */
  providerId: string;
  /** Provider display name */
  providerName: string;
  /** Trust level classification */
  trustLevel: ProviderTrustLevel;
  /** Whether this is a local-only or direct-provider route */
  isLocalRoute: boolean;
  /** Data scope — what types of data will be sent */
  dataScope: string[];
  /** Whether source content will be transmitted */
  transmitsSourceContent: boolean;
  /** Endpoint (redacted for security — no full URLs) */
  endpointDescription: string;
}

// ---------------------------------------------------------------------------
// Privacy Policy Configuration
// ---------------------------------------------------------------------------

/**
 * Configurable privacy policy for context validation.
 */
export interface PrivacyPolicyConfig {
  /** Workspace root paths (canonical, resolved) */
  workspaceRoots: string[];
  /** Exclusion patterns (gitignore-style) */
  exclusionPatterns: string[];
  /** Maximum size in bytes for a single context item */
  maxItemSizeBytes: number;
  /** Maximum total token budget for context */
  maxTokenBudget: number;
  /** Secret scanning patterns (regex strings) */
  secretPatterns: string[];
  /** Binary file extensions to reject */
  binaryExtensions: string[];
  /** Provider trust level for the target provider */
  providerTrustLevel: ProviderTrustLevel;
  /** Whether to operate in local-only mode (block all external transmission) */
  localOnly?: boolean;
  /** Whether path canonicalization should resolve symlinks (default: true) */
  resolveSymlinks?: boolean;
  /** Whether to enable case-insensitive path comparison (for case-insensitive filesystems) */
  caseInsensitivePaths?: boolean;
}

// ---------------------------------------------------------------------------
// Validation Results
// ---------------------------------------------------------------------------

/**
 * Reason for rejecting a context item.
 */
export type RejectionReason =
  | 'stale_version'
  | 'path_violation'
  | 'excluded_pattern'
  | 'secret_detected'
  | 'size_exceeded'
  | 'binary_file'
  | 'trust_level_violation'
  | 'token_budget_exceeded'
  | 'content_missing'
  | 'grant_expired'
  | 'local_only_violation'
  | 'symlink_escape';

/**
 * A single validation result for one context item.
 */
export interface ItemValidationResult {
  item: ContextItem;
  passed: boolean;
  rejectionReason?: RejectionReason;
  details?: string;
}

/**
 * Aggregated result from validating a batch of context items.
 */
export interface PrivacyValidationResult {
  /** Items that passed all policy checks */
  passed: ItemValidationResult[];
  /** Items that were rejected with reasons */
  rejected: ItemValidationResult[];
  /** Total tokens of passed items */
  totalPassedTokens: number;
  /** Whether the overall validation succeeded */
  allPassed: boolean;
  /** Provider scope disclosure for user review */
  providerDisclosure?: ProviderScopeDisclosure;
}

// ---------------------------------------------------------------------------
// Version Registry (for staleness checking)
// ---------------------------------------------------------------------------

/**
 * Interface for checking current content versions.
 */
export interface VersionRegistry {
  /** Get the current version for a source URI. Returns null if unknown. */
  getCurrentVersion(sourceUri: string): number | null;
}

// ---------------------------------------------------------------------------
// Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Provider configuration with trust level and fallback behavior.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  trustLevel: ProviderTrustLevel;
  /** Whether this is a local-only route (no external transmission) */
  isLocal?: boolean;
  /** Description of the endpoint (e.g., "localhost:11434" for local models) */
  endpointDescription?: string;
  /** Optional fallback provider. Must not weaken trust. */
  fallbackProviderId?: string;
}

// ---------------------------------------------------------------------------
// Path Canonicalization
// ---------------------------------------------------------------------------

/**
 * Result of path canonicalization.
 */
export interface CanonicalPathResult {
  /** Whether canonicalization succeeded */
  valid: boolean;
  /** The canonical path (resolved, normalized) */
  canonicalPath: string;
  /** Whether the path resolved through a symlink */
  resolvedSymlink: boolean;
  /** If invalid, the reason */
  reason?: string;
}

/**
 * Supported operation types for path canonicalization.
 * Requirements: 25.1, 25.2
 */
export type PathOperationType =
  | 'read'
  | 'search'
  | 'write'
  | 'diff'
  | 'context'
  | 'language';
