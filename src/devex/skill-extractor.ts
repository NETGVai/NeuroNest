/**
 * SkillExtractor — Extracts reusable workflow patterns from successful agent sessions.
 *
 * Analyzes complex task completions (>5 tool calls) to identify repeatable patterns,
 * represents them as structured Skills with preconditions/steps/postconditions,
 * matches incoming tasks against existing skill preconditions, tracks usage frequency
 * and success rate, and deprecates skills with declining effectiveness.
 *
 * Skills are persisted both in a SQLite `skills` table and as versioned JSON files
 * in a configurable directory for portability and version control.
 *
 * Key behaviors:
 * - extractFromSession() only triggers on sessions with >minToolCalls tool calls
 * - matchSkill() compares task description keywords against skill preconditions
 * - Usage frequency and success rate tracked per skill
 * - Skills with success rate below DEPRECATION_THRESHOLD are deprecated
 * - Persisted as versioned files: {skillsDir}/{id}_v{version}.json
 * - SQL table creation conditional on feature gate
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SkillStep {
  toolId: string;
  description: string;
  paramTemplate: Record<string, unknown>;
}

export interface Skill {
  id: string;
  name: string;
  version: number;
  preconditions: string[];
  steps: SkillStep[];
  postconditions: string[];
  usageCount: number;
  successRate: number;
  createdAt: string;
  deprecated: boolean;
}

export interface SkillExtractorConfig {
  skillsDir: string;
  minToolCalls: number; // default 5
}

/**
 * Minimal interface for ExecutionTraceService dependency.
 * Kept loose to avoid tight coupling — only needs session trace retrieval.
 */
export interface TraceServiceLike {
  getTracesBySession(sessionId: string): Promise<Array<{
    id: string;
    sessionId: string;
    entries: Array<{
      type: string;
      toolName?: string | null;
      parameters?: Record<string, unknown> | null;
      result?: unknown;
      error?: string | null;
      intentPurpose?: string | null;
    }>;
    completedAt?: string;
    totalTokens: number;
  }>>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default minimum tool calls required to extract a skill */
const DEFAULT_MIN_TOOL_CALLS = 5;

/** Success rate threshold below which a skill is deprecated */
const DEPRECATION_THRESHOLD = 0.3;

/** Minimum keyword overlap ratio to consider a skill match */
const MATCH_THRESHOLD = 0.4;

/** SQL for skills table creation (conditional on feature gate) */
export const SKILLS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  preconditions TEXT NOT NULL,
  steps TEXT NOT NULL,
  postconditions TEXT NOT NULL,
  usage_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0
);
`;

// ─── SkillExtractor Class ───────────────────────────────────────

export class SkillExtractor {
  private skills: Skill[] = [];
  private loaded = false;
  private readonly minToolCalls: number;

  constructor(
    private skillsDir: string,
    private traceService: TraceServiceLike | null,
    config?: Partial<SkillExtractorConfig>,
  ) {
    this.minToolCalls = config?.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Analyze a completed session for extractable patterns.
   * Only considers sessions with more than minToolCalls tool calls.
   * Returns the extracted Skill or null if the session doesn't qualify.
   *
   * Requirements: 21.1, 21.2
   */
  async extractFromSession(
    sessionId: string,
    toolCallCount: number,
  ): Promise<Skill | null> {
    this.ensureLoaded();

    // Only extract from complex tasks
    if (toolCallCount <= this.minToolCalls) {
      return null;
    }

    if (!this.traceService) {
      return null;
    }

    // Retrieve session traces
    const traces = await this.traceService.getTracesBySession(sessionId);
    if (traces.length === 0) {
      return null;
    }

    // Extract tool call entries from all traces
    const toolCalls: Array<{
      toolName: string;
      parameters: Record<string, unknown>;
      intentPurpose: string | null;
    }> = [];

    for (const trace of traces) {
      for (const entry of trace.entries) {
        if (entry.type === 'tool-call' && entry.toolName) {
          toolCalls.push({
            toolName: entry.toolName,
            parameters: entry.parameters ?? {},
            intentPurpose: entry.intentPurpose ?? null,
          });
        }
      }
    }

    // Verify actual tool call count meets threshold
    if (toolCalls.length <= this.minToolCalls) {
      return null;
    }

    // Check if we already have a similar skill (same tool sequence)
    const toolSequence = toolCalls.map((tc) => tc.toolName);
    const existingSkill = this.findSimilarSkill(toolSequence);
    if (existingSkill) {
      // Increment usage and return existing
      existingSkill.usageCount += 1;
      this.persist();
      return existingSkill;
    }

    // Build preconditions from intent purposes and context
    const preconditions = this.extractPreconditions(toolCalls, traces);

    // Build steps from tool call sequence
    const steps: SkillStep[] = toolCalls.map((tc) => ({
      toolId: tc.toolName,
      description: tc.intentPurpose ?? `Execute ${tc.toolName}`,
      paramTemplate: this.templatizeParams(tc.parameters),
    }));

    // Build postconditions from successful outcomes
    const postconditions = this.extractPostconditions(traces);

    // Generate skill name from preconditions and tools
    const name = this.generateSkillName(preconditions, toolSequence);

    const skill: Skill = {
      id: randomUUID(),
      name,
      version: 1,
      preconditions,
      steps,
      postconditions,
      usageCount: 1,
      successRate: 1.0,
      createdAt: new Date().toISOString(),
      deprecated: false,
    };

    this.skills.push(skill);
    this.persistSkillFile(skill);
    this.persist();

    return skill;
  }

  /**
   * Match a task description against existing skill preconditions.
   * Returns the best matching non-deprecated skill or null.
   *
   * Requirements: 21.3
   */
  matchSkill(taskDescription: string, filePaths: string[] = []): Skill | null {
    this.ensureLoaded();

    const taskKeywords = this.tokenize(taskDescription);
    const pathKeywords = filePaths.flatMap((fp) =>
      path.basename(fp).replace(/[.\-_]/g, ' ').split(/\s+/),
    );
    const allKeywords = new Set([...taskKeywords, ...pathKeywords]);

    let bestMatch: Skill | null = null;
    let bestScore = 0;

    for (const skill of this.skills) {
      if (skill.deprecated) continue;

      const preconditionKeywords = new Set(
        skill.preconditions.flatMap((p) => this.tokenize(p)),
      );

      // Calculate overlap between task keywords and skill preconditions
      let overlap = 0;
      for (const keyword of allKeywords) {
        if (preconditionKeywords.has(keyword)) {
          overlap++;
        }
      }

      const score =
        preconditionKeywords.size > 0
          ? overlap / preconditionKeywords.size
          : 0;

      if (score >= MATCH_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }

  /**
   * Record a skill execution result to update usage frequency and success rate.
   *
   * Requirements: 21.5
   */
  recordExecution(skillId: string, success: boolean): void {
    this.ensureLoaded();

    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) return;

    skill.usageCount += 1;

    // Rolling success rate calculation using exponential moving average
    const alpha = 0.3; // weight for most recent result
    skill.successRate =
      alpha * (success ? 1 : 0) + (1 - alpha) * skill.successRate;

    // Deprecate if success rate drops below threshold
    if (skill.successRate < DEPRECATION_THRESHOLD) {
      skill.deprecated = true;
    }

    this.persist();
  }

  /**
   * Get all non-deprecated skills.
   */
  getActiveSkills(): Skill[] {
    this.ensureLoaded();
    return this.skills.filter((s) => !s.deprecated);
  }

  /**
   * Get all skills including deprecated ones.
   */
  getAllSkills(): Skill[] {
    this.ensureLoaded();
    return [...this.skills];
  }

  /**
   * Get the SQL to create the skills table.
   * Intended to be executed conditionally when the skill_creation feature gate is enabled.
   */
  static getTableCreationSQL(): string {
    return SKILLS_TABLE_SQL;
  }

  // ─── Persistence ────────────────────────────────────────────────

  /**
   * Load skills from the skills directory. Creates the directory if it doesn't exist.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;

    if (fs.existsSync(this.skillsDir)) {
      this.skills = this.loadSkillsFromDir();
    } else {
      this.skills = [];
    }

    this.loaded = true;
  }

  /**
   * Load all skill files from the skills directory.
   */
  private loadSkillsFromDir(): Skill[] {
    const skills: Skill[] = [];

    try {
      const files = fs.readdirSync(this.skillsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.skillsDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const skill = JSON.parse(content) as Skill;

          // Validate minimal structure
          if (skill.id && skill.name && Array.isArray(skill.steps)) {
            skills.push(skill);
          }
        } catch {
          // Skip malformed files
          continue;
        }
      }
    } catch {
      // Directory read failure — start with empty
      return [];
    }

    return skills;
  }

  /**
   * Persist a single skill as a versioned JSON file.
   *
   * Requirements: 21.4
   */
  private persistSkillFile(skill: Skill): void {
    fs.mkdirSync(this.skillsDir, { recursive: true });

    const filename = `${skill.id}_v${skill.version}.json`;
    const filePath = path.join(this.skillsDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8');
  }

  /**
   * Persist all skills to their respective files (update existing).
   */
  private persist(): void {
    fs.mkdirSync(this.skillsDir, { recursive: true });

    for (const skill of this.skills) {
      const filename = `${skill.id}_v${skill.version}.json`;
      const filePath = path.join(this.skillsDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8');
    }
  }

  // ─── Pattern Analysis Helpers ─────────────────────────────────

  /**
   * Extract preconditions from the session context.
   * Combines intent purposes and tool-call context into meaningful preconditions.
   */
  private extractPreconditions(
    toolCalls: Array<{
      toolName: string;
      parameters: Record<string, unknown>;
      intentPurpose: string | null;
    }>,
    traces: Array<{
      entries: Array<{
        type: string;
        intentPurpose?: string | null;
      }>;
    }>,
  ): string[] {
    const preconditions: Set<string> = new Set();

    // Extract unique intent purposes as preconditions
    for (const tc of toolCalls) {
      if (tc.intentPurpose) {
        preconditions.add(tc.intentPurpose);
      }
    }

    // Extract context from trace decision entries
    for (const trace of traces) {
      for (const entry of trace.entries) {
        if (entry.type === 'decision' && entry.intentPurpose) {
          preconditions.add(entry.intentPurpose);
        }
      }
    }

    // Extract tool names as "requires <tool> capability"
    const uniqueTools = new Set(toolCalls.map((tc) => tc.toolName));
    for (const tool of uniqueTools) {
      preconditions.add(`requires ${tool} tool`);
    }

    return Array.from(preconditions).slice(0, 10); // Cap at 10 preconditions
  }

  /**
   * Extract postconditions from successful trace outcomes.
   */
  private extractPostconditions(
    traces: Array<{
      entries: Array<{
        type: string;
        result?: unknown;
        error?: string | null;
      }>;
      completedAt?: string;
    }>,
  ): string[] {
    const postconditions: string[] = [];

    // A completed trace without errors implies success
    for (const trace of traces) {
      const hasErrors = trace.entries.some(
        (e) => e.type === 'error' && e.error,
      );
      if (!hasErrors && trace.completedAt) {
        postconditions.push('task completed successfully');
        break;
      }
    }

    // Extract result summaries from final entries
    for (const trace of traces) {
      const results = trace.entries.filter(
        (e) => e.type === 'result' && e.result,
      );
      if (results.length > 0) {
        const lastResult = results[results.length - 1];
        if (typeof lastResult.result === 'string') {
          postconditions.push(lastResult.result.slice(0, 100));
        }
      }
    }

    return postconditions.length > 0
      ? postconditions.slice(0, 5)
      : ['task completed'];
  }

  /**
   * Templatize parameters by replacing specific values with placeholder patterns.
   * Preserves parameter keys but generalizes values.
   */
  private templatizeParams(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const template: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // Replace file paths with glob patterns
        if (value.includes('/') || value.includes('\\')) {
          template[key] = '{{file_path}}';
        } else if (value.length > 50) {
          template[key] = '{{content}}';
        } else {
          template[key] = value; // Keep short strings as-is
        }
      } else if (typeof value === 'number') {
        template[key] = '{{number}}';
      } else if (typeof value === 'boolean') {
        template[key] = value;
      } else {
        template[key] = '{{object}}';
      }
    }

    return template;
  }

  /**
   * Find an existing skill with a similar tool sequence.
   * Two sequences are "similar" if they share >70% of tools in order.
   */
  private findSimilarSkill(toolSequence: string[]): Skill | null {
    for (const skill of this.skills) {
      if (skill.deprecated) continue;

      const skillTools = skill.steps.map((s) => s.toolId);
      const similarity = this.sequenceSimilarity(toolSequence, skillTools);

      if (similarity > 0.7) {
        return skill;
      }
    }

    return null;
  }

  /**
   * Calculate Longest Common Subsequence ratio between two tool sequences.
   */
  private sequenceSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const lcsLength = dp[m][n];
    return lcsLength / Math.max(m, n);
  }

  /**
   * Generate a human-readable skill name from preconditions and tools.
   */
  private generateSkillName(
    preconditions: string[],
    toolSequence: string[],
  ): string {
    // Use first meaningful precondition as base
    const basePrecondition = preconditions.find(
      (p) => !p.startsWith('requires '),
    );

    if (basePrecondition) {
      // Truncate to reasonable length
      const truncated = basePrecondition.slice(0, 50);
      return truncated.endsWith('...')
        ? truncated
        : truncated.length < basePrecondition.length
          ? truncated + '...'
          : truncated;
    }

    // Fallback: use unique tools
    const uniqueTools = [...new Set(toolSequence)];
    return `Skill: ${uniqueTools.slice(0, 3).join(' → ')}`;
  }

  /**
   * Tokenize a string into lowercase keywords for matching.
   * Strips common stop words and normalizes.
   */
  private tokenize(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'shall', 'can',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after', 'and',
      'but', 'or', 'nor', 'not', 'so', 'if', 'then', 'that', 'this',
      'it', 'its', 'i', 'we', 'you', 'they', 'he', 'she',
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));
  }
}
