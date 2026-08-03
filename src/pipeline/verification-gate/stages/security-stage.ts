/**
 * Security verification stage.
 * Runs RealtimeCodeAnalyzer and AISecurityRuleEngine against modified files,
 * maps findings to Diagnostics, and fails the stage on critical/high severity findings.
 *
 * Positioned after 'lint' and before 'test' in STAGE_ORDER.
 *
 * Requirements: 9.1, 9.2, 9.3
 */
import * as path from 'path';
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
} from '../types';
import { STAGE_SCORES } from '../types';
import { RealtimeCodeAnalyzer } from '../../../runtime-security/realtime-code-analyzer.js';
import type { RealtimeAnalysisFinding } from '../../../runtime-security/realtime-code-analyzer.js';
import { AISecurityRuleEngine } from '../../../runtime-security/ai-security-rule-engine.js';
import type { AISecurityFinding } from '../../../runtime-security/ai-security-rule-engine.js';
import type { ThreatSeverity } from '../../../runtime-security/types.js';

// ─── Severity Mapping ───────────────────────────────────────────

/**
 * Maps ThreatSeverity to Diagnostic severity.
 * 'critical' and 'high' map to 'error', others to 'warning'.
 */
function mapSeverity(severity: ThreatSeverity): 'error' | 'warning' {
  if (severity === 'critical' || severity === 'high') {
    return 'error';
  }
  return 'warning';
}

// ─── Analyzer Dependencies ──────────────────────────────────────

/** Minimal CallbackEngine interface used by both analyzers */
export interface SecurityStageCallbackEngine {
  emit: (event: string, context: unknown) => void;
  on?: (event: string, handler: Function) => void;
  off?: (event: string, handler: Function) => void;
}

/** Minimal FirewallEngine interface for AISecurityRuleEngine */
export interface SecurityStageFirewallEngine {
  coveredCategories?: () => string[];
}

/** Dependencies injected into SecurityStage */
export interface SecurityStageDeps {
  callbackEngine: SecurityStageCallbackEngine;
  firewall?: SecurityStageFirewallEngine | null;
  /** Project root directory for loading AI security rules */
  projectRoot?: string;
}

// ─── Security Stage ─────────────────────────────────────────────

export class SecurityStage implements VerificationStage {
  readonly name = 'security' as const;
  readonly score = STAGE_SCORES.security;

  private readonly analyzer: RealtimeCodeAnalyzer;
  private readonly ruleEngine: AISecurityRuleEngine;

  constructor(deps?: SecurityStageDeps) {
    const callbackEngine = deps?.callbackEngine ?? { emit: () => {} };
    const firewall = deps?.firewall ?? null;

    this.analyzer = new RealtimeCodeAnalyzer(
      callbackEngine,
      firewall ? { evaluate: () => ({ passed: true }) } : null,
      5000, // 5-second budget for verification stage (more generous than pre-write 200ms)
      false, // block on any finding, not just critical
    );

    const rules = deps?.projectRoot
      ? AISecurityRuleEngine.loadRules(deps.projectRoot)
      : AISecurityRuleEngine.getDefaultRules();

    this.ruleEngine = new AISecurityRuleEngine(rules, callbackEngine, firewall ?? null);
  }

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();
    const diagnostics: Diagnostic[] = [];

    // Analyze each modified file
    for (const change of edit.changes) {
      const filePath = change.filePath;
      const content = change.content;
      const sessionId = edit.id;

      // Determine relative path for diagnostics
      const relPath = path.isAbsolute(filePath)
        ? path.relative(context.rootDir, filePath).replace(/\\/g, '/')
        : filePath;

      // Run RealtimeCodeAnalyzer
      const analyzerResult = await this.analyzer.analyzeBeforeWrite(
        filePath,
        content,
        sessionId,
      );

      // Map RealtimeCodeAnalyzer findings to Diagnostics
      for (const finding of analyzerResult.findings) {
        diagnostics.push(this.mapRealtimeFindingToDiagnostic(finding, relPath));
      }

      // Run AISecurityRuleEngine
      const ruleResult = this.ruleEngine.evaluate(filePath, content, sessionId);

      // Map AISecurityRuleEngine findings to Diagnostics
      for (const finding of ruleResult.findings) {
        diagnostics.push(this.mapAIFindingToDiagnostic(finding, relPath));
      }
    }

    // Stage fails if any finding has severity "critical" or "high"
    const hasBlockingFinding = diagnostics.some(d => d.severity === 'error');

    return {
      stageName: 'security',
      passed: !hasBlockingFinding,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Maps a RealtimeAnalysisFinding to a Diagnostic.
   */
  private mapRealtimeFindingToDiagnostic(
    finding: RealtimeAnalysisFinding,
    relPath: string,
  ): Diagnostic {
    return {
      file: relPath,
      line: finding.line,
      column: 0,
      message: `[${finding.category}] ${finding.message}`,
      severity: mapSeverity(finding.severity),
    };
  }

  /**
   * Maps an AISecurityFinding to a Diagnostic.
   */
  private mapAIFindingToDiagnostic(
    finding: AISecurityFinding,
    relPath: string,
  ): Diagnostic {
    return {
      file: relPath,
      line: finding.line,
      column: 0,
      message: `[${finding.category}] ${finding.ruleName}: ${finding.remediation}`,
      severity: mapSeverity(finding.severity),
    };
  }
}
