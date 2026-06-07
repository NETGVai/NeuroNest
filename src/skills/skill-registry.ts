// Skill registry: CRUD operations, discovery, enable/disable, routing preferences

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMarkdown } from './skill-metadata-parser.js';
import type { SkillDefinition } from './skill-metadata-parser.js';

export interface RoutingPref {
  skillId: string;
  projectId: string;
  weightOverride: number | null;
  enabledOverride: boolean | null;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  version: string;
  category: string;
  tags: string;
  scope: string;
  entrypoint: string | null;
  enabled: number;
  installed: number;
  content: string;
  metadata: string;
  bundled_skill_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RoutingPrefRow {
  skill_id: string;
  project_id: string;
  weight_override: number | null;
  enabled_override: number | null;
}

function rowToSkill(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source as SkillDefinition['source'],
    version: row.version,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    scope: row.scope as SkillDefinition['scope'],
    entrypoint: row.entrypoint ?? undefined,
    enabled: row.enabled === 1,
    installed: row.installed === 1,
    content: row.content,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoutingPref(row: RoutingPrefRow): RoutingPref {
  return {
    skillId: row.skill_id,
    projectId: row.project_id,
    weightOverride: row.weight_override,
    enabledOverride: row.enabled_override === null ? null : row.enabled_override === 1,
  };
}

export class SkillRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** List all skills, optionally filtered. */
  list(filters?: {
    source?: string;
    category?: string;
    scope?: string;
    enabled?: boolean;
    installed?: boolean;
    projectId?: string;
  }): SkillDefinition[] {
    let sql = 'SELECT * FROM skills WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.source !== undefined) {
      sql += ' AND source = ?';
      params.push(filters.source);
    }
    if (filters?.category !== undefined) {
      sql += ' AND category = ?';
      params.push(filters.category);
    }
    if (filters?.scope !== undefined) {
      sql += ' AND scope = ?';
      params.push(filters.scope);
    }
    if (filters?.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters?.installed !== undefined) {
      sql += ' AND installed = ?';
      params.push(filters.installed ? 1 : 0);
    }

    sql += ' ORDER BY name ASC';

    const rows = this.db.prepare(sql).all(...params) as SkillRow[];
    let skills = rows.map(rowToSkill);

    // Apply project-level enabled overrides if projectId is provided
    if (filters?.projectId) {
      const prefs = this.getRoutingPrefs(filters.projectId);
      const prefMap = new Map(prefs.map((p) => [p.skillId, p]));

      skills = skills.map((skill) => {
        const pref = prefMap.get(skill.id);
        if (pref?.enabledOverride !== null && pref?.enabledOverride !== undefined) {
          return { ...skill, enabled: pref.enabledOverride };
        }
        return skill;
      });

      // Re-apply enabled filter after overrides
      if (filters.enabled !== undefined) {
        skills = skills.filter((s) => s.enabled === filters.enabled);
      }
    }

    return skills;
  }

  /** Get a single skill by id. */
  get(id: string): SkillDefinition | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  /** Insert or update a skill. When a bundled skill is edited, change source to 'custom'. */
  upsert(skill: SkillDefinition): void {
    const existing = this.get(skill.id);
    const now = new Date().toISOString();

    // If editing a bundled skill with different content, change source to 'custom'
    let source = skill.source;
    if (existing && existing.source === 'bundled' && skill.content !== existing.content) {
      source = 'custom';
    }

    const tagsJson = JSON.stringify(skill.tags);
    const metadataJson = JSON.stringify(skill.metadata);

    this.db
      .prepare(
        `INSERT INTO skills (id, name, description, source, version, category, tags, scope, entrypoint, enabled, installed, content, metadata, bundled_skill_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           source = excluded.source,
           version = excluded.version,
           category = excluded.category,
           tags = excluded.tags,
           scope = excluded.scope,
           entrypoint = excluded.entrypoint,
           enabled = excluded.enabled,
           installed = excluded.installed,
           content = excluded.content,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
      )
      .run(
        skill.id,
        skill.name,
        skill.description,
        source,
        skill.version,
        skill.category,
        tagsJson,
        skill.scope,
        skill.entrypoint ?? null,
        skill.enabled ? 1 : 0,
        skill.installed ? 1 : 0,
        skill.content,
        metadataJson,
        existing?.source === 'bundled' ? skill.id : null,
        existing ? existing.createdAt : (skill.createdAt || now),
        now,
      );
  }

  /** Remove a skill by id. */
  remove(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  /** Set enabled state. */
  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  /** Discover skills from a directory path. Returns count of discovered skills. */
  discoverFromDirectory(dirPath: string, source: 'local' | 'workspace'): number {
    let count = 0;

    if (!fs.existsSync(dirPath)) {
      console.warn(`[SkillRegistry] Discovery directory not found: ${dirPath}`);
      return 0;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch (err) {
      console.warn(`[SkillRegistry] Failed to read directory ${dirPath}:`, err);
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;

      const filePath = path.join(dirPath, entry);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        console.warn(`[SkillRegistry] Failed to read file ${filePath}:`, err);
        continue;
      }

      const result = parseSkillMarkdown(raw);

      if (!result.ok) {
        console.warn(
          `[SkillRegistry] Invalid skill file ${filePath}:`,
          result.errors.map((e) => `${e.field}: ${e.message}`).join(', '),
        );
        continue;
      }

      // Override source with the discovery source
      const skill: SkillDefinition = {
        ...result.skill,
        source,
      };

      this.upsert(skill);
      count++;
    }

    return count;
  }

  /** Get routing preferences for a project. */
  getRoutingPrefs(projectId: string): RoutingPref[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_routing_prefs WHERE project_id = ?')
      .all(projectId) as RoutingPrefRow[];
    return rows.map(rowToRoutingPref);
  }

  /** Set a routing preference override. */
  setRoutingPref(skillId: string, projectId: string, pref: Partial<RoutingPref>): void {
    this.db
      .prepare(
        `INSERT INTO skill_routing_prefs (skill_id, project_id, weight_override, enabled_override)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(skill_id, project_id) DO UPDATE SET
           weight_override = COALESCE(excluded.weight_override, skill_routing_prefs.weight_override),
           enabled_override = COALESCE(excluded.enabled_override, skill_routing_prefs.enabled_override)`,
      )
      .run(
        skillId,
        projectId,
        pref.weightOverride ?? null,
        pref.enabledOverride === undefined || pref.enabledOverride === null
          ? null
          : pref.enabledOverride
            ? 1
            : 0,
      );
  }
}
