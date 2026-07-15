/**
 * Loop Receipt Generator
 *
 * Produces immutable LoopReceipt records from completed loop runs.
 * Supports JSON persistence (with retry) and Markdown export.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import type {
  LoopReceipt,
  LoopRunContext,
  PassResult,
  TerminalState,
  LoopStorageLike,
  EventBusLike,
} from '../index';

// ─── Constants ──────────────────────────────────────────────────

const RETRY_DELAY_MS = 1000;
const RECEIPT_FAILED_TOPIC = 'loop:receipt:failed';

// ─── ReceiptGenerator ───────────────────────────────────────────

export class ReceiptGenerator {
  /**
   * Generate a LoopReceipt from run context and pass results.
   *
   * This is a synchronous/fast operation that must complete within 2 seconds.
   * It simply assembles the receipt from already-available data.
   *
   * REQ-9.1: Generated when loop reaches any terminal state.
   * REQ-9.2: Contains all required fields (spec id/version, per-pass records,
   *           total cost, total passes, final status, stop reason, timestamps).
   */
  generate(
    context: LoopRunContext,
    passes: PassResult[],
    stopReason: string,
  ): LoopReceipt {
    const now = new Date().toISOString();
    const totalCostUsd = passes.reduce((sum, p) => sum + p.costUsd, 0);

    return {
      specId: context.spec.id,
      specVersion: context.spec.version,
      passes,
      totalCostUsd,
      totalPasses: passes.length,
      finalStatus: this.deriveTerminalStatus(context, passes),
      stopReason,
      startedAt: context.startedAt.toISOString(),
      endedAt: now,
    };
  }

  /**
   * Export receipt as a Markdown document.
   *
   * REQ-9.4: Returns a Markdown document with:
   *   - Header section (loop name, spec id, version, final status, stop reason)
   *   - Summary section (total passes, total cost, start/end timestamps)
   *   - Per-pass sections (pass number, action summary, tools used,
   *     verify results, evidence references, pass cost)
   */
  toMarkdown(receipt: LoopReceipt, specName: string): string {
    const lines: string[] = [];

    // ── Header ──────────────────────────────────────────────────
    lines.push(`# Loop Receipt: ${specName}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Spec ID | ${receipt.specId} |`);
    lines.push(`| Version | ${receipt.specVersion} |`);
    lines.push(`| Final Status | ${receipt.finalStatus} |`);
    lines.push(`| Stop Reason | ${receipt.stopReason} |`);
    lines.push('');

    // ── Summary ─────────────────────────────────────────────────
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`- **Total Passes:** ${receipt.totalPasses}`);
    lines.push(`- **Total Cost:** $${receipt.totalCostUsd.toFixed(4)}`);
    lines.push(`- **Started At:** ${receipt.startedAt}`);
    lines.push(`- **Ended At:** ${receipt.endedAt}`);
    lines.push('');

    // ── Per-Pass Sections ───────────────────────────────────────
    lines.push(`## Pass Details`);
    lines.push('');

    for (const pass of receipt.passes) {
      lines.push(`### Pass ${pass.passNumber}`);
      lines.push('');
      lines.push(`- **Action:** ${pass.actionSummary}`);
      lines.push(`- **Tools Used:** ${pass.toolsUsed.length > 0 ? pass.toolsUsed.join(', ') : 'none'}`);
      lines.push(`- **Cost:** $${pass.costUsd.toFixed(4)}`);
      lines.push(`- **Started:** ${pass.startedAt}`);
      lines.push(`- **Ended:** ${pass.endedAt}`);
      lines.push('');

      // Verify results
      if (pass.verifyResults.length > 0) {
        lines.push(`#### Verify Results`);
        lines.push('');
        lines.push(`| Check | Passed | Output |`);
        lines.push(`| --- | --- | --- |`);
        for (const vr of pass.verifyResults) {
          const status = vr.passed ? '✅' : '❌';
          const output = vr.output.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          lines.push(`| ${vr.checkId} | ${status} | ${output} |`);
        }
        lines.push('');
      }

      // Evidence references
      if (pass.evidence.length > 0) {
        lines.push(`#### Evidence`);
        lines.push('');
        for (const ev of pass.evidence) {
          if (ev.type === 'file') {
            lines.push(`- 📄 \`${ev.ref}\``);
          } else {
            lines.push(`- 📝 ${ev.ref}`);
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Persist receipt JSON to storage with retry logic.
   *
   * REQ-9.3: Stores receipt as JSON in loop_runs.receipt_json (immutable once written).
   * REQ-9.5: On write failure, retries once after 1 second. If retry also fails,
   *           publishes loop:receipt:failed event with run_id and error description.
   */
  async persistReceipt(
    runId: string,
    receipt: LoopReceipt,
    storage: LoopStorageLike,
    eventBus: EventBusLike,
  ): Promise<void> {
    const receiptJson = JSON.stringify(receipt);

    try {
      await storage.writeReceipt(runId, receiptJson);
    } catch (firstError) {
      // Wait 1 second then retry once
      await this.delay(RETRY_DELAY_MS);

      try {
        await storage.writeReceipt(runId, receiptJson);
      } catch (retryError) {
        // Both attempts failed — publish failure event
        const errorDescription =
          retryError instanceof Error ? retryError.message : String(retryError);

        await eventBus.publish(RECEIPT_FAILED_TOPIC, {
          run_id: runId,
          error: errorDescription,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Derive terminal status from the context state. This is a simple mapping
   * since the loop runner has already determined the terminal state.
   * Falls back to 'BLOCKED' if no clear terminal state is determinable.
   */
  private deriveTerminalStatus(
    context: LoopRunContext,
    passes: PassResult[],
  ): TerminalState {
    // Check if all verify checks in the last pass passed → SUCCEEDED
    if (passes.length > 0) {
      const lastPass = passes[passes.length - 1];
      if (lastPass) {
        const allPassed = lastPass.verifyResults.length > 0 &&
          lastPass.verifyResults.every((vr) => vr.passed);
        if (allPassed) {
          return 'SUCCEEDED';
        }
      }
    }

    // Check for stall (same progress hash repeated)
    const noProgressPasses = context.spec.stop.noProgressPasses;
    if (context.progressHashes.length >= noProgressPasses) {
      const recent = context.progressHashes.slice(-noProgressPasses);
      const firstHash = recent[0];
      if (firstHash !== undefined && recent.every((h) => h === firstHash)) {
        return 'STALLED';
      }
    }

    // Check limit exhaustion
    if (context.passesCompleted >= context.spec.stop.maxPasses) {
      return 'LIMIT_EXHAUSTED';
    }
    if (context.cumulativeCostUsd >= context.spec.stop.maxCostUsd) {
      return 'LIMIT_EXHAUSTED';
    }

    // Check no-op (first pass with no activity and all checks pass)
    if (passes.length === 1) {
      const first = passes[0];
      if (first) {
        const noActivity = first.toolsUsed.length === 0 && first.actionSummary === '';
        const allPassed = first.verifyResults.every((vr) => vr.passed);
        if (noActivity && allPassed) {
          return 'NO_OP';
        }
      }
    }

    // Default fallback
    return 'BLOCKED';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
