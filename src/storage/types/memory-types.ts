// ─── Memory_Store Types ─────────────────────────────────────────
// Type definitions for the long-term memory persistence layer.

export interface MemoryFact {
  id: string;
  userId: string;
  category: 'profile' | 'preference' | 'knowledge';
  key: string;            // semantic key for dedup
  value: string;
  relevanceScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryStoreConfig {
  maxFactsPerUser: number;        // default 10_000
  contextBudgetFraction: number;  // default 0.15
  topK: number;                   // default 20
}
