// Orchestrator Planner
// Takes an optimized prompt and produces a structured execution plan
// by dynamically scoring ALL agents in the registry and selecting the best
// combination for swarm execution.

import { AGENT_REGISTRY, AgentDefinition, getAgentsByDepartment } from '../agents/agent-registry';
import type { CallGraphEngine } from '../indexing/call-graph-engine';
import { currentDateContext } from './date-grounding';
import { PERF_FLAGS } from '../main/performance/feature-flags';

// ── Public interfaces ───────────────────────────────────────────────────

export interface AgentTask {
  id: string;
  task: string;
  dependsOn: string[];
  requiresGrounding?: boolean;
}

export type Topology = 'sequential' | 'star' | 'hierarchical' | 'mesh' | 'swarm';

export interface ExecutionPlanMetadata {
  blastRadius?: {
    affectedFiles: string[];
    upstreamCount: number;
    downstreamCount: number;
  };
  /**
   * Primary-artifact-first metadata. Set when the prompt asks for a single
   * self-contained deliverable (e.g. one index.html). Downstream stages use
   * this to pick the right output-format prompt and skip Node/build scaffolding.
   */
  primaryArtifact?: {
    kind: 'static-html';
  };
}

export interface ExecutionPlan {
  plan: string;
  agents: AgentTask[];
  topology: Topology;
  metadata?: ExecutionPlanMetadata;
}

// ── Department role classification ──────────────────────────────────────
// Determines execution phase ordering for dependency resolution.

type DeptRole = 'planning' | 'design' | 'implementation' | 'testing' | 'delivery' | 'support';

const DEPT_ROLES: Record<string, DeptRole> = {
  'Project Management': 'planning',
  'Product': 'planning',
  'Research': 'planning',
  'Design': 'design',
  'Engineering': 'implementation',
  'Specialized': 'implementation',
  'NeuroNest Orchestration': 'implementation',
  'Optimization': 'implementation',
  'Infrastructure': 'implementation',
  'Consensus': 'implementation',
  'Testing': 'testing',
  'Software Delivery': 'delivery',
  'Marketing': 'support',
  'Support': 'support',
};

const PHASE_ORDER: Record<DeptRole, number> = {
  planning: 0,
  design: 1,
  implementation: 2,
  testing: 3,
  delivery: 4,
  support: 5,
};

// ── Dynamic agent scoring ───────────────────────────────────────────────
// Scores every agent in the registry against the prompt using specialty
// keyword matching, department relevance, and task-type boosting.

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s/-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

export function scoreAllAgents(prompt: string): Map<string, number> {
  const scores = new Map<string, number>();
  const promptTokens = tokenize(prompt);
  const promptLower = prompt.toLowerCase();

  for (const agent of AGENT_REGISTRY) {
    let score = 0;

    // 1. Match prompt tokens against agent specialty words
    const specTokens = tokenize(agent.specialty);
    for (const pt of promptTokens) {
      for (const st of specTokens) {
        if (st === pt) { score += 10; break; }
        if (st.includes(pt) || pt.includes(st)) { score += 5; break; }
      }
    }

    // 2. Match against agent name
    const nameTokens = tokenize(agent.name);
    for (const pt of promptTokens) {
      for (const nt of nameTokens) {
        if (nt === pt) { score += 8; break; }
        if (nt.includes(pt) || pt.includes(nt)) { score += 3; break; }
      }
    }

    // 3. Department-level keyword boosts
    const dept = agent.department.toLowerCase();
    if (promptLower.match(/\b(build|create|make|develop|implement|generate|code|write|app|project|website|tool|program|software)\b/)) {
      if (dept.includes('engineering') || dept.includes('orchestration')) score += 6;
      if (dept.includes('design')) score += 3;
    }
    if (promptLower.match(/\b(test|qa|quality|coverage|bug|fix)\b/)) {
      if (dept.includes('testing')) score += 8;
    }
    if (promptLower.match(/\b(deploy|ci|cd|pipeline|docker|kubernetes)\b/)) {
      if (dept.includes('delivery') || dept.includes('infrastructure')) score += 8;
    }
    if (promptLower.match(/\b(security|auth|encrypt|owasp|vulnerability)\b/)) {
      if (agent.id.includes('security') || agent.id.includes('threat') || agent.id.includes('pii')) score += 10;
    }
    if (promptLower.match(/\b(design|ui|ux|layout|style|theme|color)\b/)) {
      if (dept.includes('design')) score += 8;
    }

    // 4. Code generation agents get a baseline boost for build tasks.
    // Tester and docs agents are deliberately excluded — they get separate
    // boosts only when test/docs keywords appear in the prompt.
    if (promptLower.match(/\b(build|create|make|develop|implement|generate)\b/)) {
      const codeAgents = ['neuronest-coder', 'neuronest-architect', 'frontend-developer', 'backend-architect', 'senior-developer', 'rapid-prototyper'];
      if (codeAgents.includes(agent.id)) score += 12;
    }
    if (promptLower.match(/\b(doc|docs|documentation|readme|api\s+reference)\b/)) {
      if (agent.id === 'neuronest-docs' || agent.id === 'technical-writer') score += 10;
    }

    if (score > 0) scores.set(agent.id, score);
  }

  return scores;
}

/**
 * LLM-based agent selection. Uses a reasoning model to semantically match
 * the task to the most relevant agents instead of keyword overlap.
 * Falls back to scoreAllAgents() if LLM is unavailable.
 */
export async function scoreAllAgentsWithLLM(prompt: string, llmClient?: any): Promise<Map<string, number>> {
  if (llmClient) {
    try {
      const { selectAgentsWithLLM } = await import('./llm-decision-engine');
      // Pass a subset of agents (top 30 by department relevance) to keep token count low
      const agentSummaries = AGENT_REGISTRY
        .filter(a => !EXCLUDED_AGENT_IDS.includes(a.id))
        .slice(0, 30)
        .map(a => ({ id: a.id, name: a.name, department: a.department, specialty: a.specialty.slice(0, 80) }));

      const result = await selectAgentsWithLLM(prompt, agentSummaries, llmClient);
      if (result && result.agentIds.length > 0) {
        console.log('[OrchestratorPlanner] LLM agent selection:', result.agentIds.join(', '), '—', result.reasoning);
        const scores = new Map<string, number>();
        // Assign descending scores so ordering is preserved
        result.agentIds.forEach((id: string, i: number) => {
          scores.set(id, 100 - i * 10);
        });
        return scores;
      }
    } catch (err: any) {
      console.warn('[OrchestratorPlanner] LLM agent selection failed, using keyword fallback:', err?.message);
    }
  }
  return scoreAllAgents(prompt);
}

// ── Agent selection ──────────────────────────────────────────────────────

// Agent IDs that are internal-only and must never be selected for user tasks
const EXCLUDED_AGENT_IDS = ['neuronest-critic'];

function selectAgents(scores: Map<string, number>, min: number, max: number): string[] {
  // Filter out internal-only agents (e.g., Critic Agent used only for validation)
  const filtered = [...scores.entries()].filter(([id]) => !EXCLUDED_AGENT_IDS.includes(id));
  const sorted = filtered.sort((a, b) => b[1] - a[1]);

  // Take agents above a relevance threshold, up to max
  const threshold = sorted.length > 0 ? sorted[0][1] * 0.25 : 0; // at least 25% of top score
  const relevant = sorted.filter(([, s]) => s >= threshold && s > 0);
  const count = Math.max(min, Math.min(max, relevant.length));
  const selected = relevant.slice(0, count).map(([id]) => id);

  // Ensure minimum — add core code generation agents if needed.
  // Note: tester/docs are deliberately NOT in this fallback list because
  // they should only be enrolled when the prompt explicitly asks for tests
  // or documentation (handled via department gating + scoring).
  if (selected.length < min) {
    const defaults = ['neuronest-architect', 'neuronest-coder', 'frontend-developer', 'backend-architect', 'senior-developer', 'rapid-prototyper'];
    for (const d of defaults) {
      if (selected.length >= min) break;
      if (!selected.includes(d)) selected.push(d);
    }
  }

  return selected;
}

// ── Dependency resolution ───────────────────────────────────────────────
// Uses department role phases to determine execution order.

function buildDependencies(agentIds: string[]): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const id of agentIds) deps.set(id, []);

  // Group agents by phase
  const phases = new Map<number, string[]>();
  for (const id of agentIds) {
    const agent = AGENT_REGISTRY.find(a => a.id === id);
    const dept = agent?.department || 'Engineering';
    const role = DEPT_ROLES[dept] || 'implementation';
    const phase = PHASE_ORDER[role];
    const list = phases.get(phase) || [];
    list.push(id);
    phases.set(phase, list);
  }

  // Agents in later phases depend on ALL agents in the immediately preceding phase
  const sortedPhases = [...phases.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sortedPhases.length; i++) {
    const prevPhase = sortedPhases[i - 1];
    const currPhase = sortedPhases[i];
    const prevAgents = phases.get(prevPhase) || [];
    const currAgents = phases.get(currPhase) || [];
    for (const curr of currAgents) {
      const existing = deps.get(curr) || [];
      for (const prev of prevAgents) {
        if (!existing.includes(prev)) existing.push(prev);
      }
      deps.set(curr, existing);
    }
  }

  return deps;
}

// ── Topology detection ──────────────────────────────────────────────────

function detectTopology(agents: AgentTask[]): Topology {
  if (agents.length <= 1) return 'sequential';
  if (agents.length >= 6) return 'swarm';

  const depCounts = agents.map(a => a.dependsOn.length);
  const totalDeps = depCounts.reduce((sum, c) => sum + c, 0);
  const noDeps = agents.filter(a => a.dependsOn.length === 0).length;

  // All agents run in parallel (no deps) = mesh
  if (noDeps === agents.length) return 'mesh';

  // One hub, rest depend on it = star
  if (noDeps === 1 && agents.filter(a => a.dependsOn.length === 1).length === agents.length - 1) return 'star';

  // Linear chain
  if (noDeps === 1 && agents.filter(a => a.dependsOn.length <= 1).length === agents.length) return 'sequential';

  // Multiple phases with fan-out
  if (agents.length >= 4) return 'swarm';

  return 'hierarchical';
}

// ── Task description builder ────────────────────────────────────────────

function buildTaskDescription(agent: AgentDefinition, prompt: string): string {
  const promptPreview = prompt.length > 500 ? prompt.slice(0, 500) + '…' : prompt;
  // F5 Date_Grounding_Preamble (Requirement 34.1): prepend current-date context
  // to task-planning prompts so agents stop emitting stale-year queries. Gated
  // by DATE_GROUNDING_ENABLED — when false, the prompt is emitted unchanged.
  const datePreamble = PERF_FLAGS.DATE_GROUNDING_ENABLED ? currentDateContext() : '';
  return `${datePreamble}You are ${agent.name} (${agent.department} department). Your specialty: ${agent.specialty.slice(0, 200)}\n\n` +
    `USER REQUEST: ${promptPreview}\n\n` +
    `YOUR TASK: Generate complete, production-ready code files for your area of expertise. ` +
    `Output each file with a "// file: path/filename.ext" annotation followed by a markdown code block. ` +
    `Generate 3-10 complete files. Do NOT just describe — write the actual code.\n\n` +
    `CRITICAL RULE: If the user asks you to review, analyze, or fix a specific file, you MUST work ONLY with ` +
    `the actual file content provided in the context above. If the file is NOT in the context, respond: ` +
    `"I could not find [filename] in the loaded project files. Please ensure it exists in your project directory." ` +
    `NEVER generate a stub or placeholder and pretend it is the user's file.`;
}

function buildPlanSummary(agents: AgentTask[], topology: Topology): string {
  // Group by department for summary
  const deptCounts = new Map<string, number>();
  for (const a of agents) {
    const agent = AGENT_REGISTRY.find(r => r.id === a.id);
    const dept = agent?.department || 'Unknown';
    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
  }
  const deptSummary = [...deptCounts.entries()].map(([d, c]) => `${d}(${c})`).join(', ');
  const phases = new Set(agents.map(a => a.dependsOn.length)).size;
  return `${topology.toUpperCase()} execution: ${agents.length} agents from ${deptCounts.size} departments [${deptSummary}] across ~${phases} phase(s)`;
}

// ── User constraint parsing ─────────────────────────────────────────────
// Detects explicit user instructions about which agents to use or mode to run in.

interface UserConstraints {
  singleAgent: boolean;
  specificAgents: string[];
  maxAgents?: number;
}

function parseUserConstraints(prompt: string): UserConstraints {
  const lower = prompt.toLowerCase();
  const constraints: UserConstraints = { singleAgent: false, specificAgents: [] };

  // Detect single-agent mode requests
  if (lower.match(/\b(single[- ]agent|one agent|only one agent|use only|just use)\b/)) {
    constraints.singleAgent = true;
  }

  // Detect "X only" or "use X" or "only X" patterns for specific agents
  const onlyPatterns = [
    /\b(?:use|only|just)\s+(?:the\s+)?([a-z][a-z\s-]+?)\s+(?:agent|only|for this)\b/i,
    /\b([a-z][a-z\s-]+?)\s+only\b/i,
    /\b(?:single[- ]agent\s+mode,?\s*)([a-z][a-z\s-]+?)(?:\s+only|\s*$)/i,
  ];

  for (const pattern of onlyPatterns) {
    const match = prompt.match(pattern);
    if (match && match[1]) {
      const agentQuery = match[1].trim().toLowerCase();
      // Try to find matching agent(s) in the registry
      const found = AGENT_REGISTRY.find(a =>
        a.name.toLowerCase().includes(agentQuery) ||
        a.id.toLowerCase().includes(agentQuery.replace(/\s+/g, '-')) ||
        a.specialty.toLowerCase().includes(agentQuery)
      );
      if (found && !constraints.specificAgents.includes(found.id)) {
        constraints.specificAgents.push(found.id);
      }
    }
  }

  // Detect explicit agent names mentioned with "use" or "with"
  const usePattern = /\b(?:use|with|assign to|route to)\s+(?:the\s+)?(.+?)(?:\s+agent|\s+for|\s*$)/gi;
  let useMatch;
  while ((useMatch = usePattern.exec(prompt)) !== null) {
    const query = useMatch[1].trim().toLowerCase();
    if (query.length < 3 || query.length > 40) continue;
    const found = AGENT_REGISTRY.find(a =>
      a.name.toLowerCase() === query ||
      a.name.toLowerCase().includes(query) ||
      a.id === query.replace(/\s+/g, '-')
    );
    if (found && !constraints.specificAgents.includes(found.id)) {
      constraints.specificAgents.push(found.id);
    }
  }

  // Detect max agent count constraints
  const maxMatch = lower.match(/\b(?:max|maximum|at most|no more than)\s+(\d+)\s+agent/);
  if (maxMatch) {
    constraints.maxAgents = parseInt(maxMatch[1]);
    if (constraints.maxAgents === 1) constraints.singleAgent = true;
  }

  // If specific agents found, mark as single-agent if only one
  if (constraints.specificAgents.length === 1) {
    constraints.singleAgent = true;
  }

  return constraints;
}

/**
 * LLM-based user constraint parsing. Uses a reasoning model to understand
 * natural language instructions about agent selection and mode preferences.
 * Falls back to regex-based parseUserConstraints() if LLM is unavailable.
 */
async function parseUserConstraintsWithLLM(prompt: string, llmClient?: any): Promise<UserConstraints> {
  if (llmClient) {
    try {
      const agentNames = AGENT_REGISTRY.slice(0, 30).map(a => a.name).join(', ');
      const response = await llmClient.chat([
        { role: 'system', content: `Extract user constraints about agent selection from the prompt. Available agents: ${agentNames}.\n\nRespond with ONLY a JSON object:\n{"singleAgent": true|false, "specificAgents": ["agent-id-1"], "maxAgents": number|null}\n\nRules:\n- singleAgent: true if user wants only one agent\n- specificAgents: agent IDs the user explicitly requested (use kebab-case IDs)\n- maxAgents: number if user specified a limit, null otherwise\n- If no constraints mentioned, return {"singleAgent": false, "specificAgents": [], "maxAgents": null}` },
        { role: 'user', content: prompt },
      ], { temperature: 0, maxTokens: 100 });

      if (response.content) {
        let jsonStr = response.content.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(jsonStr);
        const constraints: UserConstraints = {
          singleAgent: parsed.singleAgent === true,
          specificAgents: Array.isArray(parsed.specificAgents) ? parsed.specificAgents : [],
          maxAgents: typeof parsed.maxAgents === 'number' ? parsed.maxAgents : undefined,
        };
        if (constraints.specificAgents.length > 0 || constraints.singleAgent || constraints.maxAgents) {
          console.log('[OrchestratorPlanner] LLM parsed constraints:', constraints);
          return constraints;
        }
      }
    } catch (err: any) {
      console.warn('[OrchestratorPlanner] LLM constraint parsing failed:', err?.message);
    }
  }
  return parseUserConstraints(prompt);
}

// ── Primary-artifact-first detection ────────────────────────────────────
// Detects when the user asks for a single self-contained deliverable (e.g.
// one index.html with all logic inline). When this fires, the planner caps
// agent count to 1, forces sequential topology, and tags metadata so the
// swarm coordinator can swap in a static-HTML output format instead of the
// Node/build-tools production format.

export interface SingleArtifactIntent {
  singleArtifact: boolean;
  kind?: 'static-html';
}

export function detectSingleArtifactIntent(prompt: string): SingleArtifactIntent {
  const lower = prompt.toLowerCase();

  // Strong signals: explicit "single X file" phrasing
  const singleFilePhrase = /\b(single|one|a single|just one|one[- ]single)\s+(file|page|index\.html?|html(?:\s+file)?)\b/.test(lower);

  // Filename hint: prompt mentions index.html (or app.html / *.html as the deliverable)
  const indexHtmlMention = /\bindex\.html?\b/.test(lower);
  const onlyHtmlMention = /\b(only|just)\s+(an?\s+)?html\b/.test(lower);

  // No-tooling signals
  const noBuildTools = /\bno\s+(npm|yarn|pnpm|build\s+tools?|build\s+step|bundler|webpack|vite|framework|frameworks?|react|vue|angular)\b/.test(lower);
  const browserOnly = /\b(browser[- ]only|static\s+(page|demo|html|site)|self[- ]contained\s+(html|page|file))\b/.test(lower);

  // Counter-signal: prompt explicitly asks for multi-file / app / project
  const multiFileSignal = /\b(monorepo|multiple\s+files|multi[- ]page|spa\s+app|backend|server|api\s+endpoint|database|ci\/cd|pipeline|microservice)\b/.test(lower);

  if (multiFileSignal) {
    return { singleArtifact: false };
  }

  // Static-HTML intent fires when at least one strong signal AND html is mentioned somewhere.
  const htmlMentioned = indexHtmlMention || onlyHtmlMention || /\bhtml\b/.test(lower);
  const strongSignal = singleFilePhrase || indexHtmlMention || noBuildTools || browserOnly;

  if (strongSignal && htmlMentioned) {
    return { singleArtifact: true, kind: 'static-html' };
  }

  return { singleArtifact: false };
}

// ── Department gating for support roles ─────────────────────────────────
// Software Delivery, Testing, and Infrastructure agents must NOT be enrolled
// purely from a universal "build/create/make" verb boost. They enroll only
// when the prompt explicitly mentions their domain.

const DEFAULT_OPEN_DEPARTMENTS = new Set([
  'Engineering',
  'NeuroNest Orchestration',
  'Design',
  'Specialized',
  'Optimization',
  'Consensus',
  'Project Management',
  'Product',
  'Research',
  'Marketing',
  'Support',
]);

const DEPARTMENT_ENROLLMENT_TRIGGERS: Record<string, RegExp> = {
  'Testing': /\b(test|tests|testing|qa|coverage|spec|specs|playwright|cypress|jest|vitest|e2e|end[- ]to[- ]end|load\s+test|stress\s+test|pen[- ]?test|penetration|audit)\b/i,
  'Software Delivery': /\b(deploy|deployment|ci|cd|ci\/cd|pipeline|release|gate|sdlc|requirements\s+doc|solution\s+architect|gatekeeper|compliance)\b/i,
  'Infrastructure': /\b(docker|dockerfile|kubernetes|k8s|terraform|infra|infrastructure|cluster|service\s+mesh|load\s+balanc|memory\s+coordinator|scheduler|observability)\b/i,
};

/**
 * Apply department gating: strip agents from non-default-open departments
 * unless their department's trigger regex matched the prompt. Idempotent —
 * agents in DEFAULT_OPEN_DEPARTMENTS pass through untouched.
 */
function applyDepartmentGating(scores: Map<string, number>, prompt: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [agentId, score] of scores) {
    const agent = AGENT_REGISTRY.find(a => a.id === agentId);
    if (!agent) continue;
    if (DEFAULT_OPEN_DEPARTMENTS.has(agent.department)) {
      out.set(agentId, score);
      continue;
    }
    const trigger = DEPARTMENT_ENROLLMENT_TRIGGERS[agent.department];
    if (trigger && trigger.test(prompt)) {
      out.set(agentId, score);
    }
    // Else: drop — gated department with no explicit trigger
  }
  return out;
}

// ── OrchestratorPlanner class ───────────────────────────────────────────

export class OrchestratorPlanner {
  private callGraphEngine: CallGraphEngine | undefined;

  constructor(callGraphEngine?: CallGraphEngine) {
    this.callGraphEngine = callGraphEngine;
  }

  /**
   * Analyze an optimized prompt and produce a structured execution plan.
   * Dynamically scores ALL 110 agents in the registry and selects the
   * best 3-10 for swarm execution with proper phase ordering.
   *
   * When a CallGraphEngine is available, queries blast radius for functions
   * mentioned in the prompt to include affected files in plan metadata.
   */
  createPlan(optimizedPrompt: string): ExecutionPlan {
    // 0. Parse user constraints — detect explicit agent/mode instructions
    const constraints = parseUserConstraints(optimizedPrompt);

    // 0b. Primary-artifact-first detection — single static HTML deliverable
    const artifact = detectSingleArtifactIntent(optimizedPrompt);

    // Query blast radius if call graph engine is available
    const metadata = this.computeBlastRadiusMetadata(optimizedPrompt);

    // Single-artifact intent overrides default agent expansion when the user
    // hasn't already pinned specific agents. One frontend-developer running
    // sequentially produces a self-contained index.html with no scaffolding.
    if (
      artifact.singleArtifact &&
      artifact.kind === 'static-html' &&
      !constraints.singleAgent &&
      constraints.specificAgents.length === 0
    ) {
      const primaryAgentId = 'frontend-developer';
      const def = AGENT_REGISTRY.find(a => a.id === primaryAgentId);
      const task = def
        ? buildTaskDescription(def, optimizedPrompt)
        : `Execute task for: "${optimizedPrompt.slice(0, 100)}"`;
      const agents: AgentTask[] = [{ id: primaryAgentId, task, dependsOn: [], requiresGrounding: true }];
      const topology: Topology = 'sequential';
      const plan = buildPlanSummary(agents, topology);
      const mergedMetadata: ExecutionPlanMetadata = {
        ...(metadata || {}),
        primaryArtifact: { kind: 'static-html' },
      };
      return { plan, agents, topology, metadata: mergedMetadata };
    }

    if (constraints.singleAgent || constraints.specificAgents.length > 0) {
      // User explicitly requested specific agents — honor that
      const requestedIds = constraints.specificAgents.length > 0
        ? constraints.specificAgents
        : ['neuronest-coder']; // default single agent

      const agents: AgentTask[] = requestedIds.map(id => {
        const def = AGENT_REGISTRY.find(a => a.id === id);
        const task = def
          ? buildTaskDescription(def, optimizedPrompt)
          : `Execute task for: "${optimizedPrompt.slice(0, 100)}"`;
        return { id, task, dependsOn: [] };
      });

      const topology: Topology = agents.length === 1 ? 'sequential' : 'mesh';
      const plan = buildPlanSummary(agents, topology);

      // Post-processing: enforce grounding requirement on all agent tasks
      for (const agent of agents) {
        agent.requiresGrounding = true;
      }

      return { plan, agents, topology, ...(metadata ? { metadata } : {}) };
    }

    // 1. Score every agent in the registry against the prompt
    const rawScores = scoreAllAgents(optimizedPrompt);

    // 1b. Department gating: keep Testing/Software Delivery/Infrastructure
    // agents dormant unless the prompt explicitly mentions their domain.
    // This prevents universal "build" verb boosts from leaking testers,
    // CI/CD, and infra agents into casual single-feature prompts.
    const scores = applyDepartmentGating(rawScores, optimizedPrompt);

    // 2. Select top 3-10 agents (respect maxAgents constraint if set)
    const maxAgents = constraints.maxAgents || 10;
    const selectedIds = selectAgents(scores, 3, Math.min(maxAgents, 10));

    // 3. Build phase-based dependency graph
    const deps = buildDependencies(selectedIds);

    // 4. Create AgentTask objects
    const agents: AgentTask[] = selectedIds.map(id => {
      const def = AGENT_REGISTRY.find(a => a.id === id);
      const task = def
        ? buildTaskDescription(def, optimizedPrompt)
        : `Execute task for: "${optimizedPrompt.slice(0, 100)}"`;
      return { id, task, dependsOn: deps.get(id) ?? [] };
    });

    // 5. Detect topology
    const topology = detectTopology(agents);

    // 6. Build plan summary
    const plan = buildPlanSummary(agents, topology);

    // 7. Post-processing: enforce grounding requirement on all agent tasks
    for (const agent of agents) {
      agent.requiresGrounding = true;
    }

    return { plan, agents, topology, ...(metadata ? { metadata } : {}) };
  }

  /**
   * Compute blast radius metadata by extracting function identifiers from the prompt
   * and querying the call graph engine. Returns undefined if the engine is unavailable
   * or no functions are identified.
   */
  private computeBlastRadiusMetadata(prompt: string): ExecutionPlanMetadata | undefined {
    if (!this.callGraphEngine) {
      return undefined;
    }

    try {
      // Extract potential function identifiers from the prompt
      const functionIds = this.extractFunctionIdentifiers(prompt);

      if (functionIds.length === 0) {
        return undefined;
      }

      // Aggregate blast radius across all identified functions
      const allAffectedFiles = new Set<string>();
      let totalUpstream = 0;
      let totalDownstream = 0;

      for (const functionId of functionIds) {
        const blastRadius = this.callGraphEngine.getBlastRadius(functionId);
        for (const file of blastRadius.affectedFiles) {
          allAffectedFiles.add(file);
        }
        totalUpstream += blastRadius.upstream.length;
        totalDownstream += blastRadius.downstream.length;
      }

      if (allAffectedFiles.size === 0 && totalUpstream === 0 && totalDownstream === 0) {
        return undefined;
      }

      return {
        blastRadius: {
          affectedFiles: Array.from(allAffectedFiles),
          upstreamCount: totalUpstream,
          downstreamCount: totalDownstream,
        },
      };
    } catch (e: any) {
      // Error isolation: skip blast radius if call graph query fails
      console.warn('[OrchestratorPlanner] Blast radius query failed, skipping:', e?.message);
      return undefined;
    }
  }

  /**
   * Extract potential function identifiers from a prompt.
   * Looks for patterns like function names, method references, and file:function notation.
   */
  private extractFunctionIdentifiers(prompt: string): string[] {
    const identifiers: string[] = [];

    // Match camelCase or snake_case identifiers that look like function names
    // Pattern: word boundaries around identifiers with parentheses or preceded by "function"/"method"
    const functionPatterns = [
      /\b(?:function|method|fn)\s+([a-zA-Z_]\w*)/g,
      /\b([a-zA-Z_]\w*)\s*\(\)/g,
      /\b([a-zA-Z_]\w*\.[a-zA-Z_]\w*)\b/g,
    ];

    for (const pattern of functionPatterns) {
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        const id = match[1];
        if (id && id.length > 2 && !identifiers.includes(id)) {
          identifiers.push(id);
        }
      }
    }

    return identifiers;
  }
}
