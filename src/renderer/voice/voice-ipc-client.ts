/**
 * Renderer-side IPC client for voice input communication with the main process.
 *
 * Provides typed wrappers around the voice IPC channels:
 * - `voice:start-capture` — Start microphone recording
 * - `voice:stop-capture` — Stop microphone recording
 * - `voice:transcribe` — Transcribe captured audio
 * - `voice:status` — Get current voice system status
 *
 * Requirements: 18.3, 18.4
 */

import { ipcInvoke, ipcOn, type IpcUnsubscribe } from '../services/ipc-client';

// ─── Types ──────────────────────────────────────────────────────

/** Capture mode for voice recording */
export type VoiceCaptureMode = 'push-to-talk' | 'continuous';

/** Current status of the voice system */
export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'error';

/** Request to start capturing audio */
export interface StartCapturePayload {
  /** Recording mode */
  mode: VoiceCaptureMode;
}

/** Response from starting capture */
export interface StartCaptureResponse {
  success: boolean;
  error?: string;
}

/** Response from stopping capture */
export interface StopCaptureResponse {
  success: boolean;
  error?: string;
}

/** Response from transcription */
export interface TranscribeResponse {
  success: boolean;
  /** Transcribed text */
  text?: string;
  /** Confidence score between 0 and 1 */
  confidence?: number;
  /** Provider that performed transcription */
  provider?: string;
  /** Error message if failed */
  error?: string;
}

/** Voice status info returned from main process */
export interface VoiceStatusInfo {
  /** Current state of the voice system */
  status: VoiceStatus;
  /** Whether voice_io feature is enabled */
  featureEnabled: boolean;
  /** Available transcription providers */
  availableProviders: string[];
}

/** Audio level update pushed from main process during recording */
export interface AudioLevelUpdate {
  /** RMS energy level (0-1) */
  rms: number;
  /** Timestamp of the audio chunk */
  timestamp: number;
}

// ─── IPC Client ─────────────────────────────────────────────────

/**
 * VoiceIpcClient — Renderer-side IPC communication for voice input.
 *
 * Wraps the raw IPC channels with typed request/response interfaces.
 * Follows the existing ipc-client pattern from src/renderer/services/ipc-client.ts.
 */
export class VoiceIpcClient {
  private statusListeners: Set<(status: VoiceStatus) => void> = new Set();
  private audioLevelListeners: Set<(level: AudioLevelUpdate) => void> = new Set();
  private statusUnsubscribe: IpcUnsubscribe | null = null;
  private audioLevelUnsubscribe: IpcUnsubscribe | null = null;

  /**
   * Start microphone capture via the main process.
   *
   * @param payload - Capture configuration
   * @returns Whether capture started successfully
   */
  async startCapture(payload: StartCapturePayload): Promise<StartCaptureResponse> {
    try {
      const result = await ipcInvoke<StartCaptureResponse, StartCapturePayload>(
        'voice:start-capture',
        payload,
      );
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown IPC error',
      };
    }
  }

  /**
   * Stop the active microphone capture.
   *
   * @returns Whether capture stopped successfully
   */
  async stopCapture(): Promise<StopCaptureResponse> {
    try {
      const result = await ipcInvoke<StopCaptureResponse>('voice:stop-capture');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown IPC error',
      };
    }
  }

  /**
   * Transcribe the most recently captured audio.
   *
   * @returns The transcription result with text and confidence
   */
  async transcribe(): Promise<TranscribeResponse> {
    try {
      const result = await ipcInvoke<TranscribeResponse>('voice:transcribe');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown IPC error',
      };
    }
  }

  /**
   * Get the current voice system status.
   *
   * @returns Voice status information
   */
  async getStatus(): Promise<VoiceStatusInfo> {
    try {
      return await ipcInvoke<VoiceStatusInfo>('voice:status');
    } catch {
      return {
        status: 'idle',
        featureEnabled: false,
        availableProviders: [],
      };
    }
  }

  /**
   * Subscribe to voice status changes pushed from the main process.
   *
   * @param callback - Called when voice status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: VoiceStatus) => void): () => void {
    this.statusListeners.add(callback);

    if (!this.statusUnsubscribe) {
      this.statusUnsubscribe = ipcOn<VoiceStatus>(
        'voice:status-update',
        (status) => {
          for (const listener of this.statusListeners) {
            listener(status);
          }
        },
      );
    }

    return () => {
      this.statusListeners.delete(callback);
      if (this.statusListeners.size === 0 && this.statusUnsubscribe) {
        this.statusUnsubscribe();
        this.statusUnsubscribe = null;
      }
    };
  }

  /**
   * Subscribe to audio level updates during recording.
   * Used for real-time waveform visualization.
   *
   * @param callback - Called with audio level data during recording
   * @returns Unsubscribe function
   */
  onAudioLevel(callback: (level: AudioLevelUpdate) => void): () => void {
    this.audioLevelListeners.add(callback);

    if (!this.audioLevelUnsubscribe) {
      this.audioLevelUnsubscribe = ipcOn<AudioLevelUpdate>(
        'voice:audio-level',
        (level) => {
          for (const listener of this.audioLevelListeners) {
            listener(level);
          }
        },
      );
    }

    return () => {
      this.audioLevelListeners.delete(callback);
      if (this.audioLevelListeners.size === 0 && this.audioLevelUnsubscribe) {
        this.audioLevelUnsubscribe();
        this.audioLevelUnsubscribe = null;
      }
    };
  }

  /**
   * Dispose the client and clean up all listeners.
   */
  dispose(): void {
    this.statusListeners.clear();
    this.audioLevelListeners.clear();
    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
      this.statusUnsubscribe = null;
    }
    if (this.audioLevelUnsubscribe) {
      this.audioLevelUnsubscribe();
      this.audioLevelUnsubscribe = null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: VoiceIpcClient | null = null;

/**
 * Get the singleton VoiceIpcClient instance.
 */
export function getVoiceIpcClient(): VoiceIpcClient {
  if (!instance) {
    instance = new VoiceIpcClient();
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetVoiceIpcClient(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
