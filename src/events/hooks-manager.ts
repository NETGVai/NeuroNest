/**
 * Hooks Manager — User-configurable event-driven automation.
 *
 * Triggers agent actions on events: file saved, file created, before/after
 * tool use, prompt submit, task execution.
 */

export type HookEventType = 'fileEdited' | 'fileCreated' | 'fileDeleted' | 'promptSubmit' | 'agentStop' | 'preToolUse' | 'postToolUse' | 'manual';
export type HookActionType = 'askAgent' | 'runCommand';

export interface Hook {
  id: string;
  name: string;
  projectId: string;
  enabled: boolean;
  event: HookEventType;
  filePatterns?: string[]; // For file events: ['*.ts', '*.tsx']
  action: HookActionType;
  prompt?: string; // For askAgent
  command?: string; // For runCommand
  createdAt: number;
}

export class HooksManager {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          project_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          event_type TEXT NOT NULL,
          file_patterns TEXT,
          action_type TEXT NOT NULL,
          prompt TEXT,
          command TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (e) { console.warn('[HooksManager] Table creation failed:', e); }
  }

  createHook(projectId: string, hook: Omit<Hook, 'id' | 'createdAt'>): Hook {
    const newHook: Hook = {
      ...hook,
      id: `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      createdAt: Date.now(),
    };
    try {
      this.db.prepare(
        'INSERT INTO hooks (id, name, project_id, enabled, event_type, file_patterns, action_type, prompt, command, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(newHook.id, newHook.name, newHook.projectId, newHook.enabled ? 1 : 0, newHook.event, JSON.stringify(newHook.filePatterns || []), newHook.action, newHook.prompt || '', newHook.command || '', newHook.createdAt);
    } catch (e) { console.warn('[HooksManager] Insert failed:', e); }
    return newHook;
  }

  getHooks(projectId: string): Hook[] {
    try {
      const rows = this.db.prepare('SELECT * FROM hooks WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[];
      return rows.map((r: any) => ({
        id: r.id, name: r.name, projectId: r.project_id, enabled: !!r.enabled,
        event: r.event_type, filePatterns: JSON.parse(r.file_patterns || '[]'),
        action: r.action_type, prompt: r.prompt, command: r.command, createdAt: r.created_at,
      }));
    } catch { return []; }
  }

  getEnabledHooks(projectId: string, eventType: HookEventType): Hook[] {
    return this.getHooks(projectId).filter(h => h.enabled && h.event === eventType);
  }

  updateHook(hookId: string, updates: Partial<Hook>): void {
    try {
      const sets: string[] = [];
      const vals: any[] = [];
      if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name); }
      if (updates.enabled !== undefined) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0); }
      if (updates.prompt !== undefined) { sets.push('prompt = ?'); vals.push(updates.prompt); }
      if (updates.command !== undefined) { sets.push('command = ?'); vals.push(updates.command); }
      if (updates.filePatterns !== undefined) { sets.push('file_patterns = ?'); vals.push(JSON.stringify(updates.filePatterns)); }
      if (sets.length === 0) return;
      vals.push(hookId);
      this.db.prepare(`UPDATE hooks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } catch {}
  }

  deleteHook(hookId: string): void {
    try { this.db.prepare('DELETE FROM hooks WHERE id = ?').run(hookId); } catch {}
  }

  /**
   * Check if a file event matches any hooks.
   */
  matchFileEvent(projectId: string, eventType: HookEventType, filePath: string): Hook[] {
    const hooks = this.getEnabledHooks(projectId, eventType);
    return hooks.filter(h => {
      if (!h.filePatterns || h.filePatterns.length === 0) return true;
      return h.filePatterns.some(pattern => {
        if (pattern.startsWith('*')) {
          return filePath.endsWith(pattern.slice(1));
        }
        return filePath.includes(pattern);
      });
    });
  }
}
