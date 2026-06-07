/**
 * Kanban Board Service — column and card management for task tracking.
 *
 * Each project gets its own board with customizable columns.
 * Cards can be linked to agent sessions and assigned to specific agents.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface KanbanColumn {
  id: string;
  projectId: string;
  name: string;
  position: number;
  color?: string;
  cardCount?: number;
}

export interface KanbanCard {
  id: string;
  columnId: string;
  projectId: string;
  title: string;
  description?: string;
  agentId?: string;
  sessionId?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  labels: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_COLUMNS = [
  { name: 'Backlog', color: '#6c7086' },
  { name: 'To Do', color: '#89b4fa' },
  { name: 'In Progress', color: '#f9e2af' },
  { name: 'Review', color: '#cba6f7' },
  { name: 'Done', color: '#a6e3a1' },
];

export class KanbanService {
  constructor(private db: Database.Database) {}

  ensureBoard(projectId: string): KanbanColumn[] {
    const existing = this.getColumns(projectId);
    if (existing.length > 0) return existing;

    // Create default columns
    const stmt = this.db.prepare(
      'INSERT INTO kanban_columns (id, project_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      stmt.run(randomUUID(), projectId, DEFAULT_COLUMNS[i]!.name, i, DEFAULT_COLUMNS[i]!.color, now);
    }
    return this.getColumns(projectId);
  }

  getColumns(projectId: string): KanbanColumn[] {
    const cols = this.db.prepare(
      'SELECT * FROM kanban_columns WHERE project_id = ? ORDER BY position ASC'
    ).all(projectId) as any[];

    return cols.map(c => {
      const count = (this.db.prepare('SELECT COUNT(*) as n FROM kanban_cards WHERE column_id = ?').get(c.id) as any)?.n || 0;
      return {
        id: c.id, projectId: c.project_id, name: c.name,
        position: c.position, color: c.color || undefined, cardCount: count,
      };
    });
  }

  addColumn(projectId: string, name: string, color?: string): KanbanColumn {
    const id = randomUUID();
    const maxPos = (this.db.prepare('SELECT MAX(position) as m FROM kanban_columns WHERE project_id = ?').get(projectId) as any)?.m || 0;
    this.db.prepare(
      'INSERT INTO kanban_columns (id, project_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, name, maxPos + 1, color || null, new Date().toISOString());
    return { id, projectId, name, position: maxPos + 1, color, cardCount: 0 };
  }

  deleteColumn(columnId: string): boolean {
    return this.db.prepare('DELETE FROM kanban_columns WHERE id = ?').run(columnId).changes > 0;
  }

  getCards(projectId: string): KanbanCard[] {
    return (this.db.prepare(
      'SELECT * FROM kanban_cards WHERE project_id = ? ORDER BY position ASC'
    ).all(projectId) as any[]).map(r => this.mapCard(r));
  }

  getCardsByColumn(columnId: string): KanbanCard[] {
    return (this.db.prepare(
      'SELECT * FROM kanban_cards WHERE column_id = ? ORDER BY position ASC'
    ).all(columnId) as any[]).map(r => this.mapCard(r));
  }

  addCard(opts: {
    columnId: string; projectId: string; title: string; description?: string;
    agentId?: string; sessionId?: string; priority?: string; labels?: string[];
  }): KanbanCard {
    const id = randomUUID();
    const now = new Date().toISOString();
    const maxPos = (this.db.prepare('SELECT MAX(position) as m FROM kanban_cards WHERE column_id = ?').get(opts.columnId) as any)?.m || 0;
    this.db.prepare(
      'INSERT INTO kanban_cards (id, column_id, project_id, title, description, agent_id, session_id, priority, labels, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, opts.columnId, opts.projectId, opts.title, opts.description || null,
      opts.agentId || null, opts.sessionId || null, opts.priority || 'medium',
      JSON.stringify(opts.labels || []), maxPos + 1, now, now);
    return this.mapCard(this.db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as any);
  }

  updateCard(id: string, updates: Partial<Pick<KanbanCard, 'title' | 'description' | 'agentId' | 'sessionId' | 'priority' | 'labels' | 'columnId' | 'position'>>): boolean {
    const sets: string[] = [];
    const vals: any[] = [];
    if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description); }
    if (updates.agentId !== undefined) { sets.push('agent_id = ?'); vals.push(updates.agentId); }
    if (updates.sessionId !== undefined) { sets.push('session_id = ?'); vals.push(updates.sessionId); }
    if (updates.priority !== undefined) { sets.push('priority = ?'); vals.push(updates.priority); }
    if (updates.labels !== undefined) { sets.push('labels = ?'); vals.push(JSON.stringify(updates.labels)); }
    if (updates.columnId !== undefined) { sets.push('column_id = ?'); vals.push(updates.columnId); }
    if (updates.position !== undefined) { sets.push('position = ?'); vals.push(updates.position); }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);
    return this.db.prepare(`UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
  }

  moveCard(cardId: string, targetColumnId: string, position?: number): boolean {
    const pos = position ?? 0;
    return this.db.prepare('UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(targetColumnId, pos, new Date().toISOString(), cardId).changes > 0;
  }

  deleteCard(cardId: string): boolean {
    return this.db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId).changes > 0;
  }

  private mapCard(row: any): KanbanCard {
    let labels: string[] = [];
    try { labels = JSON.parse(row.labels || '[]'); } catch {}
    return {
      id: row.id, columnId: row.column_id, projectId: row.project_id,
      title: row.title, description: row.description || undefined,
      agentId: row.agent_id || undefined, sessionId: row.session_id || undefined,
      priority: row.priority || 'medium', labels, position: row.position,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}
