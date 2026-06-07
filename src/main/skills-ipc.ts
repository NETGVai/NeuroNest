// Skills IPC handlers: wires renderer Skills_Panel to backend skill subsystems
// Requirements: 12.1, 12.2, 12.4, 15.1, 15.2, 15.3

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { SkillRegistry } from '../skills/skill-registry.js';
import { ExecutionEngine } from '../skills/skill-execution-engine.js';
import { CatalogLoader } from '../skills/catalog-loader.js';
import { routeTask } from '../skills/skill-router.js';
import { parseSkillMarkdown, printSkillMarkdown } from '../skills/skill-metadata-parser.js';
import type { SkillDefinition } from '../skills/skill-metadata-parser.js';
import type { TaskContext } from '../skills/skill-router.js';
import { writeFileWithHeader } from '../utils/project-headers';

/**
 * Register all skills-related IPC handlers.
 * Called from the existing registerIPCHandlers() in ipc.ts.
 */
export function registerSkillsIPC(db: Database.Database): void {
  const registry = new SkillRegistry(db);
  const engine = new ExecutionEngine(db);
  const catalog = new CatalogLoader(db);

  // ── Skills CRUD ──

  ipcMain.handle('skills:list', async (_event, filters?: {
    source?: string;
    scope?: string;
    enabled?: boolean;
    installed?: boolean;
    projectId?: string;
  }) => {
    try {
      return registry.list(filters);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:get', async (_event, arg: string | { id: string }) => {
    try {
      const id = typeof arg === 'object' && arg !== null ? arg.id : arg;
      return registry.get(id);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:update', async (_event, skillData: SkillDefinition) => {
    try {
      registry.upsert(skillData);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:install', async (_event, arg: string | { id: string }) => {
    try {
      const catalogSkillId = typeof arg === 'object' && arg !== null ? arg.id : arg;
      const entry = catalog.getCatalogEntry(catalogSkillId);
      if (!entry) {
        return { error: `Catalog skill not found: ${catalogSkillId}` };
      }

      const parseResult = parseSkillMarkdown(entry.content);
      let skill: SkillDefinition;

      if (parseResult.ok) {
        skill = {
          ...parseResult.skill,
          source: 'bundled' as const,
          installed: true,
          enabled: true,
        };
      } else {
        // Catalog entry content may not have frontmatter; build skill from catalog metadata
        skill = {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          source: 'bundled' as const,
          version: entry.version || '1.0.0',
          category: entry.category || 'general',
          tags: entry.tags || [],
          scope: 'project' as const,
          enabled: true,
          installed: true,
          content: entry.content,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      registry.upsert(skill);
      return { success: true, skill };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:remove', async (_event, arg: string | { id: string }) => {
    try {
      const id = typeof arg === 'object' && arg !== null ? arg.id : arg;
      registry.remove(id);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Enable / Disable ──

  ipcMain.handle('skills:enable', async (_event, arg: string | { id: string }) => {
    try {
      const id = typeof arg === 'object' && arg !== null ? arg.id : arg;
      registry.setEnabled(id, true);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:disable', async (_event, arg: string | { id: string }) => {
    try {
      const id = typeof arg === 'object' && arg !== null ? arg.id : arg;
      registry.setEnabled(id, false);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Test Execution ──

  ipcMain.handle('skills:test', async (_event, args: {
    id?: string;
    skillId?: string;
    input?: string | { prompt: string; filePaths?: string[]; projectDir: string; parameters?: Record<string, unknown> };
    projectDir?: string;
    timeout?: number;
  }) => {
    try {
      const skillId = args.skillId || args.id || '';
      const skill = registry.get(skillId);
      if (!skill) {
        return { error: `Skill not found: ${skillId}` };
      }

      // Normalize input: renderer may send a string or an object
      let execInput: { prompt: string; filePaths?: string[]; projectDir: string; parameters?: Record<string, unknown> };
      if (typeof args.input === 'string') {
        execInput = { prompt: args.input, projectDir: args.projectDir || '.' };
      } else if (args.input && typeof args.input === 'object') {
        execInput = args.input;
      } else {
        execInput = { prompt: '', projectDir: args.projectDir || '.' };
      }

      const result = await engine.execute(skill, execInput, {
        timeout: args.timeout,
        isTest: true,
      });
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Catalog ──

  ipcMain.handle('skills:refreshCatalog', async () => {
    try {
      const count = catalog.refreshCatalog();
      const entries = catalog.listCatalog();
      return { success: true, count, entries };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Import / Export ──

  ipcMain.handle('skills:import', async (_event, args: { filePath: string }) => {
    try {
      const fs = await import('node:fs');
      const raw = fs.readFileSync(args.filePath, 'utf-8');
      const parseResult = parseSkillMarkdown(raw);

      if (parseResult.ok === false) {
        return { error: 'Validation failed', errors: parseResult.errors };
      }

      const skill: SkillDefinition = {
        ...parseResult.skill,
        source: 'custom' as const,
        installed: true,
      };

      registry.upsert(skill);
      return { success: true, skill };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills:export', async (_event, args: { skillId: string; filePath: string }) => {
    try {
      const skill = registry.get(args.skillId);
      if (!skill) {
        return { error: `Skill not found: ${args.skillId}` };
      }

      const markdown = printSkillMarkdown(skill);
      const fs = await import('node:fs');
      const path = await import('node:path');
      writeFileWithHeader(args.filePath, markdown);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Orchestrator Integration ──

  ipcMain.handle('orchestrator:routeTask', async (_event, context: TaskContext & { threshold?: number }) => {
    try {
      const { threshold, ...taskContext } = context;
      const result = routeTask(registry, taskContext, threshold);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Project Skills ──

  ipcMain.handle('project:skills:get', async (_event, projectId: string) => {
    try {
      const skills = registry.list({ projectId });
      const prefs = registry.getRoutingPrefs(projectId);
      return { skills, prefs };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('project:skills:update', async (_event, args: {
    skillId: string;
    projectId: string;
    pref: { weightOverride?: number | null; enabledOverride?: boolean | null };
  }) => {
    try {
      registry.setRoutingPref(args.skillId, args.projectId, args.pref);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('project:skills:assign', async (_event, args: {
    skillId: string;
    projectId: string;
  }) => {
    try {
      // Assign a design template to a project with weight_override = 999
      // This ensures the template always wins for Design agent tasks
      registry.setRoutingPref(args.skillId, args.projectId, {
        weightOverride: 999,
        enabledOverride: true,
      });
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Agent Skill Assignments (fallback for when enhanced coordinator is unavailable) ──

  ipcMain.handle('get-agent-skill-assignments', async (_event, agentId: string) => {
    try {
      const rows = db.prepare(
        `SELECT asa.agent_id, asa.skill_id, asa.proficiency_level, asa.success_rate,
                asa.total_executions, asa.successful_executions, s.name
         FROM agent_skill_assignments asa
         LEFT JOIN skills s ON asa.skill_id = s.id
         WHERE asa.agent_id = ?
         ORDER BY s.name ASC`
      ).all(agentId) as Array<{
        agent_id: string;
        skill_id: string;
        proficiency_level: string;
        success_rate: number;
        total_executions: number;
        successful_executions: number;
        name: string | null;
      }>;

      return rows.map(r => ({
        skillId: r.skill_id,
        name: r.name || r.skill_id,
        proficiencyLevel: r.proficiency_level,
        successRate: r.success_rate,
        totalExecutions: r.total_executions,
        successfulExecutions: r.successful_executions,
      }));
    } catch (err) {
      return [];
    }
  });
}
