/**
 * Agent Upgrade Generator
 *
 * Dynamically discovers all Agent_Files, generates specialty-specific upgraded
 * bodies with six required sections, validates the complete staged catalog, and
 * applies source changes atomically.
 *
 * Requirements: 1.3–1.17, 2.1–7.15, 8.1–8.4
 */

import { readFile, writeFile } from 'node:fs/promises';

import { discoverCatalog } from './catalog-discovery';
import { parseAgentFileDocument } from './agent-file-parser';
import {
  applyStagedUpgrades,
  createUpgradeCandidate,
  type UpgradeCandidate,
} from './staged-upgrade-application';
import { generateAgentBody } from './agent-body-generator';

export interface UpgradeRunResult {
  readonly status: 'applied' | 'aborted' | 'error';
  readonly discoveredCount: number;
  readonly appliedCount: number;
  readonly message: string;
  readonly details?: readonly string[];
}

/**
 * Runs the complete staged upgrade pipeline:
 * 1. Dynamically discovers all Agent_Files
 * 2. Reads every source and parses frontmatter
 * 3. Generates specialty-specific body content for each source
 * 4. Creates upgrade candidates preserving frontmatter
 * 5. Validates the complete staged catalog
 * 6. Applies all source changes atomically
 */
export async function runStagedUpgrade(rootPath: string): Promise<UpgradeRunResult> {
  // Step 1: Dynamic discovery
  const manifest = await discoverCatalog(rootPath);
  if (manifest.entries.length === 0) {
    return {
      status: 'error',
      discoveredCount: 0,
      appliedCount: 0,
      message: 'EMPTY_CATALOG: No agent files discovered',
    };
  }

  // Step 2: Read all original sources
  const originalSources = new Map<string, Uint8Array>();
  for (const entry of manifest.entries) {
    const source = await readFile(entry.absolutePath);
    originalSources.set(entry.sourcePath, Uint8Array.from(source));
  }

  // Step 3+4: Generate upgrade candidates
  const candidates: UpgradeCandidate[] = [];
  const errors: string[] = [];

  for (const entry of manifest.entries) {
    const source = originalSources.get(entry.sourcePath)!;
    const parseResult = parseAgentFileDocument(source);

    if (!parseResult.frontmatter.present || !parseResult.frontmatter.parseable) {
      errors.push(`${entry.sourcePath}: unparseable frontmatter`);
      continue;
    }

    const frontmatter = parseResult.frontmatter.values;
    const name = frontmatter['name'] || entry.sourcePath;
    const department = frontmatter['department'] || 'Specialized';
    const specialty = frontmatter['specialty'] || '';

    // Generate the new body with six required sections
    const newBody = generateAgentBody({ name, department, specialty });

    const candidate = createUpgradeCandidate(
      entry.sourcePath,
      source,
      newBody,
    );

    if (!candidate) {
      errors.push(`${entry.sourcePath}: failed to create upgrade candidate`);
      continue;
    }

    candidates.push(candidate);
  }

  if (errors.length > 0) {
    return {
      status: 'error',
      discoveredCount: manifest.entries.length,
      appliedCount: 0,
      message: `Failed to create candidates for ${errors.length} files`,
      details: errors,
    };
  }

  // Step 5+6: Validate and apply staged upgrades
  const result = applyStagedUpgrades({
    manifest,
    candidates,
  });

  if (result.status === 'aborted') {
    return {
      status: 'aborted',
      discoveredCount: manifest.entries.length,
      appliedCount: 0,
      message: `Staged validation failed: ${result.reasons.length} issues`,
      details: result.reasons.map((r) => `${r.sourcePath ?? 'catalog'}: ${r.message}`),
    };
  }

  // Step 7: Write applied upgrades to disk
  for (const applied of result.applied) {
    const entry = manifest.entries.find((e) => e.sourcePath === applied.sourcePath);
    if (entry) {
      await writeFile(entry.absolutePath, applied.outputBytes);
    }
  }

  return {
    status: 'applied',
    discoveredCount: manifest.entries.length,
    appliedCount: result.applied.length,
    message: `Successfully upgraded ${result.applied.length} agent files`,
  };
}
