/**
 * HooksManagementPanel — Renderer component for hook definitions and execution status.
 *
 * Provides:
 * - CRUD interface for hook definitions (create, read, update, delete)
 * - Non-intrusive notification area displaying hook execution status
 * - On-demand viewing of hook output/history
 *
 * Listens on `hooks:execution-status` IPC channel for real-time execution updates.
 * Uses `hooks:list`, `hooks:create`, `hooks:update`, `hooks:delete`, `hooks:get-history`
 * invoke channels for CRUD operations.
 *
 * Requirements: 17.5
 */

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export type HookTrigger =
  | 'fileEdited'
  | 'fileCreated'
  | 'fileDeleted'
  | 'userTriggered'
  | 'promptSubmit';

export type HookActionType = 'askAgent' | 'runCommand';

export interface HookDefinition {
  id: string;
  name: string;
  trigger: HookTrigger;
  action: { type: HookActionType; prompt?: string; command?: string; timeout?: number };
  enabled: boolean;
  filePatterns?: string[];
}

export interface HookExecution {
  id: string;
  hookId: string;
  triggerEvent: string;
  status: 'running' | 'success' | 'failure';
  output: string | null;
  error: string | null;
  durationMs: number | null;
  triggeredAt: string;
}

export interface HookExecutionStatusEvent {
  hookId: string;
  hookName: string;
  status: 'running' | 'success' | 'failure';
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface HooksManagementState {
  hooks: HookDefinition[];
  notifications: HookExecutionStatusEvent[];
  selectedHookId: string | null;
  history: HookExecution[];
  editingHook: Partial<HookDefinition> | null;
  showCreateForm: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_NOTIFICATIONS = 10;
const NOTIFICATION_DISPLAY_DURATION_MS = 8000;

const TRIGGER_LABELS: Record<HookTrigger, string> = {
  fileEdited: 'File Edited',
  fileCreated: 'File Created',
  fileDeleted: 'File Deleted',
  userTriggered: 'Manual Trigger',
  promptSubmit: 'Prompt Submit',
};

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function statusIcon(status: 'running' | 'success' | 'failure'): string {
  switch (status) {
    case 'running':
      return '⏳';
    case 'success':
      return '✓';
    case 'failure':
      return '✗';
  }
}

function statusClass(status: 'running' | 'success' | 'failure'): string {
  switch (status) {
    case 'running':
      return 'hook-status-running';
    case 'success':
      return 'hook-status-success';
    case 'failure':
      return 'hook-status-failure';
  }
}

// ─── HooksManagementPanel ───────────────────────────────────────

export class HooksManagementPanel {
  private container: HTMLElement;
  private state: HooksManagementState;
  private executionStatusListener: ((...args: unknown[]) => void) | null = null;
  private notificationTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private nextNotificationId = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      hooks: [],
      notifications: [],
      selectedHookId: null,
      history: [],
      editingHook: null,
      showCreateForm: false,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Initialize the panel: load hooks and subscribe to execution status events.
   */
  async init(): Promise<void> {
    this.setupIPCListener();
    await this.loadHooks();
    this.render();
  }

  /**
   * Get current state (useful for testing).
   */
  getState(): HooksManagementState {
    return { ...this.state };
  }

  /**
   * Get current notifications (useful for testing).
   */
  getNotifications(): HookExecutionStatusEvent[] {
    return [...this.state.notifications];
  }

  /**
   * Clean up event listeners and timers.
   */
  destroy(): void {
    if (this.executionStatusListener) {
      eapi().removeListener('hooks:execution-status', this.executionStatusListener);
      this.executionStatusListener = null;
    }
    for (const timer of this.notificationTimers.values()) {
      clearTimeout(timer);
    }
    this.notificationTimers.clear();
    this.container.innerHTML = '';
  }

  // ─── Data Operations ────────────────────────────────────────────

  /**
   * Load all hooks from the backend.
   */
  async loadHooks(): Promise<void> {
    try {
      const result = (await eapi().invoke('hooks:list')) as {
        success: boolean;
        hooks?: HookDefinition[];
      };
      if (result && result.success && result.hooks) {
        this.state.hooks = result.hooks;
      }
    } catch {
      // Fallback: try the older hooks:get channel
      try {
        const result = (await eapi().invoke('hooks:get', {})) as {
          success: boolean;
          hooks?: HookDefinition[];
        };
        if (result && result.success && result.hooks) {
          this.state.hooks = result.hooks;
        }
      } catch {
        // Hooks not available
      }
    }
  }

  /**
   * Create a new hook definition.
   */
  async createHook(definition: Omit<HookDefinition, 'id'>): Promise<HookDefinition | null> {
    try {
      const result = (await eapi().invoke('hooks:create', definition)) as {
        success: boolean;
        hook?: HookDefinition;
      };
      if (result && result.success && result.hook) {
        this.state.hooks.push(result.hook);
        this.state.showCreateForm = false;
        this.render();
        return result.hook;
      }
    } catch {
      // Creation failed
    }
    return null;
  }

  /**
   * Update an existing hook definition.
   */
  async updateHook(hookId: string, updates: Partial<HookDefinition>): Promise<boolean> {
    try {
      const result = (await eapi().invoke('hooks:update', { hookId, updates })) as {
        success: boolean;
      };
      if (result && result.success) {
        const idx = this.state.hooks.findIndex((h) => h.id === hookId);
        if (idx !== -1) {
          this.state.hooks[idx] = { ...this.state.hooks[idx], ...updates };
        }
        this.state.editingHook = null;
        this.render();
        return true;
      }
    } catch {
      // Update failed
    }
    return false;
  }

  /**
   * Delete a hook definition.
   */
  async deleteHook(hookId: string): Promise<boolean> {
    try {
      const result = (await eapi().invoke('hooks:delete', { hookId })) as {
        success: boolean;
      };
      if (result && result.success) {
        this.state.hooks = this.state.hooks.filter((h) => h.id !== hookId);
        if (this.state.selectedHookId === hookId) {
          this.state.selectedHookId = null;
          this.state.history = [];
        }
        this.render();
        return true;
      }
    } catch {
      // Deletion failed
    }
    return false;
  }

  /**
   * Load execution history for a specific hook.
   */
  async loadHistory(hookId: string): Promise<void> {
    this.state.selectedHookId = hookId;
    try {
      const result = (await eapi().invoke('hooks:get-history', { hookId })) as {
        success: boolean;
        history?: HookExecution[];
      };
      if (result && result.success && result.history) {
        this.state.history = result.history;
      } else {
        this.state.history = [];
      }
    } catch {
      this.state.history = [];
    }
    this.render();
  }

  // ─── Notification Handling ──────────────────────────────────────

  /**
   * Handle an incoming execution status event.
   * Adds to notification area with auto-dismiss.
   */
  handleExecutionStatus(event: HookExecutionStatusEvent): void {
    // Add to front of notifications (most recent first)
    this.state.notifications.unshift(event);

    // Cap notifications
    if (this.state.notifications.length > MAX_NOTIFICATIONS) {
      this.state.notifications = this.state.notifications.slice(0, MAX_NOTIFICATIONS);
    }

    // Auto-dismiss non-running notifications after timeout
    if (event.status !== 'running') {
      const id = this.nextNotificationId++;
      const timer = setTimeout(() => {
        this.dismissNotification(event);
        this.notificationTimers.delete(id);
      }, NOTIFICATION_DISPLAY_DURATION_MS);
      this.notificationTimers.set(id, timer);
    }

    this.renderNotifications();
  }

  /**
   * Dismiss a specific notification.
   */
  dismissNotification(event: HookExecutionStatusEvent): void {
    const idx = this.state.notifications.indexOf(event);
    if (idx !== -1) {
      this.state.notifications.splice(idx, 1);
      this.renderNotifications();
    }
  }

  // ─── IPC ────────────────────────────────────────────────────────

  private setupIPCListener(): void {
    this.executionStatusListener = (...args: unknown[]) => {
      const event = args[0] as HookExecutionStatusEvent;
      if (event && event.hookId && event.status) {
        this.handleExecutionStatus(event);
      }
    };
    eapi().on('hooks:execution-status', this.executionStatusListener);
  }

  // ─── Rendering ──────────────────────────────────────────────────

  /**
   * Full panel render.
   */
  render(): void {
    this.container.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'hooks-management-panel';

    // Header
    panel.appendChild(this.renderHeader());

    // Notification area (non-intrusive)
    panel.appendChild(this.renderNotificationArea());

    // Hook list
    panel.appendChild(this.renderHookList());

    // Create form (if open)
    if (this.state.showCreateForm) {
      panel.appendChild(this.renderCreateForm());
    }

    // History view (if a hook is selected)
    if (this.state.selectedHookId) {
      panel.appendChild(this.renderHistoryView());
    }

    this.container.appendChild(panel);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'hooks-panel-header';
    header.innerHTML = `
      <h3>Agent Hooks</h3>
      <button class="hooks-create-btn" title="Create new hook">+ New Hook</button>
    `;

    const btn = header.querySelector('.hooks-create-btn') as HTMLElement;
    if (btn) {
      btn.addEventListener('click', () => {
        this.state.showCreateForm = !this.state.showCreateForm;
        this.render();
      });
    }

    return header;
  }

  private renderNotificationArea(): HTMLElement {
    const area = document.createElement('div');
    area.className = 'hooks-notification-area';
    area.setAttribute('role', 'status');
    area.setAttribute('aria-live', 'polite');
    area.setAttribute('aria-label', 'Hook execution notifications');

    if (this.state.notifications.length === 0) {
      return area;
    }

    for (const notification of this.state.notifications) {
      const item = document.createElement('div');
      item.className = `hooks-notification-item ${statusClass(notification.status)}`;
      item.innerHTML = `
        <span class="hooks-notification-icon">${statusIcon(notification.status)}</span>
        <span class="hooks-notification-name">${escHtml(notification.hookName)}</span>
        <span class="hooks-notification-status">${notification.status}</span>
        ${notification.durationMs != null ? `<span class="hooks-notification-duration">${formatDuration(notification.durationMs)}</span>` : ''}
        <button class="hooks-notification-expand" title="View output">▶</button>
        <button class="hooks-notification-dismiss" title="Dismiss">×</button>
      `;

      // Expand to show output
      const expandBtn = item.querySelector('.hooks-notification-expand') as HTMLElement;
      if (expandBtn) {
        expandBtn.addEventListener('click', () => {
          const outputEl = item.querySelector('.hooks-notification-output') as HTMLElement;
          if (outputEl) {
            outputEl.style.display = outputEl.style.display === 'none' ? '' : 'none';
          } else {
            const output = document.createElement('pre');
            output.className = 'hooks-notification-output';
            output.textContent = notification.error || notification.output || '(no output)';
            item.appendChild(output);
          }
        });
      }

      // Dismiss
      const dismissBtn = item.querySelector('.hooks-notification-dismiss') as HTMLElement;
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          this.dismissNotification(notification);
        });
      }

      area.appendChild(item);
    }

    return area;
  }

  /**
   * Re-render only the notification area (for efficiency during status updates).
   */
  private renderNotifications(): void {
    const existing = this.container.querySelector('.hooks-notification-area');
    if (existing) {
      const newArea = this.renderNotificationArea();
      existing.replaceWith(newArea);
    } else {
      // Full re-render if structure not found
      this.render();
    }
  }

  private renderHookList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'hooks-list';

    if (this.state.hooks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hooks-empty-state';
      empty.textContent = 'No hooks defined. Create one to automate agent actions on IDE events.';
      list.appendChild(empty);
      return list;
    }

    for (const hook of this.state.hooks) {
      const item = document.createElement('div');
      item.className = `hooks-list-item ${hook.enabled ? '' : 'hooks-disabled'}`;
      item.setAttribute('data-hook-id', hook.id);

      const actionLabel =
        hook.action.type === 'askAgent'
          ? `Ask: ${escHtml((hook.action.prompt || '').slice(0, 50))}`
          : `Run: ${escHtml((hook.action.command || '').slice(0, 50))}`;

      const patternsLabel = hook.filePatterns?.length
        ? `[${hook.filePatterns.join(', ')}]`
        : '';

      item.innerHTML = `
        <div class="hooks-item-main">
          <span class="hooks-item-name">${escHtml(hook.name)}</span>
          <span class="hooks-item-trigger">${TRIGGER_LABELS[hook.trigger] || hook.trigger}</span>
          ${patternsLabel ? `<span class="hooks-item-patterns">${escHtml(patternsLabel)}</span>` : ''}
        </div>
        <div class="hooks-item-action">${actionLabel}</div>
        <div class="hooks-item-controls">
          <button class="hooks-toggle-btn" title="${hook.enabled ? 'Disable' : 'Enable'}">${hook.enabled ? '●' : '○'}</button>
          <button class="hooks-history-btn" title="View history">📋</button>
          <button class="hooks-delete-btn" title="Delete hook">🗑</button>
        </div>
      `;

      // Toggle enabled
      const toggleBtn = item.querySelector('.hooks-toggle-btn') as HTMLElement;
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          this.updateHook(hook.id, { enabled: !hook.enabled });
        });
      }

      // View history
      const historyBtn = item.querySelector('.hooks-history-btn') as HTMLElement;
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          this.loadHistory(hook.id);
        });
      }

      // Delete
      const deleteBtn = item.querySelector('.hooks-delete-btn') as HTMLElement;
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          this.deleteHook(hook.id);
        });
      }

      list.appendChild(item);
    }

    return list;
  }

  private renderCreateForm(): HTMLElement {
    const form = document.createElement('div');
    form.className = 'hooks-create-form';
    form.innerHTML = `
      <h4>Create New Hook</h4>
      <label>
        Name:
        <input type="text" class="hooks-form-name" placeholder="e.g. Run tests on save" />
      </label>
      <label>
        Trigger:
        <select class="hooks-form-trigger">
          <option value="fileEdited">File Edited</option>
          <option value="fileCreated">File Created</option>
          <option value="fileDeleted">File Deleted</option>
          <option value="userTriggered">Manual Trigger</option>
          <option value="promptSubmit">Prompt Submit</option>
        </select>
      </label>
      <label>
        File Patterns (comma-separated, optional):
        <input type="text" class="hooks-form-patterns" placeholder="e.g. *.ts, src/**/*.tsx" />
      </label>
      <label>
        Action Type:
        <select class="hooks-form-action-type">
          <option value="runCommand">Run Command</option>
          <option value="askAgent">Ask Agent</option>
        </select>
      </label>
      <label class="hooks-form-command-label">
        Command:
        <input type="text" class="hooks-form-command" placeholder="e.g. npm run test" />
      </label>
      <label class="hooks-form-prompt-label" style="display:none">
        Prompt:
        <textarea class="hooks-form-prompt" placeholder="e.g. Review this file for issues"></textarea>
      </label>
      <div class="hooks-form-actions">
        <button class="hooks-form-submit">Create</button>
        <button class="hooks-form-cancel">Cancel</button>
      </div>
    `;

    // Toggle command/prompt visibility based on action type
    const actionSelect = form.querySelector('.hooks-form-action-type') as HTMLSelectElement;
    const commandLabel = form.querySelector('.hooks-form-command-label') as HTMLElement;
    const promptLabel = form.querySelector('.hooks-form-prompt-label') as HTMLElement;
    if (actionSelect) {
      actionSelect.addEventListener('change', () => {
        if (actionSelect.value === 'runCommand') {
          commandLabel.style.display = '';
          promptLabel.style.display = 'none';
        } else {
          commandLabel.style.display = 'none';
          promptLabel.style.display = '';
        }
      });
    }

    // Submit
    const submitBtn = form.querySelector('.hooks-form-submit') as HTMLElement;
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const name = (form.querySelector('.hooks-form-name') as HTMLInputElement)?.value.trim();
        const trigger = (form.querySelector('.hooks-form-trigger') as HTMLSelectElement)
          ?.value as HookTrigger;
        const patterns = (form.querySelector('.hooks-form-patterns') as HTMLInputElement)?.value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        const actionType = (form.querySelector('.hooks-form-action-type') as HTMLSelectElement)
          ?.value as HookActionType;
        const command = (form.querySelector('.hooks-form-command') as HTMLInputElement)?.value.trim();
        const prompt = (form.querySelector('.hooks-form-prompt') as HTMLTextAreaElement)?.value.trim();

        if (!name) return;

        const definition: Omit<HookDefinition, 'id'> = {
          name,
          trigger,
          action:
            actionType === 'runCommand'
              ? { type: 'runCommand', command }
              : { type: 'askAgent', prompt },
          enabled: true,
          filePatterns: patterns.length > 0 ? patterns : undefined,
        };

        this.createHook(definition);
      });
    }

    // Cancel
    const cancelBtn = form.querySelector('.hooks-form-cancel') as HTMLElement;
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.state.showCreateForm = false;
        this.render();
      });
    }

    return form;
  }

  private renderHistoryView(): HTMLElement {
    const view = document.createElement('div');
    view.className = 'hooks-history-view';

    const hook = this.state.hooks.find((h) => h.id === this.state.selectedHookId);
    const title = hook ? hook.name : 'Hook';

    view.innerHTML = `
      <div class="hooks-history-header">
        <h4>Execution History: ${escHtml(title)}</h4>
        <button class="hooks-history-close" title="Close">×</button>
      </div>
    `;

    const closeBtn = view.querySelector('.hooks-history-close') as HTMLElement;
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.state.selectedHookId = null;
        this.state.history = [];
        this.render();
      });
    }

    if (this.state.history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hooks-history-empty';
      empty.textContent = 'No execution history available.';
      view.appendChild(empty);
      return view;
    }

    const list = document.createElement('div');
    list.className = 'hooks-history-list';

    for (const exec of this.state.history) {
      const row = document.createElement('div');
      row.className = `hooks-history-item ${statusClass(exec.status)}`;
      row.innerHTML = `
        <span class="hooks-history-icon">${statusIcon(exec.status)}</span>
        <span class="hooks-history-trigger">${escHtml(exec.triggerEvent)}</span>
        <span class="hooks-history-duration">${formatDuration(exec.durationMs)}</span>
        <span class="hooks-history-time">${escHtml(exec.triggeredAt)}</span>
        <button class="hooks-history-output-btn" title="View output">▶</button>
      `;

      const outputBtn = row.querySelector('.hooks-history-output-btn') as HTMLElement;
      if (outputBtn) {
        outputBtn.addEventListener('click', () => {
          const existing = row.querySelector('.hooks-history-output') as HTMLElement;
          if (existing) {
            existing.style.display = existing.style.display === 'none' ? '' : 'none';
          } else {
            const output = document.createElement('pre');
            output.className = 'hooks-history-output';
            output.textContent = exec.error || exec.output || '(no output)';
            row.appendChild(output);
          }
        });
      }

      list.appendChild(row);
    }

    view.appendChild(list);
    return view;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create and initialize a HooksManagementPanel.
 */
export function createHooksManagementPanel(container: HTMLElement): HooksManagementPanel {
  const panel = new HooksManagementPanel(container);
  panel.init();
  return panel;
}
