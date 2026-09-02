/**
 * WorkspaceAuthority — explicit Project/Workspace/Repository/Session/Worktree
 * identity and optimistic concurrency (FUT-PKG-05-RECOVERY/T-001).
 *
 * D-04 assigns single-owner write authority for Project (`ProjectService`),
 * Workspace (`WorkspaceService`), Session (`SessionService`), Worktree, and the
 * related Repository identity. This module implements that ownership as one
 * cohesive Workspace Authority so there is exactly one writer per identity
 * class and no implicit global "active project" root can drive a mutation:
 *
 *   - Every identity record has a stable opaque `id` (D-06.1) and a monotonic
 *     `revision` (D-06.1). A create allocates revision 1; every update supplies
 *     `expectedRevision` and, when it is stale, the write has NO effect and
 *     returns a typed `STALE_REVISION` `ErrorEnvelope@1` (D-06.2, NN-DATA-004).
 *   - A related-project graph stores explicit, reversible relationships between
 *     Projects (path, stack, purpose, interfaces, dependency kind) rather than
 *     inferring multi-repo topology from path ambiguity (NN-WORKSPACE-006/013,
 *     NN-IDENT-002).
 *   - Every mutation resolves an explicit workspace root from Project + Session
 *     + Worktree identity; the resolved root is never an implicit global active
 *     root (NN-WORKSPACE-001).
 *
 * All writes are routed through {@link applyAuthorityMutation} (the T-001
 * durability transaction) so each mutation is atomic and single-owner: the
 * business-table change, the authority-revision bump, the per-scope sequence,
 * the `CommandReceipt@1`, and one `OutboxRecord@1` per emitted event all commit
 * together or not at all (D-04, D-08.2). New identity tables are created behind
 * the authority additively; no existing business table gains a second writer,
 * so rollback simply restores the prior reader (NN-COMPAT-001/002, NN-INV-008).
 *
 * Design anchors: D-04, D-05, D-07 (identity/record shapes), D-12/D-14 (root
 * resolution feeds ChangeSet/Checkpoint), D-16 (typed `PathRef` root), D-18.
 * Requirements: NN-WORKSPACE-001–008/013, NN-DATA-004/008, NN-IDENT-001/002/006,
 * NN-INV-007/008.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type EventIntent,
} from '../storage/authority-transaction.js';

// ─── Durable identity records (D-04 / D-07 record shapes) ───────────────────

/** A durable Project identity (D-04 Project row). */
export interface ProjectRecord {
  readonly projectId: string;
  readonly revision: number;
  /** Human-facing display name; not an identity key. */
  readonly name: string;
  /** Canonical, resolved absolute root path for this project. */
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A durable Repository identity bound to a Project (D-04 Workspace/repo). */
export interface RepositoryRecord {
  readonly repositoryId: string;
  readonly projectId: string;
  readonly revision: number;
  /** Whether this project root is a Git repository. */
  readonly isGitRepository: boolean;
  /** Resolved repository root path (contained within/at the project root). */
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A durable Workspace identity (D-04 Workspace row). */
export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly revision: number;
  /** Resolved workspace root identity path. */
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A durable Session identity (D-04 Session row). */
export interface SessionRecord {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A durable Worktree identity (D-04 Worktree; NN-WORKSPACE-007/008). */
export interface WorktreeRecord {
  readonly worktreeId: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  /** The session this worktree isolates work for, when session-scoped. */
  readonly sessionId: string | null;
  readonly revision: number;
  /** Branch this worktree tracks, when a Git repository. */
  readonly branch: string | null;
  /** Resolved worktree root path; routes all file/shell/diff/tree operations. */
  readonly rootPath: string;
  /** Preservation state: uncommitted worktrees are never auto-pruned. */
  readonly state: WorktreeState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Worktree preservation lifecycle (NN-WORKSPACE-008). */
export type WorktreeState = 'active' | 'merged' | 'archived';

/**
 * An explicit, reversible relationship between two Projects (NN-WORKSPACE-006,
 * NN-WORKSPACE-013, NN-IDENT-002). The graph is directed from `projectId` to
 * `relatedProjectId`; callers may register the reverse edge for symmetry.
 */
export interface RelatedProjectEdge {
  readonly edgeId: string;
  readonly projectId: string;
  readonly relatedProjectId: string;
  readonly revision: number;
  /** Dependency kind, e.g. `depends-on`, `sibling`, `imports`, `consumes`. */
  readonly relationship: string;
  /** Bounded descriptors preserved for prompt summaries (NN-WORKSPACE-006). */
  readonly stack: string | null;
  readonly purpose: string | null;
  readonly interfaces: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A fully explicit resolved workspace root for a mutation. Every field is an
 * explicit identity — there is no implicit global active root (NN-WORKSPACE-001).
 * `rootPath` is the concrete filesystem root the operation must use; when a
 * worktree is present it wins, otherwise the workspace root is used.
 */
export interface ResolvedWorkspaceRoot {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly worktreeId: string | null;
  readonly repositoryId: string | null;
  readonly rootPath: string;
  /** Which identity supplied the root path. */
  readonly rootSource: 'worktree' | 'workspace';
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** The Workspace Authority owner id stamped on receipts/events/errors. */
export const WORKSPACE_AUTHORITY = 'authority-workspace';

/** Typed conflict returned when an operation cannot proceed. */
export class WorkspaceConflictError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'WorkspaceConflictError';
    this.error = error;
  }
}

function makeError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: WORKSPACE_AUTHORITY,
    operation,
    correlationId,
    retryable: code === 'STALE_REVISION',
    redaction: 'internal',
    ...extra,
  };
}

// ─── Durable identity tables (additive, behind the authority) ───────────────

const IDENTITY_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS workspace_projects (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_repositories (
    repository_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    is_git_repository INTEGER NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES workspace_projects (project_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_workspaces (
    workspace_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repository_id TEXT,
    revision INTEGER NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES workspace_projects (project_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES workspace_projects (project_id),
    FOREIGN KEY (workspace_id) REFERENCES workspace_workspaces (workspace_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_worktrees (
    worktree_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repository_id TEXT,
    session_id TEXT,
    revision INTEGER NOT NULL,
    branch TEXT,
    root_path TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES workspace_projects (project_id)
  );

  -- Explicit, reversible related-project graph (NN-WORKSPACE-006/013).
  CREATE TABLE IF NOT EXISTS workspace_related_projects (
    edge_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    related_project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    relationship TEXT NOT NULL,
    stack TEXT,
    purpose TEXT,
    interfaces TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, related_project_id, relationship),
    FOREIGN KEY (project_id) REFERENCES workspace_projects (project_id),
    FOREIGN KEY (related_project_id) REFERENCES workspace_projects (project_id)
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_repositories_project
    ON workspace_repositories (project_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_workspaces_project
    ON workspace_workspaces (project_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_sessions_project
    ON workspace_sessions (project_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_worktrees_session
    ON workspace_worktrees (session_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_related_project
    ON workspace_related_projects (project_id);
`;

/**
 * Create the durability primitives and the workspace identity tables. Additive
 * and idempotent: safe at startup and in tests. Never mutates a business table
 * owned by another writer.
 */
export function ensureWorkspaceTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(IDENTITY_TABLES_DDL);
}

// ─── Command shapes ─────────────────────────────────────────────────────────

/** Fields shared by every Workspace Authority command. */
export interface CommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** The command scope; keys the per-scope sequence and threads identity. */
  readonly scope: ScopeDescriptor;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

export interface CreateProjectCommand extends CommandContext {
  readonly name: string;
  readonly rootPath: string;
}

export interface UpdateProjectCommand extends CommandContext {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly rootPath?: string;
}

export interface CreateRepositoryCommand extends CommandContext {
  readonly projectId: string;
  readonly isGitRepository: boolean;
  readonly rootPath: string;
}

export interface CreateWorkspaceCommand extends CommandContext {
  readonly projectId: string;
  readonly repositoryId?: string;
  readonly rootPath: string;
}

export interface CreateSessionCommand extends CommandContext {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface CreateWorktreeCommand extends CommandContext {
  readonly projectId: string;
  readonly repositoryId?: string;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly rootPath: string;
}

export interface UpdateWorktreeStateCommand extends CommandContext {
  readonly worktreeId: string;
  readonly expectedRevision: number;
  readonly state: WorktreeState;
}

export interface RelateProjectsCommand extends CommandContext {
  readonly projectId: string;
  readonly relatedProjectId: string;
  readonly relationship: string;
  readonly stack?: string;
  readonly purpose?: string;
  readonly interfaces?: string;
}

/** Result of a create/update: the committed record and its receipt id. */
export interface WorkspaceMutationResult<T> {
  readonly record: T;
  readonly receiptId: string;
  readonly authorityRevision: number;
}

// ─── The Workspace Authority (single owner per identity class) ──────────────

/**
 * The single write owner for Project/Repository/Workspace/Session/Worktree
 * identity and the related-project graph. All mutations route through the T-001
 * authority transaction; reads are direct SELECTs against the identity tables.
 */
export class WorkspaceAuthority {
  constructor(private readonly db: Database.Database) {
    ensureWorkspaceTables(db);
  }

  // ── Project ──────────────────────────────────────────────────────────────

  /** Create a Project with a stable id at revision 1. */
  createProject(cmd: CreateProjectCommand): WorkspaceMutationResult<ProjectRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const projectId = makeOpaqueId('prj', `${cmd.commandId}${cmd.name}`);
    let record!: ProjectRecord;

    const outcome = this.mutate(cmd, 'create-project', (tx) => {
      record = {
        projectId,
        revision: 1,
        name: cmd.name,
        rootPath: cmd.rootPath,
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_projects
           (project_id, revision, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(projectId, 1, cmd.name, cmd.rootPath, now, now);
      return { resultRef: makeOpaqueId('res', projectId) };
    }, [this.event('project.created', 'project', projectId, { projectId, name: cmd.name })]);

    return this.finish(outcome, () => record, cmd, 'create-project');
  }

  /**
   * Update a Project under optimistic concurrency. A stale `expectedRevision`
   * returns `STALE_REVISION` with NO effect and preserves the current record
   * (NN-DATA-004, NN-WORKSPACE-005). Last-writer-wins is impossible.
   */
  updateProject(cmd: UpdateProjectCommand): WorkspaceMutationResult<ProjectRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    let record!: ProjectRecord;

    const outcome = this.mutate(cmd, 'update-project', (tx) => {
      const current = this.readProject(cmd.projectId);
      if (!current) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `project ${cmd.projectId} not found`, 'update-project', cmd.correlationId),
        );
      }
      this.assertRevision(current.revision, cmd.expectedRevision, 'update-project', cmd.correlationId);
      const nextRevision = current.revision + 1;
      record = {
        ...current,
        revision: nextRevision,
        name: cmd.name ?? current.name,
        rootPath: cmd.rootPath ?? current.rootPath,
        updatedAt: now,
      };
      tx.prepare(
        `UPDATE workspace_projects
           SET revision = ?, name = ?, root_path = ?, updated_at = ?
         WHERE project_id = ? AND revision = ?`,
      ).run(nextRevision, record.name, record.rootPath, now, cmd.projectId, cmd.expectedRevision);
      return { resultRef: makeOpaqueId('res', `${cmd.projectId}${nextRevision}`) };
    }, [this.event('project.updated', 'project', cmd.projectId, { projectId: cmd.projectId })]);

    return this.finish(outcome, () => record, cmd, 'update-project');
  }

  /** Read a Project record, or `undefined` if absent. */
  readProject(projectId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, revision, name, root_path AS rootPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_projects WHERE project_id = ?`,
      )
      .get(projectId) as ProjectRecord | undefined;
    return row;
  }

  // ── Repository ───────────────────────────────────────────────────────────

  createRepository(cmd: CreateRepositoryCommand): WorkspaceMutationResult<RepositoryRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const repositoryId = makeOpaqueId('repo', `${cmd.commandId}${cmd.projectId}`);
    let record!: RepositoryRecord;

    const outcome = this.mutate(cmd, 'create-repository', (tx) => {
      if (!this.readProject(cmd.projectId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `project ${cmd.projectId} not found`, 'create-repository', cmd.correlationId),
        );
      }
      record = {
        repositoryId,
        projectId: cmd.projectId,
        revision: 1,
        isGitRepository: cmd.isGitRepository,
        rootPath: cmd.rootPath,
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_repositories
           (repository_id, project_id, revision, is_git_repository, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(repositoryId, cmd.projectId, 1, cmd.isGitRepository ? 1 : 0, cmd.rootPath, now, now);
      return { resultRef: makeOpaqueId('res', repositoryId) };
    }, [this.event('repository.created', 'repository', repositoryId, { repositoryId, projectId: cmd.projectId })]);

    return this.finish(outcome, () => record, cmd, 'create-repository');
  }

  readRepository(repositoryId: string): RepositoryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT repository_id AS repositoryId, project_id AS projectId, revision,
                is_git_repository AS isGit, root_path AS rootPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_repositories WHERE repository_id = ?`,
      )
      .get(repositoryId) as
      | (Omit<RepositoryRecord, 'isGitRepository'> & { isGit: number })
      | undefined;
    if (!row) return undefined;
    const { isGit, ...rest } = row;
    return { ...rest, isGitRepository: isGit === 1 };
  }

  // ── Workspace ────────────────────────────────────────────────────────────

  createWorkspace(cmd: CreateWorkspaceCommand): WorkspaceMutationResult<WorkspaceRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const workspaceId = makeOpaqueId('wsp', `${cmd.commandId}${cmd.projectId}`);
    let record!: WorkspaceRecord;

    const outcome = this.mutate(cmd, 'create-workspace', (tx) => {
      if (!this.readProject(cmd.projectId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `project ${cmd.projectId} not found`, 'create-workspace', cmd.correlationId),
        );
      }
      if (cmd.repositoryId && !this.readRepository(cmd.repositoryId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `repository ${cmd.repositoryId} not found`, 'create-workspace', cmd.correlationId),
        );
      }
      record = {
        workspaceId,
        projectId: cmd.projectId,
        repositoryId: cmd.repositoryId ?? null,
        revision: 1,
        rootPath: cmd.rootPath,
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_workspaces
           (workspace_id, project_id, repository_id, revision, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(workspaceId, cmd.projectId, cmd.repositoryId ?? null, 1, cmd.rootPath, now, now);
      return { resultRef: makeOpaqueId('res', workspaceId) };
    }, [this.event('workspace.created', 'workspace', workspaceId, { workspaceId, projectId: cmd.projectId })]);

    return this.finish(outcome, () => record, cmd, 'create-workspace');
  }

  readWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, project_id AS projectId, repository_id AS repositoryId,
                revision, root_path AS rootPath, created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_workspaces WHERE workspace_id = ?`,
      )
      .get(workspaceId) as WorkspaceRecord | undefined;
    return row;
  }

  // ── Session ──────────────────────────────────────────────────────────────

  createSession(cmd: CreateSessionCommand): WorkspaceMutationResult<SessionRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const sessionId = makeOpaqueId('ses', `${cmd.commandId}${cmd.workspaceId}`);
    let record!: SessionRecord;

    const outcome = this.mutate(cmd, 'create-session', (tx) => {
      const workspace = this.readWorkspace(cmd.workspaceId);
      if (!workspace) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `workspace ${cmd.workspaceId} not found`, 'create-session', cmd.correlationId),
        );
      }
      if (workspace.projectId !== cmd.projectId) {
        throw new WorkspaceConflictError(
          makeError(
            'CONFLICT',
            `workspace ${cmd.workspaceId} does not belong to project ${cmd.projectId}`,
            'create-session',
            cmd.correlationId,
          ),
        );
      }
      record = {
        sessionId,
        projectId: cmd.projectId,
        workspaceId: cmd.workspaceId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_sessions
           (session_id, project_id, workspace_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, cmd.projectId, cmd.workspaceId, 1, now, now);
      return { resultRef: makeOpaqueId('res', sessionId) };
    }, [this.event('session.created', 'session', sessionId, { sessionId, workspaceId: cmd.workspaceId })]);

    return this.finish(outcome, () => record, cmd, 'create-session');
  }

  readSession(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId, workspace_id AS workspaceId,
                revision, created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as SessionRecord | undefined;
    return row;
  }

  // ── Worktree ─────────────────────────────────────────────────────────────

  createWorktree(cmd: CreateWorktreeCommand): WorkspaceMutationResult<WorktreeRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const worktreeId = makeOpaqueId('wtr', `${cmd.commandId}${cmd.rootPath}`);
    let record!: WorktreeRecord;

    const outcome = this.mutate(cmd, 'create-worktree', (tx) => {
      if (!this.readProject(cmd.projectId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `project ${cmd.projectId} not found`, 'create-worktree', cmd.correlationId),
        );
      }
      if (cmd.sessionId && !this.readSession(cmd.sessionId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `session ${cmd.sessionId} not found`, 'create-worktree', cmd.correlationId),
        );
      }
      record = {
        worktreeId,
        projectId: cmd.projectId,
        repositoryId: cmd.repositoryId ?? null,
        sessionId: cmd.sessionId ?? null,
        revision: 1,
        branch: cmd.branch ?? null,
        rootPath: cmd.rootPath,
        state: 'active',
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_worktrees
           (worktree_id, project_id, repository_id, session_id, revision, branch, root_path, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        worktreeId,
        cmd.projectId,
        cmd.repositoryId ?? null,
        cmd.sessionId ?? null,
        1,
        cmd.branch ?? null,
        cmd.rootPath,
        'active',
        now,
        now,
      );
      return { resultRef: makeOpaqueId('res', worktreeId) };
    }, [this.event('worktree.created', 'worktree', worktreeId, { worktreeId, projectId: cmd.projectId })]);

    return this.finish(outcome, () => record, cmd, 'create-worktree');
  }

  /**
   * Transition a worktree's preservation state under optimistic concurrency.
   * A stale `expectedRevision` returns `STALE_REVISION` with no effect
   * (NN-WORKSPACE-008: preservation never overwritten by a stale caller).
   */
  updateWorktreeState(cmd: UpdateWorktreeStateCommand): WorkspaceMutationResult<WorktreeRecord> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    let record!: WorktreeRecord;

    const outcome = this.mutate(cmd, 'update-worktree-state', (tx) => {
      const current = this.readWorktree(cmd.worktreeId);
      if (!current) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `worktree ${cmd.worktreeId} not found`, 'update-worktree-state', cmd.correlationId),
        );
      }
      this.assertRevision(current.revision, cmd.expectedRevision, 'update-worktree-state', cmd.correlationId);
      const nextRevision = current.revision + 1;
      record = { ...current, revision: nextRevision, state: cmd.state, updatedAt: now };
      tx.prepare(
        `UPDATE workspace_worktrees SET revision = ?, state = ?, updated_at = ?
         WHERE worktree_id = ? AND revision = ?`,
      ).run(nextRevision, cmd.state, now, cmd.worktreeId, cmd.expectedRevision);
      return { resultRef: makeOpaqueId('res', `${cmd.worktreeId}${nextRevision}`) };
    }, [this.event('worktree.state-changed', 'worktree', cmd.worktreeId, { worktreeId: cmd.worktreeId, state: cmd.state })]);

    return this.finish(outcome, () => record, cmd, 'update-worktree-state');
  }

  readWorktree(worktreeId: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT worktree_id AS worktreeId, project_id AS projectId, repository_id AS repositoryId,
                session_id AS sessionId, revision, branch, root_path AS rootPath, state,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_worktrees WHERE worktree_id = ?`,
      )
      .get(worktreeId) as WorktreeRecord | undefined;
    return row;
  }

  // ── Related-project graph (NN-WORKSPACE-006/013, NN-IDENT-002) ────────────

  /**
   * Register an explicit, reversible related-project edge. Storing the
   * relationship removes path ambiguity for multi-repo topology: related
   * projects are looked up through the graph, never inferred from directory
   * layout. A duplicate `(project, related, relationship)` conflicts.
   */
  relateProjects(cmd: RelateProjectsCommand): WorkspaceMutationResult<RelatedProjectEdge> {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    const edgeId = makeOpaqueId('rel', `${cmd.projectId}${cmd.relatedProjectId}${cmd.relationship}`);
    let record!: RelatedProjectEdge;

    const outcome = this.mutate(cmd, 'relate-projects', (tx) => {
      if (cmd.projectId === cmd.relatedProjectId) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', 'a project cannot be related to itself', 'relate-projects', cmd.correlationId),
        );
      }
      if (!this.readProject(cmd.projectId) || !this.readProject(cmd.relatedProjectId)) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', 'both projects must exist to relate them', 'relate-projects', cmd.correlationId),
        );
      }
      const existing = this.db
        .prepare(
          `SELECT edge_id FROM workspace_related_projects
           WHERE project_id = ? AND related_project_id = ? AND relationship = ?`,
        )
        .get(cmd.projectId, cmd.relatedProjectId, cmd.relationship) as { edge_id: string } | undefined;
      if (existing) {
        throw new WorkspaceConflictError(
          makeError(
            'CONFLICT',
            `relationship ${cmd.relationship} between ${cmd.projectId} and ${cmd.relatedProjectId} already exists`,
            'relate-projects',
            cmd.correlationId,
          ),
        );
      }
      record = {
        edgeId,
        projectId: cmd.projectId,
        relatedProjectId: cmd.relatedProjectId,
        revision: 1,
        relationship: cmd.relationship,
        stack: cmd.stack ?? null,
        purpose: cmd.purpose ?? null,
        interfaces: cmd.interfaces ?? null,
        createdAt: now,
        updatedAt: now,
      };
      tx.prepare(
        `INSERT INTO workspace_related_projects
           (edge_id, project_id, related_project_id, revision, relationship, stack, purpose, interfaces, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        edgeId,
        cmd.projectId,
        cmd.relatedProjectId,
        1,
        cmd.relationship,
        cmd.stack ?? null,
        cmd.purpose ?? null,
        cmd.interfaces ?? null,
        now,
        now,
      );
      return { resultRef: makeOpaqueId('res', edgeId) };
    }, [this.event('project.related', 'related-project', edgeId, { projectId: cmd.projectId, relatedProjectId: cmd.relatedProjectId })]);

    return this.finish(outcome, () => record, cmd, 'relate-projects');
  }

  /**
   * Reversibly remove a related-project edge (NN-WORKSPACE-013 reversible
   * registration). Returns the receipt; the edge is gone with no effect on the
   * Projects themselves.
   */
  unrelateProjects(cmd: RelateProjectsCommand): WorkspaceMutationResult<{ readonly edgeId: string }> {
    let removed!: { readonly edgeId: string };
    const outcome = this.mutate(cmd, 'unrelate-projects', (tx) => {
      const existing = this.db
        .prepare(
          `SELECT edge_id AS edgeId FROM workspace_related_projects
           WHERE project_id = ? AND related_project_id = ? AND relationship = ?`,
        )
        .get(cmd.projectId, cmd.relatedProjectId, cmd.relationship) as { edgeId: string } | undefined;
      if (!existing) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', 'relationship not found', 'unrelate-projects', cmd.correlationId),
        );
      }
      removed = existing;
      tx.prepare(
        `DELETE FROM workspace_related_projects
         WHERE project_id = ? AND related_project_id = ? AND relationship = ?`,
      ).run(cmd.projectId, cmd.relatedProjectId, cmd.relationship);
      return { resultRef: makeOpaqueId('res', existing.edgeId) };
    }, [this.event('project.unrelated', 'related-project', cmd.projectId, { projectId: cmd.projectId, relatedProjectId: cmd.relatedProjectId })]);

    return this.finish(outcome, () => removed, cmd, 'unrelate-projects');
  }

  /** List the explicit related projects for a project (directed edges). */
  listRelatedProjects(projectId: string): RelatedProjectEdge[] {
    const rows = this.db
      .prepare(
        `SELECT edge_id AS edgeId, project_id AS projectId, related_project_id AS relatedProjectId,
                revision, relationship, stack, purpose, interfaces,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspace_related_projects WHERE project_id = ? ORDER BY created_at, edge_id`,
      )
      .all(projectId) as RelatedProjectEdge[];
    return rows;
  }

  // ── Explicit workspace-root resolution (NN-WORKSPACE-001) ─────────────────

  /**
   * Resolve the explicit workspace root for a mutation from Project + Session
   * + (optional) Worktree identity. There is NO implicit global active root:
   * an operation that cannot name its project/session is rejected upstream, and
   * this method requires the identities to exist and be mutually consistent.
   *
   * When a worktree is supplied it must belong to the session/project and it
   * supplies the root (all file/shell/diff/tree operations route to it,
   * NN-WORKSPACE-007). Otherwise the workspace root is used. A mismatch returns
   * a typed `CONFLICT`; a missing identity returns `VALIDATION`.
   */
  resolveWorkspaceRoot(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly worktreeId?: string;
    readonly correlationId: string;
  }): ResolvedWorkspaceRoot {
    const { projectId, sessionId, worktreeId, correlationId } = input;
    const session = this.readSession(sessionId);
    if (!session) {
      throw new WorkspaceConflictError(
        makeError('VALIDATION', `session ${sessionId} not found`, 'resolve-workspace-root', correlationId),
      );
    }
    if (session.projectId !== projectId) {
      throw new WorkspaceConflictError(
        makeError(
          'CONFLICT',
          `session ${sessionId} belongs to project ${session.projectId}, not ${projectId}`,
          'resolve-workspace-root',
          correlationId,
        ),
      );
    }
    const workspace = this.readWorkspace(session.workspaceId);
    if (!workspace) {
      throw new WorkspaceConflictError(
        makeError('INTEGRITY', `workspace ${session.workspaceId} for session ${sessionId} missing`, 'resolve-workspace-root', correlationId),
      );
    }

    if (worktreeId) {
      const worktree = this.readWorktree(worktreeId);
      if (!worktree) {
        throw new WorkspaceConflictError(
          makeError('VALIDATION', `worktree ${worktreeId} not found`, 'resolve-workspace-root', correlationId),
        );
      }
      if (worktree.projectId !== projectId) {
        throw new WorkspaceConflictError(
          makeError(
            'CONFLICT',
            `worktree ${worktreeId} belongs to project ${worktree.projectId}, not ${projectId}`,
            'resolve-workspace-root',
            correlationId,
          ),
        );
      }
      if (worktree.sessionId !== null && worktree.sessionId !== sessionId) {
        throw new WorkspaceConflictError(
          makeError(
            'CONFLICT',
            `worktree ${worktreeId} is bound to session ${worktree.sessionId}, not ${sessionId}`,
            'resolve-workspace-root',
            correlationId,
          ),
        );
      }
      return {
        projectId,
        workspaceId: workspace.workspaceId,
        sessionId,
        worktreeId,
        repositoryId: worktree.repositoryId ?? workspace.repositoryId,
        rootPath: worktree.rootPath,
        rootSource: 'worktree',
      };
    }

    return {
      projectId,
      workspaceId: workspace.workspaceId,
      sessionId,
      worktreeId: null,
      repositoryId: workspace.repositoryId,
      rootPath: workspace.rootPath,
      rootSource: 'workspace',
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Throw a typed `STALE_REVISION` conflict when the caller's expected revision
   * does not match the current one. Raised inside the mutation callback so the
   * transaction rolls back with no effect (NN-DATA-004).
   */
  private assertRevision(
    current: number,
    expected: number,
    operation: string,
    correlationId: string,
  ): void {
    if (current !== expected) {
      throw new WorkspaceConflictError(
        makeError(
          'STALE_REVISION',
          `expected revision ${expected} but current is ${current}; refresh and rebase/merge (both versions preserved)`,
          operation,
          correlationId,
          { effectKnown: true },
        ),
      );
    }
  }

  /** Build an EventIntent for the outbox with a canonical payload digest. */
  private event(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): EventIntent {
    return {
      eventType,
      aggregateType,
      aggregateId,
      payloadSchemaName: eventType,
      payloadSchemaVersion: CONTRACT_WRITE_VERSION,
      payload,
      redaction: 'internal',
    };
  }

  /**
   * Route a mutation through the T-001 authority transaction. A
   * {@link WorkspaceConflictError} thrown by the callback rolls the transaction
   * back and is re-thrown to the caller as a typed conflict; the mutation has
   * no effect.
   */
  private mutate(
    cmd: CommandContext,
    operation: string,
    work: (tx: Database.Database) => { readonly resultRef?: string } | void,
    events: readonly EventIntent[],
  ): ReturnType<typeof applyAuthorityMutation> {
    return applyAuthorityMutation(this.db, {
      authority: WORKSPACE_AUTHORITY,
      commandId: cmd.commandId,
      idempotencyKey: cmd.idempotencyKey,
      requestDigest: computeDigest({ operation, scope: cmd.scope, key: cmd.idempotencyKey }),
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      mutate: work,
      events,
      ...(cmd.now ? { now: cmd.now } : {}),
    });
  }

  /**
   * Translate an {@link applyAuthorityMutation} outcome into a typed workspace
   * result. A `conflict` outcome (idempotency-digest divergence) is surfaced as
   * a {@link WorkspaceConflictError}; a `replayed` outcome returns the prior
   * receipt with the current committed record read back.
   */
  private finish<T>(
    outcome: ReturnType<typeof applyAuthorityMutation>,
    readRecord: () => T,
    _cmd: CommandContext,
    _operation: string,
  ): WorkspaceMutationResult<T> {
    if (outcome.kind === 'conflict') {
      throw new WorkspaceConflictError(outcome.error);
    }
    if (outcome.kind === 'replayed') {
      return {
        record: readRecord(),
        receiptId: outcome.receipt.receiptId,
        authorityRevision: outcome.receipt.authorityRevision,
      };
    }
    return {
      record: readRecord(),
      receiptId: outcome.receipt.receiptId,
      authorityRevision: outcome.authorityRevision,
    };
  }
}
