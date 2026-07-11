/**
 * Project Identity Anchor
 *
 * Builds the complete identity anchor for system prompt injection.
 * Combines project identity (from rules.md override, manifest, or directory heuristics)
 * with cross-project registry context into injectable markdown sections.
 *
 * Priority: rules.md override > manifest-derived > directory heuristic
 *
 * Requirements: 1.1, 1.3, 1.4, 7.3, 7.4
 */

import * as path from 'node:path';
import type { IdentityAnchorResult } from './types';
import { parseProjectIdentityOverride } from './config-parser';
import { deriveProjectManifest } from './project-manifest';
import { loadRegistry, formatRegistryForPrompt } from './cross-project-registry';

/** The scope directive appended to every identity section */
const SCOPE_DIRECTIVE =
  '> You are working within the scope of this project. Do not scaffold, overwrite, or replace the project with a different application unless the user explicitly confirms.';

/**
 * Builds the complete identity anchor for system prompt injection.
 * Priority: rules.md override > manifest-derived > directory heuristic
 *
 * @param projectDir - Absolute path to the project root directory
 * @param rulesContent - Full content of the `.neuronest/rules.md` file, or null
 * @returns IdentityAnchorResult with section, relatedProjectsSection, and source
 */
export function buildIdentityAnchor(
  projectDir: string,
  rulesContent: string | null
): IdentityAnchorResult {
  // Step 1: Determine identity source (priority order)
  const { section, source } = buildIdentitySection(projectDir, rulesContent);

  // Step 2: Build related projects section from Cross_Project_Registry
  const relatedProjectsSection = buildRelatedProjectsSection(projectDir);

  return {
    section,
    relatedProjectsSection,
    source,
  };
}

/**
 * Builds the `## Project Identity` section using the priority chain:
 * 1. rules.md override
 * 2. manifest-derived
 * 3. directory heuristic
 */
function buildIdentitySection(
  projectDir: string,
  rulesContent: string | null
): { section: string; source: IdentityAnchorResult['source'] } {
  // Priority 1: rules.md override
  const overrideContent = parseProjectIdentityOverride(rulesContent);
  if (overrideContent) {
    const section = `## Project Identity\n${overrideContent}\n\n${SCOPE_DIRECTIVE}`;
    return { section, source: 'rules.md' };
  }

  // Priority 2 & 3: manifest-derived or heuristic
  const manifest = deriveProjectManifest(projectDir);

  // Determine if this is a heuristic fallback:
  // If the manifest name is just the directory basename, it likely came from heuristics
  const dirName = path.basename(projectDir);
  const isHeuristic =
    manifest.name === dirName &&
    manifest.framework === null &&
    manifest.dependencies.length === 0;

  const languageFramework = manifest.framework
    ? `${manifest.primaryLanguage}/${manifest.framework}`
    : manifest.primaryLanguage;

  const section = [
    '## Project Identity',
    `- **Name**: ${manifest.name}`,
    `- **Language/Framework**: ${languageFramework}`,
    `- **Purpose**: ${manifest.purpose}`,
    '',
    SCOPE_DIRECTIVE,
  ].join('\n');

  const source: IdentityAnchorResult['source'] = isHeuristic ? 'heuristic' : 'manifest';

  return { section, source };
}

/**
 * Builds the `## Related Projects` section from the Cross_Project_Registry.
 * Returns an empty string if no registry exists or it contains no other projects.
 */
function buildRelatedProjectsSection(projectDir: string): string {
  const registry = loadRegistry(projectDir);

  if (!registry || registry.projects.length === 0) {
    return '';
  }

  const formatted = formatRegistryForPrompt(registry, projectDir);
  return formatted;
}
