// ─── Markdown Wiki Connector Adapter ────────────────────────────
// Single-file connector for Markdown documents.
// Normalizes Markdown content into RawDocument structure.
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
 * Markdown Wiki connector adapter.
 * Reads a single Markdown file and produces a RawDocument.
 * Markdown content is kept as-is (text/markdown) since it is already text-based
 * and can be chunked directly by the ingest pipeline.
 */
export class MarkdownWikiConnector implements KBConnector {
  readonly type: ConnectorType = 'markdown-wiki';

  private filePath: string | null = null;
  private connected = false;

  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'markdown-wiki') {
      throw new Error(`MarkdownWikiConnector: invalid config type "${config.type}", expected "markdown-wiki"`);
    }
    this.filePath = config.uri;
    this.connected = true;
  }

  async list(): Promise<SourceEntry[]> {
    if (!this.connected || !this.filePath) {
      throw new Error('MarkdownWikiConnector: not connected. Call connect() first.');
    }

    try {
      const stats = await stat(this.filePath);
      return [
        {
          uri: this.filePath,
          name: basename(this.filePath),
          mimeType: 'text/markdown',
          sizeBytes: stats.size,
          lastModified: stats.mtimeMs,
        },
      ];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`MarkdownWikiConnector: failed to stat file "${this.filePath}": ${message}`);
      return [];
    }
  }

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    if (!this.connected || !this.filePath) {
      throw new Error('MarkdownWikiConnector: not connected. Call connect() first.');
    }

    for (const entry of entries) {
      try {
        const content = await readFile(entry.uri);

        // Basic validation: ensure the file is valid UTF-8 text
        this.validateMarkdown(content);

        const contentHash = createHash('sha256').update(content).digest('hex');

        yield {
          content,
          mimeType: 'text/markdown',
          sourceUri: entry.uri,
          fetchTimestamp: Date.now(),
          contentHash,
          byteSize: content.byteLength,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `MarkdownWikiConnector: skipping corrupt/unreadable document "${entry.uri}": ${message}`,
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
   * Basic Markdown validation — ensure content is non-empty UTF-8 text.
   * Markdown is a permissive format, so we mainly guard against binary data.
   */
  private validateMarkdown(content: Buffer): void {
    if (content.byteLength === 0) {
      throw new Error('Markdown file is empty');
    }
    // Check for null bytes which indicate binary content
    if (content.includes(0)) {
      throw new Error('Markdown file contains binary data (null bytes detected)');
    }
  }
}
