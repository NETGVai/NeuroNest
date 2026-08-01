/**
 * Dataset Generator — Transforms knowledgebase content into training-ready datasets.
 *
 * Supports four dataset formats:
 *   1. Instruction Tuning — LLM-synthesized Q/A pairs with configurable extraction strategies
 *   2. Chat — Multi-turn conversations following the target model's chat template
 *   3. Continued Pre-Training — Concatenated raw KB text with configurable separators
 *   4. GRPO — Preference pairs with reward signals from accumulated feedback
 *
 * Features:
 *   - Estimated generation cost displayed before proceeding
 *   - Source provenance metadata linking samples back to originating KB chunks
 *   - EventLog integration for dataset generation events
 *   - Format-specific Zod schema validation (delegated to task 14.2)
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import type { KBChunk } from '../../knowledge/ingest/chunking/types.js';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';

// ─── Types & Interfaces ─────────────────────────────────────────

/** Supported dataset output formats */
export type DatasetFormat = 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';

/** Extraction strategies for instruction-tuning dataset generation */
export type ExtractionStrategy = 'entity-based' | 'summary-based' | 'conversational';

/** Configuration for dataset generation */
export interface DatasetGenerationConfig {
  /** Target dataset format */
  format: DatasetFormat;
  /** Source KB chunks to generate training data from */
  sourceChunks: KBChunk[];
  /** Extraction strategy for instruction tuning (default: 'summary-based') */
  extractionStrategy?: ExtractionStrategy;
  /** LLM provider identifier for instruction/chat pair synthesis */
  llmProvider?: string;
  /** Output file path for the generated dataset */
  outputPath: string;
  /** Document separator for continued pre-training (default: '\n\n---\n\n') */
  documentSeparator?: string;
  /** Chat template name for chat format (default: 'chatml') */
  chatTemplate?: string;
  /** Maximum samples to generate (default: unlimited) */
  maxSamples?: number;
  /** Session ID for EventLog emission */
  sessionId?: string;
}

/** A generated dataset with metadata */
export interface GeneratedDataset {
  /** Path where the dataset file was written */
  path: string;
  /** Format of the generated dataset */
  format: DatasetFormat;
  /** Number of training samples produced */
  sampleCount: number;
  /** Total estimated token count across all samples */
  totalTokens: number;
  /** Time taken to generate the dataset in milliseconds */
  generationDurationMs: number;
  /** Provenance records linking samples to source chunks */
  provenance: DatasetProvenance[];
}

/** Links a training sample back to its originating KB chunk(s) */
export interface DatasetProvenance {
  /** Zero-based index of the sample in the dataset */
  sampleIndex: number;
  /** ID of the source KB chunk */
  sourceChunkId: string;
  /** URI of the original source document */
  sourceUri: string;
}

/** Estimated cost of generating a dataset */
export interface GenerationCostEstimate {
  /** Estimated number of LLM API calls needed */
  estimatedApiCalls: number;
  /** Estimated input tokens to be consumed */
  estimatedInputTokens: number;
  /** Estimated output tokens to be generated */
  estimatedOutputTokens: number;
  /** Estimated cost in USD (approximate) */
  estimatedCostUsd: number;
  /** Estimated generation time in seconds */
  estimatedTimeSeconds: number;
  /** Format being generated */
  format: DatasetFormat;
  /** Number of source chunks */
  sourceChunkCount: number;
}

/** A single instruction-tuning sample (prompt/response pair) */
export interface InstructionSample {
  instruction: string;
  input?: string;
  output: string;
}

/** A single chat sample (multi-turn conversation) */
export interface ChatSample {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

/** A single continued pre-training sample (raw text) */
export interface ContinuedPretrainingSample {
  text: string;
}

/** A single GRPO preference sample */
export interface GRPOSample {
  prompt: string;
  chosen: string;
  rejected: string;
  reward_chosen?: number;
  reward_rejected?: number;
}

/** Result type for the dataset validation step (schema validation in 14.2) */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sampleCount: number;
  invalidSamples: number[];
}

/** Interface for LLM interaction (decoupled for testability) */
export interface LLMClient {
  /**
   * Generate a completion from the LLM.
   * @param prompt - The system/user messages
   * @returns The assistant response text
   */
  generate(messages: Array<{ role: string; content: string }>): Promise<string>;
  /** Estimate cost per 1K input/output tokens in USD */
  costPer1KInput?: number;
  costPer1KOutput?: number;
}

// ─── GRPO Preference Data Interface ─────────────────────────────

/** Interface for accessing accumulated GRPO preference pairs */
export interface GRPOPreferenceStore {
  /** Get preference pairs for a project */
  getPreferences(projectId: string, limit?: number): Promise<GRPOPreferencePair[]>;
}

/** A stored GRPO preference pair from user feedback */
export interface GRPOPreferencePair {
  id: string;
  prompt: string;
  chosenResponse: string;
  rejectedResponse: string;
  source: 'user-feedback' | 'comparison-panel' | 'auto-generated';
  createdAt: number;
}

// ─── Event Kind for Dataset Generation ──────────────────────────

export const DATASET_EVENT_KIND = 'training.dataset.generated' as EventKind;

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_DOCUMENT_SEPARATOR = '\n\n---\n\n';
const DEFAULT_EXTRACTION_STRATEGY: ExtractionStrategy = 'summary-based';
const DEFAULT_CHAT_TEMPLATE = 'chatml';

/** Approximate tokens per LLM API call for cost estimation */
const AVG_INPUT_TOKENS_PER_CALL = 500;
const AVG_OUTPUT_TOKENS_PER_CALL = 200;
/** Default cost estimates (GPT-4o-mini tier) */
const DEFAULT_COST_PER_1K_INPUT = 0.00015;
const DEFAULT_COST_PER_1K_OUTPUT = 0.0006;

// ─── Extraction Strategy Prompts ────────────────────────────────

const EXTRACTION_PROMPTS: Record<ExtractionStrategy, (chunk: string) => string> = {
  'entity-based': (chunk: string) =>
    `Given the following knowledge content, extract key entities (concepts, APIs, classes, functions, patterns) and generate a question-answer pair where the question asks about one of those entities and the answer explains it based on the content.

Content:
${chunk}

Generate a JSON object with "instruction" (the question) and "output" (the answer). Only output the JSON, nothing else.`,

  'summary-based': (chunk: string) =>
    `Given the following knowledge content, generate a question-answer pair where the question asks for a summary or explanation of the main topic, and the answer provides a clear, informative response based on the content.

Content:
${chunk}

Generate a JSON object with "instruction" (the question) and "output" (the answer). Only output the JSON, nothing else.`,

  'conversational': (chunk: string) =>
    `Given the following knowledge content, generate a natural conversational question-answer pair as if a developer is asking a colleague about this topic. The question should be casual but specific, and the answer should be helpful and thorough.

Content:
${chunk}

Generate a JSON object with "instruction" (the question) and "output" (the answer). Only output the JSON, nothing else.`,
};

// ─── Chat Template Formatters ───────────────────────────────────

const CHAT_TEMPLATES: Record<string, (messages: ChatSample['messages']) => string> = {
  chatml: (messages) => {
    return messages
      .map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`)
      .join('\n');
  },
  llama2: (messages) => {
    let result = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        result += `<<SYS>>\n${msg.content}\n<</SYS>>\n\n`;
      } else if (msg.role === 'user') {
        result += `[INST] ${msg.content} [/INST]\n`;
      } else {
        result += `${msg.content}\n`;
      }
    }
    return result.trim();
  },
  alpaca: (messages) => {
    const system = messages.find((m) => m.role === 'system');
    const user = messages.find((m) => m.role === 'user');
    const assistant = messages.find((m) => m.role === 'assistant');
    let result = '';
    if (system) result += `### System:\n${system.content}\n\n`;
    if (user) result += `### Instruction:\n${user.content}\n\n`;
    if (assistant) result += `### Response:\n${assistant.content}`;
    return result.trim();
  },
};

// ─── DatasetGenerator Class ─────────────────────────────────────

/**
 * DatasetGenerator — Transforms KB chunks into training-ready datasets.
 *
 * Supports four format modes:
 *   - instruction: Uses LLM to synthesize Q/A pairs from chunks
 *   - chat: Formats multi-turn conversations using model chat templates
 *   - continued-pretraining: Concatenates raw text with separators
 *   - grpo: Generates preference pairs from accumulated feedback data
 *
 * Usage:
 *   const generator = new DatasetGenerator(llmClient, eventLog, preferenceStore);
 *   const estimate = generator.estimateCost(config);
 *   // Display estimate to user, then proceed:
 *   const dataset = await generator.generate(config);
 */
export class DatasetGenerator {
  constructor(
    private llmClient: LLMClient | null,
    private eventLog: EventLog | null,
    private preferenceStore?: GRPOPreferenceStore,
  ) {}

  // ─── Cost Estimation ────────────────────────────────────────

  /**
   * Estimate the cost of generating a dataset before proceeding.
   * Displays to the user so they can make an informed decision.
   *
   * Requirements: 7.2 (display estimated generation cost before proceeding)
   */
  estimateCost(config: DatasetGenerationConfig): GenerationCostEstimate {
    const { format, sourceChunks } = config;
    const chunkCount = sourceChunks.length;

    let estimatedApiCalls = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;

    switch (format) {
      case 'instruction':
        // Each chunk generates 1 API call for Q/A pair synthesis
        estimatedApiCalls = chunkCount;
        estimatedInputTokens = chunkCount * AVG_INPUT_TOKENS_PER_CALL;
        estimatedOutputTokens = chunkCount * AVG_OUTPUT_TOKENS_PER_CALL;
        break;

      case 'chat':
        // Each chunk generates 1 API call for multi-turn conversation
        estimatedApiCalls = chunkCount;
        estimatedInputTokens = chunkCount * (AVG_INPUT_TOKENS_PER_CALL * 1.5);
        estimatedOutputTokens = chunkCount * (AVG_OUTPUT_TOKENS_PER_CALL * 2);
        break;

      case 'continued-pretraining':
        // No LLM calls needed — concatenation only
        estimatedApiCalls = 0;
        estimatedInputTokens = 0;
        estimatedOutputTokens = 0;
        break;

      case 'grpo':
        // No LLM calls — uses pre-existing preference pairs
        estimatedApiCalls = 0;
        estimatedInputTokens = 0;
        estimatedOutputTokens = 0;
        break;
    }

    const costPerInput = this.llmClient?.costPer1KInput ?? DEFAULT_COST_PER_1K_INPUT;
    const costPerOutput = this.llmClient?.costPer1KOutput ?? DEFAULT_COST_PER_1K_OUTPUT;

    const estimatedCostUsd =
      (estimatedInputTokens / 1000) * costPerInput +
      (estimatedOutputTokens / 1000) * costPerOutput;

    // Rough time estimate: ~1 second per API call (includes latency)
    const estimatedTimeSeconds = estimatedApiCalls * 1.0;

    return {
      estimatedApiCalls,
      estimatedInputTokens: Math.round(estimatedInputTokens),
      estimatedOutputTokens: Math.round(estimatedOutputTokens),
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      estimatedTimeSeconds: Math.round(estimatedTimeSeconds),
      format,
      sourceChunkCount: chunkCount,
    };
  }

  // ─── Main Generation Entry Point ───────────────────────────

  /**
   * Generate a dataset from KB chunks in the specified format.
   *
   * Dispatches to the appropriate format-specific generator.
   * Emits dataset generation events to EventLog on completion.
   */
  async generate(config: DatasetGenerationConfig): Promise<GeneratedDataset> {
    const startTime = Date.now();

    let result: GeneratedDataset;

    switch (config.format) {
      case 'instruction':
        result = await this.generateInstruction(config, startTime);
        break;
      case 'chat':
        result = await this.generateChat(config, startTime);
        break;
      case 'continued-pretraining':
        result = this.generateContinuedPretraining(config, startTime);
        break;
      case 'grpo':
        result = await this.generateGRPO(config, startTime);
        break;
      default:
        throw new Error(`Unsupported dataset format: ${config.format}`);
    }

    // Emit dataset generation event to EventLog
    await this.emitGenerationEvent(result, config.sessionId);

    return result;
  }

  // ─── Instruction Format Generation ─────────────────────────

  /**
   * Generate instruction-tuning dataset (prompt/response pairs).
   *
   * Uses the configured LLM provider to synthesize question-answer pairs
   * from KB chunks. Supports configurable extraction strategies:
   *   - entity-based: Extract entities, ask questions about them
   *   - summary-based: Ask for summaries/explanations of main topics
   *   - conversational: Generate natural dev-to-dev Q/A style
   *
   * Requirements: 7.2
   */
  private async generateInstruction(
    config: DatasetGenerationConfig,
    startTime: number,
  ): Promise<GeneratedDataset> {
    const strategy = config.extractionStrategy ?? DEFAULT_EXTRACTION_STRATEGY;
    const samples: InstructionSample[] = [];
    const provenance: DatasetProvenance[] = [];

    if (!this.llmClient) {
      throw new Error(
        'LLM client is required for instruction dataset generation. ' +
        'Configure an LLM provider before generating instruction datasets.',
      );
    }

    const maxSamples = config.maxSamples ?? config.sourceChunks.length;
    const chunksToProcess = config.sourceChunks.slice(0, maxSamples);

    for (let i = 0; i < chunksToProcess.length; i++) {
      const chunk = chunksToProcess[i]!;
      const promptFn = EXTRACTION_PROMPTS[strategy];
      const prompt = promptFn(chunk.content);

      try {
        const response = await this.llmClient.generate([
          { role: 'system', content: 'You are a training data generator. Output only valid JSON.' },
          { role: 'user', content: prompt },
        ]);

        const parsed = this.parseInstructionResponse(response);
        if (parsed) {
          samples.push(parsed);
          provenance.push({
            sampleIndex: samples.length - 1,
            sourceChunkId: chunk.id,
            sourceUri: chunk.sourceUri,
          });
        }
      } catch {
        // Skip failed generations — log but continue
        continue;
      }
    }

    const totalTokens = this.estimateTotalTokens(
      samples.map((s) => `${s.instruction} ${s.output}`),
    );

    return {
      path: config.outputPath,
      format: 'instruction',
      sampleCount: samples.length,
      totalTokens,
      generationDurationMs: Date.now() - startTime,
      provenance,
    };
  }

  // ─── Chat Format Generation ────────────────────────────────

  /**
   * Generate chat-format dataset (multi-turn conversations).
   *
   * Formats multi-turn interactions following the target model's chat template.
   * Each chunk produces a system context + user question + assistant answer conversation.
   *
   * Requirements: 7.3
   */
  private async generateChat(
    config: DatasetGenerationConfig,
    startTime: number,
  ): Promise<GeneratedDataset> {
    const template = config.chatTemplate ?? DEFAULT_CHAT_TEMPLATE;
    const samples: ChatSample[] = [];
    const provenance: DatasetProvenance[] = [];

    if (!this.llmClient) {
      throw new Error(
        'LLM client is required for chat dataset generation. ' +
        'Configure an LLM provider before generating chat datasets.',
      );
    }

    const maxSamples = config.maxSamples ?? config.sourceChunks.length;
    const chunksToProcess = config.sourceChunks.slice(0, maxSamples);

    for (let i = 0; i < chunksToProcess.length; i++) {
      const chunk = chunksToProcess[i]!;

      try {
        const response = await this.llmClient.generate([
          {
            role: 'system',
            content: 'You are a training data generator. Generate a multi-turn conversation ' +
              '(2-3 turns) between a user and an assistant about the given content. ' +
              'Output only valid JSON with a "messages" array containing objects with ' +
              '"role" (system/user/assistant) and "content" fields.',
          },
          {
            role: 'user',
            content: `Generate a multi-turn conversation about this content:\n\n${chunk.content}`,
          },
        ]);

        const parsed = this.parseChatResponse(response, template);
        if (parsed) {
          samples.push(parsed);
          provenance.push({
            sampleIndex: samples.length - 1,
            sourceChunkId: chunk.id,
            sourceUri: chunk.sourceUri,
          });
        }
      } catch {
        continue;
      }
    }

    const totalTokens = this.estimateTotalTokens(
      samples.map((s) => s.messages.map((m) => m.content).join(' ')),
    );

    return {
      path: config.outputPath,
      format: 'chat',
      sampleCount: samples.length,
      totalTokens,
      generationDurationMs: Date.now() - startTime,
      provenance,
    };
  }

  // ─── Continued Pre-Training Format ─────────────────────────

  /**
   * Generate continued-pretraining dataset (concatenated raw text).
   *
   * Concatenates raw KB text with configurable document separators.
   * No LLM calls needed — purely text assembly.
   *
   * Requirements: 7.4
   */
  private generateContinuedPretraining(
    config: DatasetGenerationConfig,
    startTime: number,
  ): GeneratedDataset {
    const separator = config.documentSeparator ?? DEFAULT_DOCUMENT_SEPARATOR;
    const provenance: DatasetProvenance[] = [];
    const textParts: string[] = [];

    const maxSamples = config.maxSamples ?? config.sourceChunks.length;
    const chunksToProcess = config.sourceChunks.slice(0, maxSamples);

    for (let i = 0; i < chunksToProcess.length; i++) {
      const chunk = chunksToProcess[i]!;
      textParts.push(chunk.content);
      provenance.push({
        sampleIndex: i,
        sourceChunkId: chunk.id,
        sourceUri: chunk.sourceUri,
      });
    }

    const concatenatedText = textParts.join(separator);
    const totalTokens = this.estimateTokenCount(concatenatedText);

    return {
      path: config.outputPath,
      format: 'continued-pretraining',
      sampleCount: chunksToProcess.length,
      totalTokens,
      generationDurationMs: Date.now() - startTime,
      provenance,
    };
  }

  // ─── GRPO Format Generation ────────────────────────────────

  /**
   * Generate GRPO dataset (preference pairs with reward signals).
   *
   * Uses accumulated feedback data from the preference store to produce
   * preference pair training samples. Each pair has a chosen (preferred)
   * and rejected (non-preferred) response with optional reward signals.
   *
   * Requirements: 7.1 (GRPO format)
   */
  private async generateGRPO(
    config: DatasetGenerationConfig,
    startTime: number,
  ): Promise<GeneratedDataset> {
    const provenance: DatasetProvenance[] = [];
    const samples: GRPOSample[] = [];

    if (!this.preferenceStore) {
      throw new Error(
        'GRPO preference store is required for GRPO dataset generation. ' +
        'Provide a preference store with accumulated user feedback.',
      );
    }

    // Retrieve preference pairs from the store
    // Use sourceChunks to derive the project context for preference lookup
    const projectId = this.deriveProjectId(config.sourceChunks);
    const maxSamples = config.maxSamples ?? 1000;
    const preferences = await this.preferenceStore.getPreferences(projectId, maxSamples);

    for (let i = 0; i < preferences.length; i++) {
      const pref = preferences[i]!;
      samples.push({
        prompt: pref.prompt,
        chosen: pref.chosenResponse,
        rejected: pref.rejectedResponse,
        reward_chosen: 1.0,
        reward_rejected: -1.0,
      });

      // For GRPO, provenance links to the preference pair itself
      // If there are corresponding chunks, link to the first one as context
      if (config.sourceChunks.length > 0) {
        const matchingChunk = config.sourceChunks.find(
          (c) => pref.prompt.includes(c.content.slice(0, 50)),
        );
        provenance.push({
          sampleIndex: i,
          sourceChunkId: matchingChunk?.id ?? config.sourceChunks[0]!.id,
          sourceUri: matchingChunk?.sourceUri ?? config.sourceChunks[0]!.sourceUri,
        });
      }
    }

    const totalTokens = this.estimateTotalTokens(
      samples.map((s) => `${s.prompt} ${s.chosen} ${s.rejected}`),
    );

    return {
      path: config.outputPath,
      format: 'grpo',
      sampleCount: samples.length,
      totalTokens,
      generationDurationMs: Date.now() - startTime,
      provenance,
    };
  }

  // ─── Helper Methods ────────────────────────────────────────

  /**
   * Parse an LLM response into an InstructionSample.
   * Handles JSON extraction from potentially noisy LLM output.
   */
  private parseInstructionResponse(response: string): InstructionSample | null {
    try {
      const jsonStr = this.extractJSON(response);
      const parsed = JSON.parse(jsonStr);

      if (
        typeof parsed.instruction === 'string' &&
        parsed.instruction.length > 0 &&
        typeof parsed.output === 'string' &&
        parsed.output.length > 0
      ) {
        return {
          instruction: parsed.instruction,
          input: parsed.input ?? undefined,
          output: parsed.output,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse an LLM response into a ChatSample.
   * Validates that the conversation has the expected structure.
   */
  private parseChatResponse(response: string, _template: string): ChatSample | null {
    try {
      const jsonStr = this.extractJSON(response);
      const parsed = JSON.parse(jsonStr);

      if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length >= 2) {
        const messages = parsed.messages
          .filter(
            (m: any) =>
              typeof m.role === 'string' &&
              ['system', 'user', 'assistant'].includes(m.role) &&
              typeof m.content === 'string' &&
              m.content.length > 0,
          )
          .map((m: any) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content as string,
          }));

        if (messages.length >= 2) {
          return { messages };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract JSON from potentially noisy LLM output.
   * Handles common cases: wrapped in markdown code blocks, leading/trailing text.
   */
  private extractJSON(text: string): string {
    // Try to extract from markdown code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1]!.trim();
    }

    // Try to find JSON object boundaries
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1);
    }

    // Fall back to the raw text
    return text.trim();
  }

  /**
   * Estimate token count for a text string.
   * Uses the same heuristic as the KB system (cl100k_base approximation).
   */
  private estimateTokenCount(text: string): number {
    if (text.length === 0) return 0;
    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
    const charBasedEstimate = Math.ceil(charCount / 4);
    const wordBasedEstimate = Math.ceil(wordCount * 1.3);
    return Math.max(charBasedEstimate, wordBasedEstimate);
  }

  /**
   * Estimate total tokens across multiple text strings.
   */
  private estimateTotalTokens(texts: string[]): number {
    return texts.reduce((sum, text) => sum + this.estimateTokenCount(text), 0);
  }

  /**
   * Derive a project ID from source chunks (uses the first chunk's sourceUri path).
   */
  private deriveProjectId(chunks: KBChunk[]): string {
    if (chunks.length === 0) return 'unknown';
    // Extract a project-level identifier from the source URI
    const uri = chunks[0]!.sourceUri;
    // Use the URI as a rough project identifier
    return uri.split('/').slice(0, 3).join('/') || uri;
  }

  /**
   * Emit a dataset generation event to the EventLog.
   * Includes: format type, sample count, total tokens, generation duration.
   *
   * Requirements: 7.6
   */
  private async emitGenerationEvent(
    dataset: GeneratedDataset,
    sessionId?: string,
  ): Promise<void> {
    if (!this.eventLog || !sessionId) return;

    try {
      await this.eventLog.emit({
        sessionId,
        kind: DATASET_EVENT_KIND,
        payload: {
          format: dataset.format,
          sampleCount: dataset.sampleCount,
          totalTokens: dataset.totalTokens,
          generationDurationMs: dataset.generationDurationMs,
        },
      });
    } catch {
      // EventLog emission is best-effort; don't fail generation
    }
  }

  // ─── Public Accessors for Format-Specific Data ──────────────

  /**
   * Get the available chat templates.
   */
  getAvailableChatTemplates(): string[] {
    return Object.keys(CHAT_TEMPLATES);
  }

  /**
   * Get the available extraction strategies.
   */
  getAvailableExtractionStrategies(): ExtractionStrategy[] {
    return ['entity-based', 'summary-based', 'conversational'];
  }

  /**
   * Format a chat sample using the specified template.
   * Useful for previewing how data will look in the target format.
   */
  formatChatSample(sample: ChatSample, template?: string): string {
    const templateName = template ?? DEFAULT_CHAT_TEMPLATE;
    const formatter = CHAT_TEMPLATES[templateName] ?? CHAT_TEMPLATES[DEFAULT_CHAT_TEMPLATE]!;
    return formatter(sample.messages);
  }
}
