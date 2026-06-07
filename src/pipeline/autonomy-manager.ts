/**
 * Autonomy Manager — configurable autonomy levels for AI agent behavior.
 *
 * Five preset levels from manual to full-auto, each controlling a matrix of
 * behaviors: context loading, plan continuation, change building, auto-apply,
 * command execution, auto-debug, and auto-commit.
 */

import type Database from 'better-sqlite3';

export type AutonomyLevel = 'none' | 'basic' | 'plus' | 'semi' | 'full' | 'custom';

export interface AutonomyConfig {
  projectId: string;
  level: AutonomyLevel;
  autoContinue: boolean;
  autoBuild: boolean;
  autoLoadContext: boolean;
  smartContext: boolean;
  autoApply: boolean;
  autoExec: boolean;
  autoDebug: boolean;
  autoCommit: boolean;
  updatedAt: string;
}

// Preset configurations for each autonomy level
const PRESETS: Record<Exclude<AutonomyLevel, 'custom'>, Omit<AutonomyConfig, 'projectId' | 'level' | 'updatedAt'>> = {
  none: {
    autoContinue: false, autoBuild: false, autoLoadContext: false,
    smartContext: false, autoApply: false, autoExec: false, autoDebug: false, autoCommit: false,
  },
  basic: {
    autoContinue: true, autoBuild: true, autoLoadContext: false,
    smartContext: false, autoApply: false, autoExec: false, autoDebug: false, autoCommit: false,
  },
  plus: {
    autoContinue: true, autoBuild: true, autoLoadContext: false,
    smartContext: true, autoApply: false, autoExec: false, autoDebug: false, autoCommit: true,
  },
  semi: {
    autoContinue: true, autoBuild: true, autoLoadContext: true,
    smartContext: true, autoApply: false, autoExec: false, autoDebug: false, autoCommit: true,
  },
  full: {
    autoContinue: true, autoBuild: true, autoLoadContext: true,
    smartContext: true, autoApply: true, autoExec: true, autoDebug: true, autoCommit: true,
  },
};

export class AutonomyManager {
  constructor(private db: Database.Database) {}

  get(projectId: string): AutonomyConfig {
    const row = this.db.prepare('SELECT * FROM autonomy_config WHERE project_id = ?').get(projectId) as any;
    if (row) return this.mapRow(row);
    // Return default (basic)
    return { projectId, level: 'basic', ...PRESETS.basic, updatedAt: new Date().toISOString() };
  }

  setLevel(projectId: string, level: AutonomyLevel): AutonomyConfig {
    const now = new Date().toISOString();
    if (level === 'custom') {
      // For custom, just update the level label without changing individual settings
      const existing = this.get(projectId);
      this.db.prepare(
        'INSERT OR REPLACE INTO autonomy_config (project_id, level, auto_continue, auto_build, auto_load_context, smart_context, auto_apply, auto_exec, auto_debug, auto_commit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'custom', existing.autoContinue ? 1 : 0, existing.autoBuild ? 1 : 0,
        existing.autoLoadContext ? 1 : 0, existing.smartContext ? 1 : 0,
        existing.autoApply ? 1 : 0, existing.autoExec ? 1 : 0,
        existing.autoDebug ? 1 : 0, existing.autoCommit ? 1 : 0, now);
    } else {
      const preset = PRESETS[level];
      this.db.prepare(
        'INSERT OR REPLACE INTO autonomy_config (project_id, level, auto_continue, auto_build, auto_load_context, smart_context, auto_apply, auto_exec, auto_debug, auto_commit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(projectId, level, preset.autoContinue ? 1 : 0, preset.autoBuild ? 1 : 0,
        preset.autoLoadContext ? 1 : 0, preset.smartContext ? 1 : 0,
        preset.autoApply ? 1 : 0, preset.autoExec ? 1 : 0,
        preset.autoDebug ? 1 : 0, preset.autoCommit ? 1 : 0, now);
    }
    return this.get(projectId);
  }

  setCustom(projectId: string, updates: Partial<Omit<AutonomyConfig, 'projectId' | 'level' | 'updatedAt'>>): AutonomyConfig {
    const existing = this.get(projectId);
    const merged = { ...existing, ...updates, level: 'custom' as AutonomyLevel };
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR REPLACE INTO autonomy_config (project_id, level, auto_continue, auto_build, auto_load_context, smart_context, auto_apply, auto_exec, auto_debug, auto_commit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, 'custom', merged.autoContinue ? 1 : 0, merged.autoBuild ? 1 : 0,
      merged.autoLoadContext ? 1 : 0, merged.smartContext ? 1 : 0,
      merged.autoApply ? 1 : 0, merged.autoExec ? 1 : 0,
      merged.autoDebug ? 1 : 0, merged.autoCommit ? 1 : 0, now);
    return this.get(projectId);
  }

  getPresets(): Record<string, Omit<AutonomyConfig, 'projectId' | 'level' | 'updatedAt'>> {
    return { ...PRESETS };
  }

  private mapRow(row: any): AutonomyConfig {
    return {
      projectId: row.project_id, level: row.level,
      autoContinue: row.auto_continue === 1, autoBuild: row.auto_build === 1,
      autoLoadContext: row.auto_load_context === 1, smartContext: row.smart_context === 1,
      autoApply: row.auto_apply === 1, autoExec: row.auto_exec === 1,
      autoDebug: row.auto_debug === 1, autoCommit: row.auto_commit === 1,
      updatedAt: row.updated_at,
    };
  }
}
