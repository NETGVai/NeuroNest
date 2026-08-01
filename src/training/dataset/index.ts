/**
 * Training Dataset Module — Exports all dataset generation types and classes.
 *
 * Entry point for the dataset generation subsystem:
 *   - DatasetGenerator: Main class for generating training datasets
 *   - DatasetValidator: Validates datasets against format-specific Zod schemas
 *   - Format types: instruction, chat, continued-pretraining, grpo
 *   - Interfaces: DatasetGenerationConfig, GeneratedDataset, DatasetProvenance
 *   - Cost estimation: GenerationCostEstimate
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

export {
  DatasetGenerator,
  DATASET_EVENT_KIND,
} from './dataset-generator.js';

export {
  DatasetValidator,
  InstructionSampleSchema,
  ChatSampleSchema,
  ContinuedPretrainingSampleSchema,
  GRPOSampleSchema,
  DATASET_FORMAT_SCHEMAS,
} from './dataset-validator.js';

export type {
  DatasetFormat,
  ExtractionStrategy,
  DatasetGenerationConfig,
  GeneratedDataset,
  DatasetProvenance,
  GenerationCostEstimate,
  InstructionSample,
  ChatSample,
  ContinuedPretrainingSample,
  GRPOSample,
  GRPOPreferencePair,
  GRPOPreferenceStore,
  LLMClient,
  ValidationResult,
} from './dataset-generator.js';

export type {
  InstructionSampleValidated,
  ChatSampleValidated,
  ContinuedPretrainingSampleValidated,
  GRPOSampleValidated,
  DatasetValidationResult,
  ValidationErrorDetail,
} from './dataset-validator.js';
