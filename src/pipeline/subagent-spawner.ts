/**
 * Subagent Spawner — Lightweight Task Delegation
 *
 * Allows the main agent to spawn focused subagents for specific subtasks.
 * Subagents run in isolation (single-turn LLM call) and return a result
 * without consuming the main conversation's context window.
 */

import type { LLMClient, LLMMessage } from './llm-client';

export interface SubagentTask {
  id: string;
  name: string;
  task: string;
  systemPrompt?: string;
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
