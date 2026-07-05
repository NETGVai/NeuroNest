/**
 * Loop Doctor — Audit and repair of LoopSpec definitions.
 *
 * Detects:
 * - Weak verification (only llmJudge checks, no deterministic check)
 * - SecurityPolicy violations (enterprise with llmJudge, maxPasses over cap)
 * - Missing approval boundaries for HIGH-risk tools
 *
 * Implements Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import type { LoopSpec, DoctorFinding, SecurityPolicy } from '../index';

// ── HIGH-risk tool classifications per security policy ──────────

/** Tools classified as HIGH-risk for 'strict' policy */
const STRICT_HIGH_RISK_TOOLS = ['shell', 'network'];

/** Tools classified as HIGH-risk for 'enterprise' policy (strict + git-write) */
const ENTERPRISE_HIGH_RISK_TOOLS = [...STRICT_HIGH_RISK_TOOLS, 'git-write'];

/** MaxPasses caps per security policy */
const MAX_PASSES_CAP: Record<SecurityPolicy, number> = {
  standard: 50,
  strict: 25,
  enterprise: 10,
};

export class LoopDoctor {
  /**
   * Audit a LoopSpec for weak verification, security policy violations,
   * and missing approval boundaries.
   *
   * Runs automatically on imported catalog specs (REQ-12.4).
   */
  async audit(spec: LoopSpec): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];

    this.auditWeakVerification(spec, findings);
    this.auditSecurityPolicyViolations(spec, findings);
    this.auditMissingApprovalBoundaries(spec, findings);

    return findings;
  }

  /**
   * Generate a repair diff applying all repair recommendations from findings.
   * Produces a human-readable diff string showing original vs proposed changes.
   */
  generateRepairDiff(
    spec: LoopSpec,
    findings: DoctorFinding[],
  ): { original: LoopSpec; proposed: LoopSpec; diff: string } {
    // Deep clone the spec to create the proposed version
    const proposed: LoopSpec = JSON.parse(JSON.stringify(spec));

    // Apply all repair recommendations
    for (const finding of findings) {
      if (finding.repair) {
        this.applyRepair(proposed, finding.repair);
      }
    }

    // Generate human-readable diff
    const diff = this.generateDiffString(spec, proposed, findings);

    return { original: spec, proposed, diff };
  }

  // ── Private audit methods ───────────────────────────────────────

  /**
   * REQ-12.1, REQ-12.3: Flag specs where verify array contains only llmJudge
   * checks with no deterministic check (command, metric, or file).
   */
  private auditWeakVerification(spec: LoopSpec, findings: DoctorFinding[]): void {
    const hasDeterministicCheck = spec.verify.some(
      (check) => check.type === 'command' || check.type === 'metric' || check.type === 'file',
    );

    if (!hasDeterministicCheck && spec.verify.length > 0) {
      findings.push({
        severity: 'warning',
        field: 'verify',
        message:
          'Verify array contains only llmJudge checks (weak verification). ' +
          'Recommend adding at least one deterministic check (command, metric, or file).',
        repair: {
          verify: [
            ...spec.verify,
            {
              type: 'command',
              command: 'echo "placeholder: add a real deterministic check"',
              expectedExitCode: 0,
            },
          ],
        },
      });
    }
  }

  /**
   * REQ-12.1: Audit for securityPolicy violations:
   * - 'enterprise' policy disables llmJudge checks entirely
   * - 'strict' caps maxPasses at 25
   * - 'enterprise' caps maxPasses at 10
   */
  private auditSecurityPolicyViolations(spec: LoopSpec, findings: DoctorFinding[]): void {
    const { securityPolicy } = spec.scope;

    // Enterprise policy disables llmJudge
    if (securityPolicy === 'enterprise') {
      const hasLlmJudge = spec.verify.some((check) => check.type === 'llmJudge');
      if (hasLlmJudge) {
        const filteredVerify = spec.verify.filter((check) => check.type !== 'llmJudge');
        findings.push({
          severity: 'error',
          field: 'verify',
          message:
            'Enterprise security policy disables llmJudge verification checks. ' +
            'All llmJudge checks must be removed.',
          repair: {
            verify: filteredVerify.length > 0 ? filteredVerify : undefined,
          },
        });
      }
    }

    // MaxPasses cap enforcement
    const cap = MAX_PASSES_CAP[securityPolicy];
    if (spec.stop.maxPasses > cap) {
      findings.push({
        severity: 'error',
        field: 'stop.maxPasses',
        message:
          `Security policy '${securityPolicy}' caps maxPasses at ${cap}, ` +
          `but spec has maxPasses=${spec.stop.maxPasses}.`,
        repair: {
          stop: {
            maxPasses: cap,
          } as LoopSpec['stop'],
        },
      });
    }
  }

  /**
   * REQ-12.1: Audit for missing approval boundaries when spec allows tools
   * classified as HIGH-risk without requiring user approval.
   *
   * HIGH-risk tools:
   * - 'strict': shell, network
   * - 'enterprise': shell, network, git-write
   */
  private auditMissingApprovalBoundaries(spec: LoopSpec, findings: DoctorFinding[]): void {
    const { securityPolicy } = spec.scope;

    // Only strict and enterprise require approval boundaries for HIGH-risk tools
    if (securityPolicy === 'standard') {
      return;
    }

    const highRiskTools =
      securityPolicy === 'enterprise' ? ENTERPRISE_HIGH_RISK_TOOLS : STRICT_HIGH_RISK_TOOLS;

    // Check if spec allows any HIGH-risk tools
    const allowedHighRisk = spec.scope.allowedTools.filter((tool) =>
      highRiskTools.some((hrt) => tool.toLowerCase().includes(hrt.toLowerCase())),
    );

    if (allowedHighRisk.length === 0) {
      return;
    }

    // Check if approval boundaries are defined
    const hasApprovalBoundaries =
      spec.stop.approvalBoundaries && spec.stop.approvalBoundaries.length > 0;

    if (!hasApprovalBoundaries) {
      // Generate approval boundaries for every pass (most conservative)
      const boundaries = Array.from({ length: spec.stop.maxPasses }, (_, i) => i + 1);

      findings.push({
        severity: 'error',
        field: 'stop.approvalBoundaries',
        message:
          `Security policy '${securityPolicy}' requires approval boundaries for HIGH-risk tools ` +
          `(${allowedHighRisk.join(', ')}), but none are defined.`,
        repair: {
          stop: {
            approvalBoundaries: boundaries,
          } as LoopSpec['stop'],
        },
      });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Apply a partial repair to the proposed spec (in-place mutation).
   * For nested objects (stop, scope), merges fields rather than replacing.
   */
  private applyRepair(proposed: LoopSpec, repair: Partial<LoopSpec>): void {
    for (const [key, value] of Object.entries(repair)) {
      if (value === undefined) {
        continue;
      }

      if (key === 'stop' && typeof value === 'object') {
        // Merge stop fields on top of the current proposed.stop
        proposed.stop = {
          ...proposed.stop,
          ...(value as object),
        };
      } else if (key === 'scope' && typeof value === 'object') {
        // Merge scope fields on top of the current proposed.scope
        proposed.scope = {
          ...proposed.scope,
          ...(value as object),
        };
      } else {
        (proposed as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  /**
   * Generate a human-readable diff string describing all changes.
   */
  private generateDiffString(
    original: LoopSpec,
    proposed: LoopSpec,
    findings: DoctorFinding[],
  ): string {
    const lines: string[] = [];
    lines.push(`--- Loop Doctor Repair Diff ---`);
    lines.push(`Spec: ${original.name} (${original.id})`);
    lines.push(`Findings: ${findings.length}`);
    lines.push('');

    for (const finding of findings) {
      lines.push(`[${finding.severity.toUpperCase()}] ${finding.field}: ${finding.message}`);

      if (finding.repair) {
        for (const [key, value] of Object.entries(finding.repair)) {
          if (value === undefined) continue;
          const originalValue = (original as unknown as Record<string, unknown>)[key];
          const proposedValue = (proposed as unknown as Record<string, unknown>)[key];
          lines.push(`  - ${key}:`);
          lines.push(`    original: ${JSON.stringify(originalValue, null, 2).split('\n').join('\n    ')}`);
          lines.push(`    proposed: ${JSON.stringify(proposedValue, null, 2).split('\n').join('\n    ')}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
