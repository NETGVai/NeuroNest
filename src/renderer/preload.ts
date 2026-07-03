/**
 * Electron preload script — exposes safe IPC bridge via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const SEND_CHANNELS = [
  'chat-message', 'project-create', 'project-open', 'project-delete', 'project-rename',
  'agent-select', 'navigate', 'command-execute', 'update-agent-prompt', 'save-agent-model', 'toggle-devtools', 'save-project-file', 'save-channel-config', 'toggle-devtools', 'abort-pipeline',
  // Intent Gate — renderer → main
  'intent:override-request', 'intent:disambiguation-response',
  // Spec Interview Engine — renderer → main
  'interview:answer', 'interview:action',
  // Spec Review Card — renderer → main
  'spec:action',
  // Graph management
  'graph-clear-cache',
  // Event_Bus_Bridge — fire-and-forget Pipeline_Event emits from renderer-side
  // agents. Single main-process EventLog is the one writer of `pipeline_events`
  // rows (Requirement 1.3 / 6.1). MUST stay in SEND_CHANNELS, never INVOKE.
  'event-log.emit',
  // Production UX — fire-and-forget agent control channels
  'agent:cancel-task', 'agent:switch-mode', 'approval:respond',
  // Intent Gate — override request (Renderer → Main)
  'intent:override-request',
];

const INVOKE_CHANNELS = [
  'get-app-version', 'get-projects', 'get-active-project', 'get-agents', 'get-agent-details', 'get-theme',
  'get-config', 'get-commands', 'save-providers', 'load-providers', 'get-agent-model', 'validate-api-key', 'list-provider-models', 'get-ollama-status', 'install-ollama', 'start-ollama', 'stop-ollama', 'start-llamacpp', 'stop-llamacpp', 'uninstall-ollama', 'uninstall-llamacpp', 'pull-ollama-model', 'set-default-provider', 'get-default-provider', 'get-project-files', 'read-project-file', 'get-dashboard-stats', 'get-system-stats', 'get-system-stats-slow', 'get-integrations', 'get-channel-configs', 'connect-channel', 'disconnect-channel', 'send-channel-message', 'get-channel-status', 'get-llamacpp-status', 'install-llamacpp', 'get-agent-prompt', 'get-departments', 'autocomplete-command', 'download-project-zip', 'webauthn-register-start', 'webauthn-register-finish', 'webauthn-login-start', 'webauthn-login-finish',
  // Production auth channels
  'auth-start-registration', 'auth-start-login', 'auth-get-status', 'auth-renew-cert', 'auth-get-session', 'auth-get-registered-emails', 'auth-restart-server',
  'git-push-project', 'firewall-get-rules', 'firewall-get-events', 'firewall-get-stats', 'firewall-toggle-rule', 'firewall-update-action', 'test-llm-connection',
  // Enhanced firewall
  'enhanced-firewall-get-config', 'enhanced-firewall-update-policy', 'enhanced-firewall-update-redaction-config', 'enhanced-firewall-set-agent-policy', 'enhanced-firewall-set-project-policy', 'enhanced-firewall-apply-preset', 'enhanced-firewall-enable-llm', 'enhanced-firewall-get-stats', 'enhanced-firewall-test-input', 'enhanced-firewall-export-config', 'enhanced-firewall-import-config', 'enhanced-firewall-reset-config', 'enhanced-firewall-test-llm-connection',
  // Graph management
  'graph-has-graph', 'graph-generate', 'graph-load', 'graph-query', 'graph-stats',
  // Multica integration
  'multica-get-tasks', 'multica-get-task-stats', 'multica-get-agent-tasks', 'multica-add-task-comment', 'multica-get-agent-skills', 'multica-assign-skill', 'multica-get-runtimes', 'multica-register-runtime',
  'skills:list', 'skills:get', 'skills:update', 'skills:install', 'skills:remove',
  'skills:enable', 'skills:disable', 'skills:test', 'skills:refreshCatalog',
  'skills:import', 'skills:export',
  'orchestrator:routeTask', 'project:skills:get', 'project:skills:update', 'project:skills:assign',
  // Agent Skills
  'agent-skills:get-skills', 'agent-skills:get-skill', 'agent-skills:create-skill', 'agent-skills:update-skill', 'agent-skills:delete-skill', 'agent-skills:search-skills',
  'agent-skills:assign-skill', 'agent-skills:get-assignments', 'agent-skills:get-agent-skills', 'agent-skills:update-performance',
  'agent-skills:get-events', 'agent-skills:record-event', 'agent-skills:get-usage-stats', 'agent-skills:get-skill-analytics',
  'agent-skills:subscribe-updates', 'agent-skills:unsubscribe-updates',
  'agent-skills:websocket-status', 'agent-skills:websocket-test', 'agent-skills:websocket-broadcast',
  // Runtime environment
  'runtime-start', 'runtime-stop', 'runtime-restart', 'runtime-status', 'runtime-detect-stack', 'runtime-get-logs',
  // Cost tracking
  'get-project-cost', 'get-cost-breakdown',
  // Diagnostics & Security
  'diagnostics-run-doctor', 'security-run-scan', 'security-run-doctor', 'security-get-scan-history', 'security-export-sarif',
  // DeerFlow integration
  'get-suggestions', 'memory-list', 'memory-remember', 'memory-forget', 'sandbox-status', 'mcp-list-servers', 'mcp-list-tools', 'mcp-list-built-in', 'mcp-install-built-in', 'get-execution-mode',
  // Avatar generation
  'generate-avatar',
  // Stripe subscription payments
  'stripe:create-checkout-session', 'stripe:poll-license', 'stripe:cancel-subscription', 'stripe:validate-license',
  // Enterprise contact sales
  'enterprise:contact-sales',
  // License key management
  'license:fetch-by-code', 'license:validate', 'license:generate', 'license:mark-used', 'license:get-stored', 'license:update-features', 'license:get-app-id', 'license:clear-llm-key',
  // Pro-mode (LLM proxy) state sync — renderer → main
  'pro-mode:hydrate', 'pro-mode:set-state', 'pro-mode:get-state',
  // Referral System
  'referral:send-invite', 'referral:get-stats', 'referral:delete-invite', 'referral:get-deleted-invites', 'referral:withdraw',
  // Action Security & Event Stream & Sandbox
  'security:analyze-action', 'secure:store-token', 'secure:get-token', 'secure:delete-token',
  'update:download',
  'events:publish-action', 'events:publish-observation', 'events:query', 'events:stats',
  'sandbox:check', 'sandbox:create', 'sandbox:execute', 'sandbox:file', 'sandbox:destroy', 'sandbox:list', 'sandbox:install-docker',
  // Brainstorm, Second Opinion, Checkpoint, Edit Lock, Project Memory
  'brainstorm:check', 'brainstorm:start', 'brainstorm:answer', 'brainstorm:design', 'brainstorm:cancel', 'brainstorm:get-active', 'brainstorm:config',
  'second-opinion:get',
  'checkpoint:start', 'checkpoint:stop', 'checkpoint:update', 'checkpoint:decision', 'checkpoint:get-latest', 'checkpoint:has-recovery', 'checkpoint:get-project',
  'editlock:freeze', 'editlock:unfreeze', 'editlock:check', 'editlock:status', 'editlock:list',
  'memory:learn', 'memory:get', 'memory:context', 'memory:search', 'memory:forget', 'memory:reinforce',
  // Code Actions, Steering, Hooks, Diff, Templates, Budget
  'code-action:build',
  'steering:add', 'steering:get', 'steering:context', 'steering:update', 'steering:delete',
  'hooks:create', 'hooks:get', 'hooks:update', 'hooks:delete',
  'diff:record', 'diff:pending', 'diff:accept', 'diff:reject', 'diff:history',
  'templates:list', 'templates:get', 'templates:scaffold',
  'budget:get', 'budget:set', 'budget:record', 'budget:reset',
  // Tool Executor, Context Condenser, Web Browser, Task Tracker
  'tool:execute',
  'condenser:condense', 'condenser:check', 'condenser:config',
  'browser:fetch', 'browser:search',
  'tracker:create', 'tracker:update', 'tracker:get', 'tracker:stats', 'tracker:delete', 'tracker:context',
  // Scheduler, Workspace, Suggestions, Plan-Code-Verify
  'scheduler:create', 'scheduler:get', 'scheduler:run', 'scheduler:delete', 'scheduler:toggle',
  'workspace:create', 'workspace:list', 'workspace:rebase', 'workspace:delete', 'workspace:sync',
  'suggestions:generate',
  'pcv:create', 'pcv:start', 'pcv:complete-step', 'pcv:fail-step', 'pcv:skip-step', 'pcv:get', 'pcv:list', 'pcv:progress', 'pcv:prompt',
  // Approval, Checkpoints, Context Refs, Image, Error Monitor
  'approval:request', 'approval:approve', 'approval:reject', 'approval:pending', 'approval:stats',
  'checkpoint:snapshot', 'checkpoint:compare', 'checkpoint:restore-workspace', 'checkpoint:snapshots', 'checkpoint:delete-snapshot',
  'context:resolve', 'context:detect',
  'image:process-file', 'image:process-base64', 'image:supports-vision',
  'errors:check-file', 'errors:check-project',
  // OpenMythos integration
  'get-openmythos-status', 'install-openmythos', 'start-openmythos', 'stop-openmythos', 'uninstall-openmythos',
  // Shell utilities
  'shell:open-external',
  // Visual Diff Review
  'diff-review:create', 'diff-review:get', 'diff-review:list', 'diff-review:pending', 'diff-review:accept', 'diff-review:reject', 'diff-review:summaries',
  // Multi-Session Parallel Agents
  'parallel:create', 'parallel:get', 'parallel:list', 'parallel:update', 'parallel:delete', 'parallel:add-message', 'parallel:get-messages', 'parallel:stats', 'parallel:run',
  // Extension System
  'extensions:list', 'extensions:get', 'extensions:toggle', 'extensions:install', 'extensions:uninstall', 'extensions:find-for-file',
  // AI Readiness Score
  'readiness:scan', 'readiness:latest', 'generate-neuronest-md',
  // Session Telemetry / Inspector
  'telemetry:record', 'telemetry:snapshots', 'telemetry:summary',
  // Metrics_Sink (read-only time-series for Dashboard_Metrics_Panel and rollout gate)
  'metrics:get-series',
  // Dashboard_Metrics_Panel runtime config (~/.neuronest/config/metrics-panel.json)
  'metrics:get-config',
  // Pipeline Trace
  'trace:list', 'trace:get',
  // Kanban Board
  'kanban:get-board', 'kanban:add-column', 'kanban:delete-column', 'kanban:add-card', 'kanban:update-card', 'kanban:move-card', 'kanban:delete-card',
  // Embedded Browser
  'browser:save-tab', 'browser:get-tabs', 'browser:delete-tab',
  // P2P Session Sharing
  'sharing:create', 'sharing:verify-pin', 'sharing:stop', 'sharing:list',
  // Model Packs
  'model-packs:list', 'model-packs:get', 'model-packs:create', 'model-packs:update', 'model-packs:delete', 'model-packs:set-active', 'model-packs:get-active',
  // Autonomy Manager
  'autonomy:get', 'autonomy:set-level', 'autonomy:set-custom', 'autonomy:get-presets',
  // Smart Router & Health Monitor
  'router:get-config', 'router:update-config', 'router:set-override', 'router:clear-override', 'router:get-override',
  'health:get-statuses', 'health:signal-activity', 'health:start-burst',
  'free-providers:list', 'free-providers:models',
  // AgentMemory
  'agentmemory:status', 'agentmemory:search', 'agentmemory:recent', 'agentmemory:forget',
  // Plan Versioning
  'plan-version:record', 'plan-version:history', 'plan-version:latest', 'plan-version:rewind', 'plan-version:create-branch', 'plan-version:list-branches', 'plan-version:delete-branch',
  // Smart Context
  'smart-context:record', 'smart-context:selections', 'smart-context:latest', 'smart-context:select-files', 'smart-context:stats',
  // Inline Code Completion
  'completion:generate', 'completion:accept', 'completion:stats',
  // CI/PR Checks
  'ci:list-checks', 'ci:create-check', 'ci:toggle-check', 'ci:delete-check', 'ci:run-check', 'ci:recent-runs', 'ci:run-stats', 'ci:get-templates',
  // Auto Lint/Test
  'lint-test:get-config', 'lint-test:set-config', 'lint-test:run', 'lint-test:recent-runs', 'lint-test:stats', 'lint-test:detect',
  // Voice-to-Code
  'voice:transcribe', 'voice:get-config', 'voice:set-config', 'voice:download-models', 'voice:models-ready', 'voice:synthesize',
  // OS Mode
  'os-mode:screenshot', 'os-mode:get-config', 'os-mode:set-config',
  // Git Worktrees
  'worktree:create', 'worktree:list', 'worktree:delete',
  // Notifications
  'notifications:get-config', 'notifications:set-config', 'notifications:send',
  // Context Items (Image/URL/Note/Pipe)
  'context:add', 'context:list', 'context:remove', 'context:load-url',
  // Prompt Cache
  'prompt-cache:stats', 'prompt-cache:clear',
  // Headroom prompt compression telemetry (Slice 1)
  'headroom:stats', 'headroom:reset', 'headroom:set-enabled',
  // Slice 2: per-payload compression for renderer-side use
  'headroom:compress-text',
  // Config Profiles
  'profiles:list', 'profiles:create', 'profiles:activate', 'profiles:delete',
  // Team Personas
  'personas:list', 'personas:create', 'personas:delete',
  // Session Status
  'session-status:get', 'session-status:set',
  // File-Session Links
  'file-links:link', 'file-links:for-session', 'file-links:for-file',
  // Plan Archive
  'archive:create', 'archive:list', 'archive:unarchive',
  // Session Alerts
  'alerts:create', 'alerts:active', 'alerts:dismiss', 'alerts:dismiss-all',
  // Global Search
  'global-search:search', 'global-search:index',
  // Onboarding
  'onboarding:progress', 'onboarding:complete-step', 'onboarding:dismiss',
  // Decision Log
  'decisions:create', 'decisions:list', 'decisions:supersede', 'decisions:delete',
  // App Zoom
  'zoom:get', 'zoom:set',
  // Auto-Commit
  'git:auto-commit',
  // Recipes
  'recipes:list', 'recipes:get', 'recipes:create', 'recipes:delete', 'recipes:run', 'recipes:recent-runs', 'recipes:deeplink',
  // Subagents
  'subagents:create', 'subagents:list', 'subagents:run',
  // Tool Permissions
  'tool-perms:get', 'tool-perms:set', 'tool-perms:list',
  // Adversary Reviewer
  'adversary:review', 'adversary:flags', 'adversary:stats',
  // Context Compaction
  'compaction:record', 'compaction:stats',
  // Turn Management
  'turns:get', 'turns:set-limit', 'turns:increment', 'turns:reset',
  // Response Schemas
  'schemas:create', 'schemas:list', 'schemas:get', 'schemas:update', 'schemas:delete', 'schemas:activate', 'schemas:get-active', 'schemas:validate',
  // Scheduler
  'scheduler:add', 'scheduler:remove', 'scheduler:list', 'scheduler:pause', 'scheduler:resume',
  // Skill Learner
  'skills:learned-list', 'skills:learned-delete', 'skills:find-matching',
  // Subagent
  'subagent:spawn',
  // Architectural Quality
  'arch:scan', 'arch:latest', 'arch:gate-start', 'arch:gate-end', 'arch:gate-history',
  'arch:add-rule', 'arch:get-rules', 'arch:toggle-rule', 'arch:delete-rule', 'arch:check-rules',
  'arch:evolution', 'arch:dsm', 'arch:test-gaps', 'arch:get-test-gaps',
  // SRE Features
  'evidence:cite', 'evidence:list',
  'runbooks:list', 'runbooks:create', 'runbooks:toggle', 'runbooks:delete', 'runbooks:find-matching',
  'predictive:active', 'predictive:acknowledge', 'predictive:analyze',
  'reports:create', 'reports:list', 'reports:update-status',
  'validation:test-provider', 'validation:get-all', 'validation:test-all',
  // AI Review Model
  'review:get-config', 'review:update-config', 'review:run', 'review:recent', 'review:stats',
  // Steer/Queue Message Mode
  'msgmode:get-config', 'msgmode:set-config', 'msgmode:enqueue', 'msgmode:pending', 'msgmode:dequeue', 'msgmode:complete', 'msgmode:cancel', 'msgmode:cancel-all', 'msgmode:stats',
  // Missions
  'missions:create', 'missions:get', 'missions:list', 'missions:update-status', 'missions:update-progress', 'missions:add-worker', 'missions:get-workers', 'missions:delete', 'missions:stats',
  // Specification Mode
  'specs:get-config', 'specs:update-config', 'specs:create', 'specs:update', 'specs:get', 'specs:list', 'specs:stats', 'specs:build-prompt',
  // Wiki Generation
  'wiki:get-config', 'wiki:update-config', 'wiki:generate', 'wiki:complete-generation', 'wiki:add-page', 'wiki:get-pages', 'wiki:get-generations', 'wiki:stats', 'wiki:delete',
  // Headless Exec
  'exec:get-config', 'exec:update-config', 'exec:start', 'exec:complete', 'exec:recent', 'exec:stats',
  // QA/Demo/Verify
  'qa:get-config', 'qa:update-config', 'qa:start', 'qa:update', 'qa:get', 'qa:recent', 'qa:stats',
  // Best-of-N Evaluation
  'bon:get-config', 'bon:update-config', 'bon:start', 'bon:update', 'bon:recent', 'bon:stats', 'bon:build-synthesis',
  // Workspace Forking
  'fork:create', 'fork:list', 'fork:get', 'fork:delete', 'fork:stats',
  // Runtime Backends
  'backends:get-config', 'backends:update-config', 'backends:add', 'backends:list', 'backends:update-status', 'backends:delete',
  // AI Gateway
  'gateway:get-config', 'gateway:update-config', 'gateway:log', 'gateway:audit-log', 'gateway:stats',
  // E2E Encrypted Sharing
  'e2e:get-config', 'e2e:update-config', 'e2e:share', 'e2e:get-share', 'e2e:list', 'e2e:delete', 'e2e:decrypt', 'e2e:stats',
  // Indexing Pipeline
  'indexing:getStatus', 'indexing:fullReindex', 'indexing:stop', 'indexing:getConfig', 'indexing:updateConfig',
  // Performance: BoundedMessageStore
  'load-older-messages', 'persist-overflow-messages', 'get-overflow-count', 'clear-overflow-session',
  // Readiness Probe (Feature 6)
  'app:readiness',
  // Cookbook (Feature 8) — hardware detection, model ranking, serve profiles
  'cookbook:detect-hardware', 'cookbook:rank-models', 'cookbook:compute-profiles',
  // GCF_Wire_Format (Feature 10) — Phase 1 rollout gate status for the Settings banner
  'gcf:rollout-gate-status',
  // Skill Packs (Feature 11) — install/list/sync/remove + drift & eval
  'skill-packs:install', 'skill-packs:list', 'skill-packs:sync', 'skill-packs:remove', 'skill-packs:check-drift', 'skill-packs:run-eval',
  // Production UX — agent state & change queries
  'agent:get-change-summary', 'agent:get-diff', 'agent:get-progress-steps',
  // Production UX — steering file management
  'steering:list', 'steering:create',
  // Production UX — hooks management
  'hooks:list', 'hooks:get-history',
  // Production UX — powers management
  'powers:list', 'powers:activate', 'powers:deactivate',
  // Production UX — focus mode
  'focus-mode:toggle',
];

const RECEIVE_CHANNELS = [
  'theme-changed', 'shortcut', 'navigate', 'agent-details', 'tool-output',
  'chat-response', 'project-updated', 'projects-list', 'project-opened',
  'typing-start', 'typing-stop', 'project-files-updated', 'clear-chat', 'update-stats', 'active-project', 'channel-status-update', 'firewall-event', 'model-pull-progress',
  'provider-health-update', 'autonomy-action', 'agentmemory-status',
  // Agent Loop progress
  'agent-progress',
  // Agent Skills real-time updates
  'agent-skills:real-time-update',
  // Runtime environment
  'runtime-log', 'runtime-status-update', 'runtime-preflight-failed',
  // Voice TTS
  'voice:download-progress',
  // Diagnostics & Security
  'diagnostics-progress', 'security-scan-progress',
  // DeerFlow integration
  'suggestions-ready', 'sandbox-output', 'im-task-received',
  // Production auth
  'auth-status-update',
  // Stripe subscription payments
  'subscription-status-update',
  // LLM streaming
  'chat:stream', 'chat:done', 'chat:error',
  // OpenMythos integration
  'openmythos-status-update',
  // Multi-Session Parallel Agents
  'parallel:session-updated',
  // CI Check completed
  'ci:check-completed',
  // Dashboard_Metrics_Panel — broadcast on `metrics-panel.json` edits
  'metrics:config-updated',
  // Production UX — real-time agent event streaming
  'agent:progress', 'agent:tool-event', 'agent:file-change', 'agent:stream-token',
  'agent:task-complete', 'agent:error', 'agent:parallel-status', 'agent:approval-request',
  // Intent Gate — main → renderer
  'intent:decision', 'intent:disambiguation',
  // Spec Interview Engine — main → renderer
  'interview:batched-card', 'interview:turn', 'interview:resume',
  // Spec Review Card — main → renderer
  'spec:review',
  // Production UX — hooks execution status
  'hooks:execution-status',
  // Intent Gate — decision broadcast (Main → Renderer)
  'intent:decision',
];

contextBridge.exposeInMainWorld('electronAPI', {
  send(channel: string, ...args: unknown[]) {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke(channel: string, ...args: unknown[]) {
    if (INVOKE_CHANNELS.includes(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error(`Channel not allowed: ${channel}`));
  },
  on(channel: string, callback: (...args: unknown[]) => void) {
    if (RECEIVE_CHANNELS.includes(channel)) {
      const wrapper = (_event: unknown, ...args: unknown[]) => callback(...args);
      // Store the wrapper so removeListener can find it
      if (!(callback as any).__ipcWrappers) (callback as any).__ipcWrappers = {};
      (callback as any).__ipcWrappers[channel] = wrapper;
      ipcRenderer.on(channel, wrapper);
    }
  },
  removeListener(channel: string, callback: (...args: unknown[]) => void) {
    if (RECEIVE_CHANNELS.includes(channel)) {
      const wrapper = (callback as any).__ipcWrappers && (callback as any).__ipcWrappers[channel];
      if (wrapper) {
        ipcRenderer.removeListener(channel, wrapper);
        delete (callback as any).__ipcWrappers[channel];
      } else {
        // Fallback: try removing directly (won't work for wrapped callbacks but won't error)
        ipcRenderer.removeListener(channel, callback);
      }
    }
  },
});

// ─── Window Unload Cleanup ──────────────────────────────────────
// Remove all IPC listeners when the window is unloading to prevent
// memory leaks and stale event handlers during navigation or reload.
window.addEventListener('beforeunload', () => {
  for (const channel of RECEIVE_CHANNELS) {
    ipcRenderer.removeAllListeners(channel);
  }
});

// ─── Event_Bus_Bridge helper (`window.eventBusBridge`) ──────────
// Renderer-side agents emit Pipeline_Events via this helper. The
// channel is fire-and-forget — the IPC handler in `src/main/ipc.ts`
// uses `ipcMain.on` (not `handle`), so there's no return value to
// await. Inputs are not validated here; the main-process handler
// is the trust boundary and rejects malformed emits silently per
// design.md "Renderer emits via Event_Bus_Bridge while main is
// shutting down".
//
// Note on naming: the global is intentionally NOT called `eapi` —
// `index.ts` already declares a top-level `function eapi()` helper
// that returns `window.electronAPI`. `contextBridge.exposeInMainWorld`
// installs the global as a non-configurable lexical binding, so a
// classic-script `function eapi()` parsed afterwards triggers
// `SyntaxError: Identifier 'eapi' has already been declared` and
// black-screens the renderer.
contextBridge.exposeInMainWorld('eventBusBridge', {
  emitEvent(input: { sessionId: string; kind: string; payload: unknown }) {
    ipcRenderer.send('event-log.emit', input);
  },
});
