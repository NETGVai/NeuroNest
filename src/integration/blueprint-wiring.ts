/**
 * Blueprint Wiring — Connects Blueprint Registry with Gadget Engine and RPC Generator.
 *
 * This integration module provides factory functions to create a properly connected
 * BlueprintRegistry with GadgetEngine and RPCGenerator, ensuring:
 *
 * 1. Blueprint `instantiate()` flows through to Gadget Engine `create()`, producing
 *    a fully isolated gadget with running process, network policy, and fresh state.
 * 2. Gadget modifications trigger RPC regeneration via file watcher, keeping the
 *    RPC interface up to date within 2 seconds of source changes.
 * 3. Published Blueprints include the latest RPC interface definition from the
 *    RPC Generator, not stale cached data.
 *
 * Requirements: 2.3, 9.4
 */

import type Database from 'better-sqlite3';
import type {
  GadgetEngine,
  GadgetHandle,
  GadgetSpec,
  RPCInterfaceDefinition,
  BlueprintRegistry,
  BlueprintMetadata,
  Blueprint,
} from '../types/cloudflare-os.js';
import { BlueprintRegistryImpl, type BlueprintRegistryConfig } from '../blueprints/blueprint-registry.js';
import { GadgetEngineImpl, type GadgetEngineConfig } from '../gadgets/gadget-engine.js';
import { RPCGeneratorImpl, type RPCGeneratorConfig } from '../gadgets/rpc-generator.js';
import type { NetworkPolicy } from '../security/network-sandbox.js';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for creating a wired Blueprint + Gadget + RPC system.
 */
export interface BlueprintWiringConfig {
  /** Main NeuroNest SQLite database instance */
  db: Database.Database;
  /** Optional custom base directory for blueprint archives (for testing) */
  blueprintsBaseDir?: string;
  /** Optional custom base directory for gadget data (for testing) */
  gadgetsBaseDir?: string;
  /** Callback for applying network policy to a gadget child process */
  applyNetworkPolicy?: (gadgetId: string, policy: NetworkPolicy) => void;
  /** Callback invoked when a gadget crashes */
  onCrash?: (gadgetId: string, code: number | null, signal: string | null) => void;
  /** Callback invoked when an RPC interface is regenerated after modification */
  onRPCRegenerate?: (gadgetId: string, definition: RPCInterfaceDefinition) => void;
}

/**
 * Result of wiring — contains all connected subsystem instances.
 */
export interface BlueprintWiringResult {
  /** The Blueprint Registry connected to the Gadget Engine for instantiation */
  blueprintRegistry: BlueprintRegistryImpl;
  /** The Gadget Engine used for creating and managing gadgets */
  gadgetEngine: GadgetEngineImpl;
  /** The RPC Generator watching gadget modifications */
  rpcGenerator: RPCGeneratorImpl;
  /** Stop all file watchers and clean up resources */
  dispose: () => void;
}

// ─── Factory Functions ──────────────────────────────────────────

/**
 * Create a fully wired Blueprint Registry + Gadget Engine + RPC Generator system.
 *
 * The returned subsystems are connected so that:
 * - Instantiating a blueprint delegates to `GadgetEngine.create()` for process isolation
 * - Modifying a gadget triggers RPC regeneration via a file watcher
 * - Publishing a blueprint captures the latest RPC interface from the generator
 *
 * @example
 * ```ts
 * const wired = createWiredBlueprintSystem({ db });
 *
 * // Instantiate a blueprint — creates a real isolated gadget
 * const handle = await wired.blueprintRegistry.instantiate(blueprintId);
 *
 * // Modify gadget source — triggers RPC regeneration automatically
 * await wired.gadgetEngine.modify(handle.id, {
 *   filePath: 'server.ts',
 *   content: updatedCode,
 *   operation: 'update',
 * });
 *
 * // Publish captures the latest RPC interface
 * const blueprint = await wired.blueprintRegistry.publish(handle.id, metadata);
 *
 * // Clean up watchers on shutdown
 * wired.dispose();
 * ```
 */
export function createWiredBlueprintSystem(config: BlueprintWiringConfig): BlueprintWiringResult {
  const {
    db,
    blueprintsBaseDir,
    gadgetsBaseDir,
    applyNetworkPolicy,
    onCrash,
    onRPCRegenerate,
  } = config;

  // 1. Create the RPC Generator with a regeneration hook
  const rpcGenerator = new RPCGeneratorImpl({
    gadgetsBaseDir,
    onRegenerate: onRPCRegenerate,
  });

  // 2. Create the Gadget Engine with crash handling
  const gadgetEngine = new GadgetEngineImpl({
    db,
    gadgetsBaseDir,
    applyNetworkPolicy,
    onCrash,
  });

  // 3. Create the Blueprint Registry wired to Gadget Engine for instantiation.
  //    The `createGadget` callback delegates blueprint instantiation to the
  //    Gadget Engine's `create()` method, ensuring process isolation, network
  //    policy, and fresh state are applied.
  const blueprintRegistry = new BlueprintRegistryImpl({
    db,
    blueprintsBaseDir,
    gadgetsBaseDir,
    createGadget: async (spec) => {
      const gadgetSpec: GadgetSpec = {
        id: spec.id,
        name: spec.name,
        description: spec.description,
        hasClient: spec.hasClient,
        hasServer: spec.hasServer,
        capabilities: [], // Fresh — no inherited capabilities (Requirement 2.3)
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Delegate to GadgetEngine.create() for full lifecycle management
      const handle = await gadgetEngine.create(gadgetSpec);

      // Start watching for source changes to trigger RPC regeneration
      rpcGenerator.watchGadget(handle.id);

      // Generate initial RPC interface from source
      try {
        await rpcGenerator.regenerate(handle.id);
      } catch {
        // Non-fatal: source may not have exported async functions yet
      }

      return handle;
    },
  });

  // 4. Dispose function to clean up file watchers and resources
  const dispose = (): void => {
    rpcGenerator.unwatchAll();
  };

  return {
    blueprintRegistry,
    gadgetEngine,
    rpcGenerator,
    dispose,
  };
}

// ─── Gadget Modification Hook ───────────────────────────────────

/**
 * Wrap a GadgetEngine to automatically trigger RPC regeneration on modifications.
 *
 * This decorator intercepts `modify()` calls and ensures the RPC interface is
 * regenerated after each source code change, keeping the interface definition
 * consistent with the actual server code.
 *
 * @param gadgetEngine - The base GadgetEngine instance
 * @param rpcGenerator - The RPCGenerator that handles regeneration
 * @returns A proxy GadgetEngine that triggers RPC regeneration on modify
 */
export function withRPCRegeneration(
  gadgetEngine: GadgetEngineImpl,
  rpcGenerator: RPCGeneratorImpl,
): GadgetEngine {
  return {
    create: async (spec: GadgetSpec): Promise<GadgetHandle> => {
      const handle = await gadgetEngine.create(spec);
      // Start watching for future modifications
      rpcGenerator.watchGadget(handle.id);
      // Generate initial RPC interface
      try {
        await rpcGenerator.regenerate(handle.id);
      } catch {
        // Non-fatal: new gadget may not have RPC methods yet
      }
      return handle;
    },
    start: (gadgetId: string) => gadgetEngine.start(gadgetId),
    stop: (gadgetId: string) => gadgetEngine.stop(gadgetId),
    destroy: async (gadgetId: string) => {
      // Stop watching before destroying
      rpcGenerator.unwatchGadget(gadgetId);
      return gadgetEngine.destroy(gadgetId);
    },
    modify: async (gadgetId: string, patch) => {
      const handle = await gadgetEngine.modify(gadgetId, patch);
      // Trigger RPC regeneration after modification
      try {
        const definition = await rpcGenerator.regenerate(gadgetId);
        // Update the handle's RPC interface with the latest definition
        handle.rpcInterface = definition;
      } catch {
        // Non-fatal: source may be in a transient broken state during editing
      }
      return handle;
    },
    list: () => gadgetEngine.list(),
    getState: (gadgetId: string) => gadgetEngine.getState(gadgetId),
    restoreAll: async () => {
      const handles = await gadgetEngine.restoreAll();
      // Start watching all restored gadgets
      for (const handle of handles) {
        if (handle.status === 'running') {
          rpcGenerator.watchGadget(handle.id);
        }
      }
      return handles;
    },
  };
}

// ─── Blueprint Publishing with Latest RPC ───────────────────────

/**
 * Wrap a BlueprintRegistry to ensure published blueprints include the latest
 * RPC interface definition from the RPC Generator.
 *
 * Before publishing, this wrapper triggers an RPC regeneration to capture
 * the current state of the gadget's server source. This guarantees that
 * consumers of the blueprint receive the most up-to-date API definition.
 *
 * @param blueprintRegistry - The base BlueprintRegistry instance
 * @param rpcGenerator - The RPCGenerator to regenerate from
 * @returns A proxy BlueprintRegistry that ensures fresh RPC on publish
 */
export function withFreshRPCOnPublish(
  blueprintRegistry: BlueprintRegistryImpl,
  rpcGenerator: RPCGeneratorImpl,
): BlueprintRegistry {
  return {
    publish: async (gadgetId: string, metadata: BlueprintMetadata): Promise<Blueprint> => {
      // Regenerate RPC interface to capture latest state before archiving
      try {
        await rpcGenerator.regenerate(gadgetId);
      } catch {
        // Non-fatal: proceed with whatever RPC state exists on disk
      }
      return blueprintRegistry.publish(gadgetId, metadata);
    },
    instantiate: (blueprintId: string, version?: number) =>
      blueprintRegistry.instantiate(blueprintId, version),
    rollback: (blueprintId: string, targetVersion: number) =>
      blueprintRegistry.rollback(blueprintId, targetVersion),
    search: (query: string) => blueprintRegistry.search(query),
    export: (blueprintId: string) => blueprintRegistry.export(blueprintId),
    import: (archive: Buffer) => blueprintRegistry.import(archive),
    validate: (archive: Buffer) => blueprintRegistry.validate(archive),
    listVersions: (blueprintId: string) => blueprintRegistry.listVersions(blueprintId),
  };
}
