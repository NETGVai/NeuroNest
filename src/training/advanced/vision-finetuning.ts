/**
 * Vision Model Fine-Tuning — Extracts and indexes image data from KB sources,
 * produces image-text pairs for vision model training, and integrates with the
 * Training_Orchestrator for the full job lifecycle (spawn, monitor, checkpoint, export).
 *
 * Image sources include: screenshots, architecture diagrams, UI mockups, and
 * other visual artifacts stored alongside textual KB content.
 *
 * Image-text pairs format: { imagePath, caption, altText, surroundingContext }
 *
 * Requirements: 18.1, 18.2, 18.3
 */

import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { KBChunk } from '../../knowledge/ingest/chunking/types.js';
import type { RawDocument, SourceEntry } from '../../knowledge/connectors/types.js';
import type {
  TrainingJobConfig,
  TrainingProgress,
  TrainingOrchestrator,
} from '../orchestrator/training-orchestrator.js';

// ─── Constants ──────────────────────────────────────────────────

/** Supported image file extensions */
export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'] as const;

/** MIME types recognized as image content */
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/gif',
] as const;

/** Default maximum image file size for indexing (20 MB) */
const DEFAULT_MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/** Default batch size for image-text pair generation */
const DEFAULT_BATCH_SIZE = 50;

/** Vision training event kind */
const VISION_EVENT_KIND = 'training.vision.dataset' as EventKind;

// ─── Types ──────────────────────────────────────────────────────

/**
 * Represents an indexed image from a KB source along with its textual metadata.
 */
export interface IndexedImage {
  /** Unique identifier for this image entry (SHA-256 of path + source). */
  id: string;
  /** Absolute or relative file path to the image. */
  imagePath: string;
  /** Original filename of the image. */
  filename: string;
  /** MIME type of the image (e.g., 'image/png'). */
  mimeType: string;
  /** Size in bytes of the image file. */
  sizeBytes: number;
  /** Source URI identifying where the image was found (KB source). */
  sourceUri: string;
  /** Alt text extracted from surrounding markdown, HTML, or metadata. */
  altText: string;
  /** Caption derived from the image context (filename, heading, or annotation). */
  caption: string;
  /** Text context surrounding the image reference in the source document. */
  surroundingContext: string;
  /** Timestamp when the image was indexed. */
  indexedAt: number;
}

/**
 * An image-text pair formatted for vision model training.
 */
export interface ImageTextPair {
  /** Path to the image file. */
  image_path: string;
  /** Caption describing the image content. */
  caption: string;
  /** Alt text for the image. */
  alt_text: string;
  /** Surrounding document context for additional signal. */
  surrounding_context: string;
}

/**
 * Configuration for vision dataset generation.
 */
export interface VisionDatasetConfig {
  /** KB source chunks to scan for image references. */
  sourceChunks: KBChunk[];
  /** Raw documents from connectors that may contain images. */
  rawDocuments?: RawDocument[];
  /** Base directory where images are stored (for resolving relative paths). */
  imageBaseDir: string;
  /** Output path for the generated dataset file (JSONL). */
  outputPath: string;
  /** Maximum image file size to include (bytes). Default: 20 MB. */
  maxImageSizeBytes?: number;
  /** Maximum number of image-text pairs to generate. */
  maxPairs?: number;
  /** Session ID for EventLog emission. */
  sessionId?: string;
}

/**
 * Result of vision dataset generation.
 */
export interface VisionDatasetResult {
  /** Path where the dataset was written. */
  path: string;
  /** Total image-text pairs generated. */
  pairCount: number;
  /** Total images discovered during scanning. */
  imagesDiscovered: number;
  /** Images skipped due to size or format issues. */
  imagesSkipped: number;
  /** Time taken to generate the dataset in milliseconds. */
  generationDurationMs: number;
  /** Individual image-text pairs (for in-memory use or validation). */
  pairs: ImageTextPair[];
}

/**
 * Configuration for a vision model training job.
 * Extends the base training config with vision-specific parameters.
 */
export interface VisionTrainingConfig {
  /** Unique job identifier. */
  id: string;
  /** Project identifier. */
  projectId: string;
  /** Base vision model to fine-tune (e.g., 'llava-v1.5-7b'). */
  baseModel: string;
  /** Path to the generated image-text dataset. */
  datasetPath: string;
  /** Output directory for the trained model. */
  outputDir: string;
  /** Checkpoint directory for crash recovery. */
  checkpointDir: string;
  /** Path to the vision training script. */
  scriptPath: string;
  /** Hyperparameters for vision fine-tuning. */
  hyperparameters: VisionHyperparameters;
  /** Hardware profile for the training job. */
  hardware: {
    vendor: 'nvidia' | 'apple' | 'amd' | 'none';
    gpuName?: string;
    vramMB?: number;
    unifiedMemoryMB?: number;
    cpuCores: number;
    systemMemoryMB: number;
  };
}

/**
 * Hyperparameters specific to vision model fine-tuning.
 */
export interface VisionHyperparameters {
  /** Learning rate (default: 2e-5 — lower than text-only due to visual encoder). */
  learningRate: number;
  /** Per-device batch size (default: 2 — vision models use more memory). */
  batchSize: number;
  /** Number of training epochs (default: 3). */
  epochs: number;
  /** LoRA rank for parameter-efficient training (default: 16). */
  loraRank?: number;
  /** LoRA alpha scaling factor (default: 32). */
  loraAlpha?: number;
  /** Warmup steps for learning rate schedule (default: 50). */
  warmupSteps?: number;
  /** Image resolution for training (default: 336). */
  imageResolution?: number;
  /** Whether to freeze the visual encoder (default: true for LoRA). */
  freezeVisionEncoder?: boolean;
  /** Gradient accumulation steps (default: 8 for vision). */
  gradientAccumulationSteps?: number;
}

// ─── VisionFineTuner Class ──────────────────────────────────────

/**
 * VisionFineTuner — Manages the vision model fine-tuning pipeline.
 *
 * Workflow:
 *   1. Scan KB sources for image files (screenshots, diagrams)
 *   2. Extract textual metadata (alt text, captions, context) for each image
 *   3. Produce image-text pairs formatted for vision model training
 *   4. Invoke Training_Orchestrator with vision-specific config for job lifecycle
 *
 * The Training_Orchestrator handles: spawn, monitor, checkpoint, export via SafeExec.
 */
export class VisionFineTuner {
  constructor(
    private readonly eventLog: EventLog | null,
    private readonly orchestrator: TrainingOrchestrator | null,
  ) {}

  // ─── Image Extraction & Indexing ──────────────────────────

  /**
   * Scan KB source chunks and raw documents for image references.
   * Extracts textual metadata (alt text, caption, surrounding context) for each image.
   *
   * Scans for:
   *   - Markdown image references: ![alt](path)
   *   - HTML img tags: <img src="..." alt="...">
   *   - Raw image documents from connectors (identified by MIME type)
   *
   * Requirements: 18.1
   */
  extractImages(config: VisionDatasetConfig): IndexedImage[] {
    const maxSize = config.maxImageSizeBytes ?? DEFAULT_MAX_IMAGE_SIZE_BYTES;
    const indexed: IndexedImage[] = [];
    const seen = new Set<string>();

    // 1. Scan KB chunks for image references in markdown/HTML content
    for (const chunk of config.sourceChunks) {
      const imagesFromChunk = this.extractImagesFromText(
        chunk.content,
        chunk.sourceUri,
        config.imageBaseDir,
      );

      for (const img of imagesFromChunk) {
        if (!seen.has(img.id) && img.sizeBytes <= maxSize) {
          seen.add(img.id);
          indexed.push(img);
        }
      }
    }

    // 2. Scan raw documents for image-typed content
    if (config.rawDocuments) {
      for (const doc of config.rawDocuments) {
        if (this.isImageMimeType(doc.mimeType) && doc.byteSize <= maxSize) {
          const img = this.indexRawImageDocument(doc);
          if (!seen.has(img.id)) {
            seen.add(img.id);
            indexed.push(img);
          }
        }
      }
    }

    return indexed;
  }

  /**
   * Extract image references from text content (Markdown and HTML patterns).
   * Returns IndexedImage entries with metadata derived from the surrounding context.
   */
  private extractImagesFromText(
    content: string,
    sourceUri: string,
    imageBaseDir: string,
  ): IndexedImage[] {
    const images: IndexedImage[] = [];

    // Extract Markdown image references: ![alt text](path/to/image.ext)
    const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = mdImageRegex.exec(content)) !== null) {
      const altText = match[1] ?? '';
      const imagePath = match[2] ?? '';

      if (!this.isSupportedImageExtension(imagePath)) continue;

      const resolvedPath = this.resolveImagePath(imagePath, imageBaseDir);
      const surroundingContext = this.extractSurroundingContext(content, match.index);
      const caption = this.deriveCaption(altText, imagePath, surroundingContext);

      images.push({
        id: this.generateImageId(resolvedPath, sourceUri),
        imagePath: resolvedPath,
        filename: basename(imagePath),
        mimeType: this.mimeTypeFromExtension(extname(imagePath)),
        sizeBytes: 0, // Size populated during validation step
        sourceUri,
        altText,
        caption,
        surroundingContext,
        indexedAt: Date.now(),
      });
    }

    // Extract HTML img tags: <img src="..." alt="..." />
    const htmlImgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
    while ((match = htmlImgRegex.exec(content)) !== null) {
      const src = match[1] ?? '';
      if (!this.isSupportedImageExtension(src)) continue;

      // Extract alt attribute if present
      const altMatch = match[0].match(/alt=["']([^"']*)["']/i);
      const altText = altMatch?.[1] ?? '';

      const resolvedPath = this.resolveImagePath(src, imageBaseDir);
      const surroundingContext = this.extractSurroundingContext(content, match.index);
      const caption = this.deriveCaption(altText, src, surroundingContext);

      images.push({
        id: this.generateImageId(resolvedPath, sourceUri),
        imagePath: resolvedPath,
        filename: basename(src),
        mimeType: this.mimeTypeFromExtension(extname(src)),
        sizeBytes: 0,
        sourceUri,
        altText,
        caption,
        surroundingContext,
        indexedAt: Date.now(),
      });
    }

    return images;
  }

  /**
   * Index a raw image document received directly from a connector.
   * Derives metadata from the document's URI and filename.
   */
  private indexRawImageDocument(doc: RawDocument): IndexedImage {
    const filename = basename(doc.sourceUri);
    const caption = this.deriveCaptionFromFilename(filename);

    return {
      id: this.generateImageId(doc.sourceUri, doc.sourceUri),
      imagePath: doc.sourceUri,
      filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.byteSize,
      sourceUri: doc.sourceUri,
      altText: caption,
      caption,
      surroundingContext: '',
      indexedAt: doc.fetchTimestamp,
    };
  }

  // ─── Image-Text Pair Generation ───────────────────────────

  /**
   * Produce image-text pairs formatted for vision model training.
   * Each pair contains: image path, caption, alt text, and surrounding context.
   *
   * Requirements: 18.2
   */
  generateImageTextPairs(
    indexedImages: IndexedImage[],
    maxPairs?: number,
  ): ImageTextPair[] {
    const limit = maxPairs ?? indexedImages.length;
    const pairs: ImageTextPair[] = [];

    for (let i = 0; i < Math.min(indexedImages.length, limit); i++) {
      const img = indexedImages[i]!;

      pairs.push({
        image_path: img.imagePath,
        caption: img.caption || img.altText || img.filename,
        alt_text: img.altText || img.caption || '',
        surrounding_context: img.surroundingContext,
      });
    }

    return pairs;
  }

  /**
   * Generate a complete vision training dataset from KB sources.
   * Scans for images, extracts metadata, produces image-text pairs,
   * and writes the result as a JSONL file.
   *
   * Requirements: 18.1, 18.2
   */
  async generateDataset(config: VisionDatasetConfig): Promise<VisionDatasetResult> {
    const startTime = Date.now();

    // Step 1: Extract and index images from KB sources
    const indexedImages = this.extractImages(config);
    const imagesDiscovered = indexedImages.length;

    // Step 2: Filter out invalid/oversized images
    const maxSize = config.maxImageSizeBytes ?? DEFAULT_MAX_IMAGE_SIZE_BYTES;
    const validImages = indexedImages.filter((img) => img.sizeBytes <= maxSize);
    const imagesSkipped = imagesDiscovered - validImages.length;

    // Step 3: Generate image-text pairs
    const pairs = this.generateImageTextPairs(validImages, config.maxPairs);

    // Step 4: Emit dataset generation event
    await this.emitDatasetEvent(pairs.length, imagesDiscovered, imagesSkipped, config.sessionId);

    const result: VisionDatasetResult = {
      path: config.outputPath,
      pairCount: pairs.length,
      imagesDiscovered,
      imagesSkipped,
      generationDurationMs: Date.now() - startTime,
      pairs,
    };

    return result;
  }

  // ─── Training Job Lifecycle ───────────────────────────────

  /**
   * Start a vision model fine-tuning job using the Training_Orchestrator.
   * Supports the same job lifecycle as text model training:
   * spawn, monitor, checkpoint, export.
   *
   * Requirements: 18.3
   */
  async startTrainingJob(config: VisionTrainingConfig): Promise<string> {
    if (!this.orchestrator) {
      throw new Error(
        'Training orchestrator is required for vision fine-tuning. ' +
        'Ensure NEURONEST_TRAINING_PIPELINE is enabled.',
      );
    }

    // Build a standard TrainingJobConfig with vision-specific settings
    const jobConfig: TrainingJobConfig = {
      id: config.id,
      projectId: config.projectId,
      baseModel: config.baseModel,
      method: 'lora', // Vision fine-tuning uses LoRA by default
      datasetPath: config.datasetPath,
      datasetFormat: 'instruction', // Image-text pairs use instruction format
      hyperparameters: {
        learningRate: config.hyperparameters.learningRate,
        batchSize: config.hyperparameters.batchSize,
        epochs: config.hyperparameters.epochs,
        loraRank: config.hyperparameters.loraRank ?? 16,
        loraAlpha: config.hyperparameters.loraAlpha ?? 32,
        warmupSteps: config.hyperparameters.warmupSteps ?? 50,
        gradientAccumulationSteps: config.hyperparameters.gradientAccumulationSteps ?? 8,
      },
      hardware: config.hardware,
      outputDir: config.outputDir,
      checkpointDir: config.checkpointDir,
      scriptPath: config.scriptPath,
      checkpointIntervalEpochs: 1,
      validationSplit: 0.1,
    };

    // Delegate to Training_Orchestrator for full lifecycle management
    return this.orchestrator.startJob(jobConfig);
  }

  /**
   * Get the status of a vision training job.
   * Delegates to Training_Orchestrator.
   */
  getJobStatus(jobId: string): TrainingProgress | null {
    if (!this.orchestrator) return null;
    return this.orchestrator.getJobStatus(jobId);
  }

  /**
   * Cancel a vision training job.
   * Delegates to Training_Orchestrator (SIGTERM → 30s → SIGKILL).
   */
  async cancelJob(jobId: string): Promise<void> {
    if (!this.orchestrator) {
      throw new Error('Training orchestrator not available');
    }
    await this.orchestrator.cancelJob(jobId);
  }

  /**
   * Pause a vision training job at the next checkpoint.
   * Delegates to Training_Orchestrator.
   */
  async pauseJob(jobId: string): Promise<void> {
    if (!this.orchestrator) {
      throw new Error('Training orchestrator not available');
    }
    await this.orchestrator.pauseJob(jobId);
  }

  /**
   * Resume a paused vision training job from the last checkpoint.
   * Delegates to Training_Orchestrator.
   */
  async resumeJob(jobId: string): Promise<void> {
    if (!this.orchestrator) {
      throw new Error('Training orchestrator not available');
    }
    await this.orchestrator.resumeJob(jobId);
  }

  // ─── Default Hyperparameters ──────────────────────────────

  /**
   * Get default vision fine-tuning hyperparameters.
   * These differ from text-only training due to visual encoder memory requirements.
   */
  getDefaultHyperparameters(): VisionHyperparameters {
    return {
      learningRate: 2e-5,
      batchSize: 2,
      epochs: 3,
      loraRank: 16,
      loraAlpha: 32,
      warmupSteps: 50,
      imageResolution: 336,
      freezeVisionEncoder: true,
      gradientAccumulationSteps: 8,
    };
  }

  // ─── Helper Methods ───────────────────────────────────────

  /**
   * Check whether a file extension is a supported image format.
   */
  private isSupportedImageExtension(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
  }

  /**
   * Check whether a MIME type represents image content.
   */
  private isImageMimeType(mimeType: string): boolean {
    return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
  }

  /**
   * Resolve an image path relative to the base directory.
   * Handles both absolute and relative paths.
   */
  private resolveImagePath(imagePath: string, baseDir: string): string {
    if (imagePath.startsWith('/') || imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return imagePath;
    }
    return join(baseDir, imagePath);
  }

  /**
   * Generate a unique ID for an image based on its path and source.
   */
  private generateImageId(imagePath: string, sourceUri: string): string {
    const hash = createHash('sha256')
      .update(`${imagePath}:${sourceUri}`)
      .digest('hex');
    return hash.slice(0, 16);
  }

  /**
   * Extract surrounding text context from around an image reference.
   * Returns up to ~200 characters before and after the image reference.
   */
  private extractSurroundingContext(content: string, matchIndex: number): string {
    const contextRadius = 200;
    const start = Math.max(0, matchIndex - contextRadius);
    const end = Math.min(content.length, matchIndex + contextRadius);

    let context = content.slice(start, end).trim();

    // Clean up: remove the image reference itself to avoid redundancy
    context = context.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
    context = context.replace(/<img[^>]*>/gi, '').trim();

    // Collapse multiple whitespace/newlines
    context = context.replace(/\s+/g, ' ');

    return context;
  }

  /**
   * Derive a caption from available metadata.
   * Priority: alt text > contextual heading > filename.
   */
  private deriveCaption(
    altText: string,
    imagePath: string,
    surroundingContext: string,
  ): string {
    // Prefer explicit alt text
    if (altText && altText.trim().length > 5) {
      return altText.trim();
    }

    // Try to extract a heading from surrounding context
    const headingMatch = surroundingContext.match(/(?:^|\n)#+\s+(.+)/);
    if (headingMatch) {
      return headingMatch[1]!.trim();
    }

    // Fall back to cleaned filename
    return this.deriveCaptionFromFilename(basename(imagePath));
  }

  /**
   * Derive a caption from an image filename.
   * Converts snake_case/kebab-case filenames to human-readable text.
   */
  private deriveCaptionFromFilename(filename: string): string {
    // Remove extension
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

    // Convert common separators to spaces
    const humanized = nameWithoutExt
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
      .replace(/\s+/g, ' ')
      .trim();

    // Capitalize first letter
    if (humanized.length === 0) return filename;
    return humanized.charAt(0).toUpperCase() + humanized.slice(1);
  }

  /**
   * Map a file extension to a MIME type.
   */
  private mimeTypeFromExtension(ext: string): string {
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.gif': 'image/gif',
    };
    return mimeMap[ext.toLowerCase()] ?? 'application/octet-stream';
  }

  // ─── EventLog Integration ─────────────────────────────────

  /**
   * Emit a vision dataset generation event to the EventLog.
   */
  private async emitDatasetEvent(
    pairCount: number,
    imagesDiscovered: number,
    imagesSkipped: number,
    sessionId?: string,
  ): Promise<void> {
    if (!this.eventLog || !sessionId) return;

    try {
      await this.eventLog.emit({
        sessionId,
        kind: VISION_EVENT_KIND,
        payload: {
          pairCount,
          imagesDiscovered,
          imagesSkipped,
          format: 'vision-image-text',
        },
      });
    } catch {
      // EventLog emission is best-effort
    }
  }
}
