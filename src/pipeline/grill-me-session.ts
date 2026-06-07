/**
 * Grill-Me Session — Stress-test a build request before handing it to the orchestrator.
 *
 * Flow:
 *   1. User sends a build-task message ("build me a todo app").
 *   2. The IPC handler classifies as `build_task` and creates a GrillMeSession
 *      keyed off the active project/session. The interview begins.
 *   3. The session asks ONE question at a time, each with a recommended
 *      answer. The user types their reply.
 *   4. The session classifies the reply as either `answer`, `done`, or
 *      `restart`. On `answer`, the next question is generated. On `done`,
 *      the collected Q&A is synthesized into a build spec and the session
 *      ends. On `restart`, the prior answer is removed and the question is
 *      re-asked.
 *   5. The synthesized spec is returned to the IPC handler, which routes it
 *      to the orchestrator pipeline as if the user had typed it directly.
 *
 * The interview is LLM-driven; the system prompt below frames the model's
 * line of questioning and defines the JSON output contract this module needs.
 *
 * Sessions are kept in-memory (per process). They live only for the duration
 * of a chat. Sliding 30-minute idle TTL prevents leaks if a user walks away
 * mid-interview.
 */

import type { LLMMessage } from './llm-client';

export type GrillTurn =
  | { role: 'assistant'; question: string; recommendation: string }
  | { role: 'user'; reply: string };

export interface GrillState {
  projectId: string;
  /** Original build-request message that kicked off the interview. */
  originalMessage: string;
  /** Conversation transcript. Q1 → A1 → Q2 → A2 → ... */
  turns: GrillTurn[];
  /** Question count so we can cap runaway interviews. */
  questionsAsked: number;
  /** UNIX ms — last touch. Used by the idle reaper. */
  lastTouchedAt: number;
  /** When true the session is closed; the next user message exits grill mode. */
  finished: boolean;
}

interface GrillStepResult {
  /** Next question to surface to the user, with its recommendation. */
  question?: string;
  recommendation?: string;
  /** Set when the interview is complete. The `spec` is what the orchestrator gets. */
  done?: boolean;
  spec?: string;
  /** Set when the model thinks we should bail (e.g. user said stop). */
  aborted?: boolean;
  reason?: string;
}

/**
 * Minimal LLM interface — matches the shape both `LLMClient.chat` and the
 * worker proxy expose. Imported as `any` to avoid a hard dep on a specific
 * client class so this module can be unit-tested without electron deps.
 */
interface MinimalLLMClient {
  chat(messages: LLMMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<{ content: string }>;
}

const MAX_QUESTIONS = 12;
const IDLE_TTL_MS = 30 * 60 * 1000; // 30 min

const sessions = new Map<string, GrillState>();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the active grill session for a project, or null if none.
 */
export function getGrillSession(projectId: string): GrillState | null {
  reapIdleSessions();
  return sessions.get(projectId) ?? null;
}

/**
 * Starts a new grill-me interview for the given project. Generates the first
 * question via the LLM and stores the session. Returns the question payload
 * to display to the user.
 *
 * Caller (ipc.ts) is expected to:
 *   1. Add the user's original build-task message to the chat as `user`.
 *   2. Call this function.
 *   3. Render the returned `question` + `recommendation` to the chat as
 *      `assistant` (agent: 'NeuroNest Architect') so the user sees Q1.
 */
export async function startGrillSession(
  projectId: string,
  originalMessage: string,
  llm: MinimalLLMClient,
  codebaseContext?: string,
): Promise<{ question: string; recommendation: string } | { error: string }> {
  reapIdleSessions();

  const state: GrillState = {
    projectId,
    originalMessage: originalMessage.trim(),
    turns: [],
    questionsAsked: 0,
    lastTouchedAt: Date.now(),
    finished: false,
  };

  const step = await runStep(state, llm, codebaseContext);
  if (step.aborted) {
    return { error: step.reason || 'Could not start interview.' };
  }
  if (!step.question || !step.recommendation) {
    return { error: 'LLM did not produce a first question.' };
  }

  state.turns.push({ role: 'assistant', question: step.question, recommendation: step.recommendation });
  state.questionsAsked = 1;
  state.lastTouchedAt = Date.now();
  sessions.set(projectId, state);

  return { question: step.question, recommendation: step.recommendation };
}

/**
 * Routes a user reply through the active grill session. Returns one of:
 *   - { question, recommendation } — ask the next question
 *   - { done, spec }               — interview complete; route `spec` to orchestrator
 *   - { aborted, reason }          — user opted out; cancel the interview
 *   - { error }                    — LLM failed; caller should fall back
 */
export async function continueGrillSession(
  projectId: string,
  userReply: string,
  llm: MinimalLLMClient,
  codebaseContext?: string,
): Promise<
  | { question: string; recommendation: string }
  | { done: true; spec: string }
  | { aborted: true; reason: string }
  | { error: string }
> {
  const state = sessions.get(projectId);
  if (!state) return { error: 'No active grill session.' };
  if (state.finished) return { error: 'Grill session already finished.' };

  state.turns.push({ role: 'user', reply: userReply.trim() });
  state.lastTouchedAt = Date.now();

  // Cap the interview so a misbehaving model can't grill forever.
  if (state.questionsAsked >= MAX_QUESTIONS) {
    state.finished = true;
    sessions.delete(projectId);
    const spec = buildSpecFallback(state, 'question cap reached');
    return { done: true, spec };
  }

  const step = await runStep(state, llm, codebaseContext);

  if (step.aborted) {
    state.finished = true;
    sessions.delete(projectId);
    return { aborted: true, reason: step.reason || 'Interview cancelled.' };
  }

  if (step.done) {
    state.finished = true;
    sessions.delete(projectId);
    const spec = step.spec && step.spec.trim().length > 0 ? step.spec.trim() : buildSpecFallback(state, 'model returned empty spec');
    return { done: true, spec };
  }

  if (!step.question || !step.recommendation) {
    return { error: 'LLM did not produce a follow-up question.' };
  }

  state.turns.push({ role: 'assistant', question: step.question, recommendation: step.recommendation });
  state.questionsAsked += 1;
  state.lastTouchedAt = Date.now();
  return { question: step.question, recommendation: step.recommendation };
}

/**
 * Force-end a grill session (e.g. user opens a different project, or runs
 * /reset). Does not synthesize a spec.
 */
export function abortGrillSession(projectId: string): void {
  sessions.delete(projectId);
}

/** Test-only: clear all in-memory sessions. */
export function _resetAllGrillSessions(): void {
  sessions.clear();
}

// ── Internal: drives the LLM ─────────────────────────────────────────────────

async function runStep(state: GrillState, llm: MinimalLLMClient, codebaseContext?: string): Promise<GrillStepResult> {
  const messages: LLMMessage[] = [
    { role: 'system', content: buildSystemPrompt(state, codebaseContext) },
    ...turnsToLLMMessages(state),
  ];

  let raw: string;
  try {
    const response = await llm.chat(messages, { temperature: 0.3, maxTokens: 1500 });
    raw = (response.content || '').trim();
  } catch (err: any) {
    return { aborted: true, reason: `LLM error: ${err?.message || 'unknown'}` };
  }

  const parsed = tryParseJson(raw);
  if (!parsed) {
    // Fallback: treat as raw question text. Better than crashing.
    return { question: raw || 'Could you elaborate?', recommendation: 'No specific recommendation — share whatever feels right.' };
  }

  if (parsed.action === 'done') {
    return { done: true, spec: typeof parsed.spec === 'string' ? parsed.spec : undefined };
  }

  if (parsed.action === 'abort') {
    return { aborted: true, reason: typeof parsed.reason === 'string' ? parsed.reason : 'User declined to continue.' };
  }

  if (parsed.action === 'ask' && typeof parsed.question === 'string' && typeof parsed.recommendation === 'string') {
    const candidate = parsed.question.trim();
    // Guard against the model echoing a question it already asked.
    // Some providers (notably GPT-3.5 / smaller open-source models) loop
    // when the user's answer is short or they lose track of progress.
    // If the new question matches any previously-asked question (after
    // normalization), treat the interview as complete and let the
    // orchestrator have the partial spec we've collected so far.
    if (isQuestionRepeat(state, candidate)) {
      return {
        done: true,
        // Force fallback synthesis — the model has nothing new to add.
        spec: undefined,
      };
    }
    return { question: candidate, recommendation: parsed.recommendation.trim() };
  }

  return { question: 'Could you elaborate?', recommendation: 'No specific recommendation — share whatever feels right.' };
}

/**
 * Normalize a question for similarity comparison: lowercase, collapse
 * whitespace, strip punctuation, drop short stopwords. Returns the
 * remaining word set.
 */
function normalizeQuestionTokens(q: string): Set<string> {
  const stop = new Set([
    'a', 'an', 'and', 'or', 'the', 'is', 'are', 'do', 'does', 'should',
    'would', 'will', 'can', 'could', 'to', 'of', 'in', 'on', 'for', 'with',
    'be', 'it', 'this', 'that', 'have', 'has', 'i', 'you', 'we', 'your',
    'my', 'me', 'about', 'like', 'as', 'use', 'using', 'used',
    // Interrogative and question-shape words — noise for similarity
    'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why',
    'how', 'whether', 'going', 'plan', 'want', 'need', 'prefer',
  ]);
  return new Set(
    q
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/** Jaccard similarity over normalized token sets. 0..1. */
function questionSimilarity(a: string, b: string): number {
  const ta = normalizeQuestionTokens(a);
  const tb = normalizeQuestionTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Did the model just propose a question we've already asked? Considered
 * a repeat when the Jaccard similarity exceeds 0.6 against any prior
 * assistant turn.
 */
function isQuestionRepeat(state: GrillState, candidate: string): boolean {
  if (!candidate) return false;
  for (const turn of state.turns) {
    if (turn.role !== 'assistant') continue;
    const sim = questionSimilarity(turn.question, candidate);
    if (sim >= 0.6) return true;
  }
  return false;
}

function buildSystemPrompt(state: GrillState, codebaseContext?: string): string {
  const askedSummary = state.turns
    .filter((t) => t.role === 'assistant')
    .map((t, i) => `Q${i + 1}: ${(t as { role: 'assistant'; question: string }).question}`)
    .join('\n');

  // Re-state every prior Q→A pair in plain prose so the model can see at
  // a glance which decisions are already made. This is the strongest
  // signal against repeating a question.
  const decisionsSoFar: string[] = [];
  for (let i = 0; i < state.turns.length; i++) {
    const t = state.turns[i];
    if (t.role === 'assistant') {
      const next = state.turns[i + 1];
      if (next && next.role === 'user') {
        decisionsSoFar.push(
          `- Q: ${t.question}\n  Recommended: ${t.recommendation}\n  User answered: ${next.reply || '(no answer given)'}`,
        );
      }
    }
  }

  return [
    'You are NeuroNest Architect, an interviewer for a build request.',
    '',
    "Interview the user about the build until you have enough to write a concrete spec. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.",
    '',
    'Rules:',
    '- Ask ONE question at a time.',
    '- Each question MUST cover NEW ground — never repeat or paraphrase a question you have already asked.',
    '- Each question MUST be a follow-up that builds on the user\'s most recent answer when possible.',
    '- Cap the interview at ~10 questions. Prefer fewer (3-6) when scope is narrow.',
    '- If the user\'s answer is short or unclear, treat it as accepted; do NOT re-ask.',
    '- Once enough decisions are pinned (typically 3-6 questions for a small project, more for a large one), return action="done" with a build spec.',
    '- If you would otherwise repeat a question, return action="done" instead.',
    '',
    `User's original build request: """${state.originalMessage}"""`,
    askedSummary ? `\nQuestions you have ALREADY asked (do NOT repeat or paraphrase any of these):\n${askedSummary}` : '\n(This is question 1 — no questions asked yet.)',
    decisionsSoFar.length ? `\nDecisions already captured:\n${decisionsSoFar.join('\n')}` : '',
    codebaseContext ? `\nCodebase context (read-only, for reference):\n${codebaseContext}` : '',
    '',
    'OUTPUT CONTRACT (STRICT):',
    'Always respond with a single JSON object on its own. No prose outside the JSON. No markdown fences. The object MUST be one of:',
    '',
    '1. To ask the next question (only if it covers ground NOT already covered above):',
    '   {',
    '     "action": "ask",',
    '     "question": "<plain-text question, ~1 sentence>",',
    '     "recommendation": "<your recommended answer, ~1-3 sentences explaining trade-offs>"',
    '   }',
    '',
    '2. To finish (interview is complete; you have enough to write a spec — or you would otherwise repeat yourself):',
    '   {',
    '     "action": "done",',
    '     "spec": "<a 200-600 word build spec in markdown — sections: Goal, Constraints, Decisions Made, Open Questions, Out of Scope. This is what an orchestrator will receive as the build instructions, so be concrete>"',
    '   }',
    '',
    '3. To abort (user said stop / changed their mind):',
    '   {',
    '     "action": "abort",',
    '     "reason": "<brief explanation>"',
    '   }',
    '',
    'EXIT TRIGGERS — when the user reply matches any of these, return action="done":',
    '- "looks good", "build it", "ok let\'s go", "ship it", "go ahead", "proceed", "do it", "stop grilling", "ok done", "i\'m done", "enough", "that\'s enough", "skip the rest"',
    '- An empty reply or just "yes" twice in a row',
    '',
    'EXIT TRIGGERS — when the user reply matches any of these, return action="abort":',
    '- "cancel", "nevermind", "forget it", "abort", "stop"',
    '',
    'When in doubt, prefer action="done". A short interview is better than a repetitive one.',
  ].filter(Boolean).join('\n');
}

function turnsToLLMMessages(state: GrillState): LLMMessage[] {
  const out: LLMMessage[] = [
    { role: 'user', content: state.originalMessage },
  ];
  for (const turn of state.turns) {
    if (turn.role === 'assistant') {
      // Render as natural language plus the JSON contract. The model
      // recognizes its own prose far better than opaque JSON, which makes
      // it much less likely to repeat a question.
      const proseLine = `Q: ${turn.question}\nRecommended: ${turn.recommendation}`;
      const jsonLine = JSON.stringify({
        action: 'ask',
        question: turn.question,
        recommendation: turn.recommendation,
      });
      out.push({
        role: 'assistant',
        content: `${proseLine}\n\n${jsonLine}`,
      });
    } else {
      out.push({ role: 'user', content: turn.reply });
    }
  }
  return out;
}

function tryParseJson(raw: string): any | null {
  if (!raw) return null;
  // Strip ```json fences if the model insists on them.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  // Try to extract the first {...} block.
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* fall through */ }
  }
  return null;
}

function reapIdleSessions(): void {
  const now = Date.now();
  for (const [pid, state] of sessions) {
    if (now - state.lastTouchedAt > IDLE_TTL_MS) {
      sessions.delete(pid);
    }
  }
}

/**
 * Build a spec without going through the LLM — fallback for the question-cap
 * exit path or when the model returns empty content. Stitches together what
 * we collected so the orchestrator at least sees the original ask + the
 * Q&A trail.
 */
function buildSpecFallback(state: GrillState, reason: string): string {
  const lines: string[] = [];
  lines.push('# Build Spec');
  lines.push('');
  lines.push(`> Synthesized from grill-me interview (${reason}).`);
  lines.push('');
  lines.push('## Goal');
  lines.push(state.originalMessage);
  lines.push('');
  if (state.turns.length > 0) {
    lines.push('## Decisions Made');
    let qIdx = 1;
    for (let i = 0; i < state.turns.length; i++) {
      const turn = state.turns[i];
      if (turn.role === 'assistant') {
        lines.push(`**Q${qIdx}: ${turn.question}**`);
        lines.push(`Recommendation: ${turn.recommendation}`);
        const next = state.turns[i + 1];
        if (next && next.role === 'user') {
          lines.push(`Answer: ${next.reply}`);
        } else {
          lines.push(`Answer: (skipped)`);
        }
        lines.push('');
        qIdx++;
      }
    }
  }
  lines.push('## Out of Scope');
  lines.push('- Anything not explicitly covered above.');
  return lines.join('\n');
}
