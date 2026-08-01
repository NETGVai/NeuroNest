// ─── JSON File Connector Adapter ────────────────────────────────
// Single-file connector for JSON documents.
// Normalizes JSON content into RawDocument structure.
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
 * JSON File connector adapter.
 * Reads a single JSON file and produces a RawDocument.
 * Validates that the file contains valid JSON before emitting.
 */
export class JsonFileConnector implements KBConnector {
  readonly type: ConnectorType = 'json-file';

  private filePath: string | null = null;
  private connected = false;

  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'json-file') {
      throw new Error(`JsonFileConnector: invalid config type "${config.type}", expected "json-file"`);
    }
    this.filePath = config.uri;
    this.connected = true;
  }

  async list(): Promise<SourceEntry[]> {
    if (!this.connected || !this.filePath) {
      throw new Error('JsonFileConnector: not connected. Call connect() first.');
    }

    try {
      const stats = await stat(this.filePath);
      return [
        {
          uri: this.filePath,
          name: basename(this.filePath),
          mimeType: 'application/json',
          sizeBytes: stats.size,
          lastModified: stats.mtimeMs,
        },
      ];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`JsonFileConnector: failed to stat file "${this.filePath}": ${message}`);
      return [];
    }
  }

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    if (!this.connected || !this.filePath) {
      throw new Error('JsonFileConnector: not connected. Call connect() first.');
    }

    for (const entry of entries) {
      try {
        const content = await readFile(entry.uri);

        // Validate that content is parseable JSON
        this.validateJson(content);

        const contentHash = createHash('sha256').update(content).digest('hex');

        yield {
          content,
          mimeType: 'application/json',
          sourceUri: entry.uri,
          fetchTimestamp: Date.now(),
          contentHash,
          byteSize: content.byteLength,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `JsonFileConnector: skipping corrupt/unreadable document "${entry.uri}": ${message}`,
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
   * Validate that the content buffer contains valid JSON.
   * Throws if JSON.parse fails so the document is skipped gracefully.
   */
  private validateJson(content: Buffer): void {
    const text = content.toString('utf-8');
    JSON.parse(text); // throws SyntaxError if invalid
  }
}
