/**
 * MCP Marketplace Catalog — manages the catalog of available MCP servers
 * with metadata (name, categories, transport, ratings).
 *
 * Syncs catalog from a remote registry periodically (daily) or on-demand.
 *
 * Requirements: 9.1
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MCPCatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  categories: string[];
  transport: 'stdio' | 'sse' | 'websocket';
  command?: string[];
  url?: string;
  rating: number;
  downloads: number;
  verified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogSearchOptions {
  query?: string;
  category?: string;
  transport?: 'stdio' | 'sse' | 'websocket';
  verified?: boolean;
  limit?: number;
  offset?: number;
}

export interface CatalogSyncResult {
  success: boolean;
  entriesUpdated: number;
  lastSyncAt: number;
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CATALOG_REGISTRY_URL = 'https://registry.neuronest.dev/mcp/catalog.json';
const MAX_CATALOG_SIZE = 500;

// ─── Default catalog (bundled for offline use) ──────────────────

const BUNDLED_CATALOG: MCPCatalogEntry[] = [
  {
    id: 'filesystem-mcp',
    name: 'Filesystem',
    description: 'Read, write, and manage files on the local filesystem.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['filesystem', 'core'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-filesystem'],
    rating: 4.8,
    downloads: 50000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'github-mcp',
    name: 'GitHub',
    description: 'Interact with GitHub repositories, issues, and pull requests.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['vcs', 'productivity'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-github'],
    rating: 4.7,
    downloads: 42000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'postgres-mcp',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['database', 'backend'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-postgres'],
    rating: 4.6,
    downloads: 31000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'puppeteer-mcp',
    name: 'Puppeteer',
    description: 'Browser automation and web scraping via Puppeteer.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['browser', 'automation'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
    rating: 4.5,
    downloads: 28000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'docker-mcp',
    name: 'Docker',
    description: 'Manage Docker containers, images, and compose stacks.',
    author: 'community',
    version: '0.9.0',
    categories: ['devops', 'containers'],
    transport: 'stdio',
    command: ['npx', '-y', 'mcp-server-docker'],
    rating: 4.3,
    downloads: 18000,
    verified: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'slack-mcp',
    name: 'Slack',
    description: 'Read and send messages in Slack workspaces.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['communication', 'productivity'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-slack'],
    rating: 4.4,
    downloads: 22000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'sqlite-mcp',
    name: 'SQLite',
    description: 'Query and manage SQLite databases.',
    author: 'modelcontextprotocol',
    version: '1.0.0',
    categories: ['database', 'core'],
    transport: 'stdio',
    command: ['npx', '-y', '@modelcontextprotocol/server-sqlite'],
    rating: 4.5,
    downloads: 25000,
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'redis-mcp',
    name: 'Redis',
    description: 'Interact with Redis key-value stores and pub/sub.',
    author: 'community',
    version: '0.8.0',
    categories: ['database', 'backend'],
    transport: 'stdio',
    command: ['npx', '-y', 'mcp-server-redis'],
    rating: 4.2,
    downloads: 15000,
    verified: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

// ─── MarketplaceCatalog ─────────────────────────────────────────

export class MarketplaceCatalog {
  private db: Database.Database | null;
  private catalog: MCPCatalogEntry[] = [];
  private lastSyncAt: number = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database.Database | null) {
    this.db = db;
    this.loadFromDb();
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Start periodic sync. Performs an immediate sync if the catalog
   * hasn't been refreshed in the last 24 hours.
   */
  startPeriodicSync(): void {
    if (this.syncTimer) return;

    const elapsed = Date.now() - this.lastSyncAt;
    if (elapsed >= SYNC_INTERVAL_MS) {
      this.syncFromRegistry().catch((err) => {
        logger.warn('[MarketplaceCatalog] Periodic sync failed:', err);
      });
    }

    this.syncTimer = setInterval(() => {
      this.syncFromRegistry().catch((err) => {
        logger.warn('[MarketplaceCatalog] Periodic sync failed:', err);
      });
    }, SYNC_INTERVAL_MS);
  }

  /** Stop periodic sync. */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  // ─── Sync ─────────────────────────────────────────────────────

  /**
   * Sync catalog from remote registry. Falls back to bundled catalog
   * if the fetch fails (offline / network error).
   */
  async syncFromRegistry(): Promise<CatalogSyncResult> {
    try {
      const response = await fetch(CATALOG_REGISTRY_URL, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Registry returned ${response.status}`);
      }

      const data = await response.json() as { entries?: MCPCatalogEntry[] };
      const entries = Array.isArray(data.entries) ? data.entries : [];

      if (entries.length > 0) {
        this.catalog = entries.slice(0, MAX_CATALOG_SIZE);
        this.lastSyncAt = Date.now();
        this.persistToDb();

        return {
          success: true,
          entriesUpdated: this.catalog.length,
          lastSyncAt: this.lastSyncAt,
        };
      }

      // Empty response — fall back to bundled
      this.loadBundledCatalog();
      return {
        success: true,
        entriesUpdated: this.catalog.length,
        lastSyncAt: this.lastSyncAt,
      };
    } catch (err) {
      // Network failure — load bundled catalog if we have nothing
      if (this.catalog.length === 0) {
        this.loadBundledCatalog();
      }

      return {
        success: false,
        entriesUpdated: 0,
        lastSyncAt: this.lastSyncAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Query ────────────────────────────────────────────────────

  /** Get all catalog entries. */
  getAll(): MCPCatalogEntry[] {
    return [...this.catalog];
  }

  /** Search catalog entries with optional filters. */
  search(options: CatalogSearchOptions = {}): MCPCatalogEntry[] {
    let results = [...this.catalog];

    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter((entry) =>
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.categories.some((c) => c.toLowerCase().includes(q)) ||
        entry.author.toLowerCase().includes(q)
      );
    }

    if (options.category) {
      const cat = options.category.toLowerCase();
      results = results.filter((entry) =>
        entry.categories.some((c) => c.toLowerCase() === cat)
      );
    }

    if (options.transport) {
      results = results.filter((entry) => entry.transport === options.transport);
    }

    if (options.verified !== undefined) {
      results = results.filter((entry) => entry.verified === options.verified);
    }

    // Sort by rating descending, then downloads
    results.sort((a, b) => b.rating - a.rating || b.downloads - a.downloads);

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  /** Get a single catalog entry by ID. */
  getById(id: string): MCPCatalogEntry | undefined {
    return this.catalog.find((entry) => entry.id === id);
  }

  /** Get all unique categories. */
  getCategories(): string[] {
    const cats = new Set<string>();
    for (const entry of this.catalog) {
      for (const c of entry.categories) {
        cats.add(c);
      }
    }
    return [...cats].sort();
  }

  /** Get the timestamp of the last successful sync. */
  getLastSyncTime(): number {
    return this.lastSyncAt;
  }

  // ─── Persistence ──────────────────────────────────────────────

  private loadFromDb(): void {
    if (!this.db) {
      this.loadBundledCatalog();
      return;
    }

    try {
      const rows = this.db.prepare(
        'SELECT * FROM mcp_catalog ORDER BY rating DESC'
      ).all() as Array<{
        id: string;
        name: string;
        description: string;
        author: string;
        version: string;
        categories: string;
        transport: string;
        command: string | null;
        url: string | null;
        rating: number;
        downloads: number;
        verified: number;
        created_at: number;
        updated_at: number;
      }>;

      if (rows.length === 0) {
        this.loadBundledCatalog();
        return;
      }

      this.catalog = rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        author: row.author,
        version: row.version,
        categories: JSON.parse(row.categories || '[]'),
        transport: row.transport as MCPCatalogEntry['transport'],
        command: row.command ? JSON.parse(row.command) : undefined,
        url: row.url ?? undefined,
        rating: row.rating,
        downloads: row.downloads,
        verified: row.verified === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      // Load last sync time from metadata
      const meta = this.db.prepare(
        "SELECT value FROM mcp_catalog_meta WHERE key = 'last_sync_at'"
      ).get() as { value: string } | undefined;
      if (meta) {
        this.lastSyncAt = parseInt(meta.value, 10) || 0;
      }
    } catch {
      // Table may not exist yet (pre-migration). Use bundled.
      this.loadBundledCatalog();
    }
  }

  private persistToDb(): void {
    if (!this.db) return;

    try {
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO mcp_catalog
          (id, name, description, author, version, categories, transport, command, url, rating, downloads, verified, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = this.db.transaction(() => {
        for (const entry of this.catalog) {
          insert.run(
            entry.id,
            entry.name,
            entry.description,
            entry.author,
            entry.version,
            JSON.stringify(entry.categories),
            entry.transport,
            entry.command ? JSON.stringify(entry.command) : null,
            entry.url ?? null,
            entry.rating,
            entry.downloads,
            entry.verified ? 1 : 0,
            entry.createdAt,
            entry.updatedAt,
          );
        }

        // Persist sync metadata
        this.db!.prepare(`
          INSERT OR REPLACE INTO mcp_catalog_meta (key, value) VALUES ('last_sync_at', ?)
        `).run(String(this.lastSyncAt));
      });

      transaction();
    } catch (err) {
      logger.warn('[MarketplaceCatalog] Failed to persist catalog:', err);
    }
  }

  private loadBundledCatalog(): void {
    this.catalog = [...BUNDLED_CATALOG];
    this.lastSyncAt = Date.now();
  }
}
