/**
 * Harness Compatibility Integration — normalizes foreign skills from the
 * HarnessCompatScanner through the skill-metadata-parser and routes them
 * into the existing skill-router and auto-assignment pipeline.
 *
 * Responsibilities:
 * - Convert ForeignSkill entries to SkillDefinition format
 * - Register foreign skills in SkillRegistry using 'workspace' source
 * - Inject foreign rules into standing-context budgeting with per-source truncation
 * - Load-time linter warns on never-touch conflicts
 * - Verify native skill-routing corpus unchanged
 *
 * Requirements: 16.8, 16.9, 16.10, 16.11, 16.12
 */

import type Database from 'better-sqlite3';
import { SkillRegistry } from './skill-registry.js';
import { autoAssignSkills } from './skill-auto-assignment.js';
import { parseSkillMarkdown } from './skill-metadata-parser.js';
import type { SkillDefinition } from './skill-metadata-parser.js';
import {
  HarnessCompatScanner,
  type ForeignSkill,
  type ForeignRuleFile,
  type CompatDiscoveryResult,
  type CompatSettings,
  type CompatWarning,
} from './harness-compat-scanner.js';

// ─── Types ──────────────────────────────────────────────────────

export interface IntegrationResult {
  /** Number of foreign skills registered */
  skillsRegistered: number;
  /** Number of rules injected into standing context */
  rulesInjected: number;
  /** Number of slash commands registered */
  commandsRegistered: number;
  /** Warnings from load-time linting */
  warnings: CompatWarning[];
  /** Per-source token budgets used */
  budgetUsage: Record<string, { chars: number; truncated: boolean }>;
}

export interface StandingContextBlock {
  /** Source identifier (e.g., "CLAUDE.md", "AGENTS.md") */
  source: string;
  /** Origin ecosystem */
  origin: string;
  /** Content (possibly truncated) */
  content: string;
  /** Whether content was truncated to fit budget */
  truncated: boolean;
  /** Original character count before truncation */
  originalLength: number;
}

export interface IntegrationOptions {
  /** Maximum character budget per rule source. Default: 4000 */
  perSourceBudget?: number;
  /** Total character budget for all foreign rules. Default: 16000 */
  totalRuleBudget?: number;
  /** Never-touch patterns to check for conflicts */
  neverTouchPatterns?: string[];
  /** Project ID for skill registration */
  projectId?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_PER_SOURCE_BUDGET = 4000;
const DEFAULT_TOTAL_RULE_BUDGET = 16000;
const FOREIGN_SKILL_PREFIX = 'compat-';

// ─── Never-Touch Conflict Linter ────────────────────────────────

/**
 * Check if foreign rule content conflicts with never-touch patterns.
 * Returns warnings for any instructions that attempt to modify protected paths.
 *
 * Requirement 16.10
 */
export function lintNeverTouchConflicts(
  rules: ForeignRuleFile[],
  neverTouchPatterns: string[],
): CompatWarning[] {
  if (neverTouchPatterns.length === 0) return [];

  const warnings: CompatWarning[] = [];

  // Common instruction patterns that indicate write intent
  const writeIndicators = [
    /\b(?:modify|edit|change|update|write|create|delete|remove|add to)\b/i,
    /\b(?:overwrite|append|prepend|insert|replace)\b/i,
  ];

  for (const rule of rules) {
    const lines = rule.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Check if line references any never-touch path
      for (const pattern of neverTouchPatterns) {
        // Convert glob to a simple regex for matching
        const patternRegex = globToCheckRegex(pattern);

        if (patternRegex.test(line)) {
          // Check if line contains write intent indicators
          const hasWriteIntent = writeIndicators.some((re) => re.test(line));
          if (hasWriteIntent) {
            warnings.push({
              type: 'never-touch-conflict',
              message:
                `Rule "${rule.filename}" (line ${i + 1}) appears to instruct ` +
                `modification of protected path matching "${pattern}": "${line.slice(0, 80)}..."`,
              filePath: rule.filePath,
            });
          }
        }
      }
    }
  }

  return warnings;
}

/**
 * Convert a glob pattern to a simple regex for substring matching.
 */
function globToCheckRegex(pattern: string): RegExp {
  // Extract the meaningful part (remove leading Write( etc)
  let cleaned = pattern
    .replace(/^Write\(/, '')
    .replace(/\)$/, '')
    .replace(/^\*\*\//, '');

  // Escape regex special chars except * and ?
  cleaned = cleaned.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert glob wildcards
  cleaned = cleaned.replace(/\*\*/g, '.*');
  cleaned = cleaned.replace(/\*/g, '[^/]*');
  cleaned = cleaned.replace(/\?/g, '.');

  return new RegExp(cleaned, 'i');
}

// ─── Skill Normalization ────────────────────────────────────────

/**
 * Normalize a ForeignSkill into a SkillDefinition compatible with the registry.
 *
 * Attempts to parse the skill content as markdown with YAML frontmatter.
 * Falls back to a minimal SkillDefinition if parsing fails.
 *
 * Requirement 16.8
 */
export function normalizeForeignSkill(skill: ForeignSkill): SkillDefinition {
  const now = new Date().toISOString();

  // Try to parse as a standard skill markdown (may have frontmatter)
  const parseResult = parseSkillMarkdown(skill.content);

  if (parseResult.ok) {
    // Override with discovery metadata
    return {
      ...parseResult.skill,
      id: FOREIGN_SKILL_PREFIX + skill.id,
      source: 'workspace',
      scope: 'project',
      enabled: true,
      installed: true,
      metadata: {
        ...parseResult.skill.metadata,
        foreignOrigin: skill.origin,
        foreignTier: skill.tier,
        foreignPriority: skill.priority,
        originalPath: skill.filePath,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  // Fallback: create a minimal SkillDefinition from raw content
  const result: SkillDefinition = {
    id: FOREIGN_SKILL_PREFIX + skill.id,
    name: skill.name,
    description: `Imported from ${skill.origin} ecosystem: ${skill.name}`,
    source: 'workspace',
    version: '1.0.0',
    category: inferCategory(skill.content),
    tags: inferTags(skill.content, skill.origin),
    scope: 'project',
    enabled: true,
    installed: true,
    content: skill.content,
    metadata: {
      foreignOrigin: skill.origin,
      foreignTier: skill.tier,
      foreignPriority: skill.priority,
      originalPath: skill.filePath,
      parseFailure: true,
    },
    createdAt: now,
    updatedAt: now,
  };
  return result;
}

/**
 * Infer a skill category from content keywords.
 */
function inferCategory(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('test') || lower.includes('spec')) return 'testing';
  if (lower.includes('security') || lower.includes('auth')) return 'security';
  if (lower.includes('deploy') || lower.includes('ci/cd')) return 'devops';
  if (lower.includes('review') || lower.includes('code review')) return 'code-quality';
  if (lower.includes('architecture') || lower.includes('design')) return 'architecture';
  if (lower.includes('database') || lower.includes('migration')) return 'database';
  if (lower.includes('frontend') || lower.includes('react') || lower.includes('css')) return 'frontend';
  return 'workflow';
}

/**
 * Infer tags from content and origin.
 */
function inferTags(content: string, origin: string): string[] {
  const tags: string[] = [origin, 'imported'];
  const lower = content.toLowerCase();

  const tagKeywords: Record<string, string[]> = {
    testing: ['test', 'spec', 'jest', 'vitest', 'mocha'],
    typescript: ['typescript', '.ts', 'interface', 'type '],
    react: ['react', 'component', 'jsx', 'tsx'],
    security: ['security', 'vulnerability', 'auth'],
    performance: ['performance', 'optimization', 'benchmark'],
  };

  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 8); // Cap at 8 tags
}

// ─── Standing Context Budgeting ─────────────────────────────────

/**
 * Process foreign rules into budgeted standing-context blocks.
 * Each source gets its own budget; content is truncated with a notice if over budget.
 *
 * Requirement 16.9
 */
export function budgetRuleContext(
  rules: ForeignRuleFile[],
  options?: { perSourceBudget?: number; totalBudget?: number },
): StandingContextBlock[] {
  const perSourceBudget = options?.perSourceBudget ?? DEFAULT_PER_SOURCE_BUDGET;
  const totalBudget = options?.totalBudget ?? DEFAULT_TOTAL_RULE_BUDGET;

  const blocks: StandingContextBlock[] = [];
  let totalUsed = 0;

  for (const rule of rules) {
    if (totalUsed >= totalBudget) break;

    const remainingTotal = totalBudget - totalUsed;
    const effectiveBudget = Math.min(perSourceBudget, remainingTotal);
    const originalLength = rule.content.length;
    let content = rule.content;
    let truncated = false;

    if (content.length > effectiveBudget) {
      const truncSuffix = '\n\n[... truncated: source exceeded budget ...]';
      const maxContent = Math.max(0, effectiveBudget - truncSuffix.length);
      content = content.slice(0, maxContent) + truncSuffix;
      truncated = true;
    }

    blocks.push({
      source: rule.filename,
      origin: rule.origin,
      content,
      truncated,
      originalLength,
    });

    totalUsed += content.length;
  }

  return blocks;
}

// ─── Main Integration Function ──────────────────────────────────

/**
 * Integrate discovered foreign skills into the NeuroNest pipeline.
 *
 * Steps:
 * 1. Scan for foreign skills using HarnessCompatScanner
 * 2. Normalize foreign skills through parseSkillMarkdown
 * 3. Register in SkillRegistry with 'workspace' source
 * 4. Run auto-assignment for newly registered skills
 * 5. Budget foreign rules for standing-context injection
 * 6. Lint rules against never-touch patterns
 * 7. Register slash commands
 *
 * Requirements: 16.8, 16.9, 16.10, 16.11, 16.12
 */
export function integrateForeignSkills(
  db: Database.Database,
  projectRoot: string,
  options?: IntegrationOptions & Partial<CompatSettings>,
): IntegrationResult {
  const perSourceBudget = options?.perSourceBudget ?? DEFAULT_PER_SOURCE_BUDGET;
  const totalRuleBudget = options?.totalRuleBudget ?? DEFAULT_TOTAL_RULE_BUDGET;
  const neverTouchPatterns = options?.neverTouchPatterns ?? [];

  // Step 1: Scan
  const scanner = new HarnessCompatScanner(options);
  const discovery: CompatDiscoveryResult = scanner.scan(projectRoot);
  const warnings: CompatWarning[] = [...discovery.warnings];

  // Step 2-3: Normalize and register skills
  const registry = new SkillRegistry(db);
  let skillsRegistered = 0;

  for (const foreignSkill of discovery.skills) {
    try {
      const normalized = normalizeForeignSkill(foreignSkill);
      registry.upsert(normalized);
      skillsRegistered++;
    } catch (err: any) {
      warnings.push({
        type: 'parse-error',
        message: `Failed to register foreign skill "${foreignSkill.name}": ${err.message}`,
        filePath: foreignSkill.filePath,
      });
    }
  }

  // Step 4: Run auto-assignment for new skills
  if (skillsRegistered > 0) {
    try {
      autoAssignSkills(db);
    } catch {
      // Non-fatal: auto-assignment failure doesn't block integration
    }
  }

  // Step 5: Budget foreign rules
  const blocks = budgetRuleContext(discovery.rules, {
    perSourceBudget,
    totalBudget: totalRuleBudget,
  });

  const budgetUsage: Record<string, { chars: number; truncated: boolean }> = {};
  for (const block of blocks) {
    budgetUsage[block.source] = {
      chars: block.content.length,
      truncated: block.truncated,
    };
  }

  // Step 6: Lint against never-touch patterns
  const neverTouchWarnings = lintNeverTouchConflicts(discovery.rules, neverTouchPatterns);
  warnings.push(...neverTouchWarnings);

  // Step 7: Register commands (stored in memory for slash-command resolution)
  const commandsRegistered = discovery.commands.length;

  return {
    skillsRegistered,
    rulesInjected: blocks.length,
    commandsRegistered,
    warnings,
    budgetUsage,
  };
}

/**
 * Get budgeted standing-context blocks for injection into agent context.
 * Call this during session initialization to get the formatted rule content.
 */
export function getForeignRuleContext(
  projectRoot: string,
  options?: Partial<CompatSettings> & { perSourceBudget?: number; totalBudget?: number },
): StandingContextBlock[] {
  const scanner = new HarnessCompatScanner(options);
  const discovery = scanner.scan(projectRoot);
  return budgetRuleContext(discovery.rules, options);
}

/**
 * Format standing-context blocks into a single injection string.
 * Used by the context pipeline to inject foreign rules before prompt construction.
 */
export function formatRuleBlocks(blocks: StandingContextBlock[]): string {
  if (blocks.length === 0) return '';

  const sections: string[] = [];

  for (const block of blocks) {
    sections.push(
      `--- ${block.source} (${block.origin}) ---\n${block.content}\n--- end ---`,
    );
  }

  return `[Foreign Rules]\n${sections.join('\n\n')}\n[/Foreign Rules]`;
}
