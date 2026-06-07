/**
 * Model Packs — role-based model assignment for multi-model AI pipelines.
 *
 * Each pack maps roles (planner, architect, coder, summarizer, builder, names,
 * commitMessages) to specific provider:model pairs. This allows using the best
 * model for each task type.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ModelRole = 'planner' | 'architect' | 'coder' | 'summarizer' | 'builder' | 'names' | 'commitMessages' | 'autoContinue';

export interface ModelRoleConfig {
  provider: string;  // e.g. 'openai', 'anthropic', 'ollama'
  model: string;     // e.g. 'gpt-4o', 'claude-sonnet-4-20250514'
}

export interface ModelPack {
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;
  roles: Record<ModelRole, ModelRoleConfig>;
  createdAt: string;
}

const BUILTIN_PACKS: Omit<ModelPack, 'id' | 'createdAt'>[] = [
  {
    name: 'Balanced',
    description: 'Default provider for all roles. Uses your configured default provider.',
    isBuiltin: true,
    roles: {
      planner: { provider: 'default', model: 'default' },
      architect: { provider: 'default', model: 'default' },
      coder: { provider: 'default', model: 'default' },
      summarizer: { provider: 'default', model: 'default' },
      builder: { provider: 'default', model: 'default' },
      names: { provider: 'default', model: 'default' },
      commitMessages: { provider: 'default', model: 'default' },
      autoContinue: { provider: 'default', model: 'default' },
    },
  },
  {
    name: 'Quality First',
    description: 'Uses the strongest available model for planning and coding, cheaper models for utility tasks.',
    isBuiltin: true,
    roles: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      architect: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      coder: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      summarizer: { provider: 'openai', model: 'gpt-4o-mini' },
      builder: { provider: 'openai', model: 'gpt-4o-mini' },
      names: { provider: 'openai', model: 'gpt-4o-mini' },
      commitMessages: { provider: 'openai', model: 'gpt-4o-mini' },
      autoContinue: { provider: 'openai', model: 'gpt-4o-mini' },
    },
  },
  {
    name: 'Cost Saver',
    description: 'Uses cheaper models everywhere. Good for simpler tasks.',
    isBuiltin: true,
    roles: {
      planner: { provider: 'openai', model: 'gpt-4o-mini' },
      architect: { provider: 'openai', model: 'gpt-4o-mini' },
      coder: { provider: 'openai', model: 'gpt-4o-mini' },
      summarizer: { provider: 'openai', model: 'gpt-4o-mini' },
      builder: { provider: 'openai', model: 'gpt-4o-mini' },
      names: { provider: 'openai', model: 'gpt-4o-mini' },
      commitMessages: { provider: 'openai', model: 'gpt-4o-mini' },
      autoContinue: { provider: 'openai', model: 'gpt-4o-mini' },
    },
  },
  {
    name: 'Local Only',
    description: 'Uses Ollama for all roles. Fully offline, no API costs.',
    isBuiltin: true,
    roles: {
      planner: { provider: 'ollama', model: 'default' },
      architect: { provider: 'ollama', model: 'default' },
      coder: { provider: 'ollama', model: 'default' },
      summarizer: { provider: 'ollama', model: 'default' },
      builder: { provider: 'ollama', model: 'default' },
      names: { provider: 'ollama', model: 'default' },
      commitMessages: { provider: 'ollama', model: 'default' },
      autoContinue: { provider: 'ollama', model: 'default' },
    },
  },
  {
    name: 'Hybrid',
    description: 'Cloud models for planning/coding, local models for utility tasks.',
    isBuiltin: true,
    roles: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      architect: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      coder: { provider: 'default', model: 'default' },
      summarizer: { provider: 'ollama', model: 'default' },
      builder: { provider: 'default', model: 'default' },
      names: { provider: 'ollama', model: 'default' },
      commitMessages: { provider: 'ollama', model: 'default' },
      autoContinue: { provider: 'default', model: 'default' },
    },
  },
];

export class ModelPackManager {
  constructor(private db: Database.Database) {
    this.ensureBuiltins();
  }

  private ensureBuiltins(): void {
    for (const pack of BUILTIN_PACKS) {
      const existing = this.db.prepare('SELECT id FROM model_packs WHERE name = ?').get(pack.name) as any;
      if (!existing) {
        this.db.prepare(
          'INSERT INTO model_packs (id, name, description, is_builtin, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), pack.name, pack.description || null, 1, JSON.stringify(pack.roles), new Date().toISOString());
      }
    }
  }

  list(): ModelPack[] {
    return (this.db.prepare('SELECT * FROM model_packs ORDER BY is_builtin DESC, name ASC').all() as any[]).map(r => this.mapRow(r));
  }

  get(id: string): ModelPack | null {
    const row = this.db.prepare('SELECT * FROM model_packs WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getByName(name: string): ModelPack | null {
    const row = this.db.prepare('SELECT * FROM model_packs WHERE name = ?').get(name) as any;
    return row ? this.mapRow(row) : null;
  }

  create(pack: { name: string; description?: string; roles: Record<string, ModelRoleConfig> }): ModelPack {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO model_packs (id, name, description, is_builtin, roles, created_at) VALUES (?, ?, ?, 0, ?, ?)'
    ).run(id, pack.name, pack.description || null, JSON.stringify(pack.roles), new Date().toISOString());
    return this.get(id)!;
  }

  update(id: string, updates: { name?: string; description?: string; roles?: Record<string, ModelRoleConfig> }): boolean {
    const pack = this.get(id);
    if (!pack || pack.isBuiltin) return false;
    const sets: string[] = [];
    const vals: any[] = [];
    if (updates.name) { sets.push('name = ?'); vals.push(updates.name); }
    if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description); }
    if (updates.roles) { sets.push('roles = ?'); vals.push(JSON.stringify(updates.roles)); }
    if (sets.length === 0) return false;
    vals.push(id);
    return this.db.prepare(`UPDATE model_packs SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
  }

  delete(id: string): boolean {
    const pack = this.get(id);
    if (!pack || pack.isBuiltin) return false;
    return this.db.prepare('DELETE FROM model_packs WHERE id = ?').run(id).changes > 0;
  }

  private mapRow(row: any): ModelPack {
    return {
      id: row.id, name: row.name, description: row.description || undefined,
      isBuiltin: row.is_builtin === 1,
      roles: JSON.parse(row.roles || '{}'), createdAt: row.created_at,
    };
  }
}
