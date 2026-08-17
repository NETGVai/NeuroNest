/**
 * SessionMcpServer — The `neuronest-session-mcp` stdio MCP server executable.
 *
 * Responsibilities:
 * 1. Opens SharedDatabase with WAL/FK/busy-timeout configured from bounds
 * 2. Runs migrations via MigrationRunner
 * 3. Registers schema compatibility via FencedMigrationCoordinator
 * 4. Checks startup compatibility — exits non-zero if incompatible
 * 5. Exposes ONLY neuronest.session.v1.* namespaced tools/resources/prompts
 * 6. Reports readiness only after all compatibility checks pass
 * 7. Handles JSON-RPC over stdio for MCP protocol
 *
 * Requirements: 30.1, 30.3, 30.8–30.12, 32.1–32.2, 32.4–32.7
 */

import { SharedDatabase, type SharedDatabaseConfig } from '../../database/shared-database.js';
import { MigrationRunner } from '../../database/migration-runner.js';
import { FencedMigrationCoordinator, type CompatibilityCheckResult } from '../../database/fenced-coordinator.js';
import { NamespaceAdapter, type SurfaceDescriptor } from './namespace-adapter.js';
import {
  SESSION_NAMESPACE_PREFIX,
  MCP_ERROR_CODES,
  type SessionServerConfig,
  type ReadinessState,
  type ReadinessReport,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type SchemaCompatibilityRange,
} from './types.js';

// ─── Process identity ───────────────────────────────────────────

export const SESSION_PROCESS_NAME = 'neuronest-session-mcp' as const;

const DEFAULT_PROCESS_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
/**
 * Default schema range covers all known migrations.
 * The session process is compatible with the full range of schema versions
 * it can read and write (1 through the current migration set).
 */
const DEFAULT_SCHEMA_RANGE: SchemaCompatibilityRange = {
  readMin: 1,
  readMax: 100,
  writeMin: 1,
  writeMax: 100,
};

// ─── SessionMcpServer ───────────────────────────────────────────

export class SessionMcpServer {
  private db: SharedDatabase | null = null;
  private migrationRunner: MigrationRunner | null = null;
  private coordinator: FencedMigrationCoordinator | null = null;
  private readonly namespaceAdapter: NamespaceAdapter;
  private readonly config: SessionServerConfig;

  private state: ReadinessState = 'initializing';
  private startTime: number = Date.now();
  private draining = false;
  private compatibilityResult: CompatibilityCheckResult | null = null;
  private initError: string | undefined;

  constructor(config: SessionServerConfig) {
    this.config = config;
    this.namespaceAdapter = new NamespaceAdapter();
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Initialize the server: open database, run migrations, check compatibility.
   * Returns true if the server is ready to accept requests, false if it must exit.
   */
  async initialize(): Promise<{ ready: boolean; exitCode?: number; error?: string }> {
    this.startTime = Date.now();
    this.state = 'initializing';

    // Step 1: Open SharedDatabase
    let dbConfig: SharedDatabaseConfig;
    try {
      dbConfig = {
        path: this.config.databasePath,
        busyTimeoutMs: this.config.busyTimeoutMs,
        transactions: {
          maxDurationMs: this.config.maxTransactionDurationMs,
          maxStatements: this.config.maxStatementsPerTransaction,
        },
        synchronous: this.config.synchronous ?? 'NORMAL',
      };
      this.db = SharedDatabase.open(dbConfig);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = 'unavailable';
      this.initError = `Database unavailable: ${message}`;
      return { ready: false, exitCode: 1, error: this.initError };
    }

    // Verify WAL and FK are configured
    // Note: In-memory databases use 'memory' journal mode, which is expected.
    // WAL check only applies to file-based databases.
    if (!this.db.isWalMode() && this.config.databasePath !== ':memory:') {
      this.state = 'unavailable';
      this.initError = 'Database did not enable WAL mode';
      this.db.close();
      return { ready: false, exitCode: 1, error: this.initError };
    }

    if (!this.db.isForeignKeysEnabled()) {
      this.state = 'unavailable';
      this.initError = 'Database did not enable foreign key enforcement';
      this.db.close();
      return { ready: false, exitCode: 1, error: this.initError };
    }

    // Step 2: Run migrations
    this.state = 'running_migrations';
    try {
      this.migrationRunner = new MigrationRunner(this.db.raw, {
        owner: SESSION_PROCESS_NAME,
      });
      this.migrationRunner.applyAll();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = 'unavailable';
      this.initError = `Migration failed: ${message}`;
      this.db.close();
      return { ready: false, exitCode: 1, error: this.initError };
    }

    // Step 3: Register schema compatibility
    // The actual schema version is determined by the migrations applied to the database.
    // The process declares what version ranges it can read/write.
    this.state = 'checking_compatibility';
    try {
      const schemaRange = this.config.schemaRange ?? DEFAULT_SCHEMA_RANGE;
      const migrationStatus = this.migrationRunner!.getStatus();
      // The actual database schema version = number of applied migrations (minimum 1)
      const actualSchemaVersion = Math.max(1, migrationStatus.applied);

      this.coordinator = new FencedMigrationCoordinator(this.db.raw, {
        currentSchemaVersion: actualSchemaVersion,
      });

      this.coordinator.registerCompatibility(
        SESSION_PROCESS_NAME,
        [schemaRange.readMin, schemaRange.readMax],
        [schemaRange.writeMin, schemaRange.writeMax],
        actualSchemaVersion,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = 'unavailable';
      this.initError = `Compatibility registration failed: ${message}`;
      this.db.close();
      return { ready: false, exitCode: 1, error: this.initError };
    }

    // Step 4: Check startup compatibility — exit non-zero if incompatible
    this.compatibilityResult = this.coordinator.checkStartupCompatibility(SESSION_PROCESS_NAME);
    if (!this.compatibilityResult.compatible) {
      this.state = 'incompatible';
      this.initError = `Schema incompatible: ${this.compatibilityResult.reason}`;
      this.db.close();
      return { ready: false, exitCode: 1, error: this.initError };
    }

    // Step 5: Register session surfaces
    this.registerSessionSurfaces();

    // Step 6: Report readiness
    this.state = 'ready';
    return { ready: true };
  }

  /**
   * Handle a JSON-RPC request. Only methods under neuronest.session.v1.* are accepted.
   */
  handleRequest(request: JsonRpcRequest): JsonRpcResponse {
    // Reject if not ready
    if (this.state !== 'ready' && this.state !== 'draining') {
      return this.errorResponse(request.id, MCP_ERROR_CODES.NOT_READY, `Server not ready: ${this.state}`, {
        state: this.state,
        reason: this.initError,
      });
    }

    // Reject new work if draining
    if (this.draining) {
      return this.errorResponse(request.id, MCP_ERROR_CODES.DRAINING, 'Server is draining, not accepting new requests');
    }

    const { method } = request;

    // Handle built-in MCP protocol methods
    if (method === 'initialize') {
      return this.handleInitializeRequest(request);
    }

    if (method === 'health' || method === 'readiness') {
      return this.successResponse(request.id, this.getReadinessReport());
    }

    // Validate namespace
    const validation = this.namespaceAdapter.validateSurfaceName(method);
    if (!validation.valid) {
      return this.errorResponse(
        request.id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        validation.reason ?? `Method '${method}' not found`,
        {
          supportedNamespace: `${SESSION_NAMESPACE_PREFIX}.*`,
          alternatives: this.getRegisteredMethodNames(),
        },
      );
    }

    // Check if the method is actually registered
    if (!this.namespaceAdapter.isExposed(method)) {
      return this.errorResponse(
        request.id,
        MCP_ERROR_CODES.METHOD_NOT_FOUND,
        `Method '${method}' is not registered on this server`,
        {
          supportedNamespace: `${SESSION_NAMESPACE_PREFIX}.*`,
          category: validation.category,
          alternatives: validation.category
            ? this.namespaceAdapter.getSurfacesByCategory(validation.category).map(s => s.name)
            : [],
        },
      );
    }

    // Dispatch to surface handler (placeholder for actual implementation)
    return this.successResponse(request.id, {
      status: 'ok',
      method,
      category: validation.category,
    });
  }

  /**
   * Start graceful shutdown: stop admission, drain in-flight, close database.
   */
  async shutdown(): Promise<void> {
    this.draining = true;
    this.state = 'draining';

    // Close the database
    if (this.db && !this.db.isClosed) {
      this.db.close();
    }

    this.namespaceAdapter.clear();
    this.state = 'stopped';
  }

  /**
   * Get the current readiness report.
   */
  getReadinessReport(): ReadinessReport {
    const report: ReadinessReport = {
      state: this.state,
      processVersion: this.config.processVersion ?? DEFAULT_PROCESS_VERSION,
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      uptime: Date.now() - this.startTime,
      draining: this.draining,
      databaseConnected: this.db != null && !this.db.isClosed,
      databaseCompatible: this.compatibilityResult?.compatible ?? false,
      migrationState: this.getMigrationState(),
      requiredAuthoritiesAvailable: this.state === 'ready',
    };
    if (this.initError !== undefined) {
      report.reason = this.initError;
    }
    return report;
  }

  /**
   * Get the current readiness state.
   */
  getState(): ReadinessState {
    return this.state;
  }

  /**
   * Get the namespace adapter (for testing/inspection).
   */
  getNamespaceAdapter(): NamespaceAdapter {
    return this.namespaceAdapter;
  }

  // ─── Private Helpers ────────────────────────────────────────

  private handleInitializeRequest(request: JsonRpcRequest): JsonRpcResponse {
    return this.successResponse(request.id, {
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        cancellation: true,
        progress: true,
        logging: true,
      },
      serverInfo: {
        name: SESSION_PROCESS_NAME,
        version: this.config.processVersion ?? DEFAULT_PROCESS_VERSION,
      },
    });
  }

  private registerSessionSurfaces(): void {
    // Register all session surfaces under the namespace
    const surfaces: SurfaceDescriptor[] = [
      // Session lifecycle
      { name: `${SESSION_NAMESPACE_PREFIX}.session.create`, kind: 'tool', description: 'Create a new session' },
      { name: `${SESSION_NAMESPACE_PREFIX}.session.resume`, kind: 'tool', description: 'Resume an existing session' },
      { name: `${SESSION_NAMESPACE_PREFIX}.session.fork`, kind: 'tool', description: 'Fork a session at a given sequence' },
      { name: `${SESSION_NAMESPACE_PREFIX}.session.list`, kind: 'tool', description: 'List sessions' },

      // Replay
      { name: `${SESSION_NAMESPACE_PREFIX}.replay.events`, kind: 'tool', description: 'Replay session events' },
      { name: `${SESSION_NAMESPACE_PREFIX}.replay.verify`, kind: 'tool', description: 'Verify replay integrity' },

      // Projection
      { name: `${SESSION_NAMESPACE_PREFIX}.projection.timeline`, kind: 'resource', description: 'Canonical timeline projection' },
      { name: `${SESSION_NAMESPACE_PREFIX}.projection.header`, kind: 'resource', description: 'Session header projection' },
      { name: `${SESSION_NAMESPACE_PREFIX}.projection.workbench`, kind: 'resource', description: 'Workbench projection' },
      { name: `${SESSION_NAMESPACE_PREFIX}.projection.trajectory`, kind: 'resource', description: 'Trajectory projection' },
      { name: `${SESSION_NAMESPACE_PREFIX}.projection.insights`, kind: 'resource', description: 'Insights projection' },

      // Query
      { name: `${SESSION_NAMESPACE_PREFIX}.query.search`, kind: 'tool', description: 'Full-text session search' },
      { name: `${SESSION_NAMESPACE_PREFIX}.query.filter`, kind: 'tool', description: 'Filtered session query' },

      // Export
      { name: `${SESSION_NAMESPACE_PREFIX}.export.jsonlines`, kind: 'tool', description: 'Export session as JSON-lines' },
      { name: `${SESSION_NAMESPACE_PREFIX}.export.manifest`, kind: 'tool', description: 'Get export manifest' },

      // Compaction
      { name: `${SESSION_NAMESPACE_PREFIX}.compaction.plan`, kind: 'tool', description: 'Plan compaction strategy' },
      { name: `${SESSION_NAMESPACE_PREFIX}.compaction.commit`, kind: 'tool', description: 'Commit compaction' },

      // Spill
      { name: `${SESSION_NAMESPACE_PREFIX}.spill.readRange`, kind: 'tool', description: 'Read spilled tool result range' },
      { name: `${SESSION_NAMESPACE_PREFIX}.spill.preview`, kind: 'tool', description: 'Preview spilled content' },

      // Plan
      { name: `${SESSION_NAMESPACE_PREFIX}.plan.get`, kind: 'resource', description: 'Get current plan state' },
      { name: `${SESSION_NAMESPACE_PREFIX}.plan.history`, kind: 'resource', description: 'Plan revision history' },

      // Accounting
      { name: `${SESSION_NAMESPACE_PREFIX}.accounting.usage`, kind: 'resource', description: 'Usage accounting' },
      { name: `${SESSION_NAMESPACE_PREFIX}.accounting.budget`, kind: 'resource', description: 'Budget status' },

      // Goal
      { name: `${SESSION_NAMESPACE_PREFIX}.goal.create`, kind: 'tool', description: 'Create a goal' },
      { name: `${SESSION_NAMESPACE_PREFIX}.goal.update`, kind: 'tool', description: 'Update a goal' },
      { name: `${SESSION_NAMESPACE_PREFIX}.goal.list`, kind: 'tool', description: 'List goals' },

      // Attachment
      { name: `${SESSION_NAMESPACE_PREFIX}.attachment.prepare`, kind: 'tool', description: 'Prepare attachment upload' },
      { name: `${SESSION_NAMESPACE_PREFIX}.attachment.commit`, kind: 'tool', description: 'Commit attachment' },
      { name: `${SESSION_NAMESPACE_PREFIX}.attachment.readRange`, kind: 'tool', description: 'Read attachment range' },

      // Feedback
      { name: `${SESSION_NAMESPACE_PREFIX}.feedback.submit`, kind: 'tool', description: 'Submit session feedback' },
      { name: `${SESSION_NAMESPACE_PREFIX}.feedback.list`, kind: 'resource', description: 'List feedback entries' },

      // Diagnostic
      { name: `${SESSION_NAMESPACE_PREFIX}.diagnostic.health`, kind: 'tool', description: 'Health check' },
      { name: `${SESSION_NAMESPACE_PREFIX}.diagnostic.compatibility`, kind: 'resource', description: 'Compatibility status' },
      { name: `${SESSION_NAMESPACE_PREFIX}.diagnostic.invariants`, kind: 'tool', description: 'Check invariants' },
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

  private getRegisteredMethodNames(): string[] {
    return Array.from(this.namespaceAdapter.getRegisteredSurfaces().keys());
  }

  private successResponse(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    const error: JsonRpcError = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    return { jsonrpc: '2.0', id, error };
  }
}
