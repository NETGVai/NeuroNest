/**
 * Catalog Versioning — snapshot management and rollback for the agent catalog.
 *
 * Creates point-in-time snapshots of AGENT_REGISTRY and AGENT_TOOL_PERMISSIONS
 * before batch operations. Supports atomic rollback to any retained snapshot.
 * Maintains at most 10 recent snapshots, pruning oldest when the limit is exceeded.
 * Assigns monotonically increasing version numbers (max existing + 1).
 * Logs rollback events to the Audit Chain when available.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5
 */

import type Database from 'better-sqlite3';
import type { CatalogSnapshot } from './types';
import type { AgentDefinition, ToolPermission } from '../agents/agent-registry';
import type { AuditChainInterface } from '../devops-engine/audit-chain';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of snapshots retained. Oldest beyond this limit are pruned. */
const MAX_SNAPSHOTS = 10;

// ─── Database Row Shape ─────────────────────────────────────────

interface CatalogVersionRow {
  version: number;
  timestamp: number;
  registry_snapshot: string;
  permissions_snapshot: string;
  reason: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function rowToSnapshot(row: CatalogVersionRow): CatalogSnapshot {
  return {
    version: row.version,
    timestamp: row.timestamp,
    agentRegistry: JSON.parse(row.registry_snapshot) as AgentDefinition[],
    toolPermissions: JSON.parse(row.permissions_snapshot) as Record<string, ToolPermission>,
    reason: row.reason,
  };
}

// ─── CatalogVersioning Interface ────────────────────────────────

export interface CatalogVersioningInterface {
  /** Create a snapshot of the current catalog state before a batch operation. */
  createSnapshot(reason: string): CatalogSnapshot;

  /** Rollback the catalog to a specified version snapshot. */
  rollback(version: number): void;

  /** List available snapshots (most recent 10, ordered by version ascending). */
  listSnapshots(): CatalogSnapshot[];

  /** Get the current (latest) version number, or 0 if no snapshots exist. */
  getCurrentVersion(): number;
}

// ─── Registry Accessor Interface ────────────────────────────────

/**
 * Abstraction for reading and writing the in-memory agent registry and
 * tool permissions. This decouples catalog versioning from the concrete
 * module-level exports in agent-registry.ts so that restoration can be
 * performed atomically.
 */
export interface RegistryAccessor {
  /** Get the current agent registry state. */
  getRegistry(): AgentDefinition[];

  /** Get the current tool permissions map. */
  getPermissions(): Record<string, ToolPermission>;

  /** Replace the agent registry with the provided state. */
  setRegistry(agents: AgentDefinition[]): void;

  /** Replace the tool permissions map with the provided state. */
  setPermissions(permissions: Record<string, ToolPermission>): void;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Creates a CatalogVersioning instance backed by the provided SQLite database.
 * The `catalog_versions` table must already exist (created by migration 063).
 *
 * @param db - better-sqlite3 database instance
 * @param registryAccessor - accessor for reading/writing in-memory registry state
 * @param auditChain - optional audit chain for logging rollback events
 */
export function createCatalogVersioning(
  db: Database.Database,
  registryAccessor: RegistryAccessor,
  auditChain?: AuditChainInterface
): CatalogVersioningInterface {
  // ─── Prepared Statements ────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO catalog_versions (version, timestamp, registry_snapshot, permissions_snapshot, reason)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getMaxVersionStmt = db.prepare(`
    SELECT MAX(version) as max_version FROM catalog_versions
  `);

  const getSnapshotByVersionStmt = db.prepare(`
    SELECT * FROM catalog_versions WHERE version = ?
  `);

  const listSnapshotsStmt = db.prepare(`
    SELECT * FROM catalog_versions ORDER BY version ASC
  `);

  const countSnapshotsStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM catalog_versions
  `);

  const deleteOldestStmt = db.prepare(`
    DELETE FROM catalog_versions WHERE version = (
      SELECT MIN(version) FROM catalog_versions
    )
  `);

  // ─── Core Methods ───────────────────────────────────────────

  function createSnapshot(reason: string): CatalogSnapshot {
    const registry = registryAccessor.getRegistry();
    const permissions = registryAccessor.getPermissions();

    // Determine next version number (monotonically increasing)
    const maxRow = getMaxVersionStmt.get() as { max_version: number | null };
    const nextVersion = (maxRow.max_version ?? 0) + 1;

    const timestamp = Date.now();
    const registryJson = JSON.stringify(registry);
    const permissionsJson = JSON.stringify(permissions);

    // Insert the new snapshot
    insertStmt.run(nextVersion, timestamp, registryJson, permissionsJson, reason);

    // Prune oldest snapshots beyond the limit
    pruneSnapshots();

    return {
      version: nextVersion,
      timestamp,
      agentRegistry: registry,
      toolPermissions: permissions,
      reason,
    };
  }

  function rollback(version: number): void {
    const row = getSnapshotByVersionStmt.get(version) as CatalogVersionRow | undefined;
    if (!row) {
      throw new Error(`Catalog snapshot version ${version} not found`);
    }

    const snapshot = rowToSnapshot(row);

    // Capture current version for audit log
    const currentMaxRow = getMaxVersionStmt.get() as { max_version: number | null };
    const sourceVersion = currentMaxRow.max_version ?? 0;

    // Atomically restore registry and permissions
    registryAccessor.setRegistry(snapshot.agentRegistry);
    registryAccessor.setPermissions(snapshot.toolPermissions);

    // Log rollback event to Audit Chain if available
    if (auditChain) {
      try {
        auditChain.append({
          timestamp: Date.now(),
          agentId: 'system:catalog-versioning',
          toolName: 'catalog:rollback',
          arguments: {
            sourceVersion,
            targetVersion: version,
            reason: `Rollback from version ${sourceVersion} to version ${version}`,
          },
          resultSummary: `Restored catalog to version ${version} (${snapshot.agentRegistry.length} agents, ${Object.keys(snapshot.toolPermissions).length} permission entries)`,
          duration: 0,
          cost: 0,
        });
      } catch {
        // Audit logging failure should not prevent the rollback from completing
      }
    }
  }

  function listSnapshots(): CatalogSnapshot[] {
    const rows = listSnapshotsStmt.all() as CatalogVersionRow[];
    return rows.map(rowToSnapshot);
  }

  function getCurrentVersion(): number {
    const maxRow = getMaxVersionStmt.get() as { max_version: number | null };
    return maxRow.max_version ?? 0;
  }

  // ─── Internal Helpers ───────────────────────────────────────

  function pruneSnapshots(): void {
    const countRow = countSnapshotsStmt.get() as { cnt: number };
    let excess = countRow.cnt - MAX_SNAPSHOTS;
    while (excess > 0) {
      deleteOldestStmt.run();
      excess--;
    }
  }

  return { createSnapshot, rollback, listSnapshots, getCurrentVersion };
}
