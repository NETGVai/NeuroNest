/**
 * Task Checklist component for the Spec Viewer Panel.
 *
 * Renders tasks as an interactive checklist with status badges
 * (not_started, in_progress, completed), indentation for sub-tasks,
 * and progress bars.
 *
 * Requirements: 23.9, 23.11
 */

// ─── Types ──────────────────────────────────────────────────────

/** Task status matching the spec workflow statuses. */
export type TaskStatus = 'not_started' | 'in_progress' | 'completed';

/** Parsed task data for rendering. */
export interface TaskData {
  id: string;
  title: string;
  status: TaskStatus;
  subtasks: TaskData[];
  details: string[];
  requirements: string[];
}

/** Progress summary for a section of tasks. */
export interface ProgressInfo {
  total: number;
  completed: number;
  inProgress: number;
  percentage: number;
}

// ─── CSS Classes ────────────────────────────────────────────────

const CSS = {
  checklist: 'nn-task-checklist',
  progressBar: 'nn-task-checklist__progress',
  progressFill: 'nn-task-checklist__progress-fill',
  progressLabel: 'nn-task-checklist__progress-label',
  taskItem: 'nn-task-checklist__item',
  taskItemSub: 'nn-task-checklist__item--sub',
  taskCheckbox: 'nn-task-checklist__checkbox',
  taskTitle: 'nn-task-checklist__title',
  taskBadge: 'nn-task-checklist__badge',
  taskDetails: 'nn-task-checklist__details',
  taskDetailItem: 'nn-task-checklist__detail-item',
  taskReqs: 'nn-task-checklist__reqs',
  badgeNotStarted: 'nn-task-checklist__badge--not-started',
  badgeInProgress: 'nn-task-checklist__badge--in-progress',
  badgeCompleted: 'nn-task-checklist__badge--completed',
  checkboxChecked: 'nn-task-checklist__checkbox--checked',
  checkboxPartial: 'nn-task-checklist__checkbox--partial',
} as const;

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for the task checklist. */
export function injectTaskChecklistStyles(): void {
  if (document.getElementById('nn-task-checklist-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-task-checklist-styles';
  style.textContent = `
    .${CSS.checklist} {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .${CSS.progressBar} {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding: 8px 0;
    }
    .${CSS.progressBar} .bar-track {
      flex: 1;
      height: 6px;
      background: var(--bg-tertiary, #0f172a);
      border-radius: 3px;
      overflow: hidden;
    }
    .${CSS.progressFill} {
      height: 100%;
      background: var(--accent, #6366f1);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .${CSS.progressLabel} {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
      white-space: nowrap;
    }
    .${CSS.taskItem} {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      transition: background 0.1s;
    }
    .${CSS.taskItem}:hover {
      background: var(--bg-hover, #1e293b);
    }
    .${CSS.taskItemSub} {
      margin-left: 24px;
    }
    .${CSS.taskCheckbox} {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border, #475569);
      border-radius: 4px;
      flex-shrink: 0;
      margin-top: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s, background 0.15s;
    }
    .${CSS.checkboxChecked} {
      border-color: var(--green, #10b981);
      background: var(--green, #10b981);
    }
    .${CSS.checkboxChecked}::after {
      content: '✓';
      font-size: 10px;
      color: white;
      font-weight: 700;
    }
    .${CSS.checkboxPartial} {
      border-color: var(--yellow, #f59e0b);
      background: rgba(245, 158, 11, 0.2);
    }
    .${CSS.checkboxPartial}::after {
      content: '–';
      font-size: 12px;
      color: var(--yellow, #f59e0b);
      font-weight: 700;
    }
    .${CSS.taskTitle} {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary, #e2e8f0);
      line-height: 1.4;
    }
    .${CSS.taskBadge} {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .${CSS.badgeNotStarted} {
      background: rgba(100, 116, 139, 0.2);
      color: #94a3b8;
    }
    .${CSS.badgeInProgress} {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }
    .${CSS.badgeCompleted} {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }
    .${CSS.taskDetails} {
      margin-left: 24px;
      padding: 4px 0 8px 8px;
      border-left: 2px solid var(--border, #334155);
    }
    .${CSS.taskDetailItem} {
      font-size: 11px;
      color: var(--text-secondary, #94a3b8);
      padding: 2px 0;
      line-height: 1.4;
    }
    .${CSS.taskReqs} {
      font-size: 10px;
      color: var(--accent, #6366f1);
      margin-left: 24px;
      padding: 2px 8px;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Get badge label for a task status. */
function getBadgeLabel(status: TaskStatus): string {
  switch (status) {
    case 'not_started': return 'Todo';
    case 'in_progress': return 'Active';
    case 'completed': return 'Done';
    default: return '';
  }
}

/** Get badge CSS class for a task status. */
function getBadgeClass(status: TaskStatus): string {
  switch (status) {
    case 'not_started': return CSS.badgeNotStarted;
    case 'in_progress': return CSS.badgeInProgress;
    case 'completed': return CSS.badgeCompleted;
    default: return CSS.badgeNotStarted;
  }
}

/** Calculate progress info from a flat list of tasks. */
export function calculateProgress(tasks: TaskData[]): ProgressInfo {
  let total = 0;
  let completed = 0;
  let inProgress = 0;

  function countTask(task: TaskData): void {
    if (task.subtasks.length > 0) {
      for (const sub of task.subtasks) {
        countTask(sub);
      }
    } else {
      total++;
      if (task.status === 'completed') completed++;
      if (task.status === 'in_progress') inProgress++;
    }
  }

  for (const task of tasks) {
    countTask(task);
  }

  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, inProgress, percentage };
}

// ─── Component ──────────────────────────────────────────────────

/**
 * Render a progress bar showing overall task completion.
 */
export function renderProgressBar(progress: ProgressInfo): HTMLElement {
  injectTaskChecklistStyles();

  const container = document.createElement('div');
  container.className = CSS.progressBar;
  container.setAttribute('role', 'progressbar');
  container.setAttribute('aria-valuenow', String(progress.percentage));
  container.setAttribute('aria-valuemin', '0');
  container.setAttribute('aria-valuemax', '100');
  container.setAttribute('aria-label', `Task progress: ${progress.percentage}%`);

  const track = document.createElement('div');
  track.className = 'bar-track';

  const fill = document.createElement('div');
  fill.className = CSS.progressFill;
  fill.style.width = `${progress.percentage}%`;
  track.appendChild(fill);

  container.appendChild(track);

  const label = document.createElement('span');
  label.className = CSS.progressLabel;
  label.textContent = `${progress.completed}/${progress.total} (${progress.percentage}%)`;
  container.appendChild(label);

  return container;
}

/**
 * Render a single task item with checkbox, title, and status badge.
 */
export function renderTaskItem(task: TaskData, isSubtask = false): HTMLElement {
  const wrapper = document.createElement('div');

  // Task row
  const item = document.createElement('div');
  item.className = isSubtask ? `${CSS.taskItem} ${CSS.taskItemSub}` : CSS.taskItem;
  item.setAttribute('role', 'listitem');
  item.setAttribute('aria-label', `Task ${task.id}: ${task.title}, status: ${task.status}`);
  item.dataset.taskId = task.id;

  // Checkbox
  const checkbox = document.createElement('span');
  checkbox.className = CSS.taskCheckbox;
  if (task.status === 'completed') {
    checkbox.classList.add(CSS.checkboxChecked);
  } else if (task.status === 'in_progress') {
    checkbox.classList.add(CSS.checkboxPartial);
  }
  checkbox.setAttribute('aria-hidden', 'true');
  item.appendChild(checkbox);

  // Title
  const title = document.createElement('span');
  title.className = CSS.taskTitle;
  title.textContent = `${task.id} ${task.title}`;
  item.appendChild(title);

  // Status badge
  const badge = document.createElement('span');
  badge.className = `${CSS.taskBadge} ${getBadgeClass(task.status)}`;
  badge.textContent = getBadgeLabel(task.status);
  item.appendChild(badge);

  wrapper.appendChild(item);

  // Task details (implementation notes)
  if (task.details.length > 0 && !isSubtask) {
    const details = document.createElement('div');
    details.className = CSS.taskDetails;
    for (const detail of task.details) {
      const detailItem = document.createElement('div');
      detailItem.className = CSS.taskDetailItem;
      detailItem.textContent = detail;
      details.appendChild(detailItem);
    }
    wrapper.appendChild(details);
  }

  // Requirements references
  if (task.requirements.length > 0) {
    const reqs = document.createElement('div');
    reqs.className = CSS.taskReqs;
    reqs.textContent = `Requirements: ${task.requirements.join(', ')}`;
    wrapper.appendChild(reqs);
  }

  // Render subtasks
  if (task.subtasks.length > 0) {
    for (const subtask of task.subtasks) {
      wrapper.appendChild(renderTaskItem(subtask, true));
    }
  }

  return wrapper;
}

/**
 * Render the full task checklist with progress bar and all tasks.
 */
export function renderTaskChecklist(tasks: TaskData[]): HTMLElement {
  injectTaskChecklistStyles();

  const container = document.createElement('div');
  container.className = CSS.checklist;
  container.setAttribute('role', 'list');
  container.setAttribute('aria-label', 'Task checklist');

  // Progress bar
  const progress = calculateProgress(tasks);
  container.appendChild(renderProgressBar(progress));

  // Task items
  for (const task of tasks) {
    container.appendChild(renderTaskItem(task));
  }

  return container;
}

/**
 * Parse tasks from a tasks.md markdown string.
 * Extracts task hierarchy with status, details, and requirement refs.
 */
export function parseTasks(markdown: string): TaskData[] {
  const tasks: TaskData[] = [];
  const lines = markdown.split('\n');

  let currentTask: TaskData | null = null;
  let currentSubtask: TaskData | null = null;
  let collectingDetails = false;

  for (const line of lines) {
    // Top-level task: "- [x] 1. Title" or "- [ ] 1. Title" or "- [~] 1. Title"
    const topMatch = line.match(/^- \[([ x~-])\] (\d+)\. (.+)$/);
    if (topMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      currentSubtask = null;
      collectingDetails = false;

      const status = parseCheckboxStatus(topMatch[1]);
      currentTask = {
        id: topMatch[2],
        title: topMatch[3],
        status,
        subtasks: [],
        details: [],
        requirements: [],
      };
      continue;
    }

    // Sub-task: "  - [x] 1.1 Title" or "  - [ ] 1.1 Title"
    const subMatch = line.match(/^  - \[([ x~-])\] (\d+\.\d+) (.+)$/);
    if (subMatch && currentTask) {
      currentSubtask = null;
      collectingDetails = false;

      const status = parseCheckboxStatus(subMatch[1]);
      const subtask: TaskData = {
        id: subMatch[2],
        title: subMatch[3],
        status,
        subtasks: [],
        details: [],
        requirements: [],
      };
      currentTask.subtasks.push(subtask);
      currentSubtask = subtask;
      collectingDetails = true;
      continue;
    }

    // Detail lines under a subtask (indented with 4+ spaces and starting with -)
    const detailMatch = line.match(/^ {4,}- (.+)$/);
    if (detailMatch && collectingDetails && currentSubtask) {
      const detailText = detailMatch[1].trim();
      // Check if it's a requirement reference
      const reqMatch = detailText.match(/^_Requirements?: (.+)_$/);
      if (reqMatch) {
        currentSubtask.requirements = reqMatch[1].split(/,\s*/);
      } else {
        currentSubtask.details.push(detailText);
      }
      continue;
    }

    // Detail lines under a top-level task (indented with 4+ spaces and starting with -)
    const topDetailMatch = line.match(/^ {4,}- (.+)$/);
    if (topDetailMatch && currentTask && !currentSubtask) {
      const detailText = topDetailMatch[1].trim();
      const reqMatch = detailText.match(/^_Requirements?: (.+)_$/);
      if (reqMatch) {
        currentTask.requirements = reqMatch[1].split(/,\s*/);
      } else {
        currentTask.details.push(detailText);
      }
      continue;
    }

    // Empty lines or other content — reset detail collection
    if (line.trim() === '' && currentSubtask) {
      collectingDetails = false;
    }
  }

  // Push last task
  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

/** Parse a checkbox character into a TaskStatus. */
function parseCheckboxStatus(char: string): TaskStatus {
  switch (char) {
    case 'x': return 'completed';
    case '~':
    case '-': return 'in_progress';
    default: return 'not_started';
  }
}
