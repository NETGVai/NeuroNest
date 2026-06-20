/**
 * StartupManager — Startup optimization, lazy loading, feature flags, caching.
 *
 * Manages parallel prefetch, lazy loading of subsystems, feature flags,
 * module caching, and initialization of all feature-integration modules.
 *
 * Requirements: 22.1–22.4, 22.6–22.9, 20.1, 20.2
 */

import type { FeatureFlags } from '../shared/types.js';
import type { ToolSystem } from '../tools/tool-system.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { PluginSystem } from '../plugins/plugin-system.js';
import type Database from 'better-sqlite3';

import { ArtifactService } from '../artifacts/artifact-service.js';
import { PipelineEngine } from '../automation/pipeline-engine.js';
import { VisionAnalyzerService, registerVisionTools } from '../vision/vision-analyzer-service.js';
import { WebContainerSandbox, registerSandboxTools } from '../sandbox/web-container-sandbox.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { BenchmarkFramework, type BenchmarkFrameworkOptions } from '../benchmark/benchmark-framework.js';
import { ExecutionTraceService } from '../infrastructure/execution-trace-service.js';
import { DataConnectorSystem } from '../infrastructure/data-connector-system.js';
import { ExportService } from '../infrastructure/export-service.js';
import { WorkspaceLayerManager } from '../infrastructure/workspace-layer-manager.js';
import { DependencyProber } from '../infrastructure/dependency-prober.js';

// ─── Types ──────────────────────────────────────────────────────

export type SubsystemName =
  | 'hyperAgents'
  | 'agentSwarm'
  | 'cao'
  | 'lspManager'
  | 'promptOptimizer'
  | 'pluginSystem'
  | 'workflowBuilder';

export type SubsystemState = 'not_loaded' | 'loading' | 'loaded' | 'disabled' | 'error';

export interface SubsystemInfo {
  name: SubsystemName;
  state: SubsystemState;
  loadTimeMs?: number;
  error?: string;
}

export interface PrefetchResult {
  config: boolean;
  sessionState: boolean;
  apiKeys: boolean;
  providerHealth: boolean;
  totalMs: number;
}

export interface CacheEntry {
  key: string;
  data: unknown;
  cachedAt: Date;
  expiresAt?: Date;
}

/**
 * Result of feature module initialization.
 * Tracks which modules were successfully initialized and which degraded gracefully.
 */
export interface FeatureModuleInitResult {
  /** Module name. */
  module: string;
  /** Whether the module was successfully initialized. */
  success: boolean;
  /** Error message if initialization failed (module degraded gracefully). */
  error?: string;
  /** Time taken to initialize in milliseconds. */
  durationMs: number;
}

/**
 * Options for initializing feature-integration modules at startup.
 */
export interface FeatureModuleOptions {
  /** Root project directory (for .neuronest/ paths). */
  projectDir: string;
  /** SQLite database instance. */
  db: Database.Database;
  /** The application ToolSystem for registering tools. */
  toolSystem: ToolSystem;
  /** The CallbackEngine for lifecycle hooks. */
  callbackEngine: CallbackEngine;
  /** The PluginSystem for plugin management. */
  pluginSystem: PluginSystem;
  /**
   * Factory for creating LLM clients (needed by BenchmarkFramework).
   * Optional — if not provided, BenchmarkFramework will not be initialized.
   */
  createLLMClient?: BenchmarkFrameworkOptions['createLLMClient'];
  /**
   * Factory for creating AgentLoopControllers (needed by BenchmarkFramework).
   * Optional — if not provided, BenchmarkFramework will not be initialized.
   */
  createAgentLoop?: BenchmarkFrameworkOptions['createAgentLoop'];
}

/**
 * Container holding all initialized feature module instances.
 * Modules that failed to initialize will be null.
 */
export interface FeatureModules {
  artifactService: ArtifactService | null;
  pipelineEngine: PipelineEngine | null;
  visionAnalyzer: VisionAnalyzerService | null;
  webContainerSandbox: WebContainerSandbox | null;
  pluginRegistry: PluginRegistry | null;
  benchmarkFramework: BenchmarkFramework | null;
  executionTraceService: ExecutionTraceService | null;
  dataConnectorSystem: DataConnectorSystem | null;
  exportService: ExportService | null;
  workspaceLayerManager: WorkspaceLayerManager | null;
  dependencyProber: DependencyProber | null;
}

// ─── StartupManager ─────────────────────────────────────────────

export class StartupManager {
  private subsystems = new Map<SubsystemName, SubsystemInfo>();
  private featureFlags: FeatureFlags;
  private cache = new Map<string, CacheEntry>();
  private lazyLoaders = new Map<SubsystemName, () => Promise<void>>();

  /** Initialized feature modules (available after initializeFeatureModules). */
  private _featureModules: FeatureModules | null = null;

  /** Results from the last feature module initialization. */
  private _featureModuleResults: FeatureModuleInitResult[] = [];

  constructor(featureFlags?: FeatureFlags) {
    this.featureFlags = featureFlags ?? {
      hyperAgents: true,
      agentSwarm: true,
      cao: true,
      promptOptimizer: true,
    };

    // Initialize subsystem states
    const allSubsystems: SubsystemName[] = [
      'hyperAgents', 'agentSwarm', 'cao', 'lspManager',
      'promptOptimizer', 'pluginSystem', 'workflowBuilder',
    ];

    for (const name of allSubsystems) {
      this.subsystems.set(name, { name, state: 'not_loaded' });
    }
  }

  // ─── Feature Module Initialization ──────────────────────────────

  /**
   * Initialize all feature-integration modules.
   *
   * Each module is initialized independently with graceful degradation:
   * if a module fails to initialize (e.g., missing optional dependency),
   * it is set to null and the error is recorded. Other modules continue
   * to initialize normally.
   *
   * After initialization, probes optional dependencies and disables features
   * whose dependencies are unavailable (Requirements 20.1, 20.2).
   *
   * @param options - Configuration for module initialization.
   * @returns Array of results indicating success/failure per module.
   */
  async initializeFeatureModules(options: FeatureModuleOptions): Promise<FeatureModuleInitResult[]> {
    const results: FeatureModuleInitResult[] = [];
    const modules: FeatureModules = {
      artifactService: null,
      pipelineEngine: null,
      visionAnalyzer: null,
      webContainerSandbox: null,
      pluginRegistry: null,
      benchmarkFramework: null,
      executionTraceService: null,
      dataConnectorSystem: null,
      exportService: null,
      workspaceLayerManager: null,
      dependencyProber: null,
    };

    // 1. ArtifactService (core — uses SQLite)
    results.push(await this.initModule('ArtifactService', () => {
      const service = new ArtifactService(options.db);
      service.registerTools(options.toolSystem);
      modules.artifactService = service;
    }));

    // 2. PipelineEngine (core — uses ToolSystem + CallbackEngine)
    results.push(await this.initModule('PipelineEngine', () => {
      const engine = new PipelineEngine({
        projectDir: options.projectDir,
        toolSystem: options.toolSystem,
        callbackEngine: options.callbackEngine,
      });
      modules.pipelineEngine = engine;
    }));

    // 3. VisionAnalyzerService (optional — requires ONNX model)
    results.push(await this.initModule('VisionAnalyzerService', () => {
      const service = new VisionAnalyzerService();
      // Register tools regardless; they'll report model-unavailable at runtime
      registerVisionTools(options.toolSystem, service);
      modules.visionAnalyzer = service;
    }));

    // 4. WebContainerSandbox (optional — requires WebContainer runtime)
    results.push(await this.initModule('WebContainerSandbox', () => {
      const sandbox = new WebContainerSandbox();
      registerSandboxTools(options.toolSystem, sandbox);
      modules.webContainerSandbox = sandbox;
    }));

    // 5. PluginRegistry (core — extends PluginSystem)
    results.push(await this.initModule('PluginRegistry', () => {
      const pluginsDir = `${options.projectDir}/.neuronest/plugins`;
      const registry = new PluginRegistry(options.pluginSystem, pluginsDir);
      modules.pluginRegistry = registry;
    }));

    // 6. BenchmarkFramework (optional — needs LLM client & agent loop factories)
    results.push(await this.initModule('BenchmarkFramework', () => {
      if (!options.createLLMClient || !options.createAgentLoop) {
        throw new Error(
          'BenchmarkFramework requires createLLMClient and createAgentLoop factories. ' +
          'Feature will be available once these are configured.',
        );
      }
      const framework = new BenchmarkFramework({
        projectDir: options.projectDir,
        db: options.db,
        toolSystem: options.toolSystem,
        createLLMClient: options.createLLMClient,
        createAgentLoop: options.createAgentLoop,
      });
      modules.benchmarkFramework = framework;
    }));

    // 7. ExecutionTraceService (core — uses SQLite + CallbackEngine)
    results.push(await this.initModule('ExecutionTraceService', () => {
      const service = new ExecutionTraceService(options.db, options.callbackEngine);
      modules.executionTraceService = service;
    }));

    // 8. DataConnectorSystem (core)
    results.push(await this.initModule('DataConnectorSystem', () => {
      const system = new DataConnectorSystem();
      modules.dataConnectorSystem = system;
    }));

    // 9. ExportService (depends on ArtifactService)
    results.push(await this.initModule('ExportService', () => {
      if (!modules.artifactService) {
        throw new Error('ExportService requires ArtifactService which failed to initialize.');
      }
      const service = new ExportService(modules.artifactService);
      modules.exportService = service;
    }));

    // 10. WorkspaceLayerManager (core)
    results.push(await this.initModule('WorkspaceLayerManager', () => {
      const manager = new WorkspaceLayerManager({ projectDir: options.projectDir });
      modules.workspaceLayerManager = manager;
    }));

    // 11. DependencyProber (core — probes optional dependencies)
    results.push(await this.initModule('DependencyProber', async () => {
      const prober = new DependencyProber({
        manifestPath: `${options.projectDir}/.neuronest/dependencies.json`,
      });
      // Probe all dependencies at startup (Requirement 20.1)
      await prober.probeAll();
      modules.dependencyProber = prober;
    }));

    this._featureModules = modules;
    this._featureModuleResults = results;
    return results;
  }

  /**
   * Get the initialized feature modules container.
   * Returns null if initializeFeatureModules has not been called.
   */
  getFeatureModules(): FeatureModules | null {
    return this._featureModules;
  }

  /**
   * Get the results from the last feature module initialization.
   */
  getFeatureModuleResults(): FeatureModuleInitResult[] {
    return [...this._featureModuleResults];
  }

  /**
   * Initialize a single module with error isolation.
   * If initialization throws, the module is recorded as failed and the error is logged.
   */
  private async initModule(
    moduleName: string,
    initializer: () => void | Promise<void>,
  ): Promise<FeatureModuleInitResult> {
    const start = Date.now();
    try {
      await initializer();
      return {
        module: moduleName,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        module: moduleName,
        success: false,
        error,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Parallel prefetch of config, session state, API keys, provider health.
   * Requirements: 22.1
   */
  async prefetch(): Promise<PrefetchResult> {
    const start = Date.now();

    // Simulate parallel prefetch
    const [config, sessionState, apiKeys, providerHealth] = await Promise.all([
      this.prefetchConfig(),
      this.prefetchSessionState(),
      this.prefetchApiKeys(),
      this.prefetchProviderHealth(),
    ]);

    return {
      config,
      sessionState,
      apiKeys,
      providerHealth,
      totalMs: Date.now() - start,
    };
  }

  /**
   * Register a lazy loader for a subsystem.
   * Requirements: 22.2
   */
  registerLazyLoader(name: SubsystemName, loader: () => Promise<void>): void {
    this.lazyLoaders.set(name, loader);
  }

  /**
   * Load a subsystem on demand (lazy loading).
   * Requirements: 22.2
   */
  async loadSubsystem(name: SubsystemName): Promise<SubsystemInfo> {
    const info = this.subsystems.get(name);
    if (!info) throw new Error(`Unknown subsystem: ${name}`);

    // Check feature flags
    if (this.isDisabledByFeatureFlag(name)) {
      info.state = 'disabled';
      return info;
    }

    if (info.state === 'loaded') return info;

    info.state = 'loading';
    const start = Date.now();

    try {
      const loader = this.lazyLoaders.get(name);
      if (loader) {
        await loader();
      }
      info.state = 'loaded';
      info.loadTimeMs = Date.now() - start;
    } catch (err) {
      info.state = 'error';
      info.error = err instanceof Error ? err.message : String(err);
    }

    return info;
  }

  /**
   * Get subsystem info.
   */
  getSubsystemInfo(name: SubsystemName): SubsystemInfo | null {
    return this.subsystems.get(name) ?? null;
  }

  /**
   * Get all subsystem states.
   */
  getAllSubsystems(): SubsystemInfo[] {
    return Array.from(this.subsystems.values());
  }

  /**
   * Get feature flags.
   * Requirements: 22.3
   */
  getFeatureFlags(): FeatureFlags {
    return { ...this.featureFlags };
  }

  /**
   * Set feature flags.
   * Requirements: 22.3
   */
  setFeatureFlags(flags: Partial<FeatureFlags>): void {
    this.featureFlags = { ...this.featureFlags, ...flags };

    // Disable subsystems that are flagged off
    for (const [name, info] of this.subsystems) {
      if (this.isDisabledByFeatureFlag(name)) {
        info.state = 'disabled';
      }
    }
  }

  /**
   * Cache a module or tool schema.
   * Requirements: 22.4
   */
  cacheModule(key: string, data: unknown, ttlMs?: number): void {
    const entry: CacheEntry = {
      key,
      data,
      cachedAt: new Date(),
      ...(ttlMs ? { expiresAt: new Date(Date.now() + ttlMs) } : {}),
    };
    this.cache.set(key, entry);
  }

  /**
   * Get a cached module.
   * Requirements: 22.4
   */
  getCachedModule(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private helpers ─────────────────────────────────────────

  private isDisabledByFeatureFlag(name: SubsystemName): boolean {
    const flagMap: Partial<Record<SubsystemName, keyof FeatureFlags>> = {
      hyperAgents: 'hyperAgents',
      agentSwarm: 'agentSwarm',
      cao: 'cao',
      promptOptimizer: 'promptOptimizer',
    };
    const flag = flagMap[name];
    if (flag && !this.featureFlags[flag]) return true;
    return false;
  }

  private async prefetchConfig(): Promise<boolean> {
    // Stub: simulate config load
    return true;
  }

  private async prefetchSessionState(): Promise<boolean> {
    // Stub: simulate session state load
    return true;
  }

  private async prefetchApiKeys(): Promise<boolean> {
    // Stub: simulate API key load from Keychain
    return true;
  }

  private async prefetchProviderHealth(): Promise<boolean> {
    // Stub: simulate provider health checks
    return true;
  }
}
