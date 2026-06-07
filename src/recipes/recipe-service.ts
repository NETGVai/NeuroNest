/**
 * Recipe Service — portable YAML workflow configs with parameterization.
 *
 * Recipes package instructions, parameters, extensions, and sub-recipes
 * into reusable, shareable configurations with Jinja2-style templating.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface RecipeParameter {
  name: string;
  type: 'string' | 'integer' | 'boolean' | 'float' | 'array' | 'object';
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface Recipe {
  id: string; name: string; version: string; description?: string;
  parameters: RecipeParameter[]; extensions: unknown[]; instructions: string;
  subRecipes: unknown[]; responseSchema?: unknown; author?: string;
  source?: string; isBuiltin: boolean; createdAt: string;
}

export interface RecipeRun {
  id: string; recipeId: string; projectId?: string; parameters: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed'; output?: string;
  startedAt: string; completedAt?: string;
}

const BUILTIN_RECIPES: Omit<Recipe, 'id' | 'createdAt'>[] = [
  {
    name: 'Code Review', version: '1.0.0', description: 'Review code for quality, security, and best practices',
    parameters: [{ name: 'focus', type: 'string', description: 'Focus area (security, performance, quality)', default: 'quality' }],
    extensions: [], instructions: 'Review the current project code with focus on {{focus}}. Check for bugs, security issues, and suggest improvements.',
    subRecipes: [], isBuiltin: true, author: 'NeuroNest',
  },
  {
    name: 'API Builder', version: '1.0.0', description: 'Build a REST API with authentication and tests',
    parameters: [
      { name: 'language', type: 'string', description: 'Programming language', required: true },
      { name: 'database', type: 'string', description: 'Database type', default: 'sqlite' },
    ],
    extensions: [], instructions: 'Build a REST API in {{language}} with {{database}} database, JWT auth, CRUD endpoints, validation, and tests.',
    subRecipes: [], isBuiltin: true, author: 'NeuroNest',
  },
  {
    name: 'Security Audit', version: '1.0.0', description: 'Perform a comprehensive security audit',
    parameters: [], extensions: [],
    instructions: 'Perform a security audit: check for hardcoded secrets, SQL injection, XSS, missing auth, insecure dependencies. Report findings with severity and fixes.',
    subRecipes: [], isBuiltin: true, author: 'NeuroNest',
  },
  {
    name: 'Test Generator', version: '1.0.0', description: 'Generate tests for existing code',
    parameters: [{ name: 'framework', type: 'string', description: 'Test framework', default: 'vitest' }],
    extensions: [], instructions: 'Generate comprehensive tests using {{framework}} for all untested functions. Include unit tests, edge cases, and integration tests.',
    subRecipes: [], isBuiltin: true, author: 'NeuroNest',
  },
];

export class RecipeService {
  constructor(private db: Database.Database) { this.ensureBuiltins(); }

  private ensureBuiltins(): void {
    for (const r of BUILTIN_RECIPES) {
      const existing = this.db.prepare('SELECT id FROM recipes WHERE name = ? AND is_builtin = 1').get(r.name) as any;
      if (!existing) {
        this.db.prepare('INSERT INTO recipes (id, name, version, description, parameters, extensions, instructions, sub_recipes, response_schema, author, source, is_builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
          .run(randomUUID(), r.name, r.version, r.description || null, JSON.stringify(r.parameters), JSON.stringify(r.extensions), r.instructions, JSON.stringify(r.subRecipes), null, r.author || null, null, new Date().toISOString());
      }
    }
  }

  list(): Recipe[] {
    return (this.db.prepare('SELECT * FROM recipes ORDER BY is_builtin DESC, name ASC').all() as any[]).map(r => this.mapRecipe(r));
  }

  get(id: string): Recipe | null {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
    return r ? this.mapRecipe(r) : null;
  }

  create(opts: { name: string; description?: string; parameters?: RecipeParameter[]; instructions: string; responseSchema?: unknown }): Recipe {
    const id = randomUUID();
    this.db.prepare('INSERT INTO recipes (id, name, version, description, parameters, extensions, instructions, sub_recipes, response_schema, is_builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, opts.name, '1.0.0', opts.description || null, JSON.stringify(opts.parameters || []), '[]', opts.instructions, '[]', opts.responseSchema ? JSON.stringify(opts.responseSchema) : null, new Date().toISOString());
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM recipes WHERE id = ? AND is_builtin = 0').run(id).changes > 0;
  }

  /** Apply template substitution to instructions */
  renderInstructions(instructions: string, params: Record<string, unknown>): string {
    let result = instructions;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}', 'g'), String(value));
    }
    return result;
  }

  startRun(recipeId: string, projectId?: string, params?: Record<string, unknown>): RecipeRun {
    const id = randomUUID();
    this.db.prepare('INSERT INTO recipe_runs (id, recipe_id, project_id, parameters, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, recipeId, projectId || null, JSON.stringify(params || {}), 'running', new Date().toISOString());
    return { id, recipeId, projectId, parameters: params || {}, status: 'running', startedAt: new Date().toISOString() };
  }

  completeRun(runId: string, success: boolean, output?: string): void {
    this.db.prepare('UPDATE recipe_runs SET status = ?, output = ?, completed_at = ? WHERE id = ?')
      .run(success ? 'completed' : 'failed', output || null, new Date().toISOString(), runId);
  }

  getRecentRuns(limit?: number): RecipeRun[] {
    return (this.db.prepare('SELECT * FROM recipe_runs ORDER BY started_at DESC LIMIT ?').all(limit || 20) as any[])
      .map(r => ({ id: r.id, recipeId: r.recipe_id, projectId: r.project_id, parameters: JSON.parse(r.parameters || '{}'), status: r.status, output: r.output || undefined, startedAt: r.started_at, completedAt: r.completed_at || undefined }));
  }

  createDeeplink(recipeId: string, params?: Record<string, unknown>): string {
    const id = randomUUID();
    const shortCode = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO recipe_deeplinks (id, recipe_id, short_code, parameters, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, recipeId, shortCode, JSON.stringify(params || {}), new Date().toISOString());
    return shortCode;
  }

  private mapRecipe(r: any): Recipe {
    return {
      id: r.id, name: r.name, version: r.version, description: r.description || undefined,
      parameters: JSON.parse(r.parameters || '[]'), extensions: JSON.parse(r.extensions || '[]'),
      instructions: r.instructions, subRecipes: JSON.parse(r.sub_recipes || '[]'),
      responseSchema: r.response_schema ? JSON.parse(r.response_schema) : undefined,
      author: r.author || undefined, source: r.source || undefined,
      isBuiltin: r.is_builtin === 1, createdAt: r.created_at,
    };
  }
}
