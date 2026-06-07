/**
 * Context_Summarizer — compresses sub-task output and offloads full results to disk.
 *
 * Extends the existing Context_Compressor threshold logic. Preserves code snippets,
 * file paths, and error messages via PreservedMetadata extraction. Records compression
 * stats to Memory_Store.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextCompressor, PreservedMetadata, CodeSnippet } from '../session/context-compressor.js';
import { estimateTokens } from '../session/context-compressor.js';
import type { SummaryRecord, ContextSummarizerConfig } from './types/deerflow-types.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { sanitizeToolMessages, type ChatMessage } from './tool-message-sanitizer.js';
import { recordDroppedMessages, type MetricsSink } from './tool-sanitizer-telemetry.js';

// ─── Default configuration ──────────────────────────────────────
const DEFAULT_CONFIG: ContextSummarizerConfig = {
  maxSummaryTokens: 200,
  workspaceDir: '.neuronest/summaries',
  compressionThreshold: 0.80,
};

// ─── Metadata Extraction Helpers ────────────────────────────────

/** Extract fenced code blocks from content. */
function extractCodeSnippets(content: string): CodeSnippet[] {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const snippets: CodeSnippet[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    snippets.push({
      language: match[1] || 'text',
      code: match[2].trim(),
    });
  }
  return snippets;
}

/** Extract file paths from content. */
function extractFilePaths(content: string): string[] {
  const pathRegex = /(?:^|\s|['"`(])([./~][\w./-]+\.\w+)/g;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(content)) !== null) {
    paths.add(match[1]);
  }
  return [...paths];
}

/** Extract error messages from content. */
function extractErrorMessages(content: string): string[] {
  const errorRegex = /(?:Error|ERROR|error|Exception|EXCEPTION|exception|FAIL|fail|Failed|FAILED)[:\s](.+?)(?:\n|$)/g;
  const errors = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(content)) !== null) {
    errors.add(match[0].trim());
  }
  return [...errors];
}

/** Extract key decisions from content. */
function extractKeyDecisions(content: string): string[] {
  const decisionRegex = /(?:Decision|Decided|Conclusion|Resolved|Agreed)[:\s](.+?)(?:\n|$)/gi;
  const decisions = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = decisionRegex.exec(content)) !== null) {
    decisions.add(match[0].trim());
  }
  return [...decisions];
}

/** Extract all preserved metadata from a string. */
function extractPreservedMetadata(content: string): PreservedMetadata {
  return {
    filePaths: extractFilePaths(content),
    codeSnippets: extractCodeSnippets(content),
    errorMessages: extractErrorMessages(content),
    keyDecisions: extractKeyDecisions(content),
  };
}

// ─── Session Stats Tracker ──────────────────────────────────────
interface SessionStats {
  turnsCompressed: number;
  tokensSaved: number;
}

// ─── ContextSummarizer ─────────────────────────────────────────

export class ContextSummarizer {
  private readonly config: ContextSummarizerConfig;
  private readonly compressor: ContextCompressor | null;
  private memoryStore: MemoryStore | null;
  /**
   * Optional Metrics_Sink for F3 sanitizer telemetry (Feature 3, Requirement
   * 22.3). Wired via {@link setMetricsSink}; null disables emission (the
   * recorder remains fail-soft and logs in that case). Backward compatible.
   */
  private metricsSink: MetricsSink | null = null;

  /** summaryId → SummaryRecord */
  private readonly records = new Map<string, SummaryRecord>();
  /** summaryId → full result (in-memory fallback when fs write fails) */
  private readonly inMemoryFallback = new Map<string, string>();
  /** sessionId → cumulative stats */
  private readonly sessionStats = new Map<string, SessionStats>();

  constructor(config: Partial<ContextSummarizerConfig> & Pick<ContextSummarizerConfig, 'workspaceDir'>, compressor?: ContextCompressor | null, memoryStore?: MemoryStore | null) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compressor = compressor ?? null;
    this.memoryStore = memoryStore ?? null;
  }

  /** Allow setting the MemoryStore after construction. */
  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  /**
   * Wire an optional Metrics_Sink for F3 sanitizer telemetry. When set,
   * `summarize()` records `tool_sanitizer.dropped_messages` whenever the
   * sanitizer removes one or more messages (Requirement 22.3).
   */
  setMetricsSink(sink: MetricsSink | null): void {
    this.metricsSink = sink;
  }

  /**
   * Summarize a sub-task result. Offloads full result to disk as JSON.
   * The summary is truncated to fit within maxSummaryTokens (~800 chars for 200 tokens).
   *
   * Requirements: 2.1, 2.2, 2.5, 2.6, 2.7
   */
  summarize(sessionId: string, subTaskId: string, fullResult: string): SummaryRecord {
    const id = randomUUID();
    const maxChars = this.config.maxSummaryTokens * 4; // ~4 chars per token

    // Truncate/compress the output to fit within maxSummaryTokens
    let summary: string;
    if (fullResult.length <= maxChars) {
      summary = fullResult;
    } else {
      summary = fullResult.slice(0, maxChars - 3) + '...';
    }

    // Sanitize the compressed message array before returning so no invalid
    // tool-call sequence (orphan tool messages / dangling assistant tool_calls)
    // reaches the provider (Feature 3, Requirement 21). The summarized output
    // is a single assistant message; we frame it as a one-element ChatMessage
    // array, pass it through the sanitizer, and reflect the retained content
    // back into `summary` while preserving the SummaryRecord return shape.
    const summarized: ChatMessage[] = [
      { role: 'assistant', content: summary } as unknown as ChatMessage,
    ];
    const sanitized = sanitizeToolMessages(summarized);

    // F3 telemetry (Requirement 22.3): record the drop count when the
    // sanitizer removed one or more messages. Fail-soft — never affects the
    // SummaryRecord return value.
    recordDroppedMessages(this.metricsSink, summarized.length - sanitized.length, sessionId);

    const retained = sanitized[0] as unknown as { content?: string } | undefined;
    summary = retained && typeof retained.content === 'string' ? retained.content : '';

    // Extract preserved metadata from the FULL result (before truncation)
    const preservedMetadata = extractPreservedMetadata(fullResult);

    // Build the filesystem path for offloading
    const sessionDir = path.join(this.config.workspaceDir, sessionId);
    const filePath = path.join(sessionDir, `${subTaskId}.json`);

    // Attempt to offload full result to disk
    let offloadedToDisk = false;
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ fullResult }), 'utf-8');
      offloadedToDisk = true;
    } catch {
      // Requirement 2.6: retain full result in memory if fs write fails, log warning
      console.warn(
        `[ContextSummarizer] Failed to write offload file ${filePath}. Retaining full result in memory.`,
      );
      this.inMemoryFallback.set(id, fullResult);
    }

    const record: SummaryRecord = {
      id,
      sessionId,
      subTaskId,
      summary,
      fullResultPath: filePath,
      preservedMetadata,
      createdAt: new Date(),
    };

    this.records.set(id, record);

    // Update session stats
    const originalTokens = estimateTokens(fullResult);
    const summaryTokens = estimateTokens(summary);
    const tokensSaved = Math.max(0, originalTokens - summaryTokens);

    const stats = this.sessionStats.get(sessionId) ?? { turnsCompressed: 0, tokensSaved: 0 };
    stats.turnsCompressed += 1;
    stats.tokensSaved += tokensSaved;
    this.sessionStats.set(sessionId, stats);

    // Requirement 2.7: record stats to Memory_Store
    if (this.memoryStore) {
      try {
        this.memoryStore.recordStat(sessionId, stats.turnsCompressed, stats.tokensSaved);
      } catch {
        console.warn('[ContextSummarizer] Failed to record stat to MemoryStore');
      }
    }

    return record;
  }

  /**
   * Reload full result from disk (or in-memory fallback).
   *
   * Requirements: 2.2, 2.3
   */
  reload(summaryId: string): string {
    // Check in-memory fallback first
    const fallback = this.inMemoryFallback.get(summaryId);
    if (fallback !== undefined) {
      return fallback;
    }

    // Look up the record to find the file path
    const record = this.records.get(summaryId);
    if (!record) {
      throw new Error(`Summary record not found: ${summaryId}`);
    }

    try {
      const raw = fs.readFileSync(record.fullResultPath, 'utf-8');
      const parsed = JSON.parse(raw) as { fullResult: string };
      return parsed.fullResult;
    } catch (err) {
      throw new Error(`Failed to reload summary ${summaryId} from ${record.fullResultPath}: ${err}`);
    }
  }

  /**
   * Check if context usage exceeds threshold and summarization should be triggered.
   * Returns true iff currentTokens / windowSize > compressionThreshold.
   *
   * Requirements: 2.4
   */
  shouldSummarize(currentTokens: number, windowSize: number): boolean {
    if (windowSize <= 0) return false;
    return currentTokens / windowSize > this.config.compressionThreshold;
  }

  /**
   * Get compression stats for a session.
   *
   * Requirements: 2.7
   */
  getStats(sessionId: string): { turnsCompressed: number; tokensSaved: number } {
    return this.sessionStats.get(sessionId) ?? { turnsCompressed: 0, tokensSaved: 0 };
  }
}

export default ContextSummarizer;
