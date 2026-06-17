/**
 * Preview Server — static file server and port detection utilities for
 * the Live App Preview panel.
 *
 * This module contains the testable core logic:
 * - Port detection: checks common dev server ports (3000, 5173, 8080)
 * - Static file server: serves project files over a local HTTP server
 * - File watcher: monitors HTML/CSS/JS changes for live reload
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

// ─── Constants ──────────────────────────────────────────────────

/** Common development server ports to probe. */
export const DEV_SERVER_PORTS = [3000, 5173, 8080] as const;

/** File extensions that trigger a preview refresh. */
export const WATCHABLE_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
]);

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// ─── Port Detection ─────────────────────────────────────────────

/**
 * Check if a specific port has a listening server by attempting a TCP connection.
 * Returns true if a server is detected, false otherwise.
 */
export function checkPort(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Detect a running dev server by probing common ports in sequence.
 * Returns the URL of the first responding server, or null if none found.
 */
export async function detectDevServer(
  ports: readonly number[] = DEV_SERVER_PORTS,
  host = '127.0.0.1',
): Promise<string | null> {
  for (const port of ports) {
    const isUp = await checkPort(port, host);
    if (isUp) {
      return `http://${host}:${port}`;
    }
  }
  return null;
}

// ─── Static File Server ─────────────────────────────────────────

export interface StaticServerOptions {
  /** Root directory to serve files from. */
  rootDir: string;
  /** Port to listen on. Defaults to 0 (OS-assigned). */
  port?: number;
  /** Host to bind to. Defaults to '127.0.0.1'. */
  host?: string;
}

export interface StaticServerHandle {
  /** The URL where the server is accessible. */
  url: string;
  /** The port the server is listening on. */
  port: number;
  /** Stop the server. */
  close: () => Promise<void>;
}

/**
 * Resolve a request path to a safe filesystem path within the root directory.
 * Returns null if the resolved path escapes the root (path traversal protection).
 */
export function resolveStaticPath(rootDir: string, requestPath: string): string | null {
  // Decode URI and normalize
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  // Strip query string and hash
  const cleanPath = decoded.split('?')[0].split('#')[0];

  // Resolve against root
  const resolved = path.resolve(rootDir, '.' + cleanPath);

  // Ensure the resolved path is within rootDir
  const normalizedRoot = path.resolve(rootDir) + path.sep;
  const normalizedResolved = path.resolve(resolved);

  if (!normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== path.resolve(rootDir)) {
    return null;
  }

  return normalizedResolved;
}

/**
 * Create a minimal static file server for serving project files.
 * Serves index.html by default for directory requests.
 */
export function createStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const { rootDir, port = 0, host = '127.0.0.1' } = options;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestPath = req.url || '/';
      const filePath = resolveStaticPath(rootDir, requestPath);

      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Try to serve the file, fall back to index.html for directories
      serveFile(filePath, rootDir, res);
    });

    server.once('error', reject);

    server.listen(port, host, () => {
      const addr = server.address() as net.AddressInfo;
      const handle: StaticServerHandle = {
        url: `http://${host}:${addr.port}`,
        port: addr.port,
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        }),
      };
      resolve(handle);
    });
  });
}

/**
 * Serve a file from the filesystem, handling directories and 404s.
 */
function serveFile(filePath: string, rootDir: string, res: http.ServerResponse): void {
  fs.stat(filePath, (err, stats) => {
    if (err) {
      // File not found — try serving index.html from root
      const indexPath = path.join(rootDir, 'index.html');
      fs.stat(indexPath, (indexErr) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          streamFile(indexPath, res);
        }
      });
      return;
    }

    if (stats.isDirectory()) {
      // Try index.html in the directory
      const dirIndex = path.join(filePath, 'index.html');
      fs.stat(dirIndex, (dirErr) => {
        if (dirErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          streamFile(dirIndex, res);
        }
      });
      return;
    }

    streamFile(filePath, res);
  });
}

/**
 * Stream a file to the response with appropriate MIME type.
 */
function streamFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });
}

// ─── File Watcher ───────────────────────────────────────────────

export interface FileWatcherOptions {
  /** Project directory to watch. */
  projectDir: string;
  /** Callback invoked when a watchable file changes. */
  onChange: (filePath: string) => void;
  /** Debounce interval in ms. Defaults to 300. */
  debounceMs?: number;
}

export interface FileWatcherHandle {
  /** Stop watching. */
  close: () => void;
}

/**
 * Check if a file path has a watchable extension that should trigger refresh.
 */
export function isWatchableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return WATCHABLE_EXTENSIONS.has(ext);
}

/**
 * Watch a project directory for HTML/CSS/JS file changes.
 * Uses fs.watch with debouncing to avoid excessive refresh triggers.
 */
export function watchProjectFiles(options: FileWatcherOptions): FileWatcherHandle {
  const { projectDir, onChange, debounceMs = 300 } = options;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFile: string | null = null;

  const watcher = fs.watch(projectDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;

    // Skip non-watchable files
    if (!isWatchableFile(filename)) return;

    // Skip node_modules and .git
    if (filename.includes('node_modules') || filename.includes('.git')) return;

    // Debounce rapid changes
    const fullPath = path.join(projectDir, filename);
    lastFile = fullPath;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      if (lastFile) {
        onChange(lastFile);
        lastFile = null;
      }
    }, debounceMs);
  });

  return {
    close: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher.close();
    },
  };
}
