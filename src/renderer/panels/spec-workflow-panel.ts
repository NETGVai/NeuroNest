/**
 * SpecWorkflowPanel — Renderer component for spec-driven development workflow progress.
 *
 * Displays:
 * - Spec progress with task completion status (progress bar + per-task indicators)
 * - Allows user to review, modify, or skip individual tasks
 * - Shows workflow phase (requirements → design → tasks → executing → completed)
 *
 * Uses IPC channels:
 * - `spec-workflow:get` — fetch workflow state by ID
 * - `spec-workflow:list-active` — list all active workflows
 * - `spec-workflow:start-task` — start a pending task
 * - `spec-workflow:skip-task` — skip a task
 * - `spec-workflow:get-progress` — get completion percentage
 *
 * Requirements: 18.5
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

export type SpecWorkflowStatus = 'requirements' | 'design' | 'tasks' | 'executing' | 'completed';

export type SpecTaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export interface SpecTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  requirementRefs: string[];
  acceptanceCriteria: string[];
  status: SpecTaskStatus;
  verificationResult?: {
    passed: boolean;
    criteriaResults: Array<{
      criterion: string;
      passed: boolean;
      detail?: string;
    }>;
    verifiedAt: number;
  };
}

export interface SpecWorkflow {
  id: string;
  title: string;
  originalRequest: string;
  status: SpecWorkflowStatus;
  requirements: string | null;
  design: string | null;
  tasks: SpecTask[];
  createdAt: number;
  updatedAt: number;
}

export interface SpecWorkflowPanelState {
  workflows: SpecWorkflow[];
  selectedWorkflowId: string | null;
  selectedWorkflow: SpecWorkflow | null;
  progress: number;
  loading: boolean;
  error: string | null;
  expandedTaskId: string | null;
}

// ─── Constants ──────────────────────────────────────────────────

const PHASE_LABELS: Record<SpecWorkflowStatus, string> = {
  requirements: 'Requirements',
  design: 'Design',
  tasks: 'Task Planning',
  executing: 'Executing',
  completed: 'Completed',
};

const PHASE_ICONS: Record<SpecWorkflowStatus, string> = {
  requirements: '📋',
  design: '🏗️',
  tasks: '📝',
  executing: '⚙️',
  completed: '✅',
};

const TASK_STATUS_ICONS: Record<SpecTaskStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  skipped: '⊘',
  failed: '✗',
};

const TASK_STATUS_LABELS: Record<SpecTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  skipped: 'Skipped',
  failed: 'Failed',
};

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function taskStatusClass(status: SpecTaskStatus): string {
  switch (status) {
    case 'pending':
      return 'spec-task-pending';
    case 'in_progress':
      return 'spec-task-in-progress';
    case 'completed':
      return 'spec-task-completed';
    case 'skipped':
      return 'spec-task-skipped';
    case 'failed':
      return 'spec-task-failed';
  }
}

// ─── SpecWorkflowPanel ──────────────────────────────────────────

export class SpecWorkflowPanel {
  private container: HTMLElement;
  private state: SpecWorkflowPanelState;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      workflows: [],
      selectedWorkflowId: null,
      selectedWorkflow: null,
      progress: 0,
      loading: true,
      error: null,
      expandedTaskId: null,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Initialize the panel: load active workflows.
   */
  async init(): Promise<void> {
    this.render();
    await this.loadWorkflows();
  }

  /**
   * Get current state (useful for testing).
   */
  getState(): SpecWorkflowPanelState {
    return { ...this.state };
  }

  /**
   * Load all active workflows from the backend.
   */
  async loadWorkflows(): Promise<void> {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const result = (await eapi().invoke('spec-workflow:list-active')) as {
        success: boolean;
        workflows?: SpecWorkflow[];
        error?: string;
      };

      if (result.success && result.workflows) {
        this.state.workflows = result.workflows;
        // Auto-select first workflow if none selected
        if (!this.state.selectedWorkflowId && result.workflows.length > 0) {
          await this.selectWorkflow(result.workflows[0].id);
          return; // selectWorkflow calls render
        }
      } else {
        this.state.error = result.error || 'Failed to load workflows';
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to load workflows';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * Select and load a specific workflow.
   */
  async selectWorkflow(workflowId: string): Promise<void> {
    this.state.selectedWorkflowId = workflowId;
    this.state.expandedTaskId = null;

    try {
      const result = (await eapi().invoke('spec-workflow:get', { workflowId })) as {
        success: boolean;
        workflow?: SpecWorkflow;
        error?: string;
      };

      if (result.success && result.workflow) {
        this.state.selectedWorkflow = result.workflow;
      } else {
        this.state.error = result.error || 'Failed to load workflow';
        this.state.selectedWorkflow = null;
      }

      // Get progress
      const progressResult = (await eapi().invoke('spec-workflow:get-progress', { workflowId })) as {
        success: boolean;
        progress?: number;
      };

      if (progressResult.success && progressResult.progress != null) {
        this.state.progress = progressResult.progress;
      } else {
        this.state.progress = 0;
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to load workflow details';
      this.state.selectedWorkflow = null;
      this.state.progress = 0;
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * Start a pending task.
   */
  async startTask(taskId: string): Promise<boolean> {
    if (!this.state.selectedWorkflowId) return false;

    try {
      const result = (await eapi().invoke('spec-workflow:start-task', {
        workflowId: this.state.selectedWorkflowId,
        taskId,
      })) as { success: boolean; task?: SpecTask; error?: string };

      if (result.success && result.task) {
        this.updateTaskInState(taskId, result.task);
        this.render();
        return true;
      } else {
        this.state.error = result.error || 'Failed to start task';
        this.render();
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to start task';
      this.render();
    }
    return false;
  }

  /**
   * Skip a task.
   */
  async skipTask(taskId: string): Promise<boolean> {
    if (!this.state.selectedWorkflowId) return false;

    try {
      const result = (await eapi().invoke('spec-workflow:skip-task', {
        workflowId: this.state.selectedWorkflowId,
        taskId,
      })) as { success: boolean; task?: SpecTask; error?: string };

      if (result.success && result.task) {
        this.updateTaskInState(taskId, result.task);
        // Recalculate progress
        await this.refreshProgress();
        this.render();
        return true;
      } else {
        this.state.error = result.error || 'Failed to skip task';
        this.render();
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to skip task';
      this.render();
    }
    return false;
  }

  /**
   * Expand/collapse a task to show details.
   */
  toggleTaskExpansion(taskId: string): void {
    if (this.state.expandedTaskId === taskId) {
      this.state.expandedTaskId = null;
    } else {
      this.state.expandedTaskId = taskId;
    }
    this.render();
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.container.innerHTML = '';
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private updateTaskInState(taskId: string, updatedTask: SpecTask): void {
    if (!this.state.selectedWorkflow) return;
    const idx = this.state.selectedWorkflow.tasks.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      this.state.selectedWorkflow.tasks[idx] = updatedTask;
    }
  }

  private async refreshProgress(): Promise<void> {
    if (!this.state.selectedWorkflowId) return;
    try {
      const result = (await eapi().invoke('spec-workflow:get-progress', {
        workflowId: this.state.selectedWorkflowId,
      })) as { success: boolean; progress?: number };

      if (result.success && result.progress != null) {
        this.state.progress = result.progress;
      }
    } catch {
      // Progress refresh is non-critical
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'spec-workflow-panel';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Spec Workflow Progress');

    // Header
    wrapper.appendChild(this.renderHeader());

    // Error message
    if (this.state.error) {
      wrapper.appendChild(this.renderError());
    }

    // Body
    wrapper.appendChild(this.renderBody());

    this.container.appendChild(wrapper);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'spec-workflow-header';

    const titleSection = document.createElement('div');
    titleSection.className = 'spec-workflow-title-section';
    titleSection.innerHTML =
      '<span class="spec-workflow-icon">📐</span>' +
      '<h3 class="spec-workflow-title">Spec Workflow</h3>';
    header.appendChild(titleSection);

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'spec-workflow-refresh-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.setAttribute('title', 'Refresh');
    refreshBtn.setAttribute('aria-label', 'Refresh workflow status');
    refreshBtn.addEventListener('click', () => {
      if (this.state.selectedWorkflowId) {
        this.selectWorkflow(this.state.selectedWorkflowId);
      } else {
        this.loadWorkflows();
      }
    });
    header.appendChild(refreshBtn);

    return header;
  }

  private renderError(): HTMLElement {
    const errorEl = document.createElement('div');
    errorEl.className = 'spec-workflow-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.textContent = this.state.error || 'An error occurred';
    return errorEl;
  }

  private renderBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'spec-workflow-body';

    if (this.state.loading) {
      body.innerHTML =
        '<div class="spec-workflow-loading">Loading workflow data...</div>';
      return body;
    }

    if (this.state.workflows.length === 0 && !this.state.selectedWorkflow) {
      body.innerHTML =
        '<div class="spec-workflow-empty">' +
        '<p>No active spec workflows.</p>' +
        '<p class="spec-workflow-empty-hint">Start a spec workflow by requesting a complex feature.</p>' +
        '</div>';
      return body;
    }

    // Workflow selector (if multiple workflows)
    if (this.state.workflows.length > 1) {
      body.appendChild(this.renderWorkflowSelector());
    }

    // Selected workflow details
    if (this.state.selectedWorkflow) {
      body.appendChild(this.renderWorkflowDetails(this.state.selectedWorkflow));
    }

    return body;
  }

  private renderWorkflowSelector(): HTMLElement {
    const selector = document.createElement('div');
    selector.className = 'spec-workflow-selector';

    const select = document.createElement('select');
    select.className = 'spec-workflow-select';
    select.setAttribute('aria-label', 'Select workflow');

    for (const wf of this.state.workflows) {
      const option = document.createElement('option');
      option.value = wf.id;
      option.textContent = wf.title;
      if (wf.id === this.state.selectedWorkflowId) {
        option.selected = true;
      }
      select.appendChild(option);
    }

    select.addEventListener('change', () => {
      this.selectWorkflow(select.value);
    });

    selector.appendChild(select);
    return selector;
  }

  private renderWorkflowDetails(workflow: SpecWorkflow): HTMLElement {
    const details = document.createElement('div');
    details.className = 'spec-workflow-details';

    // Workflow phase indicator
    details.appendChild(this.renderPhaseIndicator(workflow.status));

    // Progress bar
    details.appendChild(this.renderProgressBar());

    // Task list
    if (workflow.tasks.length > 0) {
      details.appendChild(this.renderTaskList(workflow.tasks));
    } else if (workflow.status === 'executing') {
      const noTasks = document.createElement('div');
      noTasks.className = 'spec-workflow-no-tasks';
      noTasks.textContent = 'No tasks defined yet.';
      details.appendChild(noTasks);
    }

    return details;
  }

  private renderPhaseIndicator(status: SpecWorkflowStatus): HTMLElement {
    const phases: SpecWorkflowStatus[] = ['requirements', 'design', 'tasks', 'executing', 'completed'];
    const currentIdx = phases.indexOf(status);

    const indicator = document.createElement('div');
    indicator.className = 'spec-workflow-phase-indicator';
    indicator.setAttribute('role', 'progressbar');
    indicator.setAttribute('aria-valuenow', String(currentIdx));
    indicator.setAttribute('aria-valuemin', '0');
    indicator.setAttribute('aria-valuemax', String(phases.length - 1));
    indicator.setAttribute('aria-label', `Workflow phase: ${PHASE_LABELS[status]}`);

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const step = document.createElement('div');

      let stepClass = 'spec-phase-step';
      if (i < currentIdx) stepClass += ' spec-phase-done';
      else if (i === currentIdx) stepClass += ' spec-phase-active';
      else stepClass += ' spec-phase-future';

      step.className = stepClass;
      step.innerHTML =
        `<span class="spec-phase-icon">${PHASE_ICONS[phase]}</span>` +
        `<span class="spec-phase-label">${PHASE_LABELS[phase]}</span>`;
      indicator.appendChild(step);

      // Connector between steps (except after last)
      if (i < phases.length - 1) {
        const connector = document.createElement('div');
        connector.className = 'spec-phase-connector' + (i < currentIdx ? ' spec-phase-connector-done' : '');
        indicator.appendChild(connector);
      }
    }

    return indicator;
  }

  private renderProgressBar(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'spec-workflow-progress';

    const label = document.createElement('div');
    label.className = 'spec-workflow-progress-label';

    const workflow = this.state.selectedWorkflow;
    const totalTasks = workflow?.tasks.length || 0;
    const completedTasks = workflow?.tasks.filter(
      (t) => t.status === 'completed' || t.status === 'skipped',
    ).length || 0;

    label.textContent = `${completedTasks} of ${totalTasks} tasks complete (${this.state.progress}%)`;

    const barOuter = document.createElement('div');
    barOuter.className = 'spec-workflow-progress-bar';
    barOuter.setAttribute('role', 'progressbar');
    barOuter.setAttribute('aria-valuenow', String(this.state.progress));
    barOuter.setAttribute('aria-valuemin', '0');
    barOuter.setAttribute('aria-valuemax', '100');
    barOuter.setAttribute('aria-label', `Task completion: ${this.state.progress}%`);

    const barInner = document.createElement('div');
    barInner.className = 'spec-workflow-progress-fill';
    barInner.style.width = `${this.state.progress}%`;

    barOuter.appendChild(barInner);
    wrapper.appendChild(label);
    wrapper.appendChild(barOuter);

    return wrapper;
  }

  private renderTaskList(tasks: SpecTask[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'spec-workflow-task-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Spec tasks');

    for (const task of tasks) {
      list.appendChild(this.renderTaskItem(task));
    }

    return list;
  }

  private renderTaskItem(task: SpecTask): HTMLElement {
    const item = document.createElement('div');
    item.className = `spec-workflow-task-item ${taskStatusClass(task.status)}`;
    item.setAttribute('role', 'listitem');
    item.setAttribute('data-task-id', task.id);
    item.setAttribute('aria-label', `Task: ${task.title} — ${TASK_STATUS_LABELS[task.status]}`);

    // Main row: status icon, title, action buttons
    const mainRow = document.createElement('div');
    mainRow.className = 'spec-task-main-row';

    const statusIconEl = document.createElement('span');
    statusIconEl.className = 'spec-task-status-icon';
    statusIconEl.textContent = TASK_STATUS_ICONS[task.status];
    statusIconEl.setAttribute('title', TASK_STATUS_LABELS[task.status]);
    mainRow.appendChild(statusIconEl);

    const titleEl = document.createElement('span');
    titleEl.className = 'spec-task-title';
    titleEl.textContent = task.title;
    titleEl.addEventListener('click', () => this.toggleTaskExpansion(task.id));
    mainRow.appendChild(titleEl);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'spec-task-actions';

    if (task.status === 'pending') {
      const startBtn = document.createElement('button');
      startBtn.className = 'spec-task-start-btn';
      startBtn.textContent = '▶ Start';
      startBtn.setAttribute('title', 'Start this task');
      startBtn.setAttribute('aria-label', `Start task: ${task.title}`);
      startBtn.addEventListener('click', () => this.startTask(task.id));
      actions.appendChild(startBtn);

      const skipBtn = document.createElement('button');
      skipBtn.className = 'spec-task-skip-btn';
      skipBtn.textContent = 'Skip';
      skipBtn.setAttribute('title', 'Skip this task');
      skipBtn.setAttribute('aria-label', `Skip task: ${task.title}`);
      skipBtn.addEventListener('click', () => this.skipTask(task.id));
      actions.appendChild(skipBtn);
    }

    if (task.status === 'in_progress') {
      const skipBtn = document.createElement('button');
      skipBtn.className = 'spec-task-skip-btn';
      skipBtn.textContent = 'Skip';
      skipBtn.setAttribute('title', 'Skip this task');
      skipBtn.setAttribute('aria-label', `Skip task: ${task.title}`);
      skipBtn.addEventListener('click', () => this.skipTask(task.id));
      actions.appendChild(skipBtn);
    }

    mainRow.appendChild(actions);
    item.appendChild(mainRow);

    // Expanded details
    if (this.state.expandedTaskId === task.id) {
      item.appendChild(this.renderTaskDetails(task));
    }

    return item;
  }

  private renderTaskDetails(task: SpecTask): HTMLElement {
    const details = document.createElement('div');
    details.className = 'spec-task-details';

    // Description
    if (task.description) {
      const descEl = document.createElement('div');
      descEl.className = 'spec-task-description';
      descEl.textContent = task.description;
      details.appendChild(descEl);
    }

    // Requirement references
    if (task.requirementRefs.length > 0) {
      const refsEl = document.createElement('div');
      refsEl.className = 'spec-task-refs';
      refsEl.innerHTML =
        '<span class="spec-task-refs-label">Requirements:</span> ' +
        task.requirementRefs.map((r) => `<span class="spec-task-ref-badge">${escHtml(r)}</span>`).join(' ');
      details.appendChild(refsEl);
    }

    // Acceptance criteria
    if (task.acceptanceCriteria.length > 0) {
      const criteriaEl = document.createElement('div');
      criteriaEl.className = 'spec-task-criteria';
      criteriaEl.innerHTML = '<div class="spec-task-criteria-label">Acceptance Criteria:</div>';

      const criteriaList = document.createElement('ul');
      criteriaList.className = 'spec-task-criteria-list';

      for (const criterion of task.acceptanceCriteria) {
        const li = document.createElement('li');
        li.className = 'spec-task-criterion';

        // Check if we have verification results for this criterion
        const verResult = task.verificationResult?.criteriaResults.find(
          (c) => c.criterion === criterion,
        );

        if (verResult) {
          li.className += verResult.passed ? ' spec-criterion-passed' : ' spec-criterion-failed';
          li.innerHTML =
            `<span class="spec-criterion-icon">${verResult.passed ? '✓' : '✗'}</span> ` +
            escHtml(criterion);
          if (verResult.detail) {
            li.innerHTML += `<span class="spec-criterion-detail">${escHtml(verResult.detail)}</span>`;
          }
        } else {
          li.textContent = criterion;
        }

        criteriaList.appendChild(li);
      }

      criteriaEl.appendChild(criteriaList);
      details.appendChild(criteriaEl);
    }

    // Dependencies
    if (task.dependencies.length > 0) {
      const depsEl = document.createElement('div');
      depsEl.className = 'spec-task-dependencies';
      depsEl.innerHTML =
        '<span class="spec-task-deps-label">Depends on:</span> ' +
        task.dependencies.map((d) => `<span class="spec-task-dep-badge">${escHtml(d)}</span>`).join(' ');
      details.appendChild(depsEl);
    }

    return details;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create and initialize a SpecWorkflowPanel in the given container.
 */
export function createSpecWorkflowPanel(container: HTMLElement): SpecWorkflowPanel {
  const panel = new SpecWorkflowPanel(container);
  panel.init();
  return panel;
}
