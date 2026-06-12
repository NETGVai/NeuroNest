/**
 * Cold-Start Optimizer — Lazy-loading and deferred module initialization.
 *
 * Defers non-critical module loading past the `ready-to-show` event to ensure
 * the main window is visible within 1,500ms and interactive within 3,000ms.
 *
 * Modules are loaded based on their trigger:
 * - 'ready-to-show': loaded after the BrowserWindow's ready-to-show event
 * - 'user-action': loaded only when the user performs the specified action
 * - 'idle': loaded during idle time via requestIdleCallback (or setTimeout fallback)
 *
 * Requirements: 16.1, 16.2, 16.3, 16.5
 */

// ─── Types ──────────────────────────────────────────────────────

export interface LazyModule {
  name: string;
  loader: () => Promise<unknown>;
  trigger: 'ready-to-show' | 'user-action' | 'idle';
  userAction?: string;
}

export type ModuleLoadState = 'pending' | 'loading' | 'loaded' | 'error';

export interface ModuleLoadResult {
  name: string;
  state: ModuleLoadState;
  loadTimeMs?: number;
  error?: string;
}

export interface ColdStartMetrics {
  readyToShowFiredAt?: number;
  modulesLoaded: ModuleLoadResult[];
  totalLoadTimeMs: number;
}

// ─── ColdStartOptimizer ─────────────────────────────────────────

export class ColdStartOptimizer {
  private modules: LazyModule[] = [];
  private moduleStates = new Map<string, ModuleLoadResult>();
  private readyToShowFired = false;
  private startTime: number;
  private readyToShowTimestamp?: number;
  private idleCallbackIds: number[] = [];

  constructor(private getNow: () => number = Date.now) {
    this.startTime = this.getNow();
  }

  /**
   * Register a deferred module with its loading trigger.
   */
  registerModule(module: LazyModule): void {
    if (module.trigger === 'user-action' && !module.userAction) {
      throw new Error(
        `Module "${module.name}" has trigger 'user-action' but no userAction specified`
      );
    }

    this.modules.push(module);
    this.moduleStates.set(module.name, {
      name: module.name,
      state: 'pending',
    });
  }

  /**
   * Register multiple deferred modules.
   */
  registerModules(modules: LazyModule[]): void {
    for (const m of modules) {
      this.registerModule(m);
    }
  }

  /**
   * Fire the ready-to-show event. This triggers loading of all modules
   * with trigger='ready-to-show' and schedules 'idle' modules.
   *
   * Must be called after the BrowserWindow emits 'ready-to-show'.
   */
  async onReadyToShow(): Promise<ModuleLoadResult[]> {
    this.readyToShowFired = true;
    this.readyToShowTimestamp = this.getNow();

    const readyModules = this.modules.filter(m => m.trigger === 'ready-to-show');
    const results = await Promise.all(readyModules.map(m => this.loadModule(m)));

    // Schedule idle modules after ready-to-show modules complete
    this.scheduleIdleModules();

    return results;
  }

  /**
   * Trigger a user action, loading any modules associated with that action.
   * Returns the load results for triggered modules (empty if no modules match).
   */
  async onUserAction(action: string): Promise<ModuleLoadResult[]> {
    const actionModules = this.modules.filter(
      m => m.trigger === 'user-action' && m.userAction === action
    );

    if (actionModules.length === 0) {
      return [];
    }

    return Promise.all(actionModules.map(m => this.loadModule(m)));
  }

  /**
   * Get the current state of a module by name.
   */
  getModuleState(name: string): ModuleLoadResult | undefined {
    return this.moduleStates.get(name);
  }

  /**
   * Get all registered modules and their states.
   */
  getAllModuleStates(): ModuleLoadResult[] {
    return Array.from(this.moduleStates.values());
  }

  /**
   * Check if the ready-to-show event has been fired.
   */
  isReadyToShowFired(): boolean {
    return this.readyToShowFired;
  }

  /**
   * Get timing metrics for the cold start process.
   */
  getMetrics(): ColdStartMetrics {
    const modulesLoaded = Array.from(this.moduleStates.values()).filter(
      m => m.state === 'loaded'
    );

    const totalLoadTimeMs = modulesLoaded.reduce(
      (sum, m) => sum + (m.loadTimeMs ?? 0),
      0
    );

    return {
      readyToShowFiredAt: this.readyToShowTimestamp
        ? this.readyToShowTimestamp - this.startTime
        : undefined,
      modulesLoaded,
      totalLoadTimeMs,
    };
  }

  /**
   * Check whether any non-critical module has been loaded before ready-to-show.
   * Returns true if no violations are found (all non-critical modules are still pending).
   */
  verifyNoEarlyLoads(): boolean {
    if (this.readyToShowFired) return true;

    for (const [, result] of this.moduleStates) {
      if (result.state !== 'pending') {
        return false;
      }
    }
    return true;
  }

  /**
   * Dispose all pending idle callbacks.
   */
  dispose(): void {
    for (const id of this.idleCallbackIds) {
      if (typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(id);
      } else {
        clearTimeout(id);
      }
    }
    this.idleCallbackIds = [];
  }

  // ── Private ─────────────────────────────────────────────────

  private async loadModule(module: LazyModule): Promise<ModuleLoadResult> {
    const existing = this.moduleStates.get(module.name);
    if (existing && (existing.state === 'loaded' || existing.state === 'loading')) {
      return existing;
    }

    const result: ModuleLoadResult = {
      name: module.name,
      state: 'loading',
    };
    this.moduleStates.set(module.name, result);

    const start = this.getNow();

    try {
      await module.loader();
      result.state = 'loaded';
      result.loadTimeMs = this.getNow() - start;
    } catch (err) {
      result.state = 'error';
      result.error = err instanceof Error ? err.message : String(err);
      result.loadTimeMs = this.getNow() - start;
    }

    this.moduleStates.set(module.name, result);
    return result;
  }

  private scheduleIdleModules(): void {
    const idleModules = this.modules.filter(m => m.trigger === 'idle');

    for (const module of idleModules) {
      const id = this.scheduleIdle(() => {
        this.loadModule(module);
      });
      this.idleCallbackIds.push(id);
    }
  }

  private scheduleIdle(callback: () => void): number {
    if (typeof requestIdleCallback === 'function') {
      return requestIdleCallback(callback) as unknown as number;
    }
    // Fallback to setTimeout for environments without requestIdleCallback
    return setTimeout(callback, 1) as unknown as number;
  }
}

// ─── Default Configuration ──────────────────────────────────────

/**
 * Default deferred modules for NeuroNest cold start.
 * These should NOT be loaded before the ready-to-show event.
 */
export const DEFERRED_MODULES: LazyModule[] = [
  {
    name: 'cytoscape',
    loader: () => import('../graph/graph-manager.js'),
    trigger: 'user-action',
    userAction: 'open-graph-panel',
  },
  {
    name: 'voice-ui',
    loader: () => import('../voice/index.js'),
    trigger: 'ready-to-show',
  },
  {
    name: 'extensions',
    loader: () => import('../extensions/extension-manager.js'),
    trigger: 'ready-to-show',
  },
];

/**
 * Create a cold-start optimizer pre-configured with the default deferred modules.
 */
export function createColdStartOptimizer(): ColdStartOptimizer {
  const optimizer = new ColdStartOptimizer();
  optimizer.registerModules(DEFERRED_MODULES);
  return optimizer;
}
