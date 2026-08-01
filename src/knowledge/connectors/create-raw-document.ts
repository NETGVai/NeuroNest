// ─── RawDocument Factory ────────────────────────────────────────
// Utility function to normalize raw content into a fully-populated
// RawDocument structure. Encapsulates the normalization logic used
// by all connector adapters to ensure consistent document creation.
//
// Requirements: 1.7

import { createHash } from 'node:crypto';
import type { RawDocument } from './types';

/**
 * Input parameters for creating a normalized RawDocument.
 * These represent the raw values a connector adapter has after fetching content.
 */
export interface RawDocumentInput {
  /** Raw content bytes fetched from the source. */
  content: Buffer;
  /** MIME type of the content. */
  mimeType: string;
  /** Source URI identifying where the content was fetched from. */
  sourceUri: string;
  /** Optional fetch timestamp (defaults to Date.now()). */
  fetchTimestamp?: number;
}

/**
 * Creates a fully-normalized RawDocument from raw connector output.
 *
 * Guarantees:
 * - content is the provided Buffer (must have length > 0)
 * - mimeType is a non-empty string
 * - sourceUri is a non-empty string
 * - fetchTimestamp is a positive number
 * - contentHash is a 64-character hex SHA-256 digest
 * - byteSize matches content.length
 *
 * @param input - Raw inputs from a connector adapter
 * @returns A fully-populated RawDocument
 * @throws Error if content is empty, mimeType is empty, or sourceUri is empty
 */
export function createRawDocument(input: RawDocumentInput): RawDocument {
  const { content, mimeType, sourceUri, fetchTimestamp } = input;

  if (content.length === 0) {
    throw new Error('RawDocument normalization failed: content must not be empty');
  }

  if (!mimeType || mimeType.trim().length === 0) {
    throw new Error('RawDocument normalization failed: mimeType must not be empty');
  }

  if (!sourceUri || sourceUri.trim().length === 0) {
    throw new Error('RawDocument normalization failed: sourceUri must not be empty');
  }

  const resolvedTimestamp = fetchTimestamp ?? Date.now();

  if (resolvedTimestamp <= 0) {
    throw new Error('RawDocument normalization failed: fetchTimestamp must be positive');
  }

  const contentHash = createHash('sha256').update(content).digest('hex');

  return {
    content,
    mimeType,
    sourceUri,
    fetchTimestamp: resolvedTimestamp,
    contentHash,
    byteSize: content.length,
  };
}
