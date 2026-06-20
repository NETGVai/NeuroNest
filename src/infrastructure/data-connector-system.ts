/**
 * DataConnectorSystem — Structured data connector framework for external sources.
 *
 * Provides a DataConnector interface and built-in connectors for REST API (GET/POST),
 * PostgreSQL, SQLite (local), and file URL (HTTP download). Integrates with the
 * BashTool approval flow for user consent before establishing connections. Sanitizes
 * credentials from all error messages and allows custom connector registration via
 * PluginRegistry.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6
 */

import { FeatureError } from '../shared/feature-integration-errors.js';

// ─── Credential Sanitization ────────────────────────────────────

/**
 * Patterns that match credential-like values in error messages.
 * Used to strip passwords, tokens, API keys, and connection strings
 * with embedded credentials from error output.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // password=... or password:... (URL-encoded or plain)
  /password[=:][^\s&;,'"]+/gi,
  // api[_-]?key=... or apikey=...
  /api[_\-]?key[=:][^\s&;,'"]+/gi,
  // token=... or access_token=...
  /(?:access[_\-]?)?token[=:][^\s&;,'"]+/gi,
  // secret=... or client_secret=...
  /(?:client[_\-]?)?secret[=:][^\s&;,'"]+/gi,
  // Authorization header values (Bearer/Basic followed by token characters including =)
  /(?:Bearer|Basic)\s+[A-Za-z0-9+/._\-]+=*/gi,
  // Connection string credentials: ://user:password@
  /:\/\/[^:]+:[^@]+@/gi,
  // AWS-style keys
  /(?:AKIA|ASIA)[A-Z0-9]{16,}/g,
  // Generic long hex/base64 tokens (32+ chars)
  /(?:key|secret|token|credential|auth)[=:]\s*['"]?[A-Za-z0-9+/=._\-]{32,}['"]?/gi,
];

/**
 * Sanitize credential values from an error message.
 * Replaces matched patterns with [REDACTED] to prevent credential leakage.
 */
export function sanitizeCredentials(message: string): string {
  let sanitized = message;
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (match) => {
      // For connection strings ://user:password@, keep the format visible
      if (match.includes('://')) {
        return '://[REDACTED]@';
      }
      // For Bearer/Basic auth patterns, replace entire token
      if (/^(?:Bearer|Basic)\s/i.test(match)) {
        return '[REDACTED]';
      }
      // For key=value or key:value patterns, keep the key name
      const separatorIdx = match.search(/[=:]/);
      if (separatorIdx >= 0) {
        const key = match.substring(0, separatorIdx + 1);
        return `${key}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return sanitized;
}

// ─── Types ──────────────────────────────────────────────────────

export type ConnectorType = 'rest-api' | 'postgresql' | 'sqlite-local' | 'file-url' | string;

export interface ConnectionConfig {
  /** Target host, URL, or file path depending on connector type. */
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  url?: string;
  /** Additional connector-specific options. */
  options?: Record<string, unknown>;
}

export interface QueryParams {
  /** SQL query string, REST path, or connector-specific query. */
  query?: string;
  /** HTTP method for REST connector. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Request body for POST/PUT. */
  body?: unknown;
  /** HTTP headers for REST connector. */
  headers?: Record<string, string>;
  /** Query parameters for REST requests. */
  queryParams?: Record<string, string>;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface ConnectorResult {
  success: boolean;
  data: unknown;
  error?: string;
  metadata?: { rowCount?: number; headers?: Record<string, string> };
}

/**
 * Approval handler function type.
 * Consistent with BashTool's approvalHandler in ToolContext.
 * The description explains what the connector is about to do.
 */
export type ApprovalHandler = (description: string) => Promise<boolean>;

// ─── DataConnector Interface ────────────────────────────────────

export interface DataConnector {
  readonly id: string;
  readonly type: ConnectorType;
  connect(config: ConnectionConfig): Promise<void>;
  query(params: QueryParams): Promise<ConnectorResult>;
  fetch(url: string, options?: FetchOptions): Promise<ConnectorResult>;
  disconnect(): Promise<void>;
}

// ─── DataConnectorSystem ────────────────────────────────────────

export class DataConnectorSystem {
  private readonly connectors: Map<string, DataConnector> = new Map();
  private approvalHandler: ApprovalHandler | null = null;
  private autoApprove = false;

  constructor(options?: { approvalHandler?: ApprovalHandler; autoApprove?: boolean }) {
    this.approvalHandler = options?.approvalHandler ?? null;
    this.autoApprove = options?.autoApprove ?? false;

    // Register built-in connectors
    this.registerConnector(new RestApiConnector(this));
    this.registerConnector(new PostgreSQLConnector(this));
    this.registerConnector(new SQLiteLocalConnector(this));
    this.registerConnector(new FileUrlConnector(this));
  }

  /**
   * Set the approval handler (integrates with BashTool approval flow).
   */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /**
   * Set auto-approve mode (mirrors BashTool's 'auto-approve' permission mode).
   */
  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  /**
   * Get a connector by type. Throws if not found.
   */
  getConnector(type: string): DataConnector {
    const connector = this.connectors.get(type);
    if (!connector) {
      throw new FeatureError({
        message: `No connector registered for type: ${type}`,
        category: 'infrastructure',
        code: 'CONNECTOR_NOT_FOUND',
        details: { type, availableTypes: Array.from(this.connectors.keys()) },
      });
    }
    return connector;
  }

  /**
   * Register a custom connector (used by PluginRegistry for custom connectors).
   */
  registerConnector(connector: DataConnector): void {
    this.connectors.set(connector.type, connector);
  }

  /**
   * List all registered connectors.
   */
  listConnectors(): DataConnector[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Request user approval before connecting. Consistent with BashTool approval flow.
   * Returns true if approved, false if rejected.
   */
  async requestApproval(description: string): Promise<boolean> {
    if (this.autoApprove) {
      return true;
    }
    if (!this.approvalHandler) {
      return false;
    }
    return this.approvalHandler(description);
  }
}

// ─── Base Connector ─────────────────────────────────────────────

/**
 * Abstract base class providing common patterns for all built-in connectors:
 * approval integration and credential sanitization.
 */
abstract class BaseConnector implements DataConnector {
  abstract readonly id: string;
  abstract readonly type: ConnectorType;

  protected connected = false;
  protected config: ConnectionConfig | null = null;
  protected readonly system: DataConnectorSystem;

  constructor(system: DataConnectorSystem) {
    this.system = system;
  }

  abstract connect(config: ConnectionConfig): Promise<void>;
  abstract query(params: QueryParams): Promise<ConnectorResult>;
  abstract fetch(url: string, options?: FetchOptions): Promise<ConnectorResult>;

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
  }

  /**
   * Wrap an operation with credential sanitization on errors.
   */
  protected async safeExecute(
    operation: () => Promise<ConnectorResult>,
    target: string,
  ): Promise<ConnectorResult> {
    try {
      return await operation();
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeCredentials(rawMessage);
      return {
        success: false,
        data: null,
        error: `Connection to ${target} failed: ${sanitized}`,
      };
    }
  }

  /**
   * Build a safe error result with sanitized message.
   */
  protected errorResult(target: string, reason: string): ConnectorResult {
    return {
      success: false,
      data: null,
      error: `Connection to ${target} failed: ${sanitizeCredentials(reason)}`,
    };
  }
}

// ─── REST API Connector ─────────────────────────────────────────

export class RestApiConnector extends BaseConnector {
  readonly id = 'rest-api';
  readonly type: ConnectorType = 'rest-api';

  private baseUrl = '';

  constructor(system: DataConnectorSystem) {
    super(system);
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const target = config.url || `${config.host}:${config.port || 443}`;
    const approved = await this.system.requestApproval(
      `Connect to REST API at: ${target}`,
    );
    if (!approved) {
      throw new FeatureError({
        message: 'Connection rejected by user',
        category: 'infrastructure',
        code: 'CONNECTION_REJECTED',
        details: { target },
      });
    }
    this.baseUrl = config.url || `https://${config.host}${config.port ? `:${config.port}` : ''}`;
    this.config = config;
    this.connected = true;
  }

  async query(params: QueryParams): Promise<ConnectorResult> {
    if (!this.connected) {
      return this.errorResult('REST API', 'Not connected. Call connect() first.');
    }

    const method = params.method || 'GET';
    const url = params.query ? `${this.baseUrl}${params.query}` : this.baseUrl;

    return this.safeExecute(async () => {
      const queryString = params.queryParams
        ? '?' + new URLSearchParams(params.queryParams).toString()
        : '';
      const fullUrl = `${url}${queryString}`;

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(params.headers || {}),
        },
      };

      if (params.body && (method === 'POST' || method === 'PUT')) {
        fetchOptions.body = JSON.stringify(params.body);
      }

      const response = await globalThis.fetch(fullUrl, fetchOptions);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let data: unknown;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        return {
          success: false,
          data,
          error: `HTTP ${response.status}: ${response.statusText}`,
          metadata: { headers: responseHeaders },
        };
      }

      return {
        success: true,
        data,
        metadata: { headers: responseHeaders },
      };
    }, this.baseUrl);
  }

  async fetch(url: string, options?: FetchOptions): Promise<ConnectorResult> {
    const approved = await this.system.requestApproval(
      `Fetch from REST URL: ${url}`,
    );
    if (!approved) {
      return this.errorResult(url, 'Request rejected by user');
    }

    return this.safeExecute(async () => {
      const fetchOptions: RequestInit = {
        method: options?.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      };

      if (options?.body && options.method === 'POST') {
        fetchOptions.body = JSON.stringify(options.body);
      }

      if (options?.timeout) {
        const controller = new AbortController();
        fetchOptions.signal = controller.signal;
        setTimeout(() => controller.abort(), options.timeout);
      }

      const response = await globalThis.fetch(url, fetchOptions);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let data: unknown;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        success: response.ok,
        data,
        error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
        metadata: { headers: responseHeaders },
      };
    }, url);
  }

  async disconnect(): Promise<void> {
    this.baseUrl = '';
    await super.disconnect();
  }
}

// ─── PostgreSQL Connector ───────────────────────────────────────

export class PostgreSQLConnector extends BaseConnector {
  readonly id = 'postgresql';
  readonly type: ConnectorType = 'postgresql';

  private connectionTarget = '';

  constructor(system: DataConnectorSystem) {
    super(system);
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const host = config.host || 'localhost';
    const port = config.port || 5432;
    const database = config.database || 'postgres';
    this.connectionTarget = `${host}:${port}/${database}`;

    const approved = await this.system.requestApproval(
      `Connect to PostgreSQL database at: ${this.connectionTarget}`,
    );
    if (!approved) {
      throw new FeatureError({
        message: 'Connection rejected by user',
        category: 'infrastructure',
        code: 'CONNECTION_REJECTED',
        details: { target: this.connectionTarget },
      });
    }

    // In a full implementation, this would establish a pg connection pool.
    // For now we validate configuration and store it.
    this.config = config;
    this.connected = true;
  }

  async query(params: QueryParams): Promise<ConnectorResult> {
    if (!this.connected) {
      return this.errorResult(this.connectionTarget, 'Not connected. Call connect() first.');
    }

    if (!params.query) {
      return this.errorResult(this.connectionTarget, 'Query string is required.');
    }

    return this.safeExecute(async () => {
      // In a production implementation, this would use pg client to execute the query.
      // This stub demonstrates the interface contract and error handling patterns.
      // External pg dependency would be dynamically imported when available.
      try {
        const pg = await import('pg').catch(() => null);
        if (!pg) {
          return {
            success: false,
            data: null,
            error: `Connection to ${this.connectionTarget} failed: PostgreSQL driver (pg) is not installed. Run: npm install pg`,
          };
        }

        const client = new pg.Client({
          host: this.config?.host || 'localhost',
          port: this.config?.port || 5432,
          database: this.config?.database || 'postgres',
          user: this.config?.username,
          password: this.config?.password,
        });

        await client.connect();
        try {
          const result = await client.query(params.query!);
          return {
            success: true,
            data: result.rows,
            metadata: { rowCount: result.rowCount ?? 0 },
          };
        } finally {
          await client.end();
        }
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        throw new Error(rawMsg);
      }
    }, this.connectionTarget);
  }

  async fetch(url: string, _options?: FetchOptions): Promise<ConnectorResult> {
    return this.errorResult(
      this.connectionTarget,
      'fetch() is not supported for PostgreSQL connector. Use query() instead.',
    );
  }

  async disconnect(): Promise<void> {
    this.connectionTarget = '';
    await super.disconnect();
  }
}

// ─── SQLite Local Connector ─────────────────────────────────────

export class SQLiteLocalConnector extends BaseConnector {
  readonly id = 'sqlite-local';
  readonly type: ConnectorType = 'sqlite-local';

  private dbPath = '';
  private db: any = null;

  constructor(system: DataConnectorSystem) {
    super(system);
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const dbPath = config.database || config.url || ':memory:';
    this.dbPath = dbPath;

    const approved = await this.system.requestApproval(
      `Open local SQLite database at: ${dbPath}`,
    );
    if (!approved) {
      throw new FeatureError({
        message: 'Connection rejected by user',
        category: 'infrastructure',
        code: 'CONNECTION_REJECTED',
        details: { target: dbPath },
      });
    }

    // Open the database handle and keep it for the session
    try {
      const BetterSqlite3 = await import('better-sqlite3').catch(() => null);
      if (!BetterSqlite3) {
        throw new Error('better-sqlite3 driver is not available.');
      }
      this.db = (BetterSqlite3 as any).default
        ? new (BetterSqlite3 as any).default(this.dbPath)
        : new (BetterSqlite3 as any)(this.dbPath);
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new FeatureError({
        message: sanitizeCredentials(`Failed to open SQLite database: ${rawMsg}`),
        category: 'infrastructure',
        code: 'SQLITE_OPEN_FAILED',
        details: { target: dbPath },
      });
    }

    this.config = config;
    this.connected = true;
  }

  async query(params: QueryParams): Promise<ConnectorResult> {
    if (!this.connected || !this.db) {
      return this.errorResult(this.dbPath, 'Not connected. Call connect() first.');
    }

    if (!params.query) {
      return this.errorResult(this.dbPath, 'Query string is required.');
    }

    return this.safeExecute(async () => {
      try {
        const query = params.query!.trim().toLowerCase();
        if (query.startsWith('select') || query.startsWith('pragma') || query.startsWith('with')) {
          const rows = this.db.prepare(params.query!).all();
          return {
            success: true,
            data: rows,
            metadata: { rowCount: rows.length },
          };
        } else {
          const result = this.db.prepare(params.query!).run();
          return {
            success: true,
            data: { changes: result.changes, lastInsertRowid: result.lastInsertRowid },
            metadata: { rowCount: result.changes },
          };
        }
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        throw new Error(rawMsg);
      }
    }, this.dbPath);
  }

  async fetch(url: string, _options?: FetchOptions): Promise<ConnectorResult> {
    return this.errorResult(
      this.dbPath,
      'fetch() is not supported for SQLite connector. Use query() instead.',
    );
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
      this.db = null;
    }
    this.dbPath = '';
    await super.disconnect();
  }
}

// ─── File URL Connector (HTTP Download) ─────────────────────────

export class FileUrlConnector extends BaseConnector {
  readonly id = 'file-url';
  readonly type: ConnectorType = 'file-url';

  constructor(system: DataConnectorSystem) {
    super(system);
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const target = config.url || config.host || 'file-url';
    const approved = await this.system.requestApproval(
      `Enable file URL downloads from: ${target}`,
    );
    if (!approved) {
      throw new FeatureError({
        message: 'Connection rejected by user',
        category: 'infrastructure',
        code: 'CONNECTION_REJECTED',
        details: { target },
      });
    }

    this.config = config;
    this.connected = true;
  }

  async query(_params: QueryParams): Promise<ConnectorResult> {
    return this.errorResult(
      'file-url',
      'query() is not supported for file URL connector. Use fetch() instead.',
    );
  }

  async fetch(url: string, options?: FetchOptions): Promise<ConnectorResult> {
    if (!this.connected) {
      return this.errorResult(url, 'Not connected. Call connect() first.');
    }

    const approved = await this.system.requestApproval(
      `Download file from: ${url}`,
    );
    if (!approved) {
      return this.errorResult(url, 'Download rejected by user');
    }

    return this.safeExecute(async () => {
      const fetchOptions: RequestInit = {
        method: options?.method || 'GET',
        headers: options?.headers,
      };

      if (options?.timeout) {
        const controller = new AbortController();
        fetchOptions.signal = controller.signal;
        setTimeout(() => controller.abort(), options.timeout);
      }

      const response = await globalThis.fetch(url, fetchOptions);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!response.ok) {
        return {
          success: false,
          data: null,
          error: `HTTP ${response.status}: ${response.statusText}`,
          metadata: { headers: responseHeaders },
        };
      }

      // Determine content type and read appropriately
      const contentType = response.headers.get('content-type') || '';
      let data: unknown;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else if (
        contentType.includes('text/') ||
        contentType.includes('application/xml') ||
        contentType.includes('application/javascript')
      ) {
        data = await response.text();
      } else {
        // Binary content — return as base64
        const buffer = await response.arrayBuffer();
        data = {
          type: 'binary',
          encoding: 'base64',
          content: Buffer.from(buffer).toString('base64'),
          size: buffer.byteLength,
        };
      }

      return {
        success: true,
        data,
        metadata: { headers: responseHeaders },
      };
    }, url);
  }

  async disconnect(): Promise<void> {
    await super.disconnect();
  }
}
