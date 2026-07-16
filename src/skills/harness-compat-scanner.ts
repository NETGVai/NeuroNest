/**
 * Harness Compatibility Scanner — discovers skills and rules from foreign
 * agent ecosystems (Claude, Cursor, Agents, NeuroNest) across CWD, repo,
 * and home tiers.
 *
 * Discovery paths:
 * - Skills: .neuronest/skills, .agents/skills, .claude/skills, .cursor/skills
 * - Rules: AGENTS.md, CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md, NEURONEST.md
 * - Commands: commands/*.md registered as slash commands
 *
 * Priority system:
 * - CWD tier (3) > Repo tier (2) > Home tier (1)
 * - Native NeuroNest skills win equal-tier conflicts
 *
 * Key behaviors:
 * - No .gitignore filtering (Req 16.5)
 * - Settings: compat.claude, compat.cursor (default on), ignorePaths, disabled skills
 * - Environment variable overrides for CI (Req 16.7)
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

export type DiscoveryTier = 'cwd' | 'repo' | 'home';
export type SkillOrigin = 'neuronest' | 'agents' | 'claude' | 'cursor';

export interface ForeignSkill {
  /** Unique id derived from filename (stem, lowercase, dashes) */
  id: string;
  /** Display name */
  name: string;
  /** Origin ecosystem */
  origin: SkillOrigin;
  /** Discovery tier priority: cwd=3, repo=2, home=1 */
  tier: DiscoveryTier;
  /** Numeric priority for conflict resolution */
  priority: number;
  /** Absolute path to the skill file */
  filePath: string;
  /** Raw content of the skill file */
  content: string;
  /** Whether this is a native NeuroNest skill (wins equal-tier conflicts) */
  isNative: boolean;
}

export interface ForeignRuleFile {
  /** Source filename (e.g., CLAUDE.md, AGENTS.md) */
  filename: string;
  /** Origin ecosystem */
  origin: SkillOrigin;
  /** Discovery tier */
  tier: DiscoveryTier;
  /** Absolute path to the rule file */
  filePath: string;
  /** Raw content */
  content: string;
}

export interface SlashCommandDef {
  /** Command name derived from filename stem */
  name: string;
  /** Origin ecosystem */
  origin: SkillOrigin;
  /** Absolute path */
  filePath: string;
  /** Raw content (markdown) */
  content: string;
}

export interface CompatWarning {
  /** Warning type */
  type: 'conflict' | 'parse-error' | 'never-touch-conflict' | 'missing-dir';
  /** Human-readable message */
  message: string;
  /** Affected file path */
  filePath?: string;
}

export interface CompatDiscoveryResult {
  skills: ForeignSkill[];
  rules: ForeignRuleFile[];
  commands: SlashCommandDef[];
  warnings: CompatWarning[];
}

export interface CompatSettings {
  /** Enable Claude ecosystem discovery. Default: true */
  claude: boolean;
  /** Enable Cursor ecosystem discovery. Default: true */
  cursor: boolean;
  /** Additional paths to scan for skills */
  additionalPaths: string[];
  /** Paths to ignore during discovery */
  ignorePaths: string[];
  /** Skill names to disable */
  disabledSkills: string[];
}

// ─── Constants ──────────────────────────────────────────────────

const TIER_PRIORITY: Record<DiscoveryTier, number> = {
  cwd: 3,
  repo: 2,
  home: 1,
};

const SKILL_DIRS: Record<SkillOrigin, string> = {
  neuronest: '.neuronest/skills',
  agents: '.agents/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
};

const RULE_FILES: { filename: string; origin: SkillOrigin }[] = [
  { filename: 'NEURONEST.md', origin: 'neuronest' },
  { filename: 'AGENTS.md', origin: 'agents' },
  { filename: 'CLAUDE.md', origin: 'claude' },
  { filename: 'CLAUDE.local.md', origin: 'claude' },
];

const CLAUDE_RULES_DIR = '.claude/rules';

const DEFAULT_SETTINGS: CompatSettings = {
  claude: true,
  cursor: true,
  additionalPaths: [],
  ignorePaths: [],
  disabledSkills: [],
};

// ─── Environment Variable Overrides ─────────────────────────────

function getSettingsFromEnv(): Partial<CompatSettings> {
  const overrides: Partial<CompatSettings> = {};

  if (process.env['NEURONEST_COMPAT_CLAUDE'] !== undefined) {
    overrides.claude = process.env['NEURONEST_COMPAT_CLAUDE'] !== '0' &&
      process.env['NEURONEST_COMPAT_CLAUDE']!.toLowerCase() !== 'false';
  }
  if (process.env['NEURONEST_COMPAT_CURSOR'] !== undefined) {
    overrides.cursor = process.env['NEURONEST_COMPAT_CURSOR'] !== '0' &&
      process.env['NEURONEST_COMPAT_CURSOR']!.toLowerCase() !== 'false';
  }
  if (process.env['NEURONEST_COMPAT_IGNORE_PATHS']) {
    overrides.ignorePaths = process.env['NEURONEST_COMPAT_IGNORE_PATHS']
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (process.env['NEURONEST_COMPAT_DISABLED_SKILLS']) {
    overrides.disabledSkills = process.env['NEURONEST_COMPAT_DISABLED_SKILLS']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env['NEURONEST_COMPAT_ADDITIONAL_PATHS']) {
    overrides.additionalPaths = process.env['NEURONEST_COMPAT_ADDITIONAL_PATHS']
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  return overrides;
}

// ─── Helpers ────────────────────────────────────────────────────

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Derive a skill ID from a filename.
 * e.g., "My Cool Skill.md" → "my-cool-skill"
 */
function fileToSkillId(filename: string): string {
  const stem = path.basename(filename, path.extname(filename));
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check if a path should be ignored based on settings.
 */
function shouldIgnore(filePath: string, ignorePaths: string[]): boolean {
  for (const pattern of ignorePaths) {
    if (filePath.includes(pattern)) return true;
  }
  return false;
}

// ─── Scanner ────────────────────────────────────────────────────

export class HarnessCompatScanner {
  private settings: CompatSettings;

  constructor(userSettings?: Partial<CompatSettings>) {
    const envOverrides = getSettingsFromEnv();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...userSettings,
      ...envOverrides,
    };
  }

  /**
   * Perform full compatibility discovery.
   *
   * @param projectRoot - The project/repo root directory (repo tier)
   * @param cwd - Current working directory (CWD tier). Defaults to projectRoot.
   */
  scan(projectRoot: string, cwd?: string): CompatDiscoveryResult {
    const effectiveCwd = cwd || projectRoot;
    const homeDir = os.homedir();

    const result: CompatDiscoveryResult = {
      skills: [],
      rules: [],
      commands: [],
      warnings: [],
    };

    // Build tier directories (CWD → repo → home)
    const tiers: { dir: string; tier: DiscoveryTier }[] = [];

    // CWD tier (priority 3) — only if different from project root
    if (effectiveCwd !== projectRoot) {
      tiers.push({ dir: effectiveCwd, tier: 'cwd' });
    } else {
      // When CWD == projectRoot, treat as CWD tier for highest priority
      tiers.push({ dir: effectiveCwd, tier: 'cwd' });
    }

    // Repo tier (priority 2) — only add if different from CWD
    if (projectRoot !== effectiveCwd) {
      tiers.push({ dir: projectRoot, tier: 'repo' });
    }

    // Home tier (priority 1)
    tiers.push({ dir: homeDir, tier: 'home' });

    // Discover skills from all origins and tiers
    this.discoverSkills(tiers, result);

    // Discover rule files
    this.discoverRules(tiers, result);

    // Discover slash commands
    this.discoverCommands(tiers, result);

    // Discover from additional paths (treated as CWD tier)
    for (const additionalPath of this.settings.additionalPaths) {
      const resolvedPath = path.resolve(additionalPath);
      if (dirExists(resolvedPath)) {
        this.discoverSkills([{ dir: resolvedPath, tier: 'cwd' }], result);
      }
    }

    // Resolve conflicts (higher priority wins; native wins equal-tier)
    result.skills = this.resolveConflicts(result.skills);

    // Filter disabled skills
    result.skills = result.skills.filter(
      (s) => !this.settings.disabledSkills.includes(s.id) &&
             !this.settings.disabledSkills.includes(s.name),
    );

    return result;
  }

  // ─── Skill Discovery ───────────────────────────────────────────

  private discoverSkills(
    tiers: { dir: string; tier: DiscoveryTier }[],
    result: CompatDiscoveryResult,
  ): void {
    const origins = this.getEnabledOrigins();

    for (const { dir, tier } of tiers) {
      for (const origin of origins) {
        const skillDir = path.join(dir, SKILL_DIRS[origin]);

        if (!dirExists(skillDir)) continue;

        const entries = safeReadDir(skillDir);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;

          const filePath = path.join(skillDir, entry);
          if (!fileExists(filePath)) continue;
          if (shouldIgnore(filePath, this.settings.ignorePaths)) continue;

          const content = safeReadFile(filePath);
          if (content === null) {
            result.warnings.push({
              type: 'parse-error',
              message: `Failed to read skill file: ${filePath}`,
              filePath,
            });
            continue;
          }

          const id = fileToSkillId(entry);
          const name = path.basename(entry, '.md');

          result.skills.push({
            id,
            name,
            origin,
            tier,
            priority: TIER_PRIORITY[tier],
            filePath,
            content,
            isNative: origin === 'neuronest',
          });
        }
      }
    }
  }

  // ─── Rule File Discovery ───────────────────────────────────────

  private discoverRules(
    tiers: { dir: string; tier: DiscoveryTier }[],
    result: CompatDiscoveryResult,
  ): void {
    for (const { dir, tier } of tiers) {
      // Standard rule files
      for (const ruleSpec of RULE_FILES) {
        if (!this.isOriginEnabled(ruleSpec.origin)) continue;

        const filePath = path.join(dir, ruleSpec.filename);
        if (!fileExists(filePath)) continue;
        if (shouldIgnore(filePath, this.settings.ignorePaths)) continue;

        const content = safeReadFile(filePath);
        if (content === null) continue;

        result.rules.push({
          filename: ruleSpec.filename,
          origin: ruleSpec.origin,
          tier,
          filePath,
          content,
        });
      }

      // .claude/rules/*.md (additional Claude rule files)
      if (this.settings.claude) {
        const claudeRulesDir = path.join(dir, CLAUDE_RULES_DIR);
        if (dirExists(claudeRulesDir)) {
          const entries = safeReadDir(claudeRulesDir);
          for (const entry of entries) {
            if (!entry.endsWith('.md')) continue;
            const filePath = path.join(claudeRulesDir, entry);
            if (!fileExists(filePath)) continue;
            if (shouldIgnore(filePath, this.settings.ignorePaths)) continue;

            const content = safeReadFile(filePath);
            if (content === null) continue;

            result.rules.push({
              filename: `.claude/rules/${entry}`,
              origin: 'claude',
              tier,
              filePath,
              content,
            });
          }
        }
      }
    }
  }

  // ─── Slash Command Discovery ───────────────────────────────────

  private discoverCommands(
    tiers: { dir: string; tier: DiscoveryTier }[],
    result: CompatDiscoveryResult,
  ): void {
    const origins = this.getEnabledOrigins();

    for (const { dir } of tiers) {
      for (const origin of origins) {
        // Commands live under the same parent as skills
        // e.g., .neuronest/commands/, .claude/commands/, .cursor/commands/
        const parentDir = SKILL_DIRS[origin].split('/')[0] || ''; // .neuronest, .agents, .claude, .cursor
        const commandsDir = path.join(dir, parentDir, 'commands');

        if (!dirExists(commandsDir)) continue;

        const entries = safeReadDir(commandsDir);
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;

          const filePath = path.join(commandsDir, entry);
          if (!fileExists(filePath)) continue;
          if (shouldIgnore(filePath, this.settings.ignorePaths)) continue;

          const content = safeReadFile(filePath);
          if (content === null) continue;

          const commandName = path.basename(entry, '.md');

          result.commands.push({
            name: commandName,
            origin,
            filePath,
            content,
          });
        }
      }
    }
  }

  // ─── Conflict Resolution ───────────────────────────────────────

  /**
   * Resolve skill conflicts by case-insensitive name.
   * Higher-priority tier wins. Native NeuroNest skills win equal-tier conflicts.
   */
  private resolveConflicts(skills: ForeignSkill[]): ForeignSkill[] {
    const byName = new Map<string, ForeignSkill>();

    for (const skill of skills) {
      const key = skill.id.toLowerCase();
      const existing = byName.get(key);

      if (!existing) {
        byName.set(key, skill);
        continue;
      }

      // Higher priority wins
      if (skill.priority > existing.priority) {
        byName.set(key, skill);
      } else if (skill.priority === existing.priority) {
        // Equal tier: native NeuroNest wins
        if (skill.isNative && !existing.isNative) {
          byName.set(key, skill);
        }
        // If both native or both foreign at same tier, first discovered wins
      }
    }

    return Array.from(byName.values());
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private getEnabledOrigins(): SkillOrigin[] {
    const origins: SkillOrigin[] = ['neuronest', 'agents'];
    if (this.settings.claude) origins.push('claude');
    if (this.settings.cursor) origins.push('cursor');
    return origins;
  }

  private isOriginEnabled(origin: SkillOrigin): boolean {
    if (origin === 'neuronest' || origin === 'agents') return true;
    if (origin === 'claude') return this.settings.claude;
    if (origin === 'cursor') return this.settings.cursor;
    return false;
  }
}

// ─── Convenience Function ───────────────────────────────────────

/**
 * Scan a project for compatible skills, rules, and commands.
 * Convenience wrapper around HarnessCompatScanner.
 */
export function scanForCompatibility(
  projectRoot: string,
  settings?: Partial<CompatSettings>,
): CompatDiscoveryResult {
  const scanner = new HarnessCompatScanner(settings);
  return scanner.scan(projectRoot);
}
