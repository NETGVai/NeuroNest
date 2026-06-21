/**
 * BehavioralRulesEngine — Self-improving agent behavioral rules.
 *
 * Detects repeated error patterns across sessions by analyzing execution traces,
 * proposes rules to prevent those error classes, tracks rule effectiveness over
 * time, and deprecates ineffective rules. Rules are persisted as markdown in a
 * configurable project file and optionally backed by a SQLite table.
 *
 * Key behaviors:
 * - Rules persisted as markdown in rulesFilePath
 * - analyzeSession() detects repeated error patterns occurring in 3+ sessions
 * - getActiveRules() returns only rules with status 'active'
 * - updateEffectiveness() adjusts effectivenessScore: recurrence decreases, absence increases
 * - When effectivenessScore drops below 0.3, rule is deprecated
 * - Rules lifecycle: proposed → approved → active → deprecated
 * - SQL table creation conditional on feature gate
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

export interface BehavioralRule {
  id: string;
  pattern: string;          // error pattern this rule targets
  rule: string;             // natural language rule text
  adoptedAt: string;
  effectivenessScore: number; // 0.0–1.0
  recurrenceCount: number;  // times error recurred post-adoption
  status: 'proposed' | 'approved' | 'active' | 'deprecated';
}

export type BehavioralRuleStatus = BehavioralRule['status'];

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
      error?: string | null;
      toolName?: string | null;
    }>;
  }>>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Minimum sessions with same error pattern to trigger rule proposal */
const MIN_RECURRENCE_SESSIONS = 3;

/** Score decrease when targeted error recurs */
const SCORE_DECREASE = 0.15;

/** Score increase when targeted error does not recur */
const SCORE_INCREASE = 0.05;

/** Threshold below which a rule is deprecated */
const DEPRECATION_THRESHOLD = 0.3;

/** Initial effectiveness score for new rules */
const INITIAL_EFFECTIVENESS = 0.7;

/** Regex to parse rule markdown headers */
const RULE_HEADER_REGEX = /^## \[(.+?)\] (.+)$/;
const PATTERN_REGEX = /^> Pattern: (.+)$/;
const STATUS_REGEX = /^> Status: (.+)$/;
const ADOPTED_REGEX = /^> Adopted: (.+)$/;
const SCORE_REGEX = /^> Effectiveness: (.+)$/;
const RECURRENCE_REGEX = /^> Recurrences: (.+)$/;

/** SQL for behavioral_rules table creation (conditional on feature gate) */
export const BEHAVIORAL_RULES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS behavioral_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  rule TEXT NOT NULL,
  adopted_at TEXT NOT NULL,
  effectiveness_score REAL NOT NULL DEFAULT 0.7,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed', 'approved', 'active', 'deprecated'))
);
`;

// ─── BehavioralRulesEngine Class ────────────────────────────────

export class BehavioralRulesEngine {
  private rules: BehavioralRule[] = [];
  private loaded = false;

  /**
   * Historical error patterns tracked across sessions.
   * Key: normalized error pattern, Value: set of session IDs where it occurred.
   */
  private errorHistory: Map<string, Set<string>> = new Map();

  constructor(
    private rulesFilePath: string,
    private traceService: TraceServiceLike | null,
  ) {}

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Review session errors for repeated patterns. When a pattern is detected
   * in 3+ sessions, proposes a new behavioral rule targeting that error class.
   *
   * Returns newly proposed rules from this analysis.
   *
   * Requirements: 11.1, 11.2
   */
  async analyzeSession(sessionId: string): Promise<BehavioralRule[]> {
    this.ensureLoaded();

    if (!this.traceService) return [];

    // Retrieve all traces for this session
    const traces = await this.traceService.getTracesBySession(sessionId);

    // Extract error patterns from trace entries
    const sessionErrors = new Set<string>();
    for (const trace of traces) {
      for (const entry of trace.entries) {
        if (entry.type === 'error' && entry.error) {
          const normalized = this.normalizeErrorPattern(entry.error);
          if (normalized) {
            sessionErrors.add(normalized);
          }
        }
      }
    }

    // Update error history with this session's errors
    for (const errorPattern of sessionErrors) {
      if (!this.errorHistory.has(errorPattern)) {
        this.errorHistory.set(errorPattern, new Set());
      }
      this.errorHistory.get(errorPattern)!.add(sessionId);
    }

    // Check for patterns that now meet the threshold
    const newRules: BehavioralRule[] = [];

    for (const [pattern, sessions] of this.errorHistory) {
      if (sessions.size >= MIN_RECURRENCE_SESSIONS) {
        // Only propose if no existing rule already targets this pattern
        const alreadyTargeted = this.rules.some(
          (r) => r.pattern === pattern && r.status !== 'deprecated',
        );

        if (!alreadyTargeted) {
          const newRule: BehavioralRule = {
            id: randomUUID(),
            pattern,
            rule: `Avoid: ${pattern}. This error has occurred in ${sessions.size} sessions.`,
            adoptedAt: new Date().toISOString(),
            effectivenessScore: INITIAL_EFFECTIVENESS,
            recurrenceCount: 0,
            status: 'proposed',
          };
          this.rules.push(newRule);
          newRules.push(newRule);
        }
      }
    }

    // Persist updated rules
    if (newRules.length > 0) {
      this.persist();
    }

    return newRules;
  }

  /**
   * Get active rules to inject into system prompt.
   * Returns only rules with status 'active'.
   *
   * Requirements: 11.4
   */
  getActiveRules(): BehavioralRule[] {
    this.ensureLoaded();
    return this.rules.filter((r) => r.status === 'active');
  }

  /**
   * Track whether targeted errors still occur after rule adoption.
   * Adjusts effectivenessScore:
   *  - If error recurs: score decreases by SCORE_DECREASE, recurrenceCount increments
   *  - If not: score increases by SCORE_INCREASE (capped at 1.0)
   * When score drops below DEPRECATION_THRESHOLD, rule is deprecated.
   *
   * Requirements: 11.5
   */
  updateEffectiveness(rule: BehavioralRule, errorOccurred: boolean): void {
    this.ensureLoaded();

    const existing = this.rules.find((r) => r.id === rule.id);
    if (!existing) return;

    if (errorOccurred) {
      existing.recurrenceCount += 1;
      existing.effectivenessScore = Math.max(
        0,
        existing.effectivenessScore - SCORE_DECREASE,
      );
    } else {
      existing.effectivenessScore = Math.min(
        1.0,
        existing.effectivenessScore + SCORE_INCREASE,
      );
    }

    // Deprecate if below threshold
    if (existing.effectivenessScore < DEPRECATION_THRESHOLD) {
      existing.status = 'deprecated';
    }

    this.persist();
  }

  /**
   * Transition a rule's status through the lifecycle.
   * Valid transitions: proposed → approved → active → deprecated
   */
  transitionStatus(ruleId: string, newStatus: BehavioralRuleStatus): boolean {
    this.ensureLoaded();

    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) return false;

    const validTransitions: Record<BehavioralRuleStatus, BehavioralRuleStatus[]> = {
      proposed: ['approved', 'deprecated'],
      approved: ['active', 'deprecated'],
      active: ['deprecated'],
      deprecated: [],
    };

    if (!validTransitions[rule.status].includes(newStatus)) {
      return false;
    }

    rule.status = newStatus;
    if (newStatus === 'active') {
      rule.adoptedAt = new Date().toISOString();
    }

    this.persist();
    return true;
  }

  /**
   * Get all rules regardless of status.
   */
  getAllRules(): BehavioralRule[] {
    this.ensureLoaded();
    return [...this.rules];
  }

  /**
   * Get the SQL to create the behavioral_rules table.
   * Intended to be executed conditionally when the self_improvement feature gate is enabled.
   */
  static getTableCreationSQL(): string {
    return BEHAVIORAL_RULES_TABLE_SQL;
  }

  // ─── Persistence (Markdown) ─────────────────────────────────────

  /**
   * Load rules from the markdown file. Creates the file if it doesn't exist.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;

    if (fs.existsSync(this.rulesFilePath)) {
      const content = fs.readFileSync(this.rulesFilePath, 'utf-8');
      this.rules = this.parseMarkdown(content);
    } else {
      this.rules = [];
    }

    this.loaded = true;
  }

  /**
   * Persist current rules to the markdown file.
   */
  private persist(): void {
    const dir = path.dirname(this.rulesFilePath);
    fs.mkdirSync(dir, { recursive: true });

    const content = this.toMarkdown();
    fs.writeFileSync(this.rulesFilePath, content, 'utf-8');
  }

  /**
   * Serialize all rules to markdown format.
   */
  private toMarkdown(): string {
    const lines: string[] = ['# Behavioral Rules\n'];

    for (const rule of this.rules) {
      lines.push(`## [${rule.id}] ${rule.rule}`);
      lines.push(`> Pattern: ${rule.pattern}`);
      lines.push(`> Status: ${rule.status}`);
      lines.push(`> Adopted: ${rule.adoptedAt}`);
      lines.push(`> Effectiveness: ${rule.effectivenessScore.toFixed(2)}`);
      lines.push(`> Recurrences: ${rule.recurrenceCount}`);
      lines.push('');
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Parse markdown content into BehavioralRule objects.
   */
  private parseMarkdown(content: string): BehavioralRule[] {
    const rules: BehavioralRule[] = [];
    const lines = content.split('\n');

    let current: Partial<BehavioralRule> | null = null;

    for (const line of lines) {
      const headerMatch = line.match(RULE_HEADER_REGEX);
      if (headerMatch) {
        // Save previous rule
        if (current && current.id) {
          rules.push(this.completeRule(current));
        }
        current = {
          id: headerMatch[1],
          rule: headerMatch[2],
        };
        continue;
      }

      if (!current) continue;

      const patternMatch = line.match(PATTERN_REGEX);
      if (patternMatch) {
        current.pattern = patternMatch[1];
        continue;
      }

      const statusMatch = line.match(STATUS_REGEX);
      if (statusMatch) {
        current.status = statusMatch[1] as BehavioralRuleStatus;
        continue;
      }

      const adoptedMatch = line.match(ADOPTED_REGEX);
      if (adoptedMatch) {
        current.adoptedAt = adoptedMatch[1];
        continue;
      }

      const scoreMatch = line.match(SCORE_REGEX);
      if (scoreMatch) {
        current.effectivenessScore = parseFloat(scoreMatch[1]);
        continue;
      }

      const recurrenceMatch = line.match(RECURRENCE_REGEX);
      if (recurrenceMatch) {
        current.recurrenceCount = parseInt(recurrenceMatch[1], 10);
        continue;
      }
    }

    // Don't forget last rule
    if (current && current.id) {
      rules.push(this.completeRule(current));
    }

    return rules;
  }

  /**
   * Fill in defaults for any missing fields in a partially parsed rule.
   */
  private completeRule(partial: Partial<BehavioralRule>): BehavioralRule {
    return {
      id: partial.id || randomUUID(),
      pattern: partial.pattern || '',
      rule: partial.rule || '',
      adoptedAt: partial.adoptedAt || new Date().toISOString(),
      effectivenessScore: partial.effectivenessScore ?? INITIAL_EFFECTIVENESS,
      recurrenceCount: partial.recurrenceCount ?? 0,
      status: partial.status || 'proposed',
    };
  }

  // ─── Error Pattern Analysis ─────────────────────────────────────

  /**
   * Normalize an error string to a canonical pattern for comparison.
   * Strips variable parts (file paths, line numbers, specific values)
   * to identify the error class rather than a specific instance.
   */
  private normalizeErrorPattern(error: string): string | null {
    if (!error || error.trim().length === 0) return null;

    let normalized = error.trim();

    // Remove file paths (Unix and Windows style)
    normalized = normalized.replace(/[\/\\][\w.\-\/\\]+\.[a-z]{1,5}/gi, '<path>');

    // Remove line/column numbers
    normalized = normalized.replace(/\b(line|ln|col|column)\s*:?\s*\d+/gi, '<loc>');
    normalized = normalized.replace(/:\d+:\d+/g, ':<loc>');

    // Remove specific numeric values (but keep short identifiers)
    normalized = normalized.replace(/\b\d{4,}\b/g, '<num>');

    // Remove UUIDs
    normalized = normalized.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>',
    );

    // Remove quoted strings (likely variable values)
    normalized = normalized.replace(/"[^"]{20,}"/g, '"<value>"');
    normalized = normalized.replace(/'[^']{20,}'/g, "'<value>'");

    // Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Reject too short or empty patterns
    if (normalized.length < 5) return null;

    return normalized;
  }
}
