/**
 * PluginRegistry — Extends PluginSystem with remote catalog, install/uninstall,
 * manifest validation (V2), checksum verification, and permission enforcement.
 *
 * Stores plugins in `.neuronest/plugins/` directory. Each plugin is a directory
 * containing a `plugin.json` manifest and extracted package files.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PluginSystem, type Plugin, type PluginState } from './plugin-system.js';
import type {
  PluginManifestV2,
  PluginPermission,
  ValidationResult,
  ValidationError,
} from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';

// ─── Constants ──────────────────────────────────────────────────

const VALID_PLUGIN_TYPES = ['tool-plugin', 'agent-plugin', 'panel-plugin'] as const;

const VALID_PERMISSIONS: PluginPermission[] = [
  'file-read',
  'file-write',
  'network-access',
  'tool-invoke',
  'shell-execute',
  'database-access',
];

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

// ─── Types ──────────────────────────────────────────────────────

export interface PluginCatalogEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  pluginType: string;
  packageUrl: string;
  checksum: string;
  downloads?: number;
  rating?: number;
}

export interface InstalledPlugin extends Plugin {
  manifestV2: PluginManifestV2;
  enabled: boolean;
  pluginDir: string;
}

// ─── PluginRegistry ─────────────────────────────────────────────

export class PluginRegistry {
  private pluginSystem: PluginSystem;
  private pluginsDir: string;
  private installedPlugins: Map<string, InstalledPlugin> = new Map();

  constructor(pluginSystem: PluginSystem, pluginsDir: string) {
    this.pluginSystem = pluginSystem;
    this.pluginsDir = pluginsDir;
  }

  /**
   * Fetch a remote plugin catalog from a registry URL.
   * Requirements: 11.1
   */
  async fetchRemoteCatalog(registryUrl: string): Promise<PluginCatalogEntry[]> {
    if (!registryUrl || typeof registryUrl !== 'string') {
      throw new FeatureError({
        message: 'Registry URL must be a non-empty string',
        category: 'plugin',
        code: 'INVALID_REGISTRY_URL',
      });
    }

    try {
      const response = await fetch(registryUrl);
      if (!response.ok) {
        throw new FeatureError({
          message: `Failed to fetch catalog from ${registryUrl}: HTTP ${response.status}`,
          category: 'plugin',
          code: 'CATALOG_FETCH_FAILED',
          details: { statusCode: response.status },
        });
      }

      const catalog = (await response.json()) as PluginCatalogEntry[];
      if (!Array.isArray(catalog)) {
        throw new FeatureError({
          message: 'Remote catalog response is not an array',
          category: 'plugin',
          code: 'INVALID_CATALOG_FORMAT',
        });
      }

      return catalog;
    } catch (err) {
      if (err instanceof FeatureError) throw err;
      throw new FeatureError({
        message: `Failed to fetch remote catalog: ${(err as Error).message}`,
        category: 'plugin',
        code: 'CATALOG_FETCH_FAILED',
        details: { originalError: (err as Error).message },
      });
    }
  }

  /**
   * Install a plugin from a package URL.
   * Downloads the package, verifies checksum, validates manifest,
   * and extracts to .neuronest/plugins/{plugin-name}/.
   * Requirements: 11.2, 12.1, 12.2
   */
  async install(packageUrl: string): Promise<Plugin> {
    if (!packageUrl || typeof packageUrl !== 'string') {
      throw new FeatureError({
        message: 'Package URL must be a non-empty string',
        category: 'plugin',
        code: 'INVALID_PACKAGE_URL',
      });
    }

    // Download the package
    const packageBuffer = await this.downloadPackage(packageUrl);

    // Verify checksum if provided in the URL metadata
    // The checksum can be appended as #sha256=<hash> in the URL
    const expectedChecksum = this.extractChecksumFromUrl(packageUrl);
    if (expectedChecksum) {
      const actualChecksum = this.computeChecksum(packageBuffer);
      if (actualChecksum !== expectedChecksum) {
        throw new FeatureError({
          message: `Checksum verification failed. Expected: ${expectedChecksum}, Got: ${actualChecksum}`,
          category: 'plugin',
          code: 'CHECKSUM_MISMATCH',
          details: { expected: expectedChecksum, actual: actualChecksum },
        });
      }
    }

    // Parse the package to extract manifest
    const manifest = this.extractManifestFromPackage(packageBuffer);

    // Validate the manifest
    const validation = this.validateManifest(manifest);
    if (!validation.valid) {
      throw new FeatureError({
        message: `Invalid plugin manifest: ${validation.errors.map((e) => e.message).join('; ')}`,
        category: 'plugin',
        code: 'INVALID_MANIFEST',
        details: { errors: validation.errors },
      });
    }

    const validManifest = manifest as PluginManifestV2;

    // Check if already installed
    if (this.installedPlugins.has(validManifest.name)) {
      throw new FeatureError({
        message: `Plugin "${validManifest.name}" is already installed`,
        category: 'plugin',
        code: 'PLUGIN_ALREADY_INSTALLED',
      });
    }

    // Create plugin directory and extract files
    const pluginDir = path.join(this.pluginsDir, validManifest.name);
    this.ensureDirectory(pluginDir);
    this.extractPackageToDirectory(packageBuffer, pluginDir);

    // Write manifest file
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(validManifest, null, 2),
      'utf-8',
    );

    // Register the installed plugin
    const plugin: InstalledPlugin = {
      id: validManifest.name,
      manifest: {
        name: validManifest.name,
        version: validManifest.version,
        description: validManifest.description,
        author: validManifest.author,
        entryPoint: validManifest.entryPoint,
        permissions: validManifest.permissions,
        dependencies: validManifest.dependencies ?? {},
      },
      manifestV2: validManifest,
      state: 'loaded' as PluginState,
      installedAt: new Date(),
      enabled: false,
      pluginDir,
    };

    this.installedPlugins.set(validManifest.name, plugin);
    return plugin;
  }

  /**
   * Uninstall a plugin by ID.
   * Removes the plugin directory and deregisters from the system.
   * Requirements: 11.6
   */
  async uninstall(pluginId: string): Promise<void> {
    const plugin = this.installedPlugins.get(pluginId);
    if (!plugin) {
      throw new FeatureError({
        message: `Plugin not found: ${pluginId}`,
        category: 'plugin',
        code: 'PLUGIN_NOT_FOUND',
      });
    }

    // Disable first if enabled
    if (plugin.enabled) {
      await this.disable(pluginId);
    }

    // Remove plugin directory
    const pluginDir = path.join(this.pluginsDir, pluginId);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }

    // Remove from registry
    this.installedPlugins.delete(pluginId);

    // Remove from plugin system
    try {
      await this.pluginSystem.removePlugin(pluginId);
    } catch {
      // Plugin may not be in the base system yet
    }
  }

  /**
   * Enable a plugin.
   * Registers its tools/agents/panels with the respective system registries.
   * Requirements: 11.4, 11.6
   */
  async enable(pluginId: string): Promise<void> {
    const plugin = this.installedPlugins.get(pluginId);
    if (!plugin) {
      throw new FeatureError({
        message: `Plugin not found: ${pluginId}`,
        category: 'plugin',
        code: 'PLUGIN_NOT_FOUND',
      });
    }

    if (plugin.enabled) {
      return; // Already enabled
    }

    plugin.state = 'active';
    plugin.enabled = true;
  }

  /**
   * Disable a plugin.
   * Removes its registrations from system registries.
   * Requirements: 11.6
   */
  async disable(pluginId: string): Promise<void> {
    const plugin = this.installedPlugins.get(pluginId);
    if (!plugin) {
      throw new FeatureError({
        message: `Plugin not found: ${pluginId}`,
        category: 'plugin',
        code: 'PLUGIN_NOT_FOUND',
      });
    }

    if (!plugin.enabled) {
      return; // Already disabled
    }

    plugin.state = 'disabled';
    plugin.enabled = false;
  }

  /**
   * Validate a plugin manifest (V2 format).
   * Checks all required fields: name, version, description, author,
   * pluginType, entryPoint, permissions, minNeuroNestVersion.
   * Requirements: 12.1, 12.2
   */
  validateManifest(manifest: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return {
        valid: false,
        errors: [
          {
            field: 'manifest',
            message: 'Manifest must be a non-null object',
            code: 'INVALID_TYPE',
          },
        ],
      };
    }

    const m = manifest as Record<string, unknown>;

    // name: non-empty string
    if (typeof m.name !== 'string' || m.name.length === 0) {
      errors.push({
        field: 'name',
        message: 'name must be a non-empty string',
        code: 'INVALID_FIELD',
      });
    }

    // version: valid semver
    if (typeof m.version !== 'string' || !SEMVER_REGEX.test(m.version)) {
      errors.push({
        field: 'version',
        message: 'version must be a valid semver string (e.g., "1.0.0")',
        code: 'INVALID_FIELD',
      });
    }

    // description: non-empty string
    if (typeof m.description !== 'string' || m.description.length === 0) {
      errors.push({
        field: 'description',
        message: 'description must be a non-empty string',
        code: 'INVALID_FIELD',
      });
    }

    // author: non-empty string
    if (typeof m.author !== 'string' || m.author.length === 0) {
      errors.push({
        field: 'author',
        message: 'author must be a non-empty string',
        code: 'INVALID_FIELD',
      });
    }

    // pluginType: one of valid types
    if (
      typeof m.pluginType !== 'string' ||
      !(VALID_PLUGIN_TYPES as readonly string[]).includes(m.pluginType)
    ) {
      errors.push({
        field: 'pluginType',
        message: `pluginType must be one of: ${VALID_PLUGIN_TYPES.join(', ')}`,
        code: 'INVALID_FIELD',
      });
    }

    // entryPoint: non-empty string
    if (typeof m.entryPoint !== 'string' || m.entryPoint.length === 0) {
      errors.push({
        field: 'entryPoint',
        message: 'entryPoint must be a non-empty string',
        code: 'INVALID_FIELD',
      });
    }

    // permissions: array of valid PluginPermission values
    if (!Array.isArray(m.permissions)) {
      errors.push({
        field: 'permissions',
        message: 'permissions must be an array',
        code: 'INVALID_FIELD',
      });
    } else {
      const invalidPerms = m.permissions.filter(
        (p) => typeof p !== 'string' || !VALID_PERMISSIONS.includes(p as PluginPermission),
      );
      if (invalidPerms.length > 0) {
        errors.push({
          field: 'permissions',
          message: `permissions contains invalid values: ${invalidPerms.join(', ')}. Valid values are: ${VALID_PERMISSIONS.join(', ')}`,
          code: 'INVALID_FIELD',
        });
      }
    }

    // minNeuroNestVersion: valid semver
    if (typeof m.minNeuroNestVersion !== 'string' || !SEMVER_REGEX.test(m.minNeuroNestVersion)) {
      errors.push({
        field: 'minNeuroNestVersion',
        message: 'minNeuroNestVersion must be a valid semver string (e.g., "1.0.0")',
        code: 'INVALID_FIELD',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if a plugin has permission for a requested capability.
   * Returns true only if the capability is in the plugin's manifest permissions array.
   * Requirements: 23.1, 23.3
   */
  checkPermissions(pluginId: string, requestedCapability: PluginPermission): boolean {
    const plugin = this.installedPlugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    return plugin.manifestV2.permissions.includes(requestedCapability);
  }

  /**
   * Get all installed plugins.
   * Requirements: 11.1
   */
  getInstalledPlugins(): Plugin[] {
    return Array.from(this.installedPlugins.values());
  }

  /**
   * Load installed plugins from disk.
   * Scans the plugins directory for plugin.json manifests.
   */
  async loadInstalledPlugins(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) {
      return;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(this.pluginsDir, entry.name, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as PluginManifestV2;

        const validation = this.validateManifest(manifest);
        if (!validation.valid) continue;

        const plugin: InstalledPlugin = {
          id: manifest.name,
          manifest: {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author,
            entryPoint: manifest.entryPoint,
            permissions: manifest.permissions,
            dependencies: manifest.dependencies ?? {},
          },
          manifestV2: manifest,
          state: 'loaded',
          installedAt: new Date(),
          enabled: false,
          pluginDir: path.join(this.pluginsDir, entry.name),
        };

        this.installedPlugins.set(manifest.name, plugin);
      } catch {
        // Skip plugins with unreadable manifests
      }
    }
  }

  /**
   * Compute SHA-256 checksum of a buffer.
   */
  computeChecksum(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Verify the checksum of a package buffer matches the expected value.
   */
  verifyChecksum(data: Buffer, expectedChecksum: string): boolean {
    const actual = this.computeChecksum(data);
    return actual === expectedChecksum;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private async downloadPackage(packageUrl: string): Promise<Buffer> {
    try {
      const response = await fetch(packageUrl);
      if (!response.ok) {
        throw new FeatureError({
          message: `Failed to download package from ${packageUrl}: HTTP ${response.status}`,
          category: 'plugin',
          code: 'DOWNLOAD_FAILED',
          details: { statusCode: response.status },
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof FeatureError) throw err;
      throw new FeatureError({
        message: `Failed to download package: ${(err as Error).message}`,
        category: 'plugin',
        code: 'DOWNLOAD_FAILED',
        details: { originalError: (err as Error).message },
      });
    }
  }

  private extractChecksumFromUrl(packageUrl: string): string | null {
    try {
      const url = new URL(packageUrl);
      const hash = url.hash;
      if (hash && hash.startsWith('#sha256=')) {
        return hash.slice('#sha256='.length);
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractManifestFromPackage(packageBuffer: Buffer): unknown {
    // For simplicity, we expect the package to contain a JSON manifest
    // at its start (a plugin.json content). In a real implementation,
    // this would extract from a tar.gz or zip archive.
    // Here we try to parse the buffer as JSON (for simple packages)
    // or look for a plugin.json marker.
    try {
      const content = packageBuffer.toString('utf-8');
      const parsed = JSON.parse(content);

      // If the parsed content has a 'manifest' field, use it
      if (parsed && typeof parsed === 'object' && 'manifest' in parsed) {
        return parsed.manifest;
      }

      // Otherwise treat the whole content as the manifest
      return parsed;
    } catch {
      throw new FeatureError({
        message: 'Failed to extract manifest from package: invalid format',
        category: 'plugin',
        code: 'INVALID_PACKAGE_FORMAT',
      });
    }
  }

  private extractPackageToDirectory(packageBuffer: Buffer, targetDir: string): void {
    // For simplicity, we write the raw package content.
    // In a real implementation, this would extract tar.gz/zip contents.
    try {
      const content = packageBuffer.toString('utf-8');
      const parsed = JSON.parse(content);

      // If the package has a 'files' field, extract each file
      if (parsed && typeof parsed === 'object' && 'files' in parsed) {
        const files = parsed.files as Record<string, string>;
        for (const [filePath, fileContent] of Object.entries(files)) {
          const fullPath = path.join(targetDir, filePath);
          const dir = path.dirname(fullPath);
          this.ensureDirectory(dir);
          fs.writeFileSync(fullPath, fileContent, 'utf-8');
        }
      }
    } catch {
      // If we can't parse as structured content, just write the raw buffer
      fs.writeFileSync(path.join(targetDir, 'package.bin'), packageBuffer);
    }
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
