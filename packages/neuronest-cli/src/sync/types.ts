// File: packages/neuronest-cli/src/sync/types.ts
//
// SyncCli type definitions for the Typed Skill Client (Item 1).
// Mirrors design § Item 1 — types only, no runtime behavior.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.7, 1.9.

/** Stable string identifier for an installed skill — file-system origin
 *  not encoded; the same skill ID may exist under both ~/.kiro/skills/
 *  and .kiro/skills/. */
export type SkillId = string;

/** Where the skill metadata was loaded from (Req 1.1, 1.9). */
export type SkillSource = 'user' | 'workspace';

/** The metadata record read from a single skill's manifest. The exact
 *  on-disk format (skill.json / package.json#neuronest / etc.) is
 *  resolved by the Skill_Registry-compatible loader; the SyncCli only
 *  consumes the normalized shape below. */
export interface SkillMetadata {
  id: SkillId;
  /** Semver string, author-supplied. */
  version: string;
  description?: string;
  /** JSON Schema for the skill's input parameters. */
  inputSchema: object;
  /** JSON Schema for the skill's output. */
  outputSchema: object;
  /** Per-parameter human-facing docs, keyed by JSON Schema property
   *  name. Used to generate JSDoc on the emitted .d.ts. */
  paramDocs?: Record<string, string>;
  /** Deprecation hint — when present, the emitted .d.ts marks the
   *  binding `@deprecated` with this string as the reason. */
  deprecated?: string;
}

/** A single discovered skill entry as it lands in the type cache. */
export interface SkillTypeCacheEntry {
  id: SkillId;
  source: SkillSource;
  /** Path to the skill's directory at scan time, normalized to a
   *  workspace-relative form when source === 'workspace' and to '~/'
   *  form when source === 'user'. Kept for diagnostic use only — the
   *  cache MUST be byte-stable across runs on machines with the same
   *  skill set, so absolute host paths never appear here (Req 1.5). */
  relPath: string;
  metadata: SkillMetadata;
}

/** The full Skill_Type_Bundle artifact pair (Req 1.2, 1.3). */
export interface SkillTypeBundle {
  cache: {
    /** Cache schema version — bumped only on breaking shape changes. */
    schemaVersion: 1;
    /** Sorted-by-id array — ordering is part of the byte-stable
     *  contract (Req 1.5). */
    skills: SkillTypeCacheEntry[];
  };
  /** Generated TypeScript declaration text (Req 1.3, 1.4). */
  dts: string;
}

/** Warnings emitted during a sync scan. */
export type SyncWarning =
  | { kind: 'malformed_metadata'; skillRelPath: string; detail: string } // Req 1.7
  | {
      kind: 'workspace_override';
      skillId: SkillId;
      userRelPath: string;
      workspaceRelPath: string;
    }; // Req 1.9

/** Result summary returned by SyncCli.run on success. */
export interface SyncSummary {
  /** Count of skills successfully written into the bundle. */
  processed: number;
  /** Count of skills skipped due to malformed metadata. */
  skipped: number;
  /** Absolute path of the type-cache file that was written. */
  cacheAbsPath: string;
  /** Absolute path of the .d.ts file that was written. */
  dtsAbsPath: string;
  /** Warnings emitted during the scan. */
  warnings: ReadonlyArray<SyncWarning>;
}

/** Options accepted by SyncCli.run. */
export interface SyncCliOptions {
  /** Workspace root resolved from cwd. The CLI walks up from cwd
   *  looking for a `.kiro/` directory; if none, the workspace dir is
   *  treated as cwd itself. */
  workspaceRoot: string;
  /** User skills root. Default: `path.join(os.homedir(), '.kiro/skills/')`. */
  userSkillsDir?: string;
  /** Override target locations (used by tests). */
  cacheOutPath?: string;
  dtsOutPath?: string;
}

/** Failure envelopes returned by SyncCli.run. */
export type SyncError =
  | { kind: 'workspace_root_invalid'; detail: string }
  | { kind: 'fs_write_failed'; path: string; detail: string }
  | { kind: 'no_skills_found' };

/**
 * The orchestrator interface for `neuronest sync`. Mirrors design § Item 1.
 *
 * Implementations scan installed skills (read-only — Req 1.6), build the
 * Skill_Type_Bundle, and atomically write both artifacts to disk
 * (write-temp + rename — Req 1.10). On success a populated SyncSummary
 * is returned; on a write failure a structured SyncError is returned and
 * any pre-existing artifacts remain at their prior contents.
 */
export interface SyncCli {
  run(
    opts: SyncCliOptions,
  ): Promise<
    { ok: true; summary: SyncSummary } | { ok: false; error: SyncError }
  >;
}
