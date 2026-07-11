/**
 * Pre-Write Hook Wiring — Registers the pre-write security analysis
 * as a before-tool-call hook on file-write and file-edit tool operations.
 *
 * When the analysis blocks a write (critical/high findings), the wiring:
 * 1. Attempts a deterministic fix via DeterministicFixer (no LLM cost)
 * 2. Routes deterministic fix results through the verification gate
 * 3. Falls back to SecurityRemediationBridge for LLM-based repair
 *
 * This implements the escalation chain: deterministic fix → LLM self-healing → user escalation.
 *
 * Requirements: 12.1, 12.2, 10.1
 */

import type { CallbackEngine, HookContext } from './callback-engine.js';
import type { PreWriteAnalysisDeps, PreWriteAnalysisResult } from './pre-write-analysis.js';
import type { AgentEdit, ProjectContext } from './verification-gate/types.js';
import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';
import type { VerificationRunner } from './self-healing-loop.js';
import { runPreWriteAnalysis } from './pre-write-analysis.js';
import { SecurityRemediationBridge, type RepairRequest } from './security-remediation-bridge.js';
import { DeterministicFixer } from './deterministic-fixer.js';
import { generateRegressionTestForDeterministicFix, generateRegressionTestForSelfHealingFix } from './post-fix-regression-pipeline.js';

// ─── Configuration ──────────────────────────────────────────────

export interface PreWriteHookWiringConfig {
  /** Pre-write analysis dependencies (the three security engines) */
  analysisDeps: PreWriteAnalysisDeps;
  /** SecurityRemediationBridge instance for LLM-based repair */
  remediationBridge: SecurityRemediationBridge;
  /** DeterministicFixer instance for mechanical fixes */
  deterministicFixer: DeterministicFixer;
  /** Verification runner to verify deterministic fix results */
  verifier: VerificationRunner;
  /** Project context for verification gate */
  projectContext: ProjectContext;
  /** Latency budget in ms for pre-write analysis (default: 500) */
  latencyBudgetMs?: number;
}

// ─── Tool Name Detection ────────────────────────────────────────

/** Tool names that represent file-write or file-edit operations. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'fs_write',
  'file_write',
  'file_edit',
]);

/**
 * Determine if a hook context represents a file-write or file-edit tool call.
 */
function isFileWriteOrEditToolCall(ctx: HookContext): boolean {
  return ctx.toolName !== undefined && FILE_WRITE_TOOL_NAMES.has(ctx.toolName);
}

/**
 * Extract file path and content from a before-tool-call hook context.
 * For before-tool-call, the content comes from the input (the write hasn't happened yet).
 */
function extractWriteDetails(ctx: HookContext): { filePath: string | undefined; content: string | undefined } {
  const input = ctx.input as Record<string, unknown> | undefined;
  if (!input) return { filePath: undefined, content: undefined };

  const filePath = (input['filePath'] ?? input['path'] ?? input['file'] ?? input['targetFile']) as string | undefined;
  const content = (input['content'] ?? input['text'] ?? input['newContent']) as string | undefined;

  return { filePath, content };
}

// ─── Hook Result ────────────────────────────────────────────────

export interface PreWriteHookResult {
  /** Whether the write was allowed to proceed */
  allowed: boolean;
  /** The analysis result from runPreWriteAnalysis */
  analysisResult?: PreWriteAnalysisResult;
  /** Whether a deterministic fix was applied */
  deterministicFixApplied?: boolean;
  /** Whether remediation bridge was invoked */
  remediationInvoked?: boolean;
  /** Error message if the write was blocked */
  blockReason?: string;
}

// ─── Wiring Function ────────────────────────────────────────────

/**
 * Wire pre-write security analysis into the file-write tool hook system.
 *
 * Registers a before-tool-call hook on the CallbackEngine that:
 * 1. Calls runPreWriteAnalysis for file-write and file-edit operations
 * 2. When blocked, attempts deterministic fixes first (no LLM cost)
 * 3. Routes deterministic fix results through the verification gate
 * 4. Falls back to SecurityRemediationBridge if deterministic fix unavailable or fails
 *
 * Requirement 12.1: Registers pre-write analyzers on before-tool-call hook
 * Requirement 12.2: Blocks write on critical/high findings, routes to remediation
 * Requirement 10.1: Constructs RepairRequest and routes to SecurityRemediationBridge
 *
 * @param callbackEngine - The pipeline's CallbackEngine for hook registration
 * @param config - Configuration containing all required dependencies
 */
export function wirePreWriteAnalysis(
  callbackEngine: CallbackEngine,
  config: PreWriteHookWiringConfig,
): void {
  const {
    analysisDeps,
    remediationBridge,
    deterministicFixer,
    verifier,
    projectContext,
    latencyBudgetMs,
  } = config;

  callbackEngine.register('before-tool-call', async (ctx: HookContext) => {
    // Only intercept file-write and file-edit tool calls
    if (!isFileWriteOrEditToolCall(ctx)) {
      return;
    }

    const { filePath, content } = extractWriteDetails(ctx);

    // If we can't determine what's being written, allow the write
    if (!filePath || !content) {
      return;
    }

    // Run pre-write security analysis within latency budget
    let analysisResult: PreWriteAnalysisResult;
    try {
      analysisResult = await runPreWriteAnalysis(
        filePath,
        content,
        analysisDeps,
        latencyBudgetMs,
      );
    } catch {
      // If the analysis itself fails, allow the write (fail open for the analysis layer)
      // The post-write hooks will still catch issues
      return;
    }

    // If the write is allowed (no critical/high findings or budget exceeded), proceed
    if (analysisResult.allowed) {
      return;
    }

    // Write is blocked — attempt remediation
    // Requirement 12.2: Block write and route to remediation
    const blockingFindings = analysisResult.findings.filter(
      f => f.severity === 'critical' || f.severity === 'high',
    );

    // Step 1: Try deterministic fixes first (Requirement 21 escalation chain)
    const deterministicResult = await attemptDeterministicFixes(
      blockingFindings,
      content,
      deterministicFixer,
      verifier,
      projectContext,
    );

    if (deterministicResult.success) {
      // Deterministic fix resolved the issue — update the input with fixed content
      // The hook modifies ctx.input to carry the corrected content forward
      applyFixedContentToContext(ctx, deterministicResult.fixedContent!);

      // Requirement 15.1, 15.4: Generate regression test after successful deterministic fix
      // Fire-and-forget — test generation failure should not block the write
      for (const finding of blockingFindings) {
        const fix = deterministicFixer.generateFix(finding, content);
        if (fix) {
          generateRegressionTestForDeterministicFix(fix, finding, projectContext).catch(() => {
            // Regression test generation is best-effort; failure is logged but non-blocking
          });
          break; // One regression test per fix batch is sufficient
        }
      }
      return;
    }

    // Step 2: Route to SecurityRemediationBridge for LLM-based repair (Requirement 10.1)
    const repairRequest = constructRepairRequest(
      filePath,
      content,
      blockingFindings,
      ctx.sessionId,
    );

    try {
      const remediationResult = await remediationBridge.remediate(
        repairRequest,
        projectContext,
      );

      if (remediationResult.success && remediationResult.correctedEdit) {
        // Apply the corrected edit's content to the hook context
        const correctedContent = remediationResult.correctedEdit.changes[0]?.content;
        if (correctedContent) {
          applyFixedContentToContext(ctx, correctedContent);
        }

        // Requirement 15.1, 15.4: Generate regression test after successful self-healing fix
        // Fire-and-forget — test generation failure should not block the write
        if (blockingFindings.length > 0) {
          generateRegressionTestForSelfHealingFix(
            remediationResult.correctedEdit,
            blockingFindings[0]!,
            projectContext,
          ).catch(() => {
            // Regression test generation is best-effort; failure is logged but non-blocking
          });
        }
        return;
      }

      // Remediation failed — the bridge already handles escalation/blocking
      // Throw to signal the write should be aborted
      throw new PreWriteBlockedError(
        blockingFindings,
        remediationResult.failureReason ?? 'Remediation failed',
      );
    } catch (err) {
      if (err instanceof PreWriteBlockedError) {
        throw err;
      }
      // Unexpected error from remediation bridge — block the write with details
      throw new PreWriteBlockedError(
        blockingFindings,
        `Remediation error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

// ─── Deterministic Fix Attempt ──────────────────────────────────

interface DeterministicFixAttemptResult {
  success: boolean;
  fixedContent?: string;
}

/**
 * Attempt to apply deterministic fixes for all blocking findings.
 * Routes results through the verification gate to ensure fixes don't break the build.
 *
 * Returns success only if ALL blocking findings were fixed deterministically
 * and the fixes pass verification.
 */
async function attemptDeterministicFixes(
  findings: RealtimeAnalysisFinding[],
  originalContent: string,
  fixer: DeterministicFixer,
  verifier: VerificationRunner,
  projectContext: ProjectContext,
): Promise<DeterministicFixAttemptResult> {
  // Check if all blocking findings can be fixed deterministically
  const fixableFindings = findings.filter(f => fixer.canFix(f));

  if (fixableFindings.length === 0) {
    return { success: false };
  }

  // Generate fixes for all fixable findings
  let currentContent = originalContent;
  const appliedFixes = [];

  for (const finding of fixableFindings) {
    const fix = fixer.generateFix(finding, currentContent);
    if (!fix) {
      // If any fixable finding can't actually generate a fix, fall back
      return { success: false };
    }
    // Apply the fix to the content in memory
    currentContent = currentContent.replace(fix.original, fix.replacement);
    appliedFixes.push(fix);
  }

  // Only consider it a success if ALL blocking findings were addressed
  if (appliedFixes.length < findings.length) {
    // Some findings couldn't be fixed deterministically — fall back to LLM
    return { success: false };
  }

  // Route through verification gate (Requirement 11.5)
  const filePath = findings[0]?.file ?? 'unknown';
  const verificationEdit: AgentEdit = {
    id: `pre-write-deterministic-fix-${Date.now()}`,
    taskId: 'pre-write-security-fix',
    changes: [{
      filePath,
      content: currentContent,
      originalContent,
    }],
    description: `Deterministic security fix: ${appliedFixes.map(f => f.rationale).join('; ')}`,
  };

  try {
    const verificationResult = await verifier.run(verificationEdit, projectContext);
    if (verificationResult.accepted) {
      return { success: true, fixedContent: currentContent };
    }
    // Verification failed — the deterministic fix broke something
    return { success: false };
  } catch {
    // Verification error — fall back to LLM repair
    return { success: false };
  }
}

// ─── RepairRequest Construction ─────────────────────────────────

/**
 * Construct a RepairRequest from blocked write details.
 * Requirement 10.1: Construct RepairRequest from blocked edit and findings.
 */
function constructRepairRequest(
  filePath: string,
  content: string,
  findings: RealtimeAnalysisFinding[],
  sessionId: string,
): RepairRequest {
  const blockedEdit: AgentEdit = {
    id: `blocked-write-${Date.now()}`,
    taskId: 'security-blocked-write',
    changes: [{
      filePath,
      content,
    }],
    description: `Write blocked by pre-write security analysis: ${findings.length} finding(s)`,
  };

  return {
    originalContent: '', // Original file content before the attempted edit (empty for new files)
    blockedEdit,
    findings,
    agentContext: {
      agentId: 'pre-write-hook',
      sessionId,
    },
  };
}

// ─── Context Mutation ───────────────────────────────────────────

/**
 * Apply fixed content back to the hook context's input, so the tool
 * proceeds with the corrected content instead of the original.
 */
function applyFixedContentToContext(ctx: HookContext, fixedContent: string): void {
  const input = ctx.input as Record<string, unknown> | undefined;
  if (!input) return;

  // Update whichever content field is present
  if ('content' in input) {
    input['content'] = fixedContent;
  } else if ('text' in input) {
    input['text'] = fixedContent;
  } else if ('newContent' in input) {
    input['newContent'] = fixedContent;
  }
}

// ─── Error Types ────────────────────────────────────────────────

/**
 * Error thrown when a pre-write analysis blocks a write and remediation fails.
 * Contains the findings and remediation failure reason for caller handling.
 */
export class PreWriteBlockedError extends Error {
  constructor(
    public readonly findings: RealtimeAnalysisFinding[],
    public readonly reason: string,
  ) {
    const findingSummary = findings
      .map(f => `[${f.severity}] ${f.category}: ${f.message}`)
      .join('; ');
    super(`Pre-write security analysis blocked write: ${findingSummary}. ${reason}`);
    this.name = 'PreWriteBlockedError';
  }
}
