/**
 * CodeReviewPipeline — Multi-agent review orchestrator.
 *
 * Accepts diff input from multiple sources (staged changes, PRs, worktree
 * comparisons, manual text), routes them to specialized review agents
 * (security, performance, style) in parallel, aggregates findings into a
 * structured review, and generates an overall score (0-100) across five
 * dimensions: correctness, security, performance, readability, maintainability.
 *
 * Integration:
 * - Uses Provider Registry for model selection (standard tier for review depth)
 * - Feature-gated behind `code_review_pipeline` flag
 * - Follows NeuroNest's lazy-initialized TypeScript singleton pattern
 * - Agents from the agent registry (security-engineer, performance-engineer, senior-developer)
 *
 * Requirements: 4.1, 4.2, 4.5
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Source types for diff input (Req 4.1) */
export type DiffSource = 'staged' | 'pr' | 'worktree' | 'manual';

/** Severity levels for review findings */
export type ReviewSeverity = 'critical' | 'warning' | 'info';

/** Categories for review findings */
export type ReviewCategory = 'security' | 'performance' | 'style' | 'correctness' | 'maintainability';

/** Score dimensions (Req 4.5) */
export type ScoreDimension = 'correctness' | 'security' | 'performance' | 'readability' | 'maintainability';

/** Input options for the review pipeline */
export interface ReviewPipelineInput {
  /** Source type of the diff (Req 4.1) */
  source: DiffSource;
  /** Project working directory for git operations */
  cwd: string;
  /** PR number (required when source is 'pr') */
  prNumber?: number;
  /** GitHub repository (owner/repo format, required for PR source) */
  repository?: string;
  /** GitHub API token (required for PR source) */
  githubToken?: string;
  /** Worktree branch name (required when source is 'worktree') */
  worktreeBranch?: string;
  /** Base branch for comparison (default: 'main') */
  baseBranch?: string;
  /** Manual diff text (required when source is 'manual') */
  manualDiff?: string;
  /** Project ID for database tracking */
  projectId?: string;
}

/** A single review finding from a specialized agent */
export interface ReviewFinding {
  /** Unique identifier */
  id: string;
  /** File path where the issue was found */
  filePath: string;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine: number;
  /** Severity level */
  severity: ReviewSeverity;
  /** Category of the finding */
  category: ReviewCategory;
  /** Description of the issue */
  message: string;
  /** Suggested fix */
  suggestedFix?: string;
  /** ID of the reviewing agent */
  agentId: string;
}

/** Score breakdown across all dimensions (Req 4.5) */
export interface ReviewScores {
  correctness: number;
  security: number;
  performance: number;
  readability: number;
  maintainability: number;
  /** Weighted overall score (0-100) */
  overall: number;
}

/** Complete review result from the pipeline */
export interface ReviewResult {
  /** Unique review identifier */
  id: string;
  /** Source of the diff */
  source: DiffSource;
  /** Source reference (PR number, branch, etc.) */
  sourceRef: string | undefined;
  /** All findings from specialized agents */
  findings: ReviewFinding[];
  /** Score breakdown */
  scores: ReviewScores;
  /** Review status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Error message if status is 'failed' */
  error: string | undefined;
  /** Timestamp of creation */
  createdAt: number;
  /** Timestamp of completion */
  completedAt: number | undefined;
}

/** Result from a single specialized review agent */
export interface AgentReviewResult {
  agentId: string;
  findings: ReviewFinding[];
  dimensionScores: Partial<Record<ScoreDimension, number>>;
  success: boolean;
  error?: string;
}

/** Interface for feature gate dependency injection */
export interface FeatureGateCheck {
  isEnabled(feature: string): boolean;
}

/** Interface for the LLM client used by review agents */
export interface ReviewLLMClient {
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ content: string }>;
}

/** Configuration for the review pipeline */
export interface ReviewPipelineConfig {
  /** Feature gate system for checking enabled state */
  featureGate: FeatureGateCheck;
  /** LLM client for agent invocations */
  llmClient: ReviewLLMClient;
  /** Maximum diff size in characters (larger diffs are truncated) */
  maxDiffSize?: number;
  /** Timeout for individual agent reviews in milliseconds */
  agentTimeoutMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default maximum diff size in characters */
const DEFAULT_MAX_DIFF_SIZE = 100_000;

/** Default per-agent timeout (60 seconds) */
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/** Dimension weights for overall score calculation */
const DIMENSION_WEIGHTS: Record<ScoreDimension, number> = {
  correctness: 0.3,
  security: 0.25,
  performance: 0.2,
  readability: 0.15,
  maintainability: 0.1,
};

/** Specialized agent system prompts */
const AGENT_PROMPTS: Record<string, string> = {
  'security-reviewer': `You are a senior security engineer reviewing code for vulnerabilities.
Focus on: injection flaws, authentication/authorization issues, data exposure, cryptographic weaknesses, SSRF, path traversal, and insecure deserialization.
For each issue found, provide:
- File path and line range
- Severity (critical/warning/info)
- Clear description of the vulnerability
- Suggested fix with code

Also rate the code on a scale of 0-100 for the "security" dimension.
Respond in JSON format:
{
  "findings": [{ "filePath": "", "startLine": 0, "endLine": 0, "severity": "", "message": "", "suggestedFix": "" }],
  "scores": { "security": 85 }
}`,

  'performance-engineer': `You are a senior performance engineer reviewing code for efficiency issues.
Focus on: algorithmic complexity, unnecessary allocations, N+1 queries, blocking I/O on main thread, missing caching, memory leaks, and unoptimized loops.
For each issue found, provide:
- File path and line range
- Severity (critical/warning/info)
- Clear description of the performance issue
- Suggested fix with code

Also rate the code on a scale of 0-100 for the "performance" dimension.
Respond in JSON format:
{
  "findings": [{ "filePath": "", "startLine": 0, "endLine": 0, "severity": "", "message": "", "suggestedFix": "" }],
  "scores": { "performance": 85 }
}`,

  'style-reviewer': `You are a senior developer reviewing code for style, readability, maintainability, and correctness.
Focus on: naming conventions, code organization, error handling, documentation, type safety, code duplication, SOLID principles, and logical errors.
For each issue found, provide:
- File path and line range
- Severity (critical/warning/info)
- Category: one of "style", "correctness", "maintainability"
- Clear description of the issue
- Suggested fix with code

Also rate the code on a scale of 0-100 for these dimensions: "correctness", "readability", "maintainability".
Respond in JSON format:
{
  "findings": [{ "filePath": "", "startLine": 0, "endLine": 0, "severity": "", "category": "", "message": "", "suggestedFix": "" }],
  "scores": { "correctness": 85, "readability": 80, "maintainability": 80 }
}`,
};

// ─── Diff Retrieval ─────────────────────────────────────────────

/**
 * Retrieve diff content from staged changes (git diff --cached).
 * Requirement 4.1: staged changes via `git diff --cached`
 */
export function getDiffFromStaged(cwd: string): string {
  try {
    return execSync('git diff --cached', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return '';
  }
}

/**
 * Retrieve diff content from a worktree comparison.
 * Requirement 4.1: worktree comparisons
 */
export function getDiffFromWorktree(cwd: string, worktreeBranch: string, baseBranch: string = 'main'): string {
  try {
    return execSync(`git diff ${baseBranch}...${worktreeBranch}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return '';
  }
}

/**
 * Retrieve diff from a GitHub PR.
 * Requirement 4.1: PRs via GitHub API
 *
 * Uses the GitHub REST API to fetch the PR diff content.
 */
export async function getDiffFromPR(
  repository: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${repository}/pulls/${prNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': 'NeuroNest-CodeReview',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

// ─── Agent Invocation ───────────────────────────────────────────

/**
 * Parse the JSON response from a review agent into structured findings.
 * Handles malformed responses gracefully.
 */
export function parseAgentResponse(
  response: string,
  agentId: string,
  defaultCategory: ReviewCategory,
): AgentReviewResult {
  try {
    // Extract JSON from the response (agent may include markdown fencing)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { agentId, findings: [], dimensionScores: {}, success: false, error: 'No JSON in response' };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const findings: ReviewFinding[] = (parsed.findings || []).map((f: any) => ({
      id: randomUUID(),
      filePath: String(f.filePath || 'unknown'),
      startLine: Number(f.startLine) || 0,
      endLine: Number(f.endLine) || 0,
      severity: validateSeverity(f.severity),
      category: validateCategory(f.category) || defaultCategory,
      message: String(f.message || ''),
      suggestedFix: f.suggestedFix ? String(f.suggestedFix) : undefined,
      agentId,
    }));

    const scores: Partial<Record<ScoreDimension, number>> = {};
    if (parsed.scores && typeof parsed.scores === 'object') {
      for (const dim of ['correctness', 'security', 'performance', 'readability', 'maintainability'] as ScoreDimension[]) {
        if (typeof parsed.scores[dim] === 'number') {
          scores[dim] = clampScore(parsed.scores[dim]);
        }
      }
    }

    return { agentId, findings, dimensionScores: scores, success: true };
  } catch (err) {
    return {
      agentId,
      findings: [],
      dimensionScores: {},
      success: false,
      error: err instanceof Error ? err.message : 'Parse error',
    };
  }
}

/**
 * Invoke a single specialized review agent with the given diff.
 * Returns structured findings and dimension scores.
 */
export async function invokeReviewAgent(
  agentId: string,
  diff: string,
  llmClient: ReviewLLMClient,
  defaultCategory: ReviewCategory,
  timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentReviewResult> {
  const systemPrompt = AGENT_PROMPTS[agentId];
  if (!systemPrompt) {
    return {
      agentId,
      findings: [],
      dimensionScores: {},
      success: false,
      error: `No prompt configured for agent: ${agentId}`,
    };
  }

  try {
    const response = await Promise.race([
      llmClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\`` },
        ],
        { temperature: 0.3, maxTokens: 4096 },
      ),
      createTimeout(timeoutMs),
    ]);

    return parseAgentResponse(response.content, agentId, defaultCategory);
  } catch (err) {
    return {
      agentId,
      findings: [],
      dimensionScores: {},
      success: false,
      error: err instanceof Error ? err.message : 'Agent invocation failed',
    };
  }
}

// ─── Score Calculation ──────────────────────────────────────────

/**
 * Calculate the overall review score from individual dimension scores.
 * Uses weighted average across 5 dimensions (Req 4.5).
 *
 * Missing dimensions default to 70 (neutral score) to avoid penalizing
 * when an agent fails or doesn't cover a dimension.
 */
export function calculateScores(agentResults: AgentReviewResult[]): ReviewScores {
  const dimensionAverages: Record<ScoreDimension, number[]> = {
    correctness: [],
    security: [],
    performance: [],
    readability: [],
    maintainability: [],
  };

  // Collect scores from all agents
  for (const result of agentResults) {
    if (!result.success) continue;
    for (const [dim, score] of Object.entries(result.dimensionScores)) {
      const dimension = dim as ScoreDimension;
      if (dimensionAverages[dimension] && typeof score === 'number') {
        dimensionAverages[dimension].push(score);
      }
    }
  }

  // Apply penalty based on critical findings count
  const allFindings = agentResults.flatMap((r) => r.findings);
  const criticalCount = allFindings.filter((f) => f.severity === 'critical').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;

  // Calculate per-dimension averages (default to 70 if no data)
  const DEFAULT_DIMENSION_SCORE = 70;
  const scores: Record<ScoreDimension, number> = {
    correctness: DEFAULT_DIMENSION_SCORE,
    security: DEFAULT_DIMENSION_SCORE,
    performance: DEFAULT_DIMENSION_SCORE,
    readability: DEFAULT_DIMENSION_SCORE,
    maintainability: DEFAULT_DIMENSION_SCORE,
  };

  for (const [dim, values] of Object.entries(dimensionAverages)) {
    if (values.length > 0) {
      scores[dim as ScoreDimension] = Math.round(
        values.reduce((sum, v) => sum + v, 0) / values.length,
      );
    }
  }

  // Apply penalty for critical/warning findings
  const findingPenalty = Math.min(30, criticalCount * 10 + warningCount * 3);

  // Calculate weighted overall score
  let overall = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    overall += scores[dim as ScoreDimension] * weight;
  }
  overall = clampScore(Math.round(overall - findingPenalty));

  return {
    ...scores,
    overall,
  };
}

// ─── Main Pipeline ──────────────────────────────────────────────

/**
 * CodeReviewPipeline — orchestrates multi-agent code review.
 *
 * Lazy-initialized singleton pattern following NeuroNest conventions.
 * Feature-gated behind `code_review_pipeline`.
 *
 * Requirements: 4.1, 4.2, 4.5
 */
export class CodeReviewPipeline {
  private readonly featureGate: FeatureGateCheck;
  private readonly llmClient: ReviewLLMClient;
  private readonly maxDiffSize: number;
  private readonly agentTimeoutMs: number;

  constructor(config: ReviewPipelineConfig) {
    this.featureGate = config.featureGate;
    this.llmClient = config.llmClient;
    this.maxDiffSize = config.maxDiffSize ?? DEFAULT_MAX_DIFF_SIZE;
    this.agentTimeoutMs = config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  }

  /**
   * Execute the full review pipeline.
   *
   * 1. Retrieve diff from the specified source (Req 4.1)
   * 2. Route to specialized agents in parallel (Req 4.2)
   * 3. Aggregate findings and calculate scores (Req 4.5)
   *
   * Returns empty result when feature gate is disabled.
   */
  async execute(input: ReviewPipelineInput): Promise<ReviewResult> {
    const reviewId = randomUUID();
    const createdAt = Date.now();

    // Feature gate check — zero overhead when disabled
    if (!this.featureGate.isEnabled('code_review_pipeline')) {
      return {
        id: reviewId,
        source: input.source,
        sourceRef: undefined,
        findings: [],
        scores: { correctness: 0, security: 0, performance: 0, readability: 0, maintainability: 0, overall: 0 },
        status: 'completed',
        error: undefined,
        createdAt,
        completedAt: Date.now(),
      };
    }

    // Step 1: Retrieve the diff (Req 4.1)
    let diff: string;
    let sourceRef: string | undefined;
    try {
      const diffResult = await this.retrieveDiff(input);
      diff = diffResult.diff;
      sourceRef = diffResult.sourceRef;
    } catch (err) {
      return {
        id: reviewId,
        source: input.source,
        sourceRef: undefined,
        findings: [],
        scores: { correctness: 0, security: 0, performance: 0, readability: 0, maintainability: 0, overall: 0 },
        status: 'failed',
        error: err instanceof Error ? err.message : 'Failed to retrieve diff',
        createdAt,
        completedAt: Date.now(),
      };
    }

    // Empty diff — nothing to review
    if (!diff.trim()) {
      return {
        id: reviewId,
        source: input.source,
        sourceRef,
        findings: [],
        scores: { correctness: 100, security: 100, performance: 100, readability: 100, maintainability: 100, overall: 100 },
        status: 'completed',
        error: undefined,
        createdAt,
        completedAt: Date.now(),
      };
    }

    // Truncate oversized diffs to stay within LLM context limits
    const truncatedDiff = diff.length > this.maxDiffSize
      ? diff.slice(0, this.maxDiffSize) + '\n\n... [diff truncated due to size]'
      : diff;

    // Step 2: Route to specialized agents in parallel (Req 4.2)
    const agentResults = await this.routeToAgents(truncatedDiff);

    // Check if any agent failed — if ALL agents failed, mark review as failed
    const successfulAgents = agentResults.filter((r) => r.success);
    if (successfulAgents.length === 0) {
      const errors = agentResults.map((r) => `${r.agentId}: ${r.error}`).join('; ');
      return {
        id: reviewId,
        source: input.source,
        sourceRef,
        findings: [],
        scores: { correctness: 0, security: 0, performance: 0, readability: 0, maintainability: 0, overall: 0 },
        status: 'failed',
        error: `All review agents failed: ${errors}`,
        createdAt,
        completedAt: Date.now(),
      };
    }

    // Step 3: Aggregate findings and calculate scores (Req 4.5)
    const allFindings = agentResults.flatMap((r) => r.findings);
    const scores = calculateScores(agentResults);

    return {
      id: reviewId,
      source: input.source,
      sourceRef,
      findings: allFindings,
      scores,
      status: 'completed',
      error: undefined,
      createdAt,
      completedAt: Date.now(),
    };
  }

  /**
   * Retrieve diff content from the specified source.
   * Requirement 4.1: Accept diff from staged, PR, worktree, manual.
   */
  private async retrieveDiff(input: ReviewPipelineInput): Promise<{ diff: string; sourceRef?: string }> {
    switch (input.source) {
      case 'staged': {
        const diff = getDiffFromStaged(input.cwd);
        return { diff, sourceRef: 'staged' };
      }

      case 'pr': {
        if (!input.repository || !input.prNumber || !input.githubToken) {
          throw new Error('PR review requires repository, prNumber, and githubToken');
        }
        const diff = await getDiffFromPR(input.repository, input.prNumber, input.githubToken);
        return { diff, sourceRef: `PR #${input.prNumber}` };
      }

      case 'worktree': {
        if (!input.worktreeBranch) {
          throw new Error('Worktree review requires worktreeBranch');
        }
        const baseBranch = input.baseBranch || 'main';
        const diff = getDiffFromWorktree(input.cwd, input.worktreeBranch, baseBranch);
        return { diff, sourceRef: `${baseBranch}...${input.worktreeBranch}` };
      }

      case 'manual': {
        if (!input.manualDiff) {
          throw new Error('Manual review requires manualDiff text');
        }
        return { diff: input.manualDiff, sourceRef: 'manual' };
      }

      default:
        throw new Error(`Unsupported diff source: ${input.source}`);
    }
  }

  /**
   * Route the diff to specialized review agents in parallel.
   * Requirement 4.2: security, performance, style agents run in parallel.
   */
  private async routeToAgents(diff: string): Promise<AgentReviewResult[]> {
    const agentConfigs: Array<{ agentId: string; defaultCategory: ReviewCategory }> = [
      { agentId: 'security-reviewer', defaultCategory: 'security' },
      { agentId: 'performance-engineer', defaultCategory: 'performance' },
      { agentId: 'style-reviewer', defaultCategory: 'style' },
    ];

    // Invoke all agents in parallel
    const results = await Promise.allSettled(
      agentConfigs.map(({ agentId, defaultCategory }) =>
        invokeReviewAgent(agentId, diff, this.llmClient, defaultCategory, this.agentTimeoutMs),
      ),
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        agentId: agentConfigs[index]!.agentId,
        findings: [],
        dimensionScores: {},
        success: false,
        error: result.reason instanceof Error ? result.reason.message : 'Agent execution failed',
      };
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Clamp a score to the 0-100 range */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

/** Validate a severity value */
function validateSeverity(value: unknown): ReviewSeverity {
  if (value === 'critical' || value === 'warning' || value === 'info') {
    return value;
  }
  return 'info';
}

/** Validate a category value */
function validateCategory(value: unknown): ReviewCategory | undefined {
  const valid: ReviewCategory[] = ['security', 'performance', 'style', 'correctness', 'maintainability'];
  if (typeof value === 'string' && valid.includes(value as ReviewCategory)) {
    return value as ReviewCategory;
  }
  return undefined;
}

/** Create a timeout promise that rejects after the specified duration */
function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Agent review timed out after ${ms}ms`)), ms);
  });
}

// ─── Singleton Instance ─────────────────────────────────────────

let _instance: CodeReviewPipeline | null = null;

/**
 * Get or create the CodeReviewPipeline singleton.
 * Follows NeuroNest's lazy-initialization pattern.
 */
export function getCodeReviewPipeline(config: ReviewPipelineConfig): CodeReviewPipeline {
  if (!_instance) {
    _instance = new CodeReviewPipeline(config);
  }
  return _instance;
}

/** Reset the singleton (for testing) */
export function resetCodeReviewPipeline(): void {
  _instance = null;
}
