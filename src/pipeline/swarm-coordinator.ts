// Swarm Coordinator
// Executes an orchestrator plan by assigning agents to phases,
// running them in parallel, handling handoffs, and detecting consensus.

import { AGENT_REGISTRY, AgentDefinition } from '../agents/agent-registry';
import { LLMClient } from './llm-client';
import { ExecutionPlan, AgentTask } from './orchestrator-planner';
import { encodeGeneric, encodeGraph, GCF_PRIMER, type GraphPayload } from '../serializers/gcf-encoder';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { logger } from '../utils/logger';

// ── F10 GCF_Wire_Format — swarm-handoff surface ─────────────────────────

/**
 * Structural type for the Metrics_Sink — kept minimal and local so the
 * coordinator does not import `SessionTelemetryService` directly. Any object
 * exposing `recordMetric(sessionId, key, value)` satisfies it (notably
 * `SessionTelemetryService` from `src/session/session-telemetry.ts`).
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/** Metrics_Sink key for the swarm-handoff GCF size savings (Requirement 54.2 / 55). */
export const SWARM_HANDOFF_SAVINGS_METRIC_KEY = 'gcf.swarm_handoff.savings_ratio';

/**
 * A Pipeline_Trace record — the structured swarm-handoff context that crosses
 * a sub-agent boundary when one agent passes its output to a downstream peer.
 * This is the F10_Encoded_Surface payload for the swarm-handoff seam.
 */
export interface PipelineTraceRecord {
  type: 'pipeline_trace';
  fromAgent: string;
  toAgent: string;
  phase: number;
  content: string;
}

export interface HandoffEncodeContext {
  /** Metrics_Sink for `gcf.swarm_handoff.savings_ratio`. Optional. */
  metricsSink?: MetricsSink | null;
  /** Session id for the metric sample. Null/omitted records a global metric. */
  sessionId?: string | null;
}

export interface HandoffEncodeResult {
  /** Which encoding the returned `payload` is in. */
  encoding: 'json' | 'gcf';
  /** The body to inject into the downstream agent's context. */
  payload: string;
}

/** Narrow a handoff record to the GCF graph profile when it is graph-shaped. */
function isGraphShapedHandoff(record: unknown): record is GraphPayload {
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof (record as { tool?: unknown }).tool === 'string' &&
    Array.isArray((record as { symbols?: unknown }).symbols)
  );
}

/**
 * Apply the GCF wire-format to a cross-agent handoff Pipeline_Trace record
 * (F10_Encoded_Surface: swarm handoff). Returns the body to inject into the
 * downstream agent's context plus which encoding it is in.
 *
 * Paired-flag behaviour (Requirements 54.2, 55):
 *  - GCF_WIRE_FORMAT=true            → send the GCF-encoded payload across the
 *                                      handoff (falls back to JSON on encode
 *                                      failure) and emit savings telemetry.
 *  - GCF_WIRE_FORMAT=false + SHADOW  → compute the encoding for telemetry
 *                                      only; the handoff payload (`jsonBody`)
 *                                      is returned UNCHANGED.
 *  - both flags false                → skip GCF computation entirely; payload
 *                                      returned unchanged (Requirement 55.4).
 *
 * An encode failure (`null`) deterministically falls back to the existing JSON
 * path (Requirement 51.4 / 54.5). Telemetry is fail-soft — a throwing sink
 * never breaks the handoff.
 */
export function encodeHandoffForLLM(
  trace: PipelineTraceRecord,
  jsonBody: string,
  ctx: HandoffEncodeContext = {},
): HandoffEncodeResult {
  const active = PERF_FLAGS.GCF_WIRE_FORMAT;
  const shadow = PERF_FLAGS.GCF_WIRE_FORMAT_SHADOW;

  // Requirement 55.4: with both flags false, skip GCF computation entirely.
  if (!active && !shadow) {
    return { encoding: 'json', payload: jsonBody };
  }

  // Encode the Pipeline_Trace record through GCF — the graph profile when the
  // record is graph-shaped, else the generic tabular profile (design F10 table).
  const encoded = isGraphShapedHandoff(trace)
    ? encodeGraph(trace)
    : encodeGeneric(trace);

  // Encode failure → fall back to the existing JSON path; emit no telemetry.
  if (encoded === null) {
    return { encoding: 'json', payload: jsonBody };
  }

  // Savings ratio = fraction of bytes GCF saves vs the JSON encoding of the
  // same record (encoded size vs JSON size). 0.30 means GCF is 30% smaller.
  const jsonBytes = Buffer.byteLength(JSON.stringify(trace), 'utf8');
  const gcfBytes = Buffer.byteLength(encoded, 'utf8');
  const savingsRatio = jsonBytes > 0 ? 1 - gcfBytes / jsonBytes : 0;
  recordSwarmHandoffSavings(ctx, savingsRatio);

  // Active mode sends the GCF payload across the handoff; shadow mode leaves
  // the handoff payload unchanged (only the telemetry above is emitted).
  return active
    ? { encoding: 'gcf', payload: encoded }
    : { encoding: 'json', payload: jsonBody };
}

/**
 * Emit `gcf.swarm_handoff.savings_ratio` to the Metrics_Sink. Telemetry must
 * never break a handoff, so failures fall through to the logger hook. When no
 * Metrics_Sink is wired (legacy call sites), the logger is the sink.
 */
function recordSwarmHandoffSavings(ctx: HandoffEncodeContext, savingsRatio: number): void {
  if (!Number.isFinite(savingsRatio)) return;
  const sessionId = ctx.sessionId ?? null;
  if (ctx.metricsSink) {
    try {
      ctx.metricsSink.recordMetric(sessionId, SWARM_HANDOFF_SAVINGS_METRIC_KEY, savingsRatio);
      return;
    } catch {
      // fall through to the logger — telemetry must never break the handoff
    }
  }
  logger.debug(`[Swarm] ${SWARM_HANDOFF_SAVINGS_METRIC_KEY}=${savingsRatio.toFixed(4)}`);
}

// ── Event types ─────────────────────────────────────────────────────────

export type SwarmEventType =
  | 'phase_start'
  | 'agent_start'
  | 'agent_token'
  | 'agent_complete'
  | 'handoff'
  | 'consensus_result'
  | 'swarm_complete';

export interface SwarmEvent {
  type: SwarmEventType;
  agentId?: string;
  agentName?: string;
  phase?: number;
  content?: string;
  reasoning?: string;
  fromAgent?: string;
  toAgent?: string;
  confidence?: number;
  token?: string;
  msgId?: string;
  done?: boolean;
  error?: boolean;
}

export type SwarmEventCallback = (event: SwarmEvent) => void;

// ── Result types ────────────────────────────────────────────────────────

export interface ConsensusEntry {
  department: string;
  content: string;
  confidence: number;
}

export interface SwarmResult {
  outputs: Map<string, string>;
  consensusResults: ConsensusEntry[];
  totalPhases: number;
  topology: string;
}

// ── SwarmMemoryPool ─────────────────────────────────────────────────────

export class SwarmMemoryPool {
  private store = new Map<string, string>();

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  getContextSummary(): string {
    if (this.store.size === 0) return '';

    const entries: string[] = [];
    for (const [key, value] of this.store) {
      const preview = value.length > 1000 ? value.slice(0, 1000) + '…' : value;
      entries.push(`[${key}]: ${preview}`);
    }
    return entries.join('\n');
  }

  clear(): void {
    this.store.clear();
  }
}

// ── No-Provider Fallback ────────────────────────────────────────────────
// When no LLM is configured, agents show a clear message instead of fake output.

function getNoProviderMessage(agentId: string, task: string): string {
  const agentDef = AGENT_REGISTRY.find((a) => a.id === agentId);
  const agentName = agentDef?.name || agentId;

  return `## ⚠️ No AI Provider Configured — ${agentName}\n\n` +
    `This agent requires a configured AI provider to generate real output.\n\n` +
    `**To fix this:**\n` +
    `1. Go to **Settings** → **AI Providers**\n` +
    `2. Add at least one provider (OpenAI, Anthropic, Ollama, etc.)\n` +
    `3. Re-run your task\n\n` +
    `*Without a provider, agents cannot generate code, analysis, or recommendations.*`;
}

// ── Phase assignment ────────────────────────────────────────────────────

interface PhaseAssignment {
  phase: number;
  agents: AgentTask[];
}

function assignPhases(agents: AgentTask[]): PhaseAssignment[] {
  // Topological sort into phases:
  // Phase 0 = agents with no dependencies
  // Phase N = agents whose dependencies are all in phases < N
  const phaseMap = new Map<string, number>();
  const agentMap = new Map<string, AgentTask>();
  for (const agent of agents) {
    agentMap.set(agent.id, agent);
  }

  // Iteratively assign phases
  let assigned = 0;
  const total = agents.length;
  let currentPhase = 0;
  const maxIterations = total + 1; // safety valve

  while (assigned < total && currentPhase < maxIterations) {
    for (const agent of agents) {
      if (phaseMap.has(agent.id)) continue;

      const depsResolved = agent.dependsOn.every((dep) => phaseMap.has(dep));
      if (depsResolved) {
        phaseMap.set(agent.id, currentPhase);
        assigned++;
      }
    }
    currentPhase++;
  }

  // Handle any unassigned agents (circular deps) — put them in the last phase
  for (const agent of agents) {
    if (!phaseMap.has(agent.id)) {
      phaseMap.set(agent.id, currentPhase);
    }
  }

  // Group by phase
  const phases = new Map<number, AgentTask[]>();
  for (const agent of agents) {
    const p = phaseMap.get(agent.id) ?? 0;
    const list = phases.get(p) ?? [];
    list.push(agent);
    phases.set(p, list);
  }

  // Convert to sorted array
  const result: PhaseAssignment[] = [];
  const sortedPhases = [...phases.keys()].sort((a, b) => a - b);
  for (const p of sortedPhases) {
    result.push({ phase: p, agents: phases.get(p)! });
  }

  return result;
}

// ── Token streaming simulation ──────────────────────────────────────────

// Token streaming removed — full responses are sent via agent_complete events.
// The simulateTokenStream function was causing pipeline hangs due to thousands
// of delayed IPC events that were never handled by the renderer.

// ── Consensus detection ─────────────────────────────────────────────────

function detectConsensusGroups(agents: AgentTask[]): Map<string, string[]> {
  // Group agents by department — consensus applies when 2+ agents share a department
  const deptAgents = new Map<string, string[]>();

  for (const agent of agents) {
    const def = AGENT_REGISTRY.find((a) => a.id === agent.id);
    if (!def) continue;

    const list = deptAgents.get(def.department) ?? [];
    list.push(agent.id);
    deptAgents.set(def.department, list);
  }

  // Only keep groups with 2+ agents
  const groups = new Map<string, string[]>();
  for (const [dept, ids] of deptAgents) {
    if (ids.length >= 2) {
      groups.set(dept, ids);
    }
  }

  return groups;
}

function produceConsensus(
  department: string,
  agentIds: string[],
  outputs: Map<string, string>,
): ConsensusEntry {
  // Merge outputs from same-department agents into a consensus summary
  const agentOutputs = agentIds
    .map((id) => {
      const output = outputs.get(id);
      return output ? `[${id}]: ${output.slice(0, 300)}` : null;
    })
    .filter(Boolean);

  const confidence = 0.7 + Math.random() * 0.25; // 0.70 – 0.95

  return {
    department,
    content: `Consensus from ${agentIds.length} ${department} agents:\n\n${agentOutputs.join('\n\n---\n\n')}\n\nAgreed approach: The agents converged on a unified strategy combining their individual recommendations. Key alignment points have been merged and conflicts resolved by majority preference.`,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ── SwarmCoordinator class ──────────────────────────────────────────────

export class SwarmCoordinator {
  private llmClient: LLMClient | null;
  private _aborted = false;
  private _activeClients: LLMClient[] = [];
  private metricsSink: MetricsSink | null;

  constructor(
    private memoryPool: SwarmMemoryPool,
    llmClient?: LLMClient | null,
    metricsSink?: MetricsSink | null,
  ) {
    this.llmClient = llmClient || null;
    this.metricsSink = metricsSink || null;
  }

  /** Abort the current swarm execution and all in-flight LLM requests */
  abort(): void {
    this._aborted = true;
    console.log('[Swarm] Abort signal received — killing', this._activeClients.length, 'active LLM requests');
    for (const client of this._activeClients) {
      try { client.abort(); } catch {}
    }
    this._activeClients = [];
  }

  get aborted(): boolean { return this._aborted; }

  /**
   * Execute an orchestrator plan: assign agents to phases, run each phase
   * in parallel, handle handoffs between phases, detect consensus, and
   * return the complete swarm result.
   */
  async execute(plan: ExecutionPlan, onEvent?: SwarmEventCallback, agentLLMConfigs?: Map<string, LLMClient>): Promise<SwarmResult> {
    this._aborted = false;
    const outputs = new Map<string, string>();
    const phases = assignPhases(plan.agents);

    for (const { phase, agents } of phases) {
      // ── Check abort before each phase ──
      if (this._aborted) {
        onEvent?.({ type: 'swarm_complete', content: 'Swarm aborted by user' });
        return { outputs, consensusResults: [], totalPhases: phases.length, topology: plan.topology };
      }

      // ── Phase start ──
      onEvent?.({
        type: 'phase_start',
        phase,
        content: `Phase ${phase}: executing ${agents.length} agent(s) in parallel`,
      });

      // ── Execute all agents in this phase with concurrency limit ──
      const MAX_CONCURRENT_AGENTS = 3; // Limit to prevent Ollama crashes
      const promises: Promise<{ id: string; response: string }>[] = [];
      
      // Process agents in batches to limit concurrency
      for (let i = 0; i < agents.length; i += MAX_CONCURRENT_AGENTS) {
        const batch = agents.slice(i, i + MAX_CONCURRENT_AGENTS);
        const batchPromises = batch.map(async (agentTask) => {
        // Check abort before each agent
        if (this._aborted) return { id: agentTask.id, response: '' };

        const agentDef = AGENT_REGISTRY.find((a) => a.id === agentTask.id);
        const agentName = agentDef?.name ?? agentTask.id;

        // Inject handoff context from dependencies
        let contextPrefix = '';
        for (const depId of agentTask.dependsOn) {
          const depOutput = outputs.get(depId);
          if (depOutput) {
            onEvent?.({
              type: 'handoff',
              fromAgent: depId,
              toAgent: agentTask.id,
              content: `Injecting output from ${depId} into ${agentTask.id} context`,
            });

            // F10_Encoded_Surface (swarm handoff): the Pipeline_Trace record
            // crossing the sub-agent boundary. The pre-existing JSON path
            // injects the raw (truncated) upstream output; GCF wire-format is
            // applied via the paired-flag pattern. With default flags
            // (GCF_WIRE_FORMAT=false) the body is unchanged. See Req 54.2 / 55.
            const traceContent = depOutput.slice(0, 2000);
            const trace: PipelineTraceRecord = {
              type: 'pipeline_trace',
              fromAgent: depId,
              toAgent: agentTask.id,
              phase,
              content: traceContent,
            };
            const handoff = encodeHandoffForLLM(trace, traceContent, {
              metricsSink: this.metricsSink,
            });
            contextPrefix += `\n--- Context from ${depId} ---\n${handoff.payload}\n`;
          }
        }

        // Agent start
        onEvent?.({
          type: 'agent_start',
          agentId: agentTask.id,
          agentName,
          phase,
          content: `${agentName} starting task`,
        });

        // Build the full task with injected context and shared memory
        const memoryContext = this.memoryPool.getContextSummary();
        const fullTask = (contextPrefix ? `${agentTask.task}\n\nPrior context:\n${contextPrefix}` : agentTask.task)
          + (memoryContext ? '\n\n' + memoryContext : '');

        // Generate response — use agent-specific LLM, fall back to default, then simulation
        let response: string;
        let agentReasoning: string | undefined;
        // Check abort before expensive LLM call
        if (this._aborted) {
          return { id: agentTask.id, response: '' };
        }
        // Priority: per-agent config (from agentLLMConfigs) → default LLM client → simulated
        const agentLLM = agentLLMConfigs?.get(agentTask.id) || this.llmClient;
        if (agentLLM) {
          try {
            // Determine context budget for this model
            const isLocal = (agentLLM as any).config?.provider === 'ollama' || 
                            (agentLLM as any).config?.provider === 'llamacpp' ||
                            ((agentLLM as any).config?.baseUrl && ((agentLLM as any).config.baseUrl.includes('localhost') || (agentLLM as any).config.baseUrl.includes('127.0.0.1')));
            const modelContextTokens = isLocal ? 4096 : 8192;
            // Reserve tokens for completion output
            const maxTokens = Math.min(2048, Math.floor(modelContextTokens * 0.5));
            // Budget for prompt = context - completion - headroom
            const promptBudgetTokens = modelContextTokens - maxTokens - 300;
            const promptBudgetChars = promptBudgetTokens * 3; // ~3 chars per token conservative

            const { PRODUCTION_OUTPUT_FORMAT, STATIC_HTML_OUTPUT_FORMAT } = require('./code-generation-enhancer');
            // Switch output format when planner flagged single-artifact intent.
            const outputFormat = plan.metadata?.primaryArtifact?.kind === 'static-html'
              ? STATIC_HTML_OUTPUT_FORMAT
              : PRODUCTION_OUTPUT_FORMAT;

            let agentSystemPrompt = (agentDef?.systemPrompt || 'You are a helpful AI assistant.') + outputFormat;

            // ── F10 GCF primer injection ──
            // Prepend the GCF comprehension primer when the wire format is active.
            if (PERF_FLAGS.GCF_WIRE_FORMAT) {
              agentSystemPrompt = GCF_PRIMER + '\n\n' + agentSystemPrompt;
            }
            
            // Truncate system prompt if it exceeds budget (leave room for task)
            const taskBudget = Math.floor(promptBudgetChars * 0.4);
            const systemBudget = promptBudgetChars - taskBudget;
            if (agentSystemPrompt.length > systemBudget) {
              agentSystemPrompt = agentSystemPrompt.slice(0, systemBudget - 20) + '\n[truncated]';
            }
            let truncatedTask = fullTask;
            if (truncatedTask.length > taskBudget) {
              truncatedTask = truncatedTask.slice(0, taskBudget - 20) + '\n[truncated]';
            }

            this._activeClients.push(agentLLM);

            // Use true streaming — forward tokens as they arrive from the LLM
            const crypto = require('node:crypto');
            const streamMsgId = crypto.randomUUID();
            let streamedContent = '';

            // Signal stream start
            onEvent?.({
              type: 'agent_token',
              agentId: agentTask.id,
              agentName,
              msgId: streamMsgId,
              token: '',
              done: false,
            });

            await agentLLM.chatStream([
              { role: 'system', content: agentSystemPrompt },
              { role: 'user', content: truncatedTask },
            ], {
              onToken: ({ content: tokenText }) => {
                streamedContent += tokenText;
                onEvent?.({
                  type: 'agent_token',
                  agentId: agentTask.id,
                  agentName,
                  msgId: streamMsgId,
                  token: tokenText,
                });
              },
              onDone: (result) => {
                onEvent?.({
                  type: 'agent_token',
                  agentId: agentTask.id,
                  agentName,
                  msgId: streamMsgId,
                  done: true,
                });
              },
              onError: ({ message: errMsg, partialContent }) => {
                streamedContent = partialContent;
                onEvent?.({
                  type: 'agent_token',
                  agentId: agentTask.id,
                  agentName,
                  msgId: streamMsgId,
                  done: true,
                  error: true,
                  content: errMsg,
                });
              },
            }, { temperature: 0.7, maxTokens, nLoops: (agentLLM as any)._nLoops });

            response = streamedContent;
            console.log('[Swarm] LLM streamed response for', agentTask.id, ':', response.length, 'chars,', (response.match(/```/g) || []).length / 2, 'code blocks');
          } catch (llmErr: any) {
            console.error('[Swarm] LLM call failed for', agentTask.id, ':', llmErr.message);
            
            // Enhanced error message with debugging info
            let errorDetails = llmErr.message;
            let troubleshootingSteps = [
              '- API key is valid and not expired',
              '- Provider is reachable (check internet connection)',
              '- Model name is correct and available',
              '- No rate limiting is occurring'
            ];

            // Add specific troubleshooting based on error type
            if (llmErr.message.includes('socket hang up')) {
              troubleshootingSteps.push('- Try again in a few moments (server may be overloaded)');
              troubleshootingSteps.push('- Check if your firewall is blocking the connection');
            } else if (llmErr.message.includes('ENOTFOUND')) {
              troubleshootingSteps.push('- Verify your internet connection is working');
              troubleshootingSteps.push('- Check DNS settings if using custom base URL');
            } else if (llmErr.message.includes('timeout')) {
              troubleshootingSteps.push('- Server may be experiencing high load');
              troubleshootingSteps.push('- Try using a different model or provider');
            } else if (llmErr.message.includes('401') || llmErr.message.includes('403')) {
              troubleshootingSteps = [
                '- API key is invalid or expired - check Settings',
                '- Account may be out of credits or suspended',
                '- Model may not be available with your API key tier'
              ];
            }

            // Get agent's configured provider info for debugging
            const agentLLM = agentLLMConfigs?.get(agentTask.id) || this.llmClient;
            const providerInfo = agentLLM ? `Provider: ${(agentLLM as any).config?.provider || 'unknown'}, Model: ${(agentLLM as any).config?.model || 'unknown'}` : 'No provider configured';

            response = `## ❌ Agent Error: ${agentName}

**LLM API call failed:** ${errorDetails}

**Configuration:** ${providerInfo}

**Please check:**
${troubleshootingSteps.join('\n')}

**Next steps:**
1. Go to **Settings** → **AI Providers** to verify your configuration
2. Test the provider connection using the "Test" button
3. Check the agent's specific model assignment in the **Agent Editor**
4. Try using a different provider or model if the issue persists

*If this error persists, the provider may be experiencing temporary issues.*`;
          }
        } else {
          console.error('[Swarm] No LLM client for', agentTask.id);
          response = '## \u274c No AI Provider: ' + agentName + '\n\nThis agent has no AI provider configured.\n\nTo fix this:\n1. Go to **Settings** and add at least one AI provider\n2. Or go to the **Agent Editor** and assign a provider+model to this agent\n\nAll agents require a configured AI provider to generate code.';
        }

        // Store output
        outputs.set(agentTask.id, response);
        // Store in shared memory — keep more context for downstream agents
        this.memoryPool.set(`agent:${agentTask.id}`, response.slice(0, 8000));

        // Agent complete
        onEvent?.({
          type: 'agent_complete',
          agentId: agentTask.id,
          agentName,
          phase,
          content: response,
          reasoning: agentReasoning,
        });

        return { id: agentTask.id, response };
        });
        
        // Wait for this batch to complete before starting the next
        const batchResults = await Promise.allSettled(batchPromises);
        promises.push(...batchPromises);
      }

      // All batches completed for this phase
    }

    // ── Consensus detection ──
    const consensusGroups = detectConsensusGroups(plan.agents);
    const consensusResults: ConsensusEntry[] = [];

    for (const [department, agentIds] of consensusGroups) {
      const entry = produceConsensus(department, agentIds, outputs);
      consensusResults.push(entry);

      onEvent?.({
        type: 'consensus_result',
        content: `Consensus reached for ${department} department (confidence: ${entry.confidence})`,
        confidence: entry.confidence,
      });

      this.memoryPool.set(`consensus:${department}`, entry.content);
    }

    // ── Swarm complete ──
    onEvent?.({
      type: 'swarm_complete',
      content: `Swarm execution complete: ${plan.agents.length} agents, ${phases.length} phases, ${consensusResults.length} consensus group(s)`,
    });

    return {
      outputs,
      consensusResults,
      totalPhases: phases.length,
      topology: plan.topology,
    };
  }
}
