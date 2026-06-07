/**
 * Project Learning Memory — gstack-inspired /learn feature.
 *
 * Stores per-project patterns the agent discovers (e.g., "this project uses
 * Zod for validation", "tests go in tests/ not __tests__/") and injects
 * them into future prompts. Compounds over sessions.
 *
 * Memories decay 5% per week to prevent stale patterns from dominating.
 * Primary truth entries (from steering files) are exempt from decay.
 */

import { MemoryTruthGate } from './memory-truth-gate.js';

export interface ProjectMemory {
  id: string;
  projectId: string;
  category: 'pattern' | 'preference' | 'pitfall' | 'convention' | 'dependency';
  content: string;
  confidence: number; // 0-1, decays over time
  source: string; // How this was learned (e.g., 'user correction', 'code analysis', 'test failure')
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

export class ProjectMemoryStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          source TEXT NOT NULL DEFAULT 'auto',
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          use_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_project_memories_project ON project_memories(project_id, confidence DESC)
      `);
    } catch (e) {
      console.warn('[ProjectMemory] Table creation failed:', e);
    }
  }

  /**
   * Learn a new pattern/preference for a project.
   * Validates against primary truth before inserting — contradictions are rejected.
   */
  learn(projectId: string, category: ProjectMemory['category'], content: string, source: string = 'auto'): ProjectMemory | null {
    // Check for duplicates
    const existing = this.findSimilar(projectId, content);
    if (existing) {
      // Reinforce existing memory
      this.reinforce(existing.id);
      return existing;
    }

    // Validate against primary truth — skip insert if contradicts
    try {
      const truthGate = new MemoryTruthGate(this.db);
      const validation = truthGate.validateAgainstTruth(projectId, content);
      if (!validation.valid) {
        console.warn(`[ProjectMemory] Rejected memory that contradicts primary truth. Content: "${content.slice(0, 80)}..." Conflict: "${validation.conflict?.slice(0, 80)}..."`);
        return null;
      }
    } catch (e) {
      // Non-fatal: if truth gate fails, allow the insert to proceed
      console.warn('[ProjectMemory] Truth gate validation error (allowing insert):', e);
    }

    const memory: ProjectMemory = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      category,
      content,
      confidence: 1.0,
      source,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };

    try {
      this.db.prepare(
        'INSERT INTO project_memories (id, project_id, category, content, confidence, source, created_at, last_used_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(memory.id, memory.projectId, memory.category, memory.content, memory.confidence, memory.source, memory.createdAt, memory.lastUsedAt, memory.useCount);
    } catch (e) {
      console.warn('[ProjectMemory] Insert failed:', e);
    }

    return memory;
  }

  /**
   * Get all active memories for a project (confidence > 0.1).
   */
  getMemories(projectId: string, limit: number = 20): ProjectMemory[] {
    try {
      // Apply decay before reading
      this.applyDecay(projectId);

      const rows = this.db.prepare(
        'SELECT * FROM project_memories WHERE project_id = ? AND confidence > 0.1 ORDER BY confidence DESC, use_count DESC LIMIT ?'
      ).all(projectId, limit) as any[];

      return rows.map(this.rowToMemory);
    } catch {
      return [];
    }
  }

  /**
   * Get memories formatted as context for the LLM prompt.
   */
  getContextString(projectId: string): string {
    const memories = this.getMemories(projectId, 15);
    if (memories.length === 0) return '';

    let context = '## Project Patterns & Preferences\n\n';
    const grouped = new Map<string, ProjectMemory[]>();

    for (const m of memories) {
      if (!grouped.has(m.category)) grouped.set(m.category, []);
      grouped.get(m.category)!.push(m);
    }

    const categoryLabels: Record<string, string> = {
      pattern: '📐 Patterns',
      preference: '⭐ Preferences',
      pitfall: '⚠️ Pitfalls',
      convention: '📏 Conventions',
      dependency: '📦 Dependencies',
    };

    for (const [cat, mems] of grouped) {
      context += `### ${categoryLabels[cat] || cat}\n`;
      for (const m of mems) {
        context += `- ${m.content}\n`;
      }
      context += '\n';
    }

    return context;
  }

  /**
   * Reinforce a memory (increase confidence, update last used).
   */
  reinforce(memoryId: string): void {
    try {
      this.db.prepare(
        'UPDATE project_memories SET confidence = MIN(1.0, confidence + 0.1), last_used_at = ?, use_count = use_count + 1 WHERE id = ?'
      ).run(Date.now(), memoryId);
    } catch {}
  }

  /**
   * Remove a memory.
   */
  forget(memoryId: string): void {
    try {
      this.db.prepare('DELETE FROM project_memories WHERE id = ?').run(memoryId);
    } catch {}
  }

  /**
   * Search memories by content.
   */
  search(projectId: string, query: string): ProjectMemory[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM project_memories WHERE project_id = ? AND content LIKE ? AND confidence > 0.1 ORDER BY confidence DESC LIMIT 10'
      ).all(projectId, `%${query}%`) as any[];
      return rows.map(this.rowToMemory);
    } catch {
      return [];
    }
  }

  /**
   * Apply weekly 5% decay to all memories for a project.
   * Primary truth entries (source = 'primary_truth') are exempt from decay.
   */
  private applyDecay(projectId: string): void {
    try {
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // Get memories that haven't been decayed recently — skip primary_truth entries
      const rows = this.db.prepare(
        'SELECT id, last_used_at, confidence FROM project_memories WHERE project_id = ? AND confidence > 0.1 AND source != \'primary_truth\''
      ).all(projectId) as any[];

      for (const row of rows) {
        const weeksSinceUse = (now - row.last_used_at) / oneWeekMs;
        if (weeksSinceUse >= 1) {
          const decayFactor = Math.pow(0.95, Math.floor(weeksSinceUse));
          const newConfidence = row.confidence * decayFactor;
          this.db.prepare('UPDATE project_memories SET confidence = ? WHERE id = ?').run(newConfidence, row.id);
        }
      }
    } catch {}
  }

  /**
   * Find a similar existing memory (simple word overlap check).
   */
  private findSimilar(projectId: string, content: string): ProjectMemory | null {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM project_memories WHERE project_id = ? AND confidence > 0.1'
      ).all(projectId) as any[];

      const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 3));

      for (const row of rows) {
        const rowWords = new Set(row.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));
        let overlap = 0;
        for (const w of contentWords) { if (rowWords.has(w)) overlap++; }
        const similarity = contentWords.size > 0 ? overlap / Math.max(contentWords.size, rowWords.size) : 0;
        if (similarity > 0.6) return this.rowToMemory(row);
      }
    } catch {}
    return null;
  }

  private rowToMemory(row: any): ProjectMemory {
    return {
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      content: row.content,
      confidence: row.confidence,
      source: row.source,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
    };
  }
}
