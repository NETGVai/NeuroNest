/**
 * Mission Service — Multi-feature orchestration with milestones and validation.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface Mission {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  features: string;
  milestones: string;
  current_milestone: number;
  total_features: number;
  completed_features: number;
  estimated_cost: string | null;
  config: string;
  created_at: string;
}

export interface MissionWorker {
  id: string;
  mission_id: string;
  feature_index: number;
  worker_type: string;
  status: string;
  agent_name: string | null;
  output: string | null;
  duration_ms: number;
}

export class MissionService {
  constructor(private db: Database.Database) {}

  create(projectId: string, data: { title: string; description?: string; features: any[]; milestones: any[] }): Mission {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO missions (id, project_id, title, description, features, milestones, total_features) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, data.title, data.description || null, JSON.stringify(data.features), JSON.stringify(data.milestones), data.features.length);
    return this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Mission;
  }

  get(missionId: string): Mission | null {
    return this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as Mission | null;
  }

  list(projectId: string): Mission[] {
    return this.db.prepare('SELECT * FROM missions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Mission[];
  }

  updateStatus(missionId: string, status: string): void {
    this.db.prepare('UPDATE missions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, missionId);
  }

  updateProgress(missionId: string, completedFeatures: number, currentMilestone: number): void {
    this.db.prepare('UPDATE missions SET completed_features = ?, current_milestone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(completedFeatures, currentMilestone, missionId);
  }

  addWorker(missionId: string, data: Partial<MissionWorker>): MissionWorker {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO mission_workers (id, mission_id, feature_index, worker_type, status, agent_name) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, missionId, data.feature_index || 0, data.worker_type || 'feature', 'pending', data.agent_name || null);
    return this.db.prepare('SELECT * FROM mission_workers WHERE id = ?').get(id) as MissionWorker;
  }

  getWorkers(missionId: string): MissionWorker[] {
    return this.db.prepare('SELECT * FROM mission_workers WHERE mission_id = ? ORDER BY created_at').all(missionId) as MissionWorker[];
  }

  updateWorker(workerId: string, updates: Partial<MissionWorker>): void {
    const fields: string[] = []; const values: any[] = [];
    if (updates.status) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.output !== undefined) { fields.push('output = ?'); values.push(updates.output); }
    if (updates.duration_ms !== undefined) { fields.push('duration_ms = ?'); values.push(updates.duration_ms); }
    if (fields.length > 0) this.db.prepare(`UPDATE mission_workers SET ${fields.join(', ')} WHERE id = ?`).run(...values, workerId);
  }

  delete(missionId: string): void {
    this.db.prepare('DELETE FROM mission_workers WHERE mission_id = ?').run(missionId);
    this.db.prepare('DELETE FROM missions WHERE id = ?').run(missionId);
  }

  getStats(projectId: string): { total: number; completed: number; running: number; totalFeatures: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running, SUM(total_features) as totalFeatures
       FROM missions WHERE project_id = ?`
    ).get(projectId) as any;
    return { total: row?.total || 0, completed: row?.completed || 0, running: row?.running || 0, totalFeatures: row?.totalFeatures || 0 };
  }
}
