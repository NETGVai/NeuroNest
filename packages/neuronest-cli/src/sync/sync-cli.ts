// File: packages/neuronest-cli/src/sync/sync-cli.ts
//
// SyncCli orchestrator: wires the scanner (1.5) → cache serializer (1.6)
// → .d.ts emitter (1.7) → atomic disk writes for both Skill_Type_Bundle
// artifacts. Pure read-only against skill payloads (Req 1.6); writes are
// performed via write-temp + rename so any pre-existing artifact is left
// unchanged on failure (Req 1.10).
//
// Validates: Requirements 1.2, 1.3, 1.5, 1.7, 1.8, 1.10.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { serializeCache } from './cache-serializer.js';
import { emitDts } from './dts-emitter.js';
import { scanSkills } from './scanner.js';
import type {
  SkillTypeBundle,
  SkillTypeCacheEntry,
  SyncCli as SyncCliType,
  SyncCliOptions,
  SyncError,
  SyncSummary,
  SyncWarning,
} from './types.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Default cache file name written at the workspace root. */
const CACHE_FILENAME = '.neuronest-types.json';

/** Default `.d.ts` location relative to the workspace root. */
const DTS_REL_PATH = path.join('node_modules', '@neuronest', 'skills', 'index.d.ts');

/** Mode used when creating `node_modules/@neuronest/skills/` (Req 1.10). */
const SKILLS_DIR_MODE = 0o755;

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

/**
 * Run the typed-skill-client sync end-to-end.
 *
 * Pipeline:
 *   1. Scan installed skill metadata under both roots (read-only — Req 1.6).
 *   2. Build the `SkillTypeBundle.cache` and serialize it deterministically
 *      (Req 1.2, 1.5).
 *   3. Emit the `.d.ts` text (Req 1.3, 1.4, 1.5). The emitter may flag
 *      PascalCase collisions as `malformed_metadata` warnings and skip the
 *      colliding skills from the .d.ts; those skills are also excluded from
 *      the cache so the two artifacts stay consistent.
 *   4. Ensure `node_modules/@neuronest/skills/` exists, creating it with
 *      mode 0o755 if necessary (Req 1.10).
 *   5. Atomically write both files (write-temp + rename). If any write
 *      fails, return `{ ok: false; error: { kind: 'fs_write_failed' } }`
 *      and leave any pre-existing artifact at its prior contents.
 *   6. Print the summary to stdout and warnings to stderr (Req 1.7, 1.8),
 *      and return the structured `SyncSummary`.
 */
export async function runSync(
  opts: SyncCliOptions,
): Promise<{ ok: true; summary: SyncSummary } | { ok: false; error: SyncError }> {
  // 1. Validate the workspace root.
  const workspaceCheck = await validateWorkspaceRoot(opts.workspaceRoot);
  if (!workspaceCheck.ok) {
    return { ok: false, error: workspaceCheck.error };
  }

  // 2. Resolve absolute output paths.
  const cacheAbsPath = path.resolve(
    opts.cacheOutPath ?? path.join(opts.workspaceRoot, CACHE_FILENAME),
  );
  const dtsAbsPath = path.resolve(
    opts.dtsOutPath ?? path.join(opts.workspaceRoot, DTS_REL_PATH),
  );

  // 3. Scan skills (read-only).
  const scanResult = await scanSkills(opts);

  // 4. Emit the .d.ts (may add malformed_metadata warnings for PascalCase
  //    collisions; colliding skills are skipped from the .d.ts).
  const dtsResult = emitDts(scanResult.entries);

  // 5. Filter cache entries to mirror the .d.ts: skills the emitter
  //    rejected (PascalCase collisions) are excluded from the cache so the
  //    two artifacts describe the same skill set.
  const rejectedRelPaths = new Set<string>(
    dtsResult.warnings
      .filter((w) => w.kind === 'malformed_metadata')
      .map((w) => (w as { skillRelPath: string }).skillRelPath),
  );
  const acceptedEntries: SkillTypeCacheEntry[] = scanResult.entries.filter(
    (e) => !rejectedRelPaths.has(e.relPath),
  );

  // 6. Serialize the cache (byte-stable — Req 1.5).
  const cache: SkillTypeBundle['cache'] = {
    schemaVersion: 1,
    skills: acceptedEntries,
  };
  const cacheText = serializeCache(cache);
  const dtsText = dtsResult.dts;

  // 7. Combine warnings from scanner + emitter.
  const warnings: SyncWarning[] = [...scanResult.warnings, ...dtsResult.warnings];

  // 8. Ensure `node_modules/@neuronest/skills/` exists before writing the
  //    .d.ts (Req 1.10). The cache file's parent dir is the workspace root,
  //    which validateWorkspaceRoot already confirmed exists.
  try {
    await fs.mkdir(path.dirname(dtsAbsPath), {
      recursive: true,
      mode: SKILLS_DIR_MODE,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'fs_write_failed',
        path: path.dirname(dtsAbsPath),
        detail: describeError(err),
      },
    };
  }

  // 9. Write both artifacts atomically. Cache first, then .d.ts. If either
  //    write fails, return early — the other artifact is either unchanged
  //    (cache failed) or already replaced (cache succeeded but .d.ts
  //    failed; cache replacement is still atomic and consistent on its
  //    own). Atomic rename guarantees no partial files are visible.
  const cacheWrite = await atomicWrite(cacheAbsPath, cacheText);
  if (!cacheWrite.ok) {
    return { ok: false, error: cacheWrite.error };
  }

  const dtsWrite = await atomicWrite(dtsAbsPath, dtsText);
  if (!dtsWrite.ok) {
    return { ok: false, error: dtsWrite.error };
  }

  // 10. Build the summary.
  const summary: SyncSummary = {
    processed: acceptedEntries.length,
    skipped: countSkipped(warnings),
    cacheAbsPath,
    dtsAbsPath,
    warnings,
  };

  // 11. Print summary to stdout, warnings to stderr (Req 1.7, 1.8).
  printSummary(summary);
  printWarnings(warnings);

  return { ok: true, summary };
}

/**
 * Frozen value implementing the `SyncCli` interface.
 *
 * The interface accepts a single `run(opts)` method; freezing prevents
 * downstream callers from monkey-patching the dispatcher.
 */
export const SyncCli: SyncCliType = Object.freeze({ run: runSync });

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Validate that `workspaceRoot` exists and is a directory. Returns a
 * structured error otherwise.
 */
async function validateWorkspaceRoot(
  workspaceRoot: string,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'workspace_root_invalid',
        detail: 'workspaceRoot must be a non-empty string',
      },
    };
  }
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: {
          kind: 'workspace_root_invalid',
          detail: `${workspaceRoot}: not a directory`,
        },
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'workspace_root_invalid',
        detail: `${workspaceRoot}: ${describeError(err)}`,
      },
    };
  }
  return { ok: true };
}

/**
 * Atomically replace the file at `targetPath` with `contents`.
 *
 * Strategy: write a uniquely named temp file in the same directory, then
 * `fs.rename` it onto the target. On POSIX `rename(2)` is atomic when both
 * paths reside on the same filesystem; on Windows Node's `fs.rename`
 * delegates to `MoveFileEx(REPLACE_EXISTING)` which is also atomic for
 * same-volume moves. Either way, a partial `targetPath` is never observed
 * by other processes — on failure the previous content of `targetPath`
 * remains (Req 1.10).
 *
 * Best-effort cleanup: if the rename fails, the temp file is removed so
 * the workspace is not littered with `.tmp-*` debris.
 */
async function atomicWrite(
  targetPath: string,
  contents: string,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempName = `.${base}.tmp-${process.pid}-${crypto
    .randomBytes(8)
    .toString('hex')}`;
  const tempPath = path.join(dir, tempName);

  try {
    await fs.writeFile(tempPath, contents, { encoding: 'utf8' });
  } catch (err) {
    // Temp file may or may not exist; cleanup best-effort.
    await safeUnlink(tempPath);
    return {
      ok: false,
      error: {
        kind: 'fs_write_failed',
        path: targetPath,
        detail: describeError(err),
      },
    };
  }

  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    await safeUnlink(tempPath);
    return {
      ok: false,
      error: {
        kind: 'fs_write_failed',
        path: targetPath,
        detail: describeError(err),
      },
    };
  }

  return { ok: true };
}

/** Best-effort temp-file cleanup; ignores ENOENT and other failures. */
async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // Intentional: cleanup is best-effort.
  }
}

/** Count the number of skills skipped due to malformed metadata. */
function countSkipped(warnings: ReadonlyArray<SyncWarning>): number {
  let n = 0;
  for (const w of warnings) {
    if (w.kind === 'malformed_metadata') n += 1;
  }
  return n;
}

/**
 * Print the summary to stdout (Req 1.8). Format: a single block listing
 * the processed/skipped counts and both absolute output paths.
 */
function printSummary(summary: SyncSummary): void {
  process.stdout.write(
    `neuronest sync: processed ${summary.processed} skill(s), ` +
      `skipped ${summary.skipped}\n` +
      `  cache: ${summary.cacheAbsPath}\n` +
      `  types: ${summary.dtsAbsPath}\n`,
  );
}

/**
 * Print warnings to stderr (Req 1.7, 1.9). One line per warning. Stable
 * formatting so two consecutive runs against the same skill set produce
 * the same stderr output.
 */
function printWarnings(warnings: ReadonlyArray<SyncWarning>): void {
  for (const w of warnings) {
    if (w.kind === 'malformed_metadata') {
      process.stderr.write(
        `warning: malformed_metadata at ${w.skillRelPath}: ${w.detail}\n`,
      );
    } else {
      process.stderr.write(
        `warning: workspace_override for skill "${w.skillId}": ` +
          `using ${w.workspaceRelPath} (overrides ${w.userRelPath})\n`,
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
