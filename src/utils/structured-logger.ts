/**
 * Structured rotating logger for NeuroNest.
 *
 * Outputs JSON-lines format (one JSON object per line) for machine parseability.
 * Supports log levels with runtime configurability (no restart needed),
 * file rotation at 10MB with 5-file retention, and writes to a platform-appropriate
 * directory.
 *
 * Usage:
 *   import { createLogger, getLogger } from '../utils/structured-logger';
 *
 *   const logger = createLogger({ level: 'info' });
 *   logger.info('main', 'App started', { version: '1.0.0' });
 *   logger.error('ipc', 'Handler failed', new Error('timeout'), { channel: 'voice' });
 *
 *   // Change level at runtime (no restart)
 *   logger.setLevel('debug');
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Types ---

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string; // ISO 8601
  level: LogLevel;
  source: string; // module name
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export interface LoggerConfig {
  level: LogLevel;
  maxFileSize: number; // bytes, default 10MB
  maxFiles: number; // default 5
  outputDir: string; // platform-appropriate
}

export interface Logger {
  debug(source: string, message: string, context?: object): void;
  info(source: string, message: string, context?: object): void;
  warn(source: string, message: string, context?: object): void;
  error(source: string, message: string, error?: Error, context?: object): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  getConfig(): Readonly<LoggerConfig>;
  flush(): void;
}

// --- Constants ---

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 5;
const LOG_FILE_NAME = 'neuronest.log';

// --- Platform-appropriate log directory ---

export function getDefaultLogDir(): string {
  const platform = process.platform;
  const home = os.homedir();

  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Logs', 'NeuroNest');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NeuroNest', 'logs');
    default:
      // Linux and other Unix-like systems
      return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'neuronest', 'logs');
  }
}

// --- Structured Logger Implementation ---

class StructuredLogger implements Logger {
  private config: LoggerConfig;
  private currentFilePath: string;
  private currentFileSize: number;
  private writeStream: fs.WriteStream | null = null;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: config.level ?? 'info',
      maxFileSize: config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
      outputDir: config.outputDir ?? getDefaultLogDir(),
    };

    this.currentFilePath = path.join(this.config.outputDir, LOG_FILE_NAME);
    this.currentFileSize = 0;

    this.ensureOutputDir();
    this.initializeFileSize();
  }

  debug(source: string, message: string, context?: object): void {
    this.log('debug', source, message, undefined, context);
  }

  info(source: string, message: string, context?: object): void {
    this.log('info', source, message, undefined, context);
  }

  warn(source: string, message: string, context?: object): void {
    this.log('warn', source, message, undefined, context);
  }

  error(source: string, message: string, error?: Error, context?: object): void {
    this.log('error', source, message, error, context);
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  getLevel(): LogLevel {
    return this.config.level;
  }

  getConfig(): Readonly<LoggerConfig> {
    return { ...this.config };
  }

  flush(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  // --- Internal ---

  private log(level: LogLevel, source: string, message: string, error?: Error, context?: object): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    };

    // For error-level entries, always include context (even if empty)
    if (level === 'error') {
      entry.context = (context as Record<string, unknown>) ?? {};
    } else if (context !== undefined) {
      entry.context = context as Record<string, unknown>;
    }

    if (error?.stack) {
      entry.stack = error.stack;
    }

    this.writeEntry(entry);
  }

  private writeEntry(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    // Check if rotation is needed before writing
    if (this.currentFileSize + lineBytes > this.config.maxFileSize) {
      this.rotate();
    }

    this.appendToFile(line);
    this.currentFileSize += lineBytes;
  }

  private appendToFile(line: string): void {
    try {
      fs.appendFileSync(this.currentFilePath, line, 'utf8');
    } catch (err) {
      // If writing fails (e.g., disk full), attempt to ensure dir exists and retry once
      try {
        this.ensureOutputDir();
        fs.appendFileSync(this.currentFilePath, line, 'utf8');
      } catch {
        // Last resort: emit to stderr so the log isn't completely lost
        process.stderr.write(`[StructuredLogger] Failed to write: ${line}`);
      }
    }
  }

  private rotate(): void {
    // Close any open stream
    this.flush();

    try {
      // Shift existing rotated files: .4 -> delete, .3 -> .4, .2 -> .3, .1 -> .2
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const from = this.getRotatedFilePath(i);
        const to = this.getRotatedFilePath(i + 1);

        if (i === this.config.maxFiles - 1) {
          // Delete the oldest file
          try {
            fs.unlinkSync(from);
          } catch {
            // File may not exist, that's fine
          }
        } else {
          // Rename to next slot
          try {
            fs.renameSync(from, to);
          } catch {
            // File may not exist, that's fine
          }
        }
      }

      // Rotate current log file to .1
      const rotatedPath = this.getRotatedFilePath(1);
      try {
        fs.renameSync(this.currentFilePath, rotatedPath);
      } catch {
        // Current file may not exist
      }

      // Reset size counter
      this.currentFileSize = 0;
    } catch {
      // If rotation fails, just reset the file
      this.currentFileSize = 0;
    }
  }

  private getRotatedFilePath(index: number): string {
    return `${this.currentFilePath}.${index}`;
  }

  private ensureOutputDir(): void {
    try {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    } catch {
      // Directory may already exist or we can't create it
    }
  }

  private initializeFileSize(): void {
    try {
      const stats = fs.statSync(this.currentFilePath);
      this.currentFileSize = stats.size;
    } catch {
      // File doesn't exist yet
      this.currentFileSize = 0;
    }
  }
}

// --- Singleton & Factory ---

let singletonInstance: Logger | null = null;

/**
 * Creates (or returns the existing) singleton logger instance.
 * Call with config to initialize. Subsequent calls return the same instance.
 */
export function createLogger(config?: Partial<LoggerConfig>): Logger {
  if (!singletonInstance) {
    singletonInstance = new StructuredLogger(config);
  }
  return singletonInstance;
}

/**
 * Returns the existing singleton logger, or creates one with defaults.
 */
export function getLogger(): Logger {
  return createLogger();
}

/**
 * Resets the singleton (useful for testing).
 */
export function resetLogger(): void {
  if (singletonInstance) {
    singletonInstance.flush();
  }
  singletonInstance = null;
}
