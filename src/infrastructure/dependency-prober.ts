/**
 * DependencyProber — Graceful degradation for optional dependencies.
 *
 * Probes for the availability of optional dependencies (ONNX vision model,
 * WebContainer runtime, installed plugins) and records their status.
 * Disables features requiring unavailable dependencies and provides
 * installation instructions. Persists a dependency manifest at
 * `.neuronest/dependencies.json`.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OptionalDependency } from '../shared/feature-integration-types.js';

// ─── Dependency Definitions ─────────────────────────────────────

/**
 * Static registry of known optional dependencies and the features
 * that depend on them.
 */
export interface DependencyDefinition {
  id: string;
  name: string;
  requiredVersion: string;
  downloadUrl: string;
  features: string[];
  /** Function to probe whether the dependency is available. */
  probe: () => Promise<ProbeResult>;
  /** Human-readable installation instructions. */
  installInstructions: string;
}

export interface ProbeResult {
  status: 'available' | 'unavailable' | 'outdated';
  currentVersion?: string;
}

/**
 * Mapping from feature IDs to the dependency IDs required for that feature.
 */
export interface FeatureDependencyMap {
  [featureId: string]: string[];
}

// ─── Default Dependency Definitions ─────────────────────────────

/**
 * Probe for ONNX vision model files on disk.
 * Checks whether the model file exists in the expected location.
 */
async function probeOnnxVisionModel(): Promise<ProbeResult> {
  // Check common model file locations
  const modelPaths = [
    path.join(process.cwd(), 'assets', 'voice-models', 'onnx', 'tts.json'),
    path.join(process.cwd(), 'assets', 'vision-models', 'ui-detect.onnx'),
  ];

  // Check if onnxruntime-node is importable
  try {
    require.resolve('onnxruntime-node');
  } catch {
    return { status: 'unavailable' };
  }

  // Check for a vision-specific model file
  const visionModelPath = path.join(process.cwd(), 'assets', 'vision-models', 'ui-detect.onnx');
  if (fs.existsSync(visionModelPath)) {
    return { status: 'available', currentVersion: '1.0.0' };
  }

  // ONNX runtime is available but vision model is not downloaded
  return { status: 'unavailable' };
}

/**
 * Probe for WebContainer runtime availability.
 * WebContainer is an optional npm package (@webcontainer/api).
 */
async function probeWebContainerRuntime(): Promise<ProbeResult> {
  try {
    require.resolve('@webcontainer/api');
    return { status: 'available', currentVersion: '1.0.0' };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Probe for installed plugins in the .neuronest/plugins/ directory.
 */
async function probeInstalledPlugins(): Promise<ProbeResult> {
  const pluginsDir = path.join(process.cwd(), '.neuronest', 'plugins');

  if (!fs.existsSync(pluginsDir)) {
    return { status: 'available', currentVersion: '0.0.0' };
  }

  try {
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const pluginDirs = entries.filter((e) => e.isDirectory());
    return {
      status: 'available',
      currentVersion: `${pluginDirs.length} plugins`,
    };
  } catch {
    return { status: 'available', currentVersion: '0 plugins' };
  }
}

// ─── Default Definitions ────────────────────────────────────────

const DEFAULT_DEPENDENCIES: DependencyDefinition[] = [
  {
    id: 'onnx-vision-model',
    name: 'ONNX Vision Model',
    requiredVersion: '1.0.0',
    downloadUrl: 'https://github.com/nicehash/onnx-models/releases/download/v1.0/ui-detect.onnx',
    features: ['vision-screenshot-analysis', 'vision-diagram-recognition', 'vision-diff-comparison'],
    probe: probeOnnxVisionModel,
    installInstructions:
      'Download the UI detection model to assets/vision-models/ui-detect.onnx. ' +
      'Ensure onnxruntime-node is installed: npm install onnxruntime-node',
  },
  {
    id: 'webcontainer-runtime',
    name: 'WebContainer Runtime',
    requiredVersion: '1.0.0',
    downloadUrl: 'https://www.npmjs.com/package/@webcontainer/api',
    features: ['sandbox-app-execution', 'sandbox-live-preview', 'prompt-to-app'],
    probe: probeWebContainerRuntime,
    installInstructions:
      'Install the WebContainer API package: npm install @webcontainer/api',
  },
  {
    id: 'plugin-system',
    name: 'Plugin System',
    requiredVersion: '1.0.0',
    downloadUrl: '',
    features: ['plugin-registry', 'plugin-lifecycle', 'processing-nodes'],
    probe: probeInstalledPlugins,
    installInstructions:
      'The plugin system is built-in. Create plugins in .neuronest/plugins/ directory.',
  },
];

/**
 * Default feature → dependency mapping.
 * Maps feature IDs to the dependency IDs required for that feature.
 */
const DEFAULT_FEATURE_MAP: FeatureDependencyMap = {
  'vision-screenshot-analysis': ['onnx-vision-model'],
  'vision-diagram-recognition': ['onnx-vision-model'],
  'vision-diff-comparison': ['onnx-vision-model'],
  'sandbox-app-execution': ['webcontainer-runtime'],
  'sandbox-live-preview': ['webcontainer-runtime'],
  'prompt-to-app': ['webcontainer-runtime'],
  'plugin-registry': ['plugin-system'],
  'plugin-lifecycle': ['plugin-system'],
  'processing-nodes': ['plugin-system'],
};

// ─── DependencyProber ───────────────────────────────────────────

export class DependencyProber {
  private readonly definitions: DependencyDefinition[];
  private readonly featureMap: FeatureDependencyMap;
  private readonly manifestPath: string;

  /** In-memory cache of dependency statuses. */
  private statusCache: Map<string, OptionalDependency> = new Map();

  constructor(options?: {
    definitions?: DependencyDefinition[];
    featureMap?: FeatureDependencyMap;
    manifestPath?: string;
  }) {
    this.definitions = options?.definitions ?? DEFAULT_DEPENDENCIES;
    this.featureMap = options?.featureMap ?? DEFAULT_FEATURE_MAP;
    this.manifestPath =
      options?.manifestPath ??
      path.join(process.cwd(), '.neuronest', 'dependencies.json');

    // Load persisted manifest if available
    this.loadManifest();
  }

  /**
   * Probe all known optional dependencies and update the manifest.
   * Returns the complete list of dependency statuses.
   */
  async probeAll(): Promise<OptionalDependency[]> {
    const results: OptionalDependency[] = [];

    for (const def of this.definitions) {
      const result = await this.probeSingle(def);
      results.push(result);
    }

    this.persistManifest();
    return results;
  }

  /**
   * Probe a single dependency by ID.
   * Throws if the dependency ID is not recognized.
   */
  async probe(dependencyId: string): Promise<OptionalDependency> {
    const def = this.definitions.find((d) => d.id === dependencyId);
    if (!def) {
      throw new Error(`Unknown dependency: ${dependencyId}`);
    }

    const result = await this.probeSingle(def);
    this.persistManifest();
    return result;
  }

  /**
   * Get the current cached status of all dependencies.
   * Returns a map from dependency ID to its status object.
   * Does NOT re-probe; call probeAll() first for fresh data.
   */
  getStatus(): Record<string, OptionalDependency> {
    const result: Record<string, OptionalDependency> = {};
    for (const [id, dep] of this.statusCache) {
      result[id] = dep;
    }
    return result;
  }

  /**
   * Check whether a feature is available based on the status of its
   * required dependencies. A feature is available if and only if ALL
   * of its required dependencies have status 'available'.
   *
   * Returns false if the feature ID is not recognized (unknown features
   * are treated as unavailable).
   */
  isFeatureAvailable(featureId: string): boolean {
    const requiredDeps = this.featureMap[featureId];
    if (!requiredDeps || requiredDeps.length === 0) {
      // Unknown feature or no dependencies declared — treat as unavailable
      return false;
    }

    return requiredDeps.every((depId) => {
      const dep = this.statusCache.get(depId);
      return dep !== undefined && dep.status === 'available';
    });
  }

  /**
   * Get installation instructions for a specific dependency.
   * Useful when a user attempts to use a feature with a missing dep.
   */
  getInstallInstructions(dependencyId: string): string | null {
    const def = this.definitions.find((d) => d.id === dependencyId);
    return def?.installInstructions ?? null;
  }

  /**
   * Get all dependencies required by a feature.
   */
  getFeatureDependencies(featureId: string): OptionalDependency[] {
    const depIds = this.featureMap[featureId] ?? [];
    return depIds
      .map((id) => this.statusCache.get(id))
      .filter((d): d is OptionalDependency => d !== undefined);
  }

  /**
   * Get a human-readable status summary for the settings panel.
   * Returns an array of indicator objects for display.
   */
  getSettingsPanelIndicators(): DependencyIndicator[] {
    const indicators: DependencyIndicator[] = [];

    for (const def of this.definitions) {
      const cached = this.statusCache.get(def.id);
      const status = cached?.status ?? 'unavailable';

      indicators.push({
        id: def.id,
        name: def.name,
        status,
        currentVersion: cached?.currentVersion,
        requiredVersion: def.requiredVersion,
        affectedFeatures: def.features,
        installInstructions: status !== 'available' ? def.installInstructions : undefined,
      });
    }

    return indicators;
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  /**
   * Probe a single dependency definition and update the cache.
   */
  private async probeSingle(def: DependencyDefinition): Promise<OptionalDependency> {
    let probeResult: ProbeResult;
    try {
      probeResult = await def.probe();
    } catch {
      probeResult = { status: 'unavailable' };
    }

    const dep: OptionalDependency = {
      id: def.id,
      name: def.name,
      status: probeResult.status,
      requiredVersion: def.requiredVersion,
      currentVersion: probeResult.currentVersion,
      downloadUrl: def.downloadUrl || undefined,
      features: [...def.features],
    };

    this.statusCache.set(def.id, dep);
    return dep;
  }

  /**
   * Persist the current dependency manifest to disk.
   */
  private persistManifest(): void {
    try {
      const dir = path.dirname(this.manifestPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const manifest = Array.from(this.statusCache.values());
      fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch {
      // Silently ignore write failures — manifest is best-effort
      // This allows the system to function even without write access
    }
  }

  /**
   * Load the dependency manifest from disk into the cache.
   * If the file doesn't exist or is invalid, starts with empty cache.
   */
  private loadManifest(): void {
    try {
      if (!fs.existsSync(this.manifestPath)) {
        return;
      }

      const content = fs.readFileSync(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        return;
      }

      for (const entry of parsed) {
        if (isValidOptionalDependency(entry)) {
          this.statusCache.set(entry.id, entry);
        }
      }
    } catch {
      // Invalid or missing manifest — start fresh
    }
  }
}

// ─── Settings Panel Types ───────────────────────────────────────

export interface DependencyIndicator {
  id: string;
  name: string;
  status: 'available' | 'unavailable' | 'outdated';
  currentVersion?: string;
  requiredVersion: string;
  affectedFeatures: string[];
  installInstructions?: string;
}

// ─── Validation Helper ──────────────────────────────────────────

/**
 * Type guard to validate that a parsed JSON object matches the
 * OptionalDependency interface shape.
 */
function isValidOptionalDependency(value: unknown): value is OptionalDependency {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return false;
  if (typeof obj.name !== 'string' || obj.name.length === 0) return false;
  if (!['available', 'unavailable', 'outdated'].includes(obj.status as string)) return false;
  if (typeof obj.requiredVersion !== 'string') return false;
  if (!Array.isArray(obj.features)) return false;

  return true;
}
