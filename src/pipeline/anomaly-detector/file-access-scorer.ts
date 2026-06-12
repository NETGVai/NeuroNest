/**
 * FileAccessScorer — flags unexpected file access patterns outside task scope.
 *
 * Detects when an agent edit touches files that are outside the expected
 * directories or file list for the current task.
 */
import type { AnomalyScorer, AnomalyScore, AgentEdit, TaskContext } from './types';

/** Sensitive paths that should always raise suspicion when touched unexpectedly. */
const SENSITIVE_PATHS = [
  '.env',
  '.ssh',
  'credentials',
  'secrets',
  'private',
  '.git/config',
  'id_rsa',
  'token',
  'password',
  '.npmrc',
  '.pypirc',
];

export class FileAccessScorer implements AnomalyScorer {
  readonly name = 'FileAccessScorer';

  async score(edit: AgentEdit, context: TaskContext): Promise<AnomalyScore> {
    const concerns: string[] = [];
    let unexpectedCount = 0;
    let sensitiveCount = 0;

    for (const file of edit.files) {
      const filePath = file.filePath.toLowerCase();

      // Check if file is within expected scope
      const inScope = this.isInScope(file.filePath, context);
      if (!inScope) {
        unexpectedCount++;
      }

      // Check for sensitive file access
      if (this.isSensitivePath(filePath)) {
        sensitiveCount++;
        concerns.push(`Touches sensitive file: ${file.filePath}`);
      }
    }

    // Flag if majority of files are outside expected scope
    const totalFiles = edit.files.length;
    const outsideScopeRatio = totalFiles > 0 ? unexpectedCount / totalFiles : 0;

    if (outsideScopeRatio > 0.5 && unexpectedCount > 1) {
      concerns.push(
        `${unexpectedCount}/${totalFiles} files are outside the expected task scope`
      );
    }

    if (sensitiveCount > 0) {
      concerns.push(`Accesses ${sensitiveCount} sensitive file(s)`);
    }

    const flagged = sensitiveCount > 0 || (outsideScopeRatio > 0.5 && unexpectedCount > 1);
    const confidence = Math.min(1.0, (sensitiveCount * 0.5 + outsideScopeRatio * 0.5));

    return { flagged, confidence, concerns };
  }

  private isInScope(filePath: string, context: TaskContext): boolean {
    // Check if path matches any expected file
    if (context.expectedFiles.some(f => filePath.includes(f) || f.includes(filePath))) {
      return true;
    }

    // Check if path is within any expected scope directory
    if (context.expectedScope.some(scope => filePath.startsWith(scope))) {
      return true;
    }

    return false;
  }

  private isSensitivePath(filePath: string): boolean {
    return SENSITIVE_PATHS.some(sensitive => filePath.includes(sensitive));
  }
}
