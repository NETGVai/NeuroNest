/**
 * Smart Context — LLM-driven file selection and per-step context filtering.
 *
 * Exports:
 * - SmartContextSelector: Uses a lightweight LLM to identify relevant files
 *   from a project file index before the main LLM call. Enforces token budgets.
 * - SmartContextManager: Per-step context filtering for multi-step plans using
 *   database-backed keyword matching.
 *
 * Requirements: 11.1, 11.2, 11.4, 11.5
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMClient, LLMMessage } from './llm-client';

// ─── Smart Context Selector (LLM-driven) ────────────────────────────────

/** Configuration for LLM-based smart context selection */
export interface SmartContextConfig {
  projectDir: string;
  lightModel: LLMClient;        // Cheap, fast model for selection
  maxFiles: number;             // Default: 10
  maxTokenBudget: number;       // Default: 32000
}

/** Result of smart context selection */
export interface SmartContextResult {
  selectedFiles: Array<{
    path: string;
    relevanceScore: number;
    content: string;
  }>;
  totalTokens: number;
}

/**
 * SmartContextSelector — Uses a lightweight LLM to pre-select relevant project
 * files before the main reasoning call. This reduces context size and improves
 * response accuracy by focusing on semantically relevant code.
 *
 * Flow:
 * 1. Receives user message + project file index (list of paths)
 * 2. Sends a prompt to a lightweight model asking it to rank/select top files
 * 3. Parses the model's response to extract selected file paths
 * 4. Reads each selected file's content
 * 5. Enforces token budget (chars / 4 ≈ tokens)
 * 6. Returns selected files with content and estimated relevance scores
 *
 * Graceful degradation: returns empty result if model fails or returns invalid data.
 */
export class SmartContextSelector {
  private readonly config: SmartContextConfig;

  constructor(config: Partial<SmartContextConfig> & { projectDir: string; lightModel: LLMClient }) {
    this.config = {
      projectDir: config.projectDir,
      lightModel: config.lightModel,
      maxFiles: config.maxFiles ?? 10,
      maxTokenBudget: config.maxTokenBudget ?? 32000,
    };
  }

  /**
   * Select relevant files from the project file index based on the user's message.
   *
   * @param userMessage - The user's input message describing their intent
   * @param fileIndex - Array of relative file paths in the project
   * @returns SmartContextResult with selected files and their contents
   */
  async selectContext(userMessage: string, fileIndex: string[]): Promise<SmartContextResult> {
    const emptyResult: SmartContextResult = { selectedFiles: [], totalTokens: 0 };

    // Guard: nothing to select from
    if (!fileIndex || fileIndex.length === 0 || !userMessage.trim()) {
      return emptyResult;
    }

    try {
      // Ask the lightweight model to select relevant files
      const selectedPaths = await this.askModelForFiles(userMessage, fileIndex);

      if (!selectedPaths || selectedPaths.length === 0) {
        return emptyResult;
      }

      // Read file contents and enforce token budget
      return await this.readSelectedFiles(selectedPaths);
    } catch (error) {
      // Graceful degradation: if anything fails, return empty result
      console.error('[SmartContext] Selection failed, returning empty result:', error);
      return emptyResult;
    }
  }

  /**
   * Sends the file list and user message to the lightweight model, asking it
   * to rank and select the most relevant files.
   */
  private async askModelForFiles(userMessage: string, fileIndex: string[]): Promise<string[]> {
    const fileListText = fileIndex.join('\n');

    const systemPrompt = `You are a file relevance selector. Given a user's message and a list of project files, select the top ${this.config.maxFiles} most relevant files that would help answer the user's question or complete their task.

Respond ONLY with a JSON array of objects, each with "path" (string) and "score" (number 0-1 indicating relevance). Example:
[{"path": "src/utils/helper.ts", "score": 0.95}, {"path": "src/config/index.ts", "score": 0.7}]

Rules:
- Select at most ${this.config.maxFiles} files
- Only select files from the provided list
- Score from 0.0 (barely relevant) to 1.0 (highly relevant)
- Focus on files that directly relate to the user's intent
- Return an empty array [] if no files are relevant`;

    const userPrompt = `User message: "${userMessage}"

Project files:
${fileListText}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const response = await this.config.lightModel.chat(messages, {
      temperature: 0.1,
      maxTokens: 1024,
    });

    return this.parseModelResponse(response.content, fileIndex);
  }

  /**
   * Parses the model's JSON response to extract file paths and scores.
   * Validates that returned paths exist in the file index.
   */
  parseModelResponse(responseContent: string, fileIndex: string[]): string[] {
    if (!responseContent || !responseContent.trim()) {
      return [];
    }

    try {
      // Extract JSON array from the response (model might include extra text)
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return [];
      }

      // Create a set for O(1) lookups
      const fileSet = new Set(fileIndex);

      // Filter valid entries: must have path in file index, valid score
      const validEntries = parsed
        .filter((entry: any) =>
          entry &&
          typeof entry.path === 'string' &&
          fileSet.has(entry.path) &&
          typeof entry.score === 'number' &&
          entry.score >= 0 &&
          entry.score <= 1
        )
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, this.config.maxFiles);

      return validEntries.map((entry: any) => entry.path);
    } catch {
      // JSON parse failed — return empty
      return [];
    }
  }

  /**
   * Reads the content of selected files, enforcing the token budget.
   * Stops adding files once the estimated token count exceeds maxTokenBudget.
   * Estimates ~4 chars per token.
   */
  private async readSelectedFiles(filePaths: string[]): Promise<SmartContextResult> {
    const CHARS_PER_TOKEN = 4;
    const maxChars = this.config.maxTokenBudget * CHARS_PER_TOKEN;
    let totalChars = 0;
    const selectedFiles: SmartContextResult['selectedFiles'] = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const absolutePath = path.resolve(this.config.projectDir, filePath);

      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        const fileChars = content.length;

        // Check if adding this file would exceed budget
        if (totalChars + fileChars > maxChars) {
          // If we haven't added any files yet, add a truncated version of the first file
          if (selectedFiles.length === 0) {
            const truncatedContent = content.slice(0, maxChars);
            selectedFiles.push({
              path: filePath,
              relevanceScore: 1.0 - (i * 0.1),
              content: truncatedContent,
            });
            totalChars += truncatedContent.length;
          }
          // Stop adding more files — budget exceeded
          break;
        }

        selectedFiles.push({
          path: filePath,
          relevanceScore: Math.max(0.1, 1.0 - (i * 0.1)),
          content,
        });
        totalChars += fileChars;
      } catch {
        // Skip files that can't be read (deleted, permissions, etc.)
        continue;
      }
    }

    return {
      selectedFiles,
      totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    };
  }
}

export interface ContextSelection {
  id: string;
  sessionId: string;
  stepNum: number;
  selectedFiles: string[];
  totalTokens: number;
  reason?: string;
  createdAt: string;
}

export class SmartContextManager {
  constructor(private db: Database.Database) {}

  /** Record which files were selected for a given step */
  recordSelection(sessionId: string, stepNum: number, files: string[], totalTokens: number, reason?: string): ContextSelection {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO context_selections (id, session_id, step_num, selected_files, total_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, sessionId, stepNum, JSON.stringify(files), totalTokens, reason || null, now);
    return { id, sessionId, stepNum, selectedFiles: files, totalTokens, reason, createdAt: now };
  }

  /** Get all context selections for a session */
  getSelections(sessionId: string): ContextSelection[] {
    return (this.db.prepare(
      'SELECT * FROM context_selections WHERE session_id = ? ORDER BY step_num ASC'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id, sessionId: r.session_id, stepNum: r.step_num,
      selectedFiles: JSON.parse(r.selected_files || '[]'),
      totalTokens: r.total_tokens, reason: r.reason || undefined,
      createdAt: r.created_at,
    }));
  }

  /** Get the latest context selection for a session */
  getLatest(sessionId: string): ContextSelection | null {
    const row = this.db.prepare(
      'SELECT * FROM context_selections WHERE session_id = ? ORDER BY step_num DESC LIMIT 1'
    ).get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id, sessionId: row.session_id, stepNum: row.step_num,
      selectedFiles: JSON.parse(row.selected_files || '[]'),
      totalTokens: row.total_tokens, reason: row.reason || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * Select relevant files for a step based on the task description.
   * Uses keyword matching against file paths and content summaries.
   * In production, this would use the LLM + project map for selection.
   */
  selectFilesForStep(allFiles: string[], taskDescription: string, maxTokenBudget: number): string[] {
    if (!taskDescription || allFiles.length === 0) return allFiles;

    const keywords = taskDescription.toLowerCase()
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (keywords.length === 0) return allFiles;

    // Score each file by keyword relevance
    const scored = allFiles.map(file => {
      const fileLower = file.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (fileLower.includes(kw)) score += 2;
        // Boost for exact filename matches
        const fileName = fileLower.split('/').pop() || '';
        if (fileName.includes(kw)) score += 3;
      }
      return { file, score };
    });

    // Sort by relevance and take top files within token budget
    scored.sort((a, b) => b.score - a.score);

    // Estimate ~500 tokens per file on average
    const maxFiles = Math.max(5, Math.floor(maxTokenBudget / 500));
    const selected = scored
      .filter(s => s.score > 0)
      .slice(0, maxFiles)
      .map(s => s.file);

    // Always include at least the top 3 files even if no keyword match
    if (selected.length < 3) {
      for (const s of scored) {
        if (!selected.includes(s.file)) {
          selected.push(s.file);
          if (selected.length >= 3) break;
        }
      }
    }

    return selected;
  }

  /** Get context usage stats for a session */
  getStats(sessionId: string): { totalSteps: number; avgFiles: number; avgTokens: number; peakTokens: number } {
    const selections = this.getSelections(sessionId);
    if (selections.length === 0) return { totalSteps: 0, avgFiles: 0, avgTokens: 0, peakTokens: 0 };

    const totalFiles = selections.reduce((s, c) => s + c.selectedFiles.length, 0);
    const totalTokens = selections.reduce((s, c) => s + c.totalTokens, 0);
    const peakTokens = Math.max(...selections.map(c => c.totalTokens));

    return {
      totalSteps: selections.length,
      avgFiles: Math.round(totalFiles / selections.length),
      avgTokens: Math.round(totalTokens / selections.length),
      peakTokens,
    };
  }
}
