/**
 * Swarm Skill Injection — matches an agent's assigned skills against the
 * task at hand and injects the matched skill's content into the agent's
 * system prompt.
 *
 * Bridges the real Agent Skills catalog (`agent_skill_assignments` +
 * `skills` tables, populated at install time — see
 * src/agent-skills/agent-skills-service.ts) into the swarm-execution prompt
 * pipeline. Both `SwarmCoordinator` and `EnhancedSwarmCoordinator` use this
 * so skill relevance-matching and injection stay consistent across both
 * execution paths.
 */

import type Database from 'better-sqlite3';

export interface AssignedSkillRow {
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillCategory: string;
  proficiencyLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
}

export interface MatchedSkill {
  skillId: string;
  skillName: string;
  /** Full skill markdown content, ready for prompt injection. */
  content: string;
  /** Which text (keyword) triggered the match, for logging/telemetry. */
  matchedOn: string;
}

const PROFICIENCY_WEIGHT: Record<AssignedSkillRow['proficiencyLevel'], number> = {
  expert: 4,
  advanced: 3,
  intermediate: 2,
  beginner: 1,
};

/**
 * Fetch every skill assigned to `agentId` from the shared catalog tables.
 * Returns an empty array (never throws) if the tables are missing or the
 * agent has no assignments — callers proceed skill-less rather than fail.
 */
export function getAssignedSkills(db: Database.Database, agentId: string): AssignedSkillRow[] {
  try {
    const rows = db.prepare(`
      SELECT asa.skill_id AS skillId,
             s.name AS skillName,
             s.description AS skillDescription,
             s.category AS skillCategory,
             asa.proficiency_level AS proficiencyLevel
      FROM agent_skill_assignments asa
      LEFT JOIN skills s ON asa.skill_id = s.id
      WHERE asa.agent_id = ?
    `).all(agentId) as any[];

    return rows.map((row) => ({
      skillId: row.skillId,
      skillName: row.skillName || row.skillId,
      skillDescription: row.skillDescription || '',
      skillCategory: row.skillCategory || '',
      proficiencyLevel: (row.proficiencyLevel || 'beginner') as AssignedSkillRow['proficiencyLevel'],
    }));
  } catch {
    return [];
  }
}

/** Tokenize free text into lowercase words for simple overlap matching. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);
}

/**
 * Find the assigned skill most relevant to `taskDescription`, if any.
 *
 * Matching: tokenizes the task description and compares against each
 * skill's name/description/category (also tokenized). A skill is a
 * candidate if at least one token overlaps. Among candidates, the one
 * with the most overlapping tokens wins; ties broken by proficiency level
 * (expert > advanced > intermediate > beginner). Returns null when no
 * skill has any token overlap with the task — a request unrelated to any
 * assigned skill should not force-inject an irrelevant one.
 */
export function findApplicableSkillForTask(
  skills: AssignedSkillRow[],
  taskDescription: string,
): { skill: AssignedSkillRow; matchedOn: string } | null {
  const taskTokens = new Set(tokenize(taskDescription));
  if (taskTokens.size === 0 || skills.length === 0) return null;

  let best: { skill: AssignedSkillRow; overlap: number; matchedOn: string } | null = null;

  for (const skill of skills) {
    const skillText = `${skill.skillName} ${skill.skillDescription} ${skill.skillCategory} ${skill.skillId}`;
    const skillTokens = tokenize(skillText);
    let overlap = 0;
    let firstMatch = '';
    for (const tok of skillTokens) {
      if (taskTokens.has(tok)) {
        overlap++;
        if (!firstMatch) firstMatch = tok;
      }
    }
    if (overlap === 0) continue;

    const better =
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap &&
        PROFICIENCY_WEIGHT[skill.proficiencyLevel] > PROFICIENCY_WEIGHT[best.skill.proficiencyLevel]);

    if (better) {
      best = { skill, overlap, matchedOn: firstMatch };
    }
  }

  return best ? { skill: best.skill, matchedOn: best.matchedOn } : null;
}

/**
 * Resolve the applicable skill for an agent+task and load its full content
 * from the `skills` table, ready to inject into a system prompt. Returns
 * null when no skill matches, the content is missing, or any lookup fails
 * — the caller must proceed without skill content in that case rather than
 * block execution (skills are an enhancement, never a hard dependency).
 */
export function resolveSkillForInjection(
  db: Database.Database,
  agentId: string,
  taskDescription: string,
): MatchedSkill | null {
  const assigned = getAssignedSkills(db, agentId);
  const match = findApplicableSkillForTask(assigned, taskDescription);
  if (!match) return null;

  try {
    const row = db.prepare('SELECT content FROM skills WHERE id = ?').get(match.skill.skillId) as
      | { content?: string }
      | undefined;
    const content = row?.content?.trim();
    if (!content) return null;

    return {
      skillId: match.skill.skillId,
      skillName: match.skill.skillName,
      content,
      matchedOn: match.matchedOn,
    };
  } catch {
    return null;
  }
}

/**
 * Build the system-prompt block for an injected skill. Kept short and
 * clearly delimited so it reads as reference material, not instructions
 * that override the agent's core system prompt.
 */
export function buildSkillPromptBlock(skill: MatchedSkill): string {
  return (
    `\n\n=== APPLICABLE SKILL: ${skill.skillName} ===\n` +
    skill.content +
    `\n=== END SKILL ===`
  );
}
