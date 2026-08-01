// ─── CSV File Connector Adapter ─────────────────────────────────
// Single-file connector for CSV documents.
// Normalizes CSV content into RawDocument structure.
//
// Requirements: 1.2, 1.7

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type {
  ConnectorConfig,
  ConnectorType,
  KBConnector,
  RawDocument,
  SourceEntry,
} from '../types';

/**
 * CSV File connector adapter.
 * Reads a single CSV file and produces a RawDocument.
 * CSV content is kept as-is (text/csv) since it is already text-based.
 */
export class CsvFileConnector implements KBConnector {
  readonly type: ConnectorType = 'csv-file';

  private filePath: string | null = null;
  private connected = false;

  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'csv-file') {
      throw new Error(`CsvFileConnector: invalid config type "${config.type}", expected "csv-file"`);
    }
    this.filePath = config.uri;
    this.connected = true;
  }

  async list(): Promise<SourceEntry[]> {
    if (!this.connected || !this.filePath) {
      throw new Error('CsvFileConnector: not connected. Call connect() first.');
    }

    try {
      const stats = await stat(this.filePath);
      return [
        {
          uri: this.filePath,
          name: basename(this.filePath),
          mimeType: 'text/csv',
          sizeBytes: stats.size,
          lastModified: stats.mtimeMs,
        },
      ];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`CsvFileConnector: failed to stat file "${this.filePath}": ${message}`);
      return [];
    }
  }

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    if (!this.connected || !this.filePath) {
      throw new Error('CsvFileConnector: not connected. Call connect() first.');
    }

    for (const entry of entries) {
      try {
        const content = await readFile(entry.uri);

        // Basic CSV validation: ensure the file is valid UTF-8 text
        this.validateCsv(content);

        const contentHash = createHash('sha256').update(content).digest('hex');

        yield {
          content,
          mimeType: 'text/csv',
          sourceUri: entry.uri,
          fetchTimestamp: Date.now(),
          contentHash,
          byteSize: content.byteLength,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `CsvFileConnector: skipping corrupt/unreadable document "${entry.uri}": ${message}`,
        );
        // Skip corrupt documents with warnings per requirement 2.7
      }
    }
  }

  async disconnect(): Promise<void> {
    this.filePath = null;
    this.connected = false;
  }

  /**
   * Basic CSV validation — ensure the content is readable as UTF-8 text
   * and contains at least one line (header row).
   */
  private validateCsv(content: Buffer): void {
    const text = content.toString('utf-8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('CSV file is empty or contains no readable lines');
    }
  }
}
