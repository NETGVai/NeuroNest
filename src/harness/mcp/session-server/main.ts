#!/usr/bin/env node
/**
 * neuronest-session-mcp — Stdio MCP server executable entry point.
 *
 * Reads JSON-RPC messages from stdin, writes responses to stdout.
 * Exits non-zero if database is unavailable or schema is incompatible.
 *
 * Requirements: 30.1, 30.8, 30.12, 32.6
 */

import { SessionMcpServer } from './session-server.js';
import type { JsonRpcRequest, SessionServerConfig } from './types.js';

// ─── Configuration from environment ─────────────────────────────

function loadConfig(): SessionServerConfig {
  const databasePath = process.env['NEURONEST_SESSION_DB_PATH'] ?? ':memory:';
  const busyTimeoutMs = parseInt(process.env['NEURONEST_SESSION_BUSY_TIMEOUT_MS'] ?? '5000', 10);
  const maxTransactionDurationMs = parseInt(process.env['NEURONEST_SESSION_TX_DURATION_MS'] ?? '30000', 10);
  const maxStatementsPerTransaction = parseInt(process.env['NEURONEST_SESSION_TX_MAX_STMTS'] ?? '1000', 10);
  const synchronous = (process.env['NEURONEST_SESSION_SYNCHRONOUS'] ?? 'NORMAL') as 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  const processVersion = process.env['NEURONEST_SESSION_VERSION'] ?? '1.0.0';
  const protocolVersion = process.env['NEURONEST_SESSION_PROTOCOL_VERSION'] ?? '2024-11-05';

  return {
    databasePath,
    busyTimeoutMs,
    synchronous,
    maxTransactionDurationMs,
    maxStatementsPerTransaction,
    processVersion,
    protocolVersion,
  };
}

// ─── Stdio JSON-RPC Transport ───────────────────────────────────

function writeResponse(response: object): void {
  const json = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

function parseRequest(data: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed.jsonrpc === '2.0' && typeof parsed.method === 'string') {
      return parsed as JsonRpcRequest;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new SessionMcpServer(config);

  // Initialize: open DB, run migrations, check compatibility
  const initResult = await server.initialize();

  if (!initResult.ready) {
    process.stderr.write(`[neuronest-session-mcp] Initialization failed: ${initResult.error}\n`);
    process.exit(initResult.exitCode ?? 1);
  }

  // Set up graceful shutdown
  const shutdownHandler = async () => {
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  // Read JSON-RPC from stdin
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    // Parse content-length based messages
    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Try to parse as raw JSON (for simpler transports)
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          const request = parseRequest(line);
          if (request) {
            const response = server.handleRequest(request);
            writeResponse(response);
          }
        }
        continue;
      }

      const contentLength = parseInt(lengthMatch[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      const request = parseRequest(body);
      if (request) {
        const response = server.handleRequest(request);
        writeResponse(response);
      }
    }
  });

  process.stdin.on('end', async () => {
    await server.shutdown();
    process.exit(0);
  });
}

// Run only when executed directly (not when imported for testing)
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[neuronest-session-mcp] Fatal error: ${err}\n`);
    process.exit(1);
  });
}

export { main, loadConfig };
