//
// Skill_Pack_Loader — resolves external Git-hosted / local / npx-style skill
// packs into NeuroNest's local Skill_Registry without copying them into the
// source tree. This module owns the pack manifest contract, the on-disk cache
// layout, and (in later tasks) the install/sync/remove/list operations.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseSkillMarkdown } from './skill-metadata-parser.js';
import type { SkillDefinition } from './skill-metadata-parser.js';
// Type-only import: erased at compile time, so no runtime dependency cycle.
import type { SkillRegistry } from './skill-registry.js';

// ─── Cache layout ───────────────────────────────────────────────────────────
//
// Installed packs are resolved into `~/.neuronest/skill-packs/<host>/<owner>/<repo>/`.
// Each pack directory holds its `pack.json`, `skills/*.md`, optional
// `eval/questions.jsonl`, and a `.cache.json` (manifest checksum, last sync
// timestamp, last drift report, last eval report). Packs are tracked on disk
// here rather than in user settings.
export const SKILL_PACK_CACHE_ROOT = path.join(os.homedir(), '.neuronest', 'skill-packs');

/** Name of the manifest file expected at the root of every Skill_Pack. */
export const PACK_MANIFEST_FILENAME = 'pack.json';

/** Name of the per-pack cache metadata file written alongside the manifest. */
export const PACK_CACHE_FILENAME = '.cache.json';

// ─── Manifest format (Requirement 58) ─────────────────────────────────────────

/**
 * Pack_Manifest — the `pack.json` file at a Skill_Pack root.
 *
 * Required fields (`name`, `version`, `description` is optional per design,
 * `source`, `skills`) are validated structurally by `parsePackManifest`
 * (task 43.2). `eval` is optional and points at a JSONL question/answer file
 * consumed by the Skill_Eval_Runner.
 */
export interface PackManifest {
  /** Pack identity; also the namespace prefix for registered skills. */
  name: string;
  /** Semantic version string of the pack. */
  version: string;
  /** Human-readable summary of the pack's contents. */
  description?: string;
  /** Git URL the pack was authored against / tracks for drift detection. */
  source: string;
  /** Skill markdown file paths, relative to the pack root. */
  skills: string[];
  /** Optional path (relative to pack root) to an eval/questions.jsonl file. */
  eval?: string;
}

// ─── Install sources ──────────────────────────────────────────────────────────

/**
 * F11_Pack_Source — where a Skill_Pack is installed from.
 *
 * - `git`: a remote Git URL (HTTPS/SSH/self-hosted), optionally pinned to `ref`.
 * - `local`: a filesystem path symlinked (or copied on Windows) into the cache.
 * - `npx`: an `npx skills add` style `owner/repo` identifier.
 */
export type PackSource =
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'local'; path: string }
  | { kind: 'npx'; identifier: string };

/** Result of an `installPack` operation (implemented in task 43.1). */
export interface InstallResult {
  ok: boolean;
  packId?: string;
  error?: string;
}

// ─── Per-pack cache metadata (.cache.json) ────────────────────────────────────

/**
 * Pack_Cache_Meta — the `.cache.json` written next to a pack's manifest.
 *
 * Records the manifest checksum (so drift / re-install can be detected cheaply)
 * and the install timestamp. Later tasks extend this with last-sync, last-drift
 * and last-eval reports.
 */
export interface PackCacheMeta {
  /** sha256 hex digest of the raw `pack.json` contents at install time. */
  manifestChecksum: string;
  /** ISO-8601 timestamp recorded when the pack was installed. */
  installedAt: string;
  /** The source the pack was installed from, for sync/remove bookkeeping. */
  source: PackSource;
  /** Pinned git ref, when the source was a git URL with an explicit ref. */
  ref?: string;
  /** ISO-8601 timestamp of the last successful `syncPack`, when one has run. */
  lastSyncedAt?: string;
}

// ─── URL / identity normalization (Requirement 59.6) ──────────────────────────

/**
 * Parsed identity of a pack's remote, normalized to a canonical
 * `<host>/<owner>/<repo>` triple so HTTPS, SSH and self-hosted Git URLs all
 * resolve to the same cache path. `.git` suffixes are stripped.
 */
interface PackIdentity {
  host: string;
  owner: string;
  repo: string;
}

/** Strip a trailing `.git` and surrounding slashes from a path segment. */
function stripGitSuffix(segment: string): string {
  return segment.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
}

/**
 * Normalize a Git remote URL into a `<host>/<owner>/<repo>` identity.
 *
 * Supports:
 *   - HTTPS:  https://github.com/owner/repo(.git)
 *   - SSH:    git@host:owner/repo(.git)
 *   - ssh://  ssh://git@host/owner/repo(.git)
 *   - self-hosted variants of all of the above.
 *
 * Throws if the URL cannot be reduced to an `owner/repo` pair.
 */
export function normalizeGitUrl(url: string): PackIdentity {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('normalizeGitUrl: empty URL');
  }

  // scp-like SSH syntax: git@host:owner/repo(.git) — no scheme, single colon.
  const scpMatch = /^[^/@]+@([^:/]+):(.+)$/.exec(trimmed);
  let host: string;
  let pathPart: string;

  if (scpMatch && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scpMatch[1];
    pathPart = scpMatch[2];
  } else {
    // URL-with-scheme syntax (https://, ssh://, git://, etc.).
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`normalizeGitUrl: unrecognized Git URL format: ${url}`);
    }
    host = parsed.hostname;
    pathPart = parsed.pathname;
  }

  const segments = stripGitSuffix(pathPart)
    .split('/')
    .filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new Error(`normalizeGitUrl: cannot derive owner/repo from: ${url}`);
  }

  const repo = stripGitSuffix(segments[segments.length - 1]);
  const owner = segments[segments.length - 2];

  if (!host || !owner || !repo) {
    throw new Error(`normalizeGitUrl: incomplete identity from: ${url}`);
  }

  return { host, owner, repo };
}

/** Absolute cache directory for a given pack identity. */
function cacheDirFor(identity: PackIdentity): string {
  return path.join(SKILL_PACK_CACHE_ROOT, identity.host, identity.owner, identity.repo);
}

// ─── Manifest parsing + structural validation (Requirement 58.4) ──────────────

/**
 * Machine-readable cause for a `PackManifestError`. Lets callers (and the IPC
 * layer / structured logs) branch on the failure class without string-matching
 * the human-readable message.
 *
 * - `not_found`     — no `pack.json` at the pack root.
 * - `unreadable`    — the `pack.json` file exists but could not be read.
 * - `malformed_json`— the file contents are not valid JSON.
 * - `not_object`    — valid JSON, but not a top-level object.
 * - `invalid_field` — a required field is missing or has the wrong type;
 *                     the offending field is reported in `field`.
 */
export type PackManifestErrorCode =
  | 'not_found'
  | 'unreadable'
  | 'malformed_json'
  | 'not_object'
  | 'invalid_field';

/**
 * Structured error raised by `parsePackManifest` (and the install path) when a
 * Pack_Manifest is missing or malformed (Requirement 58.4). Carries a stable
 * `code`, the offending `field` (for `invalid_field`), and the resolved
 * `manifestPath`, so the Skill_Pack_Loader can log a structured error and
 * refuse to register the pack.
 */
export class PackManifestError extends Error {
  /** Machine-readable failure class. */
  readonly code: PackManifestErrorCode;
  /** Offending manifest field, when `code === 'invalid_field'`. */
  readonly field?: string;
  /** Absolute path of the `pack.json` that failed validation. */
  readonly manifestPath: string;

  constructor(
    code: PackManifestErrorCode,
    message: string,
    manifestPath: string,
    field?: string,
  ) {
    super(message);
    this.name = 'PackManifestError';
    this.code = code;
    this.manifestPath = manifestPath;
    if (field !== undefined) {
      this.field = field;
    }
    // Restore the prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, PackManifestError.prototype);
  }

  /** Plain object form for structured logging / IPC serialization. */
  toStructured(): { code: PackManifestErrorCode; field?: string; manifestPath: string; message: string } {
    return {
      code: this.code,
      ...(this.field !== undefined ? { field: this.field } : {}),
      manifestPath: this.manifestPath,
      message: this.message,
    };
  }
}

/**
 * Validate an already-parsed JSON value against the {@link PackManifest}
 * contract (Requirement 58.2/58.3). Throws a {@link PackManifestError} with
 * `code: 'invalid_field'` (or `'not_object'`) on the first violation, naming
 * the offending field. Returns the value typed as a `PackManifest` on success.
 *
 * Required: `name`, `version`, `source` (non-empty strings) and `skills` (an
 * array of non-empty string paths). Optional: `description` and `eval` (strings
 * when present).
 */
function validateManifestObject(parsed: unknown, manifestPath: string): PackManifest {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackManifestError(
      'not_object',
      `malformed ${PACK_MANIFEST_FILENAME}: expected a JSON object at ${manifestPath}`,
      manifestPath,
    );
  }

  const m = parsed as Record<string, unknown>;

  const requireNonEmptyString = (field: keyof PackManifest): void => {
    const value = m[field as string];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new PackManifestError(
        'invalid_field',
        `invalid ${PACK_MANIFEST_FILENAME}: missing or empty required string field "${String(field)}"`,
        manifestPath,
        String(field),
      );
    }
  };

  requireNonEmptyString('name');
  requireNonEmptyString('version');
  requireNonEmptyString('source');

  if (!Array.isArray(m.skills)) {
    throw new PackManifestError(
      'invalid_field',
      `invalid ${PACK_MANIFEST_FILENAME}: missing required array field "skills"`,
      manifestPath,
      'skills',
    );
  }
  m.skills.forEach((skill, i) => {
    if (typeof skill !== 'string' || skill.trim() === '') {
      throw new PackManifestError(
        'invalid_field',
        `invalid ${PACK_MANIFEST_FILENAME}: "skills[${i}]" must be a non-empty string path`,
        manifestPath,
        `skills[${i}]`,
      );
    }
  });

  // Optional fields: only validate the type when present.
  if (m.description !== undefined && typeof m.description !== 'string') {
    throw new PackManifestError(
      'invalid_field',
      `invalid ${PACK_MANIFEST_FILENAME}: optional field "description" must be a string when present`,
      manifestPath,
      'description',
    );
  }
  if (m.eval !== undefined && (typeof m.eval !== 'string' || m.eval.trim() === '')) {
    throw new PackManifestError(
      'invalid_field',
      `invalid ${PACK_MANIFEST_FILENAME}: optional field "eval" must be a non-empty string path when present`,
      manifestPath,
      'eval',
    );
  }

  return parsed as PackManifest;
}

/**
 * Read + parse + structurally validate the `pack.json` at `packDir`. Returns
 * both the raw file bytes (so the install path can checksum the exact content)
 * and the typed manifest. Throws {@link PackManifestError} on any failure.
 * This is the shared core behind the public `parsePackManifest` and the
 * `installPack` manifest check.
 */
function readPackManifestFile(packDir: string): { raw: string; manifest: PackManifest } {
  const manifestPath = path.join(packDir, PACK_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    throw new PackManifestError(
      'not_found',
      `pack manifest not found: ${PACK_MANIFEST_FILENAME} missing in ${packDir}`,
      manifestPath,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new PackManifestError(
      'unreadable',
      `pack manifest unreadable: ${PACK_MANIFEST_FILENAME} at ${manifestPath}: ${(err as Error).message}`,
      manifestPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PackManifestError(
      'malformed_json',
      `malformed ${PACK_MANIFEST_FILENAME}: ${(err as Error).message}`,
      manifestPath,
    );
  }

  const manifest = validateManifestObject(parsed, manifestPath);
  return { raw, manifest };
}

/**
 * parsePackManifest — read and structurally validate the `pack.json`
 * Pack_Manifest at a pack root (Requirement 58.4).
 *
 * Reads `<packPath>/pack.json`, parses it as JSON, and validates it against the
 * {@link PackManifest} contract: `name`, `version`, `source` (non-empty
 * strings) and `skills` (array of non-empty string paths) are required;
 * `description` and `eval` are optional and type-checked when present.
 *
 * On any failure — missing file, unreadable file, malformed JSON, or a missing
 * / invalid field — this throws a typed {@link PackManifestError} carrying a
 * structured `code` (and `field` for field-level violations), so the
 * Skill_Pack_Loader can refuse to register the pack and emit a structured log.
 *
 * @param packPath Absolute or relative path to the pack root directory.
 * @returns The validated, typed {@link PackManifest}.
 * @throws {PackManifestError} when the manifest is missing or malformed.
 */
export function parsePackManifest(packPath: string): PackManifest {
  return readPackManifestFile(packPath).manifest;
}

/** sha256 hex digest helper for manifest checksums. */
function sha256(contents: string): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

// ─── installPack (Requirement 59) ─────────────────────────────────────────────

/**
 * installPack — resolve a Skill_Pack from a Git URL or local path into the
 * on-disk cache at `~/.neuronest/skill-packs/<host>/<owner>/<repo>/`.
 *
 * Behavior (Requirement 59):
 *   - `{ kind: 'git' }`: `git clone` the repo (checking out `ref` when given)
 *     into the cache. The cache path is derived from a normalized
 *     `<host>/<owner>/<repo>` identity so non-GitHub remotes install correctly.
 *   - `{ kind: 'local' }`: symlink the source dir into the cache, falling back
 *     to a recursive copy when symlinks are unavailable (e.g. Windows).
 *   - Refuses to overwrite an already-installed pack unless `opts.force` is set.
 *   - Writes `.cache.json` (manifest checksum + install timestamp) on success.
 *
 * Skill registration into the Skill_Registry (Requirement 59.4) is handled by
 * `registerSkills` (task 43.3) and is intentionally out of scope here.
 *
 * Never throws: all failures are returned as `{ ok: false, error }`.
 */
export async function installPack(
  source: PackSource,
  opts?: { force?: boolean },
): Promise<InstallResult> {
  const force = opts?.force === true;

  try {
    if (source.kind === 'npx') {
      // npx-style installs are resolved by a later task; not part of 43.1.
      return { ok: false, error: 'npx pack sources are not supported yet' };
    }

    // ─── Resolve the destination cache directory ──────────────────────────────
    let destDir: string;
    let identityLabel: string;

    if (source.kind === 'git') {
      const identity = normalizeGitUrl(source.url);
      destDir = cacheDirFor(identity);
      identityLabel = `${identity.owner}/${identity.repo}`;
    } else {
      // local: derive identity from the directory name, namespaced under "local".
      const absSource = path.resolve(source.path);
      if (!fs.existsSync(absSource) || !fs.statSync(absSource).isDirectory()) {
        return { ok: false, error: `local pack path is not a directory: ${source.path}` };
      }
      const repo = stripGitSuffix(path.basename(absSource)) || 'pack';
      const identity: PackIdentity = { host: 'local', owner: '_', repo };
      destDir = cacheDirFor(identity);
      identityLabel = repo;
    }

    // ─── Overwrite guard (Requirement 59.5) ───────────────────────────────────
    if (fs.existsSync(destDir)) {
      if (!force) {
        let existingVersion = 'unknown';
        try {
          existingVersion = readPackManifestFile(destDir).manifest.version;
        } catch {
          // Existing dir has no readable manifest; report version as unknown.
        }
        console.warn(
          `[PackLoader] Pack already installed at ${destDir} (version ${existingVersion}); ` +
            `refusing to overwrite without force.`,
        );
        return {
          ok: false,
          error:
            `pack already installed at ${destDir} (version ${existingVersion}); ` +
            `pass --force to overwrite`,
        };
      }
      // force: clear the existing directory before re-installing.
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    // ─── Place the pack files ─────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(destDir), { recursive: true });

    if (source.kind === 'git') {
      // Use execFileSync with an argument array — never a shell string — so the
      // URL/ref can never be interpreted as shell syntax (command injection).
      try {
        execFileSync('git', ['clone', '--', source.url, destDir], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
      } catch (err) {
        // Clean up a partial clone so a later install starts fresh.
        if (fs.existsSync(destDir)) {
          fs.rmSync(destDir, { recursive: true, force: true });
        }
        return { ok: false, error: `git clone failed: ${(err as Error).message}` };
      }

      if (source.ref) {
        try {
          execFileSync('git', ['checkout', '--', source.ref], {
            cwd: destDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
          });
        } catch (err) {
          if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
          }
          return {
            ok: false,
            error: `git checkout of ref "${source.ref}" failed: ${(err as Error).message}`,
          };
        }
      }
    } else {
      // local: prefer a symlink, fall back to a recursive copy.
      const absSource = path.resolve(source.path);
      try {
        fs.symlinkSync(absSource, destDir, 'dir');
      } catch {
        try {
          fs.cpSync(absSource, destDir, { recursive: true });
        } catch (err) {
          if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
          }
          return {
            ok: false,
            error: `failed to link/copy local pack: ${(err as Error).message}`,
          };
        }
      }
    }

    // ─── Validate manifest + compute checksum ─────────────────────────────────
    let raw: string;
    let manifest: PackManifest;
    try {
      ({ raw, manifest } = readPackManifestFile(destDir));
    } catch (err) {
      // A pack without a valid manifest is not installable. For git/copy installs
      // we remove the placed files; for a symlinked local dir we only remove the
      // link (never the user's original source tree).
      try {
        const stat = fs.lstatSync(destDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(destDir);
        } else {
          fs.rmSync(destDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort cleanup
      }
      return { ok: false, error: `pack manifest invalid: ${(err as Error).message}` };
    }

    // ─── Write .cache.json (checksum + install timestamp) ─────────────────────
    const cacheMeta: PackCacheMeta = {
      manifestChecksum: sha256(raw),
      installedAt: new Date().toISOString(),
      source,
      ...(source.kind === 'git' && source.ref ? { ref: source.ref } : {}),
    };

    const cachePath = path.join(destDir, PACK_CACHE_FILENAME);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cacheMeta, null, 2), 'utf-8');
    } catch (err) {
      return { ok: false, error: `failed to write ${PACK_CACHE_FILENAME}: ${(err as Error).message}` };
    }

    const packId = source.kind === 'git' ? identityLabel : manifest.name || identityLabel;
    console.log(`[PackLoader] Installed pack "${packId}" (version ${manifest.version}) at ${destDir}`);

    return { ok: true, packId };
  } catch (err) {
    // Defensive catch-all: never throw on the install path.
    return { ok: false, error: (err as Error).message };
  }
}

// ─── registerSkills (Requirement 59.4) ────────────────────────────────────────

/**
 * Per-skill outcome reported by {@link registerSkills}.
 *
 * `skipped` entries carry a human-readable `reason` (file missing, traversal
 * attempt, empty body) so callers can surface a structured log without the
 * whole registration failing.
 */
export interface RegisterSkillsResult {
  /** True when the pack was resolved and registration ran (individual skills may still be skipped). */
  ok: boolean;
  /** The pack identity registration ran for. */
  packId: string;
  /** The namespace prefix (`<pack.name>`) applied to every registered skill id. */
  namespace: string;
  /** Namespaced skill ids (`<pack.name>/<skillId>`) successfully registered. */
  registered: string[];
  /** Skills declared in the manifest that could not be registered. */
  skipped: Array<{ skillPath: string; reason: string }>;
  /** Fatal error (pack dir unresolvable); present only when `ok` is false. */
  error?: string;
}

/**
 * Resolve a `packId` (as reported by {@link installPack}) to its on-disk cache
 * directory, or `null` when no matching pack is found. Mirrors the resolution
 * used by the Skill_Eval_Runner / Skill_Drift_Detector so a pack can be
 * referenced by `<owner>/<repo>`, `<host>/<owner>/<repo>`, its cache directory
 * basename, or its manifest `name`.
 */
function resolvePackCacheDir(packId: string, manifest: PackManifest): string | null {
  const normalizedId = packId.trim().replace(/^\/+|\/+$/g, '');

  // 1. Direct path join (handles "<owner>/<repo>" and "<host>/<owner>/<repo>").
  const direct = path.join(SKILL_PACK_CACHE_ROOT, normalizedId);
  if (isPackDir(direct)) return direct;

  if (!fs.existsSync(SKILL_PACK_CACHE_ROOT)) return null;

  const candidates: string[] = [];
  collectPackDirs(SKILL_PACK_CACHE_ROOT, 5, candidates);

  // 2 & 3: match by cache-relative path / basename.
  for (const dir of candidates) {
    const rel = path.relative(SKILL_PACK_CACHE_ROOT, dir).split(path.sep).join('/');
    if (rel === normalizedId || rel.endsWith(`/${normalizedId}`)) return dir;
    if (path.basename(dir) === normalizedId) return dir;
  }

  // 4: match by manifest name (the packId reported for local installs).
  for (const dir of candidates) {
    const m = tryReadManifestName(dir);
    if (m !== null && (m === normalizedId || m === manifest.name)) return dir;
  }

  return null;
}

/** True when `dir` contains a `pack.json` manifest file. */
function isPackDir(dir: string): boolean {
  try {
    const manifestPath = path.join(dir, PACK_MANIFEST_FILENAME);
    return fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile();
  } catch {
    return false;
  }
}

/** Recursively collect pack directories (those holding a `pack.json`). */
function collectPackDirs(root: string, depth: number, acc: string[]): void {
  if (depth < 0) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (isPackDir(full)) {
      acc.push(full);
      continue;
    }

    let isDir: boolean;
    try {
      // statSync (not the dirent) so symlinked local packs are followed.
      isDir = fs.statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) collectPackDirs(full, depth - 1, acc);
  }
}

/** Best-effort read of a pack's manifest `name`; returns `null` on any failure. */
function tryReadManifestName(packDir: string): string | null {
  try {
    return readPackManifestFile(packDir).manifest.name;
  } catch {
    return null;
  }
}

/**
 * Derive a skill id from a manifest skill path: the file basename without its
 * `.md` (or `.markdown`) extension. `skills/rfm-predict.md` → `rfm-predict`.
 */
function skillIdFromPath(skillPath: string): string {
  const base = path.basename(skillPath);
  return base.replace(/\.(md|markdown)$/i, '');
}

/**
 * Resolve a manifest skill path against the pack root, refusing any path that
 * escapes the pack directory (path-traversal guard). Returns the absolute path
 * on success, or `null` when the path would resolve outside `packDir`.
 */
function resolveSkillFile(packDir: string, skillPath: string): string | null {
  const resolved = path.resolve(packDir, skillPath);
  const rel = path.relative(packDir, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/**
 * registerSkills — register every skill declared in a pack's manifest into the
 * existing {@link SkillRegistry}, namespaced as `<pack.name>/<skillId>`
 * (Requirement 59.4).
 *
 * For each entry in `manifest.skills` (markdown paths relative to the pack
 * root) this:
 *   1. Resolves the file under the pack's cache directory, refusing any path
 *      that escapes the pack root.
 *   2. Derives `skillId` from the file basename (sans `.md`) and the registry
 *      id from `<pack.name>/<skillId>`.
 *   3. Reads the markdown body. When the file carries valid skill frontmatter
 *      its parsed fields (name, description, tags, scope, entrypoint, metadata,
 *      mode) are preserved; otherwise sensible defaults are derived from the
 *      manifest so a plain-markdown skill still registers.
 *   4. Upserts a {@link SkillDefinition} whose `metadata` records the pack
 *      provenance (`pack`, `packId`, `packSkillPath`, `originalSkillId`).
 *
 * Existing skill execution paths are left untouched: this only ADDS namespaced
 * registry entries (never mutating or removing built-in skills), and it carries
 * each skill's original `entrypoint` and `metadata.mode` through verbatim so the
 * ExecutionEngine resolves the same mode it would for any other registered skill.
 *
 * Never throws: a missing/invalid skill file is reported in `skipped`; an
 * unresolvable pack directory returns `{ ok: false, error }`.
 *
 * @param packId   Pack identity as reported by {@link installPack}.
 * @param manifest The validated {@link PackManifest} for the pack.
 * @param registry The existing Skill_Registry to register skills into.
 */
export function registerSkills(
  packId: string,
  manifest: PackManifest,
  registry: SkillRegistry,
): RegisterSkillsResult {
  const namespace = manifest.name;
  const result: RegisterSkillsResult = {
    ok: false,
    packId,
    namespace,
    registered: [],
    skipped: [],
  };

  const packDir = resolvePackCacheDir(packId, manifest);
  if (packDir === null) {
    result.error = `pack not found in cache: ${packId}`;
    console.warn(`[PackLoader] registerSkills: ${result.error}`);
    return result;
  }

  result.ok = true;

  for (const skillPath of manifest.skills) {
    const skillId = skillIdFromPath(skillPath);
    const namespacedId = `${namespace}/${skillId}`;

    const filePath = resolveSkillFile(packDir, skillPath);
    if (filePath === null) {
      result.skipped.push({ skillPath, reason: 'path escapes pack root' });
      console.warn(`[PackLoader] registerSkills: refusing traversal path "${skillPath}" in pack ${packId}`);
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      result.skipped.push({ skillPath, reason: `unreadable: ${(err as Error).message}` });
      console.warn(`[PackLoader] registerSkills: cannot read "${skillPath}" in pack ${packId}:`, err);
      continue;
    }

    if (raw.trim() === '') {
      result.skipped.push({ skillPath, reason: 'empty skill file' });
      continue;
    }

    const now = new Date().toISOString();
    const parsed = parseSkillMarkdown(raw);

    // Build the namespaced registry entry. When the markdown has valid skill
    // frontmatter we preserve its descriptive fields; otherwise we synthesize
    // defaults from the manifest so plain-markdown skills still register.
    let skill: SkillDefinition;
    if (parsed.ok) {
      const base = parsed.skill;
      skill = {
        ...base,
        id: namespacedId,
        // Pack skills resolve to a local on-disk source; the DB `source` CHECK
        // only allows local|bundled|custom|workspace, so provenance lives in metadata.
        source: 'local',
        version: base.version || manifest.version,
        enabled: true,
        installed: true,
        metadata: {
          ...base.metadata,
          pack: namespace,
          packId,
          packSkillPath: skillPath,
          originalSkillId: base.id,
        },
        createdAt: now,
        updatedAt: now,
      };
    } else {
      skill = {
        id: namespacedId,
        name: skillId,
        description: manifest.description?.trim()
          ? manifest.description
          : `Skill ${skillId} from pack ${namespace}`,
        source: 'local',
        version: manifest.version,
        category: 'pack',
        tags: [],
        scope: 'project',
        enabled: true,
        installed: true,
        content: raw,
        metadata: {
          pack: namespace,
          packId,
          packSkillPath: skillPath,
          originalSkillId: skillId,
        },
        createdAt: now,
        updatedAt: now,
      };
    }

    try {
      registry.upsert(skill);
      result.registered.push(namespacedId);
    } catch (err) {
      result.skipped.push({ skillPath, reason: `registry upsert failed: ${(err as Error).message}` });
      console.warn(`[PackLoader] registerSkills: failed to register "${namespacedId}":`, err);
    }
  }

  console.log(
    `[PackLoader] registerSkills: pack "${packId}" registered ${result.registered.length}/${manifest.skills.length} ` +
      `skill(s) under namespace "${namespace}/"` +
      (result.skipped.length > 0 ? `; skipped ${result.skipped.length}` : ''),
  );

  return result;
}

// ─── syncPack / removePack (Requirement 62.1, 62.3) ───────────────────────────

/** Result of a {@link syncPack} operation. Superset of the design's `{ ok, error? }`. */
export interface SyncResult {
  ok: boolean;
  packId: string;
  /** True when the upstream pull (or local refresh) brought a content change. */
  updated?: boolean;
  /** Namespaced skill ids re-registered during the sync, when a registry was given. */
  registered?: string[];
  error?: string;
}

/** Result of a {@link removePack} operation. Superset of the design's `{ ok, error? }`. */
export interface RemoveResult {
  ok: boolean;
  packId: string;
  /** Namespaced skill ids unregistered from the Skill_Registry. */
  unregistered?: string[];
  error?: string;
}

/**
 * Resolve a `packId` to its on-disk cache directory without needing a manifest
 * up front (unlike {@link resolvePackCacheDir}, which sync/remove cannot call
 * before reading the pack). Matches by direct path join, cache-relative path,
 * basename, or the candidate's own manifest `name`. Returns `null` when no
 * installed pack matches.
 */
function resolvePackDirById(packId: string): string | null {
  const normalizedId = packId.trim().replace(/^\/+|\/+$/g, '');
  if (normalizedId === '') return null;

  // 1. Direct path join ("<owner>/<repo>" or "<host>/<owner>/<repo>").
  const direct = path.join(SKILL_PACK_CACHE_ROOT, normalizedId);
  if (isPackDir(direct)) return direct;

  if (!fs.existsSync(SKILL_PACK_CACHE_ROOT)) return null;

  const candidates: string[] = [];
  collectPackDirs(SKILL_PACK_CACHE_ROOT, 5, candidates);

  // 2 & 3: match by cache-relative path / basename.
  for (const dir of candidates) {
    const rel = path.relative(SKILL_PACK_CACHE_ROOT, dir).split(path.sep).join('/');
    if (rel === normalizedId || rel.endsWith(`/${normalizedId}`)) return dir;
    if (path.basename(dir) === normalizedId) return dir;
  }

  // 4: match by the candidate's own manifest name.
  for (const dir of candidates) {
    if (tryReadManifestName(dir) === normalizedId) return dir;
  }

  return null;
}

/** Best-effort read of a pack's `.cache.json`; returns `null` on any failure. */
function tryReadCacheMeta(packDir: string): PackCacheMeta | null {
  try {
    const raw = fs.readFileSync(path.join(packDir, PACK_CACHE_FILENAME), 'utf-8');
    return JSON.parse(raw) as PackCacheMeta;
  } catch {
    return null;
  }
}

/** True when `dir` is (or contains) a Git working tree we can `git pull`. */
function hasGitWorkingTree(packDir: string): boolean {
  try {
    return fs.existsSync(path.join(packDir, '.git'));
  } catch {
    return false;
  }
}

/** Best-effort `git rev-parse HEAD` for change detection; `null` on any failure. */
function tryGitHead(packDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: packDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** True when `packDir` is a symlink (a linked local pack), never a real tree. */
function isSymlinkedPack(packDir: string): boolean {
  try {
    return fs.lstatSync(packDir).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * syncPack — refresh an installed Skill_Pack from its upstream and re-register
 * any changed skills (Requirement 62.1).
 *
 * Behavior:
 *   - Git-installed packs: run `git pull` inside the cache directory (via
 *     `execFileSync` with an argument array — never a shell string — and a
 *     timeout, so the pack id/remote can never be interpreted as shell syntax).
 *     The pre/post `HEAD` commit is compared to decide whether anything
 *     changed, and the manifest is re-parsed.
 *   - Local symlinked packs: syncing is a no-op refresh — the symlink already
 *     mirrors the user's source tree, so we only re-parse + re-register. The
 *     user's source tree is never modified.
 *   - When a `registry` is supplied, the (possibly updated) manifest's skills
 *     are re-registered via {@link registerSkills} (an idempotent upsert).
 *   - `.cache.json` is refreshed with the new manifest checksum and a
 *     `lastSyncedAt` timestamp.
 *
 * Never throws: every failure is returned as `{ ok: false, error }`.
 *
 * @param packId   Pack identity as reported by {@link installPack}.
 * @param registry Optional Skill_Registry to re-register changed skills into.
 */
export async function syncPack(packId: string, registry?: SkillRegistry): Promise<SyncResult> {
  try {
    const packDir = resolvePackDirById(packId);
    if (packDir === null) {
      return { ok: false, packId, error: `pack not found in cache: ${packId}` };
    }

    const cacheMeta = tryReadCacheMeta(packDir);
    const beforeChecksum = cacheMeta?.manifestChecksum;

    // Decide whether to pull from a Git remote. Local symlinked packs (and packs
    // whose recorded source is local) are refreshed in place — we must never run
    // a Git operation that could mutate the user's original source tree.
    const isLocal =
      isSymlinkedPack(packDir) || cacheMeta?.source.kind === 'local';
    const canGitPull = !isLocal && hasGitWorkingTree(packDir);

    let updated = false;

    if (canGitPull) {
      const beforeCommit = tryGitHead(packDir);
      try {
        execFileSync('git', ['pull', '--ff-only'], {
          cwd: packDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
      } catch (err) {
        return { ok: false, packId, error: `git pull failed: ${(err as Error).message}` };
      }
      const afterCommit = tryGitHead(packDir);
      if (beforeCommit !== null && afterCommit !== null) {
        updated = beforeCommit !== afterCommit;
      }
    }

    // Re-parse the (possibly updated) manifest. A pack whose manifest went bad
    // upstream is reported as a sync failure rather than silently re-registered.
    let raw: string;
    let manifest: PackManifest;
    try {
      ({ raw, manifest } = readPackManifestFile(packDir));
    } catch (err) {
      return { ok: false, packId, error: `pack manifest invalid after sync: ${(err as Error).message}` };
    }

    const afterChecksum = sha256(raw);
    if (beforeChecksum !== undefined && beforeChecksum !== afterChecksum) {
      updated = true;
    }

    // Re-register changed skills when a registry is provided (idempotent upsert).
    let registered: string[] | undefined;
    if (registry) {
      const reg = registerSkills(packId, manifest, registry);
      registered = reg.registered;
    }

    // Refresh .cache.json: new checksum + last-sync timestamp, preserving source.
    const nextMeta: PackCacheMeta = {
      manifestChecksum: afterChecksum,
      installedAt: cacheMeta?.installedAt ?? new Date().toISOString(),
      source: cacheMeta?.source ?? { kind: 'git', url: manifest.source },
      ...(cacheMeta?.ref !== undefined ? { ref: cacheMeta.ref } : {}),
      lastSyncedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(
        path.join(packDir, PACK_CACHE_FILENAME),
        JSON.stringify(nextMeta, null, 2),
        'utf-8',
      );
    } catch (err) {
      return { ok: false, packId, error: `failed to update ${PACK_CACHE_FILENAME}: ${(err as Error).message}` };
    }

    console.log(
      `[PackLoader] syncPack: pack "${packId}" ${updated ? 'updated' : 'already current'}` +
        (registered ? `; re-registered ${registered.length} skill(s)` : ''),
    );

    return {
      ok: true,
      packId,
      updated,
      ...(registered !== undefined ? { registered } : {}),
    };
  } catch (err) {
    // Defensive catch-all: never throw on the sync path.
    return { ok: false, packId, error: (err as Error).message };
  }
}

/**
 * removePack — unregister a Skill_Pack's skills from the Skill_Registry and
 * delete its on-disk cache directory (Requirement 62.3).
 *
 * Behavior:
 *   - When a `registry` is supplied, every skill registered under the pack
 *     (namespace `<pack.name>/...`, identified via the `pack`/`packId`
 *     provenance recorded by {@link registerSkills}) is removed via the
 *     registry's `remove(id)` API. This is best-effort: a registry failure on
 *     one skill does not abort the directory cleanup.
 *   - The cache directory is then removed. For a symlinked local pack only the
 *     symlink is unlinked — the user's original source tree is never deleted.
 *     For a Git clone / copied pack the directory is recursively removed.
 *
 * Never throws: every failure is returned as `{ ok: false, error }`.
 *
 * @param packId   Pack identity as reported by {@link installPack}.
 * @param registry Optional Skill_Registry to unregister the pack's skills from.
 */
export async function removePack(packId: string, registry?: SkillRegistry): Promise<RemoveResult> {
  try {
    const packDir = resolvePackDirById(packId);
    if (packDir === null) {
      return { ok: false, packId, error: `pack not found in cache: ${packId}` };
    }

    // Resolve the namespace from the manifest (best-effort) so we can match the
    // namespaced skill ids registerSkills created.
    const namespace = tryReadManifestName(packDir);

    // ─── Unregister the pack's skills (best-effort) ───────────────────────────
    const unregistered: string[] = [];
    if (registry) {
      let skills: SkillDefinition[] = [];
      try {
        skills = registry.list();
      } catch (err) {
        console.warn(`[PackLoader] removePack: registry.list() failed for ${packId}:`, err);
      }

      for (const skill of skills) {
        const meta = (skill.metadata ?? {}) as Record<string, unknown>;
        const belongsToPack =
          meta.packId === packId ||
          (namespace !== null &&
            (meta.pack === namespace || skill.id.startsWith(`${namespace}/`)));
        if (!belongsToPack) continue;

        try {
          registry.remove(skill.id);
          unregistered.push(skill.id);
        } catch (err) {
          console.warn(`[PackLoader] removePack: failed to unregister "${skill.id}":`, err);
        }
      }
    }

    // ─── Delete the cache directory ───────────────────────────────────────────
    // A symlinked local pack must only have its link removed — never the user's
    // original source tree behind it.
    try {
      if (isSymlinkedPack(packDir)) {
        fs.unlinkSync(packDir);
      } else if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
    } catch (err) {
      return { ok: false, packId, error: `failed to remove pack cache directory: ${(err as Error).message}` };
    }

    console.log(
      `[PackLoader] removePack: removed pack "${packId}"` +
        (unregistered.length > 0 ? `; unregistered ${unregistered.length} skill(s)` : ''),
    );

    return { ok: true, packId, unregistered };
  } catch (err) {
    // Defensive catch-all: never throw on the remove path.
    return { ok: false, packId, error: (err as Error).message };
  }
}

// ─── listPacks (Requirement 62.2) ─────────────────────────────────────────────

/**
 * Metadata describing a single installed Skill_Pack, as returned by
 * {@link listPacks}. Matches the design contract / `skill-packs:list` IPC shape
 * (`{ packId, manifest, lastSync }`).
 */
export interface InstalledPack {
  /**
   * Cache-relative identity (`<host>/<owner>/<repo>`, or `local/_/<repo>` for a
   * linked local pack). Resolvable back to its cache directory by
   * `syncPack` / `removePack` / `checkDrift`.
   */
  packId: string;
  /** The pack's validated {@link PackManifest}. */
  manifest: PackManifest;
  /**
   * Epoch-ms timestamp of the pack's last successful `syncPack`, falling back
   * to its install time when it has never been synced, or `0` when no
   * `.cache.json` is present.
   */
  lastSync: number;
}

/**
 * Parse an ISO-8601 timestamp to epoch-ms, returning `0` for missing or
 * unparseable values (so `lastSync` is always a finite number).
 */
function isoToEpochMs(iso: string | undefined): number {
  if (typeof iso !== 'string' || iso.trim() === '') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * listPacks — enumerate every installed Skill_Pack under the cache root
 * `~/.neuronest/skill-packs/<host>/<owner>/<repo>/` (Requirement 62.2).
 *
 * For each cached pack directory (one holding a `pack.json`) this reads the
 * pack's manifest and its `.cache.json` (manifest checksum + install / last-sync
 * timestamps) and returns `{ packId, manifest, lastSync }`. `lastSync` is the
 * epoch-ms of the last successful `syncPack`, falling back to the install time,
 * or `0` when no `.cache.json` exists. `packId` is the cache-relative
 * `<host>/<owner>/<repo>` identity, so it resolves back through
 * {@link syncPack} / {@link removePack}.
 *
 * Packs whose `pack.json` is missing or malformed are skipped (with a structured
 * warning) rather than aborting the whole listing.
 *
 * Never throws: a missing or empty cache directory yields `[]`.
 */
export async function listPacks(): Promise<InstalledPack[]> {
  try {
    if (!fs.existsSync(SKILL_PACK_CACHE_ROOT)) {
      return [];
    }

    const packDirs: string[] = [];
    collectPackDirs(SKILL_PACK_CACHE_ROOT, 5, packDirs);

    const packs: InstalledPack[] = [];
    for (const packDir of packDirs) {
      let manifest: PackManifest;
      try {
        ({ manifest } = readPackManifestFile(packDir));
      } catch (err) {
        // A pack with no readable/valid manifest is not listable; skip it.
        console.warn(
          `[PackLoader] listPacks: skipping ${packDir}: ${(err as Error).message}`,
        );
        continue;
      }

      const packId = path
        .relative(SKILL_PACK_CACHE_ROOT, packDir)
        .split(path.sep)
        .join('/');

      const cacheMeta = tryReadCacheMeta(packDir);
      const lastSync = isoToEpochMs(cacheMeta?.lastSyncedAt ?? cacheMeta?.installedAt);

      packs.push({ packId, manifest, lastSync });
    }

    console.log(`[PackLoader] listPacks: found ${packs.length} installed pack(s)`);
    return packs;
  } catch (err) {
    // Defensive catch-all: never throw on the list path.
    console.warn(`[PackLoader] listPacks: unexpected error: ${(err as Error).message}`);
    return [];
  }
}
