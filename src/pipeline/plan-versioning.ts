/**
 * Plan Versioning — version control for AI plan history with branches.
 *
 * Every action (prompt, response, context change, apply, reject) creates a
 * version. Users can rewind to any point and create branches to explore
 * different approaches.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface PlanVersion {
  id: string;
  planId: string;
  branch: string;
  versionNum: number;
  action: string;
  description?: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface PlanBranch {
  id: string;
  planId: string;
  name: string;
  parentBranch: string;
  forkVersion?: number;
  createdAt: string;
}

export class PlanVersioningService {
  constructor(private db: Database.Database) {}

  /** Record a new version in the plan's history */
  record(planId: string, action: string, snapshot: Record<string, unknown>, opts?: { branch?: string; description?: string }): PlanVersion {
    const branch = opts?.branch || 'main';
    const id = randomUUID();
    const now = new Date().toISOString();

    // Get next version number for this plan+branch
    const maxRow = this.db.prepare(
      'SELECT MAX(version_num) as m FROM plan_versions WHERE plan_id = ? AND branch = ?'
    ).get(planId, branch) as any;
    const versionNum = (maxRow?.m || 0) + 1;

    this.db.prepare(
      'INSERT INTO plan_versions (id, plan_id, branch, version_num, action, description, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, planId, branch, versionNum, action, opts?.description || null, JSON.stringify(snapshot), now);

    return { id, planId, branch, versionNum, action, description: opts?.description, snapshot, createdAt: now };
  }

  /** Get the full history for a plan on a branch */
  getHistory(planId: string, branch?: string): PlanVersion[] {
    const b = branch || 'main';
    return (this.db.prepare(
      'SELECT * FROM plan_versions WHERE plan_id = ? AND branch = ? ORDER BY version_num ASC'
    ).all(planId, b) as any[]).map(r => this.mapVersion(r));
  }

  /** Get a specific version */
  getVersion(planId: string, versionNum: number, branch?: string): PlanVersion | null {
    const b = branch || 'main';
    const row = this.db.prepare(
      'SELECT * FROM plan_versions WHERE plan_id = ? AND branch = ? AND version_num = ?'
    ).get(planId, b, versionNum) as any;
    return row ? this.mapVersion(row) : null;
  }

  /** Get the latest version */
  getLatest(planId: string, branch?: string): PlanVersion | null {
    const b = branch || 'main';
    const row = this.db.prepare(
      'SELECT * FROM plan_versions WHERE plan_id = ? AND branch = ? ORDER BY version_num DESC LIMIT 1'
    ).get(planId, b) as any;
    return row ? this.mapVersion(row) : null;
  }

  /** Rewind: delete all versions after the target version number */
  rewind(planId: string, targetVersion: number, branch?: string): boolean {
    const b = branch || 'main';
    return this.db.prepare(
      'DELETE FROM plan_versions WHERE plan_id = ? AND branch = ? AND version_num > ?'
    ).run(planId, b, targetVersion).changes > 0;
  }

  /** Create a new branch forking from the current state */
  createBranch(planId: string, branchName: string, parentBranch?: string): PlanBranch {
    const parent = parentBranch || 'main';
    const id = randomUUID();
    const now = new Date().toISOString();

    // Get the current version number on the parent branch
    const latest = this.getLatest(planId, parent);
    const forkVersion = latest?.versionNum || 0;

    this.db.prepare(
      'INSERT INTO plan_branches (id, plan_id, name, parent_branch, fork_version, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, planId, branchName, parent, forkVersion, now);

    // Copy all versions from parent up to fork point into the new branch
    const versions = this.getHistory(planId, parent);
    for (const v of versions) {
      if (v.versionNum > forkVersion) break;
      this.db.prepare(
        'INSERT INTO plan_versions (id, plan_id, branch, version_num, action, description, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), planId, branchName, v.versionNum, v.action, v.description || null, JSON.stringify(v.snapshot), v.createdAt);
    }

    return { id, planId, name: branchName, parentBranch: parent, forkVersion, createdAt: now };
  }

  /** List branches for a plan */
  listBranches(planId: string): PlanBranch[] {
    return (this.db.prepare(
      'SELECT * FROM plan_branches WHERE plan_id = ? ORDER BY created_at ASC'
    ).all(planId) as any[]).map(r => ({
      id: r.id, planId: r.plan_id, name: r.name,
      parentBranch: r.parent_branch, forkVersion: r.fork_version,
      createdAt: r.created_at,
    }));
  }

  /** Delete a branch and all its versions */
  deleteBranch(planId: string, branchName: string): boolean {
    if (branchName === 'main') return false; // Can't delete main
    this.db.prepare('DELETE FROM plan_versions WHERE plan_id = ? AND branch = ?').run(planId, branchName);
    return this.db.prepare('DELETE FROM plan_branches WHERE plan_id = ? AND name = ?').run(planId, branchName).changes > 0;
  }

  private mapVersion(row: any): PlanVersion {
    return {
      id: row.id, planId: row.plan_id, branch: row.branch,
      versionNum: row.version_num, action: row.action,
      description: row.description || undefined,
      snapshot: JSON.parse(row.snapshot || '{}'), createdAt: row.created_at,
    };
  }
}
