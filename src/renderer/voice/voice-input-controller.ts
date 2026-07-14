/**
 * VoiceInputController — Orchestrates the voice input workflow.
 *
 * Coordinates between:
 * - VoiceInputButton (UI toggle)
 * - WaveformVisualizer (recording feedback)
 * - VoiceIpcClient (main process communication)
 * - Chat input field (transcription insertion)
 * - Keyboard hotkey binding (configurable, default: Cmd+Shift+V / Ctrl+Shift+V)
 *
 * Workflow:
 * 1. User clicks mic button or presses hotkey
 * 2. Controller starts capture via IPC
 * 3. Waveform visualizer shows real-time audio levels
 * 4. User clicks stop (or hotkey again)
 * 5. Controller requests transcription via IPC
 * 6. Transcribed text is inserted into the chat input field
 * 7. User can edit before sending
 *
 * Feature-gated behind the existing `voice_io` flag.
 *
 * Requirements: 18.3, 18.4
 */

import {
  VoiceIpcClient,
  getVoiceIpcClient,
  type VoiceCaptureMode,
  type VoiceStatus,
  type AudioLevelUpdate,
} from './voice-ipc-client';
import { VoiceInputButton, type VoiceButtonState } from './voice-input-button';
import { WaveformVisualizer } from './waveform-visualizer';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the voice input controller */
export interface VoiceInputControllerConfig {
  /** Default capture mode (default: 'push-to-talk') */
  captureMode: VoiceCaptureMode;
  /** Hotkey binding (default: platform-appropriate Cmd/Ctrl+Shift+V) */
  hotkey: HotkeyBinding;
  /** Whether to auto-insert transcription at cursor (default: true) */
  autoInsert: boolean;
  /** DOM element for the chat input field to insert transcription into */
  chatInputSelector: string;
  /** DOM element to mount the mic button into */
  buttonMountSelector: string;
  /** DOM element to mount the waveform visualizer into */
  waveformMountSelector: string;
}

/** Keyboard hotkey binding */
export interface HotkeyBinding {
  /** Key code (e.g., 'KeyV') */
  key: string;
  /** Whether Ctrl/Cmd is required */
  ctrlOrCmd: boolean;
  /** Whether Shift is required */
  shift: boolean;
  /** Whether Alt is required */
  alt: boolean;
}

/** Events emitted by the controller */
export interface VoiceInputControllerEvents {
  /** Emitted when recording starts */
  onRecordingStart: () => void;
  /** Emitted when recording stops */
  onRecordingStop: () => void;
  /** Emitted when transcription is available */
  onTranscription: (text: string) => void;
  /** Emitted on error */
  onError: (error: string) => void;
  /** Emitted when state changes */
  onStateChange: (state: VoiceButtonState) => void;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default hotkey: Cmd+Shift+V (Mac) / Ctrl+Shift+V (other) */
export const DEFAULT_HOTKEY: HotkeyBinding = {
  key: 'KeyV',
  ctrlOrCmd: true,
  shift: true,
  alt: false,
};

export const DEFAULT_CONTROLLER_CONFIG: VoiceInputControllerConfig = {
  captureMode: 'push-to-talk',
  hotkey: DEFAULT_HOTKEY,
  autoInsert: true,
  chatInputSelector: '#chat-input',
  buttonMountSelector: '#chat-input-actions',
  waveformMountSelector: '#chat-input-area',
};

// ─── VoiceInputController Class ─────────────────────────────────

/**
 * Main orchestrator for the voice input feature.
 *
 * Manages the full lifecycle: button → record → visualize → transcribe → insert.
 *
 * Usage:
 *   const controller = new VoiceInputController(config);
 *   await controller.initialize();
 *   // Controller handles everything from here — hotkey and button wired.
 *   controller.dispose(); // Cleanup when done
 */
export class VoiceInputController {
  private config: VoiceInputControllerConfig;
  private ipcClient: VoiceIpcClient;
  private button: VoiceInputButton;
  private waveform: WaveformVisualizer;
  private state: VoiceButtonState = 'idle';
  private listeners: Partial<VoiceInputControllerEvents> = {};
  private hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private audioLevelUnsubscribe: (() => void) | null = null;
  private mounted = false;

  constructor(config?: Partial<VoiceInputControllerConfig>) {
    this.config = { ...DEFAULT_CONTROLLER_CONFIG, ...config };
    this.ipcClient = getVoiceIpcClient();
    this.button = new VoiceInputButton();
    this.waveform = new WaveformVisualizer();

    // Wire button click to toggle recording
    this.button.onClick(() => {
      this.toggleRecording();
    });

    // Wire waveform stop button
    this.waveform.onStop(() => {
      this.stopRecording();
    });
  }

  /**
   * Initialize the controller — check status, mount UI, bind hotkey.
   *
   * @returns Whether initialization was successful
   */
  async initialize(): Promise<boolean> {
    // Check if voice feature is available
    const status = await this.ipcClient.getStatus();
    if (!status.featureEnabled) {
      this.setState('disabled');
      return false;
    }

    // Mount UI components
    this.mountUI();

    // Bind hotkey
    this.bindHotkey();

    // Subscribe to status changes
    this.statusUnsubscribe = this.ipcClient.onStatusChange((voiceStatus) => {
      this.handleStatusChange(voiceStatus);
    });

    // Subscribe to audio levels for waveform
    this.audioLevelUnsubscribe = this.ipcClient.onAudioLevel((level) => {
      this.handleAudioLevel(level);
    });

    this.setState('idle');
    return true;
  }

  /**
   * Register an event listener.
   */
  on<K extends keyof VoiceInputControllerEvents>(
    event: K,
    handler: VoiceInputControllerEvents[K],
  ): void {
    this.listeners[event] = handler;
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof VoiceInputControllerEvents>(event: K): void {
    delete this.listeners[event];
  }

  /**
   * Get current state of the controller.
   */
  getState(): VoiceButtonState {
    return this.state;
  }

  /**
   * Get the button element (for external mounting if needed).
   */
  getButtonElement(): HTMLButtonElement {
    return this.button.getElement();
  }

  /**
   * Get the waveform element (for external mounting if needed).
   */
  getWaveformElement(): HTMLElement {
    return this.waveform.getElement();
  }

  /**
   * Programmatically toggle recording on/off.
   */
  async toggleRecording(): Promise<void> {
    if (this.state === 'recording') {
      await this.stopRecording();
    } else if (this.state === 'idle') {
      await this.startRecording();
    }
  }

  /**
   * Start voice recording.
   */
  async startRecording(): Promise<void> {
    if (this.state !== 'idle') return;

    this.setState('recording');
    this.waveform.show();

    const response = await this.ipcClient.startCapture({
      mode: this.config.captureMode,
    });

    if (!response.success) {
      this.setState('idle');
      this.waveform.hide();
      this.emit('onError', response.error ?? 'Failed to start recording');
      return;
    }

    this.emit('onRecordingStart');
  }

  /**
   * Stop voice recording and trigger transcription.
   */
  async stopRecording(): Promise<void> {
    if (this.state !== 'recording') return;

    this.setState('transcribing');
    this.waveform.hide();

    // Stop the capture
    const stopResponse = await this.ipcClient.stopCapture();
    if (!stopResponse.success) {
      this.setState('idle');
      this.emit('onError', stopResponse.error ?? 'Failed to stop recording');
      return;
    }

    this.emit('onRecordingStop');

    // Transcribe the captured audio
    const transcription = await this.ipcClient.transcribe();
    this.setState('idle');

    if (!transcription.success || !transcription.text) {
      this.emit('onError', transcription.error ?? 'Transcription failed');
      return;
    }

    // Insert transcribed text into chat input
    if (this.config.autoInsert) {
      this.insertTextIntoChatInput(transcription.text);
    }

    this.emit('onTranscription', transcription.text);
  }

  /**
   * Update the hotkey binding.
   *
   * @param hotkey - New hotkey configuration
   */
  updateHotkey(hotkey: HotkeyBinding): void {
    this.unbindHotkey();
    this.config.hotkey = hotkey;
    this.bindHotkey();
  }

  /**
   * Dispose the controller — unbind events, remove UI, clean up.
   */
  dispose(): void {
    this.unbindHotkey();

    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
      this.statusUnsubscribe = null;
    }

    if (this.audioLevelUnsubscribe) {
      this.audioLevelUnsubscribe();
      this.audioLevelUnsubscribe = null;
    }

    this.button.dispose();
    this.waveform.dispose();
    this.listeners = {};
    this.mounted = false;
  }

  // ─── Internal Methods ─────────────────────────────────────────

  /** Set the controller state and update UI components */
  private setState(state: VoiceButtonState): void {
    this.state = state;
    this.button.setState(state);
    this.emit('onStateChange', state);
  }

  /** Mount UI components into the DOM */
  private mountUI(): void {
    if (this.mounted) return;
    if (typeof document === 'undefined') return;

    const buttonMount = document.querySelector(this.config.buttonMountSelector);
    if (buttonMount) {
      buttonMount.appendChild(this.button.getElement());
    }

    const waveformMount = document.querySelector(this.config.waveformMountSelector);
    if (waveformMount) {
      waveformMount.appendChild(this.waveform.getElement());
    }

    this.mounted = true;
  }

  /** Bind the global keyboard hotkey */
  private bindHotkey(): void {
    if (typeof document === 'undefined') return;

    this.hotkeyHandler = (e: KeyboardEvent) => {
      if (this.matchesHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleRecording();
      }
    };

    document.addEventListener('keydown', this.hotkeyHandler);
  }

  /** Unbind the global keyboard hotkey */
  private unbindHotkey(): void {
    if (this.hotkeyHandler) {
      document.removeEventListener('keydown', this.hotkeyHandler);
      this.hotkeyHandler = null;
    }
  }

  /** Check if a keyboard event matches the configured hotkey */
  private matchesHotkey(e: KeyboardEvent): boolean {
    const { hotkey } = this.config;

    // Check modifier keys
    const isMac = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac');
    const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

    if (hotkey.ctrlOrCmd && !ctrlOrCmd) return false;
    if (hotkey.shift && !e.shiftKey) return false;
    if (hotkey.alt && !e.altKey) return false;
    if (e.code !== hotkey.key) return false;

    return true;
  }

  /** Handle voice status changes from main process */
  private handleStatusChange(voiceStatus: VoiceStatus): void {
    switch (voiceStatus) {
      case 'recording':
        if (this.state !== 'recording') {
          this.setState('recording');
          this.waveform.show();
        }
        break;
      case 'transcribing':
        this.setState('transcribing');
        this.waveform.hide();
        break;
      case 'idle':
        if (this.state === 'recording' || this.state === 'transcribing') {
          this.setState('idle');
          this.waveform.hide();
        }
        break;
      case 'error':
        this.setState('idle');
        this.waveform.hide();
        break;
    }
  }

  /** Handle audio level updates for waveform visualization */
  private handleAudioLevel(level: AudioLevelUpdate): void {
    this.waveform.pushLevel(level.rms);
  }

  /**
   * Insert transcribed text into the chat input field.
   *
   * Finds the chat input element and appends the transcribed text,
   * allowing the user to edit before sending.
   */
  private insertTextIntoChatInput(text: string): void {
    if (typeof document === 'undefined') return;

    const chatInput = document.querySelector(this.config.chatInputSelector) as
      | HTMLTextAreaElement
      | HTMLInputElement
      | null;

    if (!chatInput) return;

    // If the input already has content, add a space separator
    const currentValue = chatInput.value || '';
    const separator = currentValue.length > 0 && !currentValue.endsWith(' ') ? ' ' : '';
    chatInput.value = currentValue + separator + text;

    // Dispatch input event so the app reacts to the changed value
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Focus the input so the user can edit
    chatInput.focus();

    // Move cursor to end
    const length = chatInput.value.length;
    chatInput.setSelectionRange(length, length);
  }

  /** Emit an event to registered listeners */
  private emit<K extends keyof VoiceInputControllerEvents>(
    event: K,
    ...args: Parameters<VoiceInputControllerEvents[K]>
  ): void {
    const handler = this.listeners[event];
    if (handler) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[VoiceInputController] Error in ${event} handler:`, err);
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let controllerInstance: VoiceInputController | null = null;

/**
 * Get the singleton VoiceInputController instance.
 */
export function getVoiceInputController(
  config?: Partial<VoiceInputControllerConfig>,
): VoiceInputController {
  if (!controllerInstance) {
    controllerInstance = new VoiceInputController(config);
  }
  return controllerInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetVoiceInputController(): void {
  if (controllerInstance) {
    controllerInstance.dispose();
    controllerInstance = null;
  }
}
