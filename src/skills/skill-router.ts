// Skill router: scoring algorithm, threshold check, routing decision
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 16.3, 16.6

import type { SkillDefinition } from './skill-metadata-parser.js';
import type { SkillRegistry } from './skill-registry.js';

export interface RouteResult {
  matched: boolean;
  skill: SkillDefinition | null;
  score: number;
  candidates: Array<{ skillId: string; score: number }>;
}

export interface TaskContext {
  prompt: string;
  projectId: string;
  filePaths?: string[];
  language?: string;
  projectMetadata?: Record<string, unknown>;
}

// Scoring weights
const WEIGHT_INTENT = 0.30;
const WEIGHT_FILE_EXT = 0.15;
const WEIGHT_CATEGORY = 0.15;
const WEIGHT_HISTORICAL = 0.15;
const WEIGHT_USER_PREF = 0.10;
const WEIGHT_CONFIDENCE = 0.15;

const DEFAULT_THRESHOLD = 0.3;
const TEMPLATE_OVERRIDE_WEIGHT = 999;

const DESIGN_KEYWORDS = ['design', 'ui', 'layout', 'style'];

/**
 * Tokenize a string into lowercase words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Score intent keyword match (weight 0.30).
 * Tokenize prompt and match against skill name, description, tags, category.
 */
function scoreIntent(skill: SkillDefinition, promptTokens: string[]): number {
  if (promptTokens.length === 0) return 0;

  const skillTokens = new Set<string>([
    ...tokenize(skill.name),
    ...tokenize(skill.description),
    ...tokenize(skill.category),
    ...skill.tags.flatMap((t) => tokenize(t)),
  ]);

  if (skillTokens.size === 0) return 0;

  let matches = 0;
  for (const token of promptTokens) {
    for (const skillToken of skillTokens) {
      if (skillToken.includes(token) || token.includes(skillToken)) {
        matches++;
        break;
      }
    }
  }

  return matches / promptTokens.length;
}

/**
 * Score file extension / language match (weight 0.15).
 * Match file extensions in context against skill tags/metadata.
 */
function scoreFileExtension(skill: SkillDefinition, context: TaskContext): number {
  const extensions = new Set<string>();

  if (context.filePaths) {
    for (const fp of context.filePaths) {
      const ext = fp.split('.').pop()?.toLowerCase();
      if (ext) extensions.add(ext);
    }
  }

  if (context.language) {
    extensions.add(context.language.toLowerCase());
  }

  if (extensions.size === 0) return 0;

  const skillTerms = new Set<string>([
    ...skill.tags.map((t) => t.toLowerCase()),
  ]);

  // Also check metadata for language-related fields
  if (skill.metadata.language) {
    skillTerms.add(String(skill.metadata.language).toLowerCase());
  }
  if (skill.metadata.extensions && Array.isArray(skill.metadata.extensions)) {
    for (const ext of skill.metadata.extensions) {
      skillTerms.add(String(ext).toLowerCase());
    }
  }

  let matches = 0;
  for (const ext of extensions) {
    if (skillTerms.has(ext)) {
      matches++;
    }
  }

  return extensions.size > 0 ? matches / extensions.size : 0;
}

/**
 * Score category match (weight 0.15).
 * Match task type keywords (e.g., "design", "test", "deploy") to skill category.
 */
function scoreCategoryMatch(skill: SkillDefinition, promptTokens: string[]): number {
  const categoryTokens = tokenize(skill.category);
  if (categoryTokens.length === 0) return 0;

  let matches = 0;
  for (const catToken of categoryTokens) {
    for (const promptToken of promptTokens) {
      if (catToken.includes(promptToken) || promptToken.includes(catToken)) {
        matches++;
        break;
      }
    }
  }

  return matches / categoryTokens.length;
}

/**
 * Score historical success rate (weight 0.15).
 * Query skill_executions table for success ratio.
 */
function scoreHistoricalSuccess(registry: SkillRegistry, skillId: string): number {
  try {
    const db = (registry as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
        FROM skill_executions
        WHERE skill_id = ?`
      )
      .get(skillId) as { total: number; successes: number } | undefined;

    if (!row || row.total === 0) return 0.5; // default when no history
    return row.successes / row.total;
  } catch {
    return 0.5; // default on error
  }
}

/**
 * Score user preference weight (weight 0.10).
 * Check skill_routing_prefs for manual weight overrides.
 * Returns normalized value between 0 and 1.
 */
function scoreUserPreference(
  registry: SkillRegistry,
  skillId: string,
  projectId: string
): number {
  const prefs = registry.getRoutingPrefs(projectId);
  const pref = prefs.find((p) => p.skillId === skillId);

  if (!pref || pref.weightOverride === null) return 0.5; // neutral default
  if (pref.weightOverride >= TEMPLATE_OVERRIDE_WEIGHT) return 1.0;

  // Clamp weight override to [0, 1]
  return Math.max(0, Math.min(1, pref.weightOverride));
}

/**
 * Score skill confidence (weight 0.15).
 * Metadata-declared confidence or default 0.5.
 */
function scoreConfidence(skill: SkillDefinition): number {
  if (
    skill.metadata.confidence !== undefined &&
    skill.metadata.confidence !== null &&
    typeof skill.metadata.confidence === 'number'
  ) {
    return Math.max(0, Math.min(1, skill.metadata.confidence));
  }
  return 0.5;
}

/**
 * Check if a prompt is a Design agent task based on keywords.
 */
function isDesignTask(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return DESIGN_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Score and select the best skill for a task.
 * Returns matched=false if no skill exceeds the threshold.
 */
export function routeTask(
  registry: SkillRegistry,
  context: TaskContext,
  threshold: number = DEFAULT_THRESHOLD
): RouteResult {
  const emptyResult: RouteResult = {
    matched: false,
    skill: null,
    score: 0,
    candidates: [],
  };

  // Get all enabled skills for the project
  const skills = registry.list({ enabled: true, projectId: context.projectId });

  if (skills.length === 0) {
    return emptyResult;
  }

  // Check for manual template override for Design tasks
  if (isDesignTask(context.prompt)) {
    const prefs = registry.getRoutingPrefs(context.projectId);
    const templateOverride = prefs.find(
      (p) => p.weightOverride !== null && p.weightOverride >= TEMPLATE_OVERRIDE_WEIGHT
    );

    if (templateOverride) {
      const overrideSkill = registry.get(templateOverride.skillId);
      if (overrideSkill && overrideSkill.enabled) {
        // Still compute candidates for informational purposes
        const promptTokens = tokenize(context.prompt);
        const candidates = computeCandidates(registry, skills, context, promptTokens);

        return {
          matched: true,
          skill: overrideSkill,
          score: 1.0,
          candidates,
        };
      }
    }
  }

  const promptTokens = tokenize(context.prompt);
  const candidates = computeCandidates(registry, skills, context, promptTokens);

  if (candidates.length === 0) {
    return emptyResult;
  }

  const topCandidate = candidates[0];
  const matched = topCandidate.score > threshold;

  return {
    matched,
    skill: matched ? (registry.get(topCandidate.skillId) ?? null) : null,
    score: topCandidate.score,
    candidates,
  };
}

/**
 * Compute scored candidates for all enabled skills, sorted descending by score.
 */
function computeCandidates(
  registry: SkillRegistry,
  skills: SkillDefinition[],
  context: TaskContext,
  promptTokens: string[]
): Array<{ skillId: string; score: number }> {
  const scored: Array<{ skillId: string; score: number }> = [];

  for (const skill of skills) {
    const intent = scoreIntent(skill, promptTokens);
    const fileExt = scoreFileExtension(skill, context);
    const category = scoreCategoryMatch(skill, promptTokens);
    const historical = scoreHistoricalSuccess(registry, skill.id);
    const userPref = scoreUserPreference(registry, skill.id, context.projectId);
    const confidence = scoreConfidence(skill);

    const compositeScore =
      intent * WEIGHT_INTENT +
      fileExt * WEIGHT_FILE_EXT +
      category * WEIGHT_CATEGORY +
      historical * WEIGHT_HISTORICAL +
      userPref * WEIGHT_USER_PREF +
      confidence * WEIGHT_CONFIDENCE;

    scored.push({ skillId: skill.id, score: compositeScore });
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  return scored;
}


/**
 * LLM-based skill routing. Uses a reasoning model to semantically match
 * the user's task to the most relevant skill.
 * Falls back to the token-based routeTask() if LLM is unavailable.
 */
export async function routeTaskWithLLM(
  registry: SkillRegistry,
  context: TaskContext,
  llmClient?: any,
  threshold: number = DEFAULT_THRESHOLD
): Promise<RouteResult> {
  if (llmClient) {
    try {
      const { matchSkillWithLLM } = await import('../pipeline/llm-decision-engine');
      const skills = registry.list({ enabled: true, projectId: context.projectId });
      if (skills.length > 0) {
        const skillSummaries = skills.slice(0, 20).map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          tags: s.tags,
        }));
        const result = await matchSkillWithLLM(context.prompt, skillSummaries, llmClient);
        if (result && result.skillId && result.confidence >= threshold) {
          const matchedSkill = registry.get(result.skillId);
          if (matchedSkill) {
            console.log('[SkillRouter] LLM matched skill:', result.skillId, 'confidence:', result.confidence, '—', result.reasoning);
            return {
              matched: true,
              skill: matchedSkill,
              score: result.confidence,
              candidates: [{ skillId: result.skillId, score: result.confidence }],
            };
          }
        }
      }
    } catch (err: any) {
      console.warn('[SkillRouter] LLM skill matching failed, using token-based fallback:', err?.message);
    }
  }
  return routeTask(registry, context, threshold);
}
