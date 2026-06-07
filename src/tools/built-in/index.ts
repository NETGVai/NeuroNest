/**
 * Built-in tools — Stub implementations for core tool definitions.
 *
 * Each tool is an ExecutableToolDefinition with proper id, name, description,
 * inputSchema, riskLevel, and a stub execute function.
 *
 * Requirements: 15.2–15.11, 15.16
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../tool-system.js';

// ─── Stub execute helper ────────────────────────────────────────

function stubExecute(toolName: string) {
  return async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
    success: true,
    output: `${toolName}: stub implementation — not yet wired`,
  });
}

// ─── Built-in tool definitions ──────────────────────────────────

export const BashTool: ExecutableToolDefinition = {
  id: 'bash',
  name: 'BashTool',
  description: 'Execute shell commands with user approval',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  riskLevel: 'destructive',
  execute: stubExecute('BashTool'),
};

export const FileReadTool: ExecutableToolDefinition = {
  id: 'file-read',
  name: 'FileReadTool',
  description: 'Read file contents from the project directory',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  riskLevel: 'read-only',
  execute: stubExecute('FileReadTool'),
};

export const FileWriteTool: ExecutableToolDefinition = {
  id: 'file-write',
  name: 'FileWriteTool',
  description: 'Create or overwrite a file in the project directory',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  riskLevel: 'write',
  execute: stubExecute('FileWriteTool'),
};

export const FileEditTool: ExecutableToolDefinition = {
  id: 'file-edit',
  name: 'FileEditTool',
  description: 'Apply targeted edits to a file with diff preview',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] },
  riskLevel: 'write',
  execute: stubExecute('FileEditTool'),
};

export const GlobTool: ExecutableToolDefinition = {
  id: 'glob',
  name: 'GlobTool',
  description: 'Find files matching a glob pattern in the project',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  riskLevel: 'read-only',
  execute: stubExecute('GlobTool'),
};

export const GrepTool: ExecutableToolDefinition = {
  id: 'grep',
  name: 'GrepTool',
  description: 'Search file contents using ripgrep-based pattern matching',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  riskLevel: 'read-only',
  execute: stubExecute('GrepTool'),
};

export const WebFetchTool: ExecutableToolDefinition = {
  id: 'web-fetch',
  name: 'WebFetchTool',
  description: 'Fetch content from a URL',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  riskLevel: 'read-only',
  execute: stubExecute('WebFetchTool'),
};

export const WebSearchTool: ExecutableToolDefinition = {
  id: 'web-search',
  name: 'WebSearchTool',
  description: 'Perform a web search query',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  riskLevel: 'read-only',
  execute: stubExecute('WebSearchTool'),
};

export const AgentTool: ExecutableToolDefinition = {
  id: 'agent',
  name: 'AgentTool',
  description: 'Spawn a sub-agent to handle a delegated task',
  inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, task: { type: 'string' } }, required: ['agentId', 'task'] },
  riskLevel: 'execute',
  execute: stubExecute('AgentTool'),
};

export const SendMessageTool: ExecutableToolDefinition = {
  id: 'send-message',
  name: 'SendMessageTool',
  description: 'Send a message to another agent',
  inputSchema: { type: 'object', properties: { targetAgentId: { type: 'string' }, message: { type: 'string' } }, required: ['targetAgentId', 'message'] },
  riskLevel: 'write',
  execute: stubExecute('SendMessageTool'),
};

export const TaskCreateTool: ExecutableToolDefinition = {
  id: 'task-create',
  name: 'TaskCreateTool',
  description: 'Create a new subtask in the current workflow',
  inputSchema: { type: 'object', properties: { description: { type: 'string' }, assignee: { type: 'string' } }, required: ['description'] },
  riskLevel: 'write',
  execute: stubExecute('TaskCreateTool'),
};

export const TaskUpdateTool: ExecutableToolDefinition = {
  id: 'task-update',
  name: 'TaskUpdateTool',
  description: 'Update the status of an existing task',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string' } }, required: ['taskId', 'status'] },
  riskLevel: 'write',
  execute: stubExecute('TaskUpdateTool'),
};

export const ToolSearchTool: ExecutableToolDefinition = {
  id: 'tool-search',
  name: 'ToolSearchTool',
  description: 'Search for available tools by name or description',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  riskLevel: 'read-only',
  execute: stubExecute('ToolSearchTool'),
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
