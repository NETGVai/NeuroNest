/**
 * Subagent Spawner — Lightweight Task Delegation
 *
 * Allows the main agent to spawn focused subagents for specific subtasks.
 * Subagents run in isolation (single-turn LLM call) and return a result
 * without consuming the main conversation's context window.
 *
 * Extended with Skill-Aware Subagent Spawning (Requirements 5.1–5.4, 5.7, 5.8):
 * - Prepends minimalism section when enforceMinimalism is enabled
 * - Runs keyword matching against task description and role
 * - Attaches matched skills within per-role Skill_Budget cap
 * - Rejects (never truncates) skills exceeding remaining budget
 * - Spawns without skill content when no skills match
 */

import type { LLMClient, LLMMessage } from './llm-client';
import { buildMinimalismSection, type CodeQualityDirectives } from './system-prompt-builder';
import { findTriggeredSkills } from '../skills/skill-keyword-trigger';
import { resolveRole } from '../orchestration/role-vocabulary';

export interface SubagentTask {
  id: string;
  name: string;
  task: string;
  systemPrompt?: string;
}

// ─── Skill-Aware Subagent Interfaces (Requirement 5) ─────────────

/**
 * Configuration for skill injection into spawned subagents.
 *
 * - enforceMinimalism: when true, prepend minimalism section to specialist prompt
 * - skillBudgetChars: per-role character cap on total injected skill content
 * - roleAllowlist: maps role → list of allowed skill IDs for that role
 */
export interface SkillInjectionConfig {
  enforceMinimalism: boolean;
  skillBudgetChars: number;
  roleAllowlist: Map<string, string[]>;
}

/**
 * Enhanced subagent task with role-based skill injection metadata.
 * Extends SubagentTask with fields used for skill-aware spawning.
 */
export interface EnhancedSubagentTask extends SubagentTask {
  role: string;
  taskKeywords: string[];
  injectedSkills: string[];
}

export interface SubagentResult {
  id: string;
  name: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

const DEFAULT_SUBAGENT_PROMPT = `You are a focused research subagent. Your job is to complete the specific task given to you and return a concise, actionable result. Do not ask follow-up questions — work with what you have. Be thorough but brief.`;

const MAX_CONCURRENT = 3;

/**
 * Spawn a single subagent to complete a focused task.
 * Returns the result without affecting the main conversation context.
 */
export async function spawnSubagent(
  task: SubagentTask,
  llmClient: LLMClient,
  maxTokens: number = 1000
): Promise<SubagentResult> {
  const start = Date.now();

  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: task.systemPrompt || DEFAULT_SUBAGENT_PROMPT },
      { role: 'user', content: task.task },
    ];

    const response = await llmClient.chat(messages, { temperature: 0.4, maxTokens });
    const output = (response.content || '').trim();

    return {
      id: task.id,
      name: task.name,
      output,
      durationMs: Date.now() - start,
      success: output.length > 0,
    };
  } catch (err: any) {
    return {
      id: task.id,
      name: task.name,
      output: '',
      durationMs: Date.now() - start,
      success: false,
      error: err.message,
    };
  }
}

/**
 * Spawn multiple subagents in parallel (up to MAX_CONCURRENT).
 * Returns all results once all complete.
 */
export async function spawnSubagentBatch(
  tasks: SubagentTask[],
  llmClient: LLMClient,
  maxTokens: number = 1000
): Promise<SubagentResult[]> {
  const results: SubagentResult[] = [];

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
    const batch = tasks.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(task => spawnSubagent(task, llmClient, maxTokens))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Format subagent results as context that can be injected into the main conversation.
 * Keeps it concise to minimize context usage.
 */
export function formatSubagentResults(results: SubagentResult[]): string {
  if (results.length === 0) return '';

  const sections = results
    .filter(r => r.success && r.output)
    .map(r => `[${r.name}]: ${r.output.slice(0, 1500)}`);

  if (sections.length === 0) return '';

  return '--- SUBAGENT RESEARCH RESULTS ---\n' + sections.join('\n\n') + '\n--- END SUBAGENT RESULTS ---';
}

// ─── Skill-Aware Subagent Spawning (Requirement 5) ──────────────

/**
 * Resolve which skills from the catalog should be injected into a subagent's context.
 *
 * Logic:
 * 1. Validate the role against the shared Role_Vocabulary by exact comparison (R10.2)
 * 2. If the role is not in the vocabulary, return no skills and surface an indication (R10.5)
 * 3. Run keyword matching against the task description (text) and role
 * 4. Filter matched skills against the role's allowlist (derived from Role_Vocabulary, R10.3)
 * 5. Enforce per-role budget: reject (never truncate) skills that exceed remaining budget
 * 6. Return skill IDs and their content that fit within budget
 *
 * Requirements: 5.2, 5.4, 5.5, 5.8, 10.2, 10.3, 10.4, 10.5
 */
export function resolveSkillsForRole(
  task: EnhancedSubagentTask,
  config: SkillInjectionConfig,
  skillCatalog: Map<string, string>,
): { skillIds: string[]; skillContent: string; unmatchedIndication?: string } {
  // Validate the role against the shared Role_Vocabulary (R10.2, R10.5)
  const resolution = resolveRole(task.role);
  if (!resolution.matched) {
    // Role absent from vocabulary: return no skills and surface indication (R10.5)
    console.warn(`[resolveSkillsForRole] ${resolution.unmatchedIndication}`);
    return { skillIds: [], skillContent: '', unmatchedIndication: resolution.unmatchedIndication };
  }

  // Get allowlist for this role; if no allowlist entry, no skills are injectable
  const allowedSkills = config.roleAllowlist.get(task.role);
  if (!allowedSkills || allowedSkills.length === 0) {
    return { skillIds: [], skillContent: '' };
  }

  // Build search text from task description and keywords
  const searchText = [task.task, ...task.taskKeywords].join(' ');

  // Run keyword matching against the search text and role
  const triggered = findTriggeredSkills(searchText, task.role);

  // Filter to only skills on the allowlist (R10.3)
  const allowedTriggered = triggered.filter(t => allowedSkills.includes(t.mapping.skillId));

  if (allowedTriggered.length === 0) {
    return { skillIds: [], skillContent: '' };
  }

  // Enforce per-role budget: reject skills that exceed remaining budget (Req 5.8)
  let remainingBudget = config.skillBudgetChars;
  const acceptedSkillIds: string[] = [];
  const acceptedContent: string[] = [];

  for (const { mapping } of allowedTriggered) {
    const content = skillCatalog.get(mapping.skillId);
    if (!content) {
      continue;
    }

    // Reject entirely if skill content exceeds remaining budget
    if (content.length > remainingBudget) {
      continue;
    }

    acceptedSkillIds.push(mapping.skillId);
    acceptedContent.push(content);
    remainingBudget -= content.length;
  }

  return {
    skillIds: acceptedSkillIds,
    skillContent: acceptedContent.join('\n\n'),
  };
}

/**
 * Spawn a skill-aware subagent with role-matched skills and optional minimalism enforcement.
 *
 * Behavior:
 * 1. Prepends minimalism section when `config.enforceMinimalism` is true (Req 5.1)
 * 2. Runs keyword matching against task description and role for skill discovery (Req 5.2)
 * 3. Attaches matched skills within per-role budget (Req 5.4)
 * 4. Rejects (does NOT truncate) skills that exceed remaining budget (Req 5.8)
 * 5. When no skills match, spawns without skill content (Req 5.7)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.7, 5.8
 */
export async function spawnSkillAwareSubagent(
  task: EnhancedSubagentTask,
  llmClient: LLMClient,
  config: SkillInjectionConfig,
  skillCatalog: Map<string, string>,
  maxTokens?: number,
): Promise<SubagentResult> {
  // Resolve which skills should be injected
  const { skillIds, skillContent } = resolveSkillsForRole(task, config, skillCatalog);

  // Record injected skills on the task
  task.injectedSkills = skillIds;

  // Build the system prompt with optional minimalism + skills
  let systemPrompt = task.systemPrompt || DEFAULT_SUBAGENT_PROMPT;

  // Prepend minimalism section when enforceMinimalism is enabled (Req 5.1)
  if (config.enforceMinimalism) {
    const minimalismDirectives: CodeQualityDirectives = {
      enforceErrorHandling: false,
      enforceTypeSafety: false,
      enforceConventionFollowing: false,
      enforceVerification: false,
      verificationTools: [],
      enforceMinimalism: true,
      minimalismMode: 'full',
    };
    const minimalismSection = buildMinimalismSection(minimalismDirectives);
    if (minimalismSection) {
      systemPrompt = minimalismSection + '\n\n' + systemPrompt;
    }
  }

  // Append matched skill content when available (Req 5.3, 5.7)
  if (skillContent) {
    systemPrompt = systemPrompt + '\n\n--- INJECTED SKILLS ---\n' + skillContent + '\n--- END SKILLS ---';
  }

  // Spawn using the enhanced system prompt
  const enhancedTask: SubagentTask = {
    id: task.id,
    name: task.name,
    task: task.task,
    systemPrompt,
  };

  return spawnSubagent(enhancedTask, llmClient, maxTokens ?? 1000);
}
