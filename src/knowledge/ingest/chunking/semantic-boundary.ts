// ─── Semantic Boundary Chunking Strategy ────────────────────────
// Splits text at natural semantic boundaries: paragraphs, headers,
// code block boundaries, and function/class definitions.
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
 * Represents a semantic segment detected in the source text.
 */
interface SemanticSegment {
  content: string;
  heading?: string;
  language?: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Semantic boundary chunking detects natural boundaries in text
 * and splits at the nearest boundary that keeps each chunk under maxTokens.
 *
 * Boundaries detected:
 * - Blank lines (paragraph breaks)
 * - Markdown headings (# ## ###)
 * - Code block fences (```)
 * - Function/class definitions (function, class, export, def keywords)
 */
export class SemanticBoundaryChunking implements ChunkingStrategy {
  chunk(content: string, sourceUri: string, config: ChunkingConfig): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];

    if (content.trim().length === 0) {
      return chunks;
    }

    // Split into semantic segments
    const segments = this.detectSegments(content);

    let currentSegments: SemanticSegment[] = [];
    let currentTokenCount = 0;
    let chunkIndex = 0;

    const flushChunk = (): void => {
      if (currentSegments.length === 0) return;

      const chunkContent = currentSegments.map((s) => s.content).join('');
      if (chunkContent.trim().length === 0) {
        currentSegments = [];
        currentTokenCount = 0;
        return;
      }

      const tokenCount = countTokens(chunkContent);
      const firstSegment = currentSegments[0];
      const lastSegment = currentSegments[currentSegments.length - 1];

      // Find the most relevant heading (first segment's heading, or look backwards)
      const heading = currentSegments.find((s) => s.heading)?.heading;
      const language = currentSegments.find((s) => s.language)?.language;

      // If the joined content exceeds maxTokens (due to non-additive token counting),
      // split into oversized segment handling
      if (tokenCount > maxTokens) {
        const oversizedSegment: SemanticSegment = {
          content: chunkContent,
          heading,
          language,
          lineStart: firstSegment.lineStart,
          lineEnd: lastSegment.lineEnd,
        };
        const splitChunks = this.splitOversizedSegment(
          oversizedSegment,
          sourceUri,
          chunkIndex,
          config,
        );
        chunks.push(...splitChunks);
        chunkIndex += splitChunks.length;
      } else {
        chunks.push({
          id: uuidv7(),
          sourceUri,
          chunkIndex: chunkIndex++,
          content: chunkContent,
          contentHash: hashContent(chunkContent),
          tokenCount,
          llmTokenCount: countLLMTokens(chunkContent),
          metadata: {
            heading,
            language,
            lineStart: firstSegment.lineStart,
            lineEnd: lastSegment.lineEnd,
          },
        });
      }

      currentSegments = [];
      currentTokenCount = 0;
    };

    for (const segment of segments) {
      const segmentTokens = countTokens(segment.content);

      // If a single segment exceeds maxTokens, split it further
      if (segmentTokens > maxTokens) {
        // Flush accumulated content first
        if (currentSegments.length > 0) {
          flushChunk();
        }

        // Split the oversized segment at sentence boundaries
        const splitChunks = this.splitOversizedSegment(
          segment,
          sourceUri,
          chunkIndex,
          config,
        );
        chunks.push(...splitChunks);
        chunkIndex += splitChunks.length;
        continue;
      }

      // If adding this segment would exceed maxTokens, flush current chunk
      if (currentTokenCount + segmentTokens > maxTokens && currentSegments.length > 0) {
        flushChunk();
      }

      currentSegments.push(segment);
      currentTokenCount += segmentTokens;
    }

    // Flush remaining
    flushChunk();

    return chunks;
  }

  /**
   * Detect semantic segments by splitting at natural boundaries.
   */
  private detectSegments(content: string): SemanticSegment[] {
    const lines = content.split('\n');
    const segments: SemanticSegment[] = [];
    let currentLines: string[] = [];
    let currentHeading: string | undefined;
    let currentLanguage: string | undefined;
    let segmentStartLine = 1;
    let inCodeBlock = false;
    let codeBlockLanguage: string | undefined;

    const flushSegment = (lineEnd: number): void => {
      if (currentLines.length === 0) return;
      const segContent = currentLines.join('\n');
      if (segContent.trim().length > 0) {
        segments.push({
          content: segContent + '\n',
          heading: currentHeading,
          language: currentLanguage,
          lineStart: segmentStartLine,
          lineEnd,
        });
      }
      currentLines = [];
      segmentStartLine = lineEnd + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Code block fence detection
      if (line.trimStart().startsWith('```')) {
        if (!inCodeBlock) {
          // Opening a code block - flush previous segment
          flushSegment(lineNum - 1);
          inCodeBlock = true;
          const langMatch = line.match(/```(\w+)/);
          codeBlockLanguage = langMatch ? langMatch[1] : undefined;
          currentLanguage = codeBlockLanguage;
          currentLines.push(line);
          continue;
        } else {
          // Closing a code block
          currentLines.push(line);
          inCodeBlock = false;
          flushSegment(lineNum);
          currentLanguage = undefined;
          codeBlockLanguage = undefined;
          continue;
        }
      }

      // Inside code block - accumulate without splitting
      if (inCodeBlock) {
        currentLines.push(line);
        continue;
      }

      // Markdown heading detection
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        // Flush previous content before heading
        flushSegment(lineNum - 1);
        currentHeading = headingMatch[2].trim();
        currentLines.push(line);
        continue;
      }

      // Function/class definition detection (common patterns)
      if (this.isFunctionOrClassBoundary(line) && currentLines.length > 0) {
        // Flush previous content
        flushSegment(lineNum - 1);
        currentLines.push(line);
        continue;
      }

      // Blank line detection (paragraph boundary)
      if (line.trim() === '' && currentLines.length > 0) {
        // Only split on blank lines if we have substantial content
        const currentContent = currentLines.join('\n');
        if (countTokens(currentContent) > 50) {
          currentLines.push(line);
          flushSegment(lineNum);
          continue;
        }
      }

      currentLines.push(line);
    }

    // Flush remaining
    if (currentLines.length > 0) {
      flushSegment(lines.length);
    }

    return segments;
  }

  /**
   * Check if a line starts a function or class definition.
   */
  private isFunctionOrClassBoundary(line: string): boolean {
    const trimmed = line.trimStart();
    return (
      /^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed) ||
      /^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed) ||
      /^(export\s+)?interface\s+\w+/.test(trimmed) ||
      /^(export\s+)?enum\s+\w+/.test(trimmed) ||
      /^(export\s+)?type\s+\w+\s*=/.test(trimmed) ||
      /^def\s+\w+/.test(trimmed) ||
      /^class\s+\w+/.test(trimmed)
    );
  }

  /**
   * Split an oversized segment at sentence boundaries,
   * marking all resulting chunks as a continuation group.
   */
  private splitOversizedSegment(
    segment: SemanticSegment,
    sourceUri: string,
    startIndex: number,
    config: ChunkingConfig,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    const continuationGroupId = uuidv7();
    const sentences = splitAtSentenceBoundaries(segment.content);

    let currentSentences: string[] = [];
    let currentTokenCount = 0;
    let chunkIndex = startIndex;
    let currentLineStart = segment.lineStart;

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
          segment,
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
            heading: segment.heading,
            language: segment.language,
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

      // If a single sentence still exceeds maxTokens, force-split
      if (sentenceTokens > maxTokens) {
        if (currentSentences.length > 0) {
          flushSentences();
        }
        const forceSplitChunks = this.forceSplitText(
          sentence,
          sourceUri,
          chunkIndex,
          currentLineStart,
          segment,
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
   * Force-split text that exceeds maxTokens even at sentence level.
   */
  private forceSplitText(
    text: string,
    sourceUri: string,
    startIndex: number,
    lineStart: number,
    segment: SemanticSegment,
    config: ChunkingConfig,
    continuationGroupId: string,
  ): KBChunk[] {
    const { maxTokens } = config;
    const chunks: KBChunk[] = [];
    // Use a conservative chars-per-chunk estimate: maxTokens * 3
    // to reduce overshooting, then verify actual count
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
        // Find word boundary
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
          heading: segment.heading,
          language: segment.language,
          lineStart: currentLineStart,
          lineEnd,
        },
      });

      currentLineStart = lineEnd;
      offset = end;
    }

    return chunks;
  }
}
