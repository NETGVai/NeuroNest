// ─── PDF Document Connector Adapter ─────────────────────────────
// Single-file connector for PDF documents.
// Normalizes PDF content into RawDocument structure.
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
 * PDF Document connector adapter.
 * Reads a single PDF file and produces a RawDocument with extracted text content.
 * Uses pdf-parse for text extraction when available; falls back to raw buffer.
 */
export class PdfDocumentConnector implements KBConnector {
  readonly type: ConnectorType = 'pdf-document';

  private filePath: string | null = null;
  private connected = false;

  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'pdf-document') {
      throw new Error(`PdfDocumentConnector: invalid config type "${config.type}", expected "pdf-document"`);
    }
    this.filePath = config.uri;
    this.connected = true;
  }

  async list(): Promise<SourceEntry[]> {
    if (!this.connected || !this.filePath) {
      throw new Error('PdfDocumentConnector: not connected. Call connect() first.');
    }

    try {
      const stats = await stat(this.filePath);
      return [
        {
          uri: this.filePath,
          name: basename(this.filePath),
          mimeType: 'application/pdf',
          sizeBytes: stats.size,
          lastModified: stats.mtimeMs,
        },
      ];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`PdfDocumentConnector: failed to stat file "${this.filePath}": ${message}`);
      return [];
    }
  }

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    if (!this.connected || !this.filePath) {
      throw new Error('PdfDocumentConnector: not connected. Call connect() first.');
    }

    for (const entry of entries) {
      try {
        const rawBuffer = await readFile(entry.uri);

        // Attempt to extract text via pdf-parse if available
        const content = await this.extractContent(rawBuffer);

        const contentHash = createHash('sha256').update(content).digest('hex');

        yield {
          content,
          mimeType: 'application/pdf',
          sourceUri: entry.uri,
          fetchTimestamp: Date.now(),
          contentHash,
          byteSize: content.byteLength,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `PdfDocumentConnector: skipping corrupt/unreadable document "${entry.uri}": ${message}`,
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
   * Attempt to extract text content from PDF buffer.
   * Uses pdf-parse library if available, otherwise returns the raw buffer.
   */
  private async extractContent(rawBuffer: Buffer): Promise<Buffer> {
    try {
      // Dynamic import so that the module is optional at build time
      const pdfParse = await import('pdf-parse' as string);
      const parse = pdfParse.default ?? pdfParse;
      const result = await parse(rawBuffer);
      return Buffer.from(result.text, 'utf-8');
    } catch {
      // pdf-parse not available or parse failed — return raw PDF bytes
      return rawBuffer;
    }
  }
}
