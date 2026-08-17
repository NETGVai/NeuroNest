/**
 * Execution World Policy — Security_Authority-owned sandbox enforcement.
 *
 * Resolves and enforces one Sandbox_Policy per Execution_World across all
 * execution surfaces: filesystem, process, terminal, language service,
 * code runtime, and web retrieval.
 *
 * - Applies platform confinement before allowing mutating/code-execution tools.
 * - Enforces fail-closed or explicit-approval when confinement is unavailable.
 * - Denies operations exceeding policy with redacted violation events.
 * - Denies cross-world access unless an authorized transfer contract applies.
 * - Preserves existing firewall checks at trust boundaries.
 *
 * Requirements: 9.1–9.9, 23.1, 23.5–23.8
 */

import { z } from 'zod';
import { ScopeDescriptorV1Schema, type ScopeDescriptorV1 } from '../contracts/scope';
import {
  type SandboxPolicyV1,
  type ExecutionWorldV1,
  type ViolationEventV1,
  type OperationRequest,
  type EnforcementResult,
  type TransferContractV1,
  type ExecutionSurface,
  type PlatformConfinementKind,
  type UnavailabilityPolicy,
  type WorldPolicyDecision,
  SandboxPolicyV1Schema,
  ExecutionWorldV1Schema,
  ViolationEventV1Schema,
  OperationRequestSchema,
  ALL_EXECUTION_SURFACES,
} from './execution-world-schemas';

// ─── Policy Resolution Inputs ───────────────────────────────────

/**
 * Inputs from which Security_Authority resolves a Sandbox_Policy.
 * Requirement 9.1: workspace, project, session, and operation inputs.
 */
export interface PolicyResolutionInputs {
  workspaceConfig?: Partial<SandboxPolicyV1>;
  projectConfig?: Partial<SandboxPolicyV1>;
  sessionConfig?: Partial<SandboxPolicyV1>;
  operationConfig?: Partial<SandboxPolicyV1>;
  scope: ScopeDescriptorV1;
}

/**
 * Detects which platform the host is running on.
 */
export type PlatformDetector = () => PlatformConfinementKind;

/**
 * Verifies that platform confinement is active.
 * Returns true if the confinement mechanism is verified, false otherwise.
 */
export type ConfinementVerifier = (kind: PlatformConfinementKind, profileId?: string) => boolean;

/**
 * External firewall check integration (Requirement 9.9).
 * Returns true if the request passes the existing firewall, false otherwise.
 */
export type FirewallChecker = (request: OperationRequest) => boolean;

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the ExecutionWorldPolicy service.
 */
export interface ExecutionWorldPolicyConfig {
  /** Detects the current platform for confinement selection. */
  detectPlatform: PlatformDetector;
  /** Verifies platform confinement is active. */
  verifyConfinement: ConfinementVerifier;
  /** Existing firewall check (Requirement 9.9). */
  checkFirewall?: FirewallChecker;
  /** Default unavailability policy if not specified in sandbox policy. */
  defaultUnavailabilityPolicy?: UnavailabilityPolicy;
}

// ─── Default Platform Detection ─────────────────────────────────

/**
 * Default platform detector based on process.platform.
 */
export function detectHostPlatform(): PlatformConfinementKind {
  switch (process.platform) {
    case 'darwin':
      return 'macos_sandbox_profile';
    case 'linux':
      return 'linux_namespace';
    case 'win32':
      return 'windows_restricted_token';
    default:
      return 'none';
  }
}

// ─── Path Matching Utilities ────────────────────────────────────

/**
 * Matches a path against a list of glob-like patterns.
 * Supports simple wildcard (*) and double-star (**) matching.
 */
function matchesPatterns(target: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(target, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Simple glob matching: supports * (any chars except /) and ** (any chars including /).
 */
function matchGlob(value: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(value);
}

// ─── ExecutionWorldPolicy Service ───────────────────────────────

/**
 * Manages Execution_World instances and enforces Sandbox_Policy uniformly.
 *
 * Owned by Security_Authority — all enforcement decisions flow through this service.
 */
export class ExecutionWorldPolicy {
  private readonly config: ExecutionWorldPolicyConfig;
  private readonly worlds: Map<string, ExecutionWorldV1> = new Map();
  private readonly transferContracts: Map<string, TransferContractV1[]> = new Map();
  private readonly violations: ViolationEventV1[] = [];

  constructor(config: ExecutionWorldPolicyConfig) {
    this.config = config;
  }

  // ─── Policy Resolution ──────────────────────────────────────

  /**
   * Resolves one Sandbox_Policy for an Execution_World from layered inputs.
   * Requirement 9.1: Resolve from workspace, project, session, and operation inputs.
   *
   * Precedence: operation > session > project > workspace > defaults.
   */
  resolvePolicy(inputs: PolicyResolutionInputs): SandboxPolicyV1 {
    const detectedPlatform = this.config.detectPlatform();

    const defaults: SandboxPolicyV1 = {
      schemaVersion: 1,
      policyId: generatePolicyId(),
      resolvedFromScope: inputs.scope,
      platformConfinement: {
        kind: detectedPlatform,
        verified: false,
      },
      filesystem: {
        allowedReadPaths: [],
        allowedWritePaths: [],
        deniedPaths: [],
        allowSymlinks: false,
      },
      process: {
        allowedExecutables: [],
        maxProcessTreeDepth: 4,
        maxConcurrentProcesses: 8,
        maxOutputBytes: 1_048_576,
        teardownDeadlineMs: 30_000,
      },
      network: {
        allowedSchemes: ['https'],
        allowedHosts: [],
        deniedHosts: [],
        denyPrivateAddresses: true,
        maxRedirects: 5,
      },
      resourceLimits: {
        maxExecutionTimeMs: 30_000,
        maxOutputBytesPerChannel: 524_288,
        maxContinuations: 10,
      },
      unavailabilityPolicy: this.config.defaultUnavailabilityPolicy ?? 'fail_closed',
      preserveFirewallChecks: true,
      resolvedAt: new Date().toISOString(),
    };

    // Layer: workspace < project < session < operation
    const layers: Array<Partial<SandboxPolicyV1> | undefined> = [
      inputs.workspaceConfig,
      inputs.projectConfig,
      inputs.sessionConfig,
      inputs.operationConfig,
    ];

    let resolved = { ...defaults };
    for (const layer of layers) {
      if (layer) {
        resolved = mergePolicy(resolved, layer);
      }
    }

    // Preserve the resolved scope and new timestamp
    resolved.resolvedFromScope = inputs.scope;
    resolved.resolvedAt = new Date().toISOString();

    return resolved;
  }

  // ─── World Lifecycle ────────────────────────────────────────

  /**
   * Creates a new Execution_World with a resolved Sandbox_Policy.
   * Requirement 23.1: One stable world identity for related operations.
   * Requirement 9.2: Apply confinement before allowing mutating tools.
   */
  createWorld(inputs: PolicyResolutionInputs, worldId?: string): ExecutionWorldV1 {
    const policy = this.resolvePolicy(inputs);
    const id = worldId ?? generateWorldId();

    // Apply platform confinement before the world becomes active (Req 9.2)
    const confinementActive = this.applyConfinement(policy);

    // If confinement unavailable, apply unavailability policy (Req 9.8)
    if (!confinementActive && policy.platformConfinement.kind !== 'none') {
      policy.platformConfinement.verified = false;
    } else {
      policy.platformConfinement.verified = confinementActive;
    }

    const world: ExecutionWorldV1 = {
      schemaVersion: 1,
      worldId: id,
      ownerId: inputs.scope.ownerId ?? inputs.scope.sessionId ?? 'unknown',
      scope: inputs.scope,
      policy,
      active: true,
      createdAt: new Date().toISOString(),
    };

    this.worlds.set(id, world);
    return world;
  }

  /**
   * Retrieves an active Execution_World by ID.
   */
  getWorld(worldId: string): ExecutionWorldV1 | undefined {
    return this.worlds.get(worldId);
  }

  /**
   * Deactivates an Execution_World (e.g., on owner/session teardown).
   * Requirement 23.7: Close owned resources on teardown.
   */
  deactivateWorld(worldId: string): boolean {
    const world = this.worlds.get(worldId);
    if (!world) return false;
    world.active = false;
    return true;
  }

  // ─── Policy Enforcement ─────────────────────────────────────

  /**
   * Enforces Sandbox_Policy on an operation request.
   *
   * Requirement 9.6: Same policy across all surfaces.
   * Requirement 9.7: Deny and append redacted violation on exceeding policy.
   * Requirement 9.8: Fail-closed or explicit-approval when confinement unavailable.
   * Requirement 9.9: Preserve existing firewall checks.
   * Requirement 23.8: Deny cross-world access unless transfer contract applies.
   */
  enforce(request: OperationRequest): EnforcementResult {
    const world = this.worlds.get(request.worldId);

    // World must exist and be active
    if (!world || !world.active) {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'scope_mismatch',
        'Operation targets inactive or unknown execution world',
        'world_active_check',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    const policy = world.policy;

    // Check cross-world access (Requirement 23.8)
    if (!this.scopeMatchesWorld(request.requesterScope, world)) {
      if (!this.hasValidTransfer(request, world.worldId)) {
        const violation = this.createViolation(
          request.worldId,
          request.surface,
          'cross_world_access',
          'Cross-world access denied without authorized transfer',
          'cross_world_check',
          request.correlationId,
        );
        return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
      }
    }

    // Check confinement for mutating operations (Requirement 9.2)
    if (request.mutating && !policy.platformConfinement.verified) {
      if (policy.platformConfinement.kind !== 'none') {
        return this.handleUnavailableConfinement(request, policy);
      }
    }

    // Existing firewall check (Requirement 9.9)
    if (policy.preserveFirewallChecks && this.config.checkFirewall) {
      if (!this.config.checkFirewall(request)) {
        const violation = this.createViolation(
          request.worldId,
          request.surface,
          'network_denied',
          'Existing firewall check denied the operation',
          'firewall_check',
          request.correlationId,
        );
        return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
      }
    }

    // Surface-specific policy checks
    return this.enforceSurfacePolicy(request, policy);
  }

  /**
   * Registers a transfer contract for authorized cross-world access.
   * Requirement 23.8: Explicit authorized transfer contracts.
   */
  registerTransfer(contract: TransferContractV1): void {
    const key = `${contract.sourceWorldId}:${contract.destinationWorldId}`;
    const existing = this.transferContracts.get(key) ?? [];
    existing.push(contract);
    this.transferContracts.set(key, existing);
  }

  /**
   * Returns all recorded violation events (for audit/diagnostics).
   */
  getViolations(): readonly ViolationEventV1[] {
    return this.violations;
  }

  /**
   * Clears recorded violations (e.g., after export to Session_Log).
   */
  drainViolations(): ViolationEventV1[] {
    return this.violations.splice(0);
  }

  // ─── Private: Platform Confinement ──────────────────────────

  /**
   * Applies platform confinement. Returns true if verified active.
   * Requirements 9.3–9.5: macOS sandbox profile, Linux namespaces, Windows tokens.
   */
  private applyConfinement(policy: SandboxPolicyV1): boolean {
    const kind = policy.platformConfinement.kind;
    if (kind === 'none') return true;
    return this.config.verifyConfinement(kind, policy.platformConfinement.profileId);
  }

  // ─── Private: Unavailability Handling ───────────────────────

  /**
   * Handles the case where platform confinement is unavailable.
   * Requirement 9.8: fail-closed or explicit-approval.
   */
  private handleUnavailableConfinement(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    const unavailPolicy = policy.unavailabilityPolicy;

    if (unavailPolicy === 'fail_closed') {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'confinement_unavailable',
        'Platform confinement unavailable; fail-closed policy applied',
        'confinement_unavailable_fail_closed',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    // explicit_approval
    return {
      decision: 'require_approval',
      worldId: request.worldId,
      surface: request.surface,
      approvalContext: `Platform confinement (${policy.platformConfinement.kind}) is unavailable. Explicit approval required for mutating operation on ${request.surface}.`,
    };
  }

  // ─── Private: Surface Policy Enforcement ────────────────────

  /**
   * Enforces surface-specific policy rules.
   * Requirement 9.6: Uniform enforcement across all surfaces.
   */
  private enforceSurfacePolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    switch (request.surface) {
      case 'filesystem':
        return this.enforceFilesystemPolicy(request, policy);
      case 'process':
        return this.enforceProcessPolicy(request, policy);
      case 'terminal':
        return this.enforceTerminalPolicy(request, policy);
      case 'language_service':
        return this.enforceLanguageServicePolicy(request, policy);
      case 'code_runtime':
        return this.enforceCodeRuntimePolicy(request, policy);
      case 'web_retrieval':
        return this.enforceWebRetrievalPolicy(request, policy);
      default:
        return this.allowResult(request);
    }
  }

  private enforceFilesystemPolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    const fp = policy.filesystem;
    const target = request.target;

    // Denied paths always take precedence
    if (matchesPatterns(target, fp.deniedPaths)) {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'path_denied',
        'Path is in denied paths list',
        'filesystem_denied_path',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    // For write/create/delete operations, check write paths
    if (request.operationKind === 'write' || request.operationKind === 'create' || request.operationKind === 'delete') {
      if (fp.allowedWritePaths.length > 0 && !matchesPatterns(target, fp.allowedWritePaths)) {
        const violation = this.createViolation(
          request.worldId,
          request.surface,
          'path_denied',
          'Write path not in allowed write paths',
          'filesystem_write_not_allowed',
          request.correlationId,
        );
        return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
      }
    }

    // For read operations, check read paths
    if (request.operationKind === 'read' || request.operationKind === 'query') {
      if (fp.allowedReadPaths.length > 0 && !matchesPatterns(target, fp.allowedReadPaths)) {
        const violation = this.createViolation(
          request.worldId,
          request.surface,
          'path_denied',
          'Read path not in allowed read paths',
          'filesystem_read_not_allowed',
          request.correlationId,
        );
        return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
      }
    }

    return this.allowResult(request);
  }

  private enforceProcessPolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    const pp = policy.process;

    // Check executable allowlist for execute/create operations
    if (request.operationKind === 'execute' || request.operationKind === 'create') {
      if (pp.allowedExecutables.length > 0 && !matchesPatterns(request.target, pp.allowedExecutables)) {
        const violation = this.createViolation(
          request.worldId,
          request.surface,
          'executable_denied',
          'Executable not in allowed list',
          'process_executable_not_allowed',
          request.correlationId,
        );
        return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
      }
    }

    return this.allowResult(request);
  }

  private enforceTerminalPolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    // Terminal operations are scoped to owner/world (Requirement 23.5).
    // Enforcement is primarily through process policy for commands executed.
    // Read/query operations are generally allowed within the world.
    if (request.operationKind === 'execute') {
      return this.enforceProcessPolicy(request, policy);
    }
    return this.allowResult(request);
  }

  private enforceLanguageServicePolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    // Requirement 23.6: Typed semantic operations without raw protocol escape.
    // Language service operations are read-only queries by nature.
    // Only allow read/query operations.
    if (request.operationKind === 'execute' || request.operationKind === 'write' ||
        request.operationKind === 'create' || request.operationKind === 'delete') {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'scope_mismatch',
        'Language service only permits read/query operations',
        'language_service_mutating_denied',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }
    return this.allowResult(request);
  }

  private enforceCodeRuntimePolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    // Code runtime requires active confinement for execution (Requirement 9.2)
    if (request.operationKind === 'execute' && !policy.platformConfinement.verified) {
      if (policy.platformConfinement.kind !== 'none') {
        return this.handleUnavailableConfinement(request, policy);
      }
    }
    return this.allowResult(request);
  }

  private enforceWebRetrievalPolicy(
    request: OperationRequest,
    policy: SandboxPolicyV1,
  ): EnforcementResult {
    const np = policy.network;
    const target = request.target;

    // Check denied hosts
    if (matchesPatterns(target, np.deniedHosts)) {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'network_denied',
        'Host is in denied hosts list',
        'network_denied_host',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    // Check allowed hosts (if allowlist is specified)
    if (np.allowedHosts.length > 0 && !matchesPatterns(target, np.allowedHosts)) {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'network_denied',
        'Host not in allowed hosts list',
        'network_host_not_allowed',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    // Deny private addresses (Requirement 24.3)
    if (np.denyPrivateAddresses && isPrivateAddress(target)) {
      const violation = this.createViolation(
        request.worldId,
        request.surface,
        'network_denied',
        'Private/loopback address denied by policy',
        'network_private_address_denied',
        request.correlationId,
      );
      return { decision: 'deny', worldId: request.worldId, surface: request.surface, violation };
    }

    return this.allowResult(request);
  }

  // ─── Private: Cross-world Transfer ──────────────────────────

  /**
   * Checks if a valid transfer contract exists for cross-world access.
   */
  private hasValidTransfer(request: OperationRequest, targetWorldId: string): boolean {
    // Look for transfer contracts from any source world to the target
    for (const [key, contracts] of this.transferContracts) {
      if (!key.endsWith(`:${targetWorldId}`)) continue;

      for (const contract of contracts) {
        // Check expiry
        if (contract.expiresAt && new Date(contract.expiresAt) < new Date()) {
          continue;
        }
        // Check permitted surfaces
        if (!contract.permittedSurfaces.includes(request.surface)) {
          continue;
        }
        // Check permitted operations
        if (!contract.permittedOperations.includes(request.operationKind)) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  // ─── Private: Scope Matching ────────────────────────────────

  /**
   * Checks if the requester's scope matches the world's scope.
   */
  private scopeMatchesWorld(requesterScope: ScopeDescriptorV1, world: ExecutionWorldV1): boolean {
    const worldScope = world.scope;

    // Session-scoped: requester must be from same session
    if (worldScope.sessionId && requesterScope.sessionId !== worldScope.sessionId) {
      return false;
    }

    // Owner-scoped: requester must be the same owner
    if (worldScope.ownerId && requesterScope.ownerId !== worldScope.ownerId) {
      return false;
    }

    return true;
  }

  // ─── Private: Helpers ───────────────────────────────────────

  private allowResult(request: OperationRequest): EnforcementResult {
    return { decision: 'allow', worldId: request.worldId, surface: request.surface };
  }

  private createViolation(
    worldId: string,
    surface: ExecutionSurface,
    violationType: ViolationEventV1['violationType'],
    redactedDescription: string,
    violatedRule: string,
    correlationId?: string,
  ): ViolationEventV1 {
    const violation: ViolationEventV1 = {
      schemaVersion: 1,
      worldId,
      surface,
      violationType,
      redactedDescription,
      violatedRule,
      timestamp: new Date().toISOString(),
      correlationId,
    };
    this.violations.push(violation);
    return violation;
  }
}

// ─── Private Address Detection ──────────────────────────────────

/**
 * Detects private, loopback, link-local, and metadata-service addresses.
 * Requirement 24.3: Block these address ranges.
 */
function isPrivateAddress(target: string): boolean {
  const host = extractHost(target);

  // Loopback
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('127.')) return true;

  // Link-local
  if (host.startsWith('169.254.')) return true;
  if (host.startsWith('fe80:')) return true;

  // Private RFC 1918
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;

  // Cloud metadata service
  if (host === '169.254.169.254') return true;
  if (host === 'metadata.google.internal') return true;

  return false;
}

/**
 * Extracts the hostname from a target (URL or bare host).
 */
function extractHost(target: string): string {
  try {
    if (target.includes('://')) {
      const url = new URL(target);
      return url.hostname;
    }
    // Strip port if present
    const colonIdx = target.lastIndexOf(':');
    if (colonIdx > 0 && !target.includes('[')) {
      return target.slice(0, colonIdx);
    }
    return target;
  } catch {
    return target;
  }
}

// ─── ID Generation ──────────────────────────────────────────────

let policyCounter = 0;
let worldCounter = 0;

function generatePolicyId(): string {
  return `policy_${Date.now()}_${++policyCounter}`;
}

function generateWorldId(): string {
  return `world_${Date.now()}_${++worldCounter}`;
}

// ─── Policy Merge ───────────────────────────────────────────────

/**
 * Merges a layer on top of a base policy. Layer values override base values.
 */
function mergePolicy(base: SandboxPolicyV1, layer: Partial<SandboxPolicyV1>): SandboxPolicyV1 {
  return {
    ...base,
    ...layer,
    // Deep merge sub-objects
    platformConfinement: layer.platformConfinement
      ? { ...base.platformConfinement, ...layer.platformConfinement }
      : base.platformConfinement,
    filesystem: layer.filesystem
      ? { ...base.filesystem, ...layer.filesystem }
      : base.filesystem,
    process: layer.process
      ? { ...base.process, ...layer.process }
      : base.process,
    network: layer.network
      ? { ...base.network, ...layer.network }
      : base.network,
    resourceLimits: layer.resourceLimits
      ? { ...base.resourceLimits, ...layer.resourceLimits }
      : base.resourceLimits,
    // Always keep schema version
    schemaVersion: 1,
    policyId: base.policyId,
  };
}
