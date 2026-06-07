// Skill metadata parser: YAML frontmatter extraction, printing, and validation

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  source: 'local' | 'bundled' | 'custom' | 'workspace';
  version: string;
  category: string;
  tags: string[];
  scope: 'global' | 'workspace' | 'project' | 'agent';
  entrypoint?: string;
  enabled: boolean;
  installed: boolean;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ParseResult =
  | { ok: true; skill: SkillDefinition }
  | { ok: false; errors: ValidationError[] };

export interface ValidationError {
  field: string;
  message: string;
  line?: number;
}

const VALID_SOURCES = ['local', 'bundled', 'custom', 'workspace'] as const;
const VALID_SCOPES = ['global', 'workspace', 'project', 'agent'] as const;

const ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Simple YAML frontmatter parser for key-value pairs.
 * Handles: strings, booleans, numbers, arrays (inline [a, b] syntax).
 * Does NOT handle nested objects, multi-line strings, or anchors.
 */
function parseYamlFrontmatter(yaml: string): { fields: Record<string, unknown>; errors: ValidationError[] } {
  const fields: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      errors.push({ field: 'yaml', message: `Invalid YAML syntax: missing colon`, line: i + 2 }); // +2 for 1-indexed + opening ---
      continue;
    }

    const key = line.substring(0, colonIdx).trim();
    let value: unknown = line.substring(colonIdx + 1).trim();

    if (typeof value === 'string') {
      value = parseYamlValue(value as string);
    }

    fields[key] = value;
  }

  return { fields, errors };
}

function parseYamlValue(raw: string): unknown {
  // Empty value
  if (raw === '' || raw === '~' || raw === 'null') return undefined;

  // Booleans
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;

  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => {
      const trimmed = item.trim();
      return stripQuotes(trimmed);
    });
  }

  // Quoted string
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  return raw;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize a YAML value back to a string for frontmatter output.
 */
function serializeYamlValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => {
      const s = String(v);
      // Quote array items that contain commas or brackets
      if (s.includes(',') || s.includes('[') || s.includes(']')) {
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      }
      return s;
    }).join(', ') + ']';
  }
  const str = String(value);
  // Quote strings that contain special YAML characters
  if (str.includes(':') || str.includes('#') || str.includes('[') || str.includes(']') ||
      str.includes('{') || str.includes('}') || str.includes(',') || str.includes("'") ||
      str.startsWith('"') || str.startsWith("'") || str === 'true' || str === 'false' ||
      str === 'null' || str === '~' || /^-?\d+(\.\d+)?$/.test(str)) {
    // Use double quotes, escaping internal double quotes
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return str;
}

/** Parse a markdown string with YAML frontmatter into a SkillDefinition. */
export function parseSkillMarkdown(raw: string): ParseResult {
  const trimmed = raw.trim();

  // Check for frontmatter delimiters
  if (!trimmed.startsWith('---')) {
    return {
      ok: false,
      errors: [{ field: 'frontmatter', message: 'Missing opening frontmatter delimiter (---)' }],
    };
  }

  const afterOpening = trimmed.indexOf('\n', 0);
  if (afterOpening === -1) {
    return {
      ok: false,
      errors: [{ field: 'frontmatter', message: 'Missing closing frontmatter delimiter (---)' }],
    };
  }

  const closingIdx = trimmed.indexOf('\n---', afterOpening);
  if (closingIdx === -1) {
    return {
      ok: false,
      errors: [{ field: 'frontmatter', message: 'Missing closing frontmatter delimiter (---)' }],
    };
  }

  const yamlBlock = trimmed.substring(afterOpening + 1, closingIdx);
  const contentStart = closingIdx + 4; // skip \n---
  const content = trimmed.substring(contentStart).replace(/^\n+/, '');

  const { fields, errors: yamlErrors } = parseYamlFrontmatter(yamlBlock);

  if (yamlErrors.length > 0) {
    return { ok: false, errors: yamlErrors };
  }

  const now = new Date().toISOString();

  // Build partial skill from parsed fields
  const partial: Partial<SkillDefinition> = {
    id: typeof fields.id === 'string' ? fields.id : undefined,
    name: typeof fields.name === 'string' ? fields.name : undefined,
    description: typeof fields.description === 'string' ? fields.description : undefined,
    source: typeof fields.source === 'string' && isValidSource(fields.source) ? fields.source : undefined,
    version: typeof fields.version === 'string' ? fields.version : (typeof fields.version === 'number' ? String(fields.version) : '1.0.0'),
    category: typeof fields.category === 'string' ? fields.category : 'general',
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    scope: typeof fields.scope === 'string' && isValidScope(fields.scope) ? fields.scope : 'project',
    entrypoint: typeof fields.entrypoint === 'string' ? fields.entrypoint : undefined,
    enabled: typeof fields.enabled === 'boolean' ? fields.enabled : true,
    installed: typeof fields.installed === 'boolean' ? fields.installed : false,
    content,
    createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : now,
    updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : now,
  };

  // Extract metadata: all fields not in the known set
  const knownFields = new Set([
    'id', 'name', 'description', 'source', 'version', 'category',
    'tags', 'scope', 'entrypoint', 'enabled', 'installed', 'createdAt', 'updatedAt',
  ]);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!knownFields.has(key)) {
      metadata[key] = value;
    }
  }
  partial.metadata = metadata;

  // Validate
  const validationErrors = validateSkillDefinition(partial);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors };
  }

  return { ok: true, skill: partial as SkillDefinition };
}

/** Serialize a SkillDefinition back to markdown with YAML frontmatter. */
export function printSkillMarkdown(skill: SkillDefinition): string {
  const lines: string[] = ['---'];

  lines.push(`id: ${serializeYamlValue(skill.id)}`);
  lines.push(`name: ${serializeYamlValue(skill.name)}`);
  lines.push(`description: ${serializeYamlValue(skill.description)}`);
  lines.push(`source: ${serializeYamlValue(skill.source)}`);
  lines.push(`version: ${serializeYamlValue(skill.version)}`);
  lines.push(`category: ${serializeYamlValue(skill.category)}`);
  lines.push(`tags: ${serializeYamlValue(skill.tags)}`);
  lines.push(`scope: ${serializeYamlValue(skill.scope)}`);
  if (skill.entrypoint !== undefined) {
    lines.push(`entrypoint: ${serializeYamlValue(skill.entrypoint)}`);
  }
  lines.push(`enabled: ${serializeYamlValue(skill.enabled)}`);
  lines.push(`installed: ${serializeYamlValue(skill.installed)}`);
  lines.push(`createdAt: ${serializeYamlValue(skill.createdAt)}`);
  lines.push(`updatedAt: ${serializeYamlValue(skill.updatedAt)}`);

  // Serialize extra metadata fields
  for (const [key, value] of Object.entries(skill.metadata)) {
    lines.push(`${key}: ${serializeYamlValue(value)}`);
  }

  lines.push('---');
  lines.push(''); // blank line between frontmatter and content

  // Append content body
  if (skill.content) {
    lines.push(skill.content);
  }

  return lines.join('\n');
}

/** Validate a SkillDefinition's fields. Returns empty array if valid. */
export function validateSkillDefinition(skill: Partial<SkillDefinition>): ValidationError[] {
  const errors: ValidationError[] = [];

  // id: required, must match pattern
  if (skill.id === undefined || skill.id === null || skill.id === '') {
    errors.push({ field: 'id', message: 'id is required' });
  } else if (typeof skill.id !== 'string' || !ID_PATTERN.test(skill.id)) {
    errors.push({ field: 'id', message: 'id must match pattern ^[a-z0-9-]+$' });
  }

  // name: required, 1-100 chars
  if (skill.name === undefined || skill.name === null || skill.name === '') {
    errors.push({ field: 'name', message: 'name is required' });
  } else if (typeof skill.name !== 'string' || skill.name.length > 100) {
    errors.push({ field: 'name', message: 'name must be 1-100 characters' });
  }

  // description: required, 1-500 chars
  if (skill.description === undefined || skill.description === null || skill.description === '') {
    errors.push({ field: 'description', message: 'description is required' });
  } else if (typeof skill.description !== 'string' || skill.description.length > 500) {
    errors.push({ field: 'description', message: 'description must be 1-500 characters' });
  }

  // entrypoint: no .. sequences
  if (skill.entrypoint !== undefined && skill.entrypoint !== null) {
    if (typeof skill.entrypoint === 'string' && skill.entrypoint.includes('..')) {
      errors.push({ field: 'entrypoint', message: 'entrypoint must not contain directory traversal sequences (..)' });
    }
  }

  // source: must be valid enum
  if (skill.source !== undefined && skill.source !== null) {
    if (!VALID_SOURCES.includes(skill.source as typeof VALID_SOURCES[number])) {
      errors.push({ field: 'source', message: `source must be one of: ${VALID_SOURCES.join(', ')}` });
    }
  }

  // scope: must be valid enum
  if (skill.scope !== undefined && skill.scope !== null) {
    if (!VALID_SCOPES.includes(skill.scope as typeof VALID_SCOPES[number])) {
      errors.push({ field: 'scope', message: `scope must be one of: ${VALID_SCOPES.join(', ')}` });
    }
  }

  return errors;
}

function isValidSource(s: string): s is SkillDefinition['source'] {
  return VALID_SOURCES.includes(s as typeof VALID_SOURCES[number]);
}

function isValidScope(s: string): s is SkillDefinition['scope'] {
  return VALID_SCOPES.includes(s as typeof VALID_SCOPES[number]);
}
