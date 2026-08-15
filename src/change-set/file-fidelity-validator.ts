/**
 * FileFidelityValidator — Validates that proposed content preserves file fidelity
 * characteristics: line endings, encoding, final newline, executable permissions,
 * and indentation style.
 *
 * Ensures the diff engine does not inadvertently alter file formatting unless
 * the Change_Set explicitly intends such changes.
 *
 * Requirements: 7.6, 7.7
 */

/**
 * Detected line ending style.
 */
export type LineEnding = 'LF' | 'CRLF' | 'CR' | 'mixed';

/**
 * Detected indentation style.
 */
export type IndentationStyle = 'tabs' | 'spaces' | 'mixed' | 'none';

/**
 * Detected encoding type.
 */
export type EncodingType = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'ascii' | 'unknown';

/**
 * Fidelity characteristics of a file's content.
 */
export interface FileFidelityInfo {
  /** Detected line ending style */
  readonly lineEnding: LineEnding;
  /** Whether the file ends with a newline */
  readonly hasFinalNewline: boolean;
  /** Detected encoding (based on BOM or content analysis) */
  readonly encoding: EncodingType;
  /** Detected indentation style */
  readonly indentation: IndentationStyle;
  /** Detected indent size (spaces per level, if spaces) */
  readonly indentSize: number;
}

/**
 * File metadata including permissions.
 */
export interface FileMetadata {
  /** Whether the file has the executable permission bit set */
  readonly executable: boolean;
  /** File mode bits (e.g., 0o755, 0o644), if known */
  readonly mode?: number;
}

/**
 * Severity of a fidelity violation.
 */
export type FidelityViolationSeverity = 'error' | 'warning';

/**
 * A single fidelity violation found during validation.
 */
export interface FidelityViolation {
  /** The type of violation */
  readonly kind: 'line-ending' | 'encoding' | 'final-newline' | 'indentation' | 'executable-permission';
  /** Severity level */
  readonly severity: FidelityViolationSeverity;
  /** Human-readable description */
  readonly message: string;
  /** The expected value (from the base file) */
  readonly expected: string;
  /** The actual value (in the proposed content) */
  readonly actual: string;
  /** The file URI this violation applies to */
  readonly targetUri: string;
}

/**
 * Result of a fidelity validation.
 */
export interface FidelityValidationResult {
  /** Whether the proposed content preserves fidelity */
  readonly valid: boolean;
  /** List of violations found */
  readonly violations: readonly FidelityViolation[];
  /** Fidelity info for the base content */
  readonly baseFidelity: FileFidelityInfo;
  /** Fidelity info for the proposed content */
  readonly proposedFidelity: FileFidelityInfo;
}

/**
 * Options for a fidelity validation that includes metadata.
 */
export interface FidelityValidationOptions {
  /** Base file metadata (permissions, etc.) */
  readonly baseMetadata?: FileMetadata;
  /** Proposed file metadata (permissions, etc.) */
  readonly proposedMetadata?: FileMetadata;
  /** Whether to check executable permission preservation */
  readonly checkExecutablePermission?: boolean;
}

/**
 * FileFidelityValidator checks that proposed content preserves key file
 * formatting characteristics from the base content.
 */
export class FileFidelityValidator {
  /**
   * Validate that proposed content preserves fidelity of the base content.
   */
  validate(
    targetUri: string,
    baseContent: string,
    proposedContent: string,
    options?: FidelityValidationOptions
  ): FidelityValidationResult {
    const baseFidelity = this.analyze(baseContent);
    const proposedFidelity = this.analyze(proposedContent);
    const violations: FidelityViolation[] = [];

    // Check line ending preservation
    if (
      baseFidelity.lineEnding !== 'mixed' &&
      proposedFidelity.lineEnding !== 'mixed' &&
      baseFidelity.lineEnding !== proposedFidelity.lineEnding
    ) {
      violations.push({
        kind: 'line-ending',
        severity: 'error',
        message: `Line endings changed from ${baseFidelity.lineEnding} to ${proposedFidelity.lineEnding}`,
        expected: baseFidelity.lineEnding,
        actual: proposedFidelity.lineEnding,
        targetUri,
      });
    }

    // Check for mixed line endings introduced
    if (
      baseFidelity.lineEnding !== 'mixed' &&
      proposedFidelity.lineEnding === 'mixed'
    ) {
      violations.push({
        kind: 'line-ending',
        severity: 'warning',
        message: `Mixed line endings introduced (base was consistent ${baseFidelity.lineEnding})`,
        expected: baseFidelity.lineEnding,
        actual: 'mixed',
        targetUri,
      });
    }

    // Check encoding preservation
    if (baseFidelity.encoding !== proposedFidelity.encoding) {
      violations.push({
        kind: 'encoding',
        severity: 'error',
        message: `Encoding changed from ${baseFidelity.encoding} to ${proposedFidelity.encoding}`,
        expected: baseFidelity.encoding,
        actual: proposedFidelity.encoding,
        targetUri,
      });
    }

    // Check final newline preservation
    if (baseFidelity.hasFinalNewline !== proposedFidelity.hasFinalNewline) {
      violations.push({
        kind: 'final-newline',
        severity: 'warning',
        message: baseFidelity.hasFinalNewline
          ? 'Final newline removed'
          : 'Final newline added',
        expected: String(baseFidelity.hasFinalNewline),
        actual: String(proposedFidelity.hasFinalNewline),
        targetUri,
      });
    }

    // Check indentation style preservation
    if (
      baseFidelity.indentation !== 'none' &&
      proposedFidelity.indentation !== 'none' &&
      baseFidelity.indentation !== 'mixed' &&
      proposedFidelity.indentation !== baseFidelity.indentation
    ) {
      violations.push({
        kind: 'indentation',
        severity: 'warning',
        message: `Indentation style changed from ${baseFidelity.indentation} to ${proposedFidelity.indentation}`,
        expected: baseFidelity.indentation,
        actual: proposedFidelity.indentation,
        targetUri,
      });
    }

    // Check executable permission preservation
    if (options?.checkExecutablePermission !== false && options?.baseMetadata && options?.proposedMetadata) {
      if (options.baseMetadata.executable !== options.proposedMetadata.executable) {
        violations.push({
          kind: 'executable-permission',
          severity: 'error',
          message: options.baseMetadata.executable
            ? 'Executable permission removed'
            : 'Executable permission added',
          expected: String(options.baseMetadata.executable),
          actual: String(options.proposedMetadata.executable),
          targetUri,
        });
      }
    }

    return {
      valid: violations.length === 0,
      violations: Object.freeze(violations),
      baseFidelity,
      proposedFidelity,
    };
  }

  /**
   * Validate metadata preservation (executable permissions) without content analysis.
   * Useful when only metadata changes are being checked.
   */
  validateMetadata(
    targetUri: string,
    baseMetadata: FileMetadata,
    proposedMetadata: FileMetadata
  ): readonly FidelityViolation[] {
    const violations: FidelityViolation[] = [];

    if (baseMetadata.executable !== proposedMetadata.executable) {
      violations.push({
        kind: 'executable-permission',
        severity: 'error',
        message: baseMetadata.executable
          ? 'Executable permission removed'
          : 'Executable permission added',
        expected: String(baseMetadata.executable),
        actual: String(proposedMetadata.executable),
        targetUri,
      });
    }

    return Object.freeze(violations);
  }

  /**
   * Detect if content appears to be binary (contains null bytes or high
   * proportion of non-text characters).
   */
  isBinary(content: string): boolean {
    if (content.length === 0) return false;

    // Check for null bytes (strong indicator of binary)
    if (content.indexOf('\0') !== -1) return true;

    // Check for high proportion of non-printable, non-whitespace characters
    const sampleSize = Math.min(content.length, 8192);
    let nonTextCount = 0;
    for (let i = 0; i < sampleSize; i++) {
      const code = content.charCodeAt(i);
      // Non-printable and not common whitespace (tab, newline, cr)
      if (code < 0x09 || (code > 0x0d && code < 0x20) || code === 0x7f) {
        nonTextCount++;
      }
    }

    // If more than 10% of sampled bytes are non-text, treat as binary
    return nonTextCount / sampleSize > 0.1;
  }

  /**
   * Analyze the fidelity characteristics of content.
   */
  analyze(content: string): FileFidelityInfo {
    return {
      lineEnding: detectLineEnding(content),
      hasFinalNewline: detectFinalNewline(content),
      encoding: detectEncoding(content),
      indentation: detectIndentation(content),
      indentSize: detectIndentSize(content),
    };
  }
}

/**
 * Detect the line ending style of content.
 */
function detectLineEnding(content: string): LineEnding {
  const crlfCount = countOccurrences(content, '\r\n');
  const lfCount = countOccurrences(content, '\n') - crlfCount;
  const crCount = countOccurrences(content, '\r') - crlfCount;

  const total = crlfCount + lfCount + crCount;
  if (total === 0) return 'LF'; // Default for single-line files

  if (crlfCount > 0 && lfCount === 0 && crCount === 0) return 'CRLF';
  if (lfCount > 0 && crlfCount === 0 && crCount === 0) return 'LF';
  if (crCount > 0 && crlfCount === 0 && lfCount === 0) return 'CR';

  return 'mixed';
}

/**
 * Detect whether content ends with a newline.
 */
function detectFinalNewline(content: string): boolean {
  if (content.length === 0) return false;
  const lastChar = content[content.length - 1];
  return lastChar === '\n' || lastChar === '\r';
}

/**
 * Detect encoding based on BOM (Byte Order Mark) analysis.
 * In a real implementation, this would inspect raw bytes.
 * For string content, we check for BOM characters.
 */
function detectEncoding(content: string): EncodingType {
  if (content.length === 0) return 'utf-8';

  // UTF-8 BOM: EF BB BF (as decoded string starts with \uFEFF)
  if (content.charCodeAt(0) === 0xfeff) return 'utf-8-bom';

  // UTF-16 LE BOM: FF FE
  if (content.charCodeAt(0) === 0xfffe) return 'utf-16le';

  // Default to utf-8 for string content
  return 'utf-8';
}

/**
 * Detect the predominant indentation style.
 */
function detectIndentation(content: string): IndentationStyle {
  const lines = content.split(/\r\n|\n|\r/);
  let tabLines = 0;
  let spaceLines = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line[0] === '\t') tabLines++;
    else if (line[0] === ' ' && line.length > 1 && line[1] === ' ') spaceLines++;
  }

  if (tabLines === 0 && spaceLines === 0) return 'none';
  if (tabLines > 0 && spaceLines === 0) return 'tabs';
  if (spaceLines > 0 && tabLines === 0) return 'spaces';
  return 'mixed';
}

/**
 * Detect the most common indent size (2, 4, 8 spaces).
 */
function detectIndentSize(content: string): number {
  const lines = content.split(/\r\n|\n|\r/);
  const indentCounts: Record<number, number> = { 2: 0, 4: 0, 8: 0 };

  for (const line of lines) {
    if (line.length === 0 || line[0] !== ' ') continue;
    let spaces = 0;
    for (let i = 0; i < line.length && line[i] === ' '; i++) {
      spaces++;
    }
    if (spaces % 2 === 0 && spaces > 0) indentCounts[2]++;
    if (spaces % 4 === 0 && spaces > 0) indentCounts[4]++;
    if (spaces % 8 === 0 && spaces > 0) indentCounts[8]++;
  }

  // Prefer most specific match
  if (indentCounts[4] > indentCounts[2] / 2) return 4;
  if (indentCounts[2] > 0) return 2;
  if (indentCounts[8] > 0) return 8;
  return 2; // Default
}

/**
 * Count non-overlapping occurrences of a substring.
 */
function countOccurrences(str: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}
