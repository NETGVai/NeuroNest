/**
 * WasmSandbox — Isolated WebAssembly execution for third-party plugins and MCP servers.
 *
 * Executes untrusted plugin code in an isolated WebAssembly runtime with
 * capability-based permissions. Plugins must declare required capabilities
 * (filesystem read/write, network, environment variable access) and only
 * receive granted capabilities. Enforces resource limits (execution time,
 * memory allocation) with configurable thresholds.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A capability that a WASM plugin can request or be granted.
 * Each capability has a type and optional scope (e.g., path glob for fs).
 */
export interface WasmCapability {
  /** Type of capability: filesystem read, write, network, or env access */
  type: 'fs-read' | 'fs-write' | 'network' | 'env-read';
  /** Optional scope constraint (e.g., path glob for fs, domain for network) */
  scope?: string;
}

/**
 * Manifest declaring a WASM plugin's identity, required capabilities,
 * and resource limits.
 */
export interface WasmPluginManifest {
  /** Plugin name (used as key for capability grants) */
  name: string;
  /** Plugin version */
  version: string;
  /** Capabilities the plugin requires to function */
  requiredCapabilities: WasmCapability[];
  /** Resource consumption limits for the plugin */
  resourceLimits: {
    /** Maximum execution time in milliseconds */
    execTimeMs: number;
    /** Maximum memory allocation in megabytes */
    memoryMb: number;
  };
}

/**
 * Result returned from plugin execution.
 */
export interface WasmExecutionResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** Output data from the plugin (JSON-serializable) */
  output: unknown;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Peak memory usage in bytes (approximate) */
  memoryUsedBytes: number;
  /** Error message if execution failed */
  error?: string;
  /** Whether the plugin was terminated due to resource limits */
  resourceViolation?: boolean;
  /** Type of resource violation if any */
  violationType?: 'timeout' | 'memory';
}

/**
 * Record of a capability violation attempt by a plugin.
 */
export interface CapabilityViolation {
  /** Plugin that attempted the operation */
  pluginName: string;
  /** Capability that was denied */
  capability: WasmCapability;
  /** Timestamp of the violation */
  timestamp: string;
  /** Additional context about the attempted operation */
  details: string;
}

// ─── Error Classes ──────────────────────────────────────────────

export class WasmSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmSandboxError';
  }
}

export class CapabilityDeniedError extends WasmSandboxError {
  public readonly violation: CapabilityViolation;

  constructor(violation: CapabilityViolation) {
    super(
      `Plugin "${violation.pluginName}" denied capability: ${violation.capability.type}` +
        (violation.capability.scope ? ` (scope: ${violation.capability.scope})` : ''),
    );
    this.name = 'CapabilityDeniedError';
    this.violation = violation;
  }
}

export class ResourceLimitExceededError extends WasmSandboxError {
  public readonly violationType: 'timeout' | 'memory';
  public readonly pluginName: string;

  constructor(pluginName: string, violationType: 'timeout' | 'memory', limit: number) {
    const unit = violationType === 'timeout' ? 'ms' : 'MB';
    super(
      `Plugin "${pluginName}" exceeded ${violationType} limit: ${limit}${unit}`,
    );
    this.name = 'ResourceLimitExceededError';
    this.violationType = violationType;
    this.pluginName = pluginName;
  }
}

export class PluginLoadError extends WasmSandboxError {
  constructor(pluginName: string, reason: string) {
    super(`Failed to load plugin "${pluginName}": ${reason}`);
    this.name = 'PluginLoadError';
  }
}

// ─── WasmSandbox ────────────────────────────────────────────────

/**
 * WebAssembly sandbox for isolated plugin execution.
 *
 * Enforces capability-based permissions and resource limits.
 * Each plugin runs in its own WASM instance with only the capabilities
 * explicitly granted in the sandbox configuration.
 */
export class WasmSandbox {
  private grantedCapabilities: Map<string, WasmCapability[]>;
  private violations: CapabilityViolation[] = [];
  private activePlugins: Map<string, { abortController: AbortController; startTime: number }> =
    new Map();

  constructor(grantedCapabilities: Map<string, WasmCapability[]>) {
    this.grantedCapabilities = grantedCapabilities;
  }

  /**
   * Load and execute a WASM plugin with capability enforcement.
   *
   * The plugin is loaded from the specified path, validated against its
   * manifest, and executed in an isolated WebAssembly instance. Capabilities
   * are enforced via host function imports — only operations matching granted
   * capabilities are permitted.
   *
   * @param wasmPath - Path to the .wasm binary file
   * @param manifest - Plugin manifest declaring capabilities and limits
   * @param input - Input data passed to the plugin's main function
   * @returns Execution result with output, timing, and resource usage
   */
  async executePlugin(
    wasmPath: string,
    manifest: WasmPluginManifest,
    input: unknown,
  ): Promise<WasmExecutionResult> {
    const startTime = Date.now();
    const pluginId = `${manifest.name}@${manifest.version}-${crypto.randomUUID().slice(0, 8)}`;

    // Validate all required capabilities are granted before loading
    const capabilityCheck = this.validateManifestCapabilities(manifest);
    if (!capabilityCheck.granted) {
      return {
        success: false,
        output: null,
        executionTimeMs: Date.now() - startTime,
        memoryUsedBytes: 0,
        error: `Missing required capabilities: ${capabilityCheck.missing.map((c) => c.type + (c.scope ? `:${c.scope}` : '')).join(', ')}`,
      };
    }

    // Load the WASM binary
    let wasmBuffer: Uint8Array;
    try {
      const fileBuffer = fs.readFileSync(wasmPath);
      wasmBuffer = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
    } catch (err) {
      throw new PluginLoadError(
        manifest.name,
        err instanceof Error ? err.message : 'Unknown read error',
      );
    }

    // Create abort controller for timeout enforcement
    const abortController = new AbortController();
    this.activePlugins.set(pluginId, { abortController, startTime });

    try {
      const result = await this.runIsolated(
        wasmBuffer,
        manifest,
        input,
        pluginId,
        abortController,
      );
      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;

      if (err instanceof ResourceLimitExceededError) {
        return {
          success: false,
          output: null,
          executionTimeMs: elapsed,
          memoryUsedBytes: 0,
          error: err.message,
          resourceViolation: true,
          violationType: err.violationType,
        };
      }

      if (err instanceof CapabilityDeniedError) {
        return {
          success: false,
          output: null,
          executionTimeMs: elapsed,
          memoryUsedBytes: 0,
          error: err.message,
        };
      }

      // Plugin crashed — terminate without affecting agent loop
      return {
        success: false,
        output: null,
        executionTimeMs: elapsed,
        memoryUsedBytes: 0,
        error: err instanceof Error ? err.message : 'Plugin execution failed',
      };
    } finally {
      this.activePlugins.delete(pluginId);
    }
  }

  /**
   * Check if a specific capability is granted to a plugin.
   *
   * @param pluginName - The plugin requesting the capability
   * @param cap - The capability being requested
   * @returns true if the capability is granted, false otherwise
   */
  checkCapability(pluginName: string, cap: WasmCapability): boolean {
    const granted = this.grantedCapabilities.get(pluginName);
    if (!granted) {
      this.logViolation(pluginName, cap, 'No capabilities granted for this plugin');
      return false;
    }

    const hasCapability = granted.some((g) => this.capabilityMatches(g, cap));
    if (!hasCapability) {
      this.logViolation(pluginName, cap, 'Capability not in granted set');
    }

    return hasCapability;
  }

  /**
   * Get all recorded capability violations.
   */
  getViolations(): CapabilityViolation[] {
    return [...this.violations];
  }

  /**
   * Get the number of currently executing plugins.
   */
  getActivePluginCount(): number {
    return this.activePlugins.size;
  }

  /**
   * Terminate a specific active plugin execution.
   */
  terminatePlugin(pluginId: string): boolean {
    const active = this.activePlugins.get(pluginId);
    if (active) {
      active.abortController.abort();
      this.activePlugins.delete(pluginId);
      return true;
    }
    return false;
  }

  /**
   * Terminate all active plugin executions.
   */
  terminateAll(): void {
    for (const [id, plugin] of this.activePlugins) {
      plugin.abortController.abort();
    }
    this.activePlugins.clear();
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Validate that all capabilities required by the manifest are granted.
   */
  private validateManifestCapabilities(manifest: WasmPluginManifest): {
    granted: boolean;
    missing: WasmCapability[];
  } {
    const grantedCaps = this.grantedCapabilities.get(manifest.name) ?? [];
    const missing: WasmCapability[] = [];

    for (const required of manifest.requiredCapabilities) {
      const isGranted = grantedCaps.some((g) => this.capabilityMatches(g, required));
      if (!isGranted) {
        missing.push(required);
      }
    }

    return { granted: missing.length === 0, missing };
  }

  /**
   * Check if a granted capability satisfies a requested capability.
   * Type must match exactly. Scope uses glob-style matching:
   * - No scope on grant = wildcard (grants all scopes of that type)
   * - Grant scope must cover the requested scope
   */
  private capabilityMatches(granted: WasmCapability, requested: WasmCapability): boolean {
    if (granted.type !== requested.type) {
      return false;
    }

    // No scope on grant = wildcard for that type
    if (!granted.scope) {
      return true;
    }

    // No scope on request = exact type match is sufficient if grant has no scope
    if (!requested.scope) {
      return true;
    }

    // Check if granted scope covers requested scope
    return this.scopeCovers(granted.scope, requested.scope);
  }

  /**
   * Check if a granted scope pattern covers a requested scope.
   * Supports basic glob: * matches any segment, ** matches any path.
   */
  private scopeCovers(grantedScope: string, requestedScope: string): boolean {
    // Exact match
    if (grantedScope === requestedScope) {
      return true;
    }

    // Convert glob to regex for matching
    const regexStr = grantedScope
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§GLOBSTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§GLOBSTAR§/g, '.*');

    try {
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(requestedScope);
    } catch {
      // If regex creation fails, fall back to exact match
      return grantedScope === requestedScope;
    }
  }

  /**
   * Execute WASM binary in an isolated instance with resource enforcement.
   */
  private async runIsolated(
    wasmBuffer: Uint8Array,
    manifest: WasmPluginManifest,
    input: unknown,
    pluginId: string,
    abortController: AbortController,
  ): Promise<WasmExecutionResult> {
    const startTime = Date.now();
    const { execTimeMs, memoryMb } = manifest.resourceLimits;

    // Memory limit in bytes (pages are 64KB each)
    const maxPages = Math.ceil((memoryMb * 1024 * 1024) / 65536);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: maxPages });

    // Build host imports with capability-gated functions
    const hostImports = this.buildHostImports(manifest.name, memory);

    // Set up execution timeout
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, execTimeMs);

    try {
      // Compile and instantiate the WASM module
      const module = await WebAssembly.compile(wasmBuffer as BufferSource);
      const instance = await WebAssembly.instantiate(module, hostImports);

      // Check for abort before running
      if (abortController.signal.aborted) {
        throw new ResourceLimitExceededError(manifest.name, 'timeout', execTimeMs);
      }

      // Serialize input to shared memory or pass as args
      const inputBytes = new TextEncoder().encode(JSON.stringify(input ?? null));
      const exports = instance.exports as Record<string, unknown>;

      // Call the plugin's allocate function if available
      let inputPtr = 0;
      if (typeof exports['allocate'] === 'function') {
        inputPtr = (exports['allocate'] as (size: number) => number)(inputBytes.length);
        const memView = new Uint8Array(memory.buffer);
        memView.set(inputBytes, inputPtr);
      }

      // Execute the plugin's main/run function
      let output: unknown = null;
      if (typeof exports['run'] === 'function') {
        const result = (exports['run'] as (ptr: number, len: number) => number)(
          inputPtr,
          inputBytes.length,
        );
        output = this.extractOutput(memory, exports, result);
      } else if (typeof exports['main'] === 'function') {
        const result = (exports['main'] as () => number)();
        output = result;
      } else if (typeof exports['_start'] === 'function') {
        (exports['_start'] as () => void)();
        output = null;
      } else {
        throw new PluginLoadError(
          manifest.name,
          'No run, main, or _start export found in WASM module',
        );
      }

      // Check for timeout after execution
      if (timedOut || abortController.signal.aborted) {
        throw new ResourceLimitExceededError(manifest.name, 'timeout', execTimeMs);
      }

      const elapsed = Date.now() - startTime;
      const memoryUsed = memory.buffer.byteLength;

      return {
        success: true,
        output,
        executionTimeMs: elapsed,
        memoryUsedBytes: memoryUsed,
      };
    } catch (err) {
      if (timedOut) {
        throw new ResourceLimitExceededError(manifest.name, 'timeout', execTimeMs);
      }

      // Detect WebAssembly memory growth failure as memory limit
      if (
        err instanceof Error &&
        (err.message.includes('memory') ||
          err.message.includes('grow') ||
          err instanceof RangeError)
      ) {
        throw new ResourceLimitExceededError(manifest.name, 'memory', memoryMb);
      }

      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Build WASI-like host imports with capability-gated operations.
   */
  private buildHostImports(
    pluginName: string,
    memory: WebAssembly.Memory,
  ): WebAssembly.Imports {
    return {
      env: {
        memory,
        abort: () => {
          throw new WasmSandboxError(`Plugin "${pluginName}" called abort`);
        },
      },
      wasi_snapshot_preview1: {
        // Filesystem read — gated by fs-read capability
        fd_read: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'fs-read' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'fs-read' },
              timestamp: new Date().toISOString(),
              details: 'fd_read called without fs-read capability',
            });
          }
          // Stub: actual fd_read would require full WASI implementation
          return 0;
        },
        // Filesystem write — gated by fs-write capability
        fd_write: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'fs-write' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'fs-write' },
              timestamp: new Date().toISOString(),
              details: 'fd_write called without fs-write capability',
            });
          }
          // Stub: allow stdout/stderr writes
          return 0;
        },
        // Filesystem operations — gated
        path_open: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'fs-read' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'fs-read' },
              timestamp: new Date().toISOString(),
              details: 'path_open called without fs-read capability',
            });
          }
          return 0;
        },
        // Environment variable access — gated by env-read capability
        environ_get: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'env-read' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'env-read' },
              timestamp: new Date().toISOString(),
              details: 'environ_get called without env-read capability',
            });
          }
          return 0;
        },
        environ_sizes_get: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'env-read' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'env-read' },
              timestamp: new Date().toISOString(),
              details: 'environ_sizes_get called without env-read capability',
            });
          }
          return 0;
        },
        // Stubs for required WASI functions (no capability needed)
        proc_exit: (code: number) => {
          throw new WasmSandboxError(`Plugin "${pluginName}" exited with code ${code}`);
        },
        fd_close: () => 0,
        fd_seek: () => 0,
        fd_prestat_get: () => 8, // errno::badf
        fd_prestat_dir_name: () => 8,
        clock_time_get: () => 0,
        args_get: () => 0,
        args_sizes_get: () => 0,
        random_get: () => 0,
      },
      // Network capability — custom import namespace
      neuronest: {
        net_request: (..._args: unknown[]) => {
          if (!this.checkCapability(pluginName, { type: 'network' })) {
            throw new CapabilityDeniedError({
              pluginName,
              capability: { type: 'network' },
              timestamp: new Date().toISOString(),
              details: 'net_request called without network capability',
            });
          }
          return 0;
        },
      },
    };
  }

  /**
   * Extract output from WASM memory after execution.
   */
  private extractOutput(
    memory: WebAssembly.Memory,
    exports: Record<string, unknown>,
    resultPtr: number,
  ): unknown {
    // If the plugin exports a get_output_len function, use it to read output
    if (typeof exports['get_output_len'] === 'function') {
      const len = (exports['get_output_len'] as () => number)();
      if (len > 0 && resultPtr > 0) {
        const memView = new Uint8Array(memory.buffer, resultPtr, len);
        const text = new TextDecoder().decode(memView);
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }

    // Fallback: treat result as a numeric return value
    return resultPtr;
  }

  /**
   * Log a capability violation attempt.
   */
  private logViolation(pluginName: string, cap: WasmCapability, details: string): void {
    this.violations.push({
      pluginName,
      capability: cap,
      timestamp: new Date().toISOString(),
      details,
    });
  }
}

// ─── Factory / Interceptor ──────────────────────────────────────

/**
 * Create a WasmSandbox interceptor for the ToolSystem.
 * When wasm_sandbox feature gate is enabled, plugins are routed through
 * the sandbox. When disabled, plugins execute in the host process directly.
 */
export function createWasmSandboxInterceptor(
  grantedCapabilities: Map<string, WasmCapability[]>,
): {
  sandbox: WasmSandbox;
  executePlugin: (
    wasmPath: string,
    manifest: WasmPluginManifest,
    input: unknown,
  ) => Promise<WasmExecutionResult>;
} {
  const sandbox = new WasmSandbox(grantedCapabilities);
  return {
    sandbox,
    executePlugin: (wasmPath, manifest, input) =>
      sandbox.executePlugin(wasmPath, manifest, input),
  };
}
