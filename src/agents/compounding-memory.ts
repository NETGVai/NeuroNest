/**
 * CompoundingMemory — Persistent agent learning and skill management.
 *
 * In-memory stub implementation of agent-swarm's Compounding_Memory system.
 * Stores memory entries (patterns, strategies, insights, errors) and skills
 * per agent, with retrieval, pruning, and cross-agent skill sharing.
 *
 * Requirements: 7.1–7.7, 15.13, 17.1–17.4
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { HNSWIndex } from '../memory/hnsw-index.js';

// ─── Types ──────────────────────────────────────────────────────

export type MemoryType = 'pattern' | 'strategy' | 'insight' | 'error';

export interface MemoryEntry {
  id: string;
  agentId: string;
  type: MemoryType;
  content: string;
  context: string;
  relevanceScore: number;
  createdAt: Date;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  procedure: string;
  applicableDomains: string[];
}

export interface PruneCriteria {
  olderThan?: Date;
  belowRelevance?: number;
  maxEntries?: number;
}

// ─── CompoundingMemory ──────────────────────────────────────────

export class CompoundingMemory {
  private memories = new Map<string, MemoryEntry[]>(); // agentId -> entries
  private skills = new Map<string, Skill[]>(); // agentId -> skills
  private allMemoriesById = new Map<string, MemoryEntry>(); // memoryId -> entry

  /**
   * Store a memory entry for an agent.
   * Requirements: 7.1, 7.2
   */
  async store(agentId: string, memory: MemoryEntry): Promise<void> {
    const entry: MemoryEntry = {
      ...memory,
      id: memory.id || randomUUID(),
      agentId,
      createdAt: memory.createdAt ?? new Date(),
    };

    let agentMemories = this.memories.get(agentId);
    if (!agentMemories) {
      agentMemories = [];
      this.memories.set(agentId, agentMemories);
    }
    agentMemories.push(entry);
    this.allMemoriesById.set(entry.id, entry);
  }

  /**
   * Retrieve memories for an agent matching a query.
   * Requirements: 7.3
   */
  async retrieve(agentId: string, query: string, limit?: number): Promise<MemoryEntry[]> {
    const agentMemories = this.memories.get(agentId) ?? [];
    const queryLower = query.toLowerCase();

    // Simple text-matching relevance search
    const matches = agentMemories
      .filter(
        (m) =>
          m.content.toLowerCase().includes(queryLower) ||
          m.context.toLowerCase().includes(queryLower) ||
          m.type.toLowerCase().includes(queryLower),
      )
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return limit ? matches.slice(0, limit) : matches;
  }

  /**
   * List all memories for an agent.
   * Requirements: 7.5
   */
  async listMemories(agentId: string): Promise<MemoryEntry[]> {
    return [...(this.memories.get(agentId) ?? [])];
  }

  /**
   * Delete a specific memory entry by ID.
   * Requirements: 7.5
   */
  async deleteMemory(memoryId: string): Promise<void> {
    const entry = this.allMemoriesById.get(memoryId);
    if (!entry) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const agentMemories = this.memories.get(entry.agentId);
    if (agentMemories) {
      const idx = agentMemories.findIndex((m) => m.id === memoryId);
      if (idx !== -1) {
        agentMemories.splice(idx, 1);
      }
    }
    this.allMemoriesById.delete(memoryId);
  }

  /**
   * Prune memories for an agent based on criteria.
   * Requirements: 7.6
   */
  async pruneMemories(agentId: string, criteria: PruneCriteria): Promise<number> {
    const agentMemories = this.memories.get(agentId);
    if (!agentMemories) return 0;

    let pruned = 0;
    const toRemove: string[] = [];

    for (const memory of agentMemories) {
      let shouldPrune = false;

      if (criteria.olderThan && memory.createdAt < criteria.olderThan) {
        shouldPrune = true;
      }
      if (criteria.belowRelevance !== undefined && memory.relevanceScore < criteria.belowRelevance) {
        shouldPrune = true;
      }

      if (shouldPrune) {
        toRemove.push(memory.id);
      }
    }

    // If maxEntries is set, keep only the top N by relevance
    if (criteria.maxEntries !== undefined && agentMemories.length > criteria.maxEntries) {
      const sorted = [...agentMemories].sort((a, b) => b.relevanceScore - a.relevanceScore);
      for (let i = criteria.maxEntries; i < sorted.length; i++) {
        if (!toRemove.includes(sorted[i].id)) {
          toRemove.push(sorted[i].id);
        }
      }
    }

    for (const id of toRemove) {
      const idx = agentMemories.findIndex((m) => m.id === id);
      if (idx !== -1) {
        agentMemories.splice(idx, 1);
        this.allMemoriesById.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Reset all memories for an agent.
   * Requirements: 7.6
   */
  async resetMemories(agentId: string): Promise<void> {
    const agentMemories = this.memories.get(agentId) ?? [];
    for (const m of agentMemories) {
      this.allMemoriesById.delete(m.id);
    }
    this.memories.set(agentId, []);
  }

  /**
   * Learn a new skill for an agent.
   * Requirements: 7.7
   */
  async learnSkill(agentId: string, skill: Skill): Promise<void> {
    let agentSkills = this.skills.get(agentId);
    if (!agentSkills) {
      agentSkills = [];
      this.skills.set(agentId, agentSkills);
    }

    // Replace if skill with same ID exists
    const idx = agentSkills.findIndex((s) => s.id === skill.id);
    if (idx !== -1) {
      agentSkills[idx] = skill;
    } else {
      agentSkills.push(skill);
    }
  }

  /**
   * Get all skills for an agent.
   * Requirements: 7.7
   */
  async getSkills(agentId: string): Promise<Skill[]> {
    return [...(this.skills.get(agentId) ?? [])];
  }

  /**
   * Share a skill from one agent to another.
   * Requirements: 7.7
   */
  async shareSkill(fromAgentId: string, toAgentId: string, skillId: string): Promise<void> {
    const fromSkills = this.skills.get(fromAgentId) ?? [];
    const skill = fromSkills.find((s) => s.id === skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId} for agent ${fromAgentId}`);
    }
    await this.learnSkill(toAgentId, { ...skill });
  }
}

// ─── Trajectory Memory Types ────────────────────────────────────

export interface GateResultSummary {
  gateName: string;
  passed: boolean;
  message?: string;
}

export interface TrajectoryRecord {
  id: string;
  taskEmbedding: Float32Array;
  planChosen: string;
  agentsUsed: string[];
  gateResults: GateResultSummary[];
  guiAcceptanceOutcome?: boolean;
  locDelta: number;
  tokenCost: number;
  passed: boolean;
  createdAt: string;
}

export interface TrajectoryDecayCriteria {
  olderThanDays?: number;
  maxRecords?: number;
}

// ─── SQLite Table Schema ────────────────────────────────────────

const CREATE_TRAJECTORIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  task_embedding BLOB NOT NULL,
  plan_chosen TEXT NOT NULL,
  agents_used TEXT NOT NULL,
  gate_results TEXT NOT NULL,
  gui_acceptance_outcome INTEGER,
  loc_delta INTEGER NOT NULL,
  token_cost REAL NOT NULL,
  passed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

// ─── TrajectoryStore ────────────────────────────────────────────

/**
 * TrajectoryStore — Records pipeline run trajectories for learning.
 *
 * Writes trajectory records after pipeline completion and supports
 * retrieval of top-k similar trajectories via the HNSW index for
 * "what worked / what failed" context in plan creation.
 *
 * Reuses the existing decay mechanism pattern from CompoundingMemory
 * for aging out stale records.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */
export class TrajectoryStore {
  private db: Database.Database;
  private hnswIndex: HNSWIndex;

  constructor(db: Database.Database, hnswIndex: HNSWIndex) {
    this.db = db;
    this.hnswIndex = hnswIndex;
    this.ensureTable();
  }

  /**
   * Write a trajectory record after pipeline completion.
   * Persists to SQLite and inserts embedding into HNSW index.
   *
   * Requirement 17.1
   */
  async writeTrajectory(record: TrajectoryRecord): Promise<void> {
    const id = record.id || randomUUID();
    const embeddingBlob = Buffer.from(
      record.taskEmbedding.buffer,
      record.taskEmbedding.byteOffset,
      record.taskEmbedding.byteLength,
    );
    const guiOutcome = record.guiAcceptanceOutcome === undefined
      ? null
      : record.guiAcceptanceOutcome ? 1 : 0;
    const createdAt = record.createdAt || new Date().toISOString();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO trajectories
         (id, task_embedding, plan_chosen, agents_used, gate_results,
          gui_acceptance_outcome, loc_delta, token_cost, passed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        embeddingBlob,
        record.planChosen,
        JSON.stringify(record.agentsUsed),
        JSON.stringify(record.gateResults),
        guiOutcome,
        record.locDelta,
        record.tokenCost,
        record.passed ? 1 : 0,
        createdAt,
      );

    // Insert embedding into HNSW index for similarity retrieval
    await this.hnswIndex.insert(id, record.taskEmbedding, 'trajectory', id);
  }

  /**
   * Retrieve top-k most similar trajectories by embedding similarity.
   * Uses the HNSW index for nearest-neighbor search, then hydrates
   * full records from SQLite.
   *
   * Requirement 17.2
   */
  async retrieveSimilar(
    embedding: Float32Array,
    topK: number,
  ): Promise<TrajectoryRecord[]> {
    const queryResults = await this.hnswIndex.query(embedding, topK);

    if (queryResults.length === 0) {
      return [];
    }

    const ids = queryResults.map((r) => r.id);
    const records: TrajectoryRecord[] = [];

    for (const id of ids) {
      const row = this.db
        .prepare('SELECT * FROM trajectories WHERE id = ?')
        .get(id) as TrajectoryRow | undefined;

      if (row) {
        records.push(this.rowToRecord(row));
      }
    }

    return records;
  }

  /**
   * Decay (prune) stale trajectory records.
   * Reuses the same pattern as CompoundingMemory.pruneMemories —
   * remove records older than a threshold or cap total record count.
   *
   * Requirement 17.3
   */
  async decay(criteria: TrajectoryDecayCriteria): Promise<number> {
    let pruned = 0;

    if (criteria.olderThanDays !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - criteria.olderThanDays);
      const cutoffISO = cutoff.toISOString();

      const oldRows = this.db
        .prepare('SELECT id FROM trajectories WHERE created_at < ?')
        .all(cutoffISO) as Array<{ id: string }>;

      for (const row of oldRows) {
        this.db.prepare('DELETE FROM trajectories WHERE id = ?').run(row.id);
        await this.hnswIndex.remove(row.id);
        pruned++;
      }
    }

    if (criteria.maxRecords !== undefined) {
      const totalCount = this.getCount();
      if (totalCount > criteria.maxRecords) {
        const excess = totalCount - criteria.maxRecords;
        const oldestRows = this.db
          .prepare('SELECT id FROM trajectories ORDER BY created_at ASC LIMIT ?')
          .all(excess) as Array<{ id: string }>;

        for (const row of oldestRows) {
          this.db.prepare('DELETE FROM trajectories WHERE id = ?').run(row.id);
          await this.hnswIndex.remove(row.id);
          pruned++;
        }
      }
    }

    return pruned;
  }

  /**
   * Get total count of stored trajectories.
   */
  getCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM trajectories')
      .get() as { count: number };
    return row.count;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private ensureTable(): void {
    this.db.exec(CREATE_TRAJECTORIES_TABLE_SQL);
  }

  private rowToRecord(row: TrajectoryRow): TrajectoryRecord {
    const embeddingBuffer = row.task_embedding;
    const taskEmbedding = new Float32Array(
      embeddingBuffer.buffer.slice(
        embeddingBuffer.byteOffset,
        embeddingBuffer.byteOffset + embeddingBuffer.byteLength,
      ),
    );

    return {
      id: row.id,
      taskEmbedding,
      planChosen: row.plan_chosen,
      agentsUsed: JSON.parse(row.agents_used) as string[],
      gateResults: JSON.parse(row.gate_results) as GateResultSummary[],
      guiAcceptanceOutcome: row.gui_acceptance_outcome === null
        ? undefined
        : row.gui_acceptance_outcome === 1,
      locDelta: row.loc_delta,
      tokenCost: row.token_cost,
      passed: row.passed === 1,
      createdAt: row.created_at,
    };
  }
}

interface TrajectoryRow {
  id: string;
  task_embedding: Buffer;
  plan_chosen: string;
  agents_used: string;
  gate_results: string;
  gui_acceptance_outcome: number | null;
  loc_delta: number;
  token_cost: number;
  passed: number;
  created_at: string;
}
