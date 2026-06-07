/**
 * LLM Decision Engine — Shared utility for making quick LLM-based classification calls.
 *
 * Replaces hardcoded regex/keyword heuristics across the pipeline with a single
 * reasoning model call. Each decision type has a focused system prompt that asks
 * the model to return a structured JSON response.
 *
 * Design principles:
 * - Each call is low-token (~150-300 tokens total) and uses temperature=0 for determinism
 * - Every function returns null on failure so callers can fall back to legacy logic
 * - Responses are validated before returning
 */

import type { LLMClient } from './llm-client';

// ─── Shared Helpers ─────────────────────────────────────────────

/**
 * Make a quick LLM classification call and parse the JSON response.
 * Returns null if the call fails or the response is unparseable.
 */
async function quickClassify<T>(
  llmClient: LLMClient,
  systemPrompt: string,
  userMessage: string,
  validate: (parsed: any) => T | null
): Promise<T | null> {
  try {
    const response = await llmClient.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0, maxTokens: 200 }
    );

    if (!response.content) return null;

    let jsonStr = response.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(jsonStr);
    return validate(parsed);
  } catch (err: any) {
    console.warn('[LLMDecisionEngine] Classification failed:', err?.message);
    return null;
  }
}

// ─── 1. Creative Task Detection ─────────────────────────────────
// Replaces: grounding-enforcer.ts isCreativeTask() regex

export interface CreativeTaskResult {
  isCreative: boolean;
  confidence: number;
  reasoning: string;
}

const CREATIVE_TASK_PROMPT = `You are classifying whether a coding task is "creative/generative" or "analytical/investigative".

Creative tasks produce NEW content that doesn't exist yet:
- "Create a new React component" → creative
- "Build a REST API" → creative
- "Write unit tests" → creative
- "Generate a migration script" → creative
- "Design a new database schema" → creative

Analytical tasks work with EXISTING content:
- "Fix the bug in auth.ts" → analytical (modifying existing)
- "Explain how the routing works" → analytical (investigating existing)
- "Why is this test failing?" → analytical
- "Refactor the user service" → analytical (restructuring existing)
- "Review this pull request" → analytical

Respond with ONLY a JSON object:
{"isCreative": true|false, "confidence": 0.0-1.0, "reasoning": "brief reason"}`;

export async function classifyCreativeTask(
  taskDescription: string,
  llmClient: LLMClient
): Promise<CreativeTaskResult | null> {
  return quickClassify(llmClient, CREATIVE_TASK_PROMPT, taskDescription, (parsed) => {
    if (typeof parsed.isCreative !== 'boolean') return null;
    return {
      isCreative: parsed.isCreative,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
      reasoning: parsed.reasoning || '',
    };
  });
}

// ─── 2. Execution Mode Selection ────────────────────────────────
// Replaces: execution-mode-router.ts mode selection heuristics

export type ExecutionMode = 'flash' | 'standard' | 'pro' | 'ultra';

export interface ExecutionModeResult {
  mode: ExecutionMode;
  confidence: number;
  reasoning: string;
}

const EXECUTION_MODE_PROMPT = `You are selecting the execution mode for a coding task in an AI IDE with multiple agents.

Modes:
1. "flash" — Simple, single-step tasks that one agent can handle quickly. Examples:
   - "Rename this variable"
   - "Add a comment to this function"
   - "What does this error mean?"
   - Simple questions or small edits

2. "standard" — Moderate tasks requiring planning then one agent. Examples:
   - "Write a utility function for date formatting"
   - "Add input validation to this form"
   - "Create a simple API endpoint"

3. "pro" — Complex tasks requiring multiple agents working sequentially. Examples:
   - "Build a user authentication system"
   - "Create a dashboard with charts and data fetching"
   - "Implement a caching layer with tests"

4. "ultra" — Large-scale tasks requiring parallel decomposition. Examples:
   - "Build a full-stack e-commerce application"
   - "Set up a microservices architecture with CI/CD"
   - "Create an entire project from scratch with frontend, backend, database, and tests"

Respond with ONLY a JSON object:
{"mode": "flash"|"standard"|"pro"|"ultra", "confidence": 0.0-1.0, "reasoning": "brief reason"}`;

export async function classifyExecutionMode(
  task: string,
  llmClient: LLMClient
): Promise<ExecutionModeResult | null> {
  return quickClassify(llmClient, EXECUTION_MODE_PROMPT, task, (parsed) => {
    if (!parsed.mode || !['flash', 'standard', 'pro', 'ultra'].includes(parsed.mode)) return null;
    return {
      mode: parsed.mode,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
      reasoning: parsed.reasoning || '',
    };
  });
}

// ─── 3. Agent Selection ─────────────────────────────────────────
// Replaces: orchestrator-planner.ts scoreAllAgents() keyword matching

export interface AgentSelectionResult {
  agentIds: string[];
  reasoning: string;
}

/**
 * Build a system prompt for agent selection that includes the available agents.
 */
function buildAgentSelectionPrompt(agents: Array<{ id: string; name: string; department: string; specialty: string }>): string {
  const agentList = agents.map(a => `- ${a.id}: ${a.name} (${a.department}) — ${a.specialty}`).join('\n');

  return `You are selecting the best agents for a coding task. Pick 1-5 agents that are most relevant.

Available agents:
${agentList}

Rules:
- Pick the MINIMUM number of agents needed (don't over-assign)
- For simple tasks, 1-2 agents is enough
- For complex tasks, pick agents from different departments that complement each other
- Always include at least one implementation agent for coding tasks
- Order them by relevance (most relevant first)

Respond with ONLY a JSON object:
{"agentIds": ["agent-id-1", "agent-id-2"], "reasoning": "brief reason for selection"}`;
}

export async function selectAgentsWithLLM(
  task: string,
  agents: Array<{ id: string; name: string; department: string; specialty: string }>,
  llmClient: LLMClient
): Promise<AgentSelectionResult | null> {
  const systemPrompt = buildAgentSelectionPrompt(agents);
  return quickClassify(llmClient, systemPrompt, task, (parsed) => {
    if (!Array.isArray(parsed.agentIds) || parsed.agentIds.length === 0) return null;
    // Validate all IDs exist in the agent list
    const validIds = new Set(agents.map(a => a.id));
    const filteredIds = parsed.agentIds.filter((id: string) => validIds.has(id));
    if (filteredIds.length === 0) return null;
    return {
      agentIds: filteredIds,
      reasoning: parsed.reasoning || '',
    };
  });
}

// ─── 4. Task Type Detection (Smart Router) ──────────────────────
// Replaces: smart-router.ts detectTaskType() keyword checks

export type TaskType = 'reasoning' | 'coding' | 'background' | 'webSearch' | 'image' | 'general';

export interface TaskTypeResult {
  taskType: TaskType;
  confidence: number;
  reasoning: string;
}

const TASK_TYPE_PROMPT = `You are classifying a task to route it to the appropriate model tier.

Task types:
1. "reasoning" — Requires deep thinking, planning, architecture decisions, complex analysis. Needs a powerful model.
   Examples: "Design a system architecture", "Plan the migration strategy", "Analyze this algorithm's complexity"

2. "coding" — Standard code generation, modification, or explanation. Needs a good coding model.
   Examples: "Write a function to sort users", "Add error handling", "Explain this code"

3. "background" — Simple, mechanical tasks that don't need intelligence. Can use a cheap/fast model.
   Examples: "Generate a commit message", "Format this JSON", "Rename variables to camelCase"

4. "webSearch" — Requires current/external information not in the codebase.
   Examples: "What's the latest version of React?", "Find documentation for this API", "Search for best practices"

5. "image" — Involves visual content generation or analysis.
   Examples: "Generate a diagram", "Create a screenshot mockup", "Design a logo"

6. "general" — Doesn't fit other categories clearly.

Respond with ONLY a JSON object:
{"taskType": "reasoning"|"coding"|"background"|"webSearch"|"image"|"general", "confidence": 0.0-1.0, "reasoning": "brief reason"}`;

export async function classifyTaskType(
  task: string,
  llmClient: LLMClient
): Promise<TaskTypeResult | null> {
  return quickClassify(llmClient, TASK_TYPE_PROMPT, task, (parsed) => {
    if (!parsed.taskType || !['reasoning', 'coding', 'background', 'webSearch', 'image', 'general'].includes(parsed.taskType)) return null;
    return {
      taskType: parsed.taskType,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
      reasoning: parsed.reasoning || '',
    };
  });
}

// ─── 5. Smart Suggestions ───────────────────────────────────────
// Replaces: smart-suggestions.ts regex-based content detection

export interface SuggestionResult {
  suggestions: Array<{
    label: string;
    icon: string;
    prompt: string;
    category: string;
  }>;
}

const SUGGESTIONS_PROMPT = `You are generating 3-4 contextual follow-up action suggestions for a user in an AI coding IDE.

Based on the assistant's last response and the user's last message, suggest the most logical next steps.

Rules:
- Suggest 3-4 actions maximum
- Each suggestion should be a concrete, actionable next step
- Use short labels (2-4 words)
- Include an appropriate emoji icon
- The prompt should be a complete instruction the user can send
- Categories: code, test, docs, review, deploy, debug, explore

Respond with ONLY a JSON object:
{"suggestions": [{"label": "Short Label", "icon": "emoji", "prompt": "Full instruction prompt", "category": "code|test|docs|review|deploy|debug|explore"}]}`;

export async function generateSmartSuggestions(
  lastResponse: string,
  lastUserMessage: string,
  llmClient: LLMClient
): Promise<SuggestionResult | null> {
  const userContent = `User's message: "${lastUserMessage}"\n\nAssistant's response (first 500 chars): "${lastResponse.slice(0, 500)}"`;
  return quickClassify(llmClient, SUGGESTIONS_PROMPT, userContent, (parsed) => {
    if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) return null;
    const valid = parsed.suggestions
      .filter((s: any) => s.label && s.prompt && s.icon)
      .slice(0, 4)
      .map((s: any) => ({
        label: String(s.label).slice(0, 30),
        icon: String(s.icon).slice(0, 4),
        prompt: String(s.prompt).slice(0, 200),
        category: ['code', 'test', 'docs', 'review', 'deploy', 'debug', 'explore'].includes(s.category) ? s.category : 'explore',
      }));
    if (valid.length === 0) return null;
    return { suggestions: valid };
  });
}

// ─── 6. Skill Routing ───────────────────────────────────────────
// Replaces: skill-router.ts token overlap scoring

export interface SkillMatchResult {
  skillId: string | null;
  confidence: number;
  reasoning: string;
}

/**
 * Build a system prompt for skill matching that includes available skills.
 */
function buildSkillMatchPrompt(skills: Array<{ id: string; name: string; description: string; category: string; tags: string[] }>): string {
  const skillList = skills.map(s => `- ${s.id}: ${s.name} (${s.category}) — ${s.description} [tags: ${s.tags.join(', ')}]`).join('\n');

  return `You are matching a user's task to the most relevant skill in a coding IDE.

Available skills:
${skillList}

Rules:
- Pick the SINGLE best matching skill, or null if none are relevant (threshold: the task must clearly align with the skill's purpose)
- A skill should only match if the task is specifically about what the skill does
- Generic coding tasks should NOT match specialized skills
- Return null if the match confidence is below 0.5

Respond with ONLY a JSON object:
{"skillId": "skill-id"|null, "confidence": 0.0-1.0, "reasoning": "brief reason"}`;
}

export async function matchSkillWithLLM(
  task: string,
  skills: Array<{ id: string; name: string; description: string; category: string; tags: string[] }>,
  llmClient: LLMClient
): Promise<SkillMatchResult | null> {
  if (skills.length === 0) return { skillId: null, confidence: 1.0, reasoning: 'No skills available' };

  const systemPrompt = buildSkillMatchPrompt(skills);
  return quickClassify(llmClient, systemPrompt, task, (parsed) => {
    if (parsed.skillId !== null && typeof parsed.skillId !== 'string') return null;
    // Validate skill ID exists
    if (parsed.skillId && !skills.some(s => s.id === parsed.skillId)) {
      parsed.skillId = null;
    }
    return {
      skillId: parsed.skillId || null,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: parsed.reasoning || '',
    };
  });
}
