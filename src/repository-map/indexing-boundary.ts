/**
 * IndexingBoundary — Bounded workspace indexing configuration.
 *
 * The initial Repository_Map SHALL bound work by ignore rules, binary detection,
 * file-size limits, generated-file policies, and configured workspace exclusions.
 *
 * Requirements: 29.2
 */

// ─── Types ───────────────────────────────────────────────────────

export interface IndexingBoundaryConfig {
  /** Glob patterns to ignore (e.g., from .gitignore) */
  ignorePatterns: string[];
  /** Maximum file size in bytes (files exceeding this are skipped) */
  maxFileSizeBytes: number;
  /** Extensions considered binary and skipped */
  binaryExtensions: string[];
  /** Patterns indicating generated files to exclude */
  generatedFilePatterns: string[];
  /** Workspace-level exclusion paths */
  workspaceExclusions: string[];
  /** Maximum number of files to index */
  maxFileCount: number;
}

export interface BoundaryCheckResult {
  allowed: boolean;
  reason?: string;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.onnx', '.pb', '.h5', '.pt', '.safetensors',
  '.sqlite', '.db',
  '.wasm',
];

const DEFAULT_GENERATED_FILE_PATTERNS = [
  'node_modules/**',
  'dist/**',
  'build/**',
  '.next/**',
  'out/**',
  'coverage/**',
  '.cache/**',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const DEFAULT_IGNORE_PATTERNS = [
  '.git/**',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*.swo',
  '*~',
];

export const DEFAULT_INDEXING_BOUNDARY: IndexingBoundaryConfig = {
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  maxFileSizeBytes: 1_048_576, // 1 MB
  binaryExtensions: DEFAULT_BINARY_EXTENSIONS,
  generatedFilePatterns: DEFAULT_GENERATED_FILE_PATTERNS,
  workspaceExclusions: [],
  maxFileCount: 50_000,
};

// ─── Boundary Checker ────────────────────────────────────────────

export class IndexingBoundary {
  private config: IndexingBoundaryConfig;

  constructor(config: Partial<IndexingBoundaryConfig> = {}) {
    this.config = { ...DEFAULT_INDEXING_BOUNDARY, ...config };
  }

  /**
   * Check whether a file URI should be indexed.
   */
  shouldIndex(uri: string, fileSize: number): BoundaryCheckResult {
    // Check file size limit
    if (fileSize > this.config.maxFileSizeBytes) {
      return {
        allowed: false,
        reason: `File exceeds size limit (${fileSize} > ${this.config.maxFileSizeBytes} bytes)`,
      };
    }

    // Check binary extension
    const ext = this.extractExtension(uri);
    if (ext && this.config.binaryExtensions.includes(ext)) {
      return {
        allowed: false,
        reason: `Binary file extension: ${ext}`,
      };
    }

    // Check ignore patterns
    for (const pattern of this.config.ignorePatterns) {
      if (this.matchesGlob(uri, pattern)) {
        return {
          allowed: false,
          reason: `Matches ignore pattern: ${pattern}`,
        };
      }
    }

    // Check generated file patterns
    for (const pattern of this.config.generatedFilePatterns) {
      if (this.matchesGlob(uri, pattern)) {
        return {
          allowed: false,
          reason: `Matches generated file pattern: ${pattern}`,
        };
      }
    }

    // Check workspace exclusions
    for (const exclusion of this.config.workspaceExclusions) {
      if (this.matchesGlob(uri, exclusion)) {
        return {
          allowed: false,
          reason: `Matches workspace exclusion: ${exclusion}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if the file count limit would be exceeded.
   */
  checkFileCountLimit(currentCount: number): BoundaryCheckResult {
    if (currentCount >= this.config.maxFileCount) {
      return {
        allowed: false,
        reason: `Maximum file count reached (${this.config.maxFileCount})`,
      };
    }
    return { allowed: true };
  }

  /**
   * Get current configuration (read-only).
   */
  getConfig(): Readonly<IndexingBoundaryConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(partial: Partial<IndexingBoundaryConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private extractExtension(uri: string): string | null {
    const lastSlash = uri.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri;
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot < 0) return null;
    return fileName.slice(lastDot).toLowerCase();
  }

  private matchesGlob(uri: string, pattern: string): boolean {
    // Normalize pattern and URI
    const normalizedUri = uri.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Convert glob to regex
    const escaped = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<GLOBSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/<<GLOBSTAR>>/g, '.*');

    const regex = new RegExp(`(^|/)${escaped}($|/)`);
    return regex.test(normalizedUri);
  }
}
