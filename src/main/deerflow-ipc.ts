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

function getSkillLoader() {
  if (!_skillLoader) {
    const { SkillLoader } = require('../pipeline/skill-loader.js');
    _skillLoader = new SkillLoader();
  }
  return _skillLoader!;
}

function getContextSummarizer() {
  if (!_contextSummarizer) {
    const { ContextSummarizer } = require('../pipeline/context-summarizer.js');
    _contextSummarizer = new ContextSummarizer({ workspaceDir: '.neuronest/summaries' });
  }
  return _contextSummarizer!;
}

function getExecutionModeRouter() {
  if (!_executionModeRouter) {
    const { ExecutionModeRouter } = require('../pipeline/execution-mode-router.js');
    const { AGENT_REGISTRY } = require('../agents/agent-registry.js');
    // Minimal stubs for dependencies — real wiring happens in pipeline integration
    const stubSwarm = { execute: async () => ({ output: '', agentsUsed: [], tokensUsed: 0 }) };
    const stubLLM = { chat: async () => ({ content: '', tokensUsed: 0 }) };
    _executionModeRouter = new ExecutionModeRouter(stubSwarm, stubLLM, AGENT_REGISTRY || []);
  }
  return _executionModeRouter!;
}

function getMemoryStore() {
  if (!_memoryStore) {
    const { MemoryStore } = require('../storage/memory-store.js');
    _memoryStore = new MemoryStore(null); // Falls back to ephemeral store
  }
  return _memoryStore!;
}

function getSuggestionGenerator() {
  if (!_suggestionGenerator) {
    const { SuggestionGenerator } = require('../pipeline/suggestion-generator.js');
    _suggestionGenerator = new SuggestionGenerator(getMemoryStore());
  }
  return _suggestionGenerator!;
}

function getSandboxManager() {
  if (!_sandboxManager) {
    const { SandboxManager } = require('../sandbox/sandbox-manager.js');
    const stubFirewall = { evaluate: (input: string) => ({ passed: true, blocked: false, sanitized: input }) };
    _sandboxManager = new SandboxManager(null, stubFirewall);
  }
  return _sandboxManager!;
}

function getMCPServerManager() {
  if (!_mcpServerManager) {
    const { MCPServerManager } = require('../mcp/mcp-server-manager.js');
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
  }
  return _mcpServerManager!;
}

function getIMGateway() {
  if (!_imGateway) {
    const { IMGateway } = require('../channels/im-gateway.js');
    const stubChannelManager = {
      connect: async () => ({ success: true, message: 'connected' }),
      disconnect: async () => {},
      sendMessage: async () => ({ success: true }),
      onMessage: () => {},
    };
    const stubFirewall = { evaluate: () => ({ allowed: true }) };
    const stubSwarm = { execute: async () => ({ output: '' }) };
    _imGateway = new IMGateway(stubChannelManager, stubFirewall, stubSwarm);
  }
  return _imGateway!;
}

function getSubAgentContextIsolator() {
  if (!_subAgentContextIsolator) {
    const { SubAgentContextIsolator } = require('../pipeline/sub-agent-context-isolator.js');
    _subAgentContextIsolator = new SubAgentContextIsolator(getContextSummarizer(), getMemoryStore());
  }
  return _subAgentContextIsolator!;
}

function getToolCallRecoveryHandler() {
  if (!_toolCallRecoveryHandler) {
    const { ToolCallRecoveryHandler } = require('../pipeline/tool-call-recovery.js');
    _toolCallRecoveryHandler = new ToolCallRecoveryHandler();
  }
  return _toolCallRecoveryHandler!;
}

// ─── Register DeerFlow IPC handlers ─────────────────────────────

export function registerDeerFlowIPC(mainWindow: BrowserWindow): void {
  // ── INVOKE CHANNELS (renderer → main) ──────────────────────────

  ipcMain.handle('get-suggestions', async (_ev, taskOutput: string, agentDomain: string, userId: string) => {
    try {
      return getSuggestionGenerator().generate(taskOutput, agentDomain, userId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to generate suggestions', 'SUGGESTION_ERROR');
    }
  });

  ipcMain.handle('memory-list', async (_ev, userId: string) => {
    try {
      return getMemoryStore().listFacts(userId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list memory facts', 'MEMORY_LIST_ERROR');
    }
  });

  ipcMain.handle('memory-remember', async (_ev, userId: string, category: string, key: string, value: string) => {
    try {
      return getMemoryStore().remember(userId, category as any, key, value);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to store fact', 'MEMORY_REMEMBER_ERROR');
    }
  });

  ipcMain.handle('memory-forget', async (_ev, userId: string, key: string) => {
    try {
      return getMemoryStore().forget(userId, key);
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
      return getMCPServerManager().listServers();
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to list MCP servers', 'MCP_LIST_ERROR');
    }
  });

  ipcMain.handle('mcp-list-tools', async () => {
    try {
      const registry = getMCPServerManager().getToolRegistry();
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
      return getMCPServerManager().listBuiltInServers();
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
      return await getMCPServerManager().installBuiltInServer(serverId);
    } catch (err: any) {
      return errorResponse(err?.message ?? 'Failed to install built-in MCP server', 'MCP_INSTALL_ERROR');
    }
  });

  ipcMain.handle('get-execution-mode', async () => {
    try {
      return getExecutionModeRouter().getModeInfo();
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
