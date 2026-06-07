//
// Skill_Drift_Detector — compares an installed Skill_Pack against its upstream
// Git source and reports whether the locally-cached pack (and each of its
// skills) has fallen out of sync. Drift detection runs on-demand via
// `checkDrift(packId)` and (task 44.2) across every installed pack via
// `validateFreshness()`.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SKILL_PACK_CACHE_ROOT,
  PACK_CACHE_FILENAME,
  PACK_MANIFEST_FILENAME,
  type PackManifest,
  type PackCacheMeta,
} from './pack-loader.js';

const execFileAsync = promisify(execFile);

// ─── Drift report contract (Requirement 60.2 / 60.3) ──────────────────────────

/**
 * Drift_Report — the result of comparing an installed Skill_Pack against its
 * declared upstream `source`.
 *
 * - `status`: pack-level freshness. `'fresh'` when the locally-tracked commit
 *   equals the upstream default-branch HEAD, `'stale'` when they differ, and
 *   `'unknown'` when the source URL is unreachable or the commit cannot be
 *   resolved (Requirement 60.4).
 * - `sourceCommit`: the commit the local cache is checked out at.
 * - `currentCommit`: the upstream default-branch HEAD.
 * - `commitsBehind`: best-effort count of upstream commits the cache trails by.
 * - `perSkill`: per-skill freshness; a skill is `'stale'` when its markdown
 *   file changed upstream between `sourceCommit` and `currentCommit`.
 */
export interface DriftReport {
  packId: string;
  status: 'fresh' | 'stale' | 'unknown';
  sourceCommit?: string;
  currentCommit?: string;
  commitsBehind?: number;
  perSkill: Array<{ skillId: string; status: 'fresh' | 'stale' | 'unknown' }>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** An installed pack resolved from the on-disk cache. */
interface InstalledPack {
  packId: string;
  dir: string;
  manifest: PackManifest;
}

/**
 * Run `git` with an explicit argument array (never a shell string) so that a
 * pack's `source` URL or ref can never be interpreted as shell syntax — this
 * is the command-injection-safe execution path used throughout F11.
 *
 * Returns the captured stdout on success, or `null` on any failure (non-zero
 * exit, timeout, git missing, unreachable remote). Never throws.
 */
async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = 20_000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      ...(cwd ? { cwd } : {}),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Read and minimally validate a pack's `pack.json`; returns null on failure. */
function readManifest(packDir: string): PackManifest | null {
  try {
    const raw = fs.readFileSync(path.join(packDir, PACK_MANIFEST_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).source === 'string'
    ) {
      return parsed as PackManifest;
    }
  } catch {
    // missing / malformed manifest → not a resolvable pack
  }
  return null;
}

/** List immediate sub-directory names (including symlinked dirs) of `dir`. */
function listChildDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Walk the `<host>/<owner>/<repo>/` cache layout and return every directory
 * that carries a readable `pack.json`. Exported so `validateFreshness`
 * (task 44.2) can enumerate installed packs without re-deriving the layout.
 */
export function findInstalledPacks(): InstalledPack[] {
  const out: InstalledPack[] = [];
  for (const host of listChildDirs(SKILL_PACK_CACHE_ROOT)) {
    const hostDir = path.join(SKILL_PACK_CACHE_ROOT, host);
    for (const owner of listChildDirs(hostDir)) {
      const ownerDir = path.join(hostDir, owner);
      for (const repo of listChildDirs(ownerDir)) {
        const packDir = path.join(ownerDir, repo);
        const manifest = readManifest(packDir);
        if (!manifest) {
          continue;
        }
        const packId = manifest.name?.trim() || `${owner}/${repo}`;
        out.push({ packId, dir: packDir, manifest });
      }
    }
  }
  return out;
}

/**
 * Resolve a `packId` to an installed pack. Matches (in order) the manifest
 * `name`, the `<owner>/<repo>` cache path suffix, then the bare `<repo>` dir
 * name, so callers can reference a pack by any of the identifiers `installPack`
 * may have reported.
 */
function resolvePack(packId: string): InstalledPack | null {
  const packs = findInstalledPacks();

  const byName = packs.find((p) => p.manifest.name === packId);
  if (byName) {
    return byName;
  }

  const byPath = packs.find((p) => {
    const parts = p.dir.split(path.sep);
    const repo = parts[parts.length - 1];
    const owner = parts[parts.length - 2];
    return `${owner}/${repo}` === packId || repo === packId;
  });

  return byPath ?? null;
}

/** Derive a skill id (basename without `.md`) from a manifest skill path. */
function skillIdOf(skillPath: string): string {
  const normalized = skillPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() ?? normalized;
  return base.replace(/\.md$/i, '');
}

/** Normalize a manifest skill path to the form `git diff` reports. */
function normalizeSkillPath(skillPath: string): string {
  return skillPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Best-effort per-skill staleness + commits-behind computation for a pack that
 * is known to be stale. Fetches the upstream objects so a `git diff` between
 * the local and remote commits can be performed locally. When the diff cannot
 * be computed (e.g. fetch failed, shallow clone), every skill is reported as
 * `'unknown'` rather than guessed.
 */
async function computeStaleness(
  dir: string,
  source: string,
  localCommit: string,
  remoteCommit: string,
  skills: string[],
): Promise<{
  perSkill: Array<{ skillId: string; status: 'fresh' | 'stale' | 'unknown' }>;
  commitsBehind?: number;
}> {
  // Pull the upstream objects so `remoteCommit` is reachable from the cache.
  await runGit(['fetch', '--quiet', '--', source], dir, 60_000);

  const diffOut = await runGit(
    ['diff', '--name-only', `${localCommit}..${remoteCommit}`],
    dir,
  );
  const changed =
    diffOut === null
      ? null
      : diffOut
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

  let commitsBehind: number | undefined;
  const countOut = await runGit(
    ['rev-list', '--count', `${localCommit}..${remoteCommit}`],
    dir,
  );
  if (countOut !== null) {
    const n = Number.parseInt(countOut.trim(), 10);
    if (!Number.isNaN(n)) {
      commitsBehind = n;
    }
  }

  const perSkill = skills.map((skillPath) => {
    const skillId = skillIdOf(skillPath);
    if (changed === null) {
      return { skillId, status: 'unknown' as const };
    }
    const rel = normalizeSkillPath(skillPath);
    const isStale = changed.includes(rel);
    return { skillId, status: isStale ? ('stale' as const) : ('fresh' as const) };
  });

  return { perSkill, commitsBehind };
}

// ─── checkDrift (Requirement 60.1–60.4) ───────────────────────────────────────

/**
 * checkDrift — compare an installed Skill_Pack against its upstream `source`
 * and report freshness at the pack and per-skill level.
 *
 * Behavior (Requirement 60):
 *   - Resolves the pack's cache directory from `packId`.
 *   - Reads the locally-tracked commit via `git rev-parse HEAD` in the cache
 *     dir (falling back to a commit recorded in `.cache.json`).
 *   - Queries the upstream default-branch HEAD via `git ls-remote <source> HEAD`.
 *   - Equal commits → `'fresh'`; differing commits → `'stale'` with a
 *     best-effort per-skill diff; unreachable source / unresolvable commit →
 *     `'unknown'` for the pack and every skill (Requirement 60.4).
 *
 * Never throws: any unexpected error resolves to a `'unknown'` report.
 */
export async function checkDrift(packId: string): Promise<DriftReport> {
  const unknownReport = (extra?: Partial<DriftReport>): DriftReport => ({
    packId,
    status: 'unknown',
    perSkill: [],
    ...extra,
  });

  try {
    const pack = resolvePack(packId);
    if (!pack) {
      return unknownReport();
    }

    const source = pack.manifest.source;
    const skills = Array.isArray(pack.manifest.skills) ? pack.manifest.skills : [];
    const unknownSkills = skills.map((s) => ({
      skillId: skillIdOf(s),
      status: 'unknown' as const,
    }));

    // ─── Locally-tracked commit ────────────────────────────────────────────
    let localCommit: string | undefined;
    const revParse = await runGit(['rev-parse', 'HEAD'], pack.dir);
    if (revParse && revParse.trim().length > 0) {
      localCommit = revParse.trim();
    } else {
      // Fallback: a commit may have been recorded in .cache.json for non-git
      // (local symlink) installs that still track an upstream source.
      try {
        const metaRaw = fs.readFileSync(
          path.join(pack.dir, PACK_CACHE_FILENAME),
          'utf-8',
        );
        const meta = JSON.parse(metaRaw) as PackCacheMeta & {
          commit?: string;
          sourceCommit?: string;
        };
        localCommit = meta.sourceCommit ?? meta.commit ?? meta.ref;
      } catch {
        // no recorded commit
      }
    }

    // ─── Upstream default-branch HEAD ──────────────────────────────────────
    if (!source || source.trim().length === 0) {
      return unknownReport({ sourceCommit: localCommit, perSkill: unknownSkills });
    }

    const lsRemote = await runGit(['ls-remote', '--', source, 'HEAD']);
    if (lsRemote === null) {
      // Source unreachable → pack and every skill are 'unknown' (Req 60.4).
      return unknownReport({ sourceCommit: localCommit, perSkill: unknownSkills });
    }

    const remoteCommit = lsRemote.split(/\s+/)[0]?.trim() || undefined;

    if (!localCommit || !remoteCommit) {
      return unknownReport({
        sourceCommit: localCommit,
        currentCommit: remoteCommit,
        perSkill: unknownSkills,
      });
    }

    // ─── Compare ───────────────────────────────────────────────────────────
    if (localCommit === remoteCommit) {
      return {
        packId,
        status: 'fresh',
        sourceCommit: localCommit,
        currentCommit: remoteCommit,
        commitsBehind: 0,
        perSkill: skills.map((s) => ({
          skillId: skillIdOf(s),
          status: 'fresh' as const,
        })),
      };
    }

    const { perSkill, commitsBehind } = await computeStaleness(
      pack.dir,
      source,
      localCommit,
      remoteCommit,
      skills,
    );

    return {
      packId,
      status: 'stale',
      sourceCommit: localCommit,
      currentCommit: remoteCommit,
      ...(commitsBehind !== undefined ? { commitsBehind } : {}),
      perSkill,
    };
  } catch {
    // Defensive catch-all: drift detection must never throw.
    return unknownReport();
  }
}

// ─── validateFreshness (Requirement 60.4 / 62.2) ──────────────────────────────

/**
 * validateFreshness — run drift detection across every installed Skill_Pack
 * and return an aggregate, per-pack freshness report.
 *
 * Enumerates the on-disk cache via {@link findInstalledPacks} (the same layout
 * walker `checkDrift` resolves through) and runs {@link checkDrift} for each
 * resolved `packId`, returning one {@link DriftReport} per pack. Packs are
 * checked concurrently; ordering of the returned array is not significant.
 *
 * Like `checkDrift`, this never throws: any unexpected failure while
 * enumerating packs resolves to an empty report list, and a failure checking
 * an individual pack resolves to an `'unknown'` report for that pack
 * (Requirement 60.4) rather than rejecting the whole batch.
 */
export async function validateFreshness(): Promise<DriftReport[]> {
  try {
    const packs = findInstalledPacks();

    return await Promise.all(
      packs.map(async (pack): Promise<DriftReport> => {
        try {
          return await checkDrift(pack.packId);
        } catch {
          // A single pack's failure must not sink the whole batch; report it
          // as 'unknown' (Requirement 60.4) and keep going.
          return { packId: pack.packId, status: 'unknown', perSkill: [] };
        }
      }),
    );
  } catch {
    // Defensive catch-all: freshness validation must never throw.
    return [];
  }
}
