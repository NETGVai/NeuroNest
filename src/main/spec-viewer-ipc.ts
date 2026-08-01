/**
 * Spec Viewer IPC Handler — registers ipcMain.handle() handlers for the
 * Spec Viewer Panel's IPC channels.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, benchmark-ipc.ts).
 *
 * Channels:
 *   spec:get-document   — read requirements.md, design.md, or tasks.md from active spec
 *   spec:run-workflow   — trigger spec workflow commands (analyze, design, tasks, run-all)
 *   spec:get-task-status — parse tasks.md and return structured task status data
 *
 * Requirements: 23.10
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

/** Document types that can be requested by the Spec Viewer. */
type SpecDocType = 'requirements' | 'design' | 'tasks';

/** Workflow actions that can be triggered from the Spec Viewer. */
type SpecWorkflowAction = 'analyze' | 'design' | 'tasks' | 'run-all';

/** Task status as parsed from tasks.md checkbox states. */
type TaskStatusValue = 'not_started' | 'in_progress' | 'completed';

/** Structured task status returned by spec:get-task-status. */
interface TaskStatusEntry {
  id: string;
  title: string;
  status: TaskStatusValue;
  subtasks: TaskStatusEntry[];
  requirements: string[];
}

/** Standard IPC response envelope. */
interface SpecIPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// ─── Document filename mapping ──────────────────────────────────

const DOC_FILE_MAP: Record<SpecDocType, string> = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
};

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Resolve the active spec directory.
 *
 * Looks for `.kiro/specs/` in the project root and returns the most recently
 * modified spec directory, or the first one found if modification times are equal.
 */
function resolveActiveSpecDir(projectRoot: string): string | null {
  const specsRoot = join(projectRoot, '.kiro', 'specs');

  if (!existsSync(specsRoot)) {
    return null;
  }

  try {
    const entries = readdirSync(specsRoot, { withFileTypes: true });
    const specDirs = entries.filter((entry) => entry.isDirectory());

    if (specDirs.length === 0) {
      return null;
    }

    // Return the most recently modified spec directory
    let latestDir: string = specDirs[0]!.name;
    let latestMtime = 0;

    for (const dir of specDirs) {
      const dirPath = join(specsRoot, dir.name);
      try {
        const stat = statSync(dirPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestDir = dir.name;
        }
      } catch {
        // Skip directories we can't stat
      }
    }

    return join(specsRoot, latestDir);
  } catch {
    return null;
  }
}

/**
 * Parse a checkbox character from tasks.md into a TaskStatusValue.
 */
function parseCheckboxStatus(char: string): TaskStatusValue {
  switch (char) {
    case 'x': return 'completed';
    case '~':
    case '-': return 'in_progress';
    default: return 'not_started';
  }
}

/**
 * Parse tasks from a tasks.md markdown string into structured status data.
 */
function parseTaskStatuses(markdown: string): TaskStatusEntry[] {
  const tasks: TaskStatusEntry[] = [];
  const lines = markdown.split('\n');

  let currentTask: TaskStatusEntry | null = null;
  let currentSubtask: TaskStatusEntry | null = null;

  for (const line of lines) {
    // Top-level task: "- [x] 1. Title" or "- [ ] 1. Title" or "- [~] 1. Title"
    const topMatch = line.match(/^- \[([ x~-])\] (\d+)\. (.+)$/);
    if (topMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      currentSubtask = null;
      currentTask = {
        id: topMatch[2]!,
        title: topMatch[3]!,
        status: parseCheckboxStatus(topMatch[1]!),
        subtasks: [],
        requirements: [],
      };
      continue;
    }

    // Sub-task: "  - [x] 1.1 Title"
    const subMatch = line.match(/^  - \[([ x~-])\] (\d+\.\d+) (.+)$/);
    if (subMatch && currentTask) {
      const subtask: TaskStatusEntry = {
        id: subMatch[2]!,
        title: subMatch[3]!,
        status: parseCheckboxStatus(subMatch[1]!),
        subtasks: [],
        requirements: [],
      };
      currentTask.subtasks.push(subtask);
      currentSubtask = subtask;
      continue;
    }

    // Requirement references: "    - _Requirements: X.Y, Z.W_"
    const reqMatch = line.match(/^ {4,}- _Requirements?: (.+)_$/);
    if (reqMatch) {
      const reqs = reqMatch[1]!.split(/,\s*/);
      if (currentSubtask) {
        currentSubtask.requirements = reqs;
      } else if (currentTask) {
        currentTask.requirements = reqs;
      }
      continue;
    }
  }

  // Push last task
  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register Spec Viewer IPC handlers on ipcMain.
 *
 * @param mainWindow - The main BrowserWindow reference (used for sending events)
 * @param projectRoot - The root directory of the project workspace
 */
export function registerSpecViewerIPC(
  mainWindow: BrowserWindow,
  projectRoot: string,
): void {
  const resolvedRoot = resolve(projectRoot);

  // ── spec:get-document ──
  // Requirement 23.10: Read spec documents from active spec directory
  ipcMain.handle(
    'spec:get-document',
    async (
      _event,
      args: { type: SpecDocType },
    ): Promise<SpecIPCResponse<{ content: string }>> => {
      try {
        if (!args?.type || !DOC_FILE_MAP[args.type]) {
          return {
            success: false,
            error: {
              code: 'INVALID_DOC_TYPE',
              message: `Invalid document type: ${String(args?.type)}. Expected: requirements, design, or tasks.`,
            },
          };
        }

        const specDir = resolveActiveSpecDir(resolvedRoot);
        if (!specDir) {
          return {
            success: false,
            error: {
              code: 'NO_SPEC_DIR',
              message: 'No spec directory found in .kiro/specs/',
            },
          };
        }

        const filePath = join(specDir, DOC_FILE_MAP[args.type]);

        if (!existsSync(filePath)) {
          return {
            success: false,
            error: {
              code: 'DOC_NOT_FOUND',
              message: `Document not found: ${DOC_FILE_MAP[args.type]}`,
            },
          };
        }

        const content = await readFile(filePath, 'utf-8');
        return { success: true, data: { content } };
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'READ_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );

  // ── spec:run-workflow ──
  // Requirement 23.10: Trigger spec workflow commands via action buttons
  ipcMain.handle(
    'spec:run-workflow',
    async (
      _event,
      args: { action: SpecWorkflowAction },
    ): Promise<SpecIPCResponse<{ started: boolean }>> => {
      try {
        if (!args?.action) {
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: 'No workflow action specified.',
            },
          };
        }

        const validActions: SpecWorkflowAction[] = ['analyze', 'design', 'tasks', 'run-all'];
        if (!validActions.includes(args.action)) {
          return {
            success: false,
            error: {
              code: 'UNKNOWN_ACTION',
              message: `Unknown workflow action: ${args.action}. Expected: analyze, design, tasks, or run-all.`,
            },
          };
        }

        const specDir = resolveActiveSpecDir(resolvedRoot);
        if (!specDir) {
          return {
            success: false,
            error: {
              code: 'NO_SPEC_DIR',
              message: 'No spec directory found in .kiro/specs/',
            },
          };
        }

        // Emit workflow command event to the renderer for existing spec workflow
        // infrastructure to handle. The spec workflow engine listens for these events.
        mainWindow.webContents.send('spec:workflow-triggered', {
          action: args.action,
          specDir,
          timestamp: Date.now(),
        });

        return { success: true, data: { started: true } };
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );

  // ── spec:get-task-status ──
  // Requirement 23.10: Return structured task status data from tasks.md
  ipcMain.handle(
    'spec:get-task-status',
    async (): Promise<SpecIPCResponse<{ tasks: TaskStatusEntry[] }>> => {
      try {
        const specDir = resolveActiveSpecDir(resolvedRoot);
        if (!specDir) {
          return {
            success: false,
            error: {
              code: 'NO_SPEC_DIR',
              message: 'No spec directory found in .kiro/specs/',
            },
          };
        }

        const tasksPath = join(specDir, 'tasks.md');
        if (!existsSync(tasksPath)) {
          return {
            success: false,
            error: {
              code: 'TASKS_NOT_FOUND',
              message: 'tasks.md not found in spec directory.',
            },
          };
        }

        const content = await readFile(tasksPath, 'utf-8');
        const tasks = parseTaskStatuses(content);

        return { success: true, data: { tasks } };
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'PARSE_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );
}
