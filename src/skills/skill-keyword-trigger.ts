/**
 * Keyword-Triggered Skill Attachment
 *
 * Matches user messages/task descriptions against configured trigger keywords
 * and attaches the corresponding skill to the agent context.
 *
 * Implements retry-once logic for attachment failures: if the first attempt
 * fails, retries once and logs an error on the second failure.
 *
 * Requirements: 1.2, 1.3, 1.6, 10.1, 10.4, 10.6
 */

import fs from 'node:fs';
import path from 'node:path';
import { type Role } from '../orchestration/role-vocabulary.js';

export interface KeywordSkillMapping {
  skillId: string;
  keywords: string[];
  roles: string[];
}

export interface SkillAttachmentResult {
  attached: boolean;
  skillId: string;
  matchedKeyword?: string;
  retried: boolean;
  error?: string;
}

/**
 * Default keyword-skill trigger mappings.
 * Each entry maps a skill to trigger keywords and eligible roles.
 * Roles are derived solely from the shared Role_Vocabulary (R10.1, R10.6).
 */
const KEYWORD_SKILL_MAPPINGS: KeywordSkillMapping[] = [
  {
    skillId: 'lean-minimalism',
    keywords: ['simplest', 'minimal', 'yagni', 'over-engineered', 'bloat', 'do less'],
    roles: ['implementer', 'reviewer'] satisfies Role[],
  },
  {
    skillId: 'adr',
    keywords: ['architecture decision', 'adr', 'design decision', 'architectural record'],
    roles: ['architect'] satisfies Role[],
  },
];

/**
 * Check if a message/task description contains any trigger keyword for a mapping.
 * Matches are case-insensitive and support multi-word keywords (e.g. "do less").
 */
export function matchKeywords(
  text: string,
  mapping: KeywordSkillMapping,
): string | null {
  const lowerText = text.toLowerCase();
  for (const keyword of mapping.keywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return null;
}

/**
 * Find all keyword-triggered skills that match a given message text and role.
 */
export function findTriggeredSkills(
  text: string,
  role: string,
): Array<{ mapping: KeywordSkillMapping; matchedKeyword: string }> {
  const results: Array<{ mapping: KeywordSkillMapping; matchedKeyword: string }> = [];

  for (const mapping of KEYWORD_SKILL_MAPPINGS) {
    // Check if the role is eligible for this skill
    if (!mapping.roles.includes(role)) {
      continue;
    }

    const matched = matchKeywords(text, mapping);
    if (matched) {
      results.push({ mapping, matchedKeyword: matched });
    }
  }

  return results;
}

/**
 * Load the skill content for attachment to agent context.
 * Returns null if the skill file doesn't exist or can't be read.
 */
function loadSkillContent(skillId: string): string | null {
  const skillPath = path.resolve(
    __dirname,
    '../data/bundled-catalog/skills',
    `${skillId}.md`,
  );

  try {
    if (!fs.existsSync(skillPath)) {
      return null;
    }
    return fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Attach a skill to the agent context with retry-once logic.
 *
 * If the first attachment attempt fails (e.g. due to I/O error, missing file,
 * or context injection failure), retries once. If the retry also fails,
 * logs an error and returns a failure result.
 *
 * Requirement 1.6: retry attachment once, log error on second failure.
 */
export function attachSkillWithRetry(
  skillId: string,
  contextInjector: (content: string) => boolean,
): SkillAttachmentResult {
  const content = loadSkillContent(skillId);

  if (!content) {
    console.error(
      `[SkillKeywordTrigger] Skill file not found or unreadable: ${skillId}`,
    );
    return {
      attached: false,
      skillId,
      retried: false,
      error: `Skill file not found: ${skillId}`,
    };
  }

  // First attempt
  try {
    const success = contextInjector(content);
    if (success) {
      return { attached: true, skillId, retried: false };
    }
  } catch (err: any) {
    // First attempt failed — will retry
    console.warn(
      `[SkillKeywordTrigger] First attachment attempt failed for ${skillId}: ${err?.message}`,
    );
  }

  // Retry once (Requirement 1.6)
  try {
    const success = contextInjector(content);
    if (success) {
      return { attached: true, skillId, retried: true };
    }
  } catch (err: any) {
    // Second failure — log error
    console.error(
      `[SkillKeywordTrigger] Skill attachment failed after retry for ${skillId}: ${err?.message}`,
    );
    return {
      attached: false,
      skillId,
      retried: true,
      error: `Attachment failed after retry: ${err?.message}`,
    };
  }

  // contextInjector returned false on both attempts
  console.error(
    `[SkillKeywordTrigger] Skill attachment returned false after retry for ${skillId}`,
  );
  return {
    attached: false,
    skillId,
    retried: true,
    error: 'Context injector returned false on both attempts',
  };
}

/**
 * Process a message/task for keyword-triggered skill attachment.
 *
 * Given a user message and the agent's role, checks for keyword matches
 * and attaches matching skills with retry-once logic.
 *
 * Returns all attachment results (both successful and failed).
 */
export function processKeywordSkillAttachment(
  text: string,
  role: string,
  contextInjector: (content: string) => boolean,
): SkillAttachmentResult[] {
  const triggered = findTriggeredSkills(text, role);
  const results: SkillAttachmentResult[] = [];

  for (const { mapping, matchedKeyword } of triggered) {
    const result = attachSkillWithRetry(mapping.skillId, contextInjector);
    result.matchedKeyword = matchedKeyword;
    results.push(result);
  }

  return results;
}

/**
 * Get all configured keyword-skill mappings.
 * Useful for testing and inspection.
 */
export function getKeywordSkillMappings(): KeywordSkillMapping[] {
  return [...KEYWORD_SKILL_MAPPINGS];
}
