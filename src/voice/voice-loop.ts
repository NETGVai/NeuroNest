/**
 * VoiceLoop — Full voice-loop integration: STT → Firewall → Agent → TTS.
 *
 * Wires the SpeechTranscriber output through the FirewallEngine for
 * security scanning, then forwards clean transcripts for agent processing.
 * When TTS is enabled, agent responses are automatically spoken via the
 * existing Supertonic TTS system.
 *
 * Feature flag: `speech_to_text` (requires `voice_io`)
 *
 * Integration flow:
 *   1. User speaks → SpeechCapture captures audio chunks
 *   2. Audio → SpeechTranscriber → transcription text
 *   3. Transcript → FirewallEngine.evaluate() → security check
 *   4. If passed: forward to agent pipeline for processing
 *   5. Agent response → (if TTS enabled) SupertonicTTS.synthesize() → audio
 *
 * Requirements: 18.7, 18.8
 */

import type { TranscriptionResult } from './speech-transcriber.js';
import type { EvalResult, FirewallEngine } from '../firewall/firewall-engine.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the voice loop */
export interface VoiceLoopConfig {
  /** Whether TTS auto-speak is enabled for agent responses (default: true) */
  ttsAutoSpeak: boolean;
  /** Voice style for TTS output (e.g., 'M1', 'F1') */
  ttsVoiceStyle: string;
  /** Speech speed for TTS output (0.8 - 1.5) */
  ttsSpeed: number;
  /** Language for TTS output (e.g., 'en') */
  ttsLanguage: string;
  /** Maximum text length to speak (longer responses are summarized) */
  maxSpeakLength: number;
}

/** Result of processing a voice transcript through the loop */
export interface VoiceLoopProcessResult {
  /** Original transcription text */
  transcript: string;
  /** Sanitized text after firewall processing */
  sanitizedTranscript: string;
  /** Whether the transcript passed firewall checks */
  firewallPassed: boolean;
  /** Firewall evaluation result (for diagnostics) */
  firewallResult: EvalResult;
  /** Whether the transcript was forwarded for agent processing */
  forwarded: boolean;
  /** Reason if not forwarded */
  blockedReason?: string;
}

/** Result of speaking an agent response */
export interface TTSPlaybackResult {
  /** Whether the TTS synthesis succeeded */
  success: boolean;
  /** Audio buffer (WAV PCM) if successful */
  audio?: Buffer;
  /** Duration in seconds */
  duration?: number;
  /** Error message if failed */
  error?: string;
}

/** Callback invoked when transcript passes firewall and should be sent to agent */
export type TranscriptForwardCallback = (sanitizedText: string) => void | Promise<void>;

/** Callback invoked to synthesize and play TTS audio */
export type TTSSpeakCallback = (text: string, config: VoiceLoopConfig) => Promise<TTSPlaybackResult>;

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_VOICE_LOOP_CONFIG: VoiceLoopConfig = {
  ttsAutoSpeak: true,
  ttsVoiceStyle: 'M1',
  ttsSpeed: 1.05,
  ttsLanguage: 'en',
  maxSpeakLength: 500,
};

// ─── VoiceLoop Class ────────────────────────────────────────────

/**
 * Orchestrates the full voice I/O loop.
 *
 * Connects speech-to-text transcription output to the agent pipeline
 * through the FirewallEngine, and auto-speaks agent responses when
 * both voice input is active and TTS is enabled.
 *
 * Lazy-initialized singleton pattern consistent with other NeuroNest modules.
 */
export class VoiceLoop {
  private static instance: VoiceLoop | null = null;

  private config: VoiceLoopConfig;
  private firewallEngine: FirewallEngine | null = null;
  private transcriptForwardCallback: TranscriptForwardCallback | null = null;
  private ttsSpeakCallback: TTSSpeakCallback | null = null;
  private active = false;
  private ttsEnabled = false;

  // ─── Lifecycle ──────────────────────────────────────────────

  private constructor(config?: Partial<VoiceLoopConfig>) {
    this.config = { ...DEFAULT_VOICE_LOOP_CONFIG, ...config };
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<VoiceLoopConfig>): VoiceLoop {
    if (!VoiceLoop.instance) {
      VoiceLoop.instance = new VoiceLoop(config);
    }
    return VoiceLoop.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    VoiceLoop.instance = null;
  }

  // ─── Configuration ─────────────────────────────────────────

  /** Get current configuration */
  getConfig(): VoiceLoopConfig {
    return { ...this.config };
  }

  /** Update configuration */
  updateConfig(config: Partial<VoiceLoopConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Set the FirewallEngine instance used for transcript scanning */
  setFirewallEngine(engine: FirewallEngine): void {
    this.firewallEngine = engine;
  }

  /** Set the callback invoked to forward transcripts to the agent pipeline */
  setTranscriptForwardCallback(callback: TranscriptForwardCallback): void {
    this.transcriptForwardCallback = callback;
  }

  /** Set the callback invoked for TTS synthesis */
  setTTSSpeakCallback(callback: TTSSpeakCallback): void {
    this.ttsSpeakCallback = callback;
  }

  // ─── State ─────────────────────────────────────────────────

  /** Whether the voice loop is currently active (voice input is live) */
  isActive(): boolean {
    return this.active;
  }

  /** Whether TTS auto-speak is currently enabled */
  isTTSEnabled(): boolean {
    return this.ttsEnabled;
  }

  /** Activate the voice loop (voice input has started) */
  activate(): void {
    this.active = true;
  }

  /** Deactivate the voice loop (voice input has stopped) */
  deactivate(): void {
    this.active = false;
  }

  /** Enable TTS auto-speak for agent responses */
  enableTTS(): void {
    this.ttsEnabled = true;
  }

  /** Disable TTS auto-speak for agent responses */
  disableTTS(): void {
    this.ttsEnabled = false;
  }

  // ─── Core Pipeline ─────────────────────────────────────────

  /**
   * Process a transcription result through the voice loop pipeline.
   *
   * 1. Evaluates transcript through FirewallEngine for security
   * 2. If passed: forwards sanitized text to agent pipeline via callback
   * 3. If blocked: returns blocked result with reason
   *
   * @param transcription - Result from SpeechTranscriber
   * @returns Processing result indicating whether transcript was forwarded
   */
  async processTranscript(transcription: TranscriptionResult): Promise<VoiceLoopProcessResult> {
    const { text } = transcription;

    // Skip empty transcriptions
    if (!text || text.trim().length === 0) {
      return {
        transcript: text,
        sanitizedTranscript: '',
        firewallPassed: true,
        firewallResult: createEmptyEvalResult(),
        forwarded: false,
        blockedReason: 'Empty transcript',
      };
    }

    // Pass transcript through FirewallEngine
    const firewallResult = this.evaluateWithFirewall(text);

    if (firewallResult.blocked) {
      return {
        transcript: text,
        sanitizedTranscript: firewallResult.sanitized,
        firewallPassed: false,
        firewallResult,
        forwarded: false,
        blockedReason: `Blocked by firewall: ${firewallResult.events.filter(e => e.blocked).map(e => e.ruleName).join(', ')}`,
      };
    }

    // Forward sanitized transcript to agent pipeline
    const sanitizedText = firewallResult.sanitized.trim();
    let forwarded = false;

    if (sanitizedText.length > 0 && this.transcriptForwardCallback) {
      try {
        await this.transcriptForwardCallback(sanitizedText);
        forwarded = true;
      } catch (err) {
        console.error('[VoiceLoop] Error forwarding transcript:', err);
      }
    }

    return {
      transcript: text,
      sanitizedTranscript: sanitizedText,
      firewallPassed: true,
      firewallResult,
      forwarded,
      blockedReason: forwarded ? undefined : 'No forward callback registered',
    };
  }

  /**
   * Handle an agent response for potential TTS playback.
   *
   * When the voice loop is active AND TTS is enabled, automatically
   * synthesizes the agent response into speech.
   *
   * @param responseText - The agent's text response
   * @returns TTS playback result, or null if TTS is not applicable
   */
  async handleAgentResponse(responseText: string): Promise<TTSPlaybackResult | null> {
    // Only auto-speak when both conditions are met:
    // 1. Voice loop is active (user is using voice input)
    // 2. TTS is enabled
    if (!this.shouldAutoSpeak()) {
      return null;
    }

    if (!responseText || responseText.trim().length === 0) {
      return null;
    }

    if (!this.ttsSpeakCallback) {
      return { success: false, error: 'No TTS callback registered' };
    }

    try {
      const result = await this.ttsSpeakCallback(responseText, this.config);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[VoiceLoop] TTS playback error:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Determine whether auto-speak should be triggered.
   * Conditions: voice loop active + TTS enabled + config allows auto-speak.
   */
  shouldAutoSpeak(): boolean {
    return this.active && this.ttsEnabled && this.config.ttsAutoSpeak;
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * Run the firewall evaluation on a transcript.
   * Falls back to a pass-through result if no engine is configured.
   */
  private evaluateWithFirewall(text: string): EvalResult {
    if (!this.firewallEngine) {
      // No firewall configured — pass through with warning
      console.warn('[VoiceLoop] No FirewallEngine configured, passing transcript through without scanning');
      return {
        passed: true,
        blocked: false,
        sanitized: text,
        events: [],
        errors: [],
        tier: 0,
        latencyMs: 0,
      };
    }

    return this.firewallEngine.evaluate(text, { agentId: 'voice-loop' });
  }
}

// ─── Utility ────────────────────────────────────────────────────

/** Create an empty EvalResult (used for empty transcripts) */
function createEmptyEvalResult(): EvalResult {
  return {
    passed: true,
    blocked: false,
    sanitized: '',
    events: [],
    errors: [],
    tier: 0,
    latencyMs: 0,
  };
}
