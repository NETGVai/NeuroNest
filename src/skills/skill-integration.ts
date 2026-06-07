// Integration helpers: trySkillRoute pre-step and design template injection
// Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 16.3, 16.4, 16.6, 16.9

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SkillRegistry } from './skill-registry.js';
import { ExecutionEngine } from './skill-execution-engine.js';
import { CatalogLoader } from './catalog-loader.js';
import { routeTask } from './skill-router.js';
import { DesignTemplatesLibrary } from './design-templates-library.js';
import { autoAssignSkills } from './skill-auto-assignment.js';
import type { SkillDefinition } from './skill-metadata-parser.js';
import type { ExecutionResult } from './skill-execution-engine.js';
import type { RouteResult } from './skill-router.js';

export interface SkillRouteResult {
  matched: boolean;
  skill: SkillDefinition | null;
  result: ExecutionResult | null;
  route: RouteResult;
}

/**
 * Try to route a chat message to a skill before the existing pipeline.
 * Returns matched=false if no skill matches, allowing the existing pipeline to proceed unchanged.
 * Requirements: 8.1, 8.3, 8.4, 8.5, 8.6
 */
export async function trySkillRoute(
  db: Database.Database,
  prompt: string,
  projectId: string,
  projectDir: string,
): Promise<SkillRouteResult> {
  const registry = new SkillRegistry(db);
  const engine = new ExecutionEngine(db);

  const route = routeTask(registry, {
    prompt,
    projectId,
  });

  if (!route.matched || !route.skill) {
    return { matched: false, skill: null, result: null, route };
  }

  const result = await engine.execute(route.skill, {
    prompt,
    projectDir,
  });

  return { matched: true, skill: route.skill, result, route };
}

/**
 * Inject design template content into an agent task description.
 * When routeTask() selects a design-template skill, prepend template content
 * with --- DESIGN TEMPLATE --- delimiters.
 * When no template is assigned/selected, returns the original task unchanged.
 * Requirements: 16.3, 16.4, 16.6, 16.9
 */
export function injectDesignTemplate(
  db: Database.Database,
  taskDescription: string,
  projectId: string,
): string {
  const registry = new SkillRegistry(db);
  const templatesLibrary = new DesignTemplatesLibrary(db);

  const route = routeTask(registry, {
    prompt: taskDescription,
    projectId,
  });

  if (!route.matched || !route.skill) {
    return taskDescription;
  }

  // Only inject for design-template category skills
  if (route.skill.category !== 'design-template') {
    return taskDescription;
  }

  const templateContent = route.skill.content;
  if (!templateContent) {
    return taskDescription;
  }

  // Record template usage for skill demonstration tracking
  templatesLibrary.recordTemplateUsage({
    templateId: route.skill.id,
    agentId: 'system',
    projectId,
    taskContext: taskDescription,
    usageType: 'recommendation',
    skillDemonstrated: ['design_template_usage', 'ui_design', 'template_application']
  });

  return `--- DESIGN TEMPLATE: ${route.skill.name} ---\n${templateContent}\n--- END DESIGN TEMPLATE ---\n\n${taskDescription}`;
}

/**
 * Load agent-skill mappings from bundled JSON and insert into agent_skill_assignments table.
 * Uses INSERT OR IGNORE so existing assignments are not overwritten.
 */
export function loadAgentSkillMappings(db: Database.Database): number {
  const mappingsPath = path.resolve(__dirname, '../data/agent-skill-mappings.json');

  if (!fs.existsSync(mappingsPath)) {
    console.warn('[Skills] Agent skill mappings file not found:', mappingsPath);
    return 0;
  }

  let mappingsData: string;
  try {
    mappingsData = fs.readFileSync(mappingsPath, 'utf-8');
  } catch (err) {
    console.warn('[Skills] Failed to read agent skill mappings:', err);
    return 0;
  }

  let mappings: Array<{ agentId: string; skillIds: string[] }>;
  try {
    mappings = JSON.parse(mappingsData) as Array<{ agentId: string; skillIds: string[] }>;
  } catch (err) {
    console.warn('[Skills] Failed to parse agent skill mappings:', err);
    return 0;
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agent_skill_assignments
       (agent_id, skill_id, proficiency_level, success_rate, total_executions, successful_executions, avg_execution_time_ms, learned_at)
     VALUES (?, ?, 'intermediate', 0.0, 0, 0, 0, CURRENT_TIMESTAMP)`
  );

  let count = 0;
  let skipped = 0;
  for (const mapping of mappings) {
    for (const skillId of mapping.skillIds) {
      try {
        const result = stmt.run(mapping.agentId, skillId);
        if (result.changes > 0) count++;
        else skipped++;
      } catch (err: any) {
        // Log first few failures for debugging
        if (skipped < 3) {
          console.warn(`[Skills] Assignment failed: agent=${mapping.agentId} skill=${skillId} error=${err?.message}`);
        }
        skipped++;
      }
    }
  }

  console.log(`[Skills] Loaded ${count} agent-skill assignments (${skipped} skipped/existing)`);
  return count;
}

/**
 * Load bundled catalog and register design templates as skills on app startup.
 * Called after initDatabase() during app initialization.
 * Requirements: 3.1, 3.2, 16.2
 */
export function loadCatalogAndTemplates(db: Database.Database): { catalogCount: number; templateCount: number } {
  const catalog = new CatalogLoader(db);
  const registry = new SkillRegistry(db);

  // Load bundled catalog into catalog_skills table
  const catalogCount = catalog.loadBundledCatalog();
  console.log(`[Skills] Loaded ${catalogCount} bundled catalog entries`);

  // Load and register design templates as skills
  let templateCount = 0;
  const templateDir = path.resolve(__dirname, '../data/design-templates');
  const indexPath = path.join(templateDir, 'template-index.json');

  if (!fs.existsSync(indexPath)) {
    console.warn('[Skills] Design template index not found:', indexPath);
    return { catalogCount, templateCount };
  }

  try {
    const indexData = fs.readFileSync(indexPath, 'utf-8');
    const entries = JSON.parse(indexData) as Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      tags: string[];
      version: string;
      file: string;
      previewFile?: string;
      designStyle?: string;
      industry?: string;
      colorScheme?: string[];
    }>;

    for (const entry of entries) {
      const filePath = path.join(templateDir, entry.file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        console.warn(`[Skills] Failed to read template file: ${filePath}`);
        continue;
      }

      // Load preview HTML if available
      let previewHtml: string | undefined;
      if (entry.previewFile) {
        const previewPath = path.join(templateDir, entry.previewFile);
        try {
          previewHtml = fs.readFileSync(previewPath, 'utf-8');
        } catch {
          // Preview file optional
        }
      }

      const now = new Date().toISOString();
      registry.upsert({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        source: 'bundled',
        version: entry.version || '1.0.0',
        category: 'design-template',
        tags: entry.tags || [],
        scope: 'project',
        enabled: true,
        installed: true,
        content,
        metadata: {
          designStyle: entry.designStyle,
          industry: entry.industry,
          colorScheme: entry.colorScheme,
          previewHtml: previewHtml,
        },
        createdAt: now,
        updatedAt: now,
      });
      templateCount++;
    }

    console.log(`[Skills] Registered ${templateCount} design templates as skills`);
  } catch (err) {
    console.warn('[Skills] Failed to load design templates:', err);
  }

  // Load agent-skill mappings after skills are loaded
  const assignmentCount = loadAgentSkillMappings(db);
  console.log(`[Skills] Auto-assigned ${assignmentCount} agent-skill mappings`);

  // Run keyword-based auto-assignment for additional skill-agent matches
  const autoAssignCount = autoAssignSkills(db);
  console.log(`[Skills] Keyword auto-assigned ${autoAssignCount} additional agent-skill pairs`);

  // Diagnostic: verify data is in the database
  try {
    const skillsInDb = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c;
    const assignsInDb = (db.prepare('SELECT COUNT(*) as c FROM agent_skill_assignments').get() as any).c;
    const sampleAssign = db.prepare('SELECT agent_id, skill_id FROM agent_skill_assignments LIMIT 3').all() as any[];
    console.log(`[Skills] DB state: ${skillsInDb} skills, ${assignsInDb} assignments`);
    if (sampleAssign.length > 0) {
      console.log(`[Skills] Sample: ${sampleAssign.map((r: any) => `${r.agent_id}→${r.skill_id}`).join(', ')}`);
    }
  } catch (e) {
    console.warn('[Skills] DB diagnostic failed:', e);
  }

  return { catalogCount, templateCount };
}
