// ─── Chunking Module Entry Point ────────────────────────────────
// Factory function and barrel exports for all chunking strategies.
//
// Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6

export {
  ChunkingConfig,
  ChunkingStrategy,
  ChunkMetadata,
  KBChunk,
  countTokens,
  countLLMTokens,
  hashContent,
  splitAtSentenceBoundaries,
  defaultChunkingConfig,
} from './types';

export { FixedSizeChunking } from './fixed-size';
export { SemanticBoundaryChunking } from './semantic-boundary';
export { DocumentStructureChunking } from './document-structure';

import { ChunkingConfig, ChunkingStrategy } from './types';
import { FixedSizeChunking } from './fixed-size';
import { SemanticBoundaryChunking } from './semantic-boundary';
import { DocumentStructureChunking } from './document-structure';

/**
 * Factory function that creates the appropriate chunking strategy
 * based on the provided configuration.
 *
 * @param config - The chunking configuration specifying which strategy to use.
 * @returns A ChunkingStrategy instance ready for use.
 * @throws Error if the strategy type is unknown.
 */
export function createChunkingStrategy(config: ChunkingConfig): ChunkingStrategy {
  switch (config.strategy) {
    case 'fixed-size':
      return new FixedSizeChunking();
    case 'semantic-boundary':
      return new SemanticBoundaryChunking();
    case 'document-structure':
      return new DocumentStructureChunking();
    default: {
      const _exhaustive: never = config.strategy;
      throw new Error(`Unknown chunking strategy: ${_exhaustive}`);
    }
  }
}
