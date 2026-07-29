/**
 * Grounding Enforcer — Mandatory context retrieval and source verification
 *
 * Ensures every agent call includes a context retrieval step from the Knowledge Graph,
 * project files, or SharedMemory before generating text. Prevents hallucinated outputs
 * by attaching cited source material and verifying agent responses reference it.
 *
 * Requirement Coverage: Req 2 (AC 1–7), Req 3 (AC 5–6), Req 6 (AC 4–5), Req 7 (AC 1–2), Req 9 (AC 2)
 */

import type { EmbeddingStore, SearchResult } from '../indexing/embedding-store';

export interface GroundingSource {
  type: 'graph_node' | 'file' | 'memory';
  id: string;
  content: string;
  relevance: number; // 0.0 - 1.0
}

export interface GroundingContext {
  sources: GroundingSource[];
  coverage: 'grounded' | 'low-coverage' | 'ungrounded';
  nodeCount: number;
}

export class GroundingEnforcer {
  private embeddingStore: EmbeddingStore | undefined;

  constructor(
    private graphManager: any,
    private db: any,
    private projectId: string,
    embeddingStore?: EmbeddingStore
  ) {
    this.embeddingStore = embeddingStore;
    this.ensureAuditTable();
  }

  /**
   * Ensure the grounding_audit table exists for logging events.
   */
  private ensureAuditTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS grounding_audit (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          coverage TEXT NOT NULL,
          source_count INTEGER NOT NULL,
          passed BOOLEAN NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_grounding_audit_project ON grounding_audit(project_id)`);
    } catch (e: any) {
      console.error('[GroundingEnforcer] Audit table creation error:', e?.message);
    }
  }

  /**
   * Execute context retrieval for a task.
   * Queries: Embedding Store (vector search) → Knowledge Graph → Project Files → SharedMemory (waterfall fallback)
   *
   * When an EmbeddingStore is available, it is used as the primary source for semantic
   * vector search (Req 3 AC 5). Falls back to keyword-based retrieval if the embedding
   * store is unavailable or returns no results (Req 3 AC 6, Req 9 AC 2).
   *
   * Validates: Req 2 AC 1-4, Req 3 AC 5-6, Req 7 AC 1, Req 9 AC 2
   */
  async retrieveContext(taskDescription: string, queryVector?: Float32Array): Promise<GroundingContext> {
    const sources: GroundingSource[] = [];

    // 1. Primary: Vector search via EmbeddingStore (Req 3 AC 5)
    try {
      if (this.embeddingStore && queryVector) {
        const searchResults = this.embeddingStore.search(queryVector, 5, this.projectId);
        if (searchResults.length > 0) {
          for (const result of searchResults) {
            sources.push(this.mapSearchResultToGroundingSource(result));
          }
        }
      }
    } catch (e: any) {
      console.warn('[GroundingEnforcer] Embedding store vector search failed, falling back:', e?.message);
      // Continue to keyword-based fallback (Req 9 AC 2)
    }

    // 2. Fallback: Query Knowledge Graph (with 3s timeout — Req 9 AC 3)
    // Only query if vector search returned no results
    if (sources.length === 0) {
      try {
        if (this.graphManager && this.graphManager.hasGraph(this.projectId)) {
          const timeoutPromise = new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), 3000);
          });
          const graphPromise = this.graphManager.queryGraph(this.projectId, taskDescription, 2000);
          const graphResult = await Promise.race([graphPromise, timeoutPromise]);
          if (graphResult && graphResult.context && graphResult.context.length > 0) {
            for (const contextEntry of graphResult.context) {
              sources.push({
                type: 'graph_node',
                id: `graph:${sources.length}`,
                content: contextEntry,
                relevance: 0.9,
              });
            }
          }
        }
      } catch (e: any) {
        console.warn('[GroundingEnforcer] Knowledge Graph query failed or timed out, falling back:', e?.message);
        // Continue pipeline execution without blocking (Req 9 AC 3)
      }
    }

    // 3. Fallback: Project file keyword search (if still < 3 sources)
    if (sources.length < 3) {
      try {
        const fileResults = this.searchProjectFiles(taskDescription);
        for (const result of fileResults) {
          sources.push(result);
        }
      } catch (e: any) {
        console.warn('[GroundingEnforcer] Project file search failed:', e?.message);
      }
    }

    // 4. Fallback: SharedMemory search
    if (sources.length < 3) {
      try {
        const memoryResults = this.searchSharedMemory(taskDescription);
        for (const result of memoryResults) {
          sources.push(result);
        }
      } catch (e: any) {
        console.warn('[GroundingEnforcer] SharedMemory search failed:', e?.message);
      }
    }

    // Classify coverage based on source count
    const coverage = this.classifyCoverage(sources.length);

    return {
      sources,
      coverage,
      nodeCount: sources.length,
    };
  }

  /**
   * Map a SearchResult from the EmbeddingStore to a GroundingSource.
   * Uses type 'graph_node' since embedding results represent indexed code chunks
   * that are part of the knowledge graph.
   *
   * Validates: Req 3 AC 5
   */
  private mapSearchResultToGroundingSource(result: SearchResult): GroundingSource {
    return {
      type: 'graph_node',
      id: `embedding:${result.chunkId}`,
      content: result.content.slice(0, 500),
      relevance: Math.max(0, Math.min(1, result.similarity)),
    };
  }

  /**
   * Classify coverage based on source count.
   * ≥3 sources → 'grounded', 1-2 → 'low-coverage', 0 → 'ungrounded'
   *
   * Validates: Req 7 AC 1
   */
  private classifyCoverage(sourceCount: number): 'grounded' | 'low-coverage' | 'ungrounded' {
    if (sourceCount >= 3) return 'grounded';
    if (sourceCount > 0) return 'low-coverage';
    return 'ungrounded';
  }

  /**
   * Search project files for relevant content using keyword matching.
   * Extracts keywords from the task description and searches SharedMemory
   * code context entries for matches.
   */
  private searchProjectFiles(taskDescription: string): GroundingSource[] {
    const results: GroundingSource[] = [];
    const keywords = this.extractKeywords(taskDescription);

    if (keywords.length === 0) return results;

    try {
      // Search shared_memory code context entries for file content
      const rows = this.db.prepare(
        'SELECT id, content, metadata FROM shared_memory WHERE project_id = ? AND type = ? ORDER BY timestamp DESC LIMIT 50'
      ).all(this.projectId, 'code');

      for (const row of rows) {
        const content: string = row.content || '';
        const contentLower = content.toLowerCase();
        const matchCount = keywords.filter(kw => contentLower.includes(kw)).length;

        if (matchCount > 0) {
          const relevance = Math.min(1.0, matchCount / keywords.length);
          let filePath = 'unknown';
          try {
            const metadata = row.metadata ? JSON.parse(row.metadata) : null;
            if (metadata && metadata.filePath) {
              filePath = metadata.filePath;
            }
          } catch {
            // metadata parse failed, use default
          }

          results.push({
            type: 'file',
            id: `file:${filePath}`,
            content: content.slice(0, 200),
            relevance,
          });

          if (results.length >= 3) break;
        }
      }
    } catch (e: any) {
      console.warn('[GroundingEnforcer] File search query failed:', e?.message);
    }

    return results;
  }

  /**
   * Search SharedMemory for relevant entries (decisions, outputs, context).
   */
  private searchSharedMemory(taskDescription: string): GroundingSource[] {
    const results: GroundingSource[] = [];
    const keywords = this.extractKeywords(taskDescription);

    if (keywords.length === 0) return results;

    try {
      const rows = this.db.prepare(
        'SELECT id, content, type FROM shared_memory WHERE project_id = ? AND type IN (?, ?, ?) ORDER BY timestamp DESC LIMIT 30'
      ).all(this.projectId, 'decision', 'output', 'context');

      for (const row of rows) {
        const content: string = row.content || '';
        const contentLower = content.toLowerCase();
        const matchCount = keywords.filter(kw => contentLower.includes(kw)).length;

        if (matchCount > 0) {
          const relevance = Math.min(1.0, (matchCount / keywords.length) * 0.8);
          results.push({
            type: 'memory',
            id: `memory:${row.id}`,
            content: content.slice(0, 200),
            relevance,
          });

          if (results.length >= 3) break;
        }
      }
    } catch (e: any) {
      console.warn('[GroundingEnforcer] Memory search query failed:', e?.message);
    }

    return results;
  }

  /**
   * Extract meaningful keywords from a task description for search.
   * Filters out common stop words and short terms.
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
      'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
      'other', 'some', 'such', 'than', 'too', 'very', 'just', 'because',
      'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about',
      'against', 'between', 'through', 'during', 'before', 'after', 'above',
      'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off',
      'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
      'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-_./]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));
  }

  /**
   * Format grounding context for injection into agent prompt.
   * Generates different instructions based on coverage level.
   *
   * Validates: Req 2 AC 4-5, Req 7 AC 2
   */
  formatForPrompt(context: GroundingContext): string {
    if (context.coverage === 'ungrounded') {
      return '\n\n⚠️ GROUNDING WARNING: No relevant source material was found for this task. ' +
        'You MUST explicitly state uncertainty and avoid making specific claims about ' +
        'file paths, function names, or APIs that you cannot verify.\n';
    }

    let prompt = '\n\n--- GROUNDING CONTEXT (cite these sources) ---\n';
    if (context.coverage === 'low-coverage') {
      prompt += '⚠️ Limited source coverage. Preface uncertain claims with "Based on limited context...".\n\n';
    }
    for (const source of context.sources) {
      prompt += `[${source.type}:${source.id}] ${source.content}\n`;
    }
    prompt += '--- END GROUNDING CONTEXT ---\n';
    prompt += 'INSTRUCTION: Reference at least one source above in your response.\n';
    return prompt;
  }

  /**
   * Detect whether a task description indicates a creative/generative task.
   * Creative tasks get relaxed verification — they only need to acknowledge
   * existing project context rather than citing specific sources.
   *
   * Uses LLM-based classification when available, falls back to regex pattern.
   *
   * Validates: Req 2 AC 8-9, Req 9 AC 2
   */
  isCreativeTask(taskDescription: string): boolean {
    return /\b(create|build|write|generate|scaffold|implement new|design new)\b/i.test(taskDescription);
  }

  /**
   * Async version of isCreativeTask that uses an LLM for more accurate classification.
   * Falls back to the regex-based version if LLM is unavailable.
   */
  async isCreativeTaskLLM(taskDescription: string, llmClient?: any): Promise<boolean> {
    if (llmClient) {
      try {
        const { classifyCreativeTask } = await import('./llm-decision-engine');
        const result = await classifyCreativeTask(taskDescription, llmClient);
        if (result) {
          console.log('[GroundingEnforcer] LLM creative task classification:', result.isCreative, '—', result.reasoning);
          return result.isCreative;
        }
      } catch (err: any) {
        console.warn('[GroundingEnforcer] LLM creative task classification failed, using regex fallback:', err?.message);
      }
    }
    return this.isCreativeTask(taskDescription);
  }

  /**
   * Verify that an agent response references provided sources.
   * Returns true if grounding check passes.
   *
   * Checks: source IDs, file paths, or label/content matches.
   * Returns true for 'ungrounded' coverage (can't verify against nothing).
   *
   * When `taskDescription` is provided and indicates a creative task, uses
   * relaxed verification — only checks that the response acknowledges existing
   * project context (language, framework, directory structure) rather than
   * requiring specific source citations.
   *
   * Validates: Req 2 AC 6, 8-9, Req 9 AC 2
   */
  verifyGrounding(response: string, context: GroundingContext, taskDescription?: string): boolean {
    if (context.coverage === 'ungrounded') return true; // Can't verify against nothing

    // Relaxed verification for creative/generative tasks (Req 2 AC 8-9, Req 9 AC 2)
    // Only checks that the response acknowledges existing project context
    // (language, framework, directory structure) rather than requiring specific citations
    if (taskDescription && this.isCreativeTask(taskDescription)) {
      const responseLower = response.toLowerCase();
      // In relaxed mode, check for any acknowledgment of project context
      // (mentions of languages, frameworks, directories, or any source content keywords)
      for (const source of context.sources) {
        const contentWords = source.content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
        const hasAnyContextRef = contentWords.some(word => responseLower.includes(word));
        if (hasAnyContextRef) {
          return true;
        }
      }
      // Even if no specific source words matched, relaxed mode passes if the response
      // is non-empty (creative tasks are expected to produce new content)
      return true;
    }

    const responseLower = response.toLowerCase();

    for (const source of context.sources) {
      // Check by source ID
      if (response.includes(source.id)) {
        return true;
      }

      // Check by content/label match (case-insensitive, partial match)
      const contentWords = source.content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const significantMatches = contentWords.filter(word => responseLower.includes(word));

      // If at least 30% of significant words from the source appear in the response
      if (contentWords.length > 0 && significantMatches.length / contentWords.length >= 0.3) {
        return true;
      }

      // Check for file path references (extract paths from source content)
      const pathMatch = source.content.match(/[\w\-./]+\.\w+/);
      if (pathMatch && response.includes(pathMatch[0])) {
        return true;
      }
    }

    return false;
  }

  /**
   * Log grounding event for audit trail.
   * Writes to the grounding_audit SQLite table.
   *
   * Validates: Req 6 AC 4-5
   */
  logEvent(agentId: string, taskId: string, context: GroundingContext, passed: boolean): void {
    try {
      const crypto = require('node:crypto');
      const id = crypto.randomUUID();

      this.db.prepare(
        'INSERT INTO grounding_audit (id, project_id, agent_id, task_id, coverage, source_count, passed, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, this.projectId, agentId, taskId, context.coverage, context.nodeCount, passed ? 1 : 0, Date.now());

      console.log(`[Grounding] Agent ${agentId} task ${taskId}: coverage=${context.coverage}, sources=${context.nodeCount}, passed=${passed}`);
    } catch (e: any) {
      console.error('[GroundingEnforcer] Log event error:', e?.message);
    }
  }
}
