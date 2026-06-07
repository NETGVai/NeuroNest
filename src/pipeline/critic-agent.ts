/**
 * Critic Agent — Post-agent validation loop with hallucination scoring
 *
 * Evaluates primary agent outputs for factual accuracy by verifying file paths,
 * code references, and claims against the Knowledge Graph and grounding context.
 * Implements a retry loop that re-prompts agents when hallucination scores exceed
 * the threshold, and delivers the best response with a disclaimer on final failure.
 *
 * Requirement Coverage: Req 3 (AC 3–7), Req 5 (AC 1–5), Req 7 (AC 3)
 */

import fs from 'node:fs';
import { GroundingContext } from './grounding-enforcer';
import type { LineageTracker } from '../indexing/lineage-tracker.js';

export interface CriticResult {
  hallucinationScore: number; // 0.0 - 1.0
  flaggedClaims: FlaggedClaim[];
  feedback: string;
  passed: boolean;
}

export interface FlaggedClaim {
  claim: string;
  reason: 'no_source_match' | 'nonexistent_reference' | 'contradicts_memory';
  severity: 'low' | 'medium' | 'high';
}

export interface LineageVerificationResult {
  status: 'valid' | 'stale' | 'mismatch';
  nodeId: string;
  filePath?: string;
  details?: string;
}

export class CriticAgent {
  private maxRetries = 3;
  private scoreThreshold = 0.6;
  private timeoutMs = 5000;
  private lineageTracker: LineageTracker | null = null;

  constructor(
    private graphManager: any,
    private db: any,
    private projectId: string,
    lineageTracker?: LineageTracker
  ) {
    if (lineageTracker) {
      this.lineageTracker = lineageTracker;
    }
  }

  /**
   * Extract file path patterns from agent output text.
   * Matches patterns like `src/path/file.ts`, `./relative/path.js`, etc.
   * Filters out URLs (http/https) to avoid false positives.
   *
   * Validates: Req 5 AC 3
   */
  extractFilePaths(text: string): string[] {
    // Match file paths: word chars, hyphens, dots, slashes followed by a file extension
    const pathRegex = /(?:^|[\s`"'(])([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/gm;
    const dotSlashRegex = /(?:^|[\s`"'(])(\.\/[a-zA-Z0-9_./\-]+\.[a-zA-Z0-9]+)/gm;

    const matches = new Set<string>();

    let match: RegExpExecArray | null;

    while ((match = pathRegex.exec(text)) !== null) {
      const path = match[1].replace(/^[`"']+|[`"']+$/g, '');
      if (!path.startsWith('http://') && !path.startsWith('https://')) {
        matches.add(path);
      }
    }

    while ((match = dotSlashRegex.exec(text)) !== null) {
      const path = match[1].replace(/^[`"']+|[`"']+$/g, '');
      if (!path.startsWith('http://') && !path.startsWith('https://')) {
        matches.add(path);
      }
    }

    return Array.from(matches);
  }

  /**
   * Extract backtick-wrapped code identifiers from agent output text.
   * Matches patterns like `functionName`, `ClassName.method()`, `someModule.export`
   *
   * Validates: Req 5 AC 3
   */
  extractCodeReferences(text: string): string[] {
    const codeRefRegex = /`([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*(?:\(\))?)`/g;
    const refs = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = codeRefRegex.exec(text)) !== null) {
      const ref = match[1];
      // Filter out single-character refs and common non-code terms
      if (ref.length > 1) {
        refs.add(ref);
      }
    }

    return Array.from(refs);
  }

  /**
   * Verify if a file path exists in the Knowledge Graph nodes.
   * Returns true if the path is found or if the graph is unavailable (can't verify).
   *
   * Validates: Req 5 AC 3-4
   */
  async verifyFileInGraph(filePath: string): Promise<boolean> {
    try {
      if (!this.graphManager || !this.graphManager.hasGraph(this.projectId)) {
        return true; // Can't verify without graph — assume valid
      }

      const graph = await this.graphManager.loadGraph(this.projectId);
      if (!graph || !graph.nodes) {
        return true; // No graph data — assume valid
      }

      return graph.nodes.some(
        (n: any) => n.id.includes(filePath) || n.label.includes(filePath)
      );
    } catch (e: any) {
      console.warn('[CriticAgent] verifyFileInGraph error:', e?.message);
      return true; // On error, don't block — assume valid
    }
  }

  /**
   * Verify if a code identifier exists in the Knowledge Graph node labels.
   * Returns true if the identifier is found or if the graph is unavailable.
   *
   * Validates: Req 5 AC 3-4
   */
  async verifyCodeRefInGraph(ref: string): Promise<boolean> {
    try {
      if (!this.graphManager || !this.graphManager.hasGraph(this.projectId)) {
        return true; // Can't verify without graph — assume valid
      }

      const graph = await this.graphManager.loadGraph(this.projectId);
      if (!graph || !graph.nodes) {
        return true; // No graph data — assume valid
      }

      return graph.nodes.some((n: any) => n.label.includes(ref));
    } catch (e: any) {
      console.warn('[CriticAgent] verifyCodeRefInGraph error:', e?.message);
      return true; // On error, don't block — assume valid
    }
  }

  /**
   * Verify lineage for a graph node by checking that the claimed content
   * matches the actual source file content at the recorded byte range.
   *
   * Queries the `lineage` table by node_id to get file_path and byte range,
   * reads the source file at that byte range, and compares against the
   * claimed content.
   *
   * Returns:
   * - 'valid': The source file content at the byte range matches the claimed content
   * - 'stale': The lineage record is marked as stale (byte range may be invalid)
   * - 'mismatch': The source file content does not match the claimed content
   *
   * Validates: Req 7 AC 3
   */
  async verifyLineage(nodeId: string, claimedContent: string): Promise<LineageVerificationResult> {
    try {
      if (!this.lineageTracker) {
        // No lineage tracker available — cannot verify, assume valid
        return { status: 'valid', nodeId, details: 'Lineage tracker unavailable' };
      }

      const records = this.lineageTracker.getByNodeId(nodeId);

      if (records.length === 0) {
        // No lineage records found for this node — cannot verify
        return { status: 'mismatch', nodeId, details: 'No lineage records found for node' };
      }

      // Check the first (most relevant) lineage record
      const record = records[0];

      // If the record is already marked stale, return stale immediately
      if (record.isStale) {
        return {
          status: 'stale',
          nodeId,
          filePath: record.filePath,
          details: 'Lineage record is marked as stale',
        };
      }

      // Read the source file at the byte range
      let fileContent: Buffer;
      try {
        const fd = fs.openSync(record.filePath, 'r');
        const length = record.endByte - record.startByte;
        fileContent = Buffer.alloc(length);
        fs.readSync(fd, fileContent, 0, length, record.startByte);
        fs.closeSync(fd);
      } catch (fileErr: any) {
        // File doesn't exist or can't be read — record is stale
        return {
          status: 'stale',
          nodeId,
          filePath: record.filePath,
          details: `Cannot read source file: ${fileErr?.message}`,
        };
      }

      // Compare the file content at the byte range against the claimed content
      const actualContent = fileContent.toString('utf-8');
      const normalizedActual = actualContent.trim();
      const normalizedClaimed = claimedContent.trim();

      if (normalizedActual === normalizedClaimed) {
        return {
          status: 'valid',
          nodeId,
          filePath: record.filePath,
        };
      }

      return {
        status: 'mismatch',
        nodeId,
        filePath: record.filePath,
        details: 'Source file content does not match claimed content',
      };
    } catch (e: any) {
      console.warn('[CriticAgent] verifyLineage error:', e?.message);
      // On unexpected error, report as stale to be safe
      return {
        status: 'stale',
        nodeId,
        details: `Verification error: ${e?.message}`,
      };
    }
  }

  /**
   * Evaluate an agent response for hallucination with timeout enforcement.
   * If evaluate() takes longer than 5 seconds, resolves with a pass-through
   * result rather than blocking the pipeline.
   *
   * Validates: Req 3 AC 7, Req 9 AC 4
   */
  async evaluateWithTimeout(
    response: string,
    groundingContext: GroundingContext,
    agentId: string
  ): Promise<CriticResult> {
    const timeoutPromise = new Promise<CriticResult>((resolve) => {
      setTimeout(() => resolve({
        passed: true,
        hallucinationScore: 0,
        flaggedClaims: [],
        feedback: '',
      }), this.timeoutMs);
    });

    return Promise.race([
      this.evaluate(response, groundingContext, agentId),
      timeoutPromise,
    ]);
  }

  /**
   * Evaluate an agent response for hallucination.
   *
   * Checks:
   * 1. File paths mentioned → verify exist in Knowledge Graph
   * 2. Function/class names → verify exist in Knowledge Graph
   * 3. Calculate ungrounded ratio and hallucination score
   *
   * hallucinationScore = min(1.0, ungroundedRatio × 1.5)
   * passed = hallucinationScore <= scoreThreshold (0.6)
   *
   * Validates: Req 3 AC 3-5, Req 5 AC 1-5
   */
  async evaluate(
    response: string,
    groundingContext: GroundingContext,
    agentId: string,
    taskDescription?: string
  ): Promise<CriticResult> {
    const flaggedClaims: FlaggedClaim[] = [];

    // Detect creative/generative task (Req 9 AC 2, 5)
    const isCreative = taskDescription
      ? /\b(create|build|write|generate|scaffold|implement new|design new)\b/i.test(taskDescription)
      : false;

    // Collect known paths from grounding context sources for creative task comparison
    const knownSourcePaths = new Set<string>();
    if (isCreative) {
      for (const source of groundingContext.sources) {
        // Extract file paths from source content/id
        const pathMatch = source.content.match(/[\w\-./]+\.\w+/g);
        if (pathMatch) {
          for (const p of pathMatch) knownSourcePaths.add(p);
        }
        if (source.id.startsWith('file:')) {
          knownSourcePaths.add(source.id.replace('file:', ''));
        }
      }
    }

    // 1. Extract and verify file path references
    const filePaths = this.extractFilePaths(response);
    for (const fp of filePaths) {
      // For creative tasks: skip verification for paths that don't exist yet
      // Only flag paths that SHOULD exist based on grounding context but are referenced incorrectly
      if (isCreative) {
        // If the path is not in the known sources, it's likely a new file being created — skip
        const isKnownPath = Array.from(knownSourcePaths).some(
          known => fp.includes(known) || known.includes(fp)
        );
        if (!isKnownPath) {
          continue; // New path for creative task — don't flag
        }
      }

      const exists = await this.verifyFileInGraph(fp);
      if (!exists) {
        flaggedClaims.push({
          claim: fp,
          reason: 'nonexistent_reference',
          severity: 'high',
        });
      }
    }

    // 2. Extract and verify code references (backtick-wrapped identifiers)
    const codeRefs = this.extractCodeReferences(response);
    for (const ref of codeRefs) {
      const exists = await this.verifyCodeRefInGraph(ref);
      if (!exists) {
        flaggedClaims.push({
          claim: ref,
          reason: 'nonexistent_reference',
          severity: 'medium',
        });
      }
    }

    // 3. Calculate hallucination score based on ungrounded ratio
    const totalClaims = filePaths.length + codeRefs.length;
    const ungroundedRatio = totalClaims > 0
      ? flaggedClaims.length / totalClaims
      : 0;

    // hallucinationScore = min(1.0, ungroundedRatio × 1.5)
    const hallucinationScore = Math.min(1.0, ungroundedRatio * 1.5);

    return {
      hallucinationScore,
      flaggedClaims,
      feedback: this.buildFeedback(flaggedClaims),
      passed: hallucinationScore <= this.scoreThreshold,
    };
  }

  /**
   * Run the full critic evaluation loop with retries.
   * Retries up to maxRetries (3) times, tracking the best score.
   * Returns the best response with a disclaimer on final failure.
   *
   * Validates: Req 3 AC 4-6
   */
  async evaluateWithRetry(
    getResponse: () => Promise<string>,
    groundingContext: GroundingContext,
    agentId: string
  ): Promise<{ finalResponse: string; result: CriticResult; attempts: number }> {
    let bestResponse = '';
    let bestScore = Infinity;
    let bestResult: CriticResult | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const response = await getResponse();
      const result = await this.evaluate(response, groundingContext, agentId);

      if (result.passed) {
        return { finalResponse: response, result, attempts: attempt + 1 };
      }

      // Track the best (lowest) hallucination score
      if (result.hallucinationScore < bestScore) {
        bestScore = result.hallucinationScore;
        bestResponse = response;
        bestResult = result;
      }
    }

    // All retries failed — return best response with disclaimer
    const disclaimer =
      '⚠️ *Response confidence: reduced* — Some claims could not be verified against project sources.\n\n';

    return {
      finalResponse: disclaimer + bestResponse,
      result: bestResult || {
        hallucinationScore: bestScore,
        flaggedClaims: [],
        feedback: '',
        passed: false,
      },
      attempts: this.maxRetries,
    };
  }

  /**
   * Build human-readable feedback from flagged claims.
   * Used to provide the agent with specific guidance on what to fix.
   */
  private buildFeedback(claims: FlaggedClaim[]): string {
    if (claims.length === 0) return '';

    return (
      'The following references could not be verified:\n' +
      claims.map((c) => `- ${c.claim} (${c.reason})`).join('\n') +
      '\nPlease verify these exist or remove them from your response.'
    );
  }
}
