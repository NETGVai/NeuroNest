/**
 * NotebookService — Notebook CRUD and cell execution.
 *
 * Creates/opens standard .ipynb files compatible with Jupyter.
 * Manages cells (markdown, code) with add/edit/delete/execute operations.
 * Captures cell outputs: text, images (base64), tables, error tracebacks.
 * Exposes agent tools: notebook_create, notebook_add_cell, notebook_run_cell, notebook_get_output.
 *
 * Requirements: 20.1, 20.3, 20.4, 20.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { KernelManager, type KernelLanguage, type CellOutput, type ExecutionResult } from './kernel-manager';

// ─── .ipynb Format Types ────────────────────────────────────────

export interface IpynbNotebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: {
    kernelspec: {
      display_name: string;
      language: string;
      name: string;
    };
    language_info: {
      name: string;
      version?: string;
    };
  };
  cells: IpynbCell[];
}

export interface IpynbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  id: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: IpynbOutput[];
  execution_count?: number | null;
}

export interface IpynbOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: string[];
  data?: Record<string, string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

// ─── Service Types ──────────────────────────────────────────────

export interface NotebookInfo {
  id: string;
  name: string;
  path: string;
  language: KernelLanguage;
  cellCount: number;
  createdAt: number;
  modifiedAt: number;
}

export interface CellInfo {
  id: string;
  type: 'code' | 'markdown';
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
}

// ─── NotebookService ────────────────────────────────────────────

/**
 * Singleton service for notebook CRUD and execution.
 * Lazy-initialized following NeuroNest's established patterns.
 */
export class NotebookService {
  private static instance: NotebookService | null = null;

  private readonly openNotebooks = new Map<string, { notebook: IpynbNotebook; filePath: string; language: KernelLanguage }>();
  private readonly kernelManager: KernelManager;

  private constructor() {
    this.kernelManager = KernelManager.getInstance();
  }

  /** Lazy singleton accessor */
  static getInstance(): NotebookService {
    if (!NotebookService.instance) {
      NotebookService.instance = new NotebookService();
    }
    return NotebookService.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    NotebookService.instance = null;
  }

  // ─── Notebook CRUD ────────────────────────────────────────────

  /**
   * Create a new .ipynb notebook file.
   */
  createNotebook(name: string, directory: string, language: KernelLanguage = 'python'): NotebookInfo {
    const fileName = name.endsWith('.ipynb') ? name : `${name}.ipynb`;
    const filePath = path.join(directory, fileName);

    // Ensure directory exists
    fs.mkdirSync(directory, { recursive: true });

    const kernelspec = this.getKernelSpec(language);
    const notebook: IpynbNotebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec,
        language_info: {
          name: language,
        },
      },
      cells: [],
    };

    fs.writeFileSync(filePath, JSON.stringify(notebook, null, 2), 'utf-8');

    const id = crypto.randomUUID();
    this.openNotebooks.set(id, { notebook, filePath, language });

    return {
      id,
      name: fileName,
      path: filePath,
      language,
      cellCount: 0,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    };
  }

  /**
   * Open an existing .ipynb file.
   */
  openNotebook(filePath: string): NotebookInfo {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Notebook not found: ${filePath}`);
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const notebook: IpynbNotebook = JSON.parse(raw);

    // Validate basic structure
    if (!notebook.nbformat || !notebook.cells) {
      throw new Error(`Invalid .ipynb format: ${filePath}`);
    }

    const language = (notebook.metadata?.kernelspec?.language || notebook.metadata?.language_info?.name || 'python') as KernelLanguage;
    const id = crypto.randomUUID();

    this.openNotebooks.set(id, { notebook, filePath: resolvedPath, language });

    const stat = fs.statSync(resolvedPath);

    return {
      id,
      name: path.basename(resolvedPath),
      path: resolvedPath,
      language,
      cellCount: notebook.cells.length,
      createdAt: stat.birthtimeMs,
      modifiedAt: stat.mtimeMs,
    };
  }

  /**
   * Close a notebook and shut down its kernel.
   */
  async closeNotebook(notebookId: string): Promise<void> {
    await this.kernelManager.shutdownKernel(notebookId);
    this.openNotebooks.delete(notebookId);
  }

  /**
   * Save the notebook to disk.
   */
  saveNotebook(notebookId: string): void {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    fs.writeFileSync(entry.filePath, JSON.stringify(entry.notebook, null, 2), 'utf-8');
  }

  // ─── Cell Operations ──────────────────────────────────────────

  /**
   * Add a cell to the notebook.
   */
  addCell(notebookId: string, type: 'code' | 'markdown', source: string, position?: number): CellInfo {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    const cellId = crypto.randomUUID().slice(0, 8);
    const cell: IpynbCell = {
      cell_type: type,
      id: cellId,
      source: source.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line),
      metadata: {},
      ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
    };

    if (position !== undefined && position >= 0 && position <= entry.notebook.cells.length) {
      entry.notebook.cells.splice(position, 0, cell);
    } else {
      entry.notebook.cells.push(cell);
    }

    this.saveNotebook(notebookId);

    return {
      id: cellId,
      type,
      source,
      outputs: [],
      executionCount: null,
    };
  }

  /**
   * Edit an existing cell's source.
   */
  editCell(notebookId: string, cellId: string, source: string): CellInfo {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    const cell = entry.notebook.cells.find((c) => c.id === cellId);
    if (!cell) throw new Error(`Cell not found: ${cellId}`);

    cell.source = source.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line);

    this.saveNotebook(notebookId);

    return {
      id: cellId,
      type: cell.cell_type as 'code' | 'markdown',
      source,
      outputs: this.convertOutputs(cell.outputs || []),
      executionCount: cell.execution_count ?? null,
    };
  }

  /**
   * Delete a cell from the notebook.
   */
  deleteCell(notebookId: string, cellId: string): boolean {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    const idx = entry.notebook.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return false;

    entry.notebook.cells.splice(idx, 1);
    this.saveNotebook(notebookId);
    return true;
  }

  /**
   * Get all cells in a notebook.
   */
  getCells(notebookId: string): CellInfo[] {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    return entry.notebook.cells.map((cell) => ({
      id: cell.id,
      type: cell.cell_type as 'code' | 'markdown',
      source: cell.source.join(''),
      outputs: this.convertOutputs(cell.outputs || []),
      executionCount: cell.execution_count ?? null,
    }));
  }

  // ─── Cell Execution ───────────────────────────────────────────

  /**
   * Execute a code cell and capture its output.
   */
  async runCell(notebookId: string, cellId: string): Promise<ExecutionResult> {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    const cell = entry.notebook.cells.find((c) => c.id === cellId);
    if (!cell) throw new Error(`Cell not found: ${cellId}`);
    if (cell.cell_type !== 'code') {
      return { success: true, outputs: [], executionCount: 0, durationMs: 0 };
    }

    const code = cell.source.join('');
    const cwd = path.dirname(entry.filePath);

    const result = await this.kernelManager.executeCode(notebookId, code, entry.language, cwd);

    // Update cell with execution results
    cell.execution_count = result.executionCount;
    cell.outputs = this.toIpynbOutputs(result.outputs);

    this.saveNotebook(notebookId);

    return result;
  }

  /**
   * Get the output of a specific cell.
   */
  getCellOutput(notebookId: string, cellId: string): CellOutput[] {
    const entry = this.openNotebooks.get(notebookId);
    if (!entry) throw new Error(`Notebook not open: ${notebookId}`);

    const cell = entry.notebook.cells.find((c) => c.id === cellId);
    if (!cell) throw new Error(`Cell not found: ${cellId}`);

    return this.convertOutputs(cell.outputs || []);
  }

  // ─── Agent Tools ──────────────────────────────────────────────

  /**
   * Get tool definitions for agent integration.
   * Returns tool definitions compatible with the NeuroNest tool system.
   */
  getAgentToolDefinitions(): Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    riskLevel: string;
  }> {
    return [
      {
        id: 'notebook_create',
        name: 'NotebookCreate',
        description: 'Create a new Jupyter-compatible notebook (.ipynb) in the project',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Notebook filename (without extension)' },
            language: { type: 'string', description: 'Kernel language: python, javascript, or r', enum: ['python', 'javascript', 'r'] },
            directory: { type: 'string', description: 'Directory to create the notebook in (relative to project root)' },
          },
          required: ['name'],
        },
        riskLevel: 'write',
      },
      {
        id: 'notebook_add_cell',
        name: 'NotebookAddCell',
        description: 'Add a code or markdown cell to an open notebook',
        inputSchema: {
          type: 'object',
          properties: {
            notebookId: { type: 'string', description: 'ID of the open notebook' },
            type: { type: 'string', description: 'Cell type: code or markdown', enum: ['code', 'markdown'] },
            source: { type: 'string', description: 'Cell content (code or markdown text)' },
            position: { type: 'number', description: 'Insert position (0-indexed). Appends if omitted.' },
          },
          required: ['notebookId', 'type', 'source'],
        },
        riskLevel: 'write',
      },
      {
        id: 'notebook_run_cell',
        name: 'NotebookRunCell',
        description: 'Execute a code cell in the notebook kernel and capture output',
        inputSchema: {
          type: 'object',
          properties: {
            notebookId: { type: 'string', description: 'ID of the open notebook' },
            cellId: { type: 'string', description: 'ID of the cell to execute' },
          },
          required: ['notebookId', 'cellId'],
        },
        riskLevel: 'execute',
      },
      {
        id: 'notebook_get_output',
        name: 'NotebookGetOutput',
        description: 'Get the execution output of a notebook cell',
        inputSchema: {
          type: 'object',
          properties: {
            notebookId: { type: 'string', description: 'ID of the open notebook' },
            cellId: { type: 'string', description: 'ID of the cell to get output for' },
          },
          required: ['notebookId', 'cellId'],
        },
        riskLevel: 'read-only',
      },
    ];
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private getKernelSpec(language: KernelLanguage): { display_name: string; language: string; name: string } {
    switch (language) {
      case 'python':
        return { display_name: 'Python 3', language: 'python', name: 'python3' };
      case 'javascript':
        return { display_name: 'JavaScript (Node.js)', language: 'javascript', name: 'javascript' };
      case 'r':
        return { display_name: 'R', language: 'r', name: 'ir' };
      default:
        return { display_name: 'Python 3', language: 'python', name: 'python3' };
    }
  }

  private toIpynbOutputs(outputs: CellOutput[]): IpynbOutput[] {
    return outputs.map((output) => {
      switch (output.type) {
        case 'text':
          return {
            output_type: 'stream' as const,
            name: 'stdout',
            text: output.content.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l),
          };
        case 'image':
          return {
            output_type: 'display_data' as const,
            data: { [output.mimeType || 'image/png']: [output.content] },
            metadata: {},
          };
        case 'table':
          return {
            output_type: 'execute_result' as const,
            data: { 'text/plain': output.content.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l) },
            metadata: {},
            execution_count: null,
          };
        case 'error':
          return {
            output_type: 'error' as const,
            ename: 'Error',
            evalue: output.content.split('\n')[0] || 'Unknown error',
            traceback: output.content.split('\n'),
          };
        default:
          return {
            output_type: 'stream' as const,
            name: 'stdout',
            text: [output.content],
          };
      }
    });
  }

  private convertOutputs(ipynbOutputs: IpynbOutput[]): CellOutput[] {
    return ipynbOutputs.map((output) => {
      switch (output.output_type) {
        case 'stream':
          return { type: 'text' as const, content: (output.text || []).join('') };
        case 'display_data':
        case 'execute_result': {
          const data = output.data || {};
          // Check for images
          for (const mime of ['image/png', 'image/jpeg', 'image/svg+xml']) {
            if (data[mime]) {
              return { type: 'image' as const, content: data[mime].join(''), mimeType: mime };
            }
          }
          // Text fallback
          if (data['text/plain']) {
            return { type: 'text' as const, content: data['text/plain'].join('') };
          }
          return { type: 'text' as const, content: JSON.stringify(data) };
        }
        case 'error':
          return {
            type: 'error' as const,
            content: (output.traceback || [output.evalue || 'Unknown error']).join('\n'),
          };
        default:
          return { type: 'text' as const, content: '' };
      }
    });
  }
}
