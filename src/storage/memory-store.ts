/**
 * Memory_Store — persistent long-term memory backed by better-sqlite3.
 *
 * Stores user profile data, preferences, and knowledge facts across sessions.
 * Falls back to an ephemeral in-memory Map when the database is unavailable.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { MemoryFact, MemoryStoreConfig } from './types/memory-types.js';

// ─── Default configuration ──────────────────────────────────────
const DEFAULT_CONFIG: MemoryStoreConfig = {
  maxFactsPerUser: 10_000,
  contextBudgetFraction: 0.15,
  topK: 20,
};

// ─── Row shape returned by better-sqlite3 ───────────────────────
interface MemoryRow {
  id: string;
  user_id: string;
  category: MemoryFact['category'];
  key: string;
  value: string;
  relevance_score: number;
  created_at: string;
  updated_at: string;
}

/** Rough token estimate matching Context_Compressor convention (~4 chars/token). */
function estimateTokenCost(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Convert a database row into a MemoryFact. */
function rowToFact(row: MemoryRow): MemoryFact {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    key: row.key,
    value: row.value,
    relevanceScore: row.relevance_score,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ─── Ephemeral fallback (mirrors SwarmMemoryPool behaviour) ─────
class EphemeralMemoryStore {
  private facts = new Map<string, MemoryFact>();
  private stats: Array<{ sessionId: string; turnsCompressed: number; tokensSaved: number }> = [];
  private config: MemoryStoreConfig;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
  }

  remember(userId: string, category: MemoryFact['category'], key: string, value: string): string {
    const compositeKey = `${userId}:${key}`;
    const existing = this.facts.get(compositeKey);

    // Quota check — only count if this is a genuinely new key
    if (!existing) {
      const count = this.getFactCount(userId);
      if (count >= this.config.maxFactsPerUser) {
        throw new Error(`Memory quota exceeded for user ${userId}: limit is ${this.config.maxFactsPerUser} facts`);
      }
    }

    const now = new Date();
    const id = existing?.id ?? randomUUID();
    const fact: MemoryFact = {
      id,
      userId,
      category,
      key,
      value,
      relevanceScore: 1.0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.facts.set(compositeKey, fact);
    return id;
  }

  forget(userId: string, key: string): boolean {
    return this.facts.delete(`${userId}:${key}`);
  }

  loadContext(userId: string, contextWindowSize: number): MemoryFact[] {
    const userFacts = [...this.facts.values()]
      .filter((f) => f.userId === userId)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const budget = Math.floor(this.config.contextBudgetFraction * contextWindowSize);
    const result: MemoryFact[] = [];
    let tokensCost = 0;

    for (const fact of userFacts.slice(0, this.config.topK)) {
      const cost = estimateTokenCost(fact.value);
      if (tokensCost + cost > budget) break;
      tokensCost += cost;
      result.push(fact);
    }
    return result;
  }

  listFacts(userId: string): MemoryFact[] {
    return [...this.facts.values()].filter((f) => f.userId === userId);
  }

  getFactCount(userId: string): number {
    return [...this.facts.values()].filter((f) => f.userId === userId).length;
  }

  recordStat(sessionId: string, turnsCompressed: number, tokensSaved: number): void {
    this.stats.push({ sessionId, turnsCompressed, tokensSaved });
  }
}

// ─── MemoryStore (database-backed) ──────────────────────────────
export class MemoryStore {
  private readonly config: MemoryStoreConfig;
  private readonly db: Database.Database | null;
  private readonly fallback: EphemeralMemoryStore | null;

  // Prepared statements (lazily assigned when db is available)
  private upsertStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;
  private loadStmt!: Database.Statement;
  private listStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private insertStatStmt!: Database.Statement;

  constructor(db: Database.Database | null, config?: Partial<MemoryStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (db) {
      try {
        this.prepareStatements(db);
        this.db = db;
        this.fallback = null;
      } catch {
        // Database unavailable — fall back to ephemeral store (Req 4.7)
        console.warn('[MemoryStore] Database unavailable, falling back to ephemeral memory');
        this.db = null;
        this.fallback = new EphemeralMemoryStore(this.config);
      }
    } else {
      console.warn('[MemoryStore] No database provided, falling back to ephemeral memory');
      this.db = null;
      this.fallback = new EphemeralMemoryStore(this.config);
    }
  }

  private prepareStatements(db: Database.Database): void {
    this.upsertStmt = db.prepare(`
      INSERT INTO long_term_memory (id, user_id, category, key, value, relevance_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1.0, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, key) DO UPDATE SET
        category  = excluded.category,
        value     = excluded.value,
        updated_at = datetime('now')
    `);

    this.deleteStmt = db.prepare(
      'DELETE FROM long_term_memory WHERE user_id = ? AND key = ?',
    );

    this.loadStmt = db.prepare(
      'SELECT * FROM long_term_memory WHERE user_id = ? ORDER BY relevance_score DESC LIMIT ?',
    );

    this.listStmt = db.prepare(
      'SELECT * FROM long_term_memory WHERE user_id = ? ORDER BY updated_at DESC',
    );

    this.countStmt = db.prepare(
      'SELECT COUNT(*) AS cnt FROM long_term_memory WHERE user_id = ?',
    );

    this.insertStatStmt = db.prepare(
      'INSERT INTO compression_stats (id, session_id, turns_compressed, tokens_saved, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    );
  }

  /**
   * Store a fact, deduplicating by semantic key via UPSERT.
   * Throws if the per-user quota would be exceeded.
   * Returns the fact ID.
   *
   * Requirements: 4.1, 4.2, 4.5
   */
  remember(userId: string, category: MemoryFact['category'], key: string, value: string): string {
    if (this.fallback) {
      return this.fallback.remember(userId, category, key, value);
    }

    // Check quota — only enforce when this is a new key (not an update)
    const existing = (this.db!.prepare(
      'SELECT id FROM long_term_memory WHERE user_id = ? AND key = ?',
    ).get(userId, key)) as { id: string } | undefined;

    if (!existing) {
      const count = this.getFactCount(userId);
      if (count >= this.config.maxFactsPerUser) {
        throw new Error(`Memory quota exceeded for user ${userId}: limit is ${this.config.maxFactsPerUser} facts`);
      }
    }

    const id = existing?.id ?? randomUUID();
    this.upsertStmt.run(id, userId, category, key, value);
    return id;
  }

  /**
   * Delete a fact by key match. Returns true if a row was deleted.
   *
   * Requirements: 4.1
   */
  forget(userId: string, key: string): boolean {
    if (this.fallback) {
      return this.fallback.forget(userId, key);
    }
    const result = this.deleteStmt.run(userId, key);
    return result.changes > 0;
  }

  /**
   * Load top-k facts for session initialization, respecting the token budget.
   * Orders by relevance_score DESC, limits to topK, then trims to fit within
   * contextBudgetFraction × contextWindowSize tokens.
   *
   * Requirements: 4.3, 4.6
   */
  loadContext(userId: string, contextWindowSize: number): MemoryFact[] {
    if (this.fallback) {
      return this.fallback.loadContext(userId, contextWindowSize);
    }

    const rows = this.loadStmt.all(userId, this.config.topK) as MemoryRow[];
    const budget = Math.floor(this.config.contextBudgetFraction * contextWindowSize);
    const result: MemoryFact[] = [];
    let tokensCost = 0;

    for (const row of rows) {
      const cost = estimateTokenCost(row.value);
      if (tokensCost + cost > budget) break;
      tokensCost += cost;
      result.push(rowToFact(row));
    }

    return result;
  }

  /**
   * Get all facts for a user (for /memory command).
   *
   * Requirements: 4.1
   */
  listFacts(userId: string): MemoryFact[] {
    if (this.fallback) {
      return this.fallback.listFacts(userId);
    }
    const rows = this.listStmt.all(userId) as MemoryRow[];
    return rows.map(rowToFact);
  }

  /**
   * Get fact count for quota enforcement.
   *
   * Requirements: 4.5
   */
  getFactCount(userId: string): number {
    if (this.fallback) {
      return this.fallback.getFactCount(userId);
    }
    const row = this.countStmt.get(userId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Record a compression stat event.
   *
   * Requirements: 2.7
   */
  recordStat(sessionId: string, turnsCompressed: number, tokensSaved: number): void {
    if (this.fallback) {
      return this.fallback.recordStat(sessionId, turnsCompressed, tokensSaved);
    }
    this.insertStatStmt.run(randomUUID(), sessionId, turnsCompressed, tokensSaved);
  }
}

export default MemoryStore;
