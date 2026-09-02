/**
 * Agent roles — Roo role identities, permission scopes, and the least-privilege
 * permission ceiling (FUT-PKG-06-EXECUTION/T-004).
 *
 * D-07 pins `AgentManifest@1`; the Agent Registry owns activation state. This
 * module defines the role layer the registry validates a manifest and its
 * profile against:
 *
 *   - The declared read/edit/command/MCP permission scopes an agent role may
 *     hold (NN-AGENT-003): read-only planners and prompt enhancers cannot
 *     mutate; delegators cannot call direct tools; security reviewers report
 *     without editing; full-access diagnostic/checkpoint roles remain subject
 *     to the global safety floor.
 *   - The eight distinct Roo role identities (NN-AGENT-004): Architect Planner,
 *     Debug Investigator, Orchestrator Delegator, Prompt Enhancer, Codebase
 *     Indexer, Checkpoint Manager, Legacy Refactorer, and Security Reviewer,
 *     with non-overlapping missions and role-specific permission ceilings whose
 *     IDs do not collide with existing optimizer/auditor identities.
 *   - The **permission ceiling** each role imposes: a profile or custom mode may
 *     only ever be a SUBSET of its role's declared permissions (NN-AGENT-005,
 *     NN-INV-005 least privilege). A profile can never widen a role's scope —
 *     that is the `role-permission-boundary` property (V-AGENT-001).
 *
 * This module is pure and side-effect free: it declares the role catalog and
 * the boundary predicate the registry enforces at activation and at profile
 * selection. It performs no I/O and mutates nothing.
 *
 * Design anchors: D-04 (Agent catalog authority), D-05, D-07 (`AgentManifest@1`),
 * D-13 (orchestration delegation).
 * Requirements: NN-AGENT-003/004/005, NN-INV-005 (least privilege),
 * NN-INV-001/002 (fail closed, safety floor).
 */

// ─── Permission scopes (NN-AGENT-003) ───────────────────────────────────────

/**
 * The four permission scope families a role governs (NN-AGENT-003). Each is a
 * capability the agent may exercise; a role that does not declare a scope can
 * NEVER exercise it, and a profile can never add one the role lacks.
 *
 *   - `read`    — read workspace/source/context.
 *   - `edit`    — mutate files/workspace (a "read-only" role lacks this).
 *   - `command` — run direct commands/tools (a delegator lacks this).
 *   - `mcp`     — call MCP servers/external tools.
 */
export const PERMISSION_SCOPES = Object.freeze([
  'read',
  'edit',
  'command',
  'mcp',
] as const);
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** Whether a value is a known permission scope. */
export function isPermissionScope(value: unknown): value is PermissionScope {
  return (
    typeof value === 'string' &&
    (PERMISSION_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * A permission set: the scopes granted plus the concrete, bounded resource
 * capabilities within them. `read`/`edit`/`command`/`mcp` gate the scope;
 * `commandAllow` and `mcpServers` bound the specific commands/servers the role
 * may reach. `edit` false means the role can NEVER mutate regardless of any
 * profile. Empty capability lists with a granted scope mean "scope allowed but
 * no specific resource pre-authorized" (still fail-closed at the tool
 * pipeline).
 */
export interface PermissionSet {
  readonly read: boolean;
  readonly edit: boolean;
  readonly command: boolean;
  readonly mcp: boolean;
  /** Allowed command verbs (bounded); a subset the role may run. */
  readonly commandAllow: readonly string[];
  /** Allowed MCP server ids (bounded). */
  readonly mcpServers: readonly string[];
}

/** A fully-denied permission set (the safe floor for subtraction). */
export const DENY_ALL: PermissionSet = Object.freeze({
  read: false,
  edit: false,
  command: false,
  mcp: false,
  commandAllow: Object.freeze([]),
  mcpServers: Object.freeze([]),
});

// ─── Roo role identities (NN-AGENT-004) ─────────────────────────────────────

/**
 * The eight distinct Roo role identities (NN-AGENT-004). These IDs are the
 * canonical role identifiers and MUST NOT collide with the existing
 * optimizer/auditor identities (kept in {@link RESERVED_ROLE_IDS}).
 */
export const ROO_ROLE_IDS = Object.freeze([
  'architect-planner',
  'debug-investigator',
  'orchestrator-delegator',
  'prompt-enhancer',
  'codebase-indexer',
  'checkpoint-manager',
  'legacy-refactorer',
  'security-reviewer',
] as const);
export type RooRoleId = (typeof ROO_ROLE_IDS)[number];

/**
 * Existing optimizer/auditor identities the Roo role IDs must not collide with
 * (NN-AGENT-004: "their IDs SHALL not collide with existing optimizer/auditor
 * identities"). Used by {@link isReservedRoleId} so activation rejects a
 * manifest that reuses a reserved id for a Roo role.
 */
export const RESERVED_ROLE_IDS = Object.freeze([
  'optimizer',
  'auditor',
] as const);
export type ReservedRoleId = (typeof RESERVED_ROLE_IDS)[number];

/** Whether an id collides with a reserved optimizer/auditor identity. */
export function isReservedRoleId(id: string): boolean {
  return (RESERVED_ROLE_IDS as readonly string[]).includes(id);
}

/** Whether a value is a known Roo role id. */
export function isRooRoleId(value: unknown): value is RooRoleId {
  return (
    typeof value === 'string' && (ROO_ROLE_IDS as readonly string[]).includes(value)
  );
}

/** A role definition: identity, mission, and its permission CEILING. */
export interface RoleDefinition {
  readonly roleId: RooRoleId;
  /** A short, non-overlapping mission statement (NN-AGENT-004). */
  readonly mission: string;
  /**
   * The permission CEILING: the maximum permissions any profile using this role
   * may hold. A profile permission set must be a subset of this ceiling
   * (NN-AGENT-005, {@link isWithinCeiling}).
   */
  readonly ceiling: PermissionSet;
}

/**
 * The canonical Roo role catalog with role-specific permission ceilings
 * (NN-AGENT-003/004). Missions are non-overlapping:
 *
 *   - **architect-planner** — read-only planning; NO edit, NO command.
 *   - **debug-investigator** — read + bounded diagnostic commands; NO edit.
 *   - **orchestrator-delegator** — delegates; NO direct tool/command calls.
 *   - **prompt-enhancer** — read-only prompt refinement; NO edit/command/mcp.
 *   - **codebase-indexer** — read + index-scoped commands; NO edit.
 *   - **checkpoint-manager** — full read/edit/command for checkpoint/restore
 *     (still subject to the global safety floor, NN-INV-002).
 *   - **legacy-refactorer** — read + edit + bounded refactor commands.
 *   - **security-reviewer** — reports without editing: read + mcp scan; NO edit,
 *     NO command (NN-AGENT-003 "security reviewers report without editing").
 */
export const ROLE_CATALOG: Readonly<Record<RooRoleId, RoleDefinition>> =
  Object.freeze({
    'architect-planner': {
      roleId: 'architect-planner',
      mission: 'Plan architecture and decompose work; read-only planner.',
      ceiling: {
        read: true,
        edit: false,
        command: false,
        mcp: false,
        commandAllow: Object.freeze([]),
        mcpServers: Object.freeze([]),
      },
    },
    'debug-investigator': {
      roleId: 'debug-investigator',
      mission: 'Investigate defects with bounded diagnostics; never mutates.',
      ceiling: {
        read: true,
        edit: false,
        command: true,
        mcp: false,
        commandAllow: Object.freeze(['test', 'lint', 'typecheck', 'inspect']),
        mcpServers: Object.freeze([]),
      },
    },
    'orchestrator-delegator': {
      roleId: 'orchestrator-delegator',
      mission: 'Delegate subtasks to other agents; calls no direct tools.',
      ceiling: {
        read: true,
        edit: false,
        command: false,
        mcp: false,
        commandAllow: Object.freeze([]),
        mcpServers: Object.freeze([]),
      },
    },
    'prompt-enhancer': {
      roleId: 'prompt-enhancer',
      mission: 'Refine prompts; read-only, no execution.',
      ceiling: {
        read: true,
        edit: false,
        command: false,
        mcp: false,
        commandAllow: Object.freeze([]),
        mcpServers: Object.freeze([]),
      },
    },
    'codebase-indexer': {
      roleId: 'codebase-indexer',
      mission: 'Build and refresh the code index; read + index commands.',
      ceiling: {
        read: true,
        edit: false,
        command: true,
        mcp: false,
        commandAllow: Object.freeze(['index', 'scan', 'fingerprint']),
        mcpServers: Object.freeze([]),
      },
    },
    'checkpoint-manager': {
      roleId: 'checkpoint-manager',
      mission: 'Create/restore checkpoints; full-access under the safety floor.',
      ceiling: {
        read: true,
        edit: true,
        command: true,
        mcp: true,
        commandAllow: Object.freeze([
          'checkpoint',
          'restore',
          'rescue',
          'diff',
        ]),
        mcpServers: Object.freeze(['checkpoint-backend']),
      },
    },
    'legacy-refactorer': {
      roleId: 'legacy-refactorer',
      mission: 'Migrate and refactor legacy code; read + edit + refactor cmds.',
      ceiling: {
        read: true,
        edit: true,
        command: true,
        mcp: false,
        commandAllow: Object.freeze(['refactor', 'format', 'test', 'build']),
        mcpServers: Object.freeze([]),
      },
    },
    'security-reviewer': {
      roleId: 'security-reviewer',
      mission: 'Review for security; reports without editing.',
      ceiling: {
        read: true,
        edit: false,
        command: false,
        mcp: true,
        commandAllow: Object.freeze([]),
        mcpServers: Object.freeze(['security-scanner']),
      },
    },
  });

/** Look up a role definition by id, or `undefined` when unknown. */
export function roleDefinition(roleId: string): RoleDefinition | undefined {
  return isRooRoleId(roleId) ? ROLE_CATALOG[roleId] : undefined;
}

/** The role's permission ceiling, or {@link DENY_ALL} for an unknown role. */
export function roleCeiling(roleId: string): PermissionSet {
  return roleDefinition(roleId)?.ceiling ?? DENY_ALL;
}

// ─── Permission ceiling / least-privilege boundary (NN-AGENT-005) ───────────

/**
 * Whether `candidate` is within `ceiling`: it may NOT grant any scope the
 * ceiling denies, and every allowed command/MCP server it names must be a
 * member of the ceiling's allow-list. This is the least-privilege boundary
 * (NN-AGENT-005, NN-INV-005): a profile can never exceed its role's permission
 * ceiling. The relation is reflexive (a ceiling is within itself) and
 * transitive; the property test asserts a profile derived by subtraction is
 * always within the role ceiling and a profile that adds any scope/resource is
 * always rejected.
 */
export function isWithinCeiling(
  candidate: PermissionSet,
  ceiling: PermissionSet,
): boolean {
  // A boolean scope may not be widened: candidate.read implies ceiling.read.
  if (candidate.read && !ceiling.read) return false;
  if (candidate.edit && !ceiling.edit) return false;
  if (candidate.command && !ceiling.command) return false;
  if (candidate.mcp && !ceiling.mcp) return false;

  // A command may only be run if the scope is granted AND it is in the ceiling.
  if (candidate.commandAllow.length > 0 && !candidate.command) return false;
  const ceilingCommands = new Set(ceiling.commandAllow);
  for (const cmd of candidate.commandAllow) {
    if (!ceilingCommands.has(cmd)) return false;
  }

  // An MCP server may only be reached if the scope is granted AND it is listed.
  if (candidate.mcpServers.length > 0 && !candidate.mcp) return false;
  const ceilingServers = new Set(ceiling.mcpServers);
  for (const server of candidate.mcpServers) {
    if (!ceilingServers.has(server)) return false;
  }

  return true;
}

/**
 * Clamp a requested permission set to its ceiling: intersect scopes and
 * resource allow-lists so the result is ALWAYS within the ceiling. Used to
 * derive a least-privilege effective permission set from a profile request
 * without ever widening the role (NN-INV-005). The result satisfies
 * {@link isWithinCeiling}(result, ceiling) for any input.
 */
export function clampToCeiling(
  requested: PermissionSet,
  ceiling: PermissionSet,
): PermissionSet {
  const command = requested.command && ceiling.command;
  const mcp = requested.mcp && ceiling.mcp;
  const ceilingCommands = new Set(ceiling.commandAllow);
  const ceilingServers = new Set(ceiling.mcpServers);
  return {
    read: requested.read && ceiling.read,
    edit: requested.edit && ceiling.edit,
    command,
    mcp,
    commandAllow: command
      ? Object.freeze(requested.commandAllow.filter((c) => ceilingCommands.has(c)))
      : Object.freeze([]),
    mcpServers: mcp
      ? Object.freeze(requested.mcpServers.filter((s) => ceilingServers.has(s)))
      : Object.freeze([]),
  };
}

/**
 * The specific violations by which `candidate` exceeds `ceiling`, for typed
 * audit reporting. Empty means within the ceiling. Never throws.
 */
export function ceilingViolations(
  candidate: PermissionSet,
  ceiling: PermissionSet,
): string[] {
  const out: string[] = [];
  if (candidate.read && !ceiling.read) out.push('scope:read');
  if (candidate.edit && !ceiling.edit) out.push('scope:edit');
  if (candidate.command && !ceiling.command) out.push('scope:command');
  if (candidate.mcp && !ceiling.mcp) out.push('scope:mcp');
  if (candidate.commandAllow.length > 0 && !candidate.command) {
    out.push('command-allow-without-command-scope');
  }
  const ceilingCommands = new Set(ceiling.commandAllow);
  for (const cmd of candidate.commandAllow) {
    if (!ceilingCommands.has(cmd)) out.push(`command:${cmd}`);
  }
  if (candidate.mcpServers.length > 0 && !candidate.mcp) {
    out.push('mcp-server-without-mcp-scope');
  }
  const ceilingServers = new Set(ceiling.mcpServers);
  for (const server of candidate.mcpServers) {
    if (!ceilingServers.has(server)) out.push(`mcp:${server}`);
  }
  return out;
}
