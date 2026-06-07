/**
 * StartupManager — Startup optimization, lazy loading, feature flags, caching.
 *
 * Stub implementation with in-memory state. Manages parallel prefetch,
 * lazy loading of subsystems, feature flags, and module caching.
 *
 * Requirements: 22.1–22.4, 22.6–22.9
 */

import type { FeatureFlags } from '../shared/types.js';

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

// ─── StartupManager ─────────────────────────────────────────────

export class StartupManager {
  private subsystems = new Map<SubsystemName, SubsystemInfo>();
  private featureFlags: FeatureFlags;
  private cache = new Map<string, CacheEntry>();
  private lazyLoaders = new Map<SubsystemName, () => Promise<void>>();

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
      expiresAt: ttlMs ? new Date(Date.now() + ttlMs) : undefined,
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
