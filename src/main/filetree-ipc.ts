/**
 * IPC handler registration for the File Tree Panel.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, benchmark-ipc.ts, codebase-ipc.ts).
 *
 * Channels:
 *   filetree:get-tree           — read workspace directory recursively, return FileNode[]
 *   filetree:open-file          — open a file in the editor panel with optional line number
 *   filetree:get-modified-files — return files modified by agent operations with change counts
 *
 * Requirements: 23.15
 */

import { ipcMain, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { safeExecFileSync } from '../security/safe-exec.js';

// ─── Types ──────────────────────────────────────────────────────

/** Represents a node in the file tree (mirrors renderer FileNode interface). */
export interface FileNode {
  /** File or folder name (not full path) */
  name: string;
  /** Full path relative to workspace root */
  path: string;
  /** Whether this node is a directory */
  isDirectory: boolean;
  /** Child nodes (only for directories) */
  children?: FileNode[];
}

/** Modification info for a file changed by agent operations. */
export interface FileModification {
  /** File path relative to workspace root */
  path: string;
  /** Number of changes (additions + deletions) */
  changeCount: number;
}

/** Arguments for the filetree:open-file handler. */
export interface OpenFileArgs {
  /** Absolute or relative file path to open */
  path: string;
  /** Optional line number to scroll to */
  line?: number;
  /** If true, open in preview mode (single-click); otherwise open fully (double-click) */
  preview?: boolean;
}

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface FileTreeIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): FileTreeIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Gitignore parsing ──────────────────────────────────────────

/** Default directories to always skip during tree walk. */
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '__pycache__', '.DS_Store']);

/**
 * Parse a .gitignore file into an array of non-comment, non-empty patterns.
 */
function parseGitignorePatterns(gitignorePath: string): string[] {
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Simple gitignore pattern matcher.
 * Supports:
 * - Exact directory matches (e.g., "node_modules")
 * - Extension glob (e.g., "*.log")
 * - Directory markers (e.g., "dist/")
 * - Negation patterns are skipped (e.g., "!important.log")
 */
function matchesGitignorePattern(name: string, relativePath: string, isDirectory: boolean, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue; // skip negation for simplicity

    const cleanPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;

    // Exact name match
    if (name === cleanPattern) return true;

    // Relative path match
    if (relativePath === cleanPattern) return true;

    // Glob extension match (*.ext)
    if (cleanPattern.startsWith('*.')) {
      const ext = cleanPattern.slice(1); // e.g., ".log"
      if (name.endsWith(ext)) return true;
    }

    // Directory-only pattern (pattern/)
    if (pattern.endsWith('/') && isDirectory && name === cleanPattern) {
      return true;
    }

    // Path prefix match
    if (relativePath.startsWith(cleanPattern + '/')) return true;
  }
  return false;
}

// ─── Recursive directory walk ───────────────────────────────────

/**
 * Recursively walk a directory and build a FileNode[] tree.
 * Respects .gitignore patterns and default skip directories.
 */
async function walkDirectory(
  dir: string,
  rootDir: string,
  gitignorePatterns: string[],
  maxDepth: number = 15,
  currentDepth: number = 0,
): Promise<FileNode[]> {
  if (currentDepth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: FileNode[] = [];

  // Sort entries: directories first, then alphabetical
  entries.sort((a, b) => {
    const aIsDir = a.isDirectory();
    const bIsDir = b.isDirectory();
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  for (const entry of entries) {
    const name = entry.name;
    const fullPath = path.join(dir, name);
    const relativePath = path.relative(rootDir, fullPath);
    const isDirectory = entry.isDirectory();

    // Skip default patterns
    if (DEFAULT_SKIP_DIRS.has(name)) continue;

    // Skip gitignore patterns
    if (matchesGitignorePattern(name, relativePath, isDirectory, gitignorePatterns)) {
      continue;
    }

    if (isDirectory) {
      const children = await walkDirectory(fullPath, rootDir, gitignorePatterns, maxDepth, currentDepth + 1);
      results.push({
        name,
        path: relativePath,
        isDirectory: true,
        children,
      });
    } else {
      results.push({
        name,
        path: relativePath,
        isDirectory: false,
      });
    }
  }

  return results;
}

// ─── Git diff for modified files ────────────────────────────────

/**
 * Get modified files using `git diff --numstat` to determine change counts.
 * Falls back to `git status --porcelain` if numstat fails.
 * Returns an array of FileModification objects.
 */
function getGitModifiedFiles(workspaceDir: string): FileModification[] {
  const modifications: FileModification[] = [];

  try {
    // Get numstat for both staged and unstaged changes
    const numstatResult = safeExecFileSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd: workspaceDir,
      timeout: 10000,
    });

    if (numstatResult.exitCode === 0 && numstatResult.stdout.trim()) {
      const lines = numstatResult.stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const added = parseInt(parts[0] ?? '0', 10) || 0;
          const removed = parseInt(parts[1] ?? '0', 10) || 0;
          const filePath = parts[2];
          if (filePath) {
            modifications.push({
              path: filePath,
              changeCount: added + removed,
            });
          }
        }
      }
    }

    // Also check for untracked/new files via git status
    const statusResult = safeExecFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd: workspaceDir,
      timeout: 10000,
    });

    if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
      const lines = statusResult.stdout.trim().split('\n');
      for (const line of lines) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3).trim();

        // Include new/untracked files not already in modifications
        if ((status.includes('?') || status.includes('A')) && filePath) {
          const already = modifications.find((m) => m.path === filePath);
          if (!already) {
            // Count lines in new files as changes
            try {
              const fullPath = path.join(workspaceDir, filePath);
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lineCount = content.split('\n').length;
              modifications.push({
                path: filePath,
                changeCount: lineCount,
              });
            } catch {
              modifications.push({
                path: filePath,
                changeCount: 1,
              });
            }
          }
        }
      }
    }
  } catch {
    // Git not available or not a git repo — return empty
  }

  return modifications;
}

// ─── Workspace directory tracking ───────────────────────────────

/** Tracks the current workspace directory for file tree operations. */
let currentWorkspaceDir: string | null = null;

/**
 * Set the workspace directory used by file tree IPC handlers.
 * Should be called when a project is opened or changed.
 */
export function setFileTreeWorkspaceDir(dir: string): void {
  currentWorkspaceDir = dir;
}

/**
 * Get the current workspace directory.
 * Falls back to process.cwd() if not explicitly set.
 */
function getWorkspaceDir(): string {
  return currentWorkspaceDir || process.cwd();
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register all File Tree Panel IPC handlers.
 * Wire to Electron's ipcMain with the channel-based pattern.
 */
export function registerFileTreeIPC(mainWindow: BrowserWindow): void {
  // ── filetree:get-tree ──
  // Requirement 23.6: Display workspace file/folder hierarchy in collapsible tree
  ipcMain.handle('filetree:get-tree', async (): Promise<FileNode[] | FileTreeIPCErrorResponse> => {
    try {
      const workspaceDir = getWorkspaceDir();

      // Load .gitignore patterns if available
      const gitignorePath = path.join(workspaceDir, '.gitignore');
      const gitignorePatterns = parseGitignorePatterns(gitignorePath);

      // Recursively walk the workspace directory
      const tree = await walkDirectory(workspaceDir, workspaceDir, gitignorePatterns);
      return tree;
    } catch (err) {
      return makeError('FILETREE_GET_TREE_FAILED', err);
    }
  });

  // ── filetree:open-file ──
  // Requirement 23.15: Open file in editor panel with optional line number
  ipcMain.handle(
    'filetree:open-file',
    async (_event, args: OpenFileArgs): Promise<{ success: boolean } | FileTreeIPCErrorResponse> => {
      try {
        if (!args || !args.path) {
          return makeError('INVALID_ARGS', new Error('File path is required'));
        }

        const workspaceDir = getWorkspaceDir();

        // Resolve the file path (could be relative to workspace or absolute)
        const resolvedPath = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(workspaceDir, args.path);

        // Validate the file exists
        try {
          await fsPromises.access(resolvedPath, fs.constants.R_OK);
        } catch {
          return makeError('FILE_NOT_FOUND', new Error(`File not found: ${args.path}`));
        }

        // Ensure the resolved path is within the workspace (security check)
        const normalizedWorkspace = path.resolve(workspaceDir);
        const normalizedFile = path.resolve(resolvedPath);
        if (!normalizedFile.startsWith(normalizedWorkspace)) {
          return makeError('PATH_OUTSIDE_WORKSPACE', new Error('Cannot open files outside workspace'));
        }

        // Send the file open event to the renderer with line info
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('editor:open-file', {
            path: normalizedFile,
            relativePath: path.relative(workspaceDir, normalizedFile),
            line: args.line ?? undefined,
            preview: args.preview ?? false,
          });
        }

        return { success: true };
      } catch (err) {
        return makeError('FILETREE_OPEN_FILE_FAILED', err);
      }
    },
  );

  // ── filetree:get-modified-files ──
  // Requirement 23.7: Highlight files modified by agent operations with change count
  ipcMain.handle(
    'filetree:get-modified-files',
    async (): Promise<FileModification[] | FileTreeIPCErrorResponse> => {
      try {
        const workspaceDir = getWorkspaceDir();
        const modifications = getGitModifiedFiles(workspaceDir);
        return modifications;
      } catch (err) {
        return makeError('FILETREE_GET_MODIFIED_FAILED', err);
      }
    },
  );
}
