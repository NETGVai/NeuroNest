/**
 * SpeechCapture — Microphone audio capture for speech-to-text input.
 *
 * Captures audio from the system microphone using the Web Audio API
 * (renderer process). Supports two modes:
 *   - Push-to-talk: Record while held, auto-stop on silence (>2s)
 *   - Continuous: Record until explicitly stopped (no silence detection)
 *
 * Streams audio chunks as Float32Array PCM data via an event callback.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 * Feature-gated behind the existing `voice_io` flag.
 *
 * Note: This module is designed for the renderer process where Web Audio API
 * is available. Type declarations for browser APIs are included inline to
 * allow compilation under the main (Node.js) tsconfig.
 *
 * Requirements: 18.1, 18.5, 18.6
 */

// ─── Browser API Type Declarations ──────────────────────────────
// These allow compilation under the Node.js tsconfig (no DOM lib).
// At runtime, these types are provided by the Chromium environment.

/* eslint-disable @typescript-eslint/no-empty-interface */

/** Minimal AudioContext interface for speech capture */
interface IAudioContext {
  createMediaStreamSource(stream: IMediaStream): IMediaStreamAudioSourceNode;
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): IScriptProcessorNode;
  readonly destination: unknown;
  close(): Promise<void>;
}

/** Minimal MediaStream interface */
interface IMediaStream {
  getTracks(): IMediaStreamTrack[];
}

/** Minimal MediaStreamTrack interface */
interface IMediaStreamTrack {
  stop(): void;
}

/** Minimal MediaStreamAudioSourceNode interface */
interface IMediaStreamAudioSourceNode {
  connect(destination: unknown): void;
  disconnect(): void;
}

/** Minimal ScriptProcessorNode interface */
interface IScriptProcessorNode {
  onaudioprocess: ((event: IAudioProcessingEvent) => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
}

/** Minimal AudioProcessingEvent interface */
interface IAudioProcessingEvent {
  inputBuffer: {
    getChannelData(channel: number): Float32Array;
  };
}

/** Minimal MediaStreamConstraints interface */
interface IMediaStreamConstraints {
  audio: {
    sampleRate?: { ideal: number };
    channelCount?: { exact: number };
    echoCancellation?: { ideal: boolean };
    noiseSuppression?: { ideal: boolean };
    autoGainControl?: { ideal: boolean };
  };
}

// ─── Types ──────────────────────────────────────────────────────

/** Capture mode determines recording behavior */
export type CaptureMode = 'push-to-talk' | 'continuous';

/** Current state of the speech capture system */
export type CaptureState = 'idle' | 'recording' | 'stopping';

/** Configuration for the speech capture module */
export interface SpeechCaptureConfig {
  /** Sample rate for captured audio (default: 16000 Hz — optimal for speech) */
  sampleRate: number;
  /** Size of each audio chunk in samples (default: 4096) */
  chunkSize: number;
  /** Silence threshold — RMS below this is considered silence (default: 0.01) */
  silenceThreshold: number;
  /** Duration of silence (in ms) before auto-stopping in push-to-talk mode (default: 2000) */
  silenceDurationMs: number;
  /** Capture mode (default: 'push-to-talk') */
  mode: CaptureMode;
}

/** Audio chunk emitted during recording */
export interface AudioChunk {
  /** PCM audio data as Float32Array */
  data: Float32Array;
  /** Timestamp when this chunk was captured (ms since epoch) */
  timestamp: number;
  /** RMS energy level of this chunk (0-1) */
  rms: number;
}

/** Events emitted by SpeechCapture */
export interface SpeechCaptureEvents {
  /** Emitted for each audio chunk during recording */
  onChunk: (chunk: AudioChunk) => void;
  /** Emitted when recording starts */
  onStart: () => void;
  /** Emitted when recording stops (includes reason) */
  onStop: (reason: StopReason) => void;
  /** Emitted on error */
  onError: (error: Error) => void;
  /** Emitted when silence is detected (push-to-talk mode only) */
  onSilenceDetected: () => void;
}

/** Reason the recording stopped */
export type StopReason = 'manual' | 'silence' | 'error';

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_SPEECH_CAPTURE_CONFIG: SpeechCaptureConfig = {
  sampleRate: 16000,
  chunkSize: 4096,
  silenceThreshold: 0.01,
  silenceDurationMs: 2000,
  mode: 'push-to-talk',
};

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Calculate RMS (Root Mean Square) energy of an audio buffer.
 * Returns a value between 0 and 1 representing the signal amplitude.
 */
export function calculateRMS(buffer: Float32Array): number {
  if (buffer.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const sample = buffer[i];
    if (sample !== undefined) {
      sum += sample * sample;
    }
  }
  return Math.sqrt(sum / buffer.length);
}

/**
 * Determine if a given RMS level is below the silence threshold.
 */
export function isSilent(rms: number, threshold: number): boolean {
  return rms < threshold;
}

// ─── SpeechCapture Class ────────────────────────────────────────

/**
 * Core speech capture class.
 *
 * This class manages microphone access, audio processing, and silence
 * detection. It operates in the renderer process and uses the Web Audio API
 * for real-time audio capture.
 *
 * Usage:
 *   const capture = SpeechCapture.getInstance();
 *   capture.on('onChunk', chunk => { ... });
 *   await capture.start({ mode: 'push-to-talk' });
 *   // later...
 *   capture.stop();
 */
export class SpeechCapture {
  private static instance: SpeechCapture | null = null;

  private config: SpeechCaptureConfig;
  private state: CaptureState = 'idle';
  private listeners: Partial<SpeechCaptureEvents> = {};

  // Web Audio API state (populated during recording)
  private audioContext: IAudioContext | null = null;
  private mediaStream: IMediaStream | null = null;
  private sourceNode: IMediaStreamAudioSourceNode | null = null;
  private processorNode: IScriptProcessorNode | null = null;

  // Silence detection state
  private silenceStartTime: number | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────

  private constructor(config?: Partial<SpeechCaptureConfig>) {
    this.config = { ...DEFAULT_SPEECH_CAPTURE_CONFIG, ...config };
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<SpeechCaptureConfig>): SpeechCapture {
    if (!SpeechCapture.instance) {
      SpeechCapture.instance = new SpeechCapture(config);
    }
    return SpeechCapture.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (SpeechCapture.instance) {
      SpeechCapture.instance.dispose();
    }
    SpeechCapture.instance = null;
  }

  // ─── Public API ─────────────────────────────────────────────

  /** Get current capture state */
  getState(): CaptureState {
    return this.state;
  }

  /** Get current configuration */
  getConfig(): SpeechCaptureConfig {
    return { ...this.config };
  }

  /** Update configuration (only when idle) */
  updateConfig(config: Partial<SpeechCaptureConfig>): void {
    if (this.state !== 'idle') {
      throw new Error('Cannot update config while recording');
    }
    this.config = { ...this.config, ...config };
  }

  /** Register an event listener */
  on<K extends keyof SpeechCaptureEvents>(event: K, handler: SpeechCaptureEvents[K]): void {
    this.listeners[event] = handler;
  }

  /** Remove an event listener */
  off<K extends keyof SpeechCaptureEvents>(event: K): void {
    delete this.listeners[event];
  }

  /**
   * Start capturing audio from the system microphone.
   *
   * Requests microphone access via getUserMedia, sets up the Web Audio API
   * processing pipeline, and begins streaming audio chunks.
   *
   * @param options - Optional overrides for mode and config
   * @throws If microphone access is denied or audio API is unavailable
   */
  async start(options?: { mode?: CaptureMode }): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start capture: current state is "${this.state}"`);
    }

    const mode = options?.mode ?? this.config.mode;
    this.config.mode = mode;

    try {
      this.state = 'recording';
      this.silenceStartTime = null;

      // Request microphone access
      this.mediaStream = await this.requestMicrophoneAccess();

      // Set up audio processing pipeline
      this.setupAudioPipeline(this.mediaStream);

      this.emit('onStart');
    } catch (error) {
      this.state = 'idle';
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('onError', err);
      throw err;
    }
  }

  /**
   * Stop capturing audio.
   *
   * Tears down the audio pipeline, stops the media stream, and emits
   * the stop event with reason 'manual'.
   */
  stop(): void {
    if (this.state !== 'recording') {
      return;
    }
    this.stopInternal('manual');
  }

  /**
   * Clean up all resources. Called when the instance is being destroyed.
   */
  dispose(): void {
    if (this.state === 'recording') {
      this.stopInternal('manual');
    }
    this.listeners = {};
  }

  // ─── Internal Methods ───────────────────────────────────────

  /**
   * Request microphone access via the navigator.mediaDevices API.
   * Configures constraints for speech-optimal capture.
   */
  private async requestMicrophoneAccess(): Promise<IMediaStream> {
    // Check for browser environment with mediaDevices support
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const mediaDevices = nav && 'mediaDevices' in nav
      ? (nav as unknown as { mediaDevices: { getUserMedia(c: IMediaStreamConstraints): Promise<IMediaStream> } }).mediaDevices
      : undefined;

    if (!mediaDevices) {
      throw new Error('Web Audio API not available (not in renderer process)');
    }

    const constraints: IMediaStreamConstraints = {
      audio: {
        sampleRate: { ideal: this.config.sampleRate },
        channelCount: { exact: 1 },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
      },
    };

    return mediaDevices.getUserMedia(constraints);
  }

  /**
   * Set up the Web Audio API processing pipeline:
   *   MediaStream → SourceNode → ScriptProcessorNode → (chunk emission)
   */
  private setupAudioPipeline(stream: IMediaStream): void {
    // Access AudioContext from global scope (renderer process)
    const AudioContextCtor = typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { AudioContext?: new (opts: { sampleRate: number }) => IAudioContext }).AudioContext
      : undefined;

    if (!AudioContextCtor) {
      throw new Error('AudioContext not available (not in renderer process)');
    }

    this.audioContext = new AudioContextCtor({ sampleRate: this.config.sampleRate });
    this.sourceNode = this.audioContext.createMediaStreamSource(stream);

    // ScriptProcessorNode for real-time audio processing
    // bufferSize: 4096 provides good balance between latency and performance
    this.processorNode = this.audioContext.createScriptProcessor(
      this.config.chunkSize,
      1, // input channels (mono)
      1, // output channels (mono)
    );

    this.processorNode.onaudioprocess = (event: IAudioProcessingEvent) => {
      this.handleAudioProcess(event);
    };

    // Connect: source → processor → destination (required for processing to work)
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
  }

  /**
   * Handle each audio processing event from the ScriptProcessorNode.
   * Emits chunks and runs silence detection.
   */
  handleAudioProcess(event: IAudioProcessingEvent): void {
    if (this.state !== 'recording') return;

    const inputData = event.inputBuffer.getChannelData(0);
    const now = Date.now();

    // Create a copy of the audio data (the buffer is reused by the browser)
    const chunkData = new Float32Array(inputData.length);
    chunkData.set(inputData);

    const rms = calculateRMS(chunkData);

    const chunk: AudioChunk = {
      data: chunkData,
      timestamp: now,
      rms,
    };

    this.emit('onChunk', chunk);

    // Silence detection — only in push-to-talk mode
    if (this.config.mode === 'push-to-talk') {
      this.checkSilence(rms, now);
    }
  }

  /**
   * Check for silence in push-to-talk mode.
   * If silence persists for longer than silenceDurationMs, auto-stop.
   */
  checkSilence(rms: number, now: number): void {
    if (isSilent(rms, this.config.silenceThreshold)) {
      if (this.silenceStartTime === null) {
        this.silenceStartTime = now;
      } else if (now - this.silenceStartTime >= this.config.silenceDurationMs) {
        // Silence exceeded threshold — auto-stop
        this.emit('onSilenceDetected');
        this.stopInternal('silence');
      }
    } else {
      // Audio detected — reset silence timer
      this.silenceStartTime = null;
    }
  }

  /**
   * Internal stop implementation — tears down audio pipeline.
   */
  private stopInternal(reason: StopReason): void {
    this.state = 'stopping';

    // Disconnect audio nodes
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        // Ignore close errors
      });
      this.audioContext = null;
    }

    // Stop all media tracks
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    // Reset state
    this.silenceStartTime = null;
    this.state = 'idle';

    this.emit('onStop', reason);
  }

  /**
   * Emit an event to registered listeners.
   */
  private emit<K extends keyof SpeechCaptureEvents>(
    event: K,
    ...args: Parameters<SpeechCaptureEvents[K]>
  ): void {
    const handler = this.listeners[event];
    if (handler) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[SpeechCapture] Error in ${event} handler:`, err);
      }
    }
  }
}
