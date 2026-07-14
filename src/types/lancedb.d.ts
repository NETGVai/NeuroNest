/**
 * Minimal type declaration for 'lancedb' (optional dependency).
 * lancedb is dynamically imported at runtime with a try/catch fallback,
 * so it may not be installed. This stub satisfies TypeScript's module
 * resolution without requiring the full @types/lancedb package.
 */
declare module 'lancedb' {
  export interface Table {
    add(data: Record<string, unknown>[]): Promise<void>;
    search(queryVector: number[]): VectorQuery;
    delete(filter: string): Promise<void>;
    countRows(): Promise<number>;
    toArray(): Promise<Record<string, unknown>[]>;
  }

  export interface VectorQuery {
    metricType(metric: 'cosine' | 'l2' | 'dot'): VectorQuery;
    limit(n: number): VectorQuery;
    toArray(): Promise<Record<string, unknown>[]>;
  }

  export interface Connection {
    tableNames(): Promise<string[]>;
    openTable(name: string): Promise<Table>;
    createTable(name: string, data: Record<string, unknown>[]): Promise<Table>;
    dropTable(name: string): Promise<void>;
  }

  export function connect(uri: string): Promise<Connection>;
}
