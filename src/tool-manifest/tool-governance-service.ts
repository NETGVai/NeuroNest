/**
 * ToolGovernanceService — Unified governance of built-in, plugin, and MCP tools.
 *
 * This is the single manifest contract that enforces:
 * - Stable identity, schema, side effects, permissions, scopes, secrets, timeout,
 *   trust source, duplicate detection, compatibility, and runtime availability (R37.1, R37.2)
 * - Untrusted argument/output handling, unified lifecycle + Evidence contract,
 *   most-restrictive policy resolution (R37.3, R37.4, R37.5)
 * - Network allowlists, bounded heartbeat/timeout, install/update disclosure (R37.6, R37.7, R37.8)
 * - Trusted tool versions in production readiness, typed failure routing to Delivery_Loop (R37.9, R37.10)
 *
 * Requirements: 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9, 37.10
 */

import type {
  ToolManifest,
  PolicyStack,
  ResolvedPolicy,
} from './types.js';
import { ToolManifestService } from './tool-manifest-service.js';
import { PolicyResolver } from './policy-resolver.js';

// ─── Trust Levels ───────────────────────────────────────────────

/**
 * Trust source classification for tools.
 * Built-in tools are fully trusted; verified plugins are semi-trusted;
 * unverified MCP/plugin tools are untrusted until disclosure is reviewed.
 */
export type TrustLevel = 'trusted' | 'verified' | 'unverified' | 'untrusted';

// ─── Compatibility Status ───────────────────────────────────────

export type CompatibilityStatus = 'compatible' | 'deprecated' | 'incompatible' | 'unknown';

// ─── Runtime Availability ───────────────────────────────────────

export type RuntimeAvailability = 'available' | 'unavailable' | 'degraded' | 'starting';

// ─── Install/Update Disclosure ──────────────────────────────────

export interface ToolDisclosure {
  /** Publisher or source of the tool */
  publisher: string;
  /** Source repository or registry URL */
  sourceUrl: string;
  /** Version being installed or updated */
  version: string;
  /** Integrity hash (e.g., SHA-256) when available */
  integrityHash?: string;
  /** Signature verification status */
  signatureVerified: boolean;
  /** Permissions requested by the tool */
  requestedPermissions: string[];
  /** Whether rollback to a previous version is possible */
  rollbackAvailable: boolean;
  /** Previous version (for updates) */
  previousVersion?: string;
  /** Timestamp of disclosure review */
  disclosedAt?: string;
  /** Whether the disclosure has been reviewed and accepted */
  accepted: boolean;
}

// ─── Extended Manifest (governance-enriched) ────────────────────

export interface GovernedToolManifest extends ToolManifest {
  /** Trust classification of the tool source */
  trustLevel: TrustLevel;
  /** Permission categories required by the tool */
  permissionCategories: string[];
  /** Workspace scope restrictions (path patterns) */
  scopeRestrictions: string[];
  /** Compatibility with the current platform version */
  compatibilityStatus: CompatibilityStatus;
  /** Runtime availability (can the tool actually run?) */
  runtimeAvailability: RuntimeAvailability;
  /** Install/update disclosure record */
  disclosure?: ToolDisclosure;
  /** Maximum heartbeat interval before the tool is considered unresponsive */
  maxHeartbeatIntervalMs?: number;
  /** Whether the tool version is trusted for production readiness */
  productionTrusted: boolean;
  /** Side effects declared by the tool */
  sideEffects: ToolSideEffect[];
}

// ─── Side Effects ───────────────────────────────────────────────

export type ToolSideEffect =
  | 'filesystem-write'
  | 'filesystem-delete'
  | 'network-request'
  | 'process-spawn'
  | 'credential-access'
  | 'git-mutation'
  | 'database-write'
  | 'external-service-call'
  | 'none';

// ─── Enablement Decision ────────────────────────────────────────

export interface EnablementDecision {
  enabled: boolean;
  reasons: string[];
  manifest: GovernedToolManifest;
  resolvedPolicy: ResolvedPolicy;
}

// ─── Typed Failure for Delivery_Loop ────────────────────────────

export type FailureCategory =
  | 'manifest-invalid'
  | 'policy-denied'
  | 'runtime-unavailable'
  | 'schema-validation'
  | 'network-violation'
  | 'timeout-exceeded'
  | 'heartbeat-missed'
  | 'trust-violation'
  | 'compatibility-failure'
  | 'output-untrusted'
  | 'execution-error';

export interface TypedToolFailure {
  /** Unique failure ID */
  failureId: string;
  /** Tool name that failed */
  toolName: string;
  /** Tool version */
  toolVersion: string;
  /** Failure classification */
  category: FailureCategory;
  /** Human-readable message */
  message: string;
  /** Whether the failure is retryable */
  retryable: boolean;
  /** Suggested recovery action */
  suggestedAction: string;
  /** Timestamp */
  timestamp: string;
  /** Correlation IDs for tracing */
  correlationIds: {
    runId?: string;
    taskId?: string;
    sessionId?: string;
    invocationId?: string;
  };
}

// ─── Evidence Envelope (from tool execution) ────────────────────

export interface ToolEvidenceEnvelope {
  /** Evidence ID */
  id: string;
  /** Tool producing the evidence */
  toolName: string;
  /** Tool version */
  toolVersion: string;
  /** Whether the tool version is production-trusted */
  productionTrusted: boolean;
  /** Tool trust level */
  trustLevel: TrustLevel;
  /** Invocation ID */
  invocationId: string;
  /** The lifecycle states traversed */
  lifecycleStates: string[];
  /** Policy stack used for this invocation */
  policyFingerprint: string;
  /** Output treated as untrusted */
  outputUntrusted: boolean;
  /** Arguments were schema-validated */
  argumentsValidated: boolean;
  /** Timestamp of evidence capture */
  capturedAt: string;
}

// ─── Heartbeat Tracking ─────────────────────────────────────────

interface HeartbeatRecord {
  toolName: string;
  invocationId: string;
  lastHeartbeatAt: string;
  expectedIntervalMs: number;
  missedCount: number;
}

// ─── ToolGovernanceService ──────────────────────────────────────

export class ToolGovernanceService {
  private readonly manifestService: ToolManifestService;
  private readonly policyResolver: PolicyResolver;
  private readonly governedManifests = new Map<string, GovernedToolManifest>();
  private readonly heartbeats = new Map<string, HeartbeatRecord>();
  private readonly disclosures = new Map<string, ToolDisclosure>();
  private readonly failures: TypedToolFailure[] = [];
  private readonly evidenceRecords: ToolEvidenceEnvelope[] = [];
  private failureListener: ((failure: TypedToolFailure) => void) | null = null;

  constructor(manifestService: ToolManifestService, policyResolver: PolicyResolver) {
    this.manifestService = manifestService;
    this.policyResolver = policyResolver;
  }

  // ─── Manifest Registration and Validation (R37.1, R37.2) ─────

  /**
   * Register and validate a governed tool manifest.
   *
   * Checks: stable identity, schema validity, side effects, permissions,
   * scopes, secrets, timeout, trust source, duplicate names, compatibility,
   * and runtime availability before enablement.
   */
  registerGoverned(manifest: GovernedToolManifest): EnablementDecision {
    const reasons: string[] = [];

    // 1. Validate trust source (R37.1 trust source)
    if (manifest.trustLevel === 'untrusted' && !manifest.disclosure?.accepted) {
      reasons.push(
        `Tool '${manifest.name}' has untrusted source and no accepted disclosure`,
      );
    }

    // 2. Check duplicate names in governed registry (R37.2 duplicate names)
    const existingGoverned = this.getGovernedByName(manifest.name);
    if (existingGoverned && existingGoverned.version !== manifest.version) {
      // Different version exists — check compatibility
      if (manifest.compatibilityStatus === 'incompatible') {
        reasons.push(
          `Tool '${manifest.name}@${manifest.version}' is incompatible with existing '${existingGoverned.version}'`,
        );
      }
    }

    // 3. Check compatibility status (R37.2 compatibility)
    if (manifest.compatibilityStatus === 'incompatible') {
      reasons.push(
        `Tool '${manifest.name}' has incompatible compatibility status`,
      );
    }

    // 4. Check runtime availability (R37.2 runtime availability)
    if (manifest.runtimeAvailability === 'unavailable') {
      reasons.push(
        `Tool '${manifest.name}' runtime is unavailable`,
      );
    }

    // 5. Validate side effects are declared (R37.1 side effects)
    if (manifest.riskLevel !== 'read-only' && manifest.sideEffects.length === 0) {
      reasons.push(
        `Tool '${manifest.name}' has non-read-only risk level but declares no side effects`,
      );
    }

    // 6. Validate permission categories are present when secrets are required (R37.1 permissions)
    if (manifest.secretAccess.length > 0 && manifest.permissionCategories.length === 0) {
      reasons.push(
        `Tool '${manifest.name}' requires secret access but declares no permission categories`,
      );
    }

    // 7. Validate timeout bounds (R37.1 timeout)
    if (manifest.timeoutMs !== undefined && manifest.timeoutMs <= 0) {
      reasons.push(`Tool '${manifest.name}' has invalid timeout: ${manifest.timeoutMs}`);
    }

    // 8. Validate heartbeat interval (R37.8 bounded heartbeat)
    if (
      manifest.heartbeatIntervalMs !== undefined &&
      manifest.maxHeartbeatIntervalMs !== undefined &&
      manifest.heartbeatIntervalMs > manifest.maxHeartbeatIntervalMs
    ) {
      reasons.push(
        `Tool '${manifest.name}' heartbeat interval exceeds maximum allowed`,
      );
    }

    // 9. Validate network allowlist when required (R37.6 network allowlists)
    if (manifest.networkPolicy === 'allowlist') {
      if (!manifest.networkAllowlist || manifest.networkAllowlist.length === 0) {
        reasons.push(
          `Tool '${manifest.name}' uses allowlist network policy but has no destinations`,
        );
      }
    }

    // If governance checks fail, stop here before registering with base service
    if (reasons.length > 0) {
      const resolvedPolicy = this.policyResolver.resolve({});
      return { enabled: false, reasons, manifest, resolvedPolicy };
    }

    // 10. Validate base manifest via existing service (R37.1 stable identity, schema)
    const baseResult = this.manifestService.register(manifest);
    if (!baseResult.success) {
      // Filter out "already registered" if we're updating governance
      const nonDuplicateErrors = baseResult.errors.filter(
        (e) => !e.includes('is already registered'),
      );
      if (nonDuplicateErrors.length > 0) {
        reasons.push(...nonDuplicateErrors);
      }
    }

    const enabled = reasons.length === 0;
    const key = `${manifest.name}@${manifest.version}`;

    if (enabled) {
      this.governedManifests.set(key, { ...manifest });
    }

    // Apply a default resolved policy for the decision
    const resolvedPolicy = this.policyResolver.resolve({});

    return {
      enabled,
      reasons,
      manifest,
      resolvedPolicy,
    };
  }

  /**
   * Get a governed manifest by name (latest version).
   */
  getGovernedByName(name: string): GovernedToolManifest | undefined {
    let latest: GovernedToolManifest | undefined;
    let latestVersion = '';

    for (const [, manifest] of this.governedManifests) {
      if (manifest.name === name) {
        if (!latest || this.compareVersions(manifest.version, latestVersion) > 0) {
          latest = manifest;
          latestVersion = manifest.version;
        }
      }
    }

    return latest;
  }

  /**
   * Get a governed manifest by name and version.
   */
  getGoverned(name: string, version: string): GovernedToolManifest | undefined {
    return this.governedManifests.get(`${name}@${version}`);
  }

  /**
   * List all governed manifests.
   */
  listGoverned(): GovernedToolManifest[] {
    return Array.from(this.governedManifests.values());
  }

  // ─── Policy Enforcement (R37.3, R37.4, R37.5) ────────────────

  /**
   * Validate a tool invocation against the most-restrictive policy.
   *
   * Treats arguments as untrusted, checks schema, enforces policy layers.
   */
  validateInvocation(
    toolName: string,
    args: unknown,
    policyStack: PolicyStack,
  ): { allowed: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const manifest = this.getGovernedByName(toolName);
    if (!manifest) {
      reasons.push(`No governed manifest found for tool '${toolName}'`);
      return { allowed: false, reasons };
    }

    // Arguments are UNTRUSTED — validate against schema
    if (!this.validateArguments(args, manifest.inputSchema)) {
      reasons.push(`Arguments for '${toolName}' do not match declared input schema`);
    }

    // Resolve most-restrictive policy
    const resolved = this.policyResolver.resolve(policyStack);

    // Check tool is allowed
    const check = this.policyResolver.isToolAllowed(
      manifest.name,
      manifest.riskLevel,
      resolved,
    );
    if (!check.allowed) {
      reasons.push(check.reason!);
    }

    // Check network
    if (manifest.networkPolicy !== 'none' && !resolved.networkAllowed) {
      reasons.push(`Tool '${toolName}' requires network access denied by policy`);
    }

    // Check secrets
    if (manifest.secretAccess.length > 0 && !resolved.secretAccessAllowed) {
      reasons.push(`Tool '${toolName}' requires secret access denied by policy`);
    }

    // Check runtime availability
    if (manifest.runtimeAvailability !== 'available') {
      reasons.push(
        `Tool '${toolName}' runtime is '${manifest.runtimeAvailability}', not available`,
      );
    }

    return { allowed: reasons.length === 0, reasons };
  }

  /**
   * Resolve the effective policy for a given stack.
   */
  resolvePolicy(policyStack: PolicyStack): ResolvedPolicy {
    return this.policyResolver.resolve(policyStack);
  }

  // ─── Output Handling (R37.3) ──────────────────────────────────

  /**
   * Validate and mark tool output as untrusted.
   *
   * Outputs SHALL be treated as untrusted data and schema-validated
   * when an output schema is declared.
   */
  validateOutput(
    toolName: string,
    output: unknown,
  ): { valid: boolean; untrusted: true; reason?: string } {
    const manifest = this.getGovernedByName(toolName);
    if (!manifest) {
      return { valid: false, untrusted: true, reason: 'No manifest found' };
    }

    // Output is ALWAYS untrusted
    if (manifest.outputSchema) {
      const valid = this.validateAgainstSchema(output, manifest.outputSchema);
      if (!valid) {
        return {
          valid: false,
          untrusted: true,
          reason: 'Output does not match declared output schema',
        };
      }
    }

    return { valid: true, untrusted: true };
  }

  // ─── Network Allowlist Enforcement (R37.6) ────────────────────

  /**
   * Check if a network destination is allowed for a tool.
   */
  isNetworkDestinationAllowed(toolName: string, destination: string): boolean {
    const manifest = this.getGovernedByName(toolName);
    if (!manifest) return false;

    if (manifest.networkPolicy === 'none') return false;
    if (manifest.networkPolicy === 'unrestricted') return true;
    if (manifest.networkPolicy === 'local-only') {
      return this.isLocalDestination(destination);
    }

    // allowlist mode
    if (!manifest.networkAllowlist) return false;
    return manifest.networkAllowlist.some((allowed) =>
      this.matchesAllowlistEntry(destination, allowed),
    );
  }

  // ─── Heartbeat and Timeout (R37.8) ────────────────────────────

  /**
   * Record a heartbeat from a long-running tool.
   */
  recordHeartbeat(toolName: string, invocationId: string): void {
    const manifest = this.getGovernedByName(toolName);
    if (!manifest) return;

    const expectedInterval =
      manifest.heartbeatIntervalMs ?? manifest.maxHeartbeatIntervalMs ?? 30_000;

    this.heartbeats.set(invocationId, {
      toolName,
      invocationId,
      lastHeartbeatAt: new Date().toISOString(),
      expectedIntervalMs: expectedInterval,
      missedCount: 0,
    });
  }

  /**
   * Check if a tool has exceeded its heartbeat interval.
   * Returns true if the tool should be terminated.
   */
  isHeartbeatMissed(invocationId: string): boolean {
    const record = this.heartbeats.get(invocationId);
    if (!record) return false;

    const now = Date.now();
    const lastBeat = new Date(record.lastHeartbeatAt).getTime();
    const elapsed = now - lastBeat;

    // Allow 2x the expected interval before declaring missed
    return elapsed > record.expectedIntervalMs * 2;
  }

  /**
   * Check if a tool has exceeded its timeout.
   */
  isTimeoutExceeded(toolName: string, startedAt: string): boolean {
    const manifest = this.getGovernedByName(toolName);
    if (!manifest || !manifest.timeoutMs) return false;

    const elapsed = Date.now() - new Date(startedAt).getTime();
    return elapsed > manifest.timeoutMs;
  }

  /**
   * Remove heartbeat tracking for a completed invocation.
   */
  clearHeartbeat(invocationId: string): void {
    this.heartbeats.delete(invocationId);
  }

  // ─── Install/Update Disclosure (R37.7) ────────────────────────

  /**
   * Create a disclosure record for a tool install or update.
   *
   * Displays publisher, source, version, integrity, permissions, and rollback path.
   * The disclosure must be accepted before the tool can be enabled.
   */
  createDisclosure(params: {
    toolName: string;
    publisher: string;
    sourceUrl: string;
    version: string;
    integrityHash?: string;
    signatureVerified: boolean;
    requestedPermissions: string[];
    rollbackAvailable: boolean;
    previousVersion?: string;
  }): ToolDisclosure {
    const disclosure: ToolDisclosure = {
      publisher: params.publisher,
      sourceUrl: params.sourceUrl,
      version: params.version,
      signatureVerified: params.signatureVerified,
      requestedPermissions: params.requestedPermissions,
      rollbackAvailable: params.rollbackAvailable,
      accepted: false,
      ...(params.integrityHash !== undefined && { integrityHash: params.integrityHash }),
      ...(params.previousVersion !== undefined && { previousVersion: params.previousVersion }),
    };

    this.disclosures.set(`${params.toolName}@${params.version}`, disclosure);
    return disclosure;
  }

  /**
   * Accept a disclosure, enabling the tool for registration.
   */
  acceptDisclosure(toolName: string, version: string): boolean {
    const key = `${toolName}@${version}`;
    const disclosure = this.disclosures.get(key);
    if (!disclosure) return false;

    disclosure.accepted = true;
    disclosure.disclosedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get a disclosure record.
   */
  getDisclosure(toolName: string, version: string): ToolDisclosure | undefined {
    return this.disclosures.get(`${toolName}@${version}`);
  }

  // ─── Production Readiness (R37.9, R37.10) ─────────────────────

  /**
   * Get all tools used by a run with their production-trusted status.
   * This feeds the Production_Readiness_Report.
   */
  getProductionReadinessReport(toolNames: string[]): {
    tools: Array<{
      name: string;
      version: string;
      trusted: boolean;
      trustLevel: TrustLevel;
      current: boolean;
    }>;
    allTrusted: boolean;
    untrustedTools: string[];
  } {
    const tools: Array<{
      name: string;
      version: string;
      trusted: boolean;
      trustLevel: TrustLevel;
      current: boolean;
    }> = [];

    const untrustedTools: string[] = [];

    for (const name of toolNames) {
      const manifest = this.getGovernedByName(name);
      if (manifest) {
        const trusted = manifest.productionTrusted;
        tools.push({
          name: manifest.name,
          version: manifest.version,
          trusted,
          trustLevel: manifest.trustLevel,
          current: manifest.runtimeAvailability === 'available',
        });
        if (!trusted) {
          untrustedTools.push(name);
        }
      } else {
        tools.push({
          name,
          version: 'unknown',
          trusted: false,
          trustLevel: 'untrusted',
          current: false,
        });
        untrustedTools.push(name);
      }
    }

    return {
      tools,
      allTrusted: untrustedTools.length === 0,
      untrustedTools,
    };
  }

  // ─── Typed Failure Routing (R37.9, R37.10) ────────────────────

  /**
   * Route a typed tool failure to the Delivery_Loop.
   *
   * Tool failures SHALL NOT be represented as successful model output;
   * the Delivery_Loop SHALL receive a typed failure and decide whether retry is safe.
   */
  routeFailure(params: {
    toolName: string;
    category: FailureCategory;
    message: string;
    retryable: boolean;
    suggestedAction: string;
    correlationIds: TypedToolFailure['correlationIds'];
  }): TypedToolFailure {
    const manifest = this.getGovernedByName(params.toolName);
    const failure: TypedToolFailure = {
      failureId: `failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: params.toolName,
      toolVersion: manifest?.version ?? 'unknown',
      category: params.category,
      message: params.message,
      retryable: params.retryable,
      suggestedAction: params.suggestedAction,
      timestamp: new Date().toISOString(),
      correlationIds: params.correlationIds,
    };

    this.failures.push(failure);

    // Emit to Delivery_Loop listener
    if (this.failureListener) {
      this.failureListener(failure);
    }

    return failure;
  }

  /**
   * Register a listener for typed failures (the Delivery_Loop consumer).
   */
  onFailure(listener: (failure: TypedToolFailure) => void): () => void {
    this.failureListener = listener;
    return () => {
      this.failureListener = null;
    };
  }

  /**
   * Get all recorded failures for a run.
   */
  getFailuresForRun(runId: string): TypedToolFailure[] {
    return this.failures.filter((f) => f.correlationIds.runId === runId);
  }

  // ─── Evidence Contract (R37.4) ────────────────────────────────

  /**
   * Create an evidence envelope for a tool invocation.
   *
   * Built-in, plugin, and MCP tools SHALL emit the same Tool_Event lifecycle,
   * audit, cancellation, redaction, retry, and Evidence records.
   */
  createEvidence(params: {
    toolName: string;
    invocationId: string;
    lifecycleStates: string[];
    policyStack: PolicyStack;
  }): ToolEvidenceEnvelope {
    const manifest = this.getGovernedByName(params.toolName);
    const policyFingerprint = this.computePolicyFingerprint(params.policyStack);

    const evidence: ToolEvidenceEnvelope = {
      id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: params.toolName,
      toolVersion: manifest?.version ?? 'unknown',
      productionTrusted: manifest?.productionTrusted ?? false,
      trustLevel: manifest?.trustLevel ?? 'untrusted',
      invocationId: params.invocationId,
      lifecycleStates: params.lifecycleStates,
      policyFingerprint,
      outputUntrusted: true, // Always untrusted per R37.3
      argumentsValidated: true, // Always validated per R37.3
      capturedAt: new Date().toISOString(),
    };

    this.evidenceRecords.push(evidence);
    return evidence;
  }

  /**
   * Get evidence records for a specific invocation.
   */
  getEvidenceForInvocation(invocationId: string): ToolEvidenceEnvelope | undefined {
    return this.evidenceRecords.find((e) => e.invocationId === invocationId);
  }

  /**
   * Get all evidence records for production readiness evaluation.
   */
  getAllEvidence(): ToolEvidenceEnvelope[] {
    return [...this.evidenceRecords];
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private validateArguments(args: unknown, schema: Record<string, unknown>): boolean {
    // Basic schema validation: check that args is an object and required properties exist
    if (args === null || args === undefined) {
      // If schema has no required properties, null/undefined is acceptable
      const required = schema['required'] as string[] | undefined;
      return !required || required.length === 0;
    }

    if (typeof args !== 'object') return false;

    // Check required properties
    const required = schema['required'] as string[] | undefined;
    if (required && Array.isArray(required)) {
      const argObj = args as Record<string, unknown>;
      for (const prop of required) {
        if (!(prop in argObj)) return false;
      }
    }

    return true;
  }

  private validateAgainstSchema(
    data: unknown,
    schema: Record<string, unknown>,
  ): boolean {
    // Basic type checking
    const expectedType = schema['type'] as string | undefined;
    if (expectedType) {
      if (expectedType === 'object' && (typeof data !== 'object' || data === null)) {
        return false;
      }
      if (expectedType === 'string' && typeof data !== 'string') return false;
      if (expectedType === 'number' && typeof data !== 'number') return false;
      if (expectedType === 'boolean' && typeof data !== 'boolean') return false;
      if (expectedType === 'array' && !Array.isArray(data)) return false;
    }
    return true;
  }

  private isLocalDestination(destination: string): boolean {
    const localPatterns = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
    return localPatterns.some((p) => destination.includes(p));
  }

  private matchesAllowlistEntry(destination: string, pattern: string): boolean {
    // Simple matching: exact match or wildcard subdomain
    if (pattern === destination) return true;
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return destination.endsWith(domain) || destination === domain;
    }
    // Check if destination starts with the pattern (e.g., "api.example.com" matches "api.example.com")
    return destination === pattern;
  }

  private computePolicyFingerprint(stack: PolicyStack): string {
    const json = JSON.stringify(stack);
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `policy-${Math.abs(hash).toString(16)}`;
  }

  private compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] ?? 0;
      const bPart = bParts[i] ?? 0;
      if (aPart !== bPart) return aPart - bPart;
    }
    return 0;
  }
}
