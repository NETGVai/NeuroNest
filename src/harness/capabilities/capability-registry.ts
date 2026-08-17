/**
 * Capability Registry — Extends Plugin_Registry with typed capability definitions,
 * provider compatibility validation, active-provider resolution, in-flight version
 * pinning, inspection metadata, idempotent disposers, and bounded owned-work drain.
 *
 * Requirements: 2.1–2.7
 */

import { randomUUID } from 'node:crypto';
import type {
  CapabilityDefinition,
  CapabilityDisposer,
  CapabilityErrorCode,
  CapabilityInspection,
  CapabilityLifecycleState,
  CapabilityRegistryConfig,
  ContractVersion,
  InFlightPin,
  ProviderRegistration,
  ResolutionError,
  ResolutionResult,
  ResolutionSuccess,
} from './types.js';

// ─── Compatibility Utilities ────────────────────────────────────

/**
 * Determines if a provider contract is compatible with a capability contract.
 * Compatibility rule: same major version, provider minor >= capability minor.
 */
export function isContractCompatible(
  required: ContractVersion,
  provided: ContractVersion,
): boolean {
  return (
    required.major === provided.major &&
    provided.minor >= required.minor
  );
}

// ─── CapabilityRegistry ─────────────────────────────────────────

/**
 * Central typed capability registry that extends the Plugin_Registry pattern.
 *
 * Invariants:
 * - Each capability has a unique name.
 * - Provider compatibility is validated before activation.
 * - At most one active provider per capability at any time.
 * - In-flight operations remain pinned to one provider version until completion.
 * - Disposal is idempotent and drains owned work within a configured deadline.
 * - Inspection metadata is always available for loaded capabilities.
 */
export class CapabilityRegistry {
  private readonly capabilities: Map<string, CapabilityDefinition> = new Map();
  private readonly providers: Map<string, ProviderRegistration[]> = new Map();
  private readonly inFlightPins: Map<string, InFlightPin> = new Map();
  private readonly ownedWork: Map<string, Set<Promise<unknown>>> = new Map();
  private readonly config: CapabilityRegistryConfig;

  constructor(config: CapabilityRegistryConfig) {
    this.config = config;
  }

  // ─── Capability Registration ──────────────────────────────────

  /**
   * Register a capability with a unique name, versioned contracts, and owner.
   * Returns an idempotent disposer on success.
   *
   * Requirement 2.1: Register each capability with unique name, versioned I/O contracts,
   * owner identity, and lifecycle state.
   * Requirement 2.6: Return an idempotent disposer owned by the registration.
   */
  register(
    name: string,
    inputContract: ContractVersion,
    outputContract: ContractVersion,
    owner: string,
  ): { ok: true; disposer: CapabilityDisposer } | ResolutionError {
    if (this.capabilities.has(name)) {
      return this.makeError(
        'PROVIDER_ALREADY_REGISTERED',
        `Capability "${name}" is already registered.`,
      );
    }

    const definition: CapabilityDefinition = {
      name,
      inputContract,
      outputContract,
      owner,
      state: 'registered',
      registeredAt: Date.now(),
    };

    this.capabilities.set(name, definition);
    this.providers.set(name, []);
    this.ownedWork.set(name, new Set());

    const disposer = this.createDisposer(name);
    return { ok: true, disposer };
  }

  // ─── Provider Registration ────────────────────────────────────

  /**
   * Register a provider for a capability.
   * Validates provider compatibility before making it active.
   *
   * Requirement 2.2: Validate provider compatibility before activation.
   */
  registerProvider(
    capabilityName: string,
    providerId: string,
    inputContract: ContractVersion,
    outputContract: ContractVersion,
    owner: string,
  ): { ok: true; provider: ProviderRegistration } | ResolutionError {
    const capability = this.capabilities.get(capabilityName);
    if (!capability) {
      return this.makeError(
        'CAPABILITY_NOT_FOUND',
        `Capability "${capabilityName}" is not registered.`,
      );
    }

    if (capability.state === 'disposed') {
      return this.makeError(
        'CAPABILITY_DISPOSED',
        `Capability "${capabilityName}" has been disposed.`,
      );
    }

    if (capability.state === 'draining') {
      return this.makeError(
        'CAPABILITY_DRAINING',
        `Capability "${capabilityName}" is draining and cannot accept new providers.`,
      );
    }

    // Validate compatibility
    const inputCompatible = isContractCompatible(capability.inputContract, inputContract);
    const outputCompatible = isContractCompatible(capability.outputContract, outputContract);

    if (!inputCompatible || !outputCompatible) {
      const providers = this.providers.get(capabilityName) ?? [];
      return {
        ok: false,
        error: {
          code: 'INCOMPATIBLE_CONTRACT',
          message: `Provider "${providerId}" is incompatible with capability "${capabilityName}".`,
          requestedInput: capability.inputContract,
          requestedOutput: capability.outputContract,
          availableContracts: providers.map((p) => ({
            providerId: p.providerId,
            inputContract: p.inputContract,
            outputContract: p.outputContract,
          })),
        },
      };
    }

    // Check for duplicate provider
    const existingProviders = this.providers.get(capabilityName)!;
    if (existingProviders.some((p) => p.providerId === providerId)) {
      return this.makeError(
        'PROVIDER_ALREADY_REGISTERED',
        `Provider "${providerId}" is already registered for capability "${capabilityName}".`,
      );
    }

    const provider: ProviderRegistration = {
      providerId,
      capabilityName,
      inputContract,
      outputContract,
      owner,
      active: false,
      registeredAt: Date.now(),
    };

    existingProviders.push(provider);

    // If no active provider exists, make this one active
    const hasActive = existingProviders.some((p) => p.active);
    if (!hasActive) {
      provider.active = true;
      capability.state = 'active';
    }

    return { ok: true, provider };
  }

  /**
   * Activate a specific provider, deactivating the current one.
   * In-flight operations on the old provider remain pinned.
   *
   * Requirement 2.4: Pin in-flight operations to one provider version.
   */
  activateProvider(
    capabilityName: string,
    providerId: string,
  ): { ok: true } | ResolutionError {
    const capability = this.capabilities.get(capabilityName);
    if (!capability) {
      return this.makeError(
        'CAPABILITY_NOT_FOUND',
        `Capability "${capabilityName}" is not registered.`,
      );
    }

    if (capability.state === 'disposed' || capability.state === 'draining') {
      return this.makeError(
        'CAPABILITY_DISPOSED',
        `Capability "${capabilityName}" cannot accept activations in state "${capability.state}".`,
      );
    }

    const providers = this.providers.get(capabilityName)!;
    const target = providers.find((p) => p.providerId === providerId);
    if (!target) {
      return this.makeError(
        'PROVIDER_NOT_FOUND',
        `Provider "${providerId}" is not registered for capability "${capabilityName}".`,
      );
    }

    // Validate compatibility
    const inputCompatible = isContractCompatible(capability.inputContract, target.inputContract);
    const outputCompatible = isContractCompatible(capability.outputContract, target.outputContract);
    if (!inputCompatible || !outputCompatible) {
      return {
        ok: false,
        error: {
          code: 'INCOMPATIBLE_CONTRACT',
          message: `Provider "${providerId}" is incompatible with capability "${capabilityName}".`,
          requestedInput: capability.inputContract,
          requestedOutput: capability.outputContract,
          availableContracts: providers.map((p) => ({
            providerId: p.providerId,
            inputContract: p.inputContract,
            outputContract: p.outputContract,
          })),
        },
      };
    }

    // Deactivate current active, activate target
    // In-flight operations remain pinned (they use InFlightPin records)
    for (const p of providers) {
      p.active = false;
    }
    target.active = true;
    capability.state = 'active';

    return { ok: true };
  }

  // ─── Consumer Resolution ──────────────────────────────────────

  /**
   * Resolve a capability for a consumer.
   * Returns one compatible active provider or a structured error.
   *
   * Requirement 2.3: Return one compatible active provider or structured error.
   */
  resolve(capabilityName: string): ResolutionResult {
    const capability = this.capabilities.get(capabilityName);
    if (!capability) {
      return this.makeError(
        'CAPABILITY_NOT_FOUND',
        `Capability "${capabilityName}" is not registered.`,
      );
    }

    if (capability.state === 'disposed') {
      return this.makeError(
        'CAPABILITY_DISPOSED',
        `Capability "${capabilityName}" has been disposed.`,
      );
    }

    if (capability.state === 'draining') {
      return this.makeError(
        'CAPABILITY_DRAINING',
        `Capability "${capabilityName}" is draining and not accepting new resolutions.`,
      );
    }

    const providers = this.providers.get(capabilityName) ?? [];
    const activeProvider = providers.find((p) => p.active);

    if (!activeProvider) {
      return {
        ok: false,
        error: {
          code: 'NO_ACTIVE_PROVIDER',
          message: `No active provider for capability "${capabilityName}".`,
          requestedInput: capability.inputContract,
          requestedOutput: capability.outputContract,
          availableContracts: providers.map((p) => ({
            providerId: p.providerId,
            inputContract: p.inputContract,
            outputContract: p.outputContract,
          })),
        },
      };
    }

    return { ok: true, provider: activeProvider } satisfies ResolutionSuccess;
  }

  // ─── In-flight Pinning ────────────────────────────────────────

  /**
   * Pin an in-flight operation to the current active provider version.
   * The operation remains pinned until explicitly released.
   *
   * Requirement 2.4: Pin each in-flight operation to one provider version.
   */
  pinOperation(capabilityName: string): InFlightPin | ResolutionError {
    const resolution = this.resolve(capabilityName);
    if (!resolution.ok) {
      return resolution;
    }

    const pin: InFlightPin = {
      operationId: randomUUID(),
      capabilityName,
      providerId: resolution.provider.providerId,
      inputContract: resolution.provider.inputContract,
      outputContract: resolution.provider.outputContract,
      pinnedAt: Date.now(),
    };

    this.inFlightPins.set(pin.operationId, pin);
    return pin;
  }

  /**
   * Release an in-flight pin, indicating the operation has completed.
   */
  releasePin(operationId: string): boolean {
    return this.inFlightPins.delete(operationId);
  }

  /**
   * Get the pinned provider for an in-flight operation.
   * Returns the original pinned provider even if the active provider has changed.
   */
  getPinnedProvider(operationId: string): InFlightPin | undefined {
    return this.inFlightPins.get(operationId);
  }

  // ─── Owned Work Tracking ──────────────────────────────────────

  /**
   * Track an async operation as owned work for a capability.
   * Owned work is drained during disposal within the configured deadline.
   */
  trackWork(capabilityName: string, work: Promise<unknown>): void {
    const workSet = this.ownedWork.get(capabilityName);
    if (!workSet) return;

    workSet.add(work);
    // Auto-remove when complete
    void work.finally(() => {
      workSet.delete(work);
    });
  }

  // ─── Inspection ───────────────────────────────────────────────

  /**
   * Expose inspection metadata for all loaded capabilities.
   *
   * Requirement 2.5: Expose loaded capabilities, active providers, compatible
   * versions, owner identities, and consumer counts.
   */
  inspect(): CapabilityInspection {
    const capabilities = Array.from(this.capabilities.values());

    const activeProviders = new Map<string, ProviderRegistration>();
    for (const [name, providers] of this.providers) {
      const active = providers.find((p) => p.active);
      if (active) {
        activeProviders.set(name, active);
      }
    }

    const compatibleVersions = new Map<string, ContractVersion[]>();
    for (const [name, providers] of this.providers) {
      const capability = this.capabilities.get(name)!;
      const compatible = providers
        .filter(
          (p) =>
            isContractCompatible(capability.inputContract, p.inputContract) &&
            isContractCompatible(capability.outputContract, p.outputContract),
        )
        .map((p) => p.outputContract);
      compatibleVersions.set(name, compatible);
    }

    const owners = new Map<string, string>();
    for (const [name, cap] of this.capabilities) {
      owners.set(name, cap.owner);
    }

    const consumerCounts = new Map<string, number>();
    for (const [name] of this.capabilities) {
      let count = 0;
      for (const pin of this.inFlightPins.values()) {
        if (pin.capabilityName === name) {
          count++;
        }
      }
      consumerCounts.set(name, count);
    }

    return {
      capabilities,
      activeProviders,
      compatibleVersions,
      owners,
      consumerCounts,
    };
  }

  // ─── State Query ──────────────────────────────────────────────

  /**
   * Get the current lifecycle state of a capability.
   */
  getState(capabilityName: string): CapabilityLifecycleState | undefined {
    return this.capabilities.get(capabilityName)?.state;
  }

  /**
   * Check if a capability is registered.
   */
  has(capabilityName: string): boolean {
    return this.capabilities.has(capabilityName);
  }

  /**
   * Get all registered providers for a capability.
   */
  getProviders(capabilityName: string): readonly ProviderRegistration[] {
    return this.providers.get(capabilityName) ?? [];
  }

  /**
   * Get all in-flight pins for a capability.
   */
  getInFlightPins(capabilityName: string): InFlightPin[] {
    const pins: InFlightPin[] = [];
    for (const pin of this.inFlightPins.values()) {
      if (pin.capabilityName === capabilityName) {
        pins.push(pin);
      }
    }
    return pins;
  }

  // ─── Disposal ─────────────────────────────────────────────────

  /**
   * Create an idempotent disposer for a capability registration.
   *
   * Requirement 2.6: Return an idempotent disposer.
   * Requirement 2.7: Disposer stops new resolutions, drains owned work,
   * and reverses registration effects.
   */
  private createDisposer(capabilityName: string): CapabilityDisposer {
    let disposed = false;

    const dispose = async (): Promise<void> => {
      // Idempotent: no-op if already disposed
      if (disposed) return;
      disposed = true;

      const capability = this.capabilities.get(capabilityName);
      if (!capability) return;

      // 1. Stop new resolutions by transitioning to draining
      capability.state = 'draining';

      // 2. Drain owned async work within configured deadline
      const workSet = this.ownedWork.get(capabilityName);
      if (workSet && workSet.size > 0) {
        const deadline = new Promise<void>((resolve) =>
          setTimeout(resolve, this.config.drainDeadlineMs),
        );
        const allWork = Promise.allSettled(Array.from(workSet));
        await Promise.race([allWork, deadline]);
      }

      // 3. Release remaining in-flight pins for this capability
      for (const [opId, pin] of this.inFlightPins) {
        if (pin.capabilityName === capabilityName) {
          this.inFlightPins.delete(opId);
        }
      }

      // 4. Reverse registration effects
      capability.state = 'disposed';
      this.providers.delete(capabilityName);
      this.ownedWork.delete(capabilityName);
    };

    return {
      get disposed() {
        return disposed;
      },
      dispose,
    };
  }

  // ─── Error Helpers ────────────────────────────────────────────

  private makeError(code: CapabilityErrorCode, message: string): ResolutionError {
    return {
      ok: false,
      error: { code, message },
    };
  }
}
