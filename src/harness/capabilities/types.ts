/**
 * Capability Registry Types — Typed capability definitions, providers, consumers,
 * and lifecycle contracts for the Capability_Registry.
 *
 * Requirements: 2.1–2.7
 */

// ─── Versioned Contract ─────────────────────────────────────────

/**
 * A versioned contract reference for capability input or output.
 * Uses semver-style major.minor for compatibility checks.
 */
export interface ContractVersion {
  /** Semver-style version string (e.g., "1.0", "2.3") */
  readonly major: number;
  readonly minor: number;
}

/**
 * Lifecycle states for a capability registration.
 */
export type CapabilityLifecycleState =
  | 'registered'
  | 'active'
  | 'draining'
  | 'disposed';

// ─── Capability Definition ──────────────────────────────────────

/**
 * A registered capability with versioned input/output contracts,
 * owner identity, and lifecycle state.
 */
export interface CapabilityDefinition {
  /** Unique capability name */
  readonly name: string;
  /** Versioned input contract */
  readonly inputContract: ContractVersion;
  /** Versioned output contract */
  readonly outputContract: ContractVersion;
  /** Owner identity string */
  readonly owner: string;
  /** Current lifecycle state */
  state: CapabilityLifecycleState;
  /** Timestamp of registration */
  readonly registeredAt: number;
}

// ─── Provider Registration ──────────────────────────────────────

/**
 * A provider registration for a capability.
 */
export interface ProviderRegistration {
  /** Unique provider ID */
  readonly providerId: string;
  /** The capability this provider serves */
  readonly capabilityName: string;
  /** Input contract version this provider supports */
  readonly inputContract: ContractVersion;
  /** Output contract version this provider produces */
  readonly outputContract: ContractVersion;
  /** Owner of this provider */
  readonly owner: string;
  /** Whether this provider is currently active (selected for resolution) */
  active: boolean;
  /** Timestamp of registration */
  readonly registeredAt: number;
}

// ─── Resolution Result ──────────────────────────────────────────

/**
 * Successful resolution returning the active provider.
 */
export interface ResolutionSuccess {
  readonly ok: true;
  readonly provider: ProviderRegistration;
}

/**
 * Failed resolution with structured error.
 */
export interface ResolutionError {
  readonly ok: false;
  readonly error: {
    readonly code: CapabilityErrorCode;
    readonly message: string;
    /** The requested contract versions */
    readonly requestedInput?: ContractVersion;
    readonly requestedOutput?: ContractVersion;
    /** Available compatible contract versions */
    readonly availableContracts?: Array<{
      readonly providerId: string;
      readonly inputContract: ContractVersion;
      readonly outputContract: ContractVersion;
    }>;
  };
}

export type ResolutionResult = ResolutionSuccess | ResolutionError;

/**
 * Error codes for capability operations.
 */
export type CapabilityErrorCode =
  | 'CAPABILITY_NOT_FOUND'
  | 'NO_ACTIVE_PROVIDER'
  | 'INCOMPATIBLE_CONTRACT'
  | 'CAPABILITY_DRAINING'
  | 'CAPABILITY_DISPOSED'
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PROVIDER_NOT_FOUND';

// ─── In-flight Pin ──────────────────────────────────────────────

/**
 * Represents an in-flight operation pinned to a specific provider version.
 */
export interface InFlightPin {
  /** Unique operation ID */
  readonly operationId: string;
  /** The capability name */
  readonly capabilityName: string;
  /** The pinned provider ID */
  readonly providerId: string;
  /** Pinned input contract version */
  readonly inputContract: ContractVersion;
  /** Pinned output contract version */
  readonly outputContract: ContractVersion;
  /** Timestamp when the operation was pinned */
  readonly pinnedAt: number;
}

// ─── Inspection Metadata ────────────────────────────────────────

/**
 * Metadata for inspecting capability state.
 */
export interface CapabilityInspection {
  /** All loaded capability definitions */
  readonly capabilities: ReadonlyArray<CapabilityDefinition>;
  /** Active providers by capability name */
  readonly activeProviders: ReadonlyMap<string, ProviderRegistration>;
  /** All compatible contract versions per capability */
  readonly compatibleVersions: ReadonlyMap<string, ReadonlyArray<ContractVersion>>;
  /** Owner identities of registered capabilities */
  readonly owners: ReadonlyMap<string, string>;
  /** Current consumer/in-flight counts per capability */
  readonly consumerCounts: ReadonlyMap<string, number>;
}

// ─── Disposer ───────────────────────────────────────────────────

/**
 * An idempotent disposer returned on successful capability registration.
 * Calling dispose() stops new resolutions, drains owned async work within
 * the configured deadline, and reverses registration effects.
 */
export interface CapabilityDisposer {
  /** Whether this disposer has already been called */
  readonly disposed: boolean;
  /**
   * Dispose the capability registration.
   * - Stops new resolutions
   * - Drains owned async work within the configured deadline
   * - Reverses registration effects
   * Idempotent: calling multiple times has the same effect as calling once.
   */
  dispose(): Promise<void>;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the CapabilityRegistry.
 */
export interface CapabilityRegistryConfig {
  /** Maximum time in ms to wait for owned work to drain during disposal */
  readonly drainDeadlineMs: number;
}
