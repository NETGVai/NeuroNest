/**
 * ProcessingNodeFramework — Chainable data processing operations with typed inputs/outputs.
 *
 * Provides the ProcessingNode interface, ProcessingNodeRegistry (register, unregister, get,
 * list, validateChain), and built-in nodes: file-read, file-write, json-parse, json-serialize,
 * text-split, regex-extract, llm-transform, tool-invoke.
 *
 * Integrates with PluginRegistry for custom node registration and uses isSchemaCompatible
 * from the pipeline-engine for chain validation.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import * as fs from 'fs';
import { isSchemaCompatible } from '../automation/pipeline-engine';
import type { ValidationResult, ValidationError } from '../shared/feature-integration-types';
import { FeatureError } from '../shared/feature-integration-errors';

// ─── Interfaces ─────────────────────────────────────────────────

export interface NodeContext {
  pipelineId: string;
  stepIndex: number;
  abortSignal: AbortSignal;
}

export interface ProcessingNode<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  inputSchema: object;
  outputSchema: object;
  validate(input: TInput): ValidationResult;
  transform(input: TInput, context: NodeContext): Promise<TOutput>;
}

// ─── Node Error ─────────────────────────────────────────────────

/**
 * Error thrown when a ProcessingNode's transform function fails.
 * Captures the node context for debugging (Req 13.4).
 */
export class ProcessingNodeError extends FeatureError {
  readonly nodeId: string;
  readonly pipelineId: string;
  readonly stepIndex: number;

  constructor(params: {
    message: string;
    nodeId: string;
    pipelineId: string;
    stepIndex: number;
    cause?: Error;
  }) {
    super({
      message: `ProcessingNode "${params.nodeId}" failed at step ${params.stepIndex} in pipeline "${params.pipelineId}": ${params.message}`,
      category: 'plugin',
      code: 'PROCESSING_NODE_ERROR',
      details: {
        nodeId: params.nodeId,
        pipelineId: params.pipelineId,
        stepIndex: params.stepIndex,
        originalError: params.cause?.message,
      },
    });
    this.nodeId = params.nodeId;
    this.pipelineId = params.pipelineId;
    this.stepIndex = params.stepIndex;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ProcessingNodeError.prototype);
  }
}

// ─── ProcessingNodeRegistry ─────────────────────────────────────

export class ProcessingNodeRegistry {
  private nodes = new Map<string, ProcessingNode>();

  /**
   * Register a processing node. Throws if a node with the same ID is already registered.
   */
  register(node: ProcessingNode): void {
    if (this.nodes.has(node.id)) {
      throw new FeatureError({
        message: `Processing node with ID "${node.id}" is already registered`,
        category: 'plugin',
        code: 'NODE_ALREADY_REGISTERED',
        details: { nodeId: node.id },
      });
    }
    this.nodes.set(node.id, node);
  }

  /**
   * Unregister a processing node by ID.
   */
  unregister(nodeId: string): void {
    if (!this.nodes.has(nodeId)) {
      throw new FeatureError({
        message: `Processing node not found: "${nodeId}"`,
        category: 'plugin',
        code: 'NODE_NOT_FOUND',
        details: { nodeId },
      });
    }
    this.nodes.delete(nodeId);
  }

  /**
   * Get a processing node by ID. Returns null if not found.
   */
  get(nodeId: string): ProcessingNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /**
   * List all registered processing nodes.
   */
  list(): ProcessingNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Validate a chain of processing nodes by checking type compatibility
   * between each consecutive pair (output schema of node[i] → input schema of node[i+1]).
   *
   * Uses isSchemaCompatible from pipeline-engine (Req 13.2).
   */
  validateChain(nodeIds: string[]): ValidationResult {
    const errors: ValidationError[] = [];

    if (nodeIds.length === 0) {
      return { valid: true, errors: [] };
    }

    // Check all nodes exist
    for (const nodeId of nodeIds) {
      if (!this.nodes.has(nodeId)) {
        errors.push({
          field: nodeId,
          message: `Processing node not found: "${nodeId}"`,
          code: 'NODE_NOT_FOUND',
        });
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Validate type compatibility between consecutive pairs
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const currentNode = this.nodes.get(nodeIds[i])!;
      const nextNode = this.nodes.get(nodeIds[i + 1])!;

      if (!isSchemaCompatible(currentNode.outputSchema, nextNode.inputSchema)) {
        errors.push({
          field: `${currentNode.id} -> ${nextNode.id}`,
          message: `Output schema of "${currentNode.name}" is incompatible with input schema of "${nextNode.name}"`,
          code: 'SCHEMA_INCOMPATIBLE',
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ─── Built-in Nodes ─────────────────────────────────────────────

/**
 * file-read node: Reads a file from disk.
 * Input: { path: string }
 * Output: { content: string }
 */
export const fileReadNode: ProcessingNode<{ path: string }, { content: string }> = {
  id: 'file-read',
  name: 'File Read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
    },
    required: ['content'],
  },
  validate(input: { path: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.path !== 'string' || input.path.length === 0) {
      errors.push({
        field: 'path',
        message: 'path must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { path: string }, context: NodeContext): Promise<{ content: string }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      const content = await fs.promises.readFile(input.path, 'utf-8');
      return { content };
    } catch (err) {
      throw new ProcessingNodeError({
        message: `Failed to read file "${input.path}": ${(err as Error).message}`,
        nodeId: 'file-read',
        pipelineId: context.pipelineId,
        stepIndex: context.stepIndex,
        cause: err as Error,
      });
    }
  },
};

/**
 * file-write node: Writes content to a file.
 * Input: { path: string, content: string }
 * Output: { success: boolean }
 */
export const fileWriteNode: ProcessingNode<{ path: string; content: string }, { success: boolean }> = {
  id: 'file-write',
  name: 'File Write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
    },
    required: ['success'],
  },
  validate(input: { path: string; content: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.path !== 'string' || input.path.length === 0) {
      errors.push({
        field: 'path',
        message: 'path must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    }
    if (!input || typeof input.content !== 'string') {
      errors.push({
        field: 'content',
        message: 'content must be a string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { path: string; content: string }, context: NodeContext): Promise<{ success: boolean }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      await fs.promises.writeFile(input.path, input.content, 'utf-8');
      return { success: true };
    } catch (err) {
      throw new ProcessingNodeError({
        message: `Failed to write file "${input.path}": ${(err as Error).message}`,
        nodeId: 'file-write',
        pipelineId: context.pipelineId,
        stepIndex: context.stepIndex,
        cause: err as Error,
      });
    }
  },
};

/**
 * json-parse node: Parses a JSON string into an object.
 * Input: { text: string }
 * Output: { data: object }
 */
export const jsonParseNode: ProcessingNode<{ text: string }, { data: object }> = {
  id: 'json-parse',
  name: 'JSON Parse',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      data: { type: 'object' },
    },
    required: ['data'],
  },
  validate(input: { text: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.text !== 'string') {
      errors.push({
        field: 'text',
        message: 'text must be a string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { text: string }, context: NodeContext): Promise<{ data: object }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      const data = JSON.parse(input.text);
      return { data };
    } catch (err) {
      throw new ProcessingNodeError({
        message: `Failed to parse JSON: ${(err as Error).message}`,
        nodeId: 'json-parse',
        pipelineId: context.pipelineId,
        stepIndex: context.stepIndex,
        cause: err as Error,
      });
    }
  },
};

/**
 * json-serialize node: Serializes an object to a JSON string.
 * Input: { data: object }
 * Output: { text: string }
 */
export const jsonSerializeNode: ProcessingNode<{ data: object }, { text: string }> = {
  id: 'json-serialize',
  name: 'JSON Serialize',
  inputSchema: {
    type: 'object',
    properties: {
      data: { type: 'object' },
    },
    required: ['data'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  validate(input: { data: object }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || input.data === undefined || input.data === null) {
      errors.push({
        field: 'data',
        message: 'data must be a non-null value',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { data: object }, context: NodeContext): Promise<{ text: string }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      const text = JSON.stringify(input.data);
      return { text };
    } catch (err) {
      throw new ProcessingNodeError({
        message: `Failed to serialize to JSON: ${(err as Error).message}`,
        nodeId: 'json-serialize',
        pipelineId: context.pipelineId,
        stepIndex: context.stepIndex,
        cause: err as Error,
      });
    }
  },
};

/**
 * text-split node: Splits a text string by a separator.
 * Input: { text: string, separator: string }
 * Output: { parts: string[] }
 */
export const textSplitNode: ProcessingNode<{ text: string; separator: string }, { parts: string[] }> = {
  id: 'text-split',
  name: 'Text Split',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      separator: { type: 'string' },
    },
    required: ['text', 'separator'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      parts: { type: 'array', items: { type: 'string' } },
    },
    required: ['parts'],
  },
  validate(input: { text: string; separator: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.text !== 'string') {
      errors.push({
        field: 'text',
        message: 'text must be a string',
        code: 'INVALID_INPUT',
      });
    }
    if (!input || typeof input.separator !== 'string') {
      errors.push({
        field: 'separator',
        message: 'separator must be a string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { text: string; separator: string }, context: NodeContext): Promise<{ parts: string[] }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    const parts = input.text.split(input.separator);
    return { parts };
  },
};

/**
 * regex-extract node: Extracts matches from text using a regex pattern.
 * Input: { text: string, pattern: string }
 * Output: { matches: string[] }
 */
export const regexExtractNode: ProcessingNode<{ text: string; pattern: string }, { matches: string[] }> = {
  id: 'regex-extract',
  name: 'Regex Extract',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      pattern: { type: 'string' },
    },
    required: ['text', 'pattern'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      matches: { type: 'array', items: { type: 'string' } },
    },
    required: ['matches'],
  },
  validate(input: { text: string; pattern: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.text !== 'string') {
      errors.push({
        field: 'text',
        message: 'text must be a string',
        code: 'INVALID_INPUT',
      });
    }
    if (!input || typeof input.pattern !== 'string' || input.pattern.length === 0) {
      errors.push({
        field: 'pattern',
        message: 'pattern must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { text: string; pattern: string }, context: NodeContext): Promise<{ matches: string[] }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      const regex = new RegExp(input.pattern, 'g');
      const matches = input.text.match(regex) ?? [];
      return { matches };
    } catch (err) {
      throw new ProcessingNodeError({
        message: `Invalid regex pattern "${input.pattern}": ${(err as Error).message}`,
        nodeId: 'regex-extract',
        pipelineId: context.pipelineId,
        stepIndex: context.stepIndex,
        cause: err as Error,
      });
    }
  },
};

/**
 * llm-transform node: Passes input text through an LLM with a prompt.
 * Input: { prompt: string, input: string }
 * Output: { output: string }
 *
 * Note: The actual LLM invocation is delegated to a provided handler.
 * In production, this integrates with the AgentLoopController.
 */
export const llmTransformNode: ProcessingNode<{ prompt: string; input: string }, { output: string }> = {
  id: 'llm-transform',
  name: 'LLM Transform',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      input: { type: 'string' },
    },
    required: ['prompt', 'input'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      output: { type: 'string' },
    },
    required: ['output'],
  },
  validate(input: { prompt: string; input: string }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.prompt !== 'string' || input.prompt.length === 0) {
      errors.push({
        field: 'prompt',
        message: 'prompt must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    }
    if (!input || typeof input.input !== 'string') {
      errors.push({
        field: 'input',
        message: 'input must be a string',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { prompt: string; input: string }, context: NodeContext): Promise<{ output: string }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    // In production, this would invoke the LLM via AgentLoopController.
    // For the framework implementation, we provide a placeholder that concatenates
    // prompt and input. The actual LLM handler is injected at runtime via
    // setLlmHandler() or by replacing this node with a configured version.
    if (_llmHandler) {
      try {
        const output = await _llmHandler(input.prompt, input.input, context);
        return { output };
      } catch (err) {
        throw new ProcessingNodeError({
          message: `LLM transform failed: ${(err as Error).message}`,
          nodeId: 'llm-transform',
          pipelineId: context.pipelineId,
          stepIndex: context.stepIndex,
          cause: err as Error,
        });
      }
    }
    // Default: return the input unchanged (no LLM available)
    return { output: input.input };
  },
};

/**
 * tool-invoke node: Invokes a tool by ID with parameters.
 * Input: { toolId: string, params: object }
 * Output: { result: object }
 *
 * Note: The actual tool invocation is delegated to a provided handler.
 * In production, this integrates with the ToolSystem.
 */
export const toolInvokeNode: ProcessingNode<{ toolId: string; params: object }, { result: object }> = {
  id: 'tool-invoke',
  name: 'Tool Invoke',
  inputSchema: {
    type: 'object',
    properties: {
      toolId: { type: 'string' },
      params: { type: 'object' },
    },
    required: ['toolId', 'params'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      result: { type: 'object' },
    },
    required: ['result'],
  },
  validate(input: { toolId: string; params: object }): ValidationResult {
    const errors: ValidationError[] = [];
    if (!input || typeof input.toolId !== 'string' || input.toolId.length === 0) {
      errors.push({
        field: 'toolId',
        message: 'toolId must be a non-empty string',
        code: 'INVALID_INPUT',
      });
    }
    if (!input || input.params === null || typeof input.params !== 'object') {
      errors.push({
        field: 'params',
        message: 'params must be a non-null object',
        code: 'INVALID_INPUT',
      });
    }
    return { valid: errors.length === 0, errors };
  },
  async transform(input: { toolId: string; params: object }, context: NodeContext): Promise<{ result: object }> {
    if (context.abortSignal.aborted) {
      throw new Error('Operation aborted');
    }
    if (_toolInvokeHandler) {
      try {
        const result = await _toolInvokeHandler(input.toolId, input.params, context);
        return { result };
      } catch (err) {
        throw new ProcessingNodeError({
          message: `Tool invoke "${input.toolId}" failed: ${(err as Error).message}`,
          nodeId: 'tool-invoke',
          pipelineId: context.pipelineId,
          stepIndex: context.stepIndex,
          cause: err as Error,
        });
      }
    }
    // Default: return empty result (no tool system available)
    return { result: {} };
  },
};

// ─── Runtime Handlers ───────────────────────────────────────────

type LlmHandler = (prompt: string, input: string, context: NodeContext) => Promise<string>;
type ToolInvokeHandler = (toolId: string, params: object, context: NodeContext) => Promise<object>;

let _llmHandler: LlmHandler | null = null;
let _toolInvokeHandler: ToolInvokeHandler | null = null;

/**
 * Set the LLM handler for the llm-transform node.
 * Called during application startup to inject the real LLM invocation.
 */
export function setLlmHandler(handler: LlmHandler): void {
  _llmHandler = handler;
}

/**
 * Set the tool invoke handler for the tool-invoke node.
 * Called during application startup to inject the real ToolSystem.
 */
export function setToolInvokeHandler(handler: ToolInvokeHandler): void {
  _toolInvokeHandler = handler;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * All built-in processing nodes.
 */
export const builtInNodes: ProcessingNode[] = [
  fileReadNode,
  fileWriteNode,
  jsonParseNode,
  jsonSerializeNode,
  textSplitNode,
  regexExtractNode,
  llmTransformNode,
  toolInvokeNode,
];

/**
 * Create a ProcessingNodeRegistry pre-loaded with all built-in nodes.
 */
export function createProcessingNodeRegistry(): ProcessingNodeRegistry {
  const registry = new ProcessingNodeRegistry();
  for (const node of builtInNodes) {
    registry.register(node);
  }
  return registry;
}
