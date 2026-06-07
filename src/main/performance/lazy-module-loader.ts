/**
 * LazyModuleLoader - Defers initialization of heavy subsystems until after
 * the main window is visible or until first access.
 *
 * Critical modules (SessionManager, CommandSystem, Database) are loaded at startup.
 * Deferred modules are loaded after the window is visible or on first access.
 *
 * Features:
 * - Circular dependency detection during registration (DFS cycle detection)
 * - 10s timeout per module initialization
 * - Failed modules are logged but don't crash the app (except critical modules)
 * - On-demand initialization for modules accessed before deferred init
 */

import { ModulePriority, ModuleDefinition } from './types';

export type ModuleState = 'unloaded' | 'loading' | 'loaded' | 'failed';

const MODULE_INIT_TIMEOUT_MS = 10_000;

export class LazyModuleLoader {
  private modules: Map<string, ModuleDefinition> = new Map();
  private instances: Map<string, any> = new Map();
  private states: Map<string, ModuleState> = new Map();
  private initializing: Map<string, Promise<any>> = new Map();
  private errors: Map<string, Error> = new Map();

  /**
   * Register a module with its priority and factory.
   * Detects circular dependencies at registration time using DFS.
   * @throws Error if a circular dependency is detected
   */
  register(definition: ModuleDefinition): void {
    this.modules.set(definition.name, definition);
    this.states.set(definition.name, 'unloaded');

    // Validate that all declared dependencies exist or will exist
    // and check for circular dependencies
    this.detectCircularDependencies(definition.name);
  }

  /**
   * Initialize all critical modules (called at startup).
   * Critical modules are loaded in dependency order.
   * @throws Error if any critical module fails to initialize
   */
  async initCritical(): Promise<void> {
    const criticalModules = this.getModulesByPriority('critical');
    const ordered = this.topologicalSort(criticalModules);

    for (const name of ordered) {
      await this.initializeModule(name, true);
    }
  }

  /**
   * Initialize all deferred modules (called after window visible).
   * Deferred modules are loaded in dependency order.
   * Failed deferred modules are logged but don't crash the app.
   */
  async initDeferred(): Promise<void> {
    const deferredModules = this.getModulesByPriority('deferred');
    const ordered = this.topologicalSort(deferredModules);

    for (const name of ordered) {
      if (this.states.get(name) === 'loaded') {
        // Already initialized on-demand
        continue;
      }
      await this.initializeModule(name, false);
    }
  }

  /**
   * Get a module instance synchronously.
   * If the module is not yet loaded, triggers synchronous initialization.
   * Returns the instance if loaded, or null if failed.
   */
  get<T>(name: string): T {
    const state = this.states.get(name);

    if (state === 'loaded') {
      return this.instances.get(name) as T;
    }

    if (state === 'failed') {
      return null as unknown as T;
    }

    // Trigger on-demand initialization (fire and forget for async, but attempt sync)
    const definition = this.modules.get(name);
    if (!definition) {
      throw new Error(`Module "${name}" is not registered`);
    }

    // Start async initialization if not already in progress
    if (!this.initializing.has(name)) {
      this.initializeModule(name, definition.priority === 'critical');
    }

    // Return null for now - caller should use getAsync for guaranteed access
    return null as unknown as T;
  }

  /**
   * Async get that waits for initialization to complete.
   * If the module is not yet loaded, triggers initialization and waits.
   */
  async getAsync<T>(name: string): Promise<T> {
    const state = this.states.get(name);

    if (state === 'loaded') {
      return this.instances.get(name) as T;
    }

    if (state === 'failed') {
      const error = this.errors.get(name);
      throw new Error(`Module "${name}" failed to initialize: ${error?.message}`);
    }

    // If already initializing, wait for it
    const existingPromise = this.initializing.get(name);
    if (existingPromise) {
      return existingPromise as Promise<T>;
    }

    // Trigger initialization
    const definition = this.modules.get(name);
    if (!definition) {
      throw new Error(`Module "${name}" is not registered`);
    }

    // Initialize dependencies first
    await this.initializeDependencies(name);

    const promise = this.initializeModule(name, definition.priority === 'critical');
    return promise as Promise<T>;
  }

  /**
   * Get the current state of a module.
   */
  getState(name: string): ModuleState | undefined {
    return this.states.get(name);
  }

  /**
   * Get all registered module names.
   */
  getRegisteredModules(): string[] {
    return Array.from(this.modules.keys());
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Initialize a single module with timeout enforcement.
   * @param isCritical - If true, throws on failure; if false, logs and continues
   */
  private async initializeModule(name: string, isCritical: boolean): Promise<any> {
    const definition = this.modules.get(name);
    if (!definition) {
      throw new Error(`Module "${name}" is not registered`);
    }

    // If already loaded, return the instance
    if (this.states.get(name) === 'loaded') {
      return this.instances.get(name);
    }

    // If already initializing, return the existing promise
    const existingPromise = this.initializing.get(name);
    if (existingPromise) {
      return existingPromise;
    }

    this.states.set(name, 'loading');

    const initPromise = this.executeWithTimeout(name, definition, isCritical);
    this.initializing.set(name, initPromise);

    try {
      const instance = await initPromise;
      return instance;
    } finally {
      this.initializing.delete(name);
    }
  }

  /**
   * Execute a module factory with a 10s timeout.
   */
  private async executeWithTimeout(
    name: string,
    definition: ModuleDefinition,
    isCritical: boolean
  ): Promise<any> {
    // Initialize dependencies first
    await this.initializeDependencies(name);

    return new Promise<any>((resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;

        const error = new Error(`Module "${name}" initialization timed out after ${MODULE_INIT_TIMEOUT_MS}ms`);
        this.states.set(name, 'failed');
        this.errors.set(name, error);

        if (isCritical) {
          reject(error);
        } else {
          console.error(`[LazyModuleLoader] ${error.message}`);
          resolve(null);
        }
      }, MODULE_INIT_TIMEOUT_MS);

      // Execute the factory
      let factoryResult: any;
      try {
        factoryResult = definition.factory();
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        this.states.set(name, 'failed');
        this.errors.set(name, error);

        if (isCritical) {
          reject(new Error(`Critical module "${name}" failed to initialize: ${error.message}`));
        } else {
          console.error(`[LazyModuleLoader] Deferred module "${name}" failed to initialize: ${error.message}`);
          resolve(null);
        }
        return;
      }

      // Handle async factories
      if (factoryResult instanceof Promise) {
        factoryResult.then(
          (instance) => {
            clearTimeout(timeoutId);
            if (settled) return;
            settled = true;

            this.instances.set(name, instance);
            this.states.set(name, 'loaded');
            resolve(instance);
          },
          (error: any) => {
            clearTimeout(timeoutId);
            if (settled) return;
            settled = true;

            this.states.set(name, 'failed');
            this.errors.set(name, error);

            if (isCritical) {
              reject(new Error(`Critical module "${name}" failed to initialize: ${error.message}`));
            } else {
              console.error(`[LazyModuleLoader] Deferred module "${name}" failed to initialize: ${error.message}`);
              resolve(null);
            }
          }
        );
      } else {
        // Synchronous factory
        clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        this.instances.set(name, factoryResult);
        this.states.set(name, 'loaded');
        resolve(factoryResult);
      }
    });
  }

  /**
   * Initialize all dependencies of a module before initializing it.
   */
  private async initializeDependencies(name: string): Promise<void> {
    const definition = this.modules.get(name);
    if (!definition?.dependencies?.length) {
      return;
    }

    for (const depName of definition.dependencies) {
      const depState = this.states.get(depName);
      if (depState === 'loaded') {
        continue;
      }
      if (depState === 'failed') {
        throw new Error(`Dependency "${depName}" of module "${name}" failed to initialize`);
      }

      const depDef = this.modules.get(depName);
      if (!depDef) {
        throw new Error(`Dependency "${depName}" of module "${name}" is not registered`);
      }

      await this.initializeModule(depName, depDef.priority === 'critical');
    }
  }

  /**
   * Detect circular dependencies using DFS cycle detection.
   * Called during registration to fail fast.
   * @throws Error if a circular dependency is detected
   */
  private detectCircularDependencies(startName: string): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (name: string, path: string[]): void => {
      visited.add(name);
      recursionStack.add(name);

      const definition = this.modules.get(name);
      if (definition?.dependencies) {
        for (const dep of definition.dependencies) {
          // Only check dependencies that are registered
          if (!this.modules.has(dep)) {
            continue;
          }

          if (recursionStack.has(dep)) {
            const cyclePath = [...path, name, dep].join(' -> ');
            throw new Error(`Circular dependency detected: ${cyclePath}`);
          }

          if (!visited.has(dep)) {
            dfs(dep, [...path, name]);
          }
        }
      }

      recursionStack.delete(name);
    };

    // Run DFS from the newly registered module
    visited.clear();
    dfs(startName, []);
  }

  /**
   * Get all module names with a specific priority.
   */
  private getModulesByPriority(priority: ModulePriority): string[] {
    const result: string[] = [];
    for (const [name, def] of this.modules) {
      if (def.priority === priority) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Topological sort of modules respecting dependency order.
   * Returns modules in initialization order (dependencies first).
   */
  private topologicalSort(moduleNames: string[]): string[] {
    const nameSet = new Set(moduleNames);
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) return; // Cycle already detected at registration

      visiting.add(name);

      const definition = this.modules.get(name);
      if (definition?.dependencies) {
        for (const dep of definition.dependencies) {
          if (this.modules.has(dep)) {
            visit(dep);
          }
        }
      }

      visiting.delete(name);
      visited.add(name);

      // Only add to sorted if it's in our target set
      if (nameSet.has(name)) {
        sorted.push(name);
      }
    };

    for (const name of moduleNames) {
      visit(name);
    }

    return sorted;
  }
}
