/**
 * PersonaRegistry — Composable behavioral overlays for agents.
 *
 * Personas are loaded from `.neuronest/personas/*.json` (project tier) and
 * `~/.neuronest/personas/*.json` (user tier), plus built-in read-only defaults.
 *
 * Resolution order: agent prompt → rulesets → persona overlay.
 * Personas do NOT change model selection, tool availability, authorization,
 * sandbox profile, or agent identity. Persona content counts against context budgets.
 *
 * Requirements: 18.1, 18.2, 18.3
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// ─── Public Types ───────────────────────────────────────────────

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPromptOverlay: string;
  toolSubset?: string[];
  style?: PersonaStyle;
  builtIn: boolean;
  source: 'builtin' | 'project' | 'user';
}

export interface PersonaStyle {
  verbosity?: 'terse' | 'normal' | 'verbose';
  outputContract?: {
    format: 'markdown' | 'json' | 'diff-only';
    schema?: object;
  };
}

export interface SessionContext {
  systemPrompt: string;
  availableTools?: string[];
  metadata?: Record<string, unknown>;
}

export interface PersonaFileSchema {
  name: string;
  description: string;
  systemPromptOverlay: string;
  toolSubset?: string[];
  style?: PersonaStyle;
}

// ─── Built-in Personas ──────────────────────────────────────────

const BUILTIN_PERSONAS: Omit<Persona, 'id'>[] = [
  {
    name: 'concise',
    description: 'Terse, minimal output focused on essentials only.',
    systemPromptOverlay:
      'Respond concisely. Omit pleasantries, filler, and redundant explanation. ' +
      'Provide only the essential answer or code. Use bullet points over paragraphs.',
    style: { verbosity: 'terse' },
    builtIn: true,
    source: 'builtin',
  },
  {
    name: 'adversarial-reviewer',
    description: 'Critical code reviewer that actively seeks flaws, edge cases, and anti-patterns.',
    systemPromptOverlay:
      'You are an adversarial code reviewer. Actively look for bugs, security vulnerabilities, ' +
      'performance issues, edge cases, and design anti-patterns. Challenge assumptions. ' +
      'Rate severity for each finding. Be constructive but thorough — do not let issues slide.',
    style: { verbosity: 'verbose' },
    builtIn: true,
    source: 'builtin',
  },
  {
    name: 'researcher',
    description: 'Citation-heavy research mode that pairs with read-only execution posture.',
    systemPromptOverlay:
      'You are in research mode. Provide citations for all claims. ' +
      'Structure output as findings with evidence. Do not make changes — analyze and report only. ' +
      'Cross-reference multiple sources when possible. Flag low-confidence claims explicitly.',
    style: {
      verbosity: 'verbose',
      outputContract: { format: 'markdown' },
    },
    builtIn: true,
    source: 'builtin',
  },
];

// ─── PersonaRegistry ────────────────────────────────────────────

export class PersonaRegistry {
  private personas: Map<string, Persona> = new Map();
  private projectDir?: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir;
    this._loadBuiltins();
    this._loadFromDisk();
  }

  // ─── CRUD Operations ────────────────────────────────────────

  /**
   * Create a new persona. Returns the generated ID.
   * Built-in persona names cannot be reused.
   */
  create(input: PersonaFileSchema): Persona {
    const existingBuiltin = this._findByName(input.name);
    if (existingBuiltin?.builtIn) {
      throw new Error(`Cannot create persona with reserved built-in name: '${input.name}'`);
    }

    const id = randomUUID();
    const persona: Persona = {
      id,
      name: input.name,
      description: input.description,
      systemPromptOverlay: input.systemPromptOverlay,
      toolSubset: input.toolSubset,
      style: input.style,
      builtIn: false,
      source: 'project',
    };

    this.personas.set(id, persona);
    this._persistPersona(persona);
    return persona;
  }

  /**
   * Retrieve a persona by ID.
   */
  get(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  /**
   * Retrieve a persona by name. Names are unique within the registry.
   */
  getByName(name: string): Persona | undefined {
    return this._findByName(name);
  }

  /**
   * List all registered personas.
   */
  list(): Persona[] {
    return Array.from(this.personas.values());
  }

  /**
   * Update a mutable (non-built-in) persona.
   */
  update(id: string, updates: Partial<PersonaFileSchema>): Persona {
    const existing = this.personas.get(id);
    if (!existing) {
      throw new Error(`Persona not found: '${id}'`);
    }
    if (existing.builtIn) {
      throw new Error(`Cannot modify built-in persona: '${existing.name}'`);
    }

    if (updates.name && updates.name !== existing.name) {
      const nameConflict = this._findByName(updates.name);
      if (nameConflict && nameConflict.id !== id) {
        throw new Error(`Persona name already in use: '${updates.name}'`);
      }
    }

    const updated: Persona = {
      ...existing,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      systemPromptOverlay: updates.systemPromptOverlay ?? existing.systemPromptOverlay,
      toolSubset: updates.toolSubset !== undefined ? updates.toolSubset : existing.toolSubset,
      style: updates.style !== undefined ? updates.style : existing.style,
    };

    this.personas.set(id, updated);
    this._persistPersona(updated);
    return updated;
  }

  /**
   * Delete a mutable persona by ID. Built-in personas cannot be deleted.
   */
  delete(id: string): boolean {
    const existing = this.personas.get(id);
    if (!existing) {
      return false;
    }
    if (existing.builtIn) {
      throw new Error(`Cannot delete built-in persona: '${existing.name}'`);
    }

    this.personas.delete(id);
    this._deletePersonaFile(existing);
    return true;
  }

  // ─── Session Application ────────────────────────────────────

  /**
   * Apply a persona to a session context by injecting the system prompt overlay
   * and filtering available tools if a toolSubset is specified.
   *
   * Resolution: agent prompt → rulesets → persona overlay (appended last).
   */
  applyPersona(sessionContext: SessionContext, personaId: string): SessionContext {
    const persona = this.personas.get(personaId);
    if (!persona) {
      throw new Error(`Persona not found: '${personaId}'`);
    }

    const result: SessionContext = {
      ...sessionContext,
      systemPrompt: sessionContext.systemPrompt + '\n\n' + persona.systemPromptOverlay,
      metadata: {
        ...sessionContext.metadata,
        activePersona: persona.id,
        personaName: persona.name,
        personaSource: persona.source,
      },
    };

    // Tool subset filtering
    if (persona.toolSubset && persona.toolSubset.length > 0) {
      if (sessionContext.availableTools) {
        result.availableTools = sessionContext.availableTools.filter((tool) =>
          persona.toolSubset!.includes(tool),
        );
      } else {
        result.availableTools = [...persona.toolSubset];
      }
    }

    return result;
  }

  // ─── Private Methods ────────────────────────────────────────

  private _loadBuiltins(): void {
    for (const def of BUILTIN_PERSONAS) {
      const id = `builtin-${def.name}`;
      this.personas.set(id, { ...def, id });
    }
  }

  private _loadFromDisk(): void {
    // Load project personas
    if (this.projectDir) {
      const projectPersonasDir = join(this.projectDir, '.neuronest', 'personas');
      this._loadPersonasFromDir(projectPersonasDir, 'project');
    }

    // Load user personas
    const userPersonasDir = join(homedir(), '.neuronest', 'personas');
    this._loadPersonasFromDir(userPersonasDir, 'user');
  }

  private _loadPersonasFromDir(dir: string, source: 'project' | 'user'): void {
    if (!existsSync(dir)) {
      return;
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const content = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as PersonaFileSchema & { id?: string };

        if (!parsed.name || !parsed.systemPromptOverlay) {
          continue;
        }

        // Skip if a built-in with the same name exists
        const existingBuiltin = this._findByName(parsed.name);
        if (existingBuiltin?.builtIn) {
          continue;
        }

        // Project personas take precedence over user personas with same name
        if (source === 'user') {
          const existingProject = this._findByName(parsed.name);
          if (existingProject?.source === 'project') {
            continue;
          }
        }

        const id = parsed.id || `${source}-${basename(file, '.json')}`;
        const persona: Persona = {
          id,
          name: parsed.name,
          description: parsed.description || '',
          systemPromptOverlay: parsed.systemPromptOverlay,
          toolSubset: parsed.toolSubset,
          style: parsed.style,
          builtIn: false,
          source,
        };

        this.personas.set(id, persona);
      } catch {
        // Skip invalid persona files
      }
    }
  }

  private _findByName(name: string): Persona | undefined {
    for (const persona of this.personas.values()) {
      if (persona.name === name) {
        return persona;
      }
    }
    return undefined;
  }

  private _persistPersona(persona: Persona): void {
    if (persona.builtIn || !this.projectDir) {
      return;
    }

    const dir = join(this.projectDir, '.neuronest', 'personas');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filename = `${persona.name.replace(/[^a-zA-Z0-9-_]/g, '-')}.json`;
    const filePath = join(dir, filename);

    const fileContent: PersonaFileSchema & { id: string } = {
      id: persona.id,
      name: persona.name,
      description: persona.description,
      systemPromptOverlay: persona.systemPromptOverlay,
      ...(persona.toolSubset && { toolSubset: persona.toolSubset }),
      ...(persona.style && { style: persona.style }),
    };

    writeFileSync(filePath, JSON.stringify(fileContent, null, 2), 'utf-8');
  }

  private _deletePersonaFile(persona: Persona): void {
    if (persona.builtIn || !this.projectDir) {
      return;
    }

    const dir = join(this.projectDir, '.neuronest', 'personas');
    const filename = `${persona.name.replace(/[^a-zA-Z0-9-_]/g, '-')}.json`;
    const filePath = join(dir, filename);

    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Non-fatal: persona removed from memory even if file delete fails
    }
  }
}
