/**
 * Dataset Validator — Validates generated datasets against format-specific Zod schemas.
 *
 * Provides Zod schemas for each dataset format's sample structure:
 *   - InstructionSample: { instruction: string, input?: string, output: string }
 *   - ChatSample: { messages: Array<{ role, content }> }
 *   - ContinuedPretrainingSample: { text: string }
 *   - GRPOSample: { prompt, chosen, rejected, reward_chosen?, reward_rejected? }
 *
 * Validates JSONL datasets line-by-line, returning a ValidationResult with:
 *   - valid/invalid counts
 *   - error details per invalid sample
 *   - Rejection of invalid samples before persistence
 *
 * Also ensures provenance metadata is preserved and emits dataset generation events.
 *
 * Requirements: 7.5, 7.6, 7.7
 */

import { z } from 'zod';
import type { DatasetFormat, DatasetProvenance } from './dataset-generator.js';

// ─── Format-Specific Zod Schemas ────────────────────────────────

/**
 * Schema for instruction-tuning format samples.
 * Each sample is a question/answer pair with an optional input field.
 */
export const InstructionSampleSchema = z.object({
  instruction: z.string().min(1, 'instruction must be a non-empty string'),
  input: z.string().optional(),
  output: z.string().min(1, 'output must be a non-empty string'),
});
export type InstructionSampleValidated = z.infer<typeof InstructionSampleSchema>;

/**
 * Schema for chat format samples.
 * Each sample contains an array of messages with role and content.
 */
export const ChatSampleSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1, 'message content must be non-empty'),
      }),
    )
    .min(2, 'chat samples must have at least 2 messages'),
});
export type ChatSampleValidated = z.infer<typeof ChatSampleSchema>;

/**
 * Schema for continued pre-training format samples.
 * Each sample is a single block of raw text.
 */
export const ContinuedPretrainingSampleSchema = z.object({
  text: z.string().min(1, 'text must be a non-empty string'),
});
export type ContinuedPretrainingSampleValidated = z.infer<typeof ContinuedPretrainingSampleSchema>;

/**
 * Schema for GRPO (preference learning) format samples.
 * Each sample has a prompt with chosen/rejected responses and optional reward signals.
 */
export const GRPOSampleSchema = z.object({
  prompt: z.string().min(1, 'prompt must be a non-empty string'),
  chosen: z.string().min(1, 'chosen must be a non-empty string'),
  rejected: z.string().min(1, 'rejected must be a non-empty string'),
  reward_chosen: z.number().optional(),
  reward_rejected: z.number().optional(),
});
export type GRPOSampleValidated = z.infer<typeof GRPOSampleSchema>;

// ─── Schema Registry ────────────────────────────────────────────

/**
 * Maps dataset format identifiers to their corresponding Zod schemas.
 */
export const DATASET_FORMAT_SCHEMAS: Record<DatasetFormat, z.ZodType> = {
  instruction: InstructionSampleSchema as z.ZodType,
  chat: ChatSampleSchema as z.ZodType,
  'continued-pretraining': ContinuedPretrainingSampleSchema as z.ZodType,
  grpo: GRPOSampleSchema as z.ZodType,
};

// ─── Validation Result Types ────────────────────────────────────

/**
 * Details about a single validation error.
 */
export interface ValidationErrorDetail {
  /** Zero-based line/sample index in the dataset */
  sampleIndex: number;
  /** Human-readable error messages from Zod validation */
  errors: string[];
  /** The raw sample data that failed validation (truncated for safety) */
  rawSample?: string;
}

/**
 * Result of validating a dataset against its format schema.
 */
export interface DatasetValidationResult {
  /** Whether the entire dataset passed validation (no invalid samples) */
  valid: boolean;
  /** Total number of samples in the dataset */
  sampleCount: number;
  /** Number of samples that passed validation */
  validCount: number;
  /** Number of samples that failed validation */
  invalidCount: number;
  /** Indices of invalid samples (for filtering before persistence) */
  invalidSamples: number[];
  /** Detailed error information per invalid sample */
  errorDetails: ValidationErrorDetail[];
}

// ─── Dataset Validator Class ────────────────────────────────────

/**
 * DatasetValidator — Validates JSONL datasets against format-specific Zod schemas.
 *
 * Usage:
 *   const validator = new DatasetValidator();
 *   const result = validator.validateSamples(samples, 'instruction');
 *   if (!result.valid) {
 *     // Filter out invalid samples before persisting
 *     const validSamples = samples.filter((_, i) => !result.invalidSamples.includes(i));
 *   }
 */
export class DatasetValidator {
  /**
   * Validate an array of parsed samples against the format-specific schema.
   *
   * @param samples - The parsed sample objects to validate
   * @param format - The dataset format determining which schema to apply
   * @returns DatasetValidationResult with valid/invalid counts and error details
   */
  validateSamples(samples: unknown[], format: DatasetFormat): DatasetValidationResult {
    const schema = DATASET_FORMAT_SCHEMAS[format];
    if (!schema) {
      return {
        valid: false,
        sampleCount: samples.length,
        validCount: 0,
        invalidCount: samples.length,
        invalidSamples: samples.map((_, i) => i),
        errorDetails: [
          {
            sampleIndex: 0,
            errors: [`Unsupported dataset format: ${format}`],
          },
        ],
      };
    }

    const invalidSamples: number[] = [];
    const errorDetails: ValidationErrorDetail[] = [];

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const result = schema.safeParse(sample);

      if (!result.success) {
        invalidSamples.push(i);
        const issues = result.error?.issues ?? [];
        errorDetails.push({
          sampleIndex: i,
          errors: issues.length > 0
            ? issues.map((e) => `${(e.path ?? []).join('.')}: ${e.message}`)
            : ['Schema validation failed'],
          rawSample: truncateSample(sample),
        });
      }
    }

    const validCount = samples.length - invalidSamples.length;

    return {
      valid: invalidSamples.length === 0,
      sampleCount: samples.length,
      validCount,
      invalidCount: invalidSamples.length,
      invalidSamples,
      errorDetails,
    };
  }

  /**
   * Validate a JSONL string (multi-line JSON, one object per line).
   *
   * Parses each line as JSON, then validates against the format schema.
   * Lines that fail JSON parsing are counted as invalid.
   *
   * @param jsonlContent - Raw JSONL content (one JSON object per line)
   * @param format - The dataset format determining which schema to apply
   * @returns DatasetValidationResult with valid/invalid counts and error details
   */
  validateJsonl(jsonlContent: string, format: DatasetFormat): DatasetValidationResult {
    const lines = jsonlContent
      .split('\n')
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return {
        valid: true,
        sampleCount: 0,
        validCount: 0,
        invalidCount: 0,
        invalidSamples: [],
        errorDetails: [],
      };
    }

    const samples: unknown[] = [];
    const parseErrors: ValidationErrorDetail[] = [];
    const parseFailIndices: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]!);
        samples.push(parsed);
      } catch {
        parseFailIndices.push(i);
        parseErrors.push({
          sampleIndex: i,
          errors: ['Invalid JSON: failed to parse line'],
          rawSample: lines[i]!.slice(0, 200),
        });
      }
    }

    // If all lines failed JSON parsing, return early
    if (parseFailIndices.length === lines.length) {
      return {
        valid: false,
        sampleCount: lines.length,
        validCount: 0,
        invalidCount: lines.length,
        invalidSamples: parseFailIndices,
        errorDetails: parseErrors,
      };
    }

    // Validate successfully parsed samples against the schema
    const schemaResult = this.validateSamples(samples, format);

    // Merge JSON parse errors with schema validation errors
    // Adjust schema error indices to account for JSON parse failures
    const allInvalid = [...parseFailIndices];
    const allErrors = [...parseErrors];

    // Map sample indices back to line indices
    let sampleIdx = 0;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (parseFailIndices.includes(lineIdx)) {
        continue; // Already counted as invalid
      }
      if (schemaResult.invalidSamples.includes(sampleIdx)) {
        allInvalid.push(lineIdx);
        const detail = schemaResult.errorDetails.find((d) => d.sampleIndex === sampleIdx);
        if (detail) {
          allErrors.push({ ...detail, sampleIndex: lineIdx });
        }
      }
      sampleIdx++;
    }

    return {
      valid: allInvalid.length === 0,
      sampleCount: lines.length,
      validCount: lines.length - allInvalid.length,
      invalidCount: allInvalid.length,
      invalidSamples: allInvalid.sort((a, b) => a - b),
      errorDetails: allErrors.sort((a, b) => a.sampleIndex - b.sampleIndex),
    };
  }

  /**
   * Filter valid samples from a JSONL string, rejecting invalid ones.
   * Returns only the samples that pass schema validation.
   *
   * @param jsonlContent - Raw JSONL content
   * @param format - Dataset format
   * @returns Array of valid parsed samples
   */
  filterValidSamples<T = unknown>(jsonlContent: string, format: DatasetFormat): T[] {
    const lines = jsonlContent
      .split('\n')
      .filter((line) => line.trim().length > 0);

    const schema = DATASET_FORMAT_SCHEMAS[format];
    if (!schema) return [];

    const validSamples: T[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const result = schema.safeParse(parsed);
        if (result.success) {
          validSamples.push(parsed as T);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return validSamples;
  }

  /**
   * Validate provenance metadata for a dataset.
   * Ensures every sample has a valid provenance record linking to a KB chunk.
   *
   * @param provenance - Array of provenance records from dataset generation
   * @param sampleCount - Total number of samples in the dataset
   * @param validChunkIds - Set of valid chunk IDs from the KB (for existence checking)
   * @returns Whether all provenance records are valid
   */
  validateProvenance(
    provenance: DatasetProvenance[],
    sampleCount: number,
    validChunkIds?: Set<string>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check that every sample index has a provenance record
    const coveredIndices = new Set(provenance.map((p) => p.sampleIndex));
    for (let i = 0; i < sampleCount; i++) {
      if (!coveredIndices.has(i)) {
        errors.push(`Sample at index ${i} is missing provenance metadata`);
      }
    }

    // Validate provenance record structure
    for (const record of provenance) {
      if (!record.sourceChunkId || record.sourceChunkId.length === 0) {
        errors.push(`Provenance at index ${record.sampleIndex} has empty sourceChunkId`);
      }
      if (!record.sourceUri || record.sourceUri.length === 0) {
        errors.push(`Provenance at index ${record.sampleIndex} has empty sourceUri`);
      }
      if (record.sampleIndex < 0 || record.sampleIndex >= sampleCount) {
        errors.push(`Provenance sampleIndex ${record.sampleIndex} is out of bounds [0, ${sampleCount})`);
      }
      // If validChunkIds are provided, check existence
      if (validChunkIds && !validChunkIds.has(record.sourceChunkId)) {
        errors.push(
          `Provenance at index ${record.sampleIndex} references non-existent chunk: ${record.sourceChunkId}`,
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the schema for a specific dataset format.
   * Useful for external validation or inspection.
   */
  getSchemaForFormat(format: DatasetFormat): z.ZodType | undefined {
    return DATASET_FORMAT_SCHEMAS[format];
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Truncate a sample to a reasonable string length for error reporting.
 */
function truncateSample(sample: unknown, maxLength: number = 200): string {
  try {
    const str = JSON.stringify(sample);
    if (str.length > maxLength) {
      return str.slice(0, maxLength) + '...';
    }
    return str;
  } catch {
    return '[unserializable]';
  }
}
