/**
 * Agent Importer
 *
 * Reads markdown agent files from the agency-agents repository and converts them
 * to NeuroNest's AgentDefinition TypeScript interface format.
 *
 * Key responsibilities:
 * - Parse YAML frontmatter (name, description, color) from markdown files
 * - Concatenate structured sections into systemPrompt
 * - Map directory paths to departments via division-mapper
 * - Generate kebab-case IDs from agent names
 * - Assign tool permissions based on division mapping
 * - Upgrade command permission when systemPrompt references code execution
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';

import type { AgentDefinition, ToolPermission } from '../agents/agent-registry';
import type { ImportedAgent, ImportResult } from './types';
import {
  mapDirectoryToDepartment,
  getPermissionForDivision,
  registerDepartment,
  mapColorToEmoji,
} from './division-mapper';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Sections to extract from the markdown body and concatenate into the systemPrompt.
 * Order matters — they're joined in this sequence.
 */
const SYSTEM_PROMPT_SECTIONS = [
  'Identity',
  'Core Mission',
  'Critical Rules',
  'Technical Deliverables',
  'Workflow Process',
  'Success Metrics',
];

/**
 * Keywords that indicate an agent needs command execution permission,
 * regardless of its division default.
 */
const COMMAND_UPGRADE_KEYWORDS = [
  'execute',
  'run command',
  'shell command',
  'terminal',
  'command line',
  'command-line',
  'cli',
  'bash',
  'subprocess',
  'spawn',
  'exec(',
  'child_process',
  'code execution',
  'run script',
  'execute script',
  'tool usage',
  'invoke tool',
  'call tool',
  'use tools',
  'tool access',
];

// ─────────────────────────────────────────────
// YAML Frontmatter Parsing
// ─────────────────────────────────────────────

/**
 * Parses YAML frontmatter from a markdown file content string.
 * Frontmatter is delimited by --- markers at the start of the file.
 *
 * @param content - Raw markdown content
 * @returns An object with frontmatter fields and the remaining body
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  const endMarkerIndex = trimmed.indexOf('---', 3);
  if (endMarkerIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterBlock = trimmed.slice(3, endMarkerIndex).trim();
  const body = trimmed.slice(endMarkerIndex + 3).trim();

  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterBlock.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ─────────────────────────────────────────────
// Section Extraction
// ─────────────────────────────────────────────

/**
 * Extracts named sections from the markdown body.
 * Sections are identified by ## or # headers matching the section names.
 *
 * @param body - The markdown body (without frontmatter)
 * @returns Map of section name → section content
 */
function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split('\n');

  let currentSection: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    // Match ## Section Name or # Section Name
    const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections.set(currentSection, currentContent.join('\n').trim());
      }
      currentSection = (headerMatch[1] ?? '').trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Save final section
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }

  return sections;
}

/**
 * Concatenates the relevant sections into a single systemPrompt string.
 * Preserves structural formatting (headers, bullet points, etc.)
 */
function buildSystemPrompt(sections: Map<string, string>, fullBody: string): string {
  const parts: string[] = [];

  for (const sectionName of SYSTEM_PROMPT_SECTIONS) {
    // Try exact match first, then case-insensitive
    let content = sections.get(sectionName);
    if (!content) {
      for (const [key, value] of sections) {
        if (key.toLowerCase() === sectionName.toLowerCase()) {
          content = value;
          break;
        }
      }
    }

    if (content) {
      parts.push(`## ${sectionName}\n\n${content}`);
    }
  }

  // If no recognized sections found, use the full body as the system prompt
  if (parts.length === 0) {
    return fullBody.trim() || 'You are a specialized AI agent.';
  }

  return parts.join('\n\n');
}

// ─────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────

/**
 * Generates a kebab-case ID from an agent name.
 *
 * Rules:
 * - Lowercase
 * - Only alphanumeric characters and hyphens
 * - No leading, trailing, or consecutive hyphens
 *
 * @param name - The agent's display name
 * @returns A valid kebab-case identifier
 */
export function generateId(name: string): string {
  if (!name || typeof name !== 'string') {
    return 'unnamed-agent';
  }

  const id = name
    .toLowerCase()
    // Replace non-alphanumeric characters with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading hyphens
    .replace(/^-+/, '')
    // Remove trailing hyphens
    .replace(/-+$/, '')
    // Collapse consecutive hyphens
    .replace(/-{2,}/g, '-');

  return id || 'unnamed-agent';
}

// ─────────────────────────────────────────────
// Permission Assignment
// ─────────────────────────────────────────────

/**
 * Checks if the systemPrompt references code execution, shell commands,
 * or tool usage keywords that warrant upgrading command permission.
 */
function shouldUpgradeCommandPermission(systemPrompt: string): boolean {
  const lowerPrompt = systemPrompt.toLowerCase();
  return COMMAND_UPGRADE_KEYWORDS.some((keyword) => lowerPrompt.includes(keyword.toLowerCase()));
}

/**
 * Assigns tool permissions to an imported agent based on its division
 * and systemPrompt content analysis.
 *
 * @param agent - The imported agent
 * @returns The tool permission profile
 */
export function assignPermissions(agent: ImportedAgent): ToolPermission {
  const divisionProfile = getPermissionForDivision(agent.division);

  const permission: ToolPermission = {
    read: divisionProfile.read,
    edit: divisionProfile.edit,
    command: divisionProfile.command,
    mcp: divisionProfile.mcp,
  };

  // Upgrade command permission if systemPrompt references code execution
  if (!permission.command && shouldUpgradeCommandPermission(agent.definition.systemPrompt)) {
    permission.command = true;
  }

  return permission;
}

// ─────────────────────────────────────────────
// Single File Parsing
// ─────────────────────────────────────────────

/**
 * Parses a single markdown agent file into an ImportedAgent.
 *
 * @param filePath - Relative path of the file within the agent repository
 * @param markdownContent - Raw file content
 * @returns The parsed ImportedAgent
 */
export function parseAgentFile(filePath: string, markdownContent: string): ImportedAgent {
  const { frontmatter, body } = parseFrontmatter(markdownContent);

  // Extract name from frontmatter, or derive from filename
  const name = frontmatter['name'] || deriveNameFromPath(filePath);
  const description = frontmatter['description'] || frontmatter['specialty'] || '';
  const color = frontmatter['color'];

  // Map color to emoji, or use explicit emoji from frontmatter
  const emoji = frontmatter['emoji'] || mapColorToEmoji(color);

  // Generate ID from name
  const id = generateId(name);

  // Extract sections and build system prompt
  const sections = extractSections(body);
  const systemPrompt = buildSystemPrompt(sections, body);

  // Determine department from directory path, or use frontmatter department
  const department = frontmatter['department'] || resolveDepartment(filePath);

  // Build the AgentDefinition
  const definition: AgentDefinition = {
    id,
    name,
    emoji,
    department,
    specialty: description || extractSpecialty(sections, body),
    systemPrompt,
  };

  return {
    definition,
    sourceFile: filePath,
    division: department,
    rawFrontmatter: frontmatter,
  };
}

// ─────────────────────────────────────────────
// Directory Import
// ─────────────────────────────────────────────

/**
 * Imports all markdown agent files from a directory tree.
 *
 * @param rootPath - Absolute path to the root of the agent repository
 * @returns ImportResult with all successfully imported agents and any errors
 */
export async function importDirectory(rootPath: string): Promise<ImportResult> {
  const imported: ImportedAgent[] = [];
  const errors: { file: string; reason: string }[] = [];
  const divisionsSet = new Set<string>();

  const mdFiles = await findMarkdownFiles(rootPath);

  for (const absolutePath of mdFiles) {
    const relativePath = relative(rootPath, absolutePath);
    try {
      const content = await readFile(absolutePath, 'utf-8');
      const agent = parseAgentFile(relativePath, content);
      imported.push(agent);
      divisionsSet.add(agent.division);
    } catch (err) {
      errors.push({
        file: relativePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    imported,
    errors,
    divisions: Array.from(divisionsSet).sort(),
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Recursively finds all .md files in a directory tree.
 */
async function findMarkdownFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dirPath);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    try {
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        // Skip hidden directories and common non-agent directories
        if (!entry.startsWith('.') && entry !== 'node_modules') {
          const nested = await findMarkdownFiles(fullPath);
          results.push(...nested);
        }
      } else if (stats.isFile() && entry.endsWith('.md') && entry !== 'README.md') {
        results.push(fullPath);
      }
    } catch {
      // Skip files we can't stat
    }
  }

  return results;
}

/**
 * Derives a human-readable name from a file path when no frontmatter name exists.
 * e.g., "engineering/frontend-developer.md" → "Frontend Developer"
 */
function deriveNameFromPath(filePath: string): string {
  const filename = filePath.split('/').pop() || 'unnamed';
  const baseName = filename.replace(/\.md$/, '');

  return baseName
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || 'Unnamed Agent';
}

/**
 * Resolves the department for an agent based on its file path.
 * Falls back to 'Specialized' if the directory cannot be mapped or registered.
 */
function resolveDepartment(filePath: string): string {
  const directory = dirname(filePath);
  const mapped = mapDirectoryToDepartment(directory);

  // mapDirectoryToDepartment already returns 'Specialized' for unmapped paths
  // Attempt to register the department if it's new
  const registered = registerDepartment(mapped);
  if (!registered) {
    return 'Specialized';
  }
  return mapped;
}

/**
 * Extracts a specialty description from sections or body content.
 * Uses the first sentence of the Identity or Core Mission section if available.
 */
function extractSpecialty(sections: Map<string, string>, body: string): string {
  // Try Identity section first
  const identity = sections.get('Identity') || sections.get('identity');
  if (identity) {
    const firstSentence = identity.split(/[.!?]\s/)[0];
    if (firstSentence && firstSentence.length > 10) {
      return firstSentence.trim() + '.';
    }
  }

  // Try Core Mission
  const mission = sections.get('Core Mission') || sections.get('core mission');
  if (mission) {
    const firstSentence = mission.split(/[.!?]\s/)[0];
    if (firstSentence && firstSentence.length > 10) {
      return firstSentence.trim() + '.';
    }
  }

  // Fall back to first non-empty line of body
  const firstLine = body.split('\n').find((line) => line.trim().length > 10);
  return firstLine?.trim() || 'Specialized AI agent.';
}
