/**
 * Database Tool — First-class database integration for schema generation and migrations.
 *
 * Supports three actions:
 * - execute-query: Run SQL against a PostgreSQL connection (with user approval)
 * - generate-schema: Convert natural language to DDL, write to schema/ directory
 * - generate-migration: Create timestamped migration files in migrations/ directory
 *
 * If no database connection is configured, execute-query returns an error while
 * generate-schema and generate-migration still work in local-only mode.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.4
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../tool-system.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface DatabaseToolInput {
  action: 'execute-query' | 'generate-schema' | 'generate-migration';
  /** SQL query to execute (for execute-query action) */
  query?: string;
  /** Natural language description of the schema (for generate-schema) */
  description?: string;
  /** Migration name (for generate-migration) */
  migrationName?: string;
  /** SQL content for the migration (for generate-migration) */
  upSql?: string;
  /** SQL content for rollback (for generate-migration) */
  downSql?: string;
  /** Database connection string override */
  connectionString?: string;
}

export interface DatabaseConfig {
  connectionString?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Load database configuration from project's .neuronest/config.json
 */
export async function loadDatabaseConfig(projectDir: string): Promise<DatabaseConfig> {
  const configPath = path.join(projectDir, '.neuronest', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      connectionString: parsed?.databaseUrl || parsed?.connectionString || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Generate a timestamp string suitable for migration file names.
 * Format: YYYYMMDDHHMMSS
 */
export function generateTimestamp(date?: Date): string {
  const d = date || new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Sanitize a migration name into a safe filename component.
 */
export function sanitizeMigrationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

/**
 * Generate DDL from a natural language description.
 * This produces a reasonable DDL template. In a full implementation,
 * this would call the LLM to generate the DDL.
 */
export function generateDDLFromDescription(description: string): string {
  // Extract a table name hint from the description
  const tableNameMatch = description.match(/(?:table|entity|model)\s+(?:called|named)?\s*["`']?(\w+)["`']?/i);
  const tableName = tableNameMatch ? tableNameMatch[1].toLowerCase() : 'unnamed_table';

  return [
    `-- Generated from description: ${description}`,
    `-- Review and modify as needed before applying`,
    '',
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    '  id SERIAL PRIMARY KEY,',
    '  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),',
    '  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()',
    ');',
    '',
  ].join('\n');
}

// ─── Execute Actions ────────────────────────────────────────────

async function executeQuery(
  input: DatabaseToolInput,
  context: ToolContext,
  projectDir: string,
): Promise<ToolResult> {
  const { query, connectionString: inputConnString } = input;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { success: false, output: null, error: 'Missing required parameter: query' };
  }

  // Load connection string from input override or project config
  const dbConfig = await loadDatabaseConfig(projectDir);
  const connString = inputConnString || dbConfig.connectionString;

  if (!connString) {
    return {
      success: false,
      output: null,
      error:
        'No database connection configured. Add "databaseUrl" to .neuronest/config.json or provide a connectionString parameter.',
    };
  }

  // Require user approval for query execution
  const isAutoApprove = context.permissionMode === 'auto-approve';
  if (!isAutoApprove) {
    if (context.approvalHandler) {
      const approved = await context.approvalHandler(`Execute SQL: ${query}`);
      if (!approved) {
        return {
          success: false,
          output: null,
          error: 'Query execution rejected by user',
        };
      }
    } else {
      return {
        success: false,
        output: null,
        error: 'Query execution rejected by user',
      };
    }
  }

  // Try to dynamically import pg
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg: any = await import('pg');
    const Client = pg.default?.Client || pg.Client;
    const client = new Client({ connectionString: connString });

    try {
      await client.connect();
      const result = await client.query(query);
      await client.end();

      return {
        success: true,
        output: {
          rows: result.rows,
          rowCount: result.rowCount,
          command: result.command,
        },
      };
    } catch (err: unknown) {
      try { await client.end(); } catch { /* ignore close errors */ }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `Query execution failed: ${message}` };
    }
  } catch {
    return {
      success: false,
      output: null,
      error:
        'PostgreSQL client (pg) is not installed. Run "npm install pg" to enable query execution.',
    };
  }
}

async function executeGenerateSchema(
  input: DatabaseToolInput,
  projectDir: string,
): Promise<ToolResult> {
  const { description } = input;

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return { success: false, output: null, error: 'Missing required parameter: description' };
  }

  // Generate DDL from description
  const ddl = generateDDLFromDescription(description);

  // Write to schema/ directory
  const schemaDir = path.join(projectDir, 'schema');
  await fs.mkdir(schemaDir, { recursive: true });

  // Generate a safe filename from the description
  const fileName = sanitizeMigrationName(description.slice(0, 40)) + '.sql';
  const filePath = path.join(schemaDir, fileName);

  await fs.writeFile(filePath, ddl, 'utf-8');

  return {
    success: true,
    output: {
      filePath: path.relative(projectDir, filePath),
      ddl,
      message: `Schema file generated at schema/${fileName}`,
    },
  };
}

async function executeGenerateMigration(
  input: DatabaseToolInput,
  projectDir: string,
): Promise<ToolResult> {
  const { migrationName, upSql, downSql } = input;

  if (!migrationName || typeof migrationName !== 'string' || migrationName.trim().length === 0) {
    return { success: false, output: null, error: 'Missing required parameter: migrationName' };
  }

  if (!upSql || typeof upSql !== 'string' || upSql.trim().length === 0) {
    return { success: false, output: null, error: 'Missing required parameter: upSql' };
  }

  // Create migrations directory
  const migrationsDir = path.join(projectDir, 'migrations');
  await fs.mkdir(migrationsDir, { recursive: true });

  // Generate timestamped filename
  const timestamp = generateTimestamp();
  const safeName = sanitizeMigrationName(migrationName);
  const baseName = `${timestamp}_${safeName}`;

  // Write up migration
  const upPath = path.join(migrationsDir, `${baseName}.up.sql`);
  await fs.writeFile(upPath, upSql, 'utf-8');

  // Write down migration if provided
  let downPath: string | undefined;
  if (downSql && typeof downSql === 'string' && downSql.trim().length > 0) {
    downPath = path.join(migrationsDir, `${baseName}.down.sql`);
    await fs.writeFile(downPath, downSql, 'utf-8');
  }

  const output: Record<string, unknown> = {
    upFile: path.relative(projectDir, upPath),
    upSql,
    message: `Migration created: ${baseName}`,
  };

  if (downPath) {
    output.downFile = path.relative(projectDir, downPath);
    output.downSql = downSql;
  }

  return { success: true, output };
}

// ─── Main execute function ──────────────────────────────────────

async function databaseToolExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const params = input as DatabaseToolInput;

  if (!params || typeof params !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object' };
  }

  const { action } = params;

  if (!action || typeof action !== 'string') {
    return {
      success: false,
      output: null,
      error: 'Missing required parameter: action (execute-query | generate-schema | generate-migration)',
    };
  }

  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  switch (action) {
    case 'execute-query':
      return executeQuery(params, context, projectDir);

    case 'generate-schema':
      return executeGenerateSchema(params, projectDir);

    case 'generate-migration':
      return executeGenerateMigration(params, projectDir);

    default:
      return {
        success: false,
        output: null,
        error: `Unknown action: ${action}. Valid actions: execute-query, generate-schema, generate-migration`,
      };
  }
}

// ─── Tool Definition ────────────────────────────────────────────

export const DatabaseTool: ExecutableToolDefinition = {
  id: 'database',
  name: 'DatabaseTool',
  description:
    'Database integration tool for executing queries, generating schemas, and creating migrations',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['execute-query', 'generate-schema', 'generate-migration'],
        description: 'The action to perform',
      },
      query: {
        type: 'string',
        description: 'SQL query to execute (for execute-query action)',
      },
      description: {
        type: 'string',
        description: 'Natural language description of the schema (for generate-schema action)',
      },
      migrationName: {
        type: 'string',
        description: 'Name for the migration (for generate-migration action)',
      },
      upSql: {
        type: 'string',
        description: 'SQL for the up migration (for generate-migration action)',
      },
      downSql: {
        type: 'string',
        description: 'SQL for the down/rollback migration (for generate-migration action)',
      },
      connectionString: {
        type: 'string',
        description: 'Optional database connection string override',
      },
    },
    required: ['action'],
  },
  riskLevel: 'destructive',
  execute: databaseToolExecute,
};
