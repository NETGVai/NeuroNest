/**
 * VoiceIOService — Voice input/output for hands-free agent interaction.
 *
 * Provides speech-to-text (transcription) and text-to-speech (synthesis) capabilities
 * using the existing voice-models ONNX assets and voice_styles directory. Supports
 * configurable wake word or push-to-talk activation, streaming audio processing,
 * confidence threshold with confirmation prompts, and multiple voice styles.
 *
 * Key behaviors:
 * - listen() transcribes speech from microphone input using ONNX voice models
 * - speak() converts text to speech using a configured voice style
 * - Supports two activation modes: 'wake-word' and 'push-to-talk'
 * - Wake word detection is a placeholder for future ML-based implementation
 * - Configurable confidence threshold triggers confirmation when below threshold
 * - Streaming support for real-time audio processing via event callbacks
 * - Voice styles loaded from voice_styles/*.json in the models directory
 * - Feature gated: zero overhead when voice_io gate is disabled
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for the VoiceIO subsystem */
export interface VoiceIOConfig {
  /** Activation mode: 'wake-word' listens for a keyword, 'push-to-talk' requires manual trigger */
  activationMode: 'wake-word' | 'push-to-talk';
  /** The wake word to listen for (only used in 'wake-word' mode) */
  wakeWord?: string;
  /** Voice style identifier referencing voice_styles/{id}.json */
  voiceStyle: string;
  /** Confidence threshold (0.0–1.0). Below this, transcription requires user confirmation. Default: 0.7 */
  confidenceThreshold: number;
  /** Sample rate in Hz for audio capture. Default: 16000 */
  sampleRate?: number;
  /** Whether to enable streaming mode for real-time processing */
  streamingEnabled?: boolean;
  /** Maximum recording duration in milliseconds. Default: 30000 */
  maxRecordingDurationMs?: number;
  /** Language hint for speech recognition (BCP-47 format, e.g., 'en-US') */
  language?: string;
}

/** Result of a speech-to-text transcription */
export interface VoiceIOResult {
  /** The transcribed text */
  text: string;
  /** Confidence score (0.0–1.0) of the transcription */
  confidence: number;
  /** Whether the transcription needs user confirmation (confidence < threshold) */
  needsConfirmation: boolean;
  /** Duration of the audio in milliseconds */
  durationMs: number;
  /** Whether the result is a partial (streaming) or final transcription */
  isFinal: boolean;
}

/** Result of text-to-speech synthesis */
export interface VoiceIOSynthesisResult {
  /** Audio buffer containing the synthesized speech */
  audioBuffer: Buffer;
  /** Duration of the synthesized audio in milliseconds */
  durationMs: number;
  /** Sample rate of the output audio */
  sampleRate: number;
  /** Voice style used for synthesis */
  voiceStyle: string;
}

/** Streaming event callbacks for real-time audio processing */
export interface VoiceIOStreamCallbacks {
  /** Called with partial transcription results during streaming */
  onPartialResult?: (result: VoiceIOResult) => void;
  /** Called when the final transcription is ready */
  onFinalResult?: (result: VoiceIOResult) => void;
  /** Called when an error occurs during streaming */
  onError?: (error: Error) => void;
  /** Called when audio level changes (for UI indicators) */
  onAudioLevel?: (level: number) => void;
}

/** Voice style data loaded from voice_styles/*.json */
export interface VoiceStyleData {
  /** Style name/identifier */
  id: string;
  /** Style tensor/embedding data for TTS model */
  styleTtl: unknown;
}

/** State of the voice IO service */
export type VoiceIOState = 'idle' | 'listening' | 'processing' | 'speaking' | 'wake-word-listening';

/** Events emitted by VoiceIOService */
export interface VoiceIOEvents {
  'state-changed': (state: VoiceIOState) => void;
  'wake-word-detected': () => void;
  'listening-started': () => void;
  'listening-stopped': () => void;
  'transcription-partial': (result: VoiceIOResult) => void;
  'transcription-complete': (result: VoiceIOResult) => void;
  'synthesis-complete': (result: VoiceIOSynthesisResult) => void;
  'error': (error: Error) => void;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MAX_RECORDING_DURATION_MS = 30000;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const VOICE_STYLES_DIR = 'voice_styles';
const ONNX_DIR = 'onnx';

// ─── VoiceIOService Class ───────────────────────────────────────

export class VoiceIOService extends EventEmitter {
  private readonly config: Required<VoiceIOConfig>;
  private readonly modelsDir: string;
  private state: VoiceIOState = 'idle';
  private voiceStyleCache: Map<string, VoiceStyleData> = new Map();
  private isInitialized = false;
  private activeStreamCallbacks: VoiceIOStreamCallbacks | null = null;

  constructor(config: VoiceIOConfig, modelsDir: string) {
    super();
    this.config = {
      activationMode: config.activationMode,
      wakeWord: config.wakeWord ?? 'neuronest',
      voiceStyle: config.voiceStyle,
      confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      sampleRate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
      streamingEnabled: config.streamingEnabled ?? false,
      maxRecordingDurationMs: config.maxRecordingDurationMs ?? DEFAULT_MAX_RECORDING_DURATION_MS,
      language: config.language ?? 'en-US',
    };
    this.modelsDir = modelsDir;
  }

  /**
   * Initialize the voice IO service, loading models and validating configuration.
   *
   * Requirements: 24.1
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Validate models directory exists
    if (!fs.existsSync(this.modelsDir)) {
      throw new Error(`Voice models directory not found: ${this.modelsDir}`);
    }

    // Validate ONNX models are present
    const onnxDir = path.join(this.modelsDir, ONNX_DIR);
    if (!fs.existsSync(onnxDir)) {
      throw new Error(`ONNX models directory not found: ${onnxDir}`);
    }

    // Validate configured voice style exists
    await this.loadVoiceStyle(this.config.voiceStyle);

    this.isInitialized = true;
  }

  /**
   * Start listening for voice input and transcribe speech to text.
   *
   * In 'wake-word' mode, waits for the wake word before transcribing.
   * In 'push-to-talk' mode, immediately starts transcription.
   *
   * Returns the transcribed text with a confidence score. If confidence is below
   * the configured threshold, `needsConfirmation` will be true to indicate the
   * UI should prompt the user for confirmation.
   *
   * Requirements: 24.1, 24.4, 24.5
   */
  async listen(): Promise<VoiceIOResult> {
    this.ensureInitialized();

    if (this.config.activationMode === 'wake-word') {
      this.setState('wake-word-listening');
      const detected = await this.detectWakeWord();
      if (!detected) {
        return this.createEmptyResult();
      }
      this.emit('wake-word-detected');
    }

    this.setState('listening');
    this.emit('listening-started');

    try {
      const audioData = await this.captureAudio();
      this.emit('listening-stopped');

      this.setState('processing');
      const result = await this.transcribe(audioData);
      this.setState('idle');

      this.emit('transcription-complete', result);
      return result;
    } catch (error) {
      this.setState('idle');
      this.emit('listening-stopped');
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Start streaming voice input with real-time partial transcription results.
   *
   * Emits partial results via callbacks as audio is processed. Call stopListening()
   * to end the stream and get the final result.
   *
   * Requirements: 24.1, 24.4
   */
  async startStreaming(callbacks: VoiceIOStreamCallbacks): Promise<void> {
    this.ensureInitialized();

    if (!this.config.streamingEnabled) {
      throw new Error('Streaming is not enabled in VoiceIO configuration');
    }

    if (this.state !== 'idle') {
      throw new Error(`Cannot start streaming in state: ${this.state}`);
    }

    this.activeStreamCallbacks = callbacks;

    if (this.config.activationMode === 'wake-word') {
      this.setState('wake-word-listening');
      const detected = await this.detectWakeWord();
      if (!detected) {
        this.activeStreamCallbacks = null;
        return;
      }
      this.emit('wake-word-detected');
    }

    this.setState('listening');
    this.emit('listening-started');

    // Start background audio capture with streaming transcription
    this.processStreamingAudio().catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.activeStreamCallbacks?.onError?.(err);
      this.emit('error', err);
      this.setState('idle');
    });
  }

  /**
   * Stop the current listening/streaming session.
   *
   * Requirements: 24.1
   */
  stopListening(): void {
    if (this.state === 'listening' || this.state === 'wake-word-listening') {
      this.setState('idle');
      this.emit('listening-stopped');
      this.activeStreamCallbacks = null;
    }
  }

  /**
   * Convert text to speech using the configured voice style.
   *
   * Loads the voice style data from the voice_styles directory and synthesizes
   * speech using the ONNX TTS model.
   *
   * Requirements: 24.2
   */
  async speak(text: string): Promise<VoiceIOSynthesisResult> {
    this.ensureInitialized();

    if (!text || text.trim().length === 0) {
      return {
        audioBuffer: Buffer.alloc(0),
        durationMs: 0,
        sampleRate: this.config.sampleRate,
        voiceStyle: this.config.voiceStyle,
      };
    }

    this.setState('speaking');

    try {
      const voiceStyle = await this.loadVoiceStyle(this.config.voiceStyle);
      const result = await this.synthesize(text, voiceStyle);

      this.setState('idle');
      this.emit('synthesis-complete', result);
      return result;
    } catch (error) {
      this.setState('idle');
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Transcribe raw audio data to text.
   *
   * This is the core speech-to-text method that processes audio buffers
   * through the ONNX speech recognition model.
   *
   * Requirements: 24.1
   */
  async transcribe(audioData: Buffer): Promise<VoiceIOResult> {
    this.ensureInitialized();

    if (audioData.length === 0) {
      return this.createEmptyResult();
    }

    // Process audio through the STT model
    // In production, this would use onnxruntime-node to run the ONNX model.
    // The implementation delegates to the model inference engine.
    const transcriptionResult = await this.runSpeechToTextModel(audioData);

    const result: VoiceIOResult = {
      text: transcriptionResult.text,
      confidence: transcriptionResult.confidence,
      needsConfirmation: transcriptionResult.confidence < this.config.confidenceThreshold,
      durationMs: this.calculateAudioDurationMs(audioData),
      isFinal: true,
    };

    return result;
  }

  /**
   * Synthesize speech from text using the specified or default voice style.
   *
   * Requirements: 24.2
   */
  async synthesize(text: string, voiceStyle?: VoiceStyleData): Promise<VoiceIOSynthesisResult> {
    this.ensureInitialized();

    const style = voiceStyle ?? (await this.loadVoiceStyle(this.config.voiceStyle));

    // Process text through the TTS model
    // In production, this would use onnxruntime-node with the duration_predictor.onnx
    // and voice style embeddings to generate audio.
    const audioBuffer = await this.runTextToSpeechModel(text, style);
    const durationMs = this.calculateAudioDurationMs(audioBuffer);

    return {
      audioBuffer,
      durationMs,
      sampleRate: this.config.sampleRate,
      voiceStyle: style.id,
    };
  }

  /**
   * Get the current state of the voice IO service.
   */
  getState(): VoiceIOState {
    return this.state;
  }

  /**
   * Check if the service is currently listening for input.
   */
  isListening(): boolean {
    return this.state === 'listening' || this.state === 'wake-word-listening';
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<Required<VoiceIOConfig>> {
    return this.config;
  }

  /**
   * Update the voice style at runtime.
   *
   * Requirements: 24.2
   */
  async setVoiceStyle(styleId: string): Promise<void> {
    await this.loadVoiceStyle(styleId);
    (this.config as VoiceIOConfig).voiceStyle = styleId;
  }

  /**
   * Update the confidence threshold at runtime.
   *
   * Requirements: 24.5
   */
  setConfidenceThreshold(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error(`Confidence threshold must be between 0 and 1, got: ${threshold}`);
    }
    (this.config as VoiceIOConfig).confidenceThreshold = threshold;
  }

  /**
   * List available voice styles from the voice_styles directory.
   */
  listAvailableVoiceStyles(): string[] {
    const stylesDir = path.join(this.modelsDir, VOICE_STYLES_DIR);
    if (!fs.existsSync(stylesDir)) {
      return [];
    }

    return fs
      .readdirSync(stylesDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.basename(file, '.json'));
  }

  /**
   * Destroy the service, releasing all resources.
   */
  destroy(): void {
    this.stopListening();
    this.voiceStyleCache.clear();
    this.isInitialized = false;
    this.removeAllListeners();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Detect the wake word in audio input.
   *
   * This is a placeholder implementation. In production, this would use a
   * lightweight keyword-spotting model (e.g., Porcupine or a custom ONNX model)
   * for always-on wake word detection with minimal CPU usage.
   *
   * Requirements: 24.4
   */
  private async detectWakeWord(): Promise<boolean> {
    // Placeholder: In production, this would:
    // 1. Open a low-power audio stream
    // 2. Run a small keyword-spotting model continuously
    // 3. Return true when the configured wake word is detected
    // 4. Return false on timeout or cancellation
    //
    // For now, this immediately returns true to allow development and testing
    // of the downstream transcription pipeline.
    return true;
  }

  /**
   * Capture audio from the system microphone.
   *
   * In production, this would use a native audio capture API (e.g., via
   * node-microphone or Electron's desktopCapturer) to record audio until
   * silence is detected or max duration is reached.
   *
   * Requirements: 24.1
   */
  private async captureAudio(): Promise<Buffer> {
    // Placeholder: Returns an empty buffer.
    // In production, this integrates with the native audio subsystem.
    // The capture stops when:
    // 1. Voice activity detection detects end of speech
    // 2. Maximum recording duration is reached
    // 3. User explicitly stops via stopListening()
    return Buffer.alloc(0);
  }

  /**
   * Process streaming audio with real-time partial results.
   */
  private async processStreamingAudio(): Promise<void> {
    // Placeholder: In production, this would:
    // 1. Open a continuous audio stream
    // 2. Buffer audio in chunks (e.g., 100ms segments)
    // 3. Run incremental STT on each chunk for partial results
    // 4. Emit partial results via activeStreamCallbacks.onPartialResult
    // 5. When silence is detected, emit final result
    // 6. Continue until stopListening() is called

    const finalResult = await this.transcribe(Buffer.alloc(0));
    this.activeStreamCallbacks?.onFinalResult?.(finalResult);
    this.emit('transcription-complete', finalResult);
    this.setState('idle');
  }

  /**
   * Run the ONNX speech-to-text model on audio data.
   *
   * In production, this would:
   * 1. Preprocess audio (resample, normalize, compute mel-spectrogram)
   * 2. Run inference via onnxruntime-node on the STT model
   * 3. Decode output tokens to text
   * 4. Compute confidence from model logits
   *
   * Requirements: 24.1
   */
  private async runSpeechToTextModel(
    _audioData: Buffer,
  ): Promise<{ text: string; confidence: number }> {
    // Placeholder: In production, integrates with onnxruntime-node
    // and the ONNX models in the onnx/ directory.
    return { text: '', confidence: 0 };
  }

  /**
   * Run the ONNX text-to-speech model to generate audio.
   *
   * In production, this would:
   * 1. Tokenize input text using unicode_indexer.json
   * 2. Run duration predictor (duration_predictor.onnx) for timing
   * 3. Generate mel-spectrogram conditioned on voice style embeddings
   * 4. Convert mel-spectrogram to waveform via vocoder
   * 5. Return PCM audio buffer at configured sample rate
   *
   * Requirements: 24.2
   */
  private async runTextToSpeechModel(
    _text: string,
    _voiceStyle: VoiceStyleData,
  ): Promise<Buffer> {
    // Placeholder: In production, integrates with onnxruntime-node
    // and the TTS model pipeline (tts.json config + duration_predictor.onnx
    // + voice style embeddings from voice_styles/).
    return Buffer.alloc(0);
  }

  /**
   * Load a voice style from the voice_styles directory with caching.
   *
   * Requirements: 24.2
   */
  private async loadVoiceStyle(styleId: string): Promise<VoiceStyleData> {
    const cached = this.voiceStyleCache.get(styleId);
    if (cached) {
      return cached;
    }

    const stylePath = path.join(this.modelsDir, VOICE_STYLES_DIR, `${styleId}.json`);
    if (!fs.existsSync(stylePath)) {
      throw new Error(
        `Voice style not found: ${styleId}. Available styles: ${this.listAvailableVoiceStyles().join(', ')}`,
      );
    }

    try {
      const raw = fs.readFileSync(stylePath, 'utf-8');
      const data = JSON.parse(raw);
      const voiceStyle: VoiceStyleData = {
        id: styleId,
        styleTtl: data,
      };

      this.voiceStyleCache.set(styleId, voiceStyle);
      return voiceStyle;
    } catch (error) {
      throw new Error(
        `Failed to load voice style '${styleId}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Calculate audio duration in milliseconds from buffer size and sample rate.
   */
  private calculateAudioDurationMs(audioBuffer: Buffer): number {
    if (audioBuffer.length === 0) {
      return 0;
    }
    // Assuming 16-bit PCM mono audio
    const bytesPerSample = 2;
    const numSamples = audioBuffer.length / bytesPerSample;
    return Math.round((numSamples / this.config.sampleRate) * 1000);
  }

  /**
   * Create an empty transcription result.
   */
  private createEmptyResult(): VoiceIOResult {
    return {
      text: '',
      confidence: 0,
      needsConfirmation: true,
      durationMs: 0,
      isFinal: true,
    };
  }

  /**
   * Update the service state and emit state-changed event.
   */
  private setState(newState: VoiceIOState): void {
    const previousState = this.state;
    this.state = newState;
    if (previousState !== newState) {
      this.emit('state-changed', newState);
    }
  }

  /**
   * Ensure the service has been initialized before use.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('VoiceIOService must be initialized before use. Call initialize() first.');
    }
  }
}
