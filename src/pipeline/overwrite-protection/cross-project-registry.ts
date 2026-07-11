/**
 * Cross-Project Registry
 *
 * Maintains a shared registry of sibling projects at `../.neuronest-workspace/registry.json`.
 * Enables cross-project awareness by tracking each project's manifest, interfaces, and
 * dependency relationships. Provides formatted context injection for system prompts
 * within an 8000-character budget.
 *
 * Requirements: 7.1, 7.2, 7.5, 7.6, 7.8
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CrossProjectRegistry, RegisteredProject } from './types';
import { deriveProjectManifest } from './project-manifest';

/** Maximum characters allowed for the formatted registry prompt */
const MAX_REGISTRY_CHARS = 8000;

/** Directory name for the workspace-level registry */
const REGISTRY_DIR_NAME = '.neuronest-workspace';

/** Registry file name */
const REGISTRY_FILE_NAME = 'registry.json';

/**
 * Computes the path to the registry file relative to the project directory.
 * The registry lives one level above the project dir in a shared workspace folder.
 */
function getRegistryPath(projectDir: string): string {
  return path.resolve(projectDir, '..', REGISTRY_DIR_NAME, REGISTRY_FILE_NAME);
}

/**
 * Reads the cross-project registry from `../.neuronest-workspace/registry.json`.
 * Returns null if the file doesn't exist or is corrupted/unreadable.
 */
export function loadRegistry(projectDir: string): CrossProjectRegistry | null {
  const registryPath = getRegistryPath(projectDir);

  if (!fs.existsSync(registryPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Basic structural validation
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.version !== 'number' ||
      !Array.isArray(parsed.projects)
    ) {
      console.warn(
        `[overwrite-protection] Registry file at ${registryPath} has invalid structure, ignoring.`
      );
      return null;
    }

    return parsed as CrossProjectRegistry;
  } catch (error) {
    console.warn(
      `[overwrite-protection] Failed to read registry at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Writes the cross-project registry, creating the `../.neuronest-workspace/` directory
 * if it doesn't exist.
 */
export function saveRegistry(projectDir: string, registry: CrossProjectRegistry): void {
  const registryPath = getRegistryPath(projectDir);
  const registryDir = path.dirname(registryPath);

  try {
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true });
    }

    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (error) {
    console.warn(
      `[overwrite-protection] Failed to save registry at ${registryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Registers a new project in the cross-project registry.
 * Scans the project's manifest and public interfaces, then persists the updated registry.
 */
export function registerProject(
  projectDir: string,
  newProjectDir: string
): RegisteredProject {
  const manifest = deriveProjectManifest(newProjectDir);

  // Build the stack string from language + framework
  const stack = manifest.framework
    ? `${manifest.primaryLanguage}/${manifest.framework}`
    : manifest.primaryLanguage;

  // Scan for exported interfaces
  const exportedInterfaces = scanExportedInterfaces(newProjectDir);

  const entry: RegisteredProject = {
    name: manifest.name,
    directory: newProjectDir,
    stack,
    purpose: manifest.purpose,
    exportedInterfaces,
    dependencies: [],
    lastUpdated: new Date().toISOString(),
  };

  // Load or create registry, append the new project, and save
  const existing = loadRegistry(projectDir) || { version: 1, projects: [] };

  // Remove any existing entry for the same directory (update case)
  existing.projects = existing.projects.filter(
    (p) => p.directory !== newProjectDir
  );

  existing.projects.push(entry);
  saveRegistry(projectDir, existing);

  return entry;
}

/**
 * Formats the cross-project registry for injection into the system prompt.
 * Filters out the current project, prioritizes dependency-linked projects,
 * and respects the 8000-character budget.
 */
export function formatRegistryForPrompt(
  registry: CrossProjectRegistry,
  currentProject: string
): string {
  // Filter out the current project
  const otherProjects = registry.projects.filter(
    (p) => p.directory !== currentProject && p.name !== currentProject
  );

  if (otherProjects.length === 0) {
    return '';
  }

  // Sort: dependency-linked projects first, then by lastUpdated (most recent first)
  const sorted = sortProjectsByRelevance(otherProjects, currentProject, registry);

  let result = '## Related Projects\n\n';
  let charCount = result.length;

  for (const project of sorted) {
    const entry = formatProjectEntry(project);

    // Check if adding this entry would exceed the budget
    if (charCount + entry.length > MAX_REGISTRY_CHARS) {
      break;
    }

    result += entry;
    charCount += entry.length;
  }

  return result;
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Sorts projects by relevance: dependency-linked first, then by recency.
 */
function sortProjectsByRelevance(
  projects: RegisteredProject[],
  currentProject: string,
  registry: CrossProjectRegistry
): RegisteredProject[] {
  // Find the current project entry to check its dependencies
  const currentEntry = registry.projects.find(
    (p) => p.directory === currentProject || p.name === currentProject
  );
  const currentDeps = new Set(currentEntry?.dependencies || []);

  return [...projects].sort((a, b) => {
    const aIsLinked = currentDeps.has(a.name) || a.dependencies.includes(currentEntry?.name || '');
    const bIsLinked = currentDeps.has(b.name) || b.dependencies.includes(currentEntry?.name || '');

    // Dependency-linked projects come first
    if (aIsLinked && !bIsLinked) return -1;
    if (!aIsLinked && bIsLinked) return 1;

    // Then sort by lastUpdated (most recent first)
    return b.lastUpdated.localeCompare(a.lastUpdated);
  });
}

/**
 * Formats a single project entry as a markdown section.
 */
function formatProjectEntry(project: RegisteredProject): string {
  let entry = `### ${project.name}\n`;
  entry += `- **Stack**: ${project.stack}\n`;
  entry += `- **Purpose**: ${project.purpose}\n`;

  if (project.exportedInterfaces.length > 0) {
    entry += `- **Interfaces**:\n`;
    for (const iface of project.exportedInterfaces) {
      entry += `  - \`${iface}\`\n`;
    }
  }

  if (project.dependencies.length > 0) {
    entry += `- **Depends on**: ${project.dependencies.join(', ')}\n`;
  }

  entry += '\n';
  return entry;
}

/**
 * Scans a project directory for exported interfaces.
 * Looks for:
 * - Express/Fastify route definitions: router.get('/path', ...) or app.post('/path', ...)
 * - Exported TypeScript interfaces: export interface X
 * - Exported types: export type X
 */
function scanExportedInterfaces(projectDir: string): string[] {
  const interfaces: string[] = [];

  try {
    // Scan src/ directory for route and type files
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      scanDirectoryForInterfaces(srcDir, interfaces);
    }

    // Also scan root-level route/type files
    scanDirectoryForInterfaces(projectDir, interfaces, false);
  } catch {
    // Ignore scan errors — return whatever we found
  }

  // Limit the number of interfaces to prevent overly large registry entries
  return interfaces.slice(0, 50);
}

/**
 * Recursively scans a directory for interface/route definitions.
 */
function scanDirectoryForInterfaces(
  dir: string,
  interfaces: string[],
  recursive: boolean = true
): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && recursive) {
        // Skip node_modules, dist, and hidden directories
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        scanDirectoryForInterfaces(fullPath, interfaces, true);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        extractInterfacesFromFile(fullPath, interfaces);
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Checks if a file name is a source file worth scanning.
 */
function isSourceFile(fileName: string): boolean {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
  return extensions.some((ext) => fileName.endsWith(ext));
}

/**
 * Extracts exported interfaces and route definitions from a file.
 */
function extractInterfacesFromFile(filePath: string, interfaces: string[]): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract exported interfaces: export interface X
    const interfaceRegex = /export\s+interface\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = interfaceRegex.exec(content)) !== null) {
      interfaces.push(`interface ${match[1]}`);
    }

    // Extract exported types: export type X
    const typeRegex = /export\s+type\s+(\w+)/g;
    while ((match = typeRegex.exec(content)) !== null) {
      interfaces.push(`type ${match[1]}`);
    }

    // Extract route definitions: router.get('/path', ...) or app.post('/path', ...)
    const routeRegex = /(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1];
      const routePath = match[2];
      if (method && routePath) {
        interfaces.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
  } catch {
    // Ignore file read errors
  }
}
