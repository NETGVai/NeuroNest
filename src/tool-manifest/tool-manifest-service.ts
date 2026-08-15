/**
 * ToolManifestService — Normalizes and validates tool manifests for built-in, plugin, and MCP tools.
 *
 * Every tool (built-in, plugin, MCP) must be registered with a valid ToolManifest.
 * The service validates manifests on registration and rejects tools without valid manifests.
 *
 * Requirements: 36.1, 36.2, 36.3, 36.5, 36.6, 36.7, 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9, 37.10
 */

import type {
  ToolManifest,
  ToolSource,
  ManifestRegistrationResult,
  ToolRiskLevel,
  NetworkPolicy,
  PolicyStack,
  ResolvedPolicy,
  ToolInvocationRequest,
  ToolInvocationResult,
} from './types.js';
import { PolicyResolver } from './policy-resolver.js';

// ─── Manifest Validation ────────────────────────────────────────

function validateManifest(manifest: Partial<ToolManifest>): string[] {
  const errors: string[] = [];

  if (!manifest.name || typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('version is required and must be a string');
  } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push('version must follow semver format (e.g., "1.0.0")');
  }

  if (!manifest.description || typeof manifest.description !== 'string') {
    errors.push('description is required and must be a string');
  }

  if (!manifest.inputSchema || typeof manifest.inputSchema !== 'object') {
    errors.push('inputSchema is required and must be an object');
  }

  const validRiskLevels: ToolRiskLevel[] = ['read-only', 'write', 'execute', 'destructive'];
  if (!manifest.riskLevel || !validRiskLevels.includes(manifest.riskLevel)) {
    errors.push(`riskLevel is required and must be one of: ${validRiskLevels.join(', ')}`);
  }

  const validNetworkPolicies: NetworkPolicy[] = ['none', 'local-only', 'allowlist', 'unrestricted'];
  if (!manifest.networkPolicy || !validNetworkPolicies.includes(manifest.networkPolicy)) {
    errors.push(`networkPolicy is required and must be one of: ${validNetworkPolicies.join(', ')}`);
  }

  if (manifest.networkPolicy === 'allowlist') {
    if (!manifest.networkAllowlist || !Array.isArray(manifest.networkAllowlist) || manifest.networkAllowlist.length === 0) {
      errors.push('networkAllowlist is required and must be a non-empty array when networkPolicy is "allowlist"');
    }
  }

  if (!Array.isArray(manifest.secretAccess)) {
    errors.push('secretAccess is required and must be an array');
  }

  if (manifest.outputBoundsBytes === undefined || typeof manifest.outputBoundsBytes !== 'number' || manifest.outputBoundsBytes <= 0) {
    errors.push('outputBoundsBytes is required and must be a positive number');
  }

  if (typeof manifest.cancellationSupport !== 'boolean') {
    errors.push('cancellationSupport is required and must be a boolean');
  }

  const validSources: ToolSource[] = ['built-in', 'plugin', 'mcp'];
  if (!manifest.source || !validSources.includes(manifest.source)) {
    errors.push(`source is required and must be one of: ${validSources.join(', ')}`);
  }

  if (manifest.timeoutMs !== undefined && (typeof manifest.timeoutMs !== 'number' || manifest.timeoutMs <= 0)) {
    errors.push('timeoutMs must be a positive number when specified');
  }

  if (manifest.heartbeatIntervalMs !== undefined && (typeof manifest.heartbeatIntervalMs !== 'number' || manifest.heartbeatIntervalMs <= 0)) {
    errors.push('heartbeatIntervalMs must be a positive number when specified');
  }

  return errors;
}

// ─── ToolManifestService ────────────────────────────────────────

export class ToolManifestService {
  private manifests = new Map<string, ToolManifest>();
  private policyResolver = new PolicyResolver();

  /**
   * Register a tool manifest. Validates the manifest and rejects invalid ones.
   * Returns a result indicating success or listing validation errors.
   */
  register(manifest: Partial<ToolManifest>): ManifestRegistrationResult {
    const errors = validateManifest(manifest);

    if (errors.length > 0) {
      return { success: false, errors };
    }

    const validManifest = manifest as ToolManifest;
    const key = this.getManifestKey(validManifest.name, validManifest.version);

    if (this.manifests.has(key)) {
      return {
        success: false,
        errors: [`Tool '${validManifest.name}@${validManifest.version}' is already registered`],
      };
    }

    this.manifests.set(key, { ...validManifest });
    return { success: true, errors: [] };
  }

  /**
   * Unregister a tool manifest by name and version.
   */
  unregister(name: string, version: string): boolean {
    const key = this.getManifestKey(name, version);
    return this.manifests.delete(key);
  }

  /**
   * Get a registered manifest by name and version.
   */
  get(name: string, version: string): ToolManifest | undefined {
    return this.manifests.get(this.getManifestKey(name, version));
  }

  /**
   * Get the latest registered version of a tool by name.
   */
  getLatest(name: string): ToolManifest | undefined {
    let latest: ToolManifest | undefined;
    let latestVersion = '';

    for (const [key, manifest] of this.manifests) {
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
   * List all registered manifests.
   */
  list(): ToolManifest[] {
    return Array.from(this.manifests.values());
  }

  /**
   * List manifests by source type.
   */
  listBySource(source: ToolSource): ToolManifest[] {
    return this.list().filter((m) => m.source === source);
  }

  /**
   * Validate a tool invocation against its manifest and the policy stack.
   * Returns whether the invocation is allowed and the reason if denied.
   */
  validateInvocation(
    request: ToolInvocationRequest,
    policyStack: PolicyStack,
  ): ToolInvocationResult {
    // Find the manifest for this tool
    const manifest = this.getLatest(request.toolName);
    if (!manifest) {
      return {
        success: false,
        denied: true,
        reason: `No valid manifest found for tool '${request.toolName}'`,
      };
    }

    // Resolve the policy stack
    const resolvedPolicy = this.policyResolver.resolve(policyStack);

    // Check if the tool is allowed under policy
    const policyCheck = this.policyResolver.isToolAllowed(
      manifest.name,
      manifest.riskLevel,
      resolvedPolicy,
    );
    if (!policyCheck.allowed) {
      return {
        success: false,
        denied: true,
        reason: policyCheck.reason,
      };
    }

    // Check network policy
    if (manifest.networkPolicy !== 'none' && !resolvedPolicy.networkAllowed) {
      return {
        success: false,
        denied: true,
        reason: `Tool '${manifest.name}' requires network access but policy denies it`,
      };
    }

    // Check secret access
    if (manifest.secretAccess.length > 0 && !resolvedPolicy.secretAccessAllowed) {
      return {
        success: false,
        denied: true,
        reason: `Tool '${manifest.name}' requires secret access but policy denies it`,
      };
    }

    // Check output bounds
    if (manifest.outputBoundsBytes > resolvedPolicy.maxOutputBoundsBytes) {
      return {
        success: false,
        denied: true,
        reason: `Tool '${manifest.name}' output bounds (${manifest.outputBoundsBytes}) exceed policy maximum (${resolvedPolicy.maxOutputBoundsBytes})`,
      };
    }

    return { success: true };
  }

  /**
   * Get the resolved policy for a given policy stack.
   */
  resolvePolicy(policyStack: PolicyStack): ResolvedPolicy {
    return this.policyResolver.resolve(policyStack);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private getManifestKey(name: string, version: string): string {
    return `${name}@${version}`;
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
