// File: packages/neuronest-cli/src/sync/scanner.ts
//
// Read-only skill metadata scanner for the Typed Skill Client (Item 1).
// Walks ~/.kiro/skills/ and ${workspaceRoot}/.kiro/skills/, reading each
// skill's manifest (skill.json or package.json#neuronest) using only
// fs.readFile, fs.stat, and fs.readdir. Never executes, requires,
// imports, evaluates, or spawns against any discovered skill payload.
//
// Validates: Requirements 1.1, 1.6, 1.7, 1.9.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  SkillId,
  SkillMetadata,
  SkillSource,
  SkillTypeCacheEntry,
  SyncCliOptions,
  SyncWarning,
} from './types.js';

/** Result of a successful scan. */
export interface ScanResult {
  entries: SkillTypeCacheEntry[];
  warnings: SyncWarning[];
}

/** Manifest file names recognized by the scanner, in priority order. */
const SKILL_MANIFEST_FILENAME = 'skill.json';
const PACKAGE_MANIFEST_FILENAME = 'package.json';

/** Phase 3 Skill_Registry-compatible identifier pattern. */
const SKILL_ID_PATTERN = /^[a-z0-9-]+$/;

/** Default user skills root: ~/.kiro/skills/ */
function defaultUserSkillsDir(): string {
  return path.join(os.homedir(), '.kiro', 'skills');
}

/**
 * Scan installed skills under both skill roots and return a flat array
 * of normalized cache entries plus any warnings encountered.
 *
 * Resolution rules (Req 1.9): when the same `id` is registered under
 * both roots, the workspace-local definition wins and a
 * `workspace_override` warning is emitted naming both relative paths.
 *
 * Validation rules (Req 1.7): each manifest is validated against the
 * Phase 3 Skill_Registry-compatible schema; on failure a
 * `malformed_metadata` warning is emitted naming the relative path and
 * the validation detail, the offending skill is skipped, and scanning
 * continues.
 *
 * Hard execution invariants (Req 1.6): the scanner reads metadata files
 * only via `fs.readFile`, `fs.stat`, and `fs.readdir`. It never invokes
 * `require`, dynamic `import()`, `eval`, `new Function`,
 * `child_process.spawn`, `child_process.exec`, or any other code-loading
 * path against discovered skill content.
 *
 * Path normalization (Req 1.1): `relPath` is normalized to `~/<…>` form
 * for `source === 'user'` and to a workspace-relative form for
 * `source === 'workspace'`. No absolute host paths appear in the output.
 */
export async function scanSkills(opts: SyncCliOptions): Promise<ScanResult> {
  const warnings: SyncWarning[] = [];
  const userSkillsDir = opts.userSkillsDir ?? defaultUserSkillsDir();
  const workspaceSkillsDir = path.join(opts.workspaceRoot, '.kiro', 'skills');
  // Derive the home dir for `~/` normalization from the user-skills-dir
  // itself (its grandparent — i.e. the dir containing the `.kiro/`
  // folder). Defaulting to os.homedir() would break test isolation
  // because tests inject a fake userSkillsDir under tmpdir() but the
  // process's real home is unrelated. Production is unaffected because
  // the default userSkillsDir IS `${os.homedir()}/.kiro/skills/`, so
  // the grandparent is os.homedir().
  const homeDir = path.dirname(path.dirname(userSkillsDir));

  // Scan each root independently so a missing or unreadable root only
  // affects its own scan.
  const userEntries = await scanRoot(
    userSkillsDir,
    'user',
    homeDir,
    opts.workspaceRoot,
    warnings,
  );
  const workspaceEntries = await scanRoot(
    workspaceSkillsDir,
    'workspace',
    homeDir,
    opts.workspaceRoot,
    warnings,
  );

  // Resolve user/workspace collisions: workspace wins.
  const userById = new Map<SkillId, SkillTypeCacheEntry>();
  for (const e of userEntries) {
    userById.set(e.metadata.id, e);
  }

  const workspaceIds = new Set<SkillId>();
  const merged: SkillTypeCacheEntry[] = [];

  for (const ws of workspaceEntries) {
    const id = ws.metadata.id;
    workspaceIds.add(id);
    const userOverride = userById.get(id);
    if (userOverride) {
      warnings.push({
        kind: 'workspace_override',
        skillId: id,
        userRelPath: userOverride.relPath,
        workspaceRelPath: ws.relPath,
      });
    }
    merged.push(ws);
  }

  for (const usr of userEntries) {
    if (!workspaceIds.has(usr.metadata.id)) {
      merged.push(usr);
    }
  }

  return { entries: merged, warnings };
}

/**
 * Scan a single skill root. Returns one entry per validly parsed skill
 * found at top-level under the root. Malformed manifests emit warnings
 * and are skipped; sub-directories with no manifest are skipped
 * silently (they are not skill payloads).
 */
async function scanRoot(
  rootDir: string,
  source: SkillSource,
  homeDir: string,
  workspaceRoot: string,
  warnings: SyncWarning[],
): Promise<SkillTypeCacheEntry[]> {
  let rootStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    rootStat = await fs.stat(rootDir);
  } catch {
    // Root does not exist or is unreadable; not an error condition.
    return [];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  let childNames: string[];
  try {
    childNames = await fs.readdir(rootDir);
  } catch {
    return [];
  }

  // Sort so warning emission order is stable across hosts.
  childNames.sort();

  const out: SkillTypeCacheEntry[] = [];
  for (const childName of childNames) {
    // Skip dotfiles and dot-directories at the top level (.git, .DS_Store,
    // etc.). They are not skill payloads.
    if (childName.startsWith('.')) {
      continue;
    }

    const childPath = path.join(rootDir, childName);
    let childStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      childStat = await fs.stat(childPath);
    } catch {
      continue;
    }
    if (!childStat.isDirectory()) {
      continue;
    }

    const skillRelPath = relPathFor(source, childPath, homeDir, workspaceRoot);
    const parsed = await readSkillManifest(childPath);

    if (parsed.kind === 'no-manifest') {
      // No manifest at all — not a skill; skip silently.
      continue;
    }
    if (parsed.kind === 'error') {
      warnings.push({
        kind: 'malformed_metadata',
        skillRelPath,
        detail: parsed.detail,
      });
      continue;
    }

    out.push({
      id: parsed.metadata.id,
      source,
      relPath: skillRelPath,
      metadata: parsed.metadata,
    });
  }

  return out;
}

/**
 * Compute the normalized relative path for a skill directory.
 * Forward slashes are used regardless of host OS so that the cache
 * stays byte-stable across platforms (Req 1.5 / Req 1.1).
 */
function relPathFor(
  source: SkillSource,
  absSkillDir: string,
  homeDir: string,
  workspaceRoot: string,
): string {
  if (source === 'user') {
    const rel = path.relative(homeDir, absSkillDir);
    return `~/${toPosix(rel)}`;
  }
  const rel = path.relative(workspaceRoot, absSkillDir);
  return toPosix(rel);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Outcome of attempting to read a single skill's manifest. */
type ManifestReadResult =
  | { kind: 'ok'; metadata: SkillMetadata }
  | { kind: 'no-manifest' }
  | { kind: 'error'; detail: string };

/**
 * Read a skill's manifest from `skill.json` (preferred) or from the
 * `neuronest` field of `package.json`. Uses ONLY `fs.readFile` and
 * `fs.stat` — never imports, requires, evaluates, or spawns.
 */
async function readSkillManifest(skillDir: string): Promise<ManifestReadResult> {
  const skillJsonPath = path.join(skillDir, SKILL_MANIFEST_FILENAME);
  const packageJsonPath = path.join(skillDir, PACKAGE_MANIFEST_FILENAME);

  if (await isReadableFile(skillJsonPath)) {
    let raw: string;
    try {
      raw = await fs.readFile(skillJsonPath, 'utf8');
    } catch (err) {
      return {
        kind: 'error',
        detail: `${SKILL_MANIFEST_FILENAME}: read failed (${describeError(err)})`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        kind: 'error',
        detail: `${SKILL_MANIFEST_FILENAME}: invalid JSON (${describeError(err)})`,
      };
    }
    return validateManifest(parsed, SKILL_MANIFEST_FILENAME);
  }

  if (await isReadableFile(packageJsonPath)) {
    let raw: string;
    try {
      raw = await fs.readFile(packageJsonPath, 'utf8');
    } catch (err) {
      return {
        kind: 'error',
        detail: `${PACKAGE_MANIFEST_FILENAME}: read failed (${describeError(err)})`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        kind: 'error',
        detail: `${PACKAGE_MANIFEST_FILENAME}: invalid JSON (${describeError(err)})`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        kind: 'error',
        detail: `${PACKAGE_MANIFEST_FILENAME}: top-level value is not a JSON object`,
      };
    }
    if (!('neuronest' in parsed)) {
      // package.json with no neuronest field — treat as not-a-skill so
      // we don't warn on every npm package directory accidentally placed
      // under .kiro/skills/.
      return { kind: 'no-manifest' };
    }
    return validateManifest(
      (parsed as Record<string, unknown>)['neuronest'],
      `${PACKAGE_MANIFEST_FILENAME}#neuronest`,
    );
  }

  return { kind: 'no-manifest' };
}

/**
 * Validate the manifest object against the Phase 3 Skill_Registry-
 * compatible schema as scoped to Phase 4: required `id`, `version`,
 * `inputSchema`, `outputSchema`; optional `description`, `paramDocs`,
 * `deprecated`.
 */
function validateManifest(
  manifestObj: unknown,
  manifestSource: string,
): ManifestReadResult {
  if (!isPlainObject(manifestObj)) {
    return {
      kind: 'error',
      detail: `${manifestSource}: manifest is not a JSON object`,
    };
  }

  const obj = manifestObj;
  const id = obj['id'];
  const version = obj['version'];
  const inputSchema = obj['inputSchema'];
  const outputSchema = obj['outputSchema'];
  const description = obj['description'];
  const paramDocs = obj['paramDocs'];
  const deprecated = obj['deprecated'];

  if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) {
    return {
      kind: 'error',
      detail: `${manifestSource}: "id" must be a non-empty string matching ${SKILL_ID_PATTERN}`,
    };
  }
  if (typeof version !== 'string' || version.length === 0) {
    return {
      kind: 'error',
      detail: `${manifestSource}: "version" must be a non-empty string`,
    };
  }
  if (!isPlainObject(inputSchema)) {
    return {
      kind: 'error',
      detail: `${manifestSource}: "inputSchema" must be a JSON object`,
    };
  }
  if (!isPlainObject(outputSchema)) {
    return {
      kind: 'error',
      detail: `${manifestSource}: "outputSchema" must be a JSON object`,
    };
  }
  if (description !== undefined && typeof description !== 'string') {
    return {
      kind: 'error',
      detail: `${manifestSource}: "description" must be a string when present`,
    };
  }
  if (paramDocs !== undefined) {
    if (!isPlainObject(paramDocs)) {
      return {
        kind: 'error',
        detail: `${manifestSource}: "paramDocs" must be a JSON object when present`,
      };
    }
    for (const [k, v] of Object.entries(paramDocs)) {
      if (typeof v !== 'string') {
        return {
          kind: 'error',
          detail: `${manifestSource}: "paramDocs.${k}" must be a string`,
        };
      }
    }
  }
  if (deprecated !== undefined && typeof deprecated !== 'string') {
    return {
      kind: 'error',
      detail: `${manifestSource}: "deprecated" must be a string when present`,
    };
  }

  const metadata: SkillMetadata = {
    id,
    version,
    inputSchema: inputSchema as object,
    outputSchema: outputSchema as object,
  };
  if (description !== undefined) {
    metadata.description = description;
  }
  if (paramDocs !== undefined) {
    metadata.paramDocs = { ...(paramDocs as Record<string, string>) };
  }
  if (deprecated !== undefined) {
    metadata.deprecated = deprecated;
  }

  return { kind: 'ok', metadata };
}

/** True iff `p` exists and is a regular file. Uses fs.stat only. */
async function isReadableFile(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
