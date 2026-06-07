/**
 * Runtime Backend Service — Docker, SSH, DevContainer, Local, Worktree.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface RuntimeBackend {
  id: string; project_id: string; name: string; backend_type: string;
  config: string; status: string; is_default: boolean; created_at: string;
}
export interface RuntimeBackendConfig {
  project_id: string; default_backend: string; docker_image: string;
  ssh_host: string | null; ssh_user: string; ssh_port: number;
  devcontainer_path: string; share_credentials: boolean;
}

export class RuntimeBackendService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): RuntimeBackendConfig {
    const row = this.db.prepare('SELECT * FROM runtime_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, share_credentials: !!row.share_credentials };
    this.db.prepare('INSERT INTO runtime_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, default_backend: 'local', docker_image: 'node:20', ssh_host: null, ssh_user: 'root', ssh_port: 22, devcontainer_path: '.devcontainer/devcontainer.json', share_credentials: true };
  }

  updateConfig(projectId: string, updates: Partial<RuntimeBackendConfig>): RuntimeBackendConfig {
    this.getConfig(projectId);
    const f: string[] = []; const v: any[] = [];
    if (updates.default_backend !== undefined) { f.push('default_backend = ?'); v.push(updates.default_backend); }
    if (updates.docker_image !== undefined) { f.push('docker_image = ?'); v.push(updates.docker_image); }
    if (updates.ssh_host !== undefined) { f.push('ssh_host = ?'); v.push(updates.ssh_host); }
    if (updates.ssh_user !== undefined) { f.push('ssh_user = ?'); v.push(updates.ssh_user); }
    if (updates.ssh_port !== undefined) { f.push('ssh_port = ?'); v.push(updates.ssh_port); }
    if (updates.devcontainer_path !== undefined) { f.push('devcontainer_path = ?'); v.push(updates.devcontainer_path); }
    if (updates.share_credentials !== undefined) { f.push('share_credentials = ?'); v.push(updates.share_credentials ? 1 : 0); }
    if (f.length) { f.push('updated_at = CURRENT_TIMESTAMP'); this.db.prepare(`UPDATE runtime_config SET ${f.join(', ')} WHERE project_id = ?`).run(...v, projectId); }
    return this.getConfig(projectId);
  }

  addBackend(projectId: string, data: { name: string; backendType: string; config?: any }): RuntimeBackend {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO runtime_backends (id, project_id, name, backend_type, config) VALUES (?, ?, ?, ?, ?)').run(id, projectId, data.name, data.backendType, JSON.stringify(data.config || {}));
    return this.db.prepare('SELECT * FROM runtime_backends WHERE id = ?').get(id) as RuntimeBackend;
  }

  listBackends(projectId: string): RuntimeBackend[] {
    return this.db.prepare('SELECT * FROM runtime_backends WHERE project_id = ? ORDER BY created_at').all(projectId) as RuntimeBackend[];
  }

  updateBackendStatus(backendId: string, status: string): void {
    this.db.prepare('UPDATE runtime_backends SET status = ? WHERE id = ?').run(status, backendId);
  }

  deleteBackend(backendId: string): void {
    this.db.prepare('DELETE FROM runtime_backends WHERE id = ?').run(backendId);
  }
}
