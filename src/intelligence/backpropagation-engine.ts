/**
 * BackpropagationEngine — Bug-to-spec gap traceability analysis.
 *
 * Traces bugs in agent-generated code back to insufficient or ambiguous
 * specifications, producing gap reports that link to specific requirement
 * sections with recommended amendments. Detects systemic planning weaknesses
 * when the same gap category appears in 3+ reports.
 *
 * Key behaviors:
 * - analyzeBug() uses LLM to trace a bug description back to a spec gap
 * - Gap reports are stored via the ExecutionTraceService for aggregation
 * - checkSystemicGaps() identifies gap categories with 3+ reports
 * - Reports include linkedRequirement, gapCategory, and recommendedAmendment
 * - When the backpropagation Feature_Gate is disabled, no analysis occurs
 *
 * Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6
 */

import { randomUUID } from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SpecGapReport {
  id: string;
  bugDescription: string;
  linkedRequirement: string;    // e.g., "Req 1.3"
  gapCategory: string;
  recommendedAmendment: string;
  createdAt: string;
  sessionId: string;
}

/**
 * Minimal LLM interface for bug-to-spec analysis — kept loose to avoid
 * coupling to a specific client implementation.
 */
export interface LLMClientLike {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ content: string }>;
}

/**
 * Minimal interface for ExecutionTraceService dependency.
 * Used to persist and retrieve gap reports for aggregation.
 */
export interface TraceServiceLike {
  storeGapReport(report: SpecGapReport): Promise<void>;
  getGapReports(): Promise<SpecGapReport[]>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Minimum reports in the same gap category to flag as systemic */
const SYSTEMIC_THRESHOLD = 3;

/** System prompt for the LLM to analyze bug-to-spec gaps */
const ANALYSIS_SYSTEM_PROMPT = `You are a specification quality analyst. Given a bug description, relevant code context, and the related specification content, your task is to identify which specific requirement or acceptance criterion was insufficient, ambiguous, or missing that allowed the bug to occur.

Respond with ONLY a JSON object in this exact format:
{
  "linkedRequirement": "Req X.Y",
  "gapCategory": "category_name",
  "recommendedAmendment": "A concise recommendation for how the spec should be amended to prevent this class of bug."
}

Gap categories:
- "missing_edge_case": The spec did not account for a specific edge case
- "ambiguous_requirement": The requirement was unclear, allowing incorrect interpretation
- "missing_constraint": A constraint or validation was not specified
- "incomplete_error_handling": Error/failure scenarios were not specified
- "missing_integration_behavior": Interaction between components was not specified
- "insufficient_boundary": Numeric/string/temporal boundaries were not defined
- "missing_concurrency_handling": Race conditions or parallel access not addressed
- "missing_security_consideration": Security requirement was absent or insufficient
- "underdefined_api_contract": API input/output contract was incomplete
- "missing_state_transition": A valid state transition was not specified

If you cannot determine the specific requirement, use "Req UNKNOWN" and provide your best analysis in the recommendedAmendment field.`;

// ─── SQL Schema ─────────────────────────────────────────────────

/** SQL for spec_gap_reports table creation (conditional on feature gate) */
export const SPEC_GAP_REPORTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS spec_gap_reports (
  id TEXT PRIMARY KEY,
  bug_description TEXT NOT NULL,
  linked_requirement TEXT NOT NULL,
  gap_category TEXT NOT NULL,
  recommended_amendment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  session_id TEXT NOT NULL
);
`;

// ─── BackpropagationEngine Class ────────────────────────────────

export class BackpropagationEngine {
  private reports: SpecGapReport[] = [];
  private loaded = false;

  constructor(
    private traceService: TraceServiceLike | null,
    private llmClient: LLMClientLike,
  ) {}

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Analyze a bug and trace it back to a spec gap.
   *
   * Uses the LLM to identify which requirement or acceptance criterion was
   * insufficient, producing a SpecGapReport with a recommended amendment.
   *
   * @param bugDescription - Description of the bug that was identified
   * @param codeContext - The relevant code where the bug manifests
   * @param specContent - The specification content that should have prevented the bug
   * @returns A SpecGapReport linking the bug to a spec gap
   *
   * Requirements: 30.1, 30.2
   */
  async analyzeBug(
    bugDescription: string,
    codeContext: string,
    specContent: string,
  ): Promise<SpecGapReport> {
    const userMessage = this.buildAnalysisPrompt(bugDescription, codeContext, specContent);

    const response = await this.llmClient.chat(
      [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.2, maxTokens: 1024 },
    );

    const parsed = this.parseAnalysisResponse(response.content, bugDescription);

    const report: SpecGapReport = {
      id: randomUUID(),
      bugDescription,
      linkedRequirement: parsed.linkedRequirement,
      gapCategory: parsed.gapCategory,
      recommendedAmendment: parsed.recommendedAmendment,
      createdAt: new Date().toISOString(),
      sessionId: this.generateSessionId(),
    };

    // Persist the report via trace service
    if (this.traceService) {
      await this.traceService.storeGapReport(report);
    }

    // Also keep in-memory for checkSystemicGaps
    this.reports.push(report);

    return report;
  }

  /**
   * Check if any gap category is systemic (3+ reports with the same category).
   *
   * Loads all stored gap reports and groups by category, returning those
   * categories that meet or exceed the systemic threshold.
   *
   * Requirements: 30.4
   */
  async checkSystemicGaps(): Promise<SpecGapReport[]> {
    await this.ensureLoaded();

    // Group reports by gap category
    const categoryMap = new Map<string, SpecGapReport[]>();

    for (const report of this.reports) {
      const existing = categoryMap.get(report.gapCategory) || [];
      existing.push(report);
      categoryMap.set(report.gapCategory, existing);
    }

    // Return reports from categories that meet the systemic threshold
    const systemicReports: SpecGapReport[] = [];

    for (const [_category, reports] of categoryMap) {
      if (reports.length >= SYSTEMIC_THRESHOLD) {
        systemicReports.push(...reports);
      }
    }

    return systemicReports;
  }

  /**
   * Get all stored gap reports.
   */
  getAllReports(): SpecGapReport[] {
    return [...this.reports];
  }

  /**
   * Get the SQL to create the spec_gap_reports table.
   * Intended to be executed conditionally when the backpropagation feature gate is enabled.
   */
  static getTableCreationSQL(): string {
    return SPEC_GAP_REPORTS_TABLE_SQL;
  }

  /**
   * Format a gap report for user presentation with one-click amendment approval.
   *
   * Requirements: 30.5
   */
  formatForPresentation(report: SpecGapReport): {
    summary: string;
    linkedRequirement: string;
    category: string;
    amendment: string;
    approvalAction: { type: 'amend_spec'; reportId: string; requirement: string; amendment: string };
  } {
    return {
      summary: `Bug "${report.bugDescription}" traced to specification gap in ${report.linkedRequirement}`,
      linkedRequirement: report.linkedRequirement,
      category: report.gapCategory,
      amendment: report.recommendedAmendment,
      approvalAction: {
        type: 'amend_spec',
        reportId: report.id,
        requirement: report.linkedRequirement,
        amendment: report.recommendedAmendment,
      },
    };
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Ensure reports are loaded from the trace service.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (this.traceService) {
      const stored = await this.traceService.getGapReports();
      // Merge stored reports with any already in memory (avoid duplicates)
      const existingIds = new Set(this.reports.map((r) => r.id));
      for (const report of stored) {
        if (!existingIds.has(report.id)) {
          this.reports.push(report);
        }
      }
    }

    this.loaded = true;
  }

  /**
   * Build the user prompt for the LLM analysis.
   */
  private buildAnalysisPrompt(
    bugDescription: string,
    codeContext: string,
    specContent: string,
  ): string {
    return [
      '## Bug Description',
      bugDescription,
      '',
      '## Relevant Code Context',
      '```',
      codeContext,
      '```',
      '',
      '## Specification Content',
      specContent,
      '',
      'Analyze which specific requirement or acceptance criterion was insufficient to prevent this bug. Identify the gap category and recommend an amendment.',
    ].join('\n');
  }

  /**
   * Parse the LLM response into structured fields.
   * Falls back to sensible defaults if parsing fails.
   */
  private parseAnalysisResponse(
    responseContent: string,
    bugDescription: string,
  ): { linkedRequirement: string; gapCategory: string; recommendedAmendment: string } {
    try {
      // Try to extract JSON from the response (handle markdown code fences)
      const jsonStr = this.extractJson(responseContent);
      const parsed = JSON.parse(jsonStr);

      return {
        linkedRequirement: typeof parsed.linkedRequirement === 'string'
          ? parsed.linkedRequirement
          : 'Req UNKNOWN',
        gapCategory: typeof parsed.gapCategory === 'string'
          ? this.normalizeCategory(parsed.gapCategory)
          : 'ambiguous_requirement',
        recommendedAmendment: typeof parsed.recommendedAmendment === 'string'
          ? parsed.recommendedAmendment
          : `Review specification for gap related to: ${bugDescription}`,
      };
    } catch {
      // If JSON parsing fails, return defaults
      return {
        linkedRequirement: 'Req UNKNOWN',
        gapCategory: 'ambiguous_requirement',
        recommendedAmendment: `Review specification for gap related to: ${bugDescription}`,
      };
    }
  }

  /**
   * Extract JSON from a response that may include markdown code fences.
   */
  private extractJson(content: string): string {
    // Try to find JSON within code fences
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch && fenceMatch[1]) {
      return fenceMatch[1].trim();
    }

    // Try to find a JSON object directly
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return objectMatch[0].trim();
    }

    return content.trim();
  }

  /**
   * Normalize a gap category to one of the known categories.
   * Returns the category as-is if it matches a known one, otherwise defaults.
   */
  private normalizeCategory(category: string): string {
    const knownCategories = new Set([
      'missing_edge_case',
      'ambiguous_requirement',
      'missing_constraint',
      'incomplete_error_handling',
      'missing_integration_behavior',
      'insufficient_boundary',
      'missing_concurrency_handling',
      'missing_security_consideration',
      'underdefined_api_contract',
      'missing_state_transition',
    ]);

    const normalized = category.toLowerCase().replace(/\s+/g, '_');
    if (knownCategories.has(normalized)) {
      return normalized;
    }

    // Try to find a partial match
    for (const known of knownCategories) {
      if (normalized.includes(known) || known.includes(normalized)) {
        return known;
      }
    }

    return category;
  }

  /**
   * Generate a session identifier. In production this would come from
   * the AgentLoopController; here we generate a placeholder.
   */
  private generateSessionId(): string {
    return `session-${Date.now()}`;
  }
}
