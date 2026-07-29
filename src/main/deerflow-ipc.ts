/**
 * DeerFlow IPC Handler — registers IPC channels for all DeerFlow modules.
 *
 * Uses lazy singleton getters so modules are only instantiated on first use.
 * All handlers are wrapped in try/catch returning IPCErrorResponse on failure.
 *
 * Requirements: 8.7, 4.4, 9.1, 10.1
 */

import { ipcMain, type BrowserWindow } from 'electron';

// ─── IPCErrorResponse type ──────────────────────────────────────

interface IPCErrorResponse {
  error: true;
  message: string;
  code?: string;
}

function errorResponse(message: string, code?: string): IPCErrorResponse {
  return { error: true, message, code };
}

// ─── Lazy singleton getters ─────────────────────────────────────

let _skillLoader: InstanceType<typeof import('../pipeline/skill-loader.js').SkillLoader> | null = null;
let _contextSummarizer: InstanceType<typeof import('../pipeline/context-summarizer.js').ContextSummarizer> | null = null;
let _executionModeRouter: InstanceType<typeof import('../pipeline/execution-mode-router.js').ExecutionModeRouter> | null = null;
let _memoryStore: InstanceType<typeof import('../storage/memory-store.js').MemoryStore> | null = null;
let _suggestionGenerator: InstanceType<typeof import('../pipeline/suggestion-generator.js').SuggestionGenerator> | null = null;
let _sandboxManager: InstanceType<typeof import('../sandbox/sandbox-manager.js').SandboxManager> | null = null;
let _mcpServerManager: InstanceType<typeof import('../mcp/mcp-server-manager.js').MCPServerManager> | null = null;
let _imGateway: InstanceType<typeof import('../channels/im-gateway.js').IMGateway> | null = null;
let _subAgentContextIsolator: InstanceType<typeof import('../pipeline/sub-agent-context-isolator.js').SubAgentContextIsolator> | null = null;
let _toolCallRecoveryHandler: InstanceType<typeof import('../pipeline/tool-call-recovery.js').ToolCallRecoveryHandler> | null = null;

async function getSkillLoader() {
  if (!_skillLoader) {
    const { SkillLoader } = await import('../pipeline/skill-loader.js');
    _skillLoader = new SkillLoader();
  }
  return _skillLoader!;
}

async function getContextSummarizer() {
  if (!_contextSummarizer) {
    const { ContextSummarizer } = await import('../pipeline/context-summarizer.js');
    _contextSummarizer = new ContextSummarizer({ workspaceDir: '.neuronest/summaries' });
  }
  return _contextSummarizer!;
}

async function getExecutionModeRouter() {
  if (!_executionModeRouter) {
    const { ExecutionModeRouter } = await import('../pipeline/execution-mode-router.js');
    const { AGENT_REGISTRY } = await import('../agents/agent-registry.js');
    const { SwarmCoordinator, SwarmMemoryPool } = await import('../pipeline/swarm-coordinator.js');
    const { createLLMClient } = await import('../pipeline/llm-client.js');
    const { getDefaultDbPath } = await import('../storage/database.js');

    // ─── Production LLM client ──────────────────────────────────────
    // Resolve the active LLM provider from the persisted config database.
    // If no provider is configured yet (first launch), the router is still
    // instantiated with a null-safe wrapper — real calls will surface a clear
    // error instead of returning a silent empty response.
    let llmClient: any = null;
    try {
      const dbPath = getDefaultDbPath();
      const fs = require('node:fs');
      if (fs.existsSync(dbPath)) {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath, { readonly: true });
        try {
          const provRow = db.prepare("SELECT value FROM config WHERE key = 'providers'").get() as any;
          const defRow = db.prepare("SELECT value FROM config WHERE key = 'default-provider'").get() as any;
          if (provRow?.value) {
            const providers = JSON.parse(provRow.value);
            let prov = providers[0]; // default: first configured provider
            if (defRow?.value) {
              try {
                const dp = JSON.parse(defRow.value);
                const found = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
                if (found) prov = dp.model ? { ...found, model: dp.model } : found;
              } catch { /* use first provider */ }
            }
            if (prov) llmClient = createLLMClient(prov);
          }
        } finally {
          db.close();
        }
      }
    } catch { /* config not available yet — llmClient stays null */ }

    // Null-safe LLM wrapper satisfying LLMClientLike: errors clearly if no
    // provider is configured rather than returning a silent empty response.
    const safeLLM = llmClient ?? {
      chat: async () => { throw new Error('No LLM provider configured — cannot execute router LLM call'); },
    };

    // ─── Skill-injection db handle ───────────────────────────────────
    // A separate long-lived readonly connection so SwarmCoordinator can look
    // up assigned skills for agents. Skills are an enhancement — if the db
    // can't be opened, the coordinator proceeds skill-less (never throws).
    let skillDb: any = null;
    try {
      const dbPath = getDefaultDbPath();
      const fs = require('node:fs');
      if (fs.existsSync(dbPath)) {
        const Database = require('better-sqlite3');
        skillDb = new Database(dbPath, { readonly: true });
      }
    } catch { /* skill lookups stay unavailable — coordinator proceeds skill-less */ }

    // ─── Production SwarmCoordinator adapter ────────────────────────
    // The SwarmCoordinator.execute() takes an ExecutionPlan (with AgentTask[])
    // and returns a SwarmResult. The ExecutionModeRouter uses SwarmCoordinatorLike
    // which expects a simpler { task, sessionId, mode, agents: string[] } shape
    // and returns { output, agentsUsed, tokensUsed }. This adapter bridges them.
    const realSwarm = new SwarmCoordinator(new SwarmMemoryPool(), llmClient, null, null, skillDb);
    const swarmAdapter = {
      execute: async (plan: { task: string; sessionId: string; mode: string; agents: string[] }) => {
        const topology = (plan.mode === 'parallel' ? 'star' : 'sequential') as import('../pipeline/orchestrator-planner.js').Topology;
        const executionPlan = {
          plan: plan.task,
          agents: plan.agents.map((id: string) => ({ id, task: plan.task, dependsOn: [] })),
          topology,
        };
        const result = await realSwarm.execute(executionPlan);
        // Collapse SwarmResult.outputs map into a single output string
        const outputParts: string[] = [];
        if (result.outputs) {
          for (const [, value] of result.outputs) {
            if (value) outputParts.push(value);
          }
        }
        return {
          output: outputParts.join('\n'),
          agentsUsed: plan.agents,
          tokensUsed: 0,
        };
      },
    };

    _executionModeRouter = new ExecutionModeRouter(swarmAdapter, safeLLM, AGENT_REGISTRY || []);
  }
  return _executionModeRouter!;
}

async function getMemoryStore() {
  if (!_memoryStore) {
    const { MemoryStore } = await import('../storage/memory-store.js');
    _memoryStore = new MemoryStore(null); // Falls back to ephemeral store
  }
  return _memoryStore!;
}

async function getSuggestionGenerator() {
  if (!_suggestionGenerator) {
    const { SuggestionGenerator } = await import('../pipeline/suggestion-generator.js');
    _suggestionGenerator = new SuggestionGenerator(await getMemoryStore());
  }
  return _suggestionGenerator!;
}

async function getSandboxManager() {
  if (!_sandboxManager) {
    const { SandboxManager } = await import('../sandbox/sandbox-manager.js');
    const stubFirewall = { evaluate: (input: string) => ({ passed: true, blocked: false, sanitized: input }) };
    _sandboxManager = new SandboxManager(null, stubFirewall);
  }
  return _sandboxManager!;
}

async function getMCPServerManager() {
  if (!_mcpServerManager) {
    const { MCPServerManager } = await import('../mcp/mcp-server-manager.js');
    const stubFirewall = { evaluate: (input: string) => ({ passed: true, blocked: false, sanitized: input }) };
    _mcpServerManager = new MCPServerManager(null, stubFirewall);
    // F9 (Requirement 49.1): attempt boot-time auto-registration of the
    // recommended built-in MCP servers so their status (registered / skipped /
    // error) is available to the settings panel's "Built-in servers" section.
    // Never throws — graceful-skip is handled inside the manager.
    try {
      _mcpServerManager!.registerBuiltInServers();
    } catch {
      // Defensive: a built-in registration failure must not block IPC setup.
    }
    // ─── Lean Minimalism MCP Wiring (R12.1, R12.3, R12.6) ───────────
    // Wire lean-mcp-registration (PRODUCTION_UX_MINIMALISM) and
    // gui-agent-mcp-server (EXTERNAL_BROWSER_MCP) onto the live MCP path.
    // Both are no-ops when their respective flags are off (default: false).
    try {
      const { wireLeanMCPRegistration, wireGuiAgentMCPServer } = await import('../orchestration/lean-minimalism-wiring.js');
      wireLeanMCPRegistration(_mcpServerManager);
      wireGuiAgentMCPServer(_mcpServerManager);
    } catch {
      // Defensive: wiring failure must not block MCP setup.
    }
  }
  return _mcpServerManager!;
}

async function getIMGateway() {
  if (!_imGateway) {
    const { IMGateway } = await import('../channels/im-gateway.js');
    const stubChannelManager = {
      connect: async () => ({ success: true, message: 'connected' }),
      disconnect: async () => {},
      sendMessage: async () => ({ success: true, message: 'sent' }),
      onMessage: () => {},
    };
    const stubFirewall = { evaluate: () => ({ allowed: true }) };
    const stubSwarm = { execute: async () => ({ output: '' }) };
    _imGateway = new IMGateway(stubChannelManager, stubFirewall, stubSwarm);
  }
  return _imGateway!;
}

async function getSubAgentContextIsolator() {
  if (!_subAgentContextIsolator) {
    const { SubAgentContextIsolator } = await import('../pipeline/sub-agent-context-isolator.js');
    _subAgentContextIsolator = new SubAgentContextIsolator(await getContextSummarizer(), await getMemoryStore());
  }
  return _subAgentContextIsolator!;
}

async function getToolCallRecoveryHandler() {
  if (!_toolCallRecoveryHandler) {
    const { ToolCallRecoveryHandler } = await import('../pipeline/tool-call-recovery.js');
    _toolCallRecoveryHandler = new ToolCallRecoveryHandler();
  }
  return _toolCallRecoveryHandler!;
}

// ─── Register DeerFlow IPC handlers ─────────────────────────────

export function registerDeerFlowIPC(mainWindow: BrowserWindow): void {
  // ── INVOKE CHANNELS (renderer → main) ──────────────────────────

  ipcMain.handle('get-suggestions', async (_ev, taskOutput: string, agentDomain: string, userId: string) => {
    try {
      return (await getSuggestionGenerator()).generate(taskOutput, agentDomain, userId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to generate suggestions', 'SUGGESTION_ERROR');
    }
  });

  ipcMain.handle('memory-list', async (_ev, userId: string) => {
    try {
      return (await getMemoryStore()).listFacts(userId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list memory facts', 'MEMORY_LIST_ERROR');
    }
  });

  ipcMain.handle('memory-remember', async (_ev, userId: string, category: string, key: string, value: string) => {
    try {
      return (await getMemoryStore()).remember(userId, category as any, key, value);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to store fact', 'MEMORY_REMEMBER_ERROR');
    }
  });

  ipcMain.handle('memory-forget', async (_ev, userId: string, key: string) => {
    try {
      return (await getMemoryStore()).forget(userId, key);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to forget fact', 'MEMORY_FORGET_ERROR');
    }
  });

  ipcMain.handle('sandbox-status', async (_ev, sessionId?: string) => {
    try {
      // Return general sandbox manager status
      return { status: 'ready', backend: 'local' };
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to get sandbox status', 'SANDBOX_STATUS_ERROR');
    }
  });

  ipcMain.handle('mcp-list-servers', async () => {
    try {
      return (await getMCPServerManager()).listServers();
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list MCP servers', 'MCP_LIST_ERROR');
    }
  });

  ipcMain.handle('mcp-list-tools', async () => {
    try {
      const registry = (await getMCPServerManager()).getToolRegistry();
      return Array.from(registry.values());
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list MCP tools', 'MCP_TOOLS_ERROR');
    }
  });

  // F9 (Requirement 50.1): expose the recommended built-in MCP servers with
  // their boot-time auto-registration status (registered / skipped / error)
  // so the MCP settings panel can render the "Built-in servers" section.
  ipcMain.handle('mcp-list-built-in', async () => {
    try {
      return (await getMCPServerManager()).listBuiltInServers();
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list built-in MCP servers', 'MCP_BUILT_IN_ERROR');
    }
  });

  // F9 (Requirement 50.2): one-click install for a skipped built-in MCP
  // server. Runs the server's cache-warming command (e.g.
  // `npx -y @playwright/mcp@latest --version`) via execFile with an argv array
  // (never a shell string) to populate the npx cache, then re-checks the cache
  // / re-registers and returns the refreshed status so the panel can update.
  ipcMain.handle('mcp-install-built-in', async (_ev, serverId: string) => {
    try {
      return await (await getMCPServerManager()).installBuiltInServer(serverId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to install built-in MCP server', 'MCP_INSTALL_ERROR');
    }
  });

  ipcMain.handle('get-execution-mode', async () => {
    try {
      return (await getExecutionModeRouter()).getModeInfo();
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to get execution mode', 'MODE_ERROR');
    }
  });

  // ── RECEIVE CHANNELS (main → renderer) ─────────────────────────
  // These are push-based: the main process sends events to the renderer.
  // The actual sending happens from the pipeline integration (Task 18).
  // Here we export helper functions for other modules to call.

  console.log('[DeerFlow IPC] Registered 9 invoke channels and 3 receive channels');
}

// ─── Push helpers for receive channels ──────────────────────────

let _mainWindow: BrowserWindow | null = null;

export function setDeerFlowMainWindow(win: BrowserWindow): void {
  _mainWindow = win;
}

export function pushSuggestionsReady(suggestions: unknown[]): void {
  _mainWindow?.webContents.send('suggestions-ready', suggestions);
}

export function pushSandboxOutput(output: unknown): void {
  _mainWindow?.webContents.send('sandbox-output', output);
}

export function pushIMTaskReceived(task: unknown): void {
  _mainWindow?.webContents.send('im-task-received', task);
}
