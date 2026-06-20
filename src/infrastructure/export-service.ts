/**
 * ExportService — Exports artifacts in multiple formats (ZIP, tarball, deployment bundle).
 *
 * Supports exporting artifact content as ZIP archives, tarballs, or deployment bundles
 * (Dockerfile, vercel.json, netlify.toml). Excludes node_modules and build caches,
 * preserves directory structure, and supports checkpoint version selection.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5
 */

import { createWriteStream, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PackSync } from 'tar';
import type { ArtifactType } from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';

// ─── Export Types ───────────────────────────────────────────────

export interface ExportOptions {
  format: 'zip' | 'tarball' | 'deployment-bundle';
  deployTarget?: 'docker' | 'vercel' | 'netlify';
  checkpointVersion?: number;
  outputPath?: string;
}

// ─── Default Exclusion Patterns ─────────────────────────────────

/**
 * Paths to exclude from exports. These are directory or file name segments
 * that should be skipped during archive creation.
 */
const DEFAULT_EXCLUSIONS: string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.vite',
  'coverage',
  '.nyc_output',
  '__pycache__',
];

// ─── Deployment Bundle Templates ────────────────────────────────

function generateDockerfile(entryPoint: string): string {
  return `FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 3000

CMD ["node", "${entryPoint}"]
`;
}

function generateVercelJson(): string {
  return JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      framework: null,
    },
    null,
    2,
  );
}

function generateNetlifyToml(): string {
  return `[build]
  command = "npm run build"
  publish = "dist"

[dev]
  command = "npm run dev"
  port = 3000

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
`;
}

// ─── ExportService ──────────────────────────────────────────────

export class ExportService {
  private readonly artifactService: ArtifactService;

  constructor(artifactService: ArtifactService) {
    this.artifactService = artifactService;
  }

  /**
   * Export an artifact to the specified format.
   * Returns the file path of the exported archive.
   *
   * - For 'zip' and 'tarball': exports the artifact content preserving directory structure
   * - For 'deployment-bundle': includes deployment config files (Dockerfile, vercel.json, netlify.toml)
   * - Excludes node_modules and build caches from the export
   * - Supports selecting a specific checkpoint version
   */
  async exportArtifact(artifactId: string, options: ExportOptions): Promise<string> {
    // Validate the artifact exists
    const artifact = await this.artifactService.get(artifactId);
    if (!artifact) {
      throw new FeatureError({
        message: `Artifact not found: ${artifactId}`,
        category: 'infrastructure',
        code: 'ARTIFACT_NOT_FOUND',
        details: { artifactId },
      });
    }

    // Validate deployment-bundle requires deployTarget
    if (options.format === 'deployment-bundle' && !options.deployTarget) {
      throw new FeatureError({
        message: 'Deployment bundle format requires a deployTarget (docker, vercel, or netlify)',
        category: 'infrastructure',
        code: 'MISSING_DEPLOY_TARGET',
        details: { format: options.format },
      });
    }

    // Get the artifact content (specific version or latest)
    const content = await this.artifactService.getContent(
      artifactId,
      options.checkpointVersion,
    );

    // Create a temporary directory to stage the export
    const stagingDir = join(
      tmpdir(),
      `neuronest-export-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(stagingDir, { recursive: true });

    try {
      // Write artifact content to staging directory
      this.stageArtifactContent(stagingDir, content, artifact.title);

      // For deployment bundles, add the deployment config files
      if (options.format === 'deployment-bundle' && options.deployTarget) {
        this.addDeploymentConfig(stagingDir, options.deployTarget);
      }

      // Determine output path
      const outputPath = this.resolveOutputPath(
        options.outputPath,
        artifact.title,
        options.format,
        options.deployTarget,
      );

      // Ensure output directory exists
      mkdirSync(dirname(outputPath), { recursive: true });

      // Create the archive
      switch (options.format) {
        case 'zip':
          await this.createZipArchive(stagingDir, outputPath);
          break;
        case 'tarball':
          this.createTarball(stagingDir, outputPath);
          break;
        case 'deployment-bundle':
          await this.createZipArchive(stagingDir, outputPath);
          break;
        default:
          throw new FeatureError({
            message: `Unsupported export format: ${options.format}`,
            category: 'infrastructure',
            code: 'UNSUPPORTED_FORMAT',
            details: { format: options.format },
          });
      }

      return outputPath;
    } finally {
      // Clean up staging directory
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * Get available export formats for a given artifact type.
   *
   * All artifact types support zip and tarball.
   * Only code-bundle and generated-app support deployment-bundle.
   */
  getAvailableFormats(artifactType: ArtifactType): ExportOptions['format'][] {
    const formats: ExportOptions['format'][] = ['zip', 'tarball'];

    if (artifactType === 'code-bundle' || artifactType === 'generated-app') {
      formats.push('deployment-bundle');
    }

    return formats;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Stage artifact content into the staging directory.
   * If content is a JSON string representing a file map (Record<string, string>),
   * write each file preserving directory structure.
   * Otherwise, write as a single file.
   */
  private stageArtifactContent(
    stagingDir: string,
    content: Buffer | string,
    title: string,
  ): void {
    const contentStr = Buffer.isBuffer(content)
      ? content.toString('utf-8')
      : content;

    // Attempt to parse as a file map (JSON object with relative paths as keys)
    const fileMap = this.tryParseFileMap(contentStr);

    if (fileMap) {
      // Write each file in the map, respecting directory structure
      for (const [filePath, fileContent] of Object.entries(fileMap)) {
        // Skip excluded paths
        if (this.isExcluded(filePath)) continue;

        const targetPath = join(stagingDir, filePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, fileContent, 'utf-8');
      }
    } else {
      // Write as a single file
      const ext = this.inferExtension(contentStr);
      const fileName = `${this.sanitizeFileName(title)}${ext}`;
      writeFileSync(join(stagingDir, fileName), contentStr, 'utf-8');
    }
  }

  /**
   * Add deployment configuration files to the staging directory based on target.
   */
  private addDeploymentConfig(stagingDir: string, target: 'docker' | 'vercel' | 'netlify'): void {
    switch (target) {
      case 'docker': {
        // Try to determine entry point from package.json if it exists
        const entryPoint = this.detectEntryPoint(stagingDir);
        writeFileSync(
          join(stagingDir, 'Dockerfile'),
          generateDockerfile(entryPoint),
          'utf-8',
        );
        break;
      }
      case 'vercel':
        writeFileSync(
          join(stagingDir, 'vercel.json'),
          generateVercelJson(),
          'utf-8',
        );
        break;
      case 'netlify':
        writeFileSync(
          join(stagingDir, 'netlify.toml'),
          generateNetlifyToml(),
          'utf-8',
        );
        break;
    }
  }

  /**
   * Create a ZIP archive from the staging directory.
   * Uses the archiver library (available as transitive dependency).
   */
  private async createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
    // Dynamic import of archiver (available transitively in node_modules)
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const archiver: any = require('archiver');

    return new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath);
      const archive = typeof archiver.default === 'function'
        ? archiver.default('zip', { zlib: { level: 9 } })
        : archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      archive.on('error', (err: Error) => reject(err));

      archive.pipe(output);

      // Walk the directory and add files, excluding excluded paths
      const files = this.walkDirectory(sourceDir);
      for (const filePath of files) {
        const relativePath = relative(sourceDir, filePath);
        if (!this.isExcluded(relativePath)) {
          archive.file(filePath, { name: relativePath });
        }
      }

      archive.finalize();
    });
  }

  /**
   * Create a gzipped tarball from the staging directory using the tar package.
   */
  private createTarball(sourceDir: string, outputPath: string): void {
    // Collect all files to add (excluding excluded paths)
    const allFiles = this.walkDirectory(sourceDir);
    const filesToAdd = allFiles
      .map((f) => relative(sourceDir, f))
      .filter((rel) => !this.isExcluded(rel));

    const chunks: Buffer[] = [];
    const pack = new PackSync({ gzip: true, cwd: sourceDir });
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));

    for (const file of filesToAdd) {
      pack.add(file);
    }
    pack.end();

    const archiveBuffer = Buffer.concat(chunks);
    writeFileSync(outputPath, archiveBuffer);
  }

  /**
   * Resolve the output file path. If no outputPath specified, uses a
   * default in the OS temp directory.
   */
  private resolveOutputPath(
    outputPath: string | undefined,
    title: string,
    format: ExportOptions['format'],
    deployTarget?: string,
  ): string {
    if (outputPath) return outputPath;

    const safeName = this.sanitizeFileName(title);
    const ext = format === 'tarball' ? '.tar.gz' : '.zip';
    const suffix = deployTarget ? `-${deployTarget}` : '';
    return join(tmpdir(), `${safeName}${suffix}${ext}`);
  }

  /**
   * Check if a file path matches any exclusion pattern.
   */
  isExcluded(filePath: string): boolean {
    const segments = filePath.split(/[/\\]/);
    return segments.some((segment) => DEFAULT_EXCLUSIONS.includes(segment));
  }

  /**
   * Recursively walk a directory and collect all file paths.
   */
  private walkDirectory(dir: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip excluded directories
      if (entry.isDirectory() && DEFAULT_EXCLUSIONS.includes(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        results.push(...this.walkDirectory(fullPath));
      } else {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Attempt to parse content as a JSON file map (Record<string, string>).
   * Returns null if content is not a valid file map.
   */
  private tryParseFileMap(content: string): Record<string, string> | null {
    try {
      const parsed = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        // Verify all values are strings (file contents)
        const entries = Object.entries(parsed);
        if (entries.length === 0) return null;
        const allStrings = entries.every(
          ([key, val]) => typeof key === 'string' && typeof val === 'string',
        );
        if (allStrings) return parsed as Record<string, string>;
      }
    } catch {
      // Not valid JSON, treat as raw content
    }
    return null;
  }

  /**
   * Infer a reasonable file extension from content.
   */
  private inferExtension(content: string): string {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return '.html';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return '.json';
    if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) return '.md';
    return '.txt';
  }

  /**
   * Sanitize a string for use as a file name.
   */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_\-. ]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 64) || 'export';
  }

  /**
   * Detect the entry point from a package.json in the staging directory.
   * Defaults to 'index.js' if not determinable.
   */
  private detectEntryPoint(stagingDir: string): string {
    try {
      const pkgPath = join(stagingDir, 'package.json');
      const pkgContent = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      if (pkg.main) return pkg.main;
      if (pkg.scripts?.start) {
        // Try to extract the file from "node server.js" or similar
        const match = pkg.scripts.start.match(/node\s+(\S+)/);
        if (match) return match[1];
      }
    } catch {
      // package.json not found or unparseable
    }
    return 'index.js';
  }
}
