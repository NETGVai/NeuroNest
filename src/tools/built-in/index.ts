/**
 * Built-in tools — Core tool definitions with real implementations.
 *
 * Each tool is an ExecutableToolDefinition with proper id, name, description,
 * inputSchema, riskLevel, and an execute function.
 *
 * Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 15.2–15.11, 15.16
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import fg from 'fast-glob';
import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition, ToolSystem } from '../tool-system.js';
import type { ToolDependencies } from './tool-dependencies.js';
import { webFetchExecute } from './web-fetch.js';
import { webSearchExecute } from './web-search.js';
import { createAgentExecute } from './agent-delegate.js';
import { createSendMessageExecute } from './send-message.js';
import { createTaskCreateExecute } from './task-create.js';
import { createTaskUpdateExecute } from './task-update.js';
import { createToolSearchExecute } from './tool-search.js';
import { registerAnchoredEditTool } from './anchored-edit-tool.js';
import { registerBackgroundTaskTools } from './background-task-tools.js';
import { getBackgroundTaskRegistry } from '../../tasks/background-task-registry.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 1_048_576; // 1MB
const DEFAULT_BASH_TIMEOUT = 60_000; // 60 seconds

// ─── FileReadTool execute implementation ────────────────────────

async function fileReadExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const { path: filePath, maxBytes } = input as { path?: string; maxBytes?: number };
  if (context.signal?.aborted) {
    return { success: false, output: null, error: 'File read aborted by user' };
  }

  // Validate input
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, output: null, error: 'Missing required parameter: path' };
  }

  // Validate project directory is available
  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  // Resolve the file path against the project directory
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectDir, filePath);

  // Security: prevent path traversal outside project directory
  if (!resolvedPath.startsWith(projectDir + path.sep) && resolvedPath !== projectDir) {
    return {
      success: false,
      output: null,
      error: 'Access denied: path is outside project directory',
    };
  }

  // Read the file
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;

  try {
    const stat = await fs.stat(resolvedPath);
    if (context.signal?.aborted) {
      return { success: false, output: null, error: 'File read aborted by user' };
    }

    if (!stat.isFile()) {
      return { success: false, output: null, error: `Not a file: ${filePath}` };
    }

    const fileSize = stat.size;
    const truncated = fileSize > limit;

    let content: string;
    if (truncated) {
      // Read only up to the limit
      const fileHandle = await fs.open(resolvedPath, 'r');
      try {
        const buffer = Buffer.alloc(limit);
        await fileHandle.read(buffer, 0, limit, 0);
        content = buffer.toString('utf-8');
      } finally {
        await fileHandle.close();
      }
    } else {
      content = await fs.readFile(resolvedPath, 'utf-8');
    }

    return {
      success: true,
      output: {
        content,
        path: resolvedPath,
        size: fileSize,
        truncated,
      },
    };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return { success: false, output: null, error: `File not found: ${filePath}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: null, error: `Failed to read file: ${message}` };
  }
}

// ─── GlobTool execute implementation ────────────────────────────

const DEFAULT_GLOB_IGNORE = ['node_modules/**', '.git/**', 'dist/**', 'build/**'];

async function globExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const { pattern, ignore } = input as { pattern?: string; ignore?: string[] };

  // Validate input
  if (!pattern || typeof pattern !== 'string') {
    return { success: false, output: null, error: 'Missing required parameter: pattern' };
  }

  // Validate project directory is available
  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  // Merge default ignore patterns with any user-provided ones
  const ignorePatterns = [...DEFAULT_GLOB_IGNORE];
  if (Array.isArray(ignore)) {
    for (const p of ignore) {
      if (typeof p === 'string') {
        ignorePatterns.push(p);
      }
    }
  }

  try {
    const files = await fg(pattern, {
      cwd: projectDir,
      ignore: ignorePatterns,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });

    // Sort for deterministic output
    files.sort();

    if (files.length === 0) {
      return {
        success: true,
        output: {
          files: [],
          count: 0,
          message: `No files found matching pattern: ${pattern}`,
        },
      };
    }

    return {
      success: true,
      output: {
        files,
        count: files.length,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: null, error: `Glob search failed: ${message}` };
  }
}

// ─── BashTool execute implementation ────────────────────────────

async function bashExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const { command, timeout, cwd, background } = input as { command?: string; timeout?: number; cwd?: string; background?: boolean };
  if (context.signal?.aborted) {
    return { success: false, output: null, error: 'Command aborted by user' };
  }

  // Validate input
  if (!command || typeof command !== 'string') {
    return { success: false, output: null, error: 'Missing required parameter: command' };
  }

  // Validate project directory is available
  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  // Determine working directory
  let workingDir = projectDir;
  if (cwd && typeof cwd === 'string') {
    const resolvedCwd = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(projectDir, cwd);
    // Security: prevent path traversal outside project directory
    if (!resolvedCwd.startsWith(projectDir + path.sep) && resolvedCwd !== projectDir) {
      return {
        success: false,
        output: null,
        error: 'Access denied: working directory is outside project directory',
      };
    }
    workingDir = resolvedCwd;
  }

  // Approval flow
  const isAutoApprove = context.permissionMode === 'auto-approve';

  if (!isAutoApprove) {
    if (context.approvalHandler) {
      const approved = await context.approvalHandler(command);
      if (context.signal?.aborted) {
        return { success: false, output: null, error: 'Command aborted by user' };
      }
      if (!approved) {
        return {
          success: false,
          output: { stdout: '', stderr: '', exitCode: -1, timedOut: false },
          error: 'Command rejected by user',
        };
      }
    } else {
      // No handler and not auto-approve — reject
      return {
        success: false,
        output: { stdout: '', stderr: '', exitCode: -1, timedOut: false },
        error: 'Command rejected by user',
      };
    }
  }

  if (context.signal?.aborted) {
    return { success: false, output: null, error: 'Command aborted by user' };
  }

  // ─── Background mode: delegate to BackgroundTaskRegistry (Req 15.2, 15.4) ───
  if (background === true) {
    const registry = getBackgroundTaskRegistry();
    const sessionId = context.sessionId || 'default';

    try {
      const taskId = registry.spawn(command, [], {
        cwd: workingDir,
        sessionId,
      });

      return {
        success: true,
        output: {
          taskId,
          message: 'Task started in background',
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to spawn background task';
      return {
        success: false,
        output: null,
        error: message,
      };
    }
  }

  // ─── Blocking mode: existing behavior (Req 15.4) ───────────────────────────
  // Execute the command
  const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_BASH_TIMEOUT;

  return new Promise<ToolResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const proc = spawn(command, [], {
      shell: true,
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX, make the shell a process-group leader so cancellation can
      // terminate pipelines and nested descendants, not only the wrapper shell.
      detached: process.platform !== 'win32',
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const terminateProcessTree = (signal: NodeJS.Signals): void => {
      const pid = proc.pid;
      if (!pid) return;
      if (process.platform === 'win32') {
        try {
          const taskkill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          taskkill.unref();
          return;
        } catch {
          // Fall through to direct child termination if taskkill cannot start.
        }
      } else {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // The group may already be gone; fall back to the direct child.
        }
      }
      try { proc.kill(signal); } catch { /* The child may already have exited. */ }
    };

    const onAbort = () => {
      if (!settled) {
        aborted = true;
        terminateProcessTree('SIGTERM');
      }
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        terminateProcessTree('SIGTERM');
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    };

    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      // A descendant may ignore SIGTERM even after the wrapper shell exits.
      // Escalate the process group before reporting cancellation complete.
      if (timedOut || aborted) terminateProcessTree('SIGKILL');
      cleanup();

      const exitCode = code ?? (timedOut || aborted ? 137 : 1);

      resolve({
        success: !timedOut && !aborted && exitCode === 0,
        output: {
          stdout,
          stderr,
          exitCode,
          timedOut,
          aborted,
        },
        error: aborted
          ? 'Command aborted by user'
          : timedOut ? `Command timed out after ${timeoutMs / 1000}s` : undefined,
      });
    });

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();

      resolve({
        success: false,
        output: { stdout, stderr, exitCode: 1, timedOut: false, aborted },
        error: aborted ? 'Command aborted by user' : `Failed to execute command: ${err.message}`,
      });
    });
  });
}

// ─── Built-in tool definitions ──────────────────────────────────

export const BashTool: ExecutableToolDefinition = {
  id: 'bash',
  name: 'BashTool',
  description: 'Execute shell commands with user approval',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
      cwd: { type: 'string', description: 'Working directory relative to project dir' },
      background: { type: 'boolean', description: 'When true, spawn as background task and return taskId immediately (Req 15.2)' },
    },
    required: ['command'],
  },
  riskLevel: 'destructive',
  execute: bashExecute,
};

export const FileReadTool: ExecutableToolDefinition = {
  id: 'file-read',
  name: 'FileReadTool',
  description: 'Read file contents from the project directory',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative or absolute path to the file' },
      maxBytes: { type: 'number', description: 'Maximum bytes to read (default: 1MB)' },
    },
    required: ['path'],
  },
  riskLevel: 'read-only',
  execute: fileReadExecute,
};

export const FileWriteTool: ExecutableToolDefinition = {
  id: 'file-write',
  name: 'FileWriteTool',
  description: 'Create or overwrite a file in the project directory',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  riskLevel: 'write',
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path: filePath, content } = input as { path: string; content: string };
    if (context.signal?.aborted) {
      return { success: false, output: null, error: 'File write aborted by user' };
    }
    if (!filePath || content === undefined) {
      return { success: false, output: null, error: 'Missing required fields: path and content' };
    }
    try {
      const fs = require('node:fs');
      const pathMod = require('node:path');
      const os = require('node:os');
      const projectDir = context.projectDir || pathMod.join(os.homedir(), '.neuronest', 'projects', context.sessionId || 'default');
      const fullPath = pathMod.resolve(projectDir, filePath);
      // Security: prevent path traversal outside project
      if (!fullPath.startsWith(projectDir)) {
        return { success: false, output: null, error: 'Path traversal blocked — cannot write outside project directory' };
      }
      fs.mkdirSync(pathMod.dirname(fullPath), { recursive: true });
      if (context.signal?.aborted) {
        return { success: false, output: null, error: 'File write aborted by user' };
      }
      fs.writeFileSync(fullPath, content, 'utf-8');
      return { success: true, output: `Written ${content.length} bytes to ${filePath}` };
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  },
};

export const FileEditTool: ExecutableToolDefinition = {
  id: 'file-edit',
  name: 'FileEditTool',
  description: 'Apply targeted edits to a file — supports find/replace operations',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] },
  riskLevel: 'write',
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { path: filePath, edits } = input as { path: string; edits: Array<{ oldText: string; newText: string }> };
    if (context.signal?.aborted) {
      return { success: false, output: null, error: 'File edit aborted by user' };
    }
    if (!filePath || !Array.isArray(edits)) {
      return { success: false, output: null, error: 'Missing required fields: path and edits array' };
    }
    try {
      const fs = require('node:fs');
      const pathMod = require('node:path');
      const os = require('node:os');
      const projectDir = context.projectDir || pathMod.join(os.homedir(), '.neuronest', 'projects', context.sessionId || 'default');
      const fullPath = pathMod.resolve(projectDir, filePath);
      // Security: prevent path traversal
      if (!fullPath.startsWith(projectDir)) {
        return { success: false, output: null, error: 'Path traversal blocked — cannot edit outside project directory' };
      }
      if (!fs.existsSync(fullPath)) {
        return { success: false, output: null, error: `File not found: ${filePath}` };
      }
      let content = fs.readFileSync(fullPath, 'utf-8');
      let appliedCount = 0;
      for (const edit of edits) {
        if (edit.oldText && content.includes(edit.oldText)) {
          content = content.replace(edit.oldText, edit.newText ?? '');
          appliedCount++;
        }
      }
      if (context.signal?.aborted) {
        return { success: false, output: null, error: 'File edit aborted by user' };
      }
      fs.writeFileSync(fullPath, content, 'utf-8');
      return { success: true, output: `Applied ${appliedCount}/${edits.length} edits to ${filePath}` };
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  },
};

export const GlobTool: ExecutableToolDefinition = {
  id: 'glob',
  name: 'GlobTool',
  description: 'Find files matching a glob pattern in the project',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts")' },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional patterns to ignore',
      },
    },
    required: ['pattern'],
  },
  riskLevel: 'read-only',
  execute: globExecute,
};

// ─── GrepTool execute implementation ────────────────────────────

const DEFAULT_MAX_RESULTS = 100;

/** Directories to skip during recursive fallback search */
const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);

/** Extensions considered binary (skip during fallback search) */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.obj',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.bin', '.dat', '.db', '.sqlite', '.lock',
  '.onnx', '.pb', '.tflite',
]);

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * Attempt to run ripgrep and parse its output.
 * Returns null if ripgrep is not available.
 */
function tryRipgrep(
  pattern: string,
  searchDir: string,
  projectDir: string,
  caseSensitive: boolean,
  maxResults: number,
): Promise<{ matches: GrepMatch[]; totalMatches: number } | null> {
  return new Promise((resolve) => {
    const args: string[] = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--color', 'never',
    ];

    if (!caseSensitive) {
      args.push('--ignore-case');
    }

    // We request more than maxResults so we can get a true total count
    // (up to a reasonable limit to avoid huge outputs)
    args.push('--max-count', String(maxResults * 10));

    args.push('--', pattern, searchDir);

    execFile('rg', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, _stderr) => {
      // If ripgrep is not found, return null to trigger fallback
      if (error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(null);
        return;
      }

      // Exit code 1 means no matches; exit code 2 means error
      if (error && (error as { code?: number }).code === 2) {
        resolve(null);
        return;
      }

      // Parse ripgrep output: file:line:content
      const lines = (stdout || '').split('\n').filter((l) => l.length > 0);
      const allMatches: GrepMatch[] = [];

      for (const line of lines) {
        // Format: filepath:lineNumber:content
        const firstColon = line.indexOf(':');
        if (firstColon === -1) continue;
        const secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon === -1) continue;

        const filePath = line.substring(0, firstColon);
        const lineNum = parseInt(line.substring(firstColon + 1, secondColon), 10);
        const content = line.substring(secondColon + 1);

        if (isNaN(lineNum)) continue;

        // Make path relative to project dir
        const relativePath = path.relative(projectDir, filePath);

        allMatches.push({
          file: relativePath,
          line: lineNum,
          content: content.trim(),
        });
      }

      const totalMatches = allMatches.length;
      const truncatedMatches = allMatches.slice(0, maxResults);

      resolve({ matches: truncatedMatches, totalMatches });
    });
  });
}

/**
 * Recursive fallback search using Node.js fs when ripgrep is unavailable.
 */
async function nodeFallbackGrep(
  pattern: string,
  searchDir: string,
  projectDir: string,
  caseSensitive: boolean,
  maxResults: number,
): Promise<{ matches: GrepMatch[]; totalMatches: number }> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    // If pattern is not valid regex, treat it as a literal string
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, caseSensitive ? '' : 'i');
  }

  const allMatches: GrepMatch[] = [];
  let totalMatches = 0;

  async function walkDir(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[];
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      if (entry.isDirectory()) {
        if (GREP_SKIP_DIRS.has(entryName)) continue;
        await walkDir(path.join(dir, entryName));
      } else if (entry.isFile()) {
        const ext = path.extname(entryName).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const filePath = path.join(dir, entryName);

        // Skip very large files (> 1MB)
        try {
          const stat = await fs.stat(filePath);
          if (stat.size > 1_048_576) continue;
        } catch {
          continue;
        }

        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          continue; // Skip unreadable files
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            totalMatches++;
            if (allMatches.length < maxResults) {
              const relativePath = path.relative(projectDir, filePath);
              allMatches.push({
                file: relativePath,
                line: i + 1,
                content: lines[i].trim(),
              });
            }
          }
        }
      }
    }
  }

  await walkDir(searchDir);
  return { matches: allMatches, totalMatches };
}

async function grepExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const {
    pattern,
    path: searchPath,
    caseSensitive,
    maxResults,
  } = input as {
    pattern?: string;
    path?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  };

  // Validate input
  if (!pattern || typeof pattern !== 'string') {
    return { success: false, output: null, error: 'Missing required parameter: pattern' };
  }

  // Validate project directory is available
  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);
  const isCaseSensitive = caseSensitive === true;
  const limit = typeof maxResults === 'number' && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS;

  // Determine search directory
  let searchDir = projectDir;
  if (searchPath && typeof searchPath === 'string') {
    const resolved = path.isAbsolute(searchPath)
      ? path.resolve(searchPath)
      : path.resolve(projectDir, searchPath);

    // Security: prevent path traversal outside project directory
    if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
      return {
        success: false,
        output: null,
        error: 'Access denied: search path is outside project directory',
      };
    }
    searchDir = resolved;
  }

  // Verify the search directory exists
  try {
    const stat = await fs.stat(searchDir);
    if (!stat.isDirectory()) {
      return { success: false, output: null, error: `Not a directory: ${searchPath}` };
    }
  } catch {
    return { success: false, output: null, error: `Search directory not found: ${searchPath || projectDir}` };
  }

  // Try ripgrep first
  const rgResult = await tryRipgrep(pattern, searchDir, projectDir, isCaseSensitive, limit);

  let matches: GrepMatch[];
  let totalMatches: number;

  if (rgResult !== null) {
    matches = rgResult.matches;
    totalMatches = rgResult.totalMatches;
  } else {
    // Fall back to Node.js recursive search
    const fallbackResult = await nodeFallbackGrep(pattern, searchDir, projectDir, isCaseSensitive, limit);
    matches = fallbackResult.matches;
    totalMatches = fallbackResult.totalMatches;
  }

  return {
    success: true,
    output: {
      matches,
      totalMatches,
      truncated: totalMatches > matches.length,
    },
  };
}

export const GrepTool: ExecutableToolDefinition = {
  id: 'grep',
  name: 'GrepTool',
  description: 'Search file contents using ripgrep-based pattern matching',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
      path: { type: 'string', description: 'Subdirectory to scope search (relative to project root)' },
      caseSensitive: { type: 'boolean', description: 'Whether to match case-sensitively (default: false)' },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default: 100)' },
    },
    required: ['pattern'],
  },
  riskLevel: 'read-only',
  execute: grepExecute,
};

export const WebFetchTool: ExecutableToolDefinition = {
  id: 'web-fetch',
  name: 'WebFetchTool',
  description: 'Fetch content from a URL',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch (http or https)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['url'],
  },
  riskLevel: 'read-only',
  execute: webFetchExecute,
};

export const WebSearchTool: ExecutableToolDefinition = {
  id: 'web-search',
  name: 'WebSearchTool',
  description: 'Perform a web search query',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
    },
    required: ['query'],
  },
  riskLevel: 'read-only',
  execute: webSearchExecute,
};

export const AgentTool: ExecutableToolDefinition = {
  id: 'agent',
  name: 'AgentTool',
  description: 'Spawn a sub-agent to handle a delegated task',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'ID of the agent to delegate to' },
      task: { type: 'string', description: 'Task description for the agent' },
      maxTokens: { type: 'number', description: 'Max tokens for LLM response (default: 4096)' },
    },
    required: ['agentId', 'task'],
  },
  riskLevel: 'execute',
  execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: false,
    output: null,
    error: 'AgentTool requires dependency injection — use registerBuiltInTools()',
  }),
};

export const SendMessageTool: ExecutableToolDefinition = {
  id: 'send-message',
  name: 'SendMessageTool',
  description: 'Send a message to another agent',
  inputSchema: {
    type: 'object',
    properties: {
      targetAgentId: { type: 'string', description: 'ID of the agent to message' },
      message: { type: 'string', description: 'Message content' },
    },
    required: ['targetAgentId', 'message'],
  },
  riskLevel: 'write',
  execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: false,
    output: null,
    error: 'SendMessageTool requires dependency injection — use registerBuiltInTools()',
  }),
};

export const TaskCreateTool: ExecutableToolDefinition = {
  id: 'task-create',
  name: 'TaskCreateTool',
  description: 'Create a new subtask in the current workflow',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Task description/title' },
      assignee: { type: 'string', description: 'Agent ID to assign the task to (defaults to current agent)' },
      priority: { type: 'string', description: 'Priority: low, medium, high, or urgent (default: medium)' },
    },
    required: ['description'],
  },
  riskLevel: 'write',
  execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: false,
    output: null,
    error: 'TaskCreateTool requires dependency injection — use registerBuiltInTools()',
  }),
};

export const TaskUpdateTool: ExecutableToolDefinition = {
  id: 'task-update',
  name: 'TaskUpdateTool',
  description: 'Update the status of an existing task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'ID of the task to update' },
      status: { type: 'string', description: 'New status: queued, claimed, in_progress, completed, failed, blocked' },
    },
    required: ['taskId', 'status'],
  },
  riskLevel: 'write',
  execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: false,
    output: null,
    error: 'TaskUpdateTool requires dependency injection — use registerBuiltInTools()',
  }),
};

export const ToolSearchTool: ExecutableToolDefinition = {
  id: 'tool-search',
  name: 'ToolSearchTool',
  description: 'Search for available tools by name or description',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword or phrase' },
    },
    required: ['query'],
  },
  riskLevel: 'read-only',
  execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: false,
    output: null,
    error: 'ToolSearchTool requires dependency injection — use registerBuiltInTools()',
  }),
};

// ─── All built-in tools as an array ─────────────────────────────

export const builtInTools: ExecutableToolDefinition[] = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  WebSearchTool,
  AgentTool,
  SendMessageTool,
  TaskCreateTool,
  TaskUpdateTool,
  ToolSearchTool,
];

// ─── Registration Function ──────────────────────────────────────

/**
 * Registers all built-in tools with the ToolSystem, injecting dependencies
 * for factory-based tools (Agent, SendMessage, TaskCreate, TaskUpdate, ToolSearch).
 *
 * Static tools (WebFetch, WebSearch, Bash, FileRead, FileWrite, FileEdit, Glob, Grep)
 * are registered directly with their execute functions.
 *
 * Factory tools are instantiated with the provided dependencies before registration.
 *
 * @param deps - ToolDependencies containing db, eventBus, toolSystem, agentRegistry, resolveLLMClient
 * @param toolSystem - The ToolSystem instance to register tools with
 */
export function registerBuiltInTools(deps: ToolDependencies, toolSystem: ToolSystem): void {
  // Instantiate factory-based execute functions with dependencies
  const agentExecute = createAgentExecute({
    agentRegistry: deps.agentRegistry,
    resolveLLMClient: deps.resolveLLMClient,
  });
  const sendMessageExecute = createSendMessageExecute({
    eventBus: deps.eventBus,
  });
  const taskCreateExecute = createTaskCreateExecute({
    db: deps.db,
  });
  const taskUpdateExecute = createTaskUpdateExecute({
    db: deps.db,
  });
  const toolSearchExecute = createToolSearchExecute({
    toolSystem: deps.toolSystem,
  });

  // Register static tools (no factory dependencies)
  const staticTools: ExecutableToolDefinition[] = [
    BashTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    WebFetchTool,
    WebSearchTool,
  ];

  for (const tool of staticTools) {
    toolSystem.register(tool);
  }

  // Register factory-based tools with their wired execute functions
  toolSystem.register({ ...AgentTool, execute: agentExecute });
  toolSystem.register({ ...SendMessageTool, execute: sendMessageExecute });
  toolSystem.register({ ...TaskCreateTool, execute: taskCreateExecute });
  toolSystem.register({ ...TaskUpdateTool, execute: taskUpdateExecute });
  toolSystem.register({ ...ToolSearchTool, execute: toolSearchExecute });

  // Register anchored_edit tool (Req 12.2, 12.3, 12.4, 12.5)
  registerAnchoredEditTool(toolSystem);

  // Register background task tools (Req 15.3, 15.6, 15.7, 15.8, 15.9)
  registerBackgroundTaskTools(toolSystem);
}
