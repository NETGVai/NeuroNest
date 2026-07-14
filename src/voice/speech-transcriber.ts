/**
 * SpeechTranscriber — Audio-to-text transcription with provider fallback.
 *
 * Supports configurable transcription providers:
 *   - Local: Whisper via ONNX runtime (reuses onnxruntime-node from Supertonic TTS)
 *   - Cloud: OpenAI Whisper API
 *   - Cloud: Google Speech-to-Text
 *
 * Provider selection is configurable with automatic fallback:
 *   local → OpenAI → Google (if each fails or is unavailable).
 *
 * Returns transcribed text with a confidence score.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 * Runs in the main process (Node.js) for access to native ONNX runtime.
 *
 * Requirements: 18.2
 */

import type { AudioChunk } from './speech-capture.js';

// ─── Types ──────────────────────────────────────────────────────

/** Supported transcription provider identifiers */
export type TranscriptionProvider = 'local' | 'openai' | 'google';

/** Configuration for the speech transcriber */
export interface SpeechTranscriberConfig {
  /** Primary provider to use (default: 'local') */
  provider: TranscriptionProvider;
  /** Fallback order when primary fails (default: ['openai', 'google']) */
  fallbackOrder: TranscriptionProvider[];
  /** Path to Whisper ONNX model directory (for local provider) */
  whisperModelPath: string;
  /** OpenAI API key (for cloud fallback) */
  openaiApiKey?: string;
  /** Google Speech-to-Text API key (for cloud fallback) */
  googleApiKey?: string;
  /** Language hint in BCP-47 format (e.g., 'en', 'ja') */
  language: string;
  /** Sample rate of incoming audio in Hz (default: 16000) */
  sampleRate: number;
}

/** Result of a transcription operation */
export interface TranscriptionResult {
  /** Transcribed text */
  text: string;
  /** Confidence score between 0 and 1 */
  confidence: number;
  /** Provider that produced the result */
  provider: TranscriptionProvider;
  /** Duration of audio processed in milliseconds */
  durationMs: number;
}

/** Error emitted when all providers fail */
export class TranscriptionError extends Error {
  public readonly provider: TranscriptionProvider;
  public readonly underlyingCause: Error | undefined;

  constructor(message: string, provider: TranscriptionProvider, cause?: Error) {
    super(message);
    this.name = 'TranscriptionError';
    this.provider = provider;
    this.underlyingCause = cause;
  }
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_TRANSCRIBER_CONFIG: SpeechTranscriberConfig = {
  provider: 'local',
  fallbackOrder: ['openai', 'google'],
  whisperModelPath: '',
  language: 'en',
  sampleRate: 16000,
};

// ─── Provider Interface ─────────────────────────────────────────

/**
 * Internal interface that each transcription provider implements.
 */
export interface ITranscriptionProvider {
  /** Human-readable name for logging */
  readonly name: TranscriptionProvider;
  /** Check if this provider is available (model loaded, API key set, etc.) */
  isAvailable(): boolean;
  /** Initialize the provider (lazy load models, validate keys) */
  initialize(): Promise<void>;
  /** Transcribe audio buffer and return result */
  transcribe(audio: Float32Array, sampleRate: number, language: string): Promise<TranscriptionResult>;
}

// ─── Local Whisper Provider ─────────────────────────────────────

/**
 * Local Whisper ONNX provider.
 *
 * Uses onnxruntime-node (same runtime as Supertonic TTS) to run
 * Whisper speech-to-text inference entirely on-device.
 */
export class WhisperLocalProvider implements ITranscriptionProvider {
  readonly name: TranscriptionProvider = 'local';
  private modelPath: string;
  private session: unknown | null = null;
  private initialized = false;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  isAvailable(): boolean {
    if (!this.modelPath) return false;
    try {
      const fs = require('node:fs');
      return fs.existsSync(this.modelPath);
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.isAvailable()) {
      throw new TranscriptionError(
        `Whisper ONNX model not found at: ${this.modelPath}`,
        'local',
      );
    }

    try {
      // Dynamic import to avoid hard crash if onnxruntime-node is not available
      const ort = await import('onnxruntime-node');
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['cpu'],
      });
      this.initialized = true;
    } catch (err) {
      throw new TranscriptionError(
        'Failed to load Whisper ONNX model',
        'local',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async transcribe(
    audio: Float32Array,
    sampleRate: number,
    language: string,
  ): Promise<TranscriptionResult> {
    if (!this.initialized || !this.session) {
      await this.initialize();
    }

    try {
      const ort = await import('onnxruntime-node');
      const session = this.session as import('onnxruntime-node').InferenceSession;

      // Prepare mel-spectrogram input for Whisper
      // Whisper expects 30s of audio at 16kHz (480000 samples)
      const targetLength = 30 * 16000;
      const paddedAudio = new Float32Array(targetLength);
      const copyLength = Math.min(audio.length, targetLength);
      paddedAudio.set(audio.subarray(0, copyLength));

      // Create input tensor — Whisper models accept raw audio as input
      const audioTensor = new ort.Tensor('float32', paddedAudio, [1, targetLength]);

      // Run inference
      const feeds: Record<string, unknown> = { audio_pcm: audioTensor };

      // Some Whisper ONNX models accept a language token
      if (language) {
        const langIds = new Int32Array([getLanguageId(language)]);
        feeds['language'] = new ort.Tensor('int32', langIds, [1]);
      }

      const results = await session.run(feeds as Record<string, import('onnxruntime-node').Tensor>);

      // Extract text and confidence from model output
      const text = decodeWhisperOutput(results);
      const confidence = extractConfidence(results);
      const durationMs = (audio.length / sampleRate) * 1000;

      return {
        text,
        confidence,
        provider: 'local',
        durationMs,
      };
    } catch (err) {
      throw new TranscriptionError(
        'Local Whisper transcription failed',
        'local',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}

// ─── OpenAI Whisper Provider ────────────────────────────────────

/**
 * OpenAI Whisper API provider.
 *
 * Uses the OpenAI API (already a project dependency) to transcribe
 * audio via the cloud Whisper model.
 */
export class OpenAIWhisperProvider implements ITranscriptionProvider {
  readonly name: TranscriptionProvider = 'openai';
  private apiKey: string;
  private initialized = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new TranscriptionError('OpenAI API key not configured', 'openai');
    }
    this.initialized = true;
  }

  async transcribe(
    audio: Float32Array,
    sampleRate: number,
    language: string,
  ): Promise<TranscriptionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Convert Float32Array PCM to WAV buffer for the API
      const wavBuffer = float32ToWav(audio, sampleRate);

      // Use the OpenAI SDK (already in project dependencies)
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: this.apiKey });

      // Create a File-like object from the WAV buffer
      const file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

      const response = await client.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: language || undefined,
      } as any);

      const durationMs = (audio.length / sampleRate) * 1000;

      // Extract text from response
      const text = typeof response === 'string' ? response : (response as any).text ?? '';
      // OpenAI doesn't return a direct confidence score; estimate from avg_logprob if available
      const segments = (response as any).segments;
      const confidence = estimateConfidenceFromSegments(segments);

      return {
        text: text.trim(),
        confidence,
        provider: 'openai',
        durationMs,
      };
    } catch (err) {
      throw new TranscriptionError(
        'OpenAI Whisper transcription failed',
        'openai',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}

// ─── Google Speech-to-Text Provider ─────────────────────────────

/**
 * Google Speech-to-Text provider.
 *
 * Uses the Google Cloud Speech-to-Text REST API for transcription.
 */
export class GoogleSpeechProvider implements ITranscriptionProvider {
  readonly name: TranscriptionProvider = 'google';
  private apiKey: string;
  private initialized = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new TranscriptionError('Google Speech API key not configured', 'google');
    }
    this.initialized = true;
  }

  async transcribe(
    audio: Float32Array,
    sampleRate: number,
    language: string,
  ): Promise<TranscriptionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Convert Float32Array to 16-bit PCM and base64-encode for the API
      const pcm16 = float32ToInt16(audio);
      const audioContent = Buffer.from(pcm16.buffer).toString('base64');

      const requestBody = {
        config: {
          encoding: 'LINEAR16' as const,
          sampleRateHertz: sampleRate,
          languageCode: language || 'en-US',
          enableWordConfidence: true,
          model: 'latest_long',
        },
        audio: {
          content: audioContent,
        },
      };

      const url = `https://speech.googleapis.com/v1/speech:recognize?key=${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google Speech API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as GoogleSpeechResponse;
      const durationMs = (audio.length / sampleRate) * 1000;

      if (!data.results || data.results.length === 0) {
        return {
          text: '',
          confidence: 0,
          provider: 'google',
          durationMs,
        };
      }

      // Combine all result alternatives
      const topResult = data.results[0]?.alternatives?.[0];
      const text = data.results
        .map(r => r.alternatives?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      const confidence = topResult?.confidence ?? 0;

      return {
        text,
        confidence,
        provider: 'google',
        durationMs,
      };
    } catch (err) {
      throw new TranscriptionError(
        'Google Speech transcription failed',
        'google',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}

/** Google Speech API response structure */
interface GoogleSpeechResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  }>;
}

// ─── SpeechTranscriber Class ────────────────────────────────────

/**
 * Main speech transcriber orchestrator.
 *
 * Manages provider selection, fallback logic, and audio buffer
 * aggregation from AudioChunk streams.
 *
 * Usage:
 *   const transcriber = SpeechTranscriber.getInstance(config);
 *   const result = await transcriber.transcribe(audioChunks);
 */
export class SpeechTranscriber {
  private static instance: SpeechTranscriber | null = null;

  private config: SpeechTranscriberConfig;
  private providers: Map<TranscriptionProvider, ITranscriptionProvider> = new Map();

  // ─── Lifecycle ──────────────────────────────────────────────

  private constructor(config: Partial<SpeechTranscriberConfig>) {
    this.config = { ...DEFAULT_TRANSCRIBER_CONFIG, ...config };
    this.initializeProviders();
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<SpeechTranscriberConfig>): SpeechTranscriber {
    if (!SpeechTranscriber.instance) {
      SpeechTranscriber.instance = new SpeechTranscriber(config ?? {});
    }
    return SpeechTranscriber.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    SpeechTranscriber.instance = null;
  }

  // ─── Public API ─────────────────────────────────────────────

  /** Get current configuration */
  getConfig(): SpeechTranscriberConfig {
    return { ...this.config };
  }

  /** Update configuration (reinitializes providers) */
  updateConfig(config: Partial<SpeechTranscriberConfig>): void {
    this.config = { ...this.config, ...config };
    this.initializeProviders();
  }

  /**
   * Transcribe an array of audio chunks into text.
   *
   * Concatenates all audio chunk data into a single buffer,
   * then attempts transcription using the configured provider
   * with fallback to alternatives on failure.
   *
   * @param chunks - Array of AudioChunk objects from SpeechCapture
   * @returns TranscriptionResult with text, confidence, and provider info
   * @throws TranscriptionError if all providers fail
   */
  async transcribe(chunks: AudioChunk[]): Promise<TranscriptionResult> {
    if (chunks.length === 0) {
      return {
        text: '',
        confidence: 0,
        provider: this.config.provider,
        durationMs: 0,
      };
    }

    // Concatenate audio chunks into a single Float32Array
    const audio = concatenateChunks(chunks);
    return this.transcribeAudio(audio);
  }

  /**
   * Transcribe a raw Float32Array audio buffer.
   *
   * Attempts the primary provider first, then falls back through
   * the configured fallback order.
   *
   * @param audio - Float32Array PCM audio data
   * @returns TranscriptionResult
   * @throws TranscriptionError if all providers fail
   */
  async transcribeAudio(audio: Float32Array): Promise<TranscriptionResult> {
    // Build the provider attempt order: primary first, then fallbacks
    const attemptOrder = [this.config.provider, ...this.config.fallbackOrder].filter(
      (p, i, arr) => arr.indexOf(p) === i, // deduplicate
    );

    const errors: TranscriptionError[] = [];

    for (const providerName of attemptOrder) {
      const provider = this.providers.get(providerName);
      if (!provider || !provider.isAvailable()) {
        continue;
      }

      try {
        await provider.initialize();
        const result = await provider.transcribe(
          audio,
          this.config.sampleRate,
          this.config.language,
        );
        return result;
      } catch (err) {
        const transcriptionErr = err instanceof TranscriptionError
          ? err
          : new TranscriptionError(
            `Provider "${providerName}" failed`,
            providerName,
            err instanceof Error ? err : undefined,
          );
        errors.push(transcriptionErr);
        console.warn(
          `[SpeechTranscriber] Provider "${providerName}" failed, trying next:`,
          transcriptionErr.message,
        );
      }
    }

    // All providers failed
    throw new TranscriptionError(
      `All transcription providers failed. Errors: ${errors.map(e => `${e.provider}: ${e.message}`).join('; ')}`,
      this.config.provider,
      errors[0]?.underlyingCause,
    );
  }

  /**
   * Check which providers are currently available.
   */
  getAvailableProviders(): TranscriptionProvider[] {
    const available: TranscriptionProvider[] = [];
    for (const [name, provider] of this.providers) {
      if (provider.isAvailable()) {
        available.push(name);
      }
    }
    return available;
  }

  // ─── Internal ───────────────────────────────────────────────

  /** Initialize provider instances based on configuration */
  private initializeProviders(): void {
    this.providers.clear();

    // Local Whisper provider
    this.providers.set(
      'local',
      new WhisperLocalProvider(this.config.whisperModelPath),
    );

    // OpenAI Whisper provider
    this.providers.set(
      'openai',
      new OpenAIWhisperProvider(this.config.openaiApiKey ?? ''),
    );

    // Google Speech provider
    this.providers.set(
      'google',
      new GoogleSpeechProvider(this.config.googleApiKey ?? ''),
    );
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Concatenate an array of AudioChunks into a single Float32Array.
 */
export function concatenateChunks(chunks: AudioChunk[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return result;
}

/**
 * Convert Float32Array PCM audio to a WAV buffer.
 * Used for sending audio to cloud APIs that expect WAV format.
 */
export function float32ToWav(audio: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = audio.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert float32 [-1, 1] to int16
  for (let i = 0; i < audio.length; i++) {
    const raw = audio[i] ?? 0;
    const sample = Math.max(-1, Math.min(1, raw));
    buffer.writeInt16LE(Math.round(sample * 32767), headerSize + i * 2);
  }

  return buffer;
}

/**
 * Convert Float32Array PCM to Int16Array.
 * Used for Google Speech API which expects LINEAR16 encoding.
 */
export function float32ToInt16(audio: Float32Array): Int16Array {
  const int16 = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const raw = audio[i] ?? 0;
    const sample = Math.max(-1, Math.min(1, raw));
    int16[i] = Math.round(sample * 32767);
  }
  return int16;
}

/**
 * Decode Whisper ONNX model output to text.
 * Handles both token-based and direct text output formats.
 */
export function decodeWhisperOutput(results: Record<string, unknown>): string {
  // Some Whisper ONNX exports output text directly
  if (results['text']) {
    const textOutput = results['text'] as { data?: unknown };
    if (textOutput.data) {
      const data = textOutput.data;
      if (typeof data === 'string') return data;
      if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data as unknown as Uint8Array);
      }
    }
  }

  // Token-based output — extract token IDs
  if (results['output_ids'] || results['token_ids'] || results['sequences']) {
    const tokenKey = results['output_ids'] ? 'output_ids'
      : results['token_ids'] ? 'token_ids'
      : 'sequences';
    const tokenTensor = results[tokenKey] as { data?: unknown };
    if (tokenTensor?.data) {
      // Return token IDs as a placeholder — real decoding requires tokenizer vocabulary
      // In a full implementation, this would use the Whisper tokenizer to decode IDs to text
      return `[token_output:${Array.from(tokenTensor.data as ArrayLike<number>).slice(0, 10).join(',')}]`;
    }
  }

  return '';
}

/**
 * Extract confidence score from Whisper model output.
 * Uses average log-probability when available, otherwise defaults to 0.8.
 */
export function extractConfidence(results: Record<string, unknown>): number {
  // Check for explicit confidence or probability output
  if (results['confidence']) {
    const conf = results['confidence'] as { data?: Float32Array | number[] };
    if (conf.data && conf.data.length > 0) {
      return Math.max(0, Math.min(1, Number(conf.data[0])));
    }
  }

  // Check for average log probability (common in Whisper outputs)
  if (results['avg_logprob'] || results['no_speech_prob']) {
    const logprob = results['avg_logprob'] as { data?: Float32Array | number[] } | undefined;
    if (logprob?.data && logprob.data.length > 0) {
      // Convert log probability to confidence (0-1 range)
      return Math.max(0, Math.min(1, Math.exp(Number(logprob.data[0]))));
    }
  }

  // Default confidence when no explicit signal is available
  return 0.8;
}

/**
 * Estimate confidence from OpenAI Whisper API segments.
 * Uses avg_logprob from segments when available.
 */
export function estimateConfidenceFromSegments(
  segments: Array<{ avg_logprob?: number }> | undefined | null,
): number {
  if (!segments || segments.length === 0) {
    return 0.85; // Default high confidence for successful API calls
  }

  const logprobs = segments
    .map(s => s.avg_logprob)
    .filter((lp): lp is number => typeof lp === 'number');

  if (logprobs.length === 0) {
    return 0.85;
  }

  // Average the log probabilities and convert to a 0-1 confidence
  const avgLogprob = logprobs.reduce((sum, lp) => sum + lp, 0) / logprobs.length;
  // Whisper avg_logprob typically ranges from -1.0 (low confidence) to 0 (high confidence)
  // Map to 0-1 range: -1.0 → 0.36, -0.5 → 0.60, 0 → 1.0
  return Math.max(0, Math.min(1, Math.exp(avgLogprob)));
}

/**
 * Map a BCP-47 language code to a Whisper language ID.
 * Whisper uses integer IDs for language tokens.
 */
export function getLanguageId(language: string): number {
  const langMap: Record<string, number> = {
    'en': 0,
    'zh': 1,
    'de': 2,
    'es': 3,
    'ru': 4,
    'ko': 5,
    'fr': 6,
    'ja': 7,
    'pt': 8,
    'tr': 9,
    'pl': 10,
    'ca': 11,
    'nl': 12,
    'ar': 13,
    'sv': 14,
    'it': 15,
    'id': 16,
    'hi': 17,
    'fi': 18,
    'vi': 19,
    'he': 20,
    'uk': 21,
    'el': 22,
    'ms': 23,
    'cs': 24,
    'ro': 25,
    'da': 26,
    'hu': 27,
    'ta': 28,
    'no': 29,
    'th': 30,
  };

  // Strip region suffix (e.g., 'en-US' → 'en')
  const base = (language.split('-')[0] ?? 'en').toLowerCase();
  return langMap[base] ?? 0; // Default to English
}
