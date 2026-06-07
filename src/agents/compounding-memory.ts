/**
 * CompoundingMemory — Persistent agent learning and skill management.
 *
 * In-memory stub implementation of agent-swarm's Compounding_Memory system.
 * Stores memory entries (patterns, strategies, insights, errors) and skills
 * per agent, with retrieval, pruning, and cross-agent skill sharing.
 *
 * Requirements: 7.1–7.7, 15.13
 */

import { randomUUID } from 'node:crypto';

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
