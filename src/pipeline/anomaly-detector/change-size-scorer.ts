/**
 * ChangeSizeScorer — flags disproportionate change size relative to task description.
 *
 * Compares the actual number of lines changed against the expected size
 * based on the task's estimated scope (small/medium/large).
 */
import type { AnomalyScorer, AnomalyScore, AgentEdit, TaskContext } from './types';

/** Thresholds for expected change sizes (lines changed). */
const SIZE_THRESHOLDS: Record<string, { warn: number; flag: number }> = {
  small: { warn: 50, flag: 100 },
  medium: { warn: 200, flag: 500 },
  large: { warn: 1000, flag: 2000 },
};

/** Maximum number of files for each task size category. */
const FILE_COUNT_THRESHOLDS: Record<string, number> = {
  small: 5,
  medium: 15,
  large: 40,
};

export class ChangeSizeScorer implements AnomalyScorer {
  readonly name = 'ChangeSizeScorer';

  async score(edit: AgentEdit, context: TaskContext): Promise<AnomalyScore> {
    const concerns: string[] = [];
    const thresholds = SIZE_THRESHOLDS[context.estimatedSize] ?? SIZE_THRESHOLDS.medium;
    const fileCountLimit = FILE_COUNT_THRESHOLDS[context.estimatedSize] ?? FILE_COUNT_THRESHOLDS.medium;

    const totalLines = edit.totalLinesChanged;
    const fileCount = edit.files.length;

    let flagged = false;
    let confidence = 0;

    // Check total lines changed against threshold
    if (totalLines > thresholds.flag) {
      flagged = true;
      confidence = Math.min(1.0, totalLines / (thresholds.flag * 2));
      concerns.push(
        `Change size (${totalLines} lines) exceeds threshold for ${context.estimatedSize} task (max expected: ${thresholds.flag})`
      );
    } else if (totalLines > thresholds.warn) {
      confidence = 0.4;
    }

    // Check file count
    if (fileCount > fileCountLimit) {
      flagged = true;
      confidence = Math.max(confidence, Math.min(1.0, fileCount / (fileCountLimit * 2)));
      concerns.push(
        `File count (${fileCount}) exceeds expected limit for ${context.estimatedSize} task (max expected: ${fileCountLimit})`
      );
    }

    // Check for single-file dominance (one file with majority of changes)
    if (edit.files.length > 1) {
      const maxFileLines = Math.max(...edit.files.map(f => f.linesAdded + f.linesRemoved));
      if (totalLines > 0 && maxFileLines / totalLines > 0.9 && totalLines > thresholds.warn) {
        concerns.push(
          `Single file accounts for ${Math.round((maxFileLines / totalLines) * 100)}% of all changes`
        );
      }
    }

    return { flagged, confidence, concerns };
  }
}
