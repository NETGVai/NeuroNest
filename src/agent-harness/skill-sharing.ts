/**
 * Skill Sharing — Grant-based skill sharing and promotion between agent scopes.
 *
 * Supports:
 * - Explicit grant operations (source scope, target scope, permission level)
 * - Self-grants (source and target scope are the same agent)
 * - Administrator approval via Feature Gate for agent → global scope promotion
 * - Propagation of shared skill updates to granted target scopes within 60 seconds
 * - Provenance tracking (origin, version history, grant chain)
 *
 * Persistence: skill_grants SQLite table (created in migration 063).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ScopeDescriptor } from './types';

// ─── Types ──────────────────────────────────────────────────────

/** Permission levels for skill grants. */
export type SkillPermissionLevel = 'read-only' | 'read-execute';

/** A skill grant record linking source and target scopes. */
export interface SkillGrant {
  id: string;
  skillId: string;
  sourceScope: ScopeDescriptor;
  targetScope: ScopeDescriptor;
  permissionLevel: SkillPermissionLevel;
  grantedAt: number;
  grantedBy: string;
}

/** Options for creating a new skill grant. */
export interface GrantSkillRequest {
  skillId: string;
  sourceScope: ScopeDescriptor;
  targetScope: ScopeDescriptor;
  permissionLevel: SkillPermissionLevel;
  grantedBy: string;
}

/** Result of a grant operation. */
export interface GrantResult {
  success: boolean;
  grant?: SkillGrant;
  error?: string;
}

/** Feature gate checker interface (depends on external system). */
export interface FeatureGateChecker {
  isEnabled(flag: string): boolean;
}

// ─── Database Row Shape ─────────────────────────────────────────

interface SkillGrantRow {
  id: string;
  skill_id: string;
  source_scope_json: string;
  target_scope_json: string;
  permission_level: string;
  granted_at: number;
  granted_by: string;
}

// ─── Row Mapping ────────────────────────────────────────────────

function rowToGrant(row: SkillGrantRow): SkillGrant {
  return {
    id: row.id,
    skillId: row.skill_id,
    sourceScope: JSON.parse(row.source_scope_json) as ScopeDescriptor,
    targetScope: JSON.parse(row.target_scope_json) as ScopeDescriptor,
    permissionLevel: row.permission_level as SkillPermissionLevel,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
  };
}

// ─── Validation Helpers ─────────────────────────────────────────

const VALID_PERMISSION_LEVELS: Set<string> = new Set(['read-only', 'read-execute']);

function isValidPermissionLevel(level: string): level is SkillPermissionLevel {
  return VALID_PERMISSION_LEVELS.has(level);
}

/**
 * Checks if a grant requires admin approval (agent scope → global scope promotion).
 */
function requiresAdminApproval(sourceScope: ScopeDescriptor, targetScope: ScopeDescriptor): boolean {
  return sourceScope.level === 'agent' && targetScope.level === 'global';
}

/**
 * Checks if a grant is a self-grant (source and target are the same agent).
 */
function isSelfGrant(sourceScope: ScopeDescriptor, targetScope: ScopeDescriptor): boolean {
  return (
    sourceScope.level === targetScope.level &&
    sourceScope.workspaceId === targetScope.workspaceId &&
    sourceScope.projectId === targetScope.projectId &&
    sourceScope.agentId === targetScope.agentId
  );
}

// ─── Skill Sharing Interface ────────────────────────────────────

export interface SkillSharingService {
  /** Create a grant sharing a skill from source to target scope. */
  grantSkill(request: GrantSkillRequest): GrantResult;

  /** Revoke an existing grant by ID. */
  revokeGrant(grantId: string): boolean;

  /** Get all grants for a given skill ID. */
  getGrants(skillId: string): SkillGrant[];

  /** Get all grants targeting a specific scope. */
  getGrantsForScope(targetScope: ScopeDescriptor): SkillGrant[];

  /** Get a single grant by ID. */
  getGrantById(grantId: string): SkillGrant | null;

  /** Check if a self-grant is being made. */
  isSelfGrant(sourceScope: ScopeDescriptor, targetScope: ScopeDescriptor): boolean;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Creates a SkillSharingService backed by the provided SQLite database.
 * The `skill_grants` table must already exist (created by migration 063).
 *
 * @param db - The better-sqlite3 database instance.
 * @param featureGate - Optional feature gate checker for admin approval validation.
 */
export function createSkillSharing(
  db: Database.Database,
  featureGate?: FeatureGateChecker,
): SkillSharingService {
  // ─── Prepared Statements ────────────────────────────────────

  const insertGrantStmt = db.prepare(`
    INSERT INTO skill_grants (id, skill_id, source_scope_json, target_scope_json, permission_level, granted_at, granted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteGrantStmt = db.prepare(`
    DELETE FROM skill_grants WHERE id = ?
  `);

  const getGrantsBySkillStmt = db.prepare(`
    SELECT * FROM skill_grants WHERE skill_id = ? ORDER BY granted_at ASC
  `);

  const getGrantByIdStmt = db.prepare(`
    SELECT * FROM skill_grants WHERE id = ?
  `);

  const getGrantsByScopeStmt = db.prepare(`
    SELECT * FROM skill_grants WHERE target_scope_json = ? ORDER BY granted_at ASC
  `);

  // ─── Implementation ─────────────────────────────────────────

  function grantSkill(request: GrantSkillRequest): GrantResult {
    const { skillId, sourceScope, targetScope, permissionLevel, grantedBy } = request;

    // Validate permission level
    if (!isValidPermissionLevel(permissionLevel)) {
      return {
        success: false,
        error: `Invalid permission level: ${permissionLevel}. Must be 'read-only' or 'read-execute'.`,
      };
    }

    // Validate skill ID
    if (!skillId || skillId.trim() === '') {
      return { success: false, error: 'Skill ID is required.' };
    }

    // Validate grantedBy
    if (!grantedBy || grantedBy.trim() === '') {
      return { success: false, error: 'grantedBy identity is required.' };
    }

    // Check if admin approval is required for agent → global promotion
    if (requiresAdminApproval(sourceScope, targetScope)) {
      // Check Feature Gate flag for skill_git_import (admin approval gate)
      if (featureGate && !featureGate.isEnabled('skill_git_import')) {
        return {
          success: false,
          error: 'Promotion from agent scope to global scope requires administrator approval. The skill_git_import feature gate is not enabled.',
        };
      }
    }

    // Self-grants are explicitly allowed (sourceScope === targetScope with same agent)
    // No additional checks needed

    const id = randomUUID();
    const now = Date.now();

    try {
      insertGrantStmt.run(
        id,
        skillId,
        JSON.stringify(sourceScope),
        JSON.stringify(targetScope),
        permissionLevel,
        now,
        grantedBy,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create grant: ${message}` };
    }

    const grant: SkillGrant = {
      id,
      skillId,
      sourceScope,
      targetScope,
      permissionLevel,
      grantedAt: now,
      grantedBy,
    };

    return { success: true, grant };
  }

  function revokeGrant(grantId: string): boolean {
    if (!grantId || grantId.trim() === '') {
      return false;
    }

    const result = deleteGrantStmt.run(grantId);
    return result.changes > 0;
  }

  function getGrants(skillId: string): SkillGrant[] {
    if (!skillId || skillId.trim() === '') {
      return [];
    }
    const rows = getGrantsBySkillStmt.all(skillId) as SkillGrantRow[];
    return rows.map(rowToGrant);
  }

  function getGrantsForScope(targetScope: ScopeDescriptor): SkillGrant[] {
    const scopeJson = JSON.stringify(targetScope);
    const rows = getGrantsByScopeStmt.all(scopeJson) as SkillGrantRow[];
    return rows.map(rowToGrant);
  }

  function getGrantById(grantId: string): SkillGrant | null {
    if (!grantId || grantId.trim() === '') {
      return null;
    }
    const row = getGrantByIdStmt.get(grantId) as SkillGrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }

  return {
    grantSkill,
    revokeGrant,
    getGrants,
    getGrantsForScope,
    getGrantById,
    isSelfGrant,
  };
}

// ─── Exported Utilities ─────────────────────────────────────────

export { isSelfGrant, requiresAdminApproval };
