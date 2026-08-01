// ─── DOCX Document Connector Adapter ────────────────────────────
// Single-file connector for DOCX documents.
// Normalizes DOCX content into RawDocument structure.
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
 * DOCX Document connector adapter.
 * Reads a single DOCX file and produces a RawDocument with extracted text content.
 * Uses mammoth for text extraction when available; falls back to raw buffer.
 */
export class DocxDocumentConnector implements KBConnector {
  readonly type: ConnectorType = 'docx-document';

  private filePath: string | null = null;
  private connected = false;

  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'docx-document') {
      throw new Error(`DocxDocumentConnector: invalid config type "${config.type}", expected "docx-document"`);
    }
    this.filePath = config.uri;
    this.connected = true;
  }

  async list(): Promise<SourceEntry[]> {
    if (!this.connected || !this.filePath) {
      throw new Error('DocxDocumentConnector: not connected. Call connect() first.');
    }

    try {
      const stats = await stat(this.filePath);
      return [
        {
          uri: this.filePath,
          name: basename(this.filePath),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: stats.size,
          lastModified: stats.mtimeMs,
        },
      ];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`DocxDocumentConnector: failed to stat file "${this.filePath}": ${message}`);
      return [];
    }
  }

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    if (!this.connected || !this.filePath) {
      throw new Error('DocxDocumentConnector: not connected. Call connect() first.');
    }

    for (const entry of entries) {
      try {
        const rawBuffer = await readFile(entry.uri);

        // Attempt to extract text via mammoth if available
        const content = await this.extractContent(rawBuffer);

        const contentHash = createHash('sha256').update(content).digest('hex');

        yield {
          content,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sourceUri: entry.uri,
          fetchTimestamp: Date.now(),
          contentHash,
          byteSize: content.byteLength,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `DocxDocumentConnector: skipping corrupt/unreadable document "${entry.uri}": ${message}`,
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
   * Attempt to extract text content from DOCX buffer.
   * Uses mammoth library if available, otherwise returns the raw buffer.
   */
  private async extractContent(rawBuffer: Buffer): Promise<Buffer> {
    try {
      // Dynamic import so that the module is optional at build time
      const mammoth = await import('mammoth' as string);
      const result = await mammoth.extractRawText({ buffer: rawBuffer });
      return Buffer.from(result.value, 'utf-8');
    } catch {
      // mammoth not available or extraction failed — return raw DOCX bytes
      return rawBuffer;
    }
  }
}
