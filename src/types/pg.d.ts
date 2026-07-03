/**
 * Minimal type declaration for 'pg' (optional dependency).
 * pg is dynamically imported at runtime with a .catch() fallback,
 * so it may not be installed. This stub satisfies TypeScript's module
 * resolution without requiring the full @types/pg package.
 */
declare module 'pg' {
  export class Client {
    constructor(config?: Record<string, unknown>);
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
    end(): Promise<void>;
  }
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
    end(): Promise<void>;
  }
}
