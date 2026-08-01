// ─── Fixed-Size Chunking Strategy ───────────────────────────────
// Splits text into chunks of approximately equal token count with
// configurable overlap between consecutive chunks.
//
// Requirements: 30.1, 30.2, 30.5, 30.6

import { uuidv7 } from 'uuidv7';

import {
  ChunkingConfig,
  ChunkingStrategy,
  ChunkMetadata,
  KBChunk,
  countTokens,
  countLLMTokens,
  hashContent,
  splitAtSentenceBoundaries,
} from './types';

/**
 * Fixed-size chunking splits text into chunks with a target token count
 * and configurable overlap to preserve context across boundaries.
 *
 * When an atomic unit exceeds maxTokens, it is split at sentence/statement
 * boundaries and the resulting pieces are linked via continuationGroupId.
 */
export class FixedSizeChunking implements ChunkingStrategy {
  chunk(content: string, sourceUri: string, config: ChunkingConfig): KBChunk[] {
    const { maxTokens, overlapTokens } = config;
    const chunks: KBChunk[] = [];

    if (content.trim().length === 0) {
      return chunks;
    }

    // Split content into words for token-level control
    const words = content.split(/(\s+)/);
    let currentChunkWords: string[] = [];
    let currentTokenCount = 0;
    let chunkIndex = 0;
    let lineStart = 1;

    // Track lines for metadata
    const lineTracker = { current: 1 };

    const flushChunk = (isOverlapStart: boolean): void => {
      const chunkText = currentChunkWords.join('');
      if (chunkText.trim().length === 0) return;

      const tokenCount = countTokens(chunkText);

      // If this chunk exceeds maxTokens, we need to handle oversized content
      if (tokenCount > maxTokens) {
        const splitChunks = this.splitOversizedContent(
          chunkText,
          sourceUri,
          chunkIndex,
          lineStart,
          lineTracker,
          config,
        );
        chunks.push(...splitChunks);
        chunkIndex += splitChunks.length;
      } else {
        const lineEnd = lineStart + chunkText.split('\n').length - 1;
        chunks.push({
          id: uuidv7(),
          sourceUri,
          chunkIndex: chunkIndex++,
          content: chunkText,
          contentHash: hashContent(chunkText),
          tokenCount,
          llmTokenCount: countLLMTokens(chunkText),
          metadata: {
            lineStart,
            lineEnd,
          },
        });
        lineStart = lineEnd;
      }
    };

    for (const word of words) {
      const wordTokens = countTokens(word);

      if (currentTokenCount + wordTokens > maxTokens && currentChunkWords.length > 0) {
        flushChunk(false);

        // Apply overlap: keep the last N tokens worth of words
        if (overlapTokens > 0) {
          const overlapWords = this.getOverlapWords(currentChunkWords, overlapTokens);
          currentChunkWords = overlapWords;
          currentTokenCount = countTokens(overlapWords.join(''));
        } else {
          currentChunkWords = [];
          currentTokenCount = 0;
        }
      }

      currentChunkWords.push(word);
      currentTokenCount += wordTokens;

      // Track lines
      const newlines = (word.match(/\n/g) || []).length;
      lineTracker.current += newlines;
    }

    // Flush remaining content
    if (currentChunkWords.length > 0) {
      const chunkText = currentChunkWords.join('');
      if (chunkText.trim().length > 0) {
        const tokenCount = countTokens(chunkText);
        if (tokenCount > maxTokens) {
          const splitChunks = this.splitOversizedContent(
            chunkText,
            sourceUri,
            chunkIndex,
            lineStart,
            lineTracker,
            config,
          );
          chunks.push(...splitChunks);
        } else {
          const lineEnd = lineStart + chunkText.split('\n').length - 1;
          chunks.push({
            id: uuidv7(),
            sourceUri,
            chunkIndex,
            content: chunkText,
            contentHash: hashContent(chunkText),
            tokenCount,
            llmTokenCount: countLLMTokens(chunkText),
            metadata: {
              lineStart,
              lineEnd,
            },
          });
        }
      }
    }

    return chunks;
  }

  /**
   * Get the last N tokens worth of words for overlap.
   */
  private getOverlapWords(words: string[], targetTokens: number): string[] {
    const result: string[] = [];
    let tokenCount = 0;

    for (let i = words.length - 1; i >= 0; i--) {
      const wordTokens = countTokens(words[i]);
      if (tokenCount + wordTokens > targetTokens) break;
      result.unshift(words[i]);
      tokenCount += wordTokens;
    }

    return result;
  }

  /**
   * Split an oversized atomic unit at sentence boundaries,
   * marking all resulting chunks as a continuation group.
   */
  private splitOversizedContent(
    content: string,
    sourceUri: string,
    startIndex: number,
    lineStart: number,
    lineTracker: { current: number },
    config: ChunkingConfig,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    const continuationGroupId = uuidv7();
    const sentences = splitAtSentenceBoundaries(content);

    let currentSentences: string[] = [];
    let currentTokenCount = 0;
    let chunkIndex = startIndex;
    let currentLineStart = lineStart;

    const flushSentences = (): void => {
      const chunkText = currentSentences.join('');
      if (chunkText.trim().length === 0) return;

      const tokenCount = countTokens(chunkText);
      const lineEnd = currentLineStart + chunkText.split('\n').length - 1;

      // If joined sentences exceed maxTokens (non-additive token counting),
      // force-split at character level
      if (tokenCount > maxTokens) {
        const forceSplitChunks = this.forceSplitText(
          chunkText,
          sourceUri,
          chunkIndex,
          currentLineStart,
          config,
          continuationGroupId,
        );
        chunks.push(...forceSplitChunks);
        chunkIndex += forceSplitChunks.length;
      } else {
        chunks.push({
          id: uuidv7(),
          sourceUri,
          chunkIndex: chunkIndex++,
          content: chunkText,
          contentHash: hashContent(chunkText),
          tokenCount,
          llmTokenCount: countLLMTokens(chunkText),
          continuationGroupId,
          metadata: {
            lineStart: currentLineStart,
            lineEnd,
          },
        });
      }

      currentLineStart = lineEnd;
      currentSentences = [];
      currentTokenCount = 0;
    };

    for (const sentence of sentences) {
      const sentenceTokens = countTokens(sentence);

      // If a single sentence exceeds maxTokens, force-split at character level
      if (sentenceTokens > maxTokens) {
        // Flush anything accumulated
        if (currentSentences.length > 0) {
          flushSentences();
        }
        // Force split this sentence into maxTokens-sized pieces
        const forceSplitChunks = this.forceSplitText(
          sentence,
          sourceUri,
          chunkIndex,
          currentLineStart,
          config,
          continuationGroupId,
        );
        chunks.push(...forceSplitChunks);
        chunkIndex += forceSplitChunks.length;
        const newlines = (sentence.match(/\n/g) || []).length;
        currentLineStart += newlines;
        continue;
      }

      if (currentTokenCount + sentenceTokens > maxTokens && currentSentences.length > 0) {
        flushSentences();
      }

      currentSentences.push(sentence);
      currentTokenCount += sentenceTokens;
    }

    // Flush remaining
    if (currentSentences.length > 0) {
      flushSentences();
    }

    return chunks;
  }

  /**
   * Force-split text that cannot be split at sentence boundaries
   * (e.g., a single very long line) into character-based chunks.
   */
  private forceSplitText(
    text: string,
    sourceUri: string,
    startIndex: number,
    lineStart: number,
    config: ChunkingConfig,
    continuationGroupId: string,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    // Conservative estimate: maxTokens * 3 chars per chunk
    const charsPerChunk = maxTokens * 3;
    let chunkIndex = startIndex;
    let offset = 0;

    while (offset < text.length) {
      let end = Math.min(offset + charsPerChunk, text.length);

      // Try to find a word boundary near the end
      if (end < text.length) {
        const spaceIdx = text.lastIndexOf(' ', end);
        if (spaceIdx > offset) {
          end = spaceIdx + 1;
        }
      }

      let chunkText = text.slice(offset, end);
      let tokenCount = countTokens(chunkText);

      // Shrink if we overshot the token limit
      while (tokenCount > maxTokens && end > offset + 1) {
        end = Math.floor((offset + end) / 2);
        const spaceIdx = text.lastIndexOf(' ', end);
        if (spaceIdx > offset) {
          end = spaceIdx + 1;
        }
        chunkText = text.slice(offset, end);
        tokenCount = countTokens(chunkText);
      }

      const lineEnd = lineStart + chunkText.split('\n').length - 1;

      chunks.push({
        id: uuidv7(),
        sourceUri,
        chunkIndex: chunkIndex++,
        content: chunkText,
        contentHash: hashContent(chunkText),
        tokenCount: Math.min(tokenCount, maxTokens),
        llmTokenCount: countLLMTokens(chunkText),
        continuationGroupId,
        metadata: {
          lineStart,
          lineEnd,
        },
      });

      lineStart = lineEnd;
      offset = end;
    }

    return chunks;
  }
}
