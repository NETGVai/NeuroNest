/**
 * PluginManifest — Dedicated manifest schema definition and validation
 * for the `neuronest-plugin.json` plugin manifest format.
 *
 * Defines the structure every plugin must declare:
 * - name, version, entry point
 * - capabilities array (agents, providers, tools, panels, commands)
 * - minimum NeuroNest version compatibility
 * - permissions and dependencies
 *
 * Requirements: 21.1, 21.6
 */

// ─── Constants ──────────────────────────────────────────────────

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

/** Current NeuroNest version for compatibility checks */
const NEURONEST_VERSION = '1.0.0';

/** Valid plugin capability types */
export const PLUGIN_CAPABILITIES = [
  'agents',
  'providers',
  'tools',
  'panels',
  'commands',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** Valid plugin permissions */
export const PLUGIN_PERMISSIONS = [
  'file-read',
  'file-write',
  'network-access',
  'tool-invoke',
  'shell-execute',
  'database-access',
] as const;

export type ManifestPermission = (typeof PLUGIN_PERMISSIONS)[number];

// ─── Manifest Schema ────────────────────────────────────────────

/**
 * The `neuronest-plugin.json` manifest schema.
 *
 * Every plugin must provide this file at its root directory.
 */
export interface PluginManifestSchema {
  /** Unique plugin identifier (kebab-case) */
  name: string;

  /** SemVer version string */
  version: string;

  /** Human-readable description */
  description: string;

  /** Author name or organization */
  author: string;

  /** Relative path to the plugin entry point module */
  entryPoint: string;

  /** Capabilities this plugin registers */
  capabilities: PluginCapability[];

  /** Permissions the plugin requires */
  permissions: ManifestPermission[];

  /** Minimum compatible NeuroNest version (semver) */
  minNeuroNestVersion: string;

  /** Optional: npm-style dependency map */
  dependencies?: Record<string, string>;

  /** Optional: Plugin homepage or repository URL */
  homepage?: string;

  /** Optional: License identifier (SPDX) */
  license?: string;

  /** Optional: Keywords for discovery */
  keywords?: string[];
}

// ─── Validation Result ──────────────────────────────────────────

export interface ManifestValidationError {
  field: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
  compatible: boolean;
}

// ─── SemVer Comparison ──────────────────────────────────────────

/**
 * Parse a semver string into its numeric parts.
 * Returns null if the string is not a valid semver.
 */
function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * Check if `current` satisfies the minimum version requirement.
 * Returns true if current >= minimum.
 */
function isVersionCompatible(current: string, minimum: string): boolean {
  const cur = parseSemver(current);
  const min = parseSemver(minimum);
  if (!cur || !min) return false;

  if (cur[0] !== min[0]) return cur[0] > min[0];
  if (cur[1] !== min[1]) return cur[1] > min[1];
  return cur[2] >= min[2];
}

// ─── Validation Function ────────────────────────────────────────

/**
 * Validate a plugin manifest object against the `neuronest-plugin.json` schema.
 *
 * Checks:
 * - All required fields are present and correctly typed
 * - Version strings are valid semver
 * - Capabilities are from the allowed set
 * - Permissions are from the allowed set
 * - Minimum NeuroNest version compatibility is satisfied
 *
 * Requirements: 21.1, 21.6
 */
export function validatePluginManifest(manifest: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: [{ field: 'manifest', message: 'Manifest must be a non-null object' }],
      compatible: false,
    };
  }

  const m = manifest as Record<string, unknown>;

  // name: non-empty kebab-case string
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push({ field: 'name', message: 'name is required and must be a non-empty string' });
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name)) {
    errors.push({ field: 'name', message: 'name must be kebab-case (e.g., "my-plugin")' });
  }

  // version: valid semver
  if (typeof m.version !== 'string' || !SEMVER_REGEX.test(m.version)) {
    errors.push({ field: 'version', message: 'version must be a valid semver string (e.g., "1.0.0")' });
  }

  // description: non-empty string
  if (typeof m.description !== 'string' || m.description.length === 0) {
    errors.push({ field: 'description', message: 'description is required and must be a non-empty string' });
  }

  // author: non-empty string
  if (typeof m.author !== 'string' || m.author.length === 0) {
    errors.push({ field: 'author', message: 'author is required and must be a non-empty string' });
  }

  // entryPoint: non-empty string
  if (typeof m.entryPoint !== 'string' || m.entryPoint.length === 0) {
    errors.push({ field: 'entryPoint', message: 'entryPoint is required and must be a non-empty string' });
  }

  // capabilities: array of valid capability values
  if (!Array.isArray(m.capabilities)) {
    errors.push({ field: 'capabilities', message: 'capabilities must be an array' });
  } else if (m.capabilities.length === 0) {
    errors.push({ field: 'capabilities', message: 'capabilities must contain at least one capability' });
  } else {
    const invalidCaps = m.capabilities.filter(
      (c) => typeof c !== 'string' || !(PLUGIN_CAPABILITIES as readonly string[]).includes(c),
    );
    if (invalidCaps.length > 0) {
      errors.push({
        field: 'capabilities',
        message: `Invalid capabilities: ${invalidCaps.join(', ')}. Valid: ${PLUGIN_CAPABILITIES.join(', ')}`,
      });
    }
  }

  // permissions: array of valid permission values
  if (!Array.isArray(m.permissions)) {
    errors.push({ field: 'permissions', message: 'permissions must be an array' });
  } else {
    const invalidPerms = m.permissions.filter(
      (p) => typeof p !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p),
    );
    if (invalidPerms.length > 0) {
      errors.push({
        field: 'permissions',
        message: `Invalid permissions: ${invalidPerms.join(', ')}. Valid: ${PLUGIN_PERMISSIONS.join(', ')}`,
      });
    }
  }

  // minNeuroNestVersion: valid semver
  let compatible = true;
  if (typeof m.minNeuroNestVersion !== 'string' || !SEMVER_REGEX.test(m.minNeuroNestVersion)) {
    errors.push({
      field: 'minNeuroNestVersion',
      message: 'minNeuroNestVersion must be a valid semver string (e.g., "1.0.0")',
    });
    compatible = false;
  } else {
    compatible = isVersionCompatible(NEURONEST_VERSION, m.minNeuroNestVersion);
    if (!compatible) {
      errors.push({
        field: 'minNeuroNestVersion',
        message: `Plugin requires NeuroNest >= ${m.minNeuroNestVersion}, current is ${NEURONEST_VERSION}`,
      });
    }
  }

  // dependencies: optional, must be object if present
  if (m.dependencies !== undefined) {
    if (typeof m.dependencies !== 'object' || Array.isArray(m.dependencies) || m.dependencies === null) {
      errors.push({ field: 'dependencies', message: 'dependencies must be an object mapping names to version ranges' });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    compatible,
  };
}

/**
 * Get the current NeuroNest version used for compatibility checks.
 */
export function getCurrentNeuroNestVersion(): string {
  return NEURONEST_VERSION;
}
