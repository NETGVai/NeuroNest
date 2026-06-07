/**
 * Embedding Provider Port + Daemon Adapter (Feature 4: RAG_Tool_Selection)
 *
 * Defines the pluggable `EmbeddingProvider` port that maps `string -> number[]`
 * and the default `EmbeddingDaemonProvider` adapter, which wraps the existing
 * `EmbeddingDaemonClient` so the embedding backend can be swapped without
 * changing retrieval logic or tests.
 *
 * The `EmbeddingProvider` interface is exported from this module (rather than
 * from `tool-index.ts`) so the adapter and the consuming `ToolIndex` can share
 * the port without a circular import.
 *
 * Requirements: 24.1, 24.2
 */

import { EmbeddingDaemonClient } from '../indexing/embedding-daemon';

/**
 * Pluggable embedding port. Maps a single text string to its embedding vector.
 *
 * Implementations return a plain `number[]` so retrieval math (cosine
 * similarity) stays backend-agnostic. (Requirement 24.1)
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/**
 * Default `EmbeddingProvider` implementation. Adapts the worker-thread-backed
 * {@link EmbeddingDaemonClient} to the port contract.
 *
 * The daemon client's `embed(text)` returns a `Float32Array`; this adapter
 * converts it to a plain `number[]` to satisfy the port. (Requirement 24.2)
 */
export class EmbeddingDaemonProvider implements EmbeddingProvider {
  constructor(private client: EmbeddingDaemonClient) {}

  async embed(text: string): Promise<number[]> {
    const vector = await this.client.embed(text);
    return Array.from(vector);
  }
}
