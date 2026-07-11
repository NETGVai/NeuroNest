/**
 * Deterministic Escalation Chain — attempts cheap, reliable deterministic fixes
 * before invoking the LLM-based self-healing loop.
 *
 * Escalation order:
 * 1. Deterministic fix (eslint --fix for lint failures, OSV fixVersion rewrite for vuln-blocking)
 * 2. LLM self-healing loop (only if deterministic fix failed or was inapplicable)
 * 3. User escalation (only if LLM repair also fails)
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import type {
  AgentEdit,
  ProjectContext,
  VerificationResult,
} from './verification-gate/types.js';
import { DeterministicFixer } from './deterministic-fixer.js';
import type { VerificationRunner } from './self-healing-loop.js';
import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';

// ─── Types ──────────────────────────────────────────────────────

export interface DeterministicEscalationResult {
  /** Whether the deterministic fix resolved the verification failure */
  resolved: boolean;
  /** The fixed edit (if resolved) */
  fixedEdit?: AgentEdit;
  /** The verification result after the deterministic fix (if attempted) */
  verificationResult?: VerificationResult;
  /** What type of deterministic fix was applied */
  fixType?: 'eslint-autofix' | 'osv-version-rewrite' | 'deterministic-codemod';
  /** Whether a deterministic fix was attempted at all */
  attempted: boolean;
  /** Human-readable description of what was done */
  description?: string;
}

export interface DeterministicEscalationConfig {
  /** Project directory for running eslint */
  projectDir: string;
  /** Optional lint command override (default: eslint --fix) */
  lintCommand?: string;
  /** Optional AutoLintTestService instance for lint auto-fix */
  autoLintTestService?: AutoLintTestServiceLike;
  /** Optional database for recording lint runs */
  db?: unknown;
  /** Session ID for tracking */
  sessionId?: string;
}

/**
 * Minimal interface for what we need from AutoLintTestService.
 * Using a duck-typed interface so we don't create a hard dependency.
 */
export interface AutoLintTestServiceLike {
  getConfig(projectId: string): { lintEnabled: boolean; lintCommand?: string; autoFix: boolean };
  recordRun(
    projectId: string,
    type: 'lint' | 'test',
    command: string,
    exitCode: number,
    output: string,
    triggeredBy?: string,
    autoFixed?: boolean,
  ): unknown;
}

// ─── Core Function ──────────────────────────────────────────────

/**
 * Attempts deterministic fixes before resorting to the LLM self-healing loop.
 *
 * Returns a result indicating whether the failure was resolved deterministically.
 * If resolved, the caller should skip the LLM repair loop entirely (Req 21.4).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5
 */
export async function attemptDeterministicFix(
  edit: AgentEdit,
  verificationResult: VerificationResult,
  verifier: VerificationRunner,
  projectContext: ProjectContext,
  config: DeterministicEscalationConfig,
): Promise<DeterministicEscalationResult> {
  const failedStage = verificationResult.failedAt;

  // ─── Lint Stage Failure: attempt eslint --fix (Req 21.2) ────────
  if (failedStage === 'lint') {
    const lintResult = await attemptLintAutoFix(edit, verifier, projectContext, config);
    if (lintResult.resolved) {
      return lintResult;
    }
  }

  // ─── Security/Vulnerability Stage Failure: attempt OSV fixVersion rewrite (Req 21.3) ────────
  if (failedStage === 'security') {
    const vulnResult = await attemptVulnerabilityFix(edit, verificationResult, verifier, projectContext);
    if (vulnResult.resolved) {
      return vulnResult;
    }
  }

  // ─── Check all failed stages for deterministic fix opportunities ────────
  // Even if the primary failure isn't lint or security, check if there are
  // deterministic fixes available for any security findings in the result
  const securityStage = verificationResult.stages.find(s => s.stageName === 'security' && !s.passed);
  if (securityStage && failedStage !== 'security') {
    const vulnResult = await attemptVulnerabilityFix(edit, verificationResult, verifier, projectContext);
    if (vulnResult.resolved) {
      return vulnResult;
    }
  }

  return { resolved: false, attempted: false };
}

// ─── Lint Auto-Fix ──────────────────────────────────────────────

/**
 * Attempts to fix lint failures using eslint --fix (or the project's configured lint command).
 * Uses AutoLintTestService.autoFix path when available (Req 21.2).
 *
 * Records the result in the autoFixed column via AutoLintTestService.
 */
async function attemptLintAutoFix(
  edit: AgentEdit,
  verifier: VerificationRunner,
  projectContext: ProjectContext,
  config: DeterministicEscalationConfig,
): Promise<DeterministicEscalationResult> {
  const { projectDir, autoLintTestService } = config;

  // Determine the lint fix command
  let lintFixCommand: string;
  if (config.lintCommand) {
    lintFixCommand = config.lintCommand;
  } else if (autoLintTestService) {
    const lintConfig = autoLintTestService.getConfig(projectDir);
    if (lintConfig.lintEnabled && lintConfig.lintCommand) {
      // Append --fix if the command doesn't already include it
      lintFixCommand = lintConfig.lintCommand.includes('--fix')
        ? lintConfig.lintCommand
        : `${lintConfig.lintCommand} -- --fix`;
    } else {
      lintFixCommand = 'npx eslint --fix';
    }
  } else {
    lintFixCommand = 'npx eslint --fix';
  }

  // Get the files to lint from the edit
  const filesToFix = edit.changes
    .map(c => c.filePath)
    .filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

  if (filesToFix.length === 0) {
    return { resolved: false, attempted: false };
  }

  try {
    // Run eslint --fix on the affected files
    const fileArgs = filesToFix.map(f => `"${f}"`).join(' ');
    const command = `${lintFixCommand} ${fileArgs}`;

    let exitCode = 0;
    let output = '';
    try {
      output = execSync(command, {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      // eslint --fix may exit with non-zero if some issues are unfixable
      // but it still auto-fixes what it can
      const execError = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = execError.status ?? 1;
      output = (execError.stdout ?? '') + (execError.stderr ?? '');
    }

    // Record the lint run if AutoLintTestService is available (Req 21.2)
    if (autoLintTestService) {
      autoLintTestService.recordRun(
        projectDir,
        'lint',
        command,
        exitCode,
        output,
        'deterministic-escalation',
        true, // autoFixed
      );
    }

    // Re-read the files after eslint --fix modified them
    const updatedChanges = await Promise.all(
      edit.changes.map(async (change) => {
        try {
          const content = fs.readFileSync(change.filePath, 'utf-8');
          return { ...change, content };
        } catch {
          return change;
        }
      }),
    );

    const fixedEdit: AgentEdit = {
      ...edit,
      id: `${edit.id}_eslint_fixed`,
      changes: updatedChanges,
      description: `${edit.description ?? ''} [eslint --fix applied]`,
    };

    // Re-run verification to check if the lint fix resolved the failure (Req 21.4)
    const reVerification = await verifier.run(fixedEdit, projectContext);

    if (reVerification.accepted) {
      return {
        resolved: true,
        fixedEdit,
        verificationResult: reVerification,
        fixType: 'eslint-autofix',
        attempted: true,
        description: `Lint failures resolved by eslint --fix on ${filesToFix.length} file(s)`,
      };
    }

    // eslint --fix ran but didn't fully resolve the issue
    return {
      resolved: false,
      fixedEdit,
      verificationResult: reVerification,
      fixType: 'eslint-autofix',
      attempted: true,
      description: `eslint --fix applied but verification still fails at stage: ${reVerification.failedAt ?? 'unknown'}`,
    };
  } catch (err) {
    // eslint --fix failed entirely (not installed, timeout, etc.)
    console.warn('[DeterministicEscalation] eslint --fix failed:', err);
    return { resolved: false, attempted: true, description: 'eslint --fix failed to execute' };
  }
}

// ─── Vulnerability Fix via OSV fixVersion Rewrite ───────────────

/**
 * Attempts to fix vulnerability-blocker findings by rewriting dependency versions
 * to the fixVersion parsed from OSV (Req 21.3).
 *
 * Uses DeterministicFixer's vulnerable-dependency category for the rewrite.
 */
async function attemptVulnerabilityFix(
  edit: AgentEdit,
  verificationResult: VerificationResult,
  verifier: VerificationRunner,
  projectContext: ProjectContext,
): Promise<DeterministicEscalationResult> {
  const securityStage = verificationResult.stages.find(s => s.stageName === 'security');
  if (!securityStage || securityStage.passed) {
    return { resolved: false, attempted: false };
  }

  // Look for vulnerability-related diagnostics that can be fixed deterministically
  const vulnDiagnostics = securityStage.diagnostics.filter(d =>
    d.message.includes('vulnerable-dependency') ||
    d.message.includes('outdated-dependency') ||
    d.message.includes('weak-crypto') ||
    d.message.includes('unsafe-dom') ||
    d.message.includes('hardcoded-secret'),
  );

  if (vulnDiagnostics.length === 0) {
    return { resolved: false, attempted: false };
  }

  const fixer = new DeterministicFixer(verifier);
  let anyFixApplied = false;
  const appliedFixes: string[] = [];

  // Build a mutable copy of the edit changes
  const updatedChanges = [...edit.changes];

  for (const diagnostic of vulnDiagnostics) {
    // Convert diagnostic to a finding-like object for DeterministicFixer
    const finding = diagnosticToFinding(diagnostic);
    if (!fixer.canFix(finding)) continue;

    // Find the file content from the edit
    const changeIdx = updatedChanges.findIndex(c => c.filePath === diagnostic.file);
    const fileContent = changeIdx >= 0
      ? updatedChanges[changeIdx]!.content
      : readFileContent(diagnostic.file);

    if (!fileContent) continue;

    const fix = fixer.generateFix(finding, fileContent);
    if (!fix) continue;

    // Apply the fix to the file content
    if (changeIdx >= 0) {
      const currentChange = updatedChanges[changeIdx]!;
      const newContent = currentChange.content.replace(fix.original, fix.replacement);
      if (newContent !== currentChange.content) {
        updatedChanges[changeIdx] = { ...currentChange, content: newContent };
        anyFixApplied = true;
        appliedFixes.push(`${fix.category}: ${fix.rationale}`);
      }
    } else {
      // File not in the edit — create a new change entry
      const newContent = fileContent.replace(fix.original, fix.replacement);
      if (newContent !== fileContent) {
        updatedChanges.push({ filePath: fix.filePath, content: newContent });
        anyFixApplied = true;
        appliedFixes.push(`${fix.category}: ${fix.rationale}`);
      }
    }
  }

  if (!anyFixApplied) {
    return { resolved: false, attempted: true, description: 'No applicable deterministic fix found for security findings' };
  }

  const fixedEdit: AgentEdit = {
    ...edit,
    id: `${edit.id}_deterministic_fixed`,
    changes: updatedChanges,
    description: `${edit.description ?? ''} [deterministic security fix applied]`,
  };

  // Re-run verification to check if the deterministic fix resolved the failure (Req 21.4)
  const reVerification = await verifier.run(fixedEdit, projectContext);

  if (reVerification.accepted) {
    // Write the fixed content to disk since deterministic fixes are applied directly
    for (const change of fixedEdit.changes) {
      try {
        fs.writeFileSync(change.filePath, change.content, 'utf-8');
      } catch {
        // File write failed — non-fatal, verification passed on the content
      }
    }

    return {
      resolved: true,
      fixedEdit,
      verificationResult: reVerification,
      fixType: 'osv-version-rewrite',
      attempted: true,
      description: `Deterministic security fix resolved: ${appliedFixes.join('; ')}`,
    };
  }

  return {
    resolved: false,
    fixedEdit,
    verificationResult: reVerification,
    fixType: 'osv-version-rewrite',
    attempted: true,
    description: `Deterministic security fix applied but verification still fails at stage: ${reVerification.failedAt ?? 'unknown'}`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert a verification diagnostic into a RealtimeAnalysisFinding-like object
 * that the DeterministicFixer can process.
 */
function diagnosticToFinding(diagnostic: { file: string; line: number; message: string; severity: string }): RealtimeAnalysisFinding {
  // Parse category from diagnostic message which follows format: "[category] message"
  const categoryMatch = diagnostic.message.match(/^\[([^\]]+)\]/);
  const category = categoryMatch?.[1] ?? 'security';
  const messageBody = categoryMatch ? diagnostic.message.slice(categoryMatch[0].length).trim() : diagnostic.message;

  // Extract remediation from message (after ": " in the body)
  const colonIdx = messageBody.indexOf(': ');
  const remediation = colonIdx >= 0 ? messageBody.slice(colonIdx + 2) : messageBody;

  return {
    id: `diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    file: diagnostic.file,
    line: diagnostic.line,
    category,
    message: messageBody,
    severity: diagnostic.severity as 'critical' | 'high' | 'medium' | 'low',
    remediation,
    blockedWrite: false,
    confidence: 1.0,
  };
}

/**
 * Safely read file content from disk. Returns null if the file is unreadable.
 */
function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
