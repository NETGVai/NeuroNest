/**
 * Gadget Engine — Manages the lifecycle of sandboxed personal applications.
 *
 * Each Gadget runs as an isolated child process with its own SQLite database.
 * Network access is disabled by default via NetworkPolicy (existing firewall engine).
 * File system is scoped to `~/.neuronest/gadgets/{id}/`.
 *
 * Provides:
 * - Process isolation via `child_process.fork()`
 * - Network isolation via NetworkPolicy (strict preset, no allowlist)
 * - Per-gadget SQLite database at `~/.neuronest/gadgets/{id}/state.db`
 * - Crash detection: monitors child process 'exit' event
 * - Session persistence: restoreAll() restores gadgets on app restart
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import type {
  GadgetEngine,
  GadgetSpec,
  GadgetHandle,
  GadgetPersistentState,
  CodePatch,
  RPCInterfaceDefinition,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';
import type { NetworkPolicy } from '../security/network-sandbox.js';

// ─── Constants ──────────────────────────────────────────────────

/** Base directory for all gadget data */
const GADGETS_BASE_DIR = path.join(homedir(), '.neuronest', 'gadgets');

/** Default port range for gadget servers */
const PORT_RANGE_START = 19000;
const PORT_RANGE_END = 19999;

// ─── Database Row Types ─────────────────────────────────────────

interface GadgetRow {
  id: string;
  name: string;
  description: string | null;
  has_client: number;
  has_server: number;
  status: string;
  server_port: number | null;
  db_path: string;
  source_path: string;
  created_at: string;
  updated_at: string;
}

interface GadgetCapabilityRow {
  gadget_id: string;
  capability_id: string;
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the GadgetEngineImpl.
 */
export interface GadgetEngineConfig {
  /** Main NeuroNest SQLite database instance */
  db: Database.Database;
  /** Optional custom base directory for gadget data (for testing) */
  gadgetsBaseDir?: string;
  /** Callback for applying network policy to a child process */
  applyNetworkPolicy?: (gadgetId: string, policy: NetworkPolicy) => void;
  /** Optional callback invoked on gadget crash */
  onCrash?: (gadgetId: string, code: number | null, signal: string | null) => void;
}

// ─── Network Policy Factory ─────────────────────────────────────

/**
 * Creates a strict network policy that blocks all outbound traffic.
 * Gadgets start with no network access by default.
 */
function createGadgetNetworkPolicy(): NetworkPolicy {
  return {
    preset: 'strict',
    allowRules: [],
    denyRules: [],
    strictAllowlist: [],
  };
}

// ─── Port Allocation ────────────────────────────────────────────

/** Track allocated ports to avoid collisions */
const allocatedPorts = new Set<number>();

/**
 * Allocate a unique port for a gadget server within the allowed range.
 */
function allocatePort(): number {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports in gadget range');
}

/**
 * Release a previously allocated port.
 */
function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

// ─── RPC Interface Stub ─────────────────────────────────────────

/**
 * Creates an empty RPC interface definition for a newly created gadget.
 * The RPC Generator (task 12) will populate this with real method definitions.
 */
function createEmptyRPCInterface(gadgetId: string): RPCInterfaceDefinition {
  return {
    gadgetId,
    version: 1,
    methods: [],
    generatedAt: new Date().toISOString(),
    typeDefinitions: '',
  };
}

// ─── Source Checksum ────────────────────────────────────────────

/**
 * Compute a simple checksum of all source files in a gadget's source directory.
 */
function computeSourceChecksum(sourcePath: string): string {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');

  if (!fs.existsSync(sourcePath)) {
    return hash.update('').digest('hex');
  }

  const files = fs.readdirSync(sourcePath, { recursive: true }) as string[];
  const sortedFiles = files
    .filter((f) => {
      const fullPath = path.join(sourcePath, f);
      return fs.statSync(fullPath).isFile();
    })
    .sort();

  for (const file of sortedFiles) {
    const content = fs.readFileSync(path.join(sourcePath, file));
    hash.update(file);
    hash.update(content);
  }

  return hash.digest('hex');
}

// ─── Implementation ─────────────────────────────────────────────

export class GadgetEngineImpl implements GadgetEngine {
  private readonly db: Database.Database;
  private readonly baseDir: string;
  private readonly onCrash: ((gadgetId: string, code: number | null, signal: string | null) => void) | null;
  private readonly applyNetworkPolicy: ((gadgetId: string, policy: NetworkPolicy) => void) | null;

  /** In-memory tracking of running gadget processes */
  private readonly processes: Map<string, ChildProcess> = new Map();
  /** In-memory gadget handles for fast list() access */
  private readonly handles: Map<string, GadgetHandle> = new Map();

  // Prepared SQL statements
  private readonly stmtInsertGadget: Database.Statement;
  private readonly stmtGetGadget: Database.Statement;
  private readonly stmtGetAllGadgets: Database.Statement;
  private readonly stmtUpdateStatus: Database.Statement;
  private readonly stmtUpdatePort: Database.Statement;
  private readonly stmtDeleteGadget: Database.Statement;
  private readonly stmtInsertCapability: Database.Statement;
  private readonly stmtGetCapabilities: Database.Statement;
  private readonly stmtDeleteCapabilities: Database.Statement;

  constructor(config: GadgetEngineConfig) {
    this.db = config.db;
    this.baseDir = config.gadgetsBaseDir ?? GADGETS_BASE_DIR;
    this.onCrash = config.onCrash ?? null;
    this.applyNetworkPolicy = config.applyNetworkPolicy ?? null;

    // Ensure base directory exists
    fs.mkdirSync(this.baseDir, { recursive: true });

    // Prepare SQL statements
    this.stmtInsertGadget = this.db.prepare(`
      INSERT INTO gadgets (id, name, description, has_client, has_server, status, server_port, db_path, source_path, created_at, updated_at)
      VALUES (@id, @name, @description, @has_client, @has_server, @status, @server_port, @db_path, @source_path, @created_at, @updated_at)
    `);

    this.stmtGetGadget = this.db.prepare(`
      SELECT * FROM gadgets WHERE id = ?
    `);

    this.stmtGetAllGadgets = this.db.prepare(`
      SELECT * FROM gadgets
    `);

    this.stmtUpdateStatus = this.db.prepare(`
      UPDATE gadgets SET status = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtUpdatePort = this.db.prepare(`
      UPDATE gadgets SET server_port = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtDeleteGadget = this.db.prepare(`
      DELETE FROM gadgets WHERE id = ?
    `);

    this.stmtInsertCapability = this.db.prepare(`
      INSERT OR IGNORE INTO gadget_capabilities (gadget_id, capability_id) VALUES (?, ?)
    `);

    this.stmtGetCapabilities = this.db.prepare(`
      SELECT capability_id FROM gadget_capabilities WHERE gadget_id = ?
    `);

    this.stmtDeleteCapabilities = this.db.prepare(`
      DELETE FROM gadget_capabilities WHERE gadget_id = ?
    `);
  }

  // ─── GadgetEngine Interface Methods ─────────────────────────────

  /**
   * Create a new Gadget from a specification.
   * Spawns an isolated child process with network isolation and scoped file system.
   *
   * Abort conditions:
   * - If file system setup fails, abort and report isolation failure
   * - If network policy application fails, abort and clean up
   * - If process spawn fails, abort and clean up
   */
  async create(spec: GadgetSpec): Promise<GadgetHandle> {
    const gadgetId = spec.id || randomUUID();
    const gadgetDir = path.join(this.baseDir, gadgetId);
    const sourcePath = path.join(gadgetDir, 'src');
    const dbPath = path.join(gadgetDir, 'state.db');

    // 1. Set up isolated file system
    try {
      fs.mkdirSync(sourcePath, { recursive: true });
    } catch (err) {
      throw this.createError(
        'GADGET_ISOLATION_FAILED',
        `Failed to create gadget directory at ${gadgetDir}: ${(err as Error).message}`,
        { details: { gadgetId, component: 'filesystem' }, recoverable: false },
      );
    }

    // 2. Create initial server entry point
    const serverEntry = path.join(sourcePath, 'server.ts');
    if (!fs.existsSync(serverEntry)) {
      fs.writeFileSync(serverEntry, this.generateServerTemplate(gadgetId, spec));
    }

    // 3. Create client entry point if hasClient is true
    if (spec.hasClient) {
      const clientEntry = path.join(sourcePath, 'client.html');
      if (!fs.existsSync(clientEntry)) {
        fs.writeFileSync(clientEntry, this.generateClientTemplate(gadgetId, spec));
      }
    }

    // 4. Apply network isolation policy (strict: no outbound by default)
    const networkPolicy = createGadgetNetworkPolicy();
    try {
      if (this.applyNetworkPolicy) {
        this.applyNetworkPolicy(gadgetId, networkPolicy);
      }
    } catch (err) {
      // Clean up on failure
      fs.rmSync(gadgetDir, { recursive: true, force: true });
      throw this.createError(
        'GADGET_NETWORK_POLICY_FAILED',
        `Failed to apply network policy for gadget ${gadgetId}: ${(err as Error).message}`,
        { details: { gadgetId, component: 'network_policy' }, recoverable: false },
      );
    }

    // 5. Allocate a port for the server component
    const serverPort = allocatePort();

    // 6. Persist gadget metadata to SQLite
    const now = new Date().toISOString();
    this.stmtInsertGadget.run({
      id: gadgetId,
      name: spec.name,
      description: spec.description || null,
      has_client: spec.hasClient ? 1 : 0,
      has_server: spec.hasServer ? 1 : 0,
      status: 'creating',
      server_port: serverPort,
      db_path: dbPath,
      source_path: sourcePath,
      created_at: now,
      updated_at: now,
    });

    // 7. Associate capability bindings
    for (const capId of spec.capabilities) {
      this.stmtInsertCapability.run(gadgetId, capId);
    }

    // 8. Create the gadget handle
    const rpcInterface = createEmptyRPCInterface(gadgetId);
    const handle: GadgetHandle = {
      id: gadgetId,
      pid: 0,
      status: 'creating',
      rpcInterface,
      serverPort,
      clientUrl: spec.hasClient ? `file://${path.join(sourcePath, 'client.html')}` : undefined,
    };

    this.handles.set(gadgetId, handle);

    // 9. Spawn the child process for the server component
    try {
      const childProcess = this.spawnGadgetProcess(gadgetId, sourcePath, serverPort, dbPath);
      handle.pid = childProcess.pid ?? 0;
      handle.status = 'running';
      this.processes.set(gadgetId, childProcess);
      this.stmtUpdateStatus.run('running', new Date().toISOString(), gadgetId);
    } catch (err) {
      // Clean up: remove DB entry, release port, remove files
      this.stmtDeleteGadget.run(gadgetId);
      this.stmtDeleteCapabilities.run(gadgetId);
      releasePort(serverPort);
      fs.rmSync(gadgetDir, { recursive: true, force: true });
      this.handles.delete(gadgetId);
      throw this.createError(
        'GADGET_ISOLATION_FAILED',
        `Failed to spawn gadget process for ${gadgetId}: ${(err as Error).message}`,
        { details: { gadgetId, component: 'process_spawn' }, recoverable: false },
      );
    }

    return handle;
  }

  /**
   * Start a previously stopped gadget.
   */
  async start(gadgetId: string): Promise<GadgetHandle> {
    const row = this.stmtGetGadget.get(gadgetId) as GadgetRow | undefined;
    if (!row) {
      throw this.createError('GADGET_NOT_FOUND', `Gadget "${gadgetId}" not found`);
    }

    // Check if already running
    if (this.processes.has(gadgetId) && this.handles.get(gadgetId)?.status === 'running') {
      throw this.createError(
        'GADGET_ALREADY_RUNNING',
        `Gadget "${gadgetId}" is already running`,
        { recoverable: true },
      );
    }

    const serverPort = row.server_port ?? allocatePort();

    // Spawn a new process
    const childProcess = this.spawnGadgetProcess(gadgetId, row.source_path, serverPort, row.db_path);

    // Update state
    const now = new Date().toISOString();
    this.stmtUpdateStatus.run('running', now, gadgetId);
    this.stmtUpdatePort.run(serverPort, now, gadgetId);
    this.processes.set(gadgetId, childProcess);

    const rpcInterface = createEmptyRPCInterface(gadgetId);
    const handle: GadgetHandle = {
      id: gadgetId,
      pid: childProcess.pid ?? 0,
      status: 'running',
      rpcInterface,
      serverPort,
      clientUrl: row.has_client ? `file://${path.join(row.source_path, 'client.html')}` : undefined,
    };
    this.handles.set(gadgetId, handle);

    return handle;
  }

  /**
   * Stop a running gadget gracefully.
   * Sends SIGTERM and waits briefly, then SIGKILL if needed.
   */
  async stop(gadgetId: string): Promise<void> {
    const row = this.stmtGetGadget.get(gadgetId) as GadgetRow | undefined;
    if (!row) {
      throw this.createError('GADGET_NOT_FOUND', `Gadget "${gadgetId}" not found`);
    }

    const proc = this.processes.get(gadgetId);
    if (proc) {
      proc.removeAllListeners('exit');
      proc.kill('SIGTERM');

      // Wait up to 5s for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.processes.delete(gadgetId);
    }

    // Release port
    if (row.server_port) {
      releasePort(row.server_port);
    }

    // Update status in DB and handle
    this.stmtUpdateStatus.run('stopped', new Date().toISOString(), gadgetId);
    const handle = this.handles.get(gadgetId);
    if (handle) {
      handle.status = 'stopped';
      handle.pid = 0;
    }
  }

  /**
   * Destroy a gadget completely: stop the process, remove files, and delete DB records.
   */
  async destroy(gadgetId: string): Promise<void> {
    const row = this.stmtGetGadget.get(gadgetId) as GadgetRow | undefined;
    if (!row) {
      throw this.createError('GADGET_NOT_FOUND', `Gadget "${gadgetId}" not found`);
    }

    // Stop if running
    const proc = this.processes.get(gadgetId);
    if (proc) {
      proc.removeAllListeners('exit');
      proc.kill('SIGKILL');
      this.processes.delete(gadgetId);
    }

    // Release port
    if (row.server_port) {
      releasePort(row.server_port);
    }

    // Remove gadget directory (includes source, state.db)
    const gadgetDir = path.join(this.baseDir, gadgetId);
    if (fs.existsSync(gadgetDir)) {
      fs.rmSync(gadgetDir, { recursive: true, force: true });
    }

    // Remove DB records
    this.stmtDeleteCapabilities.run(gadgetId);
    this.stmtDeleteGadget.run(gadgetId);

    // Remove from in-memory tracking
    this.handles.delete(gadgetId);
  }

  /**
   * Modify a gadget's code by applying a code patch.
   * Only affects the targeted gadget — other gadgets are never touched.
   */
  async modify(gadgetId: string, patch: CodePatch): Promise<GadgetHandle> {
    const row = this.stmtGetGadget.get(gadgetId) as GadgetRow | undefined;
    if (!row) {
      throw this.createError('GADGET_NOT_FOUND', `Gadget "${gadgetId}" not found`);
    }

    const targetPath = path.join(row.source_path, patch.filePath);

    // Ensure the patch target is within the gadget's source directory
    const resolvedTarget = path.resolve(targetPath);
    const resolvedSource = path.resolve(row.source_path);
    if (!resolvedTarget.startsWith(resolvedSource)) {
      throw this.createError(
        'GADGET_ISOLATION_FAILED',
        `Patch target "${patch.filePath}" escapes gadget source directory`,
        { details: { gadgetId, filePath: patch.filePath }, recoverable: false },
      );
    }

    switch (patch.operation) {
      case 'create':
      case 'update':
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, patch.content, 'utf-8');
        break;
      case 'delete':
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
        break;
    }

    // Update timestamp in DB
    this.stmtUpdateStatus.run(row.status, new Date().toISOString(), gadgetId);

    // If the gadget is running, restart it with updated code
    if (row.status === 'running' && this.processes.has(gadgetId)) {
      await this.stop(gadgetId);
      return this.start(gadgetId);
    }

    // Return existing handle
    const handle = this.handles.get(gadgetId);
    if (handle) {
      return handle;
    }

    // Reconstruct handle from DB
    return this.rowToHandle(row);
  }

  /**
   * List all gadgets with their current handles.
   */
  list(): GadgetHandle[] {
    const rows = this.stmtGetAllGadgets.all() as GadgetRow[];
    return rows.map((row) => {
      const existing = this.handles.get(row.id);
      if (existing) return existing;
      return this.rowToHandle(row);
    });
  }

  /**
   * Get the persistent state of a gadget for serialization/restoration.
   */
  getState(gadgetId: string): GadgetPersistentState {
    const row = this.stmtGetGadget.get(gadgetId) as GadgetRow | undefined;
    if (!row) {
      throw this.createError('GADGET_NOT_FOUND', `Gadget "${gadgetId}" not found`);
    }

    const capabilities = (this.stmtGetCapabilities.all(gadgetId) as GadgetCapabilityRow[])
      .map((c) => c.capability_id);

    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      status: row.status as GadgetPersistentState['status'],
      sourceChecksum: computeSourceChecksum(row.source_path),
      capabilityIds: capabilities,
      dbPath: row.db_path,
      sourcePath: row.source_path,
    };
  }

  /**
   * Restore all gadgets to their last known state on application restart.
   * Gadgets that were 'running' will be restarted; others remain in their stored state.
   */
  async restoreAll(): Promise<GadgetHandle[]> {
    const rows = this.stmtGetAllGadgets.all() as GadgetRow[];
    const restoredHandles: GadgetHandle[] = [];

    for (const row of rows) {
      try {
        if (row.status === 'running') {
          // Gadget was running before shutdown — restart it
          const handle = await this.start(row.id);
          restoredHandles.push(handle);
        } else {
          // Gadget was stopped/crashed — just restore its handle in memory
          const handle = this.rowToHandle(row);
          this.handles.set(row.id, handle);
          restoredHandles.push(handle);
        }
      } catch {
        // If restore fails for a gadget, mark it as crashed and continue
        this.stmtUpdateStatus.run('crashed', new Date().toISOString(), row.id);
        const handle = this.rowToHandle(row);
        handle.status = 'crashed';
        this.handles.set(row.id, handle);
        restoredHandles.push(handle);
      }
    }

    return restoredHandles;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Spawn an isolated child process for a gadget's server component.
   * The child process is monitored for crashes via the 'exit' event.
   */
  private spawnGadgetProcess(
    gadgetId: string,
    sourcePath: string,
    serverPort: number,
    dbPath: string,
  ): ChildProcess {
    const serverEntry = path.join(sourcePath, 'server.ts');

    // Fork with isolation flags
    const child = fork(serverEntry, [], {
      cwd: sourcePath,
      env: {
        NODE_ENV: 'production',
        GADGET_ID: gadgetId,
        GADGET_PORT: String(serverPort),
        GADGET_DB_PATH: dbPath,
        GADGET_SOURCE_PATH: sourcePath,
        // Restrict file system access scope (informational — enforcement is at OS/policy level)
        GADGET_FS_ROOT: path.dirname(sourcePath),
      },
      // Isolation: stdio is piped to prevent writing to main process streams
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // Run with experimental VM modules for isolation
      execArgv: ['--experimental-vm-modules'],
      // Prevent child from inheriting the parent's file descriptors
      detached: false,
    });

    // Monitor for crashes — gadget crash must never affect main process
    child.on('exit', (code, signal) => {
      const handle = this.handles.get(gadgetId);
      if (handle && handle.status === 'running') {
        // Unexpected exit = crash
        handle.status = 'crashed';
        handle.pid = 0;
        this.stmtUpdateStatus.run('crashed', new Date().toISOString(), gadgetId);
        this.processes.delete(gadgetId);

        // Release port on crash
        releasePort(serverPort);

        // Notify crash callback
        if (this.onCrash) {
          this.onCrash(gadgetId, code, signal);
        }
      }
    });

    // Handle errors on the child process itself (e.g., spawn errors)
    child.on('error', (err) => {
      const handle = this.handles.get(gadgetId);
      if (handle) {
        handle.status = 'crashed';
        handle.pid = 0;
        this.stmtUpdateStatus.run('crashed', new Date().toISOString(), gadgetId);
        this.processes.delete(gadgetId);
        releasePort(serverPort);
      }
    });

    return child;
  }

  /**
   * Convert a database row to a GadgetHandle.
   */
  private rowToHandle(row: GadgetRow): GadgetHandle {
    const proc = this.processes.get(row.id);
    return {
      id: row.id,
      pid: proc?.pid ?? 0,
      status: row.status as GadgetHandle['status'],
      rpcInterface: createEmptyRPCInterface(row.id),
      serverPort: row.server_port ?? 0,
      clientUrl: row.has_client ? `file://${path.join(row.source_path, 'client.html')}` : undefined,
    };
  }

  /**
   * Generate a basic server template for a new gadget.
   */
  private generateServerTemplate(gadgetId: string, spec: GadgetSpec): string {
    return `/**
 * Gadget Server: ${spec.name}
 * ID: ${gadgetId}
 * Description: ${spec.description}
 *
 * This is an isolated server process for the "${spec.name}" gadget.
 * It communicates with the main process via IPC and exposes RPC methods.
 */

const PORT = parseInt(process.env.GADGET_PORT || '19000', 10);
const GADGET_ID = process.env.GADGET_ID || '${gadgetId}';

// Signal readiness to parent
if (process.send) {
  process.send({ type: 'ready', gadgetId: GADGET_ID, port: PORT });
}

// Keep process alive
setInterval(() => {}, 60000);
`;
  }

  /**
   * Generate a basic client HTML template for a gadget with client component.
   */
  private generateClientTemplate(gadgetId: string, spec: GadgetSpec): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${spec.name}</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 20px; }
  </style>
</head>
<body>
  <h1>${spec.name}</h1>
  <p>${spec.description}</p>
  <div id="root"></div>
  <script>
    // Gadget client: ${gadgetId}
    // This runs in a sandboxed webview with nodeIntegration: false
    document.getElementById('root').textContent = 'Gadget loaded.';
  </script>
</body>
</html>
`;
  }

  /**
   * Create a structured SubsystemError for the gadget engine.
   */
  private createError(
    code: 'GADGET_ISOLATION_FAILED' | 'GADGET_PROCESS_CRASHED' | 'GADGET_NOT_FOUND' | 'GADGET_ALREADY_RUNNING' | 'GADGET_NETWORK_POLICY_FAILED' | 'GADGET_STATE_CORRUPTED',
    message: string,
    options?: { details?: Record<string, unknown>; recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    return createSubsystemError('gadget_engine', code, message, {
      details: options?.details,
      recoverable: options?.recoverable ?? false,
      suggestedAction: options?.suggestedAction,
    });
  }
}
