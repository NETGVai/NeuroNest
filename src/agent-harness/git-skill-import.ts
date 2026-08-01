/**
 * Git Skill Import — Clone git repositories and import skill definitions.
 *
 * Supports:
 * - Cloning git repositories to a temporary directory
 * - Scanning for skill files (.md, .yaml, .json) with required metadata fields
 * - Recording source URL, commit SHA, and import timestamp in skill metadata
 * - On re-import: compare commit SHA, update only changed skills
 * - Return list of imported/updated skills with provenance
 *
 * Uses child_process for git operations.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 11.4, 11.5, 11.6
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScopeDescriptor } from './types';

// ─── Types ──────────────────────────────────────────────────────

/** Provenance metadata for an imported skill. */
export interface SkillProvenance {
  origin: 'git';
  repoUrl: string;
  commitSha: string;
  importTimestamp: number;
  filePath: string;
  versionHistory: SkillVersionEntry[];
  grantChain: string[];
}

/** A single version history entry for provenance tracking. */
export interface SkillVersionEntry {
  commitSha: string;
  importedAt: number;
  action: 'created' | 'updated' | 'unchanged';
}

/** A discovered skill file from a git repository. */
export interface DiscoveredSkill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  extension: string;
  metadata: Record<string, unknown>;
}

/** Result of a git skill import operation. */
export interface GitImportResult {
  success: boolean;
  repoUrl: string;
  commitSha: string;
  importedSkills: ImportedSkillInfo[];
  updatedSkills: ImportedSkillInfo[];
  unchangedSkills: ImportedSkillInfo[];
  errors: GitImportError[];
}

/** Information about a single imported/updated skill. */
export interface ImportedSkillInfo {
  name: string;
  filePath: string;
  action: 'created' | 'updated' | 'unchanged';
  provenance: SkillProvenance;
}

/** An error during git import. */
export interface GitImportError {
  file?: string;
  reason: string;
}

/** Options for the git import operation. */
export interface GitImportOptions {
  /** Existing provenance records keyed by skill file path for re-import comparison. */
  existingProvenance?: Map<string, SkillProvenance>;
  /** Target scope for imported skills. */
  targetScope?: ScopeDescriptor;
  /** Depth for git clone (default: 1 for shallow clone). */
  cloneDepth?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** File extensions recognized as potential skill files. */
const SKILL_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json']);

/** Required metadata fields that identify a file as a skill definition. */
const REQUIRED_SKILL_FIELDS = ['name', 'description'];

/** Content field alternatives: at least one must be present. */
const CONTENT_FIELDS = ['content', 'entrypoint'];

const TEMP_DIR_PREFIX = 'neuronest-git-skill-import-';

// ─── Git Operations ─────────────────────────────────────────────

/**
 * Clone a git repository to a temporary directory.
 * Uses shallow clone (depth=1) by default for efficiency.
 *
 * @returns Path to the cloned repository directory.
 * @throws Error with descriptive message including URL and failure reason.
 */
function cloneRepository(repoUrl: string, depth: number = 1): string {
  const tempDir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));

  try {
    const depthArg = depth > 0 ? `--depth ${depth}` : '';
    execSync(`git clone ${depthArg} -- "${repoUrl}" "${tempDir}"`, {
      stdio: 'pipe',
      timeout: 60_000, // 60 second timeout for clone
      encoding: 'utf-8',
    });
  } catch (err: unknown) {
    // Clean up temp dir on failure
    cleanupTempDir(tempDir);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to clone repository '${repoUrl}': ${message}`,
    );
  }

  return tempDir;
}

/**
 * Get the current HEAD commit SHA from a local repository.
 */
function getCommitSha(repoPath: string): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return sha.trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Safely remove a temporary directory.
 */
function cleanupTempDir(dirPath: string): void {
  try {
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup — don't throw
  }
}

// ─── Skill File Discovery ───────────────────────────────────────

/**
 * Recursively scan a directory for skill files.
 * Skill files must have a recognized extension (.md, .yaml, .yml, .json)
 * and contain required metadata fields (name, description, and content or entrypoint).
 */
function scanForSkillFiles(rootPath: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  walkDirectory(rootPath, rootPath, skills);
  return skills;
}

/**
 * Recursively walk a directory, discovering skill files.
 */
function walkDirectory(currentPath: string, rootPath: string, results: DiscoveredSkill[]): void {
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return; // Skip unreadable directories
  }

  for (const entry of entries) {
    // Skip hidden directories and common non-skill directories
    if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__') {
      continue;
    }

    const fullPath = join(currentPath, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // Skip unreadable files
    }

    if (stat.isDirectory()) {
      walkDirectory(fullPath, rootPath, results);
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (SKILL_EXTENSIONS.has(ext)) {
        const skill = tryParseSkillFile(fullPath, rootPath, ext);
        if (skill) {
          results.push(skill);
        }
      }
    }
  }
}

/**
 * Attempt to parse a file as a skill definition.
 * Returns null if the file doesn't contain required skill metadata.
 */
function tryParseSkillFile(
  filePath: string,
  rootPath: string,
  extension: string,
): DiscoveredSkill | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const relativePath = filePath.slice(rootPath.length + 1);

  if (extension === '.json') {
    return tryParseJsonSkill(content, relativePath, extension);
  } else if (extension === '.yaml' || extension === '.yml') {
    return tryParseYamlSkill(content, relativePath, extension);
  } else if (extension === '.md') {
    return tryParseMarkdownSkill(content, relativePath, extension);
  }

  return null;
}

/**
 * Parse a JSON file as a skill definition.
 */
function tryParseJsonSkill(
  content: string,
  filePath: string,
  extension: string,
): DiscoveredSkill | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!hasRequiredFields(parsed)) {
    return null;
  }

  return {
    name: String(parsed['name']),
    description: String(parsed['description']),
    content: parsed['content'] ? String(parsed['content']) : content,
    filePath,
    extension,
    metadata: parsed,
  };
}

/**
 * Parse a YAML file as a skill definition.
 * Uses a simple key-value parser for basic YAML (no external dependency).
 */
function tryParseYamlSkill(
  content: string,
  filePath: string,
  extension: string,
): DiscoveredSkill | null {
  const parsed = simpleYamlParse(content);
  if (!parsed || !hasRequiredFields(parsed)) {
    return null;
  }

  return {
    name: String(parsed['name']),
    description: String(parsed['description']),
    content: parsed['content'] ? String(parsed['content']) : content,
    filePath,
    extension,
    metadata: parsed,
  };
}

/**
 * Parse a Markdown file as a skill definition.
 * Looks for YAML frontmatter between --- delimiters containing required fields.
 */
function tryParseMarkdownSkill(
  content: string,
  filePath: string,
  extension: string,
): DiscoveredSkill | null {
  // Check for YAML frontmatter
  if (!content.startsWith('---')) {
    // If no frontmatter, try to extract name from first heading and use filename
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading && heading[1]) {
      return {
        name: heading[1].trim(),
        description: `Skill from ${basename(filePath)}`,
        content,
        filePath,
        extension,
        metadata: { name: heading[1].trim(), description: `Skill from ${basename(filePath)}`, content },
      };
    }
    return null;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return null;
  }

  const frontmatter = content.slice(3, endIndex).trim();
  const parsed = simpleYamlParse(frontmatter);
  if (!parsed || !hasRequiredFields(parsed)) {
    return null;
  }

  const bodyContent = content.slice(endIndex + 3).trim();

  return {
    name: String(parsed['name']),
    description: String(parsed['description']),
    content: parsed['content'] ? String(parsed['content']) : bodyContent || content,
    filePath,
    extension,
    metadata: { ...parsed, content: bodyContent || content },
  };
}

/**
 * Simple YAML key-value parser (handles top-level scalar fields only).
 * No external dependencies required.
 */
function simpleYamlParse(text: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (match && match[1] && match[2] !== undefined) {
      const key = match[1];
      let value: unknown = match[2].trim();
      // Remove quotes if present
      if (
        (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) ||
        (typeof value === 'string' && value.startsWith("'") && value.endsWith("'"))
      ) {
        value = (value as string).slice(1, -1);
      }
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Check if parsed data has the required skill fields.
 */
function hasRequiredFields(data: Record<string, unknown>): boolean {
  // Must have name and description
  for (const field of REQUIRED_SKILL_FIELDS) {
    if (!data[field] || String(data[field]).trim() === '') {
      return false;
    }
  }
  // Must have at least one content field (content or entrypoint)
  const hasContent = CONTENT_FIELDS.some(
    (field) => data[field] && String(data[field]).trim() !== '',
  );

  // For markdown files, the body serves as content even without explicit field
  if (!hasContent && !data['_markdownBody']) {
    return false;
  }

  return true;
}

// ─── Main Import Logic ──────────────────────────────────────────

/**
 * Import skills from a git repository.
 *
 * 1. Clone the repository to a temporary directory
 * 2. Scan for skill files (.md, .yaml, .json)
 * 3. Record source URL, commit SHA, and import timestamp
 * 4. On re-import: compare commit SHA, update only changed skills
 * 5. Return list of imported/updated skills with provenance
 *
 * @param repoUrl - Git repository URL to clone.
 * @param options - Import options including existing provenance for re-import detection.
 * @returns Import result with lists of imported, updated, and unchanged skills.
 */
export function importFromGit(
  repoUrl: string,
  options: GitImportOptions = {},
): GitImportResult {
  const { existingProvenance, cloneDepth = 1 } = options;

  // Validate URL
  if (!repoUrl || repoUrl.trim() === '') {
    return {
      success: false,
      repoUrl,
      commitSha: '',
      importedSkills: [],
      updatedSkills: [],
      unchangedSkills: [],
      errors: [{ reason: 'Repository URL is required.' }],
    };
  }

  // Clone repository
  let repoPath: string;
  try {
    repoPath = cloneRepository(repoUrl, cloneDepth);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      repoUrl,
      commitSha: '',
      importedSkills: [],
      updatedSkills: [],
      unchangedSkills: [],
      errors: [{ reason: message }],
    };
  }

  try {
    // Get commit SHA
    const commitSha = getCommitSha(repoPath);
    const importTimestamp = Date.now();

    // Scan for skill files
    const discoveredSkills = scanForSkillFiles(repoPath);

    const importedSkills: ImportedSkillInfo[] = [];
    const updatedSkills: ImportedSkillInfo[] = [];
    const unchangedSkills: ImportedSkillInfo[] = [];
    const errors: GitImportError[] = [];

    for (const skill of discoveredSkills) {
      try {
        const existingProv = existingProvenance?.get(skill.filePath);

        let action: 'created' | 'updated' | 'unchanged';
        if (!existingProv) {
          // New skill — first import
          action = 'created';
        } else if (existingProv.commitSha === commitSha) {
          // Same commit SHA — no changes
          action = 'unchanged';
        } else {
          // Different commit SHA — skill has been updated
          action = 'updated';
        }

        // Build version history
        const versionHistory: SkillVersionEntry[] = existingProv?.versionHistory
          ? [...existingProv.versionHistory]
          : [];

        if (action !== 'unchanged') {
          versionHistory.push({
            commitSha,
            importedAt: importTimestamp,
            action,
          });
        }

        const provenance: SkillProvenance = {
          origin: 'git',
          repoUrl,
          commitSha,
          importTimestamp,
          filePath: skill.filePath,
          versionHistory,
          grantChain: existingProv?.grantChain ?? [],
        };

        const skillInfo: ImportedSkillInfo = {
          name: skill.name,
          filePath: skill.filePath,
          action,
          provenance,
        };

        switch (action) {
          case 'created':
            importedSkills.push(skillInfo);
            break;
          case 'updated':
            updatedSkills.push(skillInfo);
            break;
          case 'unchanged':
            unchangedSkills.push(skillInfo);
            break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ file: skill.filePath, reason: message });
      }
    }

    return {
      success: true,
      repoUrl,
      commitSha,
      importedSkills,
      updatedSkills,
      unchangedSkills,
      errors,
    };
  } finally {
    // Always clean up the temporary directory
    cleanupTempDir(repoPath);
  }
}

// ─── Exported Utilities ─────────────────────────────────────────

export {
  cloneRepository,
  getCommitSha,
  cleanupTempDir,
  scanForSkillFiles,
  hasRequiredFields,
  simpleYamlParse,
  SKILL_EXTENSIONS,
};
