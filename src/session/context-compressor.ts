import type { Session, Message } from '../shared/types.js';
import { computeInputTokenBudget, resolveBudgetInputs } from '../pipeline/token-budget.js';
import { getActiveContextLength } from '../pipeline/active-model.js';

// ─── Context Compressor Types ──────────────────────────────────

export interface CodeSnippet {
  language: string;
  code: string;
  filePath?: string;
}

export interface PreservedMetadata {
  filePaths: string[];
  codeSnippets: CodeSnippet[];
  errorMessages: string[];
  keyDecisions: string[];
}

export interface CompressionResult {
  turnsCompressed: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  preservedMetadata: PreservedMetadata;
}

export interface CompressionEvent {
  sessionId: string;
  timestamp: Date;
  turnsCompressed: number;
  tokensSaved: number;
}

export interface ContextCompressorConfig {
  /** Fraction of context window that triggers compression (default 0.80) */
  threshold: number;
  /** Number of recent turns to keep in full (default 10) */
  keepRecentTurns: number;
  /** Model context window size in tokens (default 128000) */
  contextWindowSize: number;
}

const DEFAULT_CONFIG: ContextCompressorConfig = {
  threshold: 0.80,
  keepRecentTurns: 10,
  contextWindowSize: 128_000,
};

// ─── Metadata Extraction Helpers ───────────────────────────────

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract file paths from message content */
function extractFilePaths(content: string): string[] {
  // Match common file path patterns
  const pathRegex = /(?:^|\s|['"`(])([./~][\w./-]+\.\w+)/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/** Extract code snippets from markdown fenced code blocks */
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

/** Extract error messages from content */
function extractErrorMessages(content: string): string[] {
  const errorRegex = /(?:Error|ERROR|error|Exception|EXCEPTION|exception|FAIL|fail|Failed|FAILED)[:\s](.+?)(?:\n|$)/g;
  const errors: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(content)) !== null) {
    errors.push(match[0].trim());
  }
  return errors;
}

/** Extract key decisions (lines starting with "Decision:", "Decided:", etc.) */
function extractKeyDecisions(content: string): string[] {
  const decisionRegex = /(?:Decision|Decided|Conclusion|Resolved|Agreed)[:\s](.+?)(?:\n|$)/gi;
  const decisions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = decisionRegex.exec(content)) !== null) {
    decisions.push(match[0].trim());
  }
  return decisions;
}

/** Extract all metadata from a set of messages */
function extractMetadata(messages: Message[]): PreservedMetadata {
  const filePaths = new Set<string>();
  const codeSnippets: CodeSnippet[] = [];
  const errorMessages = new Set<string>();
  const keyDecisions = new Set<string>();

  for (const msg of messages) {
    for (const p of extractFilePaths(msg.content)) filePaths.add(p);
    codeSnippets.push(...extractCodeSnippets(msg.content));
    for (const e of extractErrorMessages(msg.content)) errorMessages.add(e);
    for (const d of extractKeyDecisions(msg.content)) keyDecisions.add(d);
  }

  return {
    filePaths: [...filePaths],
    codeSnippets,
    errorMessages: [...errorMessages],
    keyDecisions: [...keyDecisions],
  };
}

// ─── ContextCompressor ─────────────────────────────────────────

export class ContextCompressor {
  private config: ContextCompressorConfig;
  private compressionHistory: Map<string, CompressionEvent[]> = new Map();
  private fullHistories: Map<string, Message[]> = new Map();

  constructor(config?: Partial<ContextCompressorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Monitor a session's token count vs the model context window.
   * Returns true if compression is needed (token count >= limit).
   *
   * When an explicit `inputBudget` is supplied it overrides the config-derived
   * threshold: the limit is sized by the shared Adaptive_Token_Budget
   * calculator using the active model's context window (resolved via
   * `getActiveContextLength`, falling back to the configured window). When no
   * budget is supplied, the pre-existing `threshold * contextWindowSize`
   * behavior is preserved unchanged.
   *
   * Requirements: 13.1, 13.2, 19.1
   */
  monitor(session: Session, inputBudget?: number | null): boolean {
    const totalTokens = session.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    const { configured, explicit } = resolveBudgetInputs(inputBudget);

    let limit: number;
    if (explicit) {
      // Explicit override: size the limit via the shared calculator. Resolve
      // the active model's context length through the F2 resolver, falling
      // back to the configured window when undeterminable (resolver → 0).
      const contextLength = getActiveContextLength({
        contextLength: this.config.contextWindowSize,
      });
      limit = computeInputTokenBudget(configured, contextLength, true);
    } else {
      // No explicit budget — preserve existing behavior exactly.
      limit = this.config.threshold * this.config.contextWindowSize;
    }

    return totalTokens >= limit;
  }

  /**
   * Compress a session by summarizing older turns and preserving recent turns in full.
   * Extracts and preserves metadata (file paths, code snippets, error messages, key decisions).
   * Requirements: 19.1, 19.2, 19.3, 19.5, 19.6
   */
  compress(session: Session): CompressionResult {
    const messages = session.messages;
    const tokensBefore = messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    // Store full history before compression
    const existing = this.fullHistories.get(session.id) ?? [];
    this.fullHistories.set(session.id, [...existing, ...messages]);

    // Split into older turns (to compress) and recent turns (to keep)
    const keepCount = Math.min(this.config.keepRecentTurns, messages.length);
    const splitIndex = messages.length - keepCount;
    const olderMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    if (olderMessages.length === 0) {
      return {
        turnsCompressed: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
        tokensSaved: 0,
        preservedMetadata: { filePaths: [], codeSnippets: [], errorMessages: [], keyDecisions: [] },
      };
    }

    // Extract metadata from older messages
    const preservedMetadata = extractMetadata(olderMessages);

    // Create summary of older turns (stub: concatenate role + truncated content)
    const summaryParts = olderMessages.map(
      (m) => `[${m.role}]: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`,
    );
    const summaryContent = `[Compressed ${olderMessages.length} turns]\n${summaryParts.join('\n')}`;

    const summaryMessage: Message = {
      id: `compressed-${session.id}-${Date.now()}`,
      sessionId: session.id,
      role: 'system',
      content: summaryContent,
      createdAt: new Date(),
    };

    // Replace session messages with summary + recent
    session.messages.length = 0;
    session.messages.push(summaryMessage, ...recentMessages);

    const tokensAfter = session.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    const event: CompressionEvent = {
      sessionId: session.id,
      timestamp: new Date(),
      turnsCompressed: olderMessages.length,
      tokensSaved: tokensBefore - tokensAfter,
    };

    const history = this.compressionHistory.get(session.id) ?? [];
    history.push(event);
    this.compressionHistory.set(session.id, history);

    return {
      turnsCompressed: olderMessages.length,
      tokensBefore,
      tokensAfter,
      tokensSaved: tokensBefore - tokensAfter,
      preservedMetadata,
    };
  }

  /**
   * Get the compression history for a session.
   * Requirements: 19.5
   */
  getCompressionHistory(sessionId: string): CompressionEvent[] {
    return this.compressionHistory.get(sessionId) ?? [];
  }

  /**
   * Get the full uncompressed message history for a session.
   * Requirements: 19.7
   */
  getFullHistory(sessionId: string): Message[] {
    return this.fullHistories.get(sessionId) ?? [];
  }
}
