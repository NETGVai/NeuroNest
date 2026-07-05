/**
 * IPC handler registration — wires renderer UI to backend subsystems.
 */

import { ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import { SessionManager } from '../session/session-manager';
import { CommandSystem } from '../commands/command-system';
import { builtInCommands } from '../commands/built-in/index';
import { SuperAgentManager } from '../agents/super-agent-manager';
import { initDatabase, getDefaultDbPath } from '../storage/database';
import { checkReadiness } from '../sre/readiness-service';
import { detectHardware } from '../cookbook/hardware-detector';
import { rankModels } from '../cookbook/model-ranker';
import { computeServeProfiles } from '../cookbook/profile-generator';
// Build readiness pre-check for the Autonomy auto-build step — detects when an
// npm build script needs a local tool (e.g. CRA's react-scripts) that isn't
// installed, so we skip the build with an actionable message instead of a
// cryptic "command not found" (exit 127).
import { checkBuildReadiness } from './build-readiness';
// GCF_Wire_Format (F10) — Phase 1 rollout gate (Req 56.4). Reads the persisted
// per-provider comprehension verdicts and the configured providers to decide
// whether the GCF_WIRE_FORMAT active flip is allowed; surfaced as a Settings
// panel yellow banner.
import { getRolloutGateStatus } from '../serializers/gcf-eval';
// Skill_Pack_System (F11) — pack install/sync/remove + drift & eval (Req 63.1).
// The six channels are registered by the dedicated registerSkillPacksIPC module
// (mirroring registerSkillsIPC) so they stay independently unit-testable.
import { registerSkillPacksIPC } from './skill-packs-ipc.js';
import { ZeraOptimizer } from '../pipeline/zera-optimizer';
import { OrchestratorPlanner } from '../pipeline/orchestrator-planner';
import { SwarmCoordinator, SwarmMemoryPool } from '../pipeline/swarm-coordinator';
import { EnhancedSwarmCoordinator } from '../pipeline/enhanced-swarm-coordinator';
import { getOllamaStatus, OLLAMA_DEFAULT_URL, installOllama, startOllama, stopOllama, getLlamaCppStatus, installLlamaCpp, startLlamaCpp, stopLlamaCpp, uninstallOllama, uninstallLlamaCpp } from './ollama-manager';
import { getOpenMythosStatus, installOpenMythos, startOpenMythos, stopOpenMythos, uninstallOpenMythos } from './openmythos-manager';
import { createLLMClient } from '../pipeline/llm-client';
import { PROVIDER_URLS } from '../pipeline/llm-client';
import { createLLMClientWithProMode } from '../pipeline/pro-mode-state';
import { CostStore } from '../storage/cost-store';
import { loadPricingTable, calculateCost, type PricingTable } from '../pipeline/cost-calculator';
import { ChannelManager } from '../channels/channel-manager';
import { FirewallEngine } from '../firewall/firewall-engine';
import { EnhancedFirewallEngine } from '../firewall/enhanced-firewall-engine';
import { FirewallConfigManager } from '../firewall/firewall-config';
import { AGENT_REGISTRY, DEPARTMENTS, getDepartmentCounts, getAgentsByDepartment } from '../agents/agent-registry';
import { registerSkillsIPC } from './skills-ipc.js';
import { registerAgentSkillsIPC } from '../agent-skills/ipc-handler.js';
import { registerDiagnosticsIPC } from './diagnostics-ipc.js';
import { registerToolApprovalIPC, createApprovalHandler } from './tool-approval-ipc.js';
import { registerMultiChatIPC } from './multi-chat-ipc.js';
import { registerLicenseIPC } from './license/license-ipc.js';
import { initializeAgentSkillsInMainProcess } from '../agent-skills/main-process-integration.js';
import { trySkillRoute, loadCatalogAndTemplates } from '../skills/skill-integration.js';
import { RuntimeManager } from '../runtime';
import type { RuntimeError } from '../runtime';
import { registerDeerFlowIPC, setDeerFlowMainWindow } from './deerflow-ipc.js';
import { registerUnifiedIntentGateIPC } from './unified-intent-gate-ipc.js';
import { LazyModuleLoader } from './performance/lazy-module-loader';
import { PERF_FLAGS } from './performance/feature-flags';
import { AsyncSystemMonitor } from './performance/async-system-monitor';
import { AgentLoopController, type AgentLoopResult, type AgentLLMClient, type AgentMessage, type AgentLLMResponse, type FunctionDefinition } from '../pipeline/agent-loop';
import { ToolSystem as AgentToolSystem } from '../tools/tool-system';
import { PermissionSystem } from '../security/permission-system';
import { builtInTools } from '../tools/built-in/index';
import { autoCommit, type AutoVersioningLLMClient } from '../tools/auto-versioning';
import { CallbackEngine } from '../pipeline/callback-engine';
import { loadProjectConfig } from '../config/project-config';

// Agent status simulation - in a real system this would come from agent manager
function getAgentStatus(agentId: string): 'active' | 'busy' | 'offline' {
  // For now, return 'active' for all agents to match the main agents view
  // In production, this would query the actual agent manager or runtime
  // TODO: Integrate with actual agent runtime status when available
  return 'active';
}
import { FileEventEmitter } from './file-event-emitter';
import { BatchedEvent } from './event-batcher';
import { addHeaderToContent, writeFileWithHeader } from '../utils/project-headers';
import { FileTreeCache } from './performance/file-tree-cache';
import { GraphManager } from '../graph/graph-manager';
import { GroundingEnforcer, GroundingContext } from '../pipeline/grounding-enforcer';
import { CriticAgent } from '../pipeline/critic-agent';
import { IndexingPipelineController, IndexingConfig } from '../indexing/indexing-pipeline-controller';
import { ASTChunker } from '../indexing/ast-chunker';
import { EmbeddingStore } from '../indexing/embedding-store';
import { CallGraphEngine } from '../indexing/call-graph-engine';
import { TransformationCache } from '../indexing/transformation-cache';
import { EmbeddingDaemonClient } from '../indexing/embedding-daemon';
import { LineageTracker } from '../indexing/lineage-tracker';
import { GitConnector } from '../indexing/connectors/git-connector';
import { DocumentationConnector } from '../indexing/connectors/documentation-connector';
import { loadProjectContextFiles } from '../pipeline/context-files';
import { compressTrajectory, shouldCompress } from '../pipeline/trajectory-compressor';
import { buildFallbackChain, chatWithFallback } from '../pipeline/fallback-chain';
import { EventLog, type EventKind } from '../pipeline/event-log';
import { captureError } from '../pipeline/error-capture';
import { emitChatEvent } from './chat-event-emitter';
import { CronScheduler } from '../scheduler/cron-scheduler';
import { SkillLearner } from '../skills/skill-learner';
import { isSelfHosted as isSelfHostedEndpoint, maybeEscalate as maybeEscalateTeacher } from '../pipeline/teacher-escalation';
import { spawnSubagent, spawnSubagentBatch, formatSubagentResults } from '../pipeline/subagent-spawner';
import { tryLocalResponse } from '../pipeline/local-request-optimizer';
import { classifyTaskTier } from '../pipeline/tier-router';
import { computeInputTokenBudget, resolveBudgetInputs } from '../pipeline/token-budget';
import { getActiveContextLength } from '../pipeline/active-model';
// RAG_Tool_Selection (F4) — once-at-boot ToolIndex cold-start with 30s budget.
import {
  bootstrapToolIndexOnce,
  getToolIndex,
  COLD_START_BUDGET_MS,
  type RetryFlagStore,
} from '../pipeline/tool-index-boot';
import { PRODUCTION_OUTPUT_FORMAT, validateGeneratedProject, autoFixDependencies, scaffoldMissingConfigs } from '../pipeline/code-generation-enhancer';
import {
  type VoiceSetConfigArgs,
  type VoiceSynthesizeArgs,
  type VoiceGetConfigResult,
  type VoiceSynthesizeResult,
  isVoiceSetConfigArgs,
  isVoiceSynthesizeArgs,
} from './ipc-types';
import { AsyncCommandRunner } from './performance/async-command-runner';

// Singleton AsyncCommandRunner instance for non-blocking command execution
const asyncCommandRunner = new AsyncCommandRunner();

function sendAndStore(mainWindow: any, data: any) {
  // Auto-attach provider/model to every message if not already present
  if (!data.provider || !data.model) {
    try {
      const provJson = getCachedConfig('providers');
      const defJson = getCachedConfig('default-provider');
      if (provJson) {
        const providers = JSON.parse(provJson);
        let defProv: any = null;
        if (defJson) {
          try {
            const dp = JSON.parse(defJson);
            defProv = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
            if (defProv && dp.model) defProv = { ...defProv, model: dp.model };
          } catch {}
        }
        const activeProv = defProv || providers[0];
        if (activeProv) {
          if (!data.provider) data.provider = activeProv.type || activeProv.name || '';
          if (!data.model) data.model = (activeProv.model || '').split(',')[0].trim();
        }
      }
    } catch (e: any) {
      // This can fail at startup before DB is ready — non-fatal
    }
  }
  mainWindow.webContents.send('chat-response', data);
  storeMessage(data.role || 'assistant', data.content || '', data.agent);
}

/**
 * Send a desktop notification if the user has the relevant notification type enabled.
 * type: 'onAgentComplete' | 'onAgentNeedsInput' | 'onCheckFailed'
 */
function sendDesktopNotification(projectId: string | null, type: string, title: string, body: string): void {
  if (!projectId || !notificationServiceRef) return;
  try {
    const config = notificationServiceRef.getConfig(projectId);
    if (!config || !config.enabled) return;
    if (!(config as any)[type]) return;
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const notif = new Notification({ title, body, silent: !config.soundEnabled });
      notif.show();
    }
  } catch (e: any) {
    console.warn('[Notifications] Failed to send:', e.message);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export interface IPCDependencies {
  mainWindow: BrowserWindow;
}

// Subsystem singletons — initialized once
let db: ReturnType<typeof initDatabase>;
let sessionManager: SessionManager;
let commandSystem: CommandSystem;
let agentManager: SuperAgentManager;
let activeSessionId: string | null = null;
let activeAgentName: string | null = null;
let tokenCount = 0;
let channelManager: ChannelManager;
let zeraOptimizer: ZeraOptimizer;
let orchestratorPlanner: OrchestratorPlanner;
let firewallEngine: FirewallEngine;
let enhancedFirewallEngine: EnhancedFirewallEngine;
let firewallConfigManager: FirewallConfigManager;
let activeSwarmCoordinator: SwarmCoordinator | null = null;
let enhancedSwarmCoordinator: EnhancedSwarmCoordinator | null = null;
let activeLlmClient: ReturnType<typeof createLLMClient> | null = null;
let graphManager: GraphManager;
let indexingPipelineController: IndexingPipelineController | null = null;
let runtimeManager: RuntimeManager;
let costStore: CostStore;
let pricingTable: PricingTable;
let promptCacheRef: any = null; // Reference to PromptCacheService, set during init
let configProfileRef: any = null; // Reference to ConfigProfileService, set during init
let lintTestServiceRef: any = null; // Reference to AutoLintTestService, set during IPC init
let notificationServiceRef: any = null; // Reference to NotificationService, set during IPC init
let _ipcMainWindow: BrowserWindow | null = null; // Module-level reference for deferred channel wiring
let autonomyManagerRef: any = null; // Reference to AutonomyManager, set during IPC init
let providerRegistryRef: import('../providers/provider-registry').IProviderRegistry | null = null;
let smartRouterRef: any = null; // Reference to SmartModelRouter, set during IPC init
let providerHealthRef: any = null; // Reference to ProviderHealthMonitor, set during IPC init
let agentMemoryClient: any = null; // Reference to AgentMemoryClient, set during IPC init
let projectMemoryRef: any = null; // Reference to ProjectMemoryStore, used by memory panel
let cronScheduler: CronScheduler | null = null; // Cron scheduler for automated tasks
let skillLearner: SkillLearner | null = null; // Self-improving skill learner

// ── Agent Loop Integration (Requirement 10.1, 10.2) ──
// Singleton ToolSystem with real built-in tool implementations for the agent loop.
// Lazily initialized on first use so we don't pay the cost at module load.
let agentLoopToolSystem: InstanceType<typeof AgentToolSystem> | null = null;

/** Get or create the ToolSystem singleton for the agent loop. */
function getAgentLoopToolSystem(): InstanceType<typeof AgentToolSystem> {
  if (!agentLoopToolSystem) {
    agentLoopToolSystem = new AgentToolSystem(new PermissionSystem());
    for (const tool of builtInTools) {
      try {
        agentLoopToolSystem.register(tool);
      } catch (err: any) {
        console.warn('[AgentLoop] Failed to register tool:', tool.id, err?.message);
      }
    }
    console.log('[AgentLoop] ToolSystem initialized with', agentLoopToolSystem.list().length, 'tools');
  }
  return agentLoopToolSystem;
}

/**
 * Per-session conversation history for the agent loop.
 * Maintains message history across iterations so follow-up messages
 * have context from prior tool-use rounds.
 */
const agentLoopConversationHistory = new Map<string, AgentMessage[]>();

/** Max history messages to retain per session (prevents unbounded memory growth). */
const AGENT_LOOP_MAX_HISTORY = 50;

/**
 * Adapter: wraps the existing createLLMClient-based client to conform
 * to the AgentLLMClient interface expected by AgentLoopController.
 *
 * The existing LLMClient.chat() method doesn't natively support `tools` in its
 * TypeScript signature, but the underlying OpenAI-compatible API does. We cast
 * through `any` to pass tools and read tool_calls from the raw response.
 */
function wrapLLMClientForAgentLoop(llmClient: ReturnType<typeof createLLMClient>): AgentLLMClient {
  return {
    async chatWithTools(
      messages: AgentMessage[],
      tools: FunctionDefinition[],
      options?: { temperature?: number; maxTokens?: number },
    ): Promise<AgentLLMResponse> {
      // The existing LLM client's chat() is typed narrowly but the underlying
      // HTTP call supports the full OpenAI API including tools. We pass tools
      // via the options object (cast to any) and the provider handles it.
      const llmMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      }));

      // Build the tools parameter in OpenAI format
      const toolsParam = tools.map((t) => ({
        type: 'function' as const,
        function: t.function,
      }));

      // Call the existing LLM client — cast to any to pass tools through
      const response: any = await (llmClient as any).chat(llmMessages as any, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens,
        tools: toolsParam,
      });

      // Normalize the response to AgentLLMResponse format
      // The raw API response has tool_calls on the message choice; the LLMClient
      // may or may not expose them depending on version. We read from the response
      // object which has been extended in prior tasks.
      const result: AgentLLMResponse = {
        content: response?.content || '',
      };
      if (response?.tool_calls && response.tool_calls.length > 0) {
        result.tool_calls = response.tool_calls;
      }
      if (response?.tokensUsed || response?.promptTokens) {
        result.usage = {
          promptTokens: response.promptTokens || 0,
          completionTokens: response.completionTokens || 0,
          totalTokens: response.tokensUsed || (response.promptTokens || 0) + (response.completionTokens || 0),
        };
      }
      return result;
    },
  };
}

/**
 * Adapter: wraps the existing createLLMClient-based client to conform
 * to the AutoVersioningLLMClient interface expected by autoCommit().
 *
 * The AutoVersioningLLMClient needs a simple `chat(messages, options)` that
 * returns `{ content?: string | null }`. The existing LLMClient's chat()
 * already returns `{ content: string }`, so this is a thin passthrough.
 */
function wrapLLMForAutoCommit(llmClient: NonNullable<ReturnType<typeof createLLMClient>>): AutoVersioningLLMClient {
  return {
    async chat(
      messages: Array<{ role: string; content: string }>,
      options?: { temperature?: number; maxTokens?: number },
    ): Promise<{ content?: string | null }> {
      const response = await llmClient.chat(messages as any, options);
      return { content: response?.content || null };
    },
  };
}

// ── Event_Bus_Bridge singleton (12-factor-agent-improvements task 8) ──
// Single main-process EventLog instance. Renderer-side agents emit via the
// `event-log.emit` IPC channel (fire-and-forget), and this is the one
// writer of `pipeline_events` rows in the entire app — required so the
// per-session `seq` allocation in EventLog.flushNow stays race-free.
// Lazily constructed on first use after `db` is initialized so we don't
// pay the cost during critical-path init.
let eventLog: EventLog | null = null;
let projectContextCache: string = ''; // Cached project context files content

// ── Unified_State_Reducer singleton (12-factor-agent-improvements task 25) ──
// Fed by the EventLog singleton above; the prompt-state-block helper reads
// from the reducer's session cache and records the four `unified_state.*`
// metrics. The reducer must be a singleton: every chat-message handler
// has to hit the same instance so the warm-path cache actually warms.
// Lazily constructed for the same reason as EventLog — `db` and the
// telemetry service aren't ready at module-load time.
let unifiedReducer: import('../pipeline/unified-state-reducer').UnifiedStateReducer | null = null;

// ── Config cache — eliminates repeated DB reads for hot config keys ──
const configCache = new Map<string, { value: string; ts: number }>();
const CONFIG_CACHE_TTL = 30_000; // 30 seconds

function getActiveProfileId(): string {
  if (configProfileRef) {
    const active = configProfileRef.getActiveProfile();
    if (active) return active.id;
    return configProfileRef.getDefaultProfileId();
  }
  return 'default';
}

function getCachedConfig(key: string): string | null {
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.ts < CONFIG_CACHE_TTL) return hit.value;
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) {
      configCache.set(key, { value: row.value, ts: Date.now() });
      return row.value;
    }
  } catch {}
  return null;
}

function setCachedConfig(key: string, value: string): void {
  try {
    db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, new Date().toISOString());
    configCache.set(key, { value, ts: Date.now() });
  } catch (e) { console.error('[IPC] setCachedConfig error:', e); }
}

function invalidateConfigCache(key: string): void {
  configCache.delete(key);
}

// ── Prepared statement cache — avoids re-preparing identical SQL on every call ──
const stmtCache = new Map<string, any>();

function cachedStmt(sql: string) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** Resolve the active LLM provider from cached config (used in multiple handlers) */
function resolveActiveLLMClient(): ReturnType<typeof createLLMClient> | null {
  // ── Provider Registry path (formal routing with priority/failover/usage tracking) ──
  // When the registry is populated, use it as the primary resolution path.
  if (providerRegistryRef) {
    try {
      const adapter = providerRegistryRef.getProvider();
      // Wrap the adapter as an LLMClient-compatible object for backward compat
      const wrappedClient = {
        chat: async (messages: any[], opts?: any) => {
          const result = await adapter.chatCompletion(
            messages.map((m: any) => ({ role: m.role, content: m.content })),
            { temperature: opts?.temperature, maxTokens: opts?.maxTokens, stopSequences: opts?.stop },
          );
          return { content: result.content, usage: { promptTokens: result.tokensUsed.prompt, completionTokens: result.tokensUsed.completion } };
        },
        stream: async function*(messages: any[], opts?: any) {
          for await (const chunk of adapter.streamCompletion(
            messages.map((m: any) => ({ role: m.role, content: m.content })),
            { temperature: opts?.temperature, maxTokens: opts?.maxTokens, stopSequences: opts?.stop },
          )) {
            yield chunk.content;
          }
        },
      };
      return wrappedClient as any;
    } catch {
      // Registry not populated or provider unavailable — fall through to legacy path
    }
  }

  // ── Legacy path (direct provider config lookup) ──
  try {
    const provJson = getCachedConfig('providers');
    const defJson = getCachedConfig('default-provider');
    if (!provJson) return null;
    const providers = JSON.parse(provJson);

    // Check if smart router has a manual override active
    if (smartRouterRef) {
      const override = smartRouterRef.getOverride();
      if (override) {
        const overrideProv = providers.find((p: any) =>
          p.name === override.provider || p.type === override.provider || p.id === override.provider
        );
        if (overrideProv) {
          return createLLMClientWithProMode({ ...overrideProv, model: override.model });
        }
      }
    }

    let defaultProv: any = null;
    if (defJson) {
      try {
        const dp = JSON.parse(defJson);
        defaultProv = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
        if (defaultProv && dp.model) defaultProv = { ...defaultProv, model: dp.model };
      } catch {}
    }
    const activeProv = defaultProv || providers[0];
    return activeProv ? createLLMClientWithProMode(activeProv) : null;
  } catch { return null; }
}

/**
 * Resolve the active LLM provider *record* (not a client) from cached config.
 * Mirrors `resolveActiveLLMClient`'s selection (manual override → default-provider
 * → first provider) but returns the raw provider object so callers can read its
 * context window via `getActiveContextLength`. Returns `null` when none resolves;
 * `getActiveContextLength(null)` then yields `0` (unknown context length).
 */
function resolveActiveProviderRecord(): unknown {
  try {
    const provJson = getCachedConfig('providers');
    const defJson = getCachedConfig('default-provider');
    if (!provJson) return null;
    const providers = JSON.parse(provJson);

    if (smartRouterRef) {
      const override = smartRouterRef.getOverride();
      if (override) {
        const overrideProv = providers.find((p: any) =>
          p.name === override.provider || p.type === override.provider || p.id === override.provider
        );
        if (overrideProv) return { ...overrideProv, model: override.model };
      }
    }

    let defaultProv: any = null;
    if (defJson) {
      try {
        const dp = JSON.parse(defJson);
        defaultProv = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
        if (defaultProv && dp.model) defaultProv = { ...defaultProv, model: dp.model };
      } catch {}
    }
    return defaultProv || providers[0] || null;
  } catch { return null; }
}

/**
 * F7 Teacher_Escalation_Loop — settings + endpoint resolution helpers.
 *
 * Reads the operator-configured teacher model / endpoint (AppConfigSchema
 * fields `teacherModel` / `teacherEndpointUrl`, Requirement 41) from persisted
 * config, and derives the active "student" endpoint URL from the active
 * provider record so `isSelfHosted` (Requirement 38) can gate escalation.
 */
function resolveTeacherConfig(): { teacherModel: string | null; teacherEndpointUrl: string | null } {
  let teacherModel: string | null = null;
  let teacherEndpointUrl: string | null = null;
  try {
    const m = getCachedConfig('teacher-model');
    if (typeof m === 'string' && m.trim() !== '') teacherModel = m.trim();
    const u = getCachedConfig('teacher-endpoint-url');
    if (typeof u === 'string' && u.trim() !== '') teacherEndpointUrl = u.trim();
  } catch { /* defensive: missing config → unconfigured */ }
  return { teacherModel, teacherEndpointUrl };
}

/**
 * Resolve the active "student" endpoint URL from the active provider record.
 * Prefers the provider's explicit `baseUrl`, falling back to the provider-type
 * default in `PROVIDER_URLS`. Returns `''` when nothing can be resolved.
 */
function resolveStudentEndpoint(): string {
  try {
    const prov = resolveActiveProviderRecord() as { baseUrl?: string; type?: string; id?: string } | null;
    if (!prov || typeof prov !== 'object') return '';
    if (typeof prov.baseUrl === 'string' && prov.baseUrl.trim() !== '') return prov.baseUrl.trim();
    const type = (prov.type || (typeof prov.id === 'string' ? prov.id.split('-')[0] : '') || '').toLowerCase();
    return PROVIDER_URLS[type] || '';
  } catch { return ''; }
}

/**
 * Build the prompt handed to the teacher endpoint from the failed turn's
 * context (Requirement 40.3 — "call the Teacher_Endpoint with the failed turn's
 * full context").
 */
function buildTeacherPrompt(ctx: { studentEndpoint: string; toolResults: Array<{ error?: string; output?: string }>; agentReply: string; failureReason?: string }): string {
  const toolLines = (ctx.toolResults || [])
    .map((r, i) => `  [${i}] ${r.error ? 'error: ' + r.error : ''}${r.output ? 'output: ' + String(r.output).slice(0, 1200) : ''}`)
    .join('\n');
  return [
    'A smaller local model failed a task. Help it recover with a correct, concrete procedure.',
    ctx.failureReason ? `Detected failure: ${ctx.failureReason}` : '',
    '',
    'Tool results from the failed turn:',
    toolLines || '  (none)',
    '',
    'The local model\'s reply was:',
    (ctx.agentReply || '').slice(0, 2000),
    '',
    'Provide the corrected approach as a clear, reusable step-by-step procedure.',
  ].filter(Boolean).join('\n');
}

/**
 * F7 Teacher_Escalation_Loop — post-turn hook.
 *
 * Invoked once a chat turn completes. Escalation proceeds only when ALL of the
 * Requirement 40.2 preconditions hold:
 *   - `TEACHER_ESCALATION_ENABLED` flag is ON (Requirement 40.1, 40.2)
 *   - a teacher model is configured (Requirement 40.2, 41.1)
 *   - the active student endpoint is self-hosted (Requirement 38, 40.2)
 *   - a failure is detected for the student's turn (Requirement 39, 40.2)
 *
 * The flag, teacher-configured, and self-hosted gates are enforced here; the
 * failure-detected gate (and a second self-hosted check) are enforced inside
 * `maybeEscalate`. When the teacher's reply clears the failure detector, the
 * module persists the recovery via `SkillLearner.recordRecovery` (Requirement
 * 40.4). On any error this hook is a no-op so it never breaks the agent loop.
 *
 * Requirements: 40.2, 40.3, 40.4
 */
async function runTeacherEscalationHook(
  swarmResult: { outputs?: Map<string, string> } | null | undefined,
): Promise<void> {
  try {
    // Gate 1 — feature flag off ⇒ never trigger (Requirement 40.1).
    if (!PERF_FLAGS.TEACHER_ESCALATION_ENABLED) return;

    // Gate 2 — teacher model must be configured (Requirement 40.2, 41.1).
    const teacher = resolveTeacherConfig();
    if (!teacher.teacherModel) return;

    // Gate 3 — student endpoint must be self-hosted (Requirement 38, 40.2).
    const studentEndpoint = resolveStudentEndpoint();
    if (!studentEndpoint || !isSelfHostedEndpoint(studentEndpoint)) return;

    // A learned-skill store is required to persist any recovery (Requirement 40.4).
    if (!skillLearner) return;

    // Build the failed-turn context from the completed turn's agent outputs.
    const outputs = swarmResult?.outputs instanceof Map ? swarmResult.outputs : null;
    if (!outputs || outputs.size === 0) return;
    const values = Array.from(outputs.values()).map((o) => String(o ?? ''));
    const toolResults = values.map((output) => ({ output }));
    const agentReply = values.join('\n\n');

    // Resolve a teacher LLM client from the configured teacher endpoint/model.
    const teacherProvider: Record<string, unknown> = { type: 'openai', model: teacher.teacherModel };
    if (teacher.teacherEndpointUrl) teacherProvider.baseUrl = teacher.teacherEndpointUrl;
    const teacherClient = createLLMClientWithProMode(teacherProvider);
    if (!teacherClient) return;

    const result = await maybeEscalateTeacher(studentEndpoint, toolResults, agentReply, {
      callTeacher: async (ctx) => {
        const resp = await teacherClient.chat(
          [
            { role: 'system', content: 'You are a senior engineer helping a smaller local model recover from a failed task. Provide a concrete, correct procedure to accomplish the task.' },
            { role: 'user', content: buildTeacherPrompt(ctx) },
          ],
          { temperature: 0.2, maxTokens: 800 },
        );
        return (resp.content || '').trim();
      },
      skillLearner,
    });

    if (result.escalated) {
      console.log('[TeacherEscalation] Escalated failed turn to teacher endpoint; recovery persisted:', !!result.teacherReply);
    }
  } catch (escErr: any) {
    console.warn('[TeacherEscalation] Post-turn hook error (non-fatal):', escErr?.message);
  }
}

/**
 * Resolve the active LLM client with a fallback chain.
 * If the primary provider fails (timeout, rate limit, 5xx), cascades to other configured providers.
 */
function resolveActiveLLMClientWithFallbacks(): { primary: ReturnType<typeof createLLMClient> | null; chain: import('../pipeline/fallback-chain').FallbackChainConfig | null } {
  try {
    const provJson = getCachedConfig('providers');
    if (!provJson) return { primary: null, chain: null };
    const providers = JSON.parse(provJson);
    const defJson = getCachedConfig('default-provider');
    let defaultId: string | undefined;
    if (defJson) { try { defaultId = JSON.parse(defJson).id; } catch {} }
    const chain = buildFallbackChain(providers, defaultId);
    return { primary: chain?.primary || null, chain };
  } catch { return { primary: resolveActiveLLMClient(), chain: null }; }
}

/**
 * Resolve LLM client with smart routing — considers token count, task type, and health.
 * Falls back to resolveActiveLLMClient if router is not configured.
 */
function resolveRoutedLLMClient(tokenCount?: number, taskType?: string): ReturnType<typeof createLLMClient> | null {
  if (!smartRouterRef || !tokenCount) return resolveActiveLLMClient();

  try {
    const provJson = getCachedConfig('providers');
    if (!provJson) return resolveActiveLLMClient();
    const providers = JSON.parse(provJson);

    const decision = smartRouterRef.route(
      tokenCount || 0,
      taskType || 'default',
      getCachedConfig('default-provider') ? JSON.parse(getCachedConfig('default-provider')!).id : undefined,
      undefined
    );

    // If router decided on a specific provider/model, use it
    if (decision.provider && decision.reason !== 'Default routing') {
      const routedProv = providers.find((p: any) =>
        p.name === decision.provider || p.type === decision.provider || p.id === decision.provider
      );
      if (routedProv) {
        console.log('[Router] Routed to', decision.provider + '/' + decision.model, '—', decision.reason);
        return createLLMClientWithProMode({ ...routedProv, model: decision.model });
      }
    }

    return resolveActiveLLMClient();
  } catch {
    return resolveActiveLLMClient();
  }
}

// ── LazyModuleLoader instance for deferred initialization ──
let moduleLoader: LazyModuleLoader | null = null;
let deferredInitComplete = false;

/**
 * Create lazy proxy for a deferred module variable.
 * The proxy initializes the module on first access if not yet loaded.
 */
function createLazyProxy<T>(loader: LazyModuleLoader, moduleName: string): T {
  let cachedInstance: T | null = null;
  return new Proxy({} as any, {
    get(_target, prop) {
      if (!cachedInstance) {
        cachedInstance = loader.get<T>(moduleName);
      }
      if (cachedInstance === null || cachedInstance === undefined) {
        return undefined;
      }
      const value = (cachedInstance as any)[prop];
      return typeof value === 'function' ? value.bind(cachedInstance) : value;
    },
    set(_target, prop, value) {
      if (!cachedInstance) {
        cachedInstance = loader.get<T>(moduleName);
      }
      if (cachedInstance) {
        (cachedInstance as any)[prop] = value;
      }
      return true;
    },
  }) as T;
}

/**
 * Initialize critical modules only (Database, SessionManager, CommandSystem).
 * Called before window creation to ensure basic IPC works immediately.
 */
function initCriticalModules(): void {
  if (db) return; // Already initialized

  console.log('[IPC] Initializing critical subsystems...');
  try {
    db = initDatabase();
    sessionManager = new SessionManager(db);
    commandSystem = new CommandSystem();
    agentManager = new SuperAgentManager();

    // Register all built-in commands
    for (const cmd of builtInCommands) {
      commandSystem.register(cmd);
    }

    // Create default agents from built-in templates
    const templates = agentManager.listTemplates();
    for (const t of templates) {
      agentManager.createAgent(t);
    }

    console.log('[IPC] Critical subsystems initialized. Commands:', commandSystem.list().length);
  } catch (e) {
    console.error('[IPC] Critical init error:', e);
  }
}

/**
 * Initialize deferred modules (heavy subsystems not needed for initial window display).
 * Called after window `ready-to-show` event.
 */
async function initDeferredModules(): Promise<void> {
  if (deferredInitComplete) return;
  if (!db) {
    console.warn('[IPC] Cannot init deferred modules — DB not initialized');
    return;
  }

  console.log('[IPC] Initializing deferred subsystems...');
  const startTime = Date.now();

  try {
    zeraOptimizer = new ZeraOptimizer();
    orchestratorPlanner = new OrchestratorPlanner();
    channelManager = new ChannelManager();
    firewallEngine = new FirewallEngine();
    enhancedFirewallEngine = new EnhancedFirewallEngine();
    firewallConfigManager = new FirewallConfigManager();
    graphManager = new GraphManager(db);
    runtimeManager = new RuntimeManager();
    enhancedSwarmCoordinator = new EnhancedSwarmCoordinator(null, db);
    console.log('[IPC] Enhanced swarm coordinator initialized:', !!enhancedSwarmCoordinator);

    // Initialize cost tracking
    try {
      costStore = new CostStore(db);
      pricingTable = loadPricingTable();
      console.log('[IPC] Cost tracking initialized');
    } catch (e) { console.warn('[IPC] Cost tracking init error:', e); }

    // Initialize ProviderRegistry with formal adapter wrapping
    try {
      const { ProviderRegistry } = require('../providers/provider-registry.impl');
      const { FeatureGateSystem } = require('../feature-gate/feature-gate-system');
      const { createAdaptersFromConfigs } = require('../providers/llm-client-adapter');
      const featureGate = new FeatureGateSystem();
      const registry = new ProviderRegistry(db, featureGate);
      const provJson = getCachedConfig('providers');
      if (provJson) {
        const providers = JSON.parse(provJson);
        const adapters = createAdaptersFromConfigs(providers);
        for (const { adapter, priority } of adapters) {
          try { registry.register(adapter, priority); } catch {}
        }
      }
      providerRegistryRef = registry;
      console.log('[IPC] ProviderRegistry initialized with', registry.getStatus().length, 'providers');
    } catch (e) { console.warn('[IPC] ProviderRegistry init error (non-fatal, using legacy path):', e); }

    // Test database tables
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'").all();
      console.log('[IPC] Multica tables found:', tables.map((t: any) => t.name));

      // Test getting runtimes
      const runtimes = enhancedSwarmCoordinator.getEnhancedAgentManager().getRuntimes();
      console.log('[IPC] Default runtimes:', runtimes.length);
    } catch (e) {
      console.error('[IPC] Database test error:', e);
    }

    console.log('[IPC] Deferred subsystems initialized. Agents:', AGENT_REGISTRY.length, '(registry) +', agentManager.listAgents().length, '(manager)');

    // Load bundled catalog and register design templates after DB init
    try {
      loadCatalogAndTemplates(db);
      console.log('[IPC] Bundled catalog and design templates loaded');
    } catch (e) { console.warn('[IPC] Catalog/template load error:', e); }

    // Pre-fetch local model lists in background
    refreshLocalModelLists();

    // Initialize cron scheduler and skill learner
    try {
      cronScheduler = new CronScheduler(db);
      cronScheduler.onJobTrigger(async (job) => {
        console.log('[Scheduler] Running job:', job.name);
        // Route the job's task through the normal message pipeline
        const llm = resolveActiveLLMClient();
        if (llm) {
          const result = await llm.chat([
            { role: 'system', content: 'You are a scheduled automation agent. Complete the following task concisely.' },
            { role: 'user', content: job.task },
          ], { temperature: 0.4, maxTokens: 1000 });
          // Store result
          storeMessage('assistant', `⏰ [Scheduled: ${job.name}]\n\n${result.content || 'No output'}`, 'Scheduler');
        }
      });
      cronScheduler.startAll();
      console.log('[IPC] Cron scheduler initialized');
    } catch (e) { console.warn('[IPC] Scheduler init error:', e); }

    try {
      skillLearner = new SkillLearner(db);
      console.log('[IPC] Skill learner initialized');
    } catch (e) { console.warn('[IPC] Skill learner init error:', e); }

  } catch (e) {
    console.error('[IPC] Deferred init error:', e);
  }

  deferredInitComplete = true;
  console.log(`[IPC] Deferred initialization complete in ${Date.now() - startTime}ms`);
}

/**
 * Initialize using LazyModuleLoader with phased loading.
 * Critical modules load immediately; deferred modules load after window visible.
 */
function initWithLazyLoader(): void {
  if (db) return; // Already initialized

  moduleLoader = new LazyModuleLoader();

  // Register critical modules
  moduleLoader.register({
    name: 'Database',
    priority: 'critical',
    factory: () => initDatabase(),
  });

  moduleLoader.register({
    name: 'SessionManager',
    priority: 'critical',
    dependencies: ['Database'],
    factory: () => new SessionManager(moduleLoader!.get('Database')),
  });

  moduleLoader.register({
    name: 'CommandSystem',
    priority: 'critical',
    factory: () => {
      const cs = new CommandSystem();
      for (const cmd of builtInCommands) {
        cs.register(cmd);
      }
      return cs;
    },
  });

  // Register deferred modules
  moduleLoader.register({
    name: 'SwarmCoordinator',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => new SwarmCoordinator(new SwarmMemoryPool()),
  });

  moduleLoader.register({
    name: 'EnhancedSwarmCoordinator',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => new EnhancedSwarmCoordinator(null, moduleLoader!.get('Database')),
  });

  moduleLoader.register({
    name: 'FirewallEngine',
    priority: 'deferred',
    factory: () => new FirewallEngine(),
  });

  moduleLoader.register({
    name: 'EnhancedFirewallEngine',
    priority: 'deferred',
    factory: () => new EnhancedFirewallEngine(),
  });

  moduleLoader.register({
    name: 'IndexingPipelineController',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => null, // Initialized separately when needed
  });

  moduleLoader.register({
    name: 'GraphManager',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => new GraphManager(moduleLoader!.get('Database')),
  });

  moduleLoader.register({
    name: 'CronScheduler',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => {
      const scheduler = new CronScheduler(moduleLoader!.get('Database'));
      scheduler.onJobTrigger(async (job) => {
        console.log('[Scheduler] Running job:', job.name);
        const llm = resolveActiveLLMClient();
        if (llm) {
          const result = await llm.chat([
            { role: 'system', content: 'You are a scheduled automation agent. Complete the following task concisely.' },
            { role: 'user', content: job.task },
          ], { temperature: 0.4, maxTokens: 1000 });
          storeMessage('assistant', `⏰ [Scheduled: ${job.name}]\n\n${result.content || 'No output'}`, 'Scheduler');
        }
      });
      scheduler.startAll();
      return scheduler;
    },
  });

  moduleLoader.register({
    name: 'SkillLearner',
    priority: 'deferred',
    dependencies: ['Database'],
    factory: () => new SkillLearner(moduleLoader!.get('Database')),
  });

  moduleLoader.register({
    name: 'OrchestratorPlanner',
    priority: 'deferred',
    factory: () => new OrchestratorPlanner(),
  });

  moduleLoader.register({
    name: 'ZeraOptimizer',
    priority: 'deferred',
    factory: () => new ZeraOptimizer(),
  });

  moduleLoader.register({
    name: 'ChannelManager',
    priority: 'deferred',
    factory: () => new ChannelManager(),
  });

  // Initialize critical modules synchronously
  console.log('[IPC] Initializing critical modules via LazyModuleLoader...');
  moduleLoader.initCritical().then(() => {
    // Assign critical module instances to the existing variables for backward compatibility
    db = moduleLoader!.get('Database');
    sessionManager = moduleLoader!.get('SessionManager');
    commandSystem = moduleLoader!.get('CommandSystem');

    // Set up agent manager (not part of lazy loading, always needed early)
    agentManager = new SuperAgentManager();
    const templates = agentManager.listTemplates();
    for (const t of templates) {
      agentManager.createAgent(t);
    }

    console.log('[IPC] Critical modules loaded. Commands:', commandSystem.list().length);
  }).catch((e) => {
    console.error('[IPC] Critical module init failed:', e);
  });
}

/**
 * Complete deferred initialization via LazyModuleLoader.
 * Called after window `ready-to-show` event.
 */
async function completeLazyDeferredInit(): Promise<void> {
  if (!moduleLoader || deferredInitComplete) return;

  console.log('[IPC] Starting deferred module initialization via LazyModuleLoader...');
  const startTime = Date.now();

  try {
    await moduleLoader.initDeferred();

    // Assign deferred module instances to existing variables for backward compatibility
    enhancedSwarmCoordinator = moduleLoader.get('EnhancedSwarmCoordinator');
    firewallEngine = moduleLoader.get('FirewallEngine');
    enhancedFirewallEngine = moduleLoader.get('EnhancedFirewallEngine');
    graphManager = moduleLoader.get('GraphManager');
    cronScheduler = moduleLoader.get('CronScheduler');
    skillLearner = moduleLoader.get('SkillLearner');
    orchestratorPlanner = moduleLoader.get('OrchestratorPlanner');
    zeraOptimizer = moduleLoader.get('ZeraOptimizer');
    channelManager = moduleLoader.get('ChannelManager');

    // Initialize remaining subsystems not managed by LazyModuleLoader
    firewallConfigManager = new FirewallConfigManager();
    runtimeManager = new RuntimeManager();

    // Initialize cost tracking
    try {
      costStore = new CostStore(db);
      pricingTable = loadPricingTable();
      console.log('[IPC] Cost tracking initialized');
    } catch (e) { console.warn('[IPC] Cost tracking init error:', e); }

    // Test database tables
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'").all();
      console.log('[IPC] Multica tables found:', tables.map((t: any) => t.name));
      if (enhancedSwarmCoordinator) {
        const runtimes = enhancedSwarmCoordinator.getEnhancedAgentManager().getRuntimes();
        console.log('[IPC] Default runtimes:', runtimes.length);
      }
    } catch (e) {
      console.error('[IPC] Database test error:', e);
    }

    console.log('[IPC] Deferred modules loaded. Agents:', AGENT_REGISTRY.length, '(registry) +', agentManager.listAgents().length, '(manager)');

    // Load bundled catalog and register design templates
    try {
      loadCatalogAndTemplates(db);
      console.log('[IPC] Bundled catalog and design templates loaded');
    } catch (e) { console.warn('[IPC] Catalog/template load error:', e); }

    // Pre-fetch local model lists in background
    refreshLocalModelLists();

  } catch (e) {
    console.error('[IPC] Lazy deferred init error:', e);
  }

  deferredInitComplete = true;
  console.log(`[IPC] Lazy deferred initialization complete in ${Date.now() - startTime}ms`);
}

/**
 * ensureInit() — initializes all subsystems.
 * When PERF_FLAGS.LAZY_MODULES is enabled, only critical modules are loaded eagerly.
 * Deferred modules are loaded after window `ready-to-show` or on first access.
 * When disabled, falls back to eager initialization of all modules.
 */
function ensureInit() {
  if (!db) {
    if (PERF_FLAGS.LAZY_MODULES) {
      // Lazy loading path: only critical modules are initialized synchronously.
      // We need to do this synchronously for backward compatibility with registerIPCHandlers.
      console.log('[IPC] Initializing subsystems (lazy mode)...');
      try {
        db = initDatabase();
        sessionManager = new SessionManager(db);
        commandSystem = new CommandSystem();
        agentManager = new SuperAgentManager();

        // Register all built-in commands
        for (const cmd of builtInCommands) {
          commandSystem.register(cmd);
        }

        // Create default agents from built-in templates
        const templates = agentManager.listTemplates();
        for (const t of templates) {
          agentManager.createAgent(t);
        }

        // Set up the LazyModuleLoader for deferred modules
        moduleLoader = new LazyModuleLoader();

        // Register deferred modules with the loader
        moduleLoader.register({
          name: 'SwarmCoordinator',
          priority: 'deferred',
          factory: () => new SwarmCoordinator(new SwarmMemoryPool()),
        });

        moduleLoader.register({
          name: 'EnhancedSwarmCoordinator',
          priority: 'deferred',
          factory: () => new EnhancedSwarmCoordinator(null, db),
        });

        moduleLoader.register({
          name: 'FirewallEngine',
          priority: 'deferred',
          factory: () => new FirewallEngine(),
        });

        moduleLoader.register({
          name: 'EnhancedFirewallEngine',
          priority: 'deferred',
          factory: () => new EnhancedFirewallEngine(),
        });

        moduleLoader.register({
          name: 'IndexingPipelineController',
          priority: 'deferred',
          factory: () => null,
        });

        moduleLoader.register({
          name: 'GraphManager',
          priority: 'deferred',
          factory: () => new GraphManager(db),
        });

        moduleLoader.register({
          name: 'CronScheduler',
          priority: 'deferred',
          factory: () => {
            const scheduler = new CronScheduler(db);
            scheduler.onJobTrigger(async (job) => {
              console.log('[Scheduler] Running job:', job.name);
              const llm = resolveActiveLLMClient();
              if (llm) {
                const result = await llm.chat([
                  { role: 'system', content: 'You are a scheduled automation agent. Complete the following task concisely.' },
                  { role: 'user', content: job.task },
                ], { temperature: 0.4, maxTokens: 1000 });
                storeMessage('assistant', `⏰ [Scheduled: ${job.name}]\n\n${result.content || 'No output'}`, 'Scheduler');
              }
            });
            scheduler.startAll();
            return scheduler;
          },
        });

        moduleLoader.register({
          name: 'SkillLearner',
          priority: 'deferred',
          factory: () => new SkillLearner(db),
        });

        moduleLoader.register({
          name: 'OrchestratorPlanner',
          priority: 'deferred',
          factory: () => new OrchestratorPlanner(),
        });

        moduleLoader.register({
          name: 'ZeraOptimizer',
          priority: 'deferred',
          factory: () => new ZeraOptimizer(),
        });

        moduleLoader.register({
          name: 'ChannelManager',
          priority: 'deferred',
          factory: () => new ChannelManager(),
        });

        console.log('[IPC] Critical subsystems initialized (lazy mode). Commands:', commandSystem.list().length);
      } catch (e) {
        console.error('[IPC] Init error (lazy mode):', e);
      }
    } else {
      // Eager loading path: original behavior — all modules initialized at once
      console.log('[IPC] Initializing subsystems (eager mode)...');
      try {
        db = initDatabase();
        sessionManager = new SessionManager(db);
        commandSystem = new CommandSystem();
        agentManager = new SuperAgentManager();

        // Register all built-in commands
        for (const cmd of builtInCommands) {
          commandSystem.register(cmd);
        }

        // Create default agents from built-in templates
        const templates = agentManager.listTemplates();
        for (const t of templates) {
          agentManager.createAgent(t);
        }
        zeraOptimizer = new ZeraOptimizer();
        orchestratorPlanner = new OrchestratorPlanner();
        channelManager = new ChannelManager();
        firewallEngine = new FirewallEngine();
        enhancedFirewallEngine = new EnhancedFirewallEngine();
        firewallConfigManager = new FirewallConfigManager();
        graphManager = new GraphManager(db);
        runtimeManager = new RuntimeManager();
        enhancedSwarmCoordinator = new EnhancedSwarmCoordinator(null, db);
        console.log('[IPC] Enhanced swarm coordinator initialized:', !!enhancedSwarmCoordinator);

        // Initialize cost tracking
        try {
          costStore = new CostStore(db);
          pricingTable = loadPricingTable();
          console.log('[IPC] Cost tracking initialized');
        } catch (e) { console.warn('[IPC] Cost tracking init error:', e); }

        // Test database tables
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'").all();
          console.log('[IPC] Multica tables found:', tables.map((t: any) => t.name));

          // Test getting runtimes
          const runtimes = enhancedSwarmCoordinator.getEnhancedAgentManager().getRuntimes();
          console.log('[IPC] Default runtimes:', runtimes.length);
        } catch (e) {
          console.error('[IPC] Database test error:', e);
        }
        console.log('[IPC] Subsystems initialized. Agents:', AGENT_REGISTRY.length, '(registry) +', agentManager.listAgents().length, '(manager), Commands:', commandSystem.list().length);
        // Load bundled catalog and register design templates after DB init
        try {
          loadCatalogAndTemplates(db);
          console.log('[IPC] Bundled catalog and design templates loaded');
        } catch (e) { console.warn('[IPC] Catalog/template load error:', e); }
        // Pre-fetch local model lists in background
        refreshLocalModelLists();

        // Initialize cron scheduler and skill learner
        try {
          cronScheduler = new CronScheduler(db);
          cronScheduler.onJobTrigger(async (job) => {
            console.log('[Scheduler] Running job:', job.name);
            // Route the job's task through the normal message pipeline
            const llm = resolveActiveLLMClient();
            if (llm) {
              const result = await llm.chat([
                { role: 'system', content: 'You are a scheduled automation agent. Complete the following task concisely.' },
                { role: 'user', content: job.task },
              ], { temperature: 0.4, maxTokens: 1000 });
              // Store result
              storeMessage('assistant', `⏰ [Scheduled: ${job.name}]\n\n${result.content || 'No output'}`, 'Scheduler');
            }
          });
          cronScheduler.startAll();
          console.log('[IPC] Cron scheduler initialized');
        } catch (e) { console.warn('[IPC] Scheduler init error:', e); }

        try {
          skillLearner = new SkillLearner(db);
          console.log('[IPC] Skill learner initialized');
        } catch (e) { console.warn('[IPC] Skill learner init error:', e); }

      } catch (e) { console.error('[IPC] Init error:', e); }
    }
  }
}

/**
 * Initialize deferred modules. Should be called after window `ready-to-show`.
 * When PERF_FLAGS.LAZY_MODULES is enabled, this triggers the LazyModuleLoader's
 * deferred initialization. When disabled, this is a no-op (eager init already done).
 */
export async function initDeferredSubsystems(): Promise<void> {
  if (!PERF_FLAGS.LAZY_MODULES) {
    // Eager mode: everything already initialized in ensureInit()
    return;
  }

  if (deferredInitComplete) return;
  if (!db || !moduleLoader) {
    console.warn('[IPC] Cannot init deferred modules — critical modules not ready');
    return;
  }

  console.log('[IPC] Starting deferred module initialization...');
  const startTime = Date.now();

  try {
    await moduleLoader.initDeferred();

    // Assign deferred module instances to existing variables for backward compatibility
    enhancedSwarmCoordinator = moduleLoader.get('EnhancedSwarmCoordinator');
    firewallEngine = moduleLoader.get('FirewallEngine');
    enhancedFirewallEngine = moduleLoader.get('EnhancedFirewallEngine');
    graphManager = moduleLoader.get('GraphManager');
    cronScheduler = moduleLoader.get('CronScheduler');
    skillLearner = moduleLoader.get('SkillLearner');
    orchestratorPlanner = moduleLoader.get('OrchestratorPlanner');
    zeraOptimizer = moduleLoader.get('ZeraOptimizer');
    channelManager = moduleLoader.get('ChannelManager');

    // Initialize remaining subsystems not managed by LazyModuleLoader
    firewallConfigManager = new FirewallConfigManager();
    runtimeManager = new RuntimeManager();

    // Initialize cost tracking
    try {
      costStore = new CostStore(db);
      pricingTable = loadPricingTable();
      console.log('[IPC] Cost tracking initialized');
    } catch (e) { console.warn('[IPC] Cost tracking init error:', e); }

    // Test database tables
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'").all();
      console.log('[IPC] Multica tables found:', tables.map((t: any) => t.name));
      if (enhancedSwarmCoordinator) {
        const runtimes = enhancedSwarmCoordinator.getEnhancedAgentManager().getRuntimes();
        console.log('[IPC] Default runtimes:', runtimes.length);
      }
    } catch (e) {
      console.error('[IPC] Database test error:', e);
    }

    console.log('[IPC] Deferred subsystems initialized. Agents:', AGENT_REGISTRY.length, '(registry) +', agentManager.listAgents().length, '(manager)');

    // Load bundled catalog and register design templates
    try {
      loadCatalogAndTemplates(db);
      console.log('[IPC] Bundled catalog and design templates loaded');
    } catch (e) { console.warn('[IPC] Catalog/template load error:', e); }

    // Pre-fetch local model lists in background
    refreshLocalModelLists();

  } catch (e) {
    console.error('[IPC] Deferred init error:', e);
  }

  deferredInitComplete = true;
  console.log(`[IPC] Deferred initialization complete in ${Date.now() - startTime}ms`);

  // Wire channel manager events now that it's initialized (skipped during registerIPCHandlers in lazy mode)
  if (channelManager && _ipcMainWindow && !_ipcMainWindow.isDestroyed()) {
    try {
      // Auto-reconnect saved channels
      const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
      if (row) {
        const configs = JSON.parse(row.value);
        for (const [channelId, config] of Object.entries(configs)) {
          const cfg = config as any;
          if (!cfg || cfg.autoConnect === false || !cfg.wasConnected) continue;
          console.log('[IPC] Auto-reconnecting channel (deferred):', channelId);
          channelManager.connect(channelId, cfg).catch((err: any) => {
            console.warn('[IPC] Auto-reconnect error for', channelId, ':', err?.message);
          });
        }
      }
    } catch (e) {
      console.warn('[IPC] Deferred channel auto-reconnect error:', e);
    }

    try {
      channelManager.onMessage(async (msg: any) => {
        if (!_ipcMainWindow || _ipcMainWindow.isDestroyed()) return;
        console.log('[Channel]', msg.channelId, 'from', msg.from, ':', (msg.content || '').slice(0, 50));
        _ipcMainWindow.webContents.send('chat-response', {
          role: 'assistant',
          content: '💬 [' + msg.channelId + '] ' + msg.from + ': ' + (msg.content || ''),
          agent: msg.channelId,
          isCommand: true
        });
      });

      channelManager.onStatusChange((status: any) => {
        if (!_ipcMainWindow || _ipcMainWindow.isDestroyed()) return;
        _ipcMainWindow.webContents.send('channel-status-update', status);
      });

      console.log('[IPC] Channel manager wired (deferred)');
    } catch (e) {
      console.warn('[IPC] Deferred channel wiring error:', e);
    }
  }
}

/**
 * Restore the last active project from config, or ensure there's at least one project
 */
async function restoreActiveProject(mainWindow: any) {
  try {
    // Try to get the last active project from config
    const configValue = getCachedConfig('activeProjectId');
    
    if (configValue) {
      try {
        // Try to open the last active project
        const session = await sessionManager.open(configValue);
        activeSessionId = configValue;
        console.log('[IPC] Restored last active project:', configValue);
        mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
        return;
      } catch (sessionError) {
        console.warn('[IPC] Could not restore last active project:', configValue, sessionError);
        // Clear invalid project from config
        invalidateConfigCache('activeProjectId');
        db.prepare('DELETE FROM config WHERE key = ?').run('activeProjectId');
      }
    }
    
    // No valid active project found, get or create one
    const projects = sessionManager.list();
    
    if (projects.length > 0) {
      // Use the most recently updated project
      const latestProject = projects.sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0];
      
      activeSessionId = latestProject.id;
      console.log('[IPC] Set most recent project as active:', latestProject.id, latestProject.name);
      
      // Save this as the active project
      setCachedConfig('activeProjectId', latestProject.id);
      
      mainWindow.webContents.send('active-project', { id: latestProject.id, name: latestProject.name });
    } else {
      // No projects exist, create a default one
      const session = sessionManager.create({ name: 'Welcome Project' });
      activeSessionId = session.id;
      console.log('[IPC] Created default project:', session.id, session.name);
      
      // Save this as the active project
      setCachedConfig('activeProjectId', session.id);
      
      mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
    }
    
  } catch (error) {
    console.error('[IPC] Error restoring active project:', error);
    // Fallback: create a new project
    try {
      const session = sessionManager.create({ name: 'Default Project' });
      activeSessionId = session.id;
      console.log('[IPC] Created fallback project:', session.id, session.name);
      mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
    } catch (fallbackError) {
      console.error('[IPC] Failed to create fallback project:', fallbackError);
    }
  }
}

// Cached local model lists — refreshed on startup and on demand
let cachedOllamaModels: any[] | null = null;
let cachedLlamaCppModels: any[] | null = null;

async function refreshLocalModelLists() {
  const http = require('node:http');
  // Refresh Ollama models
  try {
    const ollamaInstalled: string[] = await new Promise((resolve) => {
      const req = http.get('http://localhost:11434/api/tags', { timeout: 5000 }, (res: any) => {
        let body = '';
        res.on('data', (c: any) => body += c);
        res.on('end', () => {
          try { const d = JSON.parse(body); resolve((d.models || []).map((m: any) => m.name || m.model)); }
          catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
    if (ollamaInstalled.length > 0) {
      cachedOllamaModels = ollamaInstalled.map(m => ({ id: m, installed: true }));
      console.log('[IPC] Cached', ollamaInstalled.length, 'Ollama models');
    }
  } catch { /* Ollama not running — that's fine */ }

  // Refresh llama.cpp models
  try {
    const llamaModels: string[] = await new Promise((resolve) => {
      const req = http.get('http://localhost:8080/v1/models', { timeout: 5000 }, (res: any) => {
        let body = '';
        res.on('data', (c: any) => body += c);
        res.on('end', () => {
          try { const d = JSON.parse(body); resolve((d.data || []).map((m: any) => m.id)); }
          catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
    if (llamaModels.length > 0) {
      cachedLlamaCppModels = llamaModels.map(m => ({ id: m, installed: true }));
      console.log('[IPC] Cached', llamaModels.length, 'llama.cpp models');
    }
  } catch { /* llama.cpp not running — that's fine */ }
}

function storeMessage(role: string, content: string, agent?: string) {
  if (!activeSessionId || !db) return;
  // Don't store messages with empty content (completion signals, etc.)
  if (!content || content.trim() === '') return;
  try {
    const id = require('node:crypto').randomUUID();
    cachedStmt('INSERT INTO messages (id, session_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, activeSessionId, role, content, agent ? JSON.stringify({agent}) : null, new Date().toISOString());

    // ── Pipeline_Event emit (12-factor-agent-improvements task 11) ──
    // Emit chat.user on user-message receipt and chat.assistant on
    // assistant-message persistence, gated by the unified-event-log
    // flags. Reusing the same `id` we just stored as `messageId` keeps
    // the event row joinable to the messages table without a second
    // randomUUID() call. Other roles (system, meta) are skipped by the
    // emitter — they aren't part of the design's chat-transcript
    // surface. Wrapped in a try/catch so an emitter regression cannot
    // tear down the persistence path. Validates: Requirements 2.4.
    try {
      if (role === 'user' || role === 'assistant') {
        emitChatEvent(getEventLog(), {
          sessionId: activeSessionId,
          role,
          messageId: id,
          body: content,
          agentId: agent,
        });
      }
    } catch (emitErr) {
      console.warn('[IPC] chat-event emit failed:', (emitErr as Error)?.message);
    }
  } catch (e) { console.error('[IPC] storeMessage error:', e); }
}

/**
 * Lazily construct (and return) the singleton EventLog used by the
 * Event_Bus_Bridge. Returns null if the database is not yet initialized
 * — callers MUST tolerate that case (the bridge handler does, by
 * dropping the event silently per design.md "Renderer emits via
 * Event_Bus_Bridge while main is shutting down").
 *
 * Centralised here so other emitters introduced by tasks 10-15 can
 * reuse the same instance without each one re-instantiating.
 */
function getEventLog(): EventLog | null {
  if (eventLog) return eventLog;
  if (!db) return null;
  try {
    eventLog = new EventLog(db);
    return eventLog;
  } catch (e) {
    console.warn('[event-log] could not construct EventLog:', (e as Error)?.message);
    return null;
  }
}

/**
 * Lazily construct (and return) the singleton `UnifiedStateReducer` used
 * by the prompt-state-block helper (12-factor-agent-improvements task
 * 25). Returns null if the database / EventLog / telemetry service is
 * not yet ready — callers MUST tolerate that case (the
 * `assembleStateBlockForSession` wrapper does so by returning '').
 *
 * The reducer is a singleton so the warm-path cache is shared across
 * every chat-message handler. Reconstructing it per call would defeat
 * the whole point of caching `lastSeq` and force a cold reduce on every
 * prompt assembly.
 */
function getUnifiedReducer():
  | import('../pipeline/unified-state-reducer').UnifiedStateReducer
  | null {
  if (unifiedReducer) return unifiedReducer;
  const log = getEventLog();
  if (!log || !db) return null;
  try {
    const { UnifiedStateReducer } = require('../pipeline/unified-state-reducer');
    const { SessionTelemetryService } = require('../session/session-telemetry');
    // Telemetry service is cheap to instantiate (just a few prepared
    // statements) and shares the db handle with the rest of the app.
    // We don't reuse the `telemetryService` constant declared further
    // down because that's scoped to a later registration block; this
    // separate handle is used only by the reducer + helper.
    const telemetry = new SessionTelemetryService(db);
    unifiedReducer = new UnifiedStateReducer(log, telemetry);
    return unifiedReducer;
  } catch (e) {
    console.warn(
      '[unified-state-reducer] could not construct reducer:',
      (e as Error)?.message,
    );
    return null;
  }
}

/**
 * Build the `## Current State` block for the given session via the
 * prompt-state-block helper (task 25). Returns '' on any error or when
 * the reducer isn't ready, so callers can splice the result
 * unconditionally. The helper itself enforces flag gating and shadow
 * mode — see `prompt-state-block.ts`.
 */
async function assembleStateBlockForSession(sessionId: string): Promise<string> {
  if (!sessionId) return '';
  const reducer = getUnifiedReducer();
  if (!reducer || !db) return '';
  try {
    const { assembleStateBlock } = require('../pipeline/prompt-state-block');
    const { SessionTelemetryService } = require('../session/session-telemetry');
    const metrics = new SessionTelemetryService(db);
    return await assembleStateBlock(sessionId, { reducer, metrics });
  } catch (e) {
    console.warn(
      '[prompt-state-block] assembly failed:',
      (e as Error)?.message,
    );
    return '';
  }
}

function autoCreateProject(mainWindow: any, firstMessage: string) {
  if (activeSessionId) return;
  const name = firstMessage.length > 40 ? firstMessage.slice(0, 40) + '...' : firstMessage;
  const session = sessionManager.create({ name: 'Project: ' + name });
  activeSessionId = session.id;
  console.log('[IPC] Auto-created project:', session.id, session.name);
  
  // Store the active project in config for persistence
  try {
    setCachedConfig('activeProjectId', session.id);
    console.log('[IPC] Saved auto-created active project to config:', session.id);
  } catch (configError) {
    console.warn('[IPC] Failed to save auto-created active project to config:', configError);
  }
  
  const projects = sessionManager.list().map((s: any) => ({ id: s.id, name: s.name, messageCount: s.messageCount }));
  mainWindow.webContents.send('projects-list', projects);
  mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
}

/**
 * Enhanced firewall evaluation with backward compatibility
 * Uses enhanced firewall if available, falls back to basic firewall
 */
async function evaluateFirewall(content: string, context: { agentId?: string; projectId?: string }) {
  try {
    // Get effective policy for this context
    const policy = firewallConfigManager.getEffectivePolicy(context.agentId, context.projectId);
    
    // Use enhanced firewall if LLM tier is enabled, otherwise use basic firewall
    if (policy.enableLLMTier && enhancedFirewallEngine.isLLMTierEnabled()) {
      return await enhancedFirewallEngine.evaluateHybrid(content, {
        agentId: context.agentId,
        projectId: context.projectId,
        policy,
        redactionConfig: firewallConfigManager.getConfig().redactionConfig
      });
    } else {
      // Use basic firewall for backward compatibility
      return firewallEngine.evaluate(content, context);
    }
  } catch (error) {
    console.warn('[IPC] Enhanced firewall evaluation failed, using basic firewall:', error);
    return firewallEngine.evaluate(content, context);
  }
}

export function registerIPCHandlers(deps: IPCDependencies): void {
  const { mainWindow } = deps;
  _ipcMainWindow = mainWindow; // Store for deferred channel wiring
  ensureInit();

  // ── CRITICAL: Register license handlers FIRST, before anything else ──
  // This ensures activation always works even if other subsystems fail to initialize.
  try {
    // If db failed to initialize in ensureInit, try once more just for license
    if (!db) {
      console.warn('[IPC] db is null after ensureInit — attempting standalone DB init for license...');
      try {
        db = initDatabase();
        console.log('[IPC] Standalone DB init succeeded for license');
      } catch (dbErr) {
        console.error('[IPC] Standalone DB init also failed:', dbErr);
      }
    }
    // Remove any previously registered license handlers
    const licenseChannels = [
      'license:fetch-by-code', 'license:validate', 'license:generate',
      'license:mark-used', 'license:get-stored', 'license:update-features',
      'license:get-app-id', 'referral:send-invite', 'referral:get-stats',
      'referral:delete-invite', 'referral:get-deleted-invites', 'referral:withdraw',
    ];
    for (const ch of licenseChannels) {
      try { ipcMain.removeHandler(ch); } catch {}
    }
    if (db) {
      registerLicenseIPC(db);
      console.log('[IPC] License IPC handlers registered (early)');
    } else {
      console.error('[IPC] CRITICAL: Cannot register license handlers — database unavailable. This is likely a native module (better-sqlite3) issue.');
    }
  } catch (licenseErr) {
    console.error('[IPC] CRITICAL: Failed to register license handlers:', licenseErr);
  }

  // ── Pro-mode state sync (renderer → main) ──────────────────────────
  // The renderer is the source of truth for professionalMode + licenseKey
  // + proxyEndpoint (held in localStorage). The main process needs those
  // values whenever it constructs an LLMClient so requests route through
  // the NeuroNest LLM service. Two channels keep the cache fresh:
  //   • pro-mode:hydrate  — on renderer boot, full snapshot
  //   • pro-mode:set-state — on every change, partial update
  try {
    const { setProModeState, getProModeState } = require('../pipeline/pro-mode-state');
    for (const ch of ['pro-mode:hydrate', 'pro-mode:set-state', 'pro-mode:get-state']) {
      try { ipcMain.removeHandler(ch); } catch {}
    }
    ipcMain.handle('pro-mode:hydrate', (_ev, snapshot: any) => {
      try {
        setProModeState({
          enabled: snapshot?.enabled === true,
          authToken: typeof snapshot?.authToken === 'string' ? snapshot.authToken : '',
          endpoint: typeof snapshot?.endpoint === 'string' ? snapshot.endpoint : '',
        });
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
    ipcMain.handle('pro-mode:set-state', (_ev, patch: any) => {
      try {
        setProModeState({
          ...(typeof patch?.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
          ...(typeof patch?.authToken === 'string' ? { authToken: patch.authToken } : {}),
          ...(typeof patch?.endpoint === 'string' && patch.endpoint.length > 0 ? { endpoint: patch.endpoint } : {}),
        });
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
    ipcMain.handle('pro-mode:get-state', () => {
      return getProModeState();
    });
    console.log('[IPC] Pro-mode state IPC handlers registered');
  } catch (proModeErr) {
    console.error('[IPC] Failed to register pro-mode state handlers:', proModeErr);
  }

  // Delay restoreActiveProject until renderer is fully loaded and ready
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[IPC] Renderer finished loading, restoring active project...');

    // Inject branding into the renderer so it can reference APP_NAME etc.
    try {
      const { BRANDING } = require('../branding');
      mainWindow.webContents.executeJavaScript(
        `window.__BRANDING__ = ${JSON.stringify(BRANDING)};`
      );
    } catch (brandErr) {
      console.warn('[IPC] Failed to inject branding:', brandErr);
    }

    restoreActiveProject(mainWindow).catch(error => {
      console.error('[IPC] Failed to restore active project:', error);
    });

    // Auto-reconnect saved channels on startup (only if channelManager is initialized)
    if (channelManager) {
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
        if (row) {
          const configs = JSON.parse(row.value);
          for (const [channelId, config] of Object.entries(configs)) {
            const cfg = config as any;
            // Only auto-reconnect channels that were actually connected when the app last quit.
            // This prevents WhatsApp from triggering QR auth flows on every startup,
            // and avoids reconnecting channels the user explicitly disconnected.
            if (!cfg || cfg.autoConnect === false || !cfg.wasConnected) {
              if (cfg && !cfg.wasConnected) {
                console.log('[IPC] Skipping auto-reconnect for', channelId, '(was not connected at last quit)');
              }
              continue;
            }
            console.log('[IPC] Auto-reconnecting channel:', channelId, '(was connected at last quit)');
            channelManager.connect(channelId, cfg).then((result) => {
              if (result.success) {
                console.log('[IPC] Auto-reconnect initiated for:', channelId);
              } else {
                console.warn('[IPC] Auto-reconnect failed for', channelId, ':', result.message);
              }
            }).catch((err) => {
              console.warn('[IPC] Auto-reconnect error for', channelId, ':', err?.message);
            });
          }
        }
      } catch (e) {
        console.warn('[IPC] Channel auto-reconnect error:', e);
      }
    }
  });

  // Wire channel incoming messages to chat (only if channelManager is initialized;
  // in lazy mode, channelManager is deferred and wired after initDeferredSubsystems)
  if (channelManager) {
  channelManager.onMessage(async (msg) => { 
    console.log('[Channel]', msg.channelId, 'from', msg.from, ':', msg.content.slice(0, 50)); 
    
    // ── Firewall: scan channel messages for security ──
    let channelContent = msg.content || '';
    if (channelContent) {
      const fwResult = await evaluateFirewall(channelContent, { 
        agentId: 'channel:' + msg.channelId, 
        projectId: activeSessionId || undefined 
      });
      
      if (fwResult.blocked) {
        // Block malicious channel messages
        console.warn('[Firewall] Blocked channel message from', msg.from, 'on', msg.channelId);
        mainWindow.webContents.send('chat-response', { 
          role: 'assistant', 
          content: '🛡️ **Channel Message Blocked** — A message from ' + msg.from + ' on ' + msg.channelId + ' was blocked by security policy.',
          agent: 'Firewall', 
          isCommand: true 
        });
        mainWindow.webContents.send('firewall-event', { 
          type: 'block', 
          source: 'channel-message', 
          channelId: msg.channelId, 
          from: msg.from,
          events: fwResult.events 
        });
        return; // Don't process blocked messages
      }
      
      if (fwResult.events.length > 0) {
        // Log firewall events for channel messages
        mainWindow.webContents.send('firewall-event', { 
          type: 'scan', 
          source: 'channel-message', 
          channelId: msg.channelId, 
          from: msg.from,
          events: fwResult.events 
        });
      }
      
      // Use sanitized content
      channelContent = fwResult.sanitized;
    }
    
    // Show incoming message in the UI
    mainWindow.webContents.send('chat-response', { 
      role: 'assistant', 
      content: '💬 [' + msg.channelId + '] ' + msg.from + ': ' + channelContent, 
      agent: msg.channelId, 
      isCommand: true 
    });

    // ── Process through NeuroNest pipeline and reply back ──
    // Supports two modes configured per-channel:
    // - "full" = ZERA → Orchestrator → Swarm (same as chat prompt)
    // - "smart" = Single LLM call with NeuroNest personality + project context (default, faster)
    if (channelContent.trim()) {
      try {
        // Determine processing mode from channel config
        let channelMode = 'smart'; // default
        try {
          const cfgRow = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
          if (cfgRow) {
            const configs = JSON.parse(cfgRow.value);
            const chCfg = configs[msg.channelId];
            if (chCfg?.mode === 'full' || chCfg?.processingMode === 'full') {
              channelMode = 'full';
            }
          }
        } catch {}

        mainWindow.webContents.send('chat-response', { 
          role: 'assistant', 
          content: '🧠 Processing message from ' + msg.from + ' on ' + msg.channelId + ' [' + channelMode + ' mode]...', 
          agent: 'NeuroNest', 
          isCommand: true 
        });

        let responseText = '';

        if (channelMode === 'full') {
          // ── FULL PIPELINE MODE ──
          // Route through the same pipeline as the chat prompt:
          // Message Router → ZERA Optimizer → Orchestrator → Swarm Coordinator
          try {
            // Step 1: ZERA Optimize
            const zeraResult = await zeraOptimizer.optimize(channelContent);
            const optimizedPrompt = zeraResult.optimizedPrompt || channelContent;

            // Step 2: Orchestrator Plan
            const plan = orchestratorPlanner.createPlan(optimizedPrompt);

            // Step 3: Get LLM client
            let llmClient = resolveActiveLLMClient();

            if (llmClient) {
              // Step 4: Swarm execution — run top agents from the plan
              const outputs = new Map<string, string>();
              for (const agentTask of plan.agents.slice(0, 3)) { // Limit to 3 agents for messaging speed
                const agentDef = AGENT_REGISTRY.find((a: any) => a.id === agentTask.id);
                if (!agentDef) continue;
                try {
                  const result = await llmClient.chat([
                    { role: 'system', content: agentDef.systemPrompt },
                    { role: 'user', content: agentTask.task },
                  ], { temperature: 0.7, maxTokens: 1024 });
                  if (result.content) outputs.set(agentTask.id, result.content);
                } catch {}
              }

              // Combine outputs
              if (outputs.size > 0) {
                responseText = [...outputs.values()].join('\n\n').slice(0, 3500);
              } else {
                responseText = '⚠️ Pipeline executed but no agent produced output.';
              }
            } else {
              responseText = '⚠️ No AI provider configured. Go to Settings → Providers to add one.';
            }
          } catch (pipeErr: any) {
            console.error('[Channel] Full pipeline error:', pipeErr?.message);
            responseText = '⚠️ Pipeline error: ' + (pipeErr?.message || 'Unknown').slice(0, 200);
          }
        } else {
          // ── SMART MODE (default) ──
          // Single LLM call with NeuroNest personality, project context, and memory
          let llmClient = resolveActiveLLMClient();

          if (llmClient) {
            // Build context-aware system prompt
            let systemPrompt = 'You are NeuroNest 🧠, a powerful AI coding assistant. You are responding via ' + msg.channelId + '.\n' +
              'You have access to 109 specialized AI agents across 13 departments.\n' +
              'Be concise, helpful, and actionable. Keep responses under 2000 characters for messaging platform limits.\n' +
              'If the user asks you to build something, explain what you would do and suggest they use the NeuroNest desktop app for full project generation.\n' +
              'For questions, provide direct answers. For coding help, provide code snippets.';

            // Add project context if available
            if (activeSessionId) {
              try {
                const projRow = db.prepare("SELECT value FROM config WHERE key = 'active-project-name'").get() as any;
                if (projRow) {
                  systemPrompt += '\n\nActive project: ' + projRow.value;
                }
              } catch {}
            }

            try {
              const result = await llmClient.chat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: channelContent },
              ], { temperature: 0.7, maxTokens: 1024 });
              responseText = result.content || 'I received your message but could not generate a response.';
            } catch (llmErr: any) {
              console.error('[Channel] LLM call failed:', llmErr?.message);
              responseText = '⚠️ AI processing error: ' + (llmErr?.message || 'Unknown error').slice(0, 200);
            }
          } else {
            responseText = '🤖 NeuroNest received your message. Configure an AI provider in Settings to enable intelligent responses.';
          }
        }

        // Send response back to the messaging platform
        // Strip markdown formatting that messaging platforms can't render
        const plainResponseText = responseText
          .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** → bold
          .replace(/\*([^*]+)\*/g, '$1')      // *italic* → italic
          .replace(/#{1,6}\s+/g, '')          // ## headers → plain text
          .replace(/```[\w]*\n?/g, '')        // code fences
          .replace(/`([^`]+)`/g, '$1')        // `inline code` → plain
          .replace(/^[-*]\s+/gm, '• ')        // - bullets → •
          .replace(/^\d+\.\s+/gm, '')         // numbered lists → plain
          .trim();
        const sendResult = await channelManager.sendMessage(msg.channelId, msg.from, plainResponseText);
        
        if (sendResult.success) {
          mainWindow.webContents.send('chat-response', { 
            role: 'assistant', 
            content: '✅ [' + msg.channelId + '] → ' + msg.from + ':\n\n' + responseText.slice(0, 500) + (responseText.length > 500 ? '...' : ''), 
            agent: 'NeuroNest', 
            isCommand: true 
          });
        } else {
          mainWindow.webContents.send('chat-response', { 
            role: 'assistant', 
            content: '⚠️ Generated response but failed to send back to ' + msg.channelId + ': ' + sendResult.message, 
            agent: 'NeuroNest', 
            isCommand: true 
          });
        }
      } catch (pipelineErr: any) {
        console.error('[Channel] Pipeline processing error:', pipelineErr?.message);
        // Try to send error message back to the platform
        try {
          await channelManager.sendMessage(msg.channelId, msg.from, '⚠️ Sorry, I encountered an error processing your message. Please try again.');
        } catch {}
      }
    }
  });

  // Wire channel status updates to renderer
  channelManager.onStatusChange((status: any) => {
    console.log('[IPC] Channel status update:', JSON.stringify(status));
    try {
      mainWindow.webContents.send('channel-status-update', status);
      console.log('[IPC] Sent channel-status-update to renderer');
    } catch (e: any) {
      console.error('[IPC] Failed to send channel-status-update:', e?.message);
    }

    // Persist live connection state for smart auto-reconnect on next startup
    // Only auto-reconnect channels that were actually connected (not just configured)
    if (status.channelId && (status.status === 'connected' || status.status === 'disconnected' || status.status === 'error')) {
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
        if (row) {
          const configs = JSON.parse(row.value);
          if (configs[status.channelId]) {
            configs[status.channelId].wasConnected = (status.status === 'connected');
            db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('channel-configs', ?, ?)").run(JSON.stringify(configs), new Date().toISOString());
            console.log('[IPC] Saved connection state for', status.channelId, ':', status.status);
          }
        }
      } catch (e: any) {
        console.warn('[IPC] Failed to save channel connection state:', e?.message);
      }
    }
  });
  } // end if (channelManager)

  /**
   * Handle file tree updates with retry logic and exponential backoff
   * Implements comprehensive error recovery for IPC communication failures
   */
  function handleFileTreeUpdateWithRetry(batchedEvent: BatchedEvent, window: Electron.BrowserWindow, retryCount: number): void {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 100;
    
    try {
      console.log('[IPC] Sending incremental file tree update:', batchedEvent.projectId, batchedEvent.filePaths.length, 'files', retryCount > 0 ? `(retry ${retryCount})` : '');
      
      // Check if window is still valid
      if (!window || window.isDestroyed()) {
        console.warn('[IPC] Window destroyed, cannot send file tree update');
        return;
      }
      
      window.webContents.send('project-files-updated', {
        projectId: batchedEvent.projectId,
        filePaths: batchedEvent.filePaths,
        batchId: batchedEvent.batchId,
        isIncremental: true
      });
      
      // Success - reset any retry state if this was a retry
      if (retryCount > 0) {
        console.log('[IPC] File tree update succeeded after', retryCount, 'retries');
      }
      
    } catch (error) {
      console.error('[IPC] Error sending incremental file tree update:', error);
      
      // Retry with exponential backoff if we haven't exceeded max retries
      if (retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
        console.log('[IPC] Retrying file tree update in', delay, 'ms (attempt', retryCount + 1, 'of', MAX_RETRIES, ')');
        
        setTimeout(() => {
          handleFileTreeUpdateWithRetry(batchedEvent, window, retryCount + 1);
        }, delay);
        return;
      }
      
      // Max retries exceeded - fall back to full tree reload
      console.warn('[IPC] Max retries exceeded for incremental update, falling back to full reload');
      try {
        if (!window || window.isDestroyed()) {
          console.warn('[IPC] Window destroyed, cannot send fallback update');
          return;
        }
        
        window.webContents.send('project-files-updated', { 
          projectId: batchedEvent.projectId,
          fallbackReason: 'ipc-retry-exhausted'
        });
        console.log('[IPC] Fallback full reload sent successfully');
        
      } catch (fallbackError) {
        console.error('[IPC] Fallback file tree update also failed:', fallbackError);
        // At this point, we've exhausted all recovery options
        // The final project-files-updated event at the end of execution will serve as reconciliation
      }
    }
  }

  // Wire FileEventEmitter batched events to renderer for real-time file tree updates
  // Extends the existing project-files-updated event with incremental update support:
  // - Standard event: { projectId: string } - triggers full tree reload (backward compatible)
  // - Incremental event: { projectId: string, filePaths: string[], batchId: string, isIncremental: true }
  const fileEventEmitter = FileEventEmitter.getInstance();
  fileEventEmitter.onBatchReady('ipc-handler', (batchedEvent: BatchedEvent) => {
    handleFileTreeUpdateWithRetry(batchedEvent, mainWindow, 0);
  });

  // Connect FileTreeCache to FileEventEmitter for auto-invalidation on file changes
  if (PERF_FLAGS.FILE_TREE_CACHE) {
    const fileTreeCache = FileTreeCache.getInstance();
    fileTreeCache.connectToFileEvents(fileEventEmitter);
  }

  // Helper: invalidate the FileTreeCache (when enabled) and notify the renderer
  // that a project's file tree changed. Use this at every site that mutates
  // project files OUTSIDE the FileEventEmitter pipeline (e.g. simple responder
  // delete_files / delete_all, NEURONEST.md generation, lint auto-fix). The
  // FileEventEmitter-wired sites at handleFileTreeUpdateWithRetry already
  // invalidate via FileTreeCache.connectToFileEvents above.
  function notifyProjectFilesUpdated(projectId: string, payload?: Record<string, unknown>) {
    if (!projectId) return;
    if (PERF_FLAGS.FILE_TREE_CACHE) {
      try { FileTreeCache.getInstance().invalidate(projectId); } catch {}
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project-files-updated', { projectId, ...(payload || {}) });
    }
  }

  // Remove old handlers if re-registering (e.g. on window recreate)
  const handlersToRemove = [
    'get-projects', 'get-agents', 'get-agent-details', 'get-theme', 'get-config',
    'get-commands', 'autocomplete-command', 'get-departments', 'get-agent-prompt',
    'validate-api-key', 'list-provider-models', 'save-providers', 'load-providers',
    'get-agent-model', 'install-ollama', 'start-ollama', 'stop-ollama',
    'start-llamacpp', 'stop-llamacpp', 'uninstall-ollama', 'uninstall-llamacpp',
    'set-default-provider', 'get-default-provider', 'pull-ollama-model',
    'test-llm-connection',
    'get-ollama-status', 'get-llamacpp-status', 'install-llamacpp',
    'get-project-files', 'read-project-file', 'connect-channel', 'disconnect-channel',
    'send-channel-message', 'get-channel-status', 'get-channel-configs',
    'get-integrations', 'get-dashboard-stats', 'get-project-cost', 'get-cost-breakdown', 'get-system-stats', 'download-project-zip',
    'webauthn-register-start', 'webauthn-register-finish', 'webauthn-login-start', 'webauthn-login-finish', 'git-push-project', 'firewall-get-rules', 'firewall-get-events', 'firewall-get-stats', 'firewall-toggle-rule', 'firewall-update-action',
    // Enhanced firewall handlers
    'enhanced-firewall-get-config', 'enhanced-firewall-update-policy', 'enhanced-firewall-update-redaction-config', 'enhanced-firewall-set-agent-policy', 'enhanced-firewall-set-project-policy', 'enhanced-firewall-apply-preset', 'enhanced-firewall-enable-llm', 'enhanced-firewall-get-stats', 'enhanced-firewall-test-input', 'enhanced-firewall-reset-config', 'enhanced-firewall-export-config',
    // Graph management handlers
    'graph-has-graph', 'graph-generate', 'graph-load', 'graph-query', 'graph-stats',
    // Multica integration handlers
    'multica-get-tasks', 'multica-get-task-stats', 'multica-get-agent-tasks', 'multica-add-task-comment', 'multica-get-agent-skills', 'multica-assign-skill', 'multica-get-runtimes', 'multica-register-runtime',
    // Skills IPC handlers (for re-registration on window recreate)
    'skills:list', 'skills:get', 'skills:update', 'skills:install', 'skills:remove',
    'skills:enable', 'skills:disable', 'skills:test', 'skills:refreshCatalog',
    'skills:import', 'skills:export',
    'orchestrator:routeTask', 'project:skills:get', 'project:skills:update', 'project:skills:assign',
    'get-agent-skill-assignments',
    // Skill Pack IPC handlers (F11) — registered via registerSkillPacksIPC
    'skill-packs:install', 'skill-packs:list', 'skill-packs:sync',
    'skill-packs:remove', 'skill-packs:check-drift', 'skill-packs:run-eval',
    // Runtime handlers
    'runtime-start', 'runtime-stop', 'runtime-restart', 'runtime-status', 'runtime-detect-stack', 'runtime-get-logs',
    // Indexing pipeline handlers
    'indexing:getStatus', 'indexing:fullReindex', 'indexing:stop', 'indexing:getConfig', 'indexing:updateConfig',
    // Performance: BoundedMessageStore
    'load-older-messages', 'persist-overflow-messages', 'get-overflow-count', 'clear-overflow-session',
    // Multi-Chat IPC handlers
    'create-chat-session', 'list-chat-sessions', 'switch-chat-session',
    // Note: License & Referral handlers are registered separately at the top of registerIPCHandlers
  ];
  for (const h of handlersToRemove) {
    try { ipcMain.removeHandler(h); } catch {}
  }

  // ── License Key IPC handlers (already registered early — skip if already done) ──
  // Registered at the top of registerIPCHandlers to ensure activation always works.

  // ── App Info ──

  ipcMain.handle('get-app-version', async () => {
    const { app } = require('electron');
    return app.getVersion();
  });

  // ── Readiness Probe (F6) ──

  ipcMain.handle('app:readiness', async () => {
    // Reuse the already-initialized SQLite handle; fall back to a standalone
    // init only if subsystems haven't been bootstrapped yet.
    const readinessDb = db ?? initDatabase();
    // The data directory is the parent of the SQLite database file.
    const path = require('node:path');
    const dataDir = path.dirname(getDefaultDbPath());
    return checkReadiness(readinessDb, dataDir);
  });

  // ── Hardware Fit Cookbook (F8) ──

  ipcMain.handle('cookbook:detect-hardware', async () => {
    try { return detectHardware(); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('cookbook:rank-models', async (_ev: any, args: { profile?: any; options?: any } = {}) => {
    try { return rankModels(args.profile ?? detectHardware(), args.options); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('cookbook:compute-profiles', async (_ev: any, args: { profile?: any; model: any }) => {
    try { return computeServeProfiles(args.profile ?? detectHardware(), args.model); }
    catch (e: any) { return { error: e.message }; }
  });

  // ── GCF_Wire_Format Phase 1 rollout gate (F10 — Req 56.4) ──
  // Reads the persisted per-provider comprehension verdicts
  // (~/.neuronest/gcf-capabilities.json) and the configured providers, then
  // returns whether the GCF_WIRE_FORMAT active flip is allowed plus the list
  // of providers that still block it. The Settings panel keys a yellow warning
  // banner off `allowed === false`. Fail-soft: any error degrades to a blocked
  // gate (`allowed: false`) so the flip is never silently permitted.
  ipcMain.handle('gcf:rollout-gate-status', async () => {
    try {
      const provJson = getCachedConfig('providers');
      const providers = provJson ? JSON.parse(provJson) : [];
      return getRolloutGateStatus(providers);
    } catch (e: any) {
      return {
        allowed: false,
        configuredProviders: [],
        capableProviders: [],
        nonCapableProviders: [],
        error: e && e.message ? e.message : String(e),
      };
    }
  });

  // ── Skill Packs (F11) ──
  // The six install/list/sync/remove + drift/eval channels live in the dedicated
  // registerSkillPacksIPC module (`./skill-packs-ipc.ts`). Dependencies are
  // injected so the module never reaches into this monolith's singletons: the
  // shared SQLite handle (for the Skill_Registry the loader registers into) and
  // the active LLM client resolver (eval runner, never a hardcoded model).
  registerSkillPacksIPC({
    getDb: () => db,
    resolveActiveLLMClient,
  });

  // ── Sessions ──

  ipcMain.handle('get-projects', async () => {
    return sessionManager.list().map(s => ({
      id: s.id, name: s.name, messageCount: s.messageCount,
      updatedAt: s.updatedAt.toISOString(),
    }));
  });

  ipcMain.handle('get-active-project', async () => {
    if (activeSessionId) {
      try {
        const session = await sessionManager.open(activeSessionId);
        return { id: session.id, name: session.name };
      } catch (error) {
        console.warn('[IPC] Active project not found:', activeSessionId);
        return null;
      }
    }
    return null;
  });

  // ── Agents ──

  ipcMain.handle('get-agents', async () => {
    return AGENT_REGISTRY.map(a => ({
      id: a.id, name: a.name, role: a.specialty,
      model: 'deepseek/deepseek-chat', department: a.department, emoji: a.emoji,
      status: getAgentStatus(a.id), // Add status information
    }));
  });

  ipcMain.handle('get-departments', async () => {
    const result = DEPARTMENTS.map(d => {
      const agents = getAgentsByDepartment(d);
      // Special case: NeuroNest Orchestration can orchestrate ALL agents
      const isOrchestration = d === 'NeuroNest Orchestration';
      const displayCount = isOrchestration ? AGENT_REGISTRY.length : agents.length;
      const displayAgents = isOrchestration ? AGENT_REGISTRY : agents;
      
      // BACKEND FIX: Improved icon selection logic for NeuroNest Orchestration
      let icon: string;
      if (isOrchestration) {
        // NeuroNest Orchestration gets a specific brain emoji '🧠' regardless of getAgentsByDepartment results
        icon = '🧠';
        console.log(`[BACKEND FIX] NeuroNest Orchestration: Using brain emoji regardless of agents array (agents.length: ${agents.length})`);
      } else {
        // Regular departments use first agent's emoji or fallback to building
        icon = agents.length > 0 ? agents[0].emoji : '🏢';
      }
      
      return {
        name: d,
        icon: icon,
        count: displayCount,
        agents: displayAgents.map(a => ({ 
          id: a.id, name: a.name, emoji: a.emoji, specialty: a.specialty, role: a.specialty,
          status: getAgentStatus(a.id), // Add status information
        })),
      };
    });
    
    // DATA VALIDATION LOGGING: Verify NeuroNest Orchestration is included in returned data
    const neuroNestDept = result.find(d => d.name === 'NeuroNest Orchestration');
    if (neuroNestDept) {
      console.log(`[DATA VALIDATION] NeuroNest Orchestration successfully included:`, {
        name: neuroNestDept.name,
        icon: neuroNestDept.icon,
        count: neuroNestDept.count,
        agentsLength: neuroNestDept.agents.length,
        isOrchestration: true,
        displayCount: neuroNestDept.count,
        displayAgents: neuroNestDept.agents.length
      });
    } else {
      console.error(`[DATA VALIDATION ERROR] NeuroNest Orchestration NOT found in departments result!`);
    }
    
    return result;
  });

  ipcMain.handle('get-agent-details', async (_ev, agentId: string) => {
    const agent = agentManager.listAgents().find(a => a.name === agentId || a.id === agentId);
    if (!agent) return null;
    return {
      id: agent.id, name: agent.name, role: agent.template.role,
      model: `${agent.model.providerId}/${agent.model.model}`,
      systemPrompt: agent.template.systemPrompt,
      tools: agent.template.toolPermissions,
    };
  });

  ipcMain.handle('get-agent-prompt', async (_ev, arg: any) => {
    let agentName: string, section: string | undefined;
    if (typeof arg === 'object' && arg !== null) {
      agentName = arg.agent || arg.name || arg;
      section = arg.section;
    } else {
      agentName = arg;
    }
    const agent = AGENT_REGISTRY.find(a => a.name === agentName || a.id === agentName);
    if (!agent) return section ? '' : null;
    const fullData: any = {
      id: agent.id,
      name: agent.name,
      role: agent.specialty,
      systemPrompt: agent.systemPrompt,
      soul: '# ' + agent.emoji + ' ' + agent.name + '\n\nDepartment: ' + agent.department + '\n\n' + agent.specialty,
      identity: agent.systemPrompt,
      tools: 'All tools available for ' + agent.department + ' department.',
      claude: 'Model-specific instructions for ' + agent.name,
      model: 'deepseek/deepseek-chat',
      department: agent.department,
      emoji: agent.emoji,
    };
    // If a section is requested, return just that section's content string
    if (section) {
      const sectionMap: Record<string, string> = { system: 'systemPrompt', soul: 'soul', identity: 'identity', tools: 'tools', claude: 'claude' };
      const key = sectionMap[section] || section;
      return fullData[key] || '';
    }
    return fullData;
  });

  ipcMain.on('update-agent-prompt', (_event, arg: any) => {
    try {
      let id, field, value;
      if (typeof arg === 'object' && arg !== null) {
        id = arg.agent || arg.id;
        field = arg.section || arg.field;
        value = arg.content || arg.value;
      } else {
        const parsed = JSON.parse(arg);
        id = parsed.id;
        field = parsed.field;
        value = parsed.value;
      }
      const agent = agentManager.listAgents().find(a => a.id === id);
      if (!agent) return;
      if (field === 'systemPrompt') {
        (agent.template as any).systemPrompt = value;
      } else if (field === 'soul') {
        (agent.identity as any).soul = value;
      } else if (field === 'identity') {
        (agent.identity as any).identity = value;
      } else if (field === 'tools') {
        (agent.identity as any).tools = value;
      } else if (field === 'claude') {
        (agent.identity as any).claude = value;
      }
      console.log('[IPC] Agent prompt updated:', agent.name, field);
    } catch (e) { console.error('[IPC] update-agent-prompt error:', e); }
  });

  // ── Theme ──

  ipcMain.handle('get-theme', async () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  // ── Config ──

  ipcMain.handle('get-config', async () => {
    return { version: '0.1.0', agents: agentManager.listAgents().length };
  });

  // ── Commands ──

  ipcMain.handle('get-commands', async () => {
    return commandSystem.list().map(c => ({
      name: c.name, description: c.description, usage: c.usage,
    }));
  });

  ipcMain.handle('autocomplete-command', async (_ev, partial: string) => {
    return commandSystem.autocomplete(partial);
  });

  // ── Chat message ──

  ipcMain.on('chat-message', async (_event, arg: any) => {
    try {
    // Accept both plain string and {projectId, message} object from renderer
    const message = typeof arg === 'object' && arg !== null ? arg.message : arg;
    if (typeof arg === 'object' && arg !== null && arg.projectId && !activeSessionId) {
      activeSessionId = arg.projectId;
    }
    // `steer: true` is set by the renderer when the user redirected
    // mid-flight via the Steer toggle. The user has already proven they
    // want speed (they aborted in-progress work to redirect), so we
    // bypass the grill-me pre-flight interview even if the new message
    // classifies as a build_task. See: src/pipeline/grill-me-session.ts
    const isSteerRedirect = !!(typeof arg === 'object' && arg !== null && arg.steer);
    // `spec: true` is set by the renderer when the user sends in the new
    // "Spec" mode. The grill-me pre-flight interview is now gated behind this
    // flag: a fresh interview is ONLY kicked off in spec mode. Plain `send`
    // mode goes straight to the orchestrator (pre-grill-me behavior).
    const isSpecMode = !!(typeof arg === 'object' && arg !== null && arg.spec);
    const trimmed = (message || '').trim();
    if (!trimmed) return;
    console.log('[IPC] chat-message received:', trimmed, isSteerRedirect ? '(steer redirect)' : '', isSpecMode ? '(spec mode)' : '');

    // ── No project selected: respond with NeuroNest info or instruct to select a project ──
    if (!activeSessionId) {
      const lowerMsg = trimmed.toLowerCase();

      // Self-knowledge lookup from neuronest-knowledge.json (same source as the active-project intercept)
      // Note: self_knowledge detection is NOT replaced by IntentGate — it operates on
      // a different taxonomy. The IntentGate handles routing (conversation/quick_action/build/ambiguous)
      // while self-knowledge is a pre-routing intercept for "what is NeuroNest?" queries.
      const { classifyIntent: classifyIntentNoProject } = require('../pipeline/intent-classifier');
      const noProjectIntent = classifyIntentNoProject(trimmed);

      if (noProjectIntent.intent === 'self_knowledge') {
        const knowledgeBase = require('../data/neuronest-knowledge.json');

        // Find best matching entry using keyword matching
        let bestMatch: any = null;
        let bestScore = 0;
        for (const entry of knowledgeBase.entries) {
          const matchCount = entry.keywords.filter((kw: string) => lowerMsg.includes(kw)).length;
          if (matchCount > bestScore) {
            bestScore = matchCount;
            bestMatch = entry;
          }
        }

        if (bestMatch && bestScore > 0) {
          sendAndStore(mainWindow, { role: 'assistant', content: bestMatch.answer + '\n\n---\n🔗 Learn more at [neuronest.cc](https://neuronest.cc)', agent: 'NeuroNest' });
        } else {
          sendAndStore(mainWindow, { role: 'assistant', content: '🧠 **NeuroNest** is an agent-first IDE by NETGV AI. For more detailed information, visit [neuronest.cc](https://neuronest.cc).', agent: 'NeuroNest' });
        }
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }

      // No self-knowledge match and no project selected — instruct user to select a project
      sendAndStore(mainWindow, {
        role: 'assistant',
        content: '👋 **Welcome to NeuroNest!**\n\n' +
          'To start working with AI agents, please:\n\n' +
          '1. **Select an existing project** from the project tree in the left sidebar, or\n' +
          '2. **Create a new project** by clicking the **"+ New"** button\n\n' +
          'Once a project is selected, you can chat with AI agents, run swarm tasks, use slash commands (`/help`), and more.\n\n' +
          '💡 *You can ask me about NeuroNest — features, pricing, security, agents, providers, or capabilities — anytime without a project!*',
        agent: 'NeuroNest',
      });
      mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
      return;
    }

    autoCreateProject(mainWindow, trimmed);

    // ── Firewall: scan user input (skip system-generated fix prompts) ──
    const isFixPrompt = trimmed.startsWith('SECURITY FIX REQUEST:');
    if (!isFixPrompt) {
      const fwResult = await evaluateFirewall(trimmed, { agentId: 'user', projectId: activeSessionId || undefined });
      if (fwResult.blocked) {
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: '\ud83d\udee1\ufe0f **Firewall Blocked** — Your message was blocked by the security policy.\n\n' +
            fwResult.events.filter(e => e.blocked).map(e => '\u274c ' + e.ruleName + ': ' + (e.match || '').slice(0, 50)).join('\n'),
          isCommand: true, agent: 'Firewall',
        });
        // Send completion signal so the brain stops spinning
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        mainWindow.webContents.send('firewall-event', { type: 'block', events: fwResult.events });
        return;
      }
      if (fwResult.events.length > 0) {
        mainWindow.webContents.send('firewall-event', { type: 'scan', events: fwResult.events });
      }
    }

    storeMessage('user', trimmed);

        // Slash command
    if (trimmed.startsWith('/')) {
      let result;
      try {
        result = await commandSystem.execute(trimmed, {
          sessionId: activeSessionId || 'default',
          agentId: activeAgentName || undefined,
        });
      } catch (e) {
        console.error('[IPC] command execute error:', e);
        result = { success: false, output: '', error: String(e) };
      }

      if (trimmed === '/abort') {
        console.log('[IPC] Abort command received — terminating pipeline');
        if (activeSwarmCoordinator) {
          activeSwarmCoordinator.abort();
          activeSwarmCoordinator = null;
        }
        sendAndStore(mainWindow, {
          role: 'assistant', content: '\u26d4 Pipeline aborted. All agent processes terminated.', isCommand: true, agent: 'System',
        });
        // Send completion signal to deactivate brain
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }

      if (trimmed === '/help' || trimmed.startsWith('/help')) {
        // Build help output
        const cmds = commandSystem.list();
        const helpText = cmds.map(c => `/${c.name} — ${c.description}`).join('\n');
        sendAndStore(mainWindow, {
          role: 'assistant', content: `Available commands:\n\n${helpText}`,
          isCommand: true,
        });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }





      if (trimmed.startsWith('/theme ')) {
        const theme = trimmed.slice(7).trim();
        if (theme === 'light' || theme === 'dark') {
          mainWindow.webContents.send('theme-changed', theme);
          sendAndStore(mainWindow, {
            role: 'assistant', content: `Theme switched to ${theme} mode.`,
            isCommand: true,
          });
        } else {
          sendAndStore(mainWindow, {
            role: 'assistant', content: `Unknown theme: "${theme}". Use /theme light or /theme dark.`,
            isCommand: true,
          });
        }
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }

      // Handle special command outputs
      if (result.success && result.output.startsWith('__CLEAR__')) {
        mainWindow.webContents.send('clear-chat', {});
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }
      if (result.success && result.output.startsWith('__SWARM__')) {
        // Redirect to the full pipeline with the swarm task
        const swarmTask = result.output.slice(9);
        // Fall through to the pipeline below by not returning
        // We'll set trimmed to the swarm task
        (trimmed as any) = swarmTask;
      } else if (result.success && result.output.startsWith('__OPTIMIZE__')) {
        const optPrompt = result.output.slice(12);
        sendAndStore(mainWindow, { role: 'assistant', content: '\u{1F52E} Running ZERA Optimizer...', isCommand: true, agent: 'ZERA' });
        const zeraOnly = await zeraOptimizer.optimize(optPrompt, (step: any, index: number) => {
          sendAndStore(mainWindow, { role: 'assistant', content: '\u2705 **' + step.principle + '** \u2014 Score: ' + step.score + '/100\n\n' + step.suggestion, isCommand: true, agent: 'ZERA' });
        });
        const displayPromptOnly = zeraOnly.optimizedPrompt.split('---')[0].split('Existing project code')[0].trim();
        sendAndStore(mainWindow, { role: 'assistant', content: '\u{1F4CB} **Optimized Prompt:**\n\n> ' + displayPromptOnly.replace(/\n/g, '\n> '), isCommand: true, agent: 'ZERA' });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      } else if (result.success && result.output.startsWith('__PLAN__')) {
        const planTask = result.output.slice(8);
        const planOnly = orchestratorPlanner.createPlan(planTask);
        const planAgents = planOnly.agents.map((a: any) => { const def = AGENT_REGISTRY.find((r: any) => r.id === a.id); return (def ? def.emoji + ' ' + def.name : a.id) + ': ' + a.task.slice(0, 100); }).join('\n');
        sendAndStore(mainWindow, { role: 'assistant', content: '\u{1F3AD} **Execution Plan**\n\nStrategy: ' + planOnly.plan + '\nTopology: ' + planOnly.topology + '\n\nAgents:\n' + planAgents, isCommand: true, agent: 'Orchestrator' });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      } else if (result.success && result.output.startsWith('__MODEL_STATUS__')) {
        const override = smartRouterRef ? smartRouterRef.getOverride() : null;
        const routerCfg = smartRouterRef ? smartRouterRef.getConfig() : { enableFailover: false, enableTaskRouting: false, longContextThreshold: 60000, routes: {} };
        let statusMsg = '🔀 **Model Router Status**\n\n';
        statusMsg += '**Active model:** ' + (override ? override.provider + '/' + override.model + ' (manual override)' : (getCachedConfig('default-provider') || 'default') + '/' + (getCachedConfig('default-model') || 'default') + ' (auto)') + '\n';
        statusMsg += '**Failover:** ' + (routerCfg.enableFailover ? '✅ Enabled' : '❌ Disabled') + '\n';
        statusMsg += '**Task routing:** ' + (routerCfg.enableTaskRouting ? '✅ Enabled' : '❌ Disabled') + '\n';
        statusMsg += '**Long context threshold:** ' + routerCfg.longContextThreshold + ' tokens\n';
        if (routerCfg.routes.background) statusMsg += '**Background model:** ' + routerCfg.routes.background + '\n';
        if (routerCfg.routes.reasoning) statusMsg += '**Reasoning model:** ' + routerCfg.routes.reasoning + '\n';
        if (routerCfg.routes.longContext) statusMsg += '**Long context model:** ' + routerCfg.routes.longContext + '\n';
        sendAndStore(mainWindow, { role: 'assistant', content: statusMsg, isCommand: true, agent: 'Router' });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      } else if (result.success && result.output.startsWith('__MODEL_SWITCH__')) {
        const modelStr = result.output.slice(16);
        const [switchProvider, switchModel] = modelStr.split(',');
        if (smartRouterRef) smartRouterRef.setOverride(switchProvider, switchModel);
        sendAndStore(mainWindow, { role: 'assistant', content: '🔀 Model switched to **' + switchProvider + '/' + switchModel + '**. Use `/model` to check status or clear with the Router settings.', isCommand: true, agent: 'Router' });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      } else {
        // Regular command result
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: result.success ? result.output : 'Error: ' + result.error,
          isCommand: true,
        });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        return;
      }
    }

    // Check if a model provider is configured
    let hasProvider = false;
    try {
      const provJson = getCachedConfig('providers');
      if (provJson) {
        const providers = JSON.parse(provJson);
        hasProvider = Array.isArray(providers) && providers.length > 0;
      }
    } catch {}

    if (!hasProvider) {
      sendAndStore(mainWindow, {
        role: 'assistant',
        content: '\u26A0\uFE0F **No model provider configured.**\n\nNeuroNest needs at least one AI model to process tasks. Please go to **Settings** and add a provider.\n\nClick the \u2699\uFE0F Settings button in the sidebar to get started.',
        isCommand: true,
        agent: 'System',
        noProvider: true,
      });
      return;
    }

    // ── Self-Knowledge Intercept — works regardless of activeSessionId ──
    // Note: self_knowledge detection is NOT replaced by IntentGate — it operates on
    // a different taxonomy. The IntentGate handles routing (conversation/quick_action/build/ambiguous)
    // while self-knowledge is a pre-routing intercept for "what is NeuroNest?" queries.
    const { classifyIntent } = require('../pipeline/intent-classifier');
    const selfKnowledgeResult = classifyIntent(trimmed);
    if (selfKnowledgeResult.intent === 'self_knowledge') {
      const knowledgeBase = require('../data/neuronest-knowledge.json');
      const messageLower = trimmed.toLowerCase();

      // Find best matching entry using keyword matching (same logic as qaKnowledge)
      let bestMatch: any = null;
      let bestScore = 0;
      for (const entry of knowledgeBase.entries) {
        const matchCount = entry.keywords.filter((kw: string) => messageLower.includes(kw)).length;
        if (matchCount > bestScore) {
          bestScore = matchCount;
          bestMatch = entry;
        }
      }

      if (bestMatch && bestScore > 0) {
        const response = bestMatch.answer + '\n\n---\n🔗 Learn more at [neuronest.cc](https://neuronest.cc)';
        sendAndStore(mainWindow, { role: 'assistant', content: response, agent: 'NeuroNest' });
      } else {
        sendAndStore(mainWindow, { role: 'assistant', content: '🧠 **NeuroNest** is an agent-first IDE by NETGV AI. For more detailed information, visit [neuronest.cc](https://neuronest.cc).', agent: 'NeuroNest' });
      }
      mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
      console.log('[IPC] Self-knowledge query intercepted — responded from knowledge base');
      return;
    }

    // ── Local Request Optimization: answer trivial messages without LLM ──
    // Only applies when there's no pending confirmation (confirmations go to simple responder)
    const localResp = tryLocalResponse(trimmed);
    if (localResp.handled && localResp.content) {
      // Check if the last stored message looks like it's waiting for confirmation
      let hasPendingAction = false;
      try {
        const lastMsg = db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(activeSessionId || '') as any;
        if (lastMsg && lastMsg.content && (lastMsg.content.includes('confirm') || lastMsg.content.includes('type \'confirm\'') || lastMsg.content.includes('Please type'))) {
          hasPendingAction = true;
        }
      } catch {}
      if (!hasPendingAction) {
        sendAndStore(mainWindow, { role: 'assistant', content: localResp.content, agent: localResp.agent || 'NeuroNest' });
        return;
      }
    }

    // ── Confirmation Intercept ──
    // Short confirmation messages ("yes", "confirm", "go ahead", etc.) MUST go to the
    // simple responder so conversation history is preserved. Without this, the LLM
    // classifier sees "yes go ahead" in isolation and has no idea it's confirming a
    // previous destructive action — it classifies it as "ambiguous".
    const confirmPattern = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|proceed|please do|yes go ahead|yes please|i confirm|affirmative|go for it)[\s.!]*$/i;
    if (confirmPattern.test(trimmed)) {
      console.log('[IPC] Confirmation message detected — routing directly to simple responder');
      const { SimpleResponder } = require('../pipeline/simple-responder');
      try {
        const osConf = require('node:os');
        const pathConf = require('node:path');
        const projDirConf = pathConf.join(osConf.homedir(), '.neuronest', 'projects', activeSessionId || 'default');

        // Get project context
        let confProjectContext = '';
        const fsConf = require('node:fs');
        if (fsConf.existsSync(projDirConf)) {
          const confFiles: string[] = [];
          const walkConf = (dir: string, prefix: string = '') => {
            try {
              const entries = fsConf.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const relPath = prefix ? prefix + '/' + entry.name : entry.name;
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                  walkConf(pathConf.join(dir, entry.name), relPath);
                } else if (entry.isFile()) {
                  confFiles.push(relPath);
                }
              }
            } catch {}
          };
          walkConf(projDirConf);
          confProjectContext = `Files (${confFiles.length}): ${confFiles.slice(0, 30).join(', ')}`;
        }

        // Get conversation history
        let confHistory: Array<{ role: string; content: string }> = [];
        try {
          const histRows = db.prepare(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 6'
          ).all(activeSessionId || 'default') as Array<{ role: string; content: string }>;
          confHistory = histRows.reverse();
        } catch {}

        const confResponder = await SimpleResponder.create(db, activeSessionId, confProjectContext, projDirConf, confHistory, assembleStateBlockForSession);
        const confResponse = await confResponder.respond(trimmed);

        // Resolve provider/model for display
        let confProvider = '', confModel = '';
        try {
          const cpJson = getCachedConfig('providers');
          const cdJson = getCachedConfig('default-provider');
          if (cpJson) {
            const cps = JSON.parse(cpJson);
            let cdp: any = null;
            if (cdJson) { try { const d = JSON.parse(cdJson); cdp = cps.find((p: any) => p.id === d.id || p.name === d.id || p.type === d.id); if (cdp && d.model) cdp = { ...cdp, model: d.model }; } catch {} }
            if (!cdp && cps.length > 0) cdp = cps[0];
            if (cdp) { confProvider = cdp.type || ''; confModel = (cdp.model || '').split(',')[0].trim(); }
          }
        } catch {}

        sendAndStore(mainWindow, {
          role: 'assistant',
          content: confResponse.content,
          agent: confResponse.agent,
          isCommand: confResponse.isCommand,
          provider: confProvider,
          model: confModel,
        });

        if (confResponse.filesChanged && activeSessionId) {
          notifyProjectFilesUpdated(activeSessionId);
        }

        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        console.log('[IPC] Confirmation handled by simple responder, filesChanged:', confResponse.filesChanged);
        return;
      } catch (confErr: any) {
        console.warn('[IPC] Confirmation responder error, falling through:', confErr?.message);
        // Fall through to normal classification
      }
    }

    // ── Grill-Me Interview (build-task pre-flight) ──
    // When the user starts a build, we run a relentless interview to clarify
    // scope/decisions BEFORE handing off to the orchestrator. While a session
    // is active, every user message routes through `continueGrillSession`
    // until the model emits action="done" (synthesize spec → orchestrator) or
    // action="abort" (cancel the interview, fall through to normal routing).
    const {
      getGrillSession,
      startGrillSession,
      continueGrillSession,
      abortGrillSession,
    } = require('../pipeline/grill-me-session');

    let grilledSpec: string | null = null;
    if (activeSessionId && isSteerRedirect) {
      // Steer overrides any stale grill state — clear so the redirect
      // doesn't get caught in a half-finished interview.
      const { abortGrillSession: dropStaleGrill } = require('../pipeline/grill-me-session');
      dropStaleGrill(activeSessionId);
    }
    if (activeSessionId && !isSteerRedirect) {
      const grillLLM = resolveActiveLLMClient();
      const existing = getGrillSession(activeSessionId);

      if (existing) {
        // Active session: route the user's reply through it.
        if (!grillLLM) {
          // No LLM available — abort the interview gracefully and fall back.
          abortGrillSession(activeSessionId);
          sendAndStore(mainWindow, {
            role: 'assistant',
            content: '⚠️ Lost LLM connection mid-interview. Routing your last message normally.',
            agent: 'NeuroNest Architect',
            isCommand: true,
          });
        } else {
          try {
            const step = await continueGrillSession(activeSessionId, trimmed, grillLLM);
            if ('question' in step) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '**' + step.question + '**\n\n_Recommendation:_ ' + step.recommendation + '\n\n_(Reply with your answer, or say "looks good" / "build it" when ready.)_',
                agent: 'NeuroNest Architect',
                isCommand: true,
              });
              mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest Architect' });
              console.log('[IPC] Grill-me follow-up question dispatched');
              return;
            }
            if ('aborted' in step) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '✋ Interview cancelled — ' + step.reason + '. Send a new build request when you\'re ready.',
                agent: 'NeuroNest Architect',
                isCommand: true,
              });
              mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest Architect' });
              console.log('[IPC] Grill-me interview aborted:', step.reason);
              return;
            }
            if ('done' in step) {
              grilledSpec = step.spec;
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '✅ Interview complete. Routing the build to the orchestrator now.\n\n---\n\n' + step.spec,
                agent: 'NeuroNest Architect',
                isCommand: true,
              });
              console.log('[IPC] Grill-me interview complete, spec length:', step.spec.length);
              // Fall through to classification with the spec as the message.
            }
            if ('error' in step) {
              abortGrillSession(activeSessionId);
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '⚠️ Interview error (' + step.error + '). Falling back to direct routing.',
                agent: 'NeuroNest Architect',
                isCommand: true,
              });
            }
          } catch (grillErr: any) {
            abortGrillSession(activeSessionId);
            console.warn('[IPC] Grill-me runtime error, aborting and falling through:', grillErr?.message);
          }
        }
      }
    }

    // If grill produced a spec, treat it as the new effective message so the
    // downstream classifier + orchestrator pipeline run against it.
    const effectiveMessage = grilledSpec ?? trimmed;

    // ── Intent Classification and Message Routing ──
    const { routeMessageWithLLM, routeMessage, routeMessageUnified } = require('../pipeline/message-router');
    const { SimpleResponder } = require('../pipeline/simple-responder');
    
    // Use LLM-based classification when a provider is available (more accurate),
    // fall back to pattern-based when no LLM is configured.
    // When the `unified_intent_gate` feature flag is enabled, the IntentGate
    // cascade replaces both legacy classifiers (Requirements: 1.3, 1.4, 1.5, 1.6).
    const classifierLLM = resolveActiveLLMClient();
    let routingDecision;

    // Attempt unified IntentGate routing (feature-gated)
    let intentGateInstance: any = null;
    let featureGateInstance: any = null;
    try {
      const { getIntentGateInstance, getFeatureGateInstance } = require('../pipeline/intent-gate-registry');
      intentGateInstance = getIntentGateInstance();
      featureGateInstance = getFeatureGateInstance();
    } catch {
      // Intent gate registry not available — fall through to legacy
    }

    if (intentGateInstance && featureGateInstance) {
      routingDecision = await routeMessageUnified(effectiveMessage, classifierLLM, {
        intentGate: intentGateInstance,
        featureGate: featureGateInstance,
        sessionContext: {
          recentTurns: [],
          activeInterview: false,
          activeOrchestration: false,
          lastAssistantSubject: null,
        },
      });
    } else if (classifierLLM) {
      console.log('[IPC] Using LLM-based intent classification...');
      routingDecision = await routeMessageWithLLM(effectiveMessage, classifierLLM);
    } else {
      console.log('[IPC] No LLM available for classification, using pattern-based fallback');
      routingDecision = routeMessage(effectiveMessage);
    }
    console.log('[IPC] Message intent classified:', routingDecision.intent.type, 'confidence:', routingDecision.intent.confidence, 'route:', routingDecision.route, 'reasoning:', routingDecision.intent.reasoning);

    // ── Grill-Me kickoff: if classification says this is a fresh build_task
    // and we don't already have a synthesized spec from a finished interview,
    // start the interview now and short-circuit. The user's next reply will
    // resume in the active-session branch above.
    //
    // Gated behind `isSpecMode`: the interview ONLY kicks off when the user
    // sent in "Spec" mode. Plain `send` mode skips the interview entirely and
    // routes straight to the orchestrator — the pre-grill-me behavior.
    if (
      isSpecMode &&
      !grilledSpec &&
      activeSessionId &&
      !isSteerRedirect &&
      (routingDecision.route === 'orchestrator_pipeline') &&
      (routingDecision.intent.type === 'build_task' || routingDecision.intent.type === 'complex_orchestration')
    ) {
      const grillLLM = resolveActiveLLMClient();
      if (grillLLM) {
        try {
          const opener = await startGrillSession(activeSessionId, trimmed, grillLLM);
          if ('question' in opener) {
            sendAndStore(mainWindow, {
              role: 'assistant',
              content: '🎯 Before I hand this off to the orchestrator, let me grill you on a few details so we get this right.\n\n**' + opener.question + '**\n\n_Recommendation:_ ' + opener.recommendation + '\n\n_(Reply with your answer, or say "looks good" / "build it" when ready to skip to the build.)_',
              agent: 'NeuroNest Architect',
              isCommand: true,
            });
            mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest Architect' });
            console.log('[IPC] Grill-me interview started for build_task');
            return;
          }
          if ('error' in opener) {
            console.warn('[IPC] Could not start grill-me interview:', opener.error, '— falling through to orchestrator');
          }
        } catch (startErr: any) {
          console.warn('[IPC] Grill-me startup error, falling through:', startErr?.message);
        }
      }
    }
    
    // Route conversational messages to simple responder
    if (routingDecision.route === 'simple_responder') {
      try {
        // Gather project context for the simple responder so it can answer
        // questions like "tell me about this project" with actual project info
        let projectContext = '';
        try {
          const osCtx = require('node:os');
          const fsCtx = require('node:fs');
          const pathCtx = require('node:path');
          const projDir = pathCtx.join(osCtx.homedir(), '.neuronest', 'projects', activeSessionId || 'default');
          if (fsCtx.existsSync(projDir)) {
            const filePaths: string[] = [];
            const walkCtx = (dir: string, prefix: string = '') => {
              try {
                const entries = fsCtx.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  const relPath = prefix ? prefix + '/' + entry.name : entry.name;
                  if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build') {
                    walkCtx(pathCtx.join(dir, entry.name), relPath);
                  } else if (entry.isFile()) {
                    filePaths.push(relPath);
                  }
                }
              } catch {}
            };
            walkCtx(projDir);

            // Build a concise project summary
            const parts: string[] = [];
            parts.push(`Project directory: ${projDir}`);
            parts.push(`Files (${filePaths.length}): ${filePaths.slice(0, 50).join(', ')}${filePaths.length > 50 ? ` ... and ${filePaths.length - 50} more` : ''}`);

            // Read package.json if it exists for project metadata
            const pkgPath = pathCtx.join(projDir, 'package.json');
            if (fsCtx.existsSync(pkgPath)) {
              try {
                const pkg = JSON.parse(fsCtx.readFileSync(pkgPath, 'utf-8'));
                if (pkg.name) parts.push(`Package name: ${pkg.name}`);
                if (pkg.description) parts.push(`Description: ${pkg.description}`);
                if (pkg.dependencies) parts.push(`Dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
              } catch {}
            }

            // Read README.md if it exists
            const readmePath = pathCtx.join(projDir, 'README.md');
            if (fsCtx.existsSync(readmePath)) {
              try {
                const readme = fsCtx.readFileSync(readmePath, 'utf-8');
                parts.push(`README.md (first 500 chars): ${readme.slice(0, 500)}`);
              } catch {}
            }

            // Read NEURONEST.md if it exists
            const neuronestPath = pathCtx.join(projDir, 'NEURONEST.md');
            if (fsCtx.existsSync(neuronestPath)) {
              try {
                const ctx = fsCtx.readFileSync(neuronestPath, 'utf-8');
                parts.push(`NEURONEST.md context: ${ctx.slice(0, 800)}`);
              } catch {}
            }

            projectContext = parts.join('\n');
          }
        } catch (ctxErr) {
          console.warn('[IPC] Failed to gather project context for simple responder:', ctxErr);
        }

        // Resolve project directory and conversation history for the simple responder
        const osSimple = require('node:os');
        const pathSimple = require('node:path');
        const projDirSimple = pathSimple.join(osSimple.homedir(), '.neuronest', 'projects', activeSessionId || 'default');

        // Get recent conversation history from stored messages for context continuity
        let recentHistory: Array<{ role: string; content: string }> = [];
        try {
          const historyRows = db.prepare(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 6'
          ).all(activeSessionId || 'default') as Array<{ role: string; content: string }>;
          recentHistory = historyRows.reverse(); // Oldest first
        } catch {}

        const simpleResponder = await SimpleResponder.create(db, activeSessionId, projectContext, projDirSimple, recentHistory, assembleStateBlockForSession);

        // Inject active schema instruction into the message if one is active
        let simpleMsg = trimmed;
        if (activeSessionId) {
          try {
            const activeSchema = schemaService.getActive(activeSessionId);
            if (activeSchema) {
              simpleMsg = trimmed + '\n\n[SYSTEM: You MUST respond with valid JSON conforming to this schema. No markdown, no code blocks, only raw JSON.]\nSchema: ' + JSON.stringify(activeSchema.schema);
            }
          } catch {}
        }

        const response = await simpleResponder.respond(simpleMsg);
        
        // Resolve provider/model for display
        let srProvider = '';
        let srModel = '';
        try {
          const srProvJson = getCachedConfig('providers');
          const srDefJson = getCachedConfig('default-provider');
          if (srProvJson) {
            const srProviders = JSON.parse(srProvJson);
            let srDefaultProv: any = null;
            if (srDefJson) {
              try {
                const dp = JSON.parse(srDefJson);
                srDefaultProv = srProviders.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
                if (srDefaultProv && dp.model) srDefaultProv = { ...srDefaultProv, model: dp.model };
              } catch {}
            }
            if (!srDefaultProv && srProviders.length > 0) srDefaultProv = srProviders[0];
            if (srDefaultProv) {
              srProvider = srDefaultProv.type || '';
              srModel = (srDefaultProv.model || '').split(',')[0].trim();
            }
          }
        } catch {}

        sendAndStore(mainWindow, {
          role: 'assistant',
          content: response.content,
          agent: response.agent,
          isCommand: response.isCommand,
          streamAnimate: !response.isCommand,
          provider: srProvider,
          model: srModel,
        });

        // ── Response Schema Validation (simple responder path) ──
        if (activeSessionId && response.content && !response.isCommand) {
          try {
            const schemaResult = schemaService.validateForSession(activeSessionId, response.content);
            if (schemaResult && !schemaResult.valid) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '⚠️ **Schema Validation Failed** — Response does not match the active schema "' + schemaResult.schemaName + '".\n\n**Errors:** ' + schemaResult.errors.join(', ') + '\n\n*Tip: Ask the AI to "respond as JSON matching the active schema" for structured output.*',
                isCommand: true,
                agent: 'Schema Validator',
              });
            }
          } catch (schemaErr: any) {
            console.warn('[Schema] Simple responder validation error:', schemaErr?.message);
          }
        }

        // If file operations were performed, refresh the file tree in the renderer
        if (response.filesChanged && activeSessionId) {
          notifyProjectFilesUpdated(activeSessionId);
        }

        // Record cost for simple responder (uses the default provider)
        try {
          if (costStore && pricingTable && activeSessionId) {
            const srProvJson = getCachedConfig('providers');
            const srDefJson = getCachedConfig('default-provider');
            if (srProvJson) {
              const srProviders = JSON.parse(srProvJson);
              let srDefaultProv: any = null;
              if (srDefJson) {
                try {
                  const dp = JSON.parse(srDefJson);
                  srDefaultProv = srProviders.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
                  if (srDefaultProv && dp.model) srDefaultProv = { ...srDefaultProv, model: dp.model };
                } catch {}
              }
              if (!srDefaultProv && srProviders.length > 0) srDefaultProv = srProviders[0];
              if (srDefaultProv) {
                srProvider = srDefaultProv.type || '';
                srModel = (srDefaultProv.model || '').split(',')[0].trim();
              }
            }
            if (srProvider) {
              const srPromptTokens = Math.max(1, Math.ceil(trimmed.length / 4));
              const srCompletionTokens = Math.max(1, Math.ceil((response.content || '').length / 4));
              const srCostResult = calculateCost(srProvider, srModel, srPromptTokens, srCompletionTokens, pricingTable);
              costStore.record({
                projectId: activeSessionId,
                provider: srProvider,
                model: srModel,
                promptTokens: srPromptTokens,
                completionTokens: srCompletionTokens,
                cost: srCostResult.cost,
              });
            }
            const projectCost = costStore ? costStore.getProjectCost(activeSessionId) : 0;
            mainWindow.webContents.send('update-stats', { tokens: tokenCount, cost: projectCost });
          }
        } catch (srCostErr) { console.error('[IPC] Simple responder cost error:', srCostErr); }

        // Cache the prompt and response for future reference
        try {
          if (promptCacheRef && activeSessionId) {
            const crypto = require('node:crypto');
            const promptHash = crypto.createHash('sha256').update(activeSessionId + ':' + trimmed).digest('hex');
            const srProvJson2 = getCachedConfig('providers');
            let cacheProvider = 'default', cacheModel = 'default';
            if (srProvJson2) {
              try {
                const ps = JSON.parse(srProvJson2);
                if (ps[0]) { cacheProvider = ps[0].type || 'default'; cacheModel = (ps[0].model || 'default').split(',')[0].trim(); }
              } catch {}
            }
            promptCacheRef.store(promptHash, cacheProvider, cacheModel, Math.ceil(trimmed.length / 4), response.content || '');
          }
        } catch (cacheErr) { /* non-fatal */ }
        
        // Send completion signal
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        console.log('[IPC] Conversational message handled by simple responder');
        return;
      } catch (simpleErr: any) {
        console.warn('[IPC] Simple responder error, falling back to fallback response:', simpleErr?.message);
        // Do NOT fall through to the orchestrator pipeline for conversational messages.
        // The classifier determined this is NOT a build task — falling through would
        // cause the system to hallucinate and start building when the user just asked a question.
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: "I'm here to help! I can build apps, write code, explain concepts, and more. What would you like me to do?",
          agent: 'NeuroNest',
          isCommand: false,
          streamAnimate: true,
        });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        console.log('[IPC] Conversational message handled by fallback (simple responder failed)');
        return;
      }
    }

    // Route ambiguous messages to clarification prompt
    // BUT: if the user's message looks like a confirmation/continuation of a previous
    // task (e.g., "start building", "yes", "do it", "focus on everything"), skip
    // clarification and route to the pipeline instead.
    if (routingDecision.route === 'clarification') {
      const confirmationPattern = /^(start\s*building|start|yes|yeah|yep|sure|ok|okay|do it|go ahead|proceed|just do it|focus on everything|focus on all|check everything|scan everything|begin|continue|let'?s go)[\s!.]*$/i;
      if (confirmationPattern.test(trimmed)) {
        console.log('[IPC] Ambiguous message matches confirmation pattern, routing to pipeline instead of clarification');
        // Fall through to the pipeline below
      } else {
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: 'Would you like me to explain what I can do, or should I start building?',
          agent: 'NeuroNest',
          isCommand: true,
        });
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
        console.log('[IPC] Ambiguous message routed to clarification prompt (confidence:', routingDecision.intent.confidence + ')');
        return;
      }
    }

// ── Skill routing pre-step: try matching a skill before the full pipeline ──
    let skillRouteOutput: string | null = null;
    try {
      const osSkill = require('node:os');
      const pathSkill = require('node:path');
      const skillProjectDir = pathSkill.join(osSkill.homedir(), '.neuronest', 'projects', activeSessionId || 'default');
      const skillResult = await trySkillRoute(db, trimmed, activeSessionId || 'default', skillProjectDir);

      if (skillResult.matched && skillResult.result && skillResult.skill) {
        // Scan skill output through existing FirewallEngine
        let skillOutput = skillResult.result.output || '';
        if (firewallEngine && skillOutput) {
          const fwSkill = firewallEngine.evaluate(skillOutput, { agentId: 'skill:' + skillResult.skill.id, projectId: activeSessionId || undefined });
          if (fwSkill.events.length > 0) {
            mainWindow.webContents.send('firewall-event', { type: 'scan', source: 'skill-output', skillId: skillResult.skill.id, events: fwSkill.events });
          }
          skillOutput = fwSkill.sanitized;
        }

        // Send skill result to renderer
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: skillOutput,
          agent: `Skill: ${skillResult.skill.name}`,
        });

        skillRouteOutput = skillOutput;
        console.log('[IPC] Skill matched:', skillResult.skill.name, 'score:', skillResult.route.score);
      }
    } catch (skillErr: any) {
      console.warn('[IPC] Skill routing error (continuing to pipeline):', skillErr?.message);
    }

    // Check if we should skip the full pipeline for conversational messages
    if (routingDecision.route === 'simple_responder' && skillRouteOutput) {
      // Skill provided output for a conversational message - send completion signal and return
      mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
      console.log('[IPC] Conversational message handled by skill, skipping pipeline');
      return;
    }

    // Skip full pipeline for conversational messages that didn't match skills
    if (routingDecision.route === 'simple_responder' && !skillRouteOutput) {
      // This case should have been handled above, but adding as safety net
      console.log('[IPC] Conversational message without skill match, already handled by simple responder');
      return;
    }

    // ── Orchestrator Pipeline: for build_task intent, use the full ZERA → Orchestrator → Swarm flow ──
    // The legacy orchestrator pipeline below handles this route with proper task decomposition
    // and multi-agent swarm execution.

// Full NeuroNest pipeline: ZERA optimize → Orchestrate → Swarm execute
    tokenCount += trimmed.length;
    mainWindow.webContents.send('update-stats', { tokens: tokenCount });

    // ── Pipeline Trace: start recording ──
    const traceService = (global as any).__pipelineTraceService;
    let traceId = '';
    const pipelineStartTime = Date.now();
    if (traceService && activeSessionId) {
      try { traceId = traceService.startTrace(activeSessionId, trimmed); }
      catch { traceId = ''; }
    }

    // ── Load Autonomy Config for this project ──
    let autonomyConfig: any = null;
    if (activeSessionId && autonomyManagerRef) {
      try { autonomyConfig = autonomyManagerRef.get(activeSessionId); }
      catch { autonomyConfig = null; }
    }

    // Load project context and shared memory
    const { SharedMemory } = require('../pipeline/shared-memory');
    const sharedMemory = new SharedMemory(db, activeSessionId);

    // Store user message in shared memory
    sharedMemory.store({ agentId: 'user', type: 'message', content: trimmed });

    // Load existing project files as context
    let projectContext = '';
    // Autonomy: only load project context if autoLoadContext is enabled (or if no autonomy config exists, default to loading)
    const shouldLoadContext = !autonomyConfig || autonomyConfig.autoLoadContext;
    if (shouldLoadContext) {
    try {
      const osM = require('node:os');
      const fsM = require('node:fs');
      const pathM = require('node:path');
      const projectDir = pathM.join(osM.homedir(), '.neuronest', 'projects', activeSessionId);
      if (fsM.existsSync(projectDir)) {
        const files: string[] = [];
        const fileManifest: Array<{ path: string; lines: number; chars: number; truncated: boolean }> = [];
        const walkDir = (dir: string, prefix: string = '') => {
          const entries = fsM.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const relPath = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'docs') {
              walkDir(pathM.join(dir, entry.name), relPath);
            } else if (entry.isFile() && !entry.name.endsWith('-output.md')) {
              try {
                const content = fsM.readFileSync(pathM.join(dir, entry.name), 'utf-8');
                const lineCount = content.split('\n').length;
                if (content.length < 5000) { // Only include small files
                  files.push('--- ' + relPath + ' ---\n' + content);
                  fileManifest.push({ path: relPath, lines: lineCount, chars: content.length, truncated: false });
                } else {
                  files.push('--- ' + relPath + ' --- (' + content.length + ' chars, truncated)\n' + content.slice(0, 1000) + '\n...');
                  fileManifest.push({ path: relPath, lines: lineCount, chars: content.length, truncated: true });
                }
              } catch {}
            }
          }
        };
        walkDir(projectDir);

        // Load NEURONEST.md project context file if it exists (priority context for agents)
        let neuronestContext = '';
        const neuronestMdPaths = [
          pathM.join(projectDir, 'NEURONEST.md'),
          pathM.join(projectDir, '.neuronest', 'context.md'),
        ];
        for (const nmp of neuronestMdPaths) {
          try {
            if (fsM.existsSync(nmp)) {
              neuronestContext = fsM.readFileSync(nmp, 'utf-8');
              sendAndStore(mainWindow, { role: 'assistant', content: '📋 Loaded project context from `' + pathM.basename(nmp) + '`', isCommand: true, agent: 'System' });
              break;
            }
          } catch {}
        }

        // Store key facts from NEURONEST.md and steering files as primary_truth in ProjectMemoryStore
        if (neuronestContext && activeSessionId && projectMemoryRef) {
          try {
            const { MemoryTruthGate } = require('../storage/memory-truth-gate.js');
            const truthGate = new MemoryTruthGate(db);
            // Extract key facts: lines that start with headings or bullet points (non-empty meaningful lines)
            const keyFacts = neuronestContext
              .split('\n')
              .map((line: string) => line.trim())
              .filter((line: string) => line.length > 10 && (line.startsWith('#') || line.startsWith('-') || line.startsWith('*') || /^[A-Z]/.test(line)))
              .slice(0, 20); // Limit to 20 key facts to avoid flooding memory

            for (const fact of keyFacts) {
              const cleanFact = fact.replace(/^[#*\-\s]+/, '').trim();
              if (cleanFact.length > 10) {
                const mem = projectMemoryRef.learn(activeSessionId, 'convention', cleanFact, 'primary_truth');
                if (mem) {
                  truthGate.tagAsPrimaryTruth(mem.id);
                }
              }
            }
            console.log('[IPC] Stored', keyFacts.length, 'primary truth entries from NEURONEST.md');
          } catch (e: any) {
            console.warn('[IPC] Failed to store primary truths from NEURONEST.md:', e?.message);
          }
        }

        // Load steering file rules as primary_truth
        if (activeSessionId && projectMemoryRef) {
          try {
            const { ProjectSteeringStore } = require('../storage/project-steering.js');
            const { MemoryTruthGate } = require('../storage/memory-truth-gate.js');
            const steeringStore = new ProjectSteeringStore(db);
            const truthGate = new MemoryTruthGate(db);
            const rules = steeringStore.getRules(activeSessionId);
            if (rules && rules.length > 0) {
              for (const rule of rules) {
                const content = rule.title + ': ' + (rule.content || '').slice(0, 200);
                if (content.length > 10) {
                  const mem = projectMemoryRef.learn(activeSessionId, 'convention', content, 'primary_truth');
                  if (mem) {
                    truthGate.tagAsPrimaryTruth(mem.id);
                  }
                }
              }
              console.log('[IPC] Stored', rules.length, 'primary truth entries from steering files');
            }
          } catch (e: any) {
            console.warn('[IPC] Failed to store primary truths from steering files:', e?.message);
          }
        }

        if (files.length > 0) {
          projectContext = (neuronestContext ? '\n\n--- PROJECT INSTRUCTIONS (from NEURONEST.md) ---\n' + neuronestContext + '\n--- END PROJECT INSTRUCTIONS ---\n\n' : '') +
            '--- EXISTING PROJECT CODE (VERIFIED FROM DISK) ---\n' +
            'IMPORTANT: The following code was loaded directly from the user\'s project directory. ' +
            'Do NOT generate, hallucinate, or fabricate any file content. If a file the user mentions ' +
            'is NOT listed below, you MUST tell the user: "I could not find [filename] in your project. ' +
            'Please ensure the file exists in your project directory."\n\n' +
            files.join('\n\n') + '\n--- END PROJECT CODE ---\n';
          // Show detailed file manifest so user can verify what was loaded
          const manifestLines = fileManifest.map(f => '  • `' + f.path + '` — ' + f.lines + ' lines, ' + f.chars + ' chars' + (f.truncated ? ' ⚠️ truncated to first 1000 chars' : '')).join('\n');
          sendAndStore(mainWindow, { role: 'assistant', content: '📂 **Loaded ' + files.length + ' project files as context:**\n\n' + manifestLines, isCommand: true, agent: 'System' });
        } else {
          // No files found in project directory — warn the user
          sendAndStore(mainWindow, { role: 'assistant', content: '⚠️ **No project files found.** Your project directory is empty. If you expected files to be here, check that they were added to this project.\n\nThe AI will work from your prompt only — it cannot review files that aren\'t loaded.', isCommand: true, agent: 'System' });
          // Add explicit no-file instruction to prevent hallucination
          projectContext = '\n\n--- NO PROJECT FILES LOADED ---\n' +
            'CRITICAL: No source files were found in the user\'s project directory. ' +
            'Do NOT generate, hallucinate, or fabricate any file content. ' +
            'If the user asks you to review, analyze, or modify a specific file, you MUST respond: ' +
            '"I could not find any files in your project directory. Please add your files to the project first, ' +
            'or create a new project and import your code."\n' +
            'Do NOT create stub implementations and pretend they are the user\'s code.\n' +
            '--- END ---\n';
        }
      }
    } catch (e: any) { console.error('[IPC] Project context load error:', e?.message); }
    } // end shouldLoadContext

    // Autonomy: Smart Context — use keyword-based relevance filtering
    if (autonomyConfig && autonomyConfig.smartContext && projectContext) {
      try {
        // Filter project context to only include files relevant to the user's prompt
        const keywords = trimmed.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
        const contextBlocks = projectContext.split('--- ').filter((b: string) => b.trim());
        const relevantBlocks = contextBlocks.filter((block: string) => {
          const lower = block.toLowerCase();
          return keywords.some((kw: string) => lower.includes(kw));
        });
        if (relevantBlocks.length > 0 && relevantBlocks.length < contextBlocks.length) {
          projectContext = '\n\n--- EXISTING PROJECT CODE (smart-filtered) ---\n--- ' + relevantBlocks.join('\n\n--- ') + '\n--- END PROJECT CODE ---\n';
          sendAndStore(mainWindow, { role: 'assistant', content: '🧠 Smart context: filtered to ' + relevantBlocks.length + '/' + contextBlocks.length + ' relevant files', isCommand: true, agent: 'Autonomy' });
        }
      } catch { /* non-fatal */ }
    }

    // Get shared memory context from previous agent interactions
    const memoryContext = sharedMemory.getContextString(30);

    // ── File reference verification ──
    // Detect if user mentions specific files and verify they were loaded
    const fileRefPattern = /\b(?:review|analyze|check|look at|fix|refactor|read|open)\s+(?:my\s+)?(?:file\s+)?[`"']?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)[`"']?/gi;
    let fileRefMatch;
    const referencedFiles: string[] = [];
    while ((fileRefMatch = fileRefPattern.exec(trimmed)) !== null) {
      referencedFiles.push(fileRefMatch[1]);
    }
    // Also catch "app.py", "main.ts" etc. mentioned directly
    const directFilePattern = /\b([a-zA-Z0-9_-]+\.[a-zA-Z]{1,5})\b/g;
    let directMatch;
    while ((directMatch = directFilePattern.exec(trimmed)) !== null) {
      const fname = directMatch[1];
      // Filter out common non-file patterns
      if (!fname.match(/^(e\.g|i\.e|vs\.|etc\.|v\d)/i) && !referencedFiles.includes(fname)) {
        referencedFiles.push(fname);
      }
    }

    if (referencedFiles.length > 0 && projectContext) {
      const missingFiles: string[] = [];
      for (const ref of referencedFiles) {
        const refLower = ref.toLowerCase();
        // Check if this file appears in the loaded context
        if (!projectContext.toLowerCase().includes('--- ' + refLower) &&
            !projectContext.toLowerCase().includes('/' + refLower + ' ---') &&
            !projectContext.toLowerCase().includes(refLower + ' ---')) {
          missingFiles.push(ref);
        }
      }
      if (missingFiles.length > 0) {
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: '⚠️ **File not found in project:** ' + missingFiles.map(f => '`' + f + '`').join(', ') + '\n\n' +
            'These files were not found in your project directory. The AI **cannot** review files that aren\'t loaded.\n\n' +
            'To fix this:\n' +
            '• Ensure the files are in your project directory (`~/.neuronest/projects/' + activeSessionId + '/`)\n' +
            '• Or drag-and-drop the files into the NeuroNest file tree\n\n' +
            '⛔ Proceeding without these files — the AI will NOT hallucinate their content.',
          isCommand: true, agent: 'System',
        });
      }
    }

    // ── Project Memory: Retrieve learned patterns from past sessions ──
    let agentMemoryContext = '';
    const memRecallStart = Date.now();
    if (projectMemoryRef && activeSessionId) {
      try {
        const pmContext = projectMemoryRef.getContextString(activeSessionId);
        if (pmContext) {
          agentMemoryContext = '\n\n' + pmContext;
          const memCount = projectMemoryRef.getMemories(activeSessionId, 50).length;
          if (memCount > 0) {
            sendAndStore(mainWindow, { role: 'assistant', content: '🧠 Recalled ' + memCount + ' learned patterns from past sessions', isCommand: true, agent: 'Memory' });
          }
        }
      } catch (memErr: any) {
        console.warn('[IPC] Project Memory retrieval failed (non-fatal):', memErr.message);
      }
    }
    if (traceService && traceId) {
      try { traceService.recordSpan(traceId, activeSessionId, 'memory_recall', memRecallStart, Date.now(), { metadata: { hasMemories: agentMemoryContext.length > 0 } }); } catch {}
    }

    // Step 1: ZERA Prompt Optimization (with project context + recalled memories)
    // When grill-me produced a synthesized spec, that becomes the prompt the
    // optimizer / orchestrator works against — not the original one-liner.
    const enrichedPrompt = effectiveMessage + (projectContext ? '\n\nExisting project code is available. Build upon it, don\'t recreate from scratch.' : '') + agentMemoryContext + (memoryContext ? '\n\n' + memoryContext : '');

    sendAndStore(mainWindow, { role: 'assistant', content: '🔮 **ZERA Optimizer** — Refining your prompt...', isCommand: true, agent: 'ZERA' });

    // Give ZERA access to the LLM for framework-based optimization (Promptly-style)
    const zeraLLM = resolveActiveLLMClient();
    if (zeraLLM) {
      zeraOptimizer.setLLMClient(zeraLLM);
    }

    const zeraStartTime = Date.now();
    const zeraResult = await zeraOptimizer.optimize(enrichedPrompt, (step, index) => {
      sendAndStore(mainWindow, {
        role: 'assistant',
        content: `✅ **${step.principle}** — Score: ${step.score}/100\n\n${step.suggestion}`,
        isCommand: true, agent: 'ZERA',
      });
    });
    if (traceService && traceId) {
      try { traceService.recordSpan(traceId, activeSessionId, 'zera_optimization', zeraStartTime, Date.now(), { metadata: { steps: zeraResult.steps.length } }); } catch {}
    }

    // Display a formatted summary — the optimized prompt has markdown headers from the framework
    const displayPrompt = zeraResult.optimizedPrompt.split('---')[0].split('Existing project code')[0].trim();

    // Format the output with a collapsible section for readability
    const formattedOutput = '📋 **Optimized Prompt**\n\n' + displayPrompt;

    sendAndStore(mainWindow, {
      role: 'assistant',
      content: formattedOutput,
      isCommand: true, agent: 'ZERA',
    });

    // Step 2: Execution Mode Selection + Orchestrator Planning
    const orchestratorStartTime = Date.now();

    // Use ExecutionModeRouter to determine optimal execution mode for this task
    let selectedMode: 'flash' | 'standard' | 'pro' | 'ultra' = 'pro'; // default
    try {
      const { scoreAllAgents } = require('../pipeline/orchestrator-planner');
      const agentScores = scoreAllAgents(zeraResult.optimizedPrompt);
      const topScore = Math.max(...Array.from(agentScores.values()));
      const qualifiedAgentCount = Array.from(agentScores.values()).filter(s => s > 5).length;

      // Mode selection heuristic based on task complexity
      if (topScore > 40 && qualifiedAgentCount <= 2) {
        selectedMode = 'flash'; // Single highly-qualified agent — skip orchestrator overhead
      } else if (qualifiedAgentCount <= 3) {
        selectedMode = 'standard'; // Small team — sequential execution
      } else if (qualifiedAgentCount <= 6) {
        selectedMode = 'pro'; // Medium team — sequential multi-agent
      } else {
        selectedMode = 'ultra'; // Large team — parallel decomposition
      }

      // Allow user override from session preferences
      const modeOverride = getCachedConfig('execution-mode');
      if (modeOverride && ['flash', 'standard', 'pro', 'ultra'].includes(modeOverride)) {
        selectedMode = modeOverride as typeof selectedMode;
      }
    } catch {}

    sendAndStore(mainWindow, {
      role: 'assistant',
      content: `⚡ **Execution Mode:** ${selectedMode.toUpperCase()} ${selectedMode === 'flash' ? '(single agent)' : selectedMode === 'standard' ? '(focused team)' : selectedMode === 'pro' ? '(sequential multi-agent)' : '(parallel decomposition)'}`,
      isCommand: true, agent: 'Router',
    });

    const plan = orchestratorPlanner.createPlan(zeraResult.optimizedPrompt);

    // Apply mode-based agent limiting
    if (selectedMode === 'flash') {
      // Flash: only use the single highest-scored agent
      plan.agents = plan.agents.slice(0, 1);
      plan.topology = 'sequential';
    } else if (selectedMode === 'standard') {
      // Standard: limit to top 3 agents, sequential
      plan.agents = plan.agents.slice(0, 3);
      plan.topology = 'sequential';
    } else if (selectedMode === 'pro') {
      // Pro: use all planned agents, sequential (default behavior)
      // No change needed — plan.agents stays as-is
    } else if (selectedMode === 'ultra') {
      // Ultra: use all planned agents with parallel topology for max concurrency
      plan.topology = 'swarm';
    }

    // Inject design template for Design department agents
    try {
      const { injectDesignTemplate } = require('../skills/skill-integration');
      const designDepts = ['Design'];
      for (const agentTask of plan.agents) {
        const agentDef = AGENT_REGISTRY.find(r => r.id === agentTask.id);
        if (agentDef && designDepts.includes(agentDef.department)) {
          const enriched = injectDesignTemplate(db, agentTask.task, activeSessionId || '');
          if (enriched !== agentTask.task) {
            agentTask.task = enriched;
            console.log('[IPC] Injected design template for', agentTask.id);
          }
        }
      }
    } catch (e: any) { console.warn('[IPC] Design template injection skipped:', e?.message); }

    const agentNames = plan.agents.map(a => {
      const def = AGENT_REGISTRY.find(r => r.id === a.id);
      return def ? def.emoji + ' ' + def.name : a.id;
    }).join(', ');

    sendAndStore(mainWindow, {
      role: 'assistant',
      content: '🎭 **Orchestrator** — Plan: ' + plan.plan + '\n\nAgents: ' + agentNames + '\nTopology: ' + plan.topology,
      isCommand: true, agent: 'Orchestrator',
    });
    if (traceService && traceId) {
      try { traceService.recordSpan(traceId, activeSessionId, 'orchestrator_planning', orchestratorStartTime, Date.now(), { metadata: { topology: plan.topology, agentCount: plan.agents.length } }); } catch {}
    }

    // Step 3: Swarm Execution — use real LLM if configured
    const agentExecStartTime = Date.now();
    const memoryPool = new SwarmMemoryPool();
    // Inject project context and shared memory into the swarm memory pool
    if (projectContext) {
      memoryPool.set('project-context', projectContext.slice(0, 10000));
    }
    if (memoryContext) {
      memoryPool.set('shared-memory', memoryContext.slice(0, 5000));
    }
    // Inject skill routing result if a skill matched
    if (skillRouteOutput) {
      memoryPool.set('skill-result', skillRouteOutput);
    }
    let llmClient = null;
    let activeProviderType = '';
    let activeModelId = '';
    try {
      const provJson = getCachedConfig('providers');
      const defJson = getCachedConfig('default-provider');
      if (provJson) {
        const providers = JSON.parse(provJson);
        let defaultProv = null;
        if (defJson) {
          try {
            const dp = JSON.parse(defJson);
            defaultProv = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
            if (defaultProv && dp.model) defaultProv = { ...defaultProv, model: dp.model };
          } catch {}
        }
        const activeProv = defaultProv || providers[0];

        // Smart Router: check for manual override or long-context routing
        let routedProv = activeProv;
        if (smartRouterRef) {
          const estimatedTokens = Math.ceil((zeraResult.optimizedPrompt || '').length / 4);
          const override = smartRouterRef.getOverride();
          if (override) {
            // Manual override from /model command
            const overrideProv = providers.find((p: any) => p.name === override.provider || p.type === override.provider);
            if (overrideProv) {
              routedProv = { ...overrideProv, model: override.model };
              console.log('[Router] Using manual override:', override.provider + '/' + override.model);
            }
          } else {
            // Auto-routing: check token count for long-context
            const decision = smartRouterRef.route(estimatedTokens, 'default', activeProv?.type, activeProv?.model);
            if (decision.reason !== 'Default routing') {
              const routeTarget = providers.find((p: any) => p.name === decision.provider || p.type === decision.provider);
              if (routeTarget) {
                routedProv = { ...routeTarget, model: decision.model };
                console.log('[Router] Auto-routed:', decision.reason);
                sendAndStore(mainWindow, { role: 'assistant', content: '🔀 **Router:** ' + decision.reason, isCommand: true, agent: 'Router' });
              }
            }
          }
        }

        if (routedProv) {
          llmClient = createLLMClientWithProMode(routedProv);
          activeProviderType = routedProv.type || '';
          activeModelId = (routedProv.model || '').split(',')[0].trim();
          console.log('[IPC] Using LLM provider:', routedProv.name, '(' + routedProv.type + ')', 'model:', routedProv.model || '(auto)');
        }
      }
    } catch (e) { console.error('[IPC] LLM client creation error:', e); }

    const swarmCoordinator = new SwarmCoordinator(memoryPool, llmClient);
    activeSwarmCoordinator = swarmCoordinator;

    // Initialize enhanced coordinator with the same LLM client
    if (enhancedSwarmCoordinator && activeSessionId) {
      // Update the enhanced coordinator's LLM client
      (enhancedSwarmCoordinator as any).enhancedLLMClient = llmClient;
    }

    // Build per-agent LLM configs from saved agent model assignments
    // Resolution chain: active model pack → agent-specific config → default provider → first provider
    const agentLLMConfigs = new Map();
    const agentProviderMap = new Map<string, { provider: string; model: string }>();
    let agentsWithCustomModel = 0;
    let agentsUsingDefault = 0;
    try {
      const provJson2 = getCachedConfig('providers');
      const providers2 = provJson2 ? JSON.parse(provJson2) : [];
      const defJson2 = getCachedConfig('default-provider');
      let defaultProv: any = null;
      if (defJson2) {
        try {
          const dp = JSON.parse(defJson2);
          defaultProv = providers2.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
          // Merge default model into provider if stored separately
          if (defaultProv && dp.model) {
            defaultProv = { ...defaultProv, model: dp.model };
          }
        } catch {}
      }
      if (!defaultProv && providers2.length > 0) defaultProv = providers2[0];

      console.log('[IPC] Providers available:', providers2.length, providers2.map((p: any) => p.name + '(' + p.type + ')').join(', '));
      console.log('[IPC] Default provider:', defaultProv ? defaultProv.name + '/' + (defaultProv.model || '').split(',')[0] : 'NONE');

      // Load active model pack for this project
      let activeModelPackRoles: Record<string, { provider: string; model: string }> | null = null;
      if (activeSessionId) {
        let activePackId = getCachedConfig('active-model-pack:' + activeSessionId);
        if (!activePackId) {
          // Default to Balanced pack
          const balancedRow = db.prepare("SELECT id FROM model_packs WHERE name = 'Balanced'").get() as any;
          if (balancedRow) activePackId = balancedRow.id;
        }
        if (activePackId) {
          try {
            const packRow = db.prepare('SELECT roles FROM model_packs WHERE id = ?').get(activePackId) as any;
            if (packRow && packRow.roles) {
              activeModelPackRoles = JSON.parse(packRow.roles);
              console.log('[IPC] Active model pack loaded, roles:', Object.keys(activeModelPackRoles!).join(', '));
            }
          } catch (packErr) { console.warn('[IPC] Model pack load error:', packErr); }
        }
      }

      // Map agent IDs to model pack roles based on agent specialty/type
      const agentRoleMap: Record<string, string> = {};
      const AGENT_ROLE_KEYWORDS: Record<string, string[]> = {
        planner: ['planner', 'plan', 'orchestrat', 'product', 'manager'],
        architect: ['architect', 'design', 'system', 'infrastructure'],
        coder: ['engineer', 'developer', 'coder', 'frontend', 'backend', 'fullstack', 'mobile', 'code'],
        summarizer: ['writer', 'document', 'summary', 'research'],
        builder: ['devops', 'build', 'deploy', 'ci', 'ops'],
        names: ['name', 'naming'],
        commitMessages: ['git', 'commit', 'version'],
        autoContinue: ['auto', 'continue'],
      };

      for (const agentTask of plan.agents) {
        const profileId = getActiveProfileId();
        const agentModelRow = (cachedStmt("SELECT value FROM config WHERE key = ?").get('agent-model:' + profileId + ':' + agentTask.id) as any)
          || (cachedStmt("SELECT value FROM config WHERE key = ?").get('agent-model:' + agentTask.id) as any);
        let agentClient = null;

        // Step 1: If model pack is active, try to resolve agent role from pack
        if (activeModelPackRoles && !agentModelRow) {
          const agentIdLower = (agentTask.id || '').toLowerCase();
          let matchedRole: string | null = null;
          // Try to match agent ID to a role
          for (const [role, keywords] of Object.entries(AGENT_ROLE_KEYWORDS)) {
            for (const kw of keywords) {
              if (agentIdLower.includes(kw)) { matchedRole = role; break; }
            }
            if (matchedRole) break;
          }
          // Default unmapped agents to 'coder' role
          if (!matchedRole) matchedRole = 'coder';
          agentRoleMap[agentTask.id] = matchedRole;

          const roleConf = activeModelPackRoles[matchedRole];
          if (roleConf && roleConf.provider !== 'default') {
            const prov = providers2.find((p: any) =>
              (p.type && p.type.toLowerCase() === roleConf.provider.toLowerCase()) ||
              (p.name && p.name.toLowerCase() === roleConf.provider.toLowerCase())
            );
            if (prov) {
              const modelToUse = roleConf.model === 'default' ? (prov.model || '').split(',')[0].trim() : roleConf.model;
              agentClient = createLLMClientWithProMode({ ...prov, model: modelToUse });
              if (agentClient) {
                agentsWithCustomModel++;
                agentProviderMap.set(agentTask.id, { provider: prov.type || '', model: modelToUse });
                console.log('[IPC] Agent', agentTask.id, '→ pack role "' + matchedRole + '":', prov.name, '/', modelToUse);
              }
            }
          } else if (roleConf && roleConf.provider === 'default' && defaultProv) {
            agentClient = createLLMClientWithProMode(defaultProv);
            if (agentClient) {
              agentsUsingDefault++;
              agentProviderMap.set(agentTask.id, { provider: defaultProv.type || '', model: (defaultProv.model || '').split(',')[0].trim() });
              console.log('[IPC] Agent', agentTask.id, '→ pack role "' + matchedRole + '" (default):', defaultProv.name);
            }
          }
        }

        // Step 2: Agent-specific config (overrides pack if explicitly set and no pack active)
        if (!agentClient && agentModelRow) {
          try {
            const am = JSON.parse(agentModelRow.value);
            if (am.provider && am.model) {
              // Agent has a specific provider+model configured
              // Match by name, type, or id — case insensitive
              const prov = providers2.find((p: any) =>
                (p.name && p.name === am.provider) ||
                (p.id && p.id === am.provider) ||
                (p.type && p.type === am.provider) ||
                (p.name && p.name.toLowerCase() === am.provider.toLowerCase())
              );
              if (prov) {
                agentClient = createLLMClientWithProMode({ ...prov, model: am.model });
                if (agentClient) {
                  // Attach nLoops for OpenMythos agents
                  if (am.nLoops != null && prov.type === 'openmythos') {
                    (agentClient as any)._nLoops = Math.max(1, Math.min(32, Math.round(Number(am.nLoops))));
                  } else if (prov.type === 'openmythos' && prov.nLoops != null) {
                    (agentClient as any)._nLoops = Math.max(1, Math.min(32, Math.round(Number(prov.nLoops))));
                  }
                  agentsWithCustomModel++;
                  agentProviderMap.set(agentTask.id, { provider: prov.type || '', model: am.model });
                  console.log('[IPC] Agent', agentTask.id, '→ custom:', prov.name, '/', am.model);
                }
              } else {
                console.warn('[IPC] Agent', agentTask.id, '→ provider "' + am.provider + '" not found in', providers2.map((p: any) => p.name).join(','));
              }
            }
          } catch (e: any) {
            console.error('[IPC] Agent model parse error for', agentTask.id, ':', e?.message);
          }
        }

        // Fallback: use default provider with its default model
        if (!agentClient && defaultProv) {
          agentClient = createLLMClientWithProMode(defaultProv);
          if (agentClient) {
            agentsUsingDefault++;
            agentProviderMap.set(agentTask.id, { provider: defaultProv.type || '', model: (defaultProv.model || '').split(',')[0].trim() });
            console.log('[IPC] Agent', agentTask.id, '→ default:', defaultProv.name, '/', (defaultProv.model || '').split(',')[0]);
          } else {
            console.error('[IPC] Agent', agentTask.id, '→ createLLMClient returned null for default provider:', defaultProv.name, 'model:', defaultProv.model);
          }
        }

        if (!agentClient) {
          console.error('[IPC] Agent', agentTask.id, '→ NO LLM CLIENT. providers:', providers2.length, 'defaultProv:', !!defaultProv);
        }

        if (agentClient) {
          agentLLMConfigs.set(agentTask.id, agentClient);
        }
      }
      console.log('[IPC] Agent LLM resolution:', agentsWithCustomModel, 'custom,', agentsUsingDefault, 'default,', plan.agents.length - agentsWithCustomModel - agentsUsingDefault, 'no provider');
    } catch (e) { console.error('[IPC] Agent LLM config error:', e); }

    // Show agent LLM assignment summary
    const agentSummaryParts: string[] = [];
    for (const agentTask of plan.agents) {
      const def = AGENT_REGISTRY.find(r => r.id === agentTask.id);
      const hasLLM = agentLLMConfigs.has(agentTask.id);
      agentSummaryParts.push((def ? def.emoji + ' ' + def.name : agentTask.id) + (hasLLM ? ' ✅' : ' ⚠️ no provider'));
    }
    const noLLMCount = plan.agents.length - agentLLMConfigs.size;
    if (noLLMCount > 0) {
      sendAndStore(mainWindow, {
        role: 'assistant',
        content: '🔧 **Agent LLM Assignment:** ' + agentLLMConfigs.size + '/' + plan.agents.length + ' agents have AI providers configured.\n' +
          agentSummaryParts.join(' | ') +
          (noLLMCount > 0 ? '\n\n⚠️ ' + noLLMCount + ' agent(s) have no AI provider configured and cannot generate output. Add a provider in Settings.' : ''),
        isCommand: true, agent: 'Orchestrator',
      });
    }

    // Pass per-agent configs to swarm — the swarm coordinator will use these
    // instead of the single default llmClient for each agent
    
    // Pass per-agent configs to swarm — the swarm coordinator will use these
    // instead of the single default llmClient for each agent

    // ── Grounding Enforcer: retrieve context and prepend to agent tasks ──
    const groundingContextMap = new Map<string, GroundingContext>();
    let groundingEnforcer: GroundingEnforcer | null = null;
    try {
      if (activeSessionId) {
        groundingEnforcer = new GroundingEnforcer(graphManager, db, activeSessionId);
        for (const agentTask of plan.agents) {
          try {
            // ── Bypass Prevention: verify requiresGrounding flag is present ──
            // If the flag is missing (e.g., plan was created by a code path that skipped post-processing),
            // enforce it retroactively to ensure no agent can bypass grounding
            if (!agentTask.requiresGrounding) {
              agentTask.requiresGrounding = true;
              console.warn(`[Grounding] Bypass prevention: retroactively set requiresGrounding=true for agent ${agentTask.id}`);
            }

            const groundingContext = await groundingEnforcer.retrieveContext(agentTask.task);
            groundingContextMap.set(agentTask.id, groundingContext);

            // Prepend grounding context to agent's task description
            const groundingPrompt = groundingEnforcer.formatForPrompt(groundingContext);
            agentTask.task = groundingPrompt + agentTask.task;

            console.log(`[Grounding] Agent ${agentTask.id} task ${agentTask.id}: coverage=${groundingContext.coverage}, sources=${groundingContext.nodeCount}, passed=true`);
          } catch (groundingErr: any) {
            console.warn(`[Grounding] Context retrieval failed for agent ${agentTask.id}, continuing without grounding:`, groundingErr?.message);
            // Graceful degradation: continue without blocking
          }
        }

        // ── Graceful Degradation: notify user when all agents are ungrounded ──
        // Check if ALL retrieved contexts are 'ungrounded' (Knowledge Graph empty/unavailable)
        if (groundingContextMap.size > 0) {
          const allUngrounded = Array.from(groundingContextMap.values()).every(ctx => ctx.coverage === 'ungrounded');
          if (allUngrounded) {
            mainWindow.webContents.send('chat-response', {
              role: 'assistant',
              content: '💡 Grounded answers require an indexed project. Generate a Knowledge Graph from the project menu for better accuracy.',
              isCommand: true,
              agent: 'NeuroNest',
            });
            console.log('[Grounding] All agents ungrounded — sent Knowledge Graph generation suggestion to user');
          }
        }
      }
    } catch (groundingInitErr: any) {
      console.warn('[Grounding] GroundingEnforcer initialization failed, continuing without grounding:', groundingInitErr?.message);
      // ── Graceful Degradation: notify user when graph is unavailable during session ──
      if (activeSessionId) {
        mainWindow.webContents.send('chat-response', {
          role: 'assistant',
          content: '⚠️ Knowledge Graph temporarily unavailable — responses may have reduced accuracy',
          isCommand: true,
          agent: 'NeuroNest',
        });
      }
      groundingEnforcer = null;
    }

    // ── Context Files Injection: prepend project context to all agent tasks ──
    if (projectContextCache) {
      for (const agentTask of plan.agents) {
        agentTask.task = projectContextCache + '\n\n' + agentTask.task;
      }
    }

    // ── Skill Matching: check if a learned skill applies to this task ──
    if (skillLearner && trimmed) {
      try {
        const matchedSkill = skillLearner.findMatchingSkill(trimmed);
        if (matchedSkill) {
          // Inject the learned procedure into the first agent's task
          const skillContext = '\n\n--- LEARNED SKILL: "' + matchedSkill.name + '" ---\n' +
            'A similar task was completed before. Follow this procedure:\n' +
            matchedSkill.procedure + '\n--- END SKILL ---\n';
          if (plan.agents.length > 0) {
            plan.agents[0].task = skillContext + plan.agents[0].task;
          }
          skillLearner.recordSuccess(matchedSkill.id);
          sendAndStore(mainWindow, {
            role: 'assistant',
            content: '🧠 Applying learned skill: "' + matchedSkill.name + '"',
            isCommand: true,
            agent: 'Skill Learner',
          });
        }
      } catch {}
    }

    // ── Trajectory Compression: compress history if too long ──
    try {
      const historyForCompression = db.prepare(
        'SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(activeSessionId || '') as Array<{ role: string; content: string }>;

      // Adaptive threshold from the shared Adaptive_Token_Budget calculator
      // (Req 13.1), sized to the active model's context window resolved via
      // Active_Model_Resolver (Req 13.2). No explicit `inputBudget` setting is
      // in scope at this call site, so adaptive sizing is used; when the
      // context length is unknown the calculator's `{ default: 30000 }`
      // reproduces the legacy 30000 fallback for parity.
      let compactionThreshold = 30000;
      try {
        const { configured, explicit } = resolveBudgetInputs(null);
        const contextLength = getActiveContextLength(resolveActiveProviderRecord());
        compactionThreshold = computeInputTokenBudget(configured, contextLength, explicit, { default: 30000 });
      } catch {}

      if (shouldCompress(historyForCompression, 20, compactionThreshold)) {
        const compLlm = resolveActiveLLMClient();
        if (compLlm) {
          const compressed = await compressTrajectory(historyForCompression, compLlm, 4);
          if (compressed) {
            storeMessage('system', '[Context Compressed] ' + compressed.summary, 'System');
            console.log('[Compression] Compressed ' + compressed.messagesRemoved + ' messages, saved ~' + compressed.tokensSaved + ' tokens (threshold: ' + compactionThreshold + ')');
          }
        }
      }
    } catch (compErr: any) {
      console.warn('[Compression] Error (non-fatal):', compErr?.message);
    }

    // ── Schema Injection: if a response schema is active, append instruction to all agent tasks ──
    if (activeSessionId) {
      try {
        const activeSchema = schemaService.getActive(activeSessionId);
        if (activeSchema) {
          const schemaInstruction = '\n\n=== RESPONSE SCHEMA (MANDATORY) ===\n' +
            'You MUST respond with valid JSON that conforms to this schema. Do NOT use markdown, code blocks, or any other format. Return ONLY raw JSON.\n\n' +
            'Schema: ' + JSON.stringify(activeSchema.schema) + '\n' +
            '=== END SCHEMA ===\n';
          for (const agentTask of plan.agents) {
            agentTask.task = agentTask.task + schemaInstruction;
          }
          console.log('[Schema] Injected active schema "' + activeSchema.name + '" into all agent tasks');
        }
      } catch (schemaInjectErr: any) {
        console.warn('[Schema] Injection error (non-fatal):', schemaInjectErr?.message);
      }
    }

    // ── RAG Tool Selection (F4, task 16.2) ──
    // Wrap the LLM call with flag-gated tool retrieval using the booted
    // ToolIndex (task 16.1). The chat pipeline normally exposes the
    // Full_Registry of tools to the model via injected prompt context; under
    // the paired rollout flags we optionally narrow that to a retrieved subset.
    //
    //   • TOOL_RAG_SELECTION=true  + index ready → send the retrieved subset
    //     (Requirement 27.3).
    //   • TOOL_RAG_SELECTION=false + SHADOW=true → compute the retrieval for
    //     telemetry only; the request is unchanged and Full_Registry is sent
    //     (Requirement 27.4).
    //   • index not ready OR retrieval error → emit `tool_rag.fallback` and use
    //     Full_Registry (Requirement 29).
    //
    // Telemetry uses the same SessionTelemetryService Metrics_Sink as the
    // cold-start boot (task 16.1).
    try {
      const { selectToolsForChat } = require('../pipeline/tool-rag-selection');

      // Full_Registry size = booted catalog size when available. Used for the
      // shadow-mode size delta; the catalog already unions ToolSystem + MCP.
      const bootedIndex = getToolIndex();
      let fullRegistrySize = 0;
      try { fullRegistrySize = bootedIndex?.size?.() ?? 0; } catch { fullRegistrySize = 0; }

      // Metrics_Sink — the canonical SessionTelemetryService over the shared db.
      let ragMetricsSink: { recordMetric(s: string | null, k: string, v: number): void } | undefined;
      try {
        const { SessionTelemetryService } = require('../session/session-telemetry');
        ragMetricsSink = new SessionTelemetryService(db);
      } catch { ragMetricsSink = undefined; }

      const decision = await selectToolsForChat({
        index: bootedIndex,
        query: trimmed,
        flags: {
          TOOL_RAG_SELECTION: PERF_FLAGS.TOOL_RAG_SELECTION,
          TOOL_RAG_SELECTION_SHADOW: PERF_FLAGS.TOOL_RAG_SELECTION_SHADOW,
        },
        fullRegistrySize,
        metricsSink: ragMetricsSink,
        sessionId: activeSessionId ?? null,
      });

      // Only when active selection is on AND a subset was retrieved do we alter
      // the request: inject the retrieved tool list as system-prompt context so
      // the model is offered the narrowed selection. In `off`, `shadow`, and
      // `fallback` modes the request is left untouched (Full_Registry).
      if (decision.mode === 'rag' && decision.retrieved && bootedIndex) {
        try {
          const toolBlock = bootedIndex.renderForSystemPrompt(decision.retrieved);
          const toolInstruction =
            '\n\n=== AVAILABLE TOOLS (RAG-selected) ===\n' + toolBlock + '\n=== END TOOLS ===\n';
          for (const agentTask of plan.agents) {
            agentTask.task = agentTask.task + toolInstruction;
          }
          console.log('[IPC] RAG tool selection: injected ' + decision.retrieved.length + ' retrieved tools');
        } catch (renderErr: any) {
          console.warn('[IPC] RAG tool render failed (continuing with Full_Registry):', renderErr?.message);
        }
      } else {
        console.log('[IPC] RAG tool selection mode:', decision.mode, '(Full_Registry sent)');
      }
    } catch (ragErr: any) {
      // Defensive: the selection layer never throws, but a wiring error must
      // never break the chat handler — fall through with Full_Registry.
      console.warn('[IPC] RAG tool selection skipped (non-fatal):', ragErr?.message ?? ragErr);
    }

    // ── Plan Validation: validate plan before swarm dispatch (Req 2.1, 2.5, 2.6, 2.7, 2.8) ──
    // The AgentLoopController.validatePlan() performs lightweight synchronous checks
    // (agent ID validation, cycle detection, feasibility) with no LLM calls.
    // Must complete within 500ms for plans up to 20 agent tasks.
    try {
      const planValidationConfig = {
        llmClient: wrapLLMClientForAgentLoop(llmClient || resolveActiveLLMClient()!),
        toolSystem: getAgentLoopToolSystem(),
        projectDir: '',
        sessionId: activeSessionId || '',
        maxIterations: 1,
        planMode: false,
        turboEditsEnabled: false,
        smartContextEnabled: false,
      };
      const agentLoop = new AgentLoopController(planValidationConfig);
      const validation = agentLoop.validatePlan(plan);

      if (validation.status === 'rejected') {
        // Report rejection to user, do not dispatch
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: `⚠️ **Plan Rejected:** ${validation.reason}\n\nAffected steps: ${validation.affectedSteps.join(', ')}`,
          isCommand: true,
          agent: 'Plan Validator',
        });
        console.warn('[IPC] Plan validation rejected:', validation.reason, 'affected:', validation.affectedSteps);
        return;
      }

      if (validation.status === 'refined') {
        // Use the corrected plan; emit plan_refined event
        mainWindow.webContents.send('plan_refined', { original: plan, refined: validation.plan });
        console.log('[IPC] Plan refined by validator, refinements:', validation.refinements);
        // Replace plan with the refined version for dispatch
        Object.assign(plan, validation.plan);
      }

      // 'approved' status: pass plan unchanged to SwarmCoordinator
    } catch (validationErr: any) {
      // Plan validation is non-blocking — if it fails, continue with the original plan
      console.warn('[IPC] Plan validation error (non-fatal, continuing with original plan):', validationErr?.message);
    }

    // Use enhanced coordinator if available and session is active
    let swarmResult;
    const useEnhancedCoordinator = true; // Feature flag - can be made configurable later
    
    if (enhancedSwarmCoordinator && activeSessionId && useEnhancedCoordinator) {
      console.log('[IPC] Using enhanced swarm coordinator with task lifecycle management');
      // Set activeSwarmCoordinator to the enhanced one so /abort works correctly
      activeSwarmCoordinator = enhancedSwarmCoordinator as any;
      swarmResult = await enhancedSwarmCoordinator.executeEnhanced(plan, activeSessionId, async (event) => {
        if (event.type === 'phase_start') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '⚡ ' + event.content, isCommand: true, agent: 'Swarm',
          });
        } else if (event.type === 'task_claimed') {
          // Suppress — agent_start already shows this
          console.log('[Swarm]', event.content);
        } else if (event.type === 'task_progress_update') {
          // Suppress noisy progress updates — only log to console
          console.log('[Swarm] Progress:', event.content);
        } else if (event.type === 'task_blocker_reported') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🚫 Blocker: ' + event.content, isCommand: true, agent: 'Task Manager',
          });
          // Desktop notification: agent needs input
          sendDesktopNotification(activeSessionId, 'onAgentNeedsInput', '🚫 Agent Blocked', (event.content || 'An agent needs your input').slice(0, 100));
        } else if (event.type === 'skill_applied') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🧩 Skill applied: ' + event.content, isCommand: true, agent: 'Skills',
          });
        } else if (event.type === 'agent_token') {
          // True streaming: forward LLM tokens directly to the renderer
          if (event.done) {
            if (event.error) {
              mainWindow.webContents.send('chat:error', { msgId: event.msgId, partial: '', error: event.content || 'Stream error' });
            } else {
              mainWindow.webContents.send('chat:done', { msgId: event.msgId, usage: {} });
            }
          } else if (event.token === '' && !event.done) {
            // Start signal — create the message bubble
            const agentProv = agentProviderMap.get(event.agentId || '') || { provider: activeProviderType, model: activeModelId };
            mainWindow.webContents.send('chat:stream', { msgId: event.msgId, token: '', agent: event.agentName || 'Agent', start: true, provider: agentProv.provider || activeProviderType, model: agentProv.model || activeModelId });
          } else {
            // Token chunk
            mainWindow.webContents.send('chat:stream', { msgId: event.msgId, token: event.token });
          }
        } else if (event.type === 'agent_start') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🚀 ' + event.agentName + ' starting...', isCommand: true, agent: event.agentName,
          });
          sharedMemory.store({ agentId: event.agentName || 'swarm', type: 'context', content: 'Agent started: ' + (event.agentName || '') });
        } else if (event.type === 'agent_complete') {
          // Firewall: scan agent output (warn only, never block code generation)
          let agentContent = event.content || '';
          if (firewallEngine && agentContent) {
            const fwOut = firewallEngine.evaluate(agentContent, { agentId: event.agentId || event.agentName, projectId: activeSessionId || undefined });
            if (fwOut.events.length > 0) {
              mainWindow.webContents.send('firewall-event', { type: 'scan', source: 'agent-output', agentId: event.agentId, events: fwOut.events });
            }
            agentContent = fwOut.sanitized;
          }

          // ── Bypass Prevention: retroactively trigger grounding if not already done ──
          if (groundingEnforcer && event.agentId && !groundingContextMap.has(event.agentId)) {
            try {
              console.warn(`[Grounding] Bypass prevention: agent ${event.agentId} completed without grounding context — triggering retroactive retrieval`);
              const retroactiveCtx = await groundingEnforcer.retrieveContext(agentContent.slice(0, 500));
              groundingContextMap.set(event.agentId, retroactiveCtx);
              console.log(`[Grounding] Agent ${event.agentId} task ${event.agentId}: coverage=${retroactiveCtx.coverage}, sources=${retroactiveCtx.nodeCount}, passed=retroactive`);
            } catch (retroErr: any) {
              console.warn(`[Grounding] Retroactive retrieval failed for agent ${event.agentId}:`, retroErr?.message);
            }
          }

          // ── Grounding Verification: verify agent output references sources ──
          if (groundingEnforcer && event.agentId) {
            try {
              const agentGroundingCtx = groundingContextMap.get(event.agentId);
              if (agentGroundingCtx) {
                const groundingPassed = groundingEnforcer.verifyGrounding(agentContent, agentGroundingCtx);
                // Log grounding event (pass or fail)
                groundingEnforcer.logEvent(event.agentId, event.agentId + ':task', agentGroundingCtx, groundingPassed);

                console.log(`[Grounding] Agent ${event.agentId} task ${event.agentId}: coverage=${agentGroundingCtx.coverage}, sources=${agentGroundingCtx.nodeCount}, passed=${groundingPassed}`);

                if (!groundingPassed && agentGroundingCtx.coverage !== 'ungrounded') {
                  // Grounding failed — log warning (re-prompting handled by critic agent below)
                  console.warn(`[Grounding] Agent ${event.agentId} output failed grounding verification (coverage=${agentGroundingCtx.coverage})`);
                }
              }
            } catch (groundingVerifyErr: any) {
              console.warn('[Grounding] Verification error for agent', event.agentId, ':', groundingVerifyErr?.message);
            }
          }

          // ── Critic Agent Evaluation: verify agent output for hallucination ──
          let hallucinationScore: number | undefined;
          if (groundingEnforcer && event.agentId) {
            try {
              const criticAgent = new CriticAgent(graphManager, db, activeSessionId || '');
              const agentGroundingCtx = groundingContextMap.get(event.agentId);

              if (agentGroundingCtx) {
                const criticResult = await criticAgent.evaluate(agentContent, agentGroundingCtx, event.agentId);
                hallucinationScore = criticResult.hallucinationScore;

                if (!criticResult.passed) {
                  // hallucinationScore > 0.6 — prepend reduced confidence disclaimer
                  console.warn(`[Critic] Agent ${event.agentId} failed critic evaluation (score=${criticResult.hallucinationScore})`);
                  agentContent = '⚠️ *Response confidence: reduced* — Some claims could not be verified.\n\n' + agentContent;
                }

                // Log critic evaluation to grounding_audit table
                groundingEnforcer.logEvent(event.agentId, event.agentId + ':critic', agentGroundingCtx, criticResult.passed);
              }
            } catch (criticErr: any) {
              console.warn('[Critic] Evaluation error for agent', event.agentId, ':', criticErr?.message);
              // Graceful degradation: continue without blocking
            }
          }

          // ── Send hallucination score to renderer via chat-response metadata ──
          if (hallucinationScore !== undefined) {
            mainWindow.webContents.send('chat-response', {
              role: 'meta',
              type: 'hallucination-score',
              agentId: event.agentId,
              agentName: event.agentName,
              hallucinationScore,
            });
          }

          // ── Response Schema Validation ──
          if (activeSessionId && agentContent) {
            try {
              const schemaResult = schemaService.validateForSession(activeSessionId, agentContent);
              if (schemaResult && !schemaResult.valid) {
                sendAndStore(mainWindow, {
                  role: 'assistant',
                  content: '⚠️ **Schema Validation Failed** — ' + (event.agentName || 'Agent') + '\'s response does not match the active schema "' + schemaResult.schemaName + '".\n\n**Errors:** ' + schemaResult.errors.join(', ') + '\n\n*The response was delivered as-is. Consider adjusting your prompt to request JSON output matching the schema.*',
                  isCommand: true,
                  agent: 'Schema Validator',
                });
              }
            } catch (schemaErr: any) {
              console.warn('[Schema] Validation error:', schemaErr?.message);
            }
          }

          // ── Agent response already streamed via agent_token events ──
          // Just store for DB and memory, don't send to renderer again
          storeMessage('assistant', agentContent, event.agentName || 'Agent');

          if (event.content && event.agentName) {
            sharedMemory.storeAgentOutput(event.agentName, event.content.slice(0, 5000));
          }

          // Desktop notification: agent completed
          sendDesktopNotification(activeSessionId, 'onAgentComplete', '✅ Agent Complete', (event.agentName || 'Agent') + ' finished its task.');
          // Project Memory: persist learned patterns for cross-session recall
          if (projectMemoryRef && activeSessionId && agentContent) {
            try { projectMemoryRef.learn(activeSessionId, 'pattern', '[' + (event.agentName || 'Agent') + '] ' + agentContent.slice(0, 500), 'agent-output'); } catch(e) {}
          }
        } else if (event.type === 'handoff') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🔗 Handoff: ' + event.content, isCommand: true, agent: 'Swarm',
          });
          sharedMemory.storeDecision('swarm', 'Handoff: ' + (event.content || ''));
        } else if (event.type === 'consensus_result') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🤝 ' + event.content, isCommand: true, agent: 'Consensus',
          });
          sharedMemory.storeDecision('consensus', event.content || '');
        } else if (event.type === 'swarm_complete') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '✅ ' + event.content, isCommand: true, agent: 'Swarm',
          });
        }
      }, agentLLMConfigs);
      
      // ── Skill Learning: analyze execution and potentially learn a reusable skill ──
      if (skillLearner && activeSessionId && swarmResult && swarmResult.outputs) {
        try {
          const llm = resolveActiveLLMClient();
          if (llm) {
            skillLearner.learnFromExecution(trimmed || '', swarmResult.outputs, activeSessionId, llm).then(function(learned) {
              if (learned) {
                sendAndStore(mainWindow, {
                  role: 'assistant',
                  content: '🧠 **Skill Learned:** "' + learned.name + '" — I\'ll remember this approach for similar tasks.',
                  isCommand: true,
                  agent: 'Skill Learner',
                });
              }
            }).catch(function() {});
          }
        } catch {}
      }

      // Send enhanced metrics
      if (swarmResult.tasks && swarmResult.tasks.length > 0) {
        const completedCount = swarmResult.tasks.filter(t => t.status === 'completed').length;
        const failedCount = swarmResult.tasks.filter(t => t.status === 'failed').length;
        const blockedCount = swarmResult.tasks.filter(t => t.status === 'blocked').length;
        const taskSummary = `📊 **Enhanced Execution Summary**\n\n` +
          `- **Tasks:** ${swarmResult.tasks.length} (${completedCount} completed${failedCount > 0 ? ', ' + failedCount + ' failed' : ''}${blockedCount > 0 ? ', ' + blockedCount + ' blocked' : ''})\n` +
          `- **Skills Used:** ${swarmResult.skillsUsed.length}\n` +
          `- **Runtimes:** ${swarmResult.runtimesUsed.length}\n` +
          `- **Blockers:** ${swarmResult.totalBlockers}\n` +
          `- **Avg Duration:** ${swarmResult.avgTaskDuration.toFixed(1)}h`;
        
        sendAndStore(mainWindow, {
          role: 'assistant', content: taskSummary, isCommand: true, agent: 'Task Manager',
        });
      }
    } else {
      console.log('[IPC] Using standard swarm coordinator');
      swarmResult = await swarmCoordinator.execute(plan, async (event) => {
        if (event.type === 'phase_start') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '⚡ ' + event.content, isCommand: true, agent: 'Swarm',
          });
        } else if (event.type === 'agent_start') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🚀 ' + event.agentName + ' starting...', isCommand: true, agent: event.agentName,
          });
          // Inject shared memory context for this agent
          sharedMemory.store({ agentId: event.agentName || 'swarm', type: 'context', content: 'Agent started: ' + (event.agentName || '') });
        } else if (event.type === 'agent_token') {
          // True streaming: forward LLM tokens directly to the renderer
          if (event.done) {
            if (event.error) {
              mainWindow.webContents.send('chat:error', { msgId: event.msgId, partial: '', error: event.content || 'Stream error' });
            } else {
              mainWindow.webContents.send('chat:done', { msgId: event.msgId, usage: {} });
            }
          } else if (event.token === '' && !event.done) {
            const agentProv2 = agentProviderMap.get(event.agentId || '') || { provider: activeProviderType, model: activeModelId };
            mainWindow.webContents.send('chat:stream', { msgId: event.msgId, token: '', agent: event.agentName || 'Agent', start: true, provider: agentProv2.provider || activeProviderType, model: agentProv2.model || activeModelId });
          } else {
            mainWindow.webContents.send('chat:stream', { msgId: event.msgId, token: event.token });
          }
        } else if (event.type === 'agent_complete') {
          // ── Firewall: scan agent output (warn only, never block code generation) ──
          let agentContent = event.content || '';
          if (firewallEngine && agentContent) {
            const fwOut = firewallEngine.evaluate(agentContent, { agentId: event.agentId || event.agentName, projectId: activeSessionId || undefined });
            // For agent output: only log/warn, never block — code naturally contains
            // patterns like fetch(), eval(), password=, api_key= etc.
            if (fwOut.events.length > 0) {
              mainWindow.webContents.send('firewall-event', { type: 'scan', source: 'agent-output', agentId: event.agentId, events: fwOut.events });
            }
            agentContent = fwOut.sanitized; // still apply tier-0 sanitization (strip invisible chars)
          }

          // ── Bypass Prevention: retroactively trigger grounding if not already done ──
          if (groundingEnforcer && event.agentId && !groundingContextMap.has(event.agentId)) {
            try {
              console.warn(`[Grounding] Bypass prevention: agent ${event.agentId} completed without grounding context — triggering retroactive retrieval`);
              const retroactiveCtx = await groundingEnforcer.retrieveContext(agentContent.slice(0, 500));
              groundingContextMap.set(event.agentId, retroactiveCtx);
              console.log(`[Grounding] Agent ${event.agentId} task ${event.agentId}: coverage=${retroactiveCtx.coverage}, sources=${retroactiveCtx.nodeCount}, passed=retroactive`);
            } catch (retroErr: any) {
              console.warn(`[Grounding] Retroactive retrieval failed for agent ${event.agentId}:`, retroErr?.message);
            }
          }

          // ── Grounding Verification: verify agent output references sources ──
          if (groundingEnforcer && event.agentId) {
            try {
              const agentGroundingCtx = groundingContextMap.get(event.agentId);
              if (agentGroundingCtx) {
                const groundingPassed = groundingEnforcer.verifyGrounding(agentContent, agentGroundingCtx);
                // Log grounding event (pass or fail)
                groundingEnforcer.logEvent(event.agentId, event.agentId + ':task', agentGroundingCtx, groundingPassed);

                console.log(`[Grounding] Agent ${event.agentId} task ${event.agentId}: coverage=${agentGroundingCtx.coverage}, sources=${agentGroundingCtx.nodeCount}, passed=${groundingPassed}`);

                if (!groundingPassed && agentGroundingCtx.coverage !== 'ungrounded') {
                  // Grounding failed — log warning (re-prompting handled by critic agent below)
                  console.warn(`[Grounding] Agent ${event.agentId} output failed grounding verification (coverage=${agentGroundingCtx.coverage})`);
                }
              }
            } catch (groundingVerifyErr: any) {
              console.warn('[Grounding] Verification error for agent', event.agentId, ':', groundingVerifyErr?.message);
            }
          }

          // ── Critic Agent Evaluation: verify agent output for hallucination ──
          let hallucinationScore: number | undefined;
          if (groundingEnforcer && event.agentId) {
            try {
              const criticAgent = new CriticAgent(graphManager, db, activeSessionId || '');
              const agentGroundingCtx = groundingContextMap.get(event.agentId);

              if (agentGroundingCtx) {
                const criticResult = await criticAgent.evaluate(agentContent, agentGroundingCtx, event.agentId);
                hallucinationScore = criticResult.hallucinationScore;

                if (!criticResult.passed) {
                  // hallucinationScore > 0.6 — prepend reduced confidence disclaimer
                  console.warn(`[Critic] Agent ${event.agentId} failed critic evaluation (score=${criticResult.hallucinationScore})`);
                  agentContent = '⚠️ *Response confidence: reduced* — Some claims could not be verified.\n\n' + agentContent;
                }

                // Log critic evaluation to grounding_audit table
                groundingEnforcer.logEvent(event.agentId, event.agentId + ':critic', agentGroundingCtx, criticResult.passed);
              }
            } catch (criticErr: any) {
              console.warn('[Critic] Evaluation error for agent', event.agentId, ':', criticErr?.message);
              // Graceful degradation: continue without blocking
            }
          }

          // ── Send hallucination score to renderer via chat-response metadata ──
          if (hallucinationScore !== undefined) {
            mainWindow.webContents.send('chat-response', {
              role: 'meta',
              type: 'hallucination-score',
              agentId: event.agentId,
              agentName: event.agentName,
              hallucinationScore,
            });
          }

          // ── Agent response already streamed via agent_token events ──
          storeMessage('assistant', agentContent, event.agentName || 'Agent');

          // Store agent output in shared memory for other agents to reference
          if (event.content && event.agentName) {
            sharedMemory.storeAgentOutput(event.agentName, event.content.slice(0, 5000));
          }

          // Desktop notification: agent completed
          sendDesktopNotification(activeSessionId, 'onAgentComplete', '✅ Agent Complete', (event.agentName || 'Agent') + ' finished its task.');
          // Project Memory: persist learned patterns for cross-session recall
          if (projectMemoryRef && activeSessionId && agentContent) {
            try { projectMemoryRef.learn(activeSessionId, 'pattern', '[' + (event.agentName || 'Agent') + '] ' + agentContent.slice(0, 500), 'agent-output'); } catch(e) {}
          }
        } else if (event.type === 'handoff') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🔗 Handoff: ' + event.content, isCommand: true, agent: 'Swarm',
          });
          sharedMemory.storeDecision('swarm', 'Handoff: ' + (event.content || ''));
        } else if (event.type === 'consensus_result') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '🤝 ' + event.content, isCommand: true, agent: 'Consensus',
          });
          sharedMemory.storeDecision('consensus', event.content || '');
        } else if (event.type === 'swarm_complete') {
          sendAndStore(mainWindow, {
            role: 'assistant', content: '✅ ' + event.content, isCommand: true, agent: 'Swarm',
          });
        }
      }, agentLLMConfigs);
    }

    activeSwarmCoordinator = null; // Clear after completion

    // ── F7 Teacher_Escalation_Loop: post-turn hook ──
    // On turn complete, escalate to a configured teacher endpoint when the
    // flag is on, a failure is detected, the student model is self-hosted, and
    // a teacher model is configured. Awaited but fully self-contained — it
    // never throws, so it cannot break the agent loop. (Requirements 40.2–40.4)
    await runTeacherEscalationHook(swarmResult);

    // Track token usage
    try {
      const tokenRow = db.prepare("SELECT value FROM config WHERE key = 'total-tokens'").get() as any;
      const prevTokens = tokenRow ? parseInt(tokenRow.value) || 0 : 0;
      const newTokens = prevTokens + tokenCount;
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('total-tokens', ?, ?)").run(String(newTokens), new Date().toISOString());
      const costPerToken = 0.000002;
      const costRow = db.prepare("SELECT value FROM config WHERE key = 'total-cost'").get() as any;
      const prevCost = costRow ? parseFloat(costRow.value) || 0 : 0;
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('total-cost', ?, ?)").run(String(prevCost + tokenCount * costPerToken), new Date().toISOString());
    } catch (tokenErr) { console.error('[IPC] Token tracking error:', tokenErr); }

    // Record cost via CostStore — per-agent based on their provider/model
    try {
      if (costStore && pricingTable && activeSessionId && agentProviderMap.size > 0) {
        // Estimate tokens per agent (distribute based on number of agents that ran)
        const numAgents = agentProviderMap.size;
        const basePromptTokens = Math.max(1, Math.ceil(trimmed.length / 4));
        const baseCompletionTokens = basePromptTokens * 3;
        // Each agent gets prompt tokens (they all see the prompt) + share of completion
        const perAgentCompletion = Math.max(1, Math.ceil(baseCompletionTokens / numAgents));

        let totalSessionCost = 0;
        for (const [agentId, agentInfo] of agentProviderMap) {
          const costResult = calculateCost(agentInfo.provider, agentInfo.model, basePromptTokens, perAgentCompletion, pricingTable);
          console.log('[Cost] Agent', agentId, ':', agentInfo.provider, '/', agentInfo.model, '→ $' + costResult.cost.toFixed(6));
          costStore.record({
            projectId: activeSessionId,
            provider: agentInfo.provider,
            model: agentInfo.model,
            promptTokens: basePromptTokens,
            completionTokens: perAgentCompletion,
            cost: costResult.cost,
          });
          totalSessionCost += costResult.cost;
        }
        console.log('[Cost] Total session cost:', '$' + totalSessionCost.toFixed(6), 'for', numAgents, 'agents');
        const projectCost = costStore.getProjectCost(activeSessionId);
        mainWindow.webContents.send('update-stats', { tokens: tokenCount, cost: projectCost });
      } else if (costStore && pricingTable && activeSessionId && activeProviderType) {
        // Fallback: single provider (no per-agent configs)
        const estimatedTokens = Math.max(1, Math.ceil(trimmed.length / 4));
        const promptTokens = estimatedTokens;
        const completionTokens = estimatedTokens * 3;
        const costResult = calculateCost(activeProviderType, activeModelId, promptTokens, completionTokens, pricingTable);
        console.log('[Cost] Fallback single provider:', activeProviderType, '/', activeModelId, '→ $' + costResult.cost.toFixed(6));
        costStore.record({
          projectId: activeSessionId,
          provider: activeProviderType,
          model: activeModelId,
          promptTokens,
          completionTokens,
          cost: costResult.cost,
        });
        const projectCost = costStore.getProjectCost(activeSessionId);
        mainWindow.webContents.send('update-stats', { tokens: tokenCount, cost: projectCost });
      } else {
        console.warn('[Cost] Skipped cost recording — costStore:', !!costStore, 'pricingTable keys:', Object.keys(pricingTable || {}).length, 'activeSessionId:', !!activeSessionId, 'agentProviderMap size:', agentProviderMap.size, 'activeProviderType:', activeProviderType);
      }
    } catch (costErr) { console.error('[IPC] Cost recording error:', costErr); }

    // Cache the prompt for this pipeline execution
    try {
      if (promptCacheRef && activeSessionId) {
        const crypto = require('node:crypto');
        const promptHash = crypto.createHash('sha256').update(activeSessionId + ':' + trimmed).digest('hex');
        promptCacheRef.store(promptHash, activeProviderType || 'default', activeModelId || 'default', Math.ceil(trimmed.length / 4), 'pipeline-execution');
      }
    } catch { /* non-fatal */ }

    // Extract code files from agent outputs and save to project directory
    let totalFiles = 0;
    if (activeSessionId) {
      try {
        const os = require('node:os');
        const fs = require('node:fs');
        const path = require('node:path');
        const projectDir = path.join(os.homedir(), '.neuronest', 'projects', activeSessionId);
        fs.mkdirSync(projectDir, { recursive: true });

        // Regex to find file path annotations before code blocks:
        //   // file: src/app.ts        ```typescript ...```
        //   <!-- file: index.html -->   ```html ...```
        //   # filename: server.py       ```python ...```
        //   **`src/utils/helper.js`**   ```javascript ...```
        //   Path: src/config.json       ```json ...```
        // Simple, reliable regex for code blocks: ```lang\ncode\n```
        const fileBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
        // Match file path annotations in many formats:
        //   // file: src/app.ts
        //   # file: src/app.ts
        //   **src/app.ts**
        //   `src/app.ts`
        //   File: src/app.ts
        //   Path: src/app.ts
        //   <!-- file: index.html -->
        //   ### src/app.ts
        const fileAnnotationPatterns = [
          /(?:\/\/|#|<!--|\/\*)\s*(?:file|path|filename)[:\s]*[`"']?([^\s`"'<>\n]+\.[a-zA-Z0-9]+)/i,
          /\*\*`?([a-zA-Z0-9_][\w./-]+\.[a-zA-Z0-9]+)`?\*\*/,
          /^`([a-zA-Z0-9_][\w./-]+\.[a-zA-Z0-9]+)`\s*$/m,
          /^#{1,4}\s+`?([a-zA-Z0-9_][\w./-]+\.[a-zA-Z0-9]+)`?\s*$/m,
          /(?:File|Path|Filename|Create|Output)[:\s]+`?([a-zA-Z0-9_][\w./-]+\.[a-zA-Z0-9]+)`?/i,
        ];
        const standalonePathRegex = /^[`*]*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)[`*]*\s*$/;

        const extMap: Record<string, string> = {
          typescript: 'ts', javascript: 'js', python: 'py', html: 'html', css: 'css',
          json: 'json', sql: 'sql', rust: 'rs', go: 'go', java: 'java', tsx: 'tsx',
          jsx: 'jsx', yaml: 'yml', yml: 'yml', sh: 'sh', bash: 'sh', markdown: 'md',
          xml: 'xml', toml: 'toml', dockerfile: 'Dockerfile', makefile: 'Makefile',
          ruby: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', scala: 'scala',
          csharp: 'cs', cpp: 'cpp', c: 'c', r: 'r',
        };

        // Directories are created on-demand when files are written (via mkdirSync recursive)
        // No pre-created empty folders — only folders that contain actual files will exist

        totalFiles = 0;
        console.log('[IPC] File extraction: processing', swarmResult.outputs.size, 'agent outputs');
        for (const [agentId, output] of swarmResult.outputs) {
          console.log('[IPC] Agent', agentId, 'output:', output.length, 'chars,', (output.match(/```/g) || []).length / 2, 'code blocks');
          let match;
          let fileIdx = 0;

          // Reset regex state
          fileBlockRegex.lastIndex = 0;

          while ((match = fileBlockRegex.exec(output)) !== null) {
            if (totalFiles > 100) break; // safety limit
            const lang = (match[1] || 'txt').toLowerCase();
            const code = match[2];

            if (!code || !code.trim()) continue;

            // Look for file path annotation in the 400 chars before this code block
            let filePath = '';
            const preceding = output.slice(Math.max(0, match.index - 400), match.index);
            for (const pattern of fileAnnotationPatterns) {
              const annotationMatch = pattern.exec(preceding);
              if (annotationMatch && annotationMatch[1]) {
                filePath = annotationMatch[1];
                break;
              }
            }

            // Fallback: check preceding lines for standalone path
            if (!filePath) {
              const precLines = preceding.split('\n').reverse();
              for (const pl of precLines) {
                const trimLine = pl.trim();
                if (!trimLine) continue;
                const spMatch = standalonePathRegex.exec(trimLine);
                if (spMatch) { filePath = spMatch[1]; break; }
                const pathMatch = trimLine.match(/[`"']?([a-zA-Z0-9_][\w./-]*\/[\w.-]+\.[a-zA-Z0-9]+)[`"']?/);
                if (pathMatch) { filePath = pathMatch[1]; break; }
                if (!trimLine.startsWith('//') && !trimLine.startsWith('#') && !trimLine.startsWith('*')) break;
              }
            }

            // If still no path, generate a structured one based on language and content
            if (!filePath) {
              const fileExt = extMap[lang] || lang;
              // Try to infer a name from the code content
              let inferredName = '';
              const classMatch = code.match(/(?:class|interface|enum)\s+(\w+)/);
              const funcMatch = code.match(/(?:function|const|export\s+(?:default\s+)?(?:function|class))\s+(\w+)/);
              const compMatch = code.match(/(?:export\s+default\s+function|const)\s+(\w+)/);
              if (classMatch) inferredName = classMatch[1].toLowerCase();
              else if (compMatch) inferredName = compMatch[1].toLowerCase();
              else if (funcMatch) inferredName = funcMatch[1].toLowerCase();
              else inferredName = agentId.replace(/[^a-zA-Z0-9]/g, '-') + '-' + fileIdx;

              // Place in appropriate directory based on language/content
              if (['html'].includes(fileExt)) filePath = 'public/' + inferredName + '.' + fileExt;
              else if (['css', 'scss', 'less'].includes(fileExt)) filePath = 'src/' + inferredName + '.' + fileExt;
              else if (['json'].includes(fileExt) && (code.includes('"name"') || code.includes('"version"'))) filePath = inferredName.includes('package') ? 'package.json' : 'config/' + inferredName + '.' + fileExt;
              else if (['yml', 'yaml', 'toml'].includes(fileExt)) filePath = 'config/' + inferredName + '.' + fileExt;
              else if (code.includes('import React') || code.includes('jsx') || ['tsx', 'jsx'].includes(fileExt)) filePath = 'src/components/' + inferredName + '.' + fileExt;
              else if (code.includes('app.get(') || code.includes('router.') || code.includes('express')) filePath = 'src/api/' + inferredName + '.' + fileExt;
              else filePath = 'src/' + inferredName + '.' + fileExt;

              fileIdx++;
            }

            // Sanitize path — remove leading slashes, .., etc
            filePath = filePath.replace(/^[./\\]+/, '').replace(/\.\./g, '');
            if (!filePath) continue;

            // Create directory and write file with header
            const fullPath = path.join(projectDir, filePath);
            writeFileWithHeader(fullPath, code.trim() + '\n');
            totalFiles++;
          }

          // Save full agent output as markdown in a docs folder with header
          fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
          const agentOutputPath = path.join(projectDir, 'docs', agentId + '-output.md');
          writeFileWithHeader(agentOutputPath, output);
        }

        // Generate a README.md if none exists
        const readmePath = path.join(projectDir, 'README.md');
        if (!fs.existsSync(readmePath)) {
          const projectName = activeSessionId ? 'NeuroNest Project' : 'Project';
          fs.writeFileSync(readmePath, `# ${projectName}\n\nGenerated by NeuroNest AI Coding SuperAgent.\n\n## Structure\n\n- \`src/\` — Source code\n- \`src/components/\` — UI components\n- \`src/api/\` — API routes and handlers\n- \`src/utils/\` — Utility functions\n- \`public/\` — Static assets\n- \`config/\` — Configuration files\n- \`docs/\` — Agent outputs and documentation\n`, 'utf-8');
        }

        console.log('[IPC] Extracted', totalFiles, 'files to', projectDir);
        if (totalFiles === 0) {
          console.warn('[IPC] No code blocks extracted from agent outputs. Agents may not have generated code in the expected format.');
          sendAndStore(mainWindow, {
            role: 'assistant',
            content: '⚠️ No code files were extracted from agent outputs. Check the docs/ folder for raw agent responses. If no AI provider is configured, add one in Settings → AI Providers.',
            isCommand: true, agent: 'System',
          });
        } else {
          sendAndStore(mainWindow, {
            role: 'assistant',
            content: '📁 Extracted ' + totalFiles + ' files to project directory. Check the file tree in the sidebar.',
            isCommand: true, agent: 'System',
          });

          // ── Post-Generation: Validate, scaffold, and fix dependencies ──
          try {
            // 1. Scaffold missing config files (.gitignore, tsconfig.json, .env.example)
            const scaffolded = scaffoldMissingConfigs(projectDir);
            if (scaffolded.length > 0) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '📋 Auto-generated config files: ' + scaffolded.join(', '),
                isCommand: true, agent: 'Code Quality',
              });
              totalFiles += scaffolded.length;
            }

            // 2. Validate the generated project
            const validation = validateGeneratedProject(projectDir);

            // 3. Auto-fix dependencies if needed
            if (validation.warnings.some(w => w.includes('Missing dependencies') || w.includes('no dependencies'))) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '📦 Installing dependencies...',
                isCommand: true, agent: 'Code Quality',
              });
              const fixResult = autoFixDependencies(projectDir);
              if (fixResult.fixed) {
                sendAndStore(mainWindow, {
                  role: 'assistant',
                  content: '✅ ' + fixResult.message,
                  isCommand: true, agent: 'Code Quality',
                });
              } else {
                sendAndStore(mainWindow, {
                  role: 'assistant',
                  content: '⚠️ Dependency install issue: ' + fixResult.message,
                  isCommand: true, agent: 'Code Quality',
                });
              }
            }

            // 4. Report remaining warnings
            const remainingWarnings = validation.warnings.filter(w => !w.includes('Missing dependencies') && !w.includes('no dependencies'));
            if (remainingWarnings.length > 0) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '💡 **Project Notes:**\n' + remainingWarnings.map(w => '- ' + w).join('\n'),
                isCommand: true, agent: 'Code Quality',
              });
            }

            if (validation.errors.length > 0) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '❌ **Issues found:**\n' + validation.errors.map(e => '- ' + e).join('\n'),
                isCommand: true, agent: 'Code Quality',
              });
            }
          } catch (valErr: any) {
            console.warn('[IPC] Post-generation validation error (non-fatal):', valErr?.message);
          }
        }
        // Send file tree update to renderer
        notifyProjectFilesUpdated(activeSessionId);
      } catch (e: any) {
        console.error('[IPC] File extraction error:', e);
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: '⚠️ File extraction error: ' + (e?.message || String(e)),
          isCommand: true, agent: 'System',
        });
      }
    }

    // Final summary — keep it short to avoid overwhelming the renderer
    try {
      const agentCount = swarmResult.outputs.size;
      const agentList = Array.from(swarmResult.outputs.keys()).map(id => {
        const def = AGENT_REGISTRY.find(r => r.id === id);
        return def ? def.emoji + ' ' + def.name : id;
      }).join(', ');

      sendAndStore(mainWindow, {
        role: 'assistant',
        content: '📊 **Swarm Complete** — ' + agentCount + ' agents, ' + swarmResult.totalPhases + ' phases, ' + totalFiles + ' files extracted\n\nAgents: ' + agentList,
        agent: 'NeuroNest',
      });
    } catch (summaryErr: any) {
      console.error('[IPC] Final summary error:', summaryErr);
      sendAndStore(mainWindow, {
        role: 'assistant',
        content: '📊 **Swarm Complete** — Processing finished',
        agent: 'NeuroNest',
      });
    }

    // ── Auto Lint & Test — trigger after AI changes ──
    if (activeSessionId && lintTestServiceRef && totalFiles > 0) {
      try {
        const lintTestConfig = lintTestServiceRef.getConfig(activeSessionId);
        if (lintTestConfig && lintTestConfig.runOnAiChange) {
          const os = require('node:os');
          const path = require('node:path');
          const { execSync } = require('node:child_process');
          const projectDir = path.join(os.homedir(), '.neuronest', 'projects', activeSessionId);

          // Run lint if enabled and command is configured
          if (lintTestConfig.lintEnabled && lintTestConfig.lintCommand) {
            sendAndStore(mainWindow, {
              role: 'assistant',
              content: '🔍 Running linter: `' + lintTestConfig.lintCommand + '`...',
              isCommand: true, agent: 'Lint & Test',
            });
            let lintOutput = '';
            let lintExitCode = 0;

            if (PERF_FLAGS.ASYNC_COMMANDS) {
              // Async execution via AsyncCommandRunner
              const lintResult = await asyncCommandRunner.execute(
                lintTestConfig.lintCommand,
                { cwd: projectDir, timeout: 60000 },
                (progress) => {
                  // Stream real-time output to renderer
                  mainWindow.webContents.send('command-output', {
                    type: 'lint',
                    stream: progress.stream,
                    chunk: progress.chunk,
                    commandId: progress.commandId,
                  });
                }
              );
              lintExitCode = lintResult.exitCode;
              lintOutput = lintResult.stdout + (lintResult.stderr ? '\n' + lintResult.stderr : '');
            } else {
              // Fallback to synchronous execution
              try {
                lintOutput = execSync(lintTestConfig.lintCommand, { cwd: projectDir, timeout: 60000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              } catch (lintErr: any) {
                lintExitCode = lintErr.status || 1;
                lintOutput = (lintErr.stdout || '') + '\n' + (lintErr.stderr || '');
              }
            }

            lintTestServiceRef.recordRun(activeSessionId, 'lint', lintTestConfig.lintCommand, lintExitCode, lintOutput, 'auto-ai-change');

            if (lintExitCode === 0) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '✅ Lint passed',
                isCommand: true, agent: 'Lint & Test',
              });
            } else {
              const truncatedLintOutput = lintOutput.trim().slice(0, 1500);
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '⚠️ Lint issues found (exit code ' + lintExitCode + '):\n```\n' + truncatedLintOutput + '\n```',
                isCommand: true, agent: 'Lint & Test',
              });

              // Desktop notification: check failed
              sendDesktopNotification(activeSessionId, 'onCheckFailed', '⚠️ Lint Failed', 'Lint issues found (exit code ' + lintExitCode + ')');

              // Auto-fix if enabled
              if (lintTestConfig.autoFix) {
                const fixCommand = lintTestConfig.lintCommand + ' --fix';

                if (PERF_FLAGS.ASYNC_COMMANDS) {
                  // Async fix execution
                  const fixResult = await asyncCommandRunner.execute(
                    fixCommand,
                    { cwd: projectDir, timeout: 60000 },
                    (progress) => {
                      mainWindow.webContents.send('command-output', {
                        type: 'fix',
                        stream: progress.stream,
                        chunk: progress.chunk,
                        commandId: progress.commandId,
                      });
                    }
                  );
                  if (fixResult.exitCode === 0) {
                    lintTestServiceRef.recordRun(activeSessionId, 'lint', fixCommand, 0, 'Auto-fix applied', 'auto-fix', true);
                    sendAndStore(mainWindow, {
                      role: 'assistant',
                      content: '🔧 Auto-fix applied: `' + fixCommand + '`',
                      isCommand: true, agent: 'Lint & Test',
                    });
                    notifyProjectFilesUpdated(activeSessionId);
                  } else {
                    console.warn('[Lint & Test] Auto-fix failed (exit code ' + fixResult.exitCode + ')');
                  }
                } else {
                  // Fallback to synchronous fix execution
                  try {
                    execSync(fixCommand, { cwd: projectDir, timeout: 60000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
                    lintTestServiceRef.recordRun(activeSessionId, 'lint', fixCommand, 0, 'Auto-fix applied', 'auto-fix', true);
                    sendAndStore(mainWindow, {
                      role: 'assistant',
                      content: '🔧 Auto-fix applied: `' + fixCommand + '`',
                      isCommand: true, agent: 'Lint & Test',
                    });
                    notifyProjectFilesUpdated(activeSessionId);
                  } catch (fixErr: any) {
                    console.warn('[Lint & Test] Auto-fix failed:', fixErr.message);
                  }
                }
              }
            }
          }

          // Run tests if enabled and command is configured
          if (lintTestConfig.testEnabled && lintTestConfig.testCommand) {
            sendAndStore(mainWindow, {
              role: 'assistant',
              content: '🧪 Running tests: `' + lintTestConfig.testCommand + '`...',
              isCommand: true, agent: 'Lint & Test',
            });
            let testOutput = '';
            let testExitCode = 0;

            if (PERF_FLAGS.ASYNC_COMMANDS) {
              // Async execution via AsyncCommandRunner
              const testResult = await asyncCommandRunner.execute(
                lintTestConfig.testCommand,
                { cwd: projectDir, timeout: 120000 },
                (progress) => {
                  // Stream real-time output to renderer
                  mainWindow.webContents.send('command-output', {
                    type: 'test',
                    stream: progress.stream,
                    chunk: progress.chunk,
                    commandId: progress.commandId,
                  });
                }
              );
              testExitCode = testResult.exitCode;
              testOutput = testResult.stdout + (testResult.stderr ? '\n' + testResult.stderr : '');
            } else {
              // Fallback to synchronous execution
              try {
                testOutput = execSync(lintTestConfig.testCommand, { cwd: projectDir, timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              } catch (testErr: any) {
                testExitCode = testErr.status || 1;
                testOutput = (testErr.stdout || '') + '\n' + (testErr.stderr || '');
              }
            }

            lintTestServiceRef.recordRun(activeSessionId, 'test', lintTestConfig.testCommand, testExitCode, testOutput, 'auto-ai-change');

            if (testExitCode === 0) {
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '✅ Tests passed',
                isCommand: true, agent: 'Lint & Test',
              });
            } else {
              const truncatedTestOutput = testOutput.trim().slice(0, 1500);
              sendAndStore(mainWindow, {
                role: 'assistant',
                content: '❌ Tests failed (exit code ' + testExitCode + '):\n```\n' + truncatedTestOutput + '\n```',
                isCommand: true, agent: 'Lint & Test',
              });

              // Desktop notification: check failed
              sendDesktopNotification(activeSessionId, 'onCheckFailed', '❌ Tests Failed', 'Tests failed (exit code ' + testExitCode + ')');
            }
          }
        }
      } catch (lintTestErr: any) {
        console.error('[IPC] Auto lint-test error:', lintTestErr);
      }
    }

    // ── Autonomy: Auto-Build ──
    if (activeSessionId && autonomyConfig && autonomyConfig.autoBuild && totalFiles > 0) {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const fs = require('node:fs');
        const { execSync } = require('node:child_process');
        const projectDir = path.join(os.homedir(), '.neuronest', 'projects', activeSessionId);

        // Detect build command from project
        let buildCommand = '';
        const pkgPath = path.join(projectDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.build) buildCommand = 'npm run build';
            else if (pkg.scripts?.compile) buildCommand = 'npm run compile';
          } catch {}
        }
        if (!buildCommand && fs.existsSync(path.join(projectDir, 'Makefile'))) buildCommand = 'make';
        if (!buildCommand && fs.existsSync(path.join(projectDir, 'Cargo.toml'))) buildCommand = 'cargo build';

        // Pre-flight: when the build is an npm script that shells out to a
        // locally-installed tool (e.g. CRA's `react-scripts build`), make sure
        // that tool is actually present before running. If dependencies didn't
        // install, running anyway only yields a confusing "command not found"
        // (exit 127) — so we skip with an actionable message instead.
        if (buildCommand) {
          const readiness = checkBuildReadiness(projectDir, buildCommand);
          if (!readiness.ready) {
            sendAndStore(mainWindow, {
              role: 'assistant',
              content:
                '⏭️ Skipped auto-build (`' + buildCommand + '`): ' + readiness.reason +
                '.\n\nRun `npm install` in the project, then build again.',
              isCommand: true, agent: 'Autonomy',
            });
            if (autonomyConfig.autoDebug) {
              mainWindow.webContents.send('autonomy-action', {
                type: 'debug-suggestion',
                error:
                  'Build skipped — ' + readiness.reason +
                  (readiness.missingTool ? ' (missing tool: ' + readiness.missingTool + ')' : '') +
                  '. Dependencies must be installed before `' + buildCommand + '` can run.',
                command: buildCommand,
              });
            }
            buildCommand = ''; // suppress the build attempt below
          }
        }

        if (buildCommand) {
          sendAndStore(mainWindow, {
            role: 'assistant',
            content: '🔨 Auto-building: `' + buildCommand + '`...',
            isCommand: true, agent: 'Autonomy',
          });
          let buildOutput = '';
          let buildExitCode = 0;

          if (PERF_FLAGS.ASYNC_COMMANDS) {
            // Async execution via AsyncCommandRunner
            const buildResult = await asyncCommandRunner.execute(
              buildCommand,
              { cwd: projectDir, timeout: 120000 },
              (progress) => {
                // Stream real-time output to renderer
                mainWindow.webContents.send('command-output', {
                  type: 'build',
                  stream: progress.stream,
                  chunk: progress.chunk,
                  commandId: progress.commandId,
                });
              }
            );
            buildExitCode = buildResult.exitCode;
            buildOutput = buildResult.stdout + (buildResult.stderr ? '\n' + buildResult.stderr : '');
          } else {
            // Fallback to synchronous execution
            try {
              buildOutput = execSync(buildCommand, { cwd: projectDir, timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (buildErr: any) {
              buildExitCode = buildErr.status || 1;
              buildOutput = (buildErr.stdout || '') + '\n' + (buildErr.stderr || '');
            }
          }

          if (buildExitCode === 0) {
            sendAndStore(mainWindow, { role: 'assistant', content: '✅ Build succeeded', isCommand: true, agent: 'Autonomy' });
          } else {
            const truncBuild = buildOutput.trim().slice(0, 1000);
            sendAndStore(mainWindow, { role: 'assistant', content: '⚠️ Build failed (exit ' + buildExitCode + '):\n```\n' + truncBuild + '\n```', isCommand: true, agent: 'Autonomy' });
            sendDesktopNotification(activeSessionId, 'onCheckFailed', '⚠️ Build Failed', 'Build failed (exit code ' + buildExitCode + ')');

            // Auto-debug: if enabled, report the error back for the AI to fix
            if (autonomyConfig.autoDebug) {
              sendAndStore(mainWindow, { role: 'assistant', content: '🐛 Auto-debug: build error detected, queuing fix...', isCommand: true, agent: 'Autonomy' });
              // Send the error as a follow-up message to the renderer for the user to see
              mainWindow.webContents.send('autonomy-action', { type: 'debug-suggestion', error: truncBuild, command: buildCommand });
            }
          }
        }
      } catch (buildErr: any) {
        console.error('[IPC] Auto-build error:', buildErr);
      }
    }

    // ── Autonomy: Auto-Commit ──
    if (activeSessionId && autonomyConfig && autonomyConfig.autoCommit && totalFiles > 0) {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const fs = require('node:fs');
        const { execSync } = require('node:child_process');
        const projectDir = path.join(os.homedir(), '.neuronest', 'projects', activeSessionId);

        // Check if it's a git repo
        const gitDir = path.join(projectDir, '.git');
        if (fs.existsSync(gitDir)) {
          // Stage all changes and commit
          try {
            const { execFileSync } = require('node:child_process');
            execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            if (status) {
              const commitMsg = 'feat: AI-generated changes (' + totalFiles + ' files)';
              execFileSync('git', ['commit', '-m', commitMsg], { cwd: projectDir, timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              sendAndStore(mainWindow, { role: 'assistant', content: '📝 Auto-committed: "' + commitMsg + '"', isCommand: true, agent: 'Autonomy' });
            }
          } catch (gitErr: any) {
            console.warn('[Autonomy] Auto-commit failed:', gitErr.message);
          }
        } else {
          // Initialize git repo if autoCommit is on but no repo exists
          try {
            execSync('git init && git add -A && git commit -m "Initial commit from NeuroNest"', { cwd: projectDir, timeout: 15000, encoding: 'utf-8', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', stdio: ['pipe', 'pipe', 'pipe'] });
            sendAndStore(mainWindow, { role: 'assistant', content: '📝 Auto-commit: initialized git repo and committed ' + totalFiles + ' files', isCommand: true, agent: 'Autonomy' });
          } catch (initErr: any) {
            console.warn('[Autonomy] Git init failed:', initErr.message);
          }
        }
      } catch (commitErr: any) {
        console.error('[IPC] Auto-commit error:', commitErr);
      }
    }

    // ── Pipeline Trace: end recording ──
    if (traceService && traceId) {
      try {
        traceService.recordSpan(traceId, activeSessionId, 'agent_execution', agentExecStartTime, Date.now(), { metadata: { agentCount: plan.agents.length, topology: plan.topology } });
        traceService.endTrace(activeSessionId);
      } catch {}
    }
    
    } catch (err: any) {
      console.error('[IPC] chat-message handler error:', err);
      // Error_Capture_Helper (task 14, Requirement 2.7). The orchestrator's
      // top-level chat-message dispatcher is one of the three migration
      // sites named by the spec; landing an `error.captured` event here
      // gives the unified state reducer a record of every dispatcher
      // failure even when downstream subsystems have already returned.
      // Augments — does not replace — the existing console.error and the
      // user-facing pipeline-error response below.
      try {
        captureError('ipc.chat-message', err, activeSessionId ?? null);
      } catch { /* never let logging crash the error path */ }
      // Always send completion signal so the brain stops spinning
      try {
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: '❌ **Pipeline Error** — ' + (err?.message || String(err)),
          isCommand: true, agent: 'System',
        });
        sendAndStore(mainWindow, {
          role: 'assistant',
          content: '📊 **Pipeline stopped due to error**',
          agent: 'NeuroNest',
        });
      } catch {}
    }
  });

  // ── Session management ──

  ipcMain.on('project-create', (_event, arg: any) => {
    const name = typeof arg === 'object' && arg !== null ? arg.name : arg;
    const session = sessionManager.create({ name: name || `Session ${Date.now()}` });
    activeSessionId = session.id;
    
    // Store the active project in config for persistence
    try {
      db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('activeProjectId', session.id, new Date().toISOString());
      console.log('[IPC] Saved newly created active project to config:', session.id);
    } catch (configError) {
      console.warn('[IPC] Failed to save newly created active project to config:', configError);
    }
    
    mainWindow.webContents.send('project-updated', {
      action: 'created', id: session.id, name: session.name,
    });
    // Send updated session list
    const sessions = sessionManager.list().map(s => ({
      id: s.id, name: s.name, messageCount: s.messageCount,
    }));
    mainWindow.webContents.send('projects-list', sessions);
    mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
  });

  ipcMain.on('project-open', async (_event, arg: any) => {
    try {
      const sessionId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      const session = await sessionManager.open(sessionId);
      
      activeSessionId = session.id;
      
      // Load project context files (NEURONEST.md, AGENTS.md, etc.)
      try {
        const os = require('node:os');
        const projDir = require('node:path').join(os.homedir(), '.neuronest', 'projects', session.id);
        projectContextCache = loadProjectContextFiles(projDir);
        if (projectContextCache) console.log('[IPC] Loaded project context files (' + projectContextCache.length + ' chars)');
      } catch { projectContextCache = ''; }

      // Store the active project in config for persistence (only if changed)
      try {
        setCachedConfig('activeProjectId', session.id);
      } catch (configError) {
        console.warn('[IPC] Failed to save active project to config:', configError);
      }

      // Start the indexing pipeline for this project
      try {
        const indexingConfig = loadIndexingConfig();
        startIndexingPipeline(indexingConfig);
      } catch (indexingError) {
        console.warn('[IPC] Failed to start indexing pipeline on project open:', indexingError);
      }
      
      const messages = session.messages.map(m => ({
        role: m.role, content: m.content,
        agent: m.toolCalls ? JSON.parse(JSON.stringify(m.toolCalls)).agent : undefined,
        isCommand: m.role === 'system',
      }));
      mainWindow.webContents.send('project-opened', {
        id: session.id, name: session.name, messages,
      });
      mainWindow.webContents.send('active-project', { id: session.id, name: session.name });
    } catch (e) {
      console.error('[IPC] project-open error:', e);
    }
  });

  ipcMain.on('project-rename', (_event, arg: any) => {
    try {
      let id, name;
      if (typeof arg === 'object' && arg !== null) {
        id = arg.projectId || arg.id;
        name = arg.name;
      } else {
        const parsed = JSON.parse(arg);
        id = parsed.id;
        name = parsed.name;
      }
      sessionManager.rename(id, name);
      console.log('[IPC] Project renamed:', id, '->', name);
      const projects = sessionManager.list().map(s => ({
        id: s.id, name: s.name, messageCount: s.messageCount,
      }));
      mainWindow.webContents.send('projects-list', projects);
    } catch (e) { console.error('[IPC] project-rename error:', e); }
  });

  ipcMain.on('project-delete', (_event, arg: any) => {
    try {
      const sessionId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      sessionManager.delete(sessionId);
      mainWindow.webContents.send('project-updated', { action: 'deleted', id: sessionId });
      const sessions = sessionManager.list().map(s => ({
        id: s.id, name: s.name, messageCount: s.messageCount,
      }));
      mainWindow.webContents.send('projects-list', sessions);
    } catch {
      // ignore
    }
  });

  // ── Agent selection ──

  ipcMain.handle('validate-api-key', async (_ev, arg: any) => {
    try {
      let provider, apiKey, baseUrl;
      if (typeof arg === 'object' && arg !== null) {
        provider = arg.type || arg.provider;
        apiKey = arg.apiKey;
        baseUrl = arg.baseUrl;
      } else {
        const parsed = JSON.parse(arg);
        provider = parsed.provider;
        apiKey = parsed.apiKey;
        baseUrl = parsed.baseUrl;
      }
      const isLocal = ['ollama', 'llamacpp'].includes(provider);

      if (isLocal) {
        // For local providers, try to reach the base URL
        const url = baseUrl || 'http://localhost:11434';
        const http = require('node:http');
        const https = require('node:https');
        const mod = url.startsWith('https') ? https : http;
        return await new Promise((resolve) => {
          const req = mod.get(url + '/api/tags', { timeout: 5000 }, (res: any) => {
            let body = '';
            res.on('data', (c: any) => body += c);
            res.on('end', () => { resolve({ valid: true, message: 'Connected to ' + url }); });
          });
          req.on('error', () => resolve({ valid: false, message: 'Cannot reach ' + url + '. Is the server running?' }));
          req.on('timeout', () => { req.destroy(); resolve({ valid: false, message: 'Connection timed out' }); });
        });
      }

      // For remote providers, make a lightweight API call
      const endpoints: Record<string, { url: string; headers: Record<string, string> }> = {
        openai: { url: 'https://api.openai.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        anthropic: { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
        deepseek: { url: 'https://api.deepseek.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey, headers: {} },
        mistral: { url: 'https://api.mistral.ai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        grok: { url: 'https://api.x.ai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        groq: { url: 'https://api.groq.com/openai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
      };

      const ep = endpoints[provider];
      if (!ep) return { valid: false, message: 'Unknown provider: ' + provider };

      const https = require('node:https');
      const http = require('node:http');
      const urlMod = require('node:url');
      const parsed = new URL(ep.url);

      return await new Promise((resolve) => {
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get(ep.url, { headers: ep.headers, timeout: 10000 }, (res: any) => {
          let body = '';
          res.on('data', (c: any) => body += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ valid: true, message: 'API key verified successfully' });
            } else if (res.statusCode === 401 || res.statusCode === 403) {
              resolve({ valid: false, message: 'Invalid API key (HTTP ' + res.statusCode + ')' });
            } else {
              resolve({ valid: false, message: 'API returned HTTP ' + res.statusCode });
            }
          });
        });
        req.on('error', (e: any) => resolve({ valid: false, message: 'Connection error: ' + e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ valid: false, message: 'Request timed out' }); });
      });
    } catch (e) { return { valid: false, message: 'Validation error: ' + String(e) }; }
  });

  ipcMain.handle('list-provider-models', async (_ev, arg: any) => {
    try {
      let provider, apiKey, baseUrl, professionalMode;
      if (typeof arg === 'object' && arg !== null) {
        provider = arg.type || arg.provider || arg.name;
        apiKey = arg.apiKey;
        baseUrl = arg.baseUrl;
        professionalMode = arg.professionalMode === true;
      } else {
        const parsed = JSON.parse(arg);
        provider = parsed.provider;
        apiKey = parsed.apiKey;
        baseUrl = parsed.baseUrl;
        professionalMode = parsed.professionalMode === true;
      }

      // OpenMythos: return static model variants
      if (provider === 'openmythos') {
        return [
          { id: 'mythos_1b', installed: true },
          { id: 'mythos_3b', installed: true },
          { id: 'mythos_10b', installed: true },
          { id: 'mythos_50b', installed: true },
          { id: 'mythos_100b', installed: true },
          { id: 'mythos_500b', installed: true },
          { id: 'mythos_1t', installed: true },
        ];
      }

      const isLocal = ['ollama', 'llamacpp'].includes(provider);

      if (isLocal) {
        const url = (baseUrl || 'http://localhost:11434');
        const http = require('node:http');
        const https = require('node:https');
        const mod = url.startsWith('https') ? https : http;

        // Popular models for local providers (shown when server not running)
        const OLLAMA_POPULAR = [
          'llama3.2:latest', 'llama3.3:latest', 'llama3.1:latest', 'llama3:latest',
          'codellama:latest', 'deepseek-coder-v2:latest', 'deepseek-r1:latest',
          'mistral:latest', 'mixtral:latest', 'phi3:latest', 'phi4:latest',
          'gemma2:latest', 'qwen2.5:latest', 'qwen2.5-coder:latest',
          'starcoder2:latest', 'codegemma:latest', 'nomic-embed-text:latest',
          'llava:latest', 'command-r:latest', 'wizardcoder:latest',
        ];
        const LLAMACPP_POPULAR = [
          'llama-3.3-70b-instruct-Q4_K_M.gguf',
          'llama-3.2-3b-instruct-Q4_K_M.gguf',
          'llama-3.1-8b-instruct-Q4_K_M.gguf',
          'mistral-7b-instruct-v0.3-Q4_K_M.gguf',
          'mixtral-8x7b-instruct-v0.1-Q4_K_M.gguf',
          'phi-4-Q4_K_M.gguf',
          'phi-3.5-mini-instruct-Q4_K_M.gguf',
          'gemma-2-9b-it-Q4_K_M.gguf',
          'gemma-2-2b-it-Q4_K_M.gguf',
          'qwen2.5-7b-instruct-Q4_K_M.gguf',
          'qwen2.5-coder-7b-instruct-Q4_K_M.gguf',
          'deepseek-coder-v2-lite-instruct-Q4_K_M.gguf',
          'deepseek-r1-distill-qwen-7b-Q4_K_M.gguf',
          'codellama-13b-instruct-Q4_K_M.gguf',
          'starcoder2-7b-Q4_K_M.gguf',
          'yi-1.5-9b-chat-Q4_K_M.gguf',
          'command-r-35b-Q4_K_M.gguf',
          'solar-10.7b-instruct-Q4_K_M.gguf',
          'tinyllama-1.1b-chat-v1.0-Q4_K_M.gguf',
          'nomic-embed-text-v1.5-Q4_K_M.gguf',
        ];

        if (provider === 'ollama') {
          const installed: string[] = await new Promise((resolve) => {
            const req = mod.get(url + '/api/tags', { timeout: 5000 }, (res: any) => {
              let body = '';
              res.on('data', (c: any) => body += c);
              res.on('end', () => {
                try { const d = JSON.parse(body); resolve((d.models || []).map((m: any) => m.name || m.model)); }
                catch { resolve([]); }
              });
            });
            req.on('error', () => resolve([]));
          });
          // Return installed models + popular ones not yet installed
          if (installed.length > 0) {
            const installedSet = new Set(installed);
            const available = OLLAMA_POPULAR.filter(m => !installedSet.has(m));
            return [...installed.map(m => ({ id: m, installed: true })), ...available.map(m => ({ id: m, installed: false }))];
          }
          // Server not running — return popular models list
          return OLLAMA_POPULAR.map(m => ({ id: m, installed: false }));
        }
        // llama.cpp
        const llamaModels: string[] = await new Promise((resolve) => {
          const req = mod.get(url + '/v1/models', { timeout: 5000 }, (res: any) => {
            let body = '';
            res.on('data', (c: any) => body += c);
            res.on('end', () => {
              try { const d = JSON.parse(body); resolve((d.data || []).map((m: any) => m.id)); }
              catch { resolve([]); }
            });
          });
          req.on('error', () => resolve([]));
        });
        return llamaModels.length > 0 ? llamaModels.map((m: string) => ({ id: m, installed: true })) : LLAMACPP_POPULAR.map(m => ({ id: m, installed: false }));
      }

      // Professional mode for cloud providers: return the static catalog
      // from src/data/model-prices.json. The user's per-provider apiKey is
      // not set in pro mode (chat completions route through the LLM proxy
      // with the licenseKey as bearer), so the direct upstream /v1/models
      // call below would fail. The static catalog is what the LLM proxy
      // bills against anyway, so it's the authoritative list for pro users.
      // Local providers (ollama/llamacpp/openmythos) handled their own
      // branches above and never reach here.
      if (professionalMode) {
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          const pricingPath = path.join(__dirname, '../data/model-prices.json');
          const raw = fs.readFileSync(pricingPath, 'utf-8');
          const table = JSON.parse(raw) as Record<string, Record<string, unknown>>;
          const providerEntry = table[provider];
          if (providerEntry) {
            const ids = Object.keys(providerEntry).filter((k) => k !== '_default');
            return ids.map((id) => ({ id, installed: true }));
          }
          // Provider not in the catalog — return empty rather than falling
          // through to the upstream /v1/models call (which would fail
          // without a real apiKey).
          return [];
        } catch (err) {
          // Catalog read failed (corrupted JSON, bundle miss). Fall through
          // to the upstream call as a last resort; in pro mode it'll likely
          // 401 but the empty array is the same end-state for the UI.
        }
      }

      // Remote providers
      const endpoints: Record<string, { url: string; headers: Record<string, string> }> = {
        openai: { url: 'https://api.openai.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        anthropic: { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
        deepseek: { url: 'https://api.deepseek.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey, headers: {} },
        mistral: { url: 'https://api.mistral.ai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        grok: { url: 'https://api.x.ai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        groq: { url: 'https://api.groq.com/openai/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
        nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', headers: { 'Authorization': 'Bearer ' + apiKey } },
      };

      const ep = endpoints[provider];
      if (!ep) return [];

      const https = require('node:https');
      const http = require('node:http');
      const parsed = new URL(ep.url);

      return await new Promise((resolve) => {
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get(ep.url, { headers: ep.headers, timeout: 10000 }, (res: any) => {
          let body = '';
          res.on('data', (c: any) => body += c);
          res.on('end', () => {
            try {
              const d = JSON.parse(body);
              if (provider === 'gemini') {
                resolve((d.models || []).map((m: any) => (m.name || '').replace('models/', '')));
              } else if (provider === 'anthropic') {
                resolve((d.data || []).map((m: any) => m.id));
              } else {
                resolve((d.data || []).map((m: any) => m.id));
              }
            } catch { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
      });
    } catch { return []; }
  });

  ipcMain.handle('save-providers', async (_ev, arg: any) => {
    try {
      const providersJson = typeof arg === 'string' ? arg : JSON.stringify(arg);
      setCachedConfig('providers', providersJson);

      // Re-register providers with health monitor when config changes
      if (providerHealthRef) {
        try {
          const providers = typeof arg === 'string' ? JSON.parse(arg) : (arg || []);
          const providerBaseUrls: Record<string, string> = {
            openai: 'https://api.openai.com/v1',
            anthropic: 'https://api.anthropic.com/v1',
            deepseek: 'https://api.deepseek.com',
            gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
            grok: 'https://api.x.ai/v1',
            mistral: 'https://api.mistral.ai/v1',
            nvidia: 'https://integrate.api.nvidia.com/v1',
            groq: 'https://api.groq.com/openai/v1',
            ollama: 'http://localhost:11434/v1',
            llamacpp: 'http://localhost:8080/v1',
            openmythos: 'http://localhost:8200/v1',
          };
          const activeIds: string[] = [];
          for (const p of providers) {
            const baseUrl = p.baseUrl || providerBaseUrls[p.type] || '';
            const id = p.name || p.type;
            if (baseUrl) {
              providerHealthRef.registerProvider(
                id,
                id,
                baseUrl,
                p.defaultModel || p.model || 'default',
                p.apiKey || ''
              );
              activeIds.push(id);
            }
          }
          // Remove providers that no longer exist
          providerHealthRef.syncProviderIds(activeIds);
        } catch {}
      }

      return { success: true };
    } catch (e) { return { success: false, error: String(e) }; }
  });

  ipcMain.handle('load-providers', async () => {
    try {
      return getCachedConfig('providers') || '[]';
    } catch { return '[]'; }
  });

  ipcMain.handle('get-agent-model', async (_ev, arg: any) => {
    try {
      const agentId = typeof arg === 'object' && arg !== null ? (arg.agent || arg.agentId) : arg;
      const profileId = getActiveProfileId();
      // Try profile-scoped key first, fall back to legacy unscoped key
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get('agent-model:' + profileId + ':' + agentId) as any;
      if (row) { try { return JSON.parse(row.value); } catch { return row.value; } }
      // Fallback: legacy unscoped key (for migration)
      const legacyRow = db.prepare("SELECT value FROM config WHERE key = ?").get('agent-model:' + agentId) as any;
      if (legacyRow) { try { return JSON.parse(legacyRow.value); } catch { return legacyRow.value; } }
      return null;
    } catch { return null; }
  });

  ipcMain.on('save-agent-model', (_event, arg: any) => {
    try {
      let parsed;
      if (typeof arg === 'object' && arg !== null) {
        parsed = arg;
      } else {
        parsed = JSON.parse(arg);
      }
      const agentId = parsed.agent || parsed.agentId;
      const profileId = getActiveProfileId();
      const valueObj: Record<string, any> = { provider: parsed.provider || '', model: parsed.model || '' };
      if (parsed.nLoops != null) {
        const n = Math.max(1, Math.min(32, Math.round(Number(parsed.nLoops))));
        if (Number.isFinite(n)) valueObj.nLoops = n;
      }
      const value = JSON.stringify(valueObj);
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)").run(
        'agent-model:' + profileId + ':' + agentId, value, new Date().toISOString()
      );
      console.log('[IPC] Agent model saved (profile ' + profileId.slice(0, 8) + '):', agentId, '->', value);
    } catch (e) { console.error('[IPC] save-agent-model error:', e); }
  });

  // Test LLM connection for debugging
  ipcMain.handle('test-llm-connection', async (_ev, arg: any) => {
    try {
      let providerConfig;
      if (typeof arg === 'object' && arg !== null) {
        providerConfig = arg;
      } else {
        providerConfig = JSON.parse(arg);
      }

      const llmClient = createLLMClientWithProMode(providerConfig);
      if (!llmClient) {
        return { success: false, message: 'Failed to create LLM client from config' };
      }

      const result = await llmClient.testConnection();
      console.log('[IPC] LLM connection test:', providerConfig.name || providerConfig.type, '->', result);
      return result;
    } catch (e: any) {
      console.error('[IPC] test-llm-connection error:', e);
      return { success: false, message: 'Test failed: ' + e.message };
    }
  });

  ipcMain.handle('install-ollama', async () => {
    try {
      const result = await installOllama((msg) => {
        mainWindow.webContents.send('chat-response', { role: 'assistant', content: msg, isCommand: true, agent: 'System' });
      });
      return result;
    } catch (e) { return { success: false, message: String(e) }; }
  });

  ipcMain.handle('start-ollama', async () => { try { const r = await startOllama(); if (r.started) refreshLocalModelLists(); return r; } catch (e) { return { started: false, message: String(e) }; } });
  ipcMain.handle('stop-ollama', async () => { stopOllama(); return { success: true }; });
  ipcMain.handle('start-llamacpp', async () => { try { const r = await startLlamaCpp(); if (r.started) refreshLocalModelLists(); return r; } catch (e) { return { started: false, message: String(e) }; } });
  ipcMain.handle('stop-llamacpp', async () => { stopLlamaCpp(); return { success: true }; });
  ipcMain.handle('uninstall-ollama', async () => { try { return await uninstallOllama(); } catch (e) { return { success: false, message: String(e) }; } });
  ipcMain.handle('uninstall-llamacpp', async () => { try { return await uninstallLlamaCpp(); } catch (e) { return { success: false, message: String(e) }; } });
  ipcMain.handle('set-default-provider', async (_ev, arg: any) => {
    try {
      const data = typeof arg === 'string' ? arg : JSON.stringify(arg);
      setCachedConfig('default-provider', data);
      return { success: true };
    } catch (e) { return { success: false, error: String(e) }; }
  });

  ipcMain.handle('get-default-provider', async () => {
    try {
      return getCachedConfig('default-provider') || null;
    } catch { return null; }
  });

  // ── Execution Mode Router ──
  ipcMain.handle('get-execution-mode', async () => {
    try {
      return getCachedConfig('execution-mode') || 'auto';
    } catch { return 'auto'; }
  });

  ipcMain.handle('set-execution-mode', async (_ev, arg: any) => {
    try {
      const mode = typeof arg === 'string' ? arg : arg?.mode || 'auto';
      if (!['auto', 'flash', 'standard', 'pro', 'ultra'].includes(mode)) {
        return { success: false, error: 'Invalid mode. Use: auto, flash, standard, pro, ultra' };
      }
      setCachedConfig('execution-mode', mode);
      return { success: true, mode };
    } catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('pull-ollama-model', async (_ev, arg: any) => {
    try {
      const modelName = typeof arg === 'object' && arg !== null ? arg.model : arg;
      if (!modelName) return { success: false, message: 'No model name provided' };

      // Use Ollama API for streaming pull with progress
      const http = require('node:http');
      return new Promise((resolve) => {
        const body = JSON.stringify({ name: modelName, stream: true });
        const req = http.request('http://localhost:11434/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 600000,
        }, (res: any) => {
          let lastStatus = '';
          res.on('data', (chunk: any) => {
            const lines = chunk.toString().split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                lastStatus = data.status || '';
                // Send progress to renderer
                mainWindow.webContents.send('model-pull-progress', {
                  model: modelName,
                  status: data.status || '',
                  digest: data.digest || '',
                  total: data.total || 0,
                  completed: data.completed || 0,
                  done: false,
                });
              } catch {}
            }
          });
          res.on('end', () => {
            mainWindow.webContents.send('model-pull-progress', { model: modelName, status: 'complete', done: true });
            // Refresh cached model list after successful pull
            refreshLocalModelLists();
            resolve({ success: true, message: modelName + ' downloaded' });
          });
        });
        req.on('error', (e: any) => {
          mainWindow.webContents.send('model-pull-progress', { model: modelName, status: 'error', error: e.message, done: true });
          resolve({ success: false, message: 'Pull failed: ' + e.message });
        });
        req.on('timeout', () => {
          req.destroy();
          mainWindow.webContents.send('model-pull-progress', { model: modelName, status: 'timeout', done: true });
          resolve({ success: false, message: 'Pull timed out' });
        });
        req.write(body);
        req.end();
      });
    } catch (e: any) { return { success: false, message: 'Failed: ' + (e.message || '').slice(0, 100) }; }
  });

  ipcMain.handle('get-ollama-status', async () => { return getOllamaStatus(); });
  ipcMain.handle('get-llamacpp-status', async () => { return getLlamaCppStatus(); });
  ipcMain.handle('get-openmythos-status', async () => { return getOpenMythosStatus(); });
  ipcMain.handle('install-openmythos', async () => { try { const r = await installOpenMythos(); return r; } catch (e) { return { success: false, message: String(e) }; } });
  ipcMain.handle('start-openmythos', async () => { try { const r = await startOpenMythos(); return r; } catch (e) { return { started: false, message: String(e) }; } });
  ipcMain.handle('stop-openmythos', async () => { stopOpenMythos(); return { success: true }; });
  ipcMain.handle('uninstall-openmythos', async () => { try { const r = await uninstallOpenMythos(); return r; } catch (e) { return { success: false, message: String(e) }; } });

  ipcMain.handle('install-llamacpp', async () => {
    try {
      sendAndStore(mainWindow, { role: 'assistant', content: 'Installing llama.cpp... This may take a few minutes.', isCommand: true, agent: 'System' });
      const result = await installLlamaCpp((msg) => {
        sendAndStore(mainWindow, { role: 'assistant', content: '⏳ ' + msg, isCommand: true, agent: 'System' });
      });
      sendAndStore(mainWindow, { role: 'assistant', content: result.success ? '\u2705 ' + result.message : '\u274C ' + result.message, isCommand: true, agent: 'System' });
      return result;
    } catch (e) { return { success: false, message: String(e) }; }
  });

  ipcMain.handle('get-project-files', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;

      // Use FileTreeCache when feature flag is enabled
      if (PERF_FLAGS.FILE_TREE_CACHE) {
        const fileTreeCache = FileTreeCache.getInstance();
        return await fileTreeCache.getTree(projectId);
      }

      // Fallback: original synchronous walk when feature flag is disabled
      const os = require('node:os');
      const fsP = require('node:fs').promises;
      const fs = require('node:fs');
      const path = require('node:path');
      const projectDir = path.join(os.homedir(), '.neuronest', 'projects', projectId);
      if (!fs.existsSync(projectDir)) return [];
      async function walk(dir: string, prefix: string = ''): Promise<any[]> {
        const entries = await fsP.readdir(dir, { withFileTypes: true });
        // Process all entries in parallel
        return Promise.all(entries.map(async (entry: any) => {
          const relPath = prefix ? prefix + '/' + entry.name : entry.name;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            return { name: entry.name, path: relPath, type: 'dir', children: await walk(fullPath, relPath) };
          } else {
            const stat = await fsP.stat(fullPath).catch(() => null);
            return { name: entry.name, path: relPath, type: 'file', size: stat?.size ?? 0 };
          }
        }));
      }
      return await walk(projectDir);
    } catch { return []; }
  });

  ipcMain.handle('read-project-file', async (_ev, arg: any) => {
    try {
      let projectId, filePath;
      if (typeof arg === 'object' && arg !== null) {
        projectId = arg.projectId;
        filePath = arg.filePath;
      } else {
        const parsed = JSON.parse(arg);
        projectId = parsed.projectId;
        filePath = parsed.filePath;
      }
      const os = require('node:os');
      const fs = require('node:fs');
      const path = require('node:path');
      const fullPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, filePath);

      // Open externally (for PDFs, images, etc.)
      if (arg && arg.openExternal) {
        if (fs.existsSync(fullPath)) {
          const { shell } = require('electron');
          shell.openPath(fullPath);
        }
        return null;
      }

      // Return absolute path only
      if (arg && arg.getAbsolutePath) {
        return fs.existsSync(fullPath) ? fullPath : null;
      }

      if (!fs.existsSync(fullPath)) return null;
      return await fs.promises.readFile(fullPath, 'utf-8');
    } catch { return null; }
  });

  ipcMain.on('save-project-file', (_event, arg: any) => {
    try {
      let projectId, filePath, content;
      if (typeof arg === 'object' && arg !== null) {
        projectId = arg.projectId;
        filePath = arg.filePath;
        content = arg.content;
      } else {
        const parsed = JSON.parse(arg);
        projectId = parsed.projectId;
        filePath = parsed.filePath;
        content = parsed.content;
      }
      const os = require('node:os');
      const fs = require('node:fs');
      const path = require('node:path');
      const fullPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, filePath);
      writeFileWithHeader(fullPath, content);
    } catch (e) { console.error('[IPC] save-project-file error:', e); }
  });

  ipcMain.handle('connect-channel', async (_ev, arg: any) => {
    try {
      let channelId, config;
      if (typeof arg === 'object' && arg !== null) {
        channelId = arg.channelId;
        config = arg.config;
      } else {
        const parsed = JSON.parse(arg);
        channelId = parsed.channelId;
        config = parsed.config;
      }
      console.log('[IPC] Connecting channel:', channelId);
      const result = await channelManager.connect(channelId, config);
      
      // Save config on successful connection for auto-reconnect on restart
      if (result.success) {
        try {
          const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
          const configs = row ? JSON.parse(row.value) : {};
          configs[channelId] = { ...config, autoConnect: true };
          db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('channel-configs', ?, ?)").run(JSON.stringify(configs), new Date().toISOString());
          console.log('[IPC] Channel config saved for auto-reconnect:', channelId);
        } catch (saveErr: any) {
          console.warn('[IPC] Failed to save channel config:', saveErr?.message);
        }
      }
      
      return result;
    } catch (e) { return { success: false, message: String(e) }; }
  });

  ipcMain.handle('disconnect-channel', async (_ev, arg: any) => {
    try {
      const channelId = typeof arg === 'object' && arg !== null ? arg.channelId : arg;
      await channelManager.disconnect(channelId);
      
      // Remove auto-connect flag and clear wasConnected on explicit disconnect
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
        if (row) {
          const configs = JSON.parse(row.value);
          if (configs[channelId]) {
            configs[channelId].autoConnect = false;
            configs[channelId].wasConnected = false;
            db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('channel-configs', ?, ?)").run(JSON.stringify(configs), new Date().toISOString());
          }
        }
      } catch {}
      
      return { success: true };
    } catch (e) { return { success: false, message: String(e) }; }
  });

  ipcMain.handle('send-channel-message', async (_ev, arg: any) => {
    try {
      let channelId, to, message;
      if (typeof arg === 'object' && arg !== null) {
        channelId = arg.channelId;
        to = arg.to;
        message = arg.message;
      } else {
        const parsed = JSON.parse(arg);
        channelId = parsed.channelId;
        to = parsed.to;
        message = parsed.message;
      }
      return await channelManager.sendMessage(channelId, to, message);
    } catch (e) { return { success: false, message: String(e) }; }
  });

  ipcMain.handle('get-channel-status', async (_ev, arg: any) => {
    const channelId = typeof arg === 'object' && arg !== null ? arg.channelId : arg;
    return channelManager.getStatus(channelId);
  });

  ipcMain.handle('get-channel-configs', async () => {
    try {
      const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
      return row ? JSON.parse(row.value) : {};
    } catch { return {}; }
  });

  ipcMain.on('save-channel-config', (_event, arg: any) => {
    try {
      const cfg = typeof arg === 'object' && arg !== null ? arg : JSON.parse(arg);
      const chId = cfg.channelId || cfg.id;
      const row = db.prepare("SELECT value FROM config WHERE key = 'channel-configs'").get() as any;
      const configs = row ? JSON.parse(row.value) : {};
      configs[chId] = cfg.config || cfg;
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('channel-configs', ?, ?)").run(JSON.stringify(configs), new Date().toISOString());
      console.log('[IPC] Channel config saved:', chId);
    } catch (e) { console.error('[IPC] save-channel-config error:', e); }
  });

  ipcMain.handle('get-integrations', async () => {
    const { INTEGRATION_CATEGORIES, INTEGRATIONS } = require('../integrations/integration-registry');
    return { categories: INTEGRATION_CATEGORIES, integrations: INTEGRATIONS };
  });

  // Avatar generation — local SVG robot avatars
  ipcMain.handle('generate-avatar', async (_ev, arg: any) => {
    try {
      const { generateAvatarDataUri } = require('./avatar-generator');
      const input = typeof arg === 'string' ? arg : (arg && arg.input ? arg.input : 'default');
      return { success: true, dataUri: generateAvatarDataUri(input) };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Avatar generation failed' };
    }
  });

  ipcMain.handle('get-dashboard-stats', async () => {
    try {
      const totalMessages = (cachedStmt("SELECT COUNT(*) as c FROM messages").get() as any).c;
      const totalProjects = (cachedStmt("SELECT COUNT(*) as c FROM sessions").get() as any).c;
      const totalTokens = parseInt(getCachedConfig('total-tokens') || '0') || 0;
      const configCost = parseFloat(getCachedConfig('total-cost') || '0') || 0;
      const totalCost = costStore ? costStore.getTotalCost() : configCost;
      const provJson = getCachedConfig('providers');
      const providers = provJson ? JSON.parse(provJson).length : 0;
      return { totalMessages, totalProjects, totalTokens, totalCost: totalCost.toFixed(4), providers, agents: AGENT_REGISTRY.length, departments: DEPARTMENTS.length };
    } catch (e) { return { totalMessages: 0, totalProjects: 0, totalTokens: 0, totalCost: '0.00', providers: 0, agents: AGENT_REGISTRY.length, departments: DEPARTMENTS.length }; }
  });

  ipcMain.handle('get-project-cost', async (_event, { projectId }: { projectId: string }) => {
    if (!costStore) return 0;
    return costStore.getProjectCost(projectId);
  });

  ipcMain.handle('get-cost-breakdown', async () => {
    if (!costStore) return { byProvider: [], byModel: [], byProject: [] };
    return costStore.getCostBreakdown();
  });

  // Cache for slow-changing data with intelligent TTL management
  let systemStatsCache: any = {
    gpu: null,
    battery: null,
    publicIP: null,
    sensors: null,
    fans: null,
    bluetooth: null,
    timestamps: {
      gpu: 0,
      battery: 0,
      publicIP: 0,
      sensors: 0,
      fans: 0,
      bluetooth: 0
    }
  };
  let slowDataPromise: Promise<any> | null = null;

  // TTL constants (in milliseconds)
  const CACHE_TTL = {
    GPU: 24 * 60 * 60 * 1000,      // 24 hours - hardware specs rarely change
    BATTERY: 60 * 60 * 1000,        // 1 hour - health/cycle count changes slowly
    PUBLIC_IP: 30 * 60 * 1000,      // 30 minutes - may change with network changes
    SENSORS: 5 * 60 * 1000,         // 5 minutes - temperature data changes moderately
    FANS: 5 * 60 * 1000,            // 5 minutes - fan speeds change moderately
    BLUETOOTH: 10 * 60 * 1000       // 10 minutes - bluetooth connections change occasionally
  };

  // Helper function to check if cache entry is valid
  const isCacheValid = (dataType: keyof typeof CACHE_TTL): boolean => {
    const keyMap: { [key: string]: string } = {
      'GPU': 'gpu',
      'BATTERY': 'battery', 
      'PUBLIC_IP': 'publicIP',
      'SENSORS': 'sensors',
      'FANS': 'fans',
      'BLUETOOTH': 'bluetooth'
    };
    const cacheKey = keyMap[dataType];
    const timestamp = systemStatsCache.timestamps[cacheKey];
    const ttl = CACHE_TTL[dataType];
    return timestamp && (Date.now() - timestamp) < ttl;
  };

  // Background refresh for external IP (refresh 5 minutes before expiry) - OPTIMIZED
  const schedulePublicIPRefresh = () => {
    const refreshTime = CACHE_TTL.PUBLIC_IP - (5 * 60 * 1000); // 25 minutes
    setTimeout(async () => {
      if (systemStatsCache.timestamps.publicIP) {
        try {
          const { execSync } = require('node:child_process');
          const exec = (cmd: string, t = 10000) => { try { return execSync(cmd, { encoding: 'utf-8', timeout: t }).trim(); } catch { return ''; } };
          
          // **OPTIMIZATION**: Use fallback chain for reliability
          let publicIP = '';
          const services = [
            { url: 'ifconfig.me', timeout: 2000 },
            { url: 'ipinfo.io/ip', timeout: 2000 },
            { url: 'api.ipify.org', timeout: 2000 }
          ];
          
          for (const service of services) {
            try {
              publicIP = exec(`curl -s --max-time 2 ${service.url}`, service.timeout);
              if (publicIP && publicIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                console.log(`[BACKGROUND_IP] Successfully refreshed from ${service.url}`);
                break;
              }
            } catch (error) {
              console.log(`[BACKGROUND_IP] Failed to refresh from ${service.url}, trying next...`);
            }
          }
          
          if (publicIP) {
            systemStatsCache.publicIP = publicIP;
            systemStatsCache.timestamps.publicIP = Date.now();
          } else {
            console.log('[BACKGROUND_IP] All services failed, keeping cached value');
          }
        } catch (e) {
          console.log('Background IP refresh failed:', e);
        }
        // Schedule next refresh
        schedulePublicIPRefresh();
      }
    }, refreshTime);
  };

  // Helper function to get fast system stats (< 500ms)
  const getFastSystemStats = async () => {
    const os = require('node:os');
    const { execSync } = require('node:child_process');
    const exec = (cmd: string, t = 500) => { try { return execSync(cmd, { encoding: 'utf-8', timeout: t }).trim(); } catch { return ''; } };

    // CPU — per-core speeds + overall usage (fast)
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const cpuCores = cpus.length;
    const cpuFreq = cpus[0]?.speed || 0;
    // Per-core load
    const perCore = cpus.map((c: any, i: number) => {
      const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      const active = total - c.times.idle;
      return { core: i, usage: total > 0 ? Math.round((active / total) * 100) : 0 };
    });

    // Memory — basic info available immediately
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // **PARALLEL EXECUTION**: Execute independent system calls simultaneously
    const [
      topOut,
      vmOut,
      swapOut,
      dfOut,
      iostatOut,
      netOut,
      connOut
    ] = await Promise.all([
      // CPU usage
      new Promise<string>((resolve) => {
        try {
          const result = exec("top -l 1 -n 0 | grep 'CPU usage'", 400);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Memory details
      new Promise<string>((resolve) => {
        try {
          const result = exec("vm_stat", 200);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Swap usage
      new Promise<string>((resolve) => {
        try {
          const result = exec("sysctl -n vm.swapusage", 200);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Disk usage
      new Promise<string>((resolve) => {
        try {
          const result = exec("df -g / | tail -1", 200);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Disk I/O
      new Promise<string>((resolve) => {
        try {
          const result = exec("iostat -d -c 1 disk0 2>/dev/null | tail -1", 300);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Network interface stats
      new Promise<string>((resolve) => {
        try {
          const result = exec("netstat -ib | grep -e en0 -m 1", 300);
          resolve(result);
        } catch {
          resolve('');
        }
      }),
      // Network connections
      new Promise<string>((resolve) => {
        try {
          const result = exec("netstat -an | grep ESTABLISHED | wc -l", 200);
          resolve(result);
        } catch {
          resolve('');
        }
      })
    ]);

    // Process CPU usage results
    let cpuUser = 0, cpuSys = 0, cpuIdle = 0;
    if (topOut) {
      const cpuMatch = topOut.match(/([\d.]+)% user.*?([\d.]+)% sys.*?([\d.]+)% idle/);
      if (cpuMatch) { 
        cpuUser = parseFloat(cpuMatch[1]); 
        cpuSys = parseFloat(cpuMatch[2]); 
        cpuIdle = parseFloat(cpuMatch[3]); 
      }
    }

    // Process memory details
    let memWired = '', memActive = '', memInactive = '', memCompressed = '';
    if (vmOut) {
      const pageSize = 16384;
      const getPages = (label: string) => { 
        const m = vmOut.match(new RegExp(label + ':\\s+(\\d+)')); 
        return m ? parseInt(m[1]) * pageSize : 0; 
      };
      memWired = formatBytes(getPages('Pages wired down'));
      memActive = formatBytes(getPages('Pages active'));
      memInactive = formatBytes(getPages('Pages inactive'));
      memCompressed = formatBytes(getPages('Pages occupied by compressor'));
    }

    // Process swap usage
    let swapUsed = '', swapTotal = '';
    if (swapOut) { 
      const sm = swapOut.match(/total = ([\d.]+)M.*used = ([\d.]+)M/); 
      if (sm) { 
        swapTotal = sm[1] + ' MB'; 
        swapUsed = sm[2] + ' MB'; 
      } 
    }

    // Process disk usage
    let diskTotal = 0, diskUsed = 0, diskFree = 0;
    if (dfOut) { 
      const p = dfOut.split(/\s+/); 
      diskTotal = parseInt(p[1]) || 0; 
      diskUsed = parseInt(p[2]) || 0; 
      diskFree = parseInt(p[3]) || 0; 
    }

    // Process disk I/O
    let diskReads = '', diskWrites = '';
    if (iostatOut) { 
      const p = iostatOut.trim().split(/\s+/); 
      if (p.length >= 3) { 
        diskReads = p[0] + ' KB/s'; 
        diskWrites = p[1] + ' KB/s'; 
      } 
    }

    // Process network interface stats
    let netSent = '0', netRecv = '0';
    if (netOut) { 
      const p = netOut.split(/\s+/); 
      if (p.length >= 10) { 
        netRecv = formatBytes(parseInt(p[6]) || 0); 
        netSent = formatBytes(parseInt(p[9]) || 0); 
      } 
    }

    // Process network connections
    let netConnections = 0;
    if (connOut) {
      netConnections = parseInt(connOut.trim()) || 0;
    }

    // Uptime (fast)
    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptime = (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm';

    // Time zones (fast)
    const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const timezones = [
      { zone: localTZ, label: 'Local' },
      { zone: 'America/New_York', label: 'New York' },
      { zone: 'America/Los_Angeles', label: 'Los Angeles' },
      { zone: 'Europe/London', label: 'London' },
      { zone: 'Asia/Tokyo', label: 'Tokyo' },
      { zone: 'Asia/Kolkata', label: 'Mumbai' },
      { zone: 'Australia/Sydney', label: 'Sydney' },
    ].map(tz => {
      try {
        const time = now.toLocaleTimeString('en-US', { timeZone: tz.zone, hour: '2-digit', minute: '2-digit', hour12: true });
        return { ...tz, time };
      } catch { return { ...tz, time: '--:--' }; }
    });

    return {
      cpu: { model: cpuModel, cores: cpuCores, usage: Math.round(cpuUser + cpuSys), user: Math.round(cpuUser), sys: Math.round(cpuSys), idle: Math.round(cpuIdle), freq: cpuFreq, perCore },
      memory: { total: formatBytes(totalMem), used: formatBytes(usedMem), free: formatBytes(freeMem), percent: memPercent, wired: memWired, active: memActive, inactive: memInactive, compressed: memCompressed, swap: swapUsed + ' / ' + swapTotal },
      disk: { total: diskTotal + ' GB', used: diskUsed + ' GB', free: diskFree + ' GB', percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0, reads: diskReads, writes: diskWrites },
      network: { sent: netSent, received: netRecv, connections: netConnections, publicIP: systemStatsCache.publicIP || '' },
      uptime,
      timezones,
      process: { 
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      hostname: os.hostname(),
      platform: os.platform() + ' ' + os.release(),
      // Include cached slow data if available
      gpu: systemStatsCache.gpu || { model: 'Loading...', cores: '', vram: '' },
      battery: systemStatsCache.battery || { percent: -1, charging: false, timeRemaining: '', health: '', cycleCount: '', temperature: '' },
      sensors: systemStatsCache.sensors || [],
      fans: systemStatsCache.fans || [],
      bluetooth: systemStatsCache.bluetooth || [],
      _loading: {
        gpu: !isCacheValid('GPU'),
        battery: !isCacheValid('BATTERY'),
        publicIP: !isCacheValid('PUBLIC_IP'),
        sensors: !isCacheValid('SENSORS'),
        fans: !isCacheValid('FANS'),
        bluetooth: !isCacheValid('BLUETOOTH')
      }
    };
  };

  // Helper function to get slow system stats (background) with intelligent caching
  const getSlowSystemStats = async () => {
    const { execSync } = require('node:child_process');
    const exec = (cmd: string, t = 10000) => { try { return execSync(cmd, { encoding: 'utf-8', timeout: t }).trim(); } catch { return ''; } };

    const slowData: any = {};
    const now = Date.now();

    try {
      // GPU (24-hour cache - rarely changes) - OPTIMIZED with fallback chain
      if (!isCacheValid('GPU')) {
        let gpuModel = 'Unknown', gpuCores = '', gpuVRAM = '';
        
        if (process.platform === 'win32') {
          // Windows: Use WMIC or PowerShell for GPU info
          try {
            const wmicGPU = exec('wmic path win32_VideoController get Name,AdapterRAM /format:csv', 3000);
            if (wmicGPU) {
              const lines = wmicGPU.split('\n').filter((l: string) => l.trim() && !l.startsWith('Node'));
              if (lines.length > 0) {
                const parts = lines[0].split(',');
                if (parts.length >= 3) {
                  gpuModel = parts[1]?.trim() || 'Unknown';
                  const ram = parseInt(parts[2]?.trim() || '0');
                  if (ram > 0) gpuVRAM = Math.round(ram / 1024 / 1024) + ' MB';
                }
              }
            }
          } catch {}
          if (gpuModel === 'Unknown') {
            try {
              const psGPU = exec('powershell -Command "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name"', 3000);
              if (psGPU) gpuModel = psGPU.trim();
            } catch {}
          }
        } else if (process.platform === 'linux') {
          // Linux: Use lspci for GPU info
          try {
            const lspciGPU = exec("lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'", 2000);
            if (lspciGPU) {
              const match = lspciGPU.match(/:\s*(.+)/);
              if (match) gpuModel = match[1].trim();
            }
          } catch {}
          if (gpuModel === 'Unknown') {
            try {
              const glx = exec("glxinfo 2>/dev/null | grep 'OpenGL renderer'", 2000);
              if (glx) { const m = glx.match(/:\s*(.+)/); if (m) gpuModel = m[1].trim(); }
            } catch {}
          }
          // Try nvidia-smi for NVIDIA GPUs
          try {
            const nvSmi = exec("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null", 2000);
            if (nvSmi) {
              const parts = nvSmi.split(',');
              if (parts[0]) gpuModel = parts[0].trim();
              if (parts[1]) gpuVRAM = parts[1].trim();
            }
          } catch {}
        } else {
        // macOS: Try lighter sysctl alternatives first, fallback to system_profiler
        try {
          // Method 1: Try ioreg (faster than system_profiler)
          const ioregGPU = exec("ioreg -r -n AppleGraphicsControl 2>/dev/null | grep -i 'model\\|vram'", 2000);
          if (ioregGPU) {
            const gm = ioregGPU.match(/"model"\s*=\s*"([^"]+)"/); if (gm) gpuModel = gm[1].trim();
            const gv = ioregGPU.match(/"VRAM,totalMB"\s*=\s*(\d+)/); if (gv) gpuVRAM = gv[1] + ' MB';
          }
          
          // Method 2: Try sysctl for GPU info (even faster)
          if (gpuModel === 'Unknown') {
            const sysctlGPU = exec("sysctl -n machdep.cpu.brand_string 2>/dev/null", 500);
            if (sysctlGPU && sysctlGPU.includes('Apple')) {
              // For Apple Silicon, infer GPU from CPU
              if (sysctlGPU.includes('M1')) gpuModel = 'Apple M1 GPU';
              else if (sysctlGPU.includes('M2')) gpuModel = 'Apple M2 GPU';
              else if (sysctlGPU.includes('M3')) gpuModel = 'Apple M3 GPU';
              else gpuModel = 'Apple Silicon GPU';
            }
          }
          
          // **FALLBACK**: Only use heavy system_profiler if lighter methods failed
          if (gpuModel === 'Unknown' || (!gpuCores && !gpuVRAM)) {
            console.log('[GPU] Falling back to system_profiler (lighter methods failed)');
            const spGPU = exec("system_profiler SPDisplaysDataType 2>/dev/null", 5000);
            if (spGPU) {
              if (gpuModel === 'Unknown') {
                const gm = spGPU.match(/(?:Chipset|Chip) Model:\s*(.+)/); if (gm) gpuModel = gm[1].trim();
              }
              if (!gpuCores) {
                const gc = spGPU.match(/Total Number of Cores:\s*(\d+)/); if (gc) gpuCores = gc[1];
              }
              if (!gpuVRAM) {
                const gv = spGPU.match(/VRAM.*?:\s*(.+)/); if (gv) gpuVRAM = gv[1].trim();
              }
            }
          }
        } catch (error) {
          console.log('[GPU] All methods failed, using graceful degradation');
          gpuModel = 'Detection Failed';
        }
        } // end macOS else block
        
        slowData.gpu = { model: gpuModel, cores: gpuCores, vram: gpuVRAM };
        systemStatsCache.gpu = slowData.gpu;
        systemStatsCache.timestamps.gpu = now;
      }

      // Battery (1-hour cache - health/cycle count changes slowly) - OPTIMIZED with fallback chain
      if (!isCacheValid('BATTERY')) {
        let battery: any = { percent: -1, charging: false, timeRemaining: '', health: '', cycleCount: '', temperature: '' };
        
        if (process.platform === 'win32') {
          // Windows: Use WMIC for battery info
          try {
            const wmicBatt = exec('wmic path Win32_Battery get EstimatedChargeRemaining,BatteryStatus /format:csv', 3000);
            if (wmicBatt) {
              const lines = wmicBatt.split('\n').filter((l: string) => l.trim() && !l.startsWith('Node'));
              if (lines.length > 0) {
                const parts = lines[0].split(',');
                if (parts.length >= 3) {
                  battery.percent = parseInt(parts[2]?.trim() || '-1');
                  battery.charging = parts[1]?.trim() === '2'; // 2 = AC power
                }
              }
            }
          } catch {}
          try {
            const psBatt = exec('powershell -Command "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus,DesignCapacity,FullChargeCapacity | ConvertTo-Json"', 3000);
            if (psBatt) {
              const b = JSON.parse(psBatt);
              if (b.EstimatedChargeRemaining) battery.percent = b.EstimatedChargeRemaining;
              if (b.BatteryStatus === 2) battery.charging = true;
              if (b.DesignCapacity && b.FullChargeCapacity) {
                const health = Math.round((b.FullChargeCapacity / b.DesignCapacity) * 100);
                battery.health = health >= 80 ? 'Normal' : health >= 60 ? 'Fair' : 'Poor';
              }
            }
          } catch {}
        } else if (process.platform === 'linux') {
          // Linux: Read from /sys/class/power_supply
          try {
            const fss = require('node:fs');
            const batPath = '/sys/class/power_supply/BAT0';
            if (fss.existsSync(batPath)) {
              try { battery.percent = parseInt(fss.readFileSync(batPath + '/capacity', 'utf-8').trim()); } catch {}
              try { battery.charging = fss.readFileSync(batPath + '/status', 'utf-8').trim() !== 'Discharging'; } catch {}
              try {
                const energyFull = parseInt(fss.readFileSync(batPath + '/energy_full', 'utf-8').trim());
                const energyDesign = parseInt(fss.readFileSync(batPath + '/energy_full_design', 'utf-8').trim());
                if (energyFull && energyDesign) {
                  const health = Math.round((energyFull / energyDesign) * 100);
                  battery.health = health >= 80 ? 'Normal' : health >= 60 ? 'Fair' : 'Poor';
                }
              } catch {}
              try { battery.cycleCount = fss.readFileSync(batPath + '/cycle_count', 'utf-8').trim(); } catch {}
            }
          } catch {}
          // Fallback: upower
          if (battery.percent === -1) {
            try {
              const upwr = exec("upower -i /org/freedesktop/UPower/devices/battery_BAT0 2>/dev/null", 2000);
              if (upwr) {
                const pm = upwr.match(/percentage:\s*(\d+)%/); if (pm) battery.percent = parseInt(pm[1]);
                battery.charging = /state:\s*charging/i.test(upwr);
              }
            } catch {}
          }
        } else {
        // macOS: Use pmset and sysctl first, fallback to system_profiler
        try {
          // Method 1: pmset for basic battery info (fast)
          const pmOut = exec("pmset -g batt", 1000);
          if (pmOut) {
            const bm = pmOut.match(/(\d+)%;\s*(charging|discharging|charged)/);
            if (bm) { battery.percent = parseInt(bm[1]); battery.charging = bm[2] !== 'discharging'; }
            const tm = pmOut.match(/(\d+:\d+) remaining/); if (tm) battery.timeRemaining = tm[1];
          }
          
          // Method 2: Try ioreg for battery details (faster than system_profiler)
          const ioregBatt = exec("ioreg -r -n AppleSmartBattery 2>/dev/null", 2000);
          if (ioregBatt) {
            const cc = ioregBatt.match(/"CycleCount"\s*=\s*(\d+)/); if (cc) battery.cycleCount = cc[1];
            const mcc = ioregBatt.match(/"MaxCapacity"\s*=\s*(\d+)/); 
            const dcc = ioregBatt.match(/"DesignCapacity"\s*=\s*(\d+)/);
            if (mcc && dcc) {
              const health = Math.round((parseInt(mcc[1]) / parseInt(dcc[1])) * 100);
              battery.health = health >= 80 ? 'Normal' : health >= 60 ? 'Fair' : 'Poor';
            }
            const temp = ioregBatt.match(/"Temperature"\s*=\s*(\d+)/);
            if (temp) battery.temperature = (parseInt(temp[1]) / 100).toFixed(1) + '°C';
          }
          
          // **FALLBACK**: Only use heavy system_profiler if lighter methods failed
          if (!battery.health || !battery.cycleCount) {
            console.log('[BATTERY] Falling back to system_profiler (lighter methods failed)');
            const battInfo = exec("system_profiler SPPowerDataType 2>/dev/null", 3000);
            if (battInfo) {
              if (!battery.cycleCount) {
                const cc = battInfo.match(/Cycle Count:\s*(\d+)/); if (cc) battery.cycleCount = cc[1];
              }
              if (!battery.health) {
                const cond = battInfo.match(/Condition:\s*(\w+)/); if (cond) battery.health = cond[1];
              }
            }
          }
        } catch (error) {
          console.log('[BATTERY] All methods failed, using graceful degradation');
          // Keep basic pmset data if available, gracefully degrade advanced features
        }
        } // end macOS else block
        
        slowData.battery = battery;
        systemStatsCache.battery = slowData.battery;
        systemStatsCache.timestamps.battery = now;
      }

      // Public IP (30-minute cache with background refresh) - OPTIMIZED: Never block main response
      if (!isCacheValid('PUBLIC_IP')) {
        // **OPTIMIZATION**: Make external IP lookup completely background-only
        // Don't block the main response for network calls
        console.log('[PUBLIC_IP] Starting background refresh (non-blocking)');
        
        // Start background fetch without waiting
        setTimeout(async () => {
          try {
            // Try multiple services with fallback chain for reliability
            let publicIP = '';
            const services = [
              { url: 'ifconfig.me', timeout: 2000 },
              { url: 'ipinfo.io/ip', timeout: 2000 },
              { url: 'api.ipify.org', timeout: 2000 }
            ];
            
            for (const service of services) {
              try {
                publicIP = exec(`curl -s --max-time 2 ${service.url}`, service.timeout);
                if (publicIP && publicIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                  console.log(`[PUBLIC_IP] Successfully fetched from ${service.url}: ${publicIP}`);
                  break;
                }
              } catch (error) {
                console.log(`[PUBLIC_IP] Failed to fetch from ${service.url}, trying next...`);
              }
            }
            
            // Update cache with result (or empty if all failed)
            systemStatsCache.publicIP = publicIP || 'Unavailable';
            systemStatsCache.timestamps.publicIP = Date.now();
            
            // Schedule next background refresh
            schedulePublicIPRefresh();
          } catch (error) {
            console.log('[PUBLIC_IP] Background fetch failed, will retry later');
            systemStatsCache.publicIP = 'Network Error';
            systemStatsCache.timestamps.publicIP = Date.now();
          }
        }, 0); // Execute immediately but asynchronously
        
        // Don't include publicIP in slowData - it's handled completely in background
        // The main response will use cached value or show "Loading..." 
      }

      // Sensors — temperature (5-minute cache) - OPTIMIZED with fallback chain
      if (!isCacheValid('SENSORS')) {
        let sensors: any[] = [];
        
        if (process.platform === 'win32') {
          // Windows: Try WMI for temperature sensors
          try {
            const wmicTemp = exec('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /format:csv', 3000);
            if (wmicTemp) {
              const lines = wmicTemp.split('\n').filter((l: string) => l.trim() && !l.startsWith('Node'));
              for (const line of lines) {
                const parts = line.split(',');
                const kelvin = parseInt(parts[parts.length - 1]?.trim() || '0');
                if (kelvin > 0) {
                  const celsius = ((kelvin / 10) - 273.15).toFixed(1);
                  sensors.push({ name: 'Thermal Zone', value: celsius + '°C' });
                }
              }
            }
          } catch {}
        } else if (process.platform === 'linux') {
          // Linux: Read from /sys/class/thermal or lm-sensors
          try {
            const fss = require('node:fs');
            const thermalZones = fss.readdirSync('/sys/class/thermal').filter((d: string) => d.startsWith('thermal_zone'));
            for (const zone of thermalZones.slice(0, 5)) {
              try {
                const temp = parseInt(fss.readFileSync('/sys/class/thermal/' + zone + '/temp', 'utf-8').trim());
                const type = fss.readFileSync('/sys/class/thermal/' + zone + '/type', 'utf-8').trim();
                if (temp > 0) sensors.push({ name: type || zone, value: (temp / 1000).toFixed(1) + '°C' });
              } catch {}
            }
          } catch {}
          if (sensors.length === 0) {
            try {
              const sensorsOut = exec("sensors 2>/dev/null | grep -i 'temp\\|core' | head -5", 2000);
              if (sensorsOut) {
                for (const line of sensorsOut.split('\n')) {
                  const m = line.match(/(.+?):\s*\+?([\d.]+)°C/);
                  if (m) sensors.push({ name: m[1].trim(), value: m[2] + '°C' });
                }
              }
            } catch {}
          }
        } else {
        // macOS: Try lighter alternatives first, avoid sudo powermetrics
        try {
          // Method 1: Try sysctl for thermal info (fastest, no sudo required)
          const thermalLevel = exec("sysctl -n machdep.xcpm.cpu_thermal_level 2>/dev/null", 500);
          if (thermalLevel && thermalLevel !== '') {
            sensors.push({ name: 'CPU Thermal Level', value: thermalLevel });
          }
          
          // Method 2: Try ioreg for battery temperature (fast)
          const ioTemp = exec("ioreg -r -n AppleSmartBattery 2>/dev/null | grep Temperature", 1000);
          if (ioTemp) {
            const tm = ioTemp.match(/"Temperature"\s*=\s*(\d+)/);
            if (tm) sensors.push({ name: 'Battery Temp', value: (parseInt(tm[1]) / 100).toFixed(1) + '°C' });
          }
          
          // Method 3: Try additional sysctl thermal sensors
          const cpuTemp = exec("sysctl -n machdep.xcpm.cpu_thermal_temp 2>/dev/null", 500);
          if (cpuTemp && cpuTemp !== '') {
            sensors.push({ name: 'CPU Temperature', value: cpuTemp + '°C' });
          }
          
          // **FALLBACK**: Only try powermetrics if other methods failed and we have no sensors
          if (sensors.length === 0) {
            console.log('[SENSORS] Falling back to powermetrics (lighter methods failed)');
            // Try without sudo first (may work on some systems)
            let tempOut = exec("powermetrics --samplers smc -i 1 -n 1 2>/dev/null | grep -i 'temperature\\|die temp'", 3000);
            
            // If that failed, try with sudo (but with shorter timeout to avoid blocking)
            if (!tempOut) {
              tempOut = exec("sudo powermetrics --samplers smc -i 1 -n 1 2>/dev/null | grep -i 'temperature\\|die temp'", 2000);
            }
            
            if (tempOut) {
              const lines = tempOut.split('\n');
              for (const line of lines) {
                const match = line.match(/([^:]+):\s*([\d.]+)/);
                if (match) sensors.push({ name: match[1].trim(), value: match[2] + '°C' });
              }
            }
          }
        } catch (error) {
          console.log('[SENSORS] All methods failed, using graceful degradation');
          // Add a placeholder sensor to indicate the feature is available but data unavailable
          sensors.push({ name: 'Temperature Sensors', value: 'Unavailable' });
        }
        } // end macOS else block
        
        slowData.sensors = sensors;
        systemStatsCache.sensors = slowData.sensors;
        systemStatsCache.timestamps.sensors = now;
      }

      // Fans (5-minute cache) - OPTIMIZED with fallback chain
      if (!isCacheValid('FANS')) {
        let fans: any[] = [];
        
        if (process.platform === 'win32') {
          // Windows: Try WMI for fan speed
          try {
            const wmicFan = exec('wmic path Win32_Fan get ActiveCooling,DesiredSpeed /format:csv', 3000);
            if (wmicFan) {
              const lines = wmicFan.split('\n').filter((l: string) => l.trim() && !l.startsWith('Node'));
              for (const line of lines) {
                const parts = line.split(',');
                if (parts.length >= 3) {
                  fans.push({ name: 'System Fan', rpm: parseInt(parts[2]?.trim() || '0') });
                }
              }
            }
          } catch {}
        } else if (process.platform === 'linux') {
          // Linux: Read from /sys/class/hwmon or lm-sensors
          try {
            const sensorsOut = exec("sensors 2>/dev/null | grep -i fan | head -5", 2000);
            if (sensorsOut) {
              for (const line of sensorsOut.split('\n')) {
                const m = line.match(/(.+?):\s*(\d+)\s*RPM/);
                if (m) fans.push({ name: m[1].trim(), rpm: parseInt(m[2]) });
              }
            }
          } catch {}
        } else {
        // macOS: Try lighter sysctl alternatives first
        try {
          // Method 1: Try sysctl for fan speed (fastest)
          const fanSpeed = exec("sysctl -n machdep.xcpm.fan_speed_rpm 2>/dev/null", 500);
          if (fanSpeed && fanSpeed !== '0' && fanSpeed !== '') {
            fans.push({ name: 'System Fan', rpm: parseInt(fanSpeed) || 0 });
          }
          
          // Method 2: Try additional sysctl fan controls
          const fanControl = exec("sysctl -a 2>/dev/null | grep -i fan | head -3", 1000);
          if (fanControl && fans.length === 0) {
            const lines = fanControl.split('\n');
            for (const line of lines) {
              const match = line.match(/([^:]+):\s*(\d+)/);
              if (match && parseInt(match[2]) > 0) {
                fans.push({ name: match[1].replace('machdep.xcpm.', '').trim(), rpm: parseInt(match[2]) });
              }
            }
          }
          
          // **FALLBACK**: Try ioreg if sysctl methods failed
          if (fans.length === 0) {
            console.log('[FANS] Falling back to ioreg (sysctl methods failed)');
            const fanOut = exec("ioreg -r -n AppleSMCFan 2>/dev/null", 2000);
            if (fanOut) {
              const rpmMatch = fanOut.match(/"CurrentSpeed"\s*=\s*(\d+)/);
              if (rpmMatch && parseInt(rpmMatch[1]) > 0) {
                fans.push({ name: 'SMC Fan', rpm: parseInt(rpmMatch[1]) });
              }
            }
          }
        } catch (error) {
          console.log('[FANS] All methods failed, using graceful degradation');
          // For systems without detectable fans (like many Apple Silicon Macs), this is normal
        }
        } // end macOS else block
        
        slowData.fans = fans;
        systemStatsCache.fans = slowData.fans;
        systemStatsCache.timestamps.fans = now;
      }

      // Bluetooth (10-minute cache) - OPTIMIZED with fallback chain
      if (!isCacheValid('BLUETOOTH')) {
        let bluetooth: any[] = [];
        
        // Bluetooth detection is macOS-only for now
        if (process.platform === 'darwin') {
          try {
            // Method 1: Try blueutil if available (faster)
            const blueutil = exec("which blueutil 2>/dev/null", 500);
            if (blueutil) {
              const btDevices = exec("blueutil --connected 2>/dev/null", 2000);
              if (btDevices) {
                const lines = btDevices.split('\n');
                for (const line of lines) {
                  const match = line.match(/address:\s*([a-f0-9:]+),\s*name:\s*"([^"]+)"/i);
                  if (match) bluetooth.push({ name: match[2].trim(), address: match[1] });
                }
              }
            }
            
            // Method 2: Try ioreg (faster than system_profiler)
            if (bluetooth.length === 0) {
              const ioregBT = exec("ioreg -r -n IOBluetoothDevice 2>/dev/null | grep -A 1 'Name'", 2000);
              if (ioregBT) {
                const matches = ioregBT.match(/"Name"\s*=\s*"([^"]+)"/g);
                if (matches) {
                  for (const match of matches) {
                    const name = match.match(/"Name"\s*=\s*"([^"]+)"/);
                    if (name) bluetooth.push({ name: name[1].trim() });
                  }
                }
              }
            }
            
            // **FALLBACK**: Only use heavy system_profiler if lighter methods failed
            if (bluetooth.length === 0) {
              console.log('[BLUETOOTH] Falling back to system_profiler (lighter methods failed)');
              const btOut = exec("system_profiler SPBluetoothDataType 2>/dev/null | grep -A 2 'Connected:'", 5000);
              if (btOut) {
                const lines = btOut.split('\n');
              for (const line of lines) {
                const name = line.match(/^\s{6,}(\S.+?):/);
                if (name) bluetooth.push({ name: name[1].trim() });
              }
            }
          }
        } catch (error) {
          console.log('[BLUETOOTH] All methods failed, using graceful degradation');
          // Return empty array - graceful degradation
        }
        } // end platform === 'darwin'
        
        slowData.bluetooth = bluetooth;
        systemStatsCache.bluetooth = slowData.bluetooth;
        systemStatsCache.timestamps.bluetooth = now;
      }

      return slowData;
    } catch (e: any) {
      console.error('Error fetching slow system stats:', e.message);
      return {};
    }
  };

  // AsyncSystemMonitor instance for async stats collection
  const asyncSystemMonitor = new AsyncSystemMonitor();

  ipcMain.handle('get-system-stats', async () => {
    try {
      if (PERF_FLAGS.ASYNC_COMMANDS) {
        // Use AsyncSystemMonitor for non-blocking stats collection
        const monitorStats = await asyncSystemMonitor.collectStats();

        // Build response in the same format as the original implementation
        // The AsyncSystemMonitor provides cpu, memory, disk, network, gpu, uptime, hostname, platform
        // We need to augment with timezones, process info, and cached slow data to match the contract

        // Time zones (fast, computed locally)
        const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const now = new Date();
        const timezones = [
          { zone: localTZ, label: 'Local' },
          { zone: 'America/New_York', label: 'New York' },
          { zone: 'America/Los_Angeles', label: 'Los Angeles' },
          { zone: 'Europe/London', label: 'London' },
          { zone: 'Asia/Tokyo', label: 'Tokyo' },
          { zone: 'Asia/Kolkata', label: 'Mumbai' },
          { zone: 'Australia/Sydney', label: 'Sydney' },
        ].map(tz => {
          try {
            const time = now.toLocaleTimeString('en-US', { timeZone: tz.zone, hour: '2-digit', minute: '2-digit', hour12: true });
            return { ...tz, time };
          } catch { return { ...tz, time: '--:--' }; }
        });

        // Also trigger slow data refresh in background if needed (same as original)
        const needsRefresh = !isCacheValid('GPU') || !isCacheValid('BATTERY') || !isCacheValid('PUBLIC_IP') || 
                            !isCacheValid('SENSORS') || !isCacheValid('FANS') || !isCacheValid('BLUETOOTH');
        if (needsRefresh && !slowDataPromise) {
          slowDataPromise = getSlowSystemStats().finally(() => {
            slowDataPromise = null;
          });
        }

        // Return response in identical format to original implementation
        return {
          cpu: monitorStats.cpu,
          memory: {
            total: monitorStats.memory.total,
            used: monitorStats.memory.used,
            free: monitorStats.memory.free,
            percent: monitorStats.memory.percent,
            wired: '',
            active: '',
            inactive: '',
            compressed: '',
            swap: ''
          },
          disk: {
            total: monitorStats.disk.total,
            used: monitorStats.disk.used,
            free: monitorStats.disk.free,
            percent: monitorStats.disk.percent,
            reads: '',
            writes: ''
          },
          network: {
            sent: monitorStats.network.sent,
            received: monitorStats.network.received,
            connections: monitorStats.network.connections,
            publicIP: systemStatsCache.publicIP || ''
          },
          uptime: monitorStats.uptime,
          timezones,
          process: {
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          },
          hostname: monitorStats.hostname,
          platform: monitorStats.platform,
          // Include cached slow data if available
          gpu: systemStatsCache.gpu || { model: monitorStats.gpu.model || 'Loading...', cores: monitorStats.gpu.cores || '', vram: monitorStats.gpu.vram || '' },
          battery: systemStatsCache.battery || { percent: -1, charging: false, timeRemaining: '', health: '', cycleCount: '', temperature: '' },
          sensors: systemStatsCache.sensors || [],
          fans: systemStatsCache.fans || [],
          bluetooth: systemStatsCache.bluetooth || [],
          _loading: {
            gpu: !isCacheValid('GPU'),
            battery: !isCacheValid('BATTERY'),
            publicIP: !isCacheValid('PUBLIC_IP'),
            sensors: !isCacheValid('SENSORS'),
            fans: !isCacheValid('FANS'),
            bluetooth: !isCacheValid('BLUETOOTH')
          }
        };
      }

      // Fallback: original sync-based implementation
      const fastData = await getFastSystemStats();

      // Check if we need to refresh any slow data based on individual TTLs
      const needsRefresh = !isCacheValid('GPU') || !isCacheValid('BATTERY') || !isCacheValid('PUBLIC_IP') || 
                          !isCacheValid('SENSORS') || !isCacheValid('FANS') || !isCacheValid('BLUETOOTH');

      // Start slow data fetch in background if needed
      if (needsRefresh && !slowDataPromise) {
        slowDataPromise = getSlowSystemStats().finally(() => {
          slowDataPromise = null;
        });
      }

      return fastData;
    } catch (e: any) {
      return { error: e?.message || 'Failed to get system stats' };
    }
  });

  // New handler for getting updated slow data
  ipcMain.handle('get-system-stats-slow', async () => {
    try {
      // Wait for slow data if it's currently being fetched
      if (slowDataPromise) {
        await slowDataPromise;
      }
      
      // Return the cached slow data
      return {
        gpu: systemStatsCache.gpu || { model: 'Unknown', cores: '', vram: '' },
        battery: systemStatsCache.battery || { percent: -1, charging: false, timeRemaining: '', health: '', cycleCount: '', temperature: '' },
        sensors: systemStatsCache.sensors || [],
        fans: systemStatsCache.fans || [],
        bluetooth: systemStatsCache.bluetooth || [],
        network: { publicIP: systemStatsCache.publicIP || '' },
        _complete: true
      };
    } catch (e: any) {
      return { error: e?.message || 'Failed to get slow system stats' };
    }
  });

  ipcMain.handle('download-project-zip', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      const os = require('node:os');
      const fs = require('node:fs');
      const path = require('node:path');
      const { execSync } = require('node:child_process');
      const { dialog } = require('electron');

      const projectDir = path.join(os.homedir(), '.neuronest', 'projects', projectId);
      if (!fs.existsSync(projectDir)) {
        return { success: false, message: 'Project directory not found' };
      }

      // Get project name from session
      let projectName = 'neuronest-project';
      try {
        const session = sessionManager.list().find((s: any) => s.id === projectId);
        if (session) {
          projectName = session.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 50);
        }
      } catch {}

      // Show save dialog
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Download Project as ZIP',
        defaultPath: path.join(os.homedir(), 'Downloads', projectName + '.zip'),
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, message: 'Download cancelled' };
      }

      const zipPath = result.filePath;

      // Use system zip command (available on macOS)
      try {
        // Remove existing zip if present
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        execSync(`zip -r "${zipPath}" .`, { cwd: projectDir, timeout: 60000 });
        return { success: true, path: zipPath, message: 'Project downloaded as ZIP' };
      } catch (zipErr: any) {
        // Fallback: try using tar if zip not available
        try {
          const tarPath = zipPath.replace(/\.zip$/, '.tar.gz');
          execSync(`tar -czf "${tarPath}" -C "${projectDir}" .`, { timeout: 60000 });
          return { success: true, path: tarPath, message: 'Project downloaded as tar.gz' };
        } catch {
          return { success: false, message: 'Failed to create archive: ' + (zipErr.message || '').slice(0, 100) };
        }
      }
    } catch (e: any) {
      return { success: false, message: 'Download error: ' + (e.message || String(e)).slice(0, 100) };
    }
  });

  // ── WebAuthn / Passkey (Chromium + SimpleWebAuthn server) ──

  // Ensure webauthn_credentials table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter INTEGER DEFAULT 0,
        device_name TEXT,
        transports TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS webauthn_challenges (
      user_id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (e: any) { console.error('[WebAuthn] Table init error:', e?.message); }

  const dynamicImportFn = new Function('specifier', 'return import(specifier)');
  const RP_ID = 'localhost';
  const RP_NAME = 'NeuroNest';
  const ORIGIN = 'file://';

  ipcMain.handle('webauthn-register-start', async (_ev, arg: any) => {
    try {
      const simpleWebAuthn = await dynamicImportFn('@simplewebauthn/server');
      const userId = arg?.userId || 'neuronest-user';

      // Get existing credentials for this user
      const existingCreds = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(userId) as any[];

      const options = await simpleWebAuthn.generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: userId,
        userDisplayName: arg?.displayName || 'NeuroNest User',
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        excludeCredentials: existingCreds.map((c: any) => ({
          id: c.credential_id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        })),
      });

      // Store challenge
      db.prepare('INSERT OR REPLACE INTO webauthn_challenges (user_id, challenge) VALUES (?, ?)').run(userId, options.challenge);

      return { success: true, options };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to generate registration options' };
    }
  });

  ipcMain.handle('webauthn-register-finish', async (_ev, arg: any) => {
    try {
      const simpleWebAuthn = await dynamicImportFn('@simplewebauthn/server');
      const userId = arg?.userId || 'neuronest-user';
      const response = arg?.response;

      // Get stored challenge
      const challengeRow = db.prepare('SELECT challenge FROM webauthn_challenges WHERE user_id = ?').get(userId) as any;
      if (!challengeRow) return { success: false, error: 'No challenge found' };

      const verification = await simpleWebAuthn.verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;
        const id = require('node:crypto').randomUUID();
        db.prepare('INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, device_name, transports) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id, userId,
          Buffer.from(credential.id).toString('base64url'),
          Buffer.from(credential.publicKey).toString('base64'),
          credential.counter,
          arg?.deviceName || 'NeuroNest Device',
          JSON.stringify(credential.transports || []),
        );
        db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(userId);
        return { success: true, credentialId: credential.id };
      }
      return { success: false, error: 'Verification failed' };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Registration verification failed' };
    }
  });

  ipcMain.handle('webauthn-login-start', async (_ev, arg: any) => {
    try {
      const simpleWebAuthn = await dynamicImportFn('@simplewebauthn/server');
      const userId = arg?.userId || 'neuronest-user';

      const creds = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(userId) as any[];

      const options = await simpleWebAuthn.generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'preferred',
        allowCredentials: creds.map((c: any) => ({
          id: c.credential_id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        })),
      });

      db.prepare('INSERT OR REPLACE INTO webauthn_challenges (user_id, challenge) VALUES (?, ?)').run(userId, options.challenge);

      return { success: true, options };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to generate login options' };
    }
  });

  ipcMain.handle('webauthn-login-finish', async (_ev, arg: any) => {
    try {
      const simpleWebAuthn = await dynamicImportFn('@simplewebauthn/server');
      const userId = arg?.userId || 'neuronest-user';
      const response = arg?.response;

      const challengeRow = db.prepare('SELECT challenge FROM webauthn_challenges WHERE user_id = ?').get(userId) as any;
      if (!challengeRow) return { success: false, error: 'No challenge found' };

      // Find the credential
      const credRow = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?').get(response?.id, userId) as any;
      if (!credRow) return { success: false, error: 'Credential not found' };

      const verification = await simpleWebAuthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credRow.credential_id,
          publicKey: Buffer.from(credRow.public_key, 'base64'),
          counter: credRow.counter,
          transports: credRow.transports ? JSON.parse(credRow.transports) : undefined,
        },
        requireUserVerification: false,
      });

      if (verification.verified) {
        // Update counter
        db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(
          verification.authenticationInfo.newCounter, credRow.id
        );
        db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(userId);
        return { success: true, userId };
      }
      return { success: false, error: 'Authentication failed' };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Login verification failed' };
    }
  });

  // ── Firewall Dashboard API ──
  ipcMain.handle('firewall-get-rules', async () => {
    return firewallEngine ? firewallEngine.getRules() : [];
  });
  ipcMain.handle('firewall-get-events', async (_ev, arg: any) => {
    return firewallEngine ? firewallEngine.getEvents(arg?.limit || 100) : [];
  });
  ipcMain.handle('firewall-get-stats', async () => {
    return firewallEngine ? firewallEngine.getStats() : { total: 0, blocked: 0, warned: 0, passed: 0 };
  });
  ipcMain.handle('firewall-toggle-rule', async (_ev, arg: any) => {
    if (firewallEngine && arg?.ruleId != null) {
      firewallEngine.setRuleEnabled(arg.ruleId, !!arg.enabled);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('firewall-update-action', async (_ev, arg: any) => {
    if (firewallEngine && arg?.ruleId && arg?.action) {
      firewallEngine.updateRuleAction(arg.ruleId, arg.action);
      return { success: true };
    }
    return { success: false };
  });

  // ── Enhanced Firewall API ──
  ipcMain.handle('enhanced-firewall-get-config', async () => {
    return firewallConfigManager ? firewallConfigManager.getConfig() : null;
  });

  ipcMain.handle('enhanced-firewall-update-policy', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.policy) {
      // Handle hybridEnabled toggle separately — it goes to hybridConfig, not globalPolicy
      if ('hybridEnabled' in arg.policy) {
        firewallConfigManager.updateHybridConfig({ enabled: arg.policy.hybridEnabled });
      }
      // Pass remaining policy fields to globalPolicy
      const { hybridEnabled, ...policyFields } = arg.policy;
      if (Object.keys(policyFields).length > 0) {
        firewallConfigManager.updateGlobalPolicy(policyFields);
      }
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-update-redaction-config', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.redactionConfig) {
      firewallConfigManager.updateRedactionConfig(arg.redactionConfig);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-set-agent-policy', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.agentId && arg?.policy) {
      firewallConfigManager.setAgentPolicy(arg.agentId, arg.policy);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-set-project-policy', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.projectId && arg?.policy) {
      firewallConfigManager.setProjectPolicy(arg.projectId, arg.policy);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-apply-preset', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.preset) {
      firewallConfigManager.applyPreset(arg.preset);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-enable-llm', async (_ev, arg: any) => {
    if (enhancedFirewallEngine) {
      enhancedFirewallEngine.enableLLMTier(!!arg?.enabled);
      return { success: true, enabled: enhancedFirewallEngine.isLLMTierEnabled() };
    }
    return { success: false };
  });

  ipcMain.handle('enhanced-firewall-get-stats', async () => {
    return enhancedFirewallEngine ? enhancedFirewallEngine.getEnhancedStats() : null;
  });

  ipcMain.handle('enhanced-firewall-test-input', async (_ev, arg: any) => {
    if (enhancedFirewallEngine && arg?.input) {
      try {
        const result = await enhancedFirewallEngine.evaluateHybrid(arg.input, {
          agentId: arg.agentId || 'test',
          projectId: arg.projectId || 'test',
          policy: arg.policy
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
    return { success: false, error: 'Enhanced firewall not available' };
  });

  ipcMain.handle('enhanced-firewall-test-llm-connection', async () => {
    if (enhancedFirewallEngine) {
      try {
        // Test LLM connection by making a simple evaluation call
        const testInput = 'test connection';
        const startTime = Date.now();
        
        const result = await enhancedFirewallEngine.evaluateHybrid(testInput, {
          agentId: 'connection-test',
          projectId: 'connection-test',
          policy: { categories: ['injection'], sensitivity: 'low', enableLLMTier: true }
        });
        
        const latency = Date.now() - startTime;
        
        return { 
          success: true, 
          latency,
          llmUsed: result.method === 'llm' || result.method === 'hybrid'
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
    return { success: false, error: 'Enhanced firewall not available' };
  });

  ipcMain.handle('enhanced-firewall-export-config', async () => {
    if (firewallConfigManager) {
      try {
        const configJson = firewallConfigManager.exportConfig();
        return configJson; // Return the JSON string directly
      } catch (error) {
        throw new Error(String(error));
      }
    }
    throw new Error('Firewall config manager not available');
  });

  ipcMain.handle('enhanced-firewall-import-config', async (_ev, arg: any) => {
    if (firewallConfigManager && arg?.configJson) {
      try {
        const success = firewallConfigManager.importConfig(arg.configJson);
        return { success, imported: success };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
    return { success: false, error: 'Invalid configuration data or config manager not available' };
  });

  ipcMain.handle('enhanced-firewall-reset-config', async () => {
    if (firewallConfigManager) {
      try {
        firewallConfigManager.resetToDefaults();
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
    return { success: false, error: 'Firewall config manager not available' };
  });

  ipcMain.handle('git-push-project', async (_ev, arg: any) => {
    try {
      const projectId = arg?.projectId;
      const action = arg?.action || 'status';
      const commitMessage = arg?.commitMessage || 'NeuroNest commit';
      const remote = arg?.remote || '';
      const branch = arg?.branch || 'main';

      const os = require('node:os');
      const pathMod = require('node:path');
      const { execSync } = require('node:child_process');
      const fsMod = require('node:fs');
      const projectDir = pathMod.join(os.homedir(), '.neuronest', 'projects', projectId);

      if (!fsMod.existsSync(projectDir)) return { success: false, output: 'Project directory not found' };

      const run = (cmd: string) => {
        try { return execSync(cmd, { cwd: projectDir, encoding: 'utf-8', timeout: 30000 }).trim(); }
        catch (e: any) { return 'ERROR: ' + (e.stderr || e.stdout || e.message || '').slice(0, 500); }
      };

      switch (action) {
        case 'status': {
          const isGit = run('git rev-parse --is-inside-work-tree 2>/dev/null');
          if (isGit !== 'true') return { success: true, output: 'Not a git repository. Click "Init" or "Connect" first.' };
          const status = run('git status');
          const remoteUrl = run('git remote get-url origin 2>/dev/null');
          const currentBranch = run('git branch --show-current 2>/dev/null');
          return { success: true, output: (remoteUrl && !remoteUrl.startsWith('ERROR') ? 'Remote: ' + remoteUrl + '\n' : '') + (currentBranch && !currentBranch.startsWith('ERROR') ? 'Branch: ' + currentBranch + '\n\n' : '\n') + status };
        }
        case 'init': {
          let out = '';
          // Sanitize branch name
          const safeBranch = branch.replace(/[^a-zA-Z0-9_.\/-]/g, '').slice(0, 50) || 'main';
          const isGit = run('git rev-parse --is-inside-work-tree 2>/dev/null');
          if (isGit !== 'true' && !isGit.startsWith('ERROR')) {
            out += run('git init -b ' + safeBranch) + '\n';
          } else if (isGit === 'true') {
            out += 'Already a git repo\n';
          } else {
            // Not a git repo — init fresh
            out += run('git init -b ' + safeBranch) + '\n';
          }
          // Create .gitignore if missing
          const gi = pathMod.join(projectDir, '.gitignore');
          if (!fsMod.existsSync(gi)) {
            fsMod.writeFileSync(gi, 'node_modules/\n.DS_Store\n*.log\ndist/\n.env\n', 'utf-8');
            out += 'Created .gitignore\n';
          }
          if (remote) { run('git remote remove origin 2>/dev/null'); out += run('git remote add origin ' + remote) + '\n'; }
          return { success: true, output: out };
        }
        case 'add': {
          return { success: true, output: run('git add -A') + '\nAll files staged.' };
        }
        case 'commit': {
          const msg = commitMessage.replace(/"/g, '\\"');
          return { success: true, output: run('git commit -m "' + msg + '"') };
        }
        case 'push': {
          let out = '';
          if (remote) { run('git remote remove origin 2>/dev/null'); out += run('git remote add origin ' + remote) + '\n'; }
          out += run('git push -u origin ' + branch + ' 2>&1');
          return { success: true, output: out };
        }
        case 'pull': {
          return { success: true, output: run('git pull origin ' + branch + ' 2>&1') };
        }
        case 'log': {
          return { success: true, output: run('git log --oneline --graph -20') };
        }
        case 'diff': {
          const diff = run('git diff --stat');
          const diffFull = run('git diff');
          return { success: true, output: diff + '\n\n' + (diffFull.length > 3000 ? diffFull.slice(0, 3000) + '\n... (truncated)' : diffFull) };
        }
        case 'branches': {
          const isGitB = run('git rev-parse --is-inside-work-tree 2>/dev/null');
          if (isGitB !== 'true') return { success: true, output: '* main' };
          return { success: true, output: run('git branch -a') || '* main' };
        }
        case 'fetch': {
          let out = '';
          if (remote) {
            run('git remote remove origin 2>/dev/null');
            out += run('git remote add origin ' + remote) + '\n';
          }
          out += run('git fetch --all 2>&1');
          return { success: true, output: out };
        }
        default:
          return { success: false, output: 'Unknown action: ' + action };
      }
    } catch (e: any) {
      return { success: false, output: 'Git error: ' + (e?.message || String(e)) };
    }
  });

  ipcMain.on('abort-pipeline', () => {
    console.log('[IPC] Abort pipeline signal received');
    if (activeSwarmCoordinator) {
      activeSwarmCoordinator.abort();
      activeSwarmCoordinator = null;
      console.log('[IPC] Swarm coordinator aborted');
    }
  });

  ipcMain.on('toggle-devtools', () => {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools({ mode: 'bottom' });
    }
  });

  ipcMain.on('agent-select', (_event, agentName: string) => {
    activeAgentName = agentName;
    const agent = agentManager.listAgents().find(a => a.name === agentName);
    if (agent) {
      mainWindow.webContents.send('agent-details', JSON.stringify({
        name: agent.name,
        role: agent.template.role,
        model: `${agent.model.providerId}/${agent.model.model}`,
        tools: agent.template.toolPermissions.join(', '),
      }));
    }
  });

  ipcMain.on('navigate', (_event, view: string) => {
    mainWindow.webContents.send('navigate', view);
  });

  ipcMain.on('command-execute', async (_event, command: string) => {
    const result = await commandSystem.execute(command, {
      sessionId: activeSessionId || 'default',
    });
    sendAndStore(mainWindow, {
      role: 'assistant',
      content: result.success ? result.output : `Error: ${result.error}`,
      isCommand: true,
    });
    mainWindow.webContents.send('chat-response', { role: 'assistant', content: '', agent: 'NeuroNest' });
  });

  // ── Graph Management (Graphify Integration) ──
  
  ipcMain.handle('graph-has-graph', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      return { hasGraph: graphManager.hasGraph(projectId) };
    } catch (e: any) {
      return { hasGraph: false, error: e?.message };
    }
  });

  ipcMain.handle('graph-generate', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      if (!projectId) {
        return { success: false, message: 'Project ID required' };
      }
      
      // Get the actual project path from the session
      let projectPath: string | undefined;
      try {
        const session = await sessionManager.open(projectId);
        projectPath = session.projectDir;
      } catch (sessionError) {
        console.warn(`[IPC] Could not load session ${projectId}, trying without project path:`, sessionError);
      }
      
      const result = await graphManager.generateGraph(projectId, projectPath);
      return result;
    } catch (e: any) {
      const errorMsg = `Graph generation error: ${e?.message || String(e)}`;
      return { success: false, message: errorMsg };
    }
  });

  ipcMain.handle('graph-load', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      const graph = await graphManager.loadGraph(projectId);
      return { success: !!graph, graph };
    } catch (e: any) {
      // ── Graceful Degradation: notify user when loadGraph throws during active session ──
      if (activeSessionId) {
        mainWindow.webContents.send('chat-response', {
          role: 'assistant',
          content: '⚠️ Knowledge Graph temporarily unavailable — responses may have reduced accuracy',
          isCommand: true,
          agent: 'NeuroNest',
        });
        console.warn('[Grounding] graphManager.loadGraph() threw during active session:', e?.message);
      }
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('graph-query', async (_ev, arg: any) => {
    try {
      let projectId, question, maxTokens;
      if (typeof arg === 'object' && arg !== null) {
        projectId = arg.projectId;
        question = arg.question;
        maxTokens = arg.maxTokens;
      } else {
        return { success: false, error: 'Invalid query parameters' };
      }
      
      const result = await graphManager.queryGraph(projectId, question, maxTokens);
      return { success: !!result, result };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('graph-stats', async (_ev, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      const stats = await graphManager.getGraphStats(projectId);
      return { success: !!stats, stats };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.on('graph-clear-cache', (_event, arg: any) => {
    try {
      const projectId = typeof arg === 'object' && arg !== null ? arg.projectId : arg;
      graphManager.clearCache(projectId);
      console.log('[IPC] Graph cache cleared for project:', projectId);
    } catch (e) {
      console.error('[IPC] graph-clear-cache error:', e);
    }
  });

  // ── Skills IPC handlers ──
  registerSkillsIPC(db);

  // ── Agent Skills IPC handlers ──
  try {
    registerAgentSkillsIPC(db);
    console.log('[IPC] Agent Skills IPC handlers registered');
  } catch (error) {
    console.error('[IPC] Failed to register Agent Skills IPC handlers:', error);
  }

  // Self-test removed — agent skills query verified working
  
  // ── Initialize Agent Skills service in main process ──
  try {
    initializeAgentSkillsInMainProcess()
      .then(() => console.log('[IPC] Agent Skills service initialized in main process'))
      .catch((err: any) => console.error('[IPC] Agent Skills service init failed:', err));
  } catch (error) {
    console.error('[IPC] Failed to initialize Agent Skills service:', error);
  }

  // ── Diagnostics & Security Scanner IPC handlers ──
  try {
    registerDiagnosticsIPC(mainWindow, db, firewallEngine);
    console.log('[IPC] Diagnostics & Security IPC handlers registered');
  } catch (error) {
    console.error('[IPC] Failed to register Diagnostics IPC handlers:', error);
  }

  // ── Tool Approval IPC handlers (BashTool user approval flow) ──
  try {
    registerToolApprovalIPC();
    console.log('[IPC] Tool Approval IPC handlers registered');
  } catch (error) {
    console.error('[IPC] Failed to register Tool Approval IPC handlers:', error);
  }

  // ── Multi-Chat IPC handlers (multiple chat sessions per project) ──
  try {
    registerMultiChatIPC({ mainWindow, sessionManager });
    console.log('[IPC] Multi-Chat IPC handlers registered');
  } catch (error) {
    console.error('[IPC] Failed to register Multi-Chat IPC handlers:', error);
  }

  // ── Action Security Analyzer ──
  try {
    const { EnsembleSecurityAnalyzer, classifyAction } = require('../security/action-analyzer.js');
    const actionAnalyzer = new EnsembleSecurityAnalyzer();

    ipcMain.handle('security:analyze-action', async (_ev, arg: any) => {
      try {
        const action = typeof arg === 'string' ? classifyAction(arg) : arg;
        return actionAnalyzer.analyze(action);
      } catch (e: any) {
        return { risk: 'UNKNOWN', reasons: [e.message], analyzer: 'error', timestamp: Date.now() };
      }
    });
    console.log('[IPC] Action Security Analyzer registered');
  } catch (error) {
    console.warn('[IPC] Action Security Analyzer not available:', error);
  }

  // ── Secure Token Storage ──
  try {
    const { storeSecureToken, getSecureToken, deleteSecureToken } = require('../security/secure-communication.js');

    ipcMain.handle('secure:store-token', async (_ev, arg: any) => {
      try {
        const ok = await storeSecureToken(arg.service || 'neuronest', arg.account || 'default', arg.token);
        return { success: ok };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('secure:get-token', async (_ev, arg: any) => {
      try {
        const token = await getSecureToken(arg.service || 'neuronest', arg.account || 'default');
        return { success: true, token };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('secure:delete-token', async (_ev, arg: any) => {
      try {
        await deleteSecureToken(arg.service || 'neuronest', arg.account || 'default');
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });
    console.log('[IPC] Secure Token Storage registered');
  } catch (error) {
    console.warn('[IPC] Secure Token Storage not available:', error);
  }

  // ── Action Event Stream ──
  try {
    const { ActionEventStream } = require('../events/action-event-stream.js');
    const actionEventStream = new ActionEventStream();

    ipcMain.handle('events:publish-action', async (_ev, arg: any) => {
      try {
        const id = actionEventStream.publishAction(
          arg.actionType, arg.agentId || 'user', arg.sessionId || 'default',
          arg.payload || {}, arg.securityRisk, arg.parentId
        );
        return { success: true, id };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('events:publish-observation', async (_ev, arg: any) => {
      try {
        const id = actionEventStream.publishObservation(
          arg.observationType, arg.actionId, arg.agentId || 'user',
          arg.sessionId || 'default', arg.payload || {}, arg.success !== false, arg.durationMs
        );
        return { success: true, id };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('events:query', async (_ev, arg: any) => {
      try {
        return { success: true, events: actionEventStream.query(arg || {}) };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('events:stats', async () => {
      try {
        return { success: true, stats: actionEventStream.getStats() };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });
    console.log('[IPC] Action Event Stream registered');
  } catch (error) {
    console.warn('[IPC] Action Event Stream not available:', error);
  }

  // ── Sandbox Runtime ──
  try {
    const { SandboxRuntime } = require('../runtime/sandbox-runtime.js');
    const sandboxRuntime = new SandboxRuntime();

    ipcMain.handle('sandbox:check', async () => {
      try {
        return await sandboxRuntime.isAvailable();
      } catch (e: any) {
        return { available: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:create', async (_ev, arg: any) => {
      try {
        const session = await sandboxRuntime.createSandbox(arg.projectId, arg.projectPath, arg.config);
        return { success: true, session };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:execute', async (_ev, arg: any) => {
      try {
        const result = await sandboxRuntime.executeCommand(arg.sessionId, arg.command);
        return { success: true, result };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:file', async (_ev, arg: any) => {
      try {
        const result = await sandboxRuntime.fileOperation(arg.sessionId, arg.operation);
        return result;
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:destroy', async (_ev, arg: any) => {
      try {
        await sandboxRuntime.destroySandbox(arg.sessionId);
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:list', async () => {
      try {
        return { success: true, sessions: sandboxRuntime.listSessions() };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('sandbox:install-docker', async () => {
      try {
        const { execSync } = require('node:child_process');
        const platform = process.platform;

        if (platform === 'darwin') {
          // macOS: Install via Homebrew
          try {
            execSync('which brew', { encoding: 'utf-8' });
          } catch {
            return { success: false, error: 'Homebrew not found. Please install Homebrew first: https://brew.sh' };
          }
          execSync('brew install --cask docker', { encoding: 'utf-8', timeout: 300000 });
          execSync('open /Applications/Docker.app', { encoding: 'utf-8' });
          return { success: true, message: 'Docker Desktop installed. It may take a moment to start.' };
        } else if (platform === 'win32') {
          // Windows: Install via winget or direct download
          try {
            execSync('winget install Docker.DockerDesktop --accept-source-agreements --accept-package-agreements', { encoding: 'utf-8', timeout: 300000, shell: 'cmd.exe' });
            return { success: true, message: 'Docker Desktop installed. Please restart your computer to complete setup.' };
          } catch {
            // Fallback: open download page
            execSync('start https://www.docker.com/products/docker-desktop/', { shell: 'cmd.exe', timeout: 5000 });
            return { success: true, message: 'Download page opened. Install Docker Desktop from docker.com.' };
          }
        } else {
          // Linux: Install via official script
          try {
            execSync('curl -fsSL https://get.docker.com | sh', { encoding: 'utf-8', timeout: 300000, shell: '/bin/sh' });
            execSync('sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null', { encoding: 'utf-8', timeout: 10000, shell: '/bin/sh' });
            return { success: true, message: 'Docker installed and started.' };
          } catch {
            execSync('xdg-open "https://docs.docker.com/engine/install/" 2>/dev/null || true', { timeout: 5000, shell: '/bin/sh' });
            return { success: false, error: 'Could not install Docker. Please install manually: https://docs.docker.com/engine/install/' };
          }
        }
      } catch (e: any) {
        const msg = e.message || String(e);
        if (msg.includes('already installed')) {
          if (process.platform === 'darwin') {
            try { require('node:child_process').execSync('open /Applications/Docker.app', { encoding: 'utf-8' }); } catch {}
          }
          return { success: true, message: 'Docker Desktop is already installed. Starting it now.' };
        }
        return { success: false, error: msg.slice(0, 200) };
      }
    });

    console.log('[IPC] Sandbox Runtime registered');
  } catch (error) {
    console.warn('[IPC] Sandbox Runtime not available:', error);
  }

  // ── Brainstorm Mode ──
  try {
    const { BrainstormMode } = require('../pipeline/brainstorm-mode.js');
    const brainstormMode = new BrainstormMode();

    ipcMain.handle('brainstorm:check', async (_ev, arg: any) => {
      return { shouldBrainstorm: brainstormMode.shouldBrainstorm(arg.message || '') };
    });

    ipcMain.handle('brainstorm:start', async (_ev, arg: any) => {
      const session = brainstormMode.startSession(arg.projectId || 'default', arg.request || '');
      return { success: true, session };
    });

    ipcMain.handle('brainstorm:answer', async (_ev, arg: any) => {
      const session = brainstormMode.answerQuestion(arg.sessionId, arg.questionIndex, arg.answer);
      return { success: !!session, session };
    });

    ipcMain.handle('brainstorm:design', async (_ev, arg: any) => {
      const doc = brainstormMode.generateDesignSummary(arg.sessionId);
      return { success: !!doc, designDoc: doc };
    });

    ipcMain.handle('brainstorm:cancel', async (_ev, arg: any) => {
      brainstormMode.cancelSession(arg.sessionId);
      return { success: true };
    });

    ipcMain.handle('brainstorm:get-active', async (_ev, arg: any) => {
      const session = brainstormMode.getActiveSession(arg.projectId || 'default');
      return { session };
    });

    ipcMain.handle('brainstorm:config', async (_ev, arg: any) => {
      if (arg && arg.set) { brainstormMode.setConfig(arg.set); }
      return { config: brainstormMode.getConfig() };
    });
    console.log('[IPC] Brainstorm Mode registered');
  } catch (error) {
    console.warn('[IPC] Brainstorm Mode not available:', error);
  }

  // ── Second Opinion ──
  try {
    ipcMain.handle('second-opinion:get', async (_ev, arg: any) => {
      try {
        const { getSecondOpinion } = require('../pipeline/second-opinion.js');
        const { createLLMClientWithProMode } = require('../pipeline/pro-mode-state');

        // Get configured providers
        const provRow = db.prepare("SELECT value FROM config WHERE key = 'providers'").get() as any;
        if (!provRow) return { success: false, error: 'No providers configured' };
        const providers = JSON.parse(provRow.value);
        if (providers.length < 2) return { success: false, error: 'Need at least 2 providers for second opinion' };

        const result = await getSecondOpinion(arg, providers, createLLMClientWithProMode);
        return { success: !!result, result };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });
    console.log('[IPC] Second Opinion registered');
  } catch (error) {
    console.warn('[IPC] Second Opinion not available:', error);
  }

  // ── Checkpoint Manager ──
  try {
    const { CheckpointManager } = require('../session/checkpoint-manager.js');
    const checkpointManager = new CheckpointManager(db);

    ipcMain.handle('checkpoint:start', async (_ev, arg: any) => {
      checkpointManager.startAutoSave(arg.sessionId || 'default', arg.projectId || 'default');
      return { success: true };
    });

    ipcMain.handle('checkpoint:stop', async () => {
      checkpointManager.stopAutoSave();
      return { success: true };
    });

    ipcMain.handle('checkpoint:update', async (_ev, arg: any) => {
      checkpointManager.updateState(arg);
      return { success: true };
    });

    ipcMain.handle('checkpoint:decision', async (_ev, arg: any) => {
      checkpointManager.recordDecision(arg.decision);
      return { success: true };
    });

    ipcMain.handle('checkpoint:get-latest', async (_ev, arg: any) => {
      const cp = checkpointManager.getLatestCheckpoint(arg.sessionId || 'default');
      return { success: !!cp, checkpoint: cp };
    });

    ipcMain.handle('checkpoint:has-recovery', async (_ev, arg: any) => {
      return { hasRecovery: checkpointManager.hasRecoverableSession(arg.projectId || 'default') };
    });

    ipcMain.handle('checkpoint:get-project', async (_ev, arg: any) => {
      const checkpoints = checkpointManager.getProjectCheckpoints(arg.projectId || 'default', arg.limit || 10);
      return { success: true, checkpoints };
    });
    console.log('[IPC] Checkpoint Manager registered');
  } catch (error) {
    console.warn('[IPC] Checkpoint Manager not available:', error);
  }

  // ── Edit Lock ──
  try {
    const { EditLockManager } = require('../security/edit-lock.js');
    const editLockManager = new EditLockManager();

    ipcMain.handle('editlock:freeze', async (_ev, arg: any) => {
      const lock = editLockManager.freeze(arg.projectId, arg.path, arg.reason, arg.createdBy || 'user');
      return { success: true, lock };
    });

    ipcMain.handle('editlock:unfreeze', async (_ev, arg: any) => {
      const removed = editLockManager.unfreeze(arg.projectId);
      return { success: removed };
    });

    ipcMain.handle('editlock:check', async (_ev, arg: any) => {
      return editLockManager.checkEdit(arg.projectId, arg.filePath);
    });

    ipcMain.handle('editlock:status', async (_ev, arg: any) => {
      const lock = editLockManager.getLock(arg.projectId);
      return { locked: !!lock, lock };
    });

    ipcMain.handle('editlock:list', async () => {
      return { locks: editLockManager.getAllLocks() };
    });
    console.log('[IPC] Edit Lock Manager registered');
  } catch (error) {
    console.warn('[IPC] Edit Lock Manager not available:', error);
  }

  // ── Project Memory ──
  try {
    const { ProjectMemoryStore } = require('../storage/project-memory.js');
    const projectMemory = new ProjectMemoryStore(db);
    projectMemoryRef = projectMemory;

    ipcMain.handle('memory:learn', async (_ev, arg: any) => {
      const mem = projectMemory.learn(arg.projectId, arg.category || 'pattern', arg.content, arg.source || 'user');
      return { success: true, memory: mem };
    });

    ipcMain.handle('memory:get', async (_ev, arg: any) => {
      const memories = projectMemory.getMemories(arg.projectId, arg.limit || 20);
      return { success: true, memories };
    });

    ipcMain.handle('memory:context', async (_ev, arg: any) => {
      const context = projectMemory.getContextString(arg.projectId);
      return { success: true, context };
    });

    ipcMain.handle('memory:search', async (_ev, arg: any) => {
      const results = projectMemory.search(arg.projectId, arg.query || '');
      return { success: true, results };
    });

    ipcMain.handle('memory:forget', async (_ev, arg: any) => {
      projectMemory.forget(arg.memoryId);
      return { success: true };
    });

    ipcMain.handle('memory:reinforce', async (_ev, arg: any) => {
      projectMemory.reinforce(arg.memoryId);
      return { success: true };
    });
    console.log('[IPC] Project Memory registered');
  } catch (error) {
    console.warn('[IPC] Project Memory not available:', error);
  }

  // ── Code Actions ──
  try {
    const { buildCodeActionPrompt } = require('../pipeline/code-actions.js');
    ipcMain.handle('code-action:build', async (_ev, arg: any) => {
      try {
        return { success: true, result: buildCodeActionPrompt(arg) };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });
    console.log('[IPC] Code Actions registered');
  } catch (error) { console.warn('[IPC] Code Actions not available:', error); }

  // ── Project Steering ──
  try {
    const { ProjectSteeringStore } = require('../storage/project-steering.js');
    const steeringStore = new ProjectSteeringStore(db);

    ipcMain.handle('steering:add', async (_ev, arg: any) => {
      try { return { success: true, rule: steeringStore.addRule(arg.projectId, arg.title, arg.content, arg.category) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('steering:get', async (_ev, arg: any) => {
      try { return { success: true, rules: steeringStore.getRules(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('steering:context', async (_ev, arg: any) => {
      try { return { success: true, context: steeringStore.getContextString(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('steering:update', async (_ev, arg: any) => {
      try { steeringStore.updateRule(arg.ruleId, arg.updates); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('steering:delete', async (_ev, arg: any) => {
      try { steeringStore.deleteRule(arg.ruleId); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Project Steering registered');
  } catch (error) { console.warn('[IPC] Project Steering not available:', error); }

  // ── Hooks Manager ──
  try {
    const { HooksManager } = require('../events/hooks-manager.js');
    const hooksManager = new HooksManager(db);

    ipcMain.handle('hooks:create', async (_ev, arg: any) => {
      try { return { success: true, hook: hooksManager.createHook(arg.projectId, arg) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('hooks:get', async (_ev, arg: any) => {
      try { return { success: true, hooks: hooksManager.getHooks(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('hooks:update', async (_ev, arg: any) => {
      try { hooksManager.updateHook(arg.hookId, arg.updates); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('hooks:delete', async (_ev, arg: any) => {
      try { hooksManager.deleteHook(arg.hookId); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Hooks Manager registered');
  } catch (error) { console.warn('[IPC] Hooks Manager not available:', error); }

  // ── Diff Manager ──
  try {
    const { DiffManager } = require('../pipeline/diff-manager.js');
    const diffManager = new DiffManager();

    ipcMain.handle('diff:record', async (_ev, arg: any) => {
      try { return { success: true, diff: diffManager.recordChange(arg.projectId, arg.filePath, arg.original, arg.modified, arg.agentId || 'agent') }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('diff:pending', async (_ev, arg: any) => {
      try { return { success: true, diffs: diffManager.getPendingDiffs(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('diff:accept', async (_ev, arg: any) => {
      try { return { success: diffManager.acceptDiff(arg.diffId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('diff:reject', async (_ev, arg: any) => {
      try { return diffManager.rejectDiff(arg.diffId) || { reverted: false }; }
      catch (e: any) { return { reverted: false, error: e.message }; }
    });
    ipcMain.handle('diff:history', async (_ev, arg: any) => {
      try { return { success: true, diffs: diffManager.getAllDiffs(arg.projectId, arg.limit) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Diff Manager registered');
  } catch (error) { console.warn('[IPC] Diff Manager not available:', error); }

  // ── Project Templates ──
  try {
    const { getTemplates, getTemplate } = require('../pipeline/project-templates.js');
    ipcMain.handle('templates:list', async () => {
      try { return { success: true, templates: getTemplates() }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('templates:get', async (_ev, arg: any) => {
      try { return { success: true, template: getTemplate(arg.id) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('templates:scaffold', async (_ev, arg: any) => {
      try {
        const template = getTemplate(arg.templateId);
        if (!template) return { success: false, error: 'Template not found' };
        const fs = require('node:fs');
        const path = require('node:path');
        const os = require('node:os');
        const projectDir = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId);
        fs.mkdirSync(projectDir, { recursive: true });
        for (const file of template.files) {
          const fullPath = path.join(projectDir, file.path);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, file.content);
        }
        if (template.dependencies || template.devDependencies || template.scripts) {
          const pkg: any = { name: arg.projectName || 'my-project', version: '1.0.0', scripts: template.scripts || {}, dependencies: template.dependencies || {}, devDependencies: template.devDependencies || {} };
          fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2));
        }
        return { success: true, message: `Scaffolded ${template.files.length} files from "${template.name}"` };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Project Templates registered');
  } catch (error) { console.warn('[IPC] Project Templates not available:', error); }

  // ── Budget Manager ──
  try {
    const { BudgetManager } = require('../pipeline/budget-manager.js');
    const budgetManager = new BudgetManager(db);

    ipcMain.handle('budget:get', async (_ev, arg: any) => {
      try { return { success: true, budget: budgetManager.getBudget(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('budget:set', async (_ev, arg: any) => {
      try { budgetManager.setBudget(arg.projectId, arg.maxCostUSD, arg.warningThreshold); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('budget:record', async (_ev, arg: any) => {
      try { return budgetManager.recordUsage(arg.projectId, arg.tokens, arg.costUSD); }
      catch (e: any) { return { allowed: true, warning: false, remaining: Infinity }; }
    });
    ipcMain.handle('budget:reset', async (_ev, arg: any) => {
      try { budgetManager.resetUsage(arg.projectId); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Budget Manager registered');
  } catch (error) { console.warn('[IPC] Budget Manager not available:', error); }

  // ── Tool Executor ──
  try {
    const { executeTool } = require('../pipeline/tool-executor.js');
    // Pipeline_Event emitters (12-factor-agent-improvements task 10).
    // The `tool:execute` IPC handler is the single dispatch site for
    // `executeTool` in the codebase, so the start/success/failure
    // event triple lives here. Per design.md "Event kinds":
    //   - tool.start    payload: { callId, name, args }
    //   - tool.success  payload: { callId, result }
    //   - tool.failure  payload: { callId, error: { name, message, stack, code, output } }
    // Emission is gated by UNIFIED_EVENT_LOG / UNIFIED_EVENT_LOG_SHADOW
    // inside the helper and is fail-soft — a logging regression cannot
    // break tool dispatch. Validates: Requirements 2.1, 2.2, 2.3.
    const {
      emitToolStart,
      emitToolSuccess,
      emitToolFailure,
    } = require('../pipeline/tool-event-emitter.js');
    ipcMain.handle('tool:execute', async (_ev, arg: any) => {
      // The IPC payload does not currently carry a stable per-call id;
      // generate one here so `tool.start` and the matching
      // `tool.success`/`tool.failure` event share it. If a future
      // change threads a callId through from the renderer, prefer
      // the supplied id over a fresh randomUUID so the renderer can
      // correlate.
      const callId =
        typeof arg?.callId === 'string' && arg.callId.length > 0
          ? arg.callId
          : require('node:crypto').randomUUID();
      const toolName = typeof arg?.tool === 'string' ? arg.tool : 'unknown';
      // `args` is the executor's request shape minus `tool` itself —
      // we forward the relevant fields so debug consumers see the
      // command/file path/content the executor actually received,
      // without re-emitting the discriminator.
      const eventArgs = {
        command: arg?.command,
        filePath: arg?.filePath,
        content: arg?.content,
        projectId: arg?.projectId,
        agentId: arg?.agentId,
        timeoutMs: arg?.timeoutMs,
      };
      const sessionId = activeSessionId;
      const log = getEventLog();

      // Emit before the call (`tool.start`). Gating + fail-soft live
      // inside the helper.
      if (sessionId) {
        emitToolStart(log, {
          sessionId,
          callId,
          name: toolName,
          args: eventArgs,
        });
      }

      try {
        const result = executeTool(arg);

        // The free executor functions return `{ success: false, ... }`
        // for any internal failure rather than throwing. Treat that as
        // a `tool.failure` so the reducer tracks the same outcome an
        // exception would yield. Otherwise emit `tool.success`.
        if (sessionId) {
          if (result && result.success === false) {
            emitToolFailure(log, {
              sessionId,
              callId,
              error: {
                name: 'ToolExecError',
                message:
                  typeof result.error === 'string' && result.error.length > 0
                    ? result.error
                    : 'Tool execution failed',
                code:
                  typeof result.exitCode === 'number'
                    ? result.exitCode
                    : undefined,
                output:
                  typeof result.output === 'string' && result.output.length > 0
                    ? result.output
                    : undefined,
              },
            });
          } else {
            emitToolSuccess(log, { sessionId, callId, result });
          }
        }

        return result;
      } catch (e: any) {
        if (sessionId) {
          emitToolFailure(log, {
            sessionId,
            callId,
            error: {
              name: e?.name ?? 'Error',
              message: e?.message ?? String(e),
              stack: e?.stack,
              code: e?.code,
              output: typeof e?.output === 'string' ? e.output : undefined,
            },
          });
        }
        return { success: false, tool: arg?.tool, output: '', error: e?.message, durationMs: 0 };
      }
    });
    console.log('[IPC] Tool Executor registered');
  } catch (error) { console.warn('[IPC] Tool Executor not available:', error); }

  // ── Context Condenser (V1 + V2) ──
  try {
    const { ContextCondenser } = require('../pipeline/context-condenser.js');
    const condenser = new ContextCondenser();

    // V2: Create enhanced condenser gated behind context_condenser_v2 flag
    let condenserV2: any = null;
    try {
      const { createContextCondenserV2, SqliteCondensationLogStore } = require('../pipeline/context-condenser-v2.js');
      const logStore = db ? new SqliteCondensationLogStore(db) : null;
      condenserV2 = createContextCondenserV2({
        config: { enabled: true, budgetRatio: 0.6, summaryMaxTokens: 600, condensationModel: 'fast' },
        summarize: async (prompt: string) => {
          // Use the cheapest available model for condensation
          const llm = resolveActiveLLMClient();
          if (!llm) throw new Error('No LLM available for condensation');
          const result = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 800 });
          return result.content || '';
        },
        logStore: logStore || undefined,
        sessionId: activeSessionId || 'unknown',
      });
      console.log('[IPC] Context Condenser V2 initialized (four-block assembly)');
    } catch (v2Err: any) {
      console.warn('[IPC] Context Condenser V2 init failed (using V1 fallback):', v2Err?.message);
    }

    ipcMain.handle('condenser:condense', async (_ev, arg: any) => {
      try {
        // When V2 is available, use it for more intelligent condensation
        if (condenserV2 && arg.events) {
          const stableBlock = { label: 'stable_prefix', content: arg.systemPrompt || '' };
          const contextWindow = arg.contextWindow || 128000;
          const modeBudget = arg.modeBudget || 80000;
          const assembled = await condenserV2.assemble(stableBlock, arg.events, arg.currentTask || '', contextWindow, modeBudget);
          return { success: true, result: assembled, version: 'v2' };
        }
        // Fallback to V1
        const result = await condenser.condense(arg.messages || []);
        return { success: true, result, version: 'v1' };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('condenser:check', async (_ev, arg: any) => {
      return { needsCondensation: condenser.needsCondensation(arg.messages || []) };
    });
    ipcMain.handle('condenser:config', async (_ev, arg: any) => {
      if (arg && arg.set) condenser.setConfig(arg.set);
      return { config: condenser.getConfig() };
    });
    console.log('[IPC] Context Condenser registered');
  } catch (error) { console.warn('[IPC] Context Condenser not available:', error); }

  // ── Web Browser ──
  try {
    const { browsePage, webSearch } = require('../pipeline/web-browser.js');
    ipcMain.handle('browser:fetch', async (_ev, arg: any) => {
      try { return await browsePage(arg); }
      catch (e: any) { return { success: false, url: arg.url || '', title: '', content: '', links: [], error: e.message, durationMs: 0 }; }
    });
    ipcMain.handle('browser:search', async (_ev, arg: any) => {
      try { return await webSearch(arg.query || ''); }
      catch (e: any) { return { success: false, url: '', title: '', content: '', links: [], error: e.message, durationMs: 0 }; }
    });
    console.log('[IPC] Web Browser registered');
  } catch (error) { console.warn('[IPC] Web Browser not available:', error); }

  // ── Task Tracker ──
  try {
    const { TaskTracker } = require('../pipeline/task-tracker.js');
    // Inject the lazy EventLog singleton so the tracker can emit
    // `task.transition` Pipeline_Events from every public mutation
    // method (12-factor-agent-improvements task 12 → Requirement 2.5).
    // The handlers below pin each emit to `activeSessionId` so the
    // Unified_State_Reducer can route them to the right session; with
    // no active session selected the tracker silently skips the emit
    // (a session-less event would be unreachable for the reducer).
    const taskTracker = new TaskTracker(db, getEventLog());
    ipcMain.handle('tracker:create', async (_ev, arg: any) => {
      try { return { success: true, task: taskTracker.createTask(arg.projectId, arg.title, arg.description, arg.priority, arg.agentId, arg.parentId, activeSessionId ?? undefined) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('tracker:update', async (_ev, arg: any) => {
      try { taskTracker.updateTask(arg.taskId, arg.updates, activeSessionId ?? undefined, arg.by); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('tracker:get', async (_ev, arg: any) => {
      try { return { success: true, tasks: taskTracker.getTasks(arg.projectId, arg.status) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('tracker:stats', async (_ev, arg: any) => {
      try { return { success: true, stats: taskTracker.getStats(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('tracker:delete', async (_ev, arg: any) => {
      try { taskTracker.deleteTask(arg.taskId, activeSessionId ?? undefined, arg.by); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('tracker:context', async (_ev, arg: any) => {
      try { return { success: true, context: taskTracker.getContextString(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Task Tracker registered');
  } catch (error) { console.warn('[IPC] Task Tracker not available:', error); }

  // ── Task Scheduler ──
  try {
    const { TaskScheduler } = require('../pipeline/task-scheduler.js');
    const taskScheduler = new TaskScheduler(db);
    taskScheduler.startAll();

    ipcMain.handle('scheduler:create', async (_ev, arg: any) => {
      try { return { success: true, task: taskScheduler.createTask(arg.projectId, arg.name, arg.schedule, arg.command, arg.type) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('scheduler:get', async (_ev, arg: any) => {
      try { return { success: true, tasks: taskScheduler.getTasks(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('scheduler:run', async (_ev, arg: any) => {
      try { return await taskScheduler.runNow(arg.taskId); }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('scheduler:delete', async (_ev, arg: any) => {
      try { taskScheduler.deleteTask(arg.taskId); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('scheduler:toggle', async (_ev, arg: any) => {
      try { taskScheduler.setEnabled(arg.taskId, arg.enabled); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Task Scheduler registered');
  } catch (error) { console.warn('[IPC] Task Scheduler not available:', error); }

  // ── Workspace Manager ──
  try {
    const { WorkspaceManager } = require('../runtime/workspace-manager.js');
    const workspaceManager = new WorkspaceManager(db);

    ipcMain.handle('workspace:create', async (_ev, arg: any) => {
      try { return workspaceManager.createWorkspace(arg.projectId, arg.projectPath, arg.name, arg.baseBranch); }
      catch (e: any) { return { error: e.message }; }
    });
    ipcMain.handle('workspace:list', async (_ev, arg: any) => {
      try { return { success: true, workspaces: workspaceManager.getWorkspaces(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('workspace:rebase', async (_ev, arg: any) => {
      try { return workspaceManager.rebaseToMain(arg.workspaceId, arg.projectPath); }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('workspace:delete', async (_ev, arg: any) => {
      try { return workspaceManager.deleteWorkspace(arg.workspaceId, arg.projectPath); }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('workspace:sync', async (_ev, arg: any) => {
      try { return workspaceManager.syncWithMain(arg.workspaceId, arg.projectPath); }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Workspace Manager registered');
  } catch (error) { console.warn('[IPC] Workspace Manager not available:', error); }

  // ── Smart Suggestions ──
  try {
    const { generateSuggestions } = require('../pipeline/smart-suggestions.js');
    ipcMain.handle('suggestions:generate', async (_ev, arg: any) => {
      try { return { success: true, suggestions: generateSuggestions(arg.lastResponse || '', arg.lastUserMessage || '', arg.filePath) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Smart Suggestions registered');
  } catch (error) { console.warn('[IPC] Smart Suggestions not available:', error); }

  // ── Plan-Code-Verify ──
  try {
    const { PlanCodeVerify } = require('../pipeline/plan-code-verify.js');
    const pcv = new PlanCodeVerify();

    ipcMain.handle('pcv:create', async (_ev, arg: any) => {
      try { return { success: true, plan: pcv.createPlan(arg.projectId, arg.goal, arg.steps || []) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:start', async (_ev, arg: any) => {
      try { return { success: true, plan: pcv.startExecution(arg.planId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:complete-step', async (_ev, arg: any) => {
      try { return { success: true, plan: pcv.completeStep(arg.planId, arg.output) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:fail-step', async (_ev, arg: any) => {
      try { return pcv.failStep(arg.planId, arg.error || 'Unknown error'); }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:skip-step', async (_ev, arg: any) => {
      try { return { success: true, plan: pcv.skipStep(arg.planId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:get', async (_ev, arg: any) => {
      try { return { success: true, plan: pcv.getPlan(arg.planId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:list', async (_ev, arg: any) => {
      try { return { success: true, plans: pcv.getPlans(arg.projectId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pcv:progress', async (_ev, arg: any) => {
      try { return pcv.getProgress(arg.planId); }
      catch (e: any) { return null; }
    });
    ipcMain.handle('pcv:prompt', async (_ev, arg: any) => {
      try { return { prompt: pcv.getCurrentStepPrompt(arg.planId) }; }
      catch (e: any) { return { prompt: null }; }
    });
    console.log('[IPC] Plan-Code-Verify registered');
  } catch (error) { console.warn('[IPC] Plan-Code-Verify not available:', error); }

  // ── Approval Queue ──
  try {
    const { ApprovalQueue } = require('../pipeline/approval-queue.js');
    const approvalQueue = new ApprovalQueue();

    ipcMain.handle('approval:request', async (_ev, arg: any) => {
      try {
        // Non-blocking: add to queue and return the request ID
        const id = `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const request = { ...arg, id, status: 'pending', createdAt: Date.now() };
        return { success: true, request };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('approval:approve', async (_ev, arg: any) => {
      try { return { success: approvalQueue.approve(arg.requestId, arg.editedContent) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('approval:reject', async (_ev, arg: any) => {
      try { return { success: approvalQueue.reject(arg.requestId) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('approval:pending', async () => {
      try { return { success: true, requests: approvalQueue.getPending() }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('approval:stats', async () => {
      try { return approvalQueue.getStats(); }
      catch (e: any) { return { pending: 0, approved: 0, rejected: 0, total: 0 }; }
    });
    console.log('[IPC] Approval Queue registered');
  } catch (error) { console.warn('[IPC] Approval Queue not available:', error); }

  // ── Workspace Checkpoints ──
  try {
    const { WorkspaceCheckpointManager } = require('../session/workspace-checkpoint.js');
    // Inject the EventLog singleton so the manager can emit
    // `checkpoint.created` / `checkpoint.restored` Pipeline_Events
    // (12-factor-agent-improvements task 15). The manager is
    // constructed before `getEventLog()` may have ever been called, but
    // `getEventLog` returns the same lazily-constructed singleton on
    // each call so passing it here gives the manager a live handle for
    // the lifetime of the process. Per Requirement 2.8 emission is
    // gated and fail-soft inside the manager.
    const checkpointMgr = new WorkspaceCheckpointManager(db, { eventLog: getEventLog() });

    ipcMain.handle('checkpoint:snapshot', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId);
        // Late-bind the EventLog if it wasn't ready when the manager
        // was constructed; this keeps Pipeline_Event emission active
        // even if the singleton was lazy-built after this block ran.
        if (typeof checkpointMgr.setEventLog === 'function') {
          checkpointMgr.setEventLog(getEventLog());
        }
        const emitCtx = activeSessionId ? { sessionId: activeSessionId } : undefined;
        return {
          success: true,
          snapshot: checkpointMgr.takeSnapshot(
            arg.projectId,
            projectPath,
            arg.label || 'Checkpoint',
            arg.agentId,
            arg.stepDescription,
            emitCtx,
          ),
        };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkpoint:compare', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId);
        return { success: true, diffs: checkpointMgr.compare(arg.snapshotId, projectPath) };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkpoint:restore-workspace', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId);
        if (typeof checkpointMgr.setEventLog === 'function') {
          checkpointMgr.setEventLog(getEventLog());
        }
        const emitCtx = activeSessionId ? { sessionId: activeSessionId } : undefined;
        return checkpointMgr.restore(arg.snapshotId, projectPath, emitCtx);
      } catch (e: any) { return { success: false, filesRestored: 0, error: e.message }; }
    });
    ipcMain.handle('checkpoint:snapshots', async (_ev, arg: any) => {
      try { return { success: true, snapshots: checkpointMgr.getSnapshots(arg.projectId, arg.limit) }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkpoint:delete-snapshot', async (_ev, arg: any) => {
      try { checkpointMgr.deleteSnapshot(arg.snapshotId); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Workspace Checkpoints registered');
  } catch (error) { console.warn('[IPC] Workspace Checkpoints not available:', error); }

  // ── Context References ──
  try {
    const { resolveContextRefs, buildContextString, detectRefs } = require('../pipeline/context-references.js');
    ipcMain.handle('context:resolve', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId || 'default');
        const result = await resolveContextRefs(arg.message || '', projectPath);
        return { success: true, cleanMessage: result.cleanMessage, refs: result.refs, contextString: buildContextString(result.refs) };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('context:detect', async (_ev, arg: any) => {
      try { return { refs: detectRefs(arg.message || '') }; }
      catch (e: any) { return { refs: [] }; }
    });
    console.log('[IPC] Context References registered');
  } catch (error) { console.warn('[IPC] Context References not available:', error); }

  // ── Image Input ──
  try {
    const { processImageFile, processBase64Image, supportsVision } = require('../pipeline/image-input.js');
    ipcMain.handle('image:process-file', async (_ev, arg: any) => {
      try { return processImageFile(arg.filePath); }
      catch (e: any) { return { error: e.message }; }
    });
    ipcMain.handle('image:process-base64', async (_ev, arg: any) => {
      try { return processBase64Image(arg.dataUrl, arg.fileName); }
      catch (e: any) { return { error: e.message }; }
    });
    ipcMain.handle('image:supports-vision', async (_ev, arg: any) => {
      return { supported: supportsVision(arg.providerType, arg.model) };
    });
    console.log('[IPC] Image Input registered');
  } catch (error) { console.warn('[IPC] Image Input not available:', error); }

  // ── Error Monitor ──
  try {
    const { checkFile, checkProject } = require('../pipeline/error-monitor.js');
    ipcMain.handle('errors:check-file', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId || 'default');
        const fullPath = path.join(projectPath, arg.filePath);
        return { success: true, errors: checkFile(fullPath, projectPath) };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('errors:check-project', async (_ev, arg: any) => {
      try {
        const os = require('node:os');
        const path = require('node:path');
        const projectPath = path.join(os.homedir(), '.neuronest', 'projects', arg.projectId || 'default');
        return { success: true, errors: checkProject(projectPath, arg.files || []) };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    console.log('[IPC] Error Monitor registered');
  } catch (error) { console.warn('[IPC] Error Monitor not available:', error); }

  // ── Multica Integration: Enhanced Task Management ──
  
  ipcMain.handle('multica-get-tasks', async (_ev, arg: any) => {
    try {
      console.log('[IPC] multica-get-tasks called with:', arg);
      console.log('[IPC] enhancedSwarmCoordinator exists:', !!enhancedSwarmCoordinator);
      
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const sessionId = typeof arg === 'object' && arg !== null ? arg.sessionId : arg;
      if (!sessionId) return { success: false, error: 'Session ID required' };
      
      console.log('[IPC] Getting tasks for session:', sessionId);
      const tasks = await enhancedSwarmCoordinator.getTasksForSession(sessionId);
      console.log('[IPC] Retrieved tasks:', tasks.length);
      return { success: true, tasks };
    } catch (e: any) {
      console.error('[IPC] multica-get-tasks error:', e);
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-get-agent-tasks', async (_ev, arg: any) => {
    try {
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const agentId = typeof arg === 'object' && arg !== null ? arg.agentId : arg;
      if (!agentId) return { success: false, error: 'Agent ID required' };
      
      const tasks = await enhancedSwarmCoordinator.getTasksForAgent(agentId);
      return { success: true, tasks };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-add-task-comment', async (_ev, arg: any) => {
    try {
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const { taskId, authorId, authorName, content } = arg;
      if (!taskId || !authorId || !authorName || !content) {
        return { success: false, error: 'Missing required fields' };
      }
      
      const commentId = await enhancedSwarmCoordinator.addTaskComment(taskId, authorId, authorName, content);
      return { success: true, commentId };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-get-agent-skills', async (_ev, arg: any) => {
    try {
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      let agentId = typeof arg === 'object' && arg !== null ? arg.agentId : arg;
      if (!agentId) return { success: false, error: 'Agent ID required' };
      
      console.log('[IPC] multica-get-agent-skills called with:', agentId);
      
      // The renderer passes the agent display name (e.g. "Frontend Developer").
      // The DB stores the kebab-case id (e.g. "frontend-developer").
      // Always resolve to the registry id first.
      let resolvedId = agentId;
      const byName = AGENT_REGISTRY.find(a => a.name === agentId);
      if (byName) {
        resolvedId = byName.id;
      }
      // Also try direct id match
      const byId = AGENT_REGISTRY.find(a => a.id === agentId);
      if (byId) {
        resolvedId = byId.id;
      }
      
      console.log('[IPC] Resolved agent ID:', resolvedId);
      
      const skills = enhancedSwarmCoordinator.getEnhancedAgentManager().getAgentSkills(resolvedId);
      console.log('[IPC] Found', skills.length, 'skills for agent', resolvedId);
      
      return { success: true, skills };
    } catch (e: any) {
      console.error('[IPC] multica-get-agent-skills error:', e);
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-assign-skill', async (_ev, arg: any) => {
    try {
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const { agentId, skillId, proficiencyLevel } = arg;
      if (!agentId || !skillId) {
        return { success: false, error: 'Agent ID and Skill ID required' };
      }
      
      await enhancedSwarmCoordinator.getEnhancedAgentManager().assignSkillToAgent(agentId, skillId, proficiencyLevel);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-get-runtimes', async () => {
    try {
      console.log('[IPC] multica-get-runtimes called');
      console.log('[IPC] enhancedSwarmCoordinator exists:', !!enhancedSwarmCoordinator);
      
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      console.log('[IPC] Getting runtimes...');
      const runtimes = enhancedSwarmCoordinator.getEnhancedAgentManager().getRuntimes();
      console.log('[IPC] Retrieved runtimes:', runtimes.length);
      return { success: true, runtimes };
    } catch (e: any) {
      console.error('[IPC] multica-get-runtimes error:', e);
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-register-runtime', async (_ev, arg: any) => {
    try {
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const { id, name, type, status, capabilities, resources, config } = arg;
      if (!id || !name || !type) {
        return { success: false, error: 'Runtime ID, name, and type required' };
      }
      
      await enhancedSwarmCoordinator.getEnhancedAgentManager().registerRuntime({
        id, name, type, status: status || 'active',
        capabilities: capabilities || [],
        resources: resources || { cpu: 0, memory: 0, disk: 0 },
        config: config || {}
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('multica-get-task-stats', async (_ev, arg: any) => {
    try {
      console.log('[IPC] multica-get-task-stats called with:', arg);
      console.log('[IPC] enhancedSwarmCoordinator exists:', !!enhancedSwarmCoordinator);
      
      if (!enhancedSwarmCoordinator) return { success: false, error: 'Enhanced coordinator not available' };
      
      const sessionId = typeof arg === 'object' && arg !== null ? arg.sessionId : arg;
      if (!sessionId) return { success: false, error: 'Session ID required' };
      
      console.log('[IPC] Getting task stats for session:', sessionId);
      const tasks = await enhancedSwarmCoordinator.getTasksForSession(sessionId);
      const stats = {
        total: tasks.length,
        queued: tasks.filter(t => t.status === 'queued').length,
        inProgress: tasks.filter(t => t.status === 'in_progress').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
        blocked: tasks.filter(t => t.status === 'blocked').length
      };
      
      console.log('[IPC] Task stats:', stats);
      return { success: true, stats };
    } catch (e: any) {
      console.error('[IPC] multica-get-task-stats error:', e);
      return { success: false, error: e?.message };
    }
  });

  // ── Runtime ──

  // Buffer logs per project so the renderer can replay them when the view opens
  const runtimeLogBuffer: Map<string, Array<{ serviceId: string; line: string }>> = new Map();
  const MAX_LOG_BUFFER = 2000;

  ipcMain.handle('runtime-get-logs', async (_ev, args: { projectId: string }) => {
    return runtimeLogBuffer.get(args.projectId) || [];
  });

  ipcMain.handle('runtime-start', async (_ev, args: { projectId: string; projectPath: string }) => {
    try {
      const { projectId } = args;
      const os = require('node:os');
      const pathMod = require('node:path');
      const fs = require('node:fs');
      const { execSync } = require('node:child_process');
      const resolvedPath = pathMod.join(os.homedir(), '.neuronest', 'projects', projectId);
      console.log('[IPC] runtime-start called for:', projectId, 'resolved path:', resolvedPath);
      console.log('[IPC] Path exists:', fs.existsSync(resolvedPath));
      if (fs.existsSync(resolvedPath)) {
        console.log('[IPC] Files in project:', fs.readdirSync(resolvedPath).join(', '));
      }

      // ── Pre-flight dependency check ──
      // Scan project code for system-level dependencies (databases, services)
      // that must be running or installed on the system for the project to work.
      const missingSystemDeps: Array<{ name: string; reason: string; installHint: string }> = [];

      try {
        const fsP = require('node:fs').promises;
        const codeFiles = (await fsP.readdir(resolvedPath)).filter((f: string) =>
          f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.jsx') || f.endsWith('.tsx') || f === 'package.json' || f === 'docker-compose.yml'
        );
        // Read all root-level code files in parallel
        const rootContents = await Promise.all(
          codeFiles.map((f: string) =>
            fsP.readFile(pathMod.join(resolvedPath, f), 'utf-8').catch(() => '')
          )
        );
        let allCode = rootContents.join('\n');

        // Also check subdirectories (src/, config/, lib/) in parallel
        const subdirs = ['src', 'config', 'lib'];
        const subdirContents = await Promise.all(subdirs.map(async (subdir) => {
          const subdirPath = pathMod.join(resolvedPath, subdir);
          try {
            const stat = await fsP.stat(subdirPath);
            if (!stat.isDirectory()) return '';
            const subFiles = (await fsP.readdir(subdirPath)).filter((f: string) => f.endsWith('.js') || f.endsWith('.ts'));
            const contents = await Promise.all(
              subFiles.map((f: string) =>
                fsP.readFile(pathMod.join(subdirPath, f), 'utf-8').catch(() => '')
              )
            );
            return contents.join('\n');
          } catch {
            return '';
          }
        }));
        allCode += '\n' + subdirContents.join('\n');

        // Check for PostgreSQL dependency
        if (allCode.includes("'postgres'") || allCode.includes('"postgres"') || allCode.includes('pg') && allCode.includes('sequelize')) {
          try { execSync('which psql', { stdio: 'pipe' }); } catch {
            missingSystemDeps.push({
              name: 'PostgreSQL',
              reason: 'Project uses Sequelize/TypeORM with PostgreSQL dialect',
              installHint: 'brew install postgresql@16 && brew services start postgresql@16',
            });
          }
        }

        // Check for MongoDB dependency
        if (allCode.includes('mongoose') || allCode.includes('mongodb://') || allCode.includes('MongoClient')) {
          try { execSync('which mongod', { stdio: 'pipe' }); } catch {
            missingSystemDeps.push({
              name: 'MongoDB',
              reason: 'Project uses Mongoose or MongoDB driver',
              installHint: 'brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community',
            });
          }
        }

        // Check for Redis dependency
        if (allCode.includes("'redis'") || allCode.includes('"redis"') || allCode.includes('ioredis') || allCode.includes('redis://')) {
          try { execSync('which redis-server', { stdio: 'pipe' }); } catch {
            missingSystemDeps.push({
              name: 'Redis',
              reason: 'Project uses Redis for caching or pub/sub',
              installHint: 'brew install redis && brew services start redis',
            });
          }
        }

        // Check for Docker dependency (docker-compose projects)
        if (allCode.includes('docker-compose') || fs.existsSync(pathMod.join(resolvedPath, 'docker-compose.yml')) || fs.existsSync(pathMod.join(resolvedPath, 'Dockerfile'))) {
          try { execSync('which docker', { stdio: 'pipe' }); } catch {
            missingSystemDeps.push({
              name: 'Docker',
              reason: 'Project includes docker-compose.yml or Dockerfile',
              installHint: 'Download from https://docker.com/products/docker-desktop',
            });
          }
        }

        // Check for Python dependency
        if (allCode.includes('python') || fs.existsSync(pathMod.join(resolvedPath, 'requirements.txt')) || fs.existsSync(pathMod.join(resolvedPath, 'Pipfile'))) {
          try { execSync('which python3', { stdio: 'pipe' }); } catch {
            missingSystemDeps.push({
              name: 'Python 3',
              reason: 'Project includes Python files or requirements.txt',
              installHint: 'brew install python3',
            });
          }
        }
      } catch (scanErr) {
        console.warn('[IPC] Pre-flight scan error (non-fatal):', scanErr);
      }

      // If system dependencies are missing, send a popup to the renderer and abort
      if (missingSystemDeps.length > 0) {
        console.warn('[IPC] Runtime pre-flight failed — missing system dependencies:', missingSystemDeps.map(d => d.name).join(', '));
        mainWindow.webContents.send('runtime-preflight-failed', {
          projectId,
          missingDeps: missingSystemDeps,
        });
        return {
          success: false,
          error: {
            code: 'MISSING_SYSTEM_DEPS',
            message: 'Missing system dependencies: ' + missingSystemDeps.map(d => d.name).join(', '),
            details: missingSystemDeps,
          },
        };
      }

      runtimeLogBuffer.set(projectId, []);
      await runtimeManager.startRuntime(
        projectId,
        resolvedPath,
        (serviceId, line) => {
          console.log('[IPC] runtime-log:', serviceId, line.substring(0, 80));
          let buf = runtimeLogBuffer.get(projectId);
          if (!buf) { buf = []; runtimeLogBuffer.set(projectId, buf); }
          buf.push({ serviceId, line });
          if (buf.length > MAX_LOG_BUFFER) buf.shift();
          // Send to renderer
          mainWindow.webContents.send('runtime-log', { projectId, serviceId, line });
        },
        (serviceId, status) => {
          const session = runtimeManager.getStatus(projectId);
          const state = session?.services.get(serviceId);
          const port = (state && state.hostPort !== null) ? state.hostPort : undefined;
          console.log('[IPC] runtime-status-update:', serviceId, status, 'port:', port, 'raw hostPort:', state?.hostPort);
          mainWindow.webContents.send('runtime-status-update', {
            projectId,
            serviceId,
            status,
            port: port,
            error: (state && state.error) ? state.error : undefined,
          });
        },
      );
      console.log('[IPC] runtime-start completed successfully');
      return { success: true };
    } catch (err: any) {
      console.error('[IPC] runtime-start error:', err.message, err.stack);
      const rtErr: RuntimeError = {
        code: err.code || 'UNKNOWN',
        message: err.message || 'An unexpected error occurred',
        details: err.details,
      };
      return { success: false, error: rtErr };
    }
  });

  ipcMain.handle('runtime-stop', async (_ev, args: { projectId: string }) => {
    try {
      // Get session before stopping so we can notify the renderer about each service
      const session = runtimeManager.getStatus(args.projectId);
      await runtimeManager.stopRuntime(args.projectId);
      // Notify renderer that all services are stopped
      if (session) {
        for (const [, state] of session.services) {
          mainWindow.webContents.send('runtime-status-update', {
            projectId: args.projectId,
            serviceId: state.serviceId,
            status: 'stopped',
            port: state.hostPort ?? undefined,
          });
        }
      }
      // Clear log buffer
      runtimeLogBuffer.delete(args.projectId);
      return { success: true };
    } catch (err: any) {
      console.error('[IPC] runtime-stop error:', err);
      const rtErr: RuntimeError = {
        code: err.code || 'UNKNOWN',
        message: err.message || 'An unexpected error occurred',
        details: err.details,
      };
      return { success: false, error: rtErr };
    }
  });

  ipcMain.handle('runtime-restart', async (_ev, args: { projectId: string; serviceId?: string }) => {
    try {
      await runtimeManager.restartRuntime(args.projectId, args.serviceId);
      return { success: true };
    } catch (err: any) {
      console.error('[IPC] runtime-restart error:', err);
      const rtErr: RuntimeError = {
        code: err.code || 'UNKNOWN',
        message: err.message || 'An unexpected error occurred',
        details: err.details,
      };
      return { success: false, error: rtErr };
    }
  });

  ipcMain.handle('runtime-status', async (_ev, args: { projectId: string }) => {
    try {
      const session = runtimeManager.getStatus(args.projectId);
      if (!session) return null;
      // Convert Map to plain object for IPC serialization
      const servicesObj: Record<string, any> = {};
      for (const [key, val] of session.services) {
        servicesObj[key] = val;
      }
      return {
        projectId: session.projectId,
        projectPath: session.projectPath,
        detectionResult: session.detectionResult,
        createdAt: session.createdAt,
        services: servicesObj,
      };
    } catch (err: any) {
      console.error('[IPC] runtime-status error:', err);
      const rtErr: RuntimeError = {
        code: err.code || 'UNKNOWN',
        message: err.message || 'An unexpected error occurred',
        details: err.details,
      };
      return { error: rtErr };
    }
  });

  ipcMain.handle('runtime-detect-stack', async (_ev, args: { projectPath: string }) => {
    try {
      const os = require('node:os');
      const pathMod = require('node:path');
      const resolvedPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectPath);
      return await runtimeManager.detectStack(resolvedPath);
    } catch (err: any) {
      console.error('[IPC] runtime-detect-stack error:', err);
      const rtErr: RuntimeError = {
        code: err.code || 'UNSUPPORTED_PROJECT',
        message: err.message || 'Could not detect project type',
        details: err.details,
      };
      return { error: rtErr };
    }
  });

  // ── DeerFlow IPC channels ──────────────────────────────────────
  registerDeerFlowIPC(mainWindow);
  setDeerFlowMainWindow(mainWindow);

  // ── Unified Intent Gate IPC channels ────────────────────────────
  try {
    const { getIntentGateInstance, getFeatureGateInstance } = require('../pipeline/intent-gate-registry');
    registerUnifiedIntentGateIPC({
      mainWindow,
      getIntentGate: () => getIntentGateInstance(),
      getSpecInterviewEngine: () => {
        try {
          const { getSpecInterviewEngineInstance } = require('../pipeline/spec-interview-engine-registry');
          return getSpecInterviewEngineInstance();
        } catch { return null; }
      },
      getFeatureGate: () => getFeatureGateInstance(),
    });
    console.log('[IPC] Unified Intent Gate IPC handlers registered');
  } catch (err: any) {
    console.warn('[IPC] Unified Intent Gate IPC registration failed (non-fatal):', err?.message);
  }

  // ── Shell: open external URL in default browser ──
  ipcMain.handle('shell:open-external', async (_event: any, url: string) => {
    const { shell } = require('electron');
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
    }
  });

  // ── Visual Diff Review IPC ──────────────────────────────────────
  const { DiffReviewService } = require('../diff/diff-review-service');
  const diffReviewService = new DiffReviewService(db);

  ipcMain.handle('diff-review:create', async (_ev: any, args: any) => {
    try { return diffReviewService.create(args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('diff-review:get', async (_ev: any, id: string) => {
    try { return diffReviewService.get(id); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('diff-review:list', async (_ev: any, sessionId: string) => {
    try { return diffReviewService.listForSession(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('diff-review:pending', async (_ev: any, sessionId: string) => {
    try { return diffReviewService.pendingForSession(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('diff-review:accept', async (_ev: any, id: string) => {
    try { return { success: diffReviewService.accept(id) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('diff-review:reject', async (_ev: any, id: string) => {
    try { return { success: diffReviewService.reject(id) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('diff-review:summaries', async (_ev: any, sessionId: string) => {
    try { return diffReviewService.getSummaries(sessionId); }
    catch (e: any) { return []; }
  });
  console.log('[IPC] Visual Diff Review registered');

  // ── Multi-Session Parallel Agents IPC ───────────────────────────
  const { ParallelSessionManager } = require('../session/parallel-session-manager');
  const parallelSessionManager = new ParallelSessionManager(db);

  ipcMain.handle('parallel:create', async (_ev: any, args: any) => {
    try { return parallelSessionManager.create(args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('parallel:get', async (_ev: any, id: string) => {
    try { return parallelSessionManager.get(id); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('parallel:list', async (_ev: any, projectId: string) => {
    try { return parallelSessionManager.list(projectId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('parallel:update', async (_ev: any, args: { id: string; updates: any }) => {
    try { return { success: parallelSessionManager.update(args.id, args.updates) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('parallel:delete', async (_ev: any, id: string) => {
    try { return { success: parallelSessionManager.delete(id) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('parallel:add-message', async (_ev: any, args: { sessionId: string; role: string; content: string; agent?: string }) => {
    try { return parallelSessionManager.addMessage(args.sessionId, args.role, args.content, args.agent); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('parallel:get-messages', async (_ev: any, sessionId: string) => {
    try { return parallelSessionManager.getMessages(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('parallel:stats', async (_ev: any, projectId: string) => {
    try { return parallelSessionManager.getStats(projectId); }
    catch (e: any) { return { total: 0, running: 0, completed: 0, failed: 0 }; }
  });

  ipcMain.handle('parallel:run', async (_ev: any, args: { id: string; prompt: string }) => {
    try {
      // Mark session as running
      parallelSessionManager.update(args.id, { status: 'running', task: args.prompt });
      parallelSessionManager.addMessage(args.id, 'user', args.prompt);

      // Get LLM client and run the task
      const client = resolveActiveLLMClient();
      if (!client) {
        parallelSessionManager.update(args.id, { status: 'failed', result: 'No AI provider configured' });
        parallelSessionManager.addMessage(args.id, 'system', 'No AI provider configured.');
        return { success: false, error: 'No AI provider configured' };
      }

      // Get the session to find agent info
      const session = parallelSessionManager.get(args.id);
      const agentDef = session?.agentId ? AGENT_REGISTRY.find((a: any) => a.id === session.agentId) : null;
      const systemPrompt = agentDef?.systemPrompt || 'You are a helpful AI coding assistant.';

      const result = await client.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: args.prompt },
      ], { temperature: 0.7, maxTokens: 4096 });

      const responseText = result.content || 'No response generated.';
      parallelSessionManager.addMessage(args.id, 'assistant', responseText, agentDef?.name);
      parallelSessionManager.update(args.id, { status: 'completed', result: responseText.slice(0, 500) });

      // Notify renderer
      mainWindow.webContents.send('parallel:session-updated', { id: args.id, status: 'completed' });
      return { success: true, response: responseText };
    } catch (e: any) {
      parallelSessionManager.update(args.id, { status: 'failed', result: e.message });
      parallelSessionManager.addMessage(args.id, 'system', 'Error: ' + e.message);
      mainWindow.webContents.send('parallel:session-updated', { id: args.id, status: 'failed' });
      return { success: false, error: e.message };
    }
  });
  console.log('[IPC] Multi-Session Parallel Agents registered');

  // ── Extension System IPC ────────────────────────────────────────
  const { ExtensionManager } = require('../extensions/extension-manager');
  const extensionManager = new ExtensionManager(db);

  ipcMain.handle('extensions:list', async () => {
    try { return extensionManager.list(); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('extensions:get', async (_ev: any, id: string) => {
    try { return extensionManager.get(id); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('extensions:toggle', async (_ev: any, args: { id: string; enabled: boolean }) => {
    try { return { success: extensionManager.toggle(args.id, args.enabled) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('extensions:install', async (_ev: any, manifest: any) => {
    try { return extensionManager.install(manifest); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('extensions:uninstall', async (_ev: any, id: string) => {
    try { return { success: extensionManager.uninstall(id) }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('extensions:find-for-file', async (_ev: any, filePath: string) => {
    try { return extensionManager.findForFile(filePath); }
    catch (e: any) { return null; }
  });
  console.log('[IPC] Extension System registered');

  // ── AI Readiness Score IPC ──────────────────────────────────────
  const { AIReadinessService } = require('../readiness/ai-readiness-service');
  const readinessService = new AIReadinessService(db);

  ipcMain.handle('readiness:scan', async (_ev: any, args: { projectId: string; projectPath: string }) => {
    try {
      const os = require('node:os');
      const pathMod = require('node:path');
      const resolvedPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectPath || args.projectId);
      return await readinessService.scan(args.projectId, resolvedPath);
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('readiness:latest', async (_ev: any, projectId: string) => {
    try { return readinessService.getLatest(projectId); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('generate-neuronest-md', async (_ev: any, args: { projectId: string }) => {
    try {
      const os = require('node:os');
      const pathMod = require('node:path');
      const fs = require('node:fs');
      const projectDir = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      if (!fs.existsSync(projectDir)) return { error: 'Project directory not found' };

      // Analyze project structure
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      const dirs = entries.filter((e: any) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'docs').map((e: any) => e.name);
      const files = entries.filter((e: any) => e.isFile()).map((e: any) => e.name);

      // Detect tech stack
      let stack = 'Unknown';
      let framework = '';
      if (files.includes('package.json')) {
        stack = 'Node.js';
        try {
          const pkg = JSON.parse(fs.readFileSync(pathMod.join(projectDir, 'package.json'), 'utf-8'));
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (deps.react || deps['react-dom']) framework = 'React';
          else if (deps.vue) framework = 'Vue';
          else if (deps.next) framework = 'Next.js';
          else if (deps.express) framework = 'Express';
          else if (deps.fastify) framework = 'Fastify';
          else if (deps.hono) framework = 'Hono';
        } catch {}
      } else if (files.includes('requirements.txt') || files.includes('pyproject.toml')) {
        stack = 'Python';
        try {
          const reqs = fs.readFileSync(pathMod.join(projectDir, files.includes('requirements.txt') ? 'requirements.txt' : 'pyproject.toml'), 'utf-8');
          if (reqs.includes('flask')) framework = 'Flask';
          else if (reqs.includes('django')) framework = 'Django';
          else if (reqs.includes('fastapi')) framework = 'FastAPI';
        } catch {}
      } else if (files.includes('go.mod')) { stack = 'Go'; }
      else if (files.includes('Cargo.toml')) { stack = 'Rust'; }

      // Get project name from session
      let projectName = 'Project';
      try {
        const session = sessionManager.list().find((s: any) => s.id === args.projectId);
        if (session) projectName = session.name;
      } catch {}

      // Generate NEURONEST.md content
      let md = '# ' + projectName + '\n\n';
      md += '## Project Overview\n\n';
      md += '- **Tech Stack:** ' + stack + (framework ? ' + ' + framework : '') + '\n';
      md += '- **Structure:** ' + dirs.join(', ') + '\n';
      md += '- **Key Files:** ' + files.filter((f: string) => !f.startsWith('.')).slice(0, 10).join(', ') + '\n\n';

      md += '## Coding Conventions\n\n';
      md += '- Follow existing code style and patterns in this project\n';
      md += '- Use descriptive variable and function names\n';
      md += '- Add comments for complex logic\n';
      md += '- Keep functions small and focused (< 50 lines)\n\n';

      md += '## Architecture Notes\n\n';
      if (dirs.includes('src')) md += '- Source code lives in `src/`\n';
      if (dirs.includes('public') || dirs.includes('static')) md += '- Static assets in `' + (dirs.includes('public') ? 'public' : 'static') + '/`\n';
      if (dirs.includes('tests') || dirs.includes('test') || dirs.includes('__tests__')) md += '- Tests in `' + (dirs.includes('tests') ? 'tests' : dirs.includes('test') ? 'test' : '__tests__') + '/`\n';
      if (framework) md += '- Framework: ' + framework + '\n';
      md += '\n';

      md += '## Instructions for AI Agents\n\n';
      md += '- Always read existing code before making changes\n';
      md += '- Do not remove existing functionality unless explicitly asked\n';
      md += '- Maintain backward compatibility\n';
      md += '- Add error handling for edge cases\n';
      md += '- If unsure about a pattern, follow what already exists in the codebase\n';

      // Write the file
      fs.writeFileSync(pathMod.join(projectDir, 'NEURONEST.md'), md, 'utf-8');
      // Notify file tree update
      notifyProjectFilesUpdated(args.projectId);
      return { success: true, path: 'NEURONEST.md' };
    } catch (e: any) { return { error: e.message }; }
  });

  console.log('[IPC] AI Readiness Score registered');

  // ── Session Inspector / Telemetry IPC ───────────────────────────
  const { SessionTelemetryService } = require('../session/session-telemetry');
  const telemetryService = new SessionTelemetryService(db);

  ipcMain.handle('telemetry:record', async (_ev: any, args: any) => {
    try { return telemetryService.record(args.sessionId, args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('telemetry:snapshots', async (_ev: any, sessionId: string) => {
    try { return telemetryService.getSnapshots(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('telemetry:summary', async (_ev: any, sessionId: string) => {
    try { return telemetryService.getSummary(sessionId); }
    catch (e: any) { return null; }
  });
  console.log('[IPC] Session Telemetry registered');

  // ── Metrics_Sink IPC ────────────────────────────────────────────
  // Reads `metric_samples` time-series for the Dashboard_Metrics_Panel
  // and the rollout-gate CI script. Writers (`recordMetric`) are NOT
  // exposed over IPC — metrics are produced inside the main process
  // only (Unified_State_Reducer, Error_Compactor, orchestrator tick).
  // Per design "Metrics_Sink (`src/session/session-telemetry.ts`
  // extension)": this handler calls `getMetricSeries(key, opts)` and
  // returns the result. On error, returns an empty array so the
  // dashboard panel renders gracefully.
  //
  // Args shape: `{ key, sessionId?, sinceMs?, limit? }`. The renderer
  // does not invoke `getMetricSeries` directly; it goes through this
  // channel so the allowlist remains the single source of truth for
  // exposed surface.
  ipcMain.handle('metrics:get-series', async (_ev: any, args: any) => {
    try {
      const key = args && typeof args.key === 'string' ? args.key : '';
      if (!key) return [];
      const opts: any = {};
      if (args && typeof args.sessionId === 'string' && args.sessionId.length > 0) opts.sessionId = args.sessionId;
      if (args && typeof args.sinceMs === 'number' && Number.isFinite(args.sinceMs)) opts.sinceMs = args.sinceMs;
      if (args && typeof args.limit === 'number' && Number.isFinite(args.limit)) opts.limit = args.limit;
      return telemetryService.getMetricSeries(key, opts);
    } catch (e: any) { return []; }
  });
  console.log('[IPC] Metrics_Sink registered');

  // ── Dashboard_Metrics_Panel config IPC ──────────────────────────
  // Backs the renderer's `metrics-panel.ts` runtime config. The panel
  // reads `~/.neuronest/config/metrics-panel.json` once on render and
  // re-fetches when it receives a `metrics:config-updated` broadcast.
  // The renderer keeps a baked-in default it falls back to when the
  // file is missing or malformed (validated renderer-side), so this
  // handler returns the raw parsed JSON — null on absence — and never
  // throws across the IPC boundary.
  //
  // The watcher uses Node's built-in `fs.watch` rather than `chokidar`
  // because chokidar isn't a dependency of this project. The behavior
  // contract is the same: edits to the config file emit a single
  // broadcast on the next tick. We debounce raw events at 250ms so a
  // single editor save (which often fires twice on macOS HFS+) lands
  // exactly one renderer-side re-render.
  try {
    const nodeFs = require('node:fs');
    const nodeOs = require('node:os');
    const nodePath = require('node:path');
    const { BrowserWindow: BW } = require('electron');

    const metricsPanelConfigDir = nodePath.join(nodeOs.homedir(), '.neuronest', 'config');
    const metricsPanelConfigPath = nodePath.join(metricsPanelConfigDir, 'metrics-panel.json');

    // Ensure the config directory exists so `fs.watch` on it works
    // even before the file itself has been authored. Watching the
    // directory (vs the file) survives editors that replace the file
    // atomically (write-temp + rename).
    try {
      nodeFs.mkdirSync(metricsPanelConfigDir, { recursive: true });
    } catch { /* ignore — read path will surface real failures */ }

    // ── First-run: seed the default metrics-panel.json ────────────
    // 12-factor-agent-improvements task 35 / Requirement 5.4. If the
    // user has never edited the config, drop the four-panel default
    // shipped in `src/data/metrics-panel-default.json` (copied to
    // `dist/data/` by `scripts/copy-renderer.mjs`) onto disk so the
    // file is discoverable and editable. The renderer keeps the same
    // defaults baked in, so a failure here is non-fatal — the panel
    // simply falls back to its in-memory default.
    try {
      if (!nodeFs.existsSync(metricsPanelConfigPath)) {
        const bundledDefaultPath = nodePath.join(__dirname, '..', 'data', 'metrics-panel-default.json');
        if (nodeFs.existsSync(bundledDefaultPath)) {
          const bundled = nodeFs.readFileSync(bundledDefaultPath, 'utf-8');
          // Validate the bundled JSON before writing so we never seed
          // a malformed file onto the user's disk.
          JSON.parse(bundled);
          nodeFs.writeFileSync(metricsPanelConfigPath, bundled, 'utf-8');
          console.log('[metrics-panel] seeded default config at', metricsPanelConfigPath);
        }
      }
    } catch (e: any) {
      console.warn('[metrics-panel] first-run config seed failed (non-fatal):', e?.message);
    }

    ipcMain.handle('metrics:get-config', async () => {
      try {
        if (!nodeFs.existsSync(metricsPanelConfigPath)) return null;
        const raw = nodeFs.readFileSync(metricsPanelConfigPath, 'utf-8');
        return JSON.parse(raw);
      } catch (e: any) {
        // Malformed JSON or transient read failure — renderer falls
        // back to defaults and logs a warning. Returning null keeps
        // the IPC contract narrow: success is a config object, absence
        // is null, errors never propagate.
        console.warn('[metrics:get-config] read failed:', e?.message);
        return null;
      }
    });

    // ── chokidar-equivalent watch + broadcast ─────────────────────
    // Single watcher for the config dir. Each fs.watch event filters
    // for the panel filename and triggers a debounced broadcast.
    let metricsConfigBroadcastTimer: NodeJS.Timeout | null = null;
    function broadcastMetricsConfigUpdated(): void {
      if (metricsConfigBroadcastTimer) clearTimeout(metricsConfigBroadcastTimer);
      metricsConfigBroadcastTimer = setTimeout(() => {
        metricsConfigBroadcastTimer = null;
        try {
          const wins = BW.getAllWindows();
          for (const w of wins) {
            if (w && !w.isDestroyed()) {
              try { w.webContents.send('metrics:config-updated'); } catch { /* per-window failure is non-fatal */ }
            }
          }
        } catch (e: any) {
          console.warn('[metrics:config-updated] broadcast failed:', e?.message);
        }
      }, 250);
    }

    try {
      const watcher = nodeFs.watch(metricsPanelConfigDir, { persistent: false }, (_eventType: string, filename: string | null) => {
        if (!filename) return;
        if (filename !== 'metrics-panel.json') return;
        broadcastMetricsConfigUpdated();
      });
      // Detach from event-loop refcount so the watcher never blocks
      // process exit (matches how the daily prune job's interval is
      // set up — long-lived background tasks don't keep us alive).
      try { (watcher as any).unref?.(); } catch {}
    } catch (e: any) {
      console.warn('[metrics-panel] config watch setup failed (non-fatal):', e?.message);
    }

    console.log('[IPC] Dashboard_Metrics_Panel config registered');
  } catch (e: any) {
    console.warn('[IPC] Dashboard_Metrics_Panel config setup failed:', e?.message);
  }

  // ── Event_Bus_Bridge IPC ────────────────────────────────────────
  // Single main-process write path for the Pipeline_Event_Log. Any
  // renderer-side agent that wants to land a Pipeline_Event sends it
  // through this fire-and-forget channel; the main-process EventLog
  // singleton is the only writer of `pipeline_events` rows, which is
  // what makes the per-session `seq` allocation race-free (Requirement
  // 1.3 / 6.1).
  //
  // Notes:
  //   - Uses `ipcMain.on`, NOT `ipcMain.handle` — emits are
  //     fire-and-forget and the renderer must not await them.
  //   - Lazily constructs the EventLog singleton on first call (via
  //     `getEventLog`) so we don't pay the cost during critical-path
  //     init. If the database is not yet ready, the event is dropped
  //     silently — design.md "Renderer emits via Event_Bus_Bridge
  //     while main is shutting down" makes this an explicit
  //     contract, not a bug.
  //   - Inputs are validated defensively because the renderer is the
  //     trust boundary; a malformed emit must NOT throw across the
  //     IPC boundary or it would tear the renderer process down.
  ipcMain.on('event-log.emit', (_ev, input) => {
    try {
      if (!input || typeof input !== 'object') return;
      const sessionId = (input as any).sessionId;
      const kind = (input as any).kind;
      const payload = (input as any).payload;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      if (typeof kind !== 'string' || kind.length === 0) return;
      const log = getEventLog();
      if (!log) return;
      // Fire-and-forget: the returned promise resolves immediately after
      // enqueue. We intentionally do not await; flushing happens on the
      // 100ms timer inside the EventLog.
      void log.emit({ sessionId, kind: kind as EventKind, payload });
    } catch (e) {
      // Never let an emit failure escape — design treats renderer-side
      // emits as best-effort. Log and continue.
      console.warn('[event-log] emit handler threw:', (e as Error)?.message);
    }
  });
  console.log('[IPC] Event_Bus_Bridge registered');

  // ── Error_Capture_Helper wiring (task 14) ───────────────────────
  // Hand the Error_Capture_Helper our existing lazy EventLog resolver so
  // any catch block that calls `captureError(scope, err, sessionId)` can
  // land an `error.captured` Pipeline_Event through the same singleton
  // writer. Helper sits in `src/pipeline/` and is wired here (rather
  // than imported from there) to avoid a `pipeline → main → pipeline`
  // import cycle. Calls before this point are safely ignored — the
  // helper no-ops when no resolver is registered.
  try {
    const { setEventLogResolver } = require('../pipeline/error-capture');
    setEventLogResolver(() => getEventLog());
    console.log('[IPC] Error_Capture_Helper wired');
  } catch (e) {
    console.warn('[IPC] Error_Capture_Helper wiring failed:', (e as Error)?.message);
  }

  // ── Pipeline Trace IPC ──────────────────────────────────────────
  const { PipelineTraceService } = require('../session/pipeline-trace');
  const pipelineTraceService = new PipelineTraceService(db);

  ipcMain.handle('trace:list', async (_ev: any, sessionId: string) => {
    try { return pipelineTraceService.getTraces(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('trace:get', async (_ev: any, traceId: string) => {
    try { return pipelineTraceService.getTrace(traceId); }
    catch (e: any) { return null; }
  });

  // Expose trace service for pipeline use
  (global as any).__pipelineTraceService = pipelineTraceService;
  console.log('[IPC] Pipeline Trace registered');

  // ── Kanban Board IPC ────────────────────────────────────────────
  const { KanbanService } = require('../kanban/kanban-service');
  const kanbanService = new KanbanService(db);

  ipcMain.handle('kanban:get-board', async (_ev: any, projectId: string) => {
    try {
      const columns = kanbanService.ensureBoard(projectId);
      const cards = kanbanService.getCards(projectId);
      return { columns, cards };
    } catch (e: any) { return { columns: [], cards: [] }; }
  });

  ipcMain.handle('kanban:add-column', async (_ev: any, args: { projectId: string; name: string; color?: string }) => {
    try { return kanbanService.addColumn(args.projectId, args.name, args.color); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('kanban:delete-column', async (_ev: any, columnId: string) => {
    try { return { success: kanbanService.deleteColumn(columnId) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('kanban:add-card', async (_ev: any, args: any) => {
    try { return kanbanService.addCard(args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('kanban:update-card', async (_ev: any, args: { id: string; updates: any }) => {
    try { return { success: kanbanService.updateCard(args.id, args.updates) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('kanban:move-card', async (_ev: any, args: { cardId: string; columnId: string; position?: number }) => {
    try { return { success: kanbanService.moveCard(args.cardId, args.columnId, args.position) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('kanban:delete-card', async (_ev: any, cardId: string) => {
    try { return { success: kanbanService.deleteCard(cardId) }; }
    catch (e: any) { return { success: false }; }
  });
  console.log('[IPC] Kanban Board registered');

  // ── Embedded Browser IPC ────────────────────────────────────────
  ipcMain.handle('browser:save-tab', async (_ev: any, args: { projectId: string; url: string; title?: string }) => {
    try {
      const id = require('node:crypto').randomUUID();
      db.prepare('INSERT INTO browser_tabs (id, project_id, url, title, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, args.projectId, args.url, args.title || args.url, new Date().toISOString());
      return { id, url: args.url, title: args.title || args.url };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('browser:get-tabs', async (_ev: any, projectId: string) => {
    try {
      return db.prepare('SELECT * FROM browser_tabs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    } catch { return []; }
  });

  ipcMain.handle('browser:delete-tab', async (_ev: any, tabId: string) => {
    try { return { success: db.prepare('DELETE FROM browser_tabs WHERE id = ?').run(tabId).changes > 0 }; }
    catch { return { success: false }; }
  });
  console.log('[IPC] Embedded Browser registered');

  // ── P2P Session Sharing IPC ─────────────────────────────────────
  ipcMain.handle('sharing:create', async (_ev: any, args: { sessionId: string; pin: string; mode: string }) => {
    try {
      const crypto = require('node:crypto');
      const id = crypto.randomUUID();
      const pinHash = crypto.createHash('sha256').update(args.pin).digest('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
      db.prepare('INSERT INTO shared_sessions (id, session_id, pin_hash, mode, active, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(id, args.sessionId, pinHash, args.mode || 'read-only', new Date().toISOString(), expiresAt);
      return { id, sessionId: args.sessionId, mode: args.mode, expiresAt };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('sharing:verify-pin', async (_ev: any, args: { shareId: string; pin: string }) => {
    try {
      const crypto = require('node:crypto');
      const pinHash = crypto.createHash('sha256').update(args.pin).digest('hex');
      const row = db.prepare('SELECT * FROM shared_sessions WHERE id = ? AND pin_hash = ? AND active = 1').get(args.shareId, pinHash) as any;
      if (!row) return { valid: false };
      if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false, expired: true };
      return { valid: true, mode: row.mode, sessionId: row.session_id };
    } catch { return { valid: false }; }
  });

  ipcMain.handle('sharing:stop', async (_ev: any, shareId: string) => {
    try { return { success: db.prepare('UPDATE shared_sessions SET active = 0 WHERE id = ?').run(shareId).changes > 0 }; }
    catch { return { success: false }; }
  });

  ipcMain.handle('sharing:list', async (_ev: any, sessionId: string) => {
    try {
      return db.prepare('SELECT id, session_id, mode, active, created_at, expires_at FROM shared_sessions WHERE session_id = ? ORDER BY created_at DESC').all(sessionId);
    } catch { return []; }
  });
  console.log('[IPC] P2P Session Sharing registered');

  // ── Model Packs IPC ─────────────────────────────────────────────
  const { ModelPackManager } = require('../pipeline/model-packs');
  const modelPackManager = new ModelPackManager(db);

  ipcMain.handle('model-packs:list', async () => {
    try { return modelPackManager.list(); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('model-packs:get', async (_ev: any, id: string) => {
    try { return modelPackManager.get(id); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('model-packs:create', async (_ev: any, args: any) => {
    try { return modelPackManager.create(args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('model-packs:update', async (_ev: any, args: { id: string; updates: any }) => {
    try { return { success: modelPackManager.update(args.id, args.updates) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('model-packs:delete', async (_ev: any, id: string) => {
    try { return { success: modelPackManager.delete(id) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('model-packs:set-active', async (_ev: any, args: { projectId: string; packId: string }) => {
    try {
      setCachedConfig('active-model-pack:' + args.projectId, args.packId);
      return { success: true };
    } catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('model-packs:get-active', async (_ev: any, projectId: string) => {
    try {
      const stored = getCachedConfig('active-model-pack:' + projectId);
      if (stored) return stored;
      // Default to "Balanced" pack if none selected
      const balancedRow = db.prepare("SELECT id FROM model_packs WHERE name = 'Balanced'").get() as any;
      if (balancedRow) {
        setCachedConfig('active-model-pack:' + projectId, balancedRow.id);
        return balancedRow.id;
      }
      // Fallback: first pack
      const firstRow = db.prepare("SELECT id FROM model_packs ORDER BY created_at ASC LIMIT 1").get() as any;
      if (firstRow) {
        setCachedConfig('active-model-pack:' + projectId, firstRow.id);
        return firstRow.id;
      }
      return null;
    }
    catch { return null; }
  });
  console.log('[IPC] Model Packs registered');

  // ── Autonomy Manager IPC ────────────────────────────────────────
  const { AutonomyManager } = require('../pipeline/autonomy-manager');
  const autonomyManager = new AutonomyManager(db);
  autonomyManagerRef = autonomyManager;

  ipcMain.handle('autonomy:get', async (_ev: any, projectId: string) => {
    try { return autonomyManager.get(projectId); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('autonomy:set-level', async (_ev: any, args: { projectId: string; level: string }) => {
    try { return autonomyManager.setLevel(args.projectId, args.level as any); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('autonomy:set-custom', async (_ev: any, args: { projectId: string; updates: any }) => {
    try { return autonomyManager.setCustom(args.projectId, args.updates); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('autonomy:get-presets', async () => {
    try { return autonomyManager.getPresets(); }
    catch { return {}; }
  });
  console.log('[IPC] Autonomy Manager registered');

  // ── Smart Model Router IPC ──────────────────────────────────────
  const { SmartModelRouter } = require('../pipeline/smart-router');
  const { ProviderHealthMonitor } = require('../pipeline/provider-health');
  const { getFreeProviders, getAllFreeModels } = require('../pipeline/free-providers');

  const providerHealthMonitor = new ProviderHealthMonitor();
  const smartRouter = new SmartModelRouter();
  smartRouter.setHealthMonitor(providerHealthMonitor);
  smartRouterRef = smartRouter;
  providerHealthRef = providerHealthMonitor;

  // Start health monitor
  providerHealthMonitor.start();

  // Send health updates to renderer
  providerHealthMonitor.onUpdate(function(statuses: any[]) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('provider-health-update', statuses);
    }
  });

  // Register providers with health monitor from saved config
  try {
    const provJson = getCachedConfig('providers');
    if (provJson) {
      const providers = JSON.parse(provJson);
      // Map provider types to their API base URLs
      const providerBaseUrls: Record<string, string> = {
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com/v1',
        deepseek: 'https://api.deepseek.com',
        gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
        grok: 'https://api.x.ai/v1',
        mistral: 'https://api.mistral.ai/v1',
        nvidia: 'https://integrate.api.nvidia.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        ollama: 'http://localhost:11434/v1',
        llamacpp: 'http://localhost:8080/v1',
        openmythos: 'http://localhost:8200/v1',
      };
      for (const p of providers) {
        const baseUrl = p.baseUrl || providerBaseUrls[p.type] || '';
        if (baseUrl) {
          providerHealthMonitor.registerProvider(
            p.name || p.type,
            p.name || p.type,
            baseUrl,
            p.defaultModel || p.model || 'default',
            p.apiKey || ''
          );
        }
      }
    }
  } catch {}

  ipcMain.handle('router:get-config', async () => {
    try { return smartRouter.getConfig(); } catch { return null; }
  });

  ipcMain.handle('router:update-config', async (_ev: any, updates: any) => {
    try { smartRouter.updateConfig(updates); return smartRouter.getConfig(); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('router:set-override', async (_ev: any, args: { provider: string; model: string }) => {
    try { smartRouter.setOverride(args.provider, args.model); return { success: true, provider: args.provider, model: args.model }; } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('router:clear-override', async () => {
    try { smartRouter.clearOverride(); return { success: true }; } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('router:get-override', async () => {
    return smartRouter.getOverride();
  });

  ipcMain.handle('health:get-statuses', async () => {
    try { return providerHealthMonitor.getStatuses(); } catch { return []; }
  });

  ipcMain.handle('health:signal-activity', async () => {
    providerHealthMonitor.signalActivity();
    return { success: true };
  });

  ipcMain.handle('health:start-burst', async () => {
    providerHealthMonitor.startBurst();
    return { success: true };
  });

  ipcMain.handle('free-providers:list', async () => {
    return getFreeProviders();
  });

  ipcMain.handle('free-providers:models', async () => {
    return getAllFreeModels();
  });

  console.log('[IPC] Smart Router, Health Monitor, Free Providers registered');

  // ── AgentMemory IPC (uses internal ProjectMemoryStore — no external service needed) ──
  try {
    // IPC handlers for memory UI panel — backed by internal SQLite ProjectMemoryStore
    ipcMain.handle('agentmemory:status', async () => {
      if (!projectMemoryRef) return { available: false, healthy: false };
      try {
        const allMems = projectMemoryRef.getMemories(activeSessionId || '', 1000);
        return { available: true, healthy: true, memoryCount: allMems.length, sessionCount: 1, version: 'internal' };
      } catch { return { available: true, healthy: true, memoryCount: 0, sessionCount: 0, version: 'internal' }; }
    });

    ipcMain.handle('agentmemory:search', async (_ev: any, args: { project: string; query: string }) => {
      if (!projectMemoryRef) return [];
      try {
        const results = projectMemoryRef.search(args.project, args.query);
        return results.map((m: any) => ({ content: m.content, score: m.confidence, agent: m.source, timestamp: new Date(m.createdAt).toISOString(), type: m.category }));
      } catch { return []; }
    });

    ipcMain.handle('agentmemory:recent', async (_ev: any, args: { project: string }) => {
      if (!projectMemoryRef) return [];
      try {
        const results = projectMemoryRef.getMemories(args.project, 10);
        return results.map((m: any) => ({ content: m.content, score: m.confidence, agent: m.source, timestamp: new Date(m.createdAt).toISOString(), type: m.category }));
      } catch { return []; }
    });

    ipcMain.handle('agentmemory:forget', async (_ev: any, args: { project: string }) => {
      if (!projectMemoryRef) return { success: false };
      try {
        const mems = projectMemoryRef.getMemories(args.project, 1000);
        for (const m of mems) { projectMemoryRef.forget(m.id); }
        return { success: true };
      } catch { return { success: false }; }
    });

    // Send initial status to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agentmemory-status', { available: true });
    }

    console.log('[IPC] AgentMemory handlers registered (internal ProjectMemoryStore)');
  } catch (e: any) {
    console.warn('[IPC] AgentMemory handlers init skipped:', e.message);
  }

  // ── Plan Versioning IPC ─────────────────────────────────────────
  const { PlanVersioningService } = require('../pipeline/plan-versioning');
  const planVersioning = new PlanVersioningService(db);

  ipcMain.handle('plan-version:record', async (_ev: any, args: { planId: string; action: string; snapshot: any; branch?: string; description?: string }) => {
    try { return planVersioning.record(args.planId, args.action, args.snapshot, { branch: args.branch, description: args.description }); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('plan-version:history', async (_ev: any, args: { planId: string; branch?: string }) => {
    try { return planVersioning.getHistory(args.planId, args.branch); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('plan-version:latest', async (_ev: any, args: { planId: string; branch?: string }) => {
    try { return planVersioning.getLatest(args.planId, args.branch); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('plan-version:rewind', async (_ev: any, args: { planId: string; targetVersion: number; branch?: string }) => {
    try { return { success: planVersioning.rewind(args.planId, args.targetVersion, args.branch) }; }
    catch (e: any) { return { success: false }; }
  });

  ipcMain.handle('plan-version:create-branch', async (_ev: any, args: { planId: string; branchName: string; parentBranch?: string }) => {
    try { return planVersioning.createBranch(args.planId, args.branchName, args.parentBranch); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('plan-version:list-branches', async (_ev: any, planId: string) => {
    try { return planVersioning.listBranches(planId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('plan-version:delete-branch', async (_ev: any, args: { planId: string; branchName: string }) => {
    try { return { success: planVersioning.deleteBranch(args.planId, args.branchName) }; }
    catch (e: any) { return { success: false }; }
  });
  console.log('[IPC] Plan Versioning registered');

  // ── Smart Context IPC ───────────────────────────────────────────
  const { SmartContextManager } = require('../pipeline/smart-context');
  const smartContext = new SmartContextManager(db);

  ipcMain.handle('smart-context:record', async (_ev: any, args: { sessionId: string; stepNum: number; files: string[]; totalTokens: number; reason?: string }) => {
    try { return smartContext.recordSelection(args.sessionId, args.stepNum, args.files, args.totalTokens, args.reason); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('smart-context:selections', async (_ev: any, sessionId: string) => {
    try { return smartContext.getSelections(sessionId); }
    catch (e: any) { return []; }
  });

  ipcMain.handle('smart-context:latest', async (_ev: any, sessionId: string) => {
    try { return smartContext.getLatest(sessionId); }
    catch (e: any) { return null; }
  });

  ipcMain.handle('smart-context:select-files', async (_ev: any, args: { allFiles: string[]; task: string; maxTokens: number }) => {
    try {
      // F2 Call Site Wiring (Req 13): obtain the budget from the shared
      // Token_Budget_Calculator instead of forwarding a raw/hardcoded value.
      // A positive finite caller `maxTokens` is honored as an explicit override
      // (clamped to what the active model can hold); otherwise the budget scales
      // to the active model's context window, falling back to the calculator's
      // documented defaults when the context length is unknown.
      const { configured, explicit } = resolveBudgetInputs(args?.maxTokens);
      const contextLength = getActiveContextLength(resolveActiveProviderRecord());
      const budget = computeInputTokenBudget(configured, contextLength, explicit);
      return smartContext.selectFilesForStep(args.allFiles, args.task, budget);
    }
    catch (e: any) { return args.allFiles; }
  });

  ipcMain.handle('smart-context:stats', async (_ev: any, sessionId: string) => {
    try { return smartContext.getStats(sessionId); }
    catch (e: any) { return { totalSteps: 0, avgFiles: 0, avgTokens: 0, peakTokens: 0 }; }
  });
  console.log('[IPC] Smart Context registered');

  // ── Inline Code Completion IPC ──────────────────────────────────
  const { InlineCompletionService } = require('../completion/inline-completion-service');
  const completionService = new InlineCompletionService(db);

  ipcMain.handle('completion:generate', async (_ev: any, args: { filePath: string; prefix: string; suffix?: string; language?: string; sessionId?: string }) => {
    try {
      const start = Date.now();
      const client = resolveActiveLLMClient();
      if (!client) return { error: 'No AI provider configured' };

      const prompt = completionService.buildCompletionPrompt(args);
      const result = await client.chat([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ], { temperature: 0.2, maxTokens: 256 });

      const completion = (result.content || '').trim();
      if (!completion) return { completion: '' };

      const latency = Date.now() - start;
      const recorded = completionService.recordCompletion(args, completion, undefined, undefined, latency);
      return { id: recorded.id, completion: recorded.completion, latencyMs: latency };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('completion:accept', async (_ev: any, id: string) => {
    try { return { success: completionService.acceptCompletion(id) }; }
    catch { return { success: false }; }
  });

  ipcMain.handle('completion:stats', async (_ev: any, sessionId?: string) => {
    try { return completionService.getStats(sessionId); }
    catch { return { totalCompletions: 0, acceptedCompletions: 0, acceptanceRate: 0, avgLatencyMs: 0 }; }
  });
  console.log('[IPC] Inline Code Completion registered');

  // ── CI/PR Checks IPC ───────────────────────────────────────────
  const { CICheckService, BUILTIN_CHECK_TEMPLATES } = require('../ci/ci-check-service');
  const ciCheckService = new CICheckService(db);

  ipcMain.handle('ci:list-checks', async (_ev: any, projectId: string) => {
    try { return ciCheckService.listChecks(projectId); }
    catch { return []; }
  });

  ipcMain.handle('ci:create-check', async (_ev: any, args: any) => {
    try { return ciCheckService.createCheck(args); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('ci:toggle-check', async (_ev: any, args: { id: string; enabled: boolean }) => {
    try { return { success: ciCheckService.toggleCheck(args.id, args.enabled) }; }
    catch { return { success: false }; }
  });

  ipcMain.handle('ci:delete-check', async (_ev: any, id: string) => {
    try { return { success: ciCheckService.deleteCheck(id) }; }
    catch { return { success: false }; }
  });

  ipcMain.handle('ci:run-check', async (_ev: any, args: { checkId: string; projectId: string; files: string[] }) => {
    try {
      const check = ciCheckService.getCheck(args.checkId);
      if (!check) return { error: 'Check not found' };

      const run = ciCheckService.startRun(args.checkId, args.projectId, args.files);
      const client = resolveActiveLLMClient();
      if (!client) {
        ciCheckService.completeRun(run.id, false, 'No AI provider configured');
        return { error: 'No AI provider configured' };
      }

      // Build context from files
      const os = require('node:os');
      const pathMod = require('node:path');
      const fsMod = require('node:fs');
      let fileContext = '';
      for (const f of args.files.slice(0, 10)) {
        try {
          const fullPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId, f);
          if (fsMod.existsSync(fullPath)) {
            const content = fsMod.readFileSync(fullPath, 'utf-8').slice(0, 5000);
            fileContext += `\n--- ${f} ---\n${content}\n`;
          }
        } catch {}
      }

      const result = await client.chat([
        { role: 'system', content: 'You are a code review agent. Analyze the code and determine if it passes the check. Respond with PASS if the code is fine, or FAIL followed by the issues found and suggested fixes.' },
        { role: 'user', content: `Check: ${check.name}\n${check.prompt}\n\nFiles to review:\n${fileContext}` },
      ], { temperature: 0.3, maxTokens: 2048 });

      const response = result.content || '';
      const passed = response.toUpperCase().startsWith('PASS');
      ciCheckService.completeRun(run.id, passed, response, passed ? undefined : response);

      mainWindow.webContents.send('ci:check-completed', { runId: run.id, checkId: args.checkId, passed });
      return { runId: run.id, passed, result: response };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('ci:recent-runs', async (_ev: any, projectId: string) => {
    try { return ciCheckService.getRecentRuns(projectId); }
    catch { return []; }
  });

  ipcMain.handle('ci:run-stats', async (_ev: any, projectId: string) => {
    try { return ciCheckService.getRunStats(projectId); }
    catch { return { total: 0, passed: 0, failed: 0, running: 0 }; }
  });

  ipcMain.handle('ci:get-templates', async () => {
    return BUILTIN_CHECK_TEMPLATES;
  });
  console.log('[IPC] CI/PR Checks registered');

  // ── Auto Lint/Test IPC ──────────────────────────────────────────
  const { AutoLintTestService } = require('../lint/auto-lint-test-service');
  const lintTestService = new AutoLintTestService(db);
  lintTestServiceRef = lintTestService;

  ipcMain.handle('lint-test:get-config', async (_ev: any, projectId: string) => {
    try { return lintTestService.getConfig(projectId); }
    catch { return null; }
  });

  ipcMain.handle('lint-test:set-config', async (_ev: any, args: { projectId: string; updates: any }) => {
    try { return lintTestService.setConfig(args.projectId, args.updates); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('lint-test:run', async (_ev: any, args: { projectId: string; type: string; command: string; triggeredBy?: string }) => {
    try {
      const { execSync } = require('node:child_process');
      const os = require('node:os');
      const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);

      let output = '';
      let exitCode = 0;
      try {
        output = execSync(args.command, { cwd: projectPath, timeout: 60000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        exitCode = e.status || 1;
        output = (e.stdout || '') + '\n' + (e.stderr || '');
      }

      const run = lintTestService.recordRun(args.projectId, args.type as any, args.command, exitCode, output, args.triggeredBy);
      return { ...run, exitCode, output: output.slice(0, 5000) };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('lint-test:recent-runs', async (_ev: any, projectId: string) => {
    try { return lintTestService.getRecentRuns(projectId); }
    catch { return []; }
  });

  ipcMain.handle('lint-test:stats', async (_ev: any, projectId: string) => {
    try { return lintTestService.getStats(projectId); }
    catch { return { lintRuns: 0, lintPassed: 0, testRuns: 0, testPassed: 0, autoFixes: 0 }; }
  });

  ipcMain.handle('lint-test:detect', async (_ev: any, projectId: string) => {
    try {
      const os = require('node:os');
      const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', projectId);
      return lintTestService.detectCommands(projectPath);
    } catch { return {}; }
  });
  console.log('[IPC] Auto Lint/Test registered');

  // ── Voice-to-Code IPC (placeholder for voice input processing) ──
  ipcMain.handle('voice:transcribe', async (_ev: any, args: { audioBase64: string }) => {
    try {
      // Voice transcription would use Whisper API or similar
      // For now, return a placeholder indicating the feature is available
      return { text: '', error: 'Voice transcription requires an OpenAI API key with Whisper access. Configure in Settings.' };
    } catch (e: any) { return { error: e.message }; }
  });

  // ── Voice TTS: Copy bundled files on startup ──
  try {
    const { ensureBundledFilesCopied } = require('../voice/tts-engine');
    ensureBundledFilesCopied();
    console.log('[Voice] Bundled model files synced to ~/.neuronest/voice-models/');
  } catch (err: any) {
    console.warn('[Voice] Failed to copy bundled files:', err.message);
  }

  ipcMain.handle('voice:get-config', async (): Promise<VoiceGetConfigResult> => {
    try {
      const { areModelsReady, areLargeModelsDownloaded, getAvailableVoices } = require('../voice/tts-engine');
      const enabled = getCachedConfig('voice-enabled') === 'true';
      const modelsReady = areModelsReady();
      const largeModelsDownloaded = areLargeModelsDownloaded();
      const voices = modelsReady ? getAvailableVoices() : [];
      const voiceStyle = getCachedConfig('voice-style') || 'M1';
      const speed = parseFloat(getCachedConfig('voice-speed') || '1.05');
      return { enabled, modelsReady, largeModelsDownloaded, voices, voiceStyle, speed, provider: 'supertonic-local' };
    } catch { return { enabled: false, modelsReady: false, largeModelsDownloaded: false, voices: [], voiceStyle: 'M1', speed: 1.05 }; }
  });

  ipcMain.handle('voice:set-config', async (_ev: unknown, args: unknown) => {
    if (!isVoiceSetConfigArgs(args)) return { success: false, error: 'Invalid arguments' };
    const v = args as VoiceSetConfigArgs;
    try {
      if (v.enabled !== undefined) setCachedConfig('voice-enabled', v.enabled ? 'true' : 'false');
      if (v.voiceStyle) setCachedConfig('voice-style', v.voiceStyle);
      if (v.speed !== undefined) setCachedConfig('voice-speed', String(v.speed));
      return { success: true };
    } catch { return { success: false }; }
  });

  ipcMain.handle('voice:download-models', async () => {
    try {
      const { downloadVoiceModels } = require('../voice/model-downloader');
      const result = await downloadVoiceModels((progress: any) => {
        mainWindow.webContents.send('voice:download-progress', progress);
      });
      return { success: result };
    } catch (err: any) {
      mainWindow.webContents.send('voice:download-progress', {
        phase: 'error', percent: 0, bytesDownloaded: 0, totalBytes: 0, currentFile: '', message: err.message,
      });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('voice:models-ready', async () => {
    try {
      const { areModelsReady } = require('../voice/tts-engine');
      return { ready: areModelsReady() };
    } catch { return { ready: false }; }
  });

  ipcMain.handle('voice:synthesize', async (_ev: unknown, args: unknown): Promise<VoiceSynthesizeResult> => {
    if (!isVoiceSynthesizeArgs(args)) return { success: false, error: 'Invalid arguments' };
    const v = args as VoiceSynthesizeArgs;

    // Gate: refuse synthesis if voice is disabled in settings (Requirement: audio only plays when enabled)
    const voiceEnabledSetting = getCachedConfig('voice-enabled');
    if (voiceEnabledSetting !== 'true') {
      return { success: false, error: 'Voice is disabled' };
    }

    try {
      const { stripMarkdownForTTS, getVoiceModelsDir, areModelsReady } = require('../voice/tts-engine');
      const { SupertonicTTS } = require('../voice/supertonic-tts');

      let cleanText = stripMarkdownForTTS(v.text);
      if (!cleanText || cleanText.length < 3) return { success: false, error: 'No speakable text' };

      // Summarize long responses before TTS (>300 chars = likely a full agent response)
      if (cleanText.length > 300) {
        try {
          const llm = resolveActiveLLMClient();
          if (llm) {
            const summaryResult = await llm.chat([
              { role: 'system', content: 'You are a concise summarizer. Summarize the following AI agent response into 1-3 short spoken sentences suitable for text-to-speech. Keep it natural and conversational. Do not use bullet points, code, or formatting. Maximum 200 words.' },
              { role: 'user', content: cleanText.slice(0, 3000) },
            ], { temperature: 0.3, maxTokens: 150 });
            const summary = (summaryResult.content || '').trim();
            if (summary && summary.length > 10 && summary.length < cleanText.length) {
              cleanText = summary;
            }
          }
        } catch {
          // Summarization failed — use the original text (truncated for TTS)
          if (cleanText.length > 800) {
            cleanText = cleanText.slice(0, 800) + '. That is the summary of the response.';
          }
        }
      }

      // Check if full models are available
      if (!areModelsReady()) {
        return { success: true, text: cleanText, useWebSpeech: true };
      }

      const modelsDir = getVoiceModelsDir();

      // Use Supertonic ONNX inference
      if (!(global as any)._supertonicTTS) {
        (global as any)._supertonicTTS = new SupertonicTTS(modelsDir);
      }

      const voiceStyle = v.voiceStyle || getCachedConfig('voice-style') || 'M1';
      const speed = v.speed || parseFloat(getCachedConfig('voice-speed') || '1.05');
      const lang = v.lang || 'en';

      const wavBuffer = await (global as any)._supertonicTTS.synthesize(cleanText, lang, voiceStyle, speed, 8);

      return { success: true, audio: wavBuffer.toString('base64'), sampleRate: (global as any)._supertonicTTS.sampleRate, useWebSpeech: false };
    } catch (err: any) {
      console.error('[Voice] Synthesis error:', err.message);
      const { stripMarkdownForTTS } = require('../voice/tts-engine');
      const cleanText = stripMarkdownForTTS(v.text);
      return { success: true, text: cleanText, useWebSpeech: true };
    }
  });

  console.log('[IPC] Voice TTS registered (Supertonic on-device)');

  // ── Scheduler IPC ──────────────────────────────────────────────
  ipcMain.handle('scheduler:add', async (_ev: any, args: { projectId: string; name: string; schedule: string; task: string }) => {
    try { if (!cronScheduler) return { error: 'Scheduler not initialized' }; return cronScheduler.addJob(args.projectId, args.name, args.schedule, args.task); }
    catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('scheduler:remove', async (_ev: any, id: string) => { try { return { success: cronScheduler?.removeJob(id) ?? false }; } catch { return { success: false }; } });
  ipcMain.handle('scheduler:list', async (_ev: any, projectId?: string) => { try { return cronScheduler?.listJobs(projectId) ?? []; } catch { return []; } });
  ipcMain.handle('scheduler:pause', async (_ev: any, id: string) => { try { return { success: cronScheduler?.pauseJob(id) ?? false }; } catch { return { success: false }; } });
  ipcMain.handle('scheduler:resume', async (_ev: any, id: string) => { try { return { success: cronScheduler?.resumeJob(id) ?? false }; } catch { return { success: false }; } });

  // ── Skill Learner IPC ──────────────────────────────────────────
  ipcMain.handle('skills:learned-list', async () => { try { return skillLearner?.listSkills() ?? []; } catch { return []; } });
  ipcMain.handle('skills:learned-delete', async (_ev: any, id: string) => { try { return { success: skillLearner?.deleteSkill(id) ?? false }; } catch { return { success: false }; } });
  ipcMain.handle('skills:find-matching', async (_ev: any, message: string) => { try { return skillLearner?.findMatchingSkill(message) ?? null; } catch { return null; } });

  // ── Subagent IPC ───────────────────────────────────────────────
  ipcMain.handle('subagent:spawn', async (_ev: any, args: { name: string; task: string; systemPrompt?: string }) => {
    try {
      const llm = resolveActiveLLMClient();
      if (!llm) return { success: false, error: 'No LLM provider configured' };
      const result = await spawnSubagent({ id: require('node:crypto').randomUUID(), name: args.name, task: args.task, systemPrompt: args.systemPrompt }, llm);
      return result;
    } catch (e: any) { return { success: false, error: e.message }; }
  });

  console.log('[IPC] Scheduler, Skill Learner, Subagent handlers registered');

  // ── OS Mode IPC (screenshot + click control) ────────────────────
  ipcMain.handle('os-mode:screenshot', async () => {
    try {
      const { desktopCapturer } = require('electron');
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
      if (sources.length > 0) {
        const thumbnail = sources[0].thumbnail.toDataURL();
        return { screenshot: thumbnail };
      }
      return { error: 'No screen sources available' };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('os-mode:get-config', async () => {
    try {
      const enabled = getCachedConfig('os-mode-enabled') === 'true';
      return { enabled };
    } catch { return { enabled: false }; }
  });

  ipcMain.handle('os-mode:set-config', async (_ev: any, args: { enabled: boolean }) => {
    try {
      setCachedConfig('os-mode-enabled', args.enabled ? 'true' : 'false');
      return { success: true };
    } catch { return { success: false }; }
  });
  console.log('[IPC] OS Mode registered');

  // ── Remaining Features IPC (batch registration) ─────────────────
  const RF = require('../features/remaining-features-service');

  const worktreeService = new RF.GitWorktreeService(db);
  const notificationService = new RF.NotificationService(db);
  notificationServiceRef = notificationService;
  const contextItemService = new RF.ContextItemService(db);
  const promptCacheService = new RF.PromptCacheService(db);
  promptCacheRef = promptCacheService;
  const configProfileService = new RF.ConfigProfileService(db);
  configProfileRef = configProfileService;
  const personaService = new RF.PersonaService(db);
  const sessionStatusService = new RF.SessionStatusService(db);
  const fileLinkService = new RF.FileSessionLinkService(db);
  const planArchiveService = new RF.PlanArchiveService(db);
  const alertService = new RF.SessionAlertService(db);
  const globalSearchService = new RF.GlobalSearchService(db);
  const onboardingService = new RF.OnboardingService(db);
  const decisionLogService = new RF.DecisionLogService(db);

  // Git Worktrees
  ipcMain.handle('worktree:create', async (_ev: any, args: any) => { try { return worktreeService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('worktree:list', async (_ev: any, projectId: string) => { try { return worktreeService.list(projectId); } catch { return []; } });
  ipcMain.handle('worktree:delete', async (_ev: any, id: string) => { try { return { success: worktreeService.delete(id) }; } catch { return { success: false }; } });

  // Notifications
  ipcMain.handle('notifications:get-config', async (_ev: any, projectId: string) => { try { return notificationService.getConfig(projectId); } catch { return null; } });
  ipcMain.handle('notifications:set-config', async (_ev: any, args: { projectId: string; updates: any }) => { try { return notificationService.setConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('notifications:send', async (_ev: any, args: { title: string; body: string }) => {
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) { new Notification({ title: args.title, body: args.body }).show(); return { success: true }; }
      return { success: false, error: 'Notifications not supported' };
    } catch (e: any) { return { success: false, error: e.message }; }
  });

  // Context Items (Image/URL/Note/Pipe)
  ipcMain.handle('context:add', async (_ev: any, args: any) => { try { return contextItemService.add(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('context:list', async (_ev: any, sessionId: string) => { try { return contextItemService.list(sessionId); } catch { return []; } });
  ipcMain.handle('context:remove', async (_ev: any, id: string) => { try { return { success: contextItemService.remove(id) }; } catch { return { success: false }; } });
  ipcMain.handle('context:load-url', async (_ev: any, args: { sessionId: string; url: string }) => {
    try {
      const https = require('node:https'); const http = require('node:http');
      const parsed = new URL(args.url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const content: string = await new Promise((resolve, reject) => {
        mod.get(args.url, { timeout: 10000 }, (res: any) => {
          let body = ''; res.on('data', (c: any) => body += c); res.on('end', () => resolve(body.slice(0, 50000)));
        }).on('error', reject);
      });
      return contextItemService.add({ sessionId: args.sessionId, type: 'url', source: args.url, content, tokenEstimate: Math.ceil(content.length / 4) });
    } catch (e: any) { return { error: e.message }; }
  });

  // Prompt Cache
  ipcMain.handle('prompt-cache:stats', async () => { try { return promptCacheService.getStats(); } catch { return { totalEntries: 0, totalHits: 0, estimatedSavings: 0 }; } });
  ipcMain.handle('prompt-cache:clear', async () => { try { promptCacheService.clear(); return { success: true }; } catch { return { success: false }; } });

  // Headroom prompt compression telemetry (Slice 1)
  // Stats are populated by maybeCompressMessages() in src/pipeline/headroom-compressor.ts.
  // Shape: { totalCalls, successfulCompressions, skippedCalls, failedCalls,
  //          tokensSavedTotal, tokensBeforeTotal, lastError? }
  // The renderer polls this for a savings ribbon and to show "Proxy down"
  // status when failedCalls > 0 with lastError matching connection patterns.
  try {
    const { getHeadroomStats, resetHeadroomStats } = require('../pipeline/headroom-compressor');
    const headroomFlags = require('./performance/feature-flags');
    ipcMain.handle('headroom:stats', async () => {
      try {
        return {
          ...getHeadroomStats(),
          flagEnabled: !!headroomFlags.PERF_FLAGS.HEADROOM_COMPRESSION,
          minBytes: headroomFlags.HEADROOM_CONFIG.minBytes,
          proxyUrl: headroomFlags.HEADROOM_CONFIG.defaultProxyUrl,
          proxyConfigured: !!headroomFlags.HEADROOM_CONFIG.proxyConfigured,
        };
      } catch (e: any) {
        return { error: e?.message ?? 'unknown' };
      }
    });
    ipcMain.handle('headroom:reset', async () => {
      try { resetHeadroomStats(); return { success: true }; } catch { return { success: false }; }
    });
    // Persist the toggle state across restarts via the existing config cache
    // so the user doesn't have to re-flip after every relaunch.
    ipcMain.handle('headroom:set-enabled', async (_ev, arg: any) => {
      try {
        const enabled = typeof arg === 'boolean' ? arg : !!(arg && arg.enabled);
        headroomFlags.PERF_FLAGS.HEADROOM_COMPRESSION = enabled;
        try { setCachedConfig('headroom-enabled', enabled ? '1' : '0'); } catch {}
        return { success: true, enabled };
      } catch (e: any) {
        return { success: false, error: e?.message ?? 'unknown' };
      }
    });
    // ── Slice 2: Renderer-callable compression for individual file payloads ──
    // The renderer's sendChat() inlines attached text/code files as fenced
    // blocks. When Slice 1's flag is on, those blocks would still pay the
    // chat-time round-trip; instead, the renderer can call this handler at
    // attach-time to pre-compress each file once (Headroom routes per-file
    // by content-type hint, picking CodeCompressor / SmartCrusher / prose).
    // The compressed string replaces the inlined content in pipelineText so
    // we don't double-compress at LLMClient.chat() time.
    //
    // Shape:
    //   in:  { content: string, contentType?: 'code'|'json'|'prose'|'logs', model?: string }
    //   out: { compressed: boolean, content: string, tokensBefore, tokensAfter, savings }
    ipcMain.handle('headroom:compress-text', async (_ev, arg: any) => {
      try {
        if (!headroomFlags.PERF_FLAGS.HEADROOM_COMPRESSION) {
          return { compressed: false, content: String(arg?.content ?? ''), tokensBefore: 0, tokensAfter: 0, savings: 0, skipReason: 'flag-off' };
        }
        const content = String(arg?.content ?? '');
        if (!content || content.length < headroomFlags.HEADROOM_CONFIG.minBytes) {
          return { compressed: false, content, tokensBefore: 0, tokensAfter: 0, savings: 0, skipReason: 'below-min-bytes' };
        }
        // Wrap as a single user-message and route through the same helper —
        // keeps the SDK call shape consistent with chat() and reuses the
        // telemetry/timeout/fallback machinery.
        const { maybeCompressMessages } = require('../pipeline/headroom-compressor');
        const result = await maybeCompressMessages(
          [{ role: 'user', content }],
          { model: typeof arg?.model === 'string' ? arg.model : undefined },
        );
        if (!result.compressed) {
          return { compressed: false, content, tokensBefore: 0, tokensAfter: 0, savings: 0, skipReason: result.skipReason };
        }
        const out = result.messages[0];
        const compressedContent = typeof out?.content === 'string' ? out.content : content;
        return {
          compressed: true,
          content: compressedContent,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          savings: result.tokensBefore - result.tokensAfter,
        };
      } catch (e: any) {
        return { compressed: false, content: String(arg?.content ?? ''), tokensBefore: 0, tokensAfter: 0, savings: 0, error: e?.message ?? 'unknown' };
      }
    });
    // Restore persisted state at startup so the toggle reflects the user's
    // last explicit preference. Compression defaults ON (always-on, self-
    // contained); an explicit persisted '0' still lets a user opt out, and a
    // persisted '1' re-affirms ON.
    try {
      const persisted = getCachedConfig('headroom-enabled');
      if (persisted === '1') {
        headroomFlags.PERF_FLAGS.HEADROOM_COMPRESSION = true;
        console.log('[IPC] Compression: restored persisted toggle ON');
      } else if (persisted === '0') {
        headroomFlags.PERF_FLAGS.HEADROOM_COMPRESSION = false;
        console.log('[IPC] Compression: restored persisted toggle OFF');
      }
    } catch {}
  } catch (e: any) {
    console.warn('[IPC] Headroom telemetry not available:', e?.message);
  }


  // Config Profiles — switching profiles loads their saved providers/model-pack settings
  ipcMain.handle('profiles:list', async () => { try { return configProfileService.list(); } catch { return []; } });
  ipcMain.handle('profiles:create', async (_ev: any, args: { name: string; description?: string; settings?: any }) => {
    try {
      // New profiles inherit current providers + default-provider from the default profile
      const profile = configProfileService.create(args.name, args.description, args.settings);
      return profile;
    } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('profiles:activate', async (_ev: any, id: string) => {
    try {
      // Activate the new profile — this only affects agent-to-provider/model mappings
      const success = configProfileService.activate(id);
      if (!success) return { success: false };
      // Clear config cache so agent-model lookups use the new profile
      configCache.clear();
      return { success: true };
    } catch { return { success: false }; }
  });
  ipcMain.handle('profiles:delete', async (_ev: any, id: string) => { try { return { success: configProfileService.delete(id) }; } catch { return { success: false }; } });

  // Team Personas
  ipcMain.handle('personas:list', async () => { try { return personaService.list(); } catch { return []; } });
  ipcMain.handle('personas:create', async (_ev: any, args: any) => { try { return personaService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('personas:delete', async (_ev: any, id: string) => { try { return { success: personaService.delete(id) }; } catch { return { success: false }; } });

  // Session Status
  ipcMain.handle('session-status:get', async (_ev: any, sessionId: string) => { try { return sessionStatusService.get(sessionId); } catch { return { status: 'idle' }; } });
  ipcMain.handle('session-status:set', async (_ev: any, args: { sessionId: string; status: string; lastActivity?: string }) => { try { sessionStatusService.set(args.sessionId, args.status, args.lastActivity); return { success: true }; } catch { return { success: false }; } });

  // File-Session Links
  ipcMain.handle('file-links:link', async (_ev: any, args: { sessionId: string; filePath: string; action: string }) => { try { fileLinkService.link(args.sessionId, args.filePath, args.action); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('file-links:for-session', async (_ev: any, sessionId: string) => { try { return fileLinkService.getFilesForSession(sessionId); } catch { return []; } });
  ipcMain.handle('file-links:for-file', async (_ev: any, filePath: string) => { try { return fileLinkService.getSessionsForFile(filePath); } catch { return []; } });

  // Plan Archive
  ipcMain.handle('archive:create', async (_ev: any, args: { sessionId: string; name: string; snapshot?: any }) => { try { return { id: planArchiveService.archive(args.sessionId, args.name, args.snapshot || {}) }; } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('archive:list', async () => { try { return planArchiveService.list(); } catch { return []; } });
  ipcMain.handle('archive:unarchive', async (_ev: any, id: string) => { try { return planArchiveService.unarchive(id); } catch { return null; } });

  // Session Alerts
  ipcMain.handle('alerts:create', async (_ev: any, args: { sessionId: string; type: string; severity: string; message: string }) => { try { return { id: alertService.create(args.sessionId, args.type, args.severity, args.message) }; } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('alerts:active', async (_ev: any, sessionId: string) => { try { return alertService.getActive(sessionId); } catch { return []; } });
  ipcMain.handle('alerts:dismiss', async (_ev: any, id: string) => { try { return { success: alertService.dismiss(id) }; } catch { return { success: false }; } });
  ipcMain.handle('alerts:dismiss-all', async (_ev: any, sessionId: string) => { try { return { count: alertService.dismissAll(sessionId) }; } catch { return { count: 0 }; } });

  // Global Search
  ipcMain.handle('global-search:search', async (_ev: any, args: { query: string; limit?: number }) => { try { return globalSearchService.search(args.query, args.limit); } catch { return []; } });
  ipcMain.handle('global-search:index', async (_ev: any, args: { sessionId: string; contentType: string; content: string; metadata?: any }) => { try { globalSearchService.index(args.sessionId, args.contentType, args.content, args.metadata); return { success: true }; } catch { return { success: false }; } });

  // Onboarding
  ipcMain.handle('onboarding:progress', async () => { try { return onboardingService.getProgress(); } catch { return { completedSteps: [], currentStep: 0, dismissed: false }; } });
  ipcMain.handle('onboarding:complete-step', async (_ev: any, stepId: string) => { try { onboardingService.completeStep(stepId); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('onboarding:dismiss', async () => { try { onboardingService.dismiss(); return { success: true }; } catch { return { success: false }; } });

  // Decision Log
  ipcMain.handle('decisions:create', async (_ev: any, args: any) => { try { return decisionLogService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('decisions:list', async (_ev: any, projectId: string) => { try { return decisionLogService.list(projectId); } catch { return []; } });
  ipcMain.handle('decisions:supersede', async (_ev: any, id: string) => { try { return { success: decisionLogService.supersede(id) }; } catch { return { success: false }; } });
  ipcMain.handle('decisions:delete', async (_ev: any, id: string) => { try { return { success: decisionLogService.delete(id) }; } catch { return { success: false }; } });

  // App Zoom
  ipcMain.handle('zoom:get', async () => { try { const r = db.prepare("SELECT value FROM app_preferences WHERE key = 'zoom-level'").get() as any; return { level: r ? parseFloat(r.value) : 1.0 }; } catch { return { level: 1.0 }; } });
  ipcMain.handle('zoom:set', async (_ev: any, level: number) => { try { db.prepare("INSERT OR REPLACE INTO app_preferences (key, value, updated_at) VALUES ('zoom-level', ?, ?)").run(String(level), new Date().toISOString()); mainWindow.webContents.setZoomFactor(level); return { success: true }; } catch { return { success: false }; } });

  // Auto-Commit with AI Messages
  ipcMain.handle('git:auto-commit', async (_ev: any, args: { projectId: string; message?: string }) => {
    try {
      const { execSync } = require('node:child_process');
      const os = require('node:os');
      const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      // Generate commit message if not provided
      let msg = args.message || 'AI-generated changes via NeuroNest';
      if (!args.message) {
        const client = resolveActiveLLMClient();
        if (client) {
          try {
            const diff = execSync('git diff --staged --stat', { cwd: projectPath, encoding: 'utf-8', timeout: 5000 }).slice(0, 2000);
            if (diff.trim()) {
              const result = await client.chat([
                { role: 'system', content: 'Generate a concise git commit message (max 72 chars first line) for these changes. Output ONLY the commit message, no explanation.' },
                { role: 'user', content: diff },
              ], { temperature: 0.3, maxTokens: 100 });
              if (result.content) msg = result.content.trim().split('\n')[0]!.slice(0, 72);
            }
          } catch {}
        }
      }
      const { execFileSync: execFile } = require('node:child_process');
      execFile('git', ['add', '-A'], { cwd: projectPath, timeout: 10000 });
      execFile('git', ['commit', '-m', msg], { cwd: projectPath, timeout: 10000 });
      return { success: true, message: msg };
    } catch (e: any) { return { success: false, error: e.message }; }
  });

  console.log('[IPC] All remaining features registered');

  // ── Goose-Inspired Features IPC ─────────────────────────────────
  const { RecipeService } = require('../recipes/recipe-service');
  const recipeService = new RecipeService(db);
  const GF = require('../agents/goose-features-service');
  const subagentService = new GF.SubagentService(db);
  const toolPermService = new GF.ToolPermissionService(db);
  const adversaryService = new GF.AdversaryReviewerService(db);
  const compactionService = new GF.ContextCompactionService(db);
  const turnService = new GF.TurnManagementService(db);
  const schemaService = new GF.ResponseSchemaService(db);

  // Recipes
  ipcMain.handle('recipes:list', async () => { try { return recipeService.list(); } catch { return []; } });
  ipcMain.handle('recipes:get', async (_ev: any, id: string) => { try { return recipeService.get(id); } catch { return null; } });
  ipcMain.handle('recipes:create', async (_ev: any, args: any) => { try { return recipeService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('recipes:delete', async (_ev: any, id: string) => { try { return { success: recipeService.delete(id) }; } catch { return { success: false }; } });
  ipcMain.handle('recipes:run', async (_ev: any, args: { recipeId: string; projectId?: string; params?: any }) => {
    try {
      const recipe = recipeService.get(args.recipeId);
      if (!recipe) return { error: 'Recipe not found' };
      const run = recipeService.startRun(args.recipeId, args.projectId, args.params);
      const rendered = recipeService.renderInstructions(recipe.instructions, args.params || {});
      const client = resolveActiveLLMClient();
      if (!client) { recipeService.completeRun(run.id, false, 'No AI provider'); return { error: 'No AI provider' }; }
      const result = await client.chat([{ role: 'system', content: 'You are executing a recipe workflow. Follow the instructions precisely.' }, { role: 'user', content: rendered }], { temperature: 0.5, maxTokens: 4096 });
      recipeService.completeRun(run.id, true, result.content);
      return { runId: run.id, output: result.content };
    } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('recipes:recent-runs', async () => { try { return recipeService.getRecentRuns(); } catch { return []; } });
  ipcMain.handle('recipes:deeplink', async (_ev: any, args: { recipeId: string; params?: any }) => { try { return { code: recipeService.createDeeplink(args.recipeId, args.params) }; } catch (e: any) { return { error: e.message }; } });

  // Subagents
  ipcMain.handle('subagents:create', async (_ev: any, args: any) => { try { return subagentService.create(args.parentSessionId, args.instructions, args.model, args.maxTurns); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('subagents:list', async (_ev: any, parentSessionId: string) => { try { return subagentService.listForSession(parentSessionId); } catch { return []; } });
  ipcMain.handle('subagents:run', async (_ev: any, args: { id: string }) => {
    try {
      const task = subagentService.get(args.id);
      if (!task) return { error: 'Task not found' };
      subagentService.updateStatus(args.id, 'running');
      const client = resolveActiveLLMClient();
      if (!client) { subagentService.updateStatus(args.id, 'failed', 'No AI provider'); return { error: 'No AI provider' }; }
      const result = await client.chat([{ role: 'user', content: task.instructions }], { temperature: 0.5, maxTokens: 4096 });
      subagentService.updateStatus(args.id, 'completed', result.content);
      return { result: result.content };
    } catch (e: any) { subagentService.updateStatus(args.id, 'failed', e.message); return { error: e.message }; }
  });

  // Tool Permissions
  ipcMain.handle('tool-perms:get', async (_ev: any, args: { projectId: string; toolName: string }) => { try { return { level: toolPermService.get(args.projectId, args.toolName) }; } catch { return { level: 'confirm' }; } });
  ipcMain.handle('tool-perms:set', async (_ev: any, args: { projectId: string; toolName: string; level: string }) => { try { toolPermService.set(args.projectId, args.toolName, args.level); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('tool-perms:list', async (_ev: any, projectId: string) => { try { return toolPermService.listForProject(projectId); } catch { return []; } });

  // Adversary Reviewer
  ipcMain.handle('adversary:review', async (_ev: any, args: { sessionId: string; actionType: string; actionDetail: string }) => { try { return adversaryService.review(args.sessionId, args.actionType, args.actionDetail); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('adversary:flags', async (_ev: any, sessionId: string) => { try { return adversaryService.getFlags(sessionId); } catch { return []; } });
  ipcMain.handle('adversary:stats', async (_ev: any, sessionId: string) => { try { return adversaryService.getStats(sessionId); } catch { return { total: 0, flagged: 0, critical: 0 }; } });

  // Context Compaction
  ipcMain.handle('compaction:record', async (_ev: any, args: any) => { try { compactionService.record(args.sessionId, args.tokensBefore, args.tokensAfter, args.messagesRemoved); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('compaction:stats', async (_ev: any, sessionId: string) => { try { return compactionService.getStats(sessionId); } catch { return { totalCompactions: 0, totalTokensSaved: 0 }; } });

  // Turn Management
  ipcMain.handle('turns:get', async (_ev: any, sessionId: string) => { try { return turnService.getLimit(sessionId); } catch { return { maxTurns: 100, currentTurn: 0 }; } });
  ipcMain.handle('turns:set-limit', async (_ev: any, args: { sessionId: string; maxTurns: number }) => { try { turnService.setLimit(args.sessionId, args.maxTurns); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('turns:increment', async (_ev: any, sessionId: string) => { try { return turnService.incrementTurn(sessionId); } catch { return { currentTurn: 0, maxTurns: 100, exceeded: false }; } });
  ipcMain.handle('turns:reset', async (_ev: any, sessionId: string) => { try { turnService.reset(sessionId); return { success: true }; } catch { return { success: false }; } });

  // Response Schemas
  ipcMain.handle('schemas:create', async (_ev: any, args: { name: string; schema: any; description?: string }) => { try { return { id: schemaService.create(args.name, args.schema, args.description) }; } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('schemas:list', async () => { try { return schemaService.list(); } catch { return []; } });
  ipcMain.handle('schemas:get', async (_ev: any, id: string) => { try { return schemaService.get(id); } catch { return null; } });
  ipcMain.handle('schemas:update', async (_ev: any, args: { id: string; name: string; schema: any; description?: string }) => { try { return { success: schemaService.update(args.id, args.name, args.schema, args.description) }; } catch (e: any) { return { success: false, error: e.message }; } });
  ipcMain.handle('schemas:delete', async (_ev: any, id: string) => { try { return { success: schemaService.delete(id) }; } catch { return { success: false }; } });
  ipcMain.handle('schemas:activate', async (_ev: any, args: { sessionId: string; schemaId: string | null }) => { try { schemaService.activate(args.sessionId, args.schemaId); return { success: true }; } catch { return { success: false }; } });
  ipcMain.handle('schemas:get-active', async (_ev: any, sessionId: string) => { try { return schemaService.getActive(sessionId); } catch { return null; } });
  ipcMain.handle('schemas:validate', async (_ev: any, args: { data: any; schema: any }) => { try { return schemaService.validate(args.data, args.schema); } catch { return { valid: false, errors: ['Validation error'] }; } });

  console.log('[IPC] Goose features registered');

  // ── Sentrux-Inspired: Architectural Quality IPC ─────────────────
  const { ArchQualityService } = require('../architecture/arch-quality-service');
  const archService = new ArchQualityService(db);

  ipcMain.handle('arch:scan', async (_ev: any, args: { projectId: string }) => {
    try {
      const os = require('node:os'); const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      return archService.scan(args.projectId, projectPath);
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('arch:latest', async (_ev: any, projectId: string) => { try { return archService.getLatest(projectId); } catch { return null; } });

  ipcMain.handle('arch:gate-start', async (_ev: any, args: { projectId: string; sessionId?: string }) => { try { return archService.gateStart(args.projectId, args.sessionId); } catch (e: any) { return { error: e.message }; } });

  ipcMain.handle('arch:gate-end', async (_ev: any, args: { gateId: string; projectId: string }) => {
    try {
      const os = require('node:os'); const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      return archService.gateEnd(args.gateId, args.projectId, projectPath);
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('arch:gate-history', async (_ev: any, projectId: string) => { try { return archService.getGateHistory(projectId); } catch { return []; } });

  ipcMain.handle('arch:add-rule', async (_ev: any, args: { projectId: string; ruleType: string; config: any }) => { try { return archService.addRule(args.projectId, args.ruleType, args.config); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('arch:get-rules', async (_ev: any, projectId: string) => { try { return archService.getRules(projectId); } catch { return []; } });
  ipcMain.handle('arch:toggle-rule', async (_ev: any, args: { ruleId: string; enabled: boolean }) => { try { return { success: archService.toggleRule(args.ruleId, args.enabled) }; } catch { return { success: false }; } });
  ipcMain.handle('arch:delete-rule', async (_ev: any, ruleId: string) => { try { return { success: archService.deleteRule(ruleId) }; } catch { return { success: false }; } });
  ipcMain.handle('arch:check-rules', async (_ev: any, projectId: string) => { try { return archService.checkRules(projectId); } catch { return { passed: true, results: [] }; } });

  ipcMain.handle('arch:evolution', async (_ev: any, args: { projectId: string; limit?: number }) => { try { return archService.getEvolution(args.projectId, args.limit); } catch { return []; } });

  ipcMain.handle('arch:dsm', async (_ev: any, args: { projectId: string }) => {
    try {
      const os = require('node:os'); const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      return archService.getDSM(args.projectId, projectPath);
    } catch { return []; }
  });

  ipcMain.handle('arch:test-gaps', async (_ev: any, args: { projectId: string }) => {
    try {
      const os = require('node:os'); const pathMod = require('node:path');
      const projectPath = pathMod.join(os.homedir(), '.neuronest', 'projects', args.projectId);
      return archService.scanTestGaps(args.projectId, projectPath);
    } catch { return []; }
  });

  ipcMain.handle('arch:get-test-gaps', async (_ev: any, projectId: string) => { try { return archService.getTestGaps(projectId); } catch { return []; } });

  console.log('[IPC] Architectural Quality registered');

  // ── SRE-Inspired Features IPC ───────────────────────────────────
  const SRE = require('../sre/sre-features-service');
  const evidenceService = new SRE.EvidenceCitationService(db);
  const runbookService = new SRE.RunbookService(db);
  const predictiveService = new SRE.PredictiveAlertService(db);
  const reportService = new SRE.InvestigationReportService(db);
  const validationService = new SRE.IntegrationValidationService(db);

  // Evidence Citations
  ipcMain.handle('evidence:cite', async (_ev: any, args: any) => { try { return evidenceService.cite(args.sessionId, args.claim, args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('evidence:list', async (_ev: any, sessionId: string) => { try { return evidenceService.listForSession(sessionId); } catch { return []; } });

  // Runbooks
  ipcMain.handle('runbooks:list', async (_ev: any, projectId?: string) => { try { return runbookService.list(projectId); } catch { return []; } });
  ipcMain.handle('runbooks:create', async (_ev: any, args: any) => { try { return runbookService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('runbooks:toggle', async (_ev: any, args: { id: string; enabled: boolean }) => { try { return { success: runbookService.toggle(args.id, args.enabled) }; } catch { return { success: false }; } });
  ipcMain.handle('runbooks:delete', async (_ev: any, id: string) => { try { return { success: runbookService.delete(id) }; } catch { return { success: false }; } });
  ipcMain.handle('runbooks:find-matching', async (_ev: any, text: string) => { try { return runbookService.findMatching(text); } catch { return null; } });

  // Predictive Alerts
  ipcMain.handle('predictive:active', async (_ev: any, projectId: string) => { try { return predictiveService.getActive(projectId); } catch { return []; } });
  ipcMain.handle('predictive:acknowledge', async (_ev: any, id: string) => { try { return { success: predictiveService.acknowledge(id) }; } catch { return { success: false }; } });
  ipcMain.handle('predictive:analyze', async (_ev: any, projectId: string) => { try { return { generated: predictiveService.analyzeTrends(projectId) }; } catch { return { generated: [] }; } });

  // Investigation Reports
  ipcMain.handle('reports:create', async (_ev: any, args: any) => { try { return reportService.create(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('reports:list', async (_ev: any, projectId: string) => { try { return reportService.listForProject(projectId); } catch { return []; } });
  ipcMain.handle('reports:update-status', async (_ev: any, args: { id: string; status: string }) => { try { return { success: reportService.updateStatus(args.id, args.status) }; } catch { return { success: false }; } });

  // Integration Validation
  ipcMain.handle('validation:test-provider', async (_ev: any, args: { name: string }) => {
    try {
      const provJson = getCachedConfig('providers');
      if (!provJson) { validationService.record(args.name, 'failed', 'No providers configured'); return { status: 'failed', error: 'No providers configured' }; }
      const providers = JSON.parse(provJson);
      const provider = providers.find(function(p: any) { return p.name === args.name || p.type === args.name; });
      if (!provider) { validationService.record(args.name, 'failed', 'Provider not found'); return { status: 'failed', error: 'Provider not found' }; }
      // Try to create a client and make a simple call
      const client = createLLMClientWithProMode(provider);
      if (!client) { validationService.record(args.name, 'failed', 'Could not create client'); return { status: 'failed', error: 'Could not create client' }; }
      const result = await client.testConnection();
      const status = result && result.success ? 'passed' : 'failed';
      validationService.record(args.name, status, result && !result.success ? result.message : undefined);
      return { status, message: result ? result.message : undefined };
    } catch (e: any) { validationService.record(args.name, 'failed', e.message); return { status: 'failed', error: e.message }; }
  });
  ipcMain.handle('validation:get-all', async () => { try { return validationService.getAll(); } catch { return []; } });
  ipcMain.handle('validation:test-all', async () => {
    try {
      const provJson = getCachedConfig('providers');
      if (!provJson) return { results: [] };
      const providers = JSON.parse(provJson);
      const results: any[] = [];
      for (const p of providers) {
        try {
          const client = createLLMClientWithProMode(p);
          if (client) {
            const r = await client.testConnection();
            const status = r && r.success ? 'passed' : 'failed';
            validationService.record(p.name || p.type, status, r && !r.success ? r.message : undefined);
            results.push({ name: p.name || p.type, status, message: r ? r.message : undefined });
          } else {
            validationService.record(p.name || p.type, 'failed', 'Could not create client');
            results.push({ name: p.name || p.type, status: 'failed', error: 'Could not create client' });
          }
        } catch (e: any) {
          validationService.record(p.name || p.type, 'failed', e.message);
          results.push({ name: p.name || p.type, status: 'failed', error: e.message });
        }
      }
      return { results };
    } catch { return { results: [] }; }
  });

  console.log('[IPC] SRE Features registered (Evidence, Runbooks, Predictive Alerts, Reports, Integration Validation)');

  // ═══════════════════════════════════════════════════════════════
  // ── AI Review Model ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { AIReviewService } = require('../review/ai-review-service');
  const aiReviewService = new AIReviewService(db);

  ipcMain.handle('review:get-config', async (_e, projectId: string) => {
    try { return aiReviewService.getConfig(projectId); } catch { return null; }
  });

  ipcMain.handle('review:update-config', async (_e, args: any) => {
    try { return aiReviewService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('review:run', async (_e, args: any) => {
    try {
      const { projectId, diff } = args;
      if (!diff || !diff.trim()) return { error: 'No changes to review' };
      const config = aiReviewService.getConfig(projectId);
      const startTime = Date.now();

      // Record the run as started
      const run = aiReviewService.recordRun(projectId, {
        review_type: 'manual',
        scope: config.review_scope,
        effort_level: config.effort_level,
        status: 'running',
      });

      // Build the review prompt
      const prompt = aiReviewService.buildReviewPrompt(config, diff);

      // Determine which model to use
      let reviewClient = resolveActiveLLMClient();
      let modelUsed = 'default';

      if (config.review_model_provider && config.review_model_name) {
        // Use dedicated review model
        try {
          const provJson = getCachedConfig('providers');
          if (provJson) {
            const providers = JSON.parse(provJson);
            const reviewProvider = providers.find((p: any) =>
              p.name === config.review_model_provider || p.type === config.review_model_provider
            );
            if (reviewProvider) {
              const { createLLMClientWithProMode: createClient } = require('../pipeline/pro-mode-state');
              reviewClient = createClient({ ...reviewProvider, model: config.review_model_name });
              modelUsed = `${config.review_model_provider}/${config.review_model_name}`;
            }
          }
        } catch { /* fall back to default */ }
      }

      if (!reviewClient) {
        aiReviewService.updateRun(run.id, { status: 'failed', summary: 'No LLM client available' });
        return { error: 'No LLM client available. Configure a provider first.' };
      }

      // Send to LLM
      let reviewText = '';
      try {
        const response = await (reviewClient as any).chat([
          { role: 'system', content: 'You are an expert code reviewer.' },
          { role: 'user', content: prompt },
        ]);
        reviewText = typeof response === 'string' ? response : (response?.content || response?.text || JSON.stringify(response));
      } catch (llmErr: any) {
        // Try streaming fallback
        try {
          const chunks: string[] = [];
          await (reviewClient as any).stream(
            [{ role: 'system', content: 'You are an expert code reviewer.' }, { role: 'user', content: prompt }],
            (chunk: string) => { chunks.push(chunk); }
          );
          reviewText = chunks.join('');
        } catch (streamErr: any) {
          aiReviewService.updateRun(run.id, { status: 'failed', summary: streamErr.message });
          return { error: 'Review failed: ' + streamErr.message };
        }
      }

      // Count issues (rough heuristic)
      const issueCount = (reviewText.match(/🔴|🟠|🟡|ℹ️|\*\*\[(critical|error|warning|info)\]\*\*/gi) || []).length;
      const filesCount = (diff.match(/^diff --git|^---\s+a\//gm) || []).length || 1;
      const durationMs = Date.now() - startTime;

      aiReviewService.updateRun(run.id, {
        status: 'completed',
        summary: reviewText.slice(0, 500),
        findings: JSON.stringify([{ raw: reviewText }]),
        files_reviewed: filesCount,
        issues_found: issueCount,
        duration_ms: durationMs,
        model_used: modelUsed,
      } as any);

      return {
        id: run.id,
        review: reviewText,
        filesReviewed: filesCount,
        issuesFound: issueCount,
        durationMs,
        modelUsed,
      };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('review:recent', async (_e, args: any) => {
    try { return aiReviewService.getRecentRuns(args.projectId, args.limit || 10); } catch { return []; }
  });

  ipcMain.handle('review:stats', async (_e, projectId: string) => {
    try { return aiReviewService.getStats(projectId); } catch { return { totalReviews: 0, totalIssues: 0, avgDuration: 0, lastReview: null }; }
  });

  console.log('[IPC] AI Review Model registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Steer/Queue Message Mode ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { MessageQueueService } = require('../messaging/message-queue-service');
  const messageQueueService = new MessageQueueService(db);

  ipcMain.handle('msgmode:get-config', async (_e, projectId: string) => {
    try { return messageQueueService.getModeConfig(projectId); } catch { return { default_mode: 'send', auto_process_queue: true }; }
  });

  ipcMain.handle('msgmode:set-config', async (_e, args: any) => {
    try { return messageQueueService.setModeConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('msgmode:enqueue', async (_e, args: any) => {
    try { return messageQueueService.enqueue(args.projectId, args.message, args.mode, args.priority); } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('msgmode:pending', async (_e, projectId: string) => {
    try { return messageQueueService.getPending(projectId); } catch { return []; }
  });

  ipcMain.handle('msgmode:dequeue', async (_e, projectId: string) => {
    try { return messageQueueService.dequeue(projectId); } catch { return null; }
  });

  ipcMain.handle('msgmode:complete', async (_e, messageId: string) => {
    try { messageQueueService.complete(messageId); return { ok: true }; } catch { return { ok: false }; }
  });

  ipcMain.handle('msgmode:cancel', async (_e, messageId: string) => {
    try { messageQueueService.cancel(messageId); return { ok: true }; } catch { return { ok: false }; }
  });

  ipcMain.handle('msgmode:cancel-all', async (_e, projectId: string) => {
    try { return { cancelled: messageQueueService.cancelAll(projectId) }; } catch { return { cancelled: 0 }; }
  });

  ipcMain.handle('msgmode:stats', async (_e, projectId: string) => {
    try { return messageQueueService.getStats(projectId); } catch { return { pending: 0, processing: 0, completed: 0, cancelled: 0 }; }
  });

  console.log('[IPC] Steer/Queue Message Mode registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Missions (Multi-Feature Orchestration) ────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { MissionService } = require('../missions/mission-service');
  const missionService = new MissionService(db);

  ipcMain.handle('missions:create', async (_e, args: any) => {
    try { return missionService.create(args.projectId, args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('missions:get', async (_e, id: string) => {
    try { return missionService.get(id); } catch { return null; }
  });
  ipcMain.handle('missions:list', async (_e, projectId: string) => {
    try { return missionService.list(projectId); } catch { return []; }
  });
  ipcMain.handle('missions:update-status', async (_e, args: any) => {
    try { missionService.updateStatus(args.missionId, args.status); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('missions:update-progress', async (_e, args: any) => {
    try { missionService.updateProgress(args.missionId, args.completedFeatures, args.currentMilestone); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('missions:add-worker', async (_e, args: any) => {
    try { return missionService.addWorker(args.missionId, args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('missions:get-workers', async (_e, missionId: string) => {
    try { return missionService.getWorkers(missionId); } catch { return []; }
  });
  ipcMain.handle('missions:delete', async (_e, id: string) => {
    try { missionService.delete(id); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('missions:stats', async (_e, projectId: string) => {
    try { return missionService.getStats(projectId); } catch { return { total: 0, completed: 0, running: 0, totalFeatures: 0 }; }
  });
  console.log('[IPC] Missions registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Specification Mode ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { SpecService } = require('../specs/spec-service');
  const specService = new SpecService(db);

  ipcMain.handle('specs:get-config', async (_e, projectId: string) => {
    try { return specService.getConfig(projectId); } catch { return null; }
  });
  ipcMain.handle('specs:update-config', async (_e, args: any) => {
    try { return specService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('specs:create', async (_e, args: any) => {
    try { return specService.create(args.projectId, args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('specs:update', async (_e, args: any) => {
    try { specService.update(args.specId, args.updates); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('specs:get', async (_e, id: string) => {
    try { return specService.get(id); } catch { return null; }
  });
  ipcMain.handle('specs:list', async (_e, projectId: string) => {
    try { return specService.list(projectId); } catch { return []; }
  });
  ipcMain.handle('specs:stats', async (_e, projectId: string) => {
    try { return specService.getStats(projectId); } catch { return { total: 0, completed: 0, avgFiles: 0 }; }
  });
  ipcMain.handle('specs:build-prompt', async (_e, description: string) => {
    try { return { prompt: specService.buildSpecPrompt(description) }; } catch { return { prompt: '' }; }
  });
  console.log('[IPC] Specification Mode registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Wiki Generation ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { WikiService } = require('../wiki/wiki-service');
  const wikiService = new WikiService(db);

  ipcMain.handle('wiki:get-config', async (_e, projectId: string) => {
    try { return wikiService.getConfig(projectId); } catch { return null; }
  });
  ipcMain.handle('wiki:update-config', async (_e, args: any) => {
    try { return wikiService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('wiki:generate', async (_e, args: any) => {
    try {
      const gen = wikiService.startGeneration(args.projectId, args.model);
      return gen;
    } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('wiki:complete-generation', async (_e, args: any) => {
    try { wikiService.completeGeneration(args.genId, args.pagesGenerated, args.durationMs); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('wiki:add-page', async (_e, args: any) => {
    try { return wikiService.addPage(args.projectId, args.wikiId, args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('wiki:get-pages', async (_e, args: any) => {
    try { return wikiService.getPages(args.projectId, args.wikiId); } catch { return []; }
  });
  ipcMain.handle('wiki:get-generations', async (_e, projectId: string) => {
    try { return wikiService.getGenerations(projectId); } catch { return []; }
  });
  ipcMain.handle('wiki:stats', async (_e, projectId: string) => {
    try { return wikiService.getStats(projectId); } catch { return { totalGenerations: 0, totalPages: 0, lastGenerated: null }; }
  });
  ipcMain.handle('wiki:delete', async (_e, wikiId: string) => {
    try { wikiService.deleteWiki(wikiId); return { ok: true }; } catch { return { ok: false }; }
  });
  console.log('[IPC] Wiki Generation registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Headless Exec (CI/CD Mode) ────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { ExecService } = require('../exec/exec-service');
  const execService = new ExecService(db);

  ipcMain.handle('exec:get-config', async (_e, projectId: string) => {
    try { return execService.getConfig(projectId); } catch { return null; }
  });
  ipcMain.handle('exec:update-config', async (_e, args: any) => {
    try { return execService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('exec:start', async (_e, args: any) => {
    try { return execService.startRun(args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('exec:complete', async (_e, args: any) => {
    try { execService.completeRun(args.runId, args.result, args.exitCode, args.durationMs, args.filesModified); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('exec:recent', async (_e, args: any) => {
    try { return execService.getRecentRuns(args.projectId, args.limit); } catch { return []; }
  });
  ipcMain.handle('exec:stats', async (_e, projectId: string) => {
    try { return execService.getStats(projectId); } catch { return { total: 0, completed: 0, failed: 0, avgDuration: 0 }; }
  });
  console.log('[IPC] Headless Exec registered');

  // ═══════════════════════════════════════════════════════════════
  // ── QA/Demo/Verify ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { QAService } = require('../qa/qa-service');
  const qaService = new QAService(db);

  ipcMain.handle('qa:get-config', async (_e, projectId: string) => {
    try { return qaService.getConfig(projectId); } catch { return null; }
  });
  ipcMain.handle('qa:update-config', async (_e, args: any) => {
    try { return qaService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('qa:start', async (_e, args: any) => {
    try { return qaService.startRun(args.projectId, args); } catch (e: any) { return { error: e.message }; }
  });
  ipcMain.handle('qa:update', async (_e, args: any) => {
    try { qaService.updateRun(args.runId, args.updates); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('qa:get', async (_e, id: string) => {
    try { return qaService.getRun(id); } catch { return null; }
  });
  ipcMain.handle('qa:recent', async (_e, args: any) => {
    try { return qaService.getRecentRuns(args.projectId, args.limit); } catch { return []; }
  });
  ipcMain.handle('qa:stats', async (_e, projectId: string) => {
    try { return qaService.getStats(projectId); } catch { return { total: 0, passed: 0, failed: 0, avgDuration: 0 }; }
  });
  console.log('[IPC] QA/Demo/Verify registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Best-of-N Parallel Evaluation ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { BestOfNService } = require('../evaluation/best-of-n-service');
  const bestOfNService = new BestOfNService(db);

  ipcMain.handle('bon:get-config', async (_e, projectId: string) => { try { return bestOfNService.getConfig(projectId); } catch { return null; } });
  ipcMain.handle('bon:update-config', async (_e, args: any) => { try { return bestOfNService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('bon:start', async (_e, args: any) => { try { return bestOfNService.startRun(args.projectId, args.prompt, args.n || 3, args.model); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('bon:update', async (_e, args: any) => { try { bestOfNService.updateRun(args.runId, args.updates); return { ok: true }; } catch { return { ok: false }; } });
  ipcMain.handle('bon:recent', async (_e, args: any) => { try { return bestOfNService.getRecent(args.projectId, args.limit); } catch { return []; } });
  ipcMain.handle('bon:stats', async (_e, projectId: string) => { try { return bestOfNService.getStats(projectId); } catch { return { total: 0, completed: 0, avgN: 3 }; } });
  ipcMain.handle('bon:build-synthesis', async (_e, args: any) => { try { return { prompt: bestOfNService.buildSynthesisPrompt(args.prompt, args.candidates) }; } catch { return { prompt: '' }; } });
  console.log('[IPC] Best-of-N registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Workspace Forking ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { ForkService } = require('../workspace/fork-service');
  const forkService = new ForkService(db);

  ipcMain.handle('fork:create', async (_e, args: any) => { try { return forkService.fork(args.projectId, args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('fork:list', async (_e, projectId: string) => { try { return forkService.list(projectId); } catch { return []; } });
  ipcMain.handle('fork:get', async (_e, id: string) => { try { return forkService.get(id); } catch { return null; } });
  ipcMain.handle('fork:delete', async (_e, id: string) => { try { forkService.delete(id); return { ok: true }; } catch { return { ok: false }; } });
  ipcMain.handle('fork:stats', async (_e, projectId: string) => { try { return forkService.getStats(projectId); } catch { return { total: 0, totalMessages: 0 }; } });
  console.log('[IPC] Workspace Forking registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Runtime Backends ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { RuntimeBackendService } = require('../runtime/runtime-backend-service');
  const runtimeBackendService = new RuntimeBackendService(db);

  ipcMain.handle('backends:get-config', async (_e, projectId: string) => { try { return runtimeBackendService.getConfig(projectId); } catch { return null; } });
  ipcMain.handle('backends:update-config', async (_e, args: any) => { try { return runtimeBackendService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('backends:add', async (_e, args: any) => { try { return runtimeBackendService.addBackend(args.projectId, args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('backends:list', async (_e, projectId: string) => { try { return runtimeBackendService.listBackends(projectId); } catch { return []; } });
  ipcMain.handle('backends:update-status', async (_e, args: any) => { try { runtimeBackendService.updateBackendStatus(args.backendId, args.status); return { ok: true }; } catch { return { ok: false }; } });
  ipcMain.handle('backends:delete', async (_e, id: string) => { try { runtimeBackendService.deleteBackend(id); return { ok: true }; } catch { return { ok: false }; } });
  console.log('[IPC] Runtime Backends registered');

  // ═══════════════════════════════════════════════════════════════
  // ── AI Gateway ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { AIGatewayService } = require('../gateway/ai-gateway-service');
  const aiGatewayService = new AIGatewayService(db);

  ipcMain.handle('gateway:get-config', async () => { try { return aiGatewayService.getConfig(); } catch { return null; } });
  ipcMain.handle('gateway:update-config', async (_e, args: any) => { try { return aiGatewayService.updateConfig(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('gateway:log', async (_e, args: any) => { try { return aiGatewayService.logRequest(args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('gateway:audit-log', async (_e, args: any) => { try { return aiGatewayService.getAuditLog(args.limit, args.projectId); } catch { return []; } });
  ipcMain.handle('gateway:stats', async (_e, projectId: string) => { try { return aiGatewayService.getStats(projectId || undefined); } catch { return { totalRequests: 0, totalTokens: 0, totalCost: 0, blockedCount: 0, avgLatency: 0 }; } });
  console.log('[IPC] AI Gateway registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Indexing Pipeline ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  /**
   * Load IndexingConfig from project settings stored in the config table.
   * Returns a default config if no settings are found.
   */
  function loadIndexingConfig(): IndexingConfig {
    const defaults: IndexingConfig = {
      enabled: false,
      incrementalIndexing: true,
      vectorSearch: true,
      callGraph: true,
      connectors: { git: true, documentation: true },
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 384,
      embeddingProvider: 'ollama',
      embeddingEndpoint: 'http://localhost:11434',
      maxCacheSize: 500 * 1024 * 1024,
      cacheTTLDays: 7,
      callGraphDepth: 5,
      gitCommitLimit: 1000,
    };

    try {
      const row = db.prepare("SELECT value FROM config WHERE key = 'indexing-config'").get() as { value: string } | undefined;
      if (row) {
        const stored = JSON.parse(row.value);
        return { ...defaults, ...stored };
      }
    } catch (e) {
      console.warn('[IPC] Failed to load indexing config, using defaults:', e);
    }

    return defaults;
  }

  /**
   * Instantiate and start the indexing pipeline with the given config.
   * Wires FileEventEmitter events to the pipeline controller.
   */
  function startIndexingPipeline(config: IndexingConfig): void {
    try {
      // Stop existing pipeline if running
      if (indexingPipelineController) {
        indexingPipelineController.stop();
        indexingPipelineController = null;
      }

      if (!config.enabled) {
        console.log('[IPC] Indexing pipeline disabled by config');
        return;
      }

      // Instantiate subsystems
      const astChunker = new ASTChunker();
      const embeddingStore = new EmbeddingStore(db, config.embeddingDimensions);
      const callGraphEngine = new CallGraphEngine(db, config.callGraphDepth);
      const transformationCache = new TransformationCache(db, config.maxCacheSize, config.cacheTTLDays);
      const lineageTracker = new LineageTracker(db);
      const embeddingDaemon = new EmbeddingDaemonClient({
        model: config.embeddingModel,
        provider: config.embeddingProvider,
        endpoint: config.embeddingEndpoint,
        maxMemoryMB: 512,
      });

      // Create the pipeline controller
      indexingPipelineController = new IndexingPipelineController(
        db,
        config,
        graphManager,
        astChunker,
        embeddingStore,
        callGraphEngine,
        transformationCache,
        embeddingDaemon,
        lineageTracker
      );

      // Register connectors based on config
      if (config.connectors.git) {
        indexingPipelineController.registerConnector(new GitConnector());
      }
      if (config.connectors.documentation) {
        indexingPipelineController.registerConnector(new DocumentationConnector());
      }

      // Wire FileEventEmitter events to the pipeline controller
      const fee = FileEventEmitter.getInstance();
      indexingPipelineController.start(fee);

      // Start the embedding daemon (non-blocking)
      embeddingDaemon.start().catch((err) => {
        console.warn('[IPC] Embedding daemon failed to start (will queue requests):', err?.message);
      });

      console.log('[IPC] Indexing pipeline started');
    } catch (e: any) {
      console.error('[IPC] Failed to start indexing pipeline:', e?.message);
      indexingPipelineController = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RAG_Tool_Selection (F4) — ToolIndex cold-start boot (task 16.1)
  // ═══════════════════════════════════════════════════════════════

  /** Config key for the one-shot ToolIndex cold-start retry flag (Req 30.4). */
  const TOOL_INDEX_RETRY_FLAG_KEY = 'tool-index.cold-start-retry';

  /**
   * Config-backed {@link RetryFlagStore}. The flag is a single boolean persisted
   * in the `config` table (the data dir) via the existing cached-config helpers.
   * `consume` reads-and-clears so the flag never accumulates across launches;
   * `schedule` arms a single retry for the next boot. Both are fail-soft.
   */
  function makeToolIndexRetryFlagStore(): RetryFlagStore {
    return {
      consume(): boolean {
        try {
          const pending = getCachedConfig(TOOL_INDEX_RETRY_FLAG_KEY) === 'true';
          if (pending) setCachedConfig(TOOL_INDEX_RETRY_FLAG_KEY, 'false');
          return pending;
        } catch {
          return false;
        }
      },
      schedule(): void {
        try {
          setCachedConfig(TOOL_INDEX_RETRY_FLAG_KEY, 'true');
        } catch {
          // Persistence is best-effort.
        }
      },
    };
  }

  /**
   * Initialize the {@link ToolIndex} exactly once at boot (Req 30.1). Aggregates
   * the three tool sources (ToolSystem, MCPServerManager.toolRegistry,
   * ChatToolDispatchTable), embeds every description via the
   * EmbeddingDaemonProvider, and races init() against the 30-second soft budget
   * (Req 30.4). Telemetry (`tool_rag.index_ms` / `tool_rag.index_size`) and the
   * one-shot retry flag are handled by `bootstrapToolIndexOnce`.
   *
   * Fire-and-forget: kicks off indexing in the background so boot is never
   * blocked. While `isReady()` is false the chat pipeline substitutes
   * Full_Registry (Req 30.2/30.3).
   */
  function bootstrapToolIndexAtBoot(): void {
    let toolIndex: any;
    try {
      // Lazy require to keep the module graph lean and avoid a hard import
      // dependency if RAG selection is disabled in a given build.
      const { ToolIndex } = require('../pipeline/tool-index');
      const { EmbeddingDaemonProvider } = require('../pipeline/embedding-daemon-provider');
      const { MCPServerManager } = require('../mcp/mcp-server-manager');
      const { ToolSystem } = require('../tools/tool-system');
      const { PermissionSystem } = require('../security/permission-system');

      // Embedding backend — reuse the indexing config's embedding settings so
      // tool descriptions embed against the same daemon the rest of the app uses.
      const cfg = loadIndexingConfig();
      const embeddingDaemon = new EmbeddingDaemonClient({
        model: cfg.embeddingModel,
        provider: cfg.embeddingProvider,
        endpoint: cfg.embeddingEndpoint,
        maxMemoryMB: 512,
      });
      // Non-blocking start; embed() calls queue until the daemon is ready.
      embeddingDaemon.start().catch((err: any) => {
        console.warn('[IPC] ToolIndex embedding daemon failed to start (queuing):', err?.message);
      });

      // Tool sources. A boot-time MCP manager exposes its (initially empty)
      // tool registry; a fresh ToolSystem provides the built-in tool catalog.
      // Each source is defensively guarded inside ToolIndex.aggregate(), so an
      // empty or unavailable source degrades gracefully rather than crashing.
      const stubFirewall = {
        evaluate: (input: string) => ({ passed: true, blocked: false, sanitized: input }),
      };
      const mcpManager = new MCPServerManager(db ?? null, stubFirewall);
      const toolSystem = new ToolSystem(new PermissionSystem());

      toolIndex = new ToolIndex({
        embeddingProvider: new EmbeddingDaemonProvider(embeddingDaemon),
        sources: {
          toolSystem,
          mcpManager,
          // Chat dispatch table is not yet assembled at boot; omit it. The
          // catalog still covers ToolSystem + MCP, and the union always includes
          // ALWAYS_AVAILABLE built-ins at retrieval time.
        },
      });
    } catch (wireErr: any) {
      console.warn('[IPC] ToolIndex construction failed; RAG tool selection disabled this run:',
        wireErr?.message ?? wireErr);
      return;
    }

    // Metrics_Sink — the canonical SessionTelemetryService over the shared db.
    let metricsSink: { recordMetric(s: string | null, k: string, v: number): void } | undefined;
    try {
      const { SessionTelemetryService } = require('../session/session-telemetry');
      metricsSink = new SessionTelemetryService(db);
    } catch (sinkErr: any) {
      console.warn('[IPC] ToolIndex telemetry sink unavailable (boot metrics will be skipped):',
        sinkErr?.message ?? sinkErr);
      metricsSink = undefined;
    }

    // Run Cold_Start_Indexing exactly once, bounded by the 30s budget.
    bootstrapToolIndexOnce(toolIndex, {
      metricsSink,
      retryFlagStore: makeToolIndexRetryFlagStore(),
      budgetMs: COLD_START_BUDGET_MS,
    })
      .then((result) => {
        if (result.ready) {
          console.log(
            `[IPC] ToolIndex cold-start ready: ${result.indexSize} tools in ${result.indexMs}ms` +
              (result.wasRetry ? ' (retry succeeded)' : ''),
          );
        } else {
          console.warn(
            `[IPC] ToolIndex cold-start ${result.reason}; staying on Full_Registry, retry armed for next launch`,
          );
        }
      })
      .catch((err) => {
        // bootstrapToolIndexOnce never rejects, but guard anyway.
        console.warn('[IPC] ToolIndex cold-start unexpected error:', err?.message ?? err);
      });
  }

  // Kick off the once-at-boot ToolIndex cold-start now that its helpers and the
  // retry-flag config key are initialized. Fire-and-forget so boot is never
  // blocked; the bootstrap is internally fail-soft (Req 30.1–30.5).
  try {
    bootstrapToolIndexAtBoot();
  } catch (toolIndexBootErr: any) {
    console.warn('[IPC] ToolIndex cold-start wiring failed (continuing without RAG tool selection):',
      toolIndexBootErr?.message ?? toolIndexBootErr);
  }

  // Register indexing IPC handlers
  ipcMain.handle('indexing:getStatus', async () => {
    try {
      if (!indexingPipelineController) {
        return { running: false, filesIndexed: 0, filesInQueue: 0, lastError: null, lastIndexedAt: null };
      }
      return indexingPipelineController.getStatus();
    } catch (e: any) {
      console.error('[IPC] indexing:getStatus error:', e);
      return { running: false, filesIndexed: 0, filesInQueue: 0, lastError: e?.message || 'Unknown error', lastIndexedAt: null };
    }
  });

  ipcMain.handle('indexing:fullReindex', async (_e, projectPath?: string) => {
    try {
      if (!indexingPipelineController) {
        // Auto-start pipeline if not running
        const config = loadIndexingConfig();
        config.enabled = true;
        startIndexingPipeline(config);
      }

      if (!indexingPipelineController) {
        return { success: false, error: 'Failed to initialize indexing pipeline' };
      }

      // Determine project path
      let targetPath = projectPath;
      if (!targetPath && activeSessionId) {
        try {
          const session = await sessionManager.open(activeSessionId);
          targetPath = (session as any).projectDir;
        } catch {}
      }

      if (!targetPath) {
        return { success: false, error: 'No project path available for reindexing' };
      }

      // Run full reindex asynchronously
      indexingPipelineController.fullReindex(targetPath).catch((err) => {
        console.error('[IPC] Full reindex error:', err);
      });

      return { success: true };
    } catch (e: any) {
      console.error('[IPC] indexing:fullReindex error:', e);
      return { success: false, error: e?.message || 'Unknown error' };
    }
  });

  ipcMain.handle('indexing:stop', async () => {
    try {
      if (indexingPipelineController) {
        indexingPipelineController.stop();
        indexingPipelineController = null;
        console.log('[IPC] Indexing pipeline stopped');
      }
      return { success: true };
    } catch (e: any) {
      console.error('[IPC] indexing:stop error:', e);
      return { success: false, error: e?.message || 'Unknown error' };
    }
  });

  ipcMain.handle('indexing:getConfig', async () => {
    try {
      return loadIndexingConfig();
    } catch (e: any) {
      console.error('[IPC] indexing:getConfig error:', e);
      return null;
    }
  });

  ipcMain.handle('indexing:updateConfig', async (_e, updates: Partial<IndexingConfig>) => {
    try {
      const current = loadIndexingConfig();
      const merged: IndexingConfig = { ...current, ...updates };
      // Merge nested connectors object
      if (updates.connectors) {
        merged.connectors = { ...current.connectors, ...updates.connectors };
      }
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('indexing-config', ?)").run(JSON.stringify(merged));
      // Restart pipeline with new config
      if (indexingPipelineController) {
        indexingPipelineController.stop();
        indexingPipelineController = null;
      }
      startIndexingPipeline(merged);
      return { success: true, config: merged };
    } catch (e: any) {
      console.error('[IPC] indexing:updateConfig error:', e);
      return { success: false, error: e?.message || 'Unknown error' };
    }
  });

  console.log('[IPC] Indexing pipeline handlers registered');

  // ═══════════════════════════════════════════════════════════════
  // ── E2E Encrypted Sharing ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  const { EncryptedSharingService } = require('../sharing/encrypted-sharing-service');
  const encryptedSharingService = new EncryptedSharingService(db);

  ipcMain.handle('e2e:get-config', async (_e, projectId: string) => { try { return encryptedSharingService.getConfig(projectId); } catch { return null; } });
  ipcMain.handle('e2e:update-config', async (_e, args: any) => { try { return encryptedSharingService.updateConfig(args.projectId, args.updates); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('e2e:share', async (_e, args: any) => { try { return encryptedSharingService.createShare(args.projectId, args); } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('e2e:get-share', async (_e, id: string) => { try { return encryptedSharingService.getShare(id); } catch { return null; } });
  ipcMain.handle('e2e:list', async (_e, projectId: string) => { try { return encryptedSharingService.listShares(projectId); } catch { return []; } });
  ipcMain.handle('e2e:delete', async (_e, id: string) => { try { encryptedSharingService.deleteShare(id); return { ok: true }; } catch { return { ok: false }; } });
  ipcMain.handle('e2e:decrypt', async (_e, args: any) => { try { return { content: encryptedSharingService.decrypt(args.encrypted, args.key, args.iv) }; } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle('e2e:stats', async (_e, projectId: string) => { try { return encryptedSharingService.getStats(projectId); } catch { return { total: 0, totalAccess: 0 }; } });
  console.log('[IPC] E2E Encrypted Sharing registered');

  // ═══════════════════════════════════════════════════════════════
  // ── Performance: BoundedMessageStore IPC Handlers ─────────────
  // ═══════════════════════════════════════════════════════════════

  ipcMain.handle('load-older-messages', async (_e, args: any) => {
    try {
      if (!PERF_FLAGS.BOUNDED_MESSAGES) {
        return { messages: [], hasMore: false, oldestTimestamp: 0 };
      }
      const { sessionId, beforeTimestamp, limit } = args;
      const pageSize = limit || 50;
      const rows = db.prepare(
        `SELECT id, session_id, role, content, agent, is_cmd, timestamp, created_at
         FROM chat_messages_overflow
         WHERE session_id = ? AND timestamp < ?
         ORDER BY timestamp DESC
         LIMIT ?`
      ).all(sessionId, beforeTimestamp, pageSize) as any[];

      // Reverse to chronological order
      const messages = rows.reverse().map((r: any) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        agent: r.agent || undefined,
        isCmd: r.is_cmd === 1,
        timestamp: r.timestamp,
        sessionId: r.session_id,
      }));

      const hasMore = rows.length === pageSize;
      const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : beforeTimestamp;

      return { messages, hasMore, oldestTimestamp };
    } catch (e: any) {
      console.error('[IPC] load-older-messages error:', e);
      return { messages: [], hasMore: false, oldestTimestamp: 0 };
    }
  });

  ipcMain.handle('persist-overflow-messages', async (_e, args: any) => {
    try {
      if (!PERF_FLAGS.BOUNDED_MESSAGES) return { success: true };
      const { messages } = args;
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO chat_messages_overflow (id, session_id, role, content, agent, is_cmd, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertMany = db.transaction((msgs: any[]) => {
        for (const msg of msgs) {
          stmt.run(msg.id, msg.sessionId, msg.role, msg.content, msg.agent || null, msg.isCmd ? 1 : 0, msg.timestamp);
        }
      });
      insertMany(messages);
      return { success: true };
    } catch (e: any) {
      console.error('[IPC] persist-overflow-messages error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-overflow-count', async (_e, args: any) => {
    try {
      if (!PERF_FLAGS.BOUNDED_MESSAGES) return { count: 0 };
      const { sessionId } = args;
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM chat_messages_overflow WHERE session_id = ?'
      ).get(sessionId) as any;
      return { count: row ? row.cnt : 0 };
    } catch (e: any) {
      console.error('[IPC] get-overflow-count error:', e);
      return { count: 0 };
    }
  });

  ipcMain.handle('clear-overflow-session', async (_e, args: any) => {
    try {
      if (!PERF_FLAGS.BOUNDED_MESSAGES) return { success: true };
      const { sessionId } = args;
      db.prepare('DELETE FROM chat_messages_overflow WHERE session_id = ?').run(sessionId);
      return { success: true };
    } catch (e: any) {
      console.error('[IPC] clear-overflow-session error:', e);
      return { success: false, error: e.message };
    }
  });

  console.log('[IPC] BoundedMessageStore handlers registered');
}

export { runtimeManager, activeLlmClient, providerRegistryRef };

export function notifyThemeChange(win: BrowserWindow, theme: 'light' | 'dark'): void {
  win.webContents.send('theme-changed', theme);
}
export function notifyToolOutput(win: BrowserWindow, output: string): void {
  win.webContents.send('tool-output', output);
}
export function notifyShortcut(win: BrowserWindow, action: string): void {
  win.webContents.send('shortcut', action);
}
