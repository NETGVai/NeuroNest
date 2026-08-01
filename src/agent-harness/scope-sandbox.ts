/**
 * Scope Sandbox — per-scope isolation enforcement for agent memory, files, and skill access.
 *
 * Enforces that agents can only access resources within their assigned scope boundary.
 * Supports four hierarchical scope levels: global > workspace > project > agent.
 * When skills conflict across scope levels, the narrower scope wins.
 * Violations are recorded in the scope_violations SQLite table for audit purposes.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ScopeDescriptor, ScopeLevel, ScopeViolation } from './types';

// ─── Constants ──────────────────────────────────────────────────

/**
 * Scope hierarchy from broadest (0) to narrowest (3).
 * Higher numeric value = narrower scope.
 */
const SCOPE_HIERARCHY: Record<ScopeLevel, number> = {
  global: 0,
  workspace: 1,
  project: 2,
  agent: 3,
};

// ─── Database Row Shape ─────────────────────────────────────────

interface ScopeViolationRow {
  id: string;
  agent_scope_json: string;
  requested_scope_json: string;
  resource: string;
  timestamp: number;
}

/** Convert a database row into a ScopeViolation object. */
function rowToViolation(row: ScopeViolationRow): ScopeViolation {
  return {
    agentScope: JSON.parse(row.agent_scope_json) as ScopeDescriptor,
    requestedScope: JSON.parse(row.requested_scope_json) as ScopeDescriptor,
    resource: row.resource,
    timestamp: row.timestamp,
  };
}

// ─── Scope Access Logic ─────────────────────────────────────────

/**
 * Determines whether an agent at `agentScope` can access a resource at `resourceScope`.
 *
 * Access rules:
 * - An agent can access resources at the same or broader scope level.
 * - Scope hierarchy: global > workspace > project > agent
 * - An agent at workspace scope can access global and workspace resources (if same workspace).
 * - An agent at project scope can access global, workspace (if same workspace), and project (if same project) resources.
 * - Different project scopes cannot access each other.
 * - Agent scope can access its own agent-level resources but not other agents' resources.
 */
function canAccess(agentScope: ScopeDescriptor, resourceScope: ScopeDescriptor): boolean {
  const agentLevel = SCOPE_HIERARCHY[agentScope.level];
  const resourceLevel = SCOPE_HIERARCHY[resourceScope.level];

  // Resource at global scope is accessible to anyone
  if (resourceScope.level === 'global') {
    return true;
  }

  // Agent must be at the same or narrower scope than the resource
  // (i.e., agent level >= resource level means agent is narrower or equal, which is allowed)
  // Actually, an agent can access resources at the same or BROADER scope.
  // Broader scope means lower numeric value. So resource level must be <= agent level.
  // Wait — let's think carefully:
  //   - An agent at "workspace" scope can access "global" and "workspace" resources.
  //   - An agent at "project" scope can access "global", "workspace" (same ws), "project" (same project).
  //   - An agent at "agent" scope can access "global", "workspace" (same ws), "project" (same project), "agent" (same agent).
  //
  // So the rule is: resource scope level must be <= agent scope level (resource is at same or broader level)
  // AND the scope identifiers must match for shared dimensions.

  if (resourceLevel > agentLevel) {
    // Resource is at a narrower scope than the agent — cannot access
    // e.g., agent at workspace scope trying to access project-level resource
    return false;
  }

  // Resource is at the same or broader scope — check identifier matching
  // For workspace-level resources: must be in the same workspace
  if (resourceScope.level === 'workspace') {
    return resourceScope.workspaceId === agentScope.workspaceId;
  }

  // For project-level resources: must be in the same workspace AND same project
  if (resourceScope.level === 'project') {
    return (
      resourceScope.workspaceId === agentScope.workspaceId &&
      resourceScope.projectId === agentScope.projectId
    );
  }

  // For agent-level resources: must be the same agent
  if (resourceScope.level === 'agent') {
    return (
      resourceScope.workspaceId === agentScope.workspaceId &&
      resourceScope.projectId === agentScope.projectId &&
      resourceScope.agentId === agentScope.agentId
    );
  }

  return false;
}

/**
 * Resolves a skill conflict by preferring the narrower scope.
 * Scope hierarchy (narrowest first): agent > project > workspace > global.
 *
 * When multiple skills exist at different scope levels, the one at the
 * narrowest scope wins because it is more specific to the current context.
 */
function resolveSkillConflict<T>(skills: Array<{ scope: ScopeDescriptor; skill: T }>): T {
  if (skills.length === 0) {
    throw new Error('resolveSkillConflict requires at least one skill');
  }

  if (skills.length === 1) {
    return skills[0]!.skill;
  }

  // Sort by scope level descending (narrowest = highest numeric value first)
  const sorted = [...skills].sort(
    (a, b) => SCOPE_HIERARCHY[b.scope.level] - SCOPE_HIERARCHY[a.scope.level]
  );

  return sorted[0]!.skill;
}

// ─── ScopeSandbox Interface ─────────────────────────────────────

export interface ScopeSandboxInterface {
  /** Check if an agent can access a resource at a given scope. */
  canAccess(agentScope: ScopeDescriptor, resourceScope: ScopeDescriptor): boolean;

  /** Resolve conflicting skills across scopes (narrower wins). */
  resolveSkillConflict<T>(skills: Array<{ scope: ScopeDescriptor; skill: T }>): T;

  /** Record a scope violation attempt to the database. */
  recordViolation(violation: ScopeViolation): void;

  /** Get violations since a given timestamp (or all if not specified). */
  getViolations(since?: number): ScopeViolation[];
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Creates a ScopeSandbox instance backed by the provided SQLite database.
 * The `scope_violations` table must already exist (created by migration 063).
 */
export function createScopeSandbox(db: Database.Database): ScopeSandboxInterface {
  // ─── Prepared Statements ────────────────────────────────────

  const insertViolationStmt = db.prepare(`
    INSERT INTO scope_violations (id, agent_scope_json, requested_scope_json, resource, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getViolationsSinceStmt = db.prepare(`
    SELECT * FROM scope_violations WHERE timestamp >= ? ORDER BY timestamp ASC
  `);

  const getAllViolationsStmt = db.prepare(`
    SELECT * FROM scope_violations ORDER BY timestamp ASC
  `);

  // ─── Methods ────────────────────────────────────────────────

  function recordViolation(violation: ScopeViolation): void {
    const id = randomUUID();
    insertViolationStmt.run(
      id,
      JSON.stringify(violation.agentScope),
      JSON.stringify(violation.requestedScope),
      violation.resource,
      violation.timestamp
    );
  }

  function getViolations(since?: number): ScopeViolation[] {
    let rows: ScopeViolationRow[];
    if (since != null) {
      rows = getViolationsSinceStmt.all(since) as ScopeViolationRow[];
    } else {
      rows = getAllViolationsStmt.all() as ScopeViolationRow[];
    }
    return rows.map(rowToViolation);
  }

  return {
    canAccess,
    resolveSkillConflict,
    recordViolation,
    getViolations,
  };
}

// ─── Exported Utilities ─────────────────────────────────────────

/**
 * Exported for testing — the scope hierarchy mapping.
 */
export { SCOPE_HIERARCHY, canAccess as canAccessPure, resolveSkillConflict as resolveSkillConflictPure };
