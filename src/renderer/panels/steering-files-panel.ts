/**
 * SteeringFilesPanel — Renderer component for managing steering files.
 *
 * Displays a list of steering files with their inclusion mode and priority.
 * Provides create, edit, and delete functionality from the project settings panel.
 *
 * Uses IPC channels:
 * - `steering:list` — fetch all steering files
 * - `steering:create` — create a new steering file
 * - `steering:update` — update an existing steering file's content
 * - `steering:delete` — delete a steering file
 *
 * Requirements: 16.5
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

export interface SteeringFileEntry {
  id: string;
  name: string;
  path: string;
  inclusionMode: 'always' | 'file-match' | 'manual';
  filePatterns?: string[];
  content: string;
  priority: number;
}

interface SteeringFilesPanelState {
  files: SteeringFileEntry[];
  loading: boolean;
  error: string | null;
  editingFile: SteeringFileEntry | null;
  creating: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function inclusionModeLabel(mode: SteeringFileEntry['inclusionMode']): string {
  switch (mode) {
    case 'always':
      return 'Always';
    case 'file-match':
      return 'File Match';
    case 'manual':
      return 'Manual';
    default:
      return String(mode);
  }
}

function inclusionModeBadgeColor(mode: SteeringFileEntry['inclusionMode']): string {
  switch (mode) {
    case 'always':
      return 'background:rgba(34,197,94,0.15);color:#22c55e;';
    case 'file-match':
      return 'background:rgba(99,102,241,0.15);color:#6366f1;';
    case 'manual':
      return 'background:rgba(156,163,175,0.15);color:#9ca3af;';
    default:
      return 'background:var(--bg-input);color:var(--text-dim);';
  }
}

// ─── SteeringFilesPanel ─────────────────────────────────────────

export class SteeringFilesPanel {
  private container: HTMLElement;
  private state: SteeringFilesPanelState;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      files: [],
      loading: true,
      error: null,
      editingFile: null,
      creating: false,
    };
  }

  /**
   * Initialize the panel and load steering files.
   */
  async init(): Promise<void> {
    this.render();
    await this.loadFiles();
  }

  /**
   * Reload the file list from the backend.
   */
  async loadFiles(): Promise<void> {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const result = (await eapi().invoke('steering:list')) as {
        success: boolean;
        files?: SteeringFileEntry[];
        error?: string;
      };

      if (result.success && result.files) {
        this.state.files = result.files;
      } else {
        this.state.error = result.error || 'Failed to load steering files';
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to load steering files';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * Show the create form.
   */
  showCreateForm(): void {
    this.state.creating = true;
    this.state.editingFile = null;
    this.render();
  }

  /**
   * Show the edit form for a specific file.
   */
  showEditForm(file: SteeringFileEntry): void {
    this.state.editingFile = { ...file };
    this.state.creating = false;
    this.render();
  }

  /**
   * Cancel the current create or edit operation.
   */
  cancelForm(): void {
    this.state.creating = false;
    this.state.editingFile = null;
    this.render();
  }

  /**
   * Create a new steering file.
   */
  async createFile(name: string, content: string, mode: SteeringFileEntry['inclusionMode'], priority: number, filePatterns?: string[]): Promise<void> {
    try {
      const result = (await eapi().invoke('steering:create', {
        name,
        content,
        mode,
        priority,
        filePatterns,
      })) as { success: boolean; error?: string };

      if (!result.success) {
        this.state.error = result.error || 'Failed to create steering file';
        this.render();
        return;
      }

      this.state.creating = false;
      await this.loadFiles();
    } catch (err: any) {
      this.state.error = err.message || 'Failed to create steering file';
      this.render();
    }
  }

  /**
   * Update an existing steering file.
   */
  async updateFile(id: string, content: string): Promise<void> {
    try {
      const result = (await eapi().invoke('steering:update', { id, content })) as {
        success: boolean;
        error?: string;
      };

      if (!result.success) {
        this.state.error = result.error || 'Failed to update steering file';
        this.render();
        return;
      }

      this.state.editingFile = null;
      await this.loadFiles();
    } catch (err: any) {
      this.state.error = err.message || 'Failed to update steering file';
      this.render();
    }
  }

  /**
   * Delete a steering file.
   */
  async deleteFile(id: string): Promise<void> {
    try {
      const result = (await eapi().invoke('steering:delete', { id })) as {
        success: boolean;
        error?: string;
      };

      if (!result.success) {
        this.state.error = result.error || 'Failed to delete steering file';
        this.render();
        return;
      }

      await this.loadFiles();
    } catch (err: any) {
      this.state.error = err.message || 'Failed to delete steering file';
      this.render();
    }
  }

  /**
   * Get current state (for testing).
   */
  getState(): SteeringFilesPanelState {
    return { ...this.state };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.container.innerHTML = '';
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'border:1px solid var(--border-color);border-radius:8px;background:var(--bg-panel,var(--bg-input));padding:16px;margin:8px 0;';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Steering Files Management');

    // Header
    wrapper.appendChild(this.renderHeader());

    // Error message
    if (this.state.error) {
      wrapper.appendChild(this.renderError());
    }

    // Create or edit form
    if (this.state.creating) {
      wrapper.appendChild(this.renderCreateForm());
    } else if (this.state.editingFile) {
      wrapper.appendChild(this.renderEditForm(this.state.editingFile));
    } else {
      // File list or loading/empty state
      wrapper.appendChild(this.renderBody());
    }

    this.container.appendChild(wrapper);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';

    const titleSection = document.createElement('div');
    titleSection.style.cssText = 'display:flex;align-items:center;gap:8px;';
    titleSection.innerHTML =
      '<span style="font-size:16px;">📋</span>' +
      '<h3 style="margin:0;font-size:14px;color:var(--text-primary);">Steering Files</h3>' +
      '<span style="font-size:11px;color:var(--text-dim);">(' + this.state.files.length + ')</span>';
    header.appendChild(titleSection);

    if (!this.state.creating && !this.state.editingFile) {
      const createBtn = document.createElement('button');
      createBtn.textContent = '+ New';
      createBtn.className = 'steering-create-btn';
      createBtn.style.cssText =
        'padding:4px 12px;font-size:11px;font-weight:600;border-radius:4px;border:1px solid var(--accent);' +
        'background:transparent;color:var(--accent);cursor:pointer;transition:background 0.15s;';
      createBtn.setAttribute('aria-label', 'Create new steering file');
      createBtn.addEventListener('click', () => this.showCreateForm());
      header.appendChild(createBtn);
    }

    return header;
  }

  private renderError(): HTMLElement {
    const errorEl = document.createElement('div');
    errorEl.style.cssText =
      'padding:8px 12px;margin-bottom:12px;border-radius:6px;background:rgba(239,68,68,0.1);' +
      'color:#ef4444;font-size:12px;border:1px solid rgba(239,68,68,0.2);';
    errorEl.setAttribute('role', 'alert');
    errorEl.textContent = this.state.error || 'An error occurred';
    return errorEl;
  }

  private renderBody(): HTMLElement {
    const body = document.createElement('div');

    if (this.state.loading) {
      body.innerHTML =
        '<div style="text-align:center;padding:24px;color:var(--text-dim);font-size:12px;">' +
        'Loading steering files...</div>';
      return body;
    }

    if (this.state.files.length === 0) {
      body.innerHTML =
        '<div style="text-align:center;padding:24px;color:var(--text-dim);font-size:12px;">' +
        '<p style="margin:0 0 8px;">No steering files configured.</p>' +
        '<p style="margin:0;font-size:11px;">Steering files provide project-level instructions to the agent.</p>' +
        '</div>';
      return body;
    }

    // File list
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Steering files list');

    for (const file of this.state.files) {
      list.appendChild(this.renderFileRow(file));
    }

    body.appendChild(list);
    return body;
  }

  private renderFileRow(file: SteeringFileEntry): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;' +
      'border:1px solid var(--border-color);background:var(--bg-primary);transition:border-color 0.15s;';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `Steering file: ${file.name}`);

    // Name and details
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML =
      '<div style="font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
      escHtml(file.name) +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">Priority: ' +
      file.priority +
      (file.filePatterns && file.filePatterns.length > 0
        ? ' · Patterns: ' + escHtml(file.filePatterns.join(', '))
        : '') +
      '</div>';
    row.appendChild(info);

    // Inclusion mode badge
    const badge = document.createElement('span');
    badge.style.cssText =
      'padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap;' +
      inclusionModeBadgeColor(file.inclusionMode);
    badge.textContent = inclusionModeLabel(file.inclusionMode);
    row.appendChild(badge);

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.cssText =
      'padding:3px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border-color);' +
      'background:var(--bg-input);color:var(--text-primary);cursor:pointer;';
    editBtn.setAttribute('aria-label', `Edit ${file.name}`);
    editBtn.addEventListener('click', () => this.showEditForm(file));
    row.appendChild(editBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '✕';
    deleteBtn.style.cssText =
      'padding:3px 7px;font-size:11px;border-radius:4px;border:1px solid rgba(239,68,68,0.3);' +
      'background:transparent;color:#ef4444;cursor:pointer;';
    deleteBtn.setAttribute('aria-label', `Delete ${file.name}`);
    deleteBtn.addEventListener('click', () => this.deleteFile(file.id));
    row.appendChild(deleteBtn);

    return row;
  }

  private renderCreateForm(): HTMLElement {
    const form = document.createElement('div');
    form.style.cssText =
      'border:1px solid var(--accent);border-radius:6px;padding:12px;background:var(--bg-primary);';
    form.setAttribute('role', 'form');
    form.setAttribute('aria-label', 'Create steering file');

    form.innerHTML =
      '<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:10px;">New Steering File</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<input id="steering-create-name" type="text" placeholder="File name" ' +
      'style="padding:6px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;" />' +
      '<select id="steering-create-mode" ' +
      'style="padding:6px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;">' +
      '<option value="always">Always</option>' +
      '<option value="file-match">File Match</option>' +
      '<option value="manual">Manual</option>' +
      '</select>' +
      '<input id="steering-create-patterns" type="text" placeholder="Glob patterns (comma-separated, for file-match mode)" ' +
      'style="padding:6px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;" />' +
      '<input id="steering-create-priority" type="number" placeholder="Priority (0 = default)" value="0" ' +
      'style="padding:6px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;" />' +
      '<textarea id="steering-create-content" rows="6" placeholder="Steering file content (Markdown)" ' +
      'style="padding:8px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;font-family:monospace;resize:vertical;"></textarea>' +
      '</div>';

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText =
      'padding:5px 12px;font-size:11px;border-radius:4px;border:1px solid var(--border-color);' +
      'background:var(--bg-input);color:var(--text-primary);cursor:pointer;';
    cancelBtn.addEventListener('click', () => this.cancelForm());

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Create';
    saveBtn.className = 'steering-save-btn';
    saveBtn.style.cssText =
      'padding:5px 12px;font-size:11px;font-weight:600;border-radius:4px;border:none;' +
      'background:var(--accent);color:#fff;cursor:pointer;';
    saveBtn.addEventListener('click', () => {
      const name = (form.querySelector('#steering-create-name') as HTMLInputElement)?.value.trim();
      const mode = (form.querySelector('#steering-create-mode') as HTMLSelectElement)?.value as SteeringFileEntry['inclusionMode'];
      const patternsRaw = (form.querySelector('#steering-create-patterns') as HTMLInputElement)?.value.trim();
      const priority = parseInt((form.querySelector('#steering-create-priority') as HTMLInputElement)?.value || '0', 10);
      const content = (form.querySelector('#steering-create-content') as HTMLTextAreaElement)?.value || '';

      if (!name) {
        this.state.error = 'Name is required';
        this.render();
        return;
      }

      const filePatterns = patternsRaw ? patternsRaw.split(',').map((p) => p.trim()).filter(Boolean) : undefined;
      this.createFile(name, content, mode, priority, filePatterns);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    return form;
  }

  private renderEditForm(file: SteeringFileEntry): HTMLElement {
    const form = document.createElement('div');
    form.style.cssText =
      'border:1px solid var(--accent);border-radius:6px;padding:12px;background:var(--bg-primary);';
    form.setAttribute('role', 'form');
    form.setAttribute('aria-label', `Edit steering file: ${file.name}`);

    form.innerHTML =
      '<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">Editing: ' +
      escHtml(file.name) + '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-bottom:10px;">Mode: ' +
      inclusionModeLabel(file.inclusionMode) + ' · Priority: ' + file.priority + '</div>' +
      '<textarea id="steering-edit-content" rows="8" ' +
      'style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:12px;font-family:monospace;resize:vertical;">' +
      escHtml(file.content) +
      '</textarea>';

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText =
      'padding:5px 12px;font-size:11px;border-radius:4px;border:1px solid var(--border-color);' +
      'background:var(--bg-input);color:var(--text-primary);cursor:pointer;';
    cancelBtn.addEventListener('click', () => this.cancelForm());

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'steering-save-btn';
    saveBtn.style.cssText =
      'padding:5px 12px;font-size:11px;font-weight:600;border-radius:4px;border:none;' +
      'background:var(--accent);color:#fff;cursor:pointer;';
    saveBtn.addEventListener('click', () => {
      const content = (form.querySelector('#steering-edit-content') as HTMLTextAreaElement)?.value || '';
      this.updateFile(file.id, content);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    return form;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create and initialize a SteeringFilesPanel in the given container.
 */
export function createSteeringFilesPanel(container: HTMLElement): SteeringFilesPanel {
  const panel = new SteeringFilesPanel(container);
  panel.init();
  return panel;
}
