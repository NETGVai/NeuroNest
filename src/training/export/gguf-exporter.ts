/**
 * GGUFExporter — Converts trained model weights to GGUF format and registers
 * them with Ollama for local inference.
 *
 * Responsibilities:
 *   - Convert trained weights to GGUF using a configurable quantization method
 *   - Register the exported GGUF file with the local Ollama instance via its model import API
 *   - Update the Provider_Registry to include the new model as a fine-tuned variant
 *   - Preserve raw weights if export fails
 *   - Emit structured export events (export.start, export.complete) to EventLog
 *
 * All subprocess operations use SafeExec (execFile with argument arrays, no shell).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { statSync } from 'node:fs';
import type { SafeExecResult } from '../../security/safe-exec.js';
import type { IProviderRegistry, LLMProviderAdapter } from '../../providers/provider-registry.js';
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

/** Supported quantization types for GGUF export */
export type QuantizationType = 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'q8_0' | 'f16';

/**
 * Configuration for a GGUF export operation.
 */
export interface GGUFExportConfig {
  /** Path to the trained model weights directory */
  modelPath: string;
  /** Output path for the exported GGUF file */
  outputPath: string;
  /** Quantization method to apply */
  quantization: QuantizationType;
  /** Model name to register with Ollama */
  ollamaModelName: string;
  /** Optional training job ID (for event correlation) */
  jobId?: string;
}

/**
 * Result of a GGUF export operation.
 */
export interface ExportResult {
  /** Path to the exported GGUF file */
  ggufPath: string;
  /** Size of the exported GGUF file in bytes */
  sizeBytes: number;
  /** Quantization method used */
  quantization: QuantizationType;
  /** Whether the model was successfully registered with Ollama */
  ollamaRegistered: boolean;
  /** Whether the model was registered in the Provider_Registry */
  providerRegistered: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────

export class GGUFExportError extends Error {
  constructor(message: string, public readonly modelPath?: string) {
    super(message);
    this.name = 'GGUFExportError';
  }
}

export class OllamaRegistrationError extends Error {
  constructor(message: string, public readonly ggufPath?: string) {
    super(message);
    this.name = 'OllamaRegistrationError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

/** Default timeout for the GGUF conversion subprocess (30 minutes) */
const DEFAULT_CONVERSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Default Ollama API endpoint */
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Provider ID used when registering fine-tuned models */
const FINETUNED_PROVIDER_PREFIX = 'ollama-finetuned';

// ─── GGUFExporter ───────────────────────────────────────────────

/**
 * Exports trained model weights to GGUF format and registers them with
 * Ollama and the Provider_Registry.
 *
 * The conversion spawns a subprocess via SafeExec (no shell interpretation).
 * On failure, raw weights are preserved and an export-failed event is emitted.
 */
export class GGUFExporter {
  private readonly ollamaEndpoint: string;
  private readonly conversionTimeoutMs: number;

  constructor(
    private readonly safeExec: SafeExecFn,
    private readonly providerRegistry: IProviderRegistry,
    private readonly eventLog: EventLog,
    options?: {
      ollamaEndpoint?: string;
      conversionTimeoutMs?: number;
    },
  ) {
    this.ollamaEndpoint = options?.ollamaEndpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.conversionTimeoutMs = options?.conversionTimeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
  }

  /**
   * Export trained model weights to GGUF format and register with Ollama.
   *
   * Steps:
   * 1. Emit training.export.start event
   * 2. Spawn conversion subprocess via SafeExec to produce GGUF
   * 3. Register the GGUF file with Ollama model import API
   * 4. Update Provider_Registry with fine-tuned model metadata
   * 5. Emit training.export.complete event
   *
   * On export failure: preserves raw weights, emits export-failed event.
   *
   * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
   */
  async export(config: GGUFExportConfig): Promise<ExportResult> {
    const { modelPath, outputPath, quantization, ollamaModelName, jobId } = config;

    // Emit export-start event
    this.emitExportEvent(TRAINING_EVENT_KINDS.EXPORT_START, {
      jobId: jobId ?? 'unknown',
      modelPath,
      quantization,
    });

    // Step 1: Convert weights to GGUF format
    let ggufPath: string;
    let sizeBytes: number;
    try {
      ggufPath = await this.convertToGGUF(modelPath, outputPath, quantization);
      sizeBytes = this.getFileSize(ggufPath);
    } catch (error: unknown) {
      // On failure: preserve raw weights, emit failed event
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitExportFailedEvent(jobId ?? 'unknown', errorMessage, modelPath);
      throw new GGUFExportError(
        `GGUF conversion failed: ${errorMessage}. Raw weights preserved at ${modelPath}`,
        modelPath,
      );
    }

    // Step 2: Register with Ollama
    let ollamaRegistered = false;
    try {
      await this.registerWithOllama(ggufPath, ollamaModelName);
      ollamaRegistered = true;
    } catch (error: unknown) {
      // Registration failure is non-fatal — GGUF file is still on disk
      // User can manually import with `ollama create`
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitExportFailedEvent(
        jobId ?? 'unknown',
        `Ollama registration failed: ${errorMessage}. GGUF file available at ${ggufPath}`,
        modelPath,
      );
    }

    // Step 3: Update Provider_Registry
    let providerRegistered = false;
    try {
      this.registerWithProviderRegistry(ollamaModelName, config);
      providerRegistered = true;
    } catch {
      // Provider registration failure is non-fatal
    }

    // Emit export-complete event
    this.emitExportEvent(TRAINING_EVENT_KINDS.EXPORT_COMPLETE, {
      jobId: jobId ?? 'unknown',
      ggufPath,
      sizeBytes,
      ollamaRegistered,
    });

    return {
      ggufPath,
      sizeBytes,
      quantization,
      ollamaRegistered,
      providerRegistered,
    };
  }

  // ─── Private: GGUF Conversion ─────────────────────────────────

  /**
   * Spawn a subprocess via SafeExec to convert model weights to GGUF format.
   *
   * Uses `llama-quantize` (or equivalent tool) with argument arrays.
   * No shell interpretation — all values passed as discrete arguments.
   *
   * Requirements: 10.1, 27.2
   */
  private async convertToGGUF(
    modelPath: string,
    outputPath: string,
    quantization: QuantizationType,
  ): Promise<string> {
    // The output file path for the GGUF
    const ggufOutputPath = outputPath.endsWith('.gguf')
      ? outputPath
      : `${outputPath}.gguf`;

    // Use the convert script to create GGUF from model weights
    // This follows the SafeExec pattern: execFile with argument arrays, no shell
    const convertResult = await this.safeExec(
      'python',
      [
        '-m', 'llama_cpp.convert',
        '--outfile', ggufOutputPath,
        '--outtype', this.mapQuantizationToOuttype(quantization),
        modelPath,
      ],
      { timeout: this.conversionTimeoutMs },
    );

    if (convertResult.exitCode !== 0) {
      throw new GGUFExportError(
        `Conversion subprocess exited with code ${convertResult.exitCode}: ${convertResult.stderr}`,
        modelPath,
      );
    }

    // If quantization is not f16, apply quantization as a second pass
    if (quantization !== 'f16') {
      const quantizeResult = await this.safeExec(
        'llama-quantize',
        [ggufOutputPath, ggufOutputPath, quantization.toUpperCase()],
        { timeout: this.conversionTimeoutMs },
      );

      if (quantizeResult.exitCode !== 0) {
        // Quantization failed but f16 GGUF exists — still usable
        throw new GGUFExportError(
          `Quantization subprocess failed with code ${quantizeResult.exitCode}: ${quantizeResult.stderr}`,
          modelPath,
        );
      }
    }

    return ggufOutputPath;
  }

  // ─── Private: Ollama Registration ─────────────────────────────

  /**
   * Register the exported GGUF file with the local Ollama instance
   * using the Ollama model import API.
   *
   * Creates a Modelfile and calls `ollama create` with the model name.
   * Handles errors: Ollama not running, registration failure.
   *
   * Requirements: 10.2
   */
  private async registerWithOllama(ggufPath: string, modelName: string): Promise<void> {
    // First, check if Ollama is available
    const isAvailable = await this.checkOllamaAvailability();
    if (!isAvailable) {
      throw new OllamaRegistrationError(
        'Ollama is not running or not reachable. Start Ollama and try again.',
        ggufPath,
      );
    }

    // Use `ollama create` with a FROM directive pointing to the GGUF file
    // This is the recommended way to import a GGUF model into Ollama
    const modelfileContent = `FROM ${ggufPath}`;

    const result = await this.safeExec(
      'ollama',
      ['create', modelName, '-f', '/dev/stdin'],
      { timeout: 120_000 },
    );

    // Fallback: if piping via stdin doesn't work, try the HTTP API approach
    if (result.exitCode !== 0) {
      // Try the Ollama create API endpoint directly
      await this.registerWithOllamaAPI(ggufPath, modelName);
    }
  }

  /**
   * Register via the Ollama HTTP API (POST /api/create).
   * This is an alternative to the CLI approach.
   */
  private async registerWithOllamaAPI(ggufPath: string, modelName: string): Promise<void> {
    try {
      const response = await fetch(`${this.ollamaEndpoint}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: modelName,
          modelfile: `FROM ${ggufPath}`,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new OllamaRegistrationError(
          `Ollama API returned HTTP ${response.status}: ${body}`,
          ggufPath,
        );
      }

      // Ollama create streams JSON responses — consume the stream
      // Each line is a JSON object with a "status" field
      const text = await response.text();
      if (text.includes('"error"')) {
        throw new OllamaRegistrationError(
          `Ollama registration error: ${text}`,
          ggufPath,
        );
      }
    } catch (error: unknown) {
      if (error instanceof OllamaRegistrationError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new OllamaRegistrationError(
        `Failed to communicate with Ollama API: ${msg}`,
        ggufPath,
      );
    }
  }

  /**
   * Check if Ollama is available by hitting the health/version endpoint.
   */
  private async checkOllamaAvailability(): Promise<boolean> {
    try {
      const result = await this.safeExec(
        'curl',
        [
          '--silent',
          '--fail',
          '--max-time', '5',
          `${this.ollamaEndpoint}/api/version`,
        ],
        { timeout: 10_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ─── Private: Provider Registry ───────────────────────────────

  /**
   * Register the new fine-tuned model with the Provider_Registry.
   *
   * Registers as an available option under the Ollama provider with metadata
   * indicating it is a fine-tuned variant.
   *
   * Requirements: 10.3
   */
  private registerWithProviderRegistry(
    modelName: string,
    config: GGUFExportConfig,
  ): void {
    const providerId = `${FINETUNED_PROVIDER_PREFIX}-${modelName}`;

    const ollamaEndpoint = this.ollamaEndpoint;
    const adapter: LLMProviderAdapter = {
      id: providerId,
      name: `Fine-tuned: ${modelName}`,
      chatCompletion: async (messages, options) => {
        // Route through Ollama's OpenAI-compatible API
        const response = await fetch(`${ollamaEndpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.maxTokens,
            stop: options?.stopSequences,
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama inference failed: HTTP ${response.status}`);
        }

        const json = await response.json() as {
          choices: Array<{
            message: { content: string };
            finish_reason: string;
          }>;
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
      streamCompletion: async function* (messages: Array<{ role: string; content: string }>, options?: { temperature?: number; maxTokens?: number; stopSequences?: string[] }) {
        const response = await fetch(`${ollamaEndpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.maxTokens,
            stop: options?.stopSequences,
            stream: true,
          }),
        });

        if (!response.ok || !response.body) {
          yield { content: '', done: true };
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
              const data = JSON.parse(trimmed.slice(6)) as {
                choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
              };
              const delta = data.choices[0]?.delta?.content ?? '';
              const finished = data.choices[0]?.finish_reason != null;
              yield { content: delta, done: finished };
            } catch {
              // Skip malformed SSE chunks
            }
          }
        }
      }.bind({ ollamaEndpoint: this.ollamaEndpoint }),
      countTokens: (text: string) => {
        // Approximate token count (GPT-4 average: ~4 chars per token)
        return Math.ceil(text.length / 4);
      },
      isAvailable: async () => {
        return this.checkOllamaAvailability();
      },
    };

    // Register with priority 45 — below cloud providers (100+), below direct
    // Unsloth MCP (50), above base Ollama (30)
    this.providerRegistry.register(adapter, 45);
  }

  // ─── Private: EventLog ────────────────────────────────────────

  /**
   * Emit a structured export event to the EventLog.
   * Uses the `kb-export` source identifier for rate limiting.
   *
   * Requirements: 10.4
   */
  private emitExportEvent(kind: EventKind, payload: Record<string, unknown>): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.EXPORT,
        kind,
        payload,
      });
    } catch {
      // EventLog emission is best-effort; don't crash the exporter
    }
  }

  /**
   * Emit an export-failed event.
   * Since there's no dedicated EXPORT_FAILED event kind in the schema,
   * we emit a JOB_FAILED event with export context.
   *
   * Requirements: 10.5
   */
  private emitExportFailedEvent(
    jobId: string,
    error: string,
    modelPath: string,
  ): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.EXPORT,
        kind: TRAINING_EVENT_KINDS.JOB_FAILED,
        payload: {
          jobId,
          error: `Export failed: ${error}. Raw weights preserved at ${modelPath}`,
        },
      });
    } catch {
      // Best-effort
    }
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Map our quantization type enum to the outtype flag expected by
   * the conversion tool.
   */
  private mapQuantizationToOuttype(quantization: QuantizationType): string {
    switch (quantization) {
      case 'f16':
        return 'f16';
      case 'q8_0':
        return 'q8_0';
      case 'q5_1':
        return 'q5_1';
      case 'q5_0':
        return 'q5_0';
      case 'q4_1':
        return 'q4_1';
      case 'q4_0':
        return 'q4_0';
      default:
        return 'f16';
    }
  }

  /**
   * Get file size in bytes. Returns 0 if the file doesn't exist.
   */
  private getFileSize(filePath: string): number {
    try {
      const stats = statSync(filePath);
      return stats.size;
    } catch {
      return 0;
    }
  }
}
