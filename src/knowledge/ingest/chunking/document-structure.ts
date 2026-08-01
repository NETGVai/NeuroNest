// ─── Document Structure Chunking Strategy ───────────────────────
// Splits text respecting document structure: sections, headings,
// and logical document units. Each heading starts a new chunk.
//
// Requirements: 30.1, 30.3, 30.5, 30.6

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
 * A structural section detected in the document.
 */
interface DocumentSection {
  /** The heading text (if any). */
  heading?: string;
  /** Heading level (1-6 for markdown, or inferred). */
  level: number;
  /** Section content including the heading line. */
  content: string;
  /** Start line in the original document. */
  lineStart: number;
  /** End line in the original document. */
  lineEnd: number;
  /** Detected language if this is a code section. */
  language?: string;
}

/**
 * Document-structure-aware chunking respects the logical structure
 * of documents by splitting at section boundaries (headings, major
 * divisions). It preserves document hierarchy context in metadata.
 *
 * Strategy:
 * 1. Parse document into a tree of sections based on headings
 * 2. Each section that fits in maxTokens becomes a chunk
 * 3. Sections exceeding maxTokens are split at sub-headings or paragraphs
 * 4. Orphan content before the first heading gets its own chunk
 */
export class DocumentStructureChunking implements ChunkingStrategy {
  chunk(content: string, sourceUri: string, config: ChunkingConfig): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];

    if (content.trim().length === 0) {
      return chunks;
    }

    // Parse into structural sections
    const sections = this.parseSections(content);
    let chunkIndex = 0;

    for (const section of sections) {
      const sectionTokens = countTokens(section.content);

      if (sectionTokens <= maxTokens) {
        // Section fits in a single chunk
        chunks.push({
          id: uuidv7(),
          sourceUri,
          chunkIndex: chunkIndex++,
          content: section.content,
          contentHash: hashContent(section.content),
          tokenCount: sectionTokens,
          llmTokenCount: countLLMTokens(section.content),
          metadata: {
            heading: section.heading,
            language: section.language,
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
          },
        });
      } else {
        // Section exceeds maxTokens - split at sub-boundaries
        const splitChunks = this.splitOversizedSection(
          section,
          sourceUri,
          chunkIndex,
          config,
        );
        chunks.push(...splitChunks);
        chunkIndex += splitChunks.length;
      }
    }

    // Post-process: ensure no chunk exceeds maxTokens
    // This handles edge cases where token counting is non-additive
    return this.enforceTokenLimit(chunks, sourceUri, config);

    return chunks;
  }

  /**
   * Parse document content into structural sections based on headings
   * and other structural markers.
   */
  private parseSections(content: string): DocumentSection[] {
    const lines = content.split('\n');
    const sections: DocumentSection[] = [];
    let currentLines: string[] = [];
    let currentHeading: string | undefined;
    let currentLevel = 0;
    let sectionStartLine = 1;
    let currentLanguage: string | undefined;

    const flushSection = (lineEnd: number): void => {
      if (currentLines.length === 0) return;
      const sectionContent = currentLines.join('\n');
      if (sectionContent.trim().length > 0) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: sectionContent + (lineEnd < lines.length ? '\n' : ''),
          lineStart: sectionStartLine,
          lineEnd,
          language: currentLanguage,
        });
      }
      currentLines = [];
      sectionStartLine = lineEnd + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect markdown headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();

        // Flush previous section before starting new heading
        if (currentLines.length > 0) {
          flushSection(lineNum - 1);
        }

        currentHeading = headingText;
        currentLevel = level;
        currentLanguage = undefined;
        currentLines.push(line);
        continue;
      }

      // Detect underline-style headings (Setext)
      if (i > 0 && currentLines.length > 0) {
        if (/^={3,}\s*$/.test(line)) {
          // H1 underline - the previous line was the heading
          const prevLine = currentLines[currentLines.length - 1];
          // Flush everything before the heading line
          if (currentLines.length > 1) {
            const headingLine = currentLines.pop()!;
            flushSection(lineNum - 2);
            currentLines.push(headingLine);
          }
          currentHeading = prevLine.trim();
          currentLevel = 1;
          currentLines.push(line);
          continue;
        }
        if (/^-{3,}\s*$/.test(line)) {
          // H2 underline or horizontal rule
          const prevLine = currentLines[currentLines.length - 1];
          if (prevLine && prevLine.trim().length > 0 && !/^[-\s]*$/.test(prevLine)) {
            if (currentLines.length > 1) {
              const headingLine = currentLines.pop()!;
              flushSection(lineNum - 2);
              currentLines.push(headingLine);
            }
            currentHeading = prevLine.trim();
            currentLevel = 2;
            currentLines.push(line);
            continue;
          }
        }
      }

      // Detect code block language markers
      if (line.trimStart().startsWith('```')) {
        const langMatch = line.match(/```(\w+)/);
        if (langMatch) {
          currentLanguage = langMatch[1];
        }
      }

      currentLines.push(line);
    }

    // Flush last section
    if (currentLines.length > 0) {
      flushSection(lines.length);
    }

    return sections;
  }

  /**
   * Split an oversized section into chunks.
   * First tries to split at paragraph boundaries, then falls back
   * to sentence boundaries if needed.
   */
  private splitOversizedSection(
    section: DocumentSection,
    sourceUri: string,
    startIndex: number,
    config: ChunkingConfig,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    const continuationGroupId = uuidv7();

    // Try splitting at paragraph boundaries (double newlines)
    const paragraphs = section.content.split(/\n\n+/);
    let currentParagraphs: string[] = [];
    let currentTokenCount = 0;
    let chunkIndex = startIndex;
    let currentLineStart = section.lineStart;

    const flushParagraphs = (): void => {
      const chunkText = currentParagraphs.join('\n\n');
      if (chunkText.trim().length === 0) return;

      const tokenCount = countTokens(chunkText);
      const lineEnd = currentLineStart + chunkText.split('\n').length - 1;

      if (tokenCount > maxTokens) {
        // Paragraph group still exceeds maxTokens - split at sentence level
        const sentenceChunks = this.splitAtSentences(
          chunkText,
          sourceUri,
          chunkIndex,
          currentLineStart,
          section,
          config,
          continuationGroupId,
        );
        chunks.push(...sentenceChunks);
        chunkIndex += sentenceChunks.length;
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
            heading: section.heading,
            language: section.language,
            lineStart: currentLineStart,
            lineEnd,
          },
        });
      }

      const newlines = (chunkText.match(/\n/g) || []).length;
      currentLineStart += newlines + 2; // +2 for the double newline separator
      currentParagraphs = [];
      currentTokenCount = 0;
    };

    for (const paragraph of paragraphs) {
      const paraTokens = countTokens(paragraph);

      // Single paragraph exceeds maxTokens
      if (paraTokens > maxTokens && currentParagraphs.length === 0) {
        currentParagraphs.push(paragraph);
        flushParagraphs();
        continue;
      }

      if (currentTokenCount + paraTokens > maxTokens && currentParagraphs.length > 0) {
        flushParagraphs();
      }

      currentParagraphs.push(paragraph);
      currentTokenCount += paraTokens;
    }

    // Flush remaining
    if (currentParagraphs.length > 0) {
      flushParagraphs();
    }

    return chunks;
  }

  /**
   * Split text at sentence boundaries as a last resort.
   */
  private splitAtSentences(
    text: string,
    sourceUri: string,
    startIndex: number,
    lineStart: number,
    section: DocumentSection,
    config: ChunkingConfig,
    continuationGroupId: string,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    const sentences = splitAtSentenceBoundaries(text);

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
      // force-split instead
      if (tokenCount > maxTokens) {
        const forceSplitChunks = this.forceSplitText(
          chunkText,
          sourceUri,
          chunkIndex,
          currentLineStart,
          section,
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
            heading: section.heading,
            language: section.language,
            lineStart: currentLineStart,
            lineEnd,
          },
        });
      }

      const newlines = (chunkText.match(/\n/g) || []).length;
      currentLineStart += newlines;
      currentSentences = [];
      currentTokenCount = 0;
    };

    for (const sentence of sentences) {
      const sentenceTokens = countTokens(sentence);

      // Force-split single sentences exceeding maxTokens
      if (sentenceTokens > maxTokens) {
        if (currentSentences.length > 0) {
          flushSentences();
        }
        const forceSplitChunks = this.forceSplitText(
          sentence,
          sourceUri,
          chunkIndex,
          currentLineStart,
          section,
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

    if (currentSentences.length > 0) {
      flushSentences();
    }

    return chunks;
  }

  /**
   * Force-split text at word boundaries when no sentence boundaries are available.
   */
  private forceSplitText(
    text: string,
    sourceUri: string,
    startIndex: number,
    lineStart: number,
    section: DocumentSection,
    config: ChunkingConfig,
    continuationGroupId: string,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    const charsPerChunk = maxTokens * 3;
    let chunkIndex = startIndex;
    let offset = 0;
    let currentLineStart = lineStart;

    while (offset < text.length) {
      let end = Math.min(offset + charsPerChunk, text.length);

      // Try to find a word boundary
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

      const lineEnd = currentLineStart + chunkText.split('\n').length - 1;

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
          heading: section.heading,
          language: section.language,
          lineStart: currentLineStart,
          lineEnd,
        },
      });

      currentLineStart = lineEnd;
      offset = end;
    }

    return chunks;
  }

  /**
   * Post-process chunks to enforce the token limit invariant.
   * Re-splits any chunk that exceeds maxTokens (can happen due to
   * non-additive token counting when segments are joined).
   */
  private enforceTokenLimit(
    chunks: KBChunk[],
    sourceUri: string,
    config: ChunkingConfig,
  ): KBChunk[] {
    const { maxTokens } = config;
    const result: KBChunk[] = [];
    let chunkIndex = 0;

    for (const chunk of chunks) {
      const actualTokenCount = countTokens(chunk.content);
      if (actualTokenCount <= maxTokens) {
        result.push({ ...chunk, chunkIndex: chunkIndex++, tokenCount: actualTokenCount });
      } else {
        // Re-split this chunk using sentence-level splitting
        const section: DocumentSection = {
          heading: chunk.metadata.heading,
          level: 0,
          content: chunk.content,
          lineStart: chunk.metadata.lineStart ?? 1,
          lineEnd: chunk.metadata.lineEnd ?? 1,
          language: chunk.metadata.language,
        };
        const splitChunks = this.splitOversizedSection(section, sourceUri, chunkIndex, config);
        result.push(...splitChunks);
        chunkIndex += splitChunks.length;
      }
    }

    return result;
  }
}
