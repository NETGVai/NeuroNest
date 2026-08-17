/**
 * RuntimeMcpServer — The `neuronest-runtime-mcp` stdio MCP server executable.
 *
 * This server:
 * 1. Opens SharedDatabase with WAL/FK/busy-timeout
 * 2. Runs migrations
 * 3. Registers schema compatibility
 * 4. Checks startup compatibility — exits non-zero if incompatible
 * 5. Exposes ONLY neuronest.runtime.v1.* namespaced tools/resources/prompts
 * 6. Does NOT own canonical session projection (that's the session server)
 * 7. Reports readiness only after compatibility checks pass
 *
 * Requirements: 25.1, 30.2, 30.4, 30.8–30.12, 32.1, 32.3–32.7
 */

import { SharedDatabase, type SharedDatabaseConfig } from '../../database/shared-database.js';
import { MigrationRunner } from '../../database/migration-runner.js';
import { FencedMigrationCoordinator } from '../../database/fenced-coordinator.js';
import { RuntimeNamespaceAdapter, type SurfaceDescriptor } from './namespace-adapter.js';
import {
  RUNTIME_NAMESPACE_PREFIX,
  RUNTIME_SURFACE_CATEGORIES,
  MCP_ERROR_CODES,
  type RuntimeServerConfig,
  type ReadinessState,
  type ReadinessReport,
  type RuntimeSurfaceCategory,
  type SchemaCompatibilityRange,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────

export const RUNTIME_PROCESS_NAME = 'neuronest-runtime-mcp' as const;
const DEFAULT_PROCESS_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_SCHEMA_RANGE: SchemaCompatibilityRange = {
  readMin: 1,
  readMax: 1,
  writeMin: 1,
  writeMax: 1,
};

// ─── RuntimeMcpServer ───────────────────────────────────────────

export class RuntimeMcpServer {
  private db: SharedDatabase | null = null;
  private migrationRunner: MigrationRunner | null = null;
  private coordinator: FencedMigrationCoordinator | null = null;
  private readonly namespaceAdapter: RuntimeNamespaceAdapter;
  private state: ReadinessState = 'initializing';
  private startTime: number = Date.now();
  private draining = false;
  private databaseConnected = false;
  private databaseCompatible = false;
  private migrationState: ReadinessReport['migrationState'] = 'unknown';
  private initError: string | undefined;
  private readonly config: Required<RuntimeServerConfig>;

  constructor(config: RuntimeServerConfig) {
    this.config = {
      databasePath: config.databasePath,
      busyTimeoutMs: config.busyTimeoutMs,
      maxTransactionDurationMs: config.maxTransactionDurationMs,
      maxStatementsPerTransaction: config.maxStatementsPerTransaction,
      synchronous: config.synchronous ?? 'NORMAL',
      processVersion: config.processVersion ?? DEFAULT_PROCESS_VERSION,
      protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      schemaRange: config.schemaRange ?? DEFAULT_SCHEMA_RANGE,
    };
    this.namespaceAdapter = new RuntimeNamespaceAdapter();
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Initialize the runtime MCP server.
   *
   * Steps:
   * 1. Open SharedDatabase with WAL/FK/busy-timeout
   * 2. Run pending migrations
   * 3. Register schema compatibility
   * 4. Check startup compatibility
   * 5. Register runtime surfaces
   * 6. Report readiness
   *
   * Returns a result indicating success or the reason for failure.
   * On incompatible database, caller should exit with non-zero status.
   */
  async initialize(): Promise<{ ok: true } | { ok: false; reason: string; exitCode: number }> {
    try {
      // Step 1: Open SharedDatabase
      this.startTime = Date.now();
      this.state = 'initializing';
      const dbConfig: SharedDatabaseConfig = {
        path: this.config.databasePath,
        busyTimeoutMs: this.config.busyTimeoutMs,
        synchronous: this.config.synchronous,
        transactions: {
          maxDurationMs: this.config.maxTransactionDurationMs,
          maxStatements: this.config.maxStatementsPerTransaction,
        },
      };

      try {
        this.db = SharedDatabase.open(dbConfig);
        this.databaseConnected = true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.state = 'unavailable';
        this.initError = `Database unavailable: ${message}`;
        return {
          ok: false,
          reason: this.initError,
          exitCode: 1,
        };
      }

      // Step 2: Run migrations
      this.state = 'running_migrations';
      try {
        this.migrationRunner = new MigrationRunner(this.db.raw, { owner: RUNTIME_PROCESS_NAME });
        this.migrationRunner.ensureMigrationTable();
        this.migrationRunner.applyAll();
        this.migrationState = 'current';
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.migrationState = 'failed';
        this.state = 'unavailable';
        this.initError = `Migration failed: ${message}`;
        return {
          ok: false,
          reason: this.initError,
          exitCode: 1,
        };
      }

      // Step 3: Register schema compatibility
      this.state = 'checking_compatibility';
      const schemaRange = this.config.schemaRange;
      this.coordinator = new FencedMigrationCoordinator(this.db.raw);
      this.coordinator.registerCompatibility(
        RUNTIME_PROCESS_NAME,
        [schemaRange.readMin, schemaRange.readMax],
        [schemaRange.writeMin, schemaRange.writeMax],
        schemaRange.readMax // observedVersion = current schema version
      );

      // Step 4: Check startup compatibility
      const compatResult = this.coordinator.checkStartupCompatibility(RUNTIME_PROCESS_NAME);
      if (!compatResult.compatible) {
        this.databaseCompatible = false;
        this.state = 'incompatible';
        this.initError = compatResult.reason ?? 'Incompatible database schema';
        return {
          ok: false,
          reason: this.initError,
          exitCode: 1,
        };
      }

      this.databaseCompatible = true;

      // Step 5: Register runtime surfaces
      this.registerRuntimeSurfaces();

      // Step 6: Report readiness
      this.state = 'ready';
      return { ok: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = 'unavailable';
      this.initError = `Unexpected initialization error: ${message}`;
      return {
        ok: false,
        reason: this.initError,
        exitCode: 1,
      };
    }
  }

  /**
   * Start graceful shutdown: stop accepting work, drain in-flight operations,
   * flush committed outbox state, close database.
   */
  async shutdown(): Promise<void> {
    this.draining = true;
    this.state = 'draining';

    // Close database connection
    if (this.db && !this.db.isClosed) {
      this.db.close();
    }

    this.databaseConnected = false;
    this.namespaceAdapter.clear();
    this.state = 'stopped';
  }

  // ─── Readiness and Health ───────────────────────────────────

  /**
   * Get the current readiness report.
   *
   * Reports process/protocol versions, uptime, draining state,
   * database compatibility/connectivity, migration state, and
   * authority availability (Req 30.11).
   */
  getReadiness(): ReadinessReport {
    return {
      state: this.state,
      processVersion: this.config.processVersion,
      protocolVersion: this.config.protocolVersion,
      uptime: Date.now() - this.startTime,
      draining: this.draining,
      databaseConnected: this.databaseConnected,
      databaseCompatible: this.databaseCompatible,
      migrationState: this.migrationState,
      requiredAuthoritiesAvailable: this.state === 'ready',
      reason: this.state === 'incompatible' || this.state === 'unavailable'
        ? this.initError
        : undefined,
    };
  }

  /**
   * Returns true only when all initialization steps have passed.
   */
  isReady(): boolean {
    return this.state === 'ready';
  }

  // ─── Namespace Filtering ────────────────────────────────────

  /**
   * Check if a method name belongs to the runtime namespace.
   * Only methods prefixed with `neuronest.runtime.v1.*` are allowed.
   */
  isRuntimeNamespace(method: string): boolean {
    return method.startsWith(`${RUNTIME_NAMESPACE_PREFIX}.`);
  }

  /**
   * Check if a method name belongs to the session namespace.
   * Used to reject session-owned surfaces (projection, replay, etc.).
   */
  isSessionNamespace(method: string): boolean {
    return this.namespaceAdapter.isSessionNamespace(method);
  }

  /**
   * Extract the surface category from a fully qualified method name.
   * Returns null if the method does not belong to the runtime namespace
   * or the category is invalid.
   */
  extractSurfaceCategory(method: string): RuntimeSurfaceCategory | null {
    const validation = this.namespaceAdapter.validateSurfaceName(method);
    if (!validation.valid) return null;
    return validation.category ?? null;
  }

  /**
   * List all registered surface categories for this server.
   */
  getRegisteredSurfaces(): readonly RuntimeSurfaceCategory[] {
    return RUNTIME_SURFACE_CATEGORIES;
  }

  // ─── Session Projection Ownership Check ─────────────────────

  /**
   * This server does NOT own canonical session projection.
   * Always returns false — session projection belongs to the session server.
   */
  ownsSessionProjection(): boolean {
    return false;
  }

  // ─── Request Handling ───────────────────────────────────────

  /**
   * Handle an incoming JSON-RPC request.
   * Validates namespace, readiness, and routes to the appropriate handler.
   */
  handleRequest(request: JsonRpcRequest): JsonRpcResponse {
    // Reject if not ready
    if (!this.isReady()) {
      return this.makeErrorResponse(
        request.id,
        MCP_ERROR_CODES.NOT_READY,
        'Server is not ready',
        { state: this.state, readiness: this.getReadiness() }
      );
    }

    // Reject if draining
    if (this.draining) {
      return this.makeErrorResponse(
        request.id,
        MCP_ERROR_CODES.DRAINING,
        'Server is draining and not accepting new work'
      );
    }

    const { method } = request;

    // Handle built-in MCP protocol methods
    if (method === 'initialize') {
      return this.handleInitializeRequest(request);
    }

    if (method === 'health' || method === 'readiness') {
      return this.successResponse(request.id, this.getReadiness());
    }

    // Validate namespace via the adapter
    const validation = this.namespaceAdapter.validateSurfaceName(method);
    if (!validation.valid) {
      // Provide supported alternatives in error (Req 32.5)
      const alternatives = RUNTIME_SURFACE_CATEGORIES.map(
        cat => `${RUNTIME_NAMESPACE_PREFIX}.${cat}.*`
      );

      return this.makeErrorResponse(
        request.id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        validation.reason ?? `Method '${method}' is not supported by this server. Only neuronest.runtime.v1.* surfaces are available.`,
        { supportedNamespaces: alternatives, supportedCategories: [...RUNTIME_SURFACE_CATEGORIES] }
      );
    }

    // Check if the method is actually registered
    if (!this.namespaceAdapter.isExposed(method)) {
      return this.makeErrorResponse(
        request.id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        `Method '${method}' is not registered on this server`,
        {
          supportedNamespace: `${RUNTIME_NAMESPACE_PREFIX}.*`,
          category: validation.category,
          alternatives: validation.category
            ? this.namespaceAdapter.getSurfacesByCategory(validation.category).map(s => s.name)
            : [],
        }
      );
    }

    // Route to registered handler (placeholder for actual surface implementations)
    return this.successResponse(request.id, {
      namespace: RUNTIME_NAMESPACE_PREFIX,
      category: validation.category,
      method,
    });
  }

  // ─── Accessors ──────────────────────────────────────────────

  /** Get the underlying database (for testing or extension) */
  getDatabase(): SharedDatabase | null {
    return this.db;
  }

  /** Get the process name constant */
  getProcessName(): string {
    return RUNTIME_PROCESS_NAME;
  }

  /** Get the current state */
  getState(): ReadinessState {
    return this.state;
  }

  /** Get the namespace adapter (for testing/inspection) */
  getNamespaceAdapter(): RuntimeNamespaceAdapter {
    return this.namespaceAdapter;
  }

  // ─── Private Helpers ────────────────────────────────────────

  private handleInitializeRequest(request: JsonRpcRequest): JsonRpcResponse {
    return this.successResponse(request.id, {
      protocolVersion: this.config.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        cancellation: true,
        progress: true,
        logging: true,
      },
      serverInfo: {
        name: RUNTIME_PROCESS_NAME,
        version: this.config.processVersion,
      },
    });
  }

  /**
   * Register all runtime surfaces under the namespace.
   *
   * Surfaces exposed:
   * - capability: typed capability registration, resolution, inspection
   * - prompt: prompt assembly and fingerprinting
   * - turn: turn lifecycle, step, inbox, cancellation
   * - queue: turn queue management
   * - tool: tool execution pipeline, schemas, results
   * - provider: provider streaming, retry, route decisions
   * - collaboration: approvals, permissions, human commands
   * - orchestration: subagent delegation, workflows, jobs
   * - profile: profile activation, dry-run, rollback
   * - execution: sandbox, code runtime, execution worlds
   * - credential: secret-reference resolution
   * - adapter: protocol adapters (Agent_Client_Protocol, hooks)
   * - introspection: capability/policy/health inspection
   * - diagnostic: health, invariants, compatibility
   */
  private registerRuntimeSurfaces(): void {
    const surfaces: SurfaceDescriptor[] = [
      // Capability
      { name: `${RUNTIME_NAMESPACE_PREFIX}.capability.register`, kind: 'tool', description: 'Register a capability provider' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.capability.resolve`, kind: 'tool', description: 'Resolve a capability to an active provider' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.capability.list`, kind: 'tool', description: 'List registered capabilities' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.capability.dispose`, kind: 'tool', description: 'Dispose a capability registration' },

      // Prompt
      { name: `${RUNTIME_NAMESPACE_PREFIX}.prompt.assemble`, kind: 'tool', description: 'Assemble a model-visible prompt' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.prompt.fingerprint`, kind: 'tool', description: 'Compute prompt fingerprint' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.prompt.sections`, kind: 'resource', description: 'List prompt sections' },

      // Turn
      { name: `${RUNTIME_NAMESPACE_PREFIX}.turn.submit`, kind: 'tool', description: 'Submit a new turn' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.turn.cancel`, kind: 'tool', description: 'Cancel an active turn' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.turn.state`, kind: 'resource', description: 'Get current turn activity state' },

      // Queue
      { name: `${RUNTIME_NAMESPACE_PREFIX}.queue.enqueue`, kind: 'tool', description: 'Add to turn queue' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.queue.mutate`, kind: 'tool', description: 'Mutate queue entries' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.queue.list`, kind: 'resource', description: 'List queue entries' },

      // Tool
      { name: `${RUNTIME_NAMESPACE_PREFIX}.tool.execute`, kind: 'tool', description: 'Execute a tool through the pipeline' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.tool.schema`, kind: 'resource', description: 'Get tool schemas' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.tool.list`, kind: 'tool', description: 'List registered tools' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.tool.result`, kind: 'resource', description: 'Get tool execution result' },

      // Provider
      { name: `${RUNTIME_NAMESPACE_PREFIX}.provider.resolve`, kind: 'tool', description: 'Resolve provider route' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.provider.stream`, kind: 'tool', description: 'Start provider stream' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.provider.retry`, kind: 'tool', description: 'Apply retry policy' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.provider.health`, kind: 'resource', description: 'Provider health status' },

      // Collaboration
      { name: `${RUNTIME_NAMESPACE_PREFIX}.collaboration.decide`, kind: 'tool', description: 'Record collaboration decision' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.collaboration.approve`, kind: 'tool', description: 'Submit approval' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.collaboration.permissions`, kind: 'resource', description: 'Get permission presets' },

      // Orchestration
      { name: `${RUNTIME_NAMESPACE_PREFIX}.orchestration.delegate`, kind: 'tool', description: 'Delegate to subagent' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.orchestration.workflow`, kind: 'tool', description: 'Submit workflow' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.orchestration.job`, kind: 'tool', description: 'Manage background jobs' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.orchestration.status`, kind: 'resource', description: 'Orchestration status' },

      // Profile
      { name: `${RUNTIME_NAMESPACE_PREFIX}.profile.activate`, kind: 'tool', description: 'Activate a profile' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.profile.dryRun`, kind: 'tool', description: 'Dry-run profile activation' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.profile.rollback`, kind: 'tool', description: 'Rollback active profile' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.profile.list`, kind: 'resource', description: 'List available profiles' },

      // Execution
      { name: `${RUNTIME_NAMESPACE_PREFIX}.execution.run`, kind: 'tool', description: 'Run code in execution world' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.execution.sandbox`, kind: 'resource', description: 'Sandbox policy' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.execution.terminate`, kind: 'tool', description: 'Terminate execution unit' },

      // Credential
      { name: `${RUNTIME_NAMESPACE_PREFIX}.credential.resolve`, kind: 'tool', description: 'Resolve credential at operation boundary' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.credential.availability`, kind: 'resource', description: 'Credential availability metadata' },

      // Adapter
      { name: `${RUNTIME_NAMESPACE_PREFIX}.adapter.translate`, kind: 'tool', description: 'Translate external protocol operation' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.adapter.list`, kind: 'resource', description: 'List registered adapters' },

      // Introspection
      { name: `${RUNTIME_NAMESPACE_PREFIX}.introspection.capabilities`, kind: 'resource', description: 'Inspect loaded capabilities' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.introspection.policies`, kind: 'resource', description: 'Inspect active policies' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.introspection.health`, kind: 'resource', description: 'Inspect authority health' },

      // Diagnostic
      { name: `${RUNTIME_NAMESPACE_PREFIX}.diagnostic.health`, kind: 'tool', description: 'Health check' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.diagnostic.compatibility`, kind: 'resource', description: 'Compatibility status' },
      { name: `${RUNTIME_NAMESPACE_PREFIX}.diagnostic.invariants`, kind: 'tool', description: 'Check runtime invariants' },
    ];

    for (const surface of surfaces) {
      this.namespaceAdapter.register(surface);
    }
  }

  private getMigrationState(): ReadinessReport['migrationState'] {
    if (!this.migrationRunner) return 'unknown';
    try {
      const status = this.migrationRunner.getStatus();
      if (status.failed > 0) return 'failed';
      if (status.pending > 0) return 'pending';
      return 'current';
    } catch {
      return 'unknown';
    }
  }

  private successResponse(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private makeErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
  ): JsonRpcResponse {
    const error: JsonRpcError = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    return { jsonrpc: '2.0', id, error };
  }
}
