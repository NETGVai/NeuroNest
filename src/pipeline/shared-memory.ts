/**
 * SharedMemory — persistent cross-agent memory for a project.
 * Stores conversation history, agent outputs, code context, and decisions.
 * Persisted to SQLite so it survives restarts and works across all providers/models.
 */

export interface MemoryEntry {
  id: string;
  projectId: string;
  agentId: string;
  type: 'message' | 'code' | 'decision' | 'context' | 'output';
  content: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export class SharedMemory {
  private db: any;
  private projectId: string;

  constructor(db: any, projectId: string) {
    this.db = db;
    this.projectId = projectId;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shared_memory (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          timestamp INTEGER NOT NULL
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_project ON shared_memory(project_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_agent ON shared_memory(project_id, agent_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_type ON shared_memory(project_id, type)`);
    } catch (e: any) {
      console.error('[SharedMemory] Table creation error:', e?.message);
    }
  }

  /** Store a memory entry. If metadata includes primaryTruth: true, the entry is preserved during summarization. */
  store(entry: Omit<MemoryEntry, 'id' | 'projectId' | 'timestamp'>): void {
    const id = require('node:crypto').randomUUID();
    try {
      // If primaryTruth flag is set in metadata, ensure it's preserved in stored metadata
      let metadata = entry.metadata;
      if (metadata && metadata['primaryTruth']) {
        metadata = { ...metadata, primaryTruth: true };
      }
      this.db.prepare(
        'INSERT INTO shared_memory (id, project_id, agent_id, type, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, this.projectId, entry.agentId, entry.type, entry.content, metadata ? JSON.stringify(metadata) : null, Date.now());
    } catch (e: any) {
      console.error('[SharedMemory] Store error:', e?.message);
    }
  }

  /** Get all memory for this project, optionally filtered */
  getAll(opts?: { type?: string; agentId?: string; limit?: number }): MemoryEntry[] {
    try {
      let sql = 'SELECT * FROM shared_memory WHERE project_id = ?';
      const params: any[] = [this.projectId];
      if (opts?.type) { sql += ' AND type = ?'; params.push(opts.type); }
      if (opts?.agentId) { sql += ' AND agent_id = ?'; params.push(opts.agentId); }
      sql += ' ORDER BY timestamp DESC';
      if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r: any) => ({
        id: r.id,
        projectId: r.project_id,
        agentId: r.agent_id,
        type: r.type,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        timestamp: r.timestamp,
      }));
    } catch (e: any) {
      console.error('[SharedMemory] GetAll error:', e?.message);
      return [];
    }
  }

  /** Get recent conversation context as a formatted string for LLM injection */
  getContextString(maxEntries: number = 20): string {
    const entries = this.getAll({ limit: maxEntries });
    if (entries.length === 0) return '';
    const lines = entries.reverse().map(e => {
      const agent = e.agentId || 'system';
      const prefix = e.type === 'code' ? '[CODE]' : e.type === 'decision' ? '[DECISION]' : e.type === 'context' ? '[CONTEXT]' : '';
      return `[${agent}] ${prefix} ${e.content.slice(0, 500)}`;
    });
    return '--- Shared Memory (recent) ---\n' + lines.join('\n') + '\n--- End Shared Memory ---';
  }

  /** Store an agent's output for other agents to reference */
  storeAgentOutput(agentId: string, output: string): void {
    this.store({ agentId, type: 'output', content: output });
  }

  /** Store a decision made during orchestration */
  storeDecision(agentId: string, decision: string): void {
    this.store({ agentId, type: 'decision', content: decision });
  }

  /** Store code context (file contents) */
  storeCodeContext(filePath: string, content: string): void {
    this.store({ agentId: 'system', type: 'code', content: `File: ${filePath}\n${content}`, metadata: { filePath } });
  }

  /** Get all code context entries */
  getCodeContext(): MemoryEntry[] {
    return this.getAll({ type: 'code' });
  }

  /** Clear all memory for this project, preserving primary_truth entries */
  clear(): void {
    try {
      // Preserve entries flagged as primaryTruth during clear/summarization
      this.db.prepare(
        "DELETE FROM shared_memory WHERE project_id = ? AND (metadata IS NULL OR json_extract(metadata, '$.primaryTruth') IS NOT 1)"
      ).run(this.projectId);
    } catch (e: any) {
      // Fallback: if json_extract is not supported, clear all (backward compat)
      try {
        this.db.prepare('DELETE FROM shared_memory WHERE project_id = ?').run(this.projectId);
      } catch (e2: any) {
        console.error('[SharedMemory] Clear error:', e2?.message);
      }
    }
  }
}
