/**
 * NetworkPolicy — Policy definition and management for the NetworkSandbox.
 *
 * Provides:
 * - Per-project policy override via `.neuronest/network-policy.json`
 * - Policy merging (project rules override global)
 * - Integration as Layer 8 in the existing security model
 *   (after content scanning, before external requests leave the process)
 *
 * Requirements: 10.5, 10.6
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NetworkSandbox,
  type NetworkPolicy,
  type NetworkPolicyPreset,
  type NetworkPolicyRule,
  getPresetPolicy,
} from './network-sandbox';

// ─── Types ──────────────────────────────────────────────────────

/** Schema for `.neuronest/network-policy.json` project override file */
export interface ProjectNetworkPolicyConfig {
  /** Optional preset override (overrides global preset) */
  preset?: NetworkPolicyPreset;
  /** Additional allow rules (merged with global) */
  allowRules?: NetworkPolicyRule[];
  /** Additional deny rules (merged with global) */
  denyRules?: NetworkPolicyRule[];
  /** Override strict allowlist (replaces global strict allowlist) */
  strictAllowlist?: string[];
  /** Whether the project policy is enabled */
  enabled?: boolean;
}

/** Layer position in the security model */
export const NETWORK_POLICY_LAYER = 8;

/** The security layers in NeuroNest's defense model */
export enum SecurityLayer {
  InputValidation = 1,
  ContentScanning = 2,
  PromptInjectionDetection = 3,
  SecretsDetection = 4,
  ActionRiskClassification = 5,
  PermissionEnforcement = 6,
  FirewallEvaluation = 7,
  NetworkAccessControl = 8,
}

/** Result of loading a project policy */
export interface PolicyLoadResult {
  success: boolean;
  policy?: ProjectNetworkPolicyConfig;
  error?: string;
  filePath?: string;
}

/** Result of merging policies */
export interface MergedPolicyResult {
  policy: NetworkPolicy;
  source: 'global' | 'project' | 'merged';
  projectOverrides: string[];
}

// ─── Constants ──────────────────────────────────────────────────

/** File name for per-project network policy override */
export const PROJECT_POLICY_FILENAME = 'network-policy.json';

/** Directory within project root for NeuroNest config */
export const NEURONEST_CONFIG_DIR = '.neuronest';

// ─── Policy File I/O ────────────────────────────────────────────

/**
 * Get the path to the project-level network policy file.
 */
export function getProjectPolicyPath(projectDir: string): string {
  return join(projectDir, NEURONEST_CONFIG_DIR, PROJECT_POLICY_FILENAME);
}

/**
 * Load the per-project network policy from `.neuronest/network-policy.json`.
 * Returns a PolicyLoadResult indicating success/failure and the parsed config.
 */
export function loadProjectPolicy(projectDir: string): PolicyLoadResult {
  const filePath = getProjectPolicyPath(projectDir);

  if (!existsSync(filePath)) {
    return { success: false, error: 'Project policy file not found', filePath };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!isValidProjectPolicyConfig(parsed)) {
      return { success: false, error: 'Invalid project policy format', filePath };
    }

    return { success: true, policy: parsed, filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error reading policy file';
    return { success: false, error: message, filePath };
  }
}

/**
 * Save a project network policy to `.neuronest/network-policy.json`.
 */
export function saveProjectPolicy(
  projectDir: string,
  config: ProjectNetworkPolicyConfig,
): { success: boolean; error?: string } {
  const filePath = getProjectPolicyPath(projectDir);
  const dirPath = join(projectDir, NEURONEST_CONFIG_DIR);

  try {
    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error writing policy file';
    return { success: false, error: message };
  }
}

// ─── Policy Validation ──────────────────────────────────────────

/**
 * Validate that a parsed JSON object is a valid ProjectNetworkPolicyConfig.
 */
export function isValidProjectPolicyConfig(obj: unknown): obj is ProjectNetworkPolicyConfig {
  if (!obj || typeof obj !== 'object') return false;
  const config = obj as Record<string, unknown>;

  // Validate preset if present
  if (config['preset'] !== undefined) {
    if (!['permissive', 'standard', 'strict'].includes(config['preset'] as string)) {
      return false;
    }
  }

  // Validate enabled if present
  if (config['enabled'] !== undefined && typeof config['enabled'] !== 'boolean') {
    return false;
  }

  // Validate allowRules if present
  if (config['allowRules'] !== undefined) {
    if (!Array.isArray(config['allowRules'])) return false;
    if (!(config['allowRules'] as unknown[]).every(isValidPolicyRule)) return false;
  }

  // Validate denyRules if present
  if (config['denyRules'] !== undefined) {
    if (!Array.isArray(config['denyRules'])) return false;
    if (!(config['denyRules'] as unknown[]).every(isValidPolicyRule)) return false;
  }

  // Validate strictAllowlist if present
  if (config['strictAllowlist'] !== undefined) {
    if (!Array.isArray(config['strictAllowlist'])) return false;
    if (!(config['strictAllowlist'] as unknown[]).every((item) => typeof item === 'string')) return false;
  }

  return true;
}

/**
 * Validate that an object is a valid NetworkPolicyRule.
 */
export function isValidPolicyRule(obj: unknown): obj is NetworkPolicyRule {
  if (!obj || typeof obj !== 'object') return false;
  const rule = obj as Record<string, unknown>;

  // id is required
  if (typeof rule['id'] !== 'string' || (rule['id'] as string).length === 0) return false;

  // action is required and must be 'allow' or 'deny'
  if (!['allow', 'deny'].includes(rule['action'] as string)) return false;

  // At least one targeting field must be present
  const hasDomain = typeof rule['domain'] === 'string';
  const hasPort = typeof rule['port'] === 'number' || typeof rule['port'] === 'string';
  const hasIpRange = typeof rule['ipRange'] === 'string';

  if (!hasDomain && !hasPort && !hasIpRange) return false;

  // Validate port format if present
  if (rule['port'] !== undefined) {
    if (typeof rule['port'] === 'string') {
      const parts = (rule['port'] as string).split('-');
      if (parts.length !== 2) return false;
      if (isNaN(parseInt(parts[0]!, 10)) || isNaN(parseInt(parts[1]!, 10))) return false;
    } else if (typeof rule['port'] !== 'number') {
      return false;
    }
  }

  return true;
}

// ─── Policy Merging ─────────────────────────────────────────────

/**
 * Merge a project-level policy with the global policy.
 *
 * Merge strategy:
 * - Project preset overrides global preset (if specified)
 * - Project allow rules are prepended (higher priority) to global allow rules
 * - Project deny rules are prepended (higher priority) to global deny rules
 * - Project strictAllowlist replaces global strictAllowlist (if specified)
 * - Rules with the same `id` in project override the global version
 *
 * @param globalPolicy - The current global policy from NetworkSandbox
 * @param projectConfig - The project-level policy configuration
 * @returns Merged policy result with source information
 */
export function mergePolicies(
  globalPolicy: NetworkPolicy,
  projectConfig: ProjectNetworkPolicyConfig,
): MergedPolicyResult {
  const overrides: string[] = [];

  // Determine the base preset
  let mergedPreset = globalPolicy.preset;
  if (projectConfig.preset) {
    mergedPreset = projectConfig.preset;
    overrides.push(`preset: ${projectConfig.preset}`);
  }

  // Start with global rules
  let mergedAllowRules = [...globalPolicy.allowRules];
  let mergedDenyRules = [...globalPolicy.denyRules];

  // If preset changed, rebuild from the new preset base
  if (projectConfig.preset && projectConfig.preset !== globalPolicy.preset) {
    const basePolicy = getPresetPolicy(
      projectConfig.preset,
      projectConfig.strictAllowlist,
    );
    mergedAllowRules = [...basePolicy.allowRules];
    mergedDenyRules = [...basePolicy.denyRules];
  }

  // Merge allow rules: project rules override global rules with same id
  if (projectConfig.allowRules && projectConfig.allowRules.length > 0) {
    const projectRuleIds = new Set(projectConfig.allowRules.map(r => r.id));
    // Remove global rules that conflict with project rules
    mergedAllowRules = mergedAllowRules.filter(r => !projectRuleIds.has(r.id));
    // Prepend project rules (higher priority)
    mergedAllowRules = [...projectConfig.allowRules, ...mergedAllowRules];
    overrides.push(`allowRules: ${projectConfig.allowRules.length} project rules`);
  }

  // Merge deny rules: project rules override global rules with same id
  if (projectConfig.denyRules && projectConfig.denyRules.length > 0) {
    const projectRuleIds = new Set(projectConfig.denyRules.map(r => r.id));
    // Remove global rules that conflict with project rules
    mergedDenyRules = mergedDenyRules.filter(r => !projectRuleIds.has(r.id));
    // Prepend project rules (higher priority)
    mergedDenyRules = [...projectConfig.denyRules, ...mergedDenyRules];
    overrides.push(`denyRules: ${projectConfig.denyRules.length} project rules`);
  }

  // Handle strict allowlist override
  let strictAllowlist: string[] | undefined;
  if (projectConfig.strictAllowlist) {
    strictAllowlist = projectConfig.strictAllowlist;
    overrides.push(`strictAllowlist: ${projectConfig.strictAllowlist.length} entries`);
  } else if (globalPolicy.strictAllowlist) {
    strictAllowlist = globalPolicy.strictAllowlist;
  }

  const mergedPolicy: NetworkPolicy = {
    preset: mergedPreset,
    allowRules: mergedAllowRules,
    denyRules: mergedDenyRules,
    ...(strictAllowlist ? { strictAllowlist } : {}),
  };

  const source = overrides.length === 0 ? 'global' : 'merged';

  return { policy: mergedPolicy, source, projectOverrides: overrides };
}

// ─── Network Policy Manager (Layer 8 Integration) ───────────────

/**
 * NetworkPolicyManager — orchestrates policy loading, merging, and application
 * to the NetworkSandbox. Acts as the Layer 8 entry point in the security model.
 *
 * Integration flow:
 *   Layer 7 (Firewall Evaluation) → Layer 8 (Network Access Control) → External Request
 *
 * After content scanning (layers 1-7), any outbound request passes through
 * the NetworkPolicyManager which applies the merged policy (global + project override)
 * to the NetworkSandbox before the request leaves the process.
 */
export class NetworkPolicyManager {
  private static instance: NetworkPolicyManager | null = null;

  private projectDir: string | null = null;
  private projectConfig: ProjectNetworkPolicyConfig | null = null;
  private globalPreset: NetworkPolicyPreset = 'standard';
  private sandbox: NetworkSandbox;

  constructor(sandbox?: NetworkSandbox) {
    this.sandbox = sandbox ?? NetworkSandbox.getInstance();
  }

  /** Get or create singleton instance */
  static getInstance(sandbox?: NetworkSandbox): NetworkPolicyManager {
    if (!NetworkPolicyManager.instance) {
      NetworkPolicyManager.instance = new NetworkPolicyManager(sandbox);
    }
    return NetworkPolicyManager.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    NetworkPolicyManager.instance = null;
  }

  // ─── Configuration ────────────────────────────────────────────

  /** Get the current global preset */
  getGlobalPreset(): NetworkPolicyPreset {
    return this.globalPreset;
  }

  /** Set the global policy preset */
  setGlobalPreset(preset: NetworkPolicyPreset, strictAllowlist?: string[]): void {
    this.globalPreset = preset;
    this.applyMergedPolicy(strictAllowlist);
  }

  /** Get the currently loaded project config (null if none) */
  getProjectConfig(): ProjectNetworkPolicyConfig | null {
    return this.projectConfig;
  }

  /** Get the current project directory */
  getProjectDir(): string | null {
    return this.projectDir;
  }

  /** Get the underlying sandbox instance */
  getSandbox(): NetworkSandbox {
    return this.sandbox;
  }

  // ─── Project Policy Loading ───────────────────────────────────

  /**
   * Load and apply the project-level policy from the given project directory.
   * If a `.neuronest/network-policy.json` file exists, it is merged with the
   * global policy. If not found or disabled, only the global policy applies.
   *
   * This should be called when:
   * - A project is opened
   * - The project policy file is modified
   * - The user changes the global preset
   */
  loadProjectPolicy(projectDir: string): PolicyLoadResult {
    this.projectDir = projectDir;

    const result = loadProjectPolicy(projectDir);

    if (result.success && result.policy) {
      // Check if project policy is disabled
      if (result.policy.enabled === false) {
        this.projectConfig = null;
        this.applyMergedPolicy();
        return { ...result, success: true, error: 'Project policy is disabled' };
      }

      this.projectConfig = result.policy;
      this.applyMergedPolicy();
    } else {
      // No project policy — use global only
      this.projectConfig = null;
      this.applyMergedPolicy();
    }

    return result;
  }

  /**
   * Unload the current project policy (e.g., when project is closed).
   * Reverts to global-only policy.
   */
  unloadProjectPolicy(): void {
    this.projectDir = null;
    this.projectConfig = null;
    this.applyMergedPolicy();
  }

  /**
   * Reload the project policy from disk (after file change detection).
   */
  reloadProjectPolicy(): PolicyLoadResult {
    if (!this.projectDir) {
      return { success: false, error: 'No project directory set' };
    }
    return this.loadProjectPolicy(this.projectDir);
  }

  // ─── Policy Application (Layer 8 Integration) ─────────────────

  /**
   * Apply the merged policy (global + project override) to the sandbox.
   * This is the Layer 8 enforcement point: after content scanning (layers 1–7),
   * but before any external request leaves the process.
   */
  private applyMergedPolicy(strictAllowlist?: string[]): void {
    const globalPolicy = getPresetPolicy(this.globalPreset, strictAllowlist);

    if (this.projectConfig) {
      const merged = mergePolicies(globalPolicy, this.projectConfig);
      this.sandbox.setPolicy(merged.policy);
    } else {
      this.sandbox.setPolicy(globalPolicy);
    }
  }

  /**
   * Get the current effective (merged) policy being enforced.
   */
  getEffectivePolicy(): NetworkPolicy {
    return this.sandbox.getPolicy();
  }

  /**
   * Get a summary of what the project policy overrides relative to global.
   * Useful for UI display showing which rules come from the project config.
   */
  getMergeInfo(): MergedPolicyResult {
    const globalPolicy = getPresetPolicy(this.globalPreset);

    if (!this.projectConfig) {
      return { policy: globalPolicy, source: 'global', projectOverrides: [] };
    }

    return mergePolicies(globalPolicy, this.projectConfig);
  }

  // ─── Layer 8 Security Model Hook ─────────────────────────────

  /**
   * Security layer metadata for integration with the multi-layer security model.
   * This identifies the NetworkPolicyManager as Layer 8 — Network Access Control.
   *
   * Execution order:
   *   1. Input Validation
   *   2. Content Scanning
   *   3. Prompt Injection Detection
   *   4. Secrets Detection
   *   5. Action Risk Classification
   *   6. Permission Enforcement
   *   7. Firewall Evaluation
   *   8. Network Access Control ← (this layer)
   */
  static readonly LAYER_INFO = {
    layer: NETWORK_POLICY_LAYER,
    name: 'Network Access Control',
    description: 'Policy-based network access control for agent operations',
    executesAfter: SecurityLayer.FirewallEvaluation,
    executesBefore: 'external-request',
  } as const;

  /**
   * Validate that a request is allowed through Layer 8.
   * Should be called after all prior security layers have passed.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @returns Whether the request is permitted
   */
  validateRequest(method: string, url: string): { allowed: boolean; reason: string } {
    const result = this.sandbox.evaluateRequest(method, url);
    return { allowed: result.allowed, reason: result.reason };
  }
}
