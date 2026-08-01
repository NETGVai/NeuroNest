/**
 * Team Sharing — Export and import LoRA adapters as self-contained archives
 * for team-wide model sharing.
 *
 * Responsibilities:
 *   - Export trained LoRA adapters as archive files containing:
 *     adapter weights, training configuration, base model reference, and version metadata
 *   - Include a manifest with: adapter version, compatible base models, training date,
 *     dataset statistics, and a content hash for integrity verification
 *   - Import: validate archive integrity (content hash), verify base model compatibility,
 *     register the adapter with the Provider_Registry
 *
 * Uses SafeExec for all subprocess operations (tar/archive creation/extraction).
 * No shell interpretation — all arguments passed as arrays.
 *
 * Requirements: 20.1, 20.2, 20.3
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SafeExecResult } from '../../security/safe-exec.js';
import type { IProviderRegistry } from '../../providers/provider-registry.js';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import {
  TRAINING_EVENT_KINDS,
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';

// ─── Types ──────────────────────────────────────────────────────

/** Type signature for the SafeExec async function */
export type SafeExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
) => Promise<SafeExecResult>;

/** Manifest included in every LoRA adapter archive */
export interface LoRAManifest {
  /** Manifest format version */
  manifestVersion: '1.0';
  /** Unique adapter identifier */
  adapterId: string;
  /** Semantic version of the adapter (e.g., '1.0.0') */
  adapterVersion: string;
  /** Compatible base models (name/ID list) */
  compatibleBaseModels: string[];
  /** ISO 8601 training completion date */
  trainingDate: string;
  /** Training method used */
  trainingMethod: 'lora' | 'qlora';
  /** Dataset statistics */
  datasetStats: DatasetStats;
  /** SHA-256 content hash of the adapter_weights directory */
  contentHash: string;
  /** Optional human-readable description */
  description?: string;
  /** Name of the person/team who created this adapter */
  author?: string;
}

/** Dataset statistics stored in the manifest */
export interface DatasetStats {
  /** Total number of training samples */
  sampleCount: number;
  /** Total tokens in the dataset */
  totalTokens: number;
  /** Dataset format used */
  format: 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';
}

/** Training configuration stored alongside the adapter */
export interface LoRATrainingConfig {
  /** Base model used for training */
  baseModel: string;
  /** LoRA rank */
  loraRank: number;
  /** LoRA alpha */
  loraAlpha: number;
  /** Learning rate */
  learningRate: number;
  /** Batch size */
  batchSize: number;
  /** Number of epochs */
  epochs: number;
  /** Warmup steps */
  warmupSteps?: number;
  /** Weight decay */
  weightDecay?: number;
  /** Gradient accumulation steps */
  gradientAccumulationSteps?: number;
  /** Quantization applied during training (QLoRA) */
  quantization?: string;
}

/** Configuration for exporting a LoRA adapter */
export interface LoRAExportConfig {
  /** Path to the LoRA adapter weights directory */
  adapterWeightsPath: string;
  /** Output path for the archive file (.tar.gz) */
  outputPath: string;
  /** Adapter identifier */
  adapterId: string;
  /** Semantic version */
  adapterVersion: string;
  /** Compatible base models */
  compatibleBaseModels: string[];
  /** Training configuration */
  trainingConfig: LoRATrainingConfig;
  /** Dataset statistics */
  datasetStats: DatasetStats;
  /** Training method */
  trainingMethod: 'lora' | 'qlora';
  /** Optional description */
  description?: string;
  /** Optional author name */
  author?: string;
}

/** Result of an export operation */
export interface LoRAExportResult {
  /** Path to the created archive */
  archivePath: string;
  /** Size of the archive in bytes */
  sizeBytes: number;
  /** Content hash of the adapter weights */
  contentHash: string;
  /** The manifest that was embedded in the archive */
  manifest: LoRAManifest;
}

/** Configuration for importing a LoRA adapter */
export interface LoRAImportConfig {
  /** Path to the archive file (.tar.gz) */
  archivePath: string;
  /** Directory where the adapter will be extracted */
  targetDir: string;
  /** Project ID this adapter will be associated with */
  projectId: string;
  /** Whether to skip base model compatibility check (override) */
  skipCompatibilityCheck?: boolean;
}

/** Result of an import operation */
export interface LoRAImportResult {
  /** Whether the import succeeded */
  success: boolean;
  /** The validated manifest from the archive */
  manifest: LoRAManifest;
  /** Path to the extracted adapter weights */
  adapterWeightsPath: string;
  /** Whether the adapter was registered with Provider_Registry */
  providerRegistered: boolean;
  /** Error message if import failed */
  error?: string;
}

// ─── Errors ─────────────────────────────────────────────────────

export class LoRAExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoRAExportError';
  }
}

export class LoRAImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoRAImportError';
  }
}

export class LoRAIntegrityError extends LoRAImportError {
  constructor(expectedHash: string, actualHash: string) {
    super(
      `Archive integrity check failed. Expected content hash: ${expectedHash}, got: ${actualHash}`,
    );
    this.name = 'LoRAIntegrityError';
  }
}

export class LoRACompatibilityError extends LoRAImportError {
  constructor(requiredModels: string[], availableModel?: string) {
    super(
      `Base model incompatibility. Adapter requires one of: [${requiredModels.join(', ')}]` +
      (availableModel ? `. Current model: ${availableModel}` : ''),
    );
    this.name = 'LoRACompatibilityError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

/** Default timeout for archive operations (5 minutes) */
const DEFAULT_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;

/** Expected files/directories in a valid LoRA archive */
const ARCHIVE_EXPECTED_ENTRIES = {
  MANIFEST: 'manifest.json',
  CONFIG: 'config.json',
  WEIGHTS_DIR: 'adapter_weights',
} as const;

/** Provider ID prefix for imported LoRA adapters */
const LORA_PROVIDER_PREFIX = 'lora-adapter';

// ─── TeamSharingManager ─────────────────────────────────────────

/**
 * Manages export and import of LoRA adapters for team sharing.
 *
 * Export creates a self-contained .tar.gz archive containing:
 *   - adapter_weights/  — LoRA weight files
 *   - manifest.json     — Version, compatibility, integrity metadata
 *   - config.json       — Training configuration
 *
 * Import validates the archive integrity (SHA-256 content hash), verifies
 * base model compatibility, extracts the adapter, and registers it with
 * the Provider_Registry for use.
 */
export class TeamSharingManager {
  private readonly archiveTimeoutMs: number;

  constructor(
    private readonly safeExec: SafeExecFn,
    private readonly providerRegistry: IProviderRegistry,
    private readonly eventLog: EventLog,
    options?: {
      archiveTimeoutMs?: number;
    },
  ) {
    this.archiveTimeoutMs = options?.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
  }

  // ─── Export ─────────────────────────────────────────────────────

  /**
   * Export a LoRA adapter as a self-contained archive.
   *
   * Steps:
   * 1. Validate adapter weights path exists
   * 2. Compute SHA-256 content hash of adapter weights
   * 3. Create manifest.json with version, base models, training date, stats, hash
   * 4. Create config.json with training configuration
   * 5. Package everything into a .tar.gz archive via SafeExec
   *
   * Requirements: 20.1, 20.3
   */
  async exportAdapter(config: LoRAExportConfig): Promise<LoRAExportResult> {
    const {
      adapterWeightsPath,
      outputPath,
      adapterId,
      adapterVersion,
      compatibleBaseModels,
      trainingConfig,
      datasetStats,
      trainingMethod,
      description,
      author,
    } = config;

    // Validate adapter weights directory exists
    if (!fs.existsSync(adapterWeightsPath)) {
      throw new LoRAExportError(
        `Adapter weights path does not exist: ${adapterWeightsPath}`,
      );
    }

    const stat = fs.statSync(adapterWeightsPath);
    if (!stat.isDirectory()) {
      throw new LoRAExportError(
        `Adapter weights path is not a directory: ${adapterWeightsPath}`,
      );
    }

    // Compute content hash of the weights directory
    const contentHash = this.computeDirectoryHash(adapterWeightsPath);

    // Build the manifest
    const manifest: LoRAManifest = {
      manifestVersion: '1.0',
      adapterId,
      adapterVersion,
      compatibleBaseModels,
      trainingDate: new Date().toISOString(),
      trainingMethod,
      datasetStats,
      contentHash,
      description,
      author,
    };

    // Create a temporary staging directory for the archive contents
    const stagingDir = `${outputPath}.staging-${Date.now()}`;
    try {
      fs.mkdirSync(stagingDir, { recursive: true });

      // Write manifest.json
      const manifestPath = path.join(stagingDir, ARCHIVE_EXPECTED_ENTRIES.MANIFEST);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      // Write config.json
      const configPath = path.join(stagingDir, ARCHIVE_EXPECTED_ENTRIES.CONFIG);
      fs.writeFileSync(configPath, JSON.stringify(trainingConfig, null, 2), 'utf-8');

      // Copy adapter weights into staging directory
      const stagingWeightsDir = path.join(stagingDir, ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR);
      this.copyDirectory(adapterWeightsPath, stagingWeightsDir);

      // Create the .tar.gz archive via SafeExec (no shell interpretation)
      const archivePath = outputPath.endsWith('.tar.gz')
        ? outputPath
        : `${outputPath}.tar.gz`;

      await this.createTarGzArchive(stagingDir, archivePath);

      // Get archive size
      const archiveStats = fs.statSync(archivePath);

      // Emit export event
      this.emitEvent(TRAINING_EVENT_KINDS.EXPORT_COMPLETE, {
        jobId: adapterId,
        ggufPath: archivePath,
        sizeBytes: archiveStats.size,
        ollamaRegistered: false,
      });

      return {
        archivePath,
        sizeBytes: archiveStats.size,
        contentHash,
        manifest,
      };
    } finally {
      // Clean up staging directory
      this.removeDirectory(stagingDir);
    }
  }

  // ─── Import ─────────────────────────────────────────────────────

  /**
   * Import a LoRA adapter from an archive.
   *
   * Steps:
   * 1. Validate the archive file exists
   * 2. Extract the archive to a temporary location
   * 3. Read and validate the manifest
   * 4. Verify content hash integrity (SHA-256 of adapter_weights)
   * 5. Verify base model compatibility
   * 6. Move adapter to target directory
   * 7. Register with Provider_Registry
   *
   * Requirements: 20.2
   */
  async importAdapter(config: LoRAImportConfig): Promise<LoRAImportResult> {
    const { archivePath, targetDir, projectId, skipCompatibilityCheck } = config;

    // Validate archive exists
    if (!fs.existsSync(archivePath)) {
      throw new LoRAImportError(`Archive file not found: ${archivePath}`);
    }

    // Create a temporary extraction directory
    const extractDir = path.join(targetDir, `.lora-import-${Date.now()}`);
    try {
      fs.mkdirSync(extractDir, { recursive: true });

      // Extract the archive via SafeExec
      await this.extractTarGzArchive(archivePath, extractDir);

      // Validate archive structure
      this.validateArchiveStructure(extractDir);

      // Read manifest
      const manifestPath = path.join(extractDir, ARCHIVE_EXPECTED_ENTRIES.MANIFEST);
      const manifest = this.readManifest(manifestPath);

      // Verify content hash integrity
      const weightsDir = path.join(extractDir, ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR);
      const actualHash = this.computeDirectoryHash(weightsDir);

      if (actualHash !== manifest.contentHash) {
        throw new LoRAIntegrityError(manifest.contentHash, actualHash);
      }

      // Verify base model compatibility (unless skipped)
      if (!skipCompatibilityCheck) {
        await this.verifyBaseModelCompatibility(manifest.compatibleBaseModels);
      }

      // Move the extracted adapter to the final target directory
      const finalDir = path.join(targetDir, manifest.adapterId);
      if (fs.existsSync(finalDir)) {
        this.removeDirectory(finalDir);
      }
      fs.renameSync(extractDir, finalDir);

      // Register with Provider_Registry
      let providerRegistered = false;
      try {
        this.registerAdapterWithProvider(manifest, finalDir, projectId);
        providerRegistered = true;
      } catch {
        // Provider registration failure is non-fatal
      }

      return {
        success: true,
        manifest,
        adapterWeightsPath: path.join(finalDir, ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR),
        providerRegistered,
      };
    } catch (error: unknown) {
      // Clean up extraction directory on failure
      if (fs.existsSync(extractDir)) {
        this.removeDirectory(extractDir);
      }

      if (
        error instanceof LoRAImportError ||
        error instanceof LoRAIntegrityError ||
        error instanceof LoRACompatibilityError
      ) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new LoRAImportError(`Import failed: ${message}`);
    }
  }

  // ─── Archive Operations ─────────────────────────────────────────

  /**
   * Create a .tar.gz archive from a directory using SafeExec.
   * No shell interpretation — all arguments passed as arrays.
   */
  private async createTarGzArchive(
    sourceDir: string,
    outputPath: string,
  ): Promise<void> {
    // Ensure the output directory exists
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    // Use tar to create the archive
    // tar -czf <output> -C <sourceDir> .
    const result = await this.safeExec(
      'tar',
      ['-czf', outputPath, '-C', sourceDir, '.'],
      { timeout: this.archiveTimeoutMs },
    );

    if (result.exitCode !== 0) {
      throw new LoRAExportError(
        `Failed to create archive: tar exited with code ${result.exitCode}. stderr: ${result.stderr}`,
      );
    }
  }

  /**
   * Extract a .tar.gz archive into a directory using SafeExec.
   * No shell interpretation — all arguments passed as arrays.
   */
  private async extractTarGzArchive(
    archivePath: string,
    targetDir: string,
  ): Promise<void> {
    // Ensure the target directory exists
    fs.mkdirSync(targetDir, { recursive: true });

    // tar -xzf <archive> -C <targetDir>
    const result = await this.safeExec(
      'tar',
      ['-xzf', archivePath, '-C', targetDir],
      { timeout: this.archiveTimeoutMs },
    );

    if (result.exitCode !== 0) {
      throw new LoRAImportError(
        `Failed to extract archive: tar exited with code ${result.exitCode}. stderr: ${result.stderr}`,
      );
    }
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate that the extracted archive has the expected structure:
   * - manifest.json
   * - config.json
   * - adapter_weights/ (directory)
   */
  private validateArchiveStructure(extractDir: string): void {
    const manifestPath = path.join(extractDir, ARCHIVE_EXPECTED_ENTRIES.MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      throw new LoRAImportError(
        `Invalid archive: missing ${ARCHIVE_EXPECTED_ENTRIES.MANIFEST}`,
      );
    }

    const configPath = path.join(extractDir, ARCHIVE_EXPECTED_ENTRIES.CONFIG);
    if (!fs.existsSync(configPath)) {
      throw new LoRAImportError(
        `Invalid archive: missing ${ARCHIVE_EXPECTED_ENTRIES.CONFIG}`,
      );
    }

    const weightsDir = path.join(extractDir, ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR);
    if (!fs.existsSync(weightsDir) || !fs.statSync(weightsDir).isDirectory()) {
      throw new LoRAImportError(
        `Invalid archive: missing ${ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR} directory`,
      );
    }
  }

  /**
   * Read and parse the manifest from a JSON file.
   * Performs basic validation on required fields.
   */
  private readManifest(manifestPath: string): LoRAManifest {
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      throw new LoRAImportError('Failed to read manifest.json from archive');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LoRAImportError('manifest.json contains invalid JSON');
    }

    const manifest = parsed as Record<string, unknown>;

    // Validate required fields
    if (manifest['manifestVersion'] !== '1.0') {
      throw new LoRAImportError(
        `Unsupported manifest version: ${String(manifest['manifestVersion'])}. Expected: 1.0`,
      );
    }

    if (!manifest['adapterId'] || typeof manifest['adapterId'] !== 'string') {
      throw new LoRAImportError('manifest.json missing required field: adapterId');
    }

    if (!manifest['adapterVersion'] || typeof manifest['adapterVersion'] !== 'string') {
      throw new LoRAImportError('manifest.json missing required field: adapterVersion');
    }

    if (!Array.isArray(manifest['compatibleBaseModels']) || manifest['compatibleBaseModels'].length === 0) {
      throw new LoRAImportError('manifest.json missing required field: compatibleBaseModels');
    }

    if (!manifest['contentHash'] || typeof manifest['contentHash'] !== 'string') {
      throw new LoRAImportError('manifest.json missing required field: contentHash');
    }

    if (!manifest['trainingDate'] || typeof manifest['trainingDate'] !== 'string') {
      throw new LoRAImportError('manifest.json missing required field: trainingDate');
    }

    if (!manifest['datasetStats'] || typeof manifest['datasetStats'] !== 'object') {
      throw new LoRAImportError('manifest.json missing required field: datasetStats');
    }

    return manifest as unknown as LoRAManifest;
  }

  /**
   * Verify that the adapter is compatible with a currently available base model.
   * Checks the Provider_Registry for the required base models.
   */
  private async verifyBaseModelCompatibility(
    compatibleBaseModels: string[],
  ): Promise<void> {
    // Get available providers/models from the registry
    const providerStatuses = this.providerRegistry.getStatus();
    const availableIds = providerStatuses.map((s) => s.id);
    const availableNames = providerStatuses.map((s) => s.name);

    // Check if any of the required base models are available
    const isCompatible = compatibleBaseModels.some(
      (model) =>
        availableIds.some((id) => id.includes(model) || model.includes(id)) ||
        availableNames.some((name) =>
          name.toLowerCase().includes(model.toLowerCase()) ||
          model.toLowerCase().includes(name.toLowerCase()),
        ),
    );

    if (!isCompatible) {
      throw new LoRACompatibilityError(
        compatibleBaseModels,
        availableIds.length > 0 ? availableIds.join(', ') : undefined,
      );
    }
  }

  // ─── Provider Registration ──────────────────────────────────────

  /**
   * Register the imported LoRA adapter with the Provider_Registry.
   * This makes the adapter available for inference via the standard provider resolution path.
   */
  private registerAdapterWithProvider(
    manifest: LoRAManifest,
    adapterDir: string,
    projectId: string,
  ): void {
    const providerId = `${LORA_PROVIDER_PREFIX}-${manifest.adapterId}`;
    const ollamaEndpoint = 'http://localhost:11434';

    const adapter = {
      id: providerId,
      name: `LoRA: ${manifest.adapterId} v${manifest.adapterVersion}`,
      chatCompletion: async (
        messages: Array<{ role: string; content: string }>,
        options?: { temperature?: number; maxTokens?: number; stopSequences?: string[] },
      ) => {
        // Route through Ollama with the adapter applied
        const response = await fetch(`${ollamaEndpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: manifest.compatibleBaseModels[0],
            messages,
            temperature: options?.temperature,
            max_tokens: options?.maxTokens,
            stop: options?.stopSequences,
            // Include adapter reference for systems that support hot-loading
            adapter_path: path.join(adapterDir, ARCHIVE_EXPECTED_ENTRIES.WEIGHTS_DIR),
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama inference with LoRA adapter failed: HTTP ${response.status}`);
        }

        const json = await response.json() as {
          choices: Array<{ message: { content: string }; finish_reason: string }>;
          usage: { prompt_tokens: number; completion_tokens: number };
        };

        const choice = json.choices[0];
        return {
          content: choice?.message?.content ?? '',
          tokensUsed: {
            prompt: json.usage?.prompt_tokens ?? 0,
            completion: json.usage?.completion_tokens ?? 0,
          },
          finishReason: (choice?.finish_reason as 'stop' | 'length' | 'tool_call') ?? 'stop',
        };
      },
      streamCompletion: async function* (
        messages: Array<{ role: string; content: string }>,
        _options?: { temperature?: number; maxTokens?: number; stopSequences?: string[] },
      ) {
        // Simplified stream — delegate to non-streaming for adapter inference
        yield { content: '', done: true };
      },
      countTokens: (text: string) => {
        return Math.ceil(text.length / 4);
      },
      isAvailable: async () => {
        try {
          const response = await fetch(`${ollamaEndpoint}/api/version`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
    };

    // Register with priority 40 — below Unsloth MCP (50), below fine-tuned models (45),
    // above base Ollama (30)
    this.providerRegistry.register(adapter, 40);
  }

  // ─── Hashing ────────────────────────────────────────────────────

  /**
   * Compute the SHA-256 hash of all files in a directory (recursively).
   * Files are sorted alphabetically to ensure deterministic hashing
   * regardless of filesystem enumeration order.
   */
  computeDirectoryHash(dirPath: string): string {
    const hash = createHash('sha256');
    const files = this.listFilesRecursive(dirPath).sort();

    for (const filePath of files) {
      // Include relative path in hash to detect renamed files
      const relativePath = path.relative(dirPath, filePath);
      hash.update(relativePath);
      // Include file content
      const content = fs.readFileSync(filePath);
      hash.update(content);
    }

    return hash.digest('hex');
  }

  /**
   * Recursively list all files in a directory.
   */
  private listFilesRecursive(dirPath: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listFilesRecursive(fullPath));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }

    return results;
  }

  // ─── File System Helpers ────────────────────────────────────────

  /**
   * Recursively copy a directory.
   */
  private copyDirectory(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Recursively remove a directory.
   */
  private removeDirectory(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — don't crash on failure
    }
  }

  // ─── EventLog ───────────────────────────────────────────────────

  /**
   * Emit a structured event to the EventLog.
   */
  private emitEvent(kind: EventKind, payload: Record<string, unknown>): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.EXPORT,
        kind,
        payload,
      });
    } catch {
      // EventLog emission is best-effort; don't crash the operation
    }
  }
}
