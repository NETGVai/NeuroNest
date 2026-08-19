/**
 * Electron preload script — exposes safe IPC bridge via contextBridge.
 *
 * ─── IPC Privilege Tiers (Requirement 28.1, 28.2, 28.3, 28.4) ──────────────
 * Channels are categorized into privilege tiers to limit renderer compromise impact:
 *   • public     — UI state channels (get-theme, get-agents, get-departments)
 *   • authenticated — user operation channels (kb:*, training:*, model-compare:*)
 *   • admin      — system operation channels (tool:execute, ops:approve-grant, secure:get-token)
 *
 * Admin-tier channels require caller authorization before the main-process handler
 * processes the request. Tier categorization is enforced at runtime — requests to
 * incorrectly categorized channels are rejected.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  IpcCleanupReason,
  IpcSubscriptionRegistry,
  IpcSubscriptionScope,
} from './preload-subscription-registry';

import type {
  AppBootstrapSnapshot,
  CloudProviderKeysMigrationConfigPayload,
  InspectorLayoutState,
  LaunchModeSettings,
  LegacyProviderKeyDeleteRequestV1,
  LegacyProviderKeyDeleteResultV1,
  LegacyProviderKeyListV1,
} from '../shared/app-bootstrap-contracts.js';
import type {
  EntitlementStatusV1,
  InspectorLayoutUpdateRequestV1,
  LaunchModeUpdateRequestV1,
  ProxyCredentialStatusV1,
} from '../shared/app-bootstrap-ipc-contracts.js';
import type {
  ChatProjectionCompositionQueryV1,
  ChatProjectionCompositionResultV1,
  ChatProjectionInvalidatedV1,
  ChatProjectionPageQueryV1,
  ChatProjectionPageResultV1,
  ChatProjectionScopeV1,
  ChatProjectionUnsubscribe,
  ChatRenderStatusResultV1,
  ScopedChatProjectionDeltaV1,
} from './types/structured-chat-preload.js';
import type {
  CommandEnvelopeV1,
  CommandTransportReceiptV1,
} from '../harness/contracts/index.js';
import type {
  ExternalLinkRequestV1,
  ExternalLinkResultV1,
} from '../shared/external-link-ipc-contracts.js';
import { SHELL_OPEN_EXTERNAL_CHANNEL } from '../shared/external-link-ipc-contracts.js';

const { contextBridge, ipcRenderer } = require('electron');
const ipcSubscriptions = new IpcSubscriptionRegistry(ipcRenderer);

// ─── IPC Privilege Tiers ─────────────────────────────────────────────────────
// Channels that expose system-level operations requiring caller authorization.
// Admin-tier handlers verify authorization before processing (Req 28.2, 28.3).
const ADMIN_CHANNELS = [
  'tool:execute',
  'ops:approve-grant',
  'secure:get-token',
] as const;

// Channels that require an authenticated session but not admin privileges.
const AUTHENTICATED_CHANNEL_PREFIXES = [
  'kb:',
  'training:',
  'model-compare:',
] as const;

// Public channels — no authorization required (UI state queries).
const PUBLIC_CHANNELS = [
  'get-theme',
  'get-agents',
  'get-departments',
  'get-app-version',
] as const;

/**
 * Determine the privilege tier for a given channel.
 * Used for runtime validation that channels are correctly categorized.
 */
function getChannelTier(channel: string): 'public' | 'authenticated' | 'admin' {
  if ((ADMIN_CHANNELS as readonly string[]).includes(channel)) return 'admin';
  for (const prefix of AUTHENTICATED_CHANNEL_PREFIXES) {
    if (channel.startsWith(prefix)) return 'authenticated';
  }
  if ((PUBLIC_CHANNELS as readonly string[]).includes(channel)) return 'public';
  // Default: treat as authenticated (requires valid session but not admin)
  return 'authenticated';
}

const SEND_CHANNELS = [
  'chat-message', 'project-create', 'project-open', 'project-delete', 'project-rename',
  'agent-select', 'navigate', 'command-execute', 'update-agent-prompt', 'save-agent-model', 'toggle-devtools', 'save-project-file', 'save-channel-config', 'abort-pipeline',
  // User profile IPC (replaces executeJavaScript localStorage reads)
  'user-profile-response',
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
];

const INVOKE_CHANNELS = [
  'get-app-version', 'get-projects', 'get-active-project', 'get-agents', 'get-agent-details', 'get-theme',
  'get-commands', 'save-providers', 'load-providers', 'get-agent-model', 'validate-api-key', 'list-provider-models', 'get-ollama-status', 'install-ollama', 'start-ollama', 'stop-ollama', 'start-llamacpp', 'stop-llamacpp', 'uninstall-ollama', 'uninstall-llamacpp', 'pull-ollama-model', 'set-default-provider', 'get-default-provider', 'set-execution-mode', 'get-project-files', 'read-project-file', 'get-dashboard-stats', 'get-system-stats', 'get-system-stats-slow', 'get-integrations', 'get-channel-configs', 'connect-channel', 'disconnect-channel', 'send-channel-message', 'get-channel-status', 'get-llamacpp-status', 'install-llamacpp', 'get-agent-prompt', 'get-departments', 'autocomplete-command', 'download-project-zip', 'webauthn-register-start', 'webauthn-register-finish', 'webauthn-login-start', 'webauthn-login-finish',
  // Production auth channels
  'auth-start-registration', 'auth-start-login', 'auth-get-status', 'auth-renew-cert', 'auth-get-session', 'auth-get-registered-emails', 'auth-restart-server',
  'git-push-project', 'firewall-get-rules', 'firewall-get-events', 'firewall-get-stats', 'firewall-toggle-rule', 'firewall-update-action', 'test-llm-connection',
  // Enhanced firewall
  'enhanced-firewall-get-config', 'enhanced-firewall-update-policy', 'enhanced-firewall-update-redaction-config', 'enhanced-firewall-set-agent-policy', 'enhanced-firewall-set-project-policy', 'enhanced-firewall-apply-preset', 'enhanced-firewall-enable-llm', 'enhanced-firewall-get-stats', 'enhanced-firewall-test-input', 'enhanced-firewall-export-config', 'enhanced-firewall-import-config', 'enhanced-firewall-reset-config', 'enhanced-firewall-test-llm-connection',
  // Graph management
  'graph-has-graph', 'graph-generate', 'graph-load', 'graph-query', 'graph-stats',
  // Codebase analysis
  'codebase-analyze', 'codebase-blast-radius', 'codebase-health-score', 'codebase-patterns',
  'codebase-layers', 'codebase-communities', 'codebase-path-trace', 'codebase-query', 'codebase-heatmap',
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
  // P5 orphan sweep (task 23.2) — Category A IPC handlers wired onto the live
  // path in registerIPCHandlers (src/main/ipc.ts); allowlisted here so their
  // renderer-side callers (visual-diff-panel, artifact-panel, sandbox preview,
  // benchmark-panel, plugin-registry-panel, drift-dashboard-panel,
  // pipeline-panel, security stats) can actually reach them.
  'vision:analyze', 'vision:compare', 'vision:diagram',
  'artifact:list', 'artifact:get', 'artifact:delete', 'artifact:history', 'artifact:diff',
  'sandbox:boot', 'sandbox:write', 'sandbox:run', 'sandbox:preview-url', 'sandbox:terminate',
  'bench:list-profiles', 'bench:create-profile', 'bench:run', 'bench:results', 'bench:trends',
  'plugin:catalog', 'plugin:install', 'plugin:uninstall', 'plugin:enable', 'plugin:disable', 'plugin:permissions', 'plugin:list',
  'pipeline:define', 'pipeline:execute', 'pipeline:cancel', 'pipeline:list', 'quickaction:execute', 'quickaction:list',
  'drift:get-state', 'security:remediation-stats', 'get-session-metrics', 'get-cumulative-metrics',
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
  // Voice Input (Speech-to-Text) — Kilo-Inspired Feature Integration
  'voice:start-capture', 'voice:stop-capture', 'voice:status',
  // Interactive Terminal (Kilo-Inspired Feature Integration)
  'terminal:create', 'terminal:write', 'terminal:read', 'terminal:close',
  // OS Mode
  'os-mode:screenshot', 'os-mode:get-config', 'os-mode:set-config',
  // Git Worktrees
  'worktree:create', 'worktree:list', 'worktree:delete', 'worktree:merge', 'worktree:discard', 'worktree:diff',
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
  'personas:list', 'personas:create', 'personas:update', 'personas:delete', 'personas:preview', 'personas:activate',
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
  'subagent:spawn', 'subagent:status', 'subagent:results',
  // Loop Engine
  'loops:list', 'loops:craft', 'loops:audit', 'loops:run', 'loops:approve',
  'loops:stop', 'loops:runStatus', 'loops:receipt',
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
  // Model Comparison Panel (Requirement 18.1, 18.2, 18.3)
  'model-compare:list-models', 'model-compare:get-metrics', 'model-compare:compare',
  // Indexing Pipeline
  'indexing:getStatus', 'indexing:fullReindex', 'indexing:stop', 'indexing:getConfig', 'indexing:updateConfig',
  // Inline Autocomplete (Kilo-Inspired Feature Integration)
  'autocomplete:request', 'autocomplete:cancel', 'autocomplete:config',
  // Semantic Index (Kilo-Inspired Feature Integration)
  'semantic:search', 'semantic:index-status', 'semantic:reindex',
  // Context Mentions (Kilo-Inspired Feature Integration)
  'context:resolve-mention', 'context:list-mentionables',
  // Prompt Enhancement (Kilo-Inspired Feature Integration)
  'prompt:enhance', 'prompt:config',
  // Commit Message Generator (Kilo-Inspired Feature Integration)
  'commit:generate', 'commit:config',
  // i18n (Kilo-Inspired Feature Integration)
  'i18n:set-locale', 'i18n:get-locale', 'i18n:available-locales',
  // LSP Integration (Kilo-Inspired Feature Integration)
  'lsp:diagnostics', 'lsp:references', 'lsp:definition', 'lsp:symbols', 'lsp:status',
  // DiffViewer (Kilo-Inspired Feature Integration)
  'diff:get-turns', 'diff:get-files', 'diff:revert-turn', 'diff:revert-file',
  // CheckpointTimeline (Kilo-Inspired Feature Integration)
  'checkpoint:timeline', 'checkpoint:restore', 'checkpoint:star',
  // CheckpointTimeline v2 — extended with hunk attribution and rewind (Req 14.9, 14.10, 14.11)
  'checkpoint:timeline-v2', 'checkpoint:rewind-preview', 'checkpoint:rewind-execute',
  // Code Review Pipeline (Kilo-Inspired Feature Integration)
  'review:start', 'review:status', 'review:comments', 'review:post-to-github',
  // Cost Controls (Kilo-Inspired Feature Integration)
  'cost:budget-set', 'cost:budget-status', 'cost:alert-config', 'cost:session-summary',
  // Background Process Manager (Kilo-Inspired Feature Integration)
  'process:start', 'process:stop', 'process:list', 'process:logs', 'process:status',
  // Network Sandbox (Kilo-Inspired Feature Integration)
  'sandbox:policy-get', 'sandbox:policy-set', 'sandbox:log', 'sandbox:activity',
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
  // Training Pipeline (Training Progress + Training Config panels)
  'training:job-start', 'training:job-cancel', 'training:job-pause', 'training:job-resume',
  'training:job-status', 'training:jobs-list', 'training:config-get', 'training:config-validate',
  'training:hardware-detect', 'training:export-model', 'training:compare-models',
  'training:store-preference', 'training:job-delete', 'training:storage-usage', 'training:cleanup',
  // Production UX — agent state & change queries
  'agent:get-change-summary', 'agent:get-diff', 'agent:get-progress-steps',
  // Production UX — steering file management
  'steering:list', 'steering:create',
  // Production UX — hooks management
  'hooks:list', 'hooks:get-history', 'hooks:enable', 'hooks:disable', 'hooks:history', 'hooks:run-now',
  // Production UX — powers management
  'powers:list', 'powers:activate', 'powers:deactivate',
  // Production UX — focus mode
  'focus-mode:toggle',
  // Feature Gate Management (Task 1.3 / 1.6)
  'feature-gate:get-all', 'feature-gate:set', 'feature-gate:audit', 'feature-gate:reset', 'feature-gate:export', 'feature-gate:import',
  // Plan Mode (Task 3.4 — Req 11.8)
  'plan-mode:get-state', 'plan-mode:toggle',
  // File Tree Panel (Requirement 23.6, 23.7, 23.15)
  'filetree:get-tree', 'filetree:open-file', 'filetree:get-modified-files',
  // Chat enhanced renderers (Requirement 23.1, 23.2, 23.5)
  'chat:apply-code', 'chat:open-file-reference', 'chat:regenerate-message', 'chat:edit-message', 'chat:insert-at-cursor', 'chat:apply-diff', 'chat:mark-step-complete',
  // Spec Viewer Panel (Requirement 23.9, 23.10, 23.11)
  'spec:get-document', 'spec:run-workflow', 'spec:get-task-status',
  // Operations Dashboard (Requirement 15.1-15.6, 19.1-19.3, 20.1-20.3)
  'ops:get-active-runs', 'ops:get-pending-approvals', 'ops:get-cost-status', 'ops:get-policy-decisions', 'ops:approve-grant', 'ops:audit-log', 'ops:subscribe-updates',
  // Knowledge Base Panel (Requirement 14.1-14.4, 15.1-15.2)
  'kb:sources-list', 'kb:source-add', 'kb:source-remove', 'kb:source-reindex', 'kb:status', 'kb:search', 'kb:config-update',
  // Git Skill Import (Requirement 9.1, 9.2, 9.3, 21.7)
  'git-import:run',
  // Channel Adapter System (Requirement 25.2)
  'channel:list', 'channel:metadata',
  // Session Context Viewer (Requirement 5.4, 5.5)
  'list-active-sessions', 'get-session-info', 'clear-session-context',
  // Structured response renderer — exact versioned read/command channels
  'chat-projection:get-page-v1', 'chat-projection:get-composition-v1',
  'chat-command:submit-v1', 'chat-diagnostics:get-render-status-v1',
];

const RECEIVE_CHANNELS = [
  'theme-changed', 'shortcut', 'navigate', 'agent-details', 'tool-output',
  'chat-response', 'project-updated', 'projects-list', 'project-opened',
  'typing-start', 'typing-stop', 'project-files-updated', 'clear-chat', 'update-stats', 'active-project', 'channel-status-update', 'firewall-event', 'model-pull-progress',
  'provider-health-update', 'autonomy-action', 'agentmemory-status',
  // File Tree Panel — file opened by main process / files changed notifications
  'editor:open-file', 'filetree:files-changed',
  // Agent Loop progress
  'agent-progress',
  // Codebase analysis progress
  'codebase-progress',
  // Agent Skills real-time updates
  'agent-skills:real-time-update',
  // Runtime environment
  'runtime-log', 'runtime-status-update', 'runtime-preflight-failed',
  // Voice TTS
  'voice:download-progress',
  // Voice Input (Speech-to-Text) — real-time updates
  'voice:status-update', 'voice:audio-level',
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
  // Dashboard session lifecycle (agent routing from dashboard dispatch)
  'dashboard:session-started',
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
  // Autocomplete status updates (Main → Renderer)
  'autocomplete:status',
  // Interactive Terminal status updates (Main → Renderer)
  'terminal:output', 'terminal:status-update',
  // Worktree manager panel updates (Main → Renderer)
  'worktree:status-update',
  // Prompt Enhancement confirmation (Main → Renderer)
  'prompt:enhanced',
  // DiffViewer turn updates (Main → Renderer)
  'diff:turn-updated',
  // CheckpointTimeline updates (Main → Renderer)
  'checkpoint:timeline-updated',
  // CheckpointTimeline v2 updates (Main → Renderer) — Req 14.9
  'checkpoint:timeline-v2-updated',
  // Cost Controls real-time budget events (Main → Renderer)
  'cost:budget-event',
  // Background Process Manager status updates (Main → Renderer)
  'process:status-update',
  // Network Sandbox activity updates (Main → Renderer)
  'sandbox:activity-update',
  // Loop Engine pass progress and state updates (Main → Renderer)
  'loop:pass-completed', 'loop:state-changed', 'loop:run-completed',
  // Drift Management real-time signals (Main → Renderer)
  'drift:signal', 'drift:state-update',
  // Plan Mode state updates (Main → Renderer)
  'plan-mode:state-update',
  // Training Pipeline real-time updates (Main → Renderer)
  'training:progress-update', 'training:job-state-changed', 'training:metrics-update', 'training:export-progress',
  // Agent Catalog updates (deferred import completed)
  'agents:catalog-updated',
  // Launch mode hot-swap (Classic ↔ Advanced without restart)
  'launch-mode:changed',
  // Knowledge Base Panel — real-time indexing/status updates (Main → Renderer)
  'kb:indexing-progress', 'kb:source-status-changed', 'kb:search-results',
  // User profile request (Main → Renderer, response via 'user-profile-response' send channel)
  'request-user-profile',
  // Channel Adapter System — registry change broadcast (Requirement 25.2)
  'channel-registry-update',
  // Structured response renderer — exact versioned projection events
  'chat-projection:delta-v1', 'chat-projection:invalidated-v1',
];

type StructuredProjectionReceiveChannel =
  | 'chat-projection:delta-v1'
  | 'chat-projection:invalidated-v1';

const scopedProjectionWrappers = new WeakMap<
  (...args: never[]) => unknown,
  Map<string, (payload: unknown) => void>
>();

/**
 * Reverse mapping from scoped wrapper callback → original callback identity.
 * Allows the disposal listener to purge the correct WeakMap entries when
 * subscriptions are cleaned up, preventing retained composition/detail payloads.
 */
const wrapperOwnership = new Map<
  (payload: unknown) => void,
  { originalCallback: (...args: never[]) => unknown; wrapperKey: string }
>();

// ─── Projection Wrapper Cleanup ──────────────────────────────────
// When subscriptions are disposed (session-switch, unload, rollback, or last
// lease released), purge the corresponding scoped wrapper so that stale closures
// cannot be reused and retained composition/detail payloads are released.
ipcSubscriptions.onDispose((disposal) => {
  if (!disposal.callback) return;
  const scopedCb = disposal.callback as (payload: unknown) => void;
  const ownership = wrapperOwnership.get(scopedCb);
  if (!ownership) return;

  // Remove the wrapper entry from the forward map
  const wrappers = scopedProjectionWrappers.get(ownership.originalCallback);
  if (wrappers) {
    wrappers.delete(ownership.wrapperKey);
    if (wrappers.size === 0) {
      scopedProjectionWrappers.delete(ownership.originalCallback);
    }
  }
  // Remove the reverse mapping
  wrapperOwnership.delete(scopedCb);
});

function assertProjectionScope(scope: ChatProjectionScopeV1): void {
  if (
    scope === null
    || typeof scope !== 'object'
    || scope.schemaVersion !== 1
    || typeof scope.sessionId !== 'string'
    || scope.sessionId.length === 0
    || typeof scope.branchId !== 'string'
    || scope.branchId.length === 0
  ) {
    throw new TypeError('A version 1 projection session/branch scope is required');
  }
}

/**
 * Freezes the caller-supplied scope so post-subscribe mutation cannot change
 * the filter identity or the {@link IpcSubscriptionScope} lease that owns the
 * listener. This preserves the "ignore stale or mismatched stream events"
 * invariant when the same scope literal is reused across subscriptions.
 */
function normalizeProjectionScope(scope: ChatProjectionScopeV1): ChatProjectionScopeV1 {
  assertProjectionScope(scope);
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId: scope.sessionId,
    branchId: scope.branchId,
  });
}

function subscribeScopedProjection<T extends ChatProjectionScopeV1>(
  channel: StructuredProjectionReceiveChannel,
  scope: ChatProjectionScopeV1,
  callback: (event: T) => void,
): ChatProjectionUnsubscribe {
  const frozenScope = normalizeProjectionScope(scope);
  if (typeof callback !== 'function') {
    throw new TypeError('A projection subscription callback is required');
  }

  const wrapperKey = `${channel}\u0000${frozenScope.sessionId}\u0000${frozenScope.branchId}`;
  let wrappers = scopedProjectionWrappers.get(callback);
  if (!wrappers) {
    wrappers = new Map<string, (payload: unknown) => void>();
    scopedProjectionWrappers.set(callback, wrappers);
  }

  let scopedCallback = wrappers.get(wrapperKey);
  if (!scopedCallback) {
    scopedCallback = (payload: unknown): void => {
      if (payload === null || typeof payload !== 'object') return;
      const envelope = payload as Partial<ChatProjectionScopeV1>;
      if (
        envelope.schemaVersion !== 1
        || envelope.sessionId !== frozenScope.sessionId
        || envelope.branchId !== frozenScope.branchId
      ) return;
      callback(payload as T);
    };
    wrappers.set(wrapperKey, scopedCallback);
    wrapperOwnership.set(scopedCallback, {
      originalCallback: callback as unknown as (...args: never[]) => unknown,
      wrapperKey,
    });
  }

  return ipcSubscriptions.subscribe(channel, scopedCallback, {
    sessionId: frozenScope.sessionId,
    branchId: frozenScope.branchId,
    gateId: 'structured_response_renderer',
  });
}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppBootstrap(): Promise<AppBootstrapSnapshot> {
    return ipcRenderer.invoke('app-bootstrap:get-v1');
  },
  getLaunchModeSettings(): Promise<LaunchModeSettings> {
    return ipcRenderer.invoke('launch-settings:get-mode-v1');
  },
  updateLaunchMode(
    request: LaunchModeUpdateRequestV1,
  ): Promise<LaunchModeSettings> {
    return ipcRenderer.invoke('launch-settings:update-mode-v1', request);
  },
  getProxyCredentialStatus(): Promise<ProxyCredentialStatusV1> {
    return ipcRenderer.invoke('proxy-credential:get-status-v1');
  },
  getEntitlementStatus(): Promise<EntitlementStatusV1> {
    return ipcRenderer.invoke('entitlements:get-status-v1');
  },
  getCloudProviderKeyMigrationStatus(): Promise<CloudProviderKeysMigrationConfigPayload> {
    return ipcRenderer.invoke('cloud-provider-keys:get-migration-status-v1');
  },
  listLegacyProviderKeys(): Promise<LegacyProviderKeyListV1> {
    return ipcRenderer.invoke('legacy-provider-keys:list-records-v1');
  },
  deleteLegacyProviderKey(
    request: LegacyProviderKeyDeleteRequestV1,
  ): Promise<LegacyProviderKeyDeleteResultV1> {
    return ipcRenderer.invoke('legacy-provider-keys:delete-record-v1', request);
  },
  getInspectorLayout(): Promise<InspectorLayoutState> {
    return ipcRenderer.invoke('inspector-layout:get-v1');
  },
  updateInspectorLayout(
    request: InspectorLayoutUpdateRequestV1,
  ): Promise<InspectorLayoutState> {
    return ipcRenderer.invoke('inspector-layout:update-v1', request);
  },
  getChatProjectionPage(
    query: ChatProjectionPageQueryV1,
  ): Promise<ChatProjectionPageResultV1> {
    return ipcRenderer.invoke('chat-projection:get-page-v1', query);
  },
  getChatProjectionComposition(
    query: ChatProjectionCompositionQueryV1,
  ): Promise<ChatProjectionCompositionResultV1> {
    return ipcRenderer.invoke('chat-projection:get-composition-v1', query);
  },
  getChatRenderStatus(
    scope: ChatProjectionScopeV1,
  ): Promise<ChatRenderStatusResultV1> {
    return ipcRenderer.invoke('chat-diagnostics:get-render-status-v1', scope);
  },
  submitChatCommand(
    command: CommandEnvelopeV1,
  ): Promise<CommandTransportReceiptV1> {
    return ipcRenderer.invoke('chat-command:submit-v1', command);
  },
  openExternalLink(
    request: ExternalLinkRequestV1,
  ): Promise<ExternalLinkResultV1> {
    return ipcRenderer.invoke(SHELL_OPEN_EXTERNAL_CHANNEL, request);
  },
  onChatProjectionDelta(
    scope: ChatProjectionScopeV1,
    callback: (delta: ScopedChatProjectionDeltaV1) => void,
  ): ChatProjectionUnsubscribe {
    return subscribeScopedProjection('chat-projection:delta-v1', scope, callback);
  },
  onChatProjectionInvalidated(
    scope: ChatProjectionScopeV1,
    callback: (event: ChatProjectionInvalidatedV1) => void,
  ): ChatProjectionUnsubscribe {
    return subscribeScopedProjection('chat-projection:invalidated-v1', scope, callback);
  },
  send(channel: string, ...args: unknown[]) {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke(channel: string, ...args: unknown[]) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    }
    // ─── IPC Privilege Tier Enforcement (Req 28.1, 28.4) ──────────────
    // Admin-tier channels are tagged so the main-process handler can verify
    // caller authorization. The tier metadata is injected into the request
    // payload as a non-enumerable property that the handler checks.
    const tier = getChannelTier(channel);
    if (tier === 'admin') {
      // For admin channels, wrap the first argument to include tier context
      // so the main-process handler can verify authorization (Req 28.2, 28.3).
      const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const enrichedPayload = { ...payload, __ipcTier: 'admin' };
      return ipcRenderer.invoke(channel, enrichedPayload, ...args.slice(1));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: string, callback: (...args: unknown[]) => void) {
    if (RECEIVE_CHANNELS.includes(channel)) {
      return ipcSubscriptions.subscribe(channel, callback);
    }
    return undefined;
  },
  onScoped(
    channel: string,
    scope: IpcSubscriptionScope,
    callback: (...args: unknown[]) => void,
  ) {
    if (RECEIVE_CHANNELS.includes(channel)) {
      return ipcSubscriptions.subscribe(channel, callback, scope);
    }
    return undefined;
  },
  removeListener(channel: string, callback: (...args: unknown[]) => void) {
    if (!RECEIVE_CHANNELS.includes(channel)) return 0;
    return ipcSubscriptions.remove(channel, callback);
  },
  switchSubscriptionSession(sessionId: string, branchId = 'main') {
    return ipcSubscriptions.switchSession(sessionId, branchId);
  },
  rollbackSubscriptionGate(gateId: string) {
    return ipcSubscriptions.rollbackGate(gateId);
  },
  cleanupSubscriptions(reason: IpcCleanupReason) {
    if (reason === 'session-switch') {
      throw new Error('Use switchSubscriptionSession for session cleanup');
    }
    return ipcSubscriptions.cleanup(reason);
  },
});

// ─── Window Lifecycle Cleanup ───────────────────────────────────
// Remove only wrappers owned by this preload bridge. Calling Electron's
// removeAllListeners here would also remove listeners installed by other owners.
const cleanupForRendererUnload = () => {
  ipcSubscriptions.cleanup('renderer-unload');
};
const cleanupForWindowDestruction = () => {
  ipcSubscriptions.cleanup('window-destroyed');
};
window.addEventListener('beforeunload', cleanupForRendererUnload);
window.addEventListener('unload', cleanupForWindowDestruction);

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

// ─── User Profile IPC Auto-Responder ─────────────────────────────
// When the main process needs the user profile from localStorage,
// it sends 'request-user-profile' instead of using executeJavaScript.
// This listener reads localStorage and sends the data back via IPC.
ipcSubscriptions.subscribe('request-user-profile', () => {
  try {
    const raw = localStorage.getItem('neuronest-user-profile') || '{}';
    const profile = JSON.parse(raw);
    ipcRenderer.send('user-profile-response', profile);
  } catch (_e) {
    ipcRenderer.send('user-profile-response', {});
  }
});
