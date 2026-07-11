/**
 * Pre-Write Security Analysis — Runs all security analyzers before a file write
 * to catch and remediate vulnerabilities before they reach disk.
 *
 * Executes HackabilityScoringEngine, ThreatModeler, and AISecurityRuleEngine
 * concurrently within a 500ms latency budget. If budget is exceeded, the write
 * is allowed with a post-write flag. If critical/high findings are detected
 * within budget, the write is blocked and routed to the SecurityRemediationBridge.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */

import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';
import type { ThreatSeverity } from '../runtime-security/types.js';
import type { HackabilityScoringEngine, HackabilityScoreResult } from '../runtime-security/hackability-scoring-engine.js';
import type { ThreatModeler, ThreatModelResult } from '../runtime-security/threat-modeler.js';
import type { AISecurityRuleEngine, AISecurityEvalResult } from '../runtime-security/ai-security-rule-engine.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface PreWriteAnalysisResult {
  /** Whether the write is allowed to proceed */
  allowed: boolean;
  /** Findings that caused the block (if not allowed) */
  findings: RealtimeAnalysisFinding[];
  /** Whether latency budget was exceeded (write allowed but flagged) */
  budgetExceeded: boolean;
  /** Actual analysis duration in ms */
  durationMs: number;
}

/**
 * Dependencies required by the pre-write analysis function.
 * These are the three security engines that run concurrently.
 */
export interface PreWriteAnalysisDeps {
  hackabilityEngine: HackabilityScoringEngine;
  threatModeler: ThreatModeler;
  aiSecurityRuleEngine: AISecurityRuleEngine;
}

// ─── Default Budget ─────────────────────────────────────────────

const DEFAULT_LATENCY_BUDGET_MS = 500;

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert HackabilityScoreResult into RealtimeAnalysisFinding[].
 * Maps the hackability score and contributing factors into findings
 * with appropriate severity based on score thresholds.
 */
function hackabilityToFindings(
  result: HackabilityScoreResult,
): RealtimeAnalysisFinding[] {
  if (result.contributingFactors.length === 0) {
    return [];
  }

  let severity: ThreatSeverity;
  if (result.score >= 75) {
    severity = 'critical';
  } else if (result.score >= 40) {
    severity = 'high';
  } else if (result.score >= 20) {
    severity = 'medium';
  } else {
    severity = 'low';
  }

  return result.contributingFactors.map((factor, idx) => ({
    id: `hackability-${result.filePath}-${idx}`,
    severity,
    confidence: result.score >= 75 ? 0.85 : result.score >= 40 ? 0.7 : 0.5,
    category: 'hackability-scoring',
    message: `Hackability score ${result.score}/100: ${factor}`,
    file: result.filePath,
    line: 1,
    remediation: `Address ${factor} to reduce hackability score below warning threshold`,
    blockedWrite: severity === 'critical' || severity === 'high',
  }));
}

/**
 * Convert ThreatModelResult into RealtimeAnalysisFinding[].
 * Maps threats into the standard finding format.
 */
function threatModelToFindings(result: ThreatModelResult): RealtimeAnalysisFinding[] {
  return result.threats.map((threat) => ({
    id: threat.id,
    severity: threat.severity,
    confidence: threat.severity === 'critical' ? 0.85 : threat.severity === 'high' ? 0.75 : 0.6,
    category: `threat-model-${threat.attackVector.split(' ')[0]?.toLowerCase() ?? 'unknown'}`,
    message: threat.attackVector,
    file: threat.affectedLocations[0]?.file ?? 'unknown',
    line: threat.affectedLocations[0]?.line ?? 1,
    remediation: threat.mitigation,
    blockedWrite: threat.severity === 'critical' || threat.severity === 'high',
  }));
}

/**
 * Convert AISecurityEvalResult into RealtimeAnalysisFinding[].
 * Maps AI security rule findings into the standard format.
 */
function aiRuleToFindings(
  result: AISecurityEvalResult,
): RealtimeAnalysisFinding[] {
  return result.findings.map((finding) => ({
    id: `ai-rule-${finding.ruleId}`,
    severity: finding.severity,
    confidence: finding.confidence,
    category: finding.category,
    message: `${finding.ruleName}: ${finding.match}`,
    file: finding.file,
    line: finding.line,
    remediation: finding.remediation,
    blockedWrite: finding.severity === 'critical' || finding.severity === 'high',
  }));
}

/**
 * Determines if any finding has a severity that should block a write.
 * Critical and high severity findings block; medium and low do not.
 */
function hasCriticalOrHighFinding(findings: RealtimeAnalysisFinding[]): boolean {
  return findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run pre-write security analysis using all three security engines concurrently.
 *
 * The function races the three analyzers against the latency budget:
 * - If all complete within budget and no critical/high findings → allow write
 * - If critical/high findings found within budget → block write
 * - If budget exceeded → allow write with budgetExceeded flag for post-write verification
 *
 * Requirement 12.1: Runs HackabilityScoringEngine, ThreatModeler, AISecurityRuleEngine
 * Requirement 12.2: Blocks write on critical/high findings within budget
 * Requirement 12.3: Completes within 500ms latency budget (exactly 500ms = exceeded)
 * Requirement 12.4: Allows write and flags for post-write when budget exceeded
 */
export async function runPreWriteAnalysis(
  filePath: string,
  content: string,
  deps: PreWriteAnalysisDeps,
  latencyBudgetMs: number = DEFAULT_LATENCY_BUDGET_MS,
): Promise<PreWriteAnalysisResult> {
  const startTime = Date.now();

  // Run all three analyzers concurrently with a timeout race
  const analysisPromise = runAnalyzersConcurrently(filePath, content, deps);

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), latencyBudgetMs);
  });

  const raceResult = await Promise.race([analysisPromise, timeoutPromise]);

  const durationMs = Date.now() - startTime;

  // Budget exceeded — allow write with post-write flag
  if (raceResult === 'timeout') {
    return {
      allowed: true,
      findings: [],
      budgetExceeded: true,
      durationMs,
    };
  }

  // Check actual elapsed time (exactly 500ms is treated as exceeding the budget per Req 12.3)
  if (durationMs >= latencyBudgetMs) {
    return {
      allowed: true,
      findings: raceResult,
      budgetExceeded: true,
      durationMs,
    };
  }

  // Within budget — check findings for critical/high severity
  if (hasCriticalOrHighFinding(raceResult)) {
    return {
      allowed: false,
      findings: raceResult,
      budgetExceeded: false,
      durationMs,
    };
  }

  // All clear or only low/medium findings — allow write
  return {
    allowed: true,
    findings: raceResult,
    budgetExceeded: false,
    durationMs,
  };
}

/**
 * Run all three analyzers concurrently and collect their findings.
 * Each analyzer is wrapped in a try/catch so a single failure doesn't
 * prevent others from completing.
 */
async function runAnalyzersConcurrently(
  filePath: string,
  content: string,
  deps: PreWriteAnalysisDeps,
): Promise<RealtimeAnalysisFinding[]> {
  const sessionId = `pre-write-${Date.now()}`;

  // Wrap each analyzer call to handle both sync and async errors
  const hackabilityPromise = (async () =>
    deps.hackabilityEngine.scoreFile(filePath, content, sessionId))();

  const threatPromise = (async () =>
    deps.threatModeler.analyze([{ path: filePath, content }], sessionId))();

  const aiRulePromise = (async () =>
    deps.aiSecurityRuleEngine.evaluate(filePath, content, sessionId))();

  const [hackabilityResult, threatResult, aiRuleResult] = await Promise.allSettled([
    hackabilityPromise,
    threatPromise,
    aiRulePromise,
  ]);

  const findings: RealtimeAnalysisFinding[] = [];

  // Collect hackability findings (graceful on failure)
  if (hackabilityResult.status === 'fulfilled') {
    findings.push(...hackabilityToFindings(hackabilityResult.value));
  }

  // Collect threat model findings (graceful on failure)
  if (threatResult.status === 'fulfilled') {
    findings.push(...threatModelToFindings(threatResult.value));
  }

  // Collect AI security rule findings (graceful on failure)
  if (aiRuleResult.status === 'fulfilled') {
    findings.push(...aiRuleToFindings(aiRuleResult.value));
  }

  return findings;
}
