/**
 * Workspace Manager — Git worktree-based isolation for parallel work.
 *
 * Each workspace is an isolated directory with its own branch checkout.
 * Parallel agents can't conflict because they work in separate worktrees.
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeExecFileSync } from '../security/safe-exec.js';

export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
  isBase: boolean;
  status: 'active' | 'merged' | 'abandoned';
  createdAt: number;
}

export class WorkspaceManager {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          branch TEXT NOT NULL,
          path TEXT NOT NULL,
          is_base INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL
        )
      `);
    } catch (e) { console.warn('[WorkspaceManager] Table creation failed:', e); }
  }

  /**
   * Check if a project directory is a git repo.
   */
  isGitRepo(projectPath: string): boolean {
    try {
      safeExecFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
      return true;
    } catch { return false; }
  }

  /**
   * Create a new isolated workspace using git worktree.
   */
  createWorkspace(projectId: string, projectPath: string, name: string, baseBranch?: string): Workspace | { error: string } {
    if (!this.isGitRepo(projectPath)) {
      return { error: 'Project is not a git repository. Initialize with: git init' };
    }

    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
    const branchName = `neuronest/${safeName}`;
    const worktreePath = path.join(path.dirname(projectPath), `.neuronest-workspaces`, safeName);

    try {
      // Create branch from base
      const base = baseBranch || 'HEAD';
      try {
        safeExecFileSync('git', ['branch', branchName, base], { cwd: projectPath });
      } catch {
        // Branch may already exist
      }

      // Create worktree
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      safeExecFileSync('git', ['worktree', 'add', worktreePath, branchName], { cwd: projectPath });

      const workspace: Workspace = {
        id: `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        projectId, name: safeName, branch: branchName, path: worktreePath,
        isBase: false, status: 'active', createdAt: Date.now(),
      };

      this.db.prepare(
        'INSERT INTO workspaces (id, project_id, name, branch, path, is_base, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(workspace.id, workspace.projectId, workspace.name, workspace.branch, workspace.path, 0, 'active', workspace.createdAt);

      return workspace;
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /**
   * List all workspaces for a project.
   */
  getWorkspaces(projectId: string): Workspace[] {
    try {
      const rows = this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[];
      return rows.map(this.rowToWorkspace);
    } catch { return []; }
  }

  /**
   * Rebase a workspace's changes back to the main branch.
   */
  rebaseToMain(workspaceId: string, projectPath: string): { success: boolean; error?: string } {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { success: false, error: 'Workspace not found' };

    try {
      // Switch to main branch in the base repo
      const mainBranchResult = safeExecFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
      const mainBranch = mainBranchResult.stdout.trim();

      // Rebase the workspace branch onto main
      safeExecFileSync('git', ['rebase', mainBranch], { cwd: ws.path });

      // Merge into main
      safeExecFileSync('git', ['checkout', mainBranch], { cwd: projectPath });
      safeExecFileSync('git', ['merge', ws.branch], { cwd: projectPath });

      this.updateStatus(workspaceId, 'merged');
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Delete a workspace and its worktree.
   */
  deleteWorkspace(workspaceId: string, projectPath: string): { success: boolean; error?: string } {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { success: false, error: 'Workspace not found' };

    try {
      // Remove worktree
      safeExecFileSync('git', ['worktree', 'remove', ws.path, '--force'], { cwd: projectPath });

      // Delete branch
      try {
        safeExecFileSync('git', ['branch', '-D', ws.branch], { cwd: projectPath });
      } catch { /* branch may not exist */ }

      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      return { success: true };
    } catch (e: any) {
      // Force cleanup
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      return { success: true };
    }
  }

  /**
   * Sync a workspace with the main branch.
   */
  syncWithMain(workspaceId: string, projectPath: string): { success: boolean; error?: string } {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return { success: false, error: 'Workspace not found' };

    try {
      const mainBranchResult = safeExecFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
      const mainBranch = mainBranchResult.stdout.trim();
      safeExecFileSync('git', ['pull', 'origin', mainBranch, '--rebase'], { cwd: ws.path });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ─── Private ────────────────────────────────────────────

  private getWorkspace(id: string): Workspace | null {
    try {
      const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
      return row ? this.rowToWorkspace(row) : null;
    } catch { return null; }
  }

  private updateStatus(id: string, status: string): void {
    try { this.db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id); } catch {}
  }

  private rowToWorkspace(row: any): Workspace {
    return {
      id: row.id, projectId: row.project_id, name: row.name, branch: row.branch,
      path: row.path, isBase: !!row.is_base, status: row.status, createdAt: row.created_at,
    };
  }
}
