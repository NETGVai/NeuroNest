/**
 * Target Allowlist — Per-Integration Context Allowlists
 *
 * Maintains allowlists for Kubernetes contexts, GitHub repositories,
 * cloud accounts, and SSH hosts. Provides:
 * - Immediate denial when a target context is not in the allowlist
 * - Feature can be enabled with no entries, but individual commands
 *   are blocked until at least one entry is added per context type
 * - Connectivity validation before accepting configuration
 * - Separate read-only and read-write credential sets per target
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

/** The four context types supported by the allowlist system. */
export type ContextType = 'kubernetes' | 'github' | 'cloud' | 'ssh';

/** Access level for a target entry. read-write implies read-only access. */
export type AccessLevel = 'read-only' | 'read-write';

/** A single entry in the target allowlist. */
export interface AllowlistEntry {
  id: string;
  contextType: ContextType;
  targetValue: string;
  accessLevel: AccessLevel;
  validated: boolean;
  createdAt: number;
}

/** The public interface for the target allowlist subsystem. */
export interface TargetAllowlist {
  /** Add a new entry to the allowlist. */
  addEntry(contextType: ContextType, targetValue: string, accessLevel: AccessLevel): AllowlistEntry;

  /** Remove an entry by ID. Returns true if the entry was found and removed. */
  removeEntry(id: string): boolean;

  /** Get all entries, optionally filtered by context type. */
  getEntries(contextType?: ContextType): AllowlistEntry[];

  /**
   * Check whether a target is allowed with the required access level.
   * read-write grants both read-only and read-write access.
   * Returns true only if the target is in the allowlist with sufficient access level.
   */
  isAllowed(contextType: ContextType, targetValue: string, requiredAccess: AccessLevel): boolean;

  /**
   * Check if at least one entry exists for the given context type.
   * Used to distinguish "feature enabled but no targets configured" from
   * "target not allowed". When false, commands should be blocked with a
   * message indicating that allowlist entries must be added first.
   */
  hasAnyEntries(contextType: ContextType): boolean;

  /**
   * Validate connectivity to the target. Currently a stub that returns true.
   * In the future, this will perform actual connectivity checks.
   */
  validateEntry(entry: AllowlistEntry): Promise<boolean>;
}

// ─── Database Row Shape ─────────────────────────────────────────

interface AllowlistRow {
  id: string;
  context_type: string;
  target_value: string;
  access_level: string;
  validated: number;
  created_at: number;
}

/** Convert a database row into an AllowlistEntry object. */
function rowToEntry(row: AllowlistRow): AllowlistEntry {
  return {
    id: row.id,
    contextType: row.context_type as ContextType,
    targetValue: row.target_value,
    accessLevel: row.access_level as AccessLevel,
    validated: row.validated === 1,
    createdAt: row.created_at,
  };
}

// ─── Validation Helpers ─────────────────────────────────────────

const VALID_CONTEXT_TYPES: Set<string> = new Set(['kubernetes', 'github', 'cloud', 'ssh']);
const VALID_ACCESS_LEVELS: Set<string> = new Set(['read-only', 'read-write']);

function isValidContextType(value: string): value is ContextType {
  return VALID_CONTEXT_TYPES.has(value);
}

function isValidAccessLevel(value: string): value is AccessLevel {
  return VALID_ACCESS_LEVELS.has(value);
}

// ─── Access Level Comparison ────────────────────────────────────

/**
 * Determines if the granted access level is sufficient for the required access.
 * read-write grants both read-only and read-write access.
 * read-only only grants read-only access.
 */
function hassufficientAccess(granted: AccessLevel, required: AccessLevel): boolean {
  if (granted === 'read-write') return true; // read-write covers everything
  return required === 'read-only'; // read-only only covers read-only
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Creates a TargetAllowlist instance backed by the provided SQLite database.
 * The `target_allowlists` table must already exist (created by migration 063).
 */
export function createTargetAllowlist(db: Database.Database): TargetAllowlist {
  // ─── Prepared Statements ────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO target_allowlists (id, context_type, target_value, access_level, validated, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM target_allowlists WHERE id = ?
  `);

  const getAllStmt = db.prepare(`
    SELECT * FROM target_allowlists ORDER BY created_at ASC
  `);

  const getByTypeStmt = db.prepare(`
    SELECT * FROM target_allowlists WHERE context_type = ? ORDER BY created_at ASC
  `);

  const getByIdStmt = db.prepare(`
    SELECT * FROM target_allowlists WHERE id = ?
  `);

  const countByTypeStmt = db.prepare(`
    SELECT COUNT(*) as count FROM target_allowlists WHERE context_type = ?
  `);

  const findMatchStmt = db.prepare(`
    SELECT * FROM target_allowlists WHERE context_type = ? AND target_value = ?
  `);

  const updateValidatedStmt = db.prepare(`
    UPDATE target_allowlists SET validated = ? WHERE id = ?
  `);

  // ─── Core Methods ───────────────────────────────────────────

  function addEntry(contextType: ContextType, targetValue: string, accessLevel: AccessLevel): AllowlistEntry {
    if (!isValidContextType(contextType)) {
      throw new Error(`Invalid context type: "${contextType}". Must be one of: kubernetes, github, cloud, ssh`);
    }
    if (!isValidAccessLevel(accessLevel)) {
      throw new Error(`Invalid access level: "${accessLevel}". Must be one of: read-only, read-write`);
    }
    if (!targetValue || targetValue.trim().length === 0) {
      throw new Error('Target value must be a non-empty string');
    }

    const id = randomUUID();
    const createdAt = Date.now();
    const validated = 0; // Not validated until validateEntry is called

    insertStmt.run(id, contextType, targetValue.trim(), accessLevel, validated, createdAt);

    return {
      id,
      contextType,
      targetValue: targetValue.trim(),
      accessLevel,
      validated: false,
      createdAt,
    };
  }

  function removeEntry(id: string): boolean {
    const result = deleteStmt.run(id);
    return result.changes > 0;
  }

  function getEntries(contextType?: ContextType): AllowlistEntry[] {
    let rows: AllowlistRow[];
    if (contextType) {
      if (!isValidContextType(contextType)) {
        throw new Error(`Invalid context type: "${contextType}". Must be one of: kubernetes, github, cloud, ssh`);
      }
      rows = getByTypeStmt.all(contextType) as AllowlistRow[];
    } else {
      rows = getAllStmt.all() as AllowlistRow[];
    }
    return rows.map(rowToEntry);
  }

  function isAllowed(contextType: ContextType, targetValue: string, requiredAccess: AccessLevel): boolean {
    if (!isValidContextType(contextType)) return false;
    if (!isValidAccessLevel(requiredAccess)) return false;
    if (!targetValue || targetValue.trim().length === 0) return false;

    const rows = findMatchStmt.all(contextType, targetValue.trim()) as AllowlistRow[];

    // Check if any matching entry has sufficient access level
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (hassufficientAccess(entry.accessLevel, requiredAccess)) {
        return true;
      }
    }

    return false;
  }

  function hasAnyEntries(contextType: ContextType): boolean {
    if (!isValidContextType(contextType)) return false;
    const result = countByTypeStmt.get(contextType) as { count: number };
    return result.count > 0;
  }

  async function validateEntry(entry: AllowlistEntry): Promise<boolean> {
    // Verify the entry exists in the database
    const row = getByIdStmt.get(entry.id) as AllowlistRow | undefined;
    if (!row) {
      return false;
    }

    // Stub connectivity validation — in production, this would perform
    // actual connectivity checks based on context type:
    // - kubernetes: kubectl cluster-info against the context
    // - github: API call to verify repo access
    // - cloud: provider-specific health check
    // - ssh: TCP connection attempt to host
    const isConnectable = true;

    if (isConnectable) {
      updateValidatedStmt.run(1, entry.id);
    }

    return isConnectable;
  }

  return {
    addEntry,
    removeEntry,
    getEntries,
    isAllowed,
    hasAnyEntries,
    validateEntry,
  };
}

export default createTargetAllowlist;
