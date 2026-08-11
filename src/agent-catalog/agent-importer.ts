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

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentDefinition, ToolPermission } from '../agents/agent-registry';
import {
  parseAgentFileDocument,
  REQUIRED_AGENT_SECTION_NAMES,
} from './agent-file-parser';
import {
  discoverCatalog,
  type CatalogManifest,
  type CatalogManifestEntry,
} from './catalog-discovery';
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
const SYSTEM_PROMPT_SECTIONS = REQUIRED_AGENT_SECTION_NAMES;

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
export function parseAgentFile(
  filePath: string,
  markdownContent: string | Uint8Array,
): ImportedAgent {
  const parseEvidence = parseAgentFileDocument(markdownContent);
  const frontmatter = { ...parseEvidence.frontmatter.values };
  const body = parseEvidence.body;
  const sections = new Map<string, string>();
  for (const sectionName of REQUIRED_AGENT_SECTION_NAMES) {
    const content = parseEvidence.sectionContents[sectionName];
    if (content !== null) {
      sections.set(sectionName, content);
    }
  }

  // Extract name from frontmatter, or derive from filename
  const name = frontmatter['name'] || deriveNameFromPath(filePath);
  const description = frontmatter['description'] || frontmatter['specialty'] || '';
  const color = frontmatter['color'];

  // Map color to emoji, or use explicit emoji from frontmatter
  const emoji = frontmatter['emoji'] || mapColorToEmoji(color);

  // Generate ID from name
  const id = generateId(name);

  // A complete recovered prompt always wins. The partial/body fallback remains
  // solely for backward-compatible callers and is explicitly marked failed by
  // parseEvidence when all six required sections were not recoverable.
  const systemPrompt = parseEvidence.systemPrompt ?? buildSystemPrompt(sections, body);

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
    parseEvidence,
  };
}

// ─────────────────────────────────────────────
// Directory Import
// ─────────────────────────────────────────────

/**
 * Imports every entry from an immutable catalog manifest.
 *
 * This explicit API lets validators and importers share one captured source
 * population rather than independently traversing the filesystem.
 */
async function importManifestEntries(
  entries: readonly Pick<CatalogManifestEntry, 'sourcePath' | 'absolutePath'>[],
): Promise<ImportResult> {
  const imported: ImportedAgent[] = [];
  const errors: { file: string; reason: string }[] = [];
  const divisionsSet = new Set<string>();

  for (const entry of entries) {
    try {
      // Read bytes so exact frontmatter identity is retained rather than
      // reconstructed after a text-only filesystem read.
      const content = await readFile(entry.absolutePath);
      const agent = parseAgentFile(entry.sourcePath, content);
      imported.push(agent);
      divisionsSet.add(agent.division);
    } catch (err) {
      errors.push({
        file: entry.sourcePath,
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

/**
 * Imports explicit manifest paths without performing another discovery pass.
 * The caller owns path capture/validation, normally via discoverCatalog().
 */
export async function importCatalogPaths(
  entries: readonly Pick<CatalogManifestEntry, 'sourcePath' | 'absolutePath'>[],
): Promise<ImportResult> {
  return importManifestEntries(entries);
}

export async function importCatalogManifest(manifest: CatalogManifest): Promise<ImportResult> {
  return importManifestEntries(manifest.entries);
}

/**
 * Imports all markdown agent files from a directory tree.
 *
 * Kept as the backward-compatible importer entry point. Source membership is
 * delegated to the shared catalog manifest discoverer.
 *
 * @param rootPath - Path to the root of the agent repository
 * @returns ImportResult with all successfully imported agents and any errors
 */
export async function importDirectory(rootPath: string): Promise<ImportResult> {
  const manifest = await discoverCatalog(rootPath);
  return importCatalogManifest(manifest);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

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
