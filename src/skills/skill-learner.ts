/**
 * Skill Learner — Self-Improving Skills from Execution
 *
 * After a swarm completes successfully, analyzes the execution trace and
 * optionally saves it as a reusable skill. On similar future tasks,
 * suggests or auto-applies the learned skill.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LLMClient } from '../pipeline/llm-client';

export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  procedure: string;    // Step-by-step instructions the AI can follow
  triggerPatterns: string[]; // Keywords/phrases that trigger this skill
  source: 'auto-learned';
  learnedFromSession: string;
  successCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

const SKILL_EXTRACTION_PROMPT = `You are a skill extractor. Given the following task execution trace (user request + agent outputs), extract a reusable procedure that could be applied to similar future tasks.

Output a JSON object with:
{
  "name": "short skill name (3-5 words)",
  "description": "one sentence describing what this skill does",
  "procedure": "step-by-step instructions (numbered list) that an AI agent can follow to accomplish this type of task",
  "triggerPatterns": ["keyword1", "keyword2", "phrase that would trigger this skill"]
}

Only extract a skill if the task was complex enough to be worth saving (not trivial one-liners).
If the task is too simple or too specific to be reusable, respond with: {"skip": true}`;

export class SkillLearner {
  constructor(private db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        procedure TEXT NOT NULL,
        trigger_patterns TEXT NOT NULL DEFAULT '[]',
        source TEXT DEFAULT 'auto-learned',
        learned_from_session TEXT,
        success_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Analyze a completed swarm execution and potentially learn a skill from it.
   */
  async learnFromExecution(
    userMessage: string,
    agentOutputs: Map<string, string>,
    sessionId: string,
    llmClient: LLMClient
  ): Promise<LearnedSkill | null> {
    // Only learn from complex executions (3+ agents or substantial output)
    if (agentOutputs.size < 3) return null;
    const totalOutput = Array.from(agentOutputs.values()).join('\n').length;
    if (totalOutput < 500) return null;

    // Build the execution trace
    const trace = `USER REQUEST: ${userMessage}\n\n` +
      Array.from(agentOutputs.entries())
        .map(([agent, output]) => `AGENT [${agent}]:\n${output.slice(0, 800)}`)
        .join('\n\n---\n\n');

    try {
      const result = await llmClient.chat([
        { role: 'system', content: SKILL_EXTRACTION_PROMPT },
        { role: 'user', content: trace.slice(0, 6000) },
      ], { temperature: 0.3, maxTokens: 400 });

      const content = (result.content || '').trim();
      
      // Try to parse as JSON
      let parsed: any;
      try {
        // Extract JSON from potential markdown code block
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }

      if (parsed.skip) return null;
      if (!parsed.name || !parsed.procedure) return null;

      // Store the learned skill
      const id = randomUUID();
      const now = new Date().toISOString();
      const triggers = JSON.stringify(parsed.triggerPatterns || []);

      this.db.prepare(
        'INSERT INTO learned_skills (id, name, description, procedure, trigger_patterns, source, learned_from_session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, parsed.name, parsed.description || '', parsed.procedure, triggers, 'auto-learned', sessionId, now);

      console.log(`[SkillLearner] Learned new skill: "${parsed.name}" from session ${sessionId}`);

      return {
        id,
        name: parsed.name,
        description: parsed.description || '',
        procedure: parsed.procedure,
        triggerPatterns: parsed.triggerPatterns || [],
        source: 'auto-learned',
        learnedFromSession: sessionId,
        successCount: 0,
        lastUsedAt: null,
        createdAt: now,
      };
    } catch (err: any) {
      console.warn('[SkillLearner] Failed to learn skill:', err.message);
      return null;
    }
  }

  /**
   * Find a matching learned skill for a given user message.
   * Returns the best match or null.
   */
  findMatchingSkill(userMessage: string): LearnedSkill | null {
    const skills = this.db.prepare('SELECT * FROM learned_skills ORDER BY success_count DESC').all() as any[];
    if (skills.length === 0) return null;

    const msgLower = userMessage.toLowerCase();

    for (const row of skills) {
      const triggers: string[] = JSON.parse(row.trigger_patterns || '[]');
      const matched = triggers.some(t => msgLower.includes(t.toLowerCase()));
      if (matched) {
        return this.rowToSkill(row);
      }
    }

    return null;
  }

  /**
   * Record that a skill was used successfully.
   */
  recordSuccess(skillId: string): void {
    this.db.prepare('UPDATE learned_skills SET success_count = success_count + 1, last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), skillId);
  }

  /**
   * Persist a recovered procedure as a reusable learned skill.
   *
   * Used by the Teacher_Escalation_Loop (Feature 7): when a self-hosted
   * "student" model fails a turn and a stronger "teacher" endpoint produces a
   * reply that clears the failure detector, that recovery is stored here so the
   * local model can reuse it on similar future tasks.
   *
   * The supplied `metadata` is persisted alongside the skill for provenance
   * (e.g. `{ source: 'teacher-escalation', studentEndpoint, failureReason }`).
   * This method is defensive — it never throws — because it runs inside the
   * post-turn hook and must not break the agent loop on a storage error.
   *
   * Requirements: 40.4
   */
  async recordRecovery(name: string, body: string, metadata: object): Promise<void> {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      // Reuse the failure reason (when present) as a coarse trigger pattern so
      // findMatchingSkill can surface the recovery on a similar future failure.
      const reason = (metadata as { failureReason?: unknown })?.failureReason;
      const triggers = JSON.stringify(typeof reason === 'string' && reason ? [reason] : []);
      const description = 'Recovered via teacher escalation — ' + JSON.stringify(metadata).slice(0, 300);

      this.db.prepare(
        'INSERT INTO learned_skills (id, name, description, procedure, trigger_patterns, source, learned_from_session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, String(name).slice(0, 200), description, String(body), triggers, 'teacher-escalation', null, now);

      console.log(`[SkillLearner] Recorded teacher-escalation recovery: "${name}"`);
    } catch (err: any) {
      console.warn('[SkillLearner] Failed to record recovery skill:', err?.message);
    }
  }

  /**
   * List all learned skills.
   */
  listSkills(): LearnedSkill[] {
    return (this.db.prepare('SELECT * FROM learned_skills ORDER BY success_count DESC, created_at DESC').all() as any[])
      .map(this.rowToSkill);
  }

  /**
   * Delete a learned skill.
   */
  deleteSkill(id: string): boolean {
    return this.db.prepare('DELETE FROM learned_skills WHERE id = ?').run(id).changes > 0;
  }

  private rowToSkill(row: any): LearnedSkill {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      procedure: row.procedure,
      triggerPatterns: JSON.parse(row.trigger_patterns || '[]'),
      source: 'auto-learned',
      learnedFromSession: row.learned_from_session || '',
      successCount: row.success_count || 0,
      lastUsedAt: row.last_used_at || null,
      createdAt: row.created_at,
    };
  }
}
